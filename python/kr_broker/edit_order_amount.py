"""`edit_order` 의 `amount` 대조(세 증권사 공용). TypeScript 판 `ts/src/edit-order-amount.ts` 와 같다.

ccxt 의 `edit_order(id, symbol, type, side, amount, price)` 에서 `amount` 는 정정 뒤 주문의 총수량(체결분 포함)이다. 국내 증권사의 정정 요청으로
표현할 수 있는 것은 잔량 전부를 새 가격으로 옮기는 정정뿐이라, "amount − 체결 수량 = 잔량" 이 아닌 조합(수량을 줄이거나 늘리는 정정)은
요청 전에 막는다. 잔량 일부만 옮기는 일부정정은 증권사 고유 기능이라 `params['partial']` 로만 받는다.
"""

from typing import Any, Dict, Optional

from kr_broker.base import functions as fn
from kr_broker.base.errors import NotSupported
from kr_broker.base.precise import Precise


def edit_order_total(original: Dict[str, Any]) -> Optional[float]:
    """원주문의 총수량(체결 수량 + 잔량). 둘 중 하나라도 모르면 `None`."""
    filled, remaining = original.get('filled'), original.get('remaining')
    if filled is None or remaining is None:
        return None
    return fn.js_number(Precise.string_add(fn.number_to_string(filled), fn.number_to_string(remaining)))


def assert_whole_remaining_edit(exchange_id: str, order_id: str, amount: Any, original: Dict[str, Any]) -> None:
    """`amount` 가 원주문의 총수량과 같으면 지나가고, 다르면 요청 전에 `NotSupported` 다. 체결 수량이나 잔량을 모르면 대조할 수 없어 던진다.
    추정한 잔량으로 정정하지 않기 위해서다."""
    total = edit_order_total(original)
    if total is None:
        raise NotSupported(f'{exchange_id} editOrder() 원주문 {order_id} 의 체결 수량과 잔량을 몰라 amount 를 대조하지 못했다. amount 를 빼면 잔량 전부를 정정한다')
    if Precise.string_eq(fn.number_to_string(amount), fn.number_to_string(total)) is not True:
        raise NotSupported(f"{exchange_id} editOrder() 의 amount 는 정정 뒤 총수량(체결 {fn.js_string(original.get('filled'))} + 잔량 "
                           f"{fn.js_string(original.get('remaining'))} = {fn.js_string(total)})이어야 한다: {fn.js_string(amount)}. "
                           '수량을 바꾸는 정정은 한 요청으로 낼 수 없다. 취소한 뒤 다시 주문하거나, 증권사가 지원하면 params.partial 로 일부정정한다')
