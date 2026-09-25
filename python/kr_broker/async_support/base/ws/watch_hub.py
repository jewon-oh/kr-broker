"""ccxt pro 의 `watch*` 의미를 구현하는 대기열. TypeScript 판 `ts/src/base/watch-hub.ts` 와 같다. 호출마다 다음 갱신을 돌려준다.

메시지 해시(`ticker:005930/KRW` 등)마다 기다리는 Future 를 모아 두고 새 값이 오면 한꺼번에 푼다. 체결과 주문처럼 여러 건이 쌓이는 것은
기다리는 쪽이 없을 때 모아 두었다가 다음 호출에 한꺼번에 돌려준다(ccxt pro 의 `newUpdates` 와 같다).
"""

import asyncio
import functools
from typing import Any, Dict, List, Optional

# 쌓아 두는 항목 수의 상한(ccxt pro 의 `tradesLimit` 기본값과 같다). 넘으면 오래된 것부터 버린다.
BUFFER_LIMIT = 1000


class WatchHub:
    def __init__(self) -> None:
        self._waiters: Dict[str, List['asyncio.Future[Any]']] = {}
        self._buffers: Dict[str, List[Any]] = {}

    def next(self, hash: str) -> 'asyncio.Future[Any]':
        """`hash` 의 다음 값을 기다리는 Future. 실행 중인 이벤트 루프 안에서 부른다. 취소되면 대기 목록에서 빠진다."""
        future = asyncio.get_running_loop().create_future()
        self._waiters.setdefault(hash, []).append(future)
        future.add_done_callback(functools.partial(self._forget, hash))
        return future

    def _forget(self, hash: str, future: 'asyncio.Future[Any]') -> None:
        waiters = self._waiters.get(hash)
        if waiters is not None and future in waiters:
            waiters.remove(future)
            if not waiters:
                del self._waiters[hash]

    def _take_waiters(self, hash: str) -> List['asyncio.Future[Any]']:
        """`hash` 의 대기자를 꺼낸다. 끝난(취소된) Future 는 버린다."""
        return [future for future in self._waiters.pop(hash, []) if not future.done()]

    def resolve(self, hash: str, value: Any) -> None:
        """기다리는 쪽을 모두 `value` 로 푼다. 기다리는 쪽이 없으면 버린다."""
        for future in self._take_waiters(hash):
            future.set_result(value)

    def next_batch(self, hash: str) -> 'asyncio.Future[Any]':
        """쌓아 둔 새 항목이 있으면 바로 돌려주고, 없으면 다음 항목을 기다린다."""
        buffered = self._buffers.pop(hash, None)
        if buffered:
            future = asyncio.get_running_loop().create_future()
            future.set_result(buffered)
            return future
        return self.next(hash)

    def push(self, hash: str, item: Any) -> None:
        """항목을 쌓는다. 기다리는 쪽이 있으면 쌓인 것까지 한꺼번에 넘기고, 없으면 다음 `next_batch` 까지 둔다."""
        items = self._buffers.pop(hash, [])
        items.append(item)
        if len(items) > BUFFER_LIMIT:
            del items[:len(items) - BUFFER_LIMIT]
        waiters = self._take_waiters(hash)
        if not waiters:
            self._buffers[hash] = items
        for future in waiters:
            future.set_result(items)

    def reject(self, reason: BaseException, hashes: Optional[List[str]] = None) -> None:
        """기다리는 Future 를 `reason` 으로 끝낸다. `hashes` 를 주지 않으면 전부이고, 쌓아 둔 항목도 버린다."""
        targets = list(self._waiters.keys()) if hashes is None else hashes
        for hash in targets:
            for future in self._take_waiters(hash):
                future.set_exception(reason)
        if hashes is None:
            self._buffers.clear()
