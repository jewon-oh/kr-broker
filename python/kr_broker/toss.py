# 이 파일은 scripts/gen-python-sync.mjs 가 python/kr_broker/async_support/toss.py 에서 만든다. 직접 고치지 않는다.
"""토스증권 Open API(`class toss(Exchange, ImplicitAPI)`). TypeScript 판 `ts/src/toss.ts` 를 옮겼다. 국내와 미국 주식 현물의 시세·잔고·주문·조회를
ccxt 와 같은 모양으로 다룬다. 실시간(`watch_*`)은 이 클래스를 상속한 `kr_broker.pro.toss` 에 있다.

.. code-block:: python

    import kr_broker
    broker = kr_broker.toss({'apiKey': CLIENT_ID, 'secret': CLIENT_SECRET, 'uid': ACCOUNT_SEQ})
    ticker = broker.fetch_ticker('005930/KRW')
    order = broker.create_order('005930/KRW', 'limit', 'buy', 1, 70000)

자격증명
    `apiKey` 는 클라이언트 ID, `secret` 은 클라이언트 시크릿, `uid` 는 계좌 순번(`accountSeq`)이다. `uid` 를 비워 두면 처음 계좌 API 를 부를 때
    `GET /accounts` 의 첫 계좌로 채운다. 토스에는 모의투자 환경이 없다.

심볼
    국내는 `005930/KRW`, 미국은 `AAPL/USD` 다. `load_markets()` 없이도 코드의 모양으로 시장을 판별한다. `load_markets()` 를 부르면
    토스가 거래할 수 있는 종목 전체(`GET /stocks/all`)가 `markets` 에 들어가고, 종목 유형(`ETF` 등)이 `market['options']` 에 실린다.

주문
    `create_order(symbol, type, side, amount, price, params)` 의 `params` 는 `clientOrderId`(멱등키), `cost`(미국 시장가 매수 금액),
    `timeInForce`(`DAY`·`CLS`·`OPG`), `triggerPrice`(있으면 조건주문), `conditionalType`(`SINGLE`·`OCO`·`OTO`), `second`(둘째 조건),
    `expireDate`(조건주문 만료일), `confirmExecution`(`False` 면 체결 조회를 하지 않는다)를 읽는다. 접수 뒤에는 주문 상세를 짧게 조회해
    체결 수량·평균가·수수료를 확정하고, 확정하지 못하면 `filled` 를 비워 둔다. 확정한 값은 `order['info']['execution']` 에도 있다.
    일반 주문은 이 키를 뺀 나머지를 요청 본문 끝에 합친다(ccxt 와 같다). 라이브러리가 인자로 채우는 필드(`symbol`·`side`·`orderType`·
    `quantity`·`orderAmount`·`price`·`confirmHighValueOrder`)를 `params` 로 주면 요청 없이 `BadRequest` 다. ccxt 조건 인자(`stopPrice` 등)는
    요청 없이 `NotSupported` 다. `edit_order` 의 일반 정정도 같은 규칙이다.

옵션
    `tokenStore`(토큰 저장소), `nxtRouting`(국내 확장세션 주문), `usExtendedLimit`(미국 확장세션 시장가를 지정가로),
    `blockAuctionBuys`(정규장 종가 동시호가의 신규 매수를 막는다), `krwIntegratedMargin`(켜면 `fetch_balance({'currency': 'USD'})` 의 USD 에 원화 매수 여력의 달러 환산액을 늘 더한다. 환율은 토스 조회,
    실패하면 `usdKrwRate`), `confirmBudget`(체결 확정 조회 예산), `confirmExecution`(접수 뒤 체결 확정 조회. 일반 주문 취소 뒤의 확정 조회도 따른다).
    `nxtRouting`·`usExtendedLimit`·`blockAuctionBuys`·`krwIntegratedMargin` 은 불리언이거나 불리언을 돌려주는 함수이고 기본은 꺼짐이다. `confirmExecution` 은 기본이
    켜짐이고 `False` 일 때만 꺼지므로 함수를 넘기면 늘 켜진다.

오류
    토스의 오류 코드는 ccxt 오류 계층으로 옮기고 원래 코드는 `error.detail` 에 둔다. 장 시간 밖은 `MarketClosed`, 주문 요청이 시간 초과로 끝나
    접수 여부를 모르면 `OrderOutcomeUnknown`(다시 보내지 않는다), 이미 체결·취소된 주문의 취소는 `OrderNotFound` 다.
"""

import json
import logging
import math
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from kr_broker.abstract.toss import ImplicitAPI
from kr_broker.base.exchange import Exchange
from kr_broker.base.runtime import maybe_await, new_lock
from kr_broker.base.token_store import LegacyKeyTokenStore, refresh_token_with_lock
from kr_broker.execution_confirm import confirm_execution
from kr_broker.extended_session_limit import build_extended_session_limit
from kr_broker.base import functions as fn
from kr_broker.base.decimal_to_precision import DECIMAL_PLACES, NO_PADDING, ROUND, TICK_SIZE, TRUNCATE, decimal_to_precision
from kr_broker.base.errors import (
    AccountNotEnabled, ArgumentsRequired, AuthenticationError, BadRequest, BadResponse, BadSymbol, DuplicateOrderId, ExchangeError,
    ExchangeNotAvailable, InsufficientFunds, InvalidOrder, ManualInteractionNeeded, MarketClosed, NotSupported, NullResponse,
    OnMaintenance, OperationRejected, OrderNotFound, OrderNotSent, OrderOutcomeUnknown, PermissionDenied, RateLimitExceeded,
    TossRateLimited, TossTokenRejected,
)
from kr_broker.base.precise import Precise
from kr_broker.base.token_store import BrokerTokenStore, legacy_token_store_key, token_store_key
from kr_broker.base.types import ApiName, Int, Num, Str, Strings
from kr_broker.broker_market_group import symbol_base_code
from kr_broker.broker_time import KST_OFFSET_MS, candle_period_utc_ms, is_daily_or_longer_timeframe
from kr_broker.edit_order_amount import assert_whole_remaining_edit, edit_order_total
from kr_broker.krx_tick_size import KRX_TICK_INVALID_DETAIL, get_krx_tick_size, krx_tick_violation
from kr_broker.krx_trading_hours import krx_auction_buy_block_reason
from kr_broker.market_calendar import apply_market_calendar
from kr_broker.toss_fee import pick_commission_rate
from kr_broker.toss_trading_hours import (
    find_kr_session, find_us_regular_close_ms, find_us_session, is_toss_orderable, kr_session_order_restriction,
    toss_kr_calendar_days, toss_us_calendar_days, us_session_order_restriction,
)
from kr_broker.toss_types import (
    TOSS_BROKERAGE_FEE, TOSS_HIGH_VALUE_THRESHOLD_KRW, TOSS_HIGH_VALUE_THRESHOLD_USD, TOSS_US_BROKERAGE_FEE,
    get_toss_effective_fee_rate, toss_market_country,
)
from kr_broker.us_market_hours import us_auction_buy_block_reason

logger = logging.getLogger('kr_broker')

GLOBAL_RATE_LIMIT_MS = 100
READ_TIMEOUT_MS = 20_000
ORDER_TIMEOUT_MS = 25_000
AUTH_TIMEOUT_MS = 10_000
# 장 운영 캘린더(30분), 수수료율(24시간), 참고 환율(5분) 캐시의 유효 시간.
CALENDAR_TTL_MS = 30 * 60 * 1000
COMMISSIONS_TTL_MS = 24 * 60 * 60 * 1000
FX_RATE_TTL_MS = 5 * 60 * 1000
# 체결 완료 주문과 미체결 조건주문의 페이지 크기(토스가 받는 최대값)와 페이지 수 상한.
CLOSED_ORDER_PAGE_LIMIT = 100
MAX_CLOSED_ORDER_PAGES = 10
CONDITIONAL_ORDER_PAGE_LIMIT = 100
MAX_CONDITIONAL_ORDER_PAGES = 10
# 캔들의 페이지당 봉 수와 페이지 수 상한, `limit` 이 없을 때의 봉 수.
CANDLE_PAGE_LIMIT = 200
MAX_CANDLE_PAGES = 10
DEFAULT_CANDLE_LIMIT = 100
# 조건주문 목록에 조건(leg)이 통째로 없을 때 상세 조회로 채우는 건수의 상한.
MAX_CONDITIONAL_DETAIL_FETCH = 20
LISTED_MARKETS = ['KOSPI', 'KOSDAQ', 'KR_ETC', 'NYSE', 'NASDAQ', 'AMEX', 'US_ETC']
KR_LISTED_MARKETS = frozenset(['KOSPI', 'KOSDAQ', 'KR_ETC'])
# 더 이상 체결이 늘지 않는 주문 상태. `REPLACED` 는 체결 정보가 대체 주문으로 옮겨 간다.
TERMINAL_ORDER_STATUSES = frozenset(['FILLED', 'CANCELED', 'REJECTED', 'CANCEL_REJECTED', 'REPLACE_REJECTED', 'REPLACED'])
# 취소를 접수한 원주문이 끝났다고 확정하는 상태. 나머지 종료 상태(`REPLACED` 등)는 원주문의 끝을 알려 주지 않는다.
CANCEL_SETTLED_STATUSES = frozenset(['CANCELED', 'FILLED', 'REJECTED'])
# ccxt 조건 인자. 조건주문은 `triggerPrice` 로만 내므로, 이 키를 버리고 일반 주문을 내지 않게 요청 전에 막는다.
UNSUPPORTED_CONDITIONAL_PARAMS = ('stopPrice', 'stopLossPrice', 'takeProfitPrice', 'stopLoss', 'takeProfit')
# 일반 주문 경로가 `params` 에서 읽는 키. 본문에 합치지 않는다.
ORDER_HANDLED_PARAMS = ['triggerPrice', 'cost', 'clientOrderId', 'timeInForce', 'confirmExecution']
# 라이브러리가 인자로 채우는 주문 본문 필드. `params` 로 덮으면 돌려주는 주문과 실제 요청이 어긋나므로 받지 않는다.
ORDER_COMPUTED_FIELDS = ('symbol', 'side', 'orderType', 'quantity', 'orderAmount', 'price', 'confirmHighValueOrder')
# 일반 정정 경로가 `params` 에서 읽는 키. 본문에 합치지 않는다.
EDIT_HANDLED_PARAMS = ['trigger', 'stop', 'partial']
# 라이브러리가 인자로 채우는 정정 본문 필드(`orderId` 는 경로에 실린다).
EDIT_COMPUTED_FIELDS = ('orderId', 'orderType', 'quantity', 'price', 'confirmHighValueOrder')
# 미국 소수점 수량의 최대 자릿수.
US_FRACTION_DIGITS = 6
US_FRACTION_SCALE = 10 ** US_FRACTION_DIGITS
# 미국 주문 금액이 이 값(달러) 미만이면 환율이 아무리 높아도 고액주문 기준에 못 미친다. 환율 조회를 건너뛰는 선이다.
HIGH_VALUE_USD_LOOKUP_FLOOR = 30_000
# 서버가 쓰는 환율을 알 수 없으므로 고액주문 기준을 조금 낮춰 잡는다.
HIGH_VALUE_MARGIN = 0.95
# 개장 직후(09:00~09:10 KST)에는 주문 정보 그룹의 한도가 줄어 비용을 두 배로 센다.
PEAK_WINDOW_START_MIN = 9 * 60
PEAK_WINDOW_END_MIN = 9 * 60 + 10
PEAK_COST_FACTOR = 2
# 429 를 받은 그룹을 쉬게 하는 시간(Retry-After 가 없을 때)과 상한.
DEFAULT_BACKOFF_MS = 1_000
MAX_BACKOFF_MS = 30_000
DAY_MS = 24 * 60 * 60 * 1000
ORDER_TIME_IN_FORCE = ('DAY', 'CLS', 'OPG')

# ---- 토큰 캐시 ----
TOKEN_KEY_PREFIX = 'toss:token:'
TOSS_TOKEN_SAFETY_MARGIN_MS = 60_000
TOSS_TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
TOKEN_FETCH_LOCK_TTL_MS = 90_000


def _now_ms() -> int:
    return fn.milliseconds()


def kst_date(ms: int) -> str:
    """UTC 밀리초의 한국 날짜(`YYYY-MM-DD`)."""
    return fn.iso8601(ms + KST_OFFSET_MS)[:10]


def is_order_info_peak_window(now_ms: Optional[int] = None) -> bool:
    """지금이 개장 직후 09:00~09:10(한국 시각)인가."""
    now = _now_ms() if now_ms is None else now_ms
    kst_minutes = ((now // 60_000) % (24 * 60) + 9 * 60) % (24 * 60)
    return PEAK_WINDOW_START_MIN <= kst_minutes < PEAK_WINDOW_END_MIN


def _unseen_rows(rows: List[Dict[str, Any]], id_key: str, seen: Set[str]) -> List[Dict[str, Any]]:
    """커서로 받은 쪽에서 아직 담지 않은 행만 고른다. 서버가 커서를 무시하고 같은 쪽을 다시 주면 같은 주문이 두 번 담긴다.
    식별자가 없는 행은 가를 수 없으므로 담는다."""
    out = []
    for row in rows:
        row_id = row.get(id_key) if isinstance(row, dict) else None
        if row_id is None:
            out.append(row)
        elif row_id not in seen:
            seen.add(row_id)
            out.append(row)
    return out


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_integer(value: Any) -> bool:
    return _is_finite_number(value) and float(value).is_integer()


def _positive(value: Any) -> Optional[float]:
    if value is None:
        return None
    n = fn.js_number(value)
    return n if math.isfinite(n) and n > 0 else None


def to_execution_snapshot(order: Any, country: str) -> Optional[Dict[str, Any]]:
    """주문 상세의 `execution` 을 체결 확정 폴링이 쓰는 스냅샷으로 옮긴다. 체결이 0 이면 `None`(기록할 사실이 없다)."""
    execution = fn.safe_dict(order, 'execution', {}) if isinstance(order, dict) else {}
    n = fn.js_number(execution.get('filledQuantity'))
    filled = n if n == n and n != 0 else 0  # JavaScript 의 `Number(x) || 0`
    if not filled > 0:
        return None
    amount = _positive(execution.get('filledAmount'))
    # 평균 체결가가 비어 있어도 체결 금액이 있으면 단가를 거꾸로 구할 수 있다.
    average = _positive(execution.get('averageFilledPrice'))
    if average is None and amount is not None:
        average = amount / filled
    # 수수료와 세금은 한쪽만 오는 경우가 있어(미국은 세금이 없다) 있는 것만 더한다.
    commission = _positive(execution.get('commission'))
    tax = _positive(execution.get('tax'))
    fee = None
    if commission is not None or tax is not None:
        fee = (commission if commission is not None else 0) + (tax if tax is not None else 0)
    return {'filled': filled, 'average': average, 'amount': amount, 'fee': fee, 'feeCurrency': 'USD' if country == 'US' else 'KRW'}


def _side_from_leg(leg: Any) -> Optional[str]:
    """`BUY`·`SELL` 값을 leg 안에서 찾는다. 문서의 키(`orderSide`)를 먼저 보고, 없으면 값으로 찾는다."""
    if not isinstance(leg, dict):
        return None

    def normalize(value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        upper = value.strip().upper()
        return 'sell' if upper == 'SELL' else 'buy' if upper == 'BUY' else None

    documented = normalize(leg.get('orderSide'))
    if documented is not None:
        return documented
    for value in leg.values():
        hit = normalize(value)
        if hit is not None:
            return hit
    return None


def conditional_side(conditional: Dict[str, Any]) -> str:
    """조건주문의 대표 방향. 조회 응답의 leg 에는 방향이 없어서, 실려 오면 그 값을 쓰고 없으면 종류로 유추한다.
    OCO 는 익절·손절 브래킷이라 매도, 그 밖(OTO 의 매수 진입, 근거가 없는 SINGLE)은 매수다."""
    from_leg = _side_from_leg(conditional.get('first'))
    if from_leg is not None:
        return from_leg
    return 'sell' if conditional.get('type') == 'OCO' else 'buy'


class TossAuth:
    """토스 OAuth2 토큰의 캐시와 발급 조정. TypeScript 판 `ts/src/toss/toss-auth.ts` 와 같다.

    토스는 클라이언트 하나에 유효한 토큰이 하나뿐이고 새로 발급하면 이전 토큰이 즉시 무효가 된다. 그래서 발급한 토큰은
    `expires_in` 에서 여유를 뺀 시각까지 메모리와 토큰 저장소에 두고, 발급은 저장소의 락으로 한 번에 한 곳만 한다.
    """

    def __init__(self, client_id: str, issue: Callable[[], Dict[str, Any]],
                 store_of: Callable[[], Optional[BrokerTokenStore]] = lambda: None) -> None:
        self.client_id = client_id
        self.issue = issue
        self.raw_store_of = store_of
        self.cached_token: Optional[Dict[str, Any]] = None
        self._lock = new_lock()

    @property
    def store_key(self) -> str:
        return token_store_key(TOKEN_KEY_PREFIX, self.client_id)

    def store_of(self) -> Any:
        """저장소. 옛 키 형식(클라이언트 ID 앞 12자)을 쓰는 판과 함께 도는 동안 두 키를 함께 읽고 쓴다."""
        store = self.raw_store_of()
        return None if store is None else LegacyKeyTokenStore(store, {self.store_key: legacy_token_store_key(TOKEN_KEY_PREFIX, self.client_id)})

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

        # 락을 잡은 뒤 저장소를 다시 읽는 단계는 `refresh_token_with_lock` 이 한다.
        def issue_and_cache() -> str:
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
            raw = maybe_await(store.get(self.store_key))
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
                maybe_await(store.set(self.store_key, fn.json_stringify(self.cached_token), int(ttl_ms)))
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
                maybe_await(store.delete(self.store_key))
            else:
                maybe_await(store.delete_if_access_token_equals(self.store_key, failed_token))
        except Exception:
            logger.debug('[toss] 저장소의 토큰을 지우지 못했다(메모리 캐시는 비웠다)', exc_info=True)


class toss(Exchange, ImplicitAPI):

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.access_token: Str = None
        self._token_auth: Optional[TossAuth] = None
        self._token_auth_client_id: Str = None
        self._blocked_until: Dict[str, int] = {}
        self._account_seq_lock = new_lock()
        # 실행 중에 쌓이는 캐시: 장 운영 캘린더(시장별 `{'value', 'fetchedAt'}`), 시장별 수수료율, 참고 환율.
        self._calendars: Dict[str, Dict[str, Any]] = {}
        self._commission_rates: Dict[str, float] = {}
        self._commissions_fetched_at = 0
        self._fx_rate: Optional[Dict[str, Any]] = None
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
            # TypeScript 판과 같은 값이다. 실시간(`ws`, `watch*`)은 `kr_broker.pro.toss` 가 True 로 바꾼다.
            'has': {
                'CORS': None,
                'spot': True,
                'margin': False,
                'swap': False,
                'future': False,
                'option': False,
                'sandbox': False,
                'ws': False,
                'watchTicker': False,
                'watchTrades': False,
                'watchOrderBook': False,
                'watchOrders': False,
                'fetchMarkets': True,
                'fetchCurrencies': False,
                'fetchTicker': True,
                'fetchTickers': True,
                'fetchOrderBook': True,
                'fetchOHLCV': True,
                'fetchBalance': True,
                'fetchTradingFee': True,
                'fetchTradingFees': False,
                'createOrder': True,
                'createMarketBuyOrderWithCost': True,
                'createTriggerOrder': True,
                'cancelOrder': True,
                'cancelAllOrders': 'emulated',
                'editOrder': True,
                'fetchOrder': True,
                'fetchOrders': False,
                'fetchOpenOrders': True,
                'fetchClosedOrders': True,
                'fetchCanceledOrders': True,
                'fetchMyTrades': 'emulated',
                'fetchTrades': True,
                'fetchMarketCalendar': True,
                'fetchStockWarnings': True,
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
                # 아래 네 옵션은 불리언이거나 불리언을 돌려주는 함수(값이 바뀔 수 있을 때)다. 기본은 꺼짐이다.
                # `fetch_balance({'currency': 'USD'})` 의 USD 에 원화 매수 여력의 달러 환산액을 늘 더한다. 환율은 토스 조회, 실패하면 `usdKrwRate` 다.
                'krwIntegratedMargin': None,
                # 국내 확장세션(프리·애프터) 주문을 연다.
                'nxtRouting': None,
                # 미국 확장세션에서 시장가를 지정가로 바꿔 낸다.
                'usExtendedLimit': None,
                # 정규장 종가 동시호가(국내 15:20~15:30, 미국 15:50~16:00 ET)의 신규 매수를 막는다. 시장이 받는 주문이라 기본은 꺼짐이다.
                'blockAuctionBuys': None,
                # 토큰과 발급 락을 여러 프로세스가 나눠 쓰는 저장소(BrokerTokenStore). 없으면 프로세스 메모리 캐시만 쓴다.
                'tokenStore': None,
                # 토스의 환율 조회가 실패했을 때 쓰는 환율 함수. 1달러당 원화를 돌려준다.
                'usdKrwRate': None,
                # 접수 뒤 체결 확정 조회와 취소 뒤 확정 조회의 예산 `{'attempts', 'intervalMs'}`. 사전이거나 사전을 돌려주는 함수다.
                'confirmBudget': None,
                # 접수 뒤 체결이, 취소 뒤 원주문의 끝이 확정될 때까지 주문 상세를 짧게 조회한다. 기본은 켜짐이고 `False` 일 때만 끈다(함수를 넘기면 켜진 것으로 본다).
                'confirmExecution': True,
                'authTimeout': AUTH_TIMEOUT_MS,
                'calendarTtl': CALENDAR_TTL_MS,
                'commissionsTtl': COMMISSIONS_TTL_MS,
                'fxRateTtl': FX_RATE_TTL_MS,
                'closedOrdersMaxPages': MAX_CLOSED_ORDER_PAGES,
                'conditionalOrdersMaxPages': MAX_CONDITIONAL_ORDER_PAGES,
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
        """`uid` 가 없을 때 `GET /accounts` 의 첫 계좌 순번을 찾아 `uid` 에 넣는다. 동시에 불러도 요청은 한 번 나간다."""
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
            request_headers['X-Tossinvest-Account'] = str(self.uid)
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
        # 코드 표에 없는 응답은 상태로만 분류한다. 주문 요청의 5xx 는 접수 미상이 된다(`is_outcome_unknown`).
        by_status = self.httpExceptions.get(str(code)) or (ExchangeNotAvailable if code >= 500 else None)
        if by_status is not None:
            raise self.http_status_error(code, by_status, feedback, detail=error_code)
        raise ExchangeError(feedback, detail=error_code)

    def unwrap(self, response: Any) -> Any:
        """응답의 `result` 봉투를 벗긴다. 봉투가 없으면 원본을, 본문이 비어 있으면 `None` 을 돌려준다."""
        if isinstance(response, dict) and 'result' in response:
            return response['result']
        return None if response == '' else response

    # ============ 종목 ============

    def _market_from_symbol(self, symbol: str) -> Dict[str, Any]:
        """심볼(`005930`, `005930/KRW`, `AAPL`)에서 종목을 만든다. 종목을 불러오지 않았을 때 코드의 모양으로 시장을 판별한다.
        클래스 주식의 `BRK/B` 는 통합 표기 `BRK.B` 로 바꾼다."""
        code = symbol_base_code(symbol)
        country = toss_market_country(code)
        quote = 'KRW' if country == 'KR' else 'USD'
        return self.safe_market_structure({
            'id': code,
            'symbol': f'{code}/{quote}',
            'base': code,
            'quote': quote,
            'baseId': code,
            'quoteId': quote,
            'type': 'spot',
            'spot': True,
            'margin': False,
            'active': None,
            'precision': {'amount': 1 if country == 'KR' else 1 / US_FRACTION_SCALE, 'price': None},
            'info': None,
            'options': {'country': country},
        })

    def market(self, symbol: Str) -> Dict[str, Any]:
        """통합 심볼(또는 종목 id)로 종목을 찾는다. 불러온 종목이 있으면 그것을, 없으면 심볼의 모양으로 만든다.
        토스에 없는 종목도 여기서는 막지 않는다. 주문을 보내면 토스가 `stock-not-found`(`BadSymbol`)로 알려 준다."""
        if symbol is None:
            raise ArgumentsRequired(f'{self.id} market() requires a symbol argument')
        loaded = (self.markets or {}).get(symbol)
        if loaded is None:
            candidates = (self.markets_by_id or {}).get(symbol)
            loaded = candidates[0] if candidates else None
        return loaded if loaded is not None else self._market_from_symbol(symbol)

    def safe_market(self, market_id: Str = None, market: Optional[Dict[str, Any]] = None, delimiter: Str = None,
                    market_type: Str = None) -> Dict[str, Any]:
        if market_id is not None:
            candidates = (self.markets_by_id or {}).get(market_id)
            if candidates:
                return candidates[0]
            if market is not None and market.get('id') == market_id:
                return market
            return self._market_from_symbol(market_id)
        return market if market is not None else self.safe_market_structure({'symbol': None})

    def fetch_markets(self, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """토스가 거래할 수 있는 종목 전체를 마켓별로 받는다(`GET /stocks/all`, 마켓당 한 번). `params['markets']` 로 마켓을 좁힌다."""
        params = {} if params is None else params
        markets = self.safe_list(params, 'markets')
        if markets is None:
            markets = self.safe_list(self.options, 'listedMarkets', list(LISTED_MARKETS))
        query = self.omit(params, 'markets')
        result = []
        for market in markets:
            response = self.private_market_get_stocks_all(self.extend({'market': market}, query))
            for row in self.to_array(self.unwrap(response)):
                result.append(self.parse_market(self.extend(row, {'market': market})))
        return result

    def parse_market(self, market: Dict[str, Any]) -> Dict[str, Any]:
        """`GET /stocks/all` 의 한 행(요청한 `market` 을 더한 것)을 종목으로 옮긴다."""
        market_id = self.safe_string(market, 'symbol')
        if market_id is None:
            raise ExchangeError(f'{self.id} parseMarket() missing symbol')
        listed_market = self.safe_string(market, 'market')
        country = 'KR' if listed_market is not None and listed_market in KR_LISTED_MARKETS else 'US'
        quote = 'KRW' if country == 'KR' else 'USD'
        # 시장별 기본 위탁수수료율이다. 실제 요율은 `fetch_trading_fee`(`GET /commissions`)가 정한다.
        brokerage = TOSS_BROKERAGE_FEE if country == 'KR' else TOSS_US_BROKERAGE_FEE
        return self.safe_market_structure({
            'id': market_id,
            'symbol': f'{market_id}/{quote}',
            'base': market_id,
            'quote': quote,
            'baseId': market_id,
            'quoteId': quote,
            'type': 'spot',
            'spot': True,
            'margin': False,
            'active': True,
            'taker': brokerage,
            'maker': brokerage,
            'precision': {'amount': 1 if country == 'KR' else 1 / US_FRACTION_SCALE, 'price': None},
            'info': market,
            'options': {
                'country': country,
                'market': listed_market,
                'name': self.safe_string(market, 'name'),
                'securityType': self.safe_string(market, 'securityType'),
                'isCommonShare': self.safe_bool(market, 'isCommonShare'),
                'isinCode': self.safe_string(market, 'isinCode'),
            },
        })

    @staticmethod
    def _country_of(market: Dict[str, Any]) -> str:
        return 'KR' if market.get('quote') == 'KRW' else 'US'

    def price_to_precision(self, symbol: Str, price: Any) -> Str:
        """가격을 호가 단위에 맞춘 문자열. 국내는 가격대별 호가 단위 표(`krx_tick_size`)로 반올림한다. 불러온 종목의 유형
        (`market['options']['securityType']`)이 주식(`STOCK`)이 아니면 표가 달라서 그대로 돌려준다. 미국은 기반 구현을 따른다.
        주문 경로는 이 메서드로 가격을 바꾸지 않는다."""
        if price is None:
            return None
        market = self.market(symbol)
        if self._country_of(market) != 'KR':
            return super().price_to_precision(symbol, price)
        security_type = self.safe_string(market.get('options'), 'securityType')
        if security_type is not None and security_type != 'STOCK':
            return fn.number_to_string(price)
        return decimal_to_precision(price, ROUND, get_krx_tick_size(fn.js_number(price)), TICK_SIZE, NO_PADDING)

    def _assert_krx_tick_aligned(self, market: Dict[str, Any], price: Any, method: str) -> None:
        """국내 지정가가 호가 단위 표에 맞지 않으면 요청 전에 `InvalidOrder` 다. 불러온 종목이 주식(`STOCK`)일 때만 검사하고, 종목 유형을
        모르거나(`load_markets` 전) ETF·ETN 이면 서버에 맡긴다. 서버도 같은 경우를 `price-tick-invalid` 로 거절한다."""
        if self._country_of(market) != 'KR' or self.safe_string(market.get('options'), 'securityType') != 'STOCK':
            return
        violation = krx_tick_violation(price)
        if violation is not None:
            raise InvalidOrder(f'{self.id} {method}() {violation} ({market["symbol"]})', detail=KRX_TICK_INVALID_DETAIL)

    def _order_price_string(self, market: Dict[str, Any], price: Any) -> Str:
        """요청 본문의 지정가. 국내는 호가에 맞추지 않고 그대로 보낸다(맞지 않는 가격은 `_assert_krx_tick_aligned` 가 막거나 서버가 거절한다)."""
        if price is None:
            return None
        return fn.number_to_string(price) if self._country_of(market) == 'KR' else self.price_to_precision(market['symbol'], price)

    def fetch_stock_warnings(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """종목 유의사항(정리매매·투자경고·투자위험·단기과열·VI·신주인수권) 원본(`GET /stocks/{symbol}/warnings`)."""
        response = self.private_market_get_stocks_symbol_warnings(self.extend({'symbol': self.market(symbol)['id']}, params))
        return self.to_array(self.unwrap(response))

    def fetch_market_investor_trading(self, market: str, interval: str = '1d', limit: int = 5,
                                      params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """투자자별 매매대금(개인·외국인·기관·기타법인의 매수·매도 대금). 종목이 아니라 시장(`KOSPI`·`KOSDAQ`) 단위다."""
        response = self.private_market_get_market_indicators_symbol_investor_trading(
            self.extend({'symbol': market, 'interval': interval, 'count': limit}, params))
        return self.safe_list(self.unwrap(response), 'records', [])

    def fetch_investor_trading(self, market: str, interval: str = '1d', limit: int = 5,
                               params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """`fetch_market_investor_trading` 의 옛 이름이다(한 판 뒤에 지운다). `fetch_investor_trading` 은 종목 단위 공통 조회
        (한국투자증권, KB증권)의 이름이라 토스증권의 `has['fetchInvestorTrading']` 은 비어 있다."""
        self._warn_deprecated('toss.fetchInvestorTrading()', 'fetchMarketInvestorTrading()')
        return self.fetch_market_investor_trading(market, interval, limit, params)

    def fetch_rankings(self, type: str, market_country: str = 'KR', duration: str = '1d', count: int = 100,
                       params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """랭킹 상위 행. `TOSS_SECURITIES_*` 는 토스증권 사용자의 체결 집중도이고 나머지는 시장 전체 기준이다."""
        response = self.private_market_get_rankings(
            self.extend({'type': type, 'marketCountry': market_country, 'duration': duration, 'count': count}, params))
        return self.safe_list(self.unwrap(response), 'rankings', [])

    # ============ 장 운영 캘린더와 세션 ============

    def fetch_market_sessions(self, market: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """장 운영 캘린더(전일·당일·익일 영업일의 세션 시각) 원본. 30분 안에 받은 것은 다시 부르지 않는다(`params['refresh']` 로 강제).
        받은 날짜별 개장 여부는 공용 휴장일 캘린더에도 넣는다. `market` 은 `'KR'`·`'US'` 이고 대소문자를 가리지 않는다.
        그 밖의 값은 요청 없이 `BadRequest` 다. 날짜별 개장 여부만 필요하면 세 증권사 공통인 `fetch_market_calendar` 를 쓴다."""
        country = market.upper() if isinstance(market, str) else None
        if country not in ('KR', 'US'):
            raise BadRequest(f"{self.id} fetchMarketSessions() market must be 'KR' or 'US'")
        cached = self._calendars.get(country)
        ttl = self.safe_integer(self.options, 'calendarTtl', CALENDAR_TTL_MS)
        if cached is not None and self.safe_bool(params, 'refresh', False) is not True and _now_ms() - cached['fetchedAt'] < ttl:
            return cached['value']
        if country == 'KR':
            value = self.unwrap(self.private_market_get_market_calendar_kr({}))
            self._calendars['KR'] = {'value': value, 'fetchedAt': _now_ms()}
            apply_market_calendar('KR', toss_kr_calendar_days(value))
            return value
        value = self.unwrap(self.private_market_get_market_calendar_us({}))
        self._calendars['US'] = {'value': value, 'fetchedAt': _now_ms()}
        apply_market_calendar('US', toss_us_calendar_days(value))
        return value

    def fetch_market_calendar(self, params: Any = None, legacy_params: Optional[Dict[str, Any]] = None) -> Any:
        """날짜별 개장 여부. 세 증권사 공통 모양이다. `params['market']` 은 `'KR'`(기본)·`'US'` 이고 대소문자를 가리지 않는다.
        장 운영 캘린더(`fetch_market_sessions`)의 전일·당일·익일 영업일과 그 사이의 평일(닫힌 날)이다. 받은 날짜는 공용 휴장일 캘린더에도 넣는다.
        첫 인자로 시장 문자열을 넘기던 옛 호출(`fetch_market_calendar('KR', params)`)은 한 판 동안 경고를 남기고
        `fetch_market_sessions` 의 결과를 돌려준다. 둘째 인자 `legacy_params` 는 그 옛 호출의 `params` 자리다."""
        if isinstance(params, str):
            self._warn_deprecated('toss.fetchMarketCalendar(market)', 'fetchMarketCalendar({ market }) 나 fetchMarketSessions(market)')
            return self.fetch_market_sessions(params, legacy_params)
        market = self._calendar_market(params)
        value = self.fetch_market_sessions(market, self.omit(params or {}, 'market'))
        return toss_kr_calendar_days(value) if market == 'KR' else toss_us_calendar_days(value)

    def current_kr_session(self, now_ms: Optional[int] = None) -> Optional[str]:
        """국내 캘린더로 본 지금의 세션. `'closed'` 는 열린 세션이 없다는 뜻이고, `None` 은 캘린더를 받지 못했다는 뜻이다."""
        try:
            session = find_kr_session(self.fetch_market_sessions('KR'), now_ms)
            return session if session is not None else 'closed'
        except Exception:
            logger.warning('[toss] 국내 장 운영 캘린더를 받지 못했다. 정적 시간표로 판정한다', exc_info=True)
            return None

    def current_us_session(self, now_ms: Optional[int] = None) -> Optional[str]:
        """미국 캘린더로 본 지금의 세션. `'closed'` 와 `None` 의 뜻은 `current_kr_session` 과 같다."""
        try:
            session = find_us_session(self.fetch_market_sessions('US'), now_ms)
            return session if session is not None else 'closed'
        except Exception:
            logger.warning('[toss] 미국 장 운영 캘린더를 받지 못했다. 정규장 기준으로 판정한다', exc_info=True)
            return None

    def _us_calendar_value(self) -> Any:
        cached = self._calendars.get('US')
        return cached['value'] if cached is not None else None

    # ============ 시세 ============

    def parse_ticker(self, ticker: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        market = self.safe_market(self.safe_string(ticker, 'symbol'), market)
        timestamp = self.parse8601(self.safe_string(ticker, 'timestamp'))
        last = self.safe_string(ticker, 'lastPrice')
        # 토스의 현재가 응답에는 최종가만 있다. 호가와 거래량은 비워 둔다.
        return self.safe_ticker({
            'symbol': market['symbol'],
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'close': last,
            'last': last,
            'info': ticker,
        }, market)

    def fetch_ticker(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        market = self.market(symbol)
        rows = self.to_array(self.unwrap(self.private_market_get_prices(self.extend({'symbols': market['id']}, params))))
        row = next((candidate for candidate in rows if self.safe_string(candidate, 'symbol') == market['id']), None)
        if row is None:
            row = rows[0] if rows else None
        if row is None:
            raise NullResponse(f"{self.id} fetchTicker() 응답에 {market['id']} 가 없다")
        return self.parse_ticker(row, market)

    def fetch_tickers(self, symbols: Strings = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """여러 종목의 현재가. 토스는 한 번에 200종목까지 받는다. 종목을 주지 않으면 `ArgumentsRequired`(전 종목 시세는 없다)."""
        if not symbols:
            raise ArgumentsRequired(f'{self.id} fetchTickers() requires a list of symbols')
        unified = self.market_symbols(symbols)
        ids = [self.market(symbol)['id'] for symbol in unified]
        rows: List[Any] = []
        batch = 200
        for i in range(0, len(ids), batch):
            response = self.private_market_get_prices(self.extend({'symbols': ','.join(ids[i:i + batch])}, params))
            rows.extend(self.to_array(self.unwrap(response)))
        return self.parse_tickers(rows, unified)

    def fetch_order_book(self, symbol: str, limit: Int = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        market = self.market(symbol)
        response = self.unwrap(self.private_market_get_orderbook(self.extend({'symbol': market['id']}, params)))
        timestamp = self.parse8601(self.safe_string(response, 'timestamp'))
        orderbook = self.parse_order_book(response, market['symbol'], timestamp, 'bids', 'asks', 'price', 'volume')

        def valid(level: List[Any]) -> bool:
            return _is_finite_number(level[0]) and level[0] > 0

        orderbook['bids'] = [level for level in orderbook['bids'] if valid(level)]
        orderbook['asks'] = [level for level in orderbook['asks'] if valid(level)]
        if limit is not None:
            orderbook['bids'] = orderbook['bids'][:limit]
            orderbook['asks'] = orderbook['asks'][:limit]
        return orderbook

    def fetch_ohlcv(self, symbol: str, timeframe: str = '1m', since: Int = None, limit: Int = None,
                    params: Optional[Dict[str, Any]] = None) -> List[List[Any]]:
        """봉. 토스는 `1m` 과 `1d` 만 준다. 다른 주기는 가까운 주기로 바꾸지 않고 던진다.
        봉의 시각은 시작 시각이다(토스의 1분봉은 종료 시각으로 오므로 1분을 뺀다). `params['until']`(ms)은 이 시각 이전의 봉만 받는다.
        `since` 가 있으면 `since` 부터 `limit` 개이고, 없으면 가장 최근 `limit` 개다. 최신 봉부터 200봉씩 10쪽까지 거슬러 받으므로,
        그 안에 `since` 까지 닿지 못하면 경고 로그를 남기고 받은 가장 오래된 봉부터 돌려준다."""
        params = {} if params is None else params
        timeframe = '1m' if timeframe is None else timeframe
        interval = self.safe_string(self.timeframes, timeframe)
        if interval is None:
            raise NotSupported(f"{self.id} 미지원 타임프레임 '{timeframe}'. 지원: 1m, 1d")
        market = self.market(symbol)
        target = max(1, DEFAULT_CANDLE_LIMIT if limit is None else limit)
        until = self.safe_integer(params, 'until')
        query = self.omit(params, 'until')
        bar_start_shift = int(self.parse_timeframe('1m') * 1000) if timeframe == '1m' else 0
        # 일봉은 거래일의 00:00 UTC 로 옮긴다(`candle_period_utc_ms`). 토스는 현지 자정(국내 00:00 KST, 미국 00:00 ET)으로 준다.
        daily_market = self._country_of(market) if is_daily_or_longer_timeframe(timeframe) else None
        before = self.iso8601(until) if until is not None else None
        rows: List[List[Any]] = []
        reached_since = False
        exhausted = False
        for _ in range(MAX_CANDLE_PAGES):
            # `since` 가 있으면 `since` 까지 거슬러 가야 하므로 쪽마다 최대로 받는다.
            count = min(CANDLE_PAGE_LIMIT, target - len(rows)) if since is None else CANDLE_PAGE_LIMIT
            request = {'symbol': market['id'], 'interval': interval, 'count': count, 'before': before, 'adjusted': 'true'}
            response = self.unwrap(self.private_market_get_candles(self.extend(request, query)))
            candles = self.safe_list(response, 'candles', [])
            if not candles:
                exhausted = True
                break
            for candle in candles:
                row = self.parse_ohlcv(candle, market)
                start = row[0]
                if start is None:
                    continue
                shifted = candle_period_utc_ms(start, timeframe, daily_market) if daily_market is not None else start - bar_start_shift
                if since is not None and shifted <= since:
                    reached_since = True
                if since is not None and shifted < since:
                    continue
                rows.append([shifted, row[1], row[2], row[3], row[4], row[5]])
            next_before = self.safe_string(response, 'nextBefore')
            if next_before is None:
                exhausted = True
                break
            done = len(rows) >= target if since is None else reached_since
            if done:
                break
            before = next_before
        if since is not None and not reached_since and not exhausted:
            logger.warning('[toss] 캔들 페이지 상한에 닿아 since 까지 받지 못했다. 받은 가장 오래된 봉부터 돌려준다(%s %s since=%s, %d쪽)',
                           market['symbol'], timeframe, since, MAX_CANDLE_PAGES)
        seen = set()
        result = []
        for row in rows:
            if not (row[0] > 0 and _is_finite_number(row[4]) and row[4] > 0) or row[0] in seen:
                continue
            seen.add(row[0])
            result.append(row)
        result.sort(key=lambda row: row[0])
        return result[-target:] if since is None else result[:target]

    def parse_ohlcv(self, ohlcv: Any, market: Optional[Dict[str, Any]] = None) -> List[Any]:
        return [
            self.parse8601(self.safe_string(ohlcv, 'timestamp')),
            self.safe_number(ohlcv, 'openPrice'),
            self.safe_number(ohlcv, 'highPrice'),
            self.safe_number(ohlcv, 'lowPrice'),
            self.safe_number(ohlcv, 'closePrice'),
            self.safe_number(ohlcv, 'volume'),
        ]

    # ============ 잔고 ============

    def fetch_balance(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """잔고. 현금은 통화 키(`KRW`·`USD`)이고 값은 현금 매수 가능 금액이며, 보유 종목은 `market['base']` 키이고 `total` 이 보유 수량이다.

        `params['symbol']` 을 주면 그 종목의 보유만, `params['currency']`(`KRW`·`USD`)를 주면 그 현금만 받는다. 둘 다 주면 그 종목의 보유와
        그 통화의 현금을 함께 받는다. 달러 현금을 받을 때 `options['krwIntegratedMargin']` 이 켜져 있으면 원화 예수금을 참고 환율로 환산해 더한다
        (전체 잔고에는 이중 계상이라 더하지 않는다). 보유 종목 키가 같은 잔고의 현금 키와 겹치면(미국 티커 `USD` 와 달러 현금) 한쪽을
        덮어쓰지 않고 `NotSupported` 를 던진다. `symbol` 과 `currency` 로 나눠 받는다.

        `free` 는 지금 주문에 쓸 수 있는 양이다(ccxt 정의). 현금은 매수 가능 금액만 있고 예수금을 주는 API 가 없어 `total` 과 `used` 가 비어 있다.
        보유 종목의 `free` 는 `symbol` 로 한 종목만 받을 때 매도 가능 수량(`GET /sellable-quantity`)으로 채우고, 전체 잔고에서는 비어 있다.
        """
        symbol = self.safe_string(params, 'symbol')
        currency = self.safe_string_upper(params, 'currency')
        if currency is not None and currency not in ('KRW', 'USD'):
            raise ArgumentsRequired(f"{self.id} fetchBalance() currency must be 'KRW' or 'USD'")
        holdings = None
        sellable = None
        if currency is None or symbol is not None:
            market_id = self.market(symbol)['id'] if symbol is not None else None
            holdings = self.unwrap(self.private_account_get_holdings({'symbol': market_id} if market_id is not None else {}))
            # 보유 목록이 없으면 "보유 없음"이 아니라 모르는 것이다.
            if not isinstance(holdings, dict) or not isinstance(holdings.get('items'), list):
                raise BadResponse(f'{self.id} 보유 조회 응답에 items 목록이 없다: {str(holdings)[:200]}')
            if market_id is not None and any(item.get('symbol') == market_id and (self.safe_number(item, 'quantity') or 0) > 0
                                             for item in holdings['items']):
                sellable = {market_id: self._fetch_sellable_quantity(market_id)}
        buying_power: Dict[str, Any] = {}
        if symbol is None or currency is not None:
            for code in ([currency] if currency is not None else ['KRW', 'USD']):
                buying_power[code] = self.unwrap(self.private_account_get_buying_power({'currency': code}))
        integrated = None
        if currency == 'USD' and self.is_option_enabled('krwIntegratedMargin'):
            integrated = self._krw_as_usd()
        return self.parse_balance({'holdings': holdings, 'sellable': sellable, 'buyingPower': buying_power, 'integrated': integrated})

    def _fetch_sellable_quantity(self, market_id: str) -> float:
        """매도 주문에 즉시 쓸 수 있는 수량(`GET /sellable-quantity`). 값이 없거나 숫자가 아니면 0 이 아니라 모르는 것이므로 던진다."""
        response = self.unwrap(self.private_account_get_sellable_quantity({'symbol': market_id}))
        quantity = self.safe_number(response, 'sellableQuantity')
        if quantity is None:
            raise BadResponse(f'{self.id} 매도 가능 수량 응답에 sellableQuantity 가 없거나 숫자가 아니다: {response!r}')
        return quantity

    def _krw_as_usd(self) -> Optional[Dict[str, float]]:
        """원화 매수 여력을 참고 환율로 달러로 환산한다. 원화가 없거나 환율을 모르면 `None`."""
        krw = self._parse_cash(self.unwrap(self.private_account_get_buying_power({'currency': 'KRW'})))
        if not krw > 0:
            return None
        usd_krw = self._usd_krw_rate()
        if not usd_krw > 0:
            return None
        return {'krw': krw, 'usdKrw': usd_krw, 'krwAsUsd': krw / usd_krw}

    def _parse_cash(self, buying_power: Any) -> float:
        """매수 가능 금액. 필드가 없거나 숫자가 아니면 0 이 아니라 모르는 것이므로 던진다. 음수(미수)는 0 으로 둔다(원값은 `info`)."""
        raw = buying_power.get('cashBuyingPower') if isinstance(buying_power, dict) else None
        cash = float('nan') if raw is None or str(raw).strip() == '' else fn.js_number(raw)
        if not math.isfinite(cash):
            raise BadResponse(f'{self.id} 매수 가능 금액 응답에 cashBuyingPower 가 없거나 숫자가 아니다: {buying_power!r}')
        return cash if cash > 0 else 0

    def parse_balance(self, response: Any) -> Dict[str, Any]:
        """`fetch_balance` 가 모은 응답(`{'holdings', 'sellable', 'buyingPower', 'integrated'}`)을 잔고 구조로 옮긴다.

        `sellable` 은 종목 id 별 매도 가능 수량이다. 보유 종목의 `free` 는 그 값이고 없으면 비운다. `used` 는 `safe_balance` 가 `total − free` 로 채운다.
        """
        holdings = response.get('holdings')
        sellable = response.get('sellable') or {}
        buying_power = response.get('buyingPower')
        integrated = response.get('integrated')
        result: Dict[str, Any] = {'info': response, 'timestamp': None, 'datetime': None}
        held: Dict[str, Any] = {}
        for item in self.safe_list(holdings, 'items', []) or []:
            quantity = self.safe_number(item, 'quantity')
            if quantity is None or not quantity > 0:
                continue
            held[item.get('symbol')] = {'free': sellable.get(item.get('symbol')), 'used': None, 'total': quantity, 'info': item}
        for code, power in (buying_power or {}).items():
            cash = self._parse_cash(power)
            info = dict(power) if isinstance(power, dict) else {}
            if code == 'USD' and integrated is not None:
                logger.info('[toss] 통합증거금: 원화 매수 여력을 달러로 환산해 합산한다(달러 %s, %s)', cash, integrated)
                cash += integrated['krwAsUsd']
                info['integratedMargin'] = integrated
            # 매수 가능 금액은 정산 뒤 계좌 현금이 아니다. `total` 과 `used` 는 모른다.
            result[code] = {'free': cash, 'used': None, 'total': None, 'info': info}
        for code, holding in held.items():
            # 겹친 키에 대입하면 보유나 현금 한쪽이 알림 없이 사라진다.
            if result.get(code) is not None:
                raise NotSupported(f'{self.id} fetchBalance() 보유 종목 {code} 가 현금 {code} 와 키가 같아 한 잔고에 담을 수 없다. '
                                   'params.symbol 로 그 종목의 보유를, params.currency 로 현금을 따로 받는다')
            result[code] = holding
        return self.safe_balance(result)

    # ============ 수수료 ============

    def fetch_commissions(self, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """수수료율 조회(`GET /commissions`) 원본."""
        return self.to_array(self.unwrap(self.private_account_get_commissions({} if params is None else params)))

    def refresh_commissions(self) -> None:
        """시장별 위탁수수료율을 받아 캐시한다(24시간). 캐시가 신선하면 부르지 않는다. 실패하면 던진다."""
        ttl = self.safe_integer(self.options, 'commissionsTtl', COMMISSIONS_TTL_MS)
        if self._commission_rates and _now_ms() - self._commissions_fetched_at < ttl:
            return
        rows = self.fetch_commissions()
        today = kst_date(_now_ms())
        for country in ('KR', 'US'):
            rate = pick_commission_rate(rows, country, today)
            if rate is not None:
                self._commission_rates[country] = rate
        self._commissions_fetched_at = _now_ms()
        logger.info('[toss] 수수료율을 갱신했다: %s', self._commission_rates)

    def fetch_trading_fee(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """위탁수수료율. `maker` 와 `taker` 는 같다. 국내 매도에 붙는 증권거래세는 별도다."""
        self.refresh_commissions()
        market = self.market(symbol)
        country = self._country_of(market)
        brokerage = self._commission_rates.get(country)
        if brokerage is None:
            brokerage = self._default_brokerage(country)
        return {'info': dict(self._commission_rates), 'symbol': market['symbol'], 'maker': brokerage, 'taker': brokerage,
                'percentage': True, 'tierBased': False}

    @staticmethod
    def _default_brokerage(country: str) -> float:
        return get_toss_effective_fee_rate(country, 'buy')

    # ============ 환율과 고액주문 ============

    def _usd_krw_rate(self) -> float:
        """참고 환율(1달러당 원화). 토스의 환율 조회를 먼저 쓰고, 실패하면 `options['usdKrwRate']` 로 폴백한다. 5분 캐시. 모르면 0."""
        ttl = self.safe_integer(self.options, 'fxRateTtl', FX_RATE_TTL_MS)
        if self._fx_rate is not None and _now_ms() - self._fx_rate['fetchedAt'] < ttl:
            return self._fx_rate['rate']
        rate: Any = 0
        try:
            response = self.unwrap(self.private_market_get_exchange_rate({'baseCurrency': 'USD', 'quoteCurrency': 'KRW'}))
            parsed = self.safe_number(response, 'rate')
            if parsed is not None and parsed > 0:
                rate = parsed
        except Exception:
            logger.debug('[toss] 환율 조회에 실패해 환율 소스로 폴백한다', exc_info=True)
        fallback = self.options.get('usdKrwRate')
        if rate <= 0 and fallback is not None:
            try:
                rate = maybe_await(fallback())
            except Exception:
                rate = 0
        if _is_finite_number(rate) and rate > 0:
            self._fx_rate = {'rate': rate, 'fetchedAt': _now_ms()}
            return rate
        return 0

    def _is_high_value(self, notional: Any, country: str) -> bool:
        """고액주문 확인 기준을 넘는가. 국내는 1억원, 미국은 1억원을 환율로 나눈 달러 금액이다(환율을 모르면 7만 달러)."""
        if not _is_finite_number(notional) or not notional > 0:
            return False
        if country == 'KR':
            return notional >= TOSS_HIGH_VALUE_THRESHOLD_KRW
        if notional >= TOSS_HIGH_VALUE_THRESHOLD_USD:
            return True
        if notional < HIGH_VALUE_USD_LOOKUP_FLOOR:
            return False
        rate = self._usd_krw_rate()
        return rate > 0 and notional >= (TOSS_HIGH_VALUE_THRESHOLD_KRW / rate) * HIGH_VALUE_MARGIN

    # ============ 주문 ============

    def normalize_quantity(self, symbol: str, type: str, side: str, amount: Any) -> float:
        """주문 수량을 토스의 규칙에 맞춘다. 국내는 정수 주(소수점은 내린다), 미국 시장가 매도만 소수점 6자리까지 허용하고,
        그 밖의 미국 주문은 정수 주다. 내린 뒤 0 이면 `InvalidOrder`, 수량이 유한하지 않거나 0 이하이면 `ArgumentsRequired` 다."""
        if not _is_finite_number(amount) or amount <= 0:
            raise ArgumentsRequired(f'{self.id} 주문 수량 비정상: {fn.js_string(amount)} ({symbol} {side})')
        country = self._country_of(self.market(symbol))
        if country == 'US' and type == 'market' and side == 'sell':
            # 십진 문자열로 자른다. `math.floor(8.2 * 1e6)` 은 `8199999` 라 0.000001주가 덜 나간다.
            return float(decimal_to_precision(amount, TRUNCATE, US_FRACTION_DIGITS, DECIMAL_PLACES))
        floored = math.floor(amount)
        if floored <= 0:
            hint = ' — US 소수점 매수는 금액(cost) 주문을 사용할 것' if country == 'US' and side == 'buy' else ''
            raise InvalidOrder(f'{self.id} 주문 수량 floor 후 0: {fn.js_string(amount)} → {floored} ({symbol} {side}){hint}')
        if floored != amount:
            logger.warning('[toss] 분수 주문을 정수로 내린다(%s): %s → %s (%s %s %s)',
                           '국내 단주' if country == 'KR' else '미국 소수점은 시장가 매도 전용', amount, floored, symbol, side, type)
        return floored

    def create_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None,
                     params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """주문을 낸다. `params['triggerPrice']` 가 있으면 조건주문이다. 인자의 뜻은 모듈 설명을 본다.

        확장세션(프리·애프터, 미국 주간거래)에서 시장가 주문은 매수와 매도 모두 지정가로 바꿔 낸다(옵션 `nxtRouting`·`usExtendedLimit` 이 켜져 있을 때만).
        이때 지정가가 아직 체결되지 않았으면 미체결 주문(`status: 'open'`, `info['extendedSession']` 에 세션 이름)을 돌려준다.
        """
        params = {} if params is None else params
        amount, price = fn.decimal_to_float(amount), fn.decimal_to_float(price)
        if side not in ('buy', 'sell'):
            raise InvalidOrder(f"{self.id} createOrder() side must be 'buy' or 'sell'")
        if type not in ('limit', 'market'):
            raise InvalidOrder(f"{self.id} createOrder() type must be 'limit' or 'market'")
        self._assert_no_conditional_params('createOrder', params)
        market = self.market(symbol)
        country = self._country_of(market)
        if self.safe_value(params, 'triggerPrice') is not None:
            return self._create_conditional_order(market, type, side, amount, price, params)
        self._assert_no_computed_params('createOrder', params, ORDER_COMPUTED_FIELDS)

        is_market = type == 'market'
        cost = self.safe_number(params, 'cost')
        # 미국 시장가 매수에 금액이 있으면 금액 기준 주문이다(소수점으로 체결된다). 그 밖에는 수량 기준이다.
        use_amount_based = is_market and side == 'buy' and country == 'US' and cost is not None and cost > 0
        if not use_amount_based and type == 'limit' and price is None:
            raise ArgumentsRequired(f'{self.id} createOrder() requires a price argument for a limit order')
        if type == 'limit' and price is not None:
            self._assert_krx_tick_aligned(market, price, 'createOrder')
        quantity = 0 if use_amount_based else self.normalize_quantity(symbol, type, side, amount)
        client_order_id = self.safe_string(params, 'clientOrderId')
        time_in_force = self._parse_time_in_force(params)

        # 확장세션 시장가는 지정가로 바꿔 낸다. 바꾸지 않으면 세션 게이트를 열어도 주문 형태 검사에서 막힌다.
        effective_type = type
        effective_price = price
        extended_session = None
        if is_market and not use_amount_based:
            if country == 'US':
                conversion = self._us_extended_session_conversion(symbol, side, quantity)
            else:
                conversion = self._kr_extended_session_conversion(symbol, side)
            if conversion is not None:
                if conversion.get('error') is not None:
                    logger.warning('[toss] 확장세션 지정가 전환을 보류한다(%s %s %s): %s', symbol, side, conversion['session'], conversion['error'])
                    raise OrderNotSent(conversion['error'], detail='extended-session-limit-unavailable')
                effective_type = 'limit'
                effective_price = conversion.get('price')
                extended_session = conversion['session']
                logger.info('[toss] 확장세션이라 시장가를 지정가로 바꿔 낸다(%s %s %s, %s)', symbol, side, extended_session, effective_price)

        # 거래시간 검사: 국내는 캘린더의 세션, 미국은 캘린더의 네 세션으로 판정한다. 실주문 직전의 마지막 방어선이다.
        gate = self._check_orderable_session(symbol, country, {
            'isMarket': effective_type == 'market', 'useAmountBased': use_amount_based, 'quantity': quantity,
        }, side)
        if gate is not None:
            logger.info('[toss] 거래시간 밖이라 주문을 보내지 않는다(%s %s): %s', symbol, side, gate)
            raise MarketClosed(gate)

        body: Dict[str, Any] = {
            'symbol': market['id'],
            'side': 'SELL' if side == 'sell' else 'BUY',
            'orderType': 'MARKET' if effective_type == 'market' else 'LIMIT',
        }
        if client_order_id is not None:
            body['clientOrderId'] = client_order_id
        if time_in_force is not None:
            body['timeInForce'] = time_in_force
        if use_amount_based:
            body['orderAmount'] = self.number_to_string(cost)
        else:
            body['quantity'] = self.number_to_string(quantity)
        if effective_type == 'limit':
            body['price'] = self._order_price_string(market, effective_price)

        # 고액주문 확인 표시. 명목가를 알 수 있을 때만 붙인다(수량 기준 시장가는 서버의 400 이 마지막 방어선이다).
        if use_amount_based:
            notional = cost
        else:
            notional = quantity * effective_price if effective_price is not None else 0
        if self._is_high_value(notional, country):
            body['confirmHighValueOrder'] = True
            logger.warning('[toss] 고액주문이라 confirmHighValueOrder 를 켠다(%s %s %s)', symbol, notional, country)

        response = self.unwrap(self.private_account_post_orders(self.extend(body, self.omit(params, ORDER_HANDLED_PARAMS))))
        order_id = self.safe_string(response, 'orderId')
        if order_id is None:
            raise OrderOutcomeUnknown(f'{self.id} 주문 접수 응답에 orderId 가 없다. 접수 여부를 주문 조회로 확인해야 한다')
        draft = {
            'market': market, 'type': effective_type, 'side': side, 'price': effective_price, 'quantity': quantity,
            'useAmountBased': use_amount_based, 'orderId': order_id, 'clientOrderId': client_order_id,
            'timeInForce': time_in_force, 'response': response, 'extendedSession': extended_session,
        }

        # 확장세션 지정가는 체결을 가정하지 않는다. 접수 직후 미체결 장부에 남아 있으면 미체결 주문으로 돌려준다.
        if extended_session is not None:
            try:
                open_orders = self.fetch_open_orders(symbol)
                still_open = any(open_order.get('id') == order_id for open_order in open_orders)
            except Exception:
                still_open = True
            if still_open:
                logger.info('[toss] 확장세션 지정가가 접수됐고 아직 체결되지 않았다(%s %s %s)', order_id, symbol, effective_price)
                return self._build_created_order(draft, 'open', still_open=True)

        logger.info('[toss] 주문이 접수됐다(%s %s %s %s)', order_id, symbol, side, effective_type)
        if self.safe_bool(params, 'confirmExecution', self.options.get('confirmExecution') is not False) is False:
            return self._build_created_order(draft, 'open')
        snapshot, last = self._confirm_order_execution(order_id, country)
        # 마지막 조회의 `result` 가 `None` 이면 조회하지 못한 것과 같다. 주문은 이미 접수됐으므로 던지지 않고 미체결로 돌려준다.
        status = self.parse_order_status(self.safe_string(last, 'status')) if last is not None else 'open'
        return self._build_created_order(draft, status, snapshot=snapshot, raw=last)

    def edit_order(self, id: str, symbol: str, type: str, side: str, amount: Num = None, price: Num = None,
                   params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """주문을 정정한다. 잔량 전부를 새 가격으로 옮긴다. 국내는 정정 본문의 수량(`quantity`)에 주문 상세(`GET /orders/{orderId}`)로 읽은
        잔량을 싣고, 미국은 가격만 보낸다. `amount` 는 ccxt 와 같이 정정 뒤 주문의 총수량(체결분 포함)이고, 주면 주문 상세로 대조해 총수량과
        다르면 정정 요청 없이 `NotSupported` 다. 명세의 `quantity` 뜻이 정해지지 않아 국내는 체결 없는 주문만 정정하고, 일부 체결된 주문은
        `NotSupported` 다. 일부정정(`params['partial']`)은 받지 않는다. 주문 상세 조회가 실패하면 던진다(미국에서 `amount` 가 없으면 조회는
        고액주문 확인에만 쓰므로 실패해도 정정한다). 정정하면 새 주문번호가 나온다. 장 시간 밖이면 원주문 조회와 정정 요청 없이 `MarketClosed` 다.
        판정은 `create_order` 와 같고, 정정은 신규 진입이 아니라서 동시호가 매수 차단은 걸지 않는다. `params['trigger']` 가 `True` 면 조건주문 정정이고,
        조건 전체를 등록과 같은 인자로 다시 선언한다. 등록처럼 장 시간 게이트는 거치지 않는다."""
        params = {} if params is None else params
        amount, price = fn.decimal_to_float(amount), fn.decimal_to_float(price)
        if self.safe_bool_2(params, 'trigger', 'stop', False) is True:
            if amount is None:
                raise ArgumentsRequired(f'{self.id} editOrder() 는 조건주문 정정에 amount 인자가 필요하다')
            return self._modify_conditional_order(id, self.market(symbol), type, side, amount, price, params)
        if type not in ('limit', 'market'):
            raise InvalidOrder(f"{self.id} editOrder() type must be 'limit' or 'market'")
        self._assert_no_conditional_params('editOrder', params)
        self._assert_no_computed_params('editOrder', params, EDIT_COMPUTED_FIELDS)
        market = self.market(symbol)
        country = self._country_of(market)
        if type == 'limit' and price is None:
            raise ArgumentsRequired(f'{self.id} editOrder() requires a price argument for a limit order')
        if self.safe_bool(params, 'partial', False) is True:
            raise NotSupported(f'{self.id} editOrder() 의 일부정정(params.partial)은 지원하지 않는다. 토스 정정은 잔량 전부를 새 가격으로 옮긴다')
        if type == 'limit' and price is not None:
            self._assert_krx_tick_aligned(market, price, 'editOrder')

        # 원주문 조회보다 먼저 판정한다. 정정 본문의 수량은 국내 잔량(정수)이거나 없어서(미국) 소수점 제한에 걸리지 않는 0 을 넘긴다.
        gate = self._check_orderable_session(symbol, country, {'isMarket': type == 'market', 'useAmountBased': False, 'quantity': 0}, None)
        if gate is not None:
            logger.info('[toss] 거래시간 밖이라 정정 요청을 보내지 않는다(%s %s): %s', id, symbol, gate)
            raise MarketClosed(gate)

        # 국내는 정정 수량을 싣기 위해, `amount` 를 주면 대조하기 위해 원주문을 조회한다. 이때 조회가 실패하면 던진다.
        original = self._edit_original(id) if country == 'KR' or amount is not None else None
        if country == 'KR' and original is not None and original['filled'] > 0:
            raise NotSupported(f"{self.id} editOrder() 는 일부 체결된 국내 주문({id}, 체결 {fn.js_string(original['filled'])})을 정정하지 않는다. "
                               '정정 수량(quantity)이 정정 뒤 총수량인지 옮길 수량인지 확인하지 못했다. 취소한 뒤 다시 주문한다')
        if amount is not None:
            assert_whole_remaining_edit(self.id, id, amount, original if original is not None else {})

        body: Dict[str, Any] = {'orderId': id, 'orderType': 'MARKET' if type == 'market' else 'LIMIT'}
        if country == 'KR' and original is not None:
            body['quantity'] = self.number_to_string(original['remaining'])
        if type == 'limit':
            body['price'] = self._order_price_string(market, price)
        # 명목가는 잔량 × 가격이다. 미국에서 원주문을 조회하지 않았으면 고액주문 확인용으로만 읽는다.
        if original is not None:
            notional = original['remaining'] * (price if price is not None else 0)
        else:
            notional = self._us_edit_notional(id, price)
        if self._is_high_value(notional, country):
            body['confirmHighValueOrder'] = True

        response = self.unwrap(self.private_account_post_orders_orderid_modify(self.extend(body, self.omit(params, EDIT_HANDLED_PARAMS))))
        new_order_id = self.safe_string(response, 'orderId')
        if new_order_id is None:
            raise OrderOutcomeUnknown(f'{self.id} 정정 응답에 orderId 가 없다. 정정 여부를 주문 조회로 확인해야 한다')
        logger.info('[toss] 정정주문으로 주문번호가 바뀌었다(%s → %s, %s)', id, new_order_id, symbol)
        timestamp = self.milliseconds()
        return self.safe_order({
            'info': response,
            'id': new_order_id,
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'symbol': market['symbol'],
            'type': type,
            'side': side,
            'price': price,
            # 정정 뒤 총수량. 국내는 조회한 잔량을 실었으므로 알고, 미국에서 `amount` 를 주지 않았으면 확인하지 않았으므로 비운다.
            'amount': amount if amount is not None else (edit_order_total(original) if country == 'KR' and original is not None else None),
            'status': 'open',
            'trades': [],
        }, market)

    def _edit_original(self, order_id: str) -> Dict[str, Any]:
        """정정할 원주문의 체결 수량과 잔량(주문 상세). 조회가 실패하면 던지고, 없거나 잔량이 없으면 `OrderNotFound` 다."""
        order = self.unwrap(self.private_account_get_orders_orderid({'orderId': order_id}))
        quantity = self.safe_number(order, 'quantity')
        filled = self.safe_number(self.safe_dict(order, 'execution'), 'filledQuantity', 0)
        remaining = fn.js_number(Precise.string_sub(self.number_to_string(quantity), self.number_to_string(filled))) if quantity is not None else None
        if remaining is None or not remaining > 0:
            raise OrderNotFound(f'{self.id} editOrder() 정정할 잔량이 있는 주문을 찾지 못했다: {order_id}')
        return {'filled': filled, 'remaining': remaining}

    def _us_edit_notional(self, order_id: str, price: Num) -> float:
        """미국 정정의 명목가. 주문 상세(`GET /orders/{orderId}`)의 남은 수량(주문 수량 − 체결 수량)에 새 가격을 곱한다.
        가격이 없거나 조회가 실패하면 0 이라 표시 없이 정정한다. 표시가 필요한 주문이면 서버가 `confirm-high-value-required` 로 거절한다."""
        if price is None:
            return 0
        try:
            order = self.unwrap(self.private_account_get_orders_orderid({'orderId': order_id}))
            quantity = self.safe_number(order, 'quantity')
            filled = self.safe_number(self.safe_dict(order, 'execution'), 'filledQuantity', 0)
            remaining = quantity - filled if quantity is not None else 0
            return remaining * price if remaining > 0 else 0
        except Exception:
            logger.warning('[toss] 정정 전 주문 조회에 실패해 고액주문 표시 없이 정정한다(%s)', order_id, exc_info=True)
            return 0

    def create_trigger_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None, trigger_price: Num = None,
                             params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """조건주문을 낸다. `create_order(..., {'triggerPrice': ...})` 와 같다. `trigger_price` 가 없으면 요청 없이 `ArgumentsRequired` 다."""
        if trigger_price is None:
            raise ArgumentsRequired(f'{self.id} createTriggerOrder() requires a triggerPrice argument')
        return self.create_order(symbol, type, side, amount, price, self.extend(params, {'triggerPrice': trigger_price}))

    def create_market_buy_order_with_cost(self, symbol: str, cost: float, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """미국 주식 시장가 매수를 금액으로 낸다(`create_order` 의 `params['cost']`). 국내는 금액 주문 API 가 없어 요청 없이 `NotSupported` 다."""
        if self._country_of(self.market(symbol)) != 'US':
            raise NotSupported(f'{self.id} createMarketBuyOrderWithCost() 는 미국 종목만 지원한다: {symbol}')
        return self.create_order(symbol, 'market', 'buy', 0, None, self.extend(params, {'cost': cost}))

    def _assert_no_conditional_params(self, method: str, params: Dict[str, Any]) -> None:
        """ccxt 조건 인자가 있으면 요청 전에 `NotSupported` 다. 본문에 합치거나 버리면 조건 없는 주문이 나간다."""
        for key in UNSUPPORTED_CONDITIONAL_PARAMS:
            if self.safe_value(params, key) is not None:
                raise NotSupported(f'{self.id} {method}() 는 조건 인자 {key} 를 받지 않는다. 조건주문은 params.triggerPrice 나 createTriggerOrder() 로 낸다')

    def _assert_no_computed_params(self, method: str, params: Dict[str, Any], fields: Tuple[str, ...]) -> None:
        """라이브러리가 인자로 채우는 본문 필드가 `params` 에 있으면 요청 전에 `BadRequest` 다. 나머지 키는 본문에 합친다."""
        for key in fields:
            if key in params:
                raise BadRequest(f'{self.id} {method}() 의 params.{key} 는 받지 않는다. 인자로 정하는 필드다')

    def _parse_time_in_force(self, params: Dict[str, Any]) -> Str:
        """`params['timeInForce']` 를 토스의 값(`DAY`·`CLS`·`OPG`)으로 확인한다. 없으면 `None`(서버 기본 `DAY`)."""
        value = self.safe_string_upper(params, 'timeInForce')
        if value is None:
            return None
        if value not in ORDER_TIME_IN_FORCE:
            raise InvalidOrder(f"{self.id} createOrder() timeInForce must be one of {', '.join(ORDER_TIME_IN_FORCE)}")
        return value

    def _check_orderable_session(self, symbol: str, country: str, form: Dict[str, Any], side: Optional[str]) -> Optional[str]:
        """주문 접수 가능 시간과 형태를 검사한다. 막는 사유(한국어)이고, 접수할 수 있으면 `None`.
        캘린더를 받지 못하면 정적 시간표(`is_toss_orderable`)로 판정한다. 그 폴백에서 국내 휴장일은 공용 캘린더가 알 때만 막고(모르면 연다),
        미국 확장세션은 막는다(좁히는 쪽). 정규장의 종가 동시호가 신규 매수는 `options['blockAuctionBuys']` 가 켜졌을 때만 막는다.
        정정은 `side` 를 비워 이 차단을 걸지 않는다."""
        now = _now_ms()

        def auction() -> Optional[str]:
            if side is None or not self.is_option_enabled('blockAuctionBuys'):
                return None
            return krx_auction_buy_block_reason(now, side) if country == 'KR' else us_auction_buy_block_reason(now, side)

        if country == 'KR':
            session = self.current_kr_session(now)
            if session is None:
                return auction() if is_toss_orderable(symbol, now) else 'KRX 거래시간 외 (09:00-15:30 KST 평일, 캘린더 조회 실패)'
            if session == 'closed':
                return 'KRX 휴장·정규장 외'
            if session != 'regularMarket':
                # 확장세션은 옵션 `nxtRouting` 이 켜져 있을 때만 연다.
                if not self.is_option_enabled('nxtRouting'):
                    return f'KRX {session} 세션 — 확장세션 주문은 nxtRouting 옵션이 켜져 있어야 한다'
                return kr_session_order_restriction(session, form)
            return auction()
        session = self.current_us_session(now)
        if session is None:
            return auction() if is_toss_orderable(symbol, now) else '미국 정규장 외 (장 운영 캘린더 조회 실패)'
        if session == 'closed':
            return '미국장 휴장·세션 외'
        regular_close_ms = find_us_regular_close_ms(self._us_calendar_value(), now)
        cutoff = {'nowMs': now, 'regularCloseMs': regular_close_ms} if regular_close_ms is not None else None
        restriction = us_session_order_restriction(session, form, cutoff)
        if restriction is None and session == 'regularMarket':
            restriction = auction()
        if restriction is not None:
            return restriction
        logger.info('[toss] 미국 세션을 확인했다. 주문을 접수할 수 있다(%s %s)', symbol, session)
        return None

    def _extended_session_limit(self, symbol: str, side: str) -> Dict[str, Any]:
        """확장세션 지정가. 같은 방향 미체결이 있거나 기준가(최종가)를 구하지 못하면 `{'error': 사유}` 다."""
        def on_warn(err: BaseException, message: str) -> None:
            logger.warning('%s (%s): %s', message, symbol, err)
        return build_extended_session_limit(self, {'symbol': symbol, 'side': side}, '[toss]', on_warn)

    def _kr_extended_session_conversion(self, symbol: str, side: str) -> Optional[Dict[str, Any]]:
        """국내 확장세션(프리·애프터) 전환 판정. 전환 대상이 아니면 `None`(정규장·휴장·옵션 꺼짐)."""
        if not self.is_option_enabled('nxtRouting'):
            return None
        session = self.current_kr_session()
        if session not in ('preMarket', 'afterMarket'):
            return None
        return self.extend({'session': session}, self._extended_session_limit(symbol, side))

    def _us_extended_session_conversion(self, symbol: str, side: str, quantity: float) -> Optional[Dict[str, Any]]:
        """미국 확장세션(주간거래·프리·애프터) 전환 판정. 소수점 수량은 정규장 전용이라 전환하지 않고 세션 검사가 막게 둔다."""
        if not self.is_option_enabled('usExtendedLimit'):
            return None
        session = self.current_us_session()
        if session not in ('dayMarket', 'preMarket', 'afterMarket'):
            return None
        if not _is_integer(quantity):
            logger.warning('[toss] 미국 확장세션의 소수점 수량은 정규장 전용이라 지정가로 바꿀 수 없다(%s %s %s %s)', symbol, side, session, quantity)
            return None
        return self.extend({'session': session}, self._extended_session_limit(symbol, side))

    def _confirm_order_execution(self, order_id: str, country: str) -> Tuple[Optional[Dict[str, Any]], Any]:
        """접수한 주문의 체결을 확정한다. 주문 상세를 예산 안에서 조회하고, 마지막으로 본 주문 원본도 함께 돌려준다."""
        last: Dict[str, Any] = {'raw': None}

        def probe(attempt: int) -> Dict[str, Any]:
            raw = self.unwrap(self.private_account_get_orders_orderid({'orderId': order_id}))
            last['raw'] = raw
            status = self.safe_value(raw, 'status')
            return {
                'snapshot': to_execution_snapshot(raw, country),
                'terminal': isinstance(status, str) and status in TERMINAL_ORDER_STATUSES,
            }

        snapshot = confirm_execution('[toss]', order_id, 'toss', probe, budget=self.get_confirm_budget())
        return snapshot, last['raw']

    def _build_created_order(self, draft: Dict[str, Any], status: Str, still_open: Optional[bool] = None,
                             snapshot: Optional[Dict[str, Any]] = None, raw: Any = None) -> Dict[str, Any]:
        """접수 결과로 주문 구조를 만든다. 체결을 확정하지 못했으면 `filled` 를 비운다(요청값으로 추정해 채우지 않는다)."""
        timestamp = self.parse8601(self.safe_value(raw, 'orderedAt'))
        if timestamp is None:
            timestamp = self.milliseconds()
        fee = None
        if snapshot is not None and snapshot.get('fee') is not None:
            fee = {'currency': snapshot['feeCurrency'], 'cost': snapshot['fee']}
        response = draft['response']
        info = self.extend(response if isinstance(response, dict) else {}, {
            'execution': snapshot,
            'order': raw,
            'extendedSession': draft['extendedSession'],
            'stillOpen': still_open,
        })
        return self.safe_order({
            'info': info,
            'id': draft['orderId'],
            'clientOrderId': draft['clientOrderId'],
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'lastTradeTimestamp': self.parse8601(self.safe_value(self.safe_value(raw, 'execution'), 'filledAt')),
            'symbol': draft['market']['symbol'],
            'type': draft['type'],
            'timeInForce': draft['timeInForce'],
            'side': draft['side'],
            'price': draft['price'] if draft['type'] == 'limit' else None,
            'amount': None if draft['useAmountBased'] else draft['quantity'],
            'filled': snapshot['filled'] if snapshot is not None else None,
            'average': snapshot['average'] if snapshot is not None else None,
            'cost': snapshot['amount'] if snapshot is not None else None,
            'status': status,
            'fee': fee,
            'trades': [],
        }, draft['market'])

    # ============ 조건주문 ============

    def _plan_conditional_order(self, type: str, side: str, price: Num, params: Dict[str, Any]) -> Dict[str, Any]:
        """조건주문 인자를 검사하고 등록할 모양으로 정리한다. 요청은 보내지 않는다. 브로커가 거절할 조합은 `OrderNotSent` 로 막는다.

        `SINGLE` 은 트리거 하나(`type: 'market'` 이면 시장가, `'limit'` 이면 `price` 가 트리거 뒤의 지정가), `OCO` 는 양쪽 매도 지정가
        브래킷(하나가 체결되면 반대편이 취소된다), `OTO` 는 첫 조건이 체결된 뒤 둘째 조건을 감시하는 지정가다.
        """
        conditional_type = self.safe_string_upper(params, 'conditionalType')
        if conditional_type is None:
            conditional_type = 'SINGLE'
        if conditional_type not in ('SINGLE', 'OCO', 'OTO'):
            raise InvalidOrder(f'{self.id} createOrder() conditionalType must be SINGLE, OCO or OTO')
        order_type = 'MARKET' if type == 'market' else 'LIMIT'
        expire_date = self.safe_string(params, 'expireDate')
        if expire_date is None:
            raise ArgumentsRequired(f'{self.id} 조건주문에는 expireDate(YYYY-MM-DD)가 필요하다')
        first = {'side': side, 'triggerPrice': self._conditional_trigger_price(params, 'triggerPrice'), 'orderPrice': price}
        second_params = self.safe_dict(params, 'second')
        second = None
        if second_params is not None:
            second_side = self.safe_string_lower(second_params, 'side')
            if second_side is None:
                second_side = ('sell' if side == 'buy' else 'buy') if conditional_type == 'OTO' else side
            second = {
                'side': second_side,
                'triggerPrice': self._conditional_trigger_price(second_params, 'second.triggerPrice'),
                'orderPrice': self.safe_number(second_params, 'price'),
            }
        if conditional_type in ('OCO', 'OTO') and second is None:
            raise OrderNotSent(f'{self.id} {conditional_type} 조건주문은 second leg 필수')
        if conditional_type == 'OCO' and (first['side'] != 'sell' or second is None or second['side'] != 'sell'):
            raise OrderNotSent(f'{self.id} OCO 는 양쪽 SELL(익절/손절 브래킷)만 지원')
        if order_type == 'MARKET' and conditional_type != 'SINGLE':
            raise OrderNotSent(f'{self.id} MARKET 조건주문은 SINGLE 만 지원(브래킷은 LIMIT)')
        if order_type == 'LIMIT' and (first['orderPrice'] is None or (second is not None and second['orderPrice'] is None)):
            raise OrderNotSent(f'{self.id} LIMIT 조건주문은 각 leg 의 orderPrice 필수')
        return {
            'conditionalType': conditional_type, 'orderType': order_type, 'expireDate': expire_date,
            'first': first, 'second': second, 'clientOrderId': self.safe_string(params, 'clientOrderId'),
        }

    def _conditional_trigger_price(self, source: Dict[str, Any], label: str) -> float:
        """조건의 트리거 가격. 없거나 숫자가 아니면 `ArgumentsRequired`, 0 이하면 `InvalidOrder` 다. 빠진 채로 보내면 트리거 없는 조건이 나간다."""
        value = self.safe_number(source, 'triggerPrice')
        if value is None:
            raise ArgumentsRequired(f"{self.id} 조건주문의 {label} 가 없거나 숫자가 아니다: {self.safe_string(source, 'triggerPrice')}")
        if not _is_finite_number(value) or not value > 0:
            raise InvalidOrder(f'{self.id} 조건주문의 {label} 는 0 보다 커야 한다: {value}')
        return value

    def _conditional_leg(self, leg: Dict[str, Any], order_type: str) -> Dict[str, Any]:
        """조건주문 요청의 leg. `orderPrice` 는 지정가일 때만 보낸다."""
        result = {'orderSide': 'SELL' if leg['side'] == 'sell' else 'BUY', 'triggerPrice': self.number_to_string(leg['triggerPrice'])}
        if order_type == 'LIMIT' and leg['orderPrice'] is not None:
            result['orderPrice'] = self.number_to_string(leg['orderPrice'])
        return result

    def _conditional_notional(self, amount: Any, first: Dict[str, Any]) -> float:
        """고액주문 확인에 쓰는 첫 조건의 명목가(지정가는 주문가, 시장가는 트리거 가격 기준)."""
        unit = first['orderPrice'] if first['orderPrice'] is not None else first['triggerPrice']
        return amount * unit if _is_finite_number(amount) and _is_finite_number(unit) else math.nan

    def _conditional_order_fields(self, market: Dict[str, Any], amount: float, plan: Dict[str, Any]) -> Dict[str, Any]:
        """조건주문 등록과 정정이 같이 보내는 필드(수량, 호가유형, 만료일, 감시조건, 고액주문 확인)."""
        order_type = plan['orderType']
        fields: Dict[str, Any] = {
            'type': plan['conditionalType'],
            'quantity': self.number_to_string(amount),
            'orderType': order_type,
            'expireDate': plan['expireDate'],
            'first': self._conditional_leg(plan['first'], order_type),
        }
        if plan['second'] is not None:
            fields['second'] = self._conditional_leg(plan['second'], order_type)
        if self._is_high_value(self._conditional_notional(amount, plan['first']), self._country_of(market)):
            fields['confirmHighValueOrder'] = True
        return fields

    def _create_conditional_order(self, market: Dict[str, Any], type: str, side: str, amount: float, price: Num,
                                  params: Dict[str, Any]) -> Dict[str, Any]:
        """조건주문을 등록한다(`create_order` 가 `params['triggerPrice']` 를 보고 부른다)."""
        plan = self._plan_conditional_order(type, side, price, params)
        order_type = plan['orderType']
        first = plan['first']
        body: Dict[str, Any] = self.extend({'symbol': market['id']}, self._conditional_order_fields(market, amount, plan))
        if plan['clientOrderId'] is not None:
            body['clientOrderId'] = plan['clientOrderId']

        response = self.unwrap(self.private_account_post_conditional_orders(body))
        conditional_order_id = self.safe_string(response, 'conditionalOrderId')
        if conditional_order_id is None:
            raise OrderOutcomeUnknown(f'{self.id} 조건주문 접수 응답에 conditionalOrderId 가 없다. 등록 여부를 조회로 확인해야 한다')
        logger.info('[toss] 조건주문을 등록했다(%s %s %s)', conditional_order_id, market['symbol'], plan['conditionalType'])
        timestamp = self.milliseconds()
        return self.safe_order({
            'info': self.extend(response if isinstance(response, dict) else {}, {'type': plan['conditionalType']}),
            'id': conditional_order_id,
            'clientOrderId': plan['clientOrderId'],
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'symbol': market['symbol'],
            'type': type,
            'side': side,
            'price': first['orderPrice'] if order_type == 'LIMIT' else None,
            'amount': amount,
            'filled': 0,
            'triggerPrice': first['triggerPrice'],
            'status': 'open',
            'trades': [],
        }, market)

    def _modify_conditional_order(self, id: str, market: Dict[str, Any], type: str, side: str, amount: float, price: Num,
                                  params: Dict[str, Any]) -> Dict[str, Any]:
        """조건주문을 정정한다(`edit_order` 가 `params['trigger']` 로 부른다). 등록과 같은 필드 전체를 다시 보낸다.
        정정하면 새 조건주문 번호가 나오고 옛 번호는 무효가 된다."""
        plan = self._plan_conditional_order(type, side, price, params)
        order_type = plan['orderType']
        first = plan['first']
        body: Dict[str, Any] = self.extend({'conditionalOrderId': id}, self._conditional_order_fields(market, amount, plan))

        response = self.unwrap(self.private_account_post_conditional_orders_conditionalorderid_modify(body))
        new_id = self.safe_string(response, 'conditionalOrderId')
        if new_id is None:
            raise OrderOutcomeUnknown(f'{self.id} 조건주문 정정 응답에 conditionalOrderId 가 없다. 정정 여부를 조회로 확인해야 한다')
        logger.info('[toss] 조건주문을 정정해 새 번호가 나왔다(%s → %s, %s %s)', id, new_id, market['symbol'], plan['conditionalType'])
        timestamp = self.milliseconds()
        return self.safe_order({
            'info': self.extend(response if isinstance(response, dict) else {}, {'type': plan['conditionalType']}),
            'id': new_id,
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'symbol': market['symbol'],
            'type': type,
            'side': side,
            'price': first['orderPrice'] if order_type == 'LIMIT' else None,
            'amount': amount,
            'triggerPrice': first['triggerPrice'],
            'status': 'open',
            'trades': [],
        }, market)

    def _hydrate_conditional_legs(self, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """조건(leg)이 통째로 없는 조건주문만 상세로 채운다. 보강은 부가 정보라 실패해도 목록 값으로 진행한다
        (던지면 조건주문이 목록에서 사라지는데, 스톱이 안 보이는 것이 방향이 틀리게 보이는 것보다 위험하다)."""
        needs_detail = [row for row in rows if row.get('first') is None]
        if not needs_detail:
            return rows
        try:
            targets = needs_detail[:MAX_CONDITIONAL_DETAIL_FETCH]
            if len(needs_detail) > len(targets):
                logger.warning('[toss] 조건주문 상세 조회 상한을 넘어 나머지는 목록 값을 쓴다(%d 중 %d)', len(needs_detail), len(targets))
            detailed: Dict[Any, Dict[str, Any]] = {}
            for row in targets:
                conditional_order_id = row.get('conditionalOrderId')
                try:
                    detail = self.unwrap(self.private_account_get_conditional_orders_conditionalorderid({'conditionalOrderId': conditional_order_id}))
                    if isinstance(detail, dict) and detail.get('first') is not None:
                        detailed[conditional_order_id] = detail
                except Exception:
                    logger.debug('[toss] 조건주문 상세 조회에 실패해 목록 값을 유지한다(%s)', conditional_order_id, exc_info=True)
            if len(detailed) < len(targets):
                sample = next((row for row in targets if row.get('conditionalOrderId') not in detailed), None)
                logger.warning('[toss] 조건주문의 조건을 확인하지 못했다. 방향과 트리거 가격 표시가 부정확할 수 있다(%d건, 키 %s)',
                               len(targets) - len(detailed), list(sample.keys()) if sample is not None else [])
            return [detailed.get(row.get('conditionalOrderId'), row) for row in rows]
        except Exception:
            logger.warning('[toss] 조건주문 상세 보강에 실패해 목록 값으로 진행한다', exc_info=True)
            return rows

    @staticmethod
    def _parse_conditional_status(status: Str) -> str:
        """조건주문 상태를 통합 상태로 옮긴다. 감시·대기 중은 `open`, 발동해 끝났으면 `closed`, 만료는 `expired` 다."""
        if status == 'COMPLETED':
            return 'closed'
        if status == 'EXPIRED':
            return 'expired'
        return 'open'

    def _parse_conditional_order(self, conditional: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """조건주문 조회 응답을 주문 구조로 옮긴다. 첫 조건(leg)이 대표이고 `triggerPrice` 에 트리거 가격이 실린다.
        방향은 응답에 실려 오면 그 값을, 없으면 종류로 유추한 값을 쓴다. 종류는 `info['type']` 이다."""
        market = self.safe_market(self.safe_string(conditional, 'symbol'), market)
        leg = conditional.get('first') or {}
        timestamp = self.parse8601(self.safe_value(conditional, 'createdAt'))
        if timestamp is None:
            timestamp = self.milliseconds()
        quantity = self.safe_number(conditional, 'quantity')
        order_type = self.safe_string_lower(conditional, 'orderType')
        return self.safe_order({
            'info': conditional,
            'id': conditional.get('conditionalOrderId'),
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'symbol': market['symbol'],
            'type': order_type if order_type is not None else 'limit',
            'side': conditional_side(conditional),
            'price': self.safe_number(leg, 'orderPrice'),
            'amount': quantity,
            'filled': 0,
            'remaining': quantity,
            'cost': 0,
            'triggerPrice': self.safe_number(leg, 'triggerPrice'),
            'status': self._parse_conditional_status(conditional.get('status')),
            'trades': [],
        }, market)

    # ============ 주문 조회와 취소 ============

    def parse_order_status(self, status: Str) -> Str:
        """주문의 세부 상태를 통합 상태로 옮긴다. 모르는 값은 원문 그대로 둔다."""
        statuses = {
            'PENDING': 'open',
            'PENDING_CANCEL': 'open',
            'PENDING_REPLACE': 'open',
            'PARTIAL_FILLED': 'open',
            'FILLED': 'closed',
            'CANCELED': 'canceled',
            'REPLACED': 'canceled',
            'REJECTED': 'rejected',
            # 명세: 거절된 취소·정정 요청을 기록한 별도 레코드의 상태다. 원주문은 이전 상태로 돌아가 제 상태로 따로 조회된다.
            'CANCEL_REJECTED': 'rejected',
            'REPLACE_REJECTED': 'rejected',
        }
        return self.safe_string(statuses, status, status)

    def parse_order(self, order: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """`GET /orders` 의 주문 하나를 주문 구조로 옮긴다. 체결 결과(`execution`)와 수수료·세금도 싣는다."""
        market = self.safe_market(self.safe_string(order, 'symbol'), market)
        execution = self.safe_dict(order, 'execution', {})
        timestamp = self.parse8601(self.safe_string(order, 'orderedAt'))
        commission = self.safe_string(execution, 'commission')
        tax = self.safe_string(execution, 'tax')
        fee_cost = None
        if commission is not None or tax is not None:
            fee_cost = Precise.string_add(commission if commission is not None else '0', tax if tax is not None else '0')
        filled = self.safe_string(execution, 'filledQuantity')
        return self.safe_order({
            'info': order,
            'id': self.safe_string(order, 'orderId'),
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'lastTradeTimestamp': self.parse8601(self.safe_string(execution, 'filledAt')),
            'symbol': market['symbol'],
            'type': self.safe_string_lower(order, 'orderType'),
            'timeInForce': self.safe_string(order, 'timeInForce'),
            'side': self.safe_string_lower(order, 'side'),
            'price': self.safe_string(order, 'price'),
            'amount': self.safe_string(order, 'quantity'),
            'filled': filled if filled is not None else '0',
            'average': self.safe_string(execution, 'averageFilledPrice'),
            'cost': self.safe_string(execution, 'filledAmount'),
            'status': self.parse_order_status(self.safe_string(order, 'status')),
            'fee': {'currency': self.safe_string(order, 'currency', market['quote']), 'cost': self.parse_number(fee_cost)} if fee_cost is not None else None,
            'trades': [],
        }, market)

    def fetch_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """주문 하나. `params['trigger']` 가 `True` 면 조건주문이다."""
        trigger = self.safe_bool_2(params, 'trigger', 'stop', False) is True
        market = self.market(symbol) if symbol is not None else None
        if trigger:
            detail = self.unwrap(self.private_account_get_conditional_orders_conditionalorderid({'conditionalOrderId': id}))
            return self._parse_conditional_order(detail, market)
        response = self.private_account_get_orders_orderid({'orderId': id})
        return self.parse_order(self.unwrap(response), market)

    def fetch_open_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                          params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """미체결 주문. `symbol` 을 주면 그 종목만 받는다. 조건주문은 별도 장부라서 `params['trigger']` 는 조건주문만,
        `params['includeTrigger']` 는 일반 주문에 조건주문을 합쳐 돌려준다. 조회에 실패하면 던진다("스톱이 없다"로 읽히는 빈 목록으로 바꾸지 않는다)."""
        params = {} if params is None else params
        trigger_only = self.safe_bool_2(params, 'trigger', 'stop', False) is True
        include_trigger = self.safe_bool(params, 'includeTrigger', False) is True
        query = self.omit(params, ['trigger', 'stop', 'includeTrigger'])
        market = self.market(symbol) if symbol is not None else None
        orders: List[Dict[str, Any]] = []
        if not trigger_only:
            request: Dict[str, Any] = {'status': 'OPEN'}
            if market is not None:
                request['symbol'] = market['id']
            response = self.unwrap(self.private_account_get_orders(self.extend(request, query)))
            orders = self.parse_orders(self.safe_value(response, 'orders'), market)
        if trigger_only or include_trigger:
            rows = self._fetch_open_conditional_rows(market)
            if market is not None:
                rows = [row for row in rows if row.get('symbol') == market['id']]
            rows = self._hydrate_conditional_legs(rows)
            orders = orders + [self._parse_conditional_order(row, market) for row in rows]
        return self.filter_by_symbol_since_limit(self.sort_by(orders, 'timestamp'), market['symbol'] if market is not None else None, since, limit)

    def _fetch_open_conditional_rows(self, market: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """미체결 조건주문 원본을 커서로 끝까지 이어 받는다(공식 기본이 20건이라 커서 없이는 잘린다). 쪽 수 상한을 넘기면 로그를 남기고 자른다.
        조회가 실패하면 던진다. 앞쪽만 돌려주면 뒤쪽의 스톱이 없는 것으로 읽힌다."""
        request: Dict[str, Any] = {'status': 'OPEN', 'limit': CONDITIONAL_ORDER_PAGE_LIMIT}
        if market is not None:
            request['symbol'] = market['id']
        max_pages = self.safe_integer(self.options, 'conditionalOrdersMaxPages', MAX_CONDITIONAL_ORDER_PAGES)
        collected: List[Dict[str, Any]] = []
        seen: Set[str] = set()
        requested: Set[str] = set()
        cursor = None
        for _ in range(max_pages):
            response = self.unwrap(self.private_account_get_conditional_orders(self.extend(request, {'cursor': cursor})))
            collected.extend(_unseen_rows(self.safe_list(response, 'conditionalOrders', []) or [], 'conditionalOrderId', seen))
            if not self.safe_value(response, 'hasNext') or not self.safe_value(response, 'nextCursor'):
                return collected
            if response['nextCursor'] in requested:
                logger.warning('[toss] 미체결 조건주문의 다음 커서가 이미 요청한 커서다. 같은 쪽을 되풀이하지 않고 멈춘다(%d건)', len(collected))
                return collected
            cursor = response['nextCursor']
            requested.add(cursor)
        logger.warning('[toss] 미체결 조건주문이 페이지 상한을 넘어 나머지는 자른다(%d건, %d쪽)', len(collected), max_pages)
        return collected

    def fetch_closed_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                            params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """전량 체결된 주문(`status: 'closed'`). 토스의 종료된 주문(`CLOSED`)에 섞인 취소, 거부, 정정 대체 주문은 거른다. 취소된 주문은
        `fetch_canceled_orders` 로 받는다. `params['until']`(ms)은 그 시각까지의 주문만 받는다. 100건씩 최대 10쪽까지 받는다."""
        return self._fetch_ended_orders('closed', symbol, since, limit, params)

    def fetch_canceled_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                              params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """취소된 주문(정정으로 대체된 원주문 포함). `fetch_closed_orders` 와 같은 조회에서 `status: 'canceled'` 만 거른다."""
        return self._fetch_ended_orders('canceled', symbol, since, limit, params)

    def _fetch_ended_orders(self, status: str, symbol: Str, since: Int, limit: Int,
                            params: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
        market = self.market(symbol) if symbol is not None else None
        params = {} if params is None else params
        until = self.safe_integer(params, 'until')

        # 서버는 `until` 을 한국 날짜로만 받으므로, 같은 날 `until` 뒤에 낸 주문은 여기서 뺀다.
        def keep(row: Dict[str, Any]) -> bool:
            if self.parse_order_status(self.safe_string(row, 'status')) != status:
                return False
            ordered_at = self.parse8601(self.safe_string(row, 'orderedAt'))
            return until is None or (ordered_at is not None and ordered_at <= until)

        rows = self._fetch_closed_order_rows(market, since, limit, params, keep)
        return self.parse_orders(rows, market, since, limit)

    def _fetch_closed_order_rows(self, market: Optional[Dict[str, Any]], since: Int, limit: Int,
                                 params: Dict[str, Any], keep: Callable[[Dict[str, Any]], bool]) -> List[Dict[str, Any]]:
        """종료된 주문 원본을 커서로 이어 받고 `keep` 에 맞는 행만 남긴다. 개수만 정한 조회는 남긴 행이 `limit` 에 이르면 멈춘다."""
        request: Dict[str, Any] = {'status': 'CLOSED', 'limit': CLOSED_ORDER_PAGE_LIMIT}
        if market is not None:
            request['symbol'] = market['id']
        # 날짜 조건은 주문한 날짜 기준이다. 자정을 넘겨 체결되는 주문이 빠지지 않게 하루를 더 앞에서 받고, 정확한 시각은 뒤에서 거른다.
        if since is not None:
            request['from'] = kst_date(since - DAY_MS)
        until = self.safe_integer(params, 'until')
        if until is not None:
            request['to'] = kst_date(until)
        query = self.omit(params, 'until')
        max_pages = self.safe_integer(self.options, 'closedOrdersMaxPages', MAX_CLOSED_ORDER_PAGES)
        collected: List[Dict[str, Any]] = []
        seen: Set[str] = set()
        requested: Set[str] = set()
        cursor = None
        for _ in range(max_pages):
            response = self.unwrap(self.private_account_get_orders(self.extend(request, {'cursor': cursor}, query)))
            collected.extend(row for row in _unseen_rows(self.safe_list(response, 'orders', []) or [], 'orderId', seen) if keep(row))
            if not self.safe_value(response, 'hasNext') or not self.safe_value(response, 'nextCursor'):
                return collected
            # 시각 조건 없이 개수만 정했다면(가장 최근 `limit` 건) 그만큼 모았을 때 멈춘다.
            if since is None and limit is not None and len(collected) >= limit:
                return collected
            if response['nextCursor'] in requested:
                logger.warning('[toss] 종료된 주문의 다음 커서가 이미 요청한 커서다. 같은 쪽을 되풀이하지 않고 멈춘다(%d건)', len(collected))
                return collected
            cursor = response['nextCursor']
            requested.add(cursor)
        logger.warning('[toss] 체결 완료 주문이 페이지 상한을 넘어 오래된 주문은 자른다(%d건)', len(collected))
        return collected

    def fetch_my_trades(self, symbol: Str = None, since: Int = None, limit: Int = None,
                        params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """체결 내역. 토스에는 체결 단위 조회가 없어 체결이 있는 주문 하나를 거래 하나로 본다. 종료된 주문과 함께 일부 체결된 채 걸려 있는
        미체결 주문도 넣는다. 거래 id 는 주문번호이고 수량은 누적 체결 수량이라, 체결이 늘면 같은 id 의 거래가 더 큰 수량으로 다시 나온다.
        거래를 쌓는 쪽은 id 로 덮어써야 한다. 가격은 평균 체결가, 수수료는 브로커가 확정한 `execution.commission` 과 `execution.tax` 의 합이다."""
        market = self.market(symbol) if symbol is not None else None

        def filled(row: Dict[str, Any]) -> bool:
            return (fn.js_number(self.safe_value(self.safe_value(row, 'execution'), 'filledQuantity')) > 0
                    and (market is None or row.get('symbol') == market['id']))

        ended = self._fetch_closed_order_rows(market, since, None, {} if params is None else params, filled)
        open_request: Dict[str, Any] = {'status': 'OPEN'}
        if market is not None:
            open_request['symbol'] = market['id']
        open_rows = [row for row in (self.safe_list(self.unwrap(self.private_account_get_orders(open_request)), 'orders', []) or [])
                     if filled(row)]
        until = self.safe_integer(params, 'until')
        trades = self.parse_trades(ended + open_rows, market, since)
        if until is not None:
            trades = [trade for trade in trades if trade['timestamp'] <= until]
        return self.filter_by_since_limit(trades, since, limit)

    def fetch_trades(self, symbol: str, since: Int = None, limit: Int = None,
                     params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """당일 최근 체결 내역(`GET /trades`, 최대 50건, 기본 50건). 체결가와 체결수량, 체결시각만 오고 방향(매수·매도)과 체결 id 는 없다.
        자기 주문의 체결(`fetch_my_trades`)과 행 모양이 달라 따로 옮긴다."""
        market = self.market(symbol)
        request: Dict[str, Any] = {'symbol': market['id']}
        if limit is not None:
            request['count'] = min(max(1, limit), 50)
        response = self.unwrap(self.private_market_get_trades(self.extend(request, params)))
        trades = [self._parse_public_trade(row, market) for row in fn.to_array(response)]
        return trades if since is None else [trade for trade in trades if (trade['timestamp'] or 0) >= since]

    def _parse_public_trade(self, trade: Dict[str, Any], market: Dict[str, Any]) -> Dict[str, Any]:
        timestamp = self.parse8601(self.safe_string(trade, 'timestamp'))
        return self.safe_trade({
            'info': trade, 'id': None, 'order': None, 'timestamp': timestamp, 'datetime': self.iso8601(timestamp), 'symbol': market['symbol'],
            'type': None, 'side': None, 'takerOrMaker': None, 'price': self.safe_string(trade, 'price'), 'amount': self.safe_string(trade, 'volume'),
            'cost': None, 'fee': None,
        }, market)

    def parse_trade(self, trade: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """체결된 주문 하나를 거래 하나로 옮긴다. 체결 시각은 최종 체결 시각(없으면 주문 시각)이다."""
        market = self.safe_market(self.safe_string(trade, 'symbol'), market)
        execution = self.safe_dict(trade, 'execution', {})
        timestamp = self.parse8601(self.safe_string(execution, 'filledAt'))
        if timestamp is None:
            timestamp = self.parse8601(self.safe_string(trade, 'orderedAt'))
        if timestamp is None:
            timestamp = self.milliseconds()
        commission = self.safe_string(execution, 'commission')
        tax = self.safe_string(execution, 'tax')
        fee_cost = None
        if commission is not None or tax is not None:
            fee_cost = Precise.string_add(commission if commission is not None else '0', tax if tax is not None else '0')
        order_id = self.safe_string(trade, 'orderId')
        price = self.safe_string_2(execution, 'averageFilledPrice', 'price')
        return self.safe_trade({
            'info': trade,
            'id': order_id,
            'order': order_id,
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'symbol': market['symbol'],
            'type': self.safe_string_lower(trade, 'orderType'),
            'side': self.safe_string_lower(trade, 'side'),
            'takerOrMaker': None,
            'price': price if price is not None else self.safe_string(trade, 'price'),
            'amount': self.safe_string(execution, 'filledQuantity'),
            'cost': self.safe_string(execution, 'filledAmount'),
            'fee': {'currency': self.safe_string(trade, 'currency', market['quote']), 'cost': fee_cost} if fee_cost is not None else None,
        }, market)

    def cancel_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """주문을 취소한다. `params['trigger']` 가 `True` 면 조건주문 취소다. 이미 체결·취소된 주문이면 `OrderNotFound` 다.
        응답 원본은 `info` 에 있고, 취소 응답 본문이 비어 있어도 성공이다.

        일반 주문은 취소를 접수한 뒤 원주문의 상세를 `create_order` 의 체결 확인과 같은 옵션(`confirmExecution`·`confirmBudget`)으로 조회한다.
        원주문이 `CANCELED`·`FILLED`·`REJECTED` 로 끝나면 그 상태(`canceled`·`closed`·`rejected`)를 돌려주고, 확정하지 못하면 `status` 를 비운다.
        취소가 거절되면 원주문이 이전 상태로 돌아가 아직 반영되지 않은 것과 구별할 수 없으므로 이때도 비운다. 조회한 원본은 `info['order']` 에 있다.
        조건주문은 명세상 취소 응답(204)이 곧 취소 완료라 조회하지 않고 `canceled` 다."""
        trigger = self.safe_bool_2(params, 'trigger', 'stop', False) is True
        market = self.market(symbol) if symbol is not None else None
        if trigger:
            response = self.private_account_delete_conditional_orders_conditionalorderid({'conditionalOrderId': id})
            logger.info('[toss] 조건주문을 취소했다(%s %s)', id, symbol)
            info = self.unwrap(response)
            return self.safe_order({'info': info if info is not None else {}, 'id': id, 'symbol': market['symbol'] if market is not None else None,
                                    'status': 'canceled', 'trades': []}, market)
        response = self.unwrap(self.private_account_post_orders_orderid_cancel({'orderId': id}))
        response = response if isinstance(response, dict) else {}
        logger.info('[toss] 주문 취소를 접수했다(%s %s, 취소 주문번호 %s)', id, symbol, response.get('orderId'))
        confirm = self.safe_bool(params, 'confirmExecution', self.options.get('confirmExecution') is not False) is not False
        order = self._confirm_cancel(id) if confirm else None
        raw_status = self.safe_string(order, 'status')
        status = self.parse_order_status(raw_status) if raw_status in CANCEL_SETTLED_STATUSES else None
        if confirm and status is None:
            logger.warning('[toss] 취소가 확정되지 않아 status 를 비운다(%s, 원주문 상태 %s)', id, raw_status)
        return self.safe_order({
            'info': self.extend(response, {'order': order}),
            'id': id,
            'symbol': market['symbol'] if market is not None else None,
            'status': status,
            'trades': [],
        }, market)

    def _confirm_cancel(self, order_id: str) -> Any:
        """취소를 접수한 원주문을 예산 안에서 조회해 마지막으로 읽은 원본을 돌려준다. 종료 상태면 멈추고, 조회가 실패하면 다음 시도로 넘어간다."""
        budget = self.get_confirm_budget()
        attempts, interval_ms = budget['attempts'], budget['intervalMs']
        last: Any = None
        for attempt in range(1, attempts + 1):
            if attempt > 1 and interval_ms > 0:
                self.sleep(interval_ms)
            try:
                last = self.unwrap(self.private_account_get_orders_orderid({'orderId': order_id}))
            except Exception:
                logger.warning('[toss] 취소 확인 조회에 실패해 다시 조회한다(주문 %s, %d/%d)', order_id, attempt, attempts, exc_info=True)
                continue
            if self.safe_string(last, 'status') in TERMINAL_ORDER_STATUSES:
                break
        return last

    def cancel_all_orders(self, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """미체결 주문을 모두 취소한다(토스에는 전체 취소가 없어 조회한 주문을 하나씩 취소한다). `params['includeTrigger']` 면 조건주문도 취소한다.
        돌려주는 목록은 대상 주문 전부이고, 항목은 미체결 조회로 받은 주문이다. 취소를 접수한 것은 `cancel_order` 가 돌려준 상태이고(확정하지 못하면
        비어 있다) 그 `info`(취소 응답 원문과 조회한 원주문 `order`)가 `info['cancelResponse']` 에 있다. 확정 조회를 주문마다 하므로 미확정 주문이 많으면
        조회가 는다. 취소하지 못한 것은 원래 상태에 `info['cancelError']`(메시지)와 `info['cancelErrorDetail']`(오류의 `detail`)이
        실린다. 일부가 실패해도 던지지 않는다. 취소하려는 사이에 끝난 주문은 원인 코드(`info['cancelErrorDetail']`)대로 옮긴다(`already-filled` 는 `closed`, `already-canceled` 는
        `canceled`, `already-rejected` 는 `rejected`). 정정으로 대체된 주문과 원인을 모르는 경우는 새 주문이 살아 있을 수 있어 원래 상태로 둔다."""
        include_trigger = self.safe_bool(params, 'includeTrigger', False) is True
        orders = self.fetch_open_orders(symbol, None, None, {'includeTrigger': True} if include_trigger else {})
        results = []
        for order in orders:
            trigger = self.safe_string(order.get('info'), 'conditionalOrderId') is not None
            try:
                canceled = self.cancel_order(order['id'], order.get('symbol'), {'trigger': trigger})
                results.append(self.extend(order, {'status': canceled.get('status'), 'info': self.extend(order.get('info'), {'cancelResponse': canceled.get('info')})}))
            except OrderNotFound as error:
                detail = getattr(error, 'detail', None)
                info = self.extend(order.get('info'), {'alreadyGone': True, 'cancelError': str(error), 'cancelErrorDetail': detail})
                if detail == 'already-filled':
                    results.append(self.extend(order, {'status': 'closed', 'filled': order.get('amount'), 'remaining': 0, 'cost': None,
                                                       'average': None, 'info': info}))
                elif detail == 'already-canceled':
                    results.append(self.extend(order, {'status': 'canceled', 'info': info}))
                elif detail == 'already-rejected':
                    results.append(self.extend(order, {'status': 'rejected', 'info': info}))
                else:
                    results.append(self.extend(order, {'info': info}))
            except Exception as error:
                info = self.extend(order.get('info'), {'cancelError': str(error), 'cancelErrorDetail': getattr(error, 'detail', None)})
                results.append(self.extend(order, {'info': info}))
        logger.info('[toss] 미체결 주문을 취소했다(%d건 중 %d건)', len(orders), sum(1 for order in results if order.get('status') == 'canceled'))
        return results
