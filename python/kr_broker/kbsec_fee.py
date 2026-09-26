"""KB증권 매매비용 추정. TypeScript 판 `ts/src/kbsec/kbsec-fee.ts` 에서 Python 판이 쓰는 것만 옮겼다.

여기 값은 공시 요율에서 온 근사이고, KB 가 실제로 청구한 금액이 아니다. 실제 청구액은 KB 정산 TR 이 준다(해외 `SPQM2205`, 국내 `SSQM2121`).
국내 매도세는 상수가 아니라 시행일별 표다(`krx_sell_tax`).
"""

from typing import Optional

from kr_broker.krx_sell_tax import krx_sell_tax_rate

# 국내 위탁수수료율(공시 근사). 실청구액은 정산 TR 로 확정한다.
KBSEC_BROKERAGE_FEE = 0.00015
# 해외(미국) 위탁수수료율(공시 근사). SEC fee 등 기타 제비용은 포함돼 있지 않다.
KBSEC_US_BROKERAGE_FEE = 0.001


def kbsec_estimated_fee_rate(market: str, side: str, at_ms: Optional[int] = None) -> float:
    """실효 매매비용률. 위탁수수료에 국내 매도면 증권거래세를 더한다(`명목금액 × rate` 가 비용이다). `at_ms` 는 체결 시각이고 생략하면 지금이다."""
    brokerage = KBSEC_BROKERAGE_FEE if market == 'KR' else KBSEC_US_BROKERAGE_FEE
    tax = krx_sell_tax_rate(at_ms) if market == 'KR' and side == 'sell' else 0
    return brokerage + tax
