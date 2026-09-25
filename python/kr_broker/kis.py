# 이 파일은 scripts/gen-python-sync.mjs 가 python/kr_broker/async_support/kis.py 에서 만든다. 직접 고치지 않는다.
"""한국투자증권 Open API(`class kis(Exchange, ImplicitAPI)`). TypeScript 판 `ts/src/kis.ts` 를 옮겼다. 국내와 미국 주식 현물의 시세와 종목,
잔고, 주문, 주문과 체결 조회, 휴장일 캘린더와 순위 같은 고유 조회를 ccxt 와 같은 모양으로 다룬다. 실시간(`watch_*`)은 이 클래스를 상속한
`kr_broker.pro.kis` 에 있다. 통합 메서드가 부르지 않는 고유 메서드(채권, 선물옵션 등)는 옮기지 않았다.

.. code-block:: python

    import kr_broker
    broker = kr_broker.kis({'apiKey': APP_KEY, 'secret': APP_SECRET, 'uid': '12345678-01'})
    ticker = broker.fetch_ticker('005930/KRW')
    order = broker.create_order('005930/KRW', 'limit', 'buy', 1, 70000)
    price = broker.private_get_uapi_domestic_stock_v1_quotations_inquire_price({
        'tr_id': 'FHKST01010100', 'FID_COND_MRKT_DIV_CODE': 'J', 'FID_INPUT_ISCD': '005930',
    })

자격증명
    `apiKey` 는 앱키, `secret` 은 앱시크릿, `uid` 는 계좌번호(`8자리-2자리`, 뒤 2자리를 생략하면 `01`)다. `set_sandbox_mode(True)` 나
    설정의 `'sandbox': True` 로 모의투자 도메인과 모의 TR ID, 초당 2건 호출 간격으로 바꾼다.

심볼
    국내는 `005930/KRW`, 미국은 `AAPL/USD` 다. 슬래시가 든 티커(`BRK/B`)는 `BRK.B/USD` 로 쓰고 `market['id']` 에 KIS 표기를 둔다.
    접미사를 뺀 `005930`, `AAPL` 도 받는다. 국내 종목은 종목코드 모양(6자리)만으로 가르고, 해외 종목의 거래소는 종목 마스터
    (`options['masterData']`, `kis_master_data` 참고)에서 찾는다. `load_markets()` 는 마스터 데이터로 종목 목록을 만들 뿐이고 주문과 시세 호출에는 필요 없다.

주문
    수량은 정수 주로 내린다. 국내 정규장 주문은 휴장일 캘린더(`chk-holiday`)를 받아 거래시간을 확인하고, 거래시간 밖이면 요청을 보내지 않고
    `MarketClosed` 를 던진다. `options['nxtRouting']` 을 켜면 NXT 확장세션(프리 08:00~08:50, 애프터 15:30~20:00)에 SOR 로 내고, 시장가는
    현재가 지정가로 바꾼다. 미국은 지정가만 받아 `price` 가 필요하고, 실전에서 시장가를 주면 장마감지정가(LOC)로 낸다. 접수 응답에는 체결이
    없어 `filled` 가 비어 있다. 체결은 `fetch_order` 와 `fetch_my_trades` 로 본다.

요청
    모든 REST 호출에 접근 토큰이 필요하다. TR ID 는 `params['tr_id']` 로 넘기면 `sign()` 이 헤더로 옮긴다. 조회가 `EGW00201`·`EGW00215`
    (초당 거래건수 초과)로 실패하면 `RateLimitExceeded` 를 던지고 조회에 한해 몇 번 다시 보낸다. 시간 초과는 다시 보내지 않는다.
    주문은 재시도하지 않고, 시간 초과나 연결 끊김이면 접수 여부를 모르므로 `OrderOutcomeUnknown` 을 던진다.

옵션
    `tokenStore`(토큰 저장소), `nxtRouting`(정규장 밖 NXT 주문과 시세, 불리언이거나 불리언을 돌려주는 함수), `masterData`(종목 마스터),
    `stockDirectory`(코스피·코스닥 구분을 알려 주는 `find_kr_market(code)` 객체), `orderableProbeCode`(주문가능현금 조회에 쓰는 종목)다.

한계
    잔고와 미체결, 주문체결 조회는 연속조회로 끝까지 받는다. 10쪽을 넘으면 일부만 돌려주지 않고 `BadResponse` 를 던진다. `fetch_ohlcv` 는 야후 파이낸스에서
    받는다(국내는 항상, 미국 일·주·월봉은 야후가 비면 KIS 로 다시 받는다). `fetch_order_book` 은 국내만, `fetch_tickers` 는 국내 30종목까지다.
"""

import datetime
import json
import logging
import math
import re
from typing import Any, Callable, Dict, List, NamedTuple, Optional

from kr_broker.abstract.kis import ImplicitAPI
from kr_broker.base.exchange import Exchange
from kr_broker.base.runtime import maybe_await, new_lock, sleep_seconds
from kr_broker.base.token_store import LegacyKeyTokenStore, refresh_token_with_lock
from kr_broker.extended_session_limit import build_extended_session_limit
from kr_broker.kis_candle_service import KISCandleService
from kr_broker.kis_yahoo_candles import fetch_yahoo_candles
from kr_broker.market_calendar import refresh_market_calendar as refresh_shared_market_calendar
from kr_broker.base import functions as fn
from kr_broker.base.decimal_to_precision import NO_PADDING, ROUND, TICK_SIZE, decimal_to_precision
from kr_broker.base.errors import (
    ArgumentsRequired, AuthenticationError, BadRequest, BadResponse, BadSymbol, ExchangeError, InvalidOrder, MarketClosed, NotSupported,
    NullResponse, OrderNotFound, RateLimitExceeded, RequestTimeout,
)
from kr_broker.base.precise import Precise
from kr_broker.base.token_store import BrokerTokenStore, legacy_token_store_key, token_store_key
from kr_broker.base.types import ApiName, Int, Num, Str, Strings
from kr_broker.broker_krx_code import is_krx_domestic_code
from kr_broker.kis_kr_market import resolve_kr_market
from kr_broker.kis_master_data import master_data_of
from kr_broker.kis_rate_limit import reserve_kis_slot, reset_kis_rate_limiter  # noqa: F401 - 예전 경로(kr_broker.kis)로도 부른다
from kr_broker.kis_overseas_master import (
    get_overseas_market_for_code, get_overseas_stock_by_code, search_overseas_stocks, to_order_market_code,
)
from kr_broker.kis_stock_master import get_krx_stock_by_code, get_stock_master_count, search_krx_stocks
from kr_broker.kis_types import (
    KIS_API_DOMAINS, KIS_BROKERAGE_FEE, KIS_CUSTOMER_TYPE, KIS_DEFAULT_ACCOUNT_SUFFIX, KIS_ORDER_TYPE, KIS_OVERSEAS_DEFAULT_FEE_RATE,
    KIS_OVERSEAS_ORD_DVSN, KIS_PRESENT_BALANCE_PARAMS, KIS_WS_DOMAINS, get_tick_size,
)
from kr_broker.krx_sell_tax import krx_sell_tax_rate
from kr_broker.krx_trading_hours import check_krx_trading_hours, get_krx_market_phase, get_nxt_session, is_nxt_extended_tradable
from kr_broker.us_market_hours import et_wall_clock_to_utc_ms, et_ymd, format_et_wall_clock, get_us_market_phase

logger = logging.getLogger('kr_broker')

# 실전 하드 한도 초당 20건(50ms)에 여유를 둔 초당 15건, 모의는 초당 2건이다.
REAL_RATE_LIMIT_MS = 67
SANDBOX_RATE_LIMIT_MS = 500
READ_TIMEOUT_MS = 20_000
ORDER_TIMEOUT_MS = 25_000
AUTH_TIMEOUT_MS = 10_000
READ_RETRIES = 3
READ_RETRY_DELAY_MS = 500
# 연속조회로 받는 최대 쪽 수. 공식 예제의 재귀 상한(10)과 같다.
MAX_CONTINUATION_PAGES = 10
# 연속조회 도우미가 꺼내 가지 않은 `tr_cont` 기록(분봉 같은 다른 조회의 것)을 남겨 두는 최대 개수.
TR_CONT_RECORD_LIMIT = 64
# 관심종목(멀티종목) 시세 한 번에 담을 수 있는 종목 수.
MULTI_TICKER_LIMIT = 30
# 종목의 NXT 거래 가능 여부를 캐시하는 시간. NXT 거래 대상은 자주 바뀌지 않는다.
NXT_ELIGIBILITY_TTL_MS = 6 * 60 * 60 * 1000
# 종목정보 조회의 상품유형: 주식·ETF·ETN·ELW.
STOCK_INFO_PRODUCT_TYPE = '300'
# VI 발동 현황 조회의 고정 화면 분류 코드. 공식 예제가 이 값 하나만 쓴다.
VI_STATUS_SCREEN_CODE = '20139'

KST_OFFSET_MS = 9 * 60 * 60 * 1000
DAY_MS = 24 * 60 * 60 * 1000
# 지난 영업일을 알기 위해 되돌아 조회하는 기간.
HOLIDAY_LOOKBACK_MS = 30 * DAY_MS
# 휴장일 캘린더를 신선하게 보는 시간. KIS 는 하루 한 번 호출을 권하므로 하루에 두 번까지만 부른다.
CALENDAR_TTL_MS = 12 * 60 * 60 * 1000

# 매도매수구분코드: 체결·미체결 조회 응답에서 `01` 이 매도, `02` 가 매수다.
SIDE_CODE_SELL = '01'
SIDE_CODE_BUY = '02'

# 국내 주문 TR ID(실전, 모의). 확장세션(NXT)은 거래소 구분(`EXCG_ID_DVSN_CD`)을 받는 신형을 쓴다.
DOMESTIC_ORDER_TR = {
    'regular': {'buy': ('TTTC0802U', 'VTTC0802U'), 'sell': ('TTTC0801U', 'VTTC0801U')},
    'extended': {'buy': ('TTTC0012U', 'VTTC0012U'), 'sell': ('TTTC0011U', 'VTTC0011U')},
}

# 해외 주문 TR ID. 앞에 실전 접두사 `T` 를 붙여 쓰고 모의는 첫 글자를 `V` 로 바꾼다. 거래소마다 다르다.
OVERSEAS_ORDER_TR = {
    'NASD': {'buy': 'TTT1002U', 'sell': 'TTT1006U'},
    'NYSE': {'buy': 'TTT1002U', 'sell': 'TTT1006U'},
    'AMEX': {'buy': 'TTT1002U', 'sell': 'TTT1006U'},
    'SEHK': {'buy': 'TTS1002U', 'sell': 'TTS1001U'},
    'SHAA': {'buy': 'TTS0202U', 'sell': 'TTS1005U'},
    'SZAA': {'buy': 'TTS0305U', 'sell': 'TTS0304U'},
    'TKSE': {'buy': 'TTS0308U', 'sell': 'TTS0307U'},
    'HASE': {'buy': 'TTS0311U', 'sell': 'TTS0310U'},
    'VNSE': {'buy': 'TTS0311U', 'sell': 'TTS0310U'},
}

# 미국 거래소. 이 거래소의 주문에는 미국장 세션 게이트를 건다.
US_ORDER_EXCHANGES = frozenset(['NASD', 'NYSE', 'AMEX'])

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
TOKEN_FETCH_LOCK_TTL_MS = 90 * 1000
STORE_TTL_MARGIN_MS = 60_000
KIS_TOKEN_SAFETY_MARGIN_MS = 30 * 60 * 1000
# 서버가 expires_in 을 주지 않을 때만 쓰는 폴백(사양의 24시간에서 여유를 뺀 값).
KIS_TOKEN_EXPIRY_MS = (24 * 60 - 30) * 60 * 1000
KIS_TOKEN_MIN_LIFETIME_MS = 60_000


# `tr()` 에 모의 TR ID 를 주지 않았다는 표지.
_OMITTED = object()


class KisInstrument(NamedTuple):
    """종목 식별 결과. 국내는 종목코드 모양으로, 해외는 종목 마스터로 정한다."""
    # 통합 심볼(`005930/KRW`, `AAPL/USD`, `BRK.B/USD`)
    symbol: str
    # KIS 가 쓰는 종목 식별자(국내 종목코드, 해외 티커는 슬래시 표기 그대로)
    code: str
    overseas: bool
    quote: str
    # 시세 거래소 코드(`NAS`). 해외 마스터에 없으면 None
    quote_exchange: Optional[str]
    # 주문·잔고 거래소 코드(`NASD`). 해외 마스터에 없으면 None
    order_exchange: Optional[str]


_SUFFIXED_SYMBOL = re.compile(r'(.+)/(KRW|USD)')
_YMD = re.compile(r'[0-9]{8}')
_HMS = re.compile(r'[0-9]{6}')


def kst_ymd(ms: int) -> str:
    """UTC 밀리초의 한국 날짜 `YYYYMMDD`."""
    return fn.iso8601(ms + KST_OFFSET_MS)[:10].replace('-', '')


def kst_timestamp(ymd: Str, hms: Str) -> Int:
    """`YYYYMMDD` 와 `HHMMSS`(한국 시각)를 UTC 밀리초로 바꾼다. 날짜를 못 읽으면 None, 시각을 못 읽으면 그날 0시다."""
    if ymd is None or _YMD.fullmatch(ymd) is None:
        return None
    clock = hms if hms is not None and _HMS.fullmatch(hms) is not None else '000000'
    return fn.js_date_parse_iso(f'{ymd[0:4]}-{ymd[4:6]}-{ymd[6:8]}T{clock[0:2]}:{clock[2:4]}:{clock[4:6]}+09:00')


def et_timestamp(ymd: Str, hms: Str) -> Int:
    """`YYYYMMDD` 와 `HHMMSS`(미국 동부 시각, 서머타임 반영)를 UTC 밀리초로 바꾼다. 읽는 규칙은 `kst_timestamp` 와 같다."""
    kst = kst_timestamp(ymd, hms)
    if kst is None:
        return None
    # 한국 시각으로 읽은 값에 9시간을 더하면 같은 벽시계 시각을 UTC 로 읽은 값이 된다.
    wall = datetime.datetime(1970, 1, 1) + datetime.timedelta(milliseconds=kst + KST_OFFSET_MS)
    return et_wall_clock_to_utc_ms(wall.year, wall.month, wall.day, wall.hour, wall.minute) + wall.second * 1000


def first_row(value: Any) -> Dict[str, Any]:
    """응답의 첫 행. 배열이면 첫 원소, 사전이면 그대로, 없으면 빈 사전이다."""
    if isinstance(value, list):
        return value[0] if len(value) > 0 and value[0] is not None else {}
    return value if isinstance(value, dict) else {}


def rows_of(value: Any) -> List[Dict[str, Any]]:
    """응답의 행 목록. 배열이 아니면 빈 목록이다."""
    return value if isinstance(value, list) else []


def multi_rows_of(value: Any) -> List[Dict[str, Any]]:
    """응답의 행 목록. 배열이면 그대로, 사전이면 키가 있을 때만 한 행으로 감싼다(KIS 는 행이 하나면 사전으로, 없으면 빈 사전으로 준다)."""
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and len(value) > 0:
        return [value]
    return []


def to_number(value: Any) -> float:
    """JavaScript 의 `Number(value)`. 유한한 수가 아니면 0 이다."""
    n = fn.js_number(value)
    return n if math.isfinite(n) else 0


def _non_negative(value: Str) -> str:
    """금액 문자열이 음수면 `'0'` 이다."""
    return '0' if value is None or Precise.string_lt(value, '0') else value


def _signed_change(change: Str, percentage: Str, sign: Str) -> str:
    """전일대비에 부호를 붙인다. 부호는 등락률의 부호를 쓰고, 등락률이 반올림으로 0 이면 전일대비부호(1 상한, 2 상승, 3 보합, 4 하한,
    5 하락)로 정한다. 등락률만 보면 호가단위가 작은 고가 종목의 작은 변동이 0 이 된다."""
    magnitude = Precise.string_abs(change if change is not None else '0') or '0'
    direction = _js_sign(to_number(percentage))
    if direction == 0:
        direction = -1 if sign in ('4', '5') else 1 if sign in ('1', '2') else 0
    if direction == 0:
        return '0'
    return (Precise.string_neg(magnitude) or '0') if direction < 0 else magnitude


def _js_sign(n: float) -> int:
    return (n > 0) - (n < 0)


def _field(response: Any, key: str) -> Any:
    """응답 사전의 필드. 응답이 사전이 아니면 None 이다."""
    return response.get(key) if isinstance(response, dict) else None


def _tpl(value: Any) -> str:
    """JavaScript 템플릿 문자열에 넣은 값(`undefined` 는 그 글자 그대로)."""
    return 'undefined' if value is None else fn.js_string(value)


def _or_none(value: Str) -> Str:
    """JavaScript 의 `value || undefined`. 빈 문자열을 없는 값으로 본다."""
    return value if value else None


# ---- 순위 ----

def _previous_fiscal_year(now: int) -> str:
    """직전 회계연도(한국 날짜 기준 올해 - 1). 재무 순위의 회계연도 기본값이다."""
    return str(int(kst_ymd(now)[0:4]) - 1)


def _finance_ranking_params(now: int, screen: str, sort: str) -> Dict[str, Any]:
    """재무 순위 세 종류의 공통 입력. 결산(`3`)과 직전 회계연도가 기본이다."""
    return {
        'fid_trgt_cls_code': '0', 'fid_cond_mrkt_div_code': 'J', 'fid_cond_scr_div_code': screen, 'fid_input_iscd': '0000',
        'fid_div_cls_code': '0', 'fid_input_price_1': '', 'fid_input_price_2': '', 'fid_vol_cnt': '',
        'fid_input_option_1': _previous_fiscal_year(now), 'fid_input_option_2': '3', 'fid_rank_sort_cls_code': sort,
        'fid_blng_cls_code': '0', 'fid_trgt_exls_cls_code': '0',
    }


# 시간외 순위는 공통 필드를 시간외 단일가 값으로 채운다.
KIS_OVERTIME_FIELDS = {'price': 'ovtm_untp_prpr', 'change': 'ovtm_untp_prdy_vrss', 'rate': 'ovtm_untp_prdy_ctrt', 'volume': 'ovtm_untp_vol'}

# 해외 순위의 거래소 코드(`EXCD`)와 그 거래소의 거래 통화.
KIS_OVERSEAS_RANKING_EXCHANGES = {
    'NYS': 'USD', 'NAS': 'USD', 'AMS': 'USD', 'HKS': 'HKD', 'SHS': 'CNY', 'SZS': 'CNY', 'HSX': 'VND', 'HNX': 'VND', 'TSE': 'JPY',
}

# 해외 신고가·신저가의 기간(`params['period']`) → `NDAY`.
KIS_NEW_HIGH_LOW_PERIODS = {'5d': '0', '10d': '1', '20d': '2', '30d': '3', '60d': '4', '120d': '5', '52w': '6', '1y': '7'}


def _dividend_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """배당 종류(`stock` 주식배당, `cash` 현금배당)를 `GB3` 로 옮긴다. 전체 값이 없는 필터라 기본값을 두지 않는다."""
    rest = {key: value for key, value in params.items() if key != 'dividendType'}
    dividend_type = params.get('dividendType')
    gb3 = rest.get('GB3')
    if gb3 is None:
        gb3 = '1' if dividend_type == 'stock' else '2' if dividend_type == 'cash' else None
    if gb3 != '1' and gb3 != '2':
        raise ArgumentsRequired("kis fetchRankings('DIVIDEND_RATE') 는 params.dividendType('stock' 주식배당, 'cash' 현금배당)이 필요하다")
    rest['GB3'] = gb3
    return rest


def _overseas_ranking_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """해외 순위의 거래소(`params['exchange']`, 예: `NAS`)를 `EXCD` 로 옮긴다. 전체 값이 없는 필터라 기본값을 두지 않는다."""
    rest = {key: value for key, value in params.items() if key != 'exchange'}
    code = rest.get('EXCD')
    if code is None:
        code = params.get('exchange')
    if code is None or code == '':
        raise ArgumentsRequired('kis 해외 순위는 params.exchange(NYS, NAS, AMS, HKS, SHS, SZS, HSX, HNX, TSE)가 필요하다')
    if KIS_OVERSEAS_RANKING_EXCHANGES.get(fn.js_string(code)) is None:
        raise BadRequest(f'kis 해외 순위의 exchange 는 설명에 있는 거래소 코드여야 한다: {_tpl(code)}')
    rest['EXCD'] = code
    return rest


def _new_high_low_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """해외 신고가·신저가의 기간(`NDAY`). 빠지면 실계좌에서 거부되고 전체 값이 없어 호출하는 쪽이 고른다."""
    rest = {key: value for key, value in params.items() if key != 'period'}
    period = params.get('period')
    code = rest.get('NDAY')
    if code is None:
        code = KIS_NEW_HIGH_LOW_PERIODS.get(period) if isinstance(period, str) else None
    if code is None:
        raise ArgumentsRequired(f"kis 해외 신고가·신저가 순위는 params.period({', '.join(KIS_NEW_HIGH_LOW_PERIODS)})가 필요하다")
    rest['NDAY'] = code
    return _overseas_ranking_params(rest)


# 해외 순위의 공통 입력. 거래량 조건은 전체(`0`), 연속조회 키와 권한 정보는 빈 값이다. 거래소는 `prepare` 가 채운다.
KIS_OVERSEAS_RANKING_COMMON = {'EXCD': '', 'VOL_RANG': '0', 'KEYB': '', 'AUTH': ''}


def _overseas_ranking(path: str, tr_id: str, params: Dict[str, Any], name: str = 'name',
                      prepare: Callable[[Dict[str, Any]], Dict[str, Any]] = _overseas_ranking_params) -> Dict[str, Any]:
    """해외 순위 표 항목. 행은 `output2`, 종목코드는 `symb` 다. 종목명 필드는 순위마다 `name` 이나 `knam` 이다."""
    return {
        'path': f'uapi/overseas-stock/v1/ranking/{path}', 'trId': tr_id, 'symbolKey': 'symb', 'rowsKey': 'output2', 'overseas': True,
        'fields': {'rank': 'rank', 'name': name, 'price': 'last', 'change': 'diff', 'rate': 'rate', 'volume': 'tvol'},
        'params': lambda now: fn.extend(KIS_OVERSEAS_RANKING_COMMON, params),
        'prepare': prepare,
    }


def _price_limit_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """상하한가 구분(`upper` 상한가, `lower` 하한가)을 `FID_PRC_CLS_CODE` 로 옮긴다. 전체 값이 없는 필터라 기본값을 두지 않는다."""
    rest = {key: value for key, value in params.items() if key != 'priceLimit'}
    price_limit = params.get('priceLimit')
    code = rest.get('FID_PRC_CLS_CODE')
    if code is None:
        code = '0' if price_limit == 'upper' else '1' if price_limit == 'lower' else None
    if code != '0' and code != '1':
        raise ArgumentsRequired("kis fetchRankings('PRICE_LIMIT') 는 params.priceLimit('upper' 상한가, 'lower' 하한가)이 필요하다")
    rest['FID_PRC_CLS_CODE'] = code
    return rest


# 순위 표의 공통 입력: 시장 KRX(`J`), 대상과 제외 대상과 분류는 전체, 가격과 거래량 범위는 비움.
KIS_RANKING_COMMON = {
    'fid_cond_mrkt_div_code': 'J', 'fid_input_iscd': '0000', 'fid_div_cls_code': '0', 'fid_trgt_cls_code': '0', 'fid_trgt_exls_cls_code': '0',
    'fid_input_price_1': '', 'fid_input_price_2': '', 'fid_vol_cnt': '',
}


def _elw_ranking(path: str, tr_id: str, name_key: str, extra: Dict[str, Any]) -> Dict[str, Any]:
    """ELW 순위 한 종류. 다섯 순위가 나눠 쓰는 입력(시장 `W`, 기초자산 전체, 발행사 전체, 범위 비움, 결재방법 `0`)에 종류별 입력을 더한다."""
    return {
        'path': f'uapi/elw/v1/ranking/{path}',
        'trId': tr_id,
        'symbolKey': 'elw_shrn_iscd',
        'params': lambda now: fn.extend({
            'FID_COND_MRKT_DIV_CODE': 'W', 'FID_UNAS_INPUT_ISCD': '000000', 'FID_INPUT_ISCD': '00000', 'FID_INPUT_PRICE_1': '',
            'FID_INPUT_PRICE_2': '', 'FID_INPUT_VOL_1': '', 'FID_INPUT_VOL_2': '', 'FID_BLNG_CLS_CODE': '0',
        }, extra),
        'fields': {'name': name_key, 'price': 'elw_prpr'},
    }


def _near_new_high_low(prc_cls_code: str) -> Dict[str, Any]:
    return {
        'path': 'uapi/domestic-stock/v1/ranking/near-new-highlow', 'trId': 'FHPST01870000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: {
            'fid_aply_rang_vol': '0', 'fid_cond_mrkt_div_code': 'J', 'fid_cond_scr_div_code': '20187', 'fid_div_cls_code': '0',
            'fid_input_cnt_1': '', 'fid_input_cnt_2': '', 'fid_prc_cls_code': prc_cls_code, 'fid_input_iscd': '0000', 'fid_trgt_cls_code': '0',
            'fid_trgt_exls_cls_code': '0', 'fid_aply_rang_prc_1': '', 'fid_aply_rang_prc_2': '',
        },
    }


# 표로 정의하는 순위. `path` 는 API 트리 경로이고 암묵 메서드 이름이 여기서 나온다. `params(now)` 는 공식 예제의 요청 키를 그대로 쓴다.
# 조회 방식을 고르는 필수 입력(정렬 등)은 예제값이 기본이고 `params` 로 바꿀 수 있다. 등락률과 거래량 순위는 따로 부른다.
KIS_RANKING_SPECS: Dict[str, Dict[str, Any]] = {
    # 시간외잔량 순위. 정렬 기본은 장전 시간외(`1`)
    'AFTER_HOUR_BALANCE': {
        'path': 'uapi/domestic-stock/v1/ranking/after-hour-balance', 'trId': 'FHPST01760000', 'symbolKey': 'stck_shrn_iscd',
        'params': lambda now: fn.extend(KIS_RANKING_COMMON, {'fid_cond_scr_div_code': '20176', 'fid_rank_sort_cls_code': '1'}),
    },
    # 대량체결건수 상위. 정렬 기본은 매수상위(`0`)
    'BULK_TRANS': {
        'path': 'uapi/domestic-stock/v1/ranking/bulk-trans-num', 'trId': 'FHKST190900C0', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: {
            'fid_aply_rang_prc_2': '', 'fid_cond_mrkt_div_code': 'J', 'fid_cond_scr_div_code': '11909', 'fid_input_iscd': '0000',
            'fid_rank_sort_cls_code': '0', 'fid_div_cls_code': '0', 'fid_input_price_1': '', 'fid_aply_rang_prc_1': '', 'fid_input_iscd_2': '',
            'fid_trgt_exls_cls_code': '0', 'fid_trgt_cls_code': '0', 'fid_vol_cnt': '',
        },
    },
    # 이격도 순위. 정렬 기본은 이격도상위(`0`), 기간은 5일(`5`)
    'DISPARITY': {
        'path': 'uapi/domestic-stock/v1/ranking/disparity', 'trId': 'FHPST01780000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: fn.extend(KIS_RANKING_COMMON, {'fid_cond_scr_div_code': '20178', 'fid_rank_sort_cls_code': '0', 'fid_hour_cls_code': '5'}),
    },
    # 예상체결 상승·하락 상위. 누적거래량 대신 예상 체결량(`cntg_vol`)이 온다
    'EXPECTED_CHANGE': {
        'path': 'uapi/domestic-stock/v1/ranking/exp-trans-updown', 'trId': 'FHPST01820000', 'symbolKey': 'stck_shrn_iscd',
        'fields': {'volume': 'cntg_vol'},
        'params': lambda now: {
            'fid_rank_sort_cls_code': '0', 'fid_cond_mrkt_div_code': 'J', 'fid_cond_scr_div_code': '20182', 'fid_input_iscd': '0000',
            'fid_div_cls_code': '0', 'fid_aply_rang_prc_1': '', 'fid_vol_cnt': '', 'fid_pbmn': '', 'fid_blng_cls_code': '0',
            'fid_mkop_cls_code': '0',
        },
    },
    # 시가총액 상위
    'MARKET_CAP': {
        'path': 'uapi/domestic-stock/v1/ranking/market-cap', 'trId': 'FHPST01740000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: fn.extend(KIS_RANKING_COMMON, {'fid_cond_scr_div_code': '20174'}),
    },
    # 신고가 근접 상위(`fid_prc_cls_code=0`)
    'NEAR_NEW_HIGH': _near_new_high_low('0'),
    # 신저가 근접 상위(`fid_prc_cls_code=1`)
    'NEAR_NEW_LOW': _near_new_high_low('1'),
    # 우선주 괴리율 상위
    'PREFERRED_DISPARITY': {
        'path': 'uapi/domestic-stock/v1/ranking/prefer-disparate-ratio', 'trId': 'FHPST01770000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: fn.extend(KIS_RANKING_COMMON, {'fid_cond_scr_div_code': '20177'}),
    },
    # 호가잔량 순위. 정렬 기본은 순매수잔량순(`0`)
    'QUOTE_BALANCE': {
        'path': 'uapi/domestic-stock/v1/ranking/quote-balance', 'trId': 'FHPST01720000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: fn.extend(KIS_RANKING_COMMON, {'fid_cond_scr_div_code': '20172', 'fid_rank_sort_cls_code': '0'}),
    },
    # 관심종목등록 상위
    'TOP_INTEREST': {
        'path': 'uapi/domestic-stock/v1/ranking/top-interest-stock', 'trId': 'FHPST01800000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: fn.extend(KIS_RANKING_COMMON, {'fid_cond_scr_div_code': '20180', 'fid_input_iscd_2': '000000', 'fid_input_cnt_1': '1'}),
    },
    # 당사매매종목 상위. 기간은 오늘 하루(한국 날짜)
    'TRADED_BY_COMPANY': {
        'path': 'uapi/domestic-stock/v1/ranking/traded-by-company', 'trId': 'FHPST01860000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: {
            'fid_trgt_exls_cls_code': '0', 'fid_cond_mrkt_div_code': 'J', 'fid_cond_scr_div_code': '20186', 'fid_div_cls_code': '0',
            'fid_rank_sort_cls_code': '0', 'fid_input_date_1': kst_ymd(now), 'fid_input_date_2': kst_ymd(now), 'fid_input_iscd': '0000',
            'fid_trgt_cls_code': '0', 'fid_aply_rang_vol': '0', 'fid_aply_rang_prc_2': '', 'fid_aply_rang_prc_1': '',
        },
    },
    # 체결강도 상위
    'VOLUME_POWER': {
        'path': 'uapi/domestic-stock/v1/ranking/volume-power', 'trId': 'FHPST01680000', 'symbolKey': 'stck_shrn_iscd',
        'params': lambda now: fn.extend(KIS_RANKING_COMMON, {'fid_cond_scr_div_code': '20168'}),
    },
    # 신용잔고 상위. 행은 `output2` 다
    'CREDIT_BALANCE': {
        'path': 'uapi/domestic-stock/v1/ranking/credit-balance', 'trId': 'FHKST17010000', 'symbolKey': 'mksc_shrn_iscd', 'rowsKey': 'output2',
        'params': lambda now: {
            'FID_COND_SCR_DIV_CODE': '11701', 'FID_INPUT_ISCD': '0000', 'FID_OPTION': '2', 'FID_COND_MRKT_DIV_CODE': 'J',
            'FID_RANK_SORT_CLS_CODE': '0',
        },
    },
    # 배당률 상위. 배당 종류는 `params['dividendType']` 으로 반드시 고른다. 기준일 범위는 최근 1년이다
    'DIVIDEND_RATE': {
        'path': 'uapi/domestic-stock/v1/ranking/dividend-rate', 'trId': 'HHKDB13470100', 'symbolKey': 'sht_cd',
        'fields': {'rank': 'rank', 'name': 'isin_name'},
        'params': lambda now: {
            'CTS_AREA': ' ', 'GB1': '1', 'UPJONG': '0001', 'GB2': '0', 'GB3': '', 'F_DT': kst_ymd(now - 365 * DAY_MS), 'T_DT': kst_ymd(now),
            'GB4': '0',
        },
        'prepare': _dividend_params,
    },
    # 재무비율 순위. 정렬 기본은 수익성 분석(`7`)
    'FINANCE_RATIO': {
        'path': 'uapi/domestic-stock/v1/ranking/finance-ratio', 'trId': 'FHPST01750000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: _finance_ranking_params(now, '20175', '7'),
    },
    # HTS 조회상위 20종목. 행은 `output1` 이다
    'HTS_TOP_VIEW': {
        'path': 'uapi/domestic-stock/v1/ranking/hts-top-view', 'trId': 'HHMCM000100C0', 'symbolKey': 'mksc_shrn_iscd', 'rowsKey': 'output1',
        'params': lambda now: {},
    },
    # 시장가치 순위. 정렬 기본은 PER(`23`)
    'MARKET_VALUE': {
        'path': 'uapi/domestic-stock/v1/ranking/market-value', 'trId': 'FHPST01790000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: _finance_ranking_params(now, '20179', '23'),
    },
    # 시간외 예상체결 등락률
    'OVERTIME_EXPECTED_CHANGE': {
        'path': 'uapi/domestic-stock/v1/ranking/overtime-exp-trans-fluct', 'trId': 'FHKST11860000', 'symbolKey': 'stck_shrn_iscd',
        'fields': {'price': 'ovtm_untp_antc_cnpr', 'change': 'ovtm_untp_antc_cntg_vrss', 'rate': 'ovtm_untp_antc_cntg_ctrt', 'volume': 'ovtm_untp_antc_cnqn'},
        'params': lambda now: {
            'FID_COND_MRKT_DIV_CODE': 'J', 'FID_COND_SCR_DIV_CODE': '11186', 'FID_INPUT_ISCD': '0000', 'FID_RANK_SORT_CLS_CODE': '0',
            'FID_DIV_CLS_CODE': '0', 'FID_INPUT_PRICE_1': '', 'FID_INPUT_PRICE_2': '', 'FID_INPUT_VOL_1': '',
        },
    },
    # 시간외 등락률 순위. 행은 `output2` 다
    'OVERTIME_CHANGE': {
        'path': 'uapi/domestic-stock/v1/ranking/overtime-fluctuation', 'trId': 'FHPST02340000', 'symbolKey': 'mksc_shrn_iscd', 'rowsKey': 'output2',
        'fields': KIS_OVERTIME_FIELDS,
        'params': lambda now: {
            'FID_COND_MRKT_DIV_CODE': 'J', 'FID_MRKT_CLS_CODE': '', 'FID_COND_SCR_DIV_CODE': '20234', 'FID_INPUT_ISCD': '0000',
            'FID_DIV_CLS_CODE': '1', 'FID_INPUT_PRICE_1': '', 'FID_INPUT_PRICE_2': '', 'FID_VOL_CNT': '', 'FID_TRGT_CLS_CODE': '',
            'FID_TRGT_EXLS_CLS_CODE': '',
        },
    },
    # 시간외 거래량 순위. 행은 `output2` 다
    'OVERTIME_VOLUME': {
        'path': 'uapi/domestic-stock/v1/ranking/overtime-volume', 'trId': 'FHPST02350000', 'symbolKey': 'stck_shrn_iscd', 'rowsKey': 'output2',
        'fields': KIS_OVERTIME_FIELDS,
        'params': lambda now: {
            'FID_COND_MRKT_DIV_CODE': 'J', 'FID_COND_SCR_DIV_CODE': '20235', 'FID_INPUT_ISCD': '0000', 'FID_RANK_SORT_CLS_CODE': '0',
            'FID_INPUT_PRICE_1': '', 'FID_INPUT_PRICE_2': '', 'FID_VOL_CNT': '', 'FID_TRGT_CLS_CODE': '', 'FID_TRGT_EXLS_CLS_CODE': '',
        },
    },
    # 수익자산지표 순위
    'PROFIT_ASSET': {
        'path': 'uapi/domestic-stock/v1/ranking/profit-asset-index', 'trId': 'FHPST01730000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: _finance_ranking_params(now, '20173', '0'),
    },
    # 공매도 상위. 순위 필드가 없다
    'SHORT_SALE': {
        'path': 'uapi/domestic-stock/v1/ranking/short-sale', 'trId': 'FHPST04820000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: {
            'FID_APLY_RANG_VOL': '', 'FID_COND_MRKT_DIV_CODE': 'J', 'FID_COND_SCR_DIV_CODE': '20482', 'FID_INPUT_ISCD': '0000',
            'FID_PERIOD_DIV_CODE': 'D', 'FID_INPUT_CNT_1': '0', 'FID_TRGT_EXLS_CLS_CODE': '', 'FID_TRGT_CLS_CODE': '', 'FID_APLY_RANG_PRC_1': '',
            'FID_APLY_RANG_PRC_2': '',
        },
    },
    # 장마감 예상체결가. 거래량 자리에는 체결거래량(`cntg_vol`)을 넣는다
    'CLOSING_EXPECTED': {
        'path': 'uapi/domestic-stock/v1/quotations/exp-closing-price', 'trId': 'FHKST117300C0', 'symbolKey': 'stck_shrn_iscd',
        'fields': {'volume': 'cntg_vol'},
        'params': lambda now: {
            'FID_COND_MRKT_DIV_CODE': 'J', 'FID_INPUT_ISCD': '0000', 'FID_RANK_SORT_CLS_CODE': '0', 'FID_COND_SCR_DIV_CODE': '11173',
            'FID_BLNG_CLS_CODE': '0',
        },
    },
    # 국내기관·외국인 매매종목 가집계
    'FOREIGN_INSTITUTION_ESTIMATE': {
        'path': 'uapi/domestic-stock/v1/quotations/foreign-institution-total', 'trId': 'FHPTJ04400000', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: {
            'FID_COND_MRKT_DIV_CODE': 'V', 'FID_COND_SCR_DIV_CODE': '16449', 'FID_INPUT_ISCD': '0000', 'FID_DIV_CLS_CODE': '0',
            'FID_RANK_SORT_CLS_CODE': '0', 'FID_ETC_CLS_CODE': '0',
        },
    },
    # 외국계 매매종목 가집계
    'FOREIGN_BROKER_ESTIMATE': {
        'path': 'uapi/domestic-stock/v1/quotations/frgnmem-trade-estimate', 'trId': 'FHKST644100C0', 'symbolKey': 'stck_shrn_iscd',
        'params': lambda now: {
            'FID_COND_MRKT_DIV_CODE': 'J', 'FID_COND_SCR_DIV_CODE': '16441', 'FID_INPUT_ISCD': '0000', 'FID_RANK_SORT_CLS_CODE': '0',
            'FID_RANK_SORT_CLS_CODE_2': '0',
        },
    },
    # 상하한가 포착. 상하한가 구분은 `params['priceLimit']` 으로 반드시 고른다
    'PRICE_LIMIT': {
        'path': 'uapi/domestic-stock/v1/quotations/capture-uplowprice', 'trId': 'FHKST130000C0', 'symbolKey': 'mksc_shrn_iscd',
        'params': lambda now: {
            'FID_COND_MRKT_DIV_CODE': 'J', 'FID_COND_SCR_DIV_CODE': '11300', 'FID_PRC_CLS_CODE': '', 'FID_DIV_CLS_CODE': '0',
            'FID_INPUT_ISCD': '0000', 'FID_TRGT_CLS_CODE': '', 'FID_TRGT_EXLS_CLS_CODE': '', 'FID_INPUT_PRICE_1': '', 'FID_INPUT_PRICE_2': '',
            'FID_VOL_CNT': '',
        },
        'prepare': _price_limit_params,
    },
    # 해외 순위. 거래소(`params['exchange']`)는 반드시 받는다. 통화구분(`CURR_GB`)은 빠지면 실계좌에서 거부된다
    'OVERSEAS_MARKET_CAP': _overseas_ranking('market-cap', 'HHDFS76350100', {'CURR_GB': '0'}),
    'OVERSEAS_NEW_HIGH': _overseas_ranking('new-highlow', 'HHDFS76300000', {'MINX': '0', 'GUBN': '1', 'GUBN2': '1'}, prepare=_new_high_low_params),
    'OVERSEAS_NEW_LOW': _overseas_ranking('new-highlow', 'HHDFS76300000', {'MINX': '0', 'GUBN': '0', 'GUBN2': '1'}, prepare=_new_high_low_params),
    'OVERSEAS_PRICE_SURGE': _overseas_ranking('price-fluct', 'HHDFS76260000', {'GUBN': '1', 'MINX': '0'}, 'knam'),
    'OVERSEAS_PRICE_PLUNGE': _overseas_ranking('price-fluct', 'HHDFS76260000', {'GUBN': '0', 'MINX': '0'}, 'knam'),
    'OVERSEAS_GAINERS': _overseas_ranking('updown-rate', 'HHDFS76290000', {'NDAY': '0', 'GUBN': '1'}),
    'OVERSEAS_LOSERS': _overseas_ranking('updown-rate', 'HHDFS76290000', {'NDAY': '0', 'GUBN': '0'}),
    'OVERSEAS_VOLUME': _overseas_ranking('trade-vol', 'HHDFS76310010', {'NDAY': '0', 'PRC1': '', 'PRC2': ''}),
    'OVERSEAS_TRADE_AMOUNT': _overseas_ranking('trade-pbmn', 'HHDFS76320010', {'NDAY': '0', 'PRC1': '', 'PRC2': ''}),
    'OVERSEAS_TRADE_GROWTH': _overseas_ranking('trade-growth', 'HHDFS76330000', {'NDAY': '0'}),
    'OVERSEAS_TURNOVER': _overseas_ranking('trade-turnover', 'HHDFS76340000', {'NDAY': '0'}),
    'OVERSEAS_VOLUME_POWER': _overseas_ranking('volume-power', 'HHDFS76280000', {'NDAY': '0'}),
    'OVERSEAS_VOLUME_SURGE': _overseas_ranking('volume-surge', 'HHDFS76270000', {'MINX': '0'}, 'knam'),
    # ELW 순위. 종목코드는 ELW 단축코드(`elw_shrn_iscd`)다
    'ELW_UPDOWN_RATE': _elw_ranking('updown-rate', 'FHPEW02770000', 'hts_kor_isnm', {
        'FID_COND_SCR_DIV_CODE': '20277', 'FID_INPUT_RMNN_DYNU_1': '0', 'FID_DIV_CLS_CODE': '0', 'FID_INPUT_DATE_1': '',
        'FID_RANK_SORT_CLS_CODE': '0', 'FID_INPUT_DATE_2': '',
    }),
    'ELW_VOLUME': _elw_ranking('volume-rank', 'FHPEW02780000', 'elw_kor_isnm', {
        'FID_COND_SCR_DIV_CODE': '20278', 'FID_INPUT_RMNN_DYNU_1': '', 'FID_DIV_CLS_CODE': '0', 'FID_INPUT_DATE_1': '',
        'FID_RANK_SORT_CLS_CODE': '0', 'FID_INPUT_ISCD_2': '0000', 'FID_INPUT_DATE_2': '',
    }),
    'ELW_INDICATOR': _elw_ranking('indicator', 'FHPEW02790000', 'elw_kor_isnm', {
        'FID_COND_SCR_DIV_CODE': '20279', 'FID_DIV_CLS_CODE': '0', 'FID_RANK_SORT_CLS_CODE': '0',
    }),
    'ELW_SENSITIVITY': _elw_ranking('sensitivity', 'FHPEW02850000', 'elw_kor_isnm', {
        'FID_COND_SCR_DIV_CODE': '20285', 'FID_DIV_CLS_CODE': '0', 'FID_RANK_SORT_CLS_CODE': '0', 'FID_INPUT_RMNN_DYNU_1': '',
        'FID_INPUT_DATE_1': '',
    }),
    'ELW_QUICK_CHANGE': _elw_ranking('quick-change', 'FHPEW02870000', 'elw_kor_isnm', {
        'FID_COND_SCR_DIV_CODE': '20287', 'FID_MRKT_CLS_CODE': 'A', 'FID_HOUR_CLS_CODE': '1', 'FID_INPUT_HOUR_1': '', 'FID_INPUT_HOUR_2': '',
        'FID_RANK_SORT_CLS_CODE': '1',
    }),
}


def _implicit_get(path: str) -> str:
    """API 트리 경로 → 암묵 메서드 이름(`uapi/domestic-stock/v1/ranking/fluctuation` → `private_get_uapi_domestic_stock_v1_ranking_fluctuation`)."""
    return 'private_get_' + re.sub(r'[/-]', '_', path).lower()


def _now_ms() -> int:
    return fn.milliseconds()


# ---- 앱키 단위 요청 스케줄러 ----
#
# 예약표는 `kis_rate_limit` 에 있다. 동기 판과 비동기 판이 같은 표를 나눠 쓴다.

def acquire_kis_slot(app_key: str, interval_ms: float, sleep: Callable[[float], Any] = sleep_seconds) -> None:
    wait_ms = reserve_kis_slot(app_key, interval_ms)
    if wait_ms > 0:
        sleep(wait_ms / 1000)


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
        self.raw_store_of = store_of
        self.cached_token: Optional[Dict[str, Any]] = None
        self.cached_approval_key: Optional[Dict[str, Any]] = None
        self._lock = new_lock()
        self._approval_lock = new_lock()

    @property
    def store_key(self) -> str:
        return token_store_key(KIS_TOKEN_KEY_PREFIX, self.app_key)

    @property
    def approval_store_key(self) -> str:
        return token_store_key(KIS_APPROVAL_KEY_PREFIX, self.app_key)

    def store_of(self) -> Any:
        """저장소. 옛 키 형식(앱키 앞 12자)을 쓰는 판과 함께 도는 동안 두 키를 함께 읽고 쓴다."""
        store = self.raw_store_of()
        return None if store is None else LegacyKeyTokenStore(store, {
            self.store_key: legacy_token_store_key(KIS_TOKEN_KEY_PREFIX, self.app_key),
            self.approval_store_key: legacy_token_store_key(KIS_APPROVAL_KEY_PREFIX, self.app_key),
        })

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
            raw = maybe_await(store.get(self.store_key))
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
                maybe_await(store.set(self.store_key, fn.json_stringify(self.cached_token), int(ttl_ms)))
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
                    raw = maybe_await(store.get(self.approval_store_key))
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
                    maybe_await(store.set(self.approval_store_key, fn.json_stringify(self.cached_approval_key), KIS_TOKEN_EXPIRY_MS - STORE_TTL_MARGIN_MS))
                except Exception:
                    logger.warning('[KISAuth] approval_key 저장소 저장 실패(프로세스 메모리 캐시는 유효)', exc_info=True)
            return key

    def invalidate(self) -> None:
        """토큰 캐시를 프로세스 메모리와 저장소에서 모두 지운다. 다음 호출이 새 토큰을 발급받는다."""
        self.forget_local_token()
        self.delete_stored_token()

    def forget_local_token(self) -> None:
        """프로세스 메모리의 토큰 캐시만 비운다."""
        self.cached_token = None

    def delete_stored_token(self) -> None:
        """토큰 저장소의 토큰을 지운다. 실패해도 던지지 않는다."""
        store = self.store_of()
        if store is not None:
            try:
                maybe_await(store.delete(self.store_key))
            except Exception:
                logger.debug('[KISAuth] 토큰 저장소 삭제 실패(프로세스 메모리 무효화는 완료)', exc_info=True)


class kis(Exchange, ImplicitAPI):

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self._auth: Optional[KISAuth] = None
        self._auth_app_key: Str = None
        self._candle_service: Optional[KISCandleService] = None
        # 종목별 NXT 거래 가능 여부. `blockedReason` 이 None 이면 거래할 수 있다.
        self._nxt_eligibility: Dict[str, Dict[str, Any]] = {}
        # 응답 객체의 id → 다음 쪽이 있다는 응답 헤더 `tr_cont`(`F`·`M`). 사전은 약한 참조를 걸 수 없어 id 로 묶고, 도우미가 받자마자 꺼내 지운다.
        self._tr_cont_of: Dict[int, str] = {}
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
            # 옮긴 통합 메서드만 True 다. 실시간(`ws`, `watch*`)은 `kr_broker.pro.kis` 가 True 로 바꾼다.
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
                'sandbox': True,
                'createOrder': True,
                'createLimitOrder': True,
                'createMarketOrder': True,
                'cancelOrder': True,
                'cancelAllOrders': 'emulated',
                'editOrder': True,
                'createTriggerOrder': True,
                'fetchBalance': True,
                'fetchMarkets': True,
                'fetchCurrencies': False,
                'fetchTicker': True,
                'fetchTickers': True,
                'fetchOrderBook': True,
                'fetchOHLCV': True,
                'fetchOrder': True,
                'fetchOrders': True,
                'fetchOpenOrders': True,
                # 부모 클래스가 `fetch_orders` 결과에서 체결 완료만 거른다.
                'fetchClosedOrders': 'emulated',
                'fetchCanceledOrders': False,
                'fetchMyTrades': True,
                'fetchTradingFee': True,
                'fetchStatus': False,
                'fetchTime': False,
                'fetchMarketCalendar': True,
                'fetchStockWarnings': True,
                'fetchInvestorTrading': True,
                'fetchRankings': True,
            },
            # 야후 파이낸스로 받는 봉 주기. 국내 캔들은 KIS 가 당일 분봉과 100행 일봉만 줘서 야후를 쓴다.
            'timeframes': {'1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w', '1M': '1M'},
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
                'fees': 'https://securities.koreainvestment.com/main/customer/guide/_static/TF04ae010000.jsp',
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
                # 주문가능금액(`inquire-psbl-order`)은 종목을 지정해야 조회된다. 현금 주문가능액은 종목과 무관하므로 어느 상장 종목이든 좋다.
                'orderableProbeCode': '005930',
                # 토큰과 발급 락을 여러 프로세스가 나눠 쓰는 저장소(BrokerTokenStore). 없으면 프로세스 메모리 캐시만 쓴다.
                'tokenStore': None,
                # 정규장 밖(NXT 프리·애프터) 주문과 시세를 연다. 불리언이거나 불리언을 돌려주는 함수다. 기본은 꺼짐이다.
                'nxtRouting': None,
                # 종목 검색과 해외 거래소 판별에 쓰는 KIS 마스터 데이터(`kis_master_data` 참고). 없으면 빈 데이터다.
                'masterData': None,
                # 국내 종목의 코스피·코스닥 구분을 알려 주는 곳(`find_kr_market(code)` 가 있는 객체). 없으면 마스터 데이터로 판별한다.
                'stockDirectory': None,
                # 체결 확정 조회의 예산. 한국투자증권은 이 옵션을 읽지 않는다.
                'confirmBudget': None,
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
        """비공개 호출은 `params['tr_id']` 와 `params['tr_cont']`(연속조회 다음 쪽)를 헤더로 옮기고 나머지는 GET 이면 쿼리로, POST 이면
        JSON 본문으로 보낸다. `tr_cont` 가 없으면 그 헤더를 싣지 않는다. 대문자 키(`CANO` 등)는 KIS 규격 그대로 둔다."""
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
            tr_cont = self.safe_string(params, 'tr_cont')
            query = self.omit(params, ['tr_id', 'tr_cont'])
            request_headers.update({
                'authorization': f'Bearer {self.token}',
                'appkey': self.apiKey or '',
                'appsecret': self.secret or '',
                'tr_id': tr_id,
                'custtype': KIS_CUSTOMER_TYPE,
            })
            if tr_cont is not None:
                request_headers['tr_cont'] = tr_cont
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
        self._record_tr_cont(headers, response)
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

    def _record_tr_cont(self, headers: Optional[Dict[str, str]], response: Any) -> None:
        """다음 쪽이 있다는 응답 헤더 `tr_cont` 를 응답 객체의 id 에 적는다. 없으면 같은 id 의 옛 기록(해제된 객체의 id 재사용)을 지운다."""
        if not isinstance(response, (dict, list)):
            return
        tr_cont = next((value for key, value in (headers or {}).items() if key.lower() == 'tr_cont'), None)
        if tr_cont not in ('F', 'M'):
            self._tr_cont_of.pop(id(response), None)
            return
        self._tr_cont_of[id(response)] = tr_cont
        for stale in list(self._tr_cont_of)[:-TR_CONT_RECORD_LIMIT]:
            self._tr_cont_of.pop(stale, None)

    def _fetch_all_pages(self, method: Callable[[Dict[str, Any]], Any], request: Dict[str, Any], keys: List[str],
                               max_pages: int = MAX_CONTINUATION_PAGES) -> List[Any]:
        """연속조회로 모든 쪽의 응답을 받는다. 응답 헤더 `tr_cont` 가 `F`·`M` 이면 요청 헤더 `tr_cont: N` 과 응답의 연속조회 키(`keys` 의
        소문자 필드)로 다음 쪽을 부른다(공식 예제 `examples_llm` 의 규칙이고 실전과 모의가 같다). `max_pages` 쪽을 넘으면 일부만 돌려주지 않고
        `BadResponse` 를 던진다."""
        pages: List[Any] = []
        params = request
        while True:
            response = method(params)
            pages.append(response)
            if self._tr_cont_of.pop(id(response), None) is None:
                return pages
            if len(pages) >= max_pages:
                raise BadResponse(f'{self.id} 연속조회가 {max_pages}쪽을 넘는다')
            params = self.extend(request, {'tr_cont': 'N'})
            for key in keys:
                params[key] = self.safe_string(response, key.lower(), '')

    def _drop_token(self, code: int, msg_cd: Str) -> None:
        logger.warning('[kis] 인증 실패(%s %s). 토큰 캐시를 무효화하고 다음 호출에서 재발급한다', code, msg_cd)
        # 메모리 캐시는 바로 비워 다음 호출이 새 토큰을 받게 한다. 저장소의 토큰은 `spawn` 이 지운다.
        self.token = None
        if self._auth is not None:
            self._auth.forget_local_token()
            self.spawn(self._auth.delete_stored_token)

    # ============ 종목 ============

    def fetch_markets(self, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """종목 마스터 데이터(`options['masterData']`)로 종목 목록을 만든다. 국내(코스피·코스닥)와 미국(나스닥·뉴욕·아멕스)이 들어 있다.
        `params['market']` 으로 `'domestic'` 이나 `'overseas'` 만 받을 수 있다."""
        which = self.safe_string(params, 'market', 'all')
        master = self._master()
        rows: List[Dict[str, Any]] = []
        if which != 'overseas':
            rows.extend(search_krx_stocks(master, None, max(get_stock_master_count(master), 1)))
        if which != 'domestic':
            rows.extend(search_overseas_stocks(master, None, 2 ** 53 - 1))
        return self.parse_markets(rows)

    def parse_market(self, market: Dict[str, Any]) -> Dict[str, Any]:
        """마스터 행 하나를 종목으로 옮긴다. 해외 마스터 행은 `currency` 를 갖고 국내 행은 갖지 않는다."""
        market_id = self.safe_string(market, 'code')
        if market_id is None:
            raise ExchangeError(f'{self.id} parseMarket() missing code')
        overseas = self.safe_string(market, 'currency') is not None or not is_krx_domestic_code(market_id)
        quote = 'USD' if overseas else 'KRW'
        base = market_id.replace('/', '.', 1)
        exchange_code = self.safe_string(market, 'market')
        fee = KIS_OVERSEAS_DEFAULT_FEE_RATE if overseas else KIS_BROKERAGE_FEE
        return self.safe_market_structure({
            'id': market_id,
            'symbol': f'{base}/{quote}',
            'base': base,
            'quote': quote,
            'baseId': market_id,
            'quoteId': quote,
            'settle': None,
            'settleId': None,
            'type': 'spot',
            'spot': True,
            'margin': False,
            'swap': False,
            'future': False,
            'option': False,
            'active': True,
            'contract': False,
            'linear': None,
            'inverse': None,
            'taker': fee,
            'maker': fee,
            'contractSize': None,
            'expiry': None,
            'expiryDatetime': None,
            'strike': None,
            'optionType': None,
            # 국내 호가 단위는 가격대별이라 한 값으로 적을 수 없다. `price_to_precision` 이 표를 쓴다. 미국은 0.01 달러다.
            'precision': {'amount': 1, 'price': 0.01 if overseas else None},
            'limits': {
                'leverage': {'min': None, 'max': None},
                'amount': {'min': 1, 'max': None},
                'price': {'min': None, 'max': None},
                'cost': {'min': None, 'max': None},
            },
            'created': None,
            'info': market,
            'options': {'exchange': exchange_code, 'orderExchange': to_order_market_code(exchange_code) if overseas else None},
        })

    def price_to_precision(self, symbol: Str, price: Any) -> Str:
        """가격을 호가 단위에 맞춘 문자열. 국내 일반 주식은 가격대별 호가 단위(2천원 미만 1원 … 50만원 이상 1천원)로 반올림하고,
        ETF·ETN 은 표가 달라 그대로 둔다. 미국은 0.01 달러 단위다."""
        if price is None:
            return None
        instrument = self._instrument_of(symbol)
        if instrument.overseas:
            return decimal_to_precision(price, ROUND, 0.01, TICK_SIZE, NO_PADDING)
        stock = get_krx_stock_by_code(self._master(), instrument.code)
        security_type = None if stock is None else stock.get('securityType')
        if security_type is not None and security_type != 'STOCK':
            return self.number_to_string(price)
        return decimal_to_precision(price, ROUND, get_tick_size(fn.js_number(price)), TICK_SIZE, NO_PADDING)

    def _instrument_of(self, symbol: str) -> KisInstrument:
        """심볼(또는 종목코드)을 종목 식별 결과로 바꾼다. 국내는 마스터 없이도 되고, 해외는 마스터에서 거래소를 찾는다."""
        suffixed = _SUFFIXED_SYMBOL.fullmatch(symbol)
        base = (suffixed.group(1) if suffixed else symbol).strip()
        if is_krx_domestic_code(base):
            return KisInstrument(f'{base}/KRW', base, False, 'KRW', None, None)
        # 통합 심볼의 점(`BRK.B`)을 KIS 표기의 슬래시(`BRK/B`)로 돌린다. 마스터가 그 표기를 가질 때만 바꾼다.
        upper = base.upper()
        slashed = upper.replace('.', '/', 1)
        master = self._master()
        use_slashed = get_overseas_stock_by_code(master, upper) is None and get_overseas_stock_by_code(master, slashed) is not None
        code = slashed if use_slashed else upper
        quote_exchange = get_overseas_market_for_code(master, code)
        return KisInstrument(f"{code.replace('/', '.', 1)}/USD", code, True, 'USD', quote_exchange, to_order_market_code(quote_exchange))

    def market(self, symbol: Str) -> Dict[str, Any]:
        """종목. `load_markets` 로 받은 종목에 있으면 그것을, 없으면 심볼 모양으로 만든 종목을 돌려준다. 시세와 주문 메서드와 같은 판별이라
        마스터 데이터 없이도 `amount_to_precision` 같은 도우미가 동작한다. 해외 종목은 마스터 데이터가 없으면 상장 거래소를 모르는 종목이 된다."""
        if symbol is None or (self.markets is not None and (symbol in self.markets or symbol in (self.markets_by_id or {}))):
            return super().market(symbol)
        return self._market_of(self._instrument_of(symbol))

    def _market_of(self, instrument: KisInstrument) -> Dict[str, Any]:
        """`load_markets()` 로 받은 종목이 있으면 그것을, 없으면 마스터 행(또는 모양)으로 종목을 만든다."""
        known = (self.markets or {}).get(instrument.symbol)
        if known is not None:
            return known
        master = self._master()
        if instrument.overseas:
            row = get_overseas_stock_by_code(master, instrument.code) or {'code': instrument.code, 'currency': 'USD'}
        else:
            row = get_krx_stock_by_code(master, instrument.code) or {'code': instrument.code}
        return self.parse_market(row)

    def _master(self) -> Dict[str, Any]:
        """이 인스턴스의 종목 마스터 데이터(`options['masterData']`). 넘기지 않았으면 빈 데이터다."""
        return master_data_of(self.options)

    def _resolve_kr_market(self, symbol: str) -> Optional[str]:
        """국내 종목의 코스피·코스닥 구분. 비동기 판의 `stockDirectory.find_kr_market` 은 코루틴을 돌려줘도 된다. 조회에 실패하면 `None` 이다."""
        try:
            return maybe_await(resolve_kr_market(symbol, self.options.get('stockDirectory'), self._master()))
        except Exception as err:
            logger.warning('[KrMarket] 종목 디렉터리 조회 실패 — 기본값(.KS/KOSPI) 사용 (symbol=%s, err=%s)', symbol, err)
            return None

    def _quote_market_division(self) -> str:
        """국내 시세 조회의 상품구분. `nxtRouting` 옵션이 켜져 있고 NXT 확장세션이면 통합(`UN`)으로 애프터마켓 시세를 받는다."""
        return 'UN' if is_nxt_extended_tradable() and self.is_option_enabled('nxtRouting') else 'J'

    # ============ 시세 ============

    def fetch_ticker(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """현재가. 호가(`bid`·`ask`)는 채우지 않는다. 현재가가 0 이거나 비어 있으면 `NullResponse` 를 던진다. 장 마감·지연시세·휴장에
        빈 값이 오는데, 0 을 현재가로 넘기면 호출하는 쪽의 손익이 -100% 로 보인다."""
        instrument = self._instrument_of(symbol)
        market = self._market_of(instrument)
        if instrument.overseas:
            if instrument.quote_exchange is None:
                raise BadSymbol(f'해외 마스터에 없는 ticker: {symbol}')
            response = self.private_get_uapi_overseas_price_v1_quotations_price(self.extend({
                'AUTH': '',
                'EXCD': instrument.quote_exchange,
                'SYMB': instrument.code,
                'tr_id': 'HHDFS00000300',
            }, params))
        else:
            response = self.private_get_uapi_domestic_stock_v1_quotations_inquire_price(self.extend({
                'FID_COND_MRKT_DIV_CODE': self._quote_market_division(),
                'FID_INPUT_ISCD': instrument.code,
                'tr_id': 'FHKST01010100',
            }, params))
        output = self.safe_dict(response, 'output', {})
        last = fn.js_number(self.safe_string(output, 'last' if instrument.overseas else 'stck_prpr'))
        if not math.isfinite(last) or last <= 0:
            raise NullResponse(f'{self.id} {symbol} 현재가가 0 이거나 비어 있다')
        return self.parse_ticker(output, market)

    def parse_ticker(self, ticker: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        timestamp = self.milliseconds()
        if market is not None and market.get('quote') == 'USD':
            last = self.safe_string(ticker, 'last')
            previous_close = self.safe_string(ticker, 'base') if Precise.string_gt(self.safe_string(ticker, 'base'), '0') else None
            return self.safe_ticker({
                'symbol': market['symbol'],
                'timestamp': timestamp,
                'datetime': self.iso8601(timestamp),
                'high': self.safe_string(ticker, 'high'),
                'low': self.safe_string(ticker, 'low'),
                'open': self.safe_string(ticker, 'open'),
                'close': last,
                'last': last,
                'previousClose': previous_close,
                # 절대 변동은 전일 종가로 구한다. 응답은 부호를 따로 주어 `diff` 를 그대로 쓰지 않는다.
                'change': Precise.string_sub(last, previous_close) if previous_close is not None else None,
                'percentage': self.safe_string(ticker, 'rate'),
                'baseVolume': self.safe_string(ticker, 'tvol'),
                'quoteVolume': self.safe_string(ticker, 'tamt'),
                'info': ticker,
            }, market)
        last = self.safe_string(ticker, 'stck_prpr')
        percentage = self.safe_string(ticker, 'prdy_ctrt')
        # 전일대비(`prdy_vrss`)는 부호가 없을 수 있어 등락률의 부호로 정한다. 보합(등락률 0)이면 변동도 0이다.
        change = _signed_change(self.safe_string(ticker, 'prdy_vrss'), percentage, self.safe_string(ticker, 'prdy_vrss_sign'))
        return self.safe_ticker({
            'symbol': None if market is None else market.get('symbol'),
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'high': self.safe_string(ticker, 'stck_hgpr'),
            'low': self.safe_string(ticker, 'stck_lwpr'),
            'open': self.safe_string(ticker, 'stck_oprc'),
            'close': last,
            'last': last,
            'previousClose': self.safe_string(ticker, 'stck_sdpr'),
            'change': change,
            'percentage': percentage,
            'baseVolume': self.safe_string(ticker, 'acml_vol'),
            'quoteVolume': self.safe_string(ticker, 'acml_tr_pbmn'),
            'info': ticker,
        }, market)

    def fetch_tickers(self, symbols: Strings = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """여러 종목의 현재가를 한 번에 받는다(`intstock-multprice`, 한 번에 30종목까지). 국내만 받는다. 이 API 는 NXT 통합(`UN`)을
        문서에 적어 두지 않아 `fetch_ticker` 와 달리 항상 KRX(`J`)로 묻는다."""
        if symbols is None or len(symbols) == 0:
            raise ArgumentsRequired(f'{self.id} fetchTickers() 는 symbols 인자가 필요하다')
        if len(symbols) > MULTI_TICKER_LIMIT:
            raise BadRequest(f'{self.id} fetchTickers() 는 한 번에 최대 {MULTI_TICKER_LIMIT}종목까지 지원한다: {len(symbols)}종목')
        instruments = []
        for symbol in symbols:
            instrument = self._instrument_of(symbol)
            if instrument.overseas:
                raise BadSymbol(f'{self.id} fetchTickers() 은 국내 종목만 지원한다: {symbol}')
            instruments.append(instrument)
        by_code = {instrument.code: instrument for instrument in instruments}
        request: Dict[str, Any] = {'tr_id': 'FHKST11300006'}
        for i, instrument in enumerate(instruments):
            request[f'FID_COND_MRKT_DIV_CODE_{i + 1}'] = 'J'
            request[f'FID_INPUT_ISCD_{i + 1}'] = instrument.code
        response = self.private_get_uapi_domestic_stock_v1_quotations_intstock_multprice(self.extend(request, params))
        result: Dict[str, Any] = {}
        for row in rows_of(self.safe_value(response, 'output')):
            instrument = by_code.get(self.safe_string(row, 'inter_shrn_iscd', ''))
            if instrument is None:
                continue
            market = self._market_of(instrument)
            result[market['symbol']] = self.parse_ticker({
                'stck_prpr': row.get('inter2_prpr'),
                'stck_hgpr': row.get('inter2_hgpr'),
                'stck_lwpr': row.get('inter2_lwpr'),
                'stck_oprc': row.get('inter2_oprc'),
                'stck_sdpr': row.get('inter2_sdpr'),
                'prdy_vrss': row.get('inter2_prdy_vrss'),
                'prdy_ctrt': row.get('prdy_ctrt'),
                'acml_vol': row.get('acml_vol'),
                'acml_tr_pbmn': row.get('acml_tr_pbmn'),
            }, market)
        return result

    def fetch_order_book(self, symbol: str, limit: Int = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """국내 호가 10단계(잔량 포함). 매수는 높은 가격부터, 매도는 낮은 가격부터다. 미국 종목은 받지 않는다. 호가가 없으면 `NullResponse`."""
        instrument = self._instrument_of(symbol)
        if instrument.overseas:
            raise NotSupported(f'{self.id} fetchOrderBook() 은 국내 종목만 지원한다: {symbol}')
        response = self.private_get_uapi_domestic_stock_v1_quotations_inquire_asking_price_exp_ccn(self.extend({
            'FID_COND_MRKT_DIV_CODE': self._quote_market_division(),
            'FID_INPUT_ISCD': instrument.code,
            'tr_id': 'FHKST01010200',
        }, params))
        output = self.safe_dict(response, 'output1', {})
        bids: List[List[float]] = []
        asks: List[List[float]] = []
        for level in range(1, 11):
            ask_price = fn.js_number(output[f'askp{level}']) if f'askp{level}' in output else math.nan
            if math.isfinite(ask_price) and ask_price > 0:
                asks.append([ask_price, to_number(output.get(f'askp_rsqn{level}'))])
            bid_price = fn.js_number(output[f'bidp{level}']) if f'bidp{level}' in output else math.nan
            if math.isfinite(bid_price) and bid_price > 0:
                bids.append([bid_price, to_number(output.get(f'bidp_rsqn{level}'))])
        if len(bids) == 0 and len(asks) == 0:
            raise NullResponse(f'{self.id} {symbol} 호가가 비어 있다')
        book = self.safe_order_book({'symbol': instrument.symbol, 'timestamp': self.milliseconds(), 'bids': bids, 'asks': asks})
        if limit is not None:
            book['bids'] = book['bids'][:limit]
            book['asks'] = book['asks'][:limit]
        return book

    def fetch_ohlcv(self, symbol: str, timeframe: str = '1d', since: Int = None, limit: Int = 100,
                    params: Optional[Dict[str, Any]] = None) -> List[List[Any]]:
        """봉. 국내는 항상 야후 파이낸스로 받는다(KIS 는 분봉이 당일뿐이고 일봉도 100행이다). 미국 일·주·월봉은 야후를 먼저 부르고,
        야후가 비거나 실패하면 KIS 로 다시 받는다. 둘 다 실패하면 던진다.

        `since <= 시각 <= params['until']` 인 봉을 ccxt 규칙대로 `limit` 개 준다(`since` 가 있으면 가장 이른 것부터, 없으면 가장 최근 것부터).
        `since` 가 없으면 야후의 타임프레임별 기본 기간(일봉 5년, 1분봉 1일 등) 안에서 고른다. 야후 분봉과 시간봉은 조회 폭 상한(1분봉 6일,
        5분봉~30분봉 59일, 시간봉 729일)보다 오래된 `since` 를 상한까지 줄여 받고 경고를 남긴다."""
        timeframe = '1d' if timeframe is None else timeframe
        limit = 100 if limit is None else limit
        instrument = self._instrument_of(symbol)
        until = self.safe_integer(params, 'until')
        # 코스피·코스닥 구분으로 야후 티커의 접미사(.KS·.KQ)를 맞게 붙인다.
        kr_market = self._resolve_kr_market(symbol)
        daily_like = timeframe in ('1d', '1w', '1W', '1M')
        # 폴백할 거래소. 자격증명이 없으면 KIS 로 폴백할 수 없다.
        fallback_exchange = (instrument.quote_exchange if instrument.overseas and daily_like and self.check_required_credentials(False)
                             else None)
        yahoo: List[List[Any]] = []
        yahoo_error: Optional[BaseException] = None
        try:
            yahoo = fetch_yahoo_candles(instrument.symbol, timeframe, limit, since, until, kr_market, exchange=self)
        except Exception as e:
            if fallback_exchange is None:
                raise
            yahoo_error = e
        if len(yahoo) > 0 or fallback_exchange is None:
            return yahoo
        logger.info('[kis] 야후가 비거나 실패해 KIS 해외 일봉으로 폴백한다 (symbol=%s, timeframe=%s, yahooError=%s)', symbol, timeframe, yahoo_error)
        native = self.candles().fetch_overseas_daily_ohlcv(instrument.code, fallback_exchange, timeframe, limit, since, until)
        if len(native) == 0 and yahoo_error is not None:
            raise yahoo_error
        return native

    def candles(self) -> KISCandleService:
        """KIS 가 직접 주는 봉(일봉·당일 분봉·해외 일봉)과 깊은 이력 페이지 조회. `fetch_ohlcv` 는 미국 일봉 폴백에만 이 경로를 쓴다."""
        if self._candle_service is None:
            self._candle_service = KISCandleService(self)
        return self._candle_service

    # ============ 수수료 ============

    def fetch_trading_fee(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """수수료율. 국내 위탁수수료 0.015%(계좌 유형과 할인에 따라 다르다), 미국 0.25%다. 요율을 알려 주는 API 가 없어 표를 쓴다.
        국내 매도에는 증권거래세가 더해진다. 세율은 시행일 표(`krx_sell_tax`)를 따르며 `info['sellTaxRate']` 에 있다."""
        instrument = self._instrument_of(symbol)
        rate = KIS_OVERSEAS_DEFAULT_FEE_RATE if instrument.overseas else KIS_BROKERAGE_FEE
        return {
            'info': {'brokerageRate': rate, 'sellTaxRate': 0 if instrument.overseas else krx_sell_tax_rate()},
            'symbol': instrument.symbol,
            'maker': rate,
            'taker': rate,
            'percentage': True,
            'tierBased': False,
        }

    # ============ 고유 조회 ============

    def fetch_stock_warnings(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """변동성완화장치(VI) 발동 현황(`inquire-vi-status`). 오늘(한국 날짜) 이 종목의 VI 가 발동한 기록이다. `params.until` 은 읽지 않는다.
        발동한 적이 없으면 빈 목록이다. 국내만 받는다."""
        instrument = self._instrument_of(symbol)
        if instrument.overseas:
            raise BadSymbol(f'{self.id} fetchStockWarnings() 은 국내 종목만 지원한다: {symbol}')
        response = self.private_get_uapi_domestic_stock_v1_quotations_inquire_vi_status(self.extend({
            'FID_DIV_CLS_CODE': '0',
            'FID_COND_SCR_DIV_CODE': VI_STATUS_SCREEN_CODE,
            'FID_MRKT_CLS_CODE': '0',
            'FID_INPUT_ISCD': instrument.code,
            'FID_RANK_SORT_CLS_CODE': '0',
            'FID_INPUT_DATE_1': kst_ymd(self.milliseconds()),
            'FID_TRGT_CLS_CODE': '',
            'FID_TRGT_EXLS_CLS_CODE': '',
            'tr_id': 'FHPST01390000',
        }, params))
        return [self.extend(self.kst_stamp(self.safe_string(row, 'bsop_date')), {
            'businessDate': self.safe_string(row, 'bsop_date', ''),
            'statusCode': self.safe_string(row, 'vi_cls_code', ''),
            'kindCode': self.safe_string(row, 'vi_kind_code', ''),
            'triggeredAt': _or_none(self.safe_string(row, 'cntg_vi_hour')),
            'canceledAt': _or_none(self.safe_string(row, 'vi_cncl_hour')),
            'price': self.safe_number(row, 'vi_prc'),
            'count': self.safe_number(row, 'vi_count'),
            'info': row,
        }) for row in multi_rows_of(self.safe_value(response, 'output'))]

    def fetch_investor_trading(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """종목의 투자자별(개인·외국인·기관계) 매매동향(`inquire-investor`)을 최근 영업일 순으로 돌려준다. 국내만 받는다.
        당일 값은 장 종료 뒤에 채워진다. 토스증권의 같은 이름 메서드는 시장 단위라서 범위가 다르다."""
        instrument = self._instrument_of(symbol)
        if instrument.overseas:
            raise BadSymbol(f'{self.id} fetchInvestorTrading() 은 국내 종목만 지원한다: {symbol}')
        response = self.private_get_uapi_domestic_stock_v1_quotations_inquire_investor(self.extend({
            'FID_COND_MRKT_DIV_CODE': 'J',
            'FID_INPUT_ISCD': instrument.code,
            'tr_id': 'FHKST01010900',
        }, params))

        def amounts(row: Dict[str, Any], prefix: str) -> Dict[str, Any]:
            return {
                'netBuyVolume': self.safe_number(row, f'{prefix}_ntby_qty'),
                'netBuyAmount': self.safe_number(row, f'{prefix}_ntby_tr_pbmn'),
                'buyVolume': self.safe_number(row, f'{prefix}_shnu_vol'),
                'buyAmount': self.safe_number(row, f'{prefix}_shnu_tr_pbmn'),
                'sellVolume': self.safe_number(row, f'{prefix}_seln_vol'),
                'sellAmount': self.safe_number(row, f'{prefix}_seln_tr_pbmn'),
            }

        return [self.extend(self.kst_stamp(self.safe_string(row, 'stck_bsop_date')), {
            'businessDate': self.safe_string(row, 'stck_bsop_date', ''),
            'close': self.safe_number(row, 'stck_clpr'),
            'change': self.safe_number(row, 'prdy_vrss'),
            'changeSign': _or_none(self.safe_string(row, 'prdy_vrss_sign')),
            'individual': amounts(row, 'prsn'),
            'foreign': amounts(row, 'frgn'),
            'institution': amounts(row, 'orgn'),
            'info': row,
        }) for row in multi_rows_of(self.safe_value(response, 'output'))]

    def fetch_rankings(self, type: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """종목 순위. 국내 순위, 해외 순위(`OVERSEAS_*`, `params['exchange']` 로 거래소를 반드시 고른다), ELW 순위(`ELW_*`)를 받는다.
        공통 필드(순위, 심볼, 이름, 현재가, 전일대비, 등락률, 누적거래량)로 정리하고 종류별 지표는 `info` 에 원문으로 둔다.
        응답에 순위 필드가 없는 종류는 `rank` 를 비운다. KIS 는 순위에도 연속조회를 쓰지만 첫 페이지만 돌려준다."""
        params = {} if params is None else params
        if type == 'FLUCTUATION':
            return self._fetch_fluctuation_ranking(params)
        if type == 'VOLUME':
            return self._fetch_volume_ranking(params)
        spec = KIS_RANKING_SPECS.get(type) if isinstance(type, str) else None
        if spec is None:
            raise NotSupported(f'{self.id} fetchRankings() 는 {_tpl(type)} 랭킹을 지원하지 않는다')
        return self._fetch_spec_ranking(spec, params)

    def _fetch_spec_ranking(self, spec: Dict[str, Any], params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """표(`KIS_RANKING_SPECS`)로 정의한 순위 하나를 부른다."""
        prepare = spec.get('prepare')
        prepared = prepare(params) if prepare is not None else params
        call = getattr(self, _implicit_get(spec['path']))
        request = self.extend(spec['params'](self.milliseconds()), {'tr_id': spec['trId']})
        response = call(self.extend(request, prepared))
        f = spec.get('fields') or {}
        overseas = bool(spec.get('overseas'))
        currency = _tpl(KIS_OVERSEAS_RANKING_EXCHANGES.get(fn.js_string(prepared.get('EXCD')))) if overseas else 'KRW'

        def symbol_of(row: Dict[str, Any]) -> str:
            # 해외 슬래시 티커(`BRK/B`)는 다른 메서드처럼 점 심볼(`BRK.B/USD`)로 옮긴다.
            code = self.safe_string(row, spec['symbolKey'], '')
            return f"{code.replace('/', '.', 1) if overseas else code}/{currency}"

        return [{
            'rank': self.safe_number(row, f.get('rank', 'data_rank')),
            'symbol': symbol_of(row),
            'name': _or_none(self.safe_string(row, f.get('name', 'hts_kor_isnm'))),
            'last': self.safe_number(row, f.get('price', 'stck_prpr')),
            'change': self.safe_number(row, f.get('change', 'prdy_vrss')),
            'percentage': self.safe_number(row, f.get('rate', 'prdy_ctrt')),
            'volume': self.safe_number(row, f.get('volume', 'acml_vol')),
            'info': row,
        } for row in rows_of(self.safe_value(response, spec.get('rowsKey', 'output')))]

    def _ranking_rows(self, response: Any, symbol_key: str) -> List[Dict[str, Any]]:
        return [{
            'rank': self.safe_number(row, 'data_rank'),
            'symbol': f"{self.safe_string(row, symbol_key, '')}/KRW",
            'name': _or_none(self.safe_string(row, 'hts_kor_isnm')),
            'last': self.safe_number(row, 'stck_prpr'),
            'change': self.safe_number(row, 'prdy_vrss'),
            'percentage': self.safe_number(row, 'prdy_ctrt'),
            'volume': self.safe_number(row, 'acml_vol'),
            'info': row,
        } for row in rows_of(self.safe_value(response, 'output'))]

    def _fetch_fluctuation_ranking(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """등락률 순위(`ranking/fluctuation`). 정렬 방향 코드는 공식 문서에 뚜렷하지 않아 예제가 쓴 값(`'0'`)만 기본으로 쓴다."""
        response = self.private_get_uapi_domestic_stock_v1_ranking_fluctuation(self.extend({
            'fid_rsfl_rate2': '',
            'fid_cond_mrkt_div_code': 'J',
            'fid_cond_scr_div_code': '20170',
            'fid_input_iscd': '0000',
            'fid_rank_sort_cls_code': '0',
            'fid_input_cnt_1': '0',
            'fid_prc_cls_code': '0',
            'fid_input_price_1': '',
            'fid_input_price_2': '',
            'fid_vol_cnt': '',
            'fid_trgt_cls_code': '0',
            'fid_trgt_exls_cls_code': '0',
            'fid_div_cls_code': '0',
            'fid_rsfl_rate1': '',
            'tr_id': 'FHPST01700000',
        }, params))
        return self._ranking_rows(response, 'stck_shrn_iscd')

    def _fetch_volume_ranking(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """거래량 순위(`quotations/volume-rank`)."""
        response = self.private_get_uapi_domestic_stock_v1_quotations_volume_rank(self.extend({
            'FID_COND_MRKT_DIV_CODE': 'J',
            'FID_COND_SCR_DIV_CODE': '20171',
            'FID_INPUT_ISCD': '0000',
            'FID_DIV_CLS_CODE': '0',
            'FID_BLNG_CLS_CODE': '0',
            'FID_TRGT_CLS_CODE': '111111111',
            'FID_TRGT_EXLS_CLS_CODE': '0000000000',
            'FID_INPUT_PRICE_1': '0',
            'FID_INPUT_PRICE_2': '0',
            'FID_VOL_CNT': '0',
            'FID_INPUT_DATE_1': '0',
            'tr_id': 'FHPST01710000',
        }, params))
        return self._ranking_rows(response, 'mksc_shrn_iscd')

    # ============ 휴장일 ============

    def fetch_market_calendar(self, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """국내 휴장일 캘린더(`chk-holiday`). 기준일부터 이후 날짜의 개장·영업·거래·결제 여부를 준다. 실전 계좌에서만 쓸 수 있다.
        지난 영업일을 세는 코드가 지난 연휴를 알도록 30일 전 기준일과 오늘 기준일을 함께 조회한다. KIS 는 하루 한 번 호출을 권한다."""
        if self.isSandboxModeEnabled:
            raise NotSupported(f'{self.id} 휴장일 조회(chk-holiday)는 실전 계좌에서만 쓸 수 있다')
        now = self.milliseconds()
        days: Dict[str, Dict[str, Any]] = {}
        for base in (kst_ymd(now - HOLIDAY_LOOKBACK_MS), kst_ymd(now)):
            response = self.private_get_uapi_domestic_stock_v1_quotations_chk_holiday(self.extend({
                'BASS_DT': base,
                'CTX_AREA_FK': '',
                'CTX_AREA_NK': '',
                'tr_id': 'CTCA0903R',
            }, params))
            rows = _field(response, 'output')
            for row in (rows if isinstance(rows, list) else [rows]):
                date = self.safe_string(row, 'bass_dt')
                open_ = self.safe_string(row, 'opnd_yn')
                if date is None or open_ is None:
                    continue
                days[date] = self.extend(self.kst_stamp(date), {
                    'date': date,
                    'open': open_ == 'Y',
                    'business': self.safe_string(row, 'bzdy_yn') == 'Y',
                    'trading': self.safe_string(row, 'tr_day_yn') == 'Y',
                    'settlement': self.safe_string(row, 'sttl_day_yn') == 'Y',
                    'info': row,
                })
        return list(days.values())

    def refresh_market_calendar(self) -> bool:
        """휴장일 캘린더를 공용 캘린더(`market_calendar`)에 넣는다. 장 시간 판정이 이 값을 읽는다. 12시간 안에 성공한 호출은 다시 하지 않는다.
        국내 실주문 직전에 저절로 부른다. 장 시간 판정을 주문 밖에서 쓰면 시작할 때 한 번 직접 부른다.

        한 번이라도 받은 캘린더가 있으면 `True` 다(이번 호출이 실패했으면 낡았을 수 있다). 자격증명이 없거나 모의투자면 부르지 않고
        `False` 다. 호출에 실패해도 던지지 않는다.
        """
        if self.isSandboxModeEnabled or not self.check_required_credentials(False):
            return False

        def fetch_days() -> List[Dict[str, Any]]:
            return [{'date': day['date'], 'open': day['open']} for day in self.fetch_market_calendar()]

        return refresh_shared_market_calendar('KR', fetch_days, CALENDAR_TTL_MS)

    # ============ 잔고 ============

    def _account_params(self) -> Dict[str, str]:
        parts = (self.uid if self.uid is not None else '').split('-')
        suffix = parts[1] if len(parts) > 1 else None
        return {'CANO': parts[0], 'ACNT_PRDT_CD': suffix if suffix else KIS_DEFAULT_ACCOUNT_SUFFIX}

    def fetch_balance(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """잔고. 현금은 통화 키(`KRW`, `USD`), 보유 종목은 종목코드(국내 `005930`, 미국 `AAPL`) 키이고 종목의 `total` 이 보유 수량이다.
        평가금액·평균단가 같은 KIS 고유 값은 각 항목의 `info` 에 있다. 조회가 하나라도 실패하면 던진다(빈 잔고와 구분한다).

        `params['scope']` 로 읽을 범위를 좁힌다. 기본은 전부(`'all'`)이고 목록으로 골라도 된다.
        `'kr'` 는 국내 잔고(`KRW` 와 국내 보유 종목), `'us'` 는 미국 보유 종목(실전은 `NASD` 한 번이 미국 전체이고 모의는 거래소마다 부른다),
        `'usd'` 는 달러 예수금과 평가금액(`USD`)이다. `params['orderable']` 이 `False` 가 아니면 국내 주문가능현금을 한 번 더 조회해
        `KRW` 의 `free` 로 쓴다. 원본 응답은 `info` 에 `{'domestic', 'overseas', 'usd'}` 로 담는다.
        """
        scope = self.safe_value(params, 'scope', 'all')
        # 모르는 범위를 조용히 건너뛰면 요청 없이 빈 잔고가 나온다.
        scopes = list(scope) if isinstance(scope, (list, tuple)) else [scope]
        if not scopes or any(name not in ('all', 'kr', 'us', 'usd') for name in scopes):
            raise BadRequest(f"{self.id} fetchBalance() params.scope 는 'all', 'kr', 'us', 'usd' 또는 그 목록이다: {scope!r}")

        def wants(name: str) -> bool:
            return 'all' in scopes or name in scopes

        orderable = self.safe_bool(params, 'orderable', True)
        raw: Dict[str, Any] = {}
        if wants('kr'):
            raw['domestic'] = self._fetch_domestic_balance_raw(orderable)
        if wants('us'):
            raw['overseas'] = self._fetch_overseas_holdings_raw()
        if wants('usd'):
            raw['usd'] = self._fetch_present_balance_raw()
        return self.parse_balance(raw)

    def _fetch_domestic_balance_raw(self, orderable: bool) -> Dict[str, Any]:
        pages = self._fetch_all_pages(self.private_get_uapi_domestic_stock_v1_trading_inquire_balance, self.extend(self._account_params(), {
            'AFHR_FLPR_YN': 'N',
            'OFL_YN': '',
            'INQR_DVSN': '02',
            'UNPR_DVSN': '01',
            'FUND_STTL_ICLD_YN': 'N',
            'FNCG_AMT_AUTO_RDPT_YN': 'N',
            'PRCS_DVSN': '01',
            'CTX_AREA_FK100': '',
            'CTX_AREA_NK100': '',
            'tr_id': self.tr('TTTC8434R'),
        }), ['CTX_AREA_FK100', 'CTX_AREA_NK100'])
        # 합계(`output2`)는 계좌 전체 값이라 첫 쪽 것을 쓴다. 쪽마다 같은 값이 온다는 것은 추정이다.
        raw: Dict[str, Any] = {
            'holdings': [row for page in pages for row in rows_of(_field(page, 'output1'))],
            'summary': first_row(_field(pages[0], 'output2')),
        }
        if orderable:
            # 주문가능금액은 잔고 응답이 아니라 매수가능조회의 `ord_psbl_cash` 를 쓴다. 시장가(`01`)로 물으면 종목 증거금율이 반영된다.
            psbl = self.private_get_uapi_domestic_stock_v1_trading_inquire_psbl_order(self.extend(self._account_params(), {
                'PDNO': self.safe_string(self.options, 'orderableProbeCode', '005930'),
                'ORD_UNPR': '0',
                'ORD_DVSN': KIS_ORDER_TYPE['MARKET'],
                'CMA_EVLU_AMT_ICLD_YN': 'N',
                'OVRS_ICLD_YN': 'N',
                'tr_id': self.tr('TTTC8908R'),
            }))
            raw['orderable'] = first_row(_field(psbl, 'output'))
        return raw

    def _fetch_overseas_holdings_raw(self) -> Dict[str, Any]:
        """미국 보유 종목. 실전은 `NASD` 가 미국 전체라 한 번만 부르고, 모의는 `NASD`·`NYSE`·`AMEX` 를 차례로 부른다."""
        exchanges = ['NASD', 'NYSE', 'AMEX'] if self.isSandboxModeEnabled else ['NASD']
        holdings: List[Dict[str, Any]] = []
        for exchange in exchanges:
            pages = self._fetch_all_pages(self.private_get_uapi_overseas_stock_v1_trading_inquire_balance, self.extend(self._account_params(), {
                'OVRS_EXCG_CD': exchange,
                'TR_CRCY_CD': 'USD',
                'CTX_AREA_FK200': '',
                'CTX_AREA_NK200': '',
                'tr_id': self.tr('TTTS3012R'),
            }), ['CTX_AREA_FK200', 'CTX_AREA_NK200'])
            holdings.extend(row for page in pages for row in rows_of(_field(page, 'output1')))
        return {'holdings': holdings}

    def _fetch_present_balance_raw(self) -> Dict[str, Any]:
        response = self.private_get_uapi_overseas_stock_v1_trading_inquire_present_balance(self.extend(self._account_params(), {
            'WCRC_FRCR_DVSN_CD': KIS_PRESENT_BALANCE_PARAMS['WCRC_FRCR_DVSN_FOREIGN'],
            'NATN_CD': KIS_PRESENT_BALANCE_PARAMS['NATN_US'],
            'TR_MKET_CD': KIS_PRESENT_BALANCE_PARAMS['TR_MKET_ALL'],
            'INQR_DVSN_CD': KIS_PRESENT_BALANCE_PARAMS['INQR_DVSN_ALL'],
            'tr_id': self.tr('CTRP6504R'),
        }))
        return {'stocks': rows_of(_field(response, 'output1')), 'currencies': rows_of(_field(response, 'output2'))}

    def parse_balance(self, response: Any) -> Dict[str, Any]:
        """`fetch_balance` 가 모은 원본(`{'domestic', 'overseas', 'usd'}`)을 통합 잔고로 옮긴다.

        `KRW` 는 `total` 이 예수금총액(`dnca_tot_amt`), `free` 가 주문가능현금(`ord_psbl_cash`), `used` 가 둘의 차이(0 밑으로 내려가지 않는다)다.
        `USD` 는 `total` 이 예수금, `free` 가 예수금에서 미결제 매수증거금을 뺀 값이고, 종목 평가금액 합계는 `info['stockValue']` 에 있다.
        종목은 `total` 이 보유수량, `free` 가 주문가능수량(없으면 보유수량)이다. 같은 종목이 매매구분이나 대출일자별로 여러 행이면 수량을
        더하고, `info` 는 첫 행에 원문 행 전부(`rows`)를 더한 것이다.
        """
        result: Dict[str, Any] = {'info': response, 'timestamp': None, 'datetime': None}
        domestic = self.safe_dict(response, 'domestic')
        if domestic is not None:
            summary = self.safe_dict(domestic, 'summary', {})
            orderable = self.safe_dict(domestic, 'orderable')
            total = self.safe_string(summary, 'dnca_tot_amt')
            free = None if orderable is None else self.safe_string(orderable, 'ord_psbl_cash')
            used = None
            if free is not None and total is not None:
                used = _non_negative(Precise.string_sub(total, free))
            result['KRW'] = {'free': free, 'used': used, 'total': total, 'info': {'summary': summary, 'orderable': orderable}}
            for item in rows_of(domestic.get('holdings')):
                self._add_holding(result, item, 'pdno', 'hldg_qty')
        overseas = self.safe_dict(response, 'overseas')
        if overseas is not None:
            for item in rows_of(overseas.get('holdings')):
                self._add_holding(result, item, 'ovrs_pdno', 'ovrs_cblc_qty')
        usd = self.safe_dict(response, 'usd')
        if usd is not None:
            cash = next((row for row in rows_of(usd.get('currencies')) if self.safe_string(row, 'crcy_cd', '').upper() == 'USD'), None)
            cash = {} if cash is None else cash
            # 금액은 문자열로 더하고 뺀다. 부동소수로 빼면 `1000.1 - 200.2` 가 `799.9000000000001` 이 된다.
            deposit = self.safe_string(cash, 'frcr_dncl_amt_2', '0')
            buy_margin = self.safe_string(cash, 'frcr_buy_mgn_amt', '0')
            stock_value = '0'
            for row in rows_of(usd.get('stocks')):
                if self.safe_string(row, 'buy_crcy_cd', 'USD').upper() == 'USD':
                    stock_value = Precise.string_add(stock_value, self.safe_string(row, 'frcr_evlu_amt2', '0')) or stock_value
            free_usd = _non_negative(Precise.string_sub(deposit, buy_margin))
            result['USD'] = {
                'free': free_usd,
                'used': _non_negative(Precise.string_sub(deposit, free_usd)),
                'total': deposit,
                'info': {'deposit': to_number(deposit), 'buyMargin': to_number(buy_margin), 'stockValue': to_number(stock_value),
                         'currencies': usd.get('currencies'), 'stocks': usd.get('stocks')},
            }
        return self.safe_balance(result)

    def _add_holding(self, result: Dict[str, Any], item: Dict[str, Any], code_key: str, quantity_key: str) -> None:
        code = self.safe_string(item, code_key)
        quantity = self.safe_string(item, quantity_key)
        if code is None or quantity is None or not fn.js_number(quantity) > 0:
            return
        free = self.safe_string(item, 'ord_psbl_qty', quantity)
        current = result.get(code)
        if current is None:
            result[code] = {'free': free, 'used': None, 'total': quantity, 'info': self.extend(item, {'rows': [item]})}
        else:
            result[code] = {'free': Precise.string_add(current['free'], free), 'used': None, 'total': Precise.string_add(current['total'], quantity),
                            'info': self.extend(current['info'], {'rows': current['info']['rows'] + [item]})}

    # ============ 주문 ============

    def create_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None,
                     params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """주문. 수량은 정수 주로 내린다(소수점 매수는 받지 않는다). 거래시간 밖은 주문을 보내지 않고 `MarketClosed` 를 던진다.

        `params['session']` 은 `'regular'` 이나 `'nxt'` 다. 생략하면 `options['nxtRouting']` 과 NXT 확장세션 시각으로 정한다(국내).
        확장세션이면 종목이 NXT 에서 거래되는지 먼저 확인하고(실전만), 아니면 `MarketClosed` 를 던진다. 그 밖의 키는 요청 본문에 합친다.

        국내 시장가는 `ORD_DVSN=01`, 지정가는 `00` 이다. 미국은 지정가만 낼 수 있고 실전에서 `market` 을 주면 장마감지정가(LOC)로 낸다.
        두 경우 모두 미국은 `price` 가 필요하다. 응답은 접수 결과라 체결은 알 수 없다(`filled` 가 비어 있다). 체결은 `fetch_order`·`fetch_my_trades` 로 본다.
        """
        amount, price = fn.decimal_to_float(amount), fn.decimal_to_float(price)
        instrument = self._instrument_of(symbol)
        quantity = self._normalize_quantity(instrument, side, amount)
        if instrument.overseas:
            # 지정가·LOC 모두 단가가 필요하다. 시장가를 의도했다면 호출하는 쪽이 현재가로 지정가를 넣는다.
            if price is None or not price > 0:
                raise ArgumentsRequired('해외 지정가/LOC 주문은 price 필수 (시장가 의도면 현재가 기반 지정가 필요)')
            self.check_order_arguments(None, type, side, quantity, price, params)
            return self._create_overseas_order(instrument, type, side, quantity, price, params)
        self.check_order_arguments(None, type, side, quantity, price, params)
        return self._create_domestic_order(instrument, type, side, quantity, price, params)

    def _normalize_quantity(self, instrument: KisInstrument, side: str, requested: Any) -> int:
        """주문 수량을 정수 주로 맞춘다. 0 이하나 비정상은 던지고 소수는 내린다(내려서 0 이 되면 던진다). 소수 주문이 몰래 잘리면
        호출하는 쪽의 수량 계산이 어긋나므로 내린 사실을 경고로 남긴다."""
        if not fn.is_number(requested) or requested <= 0:
            raise InvalidOrder(f'{self.id} 주문 수량 비정상: {_tpl(requested)} ({instrument.symbol} {side})')
        floored = math.floor(requested)
        if floored <= 0:
            raise InvalidOrder(f'{self.id} 주문 수량 floor 후 0: {_tpl(requested)} → {floored} ({instrument.symbol} {side})')
        if floored != requested:
            logger.warning('[kis] 분수 주문을 내림한다 (단주 거래) requested=%s floored=%s symbol=%s side=%s', requested, floored,
                           instrument.symbol, side)
        return floored

    def _create_domestic_order(self, instrument: KisInstrument, type: str, side: str, quantity: int, price: Num,
                               params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        session = self.safe_string(params, 'session')
        if session is not None and session not in ('regular', 'nxt'):
            raise BadRequest(f"{self.id} createOrder() 의 params.session 은 'regular' 이나 'nxt' 여야 한다: {session}")
        params = self.omit(params, 'session')
        # 확장세션(NXT 프리 08:00~08:50, 애프터 15:30~20:00)은 정규장 게이트 대신 NXT 게이트를 거쳐 SOR 로 낸다. `nxtRouting` 이 꺼져 있으면 정규장 규칙이다.
        extended = session == 'nxt' or (session is None and self.is_option_enabled('nxtRouting') and is_nxt_extended_tradable())
        if extended:
            self._assert_nxt_session_open()
            self._assert_nxt_tradable(instrument)
        limit_price = price if type == 'limit' else None
        if not extended:
            self._assert_domestic_session_open(side)
        elif limit_price is None:
            limit_price = self._extended_session_limit_price(instrument.symbol, side)
        buy = side == 'buy'
        real_tr, demo_tr = DOMESTIC_ORDER_TR['extended' if extended else 'regular']['buy' if buy else 'sell']
        request = self.extend(self._account_params(), {
            'PDNO': instrument.code,
            'ORD_DVSN': KIS_ORDER_TYPE['LIMIT'] if limit_price is not None else KIS_ORDER_TYPE['MARKET'],
            'ORD_QTY': fn.js_string(quantity),
            'ORD_UNPR': fn.js_string(limit_price) if limit_price is not None else '0',
            'tr_id': self.tr(real_tr, demo_tr),
        })
        if extended:
            request['EXCG_ID_DVSN_CD'] = 'SOR'  # KIS 최선집행 라우팅. NXT 에서 체결될 수 있다
            request['SLL_TYPE'] = '' if buy else '01'  # 매도유형: 01 일반매도(매수는 공란)
            request['CNDT_PRIC'] = ''  # 조건가격(스톱지정가)은 쓰지 않는다
        response = self.private_post_uapi_domestic_stock_v1_trading_order_cash(self.extend(request, params))
        return self._accepted_order(response, self._market_of(instrument), 'limit' if limit_price is not None else 'market', side, quantity,
                                    limit_price)

    def create_trigger_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None, trigger_price: Num = None,
                             params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """스탑지정가(국내만). 같은 주문 엔드포인트(`order-cash`)에 조건가격(`CNDT_PRIC`)을 실어 보내면 KIS 가 스탑지정가로 처리한다.
        지정가만 받고 정규장 시간에만 낼 수 있다. 해외는 대응하는 API 를 찾지 못해 `NotSupported` 다."""
        amount, price, trigger_price = fn.decimal_to_float(amount), fn.decimal_to_float(price), fn.decimal_to_float(trigger_price)
        if trigger_price is None:
            raise ArgumentsRequired(f'{self.id} createTriggerOrder() 는 triggerPrice 인자가 필요하다')
        if price is None:
            raise ArgumentsRequired(f'{self.id} createTriggerOrder() 는 price 인자가 필요하다(스탑지정가는 지정가만 지원한다)')
        instrument = self._instrument_of(symbol)
        if instrument.overseas:
            raise NotSupported(f'{self.id} createTriggerOrder() 은 국내 종목만 지원한다: {symbol}')
        quantity = self._normalize_quantity(instrument, side, amount)
        self.check_order_arguments(None, type, side, quantity, price, params)
        self._assert_domestic_session_open(side)
        buy = side == 'buy'
        real_tr, demo_tr = DOMESTIC_ORDER_TR['extended']['buy' if buy else 'sell']
        request = self.extend(self._account_params(), {
            'PDNO': instrument.code,
            'ORD_DVSN': KIS_ORDER_TYPE['LIMIT'],
            'ORD_QTY': fn.js_string(quantity),
            'ORD_UNPR': fn.js_string(price),
            'EXCG_ID_DVSN_CD': 'KRX',
            'SLL_TYPE': '' if buy else '01',
            'CNDT_PRIC': fn.js_string(trigger_price),
            'tr_id': self.tr(real_tr, demo_tr),
        })
        response = self.private_post_uapi_domestic_stock_v1_trading_order_cash(self.extend(request, params))
        return self._accepted_order(response, self._market_of(instrument), 'limit', side, quantity, price)

    def _assert_nxt_tradable(self, instrument: KisInstrument) -> None:
        """확장세션(NXT) 주문 전에 종목정보(`search-stock-info`)로 이 종목이 NXT 에서 거래되는지 본다. NXT 거래 대상이 아니거나 NXT 에서
        거래정지면 KIS 가 거절하므로 보내지 않고 `MarketClosed` 를 던진다. 조회에 실패하거나 두 필드가 모두 없으면 막지 않는다(주문 응답이
        최종 판단이다). 종목정보 조회는 모의투자를 지원하지 않아 모의에서는 보지 않는다. 결과는 종목별로 캐시하고 실패는 캐시하지 않는다."""
        if self.isSandboxModeEnabled:
            return
        now = self.milliseconds()
        entry = self._nxt_eligibility.get(instrument.code)
        if entry is None or now - entry['at'] >= NXT_ELIGIBILITY_TTL_MS:
            try:
                response = self.private_get_uapi_domestic_stock_v1_quotations_search_stock_info({
                    'PRDT_TYPE_CD': STOCK_INFO_PRODUCT_TYPE,
                    'PDNO': instrument.code,
                    'tr_id': 'CTPF1002R',
                })
                output = self.safe_dict(response, 'output', {})
            except Exception:
                logger.warning('[kis] NXT 거래 가능 여부를 확인하지 못했다. 주문은 그대로 보낸다 (symbol=%s)', instrument.symbol, exc_info=True)
                return
            eligible = self.safe_string(output, 'cptt_trad_tr_psbl_yn')
            stopped = self.safe_string(output, 'nxt_tr_stop_yn')
            if eligible is None and stopped is None:
                logger.warning('[kis] 종목정보에 NXT 거래 여부 필드가 없다. 주문은 그대로 보낸다 (symbol=%s)', instrument.symbol)
                return
            blocked_reason = None
            if eligible == 'N':
                blocked_reason = 'NXT 거래 대상 종목이 아니다'
            elif stopped == 'Y':
                blocked_reason = 'NXT 거래정지 종목이다'
            entry = {'blockedReason': blocked_reason, 'at': now}
            self._nxt_eligibility[instrument.code] = entry
        if entry['blockedReason'] is not None:
            raise MarketClosed(f"NXT 확장시간 주문 불가: {entry['blockedReason']} ({instrument.symbol})")

    def _assert_nxt_session_open(self) -> None:
        """NXT 확장세션 게이트. 프리마켓, 메인마켓, 애프터마켓에만 낸다. 휴장일과 새벽, NXT 가 멈추는 시간(08:50~09:00, KRX 종가 동시호가
        15:20~15:30)은 막는다. 휴장일은 KIS 캘린더로 알아야 해서 먼저 받는다."""
        self.refresh_market_calendar()
        phase = get_nxt_session()
        if phase not in ('pre-market', 'main', 'after-market'):
            raise MarketClosed(f'NXT 거래시간 외 (session={phase})')

    def _assert_domestic_edit_open(self) -> None:
        """국내 정정 게이트. KRX 정규장과 NXT 확장세션이 모두 닫혀 있으면 막는다. 정정은 신규 진입이 아니라서 동시호가의 매수 제한은 걸지 않는다.
        원주문이 어느 시장에 걸려 있는지는 정정 요청에 없으므로 둘 중 하나라도 열려 있으면 보낸다."""
        self.refresh_market_calendar()
        hours = check_krx_trading_hours()
        if hours['tradable']:
            return
        phase = get_nxt_session()
        if phase in ('pre-market', 'main', 'after-market'):
            return
        raise MarketClosed(f"거래시간 외: {_tpl(hours.get('reason'))} (NXT session={phase})")

    def _assert_us_edit_open(self, exchange: str) -> None:
        """미국 정정 게이트. 주문과 같이 완전 마감(`closed`)만 막는다. 홍콩·일본·베트남은 대상이 아니다."""
        if exchange in US_ORDER_EXCHANGES and get_us_market_phase() == 'closed':
            raise MarketClosed(f'미국장 정규장 외 ({format_et_wall_clock()}, phase=closed)')

    def _assert_domestic_session_open(self, side: str) -> None:
        """국내 정규장 게이트. 휴장일은 KIS 캘린더로 알아야 해서 먼저 받는다. 종가 동시호가(15:20~15:30)의 신규 매수는 막는다."""
        self.refresh_market_calendar()
        hours = check_krx_trading_hours()
        if not hours['tradable']:
            raise MarketClosed(f"거래시간 외: {_tpl(hours.get('reason'))}")
        # 동시호가는 체결가가 예상과 크게 다를 수 있다. 청산(매도)은 진입보다 우선이라 막지 않는다.
        if get_krx_market_phase() == 'closing-auction' and side == 'buy':
            raise MarketClosed('종가 동시호가 (15:20-15:30) — 신규 매수 진입 금지')

    def _extended_session_limit_price(self, symbol: str, side: str) -> float:
        """확장세션 시장가를 지정가로 바꾸는 가격. 확장세션은 지정가만 받는다. 같은 방향 미체결이 있거나 기준가를 못 구하면 던진다.
        지정가를 지어내거나 호가를 겹쳐 쌓지 않기 위해서다."""
        conversion = build_extended_session_limit(
            self, {'symbol': symbol, 'side': side}, '[kis]',
            lambda err, message: logger.warning('%s (symbol=%s)', message, symbol, exc_info=err))
        error = conversion.get('error')
        if error is not None or conversion.get('price') is None:
            raise InvalidOrder(error if error is not None else 'NXT 확장시간: 지정가 산출 실패')
        logger.info('[kis] NXT 확장시간 — 시장가를 지정가로 전환 (symbol=%s, side=%s, price=%s)', symbol, side, conversion['price'])
        return conversion['price']

    def _create_overseas_order(self, instrument: KisInstrument, type: str, side: str, quantity: int, price: float,
                               params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        exchange = instrument.order_exchange
        if exchange is None:
            raise BadSymbol(f'해외 마스터에 없는 ticker: {instrument.symbol}')
        slot = OVERSEAS_ORDER_TR.get(exchange)
        if slot is None:
            raise NotSupported(f'미지원 거래소: {exchange}')
        # 미국장 세션 게이트. 완전 마감은 양방향 모두 막고(닫힌 시장의 매도도 체결될 수 없다) 종가 동시호가의 신규 매수도 막는다.
        # 홍콩·일본·베트남 같은 다른 해외 시장은 이 게이트의 대상이 아니다.
        if exchange in US_ORDER_EXCHANGES:
            phase = get_us_market_phase()
            if phase == 'closed':
                raise MarketClosed(f'미국장 정규장 외 ({format_et_wall_clock()}, phase=closed)')
            if phase == 'closing-auction' and side == 'buy':
                raise MarketClosed(f'종가 동시호가 (15:50-16:00 ET, {format_et_wall_clock()}) — 신규 매수 진입 금지')
        # 모의투자는 지정가만 받는다. 실전은 시장가 의도를 장마감지정가(LOC)로 낸다.
        ord_dvsn = KIS_OVERSEAS_ORD_DVSN['LOC'] if type == 'market' and not self.isSandboxModeEnabled else KIS_OVERSEAS_ORD_DVSN['LIMIT']
        buy = side == 'buy'
        request = self.extend(self._account_params(), {
            'OVRS_EXCG_CD': exchange,
            'PDNO': instrument.code,
            'ORD_QTY': fn.js_string(quantity),
            'OVRS_ORD_UNPR': fn.js_string(price),
            'CTAC_TLNO': '',
            'MGCO_APTM_ODNO': '',
            'SLL_TYPE': '' if buy else '00',
            'ORD_SVR_DVSN_CD': '0',
            'ORD_DVSN': ord_dvsn,
            'tr_id': self.tr('T' + (slot['buy'] if buy else slot['sell'])),
        })
        response = self.private_post_uapi_overseas_stock_v1_trading_order(self.extend(request, params))
        order_type = 'limit' if ord_dvsn == KIS_OVERSEAS_ORD_DVSN['LIMIT'] else 'market'
        return self._accepted_order(response, self._market_of(instrument), order_type, side, quantity, price)

    def _accepted_order(self, response: Any, market: Dict[str, Any], type: str, side: str, amount: float, price: Num) -> Dict[str, Any]:
        """주문 접수 응답을 주문으로 옮긴다. 접수 응답에는 체결 정보가 없어 요청값을 싣고 `filled` 는 비워 둔다."""
        output = self.safe_dict(response, 'output', {})
        if self.safe_string(output, 'ODNO') is None:
            logger.warning('[kis] 주문은 접수됐으나 응답에 주문번호(ODNO)가 없다 (response=%s)', response)
        parsed = self.parse_order(output, market)
        return self.safe_order(self.extend(parsed, {
            'symbol': market['symbol'],
            'type': type,
            'side': side,
            'price': price,
            'amount': amount,
            'status': 'open',
            'info': response,
        }), market)

    def cancel_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """주문 취소. 국내는 남은 수량 전체를 취소한다. 미국은 취소 수량이 필요해 미체결 조회에서 찾고, 모의투자처럼 조회할 수 없으면
        `params['amount']` 로 넘긴다. 이미 체결되거나 취소된 주문은 KIS 가 오류로 거절한다."""
        instrument = None if symbol is None else self._instrument_of(symbol)
        if instrument is not None and instrument.overseas:
            return self._cancel_overseas_order(id, instrument, params)
        response = self.private_post_uapi_domestic_stock_v1_trading_order_rvsecncl(self.extend(self.extend(self._account_params(), {
            'KRX_FWDG_ORD_ORGNO': self.safe_string(params, 'orderOrgNo', ''),
            'ORGN_ODNO': id,
            'ORD_DVSN': KIS_ORDER_TYPE['LIMIT'],
            'RVSE_CNCL_DVSN_CD': '02',  # 취소
            'ORD_QTY': '0',  # 전량
            'ORD_UNPR': '0',
            'QTY_ALL_ORD_YN': 'Y',
            'tr_id': self.tr('TTTC0803U'),
        }), self.omit(params, 'orderOrgNo')))
        logger.info('[kis] 주문 취소 성공 (orderId=%s, symbol=%s)', id, symbol)
        return self.safe_order({'id': id, 'symbol': None if instrument is None else instrument.symbol, 'status': 'canceled', 'info': response},
                               None if instrument is None else self._market_of(instrument))

    def _open_quantity(self, id: str, instrument: KisInstrument) -> str:
        """미체결 조회에서 찾은 주문의 남은 수량."""
        open_orders = self.fetch_open_orders(instrument.symbol)
        open_order = next((order for order in open_orders if order.get('id') == id), None)
        if open_order is None:
            raise OrderNotFound(f'{self.id} 미체결 해외 주문을 찾지 못했다: {id}')
        quantity = open_order.get('remaining')
        if quantity is None:
            quantity = open_order.get('amount')
        return self.number_to_string(0 if quantity is None else quantity)

    def _cancel_overseas_order(self, id: str, instrument: KisInstrument, params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        exchange = instrument.order_exchange
        if exchange is None:
            raise BadSymbol(f'해외 마스터에 없는 ticker: {instrument.symbol}')
        remaining = self.safe_string(params, 'amount')
        if remaining is None:
            if self.isSandboxModeEnabled:
                raise ArgumentsRequired(f'{self.id} 모의투자의 해외 주문 취소에는 params.amount(취소 수량)가 필요하다')
            remaining = self._open_quantity(id, instrument)
        response = self.private_post_uapi_overseas_stock_v1_trading_order_rvsecncl(self.extend(self.extend(self._account_params(), {
            'OVRS_EXCG_CD': exchange,
            'PDNO': instrument.code,
            'ORGN_ODNO': id,
            'RVSE_CNCL_DVSN_CD': '02',  # 취소
            'ORD_QTY': remaining,
            'OVRS_ORD_UNPR': '0',
            'MGCO_APTM_ODNO': '',
            'ORD_SVR_DVSN_CD': '0',
            'tr_id': self.tr('TTTT1004U'),
        }), self.omit(params, 'amount')))
        logger.info('[kis] 해외 주문 취소 성공 (orderId=%s, symbol=%s)', id, instrument.symbol)
        return self.safe_order({'id': id, 'symbol': instrument.symbol, 'status': 'canceled', 'info': response}, self._market_of(instrument))

    def edit_order(self, id: str, symbol: str, type: str, side: str, amount: Num = None, price: Num = None,
                   params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """정정. 취소와 같은 엔드포인트(`order-rvsecncl`)를 `RVSE_CNCL_DVSN_CD` 로 나눈다(`01` 정정, `02` 취소). `price` 가 필요하다.
        `amount` 를 주면 그 수량으로 일부 정정(`QTY_ALL_ORD_YN: 'N'`)하고, 주지 않으면 국내는 전량(`'Y'`)을 정정한다.
        국내는 KRX 정규장과 NXT 확장세션이 모두 닫혀 있으면, 미국은 완전 마감이면 `MarketClosed` 다."""
        amount, price = fn.decimal_to_float(amount), fn.decimal_to_float(price)
        if price is None:
            raise ArgumentsRequired(f'{self.id} editOrder() requires a price argument')
        instrument = self._instrument_of(symbol)
        if instrument.overseas:
            return self._edit_overseas_order(id, instrument, price, amount, params)
        self._assert_domestic_edit_open()
        response = self.private_post_uapi_domestic_stock_v1_trading_order_rvsecncl(self.extend(self.extend(self._account_params(), {
            'KRX_FWDG_ORD_ORGNO': self.safe_string(params, 'orderOrgNo', ''),
            'ORGN_ODNO': id,
            'ORD_DVSN': KIS_ORDER_TYPE['LIMIT'],
            'RVSE_CNCL_DVSN_CD': '01',  # 정정
            'ORD_QTY': '0' if amount is None else fn.js_string(amount),
            'ORD_UNPR': fn.js_string(price),
            'QTY_ALL_ORD_YN': 'Y' if amount is None else 'N',
            'tr_id': self.tr('TTTC0803U'),
        }), self.omit(params, 'orderOrgNo')))
        new_id = self.safe_string(self.safe_dict(response, 'output', {}), 'ODNO', id)
        logger.info('[kis] 주문 정정 성공 (orderId=%s, newOrderId=%s, symbol=%s, price=%s, amount=%s)', id, new_id, symbol, price, amount)
        return self.safe_order({
            'id': new_id, 'symbol': instrument.symbol, 'type': 'limit', 'price': price, 'amount': amount, 'status': 'open', 'info': response,
        }, self._market_of(instrument))

    def _edit_overseas_order(self, id: str, instrument: KisInstrument, price: float, amount: Num,
                             params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """해외 정정. 수량(`amount` 나 `params['amount']`)이 없으면 미체결 조회에서 잔량을 찾는다. 모의투자는 미체결 조회가 없어 반드시 넘긴다.
        공식 예제처럼 정정 요청에 실제 수량과 단가를 싣는다."""
        exchange = instrument.order_exchange
        if exchange is None:
            raise BadSymbol(f'해외 마스터에 없는 ticker: {instrument.symbol}')
        quantity = self.safe_string(params, 'amount')
        if quantity is None and amount is not None:
            quantity = self.number_to_string(amount)
        if quantity is None and self.isSandboxModeEnabled:
            raise ArgumentsRequired(f'{self.id} 모의투자의 해외 주문 정정에는 amount나 params.amount(정정 수량)가 필요하다')
        self._assert_us_edit_open(exchange)
        if quantity is None:
            quantity = self._open_quantity(id, instrument)
        response = self.private_post_uapi_overseas_stock_v1_trading_order_rvsecncl(self.extend(self.extend(self._account_params(), {
            'OVRS_EXCG_CD': exchange,
            'PDNO': instrument.code,
            'ORGN_ODNO': id,
            'RVSE_CNCL_DVSN_CD': '01',  # 정정
            'ORD_QTY': quantity,
            'OVRS_ORD_UNPR': fn.js_string(price),
            'MGCO_APTM_ODNO': '',
            'ORD_SVR_DVSN_CD': '0',
            'tr_id': self.tr('TTTT1004U'),
        }), self.omit(params, 'amount')))
        new_id = self.safe_string(self.safe_dict(response, 'output', {}), 'ODNO', id)
        logger.info('[kis] 해외 주문 정정 성공 (orderId=%s, newOrderId=%s, symbol=%s, price=%s, quantity=%s)', id, new_id, instrument.symbol,
                    price, quantity)
        return self.safe_order({
            'id': new_id, 'symbol': instrument.symbol, 'type': 'limit', 'price': price, 'amount': fn.js_number(quantity), 'status': 'open',
            'info': response,
        }, self._market_of(instrument))

    def cancel_all_orders(self, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """미체결 주문을 모두 취소한다. 종목을 주면 그 종목만이다. 하나라도 취소하지 못하면 나머지를 다 시도한 뒤 첫 실패를 던진다.
        살아 있을 수 있는 주문을 성공으로 돌려주지 않기 위해서다. TypeScript 판은 동시에 보내고 이 판은 같은 순서로 차례로 보낸다.
        국내 취소에는 공식 예제처럼 미체결 행의 주문채번지점번호(`ord_gno_brno`)를 원주문 조직번호로 싣는다."""
        open_orders = self.fetch_open_orders(symbol, None, None, params)
        results: List[Dict[str, Any]] = []
        first_error: Optional[BaseException] = None
        for order in open_orders:
            try:
                results.append(self.cancel_order(order['id'], order.get('symbol'), self._cancel_params_of(order)))
            except Exception as error:
                if first_error is None:
                    first_error = error
        if first_error is not None:
            raise first_error
        return results

    def _cancel_params_of(self, order: Dict[str, Any]) -> Dict[str, Any]:
        """`cancel_all_orders` 가 미체결 주문 하나를 취소할 때의 `params`. 해외 취소 요청에는 조직번호가 없어 아무것도 싣지 않는다."""
        org_no = self.safe_string(order.get('info'), 'ord_gno_brno')
        symbol = order.get('symbol')
        overseas = symbol is not None and self._instrument_of(symbol).overseas
        return {} if org_no is None or overseas else {'orderOrgNo': org_no}

    # ============ 주문·체결 조회 ============

    def fetch_open_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                          params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """미체결 주문. 국내는 정정취소가능 주문 조회(`inquire-psbl-rvsecncl`), 미국은 미체결 내역(`inquire-nccs`)이다. 종목을 주면 그 시장만,
        주지 않으면 국내와 미국을 모두 본다(`params['market']` 이 `'domestic'` 이면 국내만). 모의투자는 미국 미체결 조회가 없어 국내만 본다."""
        instrument = None if symbol is None else self._instrument_of(symbol)
        which = self.safe_string(params, 'market', 'all')
        want_domestic = which != 'overseas' if instrument is None else not instrument.overseas
        # 모의투자에는 미국 미체결 조회(TR)가 없다.
        want_overseas = which != 'domestic' and not self.isSandboxModeEnabled if instrument is None else instrument.overseas
        orders: List[Dict[str, Any]] = []
        if want_domestic:
            pages = self._fetch_all_pages(self.private_get_uapi_domestic_stock_v1_trading_inquire_psbl_rvsecncl, self.extend(self._account_params(), {
                'CTX_AREA_FK100': '',
                'CTX_AREA_NK100': '',
                'INQR_DVSN_1': '0',
                'INQR_DVSN_2': '0',
                # 실전만 신형 TR 이 있다. 모의는 종전 TR 을 그대로 쓴다.
                'tr_id': self.tr('TTTC0084R', 'VTTC8036R'),
            }), ['CTX_AREA_FK100', 'CTX_AREA_NK100'])
            market = None if instrument is None else self._market_of(instrument)
            rows = [row for page in pages for row in rows_of(_field(page, 'output'))]
            orders.extend(self._mark_open(order) for order in self.parse_orders(rows, market))
        if want_overseas:
            pages = self._fetch_all_pages(self.private_get_uapi_overseas_stock_v1_trading_inquire_nccs, self.extend(self._account_params(), {
                'OVRS_EXCG_CD': 'NASD',
                'SORT_SQN': 'DS',
                'CTX_AREA_FK200': '',
                'CTX_AREA_NK200': '',
                'tr_id': self.tr('TTTS3018R', None),
            }), ['CTX_AREA_FK200', 'CTX_AREA_NK200'])
            rows = [row for page in pages for row in rows_of(_field(page, 'output'))]
            orders.extend(self._mark_open(order) for order in self.parse_orders(rows))
        filtered = orders if instrument is None else [order for order in orders if order.get('symbol') == instrument.symbol]
        return self.filter_by_since_limit(filtered, since, limit)

    def _mark_open(self, order: Dict[str, Any]) -> Dict[str, Any]:
        """미체결 조회의 행은 모두 살아 있는 주문이다. 응답에 취소 여부가 없어 상태를 정하지 못했으면 `open` 으로 둔다."""
        return self.extend(order, {'status': 'open'}) if order.get('status') is None else order

    def fetch_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                     params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """당일(또는 `since` 일부터)의 주문 전체(체결·미체결·취소). 국내는 일별주문체결조회(`inquire-daily-ccld`), 미국은 주문체결내역(`inquire-ccnl`)이다.
        종목을 주면 그 시장만, 주지 않으면 국내와 미국을 모두 조회한다(`params['market']` 으로 좁힌다)."""
        instrument = None if symbol is None else self._instrument_of(symbol)
        which = self.safe_string(params, 'market', 'all')
        orders: List[Dict[str, Any]] = []
        if (which != 'overseas') if instrument is None else not instrument.overseas:
            code = None if instrument is None else instrument.code
            orders.extend(self.parse_orders(self._fetch_domestic_ccld_rows(code, since, '00', self.safe_string(params, 'orderId'))))
        if (which != 'domestic') if instrument is None else instrument.overseas:
            orders.extend(self.parse_orders(self._fetch_overseas_ccld_rows(since, '00')))
        filtered = orders if instrument is None else [order for order in orders if order.get('symbol') == instrument.symbol]
        return self.filter_by_since_limit(filtered, since, limit)

    def fetch_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """주문 하나. 오늘(또는 `params['since']` 일부터)의 주문 목록에서 찾고 없으면 `OrderNotFound` 다. 국내는 주문번호로 좁혀 조회한다."""
        orders = self.fetch_orders(symbol, self.safe_integer(params, 'since'), None, self.extend(params, {'orderId': id}))
        order = next((candidate for candidate in orders if candidate.get('id') == id), None)
        if order is None:
            raise OrderNotFound(f'{self.id} 주문을 찾지 못했다: {id}')
        return order

    def fetch_my_trades(self, symbol: Str = None, since: Int = None, limit: Int = None,
                        params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """내 체결 내역. 종목을 주면 그 시장만, 주지 않으면 국내와 미국을 모두 조회한다(`params['market']` 으로 좁힌다). 체결별 수수료는
        응답에 없어 비어 있다.

        일별주문체결 조회라 주문 하나가 거래 하나다. 수량과 가격은 누적 체결 수량과 평균가이고, 시각은 주문 시각이다(응답에 체결 시각이 없다).
        체결이 늘면 같은 id 의 거래가 더 큰 수량으로 다시 나오므로 거래를 쌓는 쪽은 id 로 덮어써야 한다. `since` 는 조회 시작일로만 쓰고 시각으로
        거르지 않는다(주문 시각으로 거르면 `since` 앞에 낸 주문이 그 뒤에 체결된 것이 빠진다). 일자는 국내가 한국 날짜, 미국이 현지(ET) 날짜다."""
        instrument = None if symbol is None else self._instrument_of(symbol)
        which = self.safe_string(params, 'market', 'all')
        trades: List[Dict[str, Any]] = []
        if (which != 'overseas') if instrument is None else not instrument.overseas:
            code = None if instrument is None else instrument.code
            trades.extend(self.parse_trades(self._fetch_domestic_ccld_rows(code, since, '01')))
        if (which != 'domestic') if instrument is None else instrument.overseas:
            trades.extend(self.parse_trades(self._fetch_overseas_ccld_rows(since, '01')))
        filtered = trades if instrument is None else [trade for trade in trades if trade.get('symbol') == instrument.symbol]
        return self.filter_by_since_limit(filtered, None, limit)

    def _fetch_domestic_ccld_rows(self, code: Str, since: Int, ccld: str, order_id: Str = None) -> List[Dict[str, Any]]:
        """국내 일별주문체결 행. `ccld` 는 `'00'` 전체, `'01'` 체결, `'02'` 미체결이다. 조회일은 한국 달력 날짜다(UTC 로 잡으면 한국 0~9시에
        전날을 조회한다). 거래소 구분은 `ALL` 로 KRX·NXT·SOR 체결을 모두 본다."""
        now = self.milliseconds()
        pages = self._fetch_all_pages(self.private_get_uapi_domestic_stock_v1_trading_inquire_daily_ccld, self.extend(self._account_params(), {
            'INQR_STRT_DT': kst_ymd(since if since is not None else now),
            'INQR_END_DT': kst_ymd(now),
            'SLL_BUY_DVSN_CD': '00',
            'INQR_DVSN': '00',
            'PDNO': code if code is not None else '',
            'CCLD_DVSN': ccld,
            'ORD_GNO_BRNO': '',
            'ODNO': order_id if order_id is not None else '',
            'INQR_DVSN_3': '00',
            'INQR_DVSN_1': '',
            'CTX_AREA_FK100': '',
            'CTX_AREA_NK100': '',
            'EXCG_ID_DVSN_CD': 'ALL',
            'tr_id': self.tr('TTTC0081R'),
        }), ['CTX_AREA_FK100', 'CTX_AREA_NK100'])
        rows = [row for page in pages for row in rows_of(_field(page, 'output1'))]
        if ccld != '01':
            return rows
        return [row for row in rows if to_number(row.get('tot_ccld_qty') if row.get('tot_ccld_qty') is not None else row.get('cntg_qty')) > 0]

    def _fetch_overseas_ccld_rows(self, since: Int, ccld: str) -> List[Dict[str, Any]]:
        """미국 주문체결내역 행(`TTTS3035R`, 모의 `VTTS3035R`). 실전은 `NASD` 한 번이 미국 전체다. 모의투자는 종목·구분·거래소를 비워
        전체 조회만 되므로 체결 여부는 응답의 체결수량으로 거른다. 일자는 현지(ET) 날짜다. 주문번호로는 찾을 수 없어 호출하는 쪽이 거른다."""
        now = self.milliseconds()
        sandbox = self.isSandboxModeEnabled
        pages = self._fetch_all_pages(self.private_get_uapi_overseas_stock_v1_trading_inquire_ccnl, self.extend(self._account_params(), {
            'PDNO': '' if sandbox else '%',
            'ORD_STRT_DT': et_ymd(since if since is not None else now),
            'ORD_END_DT': et_ymd(now),
            'SLL_BUY_DVSN': '00',
            'CCLD_NCCS_DVSN': '00' if sandbox else ccld,
            'OVRS_EXCG_CD': '' if sandbox else 'NASD',
            'SORT_SQN': 'DS',
            'ORD_DT': '',
            'ORD_GNO_BRNO': '',
            'ODNO': '',
            'CTX_AREA_NK200': '',
            'CTX_AREA_FK200': '',
            'tr_id': self.tr('TTTS3035R'),
        }), ['CTX_AREA_NK200', 'CTX_AREA_FK200'])
        rows = [row for page in pages for row in rows_of(_field(page, 'output'))]
        return [row for row in rows if to_number(row.get('ft_ccld_qty')) > 0] if ccld == '01' else rows

    def parse_order(self, order: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """주문 행(접수 응답, 정정취소가능·일별체결·해외 체결·미체결 조회)을 주문으로 옮긴다. 접수 응답은 대문자 키(`ODNO`)이고 조회 행은
        소문자 키(`odno`)다. 해외 행은 `ft_` 접두 필드를 쓴다."""
        order_id = self.safe_string_2(order, 'ODNO', 'odno')
        overseas = 'ft_ord_qty' in order or (market is not None and market.get('quote') == 'USD')
        code = self.safe_string_2(order, 'pdno', 'ovrs_pdno')
        if code is not None and (market is None or market.get('id') != code):
            market = self._market_of(self._instrument_of(code))
        side_code = self.safe_string(order, 'sll_buy_dvsn_cd')
        dvsn = self.safe_string(order, 'ord_dvsn_cd')
        amount = filled = remaining = price = average = cost = status = None
        timestamp: Int = None
        if 'ODNO' in order:
            # 접수 응답은 주문번호와 접수 시각(한국 시각)만 있다. 나머지는 호출한 쪽이 요청값으로 채운다.
            timestamp = kst_timestamp(kst_ymd(self.milliseconds()), self.safe_string(order, 'ORD_TMD'))
            status = 'open'
        elif overseas:
            amount = self.safe_string(order, 'ft_ord_qty')
            filled = self.safe_string(order, 'ft_ccld_qty')
            remaining = self.safe_string(order, 'nccs_qty')
            price = self.safe_string(order, 'ft_ord_unpr3')
            average = self.safe_string(order, 'ft_ccld_unpr3')
            cost = self.safe_string(order, 'ft_ccld_amt3')
            # 국내 주문일시(`dmst_ord_dt`, `thco_ord_tmd`)는 한국 시각, 현지 주문일시(`ord_dt`, `ord_tmd`)는 미국 동부 시각이다.
            timestamp = kst_timestamp(self.safe_string(order, 'dmst_ord_dt'), self.safe_string(order, 'thco_ord_tmd'))
            if timestamp is None:
                timestamp = et_timestamp(self.safe_string(order, 'ord_dt'), self.safe_string(order, 'ord_tmd'))
            status = self._order_status_of(filled, remaining, None)
        else:
            amount = self.safe_string(order, 'ord_qty')
            filled = self.safe_string(order, 'tot_ccld_qty')
            # 일별체결 조회는 잔여수량(`rmn_qty`), 정정취소가능 조회는 가능수량(`psbl_qty`)을 준다.
            remaining = self.safe_string_2(order, 'rmn_qty', 'psbl_qty')
            price = self.safe_string(order, 'ord_unpr')
            average = self.safe_string(order, 'avg_prvs')
            cost = self.safe_string(order, 'tot_ccld_amt')
            order_date = self.safe_string(order, 'ord_dt')
            timestamp = kst_timestamp(order_date if order_date is not None else kst_ymd(self.milliseconds()), self.safe_string(order, 'ord_tmd'))
            status = self._order_status_of(filled, remaining, self.safe_string(order, 'cncl_yn'))
        return self.safe_order({
            'info': order,
            'id': order_id,
            'clientOrderId': None,
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'symbol': None if market is None else market.get('symbol'),
            'type': None if dvsn is None else 'market' if dvsn == KIS_ORDER_TYPE['MARKET'] else 'limit',
            'side': 'sell' if side_code == SIDE_CODE_SELL else 'buy' if side_code == SIDE_CODE_BUY else None,
            'price': price,
            'average': average,
            'amount': amount,
            'filled': filled,
            'remaining': remaining,
            'cost': cost,
            'status': status,
            'fee': None,
            'trades': [],
        }, market)

    def _order_status_of(self, filled: Str, remaining: Str, cancel_flag: Str) -> Str:
        """체결·잔여 수량과 취소 여부로 주문 상태를 정한다. 판단할 근거가 없으면 None 이다."""
        if cancel_flag == 'Y':
            return 'canceled'
        if remaining is not None and fn.js_number(remaining) > 0:
            return 'open'
        if filled is not None and fn.js_number(filled) > 0:
            return 'closed'
        return None

    def parse_trade(self, trade: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """체결 행 하나를 체결로 옮긴다. 체결 id 는 주문일자·주문번호·종목(·해외 거래소)의 조합이라 다시 조회해도 같다."""
        overseas = 'ft_ccld_qty' in trade or (market is not None and market.get('quote') == 'USD')
        code = self.safe_string_2(trade, 'pdno', 'ovrs_pdno')
        if code is not None and (market is None or market.get('id') != code):
            market = self._market_of(self._instrument_of(code))
        order_id = self.safe_string(trade, 'odno')
        if overseas:
            order_date = self.safe_string_2(trade, 'ord_dt', 'dmst_ord_dt', '')
            timestamp = kst_timestamp(self.safe_string(trade, 'dmst_ord_dt'), self.safe_string(trade, 'thco_ord_tmd'))
            if timestamp is None:
                timestamp = et_timestamp(order_date, self.safe_string(trade, 'ord_tmd'))
        else:
            order_date = self.safe_string(trade, 'ord_dt', '')
            timestamp = kst_timestamp(order_date, self.safe_string(trade, 'ord_tmd'))
        side_code = self.safe_string(trade, 'sll_buy_dvsn_cd')
        suffix = f":{self.safe_string(trade, 'ovrs_excg_cd', '')}" if overseas else ''
        return self.safe_trade({
            'info': trade,
            'id': f'{order_date}:{_tpl(order_id)}:{_tpl(code)}{suffix}',
            'order': order_id,
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'symbol': None if market is None else market.get('symbol'),
            'type': None,
            'side': 'sell' if side_code == SIDE_CODE_SELL else 'buy' if side_code == SIDE_CODE_BUY else None,
            'takerOrMaker': None,
            'price': self.safe_string(trade, 'ft_ccld_unpr3') if overseas else self.safe_string_2(trade, 'avg_prvs', 'cntg_unpr'),
            'amount': self.safe_string(trade, 'ft_ccld_qty') if overseas else self.safe_string_2(trade, 'tot_ccld_qty', 'cntg_qty'),
            'cost': self.safe_string(trade, 'ft_ccld_amt3') if overseas else self.safe_string(trade, 'tot_ccld_amt'),
            'fee': None,
        }, market)
