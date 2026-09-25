"""`kr_broker/base/runtime.py` 의 비동기 짝. 이름과 인자가 같아야 한다(동기 판 생성이 가져오는 곳만 바꾼다).

락과 세마포어는 이벤트 루프마다 따로 만든다. asyncio 의 락은 처음 기다린 루프에 묶이므로, 한 인스턴스를 `asyncio.run` 여러 번에
걸쳐 쓰면 두 번째 루프에서 `RuntimeError` 가 난다. 루프별로 나누면 이 문제가 없고, 한 루프 안에서는 보통의 asyncio 락과 같다.
"""

import asyncio
import inspect
import weakref
from typing import Any, Awaitable, Callable, TypeVar, Union

T = TypeVar('T')


async def sleep_seconds(seconds: float) -> None:
    """`seconds` 초 기다린다."""
    await asyncio.sleep(seconds)


class _PerLoop:
    """실행 중인 이벤트 루프마다 `factory()` 로 만든 락·세마포어를 하나씩 둔다. `async with` 로 잡는다."""

    def __init__(self, factory: Callable[[], Any]) -> None:
        self._factory = factory
        self._by_loop: 'weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, Any]' = weakref.WeakKeyDictionary()

    def current(self) -> Any:
        loop = asyncio.get_running_loop()
        primitive = self._by_loop.get(loop)
        if primitive is None:
            primitive = self._by_loop[loop] = self._factory()
        return primitive

    async def __aenter__(self) -> '_PerLoop':
        await self.current().acquire()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.current().release()

    def locked(self) -> bool:
        return self.current().locked()


def new_lock() -> Any:
    """`async with` 로 잡는 락."""
    return _PerLoop(asyncio.Lock)


def new_semaphore(value: int) -> Any:
    """`async with` 로 잡는 세마포어."""
    return _PerLoop(lambda: asyncio.BoundedSemaphore(value))


async def maybe_await(value: Union[T, Awaitable[T]]) -> T:
    """값이 코루틴(또는 다른 awaitable)이면 기다려 결과를 돌려주고, 아니면 그대로 돌려준다.
    토큰 저장소처럼 사용자가 동기 구현과 비동기 구현 가운데 하나를 넣는 자리에 쓴다."""
    if inspect.isawaitable(value):
        return await value
    return value  # type: ignore[return-value]
