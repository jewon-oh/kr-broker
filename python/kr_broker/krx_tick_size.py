"""KRX 주식 호가가격단위(세 증권사 공용). TypeScript 판 `ts/src/krx-tick-size.ts` 와 같다.

한국거래소가 2023-01-25 부터 유가증권시장과 코스닥시장에 함께 적용하는 주식 호가가격단위 표다. ETF·ETN 처럼 주식이 아닌 종목은 다른 표를 쓰므로
여기서 다루지 않는다. `price_to_precision` 은 이 표로 반올림한다. 주문 경로는 가격을 바꾸지 않고, 일반 주식인 것을 알 때만 표에 맞지 않는
가격을 요청 전에 막는다.
"""

import math
from typing import Any, Optional, Tuple

from kr_broker.base import functions as fn

# 가격 상한(미만)과 그 구간의 호가 단위. 낮은 구간부터 적는다. 50만원 이상은 `KRX_STOCK_TOP_TICK_SIZE` 다.
KRX_STOCK_TICK_SIZES: Tuple[Tuple[int, int], ...] = (
    (2_000, 1),
    (5_000, 5),
    (20_000, 10),
    (50_000, 50),
    (200_000, 100),
    (500_000, 500),
)
# 마지막 구간(50만원 이상)의 호가 단위.
KRX_STOCK_TOP_TICK_SIZE = 1_000
# 호가 단위에 맞지 않는 가격을 요청 전에 막을 때 `InvalidOrder` 의 `detail`. 토스가 같은 거절에 쓰는 코드와 같다.
KRX_TICK_INVALID_DETAIL = 'price-tick-invalid'


def get_krx_tick_size(price: float) -> int:
    """가격대의 호가 단위."""
    for below, tick in KRX_STOCK_TICK_SIZES:
        if price < below:
            return tick
    return KRX_STOCK_TOP_TICK_SIZE


def krx_tick_violation(price: Any) -> Optional[str]:
    """표에 맞지 않는 가격이면 막는 사유, 맞으면 `None`. 가격은 양의 정수이고 그 가격대 호가 단위의 배수여야 한다."""
    tick = get_krx_tick_size(price)
    if isinstance(price, (int, float)) and not isinstance(price, bool) and math.isfinite(price) and price > 0 \
            and float(price).is_integer() and int(price) % tick == 0:
        return None
    return f'호가 단위에 맞지 않는 가격이다: {fn.js_string(price)} (이 가격대의 호가 단위는 {tick}원)'
