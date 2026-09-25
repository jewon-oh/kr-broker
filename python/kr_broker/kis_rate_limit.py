"""한국투자증권 앱키 단위 요청 스케줄러의 예약표. TypeScript 판 `ts/src/kis.ts` 의 앱키 스케줄러와 같다.

초당 거래건수 초과(EGW00201)를 막는다. 같은 프로세스에서 같은 앱키를 쓰는 인스턴스는 하나의 스케줄을 나눠 쓰고,
각 호출은 들어오는 즉시 다음 가용 시각을 예약하므로 스레드나 코루틴이 동시에 들어와도 간격을 두고 차례로 나간다.
동기 판(`kr_broker.kis`)과 비동기 판(`kr_broker.async_support.kis`)이 같은 예약표를 쓰도록 생성 대상 밖에 둔다.
"""

import threading
import time
from typing import Dict, Optional


_next_slot_at: Dict[str, float] = {}
# 예약만 잡고 바로 푼다. 기다리는 일은 락 밖에서 하므로 비동기 판에서 잡아도 이벤트 루프를 오래 막지 않는다.
_slot_lock = threading.Lock()


def reserve_kis_slot(app_key: str, interval_ms: float) -> float:
    """다음 가용 시각을 예약하고, 그 시각까지 기다려야 하는 시간(ms)을 돌려준다. 0 이하면 바로 보내도 된다."""
    with _slot_lock:
        # 단조 시계(monotonic)를 쓴다. 시스템 시각은 NTP 보정이나 VM 재개로 뒤로 가면 그만큼 모든 요청이 멈춘다.
        now = time.monotonic() * 1000
        scheduled_at = max(now, _next_slot_at.get(app_key, 0))
        _next_slot_at[app_key] = scheduled_at + interval_ms
    return scheduled_at - now


def reset_kis_rate_limiter(app_key: Optional[str] = None) -> None:
    """예약 상태를 비운다(테스트용)."""
    with _slot_lock:
        if app_key is None:
            _next_slot_at.clear()
        else:
            _next_slot_at.pop(app_key, None)
