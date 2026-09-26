"""KB증권 상수와 심볼 도우미. TypeScript 판 `ts/src/kbsec/kbsec-types.ts` 에서 Python 판이 쓰는 것만 옮겼다.

엔드포인트가 기능이 아니라 TR 코드다(`POST /api/v1/{trcode}`, 조회도 POST). 요청과 응답은 `{dataHeader, dataBody}` 봉투로 감싸이고,
필드가 전부 문자열이라 금액과 수량, 가격도 문자열로 온다.
"""

import datetime
import math
import re
from decimal import ROUND_HALF_UP, Decimal

from kr_broker.base.errors import ExchangeError
from kr_broker.broker_krx_code import is_krx_domestic_code
from kr_broker.broker_market_group import symbol_base_code
from kr_broker.broker_time import kst_ymd
from kr_broker.krx_trading_hours import is_krx_business_day_kst
from kr_broker.us_market_hours import et_ymd

# 운영 도메인. 모의투자 서버가 없고 포트가 비표준(32484)이다.
KBSEC_API_BASE = 'https://developer.kbsec.com:32484'
# OAuth2 토큰 발급 경로.
KBSEC_TOKEN_PATH = '/oauth2/token'
# 토큰 폐기 경로. 공식 문서에 없어 실측으로 확인했다(잘못된 경로는 `E991`, 이 경로는 본문에 따라 `E021`·`T022` 를 준다).
KBSEC_REVOKE_PATH = '/oauth2/revoke'
# TR 호출 경로 앞부분. 뒤에 TR 코드를 소문자로 붙인다.
KBSEC_TR_PATH_PREFIX = '/api/v1/'
# 토큰 만료를 이만큼 앞당겨 재발급한다(ms).
KBSEC_TOKEN_SAFETY_MARGIN_MS = 60 * 1000
# 응답에 `expires_in` 이 없을 때의 토큰 수명(ms). 가이드 예시의 24시간이다.
KBSEC_TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

# 이 판이 부르는 TR 코드.
KBSEC_TR = {
    # 주식현재가(국내)
    'QUOTE_KR': 'IVU10140',
    # 주식호가(국내)
    'ORDERBOOK_KR': 'IVU10070',
    # 통합차트(국내)
    'CHART_KR': 'IVS11560',
    # 주식시간대별추이(국내 시간대별 체결)
    'TRADES_TIMELINE_KR': 'IVU10080',
    # 장운영상태
    'MARKET_STATUS': 'SZQM0771',
    # 종목별투자자
    'INVESTOR_TRADING': 'IVU10430',
    # 해외 현재가
    'QUOTE_US': 'GSS10030',
    # 해외 호가
    'ORDERBOOK_US': 'GSS10040',
    # 해외 시간대별체결
    'TRADES_TIMELINE_US': 'GSA10020',
    # 계좌별주문체결조회
    'TRADES_KR': 'SSQM2341',
    # 해외 주문체결조회. 해외 체결 확정의 조달처이며, 해외 체결은 국내 체결 TR 에 없다.
    'ORDERS_US': 'SPQM2103',
    # 해외 체결현황. 해외 주문번호별주문내역(`SPQM1818`)과 달리 단축종목코드를 준다.
    'ORDER_STATUS_US': 'SPQM2204',
}

# 통합차트 차트구분(`chrt_clsf`).
KBSEC_CHART_KIND = {
    'DAY': 'D',
    'WEEK': 'W',
    'MONTH': 'M',
    'MINUTE': 'B',
}

# 국내 주문구분코드(`ordr_ccd`). 지정가, 시장가, 스톱지정가(조건가격 `stpd_prc` 에 닿으면 `ordr_uprc` 지정가 주문이 된다)만 쓴다.
KBSEC_ORDER_TYPE_KR = {
    'LIMIT': '00',
    'MARKET': '03',
    'STOP_LIMIT': 'S0',
}

# 해외 거래소코드(`krx_cd`) 후보. 심볼의 상장 거래소를 늘 아는 것이 아니라 이 순서로 시도한다(찾은 값은 증권사 인스턴스가 캐시한다).
KBSEC_US_EXCHANGES = ('NAS', 'NYS', 'AMX')

# 조회구분(`inq_clsf`, SSQM2341). `1` 주식, `2` 장내채권, `5` ELW, `6` 일반상품, `9` 전체다.
KBSEC_INQ_STOCK = '1'
# 체결구분(`ccls_clsf`, SSQM2341). `0` 전체, `1` 체결, `2` 미체결이다. 빈 값으로 보내면 거부된다(`체결구분을 확인하십시오`, 8654).
KBSEC_CCLS_ALL = '0'
KBSEC_CCLS_FILLED = '1'
KBSEC_CCLS_PENDING = '2'
# 매매구분(`trd_clsf`, SSQM2341·SPQM2103 체결 행). `1` 이 매도이고 그 밖은 매수다.
KBSEC_TRD_SELL = '1'
# 연속구분(`cn_clsf`). `0` 은 첫 페이지, `1` 은 연속이다.
KBSEC_CONT_FIRST = '0'
KBSEC_CONT_NEXT = '1'

_A_PREFIXED_CODE = re.compile(r'A([0-9A-Za-z]{6})')
_KR_ISIN = re.compile(r'KR7([0-9A-Za-z]{6})[0-9A-Za-z]{3}')


def kbsec_base_symbol(symbol: str) -> str:
    """심볼 → API 종목코드(base 만). 클래스 주식의 `BRK/B` 는 `BRK.B` 로 바꾸고, `COMMON_STOCK_CODES` 의 통합 코드는 티커로 돌린다."""
    return symbol_base_code(symbol.strip()).strip()


def kbsec_market_of(symbol: str) -> str:
    """심볼 → 시장. 국내 종목코드 모양이면 `'KR'`, 아니면 `'US'` 다."""
    return 'KR' if is_krx_domestic_code(kbsec_base_symbol(symbol)) else 'US'


def kbsec_num(value: float, decimals: int = 0) -> str:
    """KB 는 수량과 가격을 문자열로 받는다. 지수 표기(`1e-7`)나 부동소수 꼬리가 실려 거부되지 않게 고정 소수점 문자열로 바꾼다.
    JavaScript `toFixed` 처럼 값의 이진 표현을 반올림하고, 가운데 값은 0 에서 먼 쪽으로 올린다. 유한하지 않으면 `'0'` 이다."""
    if not math.isfinite(value):
        return '0'
    return format(Decimal(value).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP), 'f')


def kbsec_business_date_kst(steps_back: int, now_ms: int) -> str:
    """조회 기준일(`ordr_dt`) `YYYYMMDD`. KB 의 현재일자는 영업일이라 주말·휴장일에는 직전 영업일에 머문다.

    캘린더 날짜를 그대로 보내면 그날 조회가 전부 거부된다(`주문일자가 현재일자보다 큽니다`, 2854). 그래서 주말과 KRX 휴장일
    (`is_krx_business_day_kst`)을 건너뛴다. 휴장일 표에 없는 휴장일은 호출하는 쪽이 2854 를 만나면 한 칸씩 더 되감는다.
    `steps_back` 0 은 `now_ms` 의 한국 날짜 기준 가장 최근 영업일, 1 은 그 직전 영업일이다.
    """
    ymd = kst_ymd(now_ms)
    day = datetime.date(int(ymd[0:4]), int(ymd[4:6]), int(ymd[6:8]))
    remaining = steps_back
    # 휴장일 표가 잘못되어 모든 날이 휴장으로 보여도 멈추게 상한을 둔다. 1년이면 어떤 연휴도 넘는다.
    for _ in range(366 + steps_back * 7):
        ymd = f'{day.year:04d}{day.month:02d}{day.day:02d}'
        if is_krx_business_day_kst(ymd):
            if remaining == 0:
                return ymd
            remaining -= 1
        day -= datetime.timedelta(days=1)
    raise ExchangeError(f'KB 조회 기준일을 찾지 못했다: 최근 1년에 KRX 영업일이 없다(stepsBack={steps_back})')


def kbsec_business_date_us_eastern(steps_back: int, now_ms: int) -> str:
    """`kbsec_business_date_kst` 의 미국 현지 날짜판. 해외 조회의 `ordr_dt` 축이다. 주말만 되감는다."""
    ymd = et_ymd(now_ms)
    day = datetime.date(int(ymd[0:4]), int(ymd[4:6]), int(ymd[6:8]))
    remaining = steps_back
    while True:
        if day.weekday() < 5:
            if remaining == 0:
                break
            remaining -= 1
        day -= datetime.timedelta(days=1)
    return f'{day.year:04d}{day.month:02d}{day.day:02d}'


def kbsec_normalize_code(raw: str) -> str:
    """KB 응답의 종목코드 → 도메인 코드. KB 는 국내 단축코드를 `A` 접두로 주고(`A005930`), 표준종목번호(`KR7005930003`)로 주는 필드도 있다.
    그대로 넘기면 `kbsec_market_of` 가 해외 종목으로 오판하므로 벗긴다. 벗긴 결과가 국내 코드 모양일 때만 벗긴다."""
    s = (raw or '').strip()
    prefixed = _A_PREFIXED_CODE.fullmatch(s)
    if prefixed is not None and is_krx_domestic_code(prefixed.group(1)):
        return prefixed.group(1)
    isin = _KR_ISIN.fullmatch(s)
    if isin is not None and is_krx_domestic_code(isin.group(1)):
        return isin.group(1)
    return s
