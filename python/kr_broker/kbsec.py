# 이 파일은 scripts/gen-python-sync.mjs 가 python/kr_broker/async_support/kbsec.py 에서 만든다. 직접 고치지 않는다.
"""KB증권 Open API(`class kbsec(Exchange, ImplicitAPI)`). TypeScript 판 `ts/src/kbsec.ts` 와 `ts/src/kbsec/kbsec-auth.ts` 를 옮기는 중이다.
지금은 인증과 요청 봉투, 오류 처리, 토큰 복구, 시세(`fetch_ticker`, `fetch_order_book`, `fetch_ohlcv`, `fetch_trades`), 수수료 추정
(`fetch_trading_fee`), 휴장일(`fetch_market_calendar`, `refresh_market_calendar`), 투자자 매매동향(`fetch_investor_trading`)만 옮겼다.
`has` 가 `False` 인 통합 메서드는 부모 클래스가 `NotSupported` 를 던진다. 모든 TR 은 암묵 메서드로 부를 수 있다.

.. code-block:: python

    import kr_broker
    broker = kr_broker.kbsec({'apiKey': APP_KEY, 'secret': APP_SECRET})
    ticker = broker.fetch_ticker('005930/KRW')
    body = broker.private_post_ssqm1801({'inq_clsf': '1', 'mkt_tm_ccd': '1'})['dataBody']

자격증명
    `apiKey` 는 앱키, `secret` 은 앱시크릿이다. KB 는 계좌번호를 받지 않는다(계좌가 앱키에 묶인다). 모의투자 서버가 없어
    `set_sandbox_mode(True)` 는 `NotSupported` 다.

심볼
    국내는 `005930/KRW`, 미국은 `AAPL/USD` 다. 종목 목록을 받지 않고 심볼 모양으로 종목을 만든다(`market['info']['country']` 가 `KR` 이나 `US`).
    현금 코드와 같은 티커(`USD`)는 `commonStockCodes` 의 통합 코드로 심볼을 만든다(`ProShares Ultra Semiconductors/USD`). 입력은 `USD/USD` 도 받는다.

요청
    모든 호출이 `POST /api/v1/{trcode}` 이고 본문은 `{dataHeader, dataBody}` 봉투다. `dataBody` 는 TR 입력 레이아웃(`kbsec_tr_inputs`)의 빠진 필드를
    빈 문자열로 채워 보낸다. 업무 오류는 HTTP 200 으로도 500 으로도 온다. 봉투의 `processFlag` 가 정본이고, `processCode` 는 오류의 `broker_code` 에 싣는다.
    토큰이 무효(HTTP 401, `I445`)면 토큰을 회전하고 한 번만 다시 보낸다. 그 뒤에도 토큰 실패가 이어지면 차단기(`kbsec_token_breaker`)가 호출을 멈춘다.

옵션
    `tokenStore`(토큰 저장소), `masterData`(국내 종목 유형과 시장. `price_to_precision` 과 통합차트의 시장구분이 쓴다), `hostAddr`(TR 본문에 싣는 `{'ipAddr', 'macAddr'}`.
    주지 않으면 이 호스트의 주소를 찾아 쓴다. KB 는 빈 값을 받지 않는다)다.
"""

import base64
import json
import logging
import math
import re
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Tuple, cast

from kr_broker.abstract.kbsec import ImplicitAPI
from kr_broker.base.exchange import Exchange
from kr_broker.base.runtime import maybe_await, new_lock
from kr_broker.base.token_store import refresh_token_with_lock
from kr_broker.market_calendar import refresh_market_calendar as refresh_shared_market_calendar
from kr_broker.base import functions as fn
from kr_broker.base.decimal_to_precision import NO_PADDING, ROUND, TICK_SIZE, decimal_to_precision
from kr_broker.base.errors import (
    ArgumentsRequired, AuthenticationError, BadResponse, BadSymbol, BaseError, ExchangeError, ExchangeNotAvailable, NetworkError,
    NotSupported, NullResponse, RateLimitExceeded,
)
from kr_broker.base.exchange import assert_secure_url, kst_trade_timestamps
from kr_broker.base.token_store import BrokerTokenStore, token_store_key
from kr_broker.base.types import ApiName, Int, Market, MarketInterface, Num, OrderBook, Str, Ticker, Trade, TradingFeeInterface
from kr_broker.broker_time import candle_period_utc_ms, is_daily_or_longer_timeframe, kst_ymd
from kr_broker.kbsec_chart import KBSEC_CHART_MAX, KBSEC_TIMEFRAMES, kbsec_bar_ms, kbsec_candle_timestamp, kbsec_chart_params
from kr_broker.kbsec_envelope import is_kbsec_business_error, is_kbsec_token_failure, kbsec_host_addr
from kr_broker.kbsec_error_codes import KBSEC_ERROR_DETAIL, kbsec_error_detail, kbsec_exact_exceptions
from kr_broker.kbsec_fee import kbsec_estimated_fee_rate
from kr_broker.kbsec_pick import pick_array, pick_num, pick_positive_num, pick_str
from kr_broker.kbsec_token_breaker import record_kbsec_call_ok, record_token_failure, throw_if_token_breaker_open
from kr_broker.kbsec_tr_inputs import fill_tr_inputs
from kr_broker.kbsec_types import (
    KBSEC_API_BASE, KBSEC_REVOKE_PATH, KBSEC_TOKEN_DEFAULT_TTL_MS, KBSEC_TOKEN_PATH, KBSEC_TOKEN_SAFETY_MARGIN_MS, KBSEC_TR,
    KBSEC_TR_PATH_PREFIX, KBSEC_US_EXCHANGES, kbsec_base_symbol, kbsec_market_of, kbsec_num,
)
from kr_broker.kis_master_data import master_data_of
from kr_broker.kis_stock_master import get_krx_stock_by_code
from kr_broker.krx_tick_size import get_krx_tick_size
from kr_broker.market_calendar import expand_business_days

logger = logging.getLogger('kr_broker')

# 조회 요청 상한. KB 는 토큰 발급이 분당 1회로 제한되고 과도한 반복 조회를 계정 제한 사유로 들므로, 정상 응답을 자르지 않게 넉넉히 둔다.
READ_TIMEOUT_MS = 20_000
# 주문 요청 상한. 호출하는 쪽이 주문에 두는 바깥 상한(보통 30초)보다 짧아야 요청을 끊고 `OrderOutcomeUnknown` 으로 다룬다.
ORDER_TIMEOUT_MS = 25_000
# 요청 사이 간격(ms). KB 는 호출 제한 수치를 공개하지 않아 초당 2~3회로 낮게 잡았다.
RATE_LIMIT_MS = 400
# 토큰 발급·폐기 요청 상한. 토큰 요청이 멈추면 그 뒤의 TR 이 모두 멈추므로 조회 상한보다 짧다.
AUTH_TIMEOUT_MS = 10_000
# 토큰 발급 락 TTL(한국투자증권과 같은 값).
TOKEN_FETCH_LOCK_TTL_MS = 90 * 1000
# 토큰 폐기 쿨다운. 토큰 장애 중에는 모든 TR 이 I445 로 실패하므로 실패마다 폐기를 부르지 않는다.
REVOKE_COOLDOWN_MS = 5 * 60 * 1000
# 휴장일 캘린더를 다시 받기까지의 시간. 장운영상태 TR 은 전·기준·익영업일만 줘서 자주 받아야 한다.
CALENDAR_TTL_MS = 6 * 60 * 60 * 1000
# 토큰 저장소 키 앞부분. 뒤에 앱키의 해시가 붙는다.
KBSEC_TOKEN_KEY_PREFIX = 'kbsec:token:'
# 발급·폐기 요청의 `dataHeader`. TR 과 달리 빈 주소를 받는다.
_EMPTY_HOST = {'ipAddr': '', 'macAddr': ''}


def _now_ms() -> int:
    return fn.milliseconds()


def _get(value: Any, key: str) -> Any:
    """JavaScript `value?.[key]` 처럼 읽는다. 사전이 아니면 `None` 이다."""
    return value.get(key) if isinstance(value, dict) else None


def _process_code_of(text: str) -> Str:
    """KB 봉투(`dataHeader.processCode`)의 업무 코드. JSON 이 아니거나 코드가 비었으면 `None` 이다."""
    try:
        code = _get(_get(json.loads(text), 'dataHeader'), 'processCode')
    except ValueError:
        return None
    return code if isinstance(code, str) and code.strip() != '' else None


def token_jti(token: str) -> Str:
    """JWT 의 `jti`. 토큰 동일성 판정의 정본이다.

    앞부분 비교로 판정하지 않는다. 헤더와 payload 앞부분(`sub`·`aud`)이 모든 토큰에서 같아 서로 다른 토큰도 접두가 같다.
    JWT 가 아니거나 `jti` 가 없으면 `None` 이고, 그때는 동일성을 모르는 것으로 다룬다. payload 는 패딩 없는 base64url 이다.
    """
    parts = token.split('.')
    payload = parts[1] if len(parts) > 1 else ''
    if not payload:
        return None
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)).decode('utf-8', errors='replace'))
    except ValueError:
        return None
    jti = _get(claims, 'jti')
    return jti if isinstance(jti, str) and jti != '' else None


class KbsecAuth:
    """KB증권 OAuth2 토큰의 캐시와 발급, 토큰 장애 뒤의 회전. TypeScript 판 `ts/src/kbsec/kbsec-auth.ts` 와 같다.

    토큰은 프로세스 메모리 → 토큰 저장소 → 새 발급 순으로 찾는다. 발급은 저장소의 락으로 한 곳에서만 한다(KB 는 발급 빈도를 제한한다).
    발급 본문은 공식 예제 저장소의 봉투 형태(`grantType`)를 먼저 보내고, 거절되면 포털 가이드의 평면 형태(`grant_type`)로 한 번 더 보낸다.
    통한 형태는 기억한다. 연결 실패, 시간 초과, 업무 코드 없는 5xx, 429 는 본문 형태와 관계없으므로 다른 형태로 다시 보내지 않는다.

    요청은 `post_json(url, body)` 로 보낸다. 증권사 인스턴스의 `http_request` 를 직접 쓰므로 `handle_errors` 와 verbose 로그를 거치지 않는다.
    """

    def __init__(self, app_key: str, app_secret: str, base_url: str, post_json: Callable[[str, Any], Tuple[int, str]],
                 store_of: Callable[[], Optional[BrokerTokenStore]] = lambda: None) -> None:
        self.app_key = app_key
        self.app_secret = app_secret
        self.base_url = base_url
        self.post_json = post_json
        self.raw_store_of = store_of
        self.cached_token: Optional[Dict[str, Any]] = None
        # 통한 발급 본문 형태. 두 번째 발급부터는 그 형태만 보낸다.
        self.working_shape: Str = None
        # 마지막 폐기 시도 시각(ms). 인스턴스 단위로만 제한한다.
        self.last_revoke_attempt_at = 0
        self._lock = new_lock()

    @property
    def store_key(self) -> str:
        return token_store_key(KBSEC_TOKEN_KEY_PREFIX, self.app_key)

    def store_of(self) -> Any:
        """토큰 저장소. 인스턴스 옵션 `tokenStore` 를 그대로 쓴다."""
        return self.raw_store_of()

    def get_access_token(self) -> str:
        """유효한 접근 토큰. 같은 프로세스 안의 동시 갱신은 락으로 하나로 합친다."""
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
            return refresh_token_with_lock('[KBSecAuth]', self.store_of(), self.store_key, TOKEN_FETCH_LOCK_TTL_MS,
                                           self._read_cached_token, self._issue_token)

    def invalidate(self, failed_token: Str = None) -> None:
        """토큰 캐시를 프로세스 메모리와 토큰 저장소에서 지운다. 토큰 실패 뒤 다시 보내기 전에 부르고 끝날 때까지 기다린다.

        `failed_token` 을 주면 그 토큰이 캐시에 그대로 있을 때만 메모리 캐시를 비우고, 저장소도 같은 토큰일 때만 지운다.
        동시 요청 가운데 먼저 끝난 쪽이 받아 둔 새 토큰을 지우지 않기 위해서다.
        """
        cached = self.cached_token
        if failed_token is None or (cached is not None and cached['accessToken'] == failed_token):
            self.cached_token = None
        store = self.store_of()
        if store is not None:
            try:
                if failed_token:
                    if not maybe_await(store.delete_if_access_token_equals(self.store_key, failed_token)):
                        logger.info('[KBSecAuth] 메모리 캐시만 무효화 — 토큰 저장소에는 이미 다른(더 새) 토큰이 있다')
                        return
                else:
                    maybe_await(store.delete(self.store_key))
            except Exception:
                logger.debug('[KBSecAuth] 토큰 저장소 삭제 실패 (메모리 캐시 무효화는 완료)', exc_info=True)
        logger.info('[KBSecAuth] 토큰 캐시 초기화')

    def rotate_after_token_failure(self, failed_token: str) -> None:
        """토큰 실패(I445) 뒤 토큰을 회전한다.

        KB 는 쓸 수 없게 된 토큰을 재발급 요청에도 같은 `jti` 로 돌려줄 수 있어 무효화만으로는 회복되지 않는다. 재발급 결과가 실패한 토큰과
        같은 `jti` 일 때만 `/oauth2/revoke` 로 폐기하고 한 번 더 발급한다. 새 토큰이 오면 폐기하지 않으므로 다른 프로세스가 쓰는 토큰을 없애지 않는다.
        폐기가 실패하면 재발급한 토큰을 그대로 둔다. 폐기는 `REVOKE_COOLDOWN_MS` 에 한 번만 시도한다.
        """
        self.invalidate(failed_token)
        reissued = self.get_access_token()
        if token_jti(reissued) is None or token_jti(reissued) != token_jti(failed_token):
            return
        now = _now_ms()
        if now - self.last_revoke_attempt_at < REVOKE_COOLDOWN_MS:
            logger.debug('[KBSecAuth] 폐기 쿨다운 중 — 이번 실패는 종전 동작으로: sinceMs=%s', now - self.last_revoke_attempt_at)
            return
        self.last_revoke_attempt_at = now
        logger.warning('[KBSecAuth] 재발급이 같은 토큰을 돌려줬다 — 명시 폐기 후 재발급: jti=%s', token_jti(failed_token))
        if not self._revoke_token(failed_token):
            return
        # 폐기된 토큰은 누가 갖고 있든 쓸 수 없으므로 무조건 지운다.
        self.invalidate()
        fresh = self.get_access_token()
        logger.info('[KBSecAuth] 폐기 후 재발급 완료: rotated=%s jti=%s', token_jti(fresh) != token_jti(failed_token), token_jti(fresh))

    def _revoke_token(self, token: str) -> bool:
        """`/oauth2/revoke` 호출. `processFlag` 가 `A` 면 성공이다. 본문 필드 이름이 공식 문서에 없어 후보를 순서대로 시도한다."""
        credentials = {'appKey': self.app_key, 'appSecret': self.app_secret}
        candidates = [
            ('token', fn.extend(credentials, {'token': token})),
            ('accessToken', fn.extend(credentials, {'accessToken': token})),
            ('access_token', fn.extend(credentials, {'access_token': token})),
        ]
        for label, data_body in candidates:
            try:
                status, text = self.post_json(f'{self.base_url}{KBSEC_REVOKE_PATH}', {'dataHeader': _EMPTY_HOST, 'dataBody': data_body})
                if _get(_get(json.loads(text), 'dataHeader'), 'processFlag') == 'A':
                    logger.info('[KBSecAuth] 토큰 폐기 성공: shape=%s', label)
                    return True
                logger.debug('[KBSecAuth] 토큰 폐기 실패 — 다음 형태 시도: shape=%s status=%s body=%s', label, status, text[:200])
            except Exception:
                logger.debug('[KBSecAuth] 토큰 폐기 요청 오류 — 다음 형태 시도: shape=%s', label, exc_info=True)
        logger.warning('[KBSecAuth] 토큰 폐기 — 시도한 본문 형태 전부 실패: shapes=%s', [label for label, _ in candidates])
        return False

    def _read_cached_token(self) -> Optional[str]:
        """토큰 저장소의 유효한 토큰. 없거나 만료됐으면 `None`."""
        store = self.store_of()
        if store is None:
            return None
        try:
            raw = maybe_await(store.get(self.store_key))
            if not raw:
                return None
            parsed = json.loads(raw)
            if parsed['expiresAt'] <= _now_ms():
                return None
            self.cached_token = parsed
            return parsed['accessToken']
        except Exception:
            logger.debug('[KBSecAuth] 토큰 저장소 조회 실패 — 신규 발급', exc_info=True)
            return None

    def _issue_token(self) -> str:
        """본문 형태를 차례로 보내 발급한다. 모두 거절되면 형태별 오류를 모아 `AuthenticationError` 로 던진다.
        `broker_code` 는 첫 형태의 업무 코드만 싣는다. 나중에 보내는 평면 형태는 원인과 관계없이 `E021` 을 받기 때문이다."""
        shapes = [self.working_shape] if self.working_shape else ['envelope', 'flat']
        failures: List[str] = []
        broker_code: Str = None
        for shape in shapes:
            try:
                token = self._request_token(shape)
                self.working_shape = shape
                return token
            except NetworkError:
                raise
            except Exception as err:
                if not failures and isinstance(err, BaseError):
                    broker_code = err.broker_code
                failures.append(f'{shape}: {type(err).__name__}: {err}')
                logger.warning('[KBSecAuth] 토큰 발급 실패 — 다른 본문 형태로 재시도: shape=%s err=%s', shape, err)
        raise AuthenticationError('[KBSecAuth] 토큰 발급 실패 — 시도한 본문 형태 전부 실패\n  ' + '\n  '.join(failures), broker_code=broker_code)

    def _request_token(self, shape: str) -> str:
        if shape == 'envelope':
            body: Dict[str, Any] = {'dataHeader': _EMPTY_HOST,
                                    'dataBody': {'appKey': self.app_key, 'appSecret': self.app_secret, 'grantType': 'client_credentials'}}
        else:
            body = {'grant_type': 'client_credentials', 'appKey': self.app_key, 'appSecret': self.app_secret}
        status, text = self.post_json(f'{self.base_url}{KBSEC_TOKEN_PATH}', body)
        if not 200 <= status < 300:
            message = f'KB증권 토큰 발급 오류: {status} {text[:300]}'
            if status == 429:
                raise RateLimitExceeded(message)
            # KB 는 자격증명 오류(E021 등)도 HTTP 500 과 봉투의 processCode 로 준다. 업무 코드가 없는 5xx 만 일시 장애다.
            broker_code = _process_code_of(text)
            if status >= 500 and broker_code is None:
                raise ExchangeNotAvailable(message)
            raise AuthenticationError(message, broker_code=broker_code)
        try:
            parsed = json.loads(text)
        except ValueError:
            raise ValueError(f'KB증권 토큰 응답이 JSON 이 아님: {text[:200]}') from None
        # 봉투 응답(dataBody.access_token)과 평면 응답(access_token)을 모두 받는다.
        data_body = _get(parsed, 'dataBody')
        payload = parsed if data_body is None else data_body
        access_token = _get(payload, 'access_token')
        if access_token is None:
            access_token = _get(payload, 'accessToken')
        if not access_token:
            # KB 는 발급 거절을 HTTP 200 과 빈 토큰, 실패 봉투(`processFlag B`)로도 준다.
            header = _get(parsed, 'dataHeader')
            broker_code = _process_code_of(text) if is_kbsec_business_error(header if isinstance(header, dict) else None) else None
            raise AuthenticationError(f'KB증권 토큰 응답에 access_token 없음: {text[:200]}', broker_code=broker_code)
        expires_in = _get(payload, 'expires_in')
        valid_expiry = isinstance(expires_in, (int, float)) and not isinstance(expires_in, bool) and expires_in > 0
        ttl_ms = expires_in * 1000 if valid_expiry else KBSEC_TOKEN_DEFAULT_TTL_MS
        # 수명이 안전 여유의 두 배보다 짧으면(KB 는 만료 직전에 3초, 1초를 준다) 여유를 수명의 절반으로 줄인다.
        short_lived = ttl_ms <= KBSEC_TOKEN_SAFETY_MARGIN_MS * 2
        expires_at = _now_ms() + (math.floor(ttl_ms / 2) if short_lived else ttl_ms - KBSEC_TOKEN_SAFETY_MARGIN_MS)
        self.cached_token = {'accessToken': access_token, 'expiresAt': expires_at}
        # 저장소 쓰기도 기다린다. 수명이 짧거나 남은 수명이 없는 토큰은 저장하지 않는다(다른 프로세스가 곧 만료될 토큰을 가져다 쓴다).
        store = self.store_of()
        ttl_sec = math.floor((expires_at - _now_ms()) / 1000)
        if store is not None and ttl_sec > 0 and not short_lived:
            try:
                maybe_await(store.set(self.store_key, fn.json_stringify(self.cached_token), ttl_sec * 1000))
            except Exception:
                logger.warning('[KBSecAuth] 토큰 저장소 쓰기 실패 (메모리 캐시는 유효)', exc_info=True)
        logger.info('[KBSecAuth] 접근 토큰 발급 완료: shape=%s expiresInSec=%s', shape, math.floor(ttl_ms / 1000))
        return access_token


class kbsec(Exchange, ImplicitAPI):

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        # 발급한 토큰을 들고 있는 인증 객체. 앱키나 시크릿이 바뀌면 다시 만든다.
        self._auth: Optional[KbsecAuth] = None
        self._auth_identity = ''
        # 해외 종목의 KB 거래소코드(`krx_cd`). 심볼마다 한 번 찾아 둔다. NYSE 종목이 섞여 있어 `NAS` 로 고정하면 안 된다.
        self._us_exchange_cache: Dict[str, str] = {}
        super().__init__(config)

    def describe(self) -> Dict[str, Any]:
        return self.deep_extend(super().describe(), {
            'id': 'kbsec',
            'name': 'KB증권',
            'countries': ['KR'],
            'version': 'v1',
            'rateLimit': RATE_LIMIT_MS,
            'timeout': READ_TIMEOUT_MS,
            'orderTimeout': ORDER_TIMEOUT_MS,
            # 옮긴 통합 메서드만 True 다. 키는 TypeScript 판과 같다.
            'has': {
                'ws': False,
                'watchTicker': False,
                'watchTrades': False,
                'watchOrderBook': False,
                'watchOrders': False,
                'spot': True,
                'margin': False,
                'swap': False,
                'future': False,
                'option': False,
                'sandbox': False,
                'fetchMarkets': False,
                'fetchCurrencies': False,
                'fetchTicker': True,
                'fetchTickers': False,
                'fetchOrderBook': True,
                # 국내만 지원한다. 해외 차트는 15분 지연 시세라 `NotSupported` 다.
                'fetchOHLCV': True,
                'fetchBalance': False,
                'createOrder': False,
                'createLimitOrder': False,
                'createMarketOrder': False,
                'createTriggerOrder': False,
                'editOrder': False,
                'cancelOrder': False,
                'cancelAllOrders': False,
                'fetchOrder': False,
                'fetchOrders': False,
                'fetchOpenOrders': False,
                'fetchClosedOrders': False,
                'fetchCanceledOrders': False,
                'fetchMyTrades': False,
                'fetchTrades': True,
                # KB 에 수수료 조회 TR 이 없어 공시 요율로 추정한다.
                'fetchTradingFee': 'emulated',
                'fetchStatus': False,
                'fetchTime': False,
                # 주식 고유. 장운영상태 TR 로 전·기준·익영업일을 받아 휴장일 캘린더를 채운다.
                'fetchMarketCalendar': True,
                'fetchInvestorTrading': True,
                'createMarketBuyOrderWithCost': False,
                'createConditionalOrder': False,
            },
            'urls': {
                'api': {'private': KBSEC_API_BASE},
                'www': 'https://openapi.kbsec.com',
                'doc': ['https://openapi.kbsec.com', 'https://github.com/kbsecurities/kb-openapi'],
            },
            'requiredCredentials': {'apiKey': True, 'secret': True, 'uid': False},
            'timeframes': dict(KBSEC_TIMEFRAMES),
            'fees': {
                'trading': {'tierBased': False, 'percentage': True},
            },
            # 국내 호가단위는 가격대별이라 종목 정밀도로 적지 않는다.
            'precisionMode': TICK_SIZE,
            'exceptions': {'exact': kbsec_exact_exceptions()},
            'options': {
                # 토큰을 여러 프로세스가 나눠 쓰는 저장소(BrokerTokenStore). 없으면 프로세스 메모리 캐시만 쓴다.
                'tokenStore': None,
                # 국내 종목 유형을 알려 주는 KIS 마스터 데이터(`kis_master_data` 참고). 없으면 빈 데이터다.
                'masterData': None,
            },
        })

    # ============ 요청 ============

    def _base_url(self) -> str:
        api = self.urls.get('api')
        if isinstance(api, str):
            return api
        private = _get(api, 'private')
        return KBSEC_API_BASE if private is None else private

    def _host_addr(self) -> Dict[str, str]:
        """TR 본문 `dataHeader` 에 싣는 호스트 주소. `options['hostAddr']` 로 준 값을 쓰고, 빠진 값만 이 호스트에서 모은다."""
        given = self.safe_dict(self.options, 'hostAddr', {})
        auto = kbsec_host_addr()
        return {'ipAddr': self.safe_string(given, 'ipAddr') or auto['ipAddr'], 'macAddr': self.safe_string(given, 'macAddr') or auto['macAddr']}

    def _get_auth(self) -> KbsecAuth:
        """앱키·시크릿에 묶인 인증 객체. 토큰 캐시와 발급 락이 여기 있다."""
        identity = f'{self.apiKey}\u0000{self.secret}'
        if self._auth is None or identity != self._auth_identity:
            base_url = self._base_url()
            # 발급 요청 안에서 주소가 막히면 그 `BadRequest` 가 다른 본문 형태로 넘어가는 실패가 되어 `AuthenticationError` 로 바뀐다. 먼저 확인한다.
            assert_secure_url(self.id, base_url, self.options.get('allowInsecureUrl') is True)
            self._auth = KbsecAuth(self.apiKey or '', self.secret or '', base_url, self._post_json, self.get_token_store)
            self._auth_identity = identity
        return self._auth

    def _post_json(self, url: str, body: Any) -> Tuple[int, str]:
        """토큰 발급·폐기 요청. `fetch` 를 거치지 않아 `handle_errors` 가 끼지 않고, verbose 로그에 시크릿이 든 본문이 찍히지 않는다.
        리다이렉트를 따르지 않고, 연결 실패는 `NetworkError`, 시간 초과는 `RequestTimeout` 이다. 상태 코드와 본문을 그대로 돌려준다."""
        response = self.http_request('POST', url, {'Content-Type': 'application/json'}, self.json(body), AUTH_TIMEOUT_MS)
        return response.status_code, response.content.decode('utf-8', errors='replace')

    def authenticate(self, path: str, api: ApiName, method: str, params: Dict[str, Any], headers: Optional[Dict[str, str]],
                     body: Str) -> None:
        """비공개 호출 앞에서 토큰을 준비해 요청 헤더에 싣는다. 소문자 `bearer` 다(공식 예제 기준이며 대문자는 거부된 사례가 있다)."""
        try:
            token = self._get_auth().get_access_token()
        except BaseError:
            raise
        except Exception as e:
            raise AuthenticationError(f'{self.id} 토큰을 받지 못했다: {e}') from e
        if headers is not None:
            headers['Authorization'] = f'bearer {token}'

    def sign(self, path: str, api: ApiName = 'private', method: str = 'POST', params: Optional[Dict[str, Any]] = None,
             headers: Optional[Dict[str, str]] = None, body: Str = None) -> Dict[str, Any]:
        """TR 요청을 만든다. 본문은 스펙의 입력 필드를 모두 채운 `{dataHeader, dataBody}` 봉투다(일부만 보내면 KB 가 거부한다)."""
        params = {} if params is None else params
        return {
            'url': f'{self._base_url()}{KBSEC_TR_PATH_PREFIX}{path.lower()}',
            'method': 'POST',
            'headers': self.extend({'Content-Type': 'application/json', 'appKey': self.apiKey or ''}, headers),
            # 빈 주소면 KB 가 TR 을 거부한다(`kbsec_host_addr` 참고).
            'body': self.json({'dataHeader': self._host_addr(), 'dataBody': fill_tr_inputs(path, params)}),
        }

    def fetch2(self, path: str, api: ApiName = 'private', method: str = 'POST', params: Optional[Dict[str, Any]] = None,
               headers: Optional[Dict[str, str]] = None, body: Str = None, config: Optional[Dict[str, Any]] = None) -> Any:
        """토큰이 무효인 응답(401, `I445`)을 받으면 토큰을 회전하고 한 번만 다시 보낸다. 그 뒤에도 토큰 실패면 차단기에 센다.
        I445 는 증권사가 처리하기 전에 거절한 것이라 주문 TR 도 다시 보낸다."""
        return self._fetch_with_token_recovery(path, api, method, params, headers, body, config, True)

    def _fetch_with_token_recovery(self, path: str, api: ApiName, method: str, params: Optional[Dict[str, Any]],
                                   headers: Optional[Dict[str, str]], body: Str, config: Optional[Dict[str, Any]],
                                   allow_retry: bool) -> Any:
        tr_code = path.upper()
        # 차단기가 열려 있으면 KB 를 부르지 않는다. 근거는 `kbsec_token_breaker`.
        throw_if_token_breaker_open(self.apiKey, tr_code)
        # 요청마다 새 헤더 사전을 쓴다. `authenticate` 가 여기에 토큰을 싣고, 실패했을 때 어느 토큰이었는지 여기서 읽는다.
        request_headers: Dict[str, str] = dict(headers or {})
        try:
            response = super().fetch2(path, api, method, params, request_headers, body, config)
        except Exception as error:
            token_failed = isinstance(error, AuthenticationError) and error.detail == KBSEC_ERROR_DETAIL['TOKEN_INVALID']
            if not token_failed:
                # 응답을 읽고 던진 오류(업무 거절)는 토큰이 통했다는 뜻이므로 차단기를 푼다. 전송 실패는 아무것도 알려 주지 않는다.
                if isinstance(error, ExchangeError):
                    record_kbsec_call_ok(self.apiKey)
                raise
            if not allow_retry:
                # 폐기와 회전까지 하고도 토큰 실패면 이쪽에서 쓸 수단이 다 떨어진 상태다.
                record_token_failure(self.apiKey, tr_code, KBSEC_ERROR_DETAIL['TOKEN_INVALID'])
                raise
            logger.warning('[kbsec] 토큰 실패 — 재발급 후 1회 재시도: trCode=%s', tr_code)
        else:
            record_kbsec_call_ok(self.apiKey)
            return response
        # 회전은 `except` 밖에서 한다. 안에서 하면 회전이나 재시도의 오류에 첫 토큰 실패가 원인 사슬로 붙는다.
        # 무효화가 끝나기 전에 다시 보내면 방금 무효로 판정한 토큰을 캐시에서 다시 읽으므로 회전을 끝까지 기다린다.
        failed_token = re.sub(r'^bearer ', '', request_headers.get('Authorization') or '', flags=re.IGNORECASE)
        self._get_auth().rotate_after_token_failure(failed_token)
        return self._fetch_with_token_recovery(path, api, method, params, headers, body, config, False)

    def handle_errors(self, code: int, reason: str, url: str, method: str, headers: Dict[str, str], body: str, response: Any,
                      request_headers: Optional[Dict[str, str]], request_body: Str) -> Optional[bool]:
        """응답 봉투를 오류로 옮긴다. 상태 코드와 무관하게 봉투가 정본이다. 봉투가 없는 비-2xx 는 `httpExceptions` 표가 받는다."""
        header = self.safe_dict(response, 'dataHeader')
        tr_code = url.split('/')[-1].upper()
        if is_kbsec_business_error(header):
            process_code = (self.safe_string(header, 'processCode') or '').strip()
            process_message = (self.safe_string(header, 'processMessage') or '').strip()
            feedback = f'KB증권 업무 오류 ({tr_code}): {process_message} [processCode={process_code}]'
            broker_code = process_code or None
            self.throw_exactly_matched_exception(self.exceptions.get('exact'), process_code, feedback, detail=kbsec_error_detail(process_code),
                                                 broker_code=broker_code)
            raise ExchangeError(feedback, broker_code=broker_code)
        if is_kbsec_token_failure(code, header):
            broker_code = (self.safe_string(header, 'processCode') or '').strip() or None
            raise AuthenticationError(f'{self.id} {method} {url} {code} 토큰이 무효다', detail=KBSEC_ERROR_DETAIL['TOKEN_INVALID'],
                                      broker_code=broker_code)
        if 200 <= code < 300 and response is None:
            raise BadResponse(f'KB증권 응답이 JSON 이 아님 ({tr_code}): {body[:200]}')
        return None

    def _call_tr(self, tr_code: str, data_body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """TR 을 부르고 봉투에서 `dataBody` 를 꺼낸다. 오류는 `handle_errors` 가 던진다."""
        method = getattr(self, 'private_post_' + tr_code.lower(), None)
        if method is None:
            raise NotSupported(f'{self.id} 에 없는 TR 이다: {tr_code}')
        response = method({} if data_body is None else data_body)
        return self.safe_dict(response, 'dataBody', {}) or {}

    # ============ 종목 ============

    def market(self, symbol: Str) -> MarketInterface:
        """종목. 종목 목록 TR 을 쓰지 않고 심볼 모양으로 만든다. `005930/KRW`·`005930` 은 국내, 그 밖은 미국이다.
        `markets` 에 넣어 둔 종목이 있으면 그것을 먼저 찾는다."""
        if symbol is None:
            raise ArgumentsRequired(f'{self.id} market() requires a symbol argument')
        known = (self.markets or {}).get(symbol)
        if known is not None:
            return known
        id = self.stock_ticker(kbsec_base_symbol(symbol)).upper()
        if id == '':
            raise BadSymbol(f'{self.id} does not have market symbol {symbol}')
        country = kbsec_market_of(id)
        quote = 'KRW' if country == 'KR' else 'USD'
        base = self.common_stock_code(id)
        return self.safe_market_structure({
            'id': id,
            'symbol': f'{base}/{quote}',
            'base': base,
            'quote': quote,
            'baseId': id,
            'quoteId': quote,
            'type': 'spot',
            'spot': True,
            'margin': False,
            'swap': False,
            'future': False,
            'option': False,
            'active': True,
            'contract': False,
            # 주식은 주 단위다. 국내 호가단위는 가격대별이라 가격 정밀도는 적지 않는다.
            'precision': {'amount': 1, 'price': None},
            'info': {'country': country},
            'options': {'country': country},
        })

    def _is_us(self, market: MarketInterface) -> bool:
        return _get(market.get('options'), 'country') == 'US'

    def _domestic_security_type(self, market: MarketInterface) -> Str:
        """국내 종목의 증권 유형(`STOCK`, `ETF` 등). `options['masterData']` 에 없으면 `None` 이다."""
        stock = get_krx_stock_by_code(master_data_of(self.options), market['id'] or '')
        return None if stock is None else stock.get('securityType')

    def _is_kosdaq(self, market: MarketInterface) -> bool:
        """`options['masterData']` 가 코스닥 종목이라고 알려 주는가. 통합차트의 시장구분(`mkt_clsf`)을 고를 때 쓴다."""
        stock = get_krx_stock_by_code(master_data_of(self.options), market['id'] or '')
        return stock is not None and stock.get('market') == 'KOSDAQ'

    def price_to_precision(self, symbol: Str, price: Any) -> Str:
        """가격을 호가 단위에 맞춘 문자열. 국내는 가격대별 호가 단위 표(`krx_tick_size`)로 반올림하고, `options['masterData']` 가 주식이 아니라고
        알려 주면 표가 달라 그대로 돌려준다. 미국은 부모 클래스를 따른다. 주문 경로는 이 메서드로 가격을 바꾸지 않는다."""
        if price is None:
            return None
        market = self.market(symbol)
        if self._is_us(market):
            return super().price_to_precision(symbol, price)
        security_type = self._domestic_security_type(market)
        if security_type is not None and security_type != 'STOCK':
            return self.number_to_string(price)
        return decimal_to_precision(price, ROUND, get_krx_tick_size(fn.js_number(price)), TICK_SIZE, NO_PADDING)

    def fetch_investor_trading(self, symbol: str, since: Int = None, limit: Int = None,
                               params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """종목별 투자자 매매동향(`IVU10430`)을 하루 단위로 준다. 세 증권사 공통 모양이다. 국내만 지원한다.
        개인, 외국인, 기관의 값을 싣고, 등락률과 거래량, 나머지 10개 투자자 유형은 `info` 의 원문에 있다.
        기본은 오늘(KST) 하루, 순매수(`trd_clsf='1'`), 금액 기준(`amt_q_clsf='1'`)이다. `since` 와 `params['until']` 로 기간을 넓힌다.
        `params` 로 `trd_clsf`(1 순매수, 2 매수, 3 매도)나 `amt_q_clsf`(1 금액, 2 수량)를 덮어쓰면 세 투자자 필드도 그 값이 된다."""
        until, query = self.handle_until_param('fetchInvestorTrading', limit, {} if params is None else params)
        market = self.market(symbol)
        if self._is_us(market):
            raise NotSupported(f'{self.id} fetchInvestorTrading() 는 국내 종목만 지원한다: {symbol}')
        today = kst_ymd(self.milliseconds())
        body = self._call_tr(KBSEC_TR['INVESTOR_TRADING'], self.extend({
            'excg_clsf': '1',
            'is_cd': market['id'],
            'strt_dt': today if since is None else kst_ymd(since),
            'end_dt': today if until is None else kst_ymd(until),
            'amt_q_clsf': '1',
            'trd_clsf': '1',
            'acml_clsf': '0',
        }, query))
        return self.limit_rows([self.extend(self.kst_stamp(pick_str(row, 'dt')), {
            'date': pick_str(row, 'dt'),
            'close': pick_num(row, 'cls_prc'),
            'change': pick_num(row, 'bdy_cmpr'),
            'individual': pick_num(row, 'indv'),
            'foreign': pick_num(row, 'fgnr'),
            'institution': pick_num(row, 'ogn'),
            'info': row,
        }) for row in pick_array(body)], since, limit)

    # ============ 시세 ============

    def _call_us_quote(self, base: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """해외 현재가 응답. 거래소코드를 후보 순서대로 시도해 현재가가 나온 응답을 돌려준다. 못 찾으면 `None`."""
        cached = self._us_exchange_cache.get(base)
        candidates = KBSEC_US_EXCHANGES if cached is None else (cached,)
        for krx_code in candidates:
            row = self._call_tr(KBSEC_TR['QUOTE_US'], self.extend({'krx_cd': krx_code, 'is_cd': base}, params))
            if pick_num(row, 'now_prc_p4') > 0:
                self._us_exchange_cache[base] = krx_code
                return row
        return None

    def fetch_ticker(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Ticker:
        params = {} if params is None else params
        market = self.market(symbol)
        market_id = market['id'] or ''
        if self._is_us(market):
            row = self._call_us_quote(market_id, params)
            if row is None:
                raise NullResponse(f'{self.id} fetchTicker() {symbol} 해외 현재가 없음 — 거래소코드 전 계열 미매칭')
        else:
            # 국내 현재가 입력은 `excg_clsf`(0 통합, 1 KRX, 2 NXT)와 `shrt_cd`(단축코드)다. `is_cd` 를 보내면 "해당자료가 없습니다"가 온다.
            row = self._call_tr(KBSEC_TR['QUOTE_KR'], self.extend({'excg_clsf': '1', 'shrt_cd': market_id}, params))
        ticker = self.parse_ticker(row, market)
        if ticker['last'] is None:
            raise NullResponse(f'{self.id} fetchTicker() {symbol} 현재가를 읽지 못했다 — 응답 필드 대조 필요')
        return ticker

    def parse_ticker(self, ticker: Dict[str, Any], market: Market = None) -> Ticker:
        """해외는 필드가 국내와 다르다(`_p4` 계열). 국내는 장 밖에서 `now_prc` 가 0 으로 오므로 양수인 첫 후보를 골라 종가로 넘어간다."""
        symbol = None if market is None else market['symbol']
        if market is not None and self._is_us(market):
            result = self.safe_ticker({
                'symbol': symbol,
                'timestamp': None,
                'datetime': None,
                'last': pick_positive_num(ticker, 'now_prc_p4'),
                'bid': pick_num(ticker, 'b_askprc_p4'),
                'ask': pick_num(ticker, 's_askprc_p4'),
                'high': pick_num(ticker, 'hgh_prc_p4'),
                'low': pick_num(ticker, 'lw_prc_p4'),
                'open': pick_num(ticker, 'opn_prc_p4'),
                'percentage': pick_num(ticker, 'up_dwn_r_p2'),
                'baseVolume': pick_num(ticker, 'vlm', 'bdy_vlm'),
                'info': ticker,
            }, market)
        else:
            result = self.safe_ticker({
                'symbol': symbol,
                'timestamp': None,
                'datetime': None,
                'last': pick_positive_num(ticker, 'now_prc', 'bdy_cls_prc', 'krx_bdy_clpr', 'expct_ccls_prc'),
                'bid': pick_num(ticker, 'b_sq1_askprc'),
                'ask': pick_num(ticker, 's_sq1_askprc'),
                'high': pick_num(ticker, 'hgh_prc'),
                'low': pick_num(ticker, 'lw_prc'),
                'open': pick_num(ticker, 'opn_prc'),
                'percentage': pick_num(ticker, 'up_dwn_r_p2'),
                'baseVolume': pick_num(ticker, 'acml_vlm', 'bdy_vlm'),
                'info': ticker,
            }, market)
        # 등락률은 `up_dwn_r_p2` 다. 보합이면 0 이 정상 값인데 `safe_ticker` 는 0 을 비우고 시가와 종가로 다시 계산하므로 KB 가 준 값으로 되돌린다.
        if 'up_dwn_r_p2' in ticker:
            result['percentage'] = pick_num(ticker, 'up_dwn_r_p2')
        return result

    def fetch_order_book(self, symbol: str, limit: Int = None, params: Optional[Dict[str, Any]] = None) -> OrderBook:
        """호가. 매수는 가격 내림차순, 매도는 오름차순이다. 호가가 하나도 없으면 `NullResponse` 다."""
        params = {} if params is None else params
        market = self.market(symbol)
        market_id = market['id'] or ''
        is_us = self._is_us(market)
        if is_us:
            krx_code = self._us_exchange_cache.get(market_id, KBSEC_US_EXCHANGES[0])
            row = self._call_tr(KBSEC_TR['ORDERBOOK_US'], self.extend({'krx_cd': krx_code, 'is_cd': market_id}, params))
        else:
            row = self._call_tr(KBSEC_TR['ORDERBOOK_KR'], self.extend({'is_cd': market_id, 'ovtm_mkt_clsf': '1'}, params))
        # 국내는 가격 `b{N}_aprc`·`s{N}_aprc`, 잔량 `b_pstn_b{N}_aprc_q`·`s_pstn_s{N}_aprc_q` 다.
        # 해외는 가격 `b_askprc{N}_p4`·`s_askprc{N}_p4`, 잔량 `b_askprc_q{N}`·`s_askprc_q{N}` 이다.
        bids: List[List[float]] = []
        asks: List[List[float]] = []
        for i in range(1, 11):
            bid_price = pick_num(row, f'b_askprc{i}_p4') if is_us else pick_num(row, f'b{i}_aprc')
            bid_size = pick_num(row, f'b_askprc_q{i}') if is_us else pick_num(row, f'b_pstn_b{i}_aprc_q')
            if bid_price > 0:
                bids.append([bid_price, bid_size])
            ask_price = pick_num(row, f's_askprc{i}_p4') if is_us else pick_num(row, f's{i}_aprc')
            ask_size = pick_num(row, f's_askprc_q{i}') if is_us else pick_num(row, f's_pstn_s{i}_aprc_q')
            if ask_price > 0:
                asks.append([ask_price, ask_size])
        if not bids and not asks:
            raise NullResponse(f'{self.id} fetchOrderBook() {symbol} 호가가 하나도 없다')
        book = self.parse_order_book({'bids': bids, 'asks': asks}, market['symbol'], None)
        if limit is not None:
            book['bids'] = book['bids'][:limit]
            book['asks'] = book['asks'][:limit]
        return book

    def fetch_ohlcv(self, symbol: str, timeframe: str = '1m', since: Int = None, limit: Int = None,
                    params: Optional[Dict[str, Any]] = None) -> List[List[Num]]:
        """봉. 국내만 지원한다. 명세(`IVS11560`)의 필드 이름으로 읽으며, 실계좌로 검증한 적은 없다. 해외 차트(`GSC10060`)는 15분 지연 시세라
        지연 봉을 공통 메서드에 섞지 않으려고 `NotSupported` 를 던진다.
        시장구분(`mkt_clsf`)은 `options['masterData']` 로 코스닥 종목임을 알면 `'1'`, 그 밖에는 코스피(`'0'`)로 보낸다. `params['mkt_clsf']` 가 있으면 그 값을 쓴다.

        `since` 가 있으면 `since` 부터 `limit`(기본 100) 개이고, 없으면 가장 최근 `limit` 개다. `params['until']`(ms)은 그 시각까지의 봉만 남긴다.
        명세의 시작일(`strt_dy`)은 뜻을 확인하지 못해 비워 보낸다. 대신 지금부터 `since`(또는 `until`)까지 덮을 만큼 최근 봉을 받아 거른다.
        조회건수 상한(9999)으로도 `since` 까지 닿지 못하면 경고 로그를 남기고 받은 가장 오래된 봉부터 돌려준다."""
        timeframe = '1m' if timeframe is None else timeframe
        params = {} if params is None else params
        market = self.market(symbol)
        if self._is_us(market):
            raise NotSupported(f'{self.id} fetchOHLCV() 는 국내 종목만 지원한다: 해외 차트는 15분 지연 시세다')
        chrt_clsf, minute = kbsec_chart_params(timeframe)
        wanted = 100 if limit is None else limit
        until = self.safe_integer(params, 'until')
        query = self.omit(params, 'until')

        # 조회는 가장 최근 봉부터 개수로만 하므로, 지금부터 그 시각까지 들어가는 봉 수를 달력 시간으로 넉넉히 센다.
        def bars_since(start: int) -> int:
            return math.ceil((self.milliseconds() - start) / kbsec_bar_ms(timeframe)) + 1

        count = wanted
        if since is not None:
            count = max(wanted, bars_since(since))
        elif until is not None:
            count = wanted + max(0, bars_since(until))
        count = min(count, KBSEC_CHART_MAX)
        body = self._call_tr(KBSEC_TR['CHART_KR'], self.extend({
            'info_ccd': '1',  # 원주가
            'mkt_clsf': '1' if self._is_kosdaq(market) else '0',  # 명세: 0 KOSPI, 1 KOSDAQ
            'chrt_clsf': chrt_clsf,
            'minute_tck_indx': minute,
            'is_cd': market['id'],
            'inq_clsf': '2',  # 데이터 수로 조회
            'inq_cnt': kbsec_num(count),
        }, query))
        received = pick_array(body)
        rows = [row for row in received if kbsec_candle_timestamp(pick_str(row, 'dt'), pick_str(row, 'tm')) is not None]
        # 일·주·월봉은 KB 가 현지 자정(00:00 KST)으로 주므로 기간 첫날의 00:00 UTC 로 옮긴다(`candle_period_utc_ms`).
        daily = is_daily_or_longer_timeframe(timeframe)
        candles = [[candle_period_utc_ms(cast(int, candle[0]), timeframe, 'KR'), *candle[1:]] if daily else candle
                   for candle in self.parse_ohlcvs(rows, market, timeframe)]
        candles = [candle for candle in candles if until is None or cast(int, candle[0]) <= until]
        oldest = candles[0][0] if candles else None
        if since is not None and len(received) >= count and oldest is not None and oldest > since:
            logger.warning('[kbsec] 봉 조회건수 상한에 닿아 since 까지 받지 못했다. 받은 가장 오래된 봉부터 돌려준다 '
                           '(symbol=%s, timeframe=%s, since=%s, oldest=%s, count=%s)', market['symbol'], timeframe, since, oldest, count)
        return self.filter_by_since_limit(candles, since, wanted, 0)

    def parse_ohlcv(self, ohlcv: Any, market: Market = None) -> List[Num]:
        return [
            kbsec_candle_timestamp(pick_str(ohlcv, 'dt'), pick_str(ohlcv, 'tm')),
            pick_num(ohlcv, 'opn_prc_p2'),
            pick_num(ohlcv, 'hgh_prc_p2'),
            pick_num(ohlcv, 'lw_prc_p2'),
            pick_num(ohlcv, 'cls_prc_p2'),
            pick_num(ohlcv, 'vlm'),
        ]

    def fetch_trades(self, symbol: str, since: Int = None, limit: Int = None,
                     params: Optional[Dict[str, Any]] = None) -> List[Trade]:
        """시간대별 체결 내역. 국내(`IVU10080`)와 해외(`GSA10020`)를 종목 국가로 가른다.

        국내는 체결가, 체결수량, 체결시각만 채운다. 방향(매도매수구분, `sell_buy_ccd`)과 체결 ID 는 코드값 의미를 확정할 근거가 없어(명세에 설명 없음)
        채우지 않고, `info` 에 원본이 남아 있다. 체결 행에는 시각(`ccls_tm`, HHMMSS)만 있어서, 일봉(`fetch_ohlcv`)을 한 번 더 받아 거래량이 있는
        가장 최근 영업일을 가장 새 체결의 날짜로 쓴다. 날짜가 바뀐 행부터 비우는 규칙은 한국투자증권과 같다(`kst_trade_timestamps`).
        행이 새 것부터 온다는 순서는 명세에 없고 실계좌로 확인하지 못했다. `since` 를 주면 `timestamp` 가 빈 행은 빠진다.

        해외는 체결구분(`ccls_clsf`, `1` 매수자체결, `2` 매도자체결)이 명세에 있어 `side` 를 채운다. 시각은 한국 시각 변환 필드(`kor_dt`·`kor_tm`)를
        쓴다(국내와 달리 여러 날짜를 한 번에 준다). 거래소코드(`krx_cd`)는 `fetch_ticker` 가 쓰는 캐시를 그대로 쓰고, 없으면 먼저 현재가 조회로 채운다."""
        params = {} if params is None else params
        market = self.market(symbol)
        if self._is_us(market):
            return self._fetch_overseas_trades_timeline(market, since, limit, params)
        body = self._call_tr(KBSEC_TR['TRADES_TIMELINE_KR'], self.extend({
            'excg_clsf': '1', 'is_cd': market['id'], 'ovtm_mkt_clsf': '0', 'inq_cnt': kbsec_num(30 if limit is None else limit),
        }, params))
        rows = pick_array(body)
        if len(rows) == 0:
            return []
        stamps = kst_trade_timestamps([pick_str(row, 'ccls_tm') for row in rows], self._last_traded_date(market), self.milliseconds())
        trades = [self.safe_trade({
            'info': row,
            'id': None,
            'order': None,
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'symbol': market['symbol'],
            'type': None,
            'side': None,
            'takerOrMaker': None,
            'price': pick_num(row, 'ccls_prc'),
            'amount': pick_num(row, 'ccls_q'),
            'cost': None,
            'fee': None,
        }, market) for row, timestamp in zip(rows, stamps)]
        return trades if since is None else [trade for trade in trades if (trade['timestamp'] or 0) >= since]

    def _last_traded_date(self, market: MarketInterface) -> Str:
        """거래량이 있는 가장 최근 영업일(`YYYYMMDD`). 일봉을 받지 못했거나 최근 30개에 그런 날이 없으면 `None` 이다.
        통합차트의 시장구분은 코스피(`0`)가 기본이고, `options['masterData']` 가 코스닥 종목이라고 알려 주면 코스닥(`1`)으로 조회한다."""
        symbol = market['symbol']
        try:
            candles = self.fetch_ohlcv(symbol, '1d', None, 30, {'mkt_clsf': '1'} if self._is_kosdaq(market) else {})
        except Exception as err:
            logger.warning('[kbsec] fetch_trades 의 날짜를 정할 일봉을 받지 못해 체결 시각을 비운다 (symbol=%s, err=%s)', symbol, err)
            return None
        days = [cast(int, candle[0]) for candle in candles if (candle[5] or 0) > 0]
        return kst_ymd(max(days)) if days else None

    def _fetch_overseas_trades_timeline(self, market: MarketInterface, since: Int, limit: Int, params: Dict[str, Any]) -> List[Trade]:
        base = market['id'] or ''
        if self._us_exchange_cache.get(base) is None:
            self._call_us_quote(base, {})
        krx_code = self._us_exchange_cache.get(base, KBSEC_US_EXCHANGES[0])
        body = self._call_tr(KBSEC_TR['TRADES_TIMELINE_US'], self.extend({
            'krx_cd': krx_code, 'is_cd': base, 'rcrd_c': kbsec_num(30 if limit is None else limit),
        }, params))
        trades: List[Trade] = []
        for row in pick_array(body):
            timestamp = kbsec_candle_timestamp(pick_str(row, 'kor_dt'), pick_str(row, 'kor_tm'))
            ccls_clsf = pick_str(row, 'ccls_clsf')
            trades.append(self.safe_trade({
                'info': row,
                'id': None,
                'order': None,
                'timestamp': timestamp,
                'datetime': self.iso8601(timestamp),
                'symbol': market['symbol'],
                'type': None,
                'side': 'buy' if ccls_clsf == '1' else 'sell' if ccls_clsf == '2' else None,
                'takerOrMaker': None,
                'price': pick_num(row, 'now_prc_p4'),
                'amount': pick_num(row, 'ccls_q'),
                'cost': None,
                'fee': None,
            }, market))
        return trades if since is None else [trade for trade in trades if (trade['timestamp'] or 0) >= since]

    # ============ 수수료 ============

    def fetch_trading_fee(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> TradingFeeInterface:
        """위탁수수료율의 추정이다. KB 에 수수료 조회 TR 이 없어 공시 요율의 근사를 돌려준다(`info['estimated']` 가 `True`).
        국내 매도(`params['side']` 가 `'sell'`)는 시행일별 증권거래세를 더한 실효율이다."""
        market = self.market(symbol)
        side = 'sell' if (params or {}).get('side') == 'sell' else 'buy'
        rate = kbsec_estimated_fee_rate('US' if self._is_us(market) else 'KR', side)
        return {'info': {'estimated': True, 'side': side}, 'symbol': market['symbol'], 'maker': rate, 'taker': rate, 'percentage': True,
                'tierBased': False}

    # ============ 휴장일 ============

    def fetch_market_calendar(self, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """국내 휴장일을 날짜별 개장 여부로 돌려준다. 장운영상태(`SZQM0771`)가 주는 전영업일, 기준영업일, 익영업일을 열린 날로 보고, 그 사이의
        평일을 닫힌 날로 넓힌다. KB 는 이 세 날짜 밖은 알려 주지 않으므로 넓히는 범위가 앞뒤 며칠이다.
        세 증권사 공통 모양이다. `params['market']` 은 `'KR'`(기본)만 받고, `'US'` 는 요청 없이 `NotSupported` 다."""
        if self._calendar_market(params) == 'US':
            raise NotSupported(f'{self.id} fetchMarketCalendar() 는 국내 휴장일만 준다')
        body = self._call_tr(KBSEC_TR['MARKET_STATUS'], self.omit(params or {}, 'market'))
        open_dates = [date for date in (pick_str(body, 'bfr_bsns_dt'), pick_str(body, 'std_bsnss_dt'), pick_str(body, 'next_biz_dt')) if date != '']
        return expand_business_days(open_dates)

    def refresh_market_calendar(self) -> bool:
        """`fetch_market_calendar` 의 결과를 공용 휴장일 캘린더(`market_calendar`)에 넣는다. 장 시간 판정이 이 캘린더를 읽는다. 장 시간 판정을
        주문 밖에서 쓰면 시작할 때 한 번 직접 부른다. 6시간 안에 성공한 호출은 다시 하지 않는다.
        신선한 캘린더가 있으면 `True` 다. 자격증명이 없으면 부르지 않고 `False` 다. 호출에 실패해도 던지지 않는다."""
        if self.apiKey is None or self.secret is None:
            return False
        return refresh_shared_market_calendar('KR', self.fetch_market_calendar, CALENDAR_TTL_MS)

    # 생성자가 붙이는 camelCase 별칭을 타입 검사기에 알린다. 빠지거나 남는 줄은 test_base.py 가 잡는다.
    if TYPE_CHECKING:
        handleErrors = handle_errors
        priceToPrecision = price_to_precision
        fetchInvestorTrading = fetch_investor_trading
        fetchTicker = fetch_ticker
        parseTicker = parse_ticker
        fetchOrderBook = fetch_order_book
        fetchOHLCV = fetch_ohlcv
        parseOHLCV = parse_ohlcv
        fetchTrades = fetch_trades
        fetchTradingFee = fetch_trading_fee
        fetchMarketCalendar = fetch_market_calendar
        refreshMarketCalendar = refresh_market_calendar
