"""`kr_broker/market_calendar.py` 의 `refresh_market_calendar` 비동기 판. 캘린더와 갱신 상태는 동기 판 모듈의 것을 함께 쓴다."""

from typing import Any, Awaitable, Callable, Dict, Iterable, Optional

from kr_broker.async_support.base.runtime import new_lock
from kr_broker.base import functions as fn
from kr_broker.market_calendar import (
    _MARKETS, _record_refresh_failure, _record_refresh_success, _refresh_skipped, apply_market_calendar,
)

# 같은 시장의 동시 갱신을 하나로 합친다. 뒤에 들어온 호출은 앞 호출이 끝난 뒤 신선도를 다시 본다.
_refresh_locks = {market: new_lock() for market in _MARKETS}


async def refresh_market_calendar(market: str, fetch_days: Callable[[], Awaitable[Iterable[Dict[str, Any]]]], ttl_ms: int,
                                  now_ms: Optional[int] = None) -> bool:
    """캘린더를 API 로 갱신한다. `fetch_days` 가 코루틴 함수라는 것만 동기 판과 다르다."""
    now = fn.milliseconds() if now_ms is None else now_ms
    async with _refresh_locks[market]:
        skipped = _refresh_skipped(market, ttl_ms, now)
        if skipped is not None:
            return skipped
        try:
            apply_market_calendar(market, await fetch_days())
        except Exception:
            return _record_refresh_failure(market, now)
        return _record_refresh_success(market, now)
