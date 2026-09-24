"""토스증권 Open API. TypeScript 판 `ts/src/toss.ts` 의 선언·인증·서명·오류 처리를 옮겼다.

지금은 암묵 메서드(`private_market_get_prices` 등)로 모든 엔드포인트를 부를 수 있다. 통합 메서드(`fetch_ticker` 등)는 차례로 옮기며,
옮긴 것만 `has` 에서 `True` 가 된다.

.. code-block:: python

    import kr_broker
    broker = kr_broker.toss({'apiKey': CLIENT_ID, 'secret': CLIENT_SECRET})
    rate = broker.private_market_get_exchange_rate({'baseCurrency': 'USD', 'quoteCurrency': 'KRW'})
"""

import datetime
import json
import logging
import threading
import time
from typing import Any, Callable, Dict, Optional

from kr_broker.abstract.toss import ImplicitAPI
from kr_broker.base import functions as fn
from kr_broker.base.decimal_to_precision import TICK_SIZE
from kr_broker.base.errors import (
    AccountNotEnabled, AuthenticationError, BadRequest, BadSymbol, DuplicateOrderId, ExchangeError, ExchangeNotAvailable,
    InsufficientFunds, InvalidOrder, ManualInteractionNeeded, MarketClosed, NullResponse, OnMaintenance, OperationRejected,
    OrderNotFound, OrderOutcomeUnknown, PermissionDenied, RateLimitExceeded, TossRateLimited, TossTokenRejected,
)
from kr_broker.base.exchange import Exchange
from kr_broker.base.token_store import BrokerTokenStore, refresh_token_with_lock
from kr_broker.base.types import ApiName, Num, Str

logger = logging.getLogger('kr_broker')

GLOBAL_RATE_LIMIT_MS = 100
READ_TIMEOUT_MS = 20_000
ORDER_TIMEOUT_MS = 25_000
AUTH_TIMEOUT_MS = 10_000
TOSS_BROKERAGE_FEE = 0.00015
LISTED_MARKETS = ['KOSPI', 'KOSDAQ', 'KR_ETC', 'NYSE', 'NASDAQ', 'AMEX', 'US_ETC']
# 개장 직후(09:00~09:10 KST)에는 주문 정보 그룹의 한도가 줄어 비용을 두 배로 센다.
PEAK_WINDOW_START_MIN = 9 * 60
PEAK_WINDOW_END_MIN = 9 * 60 + 10
PEAK_COST_FACTOR = 2
# 429 를 받은 그룹을 쉬게 하는 시간(Retry-After 가 없을 때)과 상한.
DEFAULT_BACKOFF_MS = 1_000
MAX_BACKOFF_MS = 30_000

# ---- 토큰 캐시 ----
TOKEN_KEY_PREFIX = 'toss:token:'
CLIENT_ID_KEY_LENGTH = 12
TOSS_TOKEN_SAFETY_MARGIN_MS = 60_000
TOSS_TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
TOKEN_FETCH_LOCK_TTL_MS = 90_000


def _now_ms() -> int:
    return int(time.time() * 1000)


def is_order_info_peak_window(now: Optional[datetime.datetime] = None) -> bool:
    now = datetime.datetime.now(datetime.timezone.utc) if now is None else now
    kst_minutes = (now.hour * 60 + now.minute + 9 * 60) % (24 * 60)
    return PEAK_WINDOW_START_MIN <= kst_minutes < PEAK_WINDOW_END_MIN


class TossAuth:
    """토스 OAuth2 토큰의 캐시와 발급 조정. TypeScript 판 `ts/src/toss/toss-auth.ts` 와 같다.

    토스는 클라이언트 하나에 유효한 토큰이 하나뿐이고 새로 발급하면 이전 토큰이 즉시 무효가 된다. 그래서 발급한 토큰은
    `expires_in` 에서 여유를 뺀 시각까지 메모리와 토큰 저장소에 두고, 발급은 저장소의 락으로 한 번에 한 곳만 한다.
    """

    def __init__(self, client_id: str, issue: Callable[[], Dict[str, Any]],
                 store_of: Callable[[], Optional[BrokerTokenStore]] = lambda: None) -> None:
        self.client_id = client_id
        self.issue = issue
        self.store_of = store_of
        self.cached_token: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()

    @property
    def store_key(self) -> str:
        return f'{TOKEN_KEY_PREFIX}{self.client_id[:CLIENT_ID_KEY_LENGTH]}'

    def get_access_token(self) -> str:
        """유효한 액세스 토큰. 메모리 캐시, 토큰 저장소, 새 발급 순으로 찾는다. 같은 프로세스 안의 동시 갱신은 하나로 합친다."""
        cached = self.cached_token
        if cached is not None and cached['expiresAt'] > _now_ms():
            return cached['accessToken']
        with self._lock:
            cached = self.cached_token
            if cached is not None and cached['expiresAt'] > _now_ms():
                return cached['accessToken']
            return self._read_store_or_issue()

    def _read_store_or_issue(self) -> str:
        stored = self._read_stored_token()
        if stored is not None:
            return stored

        def issue_and_cache() -> str:
            # 락을 잡은 뒤 한 번 더 읽는다. 그사이 다른 프로세스가 발급했으면 또 발급해 그 토큰을 무효로 만들지 않는다.
            already = self._read_stored_token()
            if already is not None:
                return already
            token = self._issue_token()
            store = self.store_of()
            if store is not None:
                self._save_to_store(store)
            return token

        return refresh_token_with_lock('[toss]', self.store_of(), self.store_key, TOKEN_FETCH_LOCK_TTL_MS,
                                       self._read_stored_token, issue_and_cache)

    def _read_stored_token(self) -> Optional[str]:
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
            logger.warning('[toss] 토큰 저장소 조회에 실패해 새로 발급한다', exc_info=True)
            return None

    def _issue_token(self) -> str:
        logger.info('[toss] 접근 토큰을 발급한다')
        issued = self.issue()
        access_token = issued.get('accessToken')
        if not access_token:
            raise AuthenticationError('토스 토큰 응답에 access_token 이 없다')
        expires_in = issued.get('expiresInSeconds')
        ttl_ms = expires_in * 1000 if expires_in is not None and expires_in > 0 else TOSS_TOKEN_DEFAULT_TTL_MS
        self.cached_token = {'accessToken': access_token, 'expiresAt': _now_ms() + ttl_ms - TOSS_TOKEN_SAFETY_MARGIN_MS}
        return access_token

    def _save_to_store(self, store: BrokerTokenStore) -> None:
        if self.cached_token is None:
            return
        try:
            ttl_ms = self.cached_token['expiresAt'] - _now_ms()
            if ttl_ms > 0:
                store.set(self.store_key, fn.json_stringify(self.cached_token), int(ttl_ms))
        except Exception:
            logger.warning('[toss] 토큰을 저장소에 넣지 못했다(메모리 캐시는 유효하다)', exc_info=True)

    def invalidate(self, failed_token: Str = None) -> None:
        """토큰 캐시를 비운다. `failed_token` 을 주면 그 토큰이 캐시에 그대로 있을 때만 지운다.

        401 은 다른 프로세스의 새 발급으로 내 토큰이 이미 무효가 됐다는 뜻일 수 있다. 그때 저장소에는 그 프로세스가 방금 넣은
        유효한 새 토큰이 있으므로, 무조건 지우면 또 발급하게 되고 프로세스끼리 401·삭제·재발급을 되풀이한다.
        """
        force = failed_token is None
        if force or (self.cached_token is not None and self.cached_token.get('accessToken') == failed_token):
            self.cached_token = None
        store = self.store_of()
        if store is None:
            return
        try:
            if force:
                store.delete(self.store_key)
            else:
                store.delete_if_access_token_equals(self.store_key, failed_token)
        except Exception:
            logger.debug('[toss] 저장소의 토큰을 지우지 못했다(메모리 캐시는 비웠다)', exc_info=True)


class toss(Exchange, ImplicitAPI):

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.access_token: Str = None
        self._token_auth: Optional[TossAuth] = None
        self._token_auth_client_id: Str = None
        self._blocked_until: Dict[str, int] = {}
        self._account_seq_lock = threading.Lock()
        super().__init__(config)

    def describe(self) -> Dict[str, Any]:
        return self.deep_extend(super().describe(), {
            'id': 'toss',
            'name': 'Toss Securities',
            'countries': ['KR'],
            'version': 'v1',
            'hostname': 'openapi.tossinvest.com',
            'rateLimit': GLOBAL_RATE_LIMIT_MS,
            'timeout': READ_TIMEOUT_MS,
            'orderTimeout': ORDER_TIMEOUT_MS,
            # 옮긴 통합 메서드만 True 다. 나머지는 TypeScript 판에 있고 Python 판에는 아직 없다.
            'has': {
                'CORS': None,
                'spot': True,
                'margin': False,
                'swap': False,
                'future': False,
                'option': False,
                'sandbox': False,
                'ws': False,
                'createLimitOrder': False,
                'createMarketOrder': False,
                'fetchMarkets': False,
                'fetchCurrencies': False,
            },
            'urls': {
                'logo': None,
                'api': {
                    'public': 'https://{hostname}',
                    'private': 'https://{hostname}/api/{version}',
                },
                'www': 'https://tossinvest.com',
                'doc': [
                    'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
                    'https://openapi.tossinvest.com/openapi-docs/overview.md',
                ],
            },
            # 그룹별 공식 한도(초당 호출 수)에서 여유를 두고 정했다(TypeScript 판과 같은 값).
            'rateLimitBuckets': {
                'auth': {'rateLimit': 334},
                'account': {'rateLimit': 1100},
                'asset': {'rateLimit': 1100},
                'stock': {'rateLimit': 250},
                'stock_all': {'rateLimit': 1100},
                'market_info': {'rateLimit': 500},
                'market_data': {'rateLimit': 100},
                'market_data_chart': {'rateLimit': 100},
                'ranking': {'rateLimit': 250},
                'market_indicator': {'rateLimit': 125},
                'market_indicator_chart': {'rateLimit': 250},
                'stock_trading_trend': {'rateLimit': 125},
                'order': {'rateLimit': 125},
                'order_history': {'rateLimit': 250},
                'order_info': {'rateLimit': 250},
                'conditional_order': {'rateLimit': 250},
                'conditional_order_history': {'rateLimit': 125},
            },
            'requiredCredentials': {'apiKey': True, 'secret': True, 'uid': False},
            'timeframes': {'1m': '1m', '1d': '1d'},
            'fees': {
                'trading': {'tierBased': False, 'percentage': True, 'taker': TOSS_BROKERAGE_FEE, 'maker': TOSS_BROKERAGE_FEE},
            },
            # 토스에서 400·403·404·409 는 요청이 거절됐다는 뜻이라 재시도해도 소용없는 오류로 옮긴다.
            'httpExceptions': {
                '400': BadRequest,
                '401': AuthenticationError,
                '403': PermissionDenied,
                '404': ExchangeError,
                '409': ExchangeError,
                '414': BadRequest,
                '415': BadRequest,
                '422': ExchangeError,
                '429': RateLimitExceeded,
            },
            'exceptions': {
                'exact': {
                    'invalid-request': BadRequest,
                    'confirm-high-value-required': InvalidOrder,
                    'account-header-required': BadRequest,
                    'unsupported-ranking-duration': BadRequest,
                    'unsupported-symbol': BadSymbol,
                    'unsupported-market': BadSymbol,
                    'invalid-token': AuthenticationError,
                    'expired-token': AuthenticationError,
                    'token-revoked': AuthenticationError,
                    'login-user-not-found': AuthenticationError,
                    'forbidden': PermissionDenied,
                    'stock-not-found': BadSymbol,
                    'exchange-rate-not-found': ExchangeError,
                    'account-not-found': AuthenticationError,
                    'order-not-found': OrderNotFound,
                    'conditional-order-not-found': OrderNotFound,
                    'already-filled': OrderNotFound,
                    'already-canceled': OrderNotFound,
                    'already-modified': OrderNotFound,
                    'already-rejected': OrderNotFound,
                    'already-processing': OperationRejected,
                    'opposite-pending-order-exists': InvalidOrder,
                    # 같은 멱등키의 주문이 처리 중이라 첫 요청의 결과를 아직 모른다.
                    'request-in-progress': OrderOutcomeUnknown,
                    'insufficient-buying-power': InsufficientFunds,
                    'insufficient-sellable-quantity': InsufficientFunds,
                    'order-hours-closed': MarketClosed,
                    'amount-order-outside-regular-hours': MarketClosed,
                    'fractional-quantity-outside-regular-hours': MarketClosed,
                    'stock-restricted': InvalidOrder,
                    'price-out-of-range': InvalidOrder,
                    'order-type-not-allowed': InvalidOrder,
                    'max-order-amount-exceeded': InvalidOrder,
                    'order-limit-exceeded': InvalidOrder,
                    'duplicate-conditional-order': InvalidOrder,
                    'condition-already-met': InvalidOrder,
                    'idempotency-key-conflict': DuplicateOrderId,
                    'market-not-supported-for-stock': BadSymbol,
                    'modify-restricted': OperationRejected,
                    'cancel-restricted': OperationRejected,
                    'account-restricted': AccountNotEnabled,
                    'prerequisite-required': ManualInteractionNeeded,
                    'investor-exchange-not-integrated': ManualInteractionNeeded,
                    'rate-limit-exceeded': RateLimitExceeded,
                    'edge-rate-limit-exceeded': RateLimitExceeded,
                    'internal-error': ExchangeNotAvailable,
                    'maintenance': OnMaintenance,
                },
                'broad': {},
            },
            'precisionMode': TICK_SIZE,
            'options': {
                # 토큰과 발급 락을 여러 프로세스가 나눠 쓰는 저장소(BrokerTokenStore). 없으면 프로세스 메모리 캐시만 쓴다.
                'tokenStore': None,
                'authTimeout': AUTH_TIMEOUT_MS,
                'listedMarkets': LISTED_MARKETS,
            },
        })

    # ============ 인증과 요청 ============

    @staticmethod
    def needs_account(api: ApiName) -> bool:
        """이 요청이 계좌 헤더(`X-Tossinvest-Account`)를 필요로 하는 API 인가."""
        return isinstance(api, (list, tuple)) and 'account' in api

    def token_auth(self) -> TossAuth:
        """토큰 캐시 관리자. 클라이언트 ID 가 바뀌면 새로 만든다."""
        client_id = self.apiKey or ''
        if self._token_auth is None or self._token_auth_client_id != client_id:
            self._token_auth = TossAuth(client_id, self._issue_access_token, self.get_token_store)
            self._token_auth_client_id = client_id
        return self._token_auth

    def _issue_access_token(self) -> Dict[str, Any]:
        response = self.public_post_oauth2_token({})
        return {
            'accessToken': self.safe_string(response, 'access_token', ''),
            'expiresInSeconds': self.safe_integer(response, 'expires_in'),
            'tokenType': self.safe_string(response, 'token_type'),
        }

    def authenticate(self, path: str, api: ApiName, method: str, params: Dict[str, Any], headers: Optional[Dict[str, str]],
                     body: Str) -> None:
        """요청 앞에서 액세스 토큰을 준비하고, 계좌 API 에는 계좌 순번(`uid`)을 채운다."""
        self.access_token = self.token_auth().get_access_token()
        if self.needs_account(api) and self.uid is None:
            self.load_account_seq()

    def load_account_seq(self) -> None:
        """`uid` 가 없을 때 `GET /accounts` 의 첫 계좌 순번을 찾아 `uid` 에 넣는다. 여러 스레드가 동시에 불러도 요청은 한 번 나간다."""
        with self._account_seq_lock:
            if self.uid is not None:
                return
            accounts = self.unwrap(self.private_market_get_accounts({}))
            first = accounts[0] if isinstance(accounts, list) and accounts else None
            seq = self.safe_string(first, 'accountSeq')
            if seq is None:
                raise NullResponse(f'{self.id} 계좌 조회 실패: 응답에 accountSeq 가 없다')
            self.uid = seq

    def sign(self, path: str, api: ApiName = 'public', method: str = 'GET', params: Optional[Dict[str, Any]] = None,
             headers: Optional[Dict[str, str]] = None, body: Str = None) -> Dict[str, Any]:
        params = {} if params is None else params
        group = api[0] if isinstance(api, (list, tuple)) else api
        base = self.implode_params(self.urls['api'][group], {'hostname': self.hostname, 'version': self.version})
        path_params = self.extract_params(path)
        encoded = {key: fn.encode_uri_component(fn.js_string(params.get(key))) for key in path_params}
        url = f'{base}/{self.implode_params(path, encoded)}'
        query = self.omit(params, path_params)
        if group == 'public':
            # 토큰 발급은 폼 인코딩 본문에 자격증명을 싣는다.
            form = fn.form_urlencode({'grant_type': 'client_credentials', 'client_id': self.apiKey or '', 'client_secret': self.secret or ''})
            return {'url': url, 'method': method, 'headers': {'Content-Type': 'application/x-www-form-urlencoded'}, 'body': form}
        if self.access_token is None:
            raise AuthenticationError(f'{self.id} 액세스 토큰이 준비되지 않았다')
        request_headers = self.extend({'Authorization': f'Bearer {self.access_token}'}, headers)
        if self.needs_account(api):
            if self.uid is None:
                raise AuthenticationError(f'{self.id} 계좌 순번(uid)이 없다')
            request_headers['X-Tossinvest-Account'] = self.uid
        if method in ('GET', 'DELETE'):
            if query:
                url += '?' + self.urlencode(query)
        else:
            body = self.json(query)
            request_headers['Content-Type'] = 'application/json'
        return {'url': url, 'method': method, 'headers': request_headers, 'body': body}

    def fetch(self, url: str, method: str = 'GET', headers: Optional[Dict[str, str]] = None, body: Str = None,
              timeout_ms: Optional[float] = None) -> Any:
        """토큰 발급은 조회보다 짧은 상한을 쓴다."""
        timeout_ms = self.timeout if timeout_ms is None else timeout_ms
        if url.endswith('/oauth2/token'):
            timeout_ms = self.safe_integer(self.options, 'authTimeout', int(timeout_ms))
        return super().fetch(url, method, headers, body, timeout_ms)

    def fetch2(self, path: str, api: ApiName = 'public', method: str = 'GET', params: Optional[Dict[str, Any]] = None,
               headers: Optional[Dict[str, str]] = None, body: Str = None, config: Optional[Dict[str, Any]] = None) -> Any:
        """토큰이 거절되면(401) 그 토큰만 무효로 만들고 한 번 다시 보낸다. 401 은 처리 전에 거절된 것이라 주문도 다시 보내도 안전하다."""
        try:
            return self._fetch_once(path, api, method, params, headers, body, config)
        except TossTokenRejected as error:
            logger.warning('[toss] 401 을 받아 토큰을 무효화하고 한 번 다시 시도한다: %s', path)
            self.token_auth().invalidate(error.failed_token)
            return self._fetch_once(path, api, method, params, headers, body, config)

    def _fetch_once(self, path: str, api: ApiName, method: str, params: Optional[Dict[str, Any]], headers: Optional[Dict[str, str]],
                    body: Str, config: Optional[Dict[str, Any]]) -> Any:
        try:
            return super().fetch2(path, api, method, params, headers, body, config)
        except TossRateLimited as error:
            wait = min(error.retry_after_ms if error.retry_after_ms is not None else DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS)
            self._blocked_until[self.safe_string(config, 'bucket', '')] = _now_ms() + int(wait)
            raise

    def calculate_rate_limiter_cost(self, api: ApiName, method: str, path: str, params: Dict[str, Any],
                                    config: Optional[Dict[str, Any]] = None) -> float:
        cost = self.safe_number(config, 'cost', 1)
        return cost * PEAK_COST_FACTOR if (config or {}).get('peak') is True and is_order_info_peak_window() else cost

    def throttle(self, cost: Num = None, bucket: Str = None) -> None:
        """그룹 한도에 더해 계정 전체 상한(`rateLimit`)도 지키고, 429 뒤에 쉬라고 한 시간이 남았으면 기다린다."""
        blocked_for = self._blocked_until.get(bucket or '', 0) - _now_ms()
        if blocked_for > 0:
            self.sleep(blocked_for)
        super().throttle(cost, bucket)
        if bucket is not None:
            super().throttle(1, None)

    def handle_errors(self, code: int, reason: str, url: str, method: str, headers: Dict[str, str], body: str, response: Any,
                      request_headers: Optional[Dict[str, str]], request_body: Str) -> Optional[bool]:
        """토스는 실패를 HTTP 상태와 본문의 오류 코드(`error.code` 또는 `error`) 두 층으로 준다. 401·403·429 는 상태가 먼저이고,
        그 밖에는 코드 표(`exceptions['exact']`)를 본 다음 상태 표(`httpExceptions`)를 본다. 코드는 오류의 `detail` 에 담는다."""
        error_value = self.safe_value(response, 'error')
        if code < 400 and error_value is None:
            return None
        error_code = error_value if isinstance(error_value, str) else self.safe_string(error_value, 'code')
        if error_code is None:
            error_code = self.safe_string(response, 'code')
        description = self.safe_string(response, 'error_description') if isinstance(error_value, str) else self.safe_string(error_value, 'message')
        is_token_request = url.endswith('/oauth2/token')
        if is_token_request:
            feedback = f'토스 토큰 발급 실패: {code} {body}'
        elif code >= 400:
            feedback = f'토스 API 오류: {code} {body}'
        else:
            feedback = f'토스 API 비즈니스 오류 [{error_code}]: {description or ""}'
        if code == 401:
            if is_token_request:
                raise AuthenticationError(feedback, detail=error_code)
            authorization = self.safe_string(request_headers, 'Authorization')
            failed_token = authorization[len('Bearer '):] if authorization is not None and authorization.startswith('Bearer ') else None
            raise TossTokenRejected(feedback, detail=error_code, failed_token=failed_token)
        if code == 403:
            raise PermissionDenied(feedback, detail=error_code)
        if code == 429:
            retry_after = self.safe_number(headers, 'Retry-After')
            raise TossRateLimited(feedback, detail=error_code, retry_after_ms=None if retry_after is None else retry_after * 1000)
        # 호가 단위를 어긴 주문은 invalid-request 에 올바른 호가 단위가 data.tickSize 로 실려 온다.
        if error_code == 'invalid-request' and self.safe_value(self.safe_dict(error_value, 'data'), 'tickSize') is not None:
            raise InvalidOrder(feedback, detail='price-tick-invalid')
        self.throw_exactly_matched_exception(self.exceptions.get('exact'), error_code, feedback, detail=error_code)
        by_status = self.httpExceptions.get(str(code))
        if by_status is not None:
            raise by_status(feedback, detail=error_code)
        if code >= 500:
            raise ExchangeNotAvailable(feedback, detail=error_code)
        raise ExchangeError(feedback, detail=error_code)

    def unwrap(self, response: Any) -> Any:
        """응답의 `result` 봉투를 벗긴다. 봉투가 없으면 원본을, 본문이 비어 있으면 `None` 을 돌려준다."""
        if isinstance(response, dict) and 'result' in response:
            return response['result']
        return None if response == '' else response
