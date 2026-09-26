"""KB증권 상수와 심볼 도우미. TypeScript 판 `ts/src/kbsec/kbsec-types.ts` 에서 Python 판이 쓰는 것만 옮겼다.

엔드포인트가 기능이 아니라 TR 코드다(`POST /api/v1/{trcode}`, 조회도 POST). 요청과 응답은 `{dataHeader, dataBody}` 봉투로 감싸이고,
필드가 전부 문자열이라 금액과 수량, 가격도 문자열로 온다.
"""

import math
from decimal import ROUND_HALF_UP, Decimal

from kr_broker.broker_krx_code import is_krx_domestic_code
from kr_broker.broker_market_group import symbol_base_code

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
}

# 통합차트 차트구분(`chrt_clsf`).
KBSEC_CHART_KIND = {
    'DAY': 'D',
    'WEEK': 'W',
    'MONTH': 'M',
    'MINUTE': 'B',
}

# 해외 거래소코드(`krx_cd`) 후보. 심볼의 상장 거래소를 늘 아는 것이 아니라 이 순서로 시도한다(찾은 값은 증권사 인스턴스가 캐시한다).
KBSEC_US_EXCHANGES = ('NAS', 'NYS', 'AMX')


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
