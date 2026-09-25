"""한국투자증권 상수와 호가 단위. TypeScript 판 `ts/src/kis/kis-types.ts` 를 옮겼다."""

from typing import Optional

from kr_broker.base import functions as fn
from kr_broker.broker_krx_code import KIS_KRX_CODE_DIGITS, KNOWN_ALNUM_KRX_CODES, is_krx_domestic_code
from kr_broker.krx_sell_tax import krx_sell_tax_rate

__all__ = [
    'KIS_API_DOMAINS', 'KIS_WS_DOMAINS', 'KIS_WS_PATH', 'KIS_WS_TR', 'KIS_WS_FIELD',
    'KIS_RATE_LIMIT_ERROR_CODE', 'KIS_LEDGER_RATE_LIMIT_ERROR_CODE', 'KIS_RATE_LIMIT_ERROR_CODES',
    'KIS_BROKERAGE_FEE', 'KIS_DEFAULT_FEE_RATE', 'KIS_OVERSEAS_DEFAULT_FEE_RATE', 'KIS_CUSTOMER_TYPE', 'KIS_DEFAULT_ACCOUNT_SUFFIX',
    'KIS_ORDER_TYPE', 'KIS_OVERSEAS_ORD_DVSN', 'KIS_PRESENT_BALANCE_PARAMS', 'KIS_KRX_CODE_DIGITS', 'KNOWN_ALNUM_KRX_CODES',
    'get_kis_effective_fee_rate', 'get_tick_size', 'is_krx_domestic_code', 'is_overseas_symbol', 'krx_sell_tax_rate',
]

KIS_API_DOMAINS = {
    'REAL': 'https://openapi.koreainvestment.com:9443',
    'VIRTUAL': 'https://openapivts.koreainvestment.com:29443',
}
KIS_WS_DOMAINS = {
    'REAL': 'ws://ops.koreainvestment.com:21000',
    'VIRTUAL': 'ws://ops.koreainvestment.com:31000',
}
# 실시간 웹소켓 구독 경로(KIS 공통 실시간 엔드포인트).
KIS_WS_PATH = '/tryitout'
# 실시간 TR ID. 국내는 체결가 H0STCNT0, 호가 H0STASP0 이고 해외는 지연체결가 HDFSCNT0, 지연호가 HDFSASP0 다(유료 실시간인 R* 계열은 쓰지 않는다).
KIS_WS_TR = {
    'DOMESTIC_TRADE': 'H0STCNT0',
    'DOMESTIC_ASKING': 'H0STASP0',
    'OVERSEAS_TRADE': 'HDFSCNT0',
    'OVERSEAS_ASKING': 'HDFSASP0',
    'PINGPONG': 'PINGPONG',
}
# 실시간 체결·호가 프레임에서 `^` 로 나뉜 본문의 필드 위치. KIS 공식 문서 기준이고, 실제 연결에서 다르면 이 값만 고친다.
KIS_WS_FIELD = {
    # 국내 체결 H0STCNT0: [0] 종목코드, [2] 현재가(STCK_PRPR), [5] 전일대비율(PRDY_CTRT)
    'DOMESTIC_TRADE_LAST': 2,
    'DOMESTIC_TRADE_CHANGE_PCT': 5,
    # 해외 체결 HDFSCNT0: [1] 종목코드(SYMB), [11] 현재가(LAST), [14] 등락율(RATE)
    'OVERSEAS_TRADE_SYMBOL': 1,
    'OVERSEAS_TRADE_LAST': 11,
    'OVERSEAS_TRADE_CHANGE_PCT': 14,
    # 국내 호가 H0STASP0: [0] 종목코드, 매도호가 ASKP1..10 = [3+i], 매수호가 BIDP1..10 = [13+i], 매도잔량 = [23+i], 매수잔량 = [33+i]
    'DOMESTIC_ASKP_BASE': 3,
    'DOMESTIC_BIDP_BASE': 13,
    'DOMESTIC_ASKP_RSQN_BASE': 23,
    'DOMESTIC_BIDP_RSQN_BASE': 33,
}

# 초당 거래건수 초과. 조회는 다시 보내고 주문은 다시 보내지 않는다(이중 주문 위험).
KIS_RATE_LIMIT_ERROR_CODE = 'EGW00201'
# 원장 초당 거래건수 초과. EGW00201 과 같은 계열이고 HTTP 500 으로 온다.
KIS_LEDGER_RATE_LIMIT_ERROR_CODE = 'EGW00215'
KIS_RATE_LIMIT_ERROR_CODES = (KIS_RATE_LIMIT_ERROR_CODE, KIS_LEDGER_RATE_LIMIT_ERROR_CODE)

# 국내 위탁수수료율(0.015%, 매수·매도 모두). 등급과 할인은 따로다.
KIS_BROKERAGE_FEE = 0.00015
# 예전 이름. 위탁수수료만 담는다.
KIS_DEFAULT_FEE_RATE = KIS_BROKERAGE_FEE
# 미국 주식 기본 수수료율(0.25%).
KIS_OVERSEAS_DEFAULT_FEE_RATE = 0.0025

# 고객 유형 코드(개인).
KIS_CUSTOMER_TYPE = 'P'
# 계좌 상품코드 기본값.
KIS_DEFAULT_ACCOUNT_SUFFIX = '01'

# 국내 주문 구분 코드.
KIS_ORDER_TYPE = {
    'LIMIT': '00',
    'MARKET': '01',
    'CONDITIONAL': '02',
    'BEST': '03',
    'PRIORITY': '04',
}

# 해외 주문 구분 코드. 모의투자는 지정가만 받는다.
KIS_OVERSEAS_ORD_DVSN = {
    'LIMIT': '00',
    'LOO': '32',
    'LOC': '34',
    'MOO': '31',
    'MOC': '33',
}

# 체결기준현재잔고(CTRP6504R) 요청 코드. 미국 시장의 달러 잔고만 본다.
KIS_PRESENT_BALANCE_PARAMS = {
    'WCRC_FRCR_DVSN_FOREIGN': '02',
    'NATN_US': '840',
    'TR_MKET_ALL': '00',
    'INQR_DVSN_ALL': '00',
}


def get_kis_effective_fee_rate(side: str, at_ms: Optional[int] = None) -> float:
    """매수는 위탁수수료, 매도는 위탁수수료에 증권거래세를 더한 비율."""
    return KIS_BROKERAGE_FEE + krx_sell_tax_rate(at_ms) if side == 'sell' else KIS_BROKERAGE_FEE


def get_tick_size(price: float) -> int:
    """KRX 가격대별 호가 단위."""
    if price < 2000:
        return 1
    if price < 5000:
        return 5
    if price < 20000:
        return 10
    if price < 50000:
        return 50
    if price < 200000:
        return 100
    if price < 500000:
        return 500
    return 1000


def is_overseas_symbol(symbol: str) -> bool:
    """해외 종목인가. 접미사(`/KRW` 등)를 떼고 국내 종목코드 모양이 아니면 해외다."""
    return not is_krx_domestic_code(fn.js_string(symbol).split('/')[0])
