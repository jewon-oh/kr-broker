"""토스 실시간 판(`kr_broker.pro.toss`). TypeScript 판 `ts/src/toss/__tests__/` 의 `toss-realtime-parser.test.ts`, `toss-price-ws.test.ts`,
`toss-watch.test.ts` 를 옮겼다. 실제 소켓은 없다. 연결은 `ws_support` 의 가짜 연결을 쓰고, 실제 시간을 기다리는 핑과 재선언 대기는
인스턴스의 간격을 줄여 짧게 끝낸다.
"""

import asyncio
import calendar
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

import pytest

from kr_broker.base.errors import ExchangeError
from kr_broker.pro.toss import toss
from kr_broker.pro.toss_price_ws import WSS_URL, TossPriceWs
from kr_broker.toss_realtime_parser import parse_toss_ws_frame
from ws_support import FakeConnector, FakeWs, RecordingSleep, settle


def utc_ms(y: int, mo: int, d: int, h: int = 0, mi: int = 0, s: int = 0, ms: int = 0) -> int:
    return calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0)) * 1000 + ms


# ============ 프레임 파서 ============

def test_parse_trade_us() -> None:
    raw = json.dumps({
        'type': 'message', 'topic': 'trade:us:AAPL',
        'data': {'price': '185.5', 'volume': '10', 'timestamp': '2026-03-25T09:30:00.123+09:00', 'currency': 'USD'},
    })
    assert parse_toss_ws_frame(raw) == {
        'kind': 'trade', 'data': {'market': 'us', 'symbol': 'AAPL', 'price': 185.5, 'volume': 10, 'timestamp': utc_ms(2026, 3, 25, 0, 30, 0, 123)},
    }


def test_parse_trade_kr_without_timestamp() -> None:
    raw = json.dumps({'type': 'message', 'topic': 'trade:kr:005930', 'data': {'price': '72000', 'volume': '120', 'currency': 'KRW'}})
    assert parse_toss_ws_frame(raw) == {'kind': 'trade', 'data': {'market': 'kr', 'symbol': '005930', 'price': 72000, 'volume': 120, 'timestamp': None}}


def test_parse_trade_with_unreadable_number_is_unknown() -> None:
    raw = json.dumps({'type': 'message', 'topic': 'trade:us:AAPL', 'data': {'price': 'n/a', 'volume': '10'}})
    assert parse_toss_ws_frame(raw) == {'kind': 'unknown'}


def test_parse_orderbook_levels_as_price_volume_pairs() -> None:
    raw = json.dumps({
        'type': 'message', 'topic': 'orderbook:kr:005930',
        'data': {'currency': 'KRW', 'asks': [{'price': '71500', 'volume': '5'}], 'bids': [{'price': '71400', 'volume': '10'}]},
    })
    assert parse_toss_ws_frame(raw) == {
        'kind': 'orderbook', 'data': {'market': 'kr', 'symbol': '005930', 'asks': [[71500, 5]], 'bids': [[71400, 10]], 'timestamp': None},
    }


def test_parse_empty_orderbook() -> None:
    raw = json.dumps({'type': 'message', 'topic': 'orderbook:us:TSLA', 'data': {'currency': 'USD', 'asks': [], 'bids': []}})
    assert parse_toss_ws_frame(raw) == {'kind': 'orderbook', 'data': {'market': 'us', 'symbol': 'TSLA', 'asks': [], 'bids': [], 'timestamp': None}}


def test_parse_personal_order_event() -> None:
    order = {
        'orderId': 'bAGzNvMOOTa5Uy0xVzYNbxDJ3Qpobwau4jDF3hyZZGWbpHm7wha8CFZc7aXVOWAl',
        'symbol': 'AAPL', 'side': 'BUY', 'orderType': 'LIMIT', 'timeInForce': 'DAY', 'status': 'FILLED',
        'price': '100.5', 'quantity': '10', 'orderAmount': None, 'currency': 'USD',
        'orderedAt': '2026-06-23T09:30:00.000+09:00', 'canceledAt': None,
        'execution': {
            'filledQuantity': '10', 'averageFilledPrice': '100', 'filledAmount': '1000', 'commission': '1.23', 'tax': '0', 'settlementDate': '2026-06-25',
        },
    }
    raw = json.dumps({'type': 'message', 'topic': 'personal:order:3', 'data': {'event': 'FILL', 'accountSeq': '3', 'order': order}})
    assert parse_toss_ws_frame(raw) == {'kind': 'order', 'data': {'accountSeq': '3', 'event': 'FILL', 'order': order}}


def test_parse_personal_order_without_event_or_order_is_unknown() -> None:
    raw = json.dumps({'type': 'message', 'topic': 'personal:order:3', 'data': {'accountSeq': '3'}})
    assert parse_toss_ws_frame(raw) == {'kind': 'unknown'}


def test_parse_subscriptions_ack_keeps_rejections() -> None:
    rejected = [{'target': 'trade:kr:999999', 'code': 'stock-not-found', 'message': '해당 종목을 찾을 수 없습니다.'}]
    raw = json.dumps({'type': 'subscriptions', 'id': 'req-1', 'subscribed': ['trade:kr:005930'], 'rejected': rejected})
    assert parse_toss_ws_frame(raw) == {'kind': 'subscriptions', 'rejected': rejected}


def test_parse_error_frame() -> None:
    raw = json.dumps({'type': 'error', 'error': {'code': 'rate-limit-exceeded', 'message': 'declare rate limit exceeded'}})
    assert parse_toss_ws_frame(raw) == {'kind': 'error', 'code': 'rate-limit-exceeded', 'message': 'declare rate limit exceeded'}


def test_parse_pong() -> None:
    assert parse_toss_ws_frame('{"type":"pong"}') == {'kind': 'pong'}


@pytest.mark.parametrize('raw', ['not json', '{"type":"something-else"}', '"a string"'])
def test_parse_non_json_or_unknown_type_is_unknown(raw: str) -> None:
    assert parse_toss_ws_frame(raw) == {'kind': 'unknown'}


# ============ TossPriceWs ============

class TokenSource:
    """`get_access_token`. 부른 횟수를 센다."""

    def __init__(self, token: str = 'tok-1') -> None:
        self.token = token
        self.calls = 0

    async def __call__(self) -> str:
        self.calls += 1
        return self.token


def last_frame(ws: FakeWs) -> Any:
    return json.loads(ws.sent[-1])


def new_stream(connector: FakeConnector, sleep: Any = None, tokens: Optional[TokenSource] = None, **handlers: Any) -> TossPriceWs:
    return TossPriceWs(tokens or TokenSource(), connector, sleep=sleep or RecordingSleep(), **handlers)


def test_constants_match_typescript() -> None:
    assert WSS_URL == 'wss://openapi-ws.tossinvest.com/ws/v1'
    assert (TossPriceWs.reconnect_base_ms, TossPriceWs.reconnect_max_ms) == (1_000, 30_000)
    assert (TossPriceWs.ping_interval_ms, TossPriceWs.ping_text, TossPriceWs.rate_limit_retry_ms) == (60_000, 'PING', 1_000)


def test_connects_with_bearer_header_and_declares_grouped_subscriptions_on_open() -> None:
    async def main() -> None:
        connector = FakeConnector()
        stream = new_stream(connector)
        stream.start([
            {'channel': 'trade', 'market': 'us', 'symbol': 'AAPL'},
            {'channel': 'trade', 'market': 'us', 'symbol': 'TSLA'},
            {'channel': 'orderbook', 'market': 'kr', 'symbol': '005930'},
        ])
        await settle()
        ws = connector.last
        assert ws.url == WSS_URL and ws.headers == {'Authorization': 'Bearer tok-1'}
        assert last_frame(ws) == [{'type': 'trade:us', 'codes': ['AAPL', 'TSLA']}, {'type': 'orderbook:kr', 'codes': ['005930']}]
        await stream.stop()

    asyncio.run(main())


def test_update_subs_redeclares_everything() -> None:
    async def main() -> None:
        connector = FakeConnector()
        stream = new_stream(connector)
        stream.start([{'channel': 'trade', 'market': 'kr', 'symbol': '005930'}])
        await settle()
        stream.update_subs([{'channel': 'trade', 'market': 'kr', 'symbol': '000660'}])
        await settle()
        assert last_frame(connector.last) == [{'type': 'trade:kr', 'codes': ['000660']}]
        await stream.stop()

    asyncio.run(main())


def test_message_frames_go_to_trade_and_orderbook_callbacks() -> None:
    trades: List[Tuple[Any, ...]] = []
    books: List[Tuple[Any, ...]] = []

    async def main() -> None:
        connector = FakeConnector()
        stream = new_stream(connector, on_trade=lambda *a: trades.append(a), on_orderbook=lambda *a: books.append(a))
        stream.start([])
        await settle()
        ws = connector.last
        ws.feed(json.dumps({'type': 'message', 'topic': 'trade:us:AAPL', 'data': {'price': '185.5', 'volume': '10', 'timestamp': '2026-09-24T12:23:00.000Z'}}))
        ws.feed(json.dumps({'type': 'message', 'topic': 'orderbook:kr:005930', 'data': {'asks': [{'price': '71500', 'volume': '5'}], 'bids': []}}))
        await settle()
        await stream.stop()

    asyncio.run(main())
    assert trades == [('us', 'AAPL', 185.5, 10, utc_ms(2026, 9, 24, 12, 23))]
    assert books == [('kr', '005930', [], [[71500, 5]], None)]


def test_order_subscription_is_declared_by_account_seq_in_the_same_array() -> None:
    async def main() -> None:
        connector = FakeConnector()
        stream = new_stream(connector)
        stream.start([{'channel': 'trade', 'market': 'kr', 'symbol': '005930'}, {'channel': 'order', 'accountSeq': '3'}])
        await settle()
        assert last_frame(connector.last) == [{'type': 'trade:kr', 'codes': ['005930']}, {'type': 'personal:order', 'codes': ['3']}]
        await stream.stop()

    asyncio.run(main())


def test_order_event_frame_goes_to_order_callback() -> None:
    events: List[Tuple[Any, ...]] = []
    order = {'orderId': 'O1', 'symbol': 'AAPL', 'status': 'FILLED'}

    async def main() -> None:
        connector = FakeConnector()
        stream = new_stream(connector, on_order=lambda *a: events.append(a))
        stream.start([{'channel': 'order', 'accountSeq': '3'}])
        await settle()
        connector.last.feed(json.dumps({'type': 'message', 'topic': 'personal:order:3', 'data': {'event': 'FILL', 'accountSeq': '3', 'order': order}}))
        await settle()
        await stream.stop()

    asyncio.run(main())
    assert events == [('3', 'FILL', order)]


def test_sends_plain_text_ping_on_interval() -> None:
    async def main() -> List[str]:
        connector = FakeConnector()
        stream = new_stream(connector)
        stream.ping_interval_ms = 20
        stream.start([])
        await settle()
        ws = connector.last
        ws.sent.clear()
        await asyncio.sleep(0.07)
        sent = list(ws.sent)
        await stream.stop()
        return sent

    sent = asyncio.run(main())
    assert sent and set(sent) == {'PING'}


def test_reconnects_after_close_and_redeclares() -> None:
    async def main() -> None:
        tokens, connector, sleep = TokenSource(), FakeConnector(), RecordingSleep()
        stream = new_stream(connector, sleep, tokens)
        stream.start([{'channel': 'trade', 'market': 'kr', 'symbol': '005930'}])
        await settle()
        assert tokens.calls == 1
        connector.last.drop()
        await settle(20)
        assert sleep.delays == [1.0] and tokens.calls == 2 and len(connector.sockets) == 2
        assert last_frame(connector.sockets[1]) == [{'type': 'trade:kr', 'codes': ['005930']}]
        await stream.stop()

    asyncio.run(main())


def test_reconnect_backoff_starts_at_one_second_and_stops_at_thirty() -> None:
    async def main() -> None:
        connector, sleep = FakeConnector(failures=7), RecordingSleep()
        stream = new_stream(connector, sleep)
        stream.start([])
        await settle(40)
        assert sleep.delays == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0] and connector.calls == 8 and stream.is_connected()
        await stream.stop()

    asyncio.run(main())


def test_closes_previous_connection_before_reconnecting() -> None:
    async def main() -> None:
        connector = FakeConnector()
        stream = new_stream(connector)
        stream.start([])
        await settle()
        first = connector.last
        closes: List[int] = []
        close = first.close

        async def counting_close() -> None:
            closes.append(1)
            await close()

        first.close = counting_close  # type: ignore[method-assign]
        first.drop()
        await settle(20)
        assert closes == [1] and connector.last is not first
        await stream.stop()

    asyncio.run(main())


def test_rate_limit_error_redeclares_after_retry_delay() -> None:
    async def main() -> None:
        connector = FakeConnector()
        stream = new_stream(connector)
        stream.rate_limit_retry_ms = 20
        stream.start([{'channel': 'trade', 'market': 'kr', 'symbol': '005930'}])
        await settle()
        ws = connector.last
        ws.sent.clear()
        ws.feed(json.dumps({'type': 'error', 'error': {'code': 'rate-limit-exceeded', 'message': 'declare rate limit exceeded'}}))
        await settle()
        assert ws.sent == []  # 아직은 기다린다
        await asyncio.sleep(0.06)
        assert last_frame(ws) == [{'type': 'trade:kr', 'codes': ['005930']}]
        await stream.stop()

    asyncio.run(main())


def test_stop_prevents_reconnect_and_closes_socket() -> None:
    async def main() -> None:
        tokens, connector, sleep = TokenSource(), FakeConnector(), RecordingSleep()
        stream = new_stream(connector, sleep, tokens)
        stream.start([])
        await settle()
        ws = connector.last
        await stream.stop()
        ws.drop()
        await settle(20)
        assert tokens.calls == 1 and connector.calls == 1 and sleep.delays == [] and ws.closed

    asyncio.run(main())


def test_warns_when_subscriptions_exceed_the_per_connection_limit(caplog: pytest.LogCaptureFixture) -> None:
    async def main() -> None:
        stream = new_stream(FakeConnector())
        with caplog.at_level(logging.WARNING, logger='kr_broker'):
            stream.start([{'channel': 'trade', 'market': 'kr', 'symbol': f'{i:06d}'} for i in range(101)])
        await stream.stop()

    asyncio.run(main())
    assert '[TossPriceWs] 구독 수가 연결당 한계 초과' in caplog.text


# ============ toss 의 watch_* 와 close ============

AT = utc_ms(2026, 9, 24, 12, 23)
CREDS = {'apiKey': 'toss-client-id-123456', 'secret': 'toss-secret', 'uid': 'ACC-001'}


class FakeStream:
    """`create_price_stream` 이 돌려주는 스트림 대신. 받은 콜백을 쥐고, 부른 메서드를 기록한다."""

    def __init__(self, handlers: Dict[str, Any]) -> None:
        self.handlers = handlers
        self.started: List[List[Dict[str, str]]] = []
        self.updates: List[List[Dict[str, str]]] = []
        self.stopped = False

    def start(self, subs: List[Dict[str, str]]) -> None:
        self.started.append(list(subs))

    def update_subs(self, subs: List[Dict[str, str]]) -> None:
        self.updates.append(list(subs))

    async def stop(self) -> None:
        self.stopped = True


def with_fake_stream(config: Optional[Dict[str, Any]] = None) -> Tuple[toss, List[FakeStream]]:
    ex = toss(dict(CREDS) if config is None else config)
    streams: List[FakeStream] = []

    def create(**handlers: Any) -> FakeStream:
        streams.append(FakeStream(handlers))
        return streams[-1]

    ex.create_price_stream = create  # type: ignore[method-assign,assignment]
    return ex, streams


def test_describe_marks_watch_methods() -> None:
    has = toss(dict(CREDS)).has
    assert all(has[k] is True for k in ('ws', 'watchTicker', 'watchTrades', 'watchOrderBook', 'watchOrders'))
    assert has['fetchTicker'] is True  # 비동기 판의 값은 그대로다


def test_watch_ticker_connects_on_first_call_and_fills_last_from_trade() -> None:
    async def main() -> None:
        ex, streams = with_fake_stream()
        pending = asyncio.ensure_future(ex.watch_ticker('005930/KRW'))
        await settle()
        streams[0].handlers['on_trade']('kr', '005930', 71000, 15, AT)
        ticker = await pending
        assert streams[0].started == [[{'channel': 'trade', 'market': 'kr', 'symbol': '005930'}]]
        assert (ticker['symbol'], ticker['last'], ticker['timestamp'], ticker['datetime']) == ('005930/KRW', 71000, AT, '2026-09-24T12:23:00.000Z')
        await ex.close()

    asyncio.run(main())


def test_later_subscriptions_redeclare_all_and_trades_are_batched() -> None:
    async def main() -> None:
        ex, streams = with_fake_stream()
        first = asyncio.ensure_future(ex.watch_trades('AAPL/USD'))
        await settle()
        on_trade = streams[0].handlers['on_trade']
        on_trade('us', 'AAPL', 228.5, 10, AT)
        await first

        book = asyncio.ensure_future(ex.watch_order_book('AAPL/USD'))
        await settle()
        on_trade('us', 'AAPL', 228.6, 5, AT + 1000)
        on_trade('us', 'AAPL', 228.7, 7, AT + 2000)
        trades = await ex.watch_trades('AAPL/USD')

        assert len(streams) == 1
        assert streams[0].updates[-1] == [
            {'channel': 'trade', 'market': 'us', 'symbol': 'AAPL'}, {'channel': 'orderbook', 'market': 'us', 'symbol': 'AAPL'},
        ]
        assert [(t['symbol'], t['price'], t['amount']) for t in trades] == [('AAPL/USD', 228.6, 5), ('AAPL/USD', 228.7, 7)]
        await ex.close()
        with pytest.raises(ExchangeError):
            await book

    asyncio.run(main())


def test_watch_order_book_cuts_to_limit() -> None:
    async def main() -> None:
        ex, streams = with_fake_stream()
        pending = asyncio.ensure_future(ex.watch_order_book('005930/KRW', 1))
        await settle()
        streams[0].handlers['on_orderbook']('kr', '005930', [[71000, 10], [70900, 20]], [[71100, 5], [71200, 6]], AT)
        book = await pending
        assert (book['symbol'], book['bids'], book['asks'], book['timestamp']) == ('005930/KRW', [[71000, 10]], [[71100, 5]], AT)
        await ex.close()

    asyncio.run(main())


def test_watch_orders_subscribes_by_account_seq_and_parses_orders() -> None:
    async def main() -> None:
        ex, streams = with_fake_stream()
        pending = asyncio.ensure_future(ex.watch_orders())
        await settle()
        streams[0].handlers['on_order']('ACC-001', 'FILL', {
            'orderId': 'O1', 'symbol': '005930', 'side': 'BUY', 'orderType': 'LIMIT', 'price': '71000', 'quantity': '10', 'status': 'FILLED',
            'orderedAt': '2026-09-24T01:00:00Z', 'execution': {'filledQuantity': '10', 'averageFilledPrice': '71000'},
        })
        [order] = await pending
        assert streams[0].started == [[{'channel': 'order', 'accountSeq': 'ACC-001'}]]
        assert (order['id'], order['side'], order['amount'], order['filled'], order['symbol']) == ('O1', 'buy', 10, 10, '005930/KRW')
        await ex.close()

    asyncio.run(main())


def test_watch_orders_loads_account_seq_when_uid_is_missing() -> None:
    async def main() -> None:
        ex, streams = with_fake_stream({'apiKey': CREDS['apiKey'], 'secret': CREDS['secret']})

        async def load_account_seq() -> None:
            ex.uid = '7'

        ex.load_account_seq = load_account_seq  # type: ignore[method-assign]
        pending = asyncio.ensure_future(ex.watch_orders())
        await settle()
        assert streams[0].started == [[{'channel': 'order', 'accountSeq': '7'}]]
        await ex.close()
        with pytest.raises(ExchangeError):
            await pending

    asyncio.run(main())


def test_close_stops_stream_and_rejects_pending_watch() -> None:
    async def main() -> None:
        ex, streams = with_fake_stream()
        pending = asyncio.ensure_future(ex.watch_ticker('005930/KRW'))
        await settle()
        await ex.close()
        with pytest.raises(ExchangeError, match='실시간 연결을 닫았다'):
            await pending
        assert streams[0].stopped

    asyncio.run(main())


def test_close_also_closes_the_http_session() -> None:
    async def main() -> None:
        ex = toss(dict(CREDS))
        ex.open()
        session = ex.session
        await ex.close()
        assert ex.session is None and session.closed

    asyncio.run(main())


class FakeSession:
    """`ws_connect` 만 있는 HTTP 세션. `session_connector` 가 이 세션으로 연결한다."""

    def __init__(self) -> None:
        self.connector = FakeConnector()

    async def ws_connect(self, url: str, headers: Dict[str, str]) -> FakeWs:
        return await self.connector(url, headers)


def test_price_stream_uses_instance_token_and_session() -> None:
    async def main() -> None:
        session = FakeSession()
        ex = toss({**CREDS, 'session': session})

        async def issue() -> Dict[str, Any]:
            return {'accessToken': 'access-token-1', 'expiresInSeconds': 86400, 'tokenType': 'Bearer'}

        ex._issue_access_token = issue  # type: ignore[method-assign]
        pending = asyncio.ensure_future(ex.watch_ticker('AAPL/USD'))
        await settle(10)
        ws = session.connector.last
        assert ws.url == WSS_URL and ws.headers == {'Authorization': 'Bearer access-token-1'}
        assert last_frame(ws) == [{'type': 'trade:us', 'codes': ['AAPL']}]
        ws.feed(json.dumps({'type': 'message', 'topic': 'trade:us:AAPL', 'data': {'price': '228.5', 'volume': '3', 'timestamp': '2026-09-24T12:23:00.000Z'}}))
        ticker = await pending
        assert (ticker['symbol'], ticker['last'], ticker['timestamp']) == ('AAPL/USD', 228.5, AT)
        await ex.close()
        assert ws.closed

    asyncio.run(main())
