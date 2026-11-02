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
    # 공휴일관리(미국). 처리구분은 설명의 조회(`4`)를 보낸다.
    'HOLIDAYS_US': 'SPAM2508',
    # 종목기본정보. 종목명, 종목유형, 매매제한, 위험등급이다.
    'SECURITY_INFO': 'SIQM4900',
    # 등락률상위
    'RANK_FLUCTUATION': 'IVU10240',
    # 거래량상위
    'RANK_VOLUME': 'IVU10280',
    # 프로그램매매상위
    'RANK_PROGRAM_TRADING': 'IVS10920',
    # 거래대금상위
    'RANK_TRADING_VALUE': 'IVU10210',
    # 시가대비등락률상위
    'RANK_OPEN_CHANGE_RATE': 'IVS10910',
    # 환율종합
    'EXCHANGE_RATES': 'IVA60190',
    # 세계지수
    'WORLD_INDICES': 'IVA60140',
    # 종목기업개요
    'COMPANY_PROFILE': 'IVM10050',
    # 신고/신저
    'NEW_HIGH_LOW': 'IVU10550',
    # 외국인기관매매상위
    'INVESTOR_RANKING': 'IVU10020',
    # 증시주변자금동향
    'MARKET_FUND_FLOW': 'IVA10370',
    # 기간외등락률순위
    'RANK_EXTENDED_HOURS_CHANGE_RATE': 'IVS11190',
    # 급등/급락 상위
    'RANK_SURGE_PLUNGE': 'IVU10270',
    # 당일주요외국계거래원
    'FOREIGN_BROKERS': 'IVU10420',
    # 종목별프로그램매매추이
    'PROGRAM_TRADING_TREND': 'IVU10450',
    # 시장종합
    'MARKET_OVERVIEW': 'IVSA0070',
    # 테마그룹조회
    'THEME_GROUPS': 'IVS11430',
    # 업종랭킹. 필드가 같은 그리드 둘을 준다.
    'RANK_SECTOR': 'IVM30010',
    # 해외 현재가
    'QUOTE_US': 'GSS10030',
    # 해외 호가
    'ORDERBOOK_US': 'GSS10040',
    # 해외 차트. 15분 지연 시세다. 봉 시각은 미국 동부 현지 시각이다.
    'CHART_US': 'GSC10060',
    # 해외 시간대별체결
    'TRADES_TIMELINE_US': 'GSA10020',
    # 계좌별주문체결조회
    'TRADES_KR': 'SSQM2341',
    # 해외 주문체결조회. 해외 체결 확정의 조달처이며, 해외 체결은 국내 체결 TR 에 없다.
    'ORDERS_US': 'SPQM2103',
    # 해외 체결현황. 해외 주문번호별주문내역(`SPQM1818`)과 달리 단축종목코드를 준다.
    'ORDER_STATUS_US': 'SPQM2204',
    # 예수금내역
    'DEPOSIT': 'SSQM0004',
    # 보유주식 조회
    'HOLDINGS': 'SSQM1801',
    # 계좌자산평가. 국내 보유의 1순위 조달처다. 실패하면 보유주식(`SSQM1801`) 경로로 내려간다.
    'ASSET_EVAL': 'SSQM2952',
    # 원마켓 계좌증거금. 원화·원화환산 외화 예수금이다.
    'ONEMARKET_MARGIN': 'SPQM3390',
    # 해외 잔고평가. 그리드가 둘이다(통화별 예수금과 종목별 보유). 첫 배열을 집으면 예수금 쪽을 집는다.
    'HOLDINGS_US': 'SPQM2226',
    # 주식자산평가조회(실시간)
    'ASSET_EVAL_REALTIME': 'SSQN2952',
    # 총 잔고 조회. 계좌별 평가액, 예수금, 출금가능금액이다.
    'ACCOUNT_SUMMARY': 'SSQM0005',
    # 종합계좌 잔고현황 조회(종합위탁계좌, 신연금저축계좌)
    'INTEGRATED_BALANCE': 'SSQM2932',
    # 평가손익 조회
    'UNREALIZED_PNL': 'SSQM0006',
    # 국내주식 소수점 매매 보유잔고내역 조회
    'FRAC_HOLDINGS_KR': 'SSQM5472',
    # 계좌원장 거래내역 조회(위탁·금융상품·저축)
    'LEDGER': 'SWQA2301',
    # 계좌원장 거래내역 조회(CMA)
    'LEDGER_CMA': 'SWQB2301',
    # 익일·익익일 출금가능금액 조회
    'WITHDRAWABLE': 'SWQN2302',
    # 개인별쿠폰 조회
    'COUPONS': 'SZQM6019',
    # 거래내역상세 조회. 거래 한 건(일자와 거래일련번호)의 상세다.
    'LEDGER_DETAIL': 'SWQM2412',
    # 예수금조회. 대용총액(`sbt_tl_amt`)이 한 레코드에 두 번 있다.
    'DEPOSIT_DETAIL': 'SWQM2302',
    # 글로벌원마켓 증거금사용현황
    'ONEMARKET_MARGIN_USAGE': 'SPQN3390',
    # 매매정산현황상세(원마켓플러스)
    'ONEMARKET_SETTLEMENT_DETAIL': 'SKQO3390',
    # 매수주문가능금액 조회(국내)
    'BUYABLE_KR': 'SSQM1802',
    # 계좌별매매가정산현황(국내). KB 가 실제로 청구한 국내 매매비용의 정본이다. 행 파서는 `kbsec_settlement_row` 다.
    'SETTLEMENT_KR': 'SSQM2121',
    # 일자별실현손익상세. 매체구분(`md_clsf`)은 호출하는 쪽이 고른다.
    'PNL_DAILY': 'SSQM2442',
    # 종목별기간실현손익. 종목 단위 기간 합계라 개별 매매로 나눌 수 없다.
    'PNL_BY_SYMBOL': 'SSQM2443',
    # 기간매매손익현황
    'PNL_PERIOD': 'SSQM2392',
    # 소수점 주문가능금액(국내)
    'FRAC_BUYABLE_KR': 'SSQN5472',
    # 소수점 매매 내역 조회(국내)
    'FRAC_TRADES_KR': 'SSQM5765',
    # 온주/소수점 주문체결내역 조회(국내)
    'FRAC_ORDERS_KR': 'SSQM5475',
    # 예약주문접수(현금신용통합, 국내)
    'RESERVED_ORDER_KR': 'SSAM0831',
    # 예약주문처리 조회(국내)
    'RESERVED_RESULTS_KR': 'SSQM0831',
    # 예약주문접수 조회(국내)
    'RESERVED_ORDERS_KR': 'SSQM0834',
    # 계좌권리발생내역
    'CORPORATE_ACTIONS': 'SRQM3051',
    # 해외 소수점 주문가능금액 조회
    'FRAC_BUYABLE_US': 'SPQN5472',
    # 해외 소수점 보유잔고내역 조회
    'FRAC_HOLDINGS_US': 'SPQM5472',
    # 해외 소수점 주문접수내역 조회(주문용)
    'FRAC_ORDERS_US': 'SPQN5473',
    # 해외 소수점 주문접수내역조회. 기간, 체결 결과와 요약 그리드를 준다.
    'FRAC_ORDER_HISTORY_US': 'SPQM5473',
    # 주식예약주문(미국)
    'RESERVED_ORDER_US': 'SPAO2104',
    # 예약주문취소(미국)
    'RESERVED_CANCEL_US': 'SPAO2106',
    # 해외 주문번호별주문내역
    'ORDER_HISTORY_US': 'SPQM1818',
    # 원마켓플러스 주문가능금액(종목·가격 지정). 원화환산 주문가능액을 준다.
    'ONEMARKET_BUYABLE': 'SKQM2106',
    # 원마켓플러스 주문가능금액 현황(통화별 총괄)
    'ONEMARKET_BUYABLE_ALL': 'SKQM3350',
    # 해외 주문가능금액. 원마켓이 아닌 계좌용이다.
    'BUYABLE_US': 'SPQM2106',
    # 매매가정산현황(해외). KB 가 실제로 청구한 해외 매매비용의 정본이다. 국내 `SETTLEMENT_KR` 과 매매구분 도메인이 다르다(`99`/`01`/`02`).
    # 행 파서는 `kbsec_overseas_settlement_row` 다.
    'SETTLEMENT_US': 'SPQM2205',
    # 현금매수주문(국내)
    'BUY_KR': 'SSAM1802',
    # 현금매도주문(국내)
    'SELL_KR': 'SSAM1801',
    # 정정주문(국내)
    'AMEND_KR': 'SSAM1805',
    # 취소주문(국내)
    'CANCEL_KR': 'SSAM1806',
    # 소수점 매수, 매도(국내)
    'FRAC_BUY_KR': 'SSAM5763',
    'FRAC_SELL_KR': 'SSAM5762',
    # 해외 매도/매수주문
    'ORDER_US': 'SKAM2101',
    # 해외 정정/취소주문
    'AMEND_CANCEL_US': 'SKAM2102',
    # 소수점매도/매수주문(해외). 금액(`amt_q_clsf='0'`)이나 수량 기준으로 낸다. 미국만 지원한다.
    # 주문유형코드(`frgn_ordr_typ_cd`)가 `ORDER_US` 와 다른 코드표를 쓴다. `2`(지정가)와 `E`(유사시장가)뿐이다.
    'FRAC_ORDER_US': 'SKAM2201',
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

# 국내 주문업무구분(`ordr_jb_clsf`).
KBSEC_ORDER_SIDE_KR = {
    'SELL': '1',
    'BUY': '2',
    'AMEND': '3',
    'CANCEL': '4',
}

# 신용유형코드(`crdt_typ_cd`). 현금만 쓴다.
KBSEC_CREDIT_CASH = '00'

# SOR 주문구분코드(`sor_ordr_ccd`). 대체거래소 라우팅이다. KB 는 이것을 주문 필드로 직접 받는다.
KBSEC_SOR = {
    'KRX': 'K',
    'NXT': 'N',
    'SOR': 'S',
}

# 해외 매매거래구분코드(`trd_dl_ccd`).
KBSEC_ORDER_SIDE_US = {
    'SELL': '01',
    'BUY': '02',
}

# 해외 주문유형코드(`frgn_ordr_typ_cd`). 시장가, 지정가, 스톱지정가(조건가격 `frgn_stp_prc_p4` 에 닿으면 `frgn_ordr_prc_p4` 지정가 주문이 된다)만 쓴다.
KBSEC_ORDER_TYPE_US = {
    'MARKET': '1',
    'LIMIT': '2',
    'STOP_LIMIT': 'C',
}

# 해외 거래소코드(`krx_cd`) 후보. 심볼의 상장 거래소를 늘 아는 것이 아니라 이 순서로 시도한다(찾은 값은 증권사 인스턴스가 캐시한다).
KBSEC_US_EXCHANGES = ('NAS', 'NYS', 'AMX')

# 시장시간구분(`mkt_tm_ccd`). 정규장만 쓴다.
KBSEC_SESSION_REGULAR = '1'
# 조회구분(`inq_clsf`, SSQM2341). `1` 주식, `2` 장내채권, `5` ELW, `6` 일반상품, `9` 전체다.
KBSEC_INQ_STOCK = '1'
# 조회구분 '전체'. 위 값 표는 SSQM2341 기준이고 보유주식(SSQM1801)에서 같은 뜻인지는 명세에 없다. 잔고 조회는 `1` 을 먼저 쓰고
# 0건일 때만 이 값으로 다시 부른다(`_fetch_holding_rows`).
KBSEC_INQ_ALL = '9'
# 체결구분(`ccls_clsf`, SSQM2341). `0` 전체, `1` 체결, `2` 미체결이다. 빈 값으로 보내면 거부된다(`체결구분을 확인하십시오`, 8654).
KBSEC_CCLS_ALL = '0'
KBSEC_CCLS_FILLED = '1'
KBSEC_CCLS_PENDING = '2'
# 매매구분(`trd_clsf`, SSQM2341·SPQM2103 체결 행). `1` 이 매도이고 그 밖은 매수다.
KBSEC_TRD_SELL = '1'
# 연속구분(`cn_clsf`). `0` 은 첫 페이지, `1` 은 연속이다.
KBSEC_CONT_FIRST = '0'
KBSEC_CONT_NEXT = '1'
# 해외 잔고평가(SPQM2226) 입력. 기준통화여부 `1` 외화기준(보유 평가를 USD 로 받는다), 환율적용여부 `2` 매매기준환율(원화 환산 필드에만 쓰인다),
# 수수료구분 `1` 미포함(평가금액에 수수료를 섞지 않는다)이다.
KBSEC_STD_CURRENCY_FOREIGN = '1'
KBSEC_EXCH_RATE_MARKET = '2'
KBSEC_FEE_EXCLUDED = '1'

# 세계지수(`IVA60140`) 조회 범위(`lnd_clsf`). 공식 예제는 `MAJOR`(주요지수)를 기본값으로 쓴다.
KBSEC_WORLD_INDEX_SCOPE_CODE = {'MAJOR': '1', 'AMERICA': 'C', 'EUROPE': 'E', 'ASIA': 'S'}
# 신고가/신저가 구분(`nw_stk_lw_ccd`).
KBSEC_HIGH_LOW_TYPE_CODE = {'HIGH': '1', 'LOW': '2'}
# 투자자구분코드(`invstr_ccd`, `IVU10020`).
KBSEC_INVESTOR_CODE = {
    'FOREIGNER': '0', 'INSTITUTION': '1', 'FOREIGNER_INSTITUTION': '2', 'SECURITIES': '3', 'INSURANCE': '4',
    'INVESTMENT_TRUST': '5', 'PRIVATE_EQUITY': '6', 'BANK': '7', 'MERCHANT_BANK': '8', 'FUND': '9',
    'OTHER': 'A', 'GOVERNMENT': 'B', 'INDIVIDUAL': 'C', 'OTHER_FOREIGNER': 'D',
}
# 외국인·기관매매상위의 순위구분(`rnk_clsf`).
KBSEC_INVESTOR_RANKING_TYPE_CODE = {'BUY': '0', 'SELL': '1', 'HOLDING_UP': '2', 'HOLDING_DOWN': '3', 'CONSECUTIVE_BUY': '4', 'CONSECUTIVE_SELL': '5'}
# 업종랭킹(`IVM30010`)의 시장구분(`mkt_clsf`).
KBSEC_SECTOR_MARKET_CODE = {'KOSPI': '1', 'KOSDAQ': '2'}
# 종목별기간실현손익(`SSQM2443`)의 매체구분(`md_clsf`). 설명대로 오프라인 `1`, 온라인 `2`, 지점 `3` 이다.
KBSEC_MEDIA_CLASS_CODE = {'OFFLINE': '1', 'ONLINE': '2', 'BRANCH': '3'}

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
