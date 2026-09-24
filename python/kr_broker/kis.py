"""한국투자증권 Open API. TypeScript 판 `ts/src/kis.ts` 의 선언·모의투자 전환·인증·서명·오류 처리를 옮겼다.

지금은 암묵 메서드로 모든 엔드포인트를 부를 수 있다. TR ID 는 `params['tr_id']` 로 넘기면 `sign()` 이 헤더로 옮긴다.
통합 메서드(`fetch_ticker` 등)는 차례로 옮기며, 옮긴 것만 `has` 에서 `True` 가 된다.

.. code-block:: python

    import kr_broker
    broker = kr_broker.kis({'apiKey': APP_KEY, 'secret': APP_SECRET, 'uid': '12345678-01'})
    price = broker.private_get_uapi_domestic_stock_v1_quotations_inquire_price({
        'tr_id': 'FHKST01010100', 'FID_COND_MRKT_DIV_CODE': 'J', 'FID_INPUT_ISCD': '005930',
    })
"""

import json
import logging
import threading
import time
from typing import Any, Callable, Dict, Optional

from kr_broker.abstract.kis import ImplicitAPI
from kr_broker.base import functions as fn
from kr_broker.base.decimal_to_precision import TICK_SIZE
from kr_broker.base.errors import (
    ArgumentsRequired, AuthenticationError, ExchangeError, NotSupported, RateLimitExceeded, RequestTimeout,
)
from kr_broker.base.exchange import Exchange
from kr_broker.base.token_store import BrokerTokenStore, refresh_token_with_lock
from kr_broker.base.types import ApiName, Num, Str

logger = logging.getLogger('kr_broker')

KIS_API_DOMAINS = {
    'REAL': 'https://openapi.koreainvestment.com:9443',
    'VIRTUAL': 'https://openapivts.koreainvestment.com:29443',
}
KIS_WS_DOMAINS = {
    'REAL': 'ws://ops.koreainvestment.com:21000',
    'VIRTUAL': 'ws://ops.koreainvestment.com:31000',
}
# 실전 하드 한도 초당 20건(50ms)에 여유를 둔 초당 15건, 모의는 초당 2건이다.
REAL_RATE_LIMIT_MS = 67
SANDBOX_RATE_LIMIT_MS = 500
READ_TIMEOUT_MS = 20_000
ORDER_TIMEOUT_MS = 25_000
AUTH_TIMEOUT_MS = 10_000
READ_RETRIES = 3
READ_RETRY_DELAY_MS = 500
KIS_BROKERAGE_FEE = 0.00015
KIS_CUSTOMER_TYPE = 'P'

KIS_EXCEPTIONS_EXACT = {
    # 초당 거래건수 초과. 조회는 다시 보내도 되므로 백오프 뒤 재시도한다.
    'EGW00201': RateLimitExceeded,
    # 원장 초당 거래건수 초과. EGW00201 과 같은 계열이다.
    'EGW00215': RateLimitExceeded,
    # 접근토큰 발급 빈도 제한(1분당 1회).
    'EGW00133': RateLimitExceeded,
    # 접근토큰 만료. HTTP 200 으로 오는 경우가 있어 상태 코드로는 잡히지 않는다.
    'EGW00123': AuthenticationError,
}

# ---- 토큰 캐시 ----
KIS_TOKEN_KEY_PREFIX = 'kis:token:'
KIS_APPROVAL_KEY_PREFIX = 'kis:approval:'
KEY_DIGITS = 12
TOKEN_FETCH_LOCK_TTL_MS = 90 * 1000
STORE_TTL_MARGIN_MS = 60_000
KIS_TOKEN_SAFETY_MARGIN_MS = 30 * 60 * 1000
# 서버가 expires_in 을 주지 않을 때만 쓰는 폴백(사양의 24시간에서 여유를 뺀 값).
KIS_TOKEN_EXPIRY_MS = (24 * 60 - 30) * 60 * 1000
KIS_TOKEN_MIN_LIFETIME_MS = 60_000


# `tr()` 에 모의 TR ID 를 주지 않았다는 표지.
_OMITTED = object()


def _now_ms() -> int:
    return fn.milliseconds()


# ---- 앱키 단위 요청 스케줄러 ----
#
# 초당 거래건수 초과(EGW00201)를 막는다. 같은 프로세스에서 같은 앱키를 쓰는 인스턴스는 하나의 스케줄을 나눠 쓰고,
# 각 호출은 들어오는 즉시 다음 가용 시각을 예약하므로 스레드가 동시에 들어와도 간격을 두고 차례로 나간다.
_next_slot_at: Dict[str, float] = {}
_slot_lock = threading.Lock()


def acquire_kis_slot(app_key: str, interval_ms: float, sleep: Callable[[float], None] = time.sleep) -> None:
    with _slot_lock:
        now = fn.milliseconds()
        scheduled_at = max(now, _next_slot_at.get(app_key, 0))
        _next_slot_at[app_key] = scheduled_at + interval_ms
    wait_ms = scheduled_at - now
    if wait_ms > 0:
        sleep(wait_ms / 1000)


def reset_kis_rate_limiter(app_key: Optional[str] = None) -> None:
    """예약 상태를 비운다(테스트용)."""
    with _slot_lock:
        if app_key is None:
            _next_slot_at.clear()
        else:
            _next_slot_at.pop(app_key, None)


def resolve_token_lifetime_ms(expires_in_sec: Any) -> int:
    """캐시 수명(ms). 서버가 준 `expires_in` 이 정본이고, 없거나 이상하면 사양의 24시간에서 여유를 뺀 값을 쓴다."""
    try:
        sec = float(expires_in_sec)
    except (TypeError, ValueError):
        return KIS_TOKEN_EXPIRY_MS
    if not sec > 0:
        return KIS_TOKEN_EXPIRY_MS
    with_margin = sec * 1000 - KIS_TOKEN_SAFETY_MARGIN_MS
    if with_margin < KIS_TOKEN_MIN_LIFETIME_MS:
        logger.warning('[KISAuth] 서버 토큰 수명(%s초)이 안전 마진보다 짧아 하한을 쓴다', sec)
        return KIS_TOKEN_MIN_LIFETIME_MS
    return int(with_margin)


class KISAuth:
    """KIS 접근 토큰과 실시간 접속키(approval_key)의 캐시. TypeScript 판 `ts/src/kis/kis-auth.ts` 와 같다.

    토큰은 24시간 유효하고 발급은 분당 1회로 제한된다. 그래서 프로세스 메모리 → 토큰 저장소 순서로 유효한 토큰을 찾고,
    없으면 저장소 락을 잡고 한 곳만 발급한다.
    """

    def __init__(self, app_key: str, request_token: Callable[[], Dict[str, Any]], request_approval_key: Callable[[], str],
                 store_of: Callable[[], Optional[BrokerTokenStore]] = lambda: None) -> None:
        self.app_key = app_key
        self.request_token = request_token
        self.request_approval_key = request_approval_key
        self.store_of = store_of
        self.cached_token: Optional[Dict[str, Any]] = None
        self.cached_approval_key: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()
        self._approval_lock = threading.Lock()

    @property
    def store_key(self) -> str:
        return f'{KIS_TOKEN_KEY_PREFIX}{self.app_key[:KEY_DIGITS]}'

    @property
    def approval_store_key(self) -> str:
        return f'{KIS_APPROVAL_KEY_PREFIX}{self.app_key[:KEY_DIGITS]}'

    def get_access_token(self) -> str:
        cached = self.cached_token
        if cached is not None and cached['expiresAt'] > _now_ms():
            return cached['accessToken']
        with self._lock:
            cached = self.cached_token
            if cached is not None and cached['expiresAt'] > _now_ms():
                return cached['accessToken']
            stored = self._read_cached_token()
            if stored is not None:
                return stored

            def issue_and_cache() -> str:
                token = self._issue_token_and_cache_local()
                store = self.store_of()
                if store is not None:
                    self._save_token_to_store(store)
                return token

            return refresh_token_with_lock('[KISAuth]', self.store_of(), self.store_key, TOKEN_FETCH_LOCK_TTL_MS,
                                           self._read_cached_token, issue_and_cache)

    def _read_cached_token(self) -> Optional[str]:
        store = self.store_of()
        if store is None:
            return None
        try:
            raw = store.get(self.store_key)
            if not raw:
                return None
            parsed = json.loads(raw)
            if parsed['expiresAt'] <= _now_ms():
                return None
            self.cached_token = parsed
            return parsed['accessToken']
        except Exception:
            logger.warning('[KISAuth] 토큰 저장소 조회 실패, 새로 발급한다', exc_info=True)
            return None

    def _issue_token_and_cache_local(self) -> str:
        logger.info('[KISAuth] 접근 토큰을 발급한다')
        issued = self.request_token()
        self.cached_token = {
            'accessToken': issued['accessToken'],
            'expiresAt': _now_ms() + resolve_token_lifetime_ms(issued.get('expiresInSec')),
        }
        return issued['accessToken']

    def _save_token_to_store(self, store: BrokerTokenStore) -> None:
        if self.cached_token is None:
            return
        try:
            ttl_ms = self.cached_token['expiresAt'] - _now_ms() - STORE_TTL_MARGIN_MS
            if ttl_ms > 0:
                store.set(self.store_key, fn.json_stringify(self.cached_token), int(ttl_ms))
        except Exception:
            logger.warning('[KISAuth] 토큰 저장소 저장 실패(프로세스 메모리 캐시는 유효)', exc_info=True)

    def get_approval_key(self) -> str:
        """실시간 접속용 approval_key. 접근 토큰과 따로 발급되는 세션 키이고 24시간쯤 유효하다."""
        cached = self.cached_approval_key
        if cached is not None and cached['expiresAt'] > _now_ms():
            return cached['key']
        with self._approval_lock:
            cached = self.cached_approval_key
            if cached is not None and cached['expiresAt'] > _now_ms():
                return cached['key']
            store = self.store_of()
            if store is not None:
                try:
                    raw = store.get(self.approval_store_key)
                    if raw:
                        parsed = json.loads(raw)
                        if parsed['expiresAt'] > _now_ms():
                            self.cached_approval_key = parsed
                            return parsed['key']
                except Exception:
                    logger.warning('[KISAuth] approval_key 저장소 조회 실패, 새로 발급한다', exc_info=True)
            key = self.request_approval_key()
            self.cached_approval_key = {'key': key, 'expiresAt': _now_ms() + KIS_TOKEN_EXPIRY_MS}
            if store is not None:
                try:
                    store.set(self.approval_store_key, fn.json_stringify(self.cached_approval_key), KIS_TOKEN_EXPIRY_MS - STORE_TTL_MARGIN_MS)
                except Exception:
                    logger.warning('[KISAuth] approval_key 저장소 저장 실패(프로세스 메모리 캐시는 유효)', exc_info=True)
            return key

    def invalidate(self) -> None:
        """토큰 캐시를 프로세스 메모리와 저장소에서 모두 지운다. 다음 호출이 새 토큰을 발급받는다."""
        self.cached_token = None
        store = self.store_of()
        if store is not None:
            try:
                store.delete(self.store_key)
            except Exception:
                logger.debug('[KISAuth] 토큰 저장소 삭제 실패(프로세스 메모리 무효화는 완료)', exc_info=True)


class kis(Exchange, ImplicitAPI):

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self._auth: Optional[KISAuth] = None
        self._auth_app_key: Str = None
        super().__init__(config)

    def describe(self) -> Dict[str, Any]:
        return self.deep_extend(super().describe(), {
            'id': 'kis',
            'name': 'Korea Investment & Securities',
            'countries': ['KR'],
            'version': 'v1',
            'rateLimit': REAL_RATE_LIMIT_MS,
            'timeout': READ_TIMEOUT_MS,
            'orderTimeout': ORDER_TIMEOUT_MS,
            # 옮긴 통합 메서드만 True 다. 나머지는 TypeScript 판에 있고 Python 판에는 아직 없다.
            'has': {
                'spot': True,
                'margin': False,
                'swap': False,
                'future': False,
                'option': False,
                'sandbox': True,
                'ws': False,
                'createLimitOrder': False,
                'createMarketOrder': False,
                'fetchMarkets': False,
                'fetchCurrencies': False,
            },
            'urls': {
                'api': {'public': KIS_API_DOMAINS['REAL'], 'private': KIS_API_DOMAINS['REAL']},
                'test': {'public': KIS_API_DOMAINS['VIRTUAL'], 'private': KIS_API_DOMAINS['VIRTUAL']},
                'ws': {'public': KIS_WS_DOMAINS['REAL']},
                'wsTest': {'public': KIS_WS_DOMAINS['VIRTUAL']},
                'www': 'https://securities.koreainvestment.com',
                'doc': [
                    'https://apiportal.koreainvestment.com/apiservice',
                    'https://github.com/koreainvestment/open-trading-api',
                ],
            },
            'requiredCredentials': {'apiKey': True, 'secret': True, 'uid': True},
            'fees': {
                'trading': {'tierBased': False, 'percentage': True, 'maker': KIS_BROKERAGE_FEE, 'taker': KIS_BROKERAGE_FEE},
            },
            'precisionMode': TICK_SIZE,
            'exceptions': {'exact': dict(KIS_EXCEPTIONS_EXACT), 'broad': {}},
            'options': {
                # 조회 재시도. 시간 초과는 fetch 가 재시도 대상에서 뺀다.
                'maxRetriesOnFailure': READ_RETRIES,
                'maxRetriesOnFailureDelay': READ_RETRY_DELAY_MS,
                # 토큰과 발급 락을 여러 프로세스가 나눠 쓰는 저장소(BrokerTokenStore). 없으면 프로세스 메모리 캐시만 쓴다.
                'tokenStore': None,
            },
        })

    # ============ 모의투자 ============

    def set_sandbox_mode(self, enabled: bool) -> None:
        """모의투자로 바꾼다. 도메인, TR ID, 호출 간격(초당 2건)이 모두 바뀌고 캐시한 토큰은 버린다."""
        super().set_sandbox_mode(enabled)
        self.rateLimit = SANDBOX_RATE_LIMIT_MS if enabled else REAL_RATE_LIMIT_MS
        self.init_rest_rate_limiter()
        self.token = None
        self._auth = None

    def tr(self, real: str, demo: Any = _OMITTED) -> str:
        """실전 TR ID 와 모의 TR ID 중 지금 모드의 것. 모의 ID 를 생략하면 실전 ID 의 첫 글자를 `V` 로 바꾼 것이다
        (`TTTC8434R` → `VTTC8434R`). 모의투자를 지원하지 않는 TR 은 `demo=None` 을 주면 `NotSupported` 를 던진다."""
        if not self.isSandboxModeEnabled:
            return real
        if demo is None:
            raise NotSupported(f'{self.id} {real} 는 모의투자를 지원하지 않는다')
        return 'V' + real[1:] if demo is _OMITTED else demo

    # ============ 요청 ============

    def throttle(self, cost: Num = None, bucket: Str = None) -> None:
        """앱키 단위 예약 스케줄러로 기다린다. 같은 프로세스의 같은 앱키는 인스턴스가 달라도 하나의 스케줄을 쓴다."""
        acquire_kis_slot(self.apiKey or '', self.rateLimit * (1 if cost is None else cost))

    def fetch(self, url: str, method: str = 'GET', headers: Optional[Dict[str, str]] = None, body: Str = None,
              timeout_ms: Optional[float] = None) -> Any:
        """시간 초과는 조회에서도 다시 보내지 않는다. 응답이 없던 요청을 되풀이하면 최악의 대기가 몇 배로 늘어난다."""
        try:
            return super().fetch(url, method, headers, body, timeout_ms)
        except RequestTimeout as e:
            if e.retryable is None:
                e.retryable = False
            raise

    def sign(self, path: str, api: ApiName = 'public', method: str = 'GET', params: Optional[Dict[str, Any]] = None,
             headers: Optional[Dict[str, str]] = None, body: Str = None) -> Dict[str, Any]:
        """비공개 호출은 `params['tr_id']` 를 헤더로 옮기고 나머지는 GET 이면 쿼리로, POST 이면 JSON 본문으로 보낸다.
        대문자 키(`CANO` 등)는 KIS 규격 그대로 둔다."""
        params = {} if params is None else params
        api_name = api[0] if isinstance(api, (list, tuple)) else api
        base = self.safe_string(self.urls['api'], api_name)
        if base is None:
            raise ExchangeError(f'{self.id} sign() 에 쓸 urls.api 가 없다: {api_name}')
        url = f'{base}/{path}'
        query = params
        request_headers = {'Content-Type': 'application/json; charset=UTF-8'}
        if self.is_private_api(api):
            tr_id = self.safe_string(params, 'tr_id')
            if tr_id is None:
                raise ArgumentsRequired(f'{self.id} {path} 호출에는 params["tr_id"] 가 필요하다')
            query = self.omit(params, 'tr_id')
            request_headers.update({
                'authorization': f'Bearer {self.token}',
                'appkey': self.apiKey or '',
                'appsecret': self.secret or '',
                'tr_id': tr_id,
                'custtype': KIS_CUSTOMER_TYPE,
            })
        request_body = None
        if method == 'GET':
            encoded = self.urlencode(query)
            if encoded:
                url += f'?{encoded}'
        else:
            request_body = self.json(query)
        return {'url': url, 'method': method, 'headers': self.extend(request_headers, headers), 'body': request_body}

    # ============ 인증 ============

    def auth_manager(self) -> KISAuth:
        app_key = self.apiKey or ''
        if self._auth is None or self._auth_app_key != app_key:
            self._auth = KISAuth(app_key, self._request_access_token, self._request_approval_key, self.get_token_store)
            self._auth_app_key = app_key
        return self._auth

    def authenticate(self, path: str = '', api: ApiName = 'private', method: str = 'GET', params: Optional[Dict[str, Any]] = None,
                     headers: Optional[Dict[str, str]] = None, body: Str = None) -> None:
        """비공개 호출 앞에서 접근 토큰을 준비한다. 캐시(프로세스 → 토큰 저장소)에 있으면 발급하지 않는다."""
        self.token = self.auth_manager().get_access_token()

    def _request_access_token(self) -> Dict[str, Any]:
        request = self.sign('oauth2/tokenP', 'public', 'POST', {
            'grant_type': 'client_credentials', 'appkey': self.apiKey, 'appsecret': self.secret,
        })
        response = self.fetch(request['url'], request['method'], request['headers'], request['body'], AUTH_TIMEOUT_MS)
        access_token = self.safe_string(response, 'access_token')
        if access_token is None:
            raise AuthenticationError(f'{self.id} 토큰 발급 응답에 access_token 이 없다')
        return {'accessToken': access_token, 'expiresInSec': self.safe_number(response, 'expires_in')}

    def _request_approval_key(self) -> str:
        """접속키 발급 본문은 `appsecret` 이 아니라 `secretkey` 를 쓴다."""
        request = self.sign('oauth2/Approval', 'public', 'POST', {
            'grant_type': 'client_credentials', 'appkey': self.apiKey, 'secretkey': self.secret,
        })
        response = self.fetch(request['url'], request['method'], request['headers'], request['body'], AUTH_TIMEOUT_MS)
        approval_key = self.safe_string(response, 'approval_key')
        if approval_key is None:
            raise AuthenticationError(f'{self.id} approval_key 응답에 approval_key 가 없다')
        return approval_key

    def invalidate_token(self) -> None:
        """토큰 캐시를 프로세스와 토큰 저장소에서 모두 지운다(재인증 강제)."""
        self.token = None
        if self._auth is not None:
            self._auth.invalidate()

    def get_approval_key(self) -> str:
        """실시간 시세 WebSocket 에 접속할 때 쓰는 접속키."""
        self.check_required_credentials()
        return self.auth_manager().get_approval_key()

    # ============ 오류 ============

    def handle_errors(self, code: int, reason: str, url: str, method: str, headers: Dict[str, str], body: str, response: Any,
                      request_headers: Optional[Dict[str, str]], request_body: Str) -> Optional[bool]:
        """KIS 는 업무 오류를 HTTP 200 과 `rt_cd != '0'` 로 주고, 초당 거래건수 초과는 HTTP 500 에 실어 온다. 상태 코드보다 봉투를 먼저 읽는다."""
        is_auth_request = '/oauth2/' in url
        msg_cd = self.safe_string_2(response, 'msg_cd', 'error_code')
        # 인증 실패가 확실할 때만 토큰 캐시를 버린다. 아무 500 에나 붙이면 발급이 남발되고, 토큰 발급은 분당 1회 제한이다.
        if not is_auth_request and (code in (401, 403) or msg_cd == 'EGW00123'):
            self._drop_token(code, msg_cd)
        if not isinstance(response, dict):
            return None
        rt_cd = self.safe_string(response, 'rt_cd')
        msg = self.safe_string_2(response, 'msg1', 'error_description')
        business_failure = rt_cd is not None and rt_cd != '0'
        http_failure = code >= 400 and msg_cd is not None
        if not business_failure and not http_failure:
            return None
        if is_auth_request:
            feedback = f'KIS 토큰 발급 실패: {code} {body}'
        elif code >= 400:
            feedback = f'KIS API 오류: {code} [{msg_cd}] {msg}'
        else:
            feedback = f'KIS API 비즈니스 오류 [{msg_cd}]: {msg}'
        # 증권사 오류 코드는 어떤 오류 클래스로 던지든 detail 에 남긴다.
        detail = None if msg_cd is None else msg_cd.strip()
        self.throw_exactly_matched_exception(self.exceptions.get('exact'), detail, feedback, detail=detail)
        self.throw_broadly_matched_exception(self.exceptions.get('broad'), msg, feedback, detail=detail)
        raise ExchangeError(feedback, detail=detail)

    def _drop_token(self, code: int, msg_cd: Str) -> None:
        logger.warning('[kis] 인증 실패(%s %s). 토큰 캐시를 무효화하고 다음 호출에서 재발급한다', code, msg_cd)
        try:
            self.invalidate_token()
        except Exception:
            logger.warning('[kis] 토큰 캐시 무효화 실패', exc_info=True)
