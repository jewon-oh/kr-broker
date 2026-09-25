"""실시간 테스트가 함께 쓰는 가짜 웹소켓. aiohttp `ClientWebSocketResponse` 의 쓰는 부분만 흉내 낸다."""

import asyncio
from typing import Dict, List, Optional

import aiohttp


class FakeWs:
    """받을 프레임은 `feed()` 로 넣고, 보낸 프레임은 `sent` 에 쌓인다. `drop()` 은 서버가 연결을 끊은 것과 같다."""

    def __init__(self, url: str, headers: Dict[str, str]) -> None:
        self.url = url
        self.headers = dict(headers)
        self.sent: List[str] = []
        self.closed = False
        self.close_code: Optional[int] = None
        self._inbox: 'asyncio.Queue[Optional[aiohttp.WSMessage]]' = asyncio.Queue()

    async def send_str(self, text: str) -> None:
        if self.closed:
            raise ConnectionResetError('closed')
        self.sent.append(text)

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            self._inbox.put_nowait(None)

    def feed(self, text: str) -> None:
        self._inbox.put_nowait(aiohttp.WSMessage(aiohttp.WSMsgType.TEXT, text, None))

    def drop(self) -> None:
        self.close_code = 1006
        self._inbox.put_nowait(aiohttp.WSMessage(aiohttp.WSMsgType.CLOSE, 1006, None))

    def __aiter__(self) -> 'FakeWs':
        return self

    async def __anext__(self) -> aiohttp.WSMessage:
        message = await self._inbox.get()
        if message is None:
            raise StopAsyncIteration
        if message.type == aiohttp.WSMsgType.CLOSE:
            self.closed = True
        return message


class FakeConnector:
    """연결 함수. 부를 때마다 새 `FakeWs` 를 만들고, `failures` 만큼은 먼저 실패한다."""

    def __init__(self, failures: int = 0) -> None:
        self.sockets: List[FakeWs] = []
        self.failures = failures
        self.calls = 0

    async def __call__(self, url: str, headers: Dict[str, str]) -> FakeWs:
        self.calls += 1
        if self.failures > 0:
            self.failures -= 1
            raise aiohttp.ClientConnectionError('refused')
        ws = FakeWs(url, headers)
        self.sockets.append(ws)
        return ws

    @property
    def last(self) -> FakeWs:
        return self.sockets[-1]


class RecordingSleep:
    """재연결 대기를 기록만 하고 바로 돌아온다."""

    def __init__(self) -> None:
        self.delays: List[float] = []

    async def __call__(self, seconds: float) -> None:
        self.delays.append(seconds)
        await asyncio.sleep(0)


async def settle(times: int = 5) -> None:
    """띄운 작업이 한 걸음씩 나아가도록 이벤트 루프를 몇 번 돌린다."""
    for _ in range(times):
        await asyncio.sleep(0)
