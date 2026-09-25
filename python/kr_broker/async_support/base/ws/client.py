"""끊기면 다시 잇는 웹소켓 연결 하나. 증권사 실시간 스트림(`kr_broker.pro`)이 상속한다.

TypeScript 판 `KisRealtimeStream`, `TossPriceWs` 의 연결 관리를 한곳에 모았다.

- `start()` 가 연결 작업을 띄운다. 실행 중인 이벤트 루프 안에서 부른다. 작업이 끝났으면(앞선 `asyncio.run` 이 끝나며 취소됐으면) 다시 띄운다.
- 연결할 때마다 `connect_target()` 이 주소와 헤더를 준다(접속키나 토큰 발급). 던지면 백오프 뒤 다시 시도한다.
- 연결되면 `on_open()` 을, 텍스트 프레임마다 `on_message(text)` 를 부른다. 두 훅이 던진 오류는 로그만 남긴다.
- 끊기면 이전 연결을 닫고 `reconnect_base_ms × 2^(시도-1)`(상한 `reconnect_max_ms`) 뒤 다시 잇는다. 연결되면 시도 횟수를 0 으로 되돌린다.
- `ping_interval_ms` 가 있으면 그 간격으로 `ping_text` 를 보낸다.

연결은 `connect(url, headers)` 코루틴이 만든다. 증권사 클래스는 `session_connector(exchange)` 로 인스턴스의 aiohttp 세션을 쓰고,
테스트는 가짜 연결을 넘긴다. 연결 객체는 aiohttp `ClientWebSocketResponse` 처럼 `send_str()`, `close()`, `closed` 와
`WSMessage` 를 내는 비동기 반복을 갖춘다.
"""

import asyncio
import logging
from typing import Any, Awaitable, Callable, Dict, Optional, Set, Tuple

import aiohttp

from kr_broker.async_support.base.runtime import sleep_seconds

logger = logging.getLogger('kr_broker')

WsConnect = Callable[[str, Dict[str, str]], Awaitable[Any]]

_CLOSING = (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR)


def session_connector(exchange: Any) -> WsConnect:
    """증권사 인스턴스의 aiohttp 세션으로 웹소켓을 여는 연결 함수. 세션이 없으면 연다."""
    async def connect(url: str, headers: Dict[str, str]) -> Any:
        exchange.open()
        return await exchange.session.ws_connect(url, headers=headers)
    return connect


class ReconnectingWebSocket:
    label = '[ws]'
    reconnect_base_ms = 1_000
    reconnect_max_ms = 30_000
    ping_interval_ms: Optional[int] = None
    ping_text = 'PING'

    def __init__(self, connect: WsConnect, sleep: Callable[[float], Awaitable[Any]] = sleep_seconds) -> None:
        self._connect = connect
        self._sleep = sleep
        self.ws: Any = None
        self.reconnect_attempts = 0
        self._task: Optional['asyncio.Task[None]'] = None
        self._ping_task: Optional['asyncio.Task[None]'] = None
        self._sends: Set['asyncio.Task[None]'] = set()

    # ---- 하위 클래스가 채우는 훅 ----

    async def connect_target(self) -> Tuple[str, Dict[str, str]]:
        """이번 연결의 주소와 헤더."""
        raise NotImplementedError

    def on_open(self) -> None:
        """연결 직후. 구독을 보낸다."""

    def on_message(self, text: str) -> None:
        """텍스트 프레임 하나."""

    # ---- 연결 관리 ----

    @property
    def running(self) -> bool:
        """연결 작업이 돌고 있는가. `stop()` 뒤나 작업을 띄운 이벤트 루프가 끝난 뒤에는 거짓이다."""
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        if self.running:
            return
        self._task = asyncio.ensure_future(self._run())

    async def stop(self) -> None:
        """연결을 닫고 다시 잇지 않는다."""
        self._stop_ping()
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        ws, self.ws = self.ws, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                logger.debug('%s 연결 닫기 실패(이미 닫혔다)', self.label, exc_info=True)

    def is_connected(self) -> bool:
        return self.ws is not None and not self.ws.closed

    def send(self, text: str) -> bool:
        """열린 연결로 보낸다. 연결이 없으면 보내지 않고 `False` 다(연결되면 `on_open` 이 다시 보낸다)."""
        if not self.is_connected():
            return False
        task = asyncio.ensure_future(self._send(self.ws, text))
        self._sends.add(task)
        task.add_done_callback(self._sends.discard)
        return True

    async def _send(self, ws: Any, text: str) -> None:
        try:
            await ws.send_str(text)
        except Exception:
            logger.warning('%s 전송 실패', self.label, exc_info=True)

    async def _run(self) -> None:
        while self.running:
            try:
                url, headers = await self.connect_target()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error('%s 접속 준비 실패 — 재연결 예약', self.label, exc_info=True)
                await self._backoff()
                continue
            try:
                ws = await self._connect(url, headers)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning('%s 연결 실패 — 재연결 예약', self.label, exc_info=True)
                await self._backoff()
                continue
            self.ws = ws
            self.reconnect_attempts = 0
            self._call_hook(self.on_open)
            self._start_ping()
            try:
                async for message in ws:
                    if message.type == aiohttp.WSMsgType.TEXT:
                        self._call_hook(self.on_message, message.data)
                    elif message.type == aiohttp.WSMsgType.BINARY:
                        self._call_hook(self.on_message, message.data.decode('utf-8', errors='replace'))
                    elif message.type in _CLOSING:
                        break
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning('%s 연결 오류', self.label, exc_info=True)
            finally:
                self._stop_ping()
                if self.ws is ws:
                    self.ws = None
                # 다시 잇기 전에 이전 연결을 닫는다. 닫지 않으면 새 연결마다 이전 연결이 밀려나 끊김이 되풀이될 수 있다.
                try:
                    await ws.close()
                except Exception:
                    logger.debug('%s 이전 연결 닫기 실패', self.label, exc_info=True)
            if self.running:
                logger.warning('%s 연결 종료(code=%s) — 재연결 예약', self.label, getattr(ws, 'close_code', None))
                await self._backoff()

    async def _backoff(self) -> None:
        self.reconnect_attempts += 1
        delay_ms = min(self.reconnect_base_ms * 2 ** (self.reconnect_attempts - 1), self.reconnect_max_ms)
        await self._sleep(delay_ms / 1000)

    def _call_hook(self, hook: Callable[..., Any], *args: Any) -> None:
        try:
            hook(*args)
        except Exception:
            logger.warning('%s %s 처리 실패', self.label, getattr(hook, '__name__', hook), exc_info=True)

    # ---- keepalive ----

    def _start_ping(self) -> None:
        self._stop_ping()
        if self.ping_interval_ms:
            self._ping_task = asyncio.ensure_future(self._ping_loop())

    def _stop_ping(self) -> None:
        task, self._ping_task = self._ping_task, None
        if task is not None and not task.done():
            task.cancel()

    async def _ping_loop(self) -> None:
        assert self.ping_interval_ms is not None
        # 재연결 대기(`self._sleep`)와 달리 실제 시간으로 기다린다. 테스트가 대기를 바꿔 끼워도 핑이 쉬지 않고 나가지 않는다.
        while True:
            await sleep_seconds(self.ping_interval_ms / 1000)
            self.send(self.ping_text)
