"""토스증권 상수와 순수 함수(시장 판정, 실효 매매비용률). TypeScript 판 `ts/src/toss/toss-types.ts` 의 상수와 함수를 옮겼다.

응답 원본의 모양(타입 선언)은 옮기지 않았다. Python 판은 응답을 사전 그대로 다루고, 키 이름은 TypeScript 판의 타입 선언과 같다.
"""

import re
from typing import Optional

from kr_broker.krx_sell_tax import krx_sell_tax_rate

# 국내주식 위탁수수료율 기본값(근사). 실제 요율은 `GET /commissions` 로 받는다.
TOSS_BROKERAGE_FEE = 0.00015

# 미국주식 위탁수수료율 기본값(근사). SEC·TAF 같은 소액 수수료를 포함해 보수적으로 잡았다.
TOSS_US_BROKERAGE_FEE = 0.001

# 고액주문 확인 기준(원화). 주문 금액이 이 값 이상이면 `confirmHighValueOrder: true` 를 보내야 한다.
TOSS_HIGH_VALUE_THRESHOLD_KRW = 100_000_000

# 환율을 알 수 없을 때 쓰는 고액주문 확인 기준(달러). 1억원을 보수적인 환율(1달러당 약 1,430원)로 나눈 값이다.
TOSS_HIGH_VALUE_THRESHOLD_USD = 70_000

# 국내 종목코드의 모양: 6자리이고 첫 글자가 숫자, 나머지는 숫자나 영문이다. 미국 티커는 숫자로 시작하지 않는다.
_KRX_CODE_SHAPE = re.compile(r'[0-9][0-9A-Za-z]{5}')


def toss_market_country(symbol: str) -> str:
    """종목 심볼(`005930`, `005930/KRW`, `AAPL`)의 시장(`'KR'`·`'US'`). 종목코드의 모양만 본다."""
    return 'KR' if _KRX_CODE_SHAPE.fullmatch(symbol.split('/')[0]) else 'US'


def get_toss_effective_fee_rate(market: str, side: str, at_ms: Optional[int] = None, brokerage: Optional[float] = None,
                                tax_exempt: bool = False) -> float:
    """실효 매매비용률: 위탁수수료에 (국내 매도라면) 증권거래세를 더한 값이다.

    세금은 거래 시각(`at_ms`, 생략하면 지금)의 세율을 쓴다. `brokerage` 를 주면 기본값 대신 그 요율을 쓴다.
    `tax_exempt` 는 증권거래세가 붙지 않는 국내 상장 ETF·ETN 매도에 쓴다.
    """
    if brokerage is None:
        brokerage = TOSS_US_BROKERAGE_FEE if market == 'US' else TOSS_BROKERAGE_FEE
    tax = krx_sell_tax_rate(at_ms) if market == 'KR' and side == 'sell' and not tax_exempt else 0
    return brokerage + tax
