"""실시간 공용 계층: `WatchHub`(TypeScript 판 `watch-hub.test.ts` 를 옮겼다)와 재연결 클라이언트."""

import asyncio
from typing import Any, Dict, List, Tuple

import pytest

from kr_broker.async_support.base.ws.client import ReconnectingWebSocket
from kr_broker.async_support.base.ws.watch_hub import BUFFER_LIMIT, WatchHub
from ws_support import FakeConnector, RecordingSleep, settle


# ============ WatchHub ============

def test_next_gets_the_next_resolve_and_all_waiters_share_it() -> None:
    async def main() -> List[int]:
        hub = WatchHub()
        a, b = hub.next('ticker:X'), hub.next('ticker:X')
        hub.resolve('ticker:X', 1)
        return list(await asyncio.gather(a, b))

    assert asyncio.run(main()) == [1, 1]


def test_resolve_without_waiters_is_dropped() -> None:
    async def main() -> int:
        hub = WatchHub()
        hub.resolve('ticker:X', 1)
        pending = hub.next('ticker:X')
        hub.resolve('ticker:X', 2)
        return await pending

    assert asyncio.run(main()) == 2


def test_push_buffers_until_next_batch() -> None:
    async def main() -> Tuple[Any, Any]:
        hub = WatchHub()
        hub.push('trades:X', 'a')
        hub.push('trades:X', 'b')
        first = await hub.next_batch('trades:X')
        pending = hub.next_batch('trades:X')
        hub.push('trades:X', 'c')
        return first, await pending

    assert asyncio.run(main()) == (['a', 'b'], ['c'])


def test_push_keeps_only_the_latest_items() -> None:
    async def main() -> Any:
        hub = WatchHub()
        for i in range(BUFFER_LIMIT + 5):
            hub.push('trades:X', i)
        return await hub.next_batch('trades:X')

    items = asyncio.run(main())
    assert len(items) == BUFFER_LIMIT and items[0] == 5


def test_reject_given_hashes_or_everything() -> None:
    async def main() -> None:
        hub = WatchHub()
        a, b = hub.next('a'), hub.next('b')
        hub.reject(RuntimeError('a 만'), ['a'])
        with pytest.raises(RuntimeError, match='a 만'):
            await a
        assert not b.done()
        hub.push('trades:X', 'kept?')
        hub.reject(RuntimeError('전부'))
        with pytest.raises(RuntimeError, match='전부'):
            await b
        # 전부 거절하면 쌓아 둔 항목도 버린다.
        pending = hub.next_batch('trades:X')
        assert not pending.done()
        pending.cancel()

    asyncio.run(main())


def test_cancelled_waiter_does_not_break_resolve() -> None:
    async def main() -> int:
        hub = WatchHub()
        gone = hub.next('t')
        gone.cancel()
        alive = hub.next('t')
        hub.resolve('t', 7)
        return await alive

    assert asyncio.run(main()) == 7


def test_push_keeps_items_when_the_only_waiter_was_cancelled() -> None:
    async def main() -> Any:
        hub = WatchHub()
        hub.next_batch('orders').cancel()
        hub.push('orders', 'fill')
        return await asyncio.wait_for(hub.next_batch('orders'), 1)

    assert asyncio.run(main()) == ['fill']


def test_timed_out_watch_does_not_take_the_next_items() -> None:
    async def main() -> Any:
        hub = WatchHub()
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(hub.next_batch('orders'), 0.01)
        hub.push('orders', 'fill')
        return await asyncio.wait_for(hub.next_batch('orders'), 1)

    assert asyncio.run(main()) == ['fill']


def test_cancelled_waiters_leave_the_hub() -> None:
    async def main() -> Dict[str, Any]:
        hub = WatchHub()
        for _ in range(3):
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(hub.next('ticker:X'), 0.001)
        hub.next('ticker:Y').cancel()
        await settle()
        return hub._waiters

    assert asyncio.run(main()) == {}


# ============ 재연결 클라이언트 ============

class EchoStream(ReconnectingWebSocket):
    label = '[test]'
    reconnect_base_ms = 1_000
    reconnect_max_ms = 4_000

    def __init__(self, connect: Any, sleep: Any, targets: List[Any]) -> None:
        super().__init__(connect, sleep)
        self.targets = targets
        self.received: List[str] = []
        self.opened = 0

    async def connect_target(self) -> Tuple[str, Dict[str, str]]:
        target = self.targets.pop(0) if len(self.targets) > 1 else self.targets[0]
        if isinstance(target, Exception):
            raise target
        return target, {'Authorization': 'Bearer t'}

    def on_open(self) -> None:
        self.opened += 1
        self.send('hello')

    def on_message(self, text: str) -> None:
        if text == 'boom':
            raise ValueError('훅 실패')
        self.received.append(text)


def test_connects_sends_on_open_and_dispatches_messages() -> None:
    async def main() -> None:
        connector, sleep = FakeConnector(), RecordingSleep()
        stream = EchoStream(connector, sleep, ['wss://x'])
        stream.start()
        await settle()
        ws = connector.last
        assert ws.url == 'wss://x' and ws.headers == {'Authorization': 'Bearer t'}
        assert stream.is_connected() and ws.sent == ['hello']
        ws.feed('boom')  # 훅이 던져도 연결은 이어진다
        ws.feed('a')
        await settle()
        assert stream.received == ['a'] and stream.is_connected()
        await stream.stop()
        assert ws.closed and not stream.is_connected() and stream.send('late') is False

    asyncio.run(main())


def test_reconnects_with_exponential_backoff_and_resets_after_open() -> None:
    async def main() -> None:
        connector, sleep = FakeConnector(failures=3), RecordingSleep()
        stream = EchoStream(connector, sleep, ['wss://x'])
        stream.start()
        await settle(20)
        # 실패 세 번: 1초, 2초, 4초(상한). 네 번째에 연결된다.
        assert sleep.delays == [1.0, 2.0, 4.0] and connector.calls == 4 and stream.opened == 1
        assert stream.reconnect_attempts == 0
        first = connector.last
        first.drop()
        await settle(20)
        # 끊기면 이전 연결을 닫고 1초부터 다시 센다.
        assert first.closed and sleep.delays[-1] == 1.0 and stream.opened == 2 and connector.last is not first
        assert connector.last.sent == ['hello']
        await stream.stop()

    asyncio.run(main())


def test_target_failure_is_retried() -> None:
    async def main() -> None:
        connector, sleep = FakeConnector(), RecordingSleep()
        stream = EchoStream(connector, sleep, [RuntimeError('토큰 발급 실패'), 'wss://x'])
        stream.start()
        await settle(10)
        assert sleep.delays == [1.0] and stream.opened == 1
        await stream.stop()

    asyncio.run(main())


def test_stop_during_backoff_does_not_reconnect() -> None:
    async def main() -> None:
        connector = FakeConnector(failures=1)
        stream = EchoStream(connector, asyncio.sleep, ['wss://x'])
        stream.reconnect_base_ms = 60_000
        stream.start()
        await settle()
        await stream.stop()
        await settle()
        assert connector.calls == 1 and not stream.running

    asyncio.run(main())


def test_stop_while_preparing_the_connection_opens_nothing() -> None:
    async def main() -> None:
        connector, ready = FakeConnector(), asyncio.Event()

        class SlowTarget(EchoStream):
            async def connect_target(self) -> Tuple[str, Dict[str, str]]:
                await ready.wait()
                return await super().connect_target()

        stream = SlowTarget(connector, RecordingSleep(), ['wss://x'])
        stream.start()
        await settle()
        await stream.stop()
        ready.set()
        await settle(10)
        assert connector.calls == 0 and stream.ws is None and not stream.running

    asyncio.run(main())


def test_start_in_a_new_event_loop_reconnects() -> None:
    connector = FakeConnector()
    stream = EchoStream(connector, RecordingSleep(), ['wss://x'])

    async def first() -> None:
        stream.start()
        await settle()
        assert stream.is_connected()

    async def second() -> None:
        # 앞선 `asyncio.run` 이 끝나며 연결 작업이 취소됐다. 다시 부르면 새로 잇는다.
        assert not stream.running
        stream.start()
        await settle()
        assert connector.calls == 2 and stream.is_connected() and connector.last.sent == ['hello']
        await stream.stop()

    asyncio.run(first())
    assert connector.sockets[0].closed
    asyncio.run(second())


def test_ping_is_sent_on_interval() -> None:
    async def main() -> List[str]:
        connector = FakeConnector()
        stream = EchoStream(connector, RecordingSleep(), ['wss://x'])
        stream.ping_interval_ms = 5
        stream.start()
        await asyncio.sleep(0.05)
        sent = list(connector.last.sent)
        await stream.stop()
        return sent

    sent = asyncio.run(main())
    assert sent[0] == 'hello' and sent.count('PING') >= 2
