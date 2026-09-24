"""주문 접수 뒤 실체결 확정(증권사 공용 폴링). TypeScript 판 `ts/src/execution-confirm.ts` 와 같다.

접수 응답에는 체결 정보가 없다. 한 번만 조회하고 포기하면 요청가와 요청 수량이 체결값으로 기록되므로, 체결이 확정될 때까지 예산 안에서 짧게 조회한다.
증권사 클래스는 자기 응답을 `{'snapshot', 'terminal'}` 로 옮기는 조회 함수 하나만 넘긴다.

체결 스냅샷은 `{'filled', 'average', 'amount', 'fee', 'feeCurrency'}` 사전이다. 브로커가 확정한 값만 담고, 모르는 값은 `None` 이다.
"""

import logging
import math
import time
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger('kr_broker')

# 폴링 예산 기본값: 6회 × 350ms ≈ 최대 1.75초. 토스 주문 정보 그룹의 한도(개장 직후 3건/초)를 넘지 않는 간격이다.
DEFAULT_ATTEMPTS = 6
DEFAULT_INTERVAL_MS = 350

_ATTEMPTS_RANGE = (1, 50)
# 0 은 폴링 없이 곧바로 다시 조회한다는 뜻이다(테스트·초저지연 브로커).
_INTERVAL_RANGE = (0, 10_000)


def _is_integer(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value) and value.is_integer()


def _valid_budget_value(name: str, value: Any, low: int, high: int) -> Optional[int]:
    """범위 안의 정수면 그 값, 아니면 `None`. 범위를 벗어난 값은 경고를 남기고 무시한다."""
    if value is None:
        return None
    if not _is_integer(value) or value < low or value > high:
        logger.warning('[execution-confirm] 예산 값이 범위를 벗어나 무시한다: %s=%r (범위 %s~%s)', name, value, low, high)
        return None
    return int(value)


def resolve_confirm_budget(defaults: Optional[Dict[str, Any]] = None, overrides: Optional[Dict[str, Any]] = None) -> Dict[str, int]:
    """예산 `{'attempts', 'intervalMs'}`. 공용 기본값 < `defaults`(증권사 클래스) < `overrides`(사용자 옵션) 순으로 뒤가 이긴다."""
    def pick(name: str, low: int, high: int, fallback: int) -> int:
        for layer in (overrides, defaults):
            value = _valid_budget_value(name, (layer or {}).get(name), low, high)
            if value is not None:
                return value
        return fallback
    return {
        'attempts': pick('attempts', *_ATTEMPTS_RANGE, DEFAULT_ATTEMPTS),
        'intervalMs': pick('intervalMs', *_INTERVAL_RANGE, DEFAULT_INTERVAL_MS),
    }


def confirm_execution(label: str, order_id: str, exchange: str, probe: Callable[[int], Dict[str, Any]],
                      defaults: Optional[Dict[str, Any]] = None, budget: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """체결이 확정될 때까지 짧게 조회한다.

    `probe(attempt)` 가 `terminal` 을 돌려주면(완전체결·취소·거부) 그때까지 가장 많이 채워진 스냅샷으로 끝내고, 예산을 다 쓰면 그때까지의 스냅샷을 돌려준다.
    `probe` 는 던져도 된다(조회 실패로 보고 다음 시도로 넘어간다). 주문은 이미 접수됐으므로 이 함수는 던지지 않는다. 확정하지 못하면 `None`.
    """
    resolved = resolve_confirm_budget(defaults, budget)
    attempts, interval_ms = resolved['attempts'], resolved['intervalMs']
    best: Optional[Dict[str, Any]] = None
    for attempt in range(1, attempts + 1):
        if attempt > 1 and interval_ms > 0:
            time.sleep(interval_ms / 1000)
        try:
            result = probe(attempt)
        except Exception:
            logger.warning('%s 체결 조회 실패, 다시 시도한다(주문 %s, %s, %d/%d)', label, order_id, exchange, attempt, attempts, exc_info=True)
            continue
        snap = result.get('snapshot')
        if snap is not None and snap['filled'] > 0 and (best is None or snap['filled'] > best['filled']):
            best = snap
        if result.get('terminal'):
            if best is None:
                logger.warning('%s 주문이 체결 없이 끝났다. 체결 기록 없음(주문 %s, %s, %d회째)', label, order_id, exchange, attempt)
            return best
    if best is None:
        logger.warning('%s 체결 미확인: 요청 수량과 호가로 기록된다. 진입가와 슬리피지에 오차가 날 수 있다(주문 %s, %s, %d회 %dms)',
                       label, order_id, exchange, attempts, (attempts - 1) * interval_ms)
    else:
        logger.warning('%s 부분체결 상태로 예산을 다 썼다. 관측된 체결분으로 기록한다(주문 %s, %s, 체결 %s)', label, order_id, exchange, best['filled'])
    return best


def _num(value: Any) -> float:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else 0


def trade_list_probe(fetch_trades: Callable[[], List[Dict[str, Any]]], order_id: str, requested_qty: float,
                     fee_currency: Optional[str] = None) -> Callable[..., Dict[str, Any]]:
    """체결 내역 목록만 주는 증권사(한국투자증권·KB증권)용 조회 함수를 만든다.

    주문 하나를 조회하는 API 가 없어 계좌 체결 내역을 주문 id 로 걸러 합산한다. 분할체결이면 같은 주문의 행이 여러 개라 수량 가중으로 합치고,
    요청 수량을 다 채웠을 때만 끝난 것으로 본다(체결 내역에는 주문이 끝났다는 신호가 없다).
    """
    warned = [False]

    def probe(*_: Any) -> Dict[str, Any]:
        rows = [t for t in fetch_trades() if t.get('order') == order_id]
        filled = sum(_num(t.get('amount')) for t in rows)
        if not filled > 0:
            # 주문의 행이 있는데 수량이 0 이면 아직 미체결이 아니라 응답 필드 이름이 어긋난 것이다. 조회마다 쌓이지 않게 한 번만 남긴다.
            if rows and not warned[0]:
                warned[0] = True
                raw = rows[0].get('info')
                keys = list((raw if isinstance(raw, dict) else rows[0]).keys())[:40]
                logger.warning('[execution-confirm] 주문의 체결 행은 있으나 수량이 0 으로 읽혔다. 응답 필드 이름을 대조한다(주문 %s, 행 %d, 키 %s)',
                               order_id, len(rows), keys)
            return {'snapshot': None, 'terminal': False}
        # 체결 금액은 브로커가 준 cost 합이 먼저이고, 없으면 수량 × 단가다.
        cost = sum(_num(t.get('cost')) or _num(t.get('amount')) * _num(t.get('price')) for t in rows)
        has_fee = any((t.get('fee') or {}).get('cost') is not None for t in rows)
        fee = sum(_num((t.get('fee') or {}).get('cost')) for t in rows) if has_fee else None
        return {
            'snapshot': {
                'filled': filled,
                'average': cost / filled if cost > 0 else None,
                'amount': cost if cost > 0 else None,
                'fee': fee,
                'feeCurrency': fee_currency,
            },
            'terminal': filled >= requested_qty if requested_qty > 0 else True,
        }

    return probe


def fill_deviation_bps(quoted_price: Optional[float], filled_price: Optional[float]) -> Optional[int]:
    """호가 대비 실제 체결 괴리(bps). 두 가격이 모두 양수일 때만 값이 있다."""
    if quoted_price is None or not quoted_price > 0 or filled_price is None or not filled_price > 0:
        return None
    # JavaScript 의 Math.round 처럼 .5 는 올린다.
    return math.floor((filled_price - quoted_price) / quoted_price * 10_000 + 0.5)
