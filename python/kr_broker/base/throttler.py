"""요청 간격 조절기(토큰 버킷). TypeScript 판 `ts/src/base/functions/throttle.ts` 와 같은 규칙이다.

토큰이 밀리초당 `refill_rate` 만큼 차오르고(`capacity` 가 상한), 요청은 `cost` 만큼 토큰을 쓴다. 토큰이 음수인 동안 다음 요청은 기다린다.
그래서 `refill_rate = 1 / rate_limit` 이면 "요청 뒤 `rate_limit × cost` 밀리초가 지나야 다음 요청이 나간다"가 된다.
스레드 여럿이 한 인스턴스를 나눠 써도 들어온 순서대로 나가도록 잠금을 건다.
"""

import threading
import time
from typing import Callable, Optional


class Throttler:
    def __init__(self, refill_rate: float, capacity: float = 1, cost: float = 1,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep) -> None:
        self.refill_rate = refill_rate
        self.capacity = capacity
        self.cost = cost
        self._clock = clock
        self._sleep = sleep
        self._tokens = 0.0
        self._last_refill = self._now_ms()
        self._lock = threading.Lock()

    def _now_ms(self) -> float:
        return self._clock() * 1000

    def _refill(self) -> None:
        current = self._now_ms()
        elapsed = current - self._last_refill
        self._last_refill = current
        self._tokens = min(self.capacity, self._tokens + self.refill_rate * elapsed)

    def throttle(self, cost: Optional[float] = None) -> None:
        """자기 차례가 오고 토큰이 음수가 아닐 때까지 기다린 뒤 비용만큼 토큰을 쓴다."""
        with self._lock:
            self._refill()
            while self._tokens < 0:
                self._sleep(-self._tokens / self.refill_rate / 1000)
                self._refill()
            self._tokens -= self.cost if cost is None else cost
