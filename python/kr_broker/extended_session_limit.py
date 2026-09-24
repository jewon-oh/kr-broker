"""확장세션 시장가 → 지정가 전환. TypeScript 판 `ts/src/extended-session-limit.ts` 와 같다.

확장세션(프리·애프터, 미국 주간거래)은 지정가만 받으므로, 시장가 청산을 내려면 지정가로 바꿔야 한다. 증권사마다 다르게 처리하면
한쪽은 확장세션 청산이 안 되므로 토스증권과 한국투자증권이 이 구현을 함께 쓴다. 불변식은 둘이다.

1. 같은 방향 미체결이 있으면 다시 내지 않는다. 조회에 실패해도 내지 않는다(중복 호가가 미발주보다 나쁘다).
2. 기준가(최종가)를 구하지 못하면 내지 않는다(지정가를 지어내지 않는다).
"""

from typing import Any, Callable, Dict, Optional


def build_extended_session_limit(source: Any, order: Dict[str, Any], label: str,
                                 on_warn: Optional[Callable[[BaseException, str], None]] = None) -> Dict[str, Any]:
    """확장세션 지정가를 구한다. `{'price': 지정가}` 이거나, 보류해야 하면 `{'error': 사유}` 다.

    `source` 는 `fetch_open_orders(symbol)` 과 `fetch_ticker(symbol)` 이 있는 증권사 클래스이고, `order` 는 `{'symbol', 'side'}` 다.
    `on_warn(오류, 메시지)` 는 미체결 조회 실패를 알리는 훅이다.
    """
    try:
        open_orders = source.fetch_open_orders(order['symbol'])
        dup = next((o for o in open_orders if str(o.get('side') or '').lower() == order['side']), None)
        if dup is not None:
            return {'error': f"확장세션 지정가 미체결 대기 중({dup.get('id')}) — 중복 발주 스킵"}
    except Exception as err:
        if on_warn is not None:
            on_warn(err, f'{label} 확장세션 미체결 조회 실패 — 발주 보류')
        return {'error': '확장세션: 미체결 주문 조회 실패 — 중복 발주 위험으로 보류'}
    # 시세 조회가 실패해도 기준가가 없는 것과 같다. 지정가를 지어내지 않고 보류한다.
    try:
        last = source.fetch_ticker(order['symbol']).get('last')
    except Exception:
        last = None
    if last is None or not last > 0:
        return {'error': '확장세션: 기준가(last) 조회 실패 — 지정가 산출 불가'}
    return {'price': last}
