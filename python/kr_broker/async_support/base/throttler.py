"""`kr_broker/base/throttler.py` 의 비동기 판. 토큰 버킷 계산은 동기 판을 그대로 쓰고, 기다리는 일만 이벤트 루프에 맡긴다.

코루틴 여럿이 한 인스턴스를 나눠 써도 들어온 순서대로 나가도록 루프별 락을 건다.
"""

import time
from typing import Any, Awaitable, Callable, Optional

from kr_broker.async_support.base.runtime import new_lock, sleep_seconds
from kr_broker.base.throttler import Throttler as SyncThrottler


class Throttler(SyncThrottler):
    def __init__(self, refill_rate: float, capacity: float = 1, cost: float = 1,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], Awaitable[Any]] = sleep_seconds) -> None:
        super().__init__(refill_rate, capacity, cost, clock)
        self._async_sleep = sleep
        self._async_lock = new_lock()

    async def throttle(self, cost: Optional[float] = None) -> None:  # type: ignore[override]
        """자기 차례가 오고 토큰이 음수가 아닐 때까지 기다린 뒤 비용만큼 토큰을 쓴다."""
        async with self._async_lock:
            self._refill()
            while self._tokens < 0:
                await self._async_sleep(-self._tokens / self.refill_rate / 1000)
                self._refill()
            self._tokens -= self.cost if cost is None else cost
