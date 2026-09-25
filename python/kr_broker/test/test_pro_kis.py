"""한국투자증권 실시간 판(`kr_broker.pro.kis`). TypeScript 판 `ts/src/kis/__tests__/` 의 `kis-realtime-parser.test.ts`,
`kis-realtime-stream.test.ts`, `kis-price-ws-error-detail.test.ts`, `kis-watch.test.ts` 를 옮겼다.

실제 웹소켓은 열지 않는다. 스트림은 `ws_support` 의 가짜 연결로 돌리고, `watch_*` 는 `create_realtime_stream` 을 가짜 스트림으로 바꿔
받은 콜백에 레코드를 직접 넣는다. `kis-ws-supported.test.ts`(Node 의 전역 WebSocket 판정)는 Python 판에 해당하는 것이 없어 옮기지 않았다.
"""

import asyncio
import base64
import calendar
import json
import logging
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

import kr_broker.async_support
from kr_broker.base.errors import ArgumentsRequired, ExchangeClosedByUser, ExchangeError
from kr_broker.kis_realtime_columns import KIS_REALTIME_COLUMNS, KIS_REALTIME_TR_ALIASES, kis_realtime_columns
from kr_broker.kis_realtime_parser import KisOrderbookRecord, KisTradeRecord, is_ping_pong, parse_kis_realtime_frame, to_stream_symbol
from kr_broker.pro import kis as pro_kis_module
from kr_broker.pro.kis import kis
from kr_broker.pro.kis_price_ws import KisPriceWs
from kr_broker.pro.kis_realtime_stream import KisRealtimeRecord, KisRealtimeStream, decrypt_kis_payload, split_kis_realtime_records
from ws_support import FakeConnector, FakeWs, RecordingSleep, settle

TS_COLUMNS = Path(__file__).resolve().parents[3] / 'ts' / 'src' / 'kis' / 'kis-realtime-columns.ts'

CREDENTIALS = {'apiKey': 'TEST-APPKEY-123456789', 'secret': 'test-app-secret', 'uid': '12345678-01'}
MASTER = {
    'kospi': [{'code': '005930', 'name': '삼성전자', 'market': 'KOSPI'}],
    'kosdaq': [],
    'nasdaq': [{'code': 'AAPL', 'name': 'APPLE INC', 'nameKr': '애플', 'market': 'NAS', 'currency': 'USD'}],
    'nyse': [],
    'amex': [],
}

KEY = '0123456789abcdef0123456789abcdef'
IV = 'fedcba9876543210'


def utc(text: str) -> int:
    """`YYYY-MM-DDTHH:MM:SS` UTC → 밀리초."""
    date, clock = text.split('T')
    y, m, d = (int(x) for x in date.split('-'))
    hh, mm, ss = (int(x) for x in clock.split(':'))
    return calendar.timegm((y, m, d, hh, mm, ss, 0, 0, 0)) * 1000


def encrypt(plain: str) -> str:
    padder = padding.PKCS7(128).padder()
    data = padder.update(plain.encode('utf-8')) + padder.finalize()
    encryptor = Cipher(algorithms.AES(KEY.encode('utf-8')), modes.CBC(IV.encode('utf-8'))).encryptor()
    return base64.b64encode(encryptor.update(data) + encryptor.finalize()).decode('ascii')


def new_kis(sandbox: bool = True, options: Optional[Dict[str, Any]] = None) -> kis:
    return kis({**CREDENTIALS, 'sandbox': sandbox, 'options': {'masterData': MASTER, **(options or {})}})


class ApprovalKey:
    """접속키 발급을 흉내 내고 부른 횟수를 센다."""

    def __init__(self, key: str = 'ak') -> None:
        self.key = key
        self.calls = 0

    async def __call__(self) -> str:
        self.calls += 1
        return self.key


def frames(ws: FakeWs) -> List[Dict[str, Any]]:
    return [json.loads(text) for text in ws.sent if text.startswith('{"header":{"approval_key"')]


# ============ 필드 표 ============

def _ts_columns() -> Tuple[Dict[str, Tuple[str, ...]], Dict[str, str]]:
    text = TS_COLUMNS.read_text(encoding='utf-8')
    table = re.search(r'KIS_REALTIME_COLUMNS[^=]*= \{(.*?)\n\};', text, re.S)
    aliases = re.search(r'KIS_REALTIME_TR_ALIASES[^=]*= \{(.*?)\};', text, re.S)
    assert table is not None and aliases is not None
    body = re.sub(r'/\*\*.*?\*/', '', table.group(1), flags=re.S)
    columns = {m.group(1): tuple(re.findall(r"'([^']*)'", m.group(2))) for m in re.finditer(r'(\w+): \[(.*?)\]', body, re.S)}
    return columns, dict(re.findall(r"(\w+): '(\w+)'", aliases.group(1)))


def test_columns_match_the_typescript_table() -> None:
    columns, aliases = _ts_columns()
    assert len(columns) == 60
    assert KIS_REALTIME_COLUMNS == columns
    assert KIS_REALTIME_TR_ALIASES == aliases


def test_sandbox_order_notice_uses_the_real_tr_columns() -> None:
    assert kis_realtime_columns('H0STCNI9') is KIS_REALTIME_COLUMNS['H0STCNI0']
    assert kis_realtime_columns('H0GSCNI9') is KIS_REALTIME_COLUMNS['H0GSCNI0']
    assert kis_realtime_columns('H0XXXXX0') is None


# ============ 프레임 파서 ============

def test_to_stream_symbol_uses_krw_for_domestic_and_usd_for_overseas() -> None:
    # 해외 호가 통화는 `USDT` 가 아니라 `USD` 다. 다른 거래소의 토큰화 주식 심볼과 겹치지 않게 한다.
    assert to_stream_symbol('005930') == '005930/KRW'
    assert to_stream_symbol('aapl') == 'AAPL/USD'


def test_is_ping_pong_only_for_pingpong_header() -> None:
    assert is_ping_pong('{"header":{"tr_id":"PINGPONG"}}') is True
    assert is_ping_pong('{"header":{"tr_id":"H0STCNT0"}}') is False
    assert is_ping_pong('0|H0STCNT0|001|005930^x') is False


def test_parse_domestic_trade_reads_price_and_change_rate() -> None:
    assert parse_kis_realtime_frame('0|H0STCNT0|001|005930^093000^79000^5^100^2.5') == [KisTradeRecord('005930', 79000, 2.5)]


def test_parse_overseas_trade_reads_symbol_price_and_rate() -> None:
    f = ['x'] * 15
    f[0], f[1], f[11], f[14] = 'DNASAAPL', 'AAPL', '185.5', '1.2'
    assert parse_kis_realtime_frame(f"0|HDFSCNT0|001|{'^'.join(f)}") == [KisTradeRecord('AAPL', 185.5, 1.2)]


def test_parse_skips_trade_without_price() -> None:
    assert parse_kis_realtime_frame('0|H0STCNT0|001|005930^093000^^5^100^2.5') == []


def test_parse_domestic_orderbook_best_first_with_sizes() -> None:
    f = ['0'] * 43
    f[0], f[1], f[2] = '005930', '093000', '0'
    f[3], f[4] = '79100', '79200'  # ASKP1, ASKP2
    f[13], f[14] = '79000', '78900'  # BIDP1, BIDP2
    f[23], f[24] = '10', '20'  # ASKP_RSQN1, 2
    f[33], f[34] = '30', '40'  # BIDP_RSQN1, 2
    records = parse_kis_realtime_frame(f"0|H0STASP0|001|{'^'.join(f)}")
    assert records == [KisOrderbookRecord('005930', [(79000, 30), (78900, 40)], [(79100, 10), (79200, 20)])]
    assert records[0].kind == 'orderbook'


def test_parse_ignores_control_empty_and_unknown_frames() -> None:
    assert parse_kis_realtime_frame('{"body":{"rt_cd":"0"}}') == []
    assert parse_kis_realtime_frame('') == []
    assert parse_kis_realtime_frame('0|UNKNOWN|001|a^b') == []


# ============ 건수 나누기와 복호 ============

def test_split_known_tr_by_column_count_and_names_fields() -> None:
    columns = KIS_REALTIME_COLUMNS['H0IFCNT0']
    one = [str(i) for i in range(len(columns))]
    records = split_kis_realtime_records('H0IFCNT0', 2, '^'.join(one + [f'b{v}' for v in one]))
    assert len(records) == 2
    assert records[0].fields is not None and records[0].fields[columns[0]] == '0'
    assert records[1].fields is not None and records[1].fields[columns[-1]] == f'b{len(columns) - 1}'
    assert len(records[1].values) == len(columns)


def test_split_unknown_tr_by_count_without_names() -> None:
    assert split_kis_realtime_records('H0XXXXX0', 2, 'a^b^c^d') == [
        KisRealtimeRecord('H0XXXXX0', ['a', 'b'], None), KisRealtimeRecord('H0XXXXX0', ['c', 'd'], None),
    ]


def test_split_short_payload_names_only_present_values() -> None:
    [record] = split_kis_realtime_records('H0STNAV0', 1, 'A005930^10500')
    assert record.values == ['A005930', '10500']
    assert record.fields is not None and len(record.fields) == 2


def test_split_uses_the_quotient_when_values_divide_evenly_by_count() -> None:
    # KIS 가 필드를 뒤에 더해도 두 번째 건이 어긋나지 않는다(TS 판과 같다).
    columns = KIS_REALTIME_COLUMNS['H0IFCNT0']
    one = [str(i) for i in range(len(columns))] + ['extra']
    records = split_kis_realtime_records('H0IFCNT0', 2, '^'.join(one + [f'b{v}' for v in one]))
    assert records[1].fields is not None and records[1].fields[columns[0]] == 'b0'
    assert len(records[1].values) == len(columns) + 1


def test_decrypt_kis_payload_is_aes_cbc_with_key_and_iv() -> None:
    assert decrypt_kis_payload(encrypt('HTSID^12345678^0000117057'), KEY, IV) == 'HTSID^12345678^0000117057'


# ============ KisRealtimeStream ============

class StreamRig:
    """가짜 연결에 붙인 `KisRealtimeStream`. `H0IFCNT0 101W12` 를 구독해 연 상태로 시작한다."""

    def __init__(self, failures: int = 0) -> None:
        self.connector = FakeConnector(failures)
        self.sleep = RecordingSleep()
        self.approval = ApprovalKey()
        self.records: List[KisRealtimeRecord] = []
        self.errors: List[Tuple[str, str, str]] = []
        self.stream = KisRealtimeStream(self.approval, True, self.connector, self.records.append,
                                        lambda *args: self.errors.append(args), self.sleep)

    async def open(self) -> FakeWs:
        self.stream.subscribe('H0IFCNT0', '101W12')
        await settle(10)
        return self.connector.last


def test_stream_reconnects_an_existing_subscription_in_a_new_event_loop() -> None:
    """앞선 `asyncio.run` 이 끝나며 연결 작업이 취소됐다. 같은 구독을 다시 부르면 새로 연결해 등록 프레임을 보낸다."""
    rig = StreamRig()

    async def first() -> None:
        await rig.open()

    async def second() -> FakeWs:
        rig.stream.subscribe('H0IFCNT0', '101W12')
        await settle(10)
        return rig.connector.last

    asyncio.run(first())
    ws = asyncio.run(second())
    assert rig.connector.calls == 2
    assert [f['body']['input']['tr_id'] for f in frames(ws)] == ['H0IFCNT0']
    asyncio.run(rig.stream.stop())


def test_stream_connects_to_sandbox_and_sends_register_and_unregister_frames() -> None:
    async def main() -> None:
        rig = StreamRig()
        ws = await rig.open()
        rig.stream.subscribe('H0IFCNT0', '101W12')
        rig.stream.subscribe('H0IFASP0', '101W12')
        rig.stream.unsubscribe('H0IFCNT0', '101W12')
        await settle()
        assert ws.url == 'ws://ops.koreainvestment.com:31000/tryitout'
        sent = frames(ws)
        assert [(f['header']['tr_type'], f['body']['input']['tr_id']) for f in sent] == [('1', 'H0IFCNT0'), ('1', 'H0IFASP0'), ('2', 'H0IFCNT0')]
        assert sent[0]['header'] == {'approval_key': 'ak', 'custtype': 'P', 'tr_type': '1', 'content-type': 'utf-8'}
        assert sent[0]['body']['input']['tr_key'] == '101W12'
        # 프레임은 TypeScript 판의 `JSON.stringify` 와 같은 모양이다(공백 없음).
        assert ws.sent[0] == ('{"header":{"approval_key":"ak","custtype":"P","tr_type":"1","content-type":"utf-8"},'
                              '"body":{"input":{"tr_id":"H0IFCNT0","tr_key":"101W12"}}}')
        await rig.stream.stop()

    asyncio.run(main())


def test_stream_names_plain_fields_and_echoes_pingpong() -> None:
    async def main() -> None:
        rig = StreamRig()
        ws = await rig.open()
        columns = KIS_REALTIME_COLUMNS['H0IFCNT0']
        values = ['101W12' if i == 0 else str(i) for i in range(len(columns))]
        ws.feed(f"0|H0IFCNT0|001|{'^'.join(values)}")
        ping = '{"header":{"tr_id":"PINGPONG","datetime":"20260923101500"}}'
        ws.feed(ping)
        await settle()
        assert len(rig.records) == 1
        assert rig.records[0].fields is not None and rig.records[0].fields[columns[0]] == '101W12'
        assert ws.sent[-1] == ping
        await rig.stream.stop()

    asyncio.run(main())


def test_stream_decrypts_order_notice_with_key_and_iv_from_subscribe_response() -> None:
    async def main() -> None:
        rig = StreamRig()
        ws = await rig.open()
        rig.stream.subscribe('H0STCNI9', 'HTSID')
        ws.feed(json.dumps({'header': {'tr_id': 'H0STCNI9', 'tr_key': 'HTSID', 'encrypt': 'N'},
                            'body': {'rt_cd': '0', 'msg1': 'SUBSCRIBE SUCCESS', 'output': {'key': KEY, 'iv': IV}}}))
        columns = KIS_REALTIME_COLUMNS['H0STCNI0']
        values = ['HTSID' if i == 0 else str(i) for i in range(len(columns))]
        ws.feed(f"1|H0STCNI9|001|{encrypt('^'.join(values))}")
        await settle()
        assert len(rig.records) == 1
        assert rig.records[0].tr_id == 'H0STCNI9'
        assert rig.records[0].fields is not None and rig.records[0].fields[columns[0]] == 'HTSID'
        await rig.stream.stop()

    asyncio.run(main())


def test_stream_drops_plaintext_order_notice(caplog: pytest.LogCaptureFixture) -> None:
    # KIS 실시간 연결은 평문이라, 경로 위에서 끼워 넣은 평문 체결통보를 받지 않는다(TS 판과 같다).
    async def main() -> None:
        rig = StreamRig()
        ws = await rig.open()
        rig.stream.subscribe('H0STCNI0', 'HTSID')
        columns = KIS_REALTIME_COLUMNS['H0STCNI0']
        values = ['HTSID' if i == 0 else str(i) for i in range(len(columns))]
        for tr_id in ('H0STCNI0', 'H0STCNI9', 'H0GSCNI0', 'H0GSCNI9'):
            ws.feed(f"0|{tr_id}|001|{'^'.join(values)}")
        await settle()
        assert rig.records == []
        await rig.stream.stop()

    caplog.set_level(logging.WARNING, logger='kr_broker')
    asyncio.run(main())


def test_stream_url_override() -> None:
    async def main() -> None:
        connector = FakeConnector(0)
        stream = KisRealtimeStream(ApprovalKey(), True, connector, lambda r: None, None, RecordingSleep(), url='wss://example.invalid:31000/tryitout')
        stream.subscribe('H0IFCNT0', '101W12')
        await settle(10)
        assert connector.last.url == 'wss://example.invalid:31000/tryitout'
        await stream.stop()

    asyncio.run(main())


def test_stream_drops_encrypted_frame_before_key_and_reports_subscribe_failure(caplog: pytest.LogCaptureFixture) -> None:
    async def main() -> None:
        rig = StreamRig()
        ws = await rig.open()
        ws.feed('1|H0GSCNI0|001|AAAA')
        ws.feed(json.dumps({'header': {'tr_id': 'H0IFCNT0', 'tr_key': '101W12'}, 'body': {'rt_cd': '9', 'msg1': 'MAX SUBSCRIBE OVER'}}))
        await settle()
        assert rig.records == []
        assert rig.errors == [('H0IFCNT0', '101W12', 'MAX SUBSCRIBE OVER')]
        await rig.stream.stop()

    caplog.set_level(logging.WARNING, logger='kr_broker')
    asyncio.run(main())
    assert '[KisRealtimeStream] 복호 key 를 받기 전에 암호화 프레임이 왔다 — 버린다 (trId=H0GSCNI0)' in caplog.messages


def test_stream_backs_off_from_2s_to_30s_and_resubscribes_after_reconnect() -> None:
    async def main() -> None:
        rig = StreamRig(failures=5)
        await rig.open()
        await settle(30)
        ws = rig.connector.last
        # 실패 다섯 번: 2, 4, 8, 16, 30(상한)초. 여섯 번째에 연결되고 매번 접속키를 다시 받는다.
        assert rig.sleep.delays == [2.0, 4.0, 8.0, 16.0, 30.0] and rig.approval.calls == 6
        ws.drop()
        await settle(20)
        assert rig.sleep.delays[-1] == 2.0 and rig.connector.last is not ws
        assert [f['body']['input']['tr_id'] for f in frames(rig.connector.last)] == ['H0IFCNT0']
        await rig.stream.stop()

    asyncio.run(main())


def test_stream_keeps_delivering_records_when_on_record_raises(caplog: pytest.LogCaptureFixture) -> None:
    async def main() -> None:
        seen: List[str] = []

        def on_record(record: KisRealtimeRecord) -> None:
            seen.append(record.values[0])
            if len(seen) == 1:
                raise RuntimeError('boom')

        connector = FakeConnector()
        stream = KisRealtimeStream(ApprovalKey(), True, connector, on_record, None, RecordingSleep())
        stream.subscribe('H0XXXXX0', 'K')
        await settle(10)
        connector.last.feed('0|H0XXXXX0|002|a^b^c^d')
        await settle()
        assert seen == ['a', 'c']
        await stream.stop()

    caplog.set_level(logging.WARNING, logger='kr_broker')
    asyncio.run(main())
    assert '[KisRealtimeStream] on_record 처리 실패 (trId=H0XXXXX0)' in caplog.messages


def test_stream_forgets_a_rejected_subscription_so_subscribing_again_resends_it() -> None:
    async def main() -> None:
        rig = StreamRig()
        ws = await rig.open()
        ws.feed(json.dumps({'header': {'tr_id': 'H0IFCNT0', 'tr_key': '101W12'}, 'body': {'rt_cd': '1', 'msg1': 'MAX SUBSCRIBE OVER'}}))
        await settle()
        rig.stream.subscribe('H0IFCNT0', '101W12')
        await settle()
        assert [(f['header']['tr_type'], f['body']['input']['tr_id']) for f in frames(ws)] == [('1', 'H0IFCNT0'), ('1', 'H0IFCNT0')]
        assert rig.errors == [('H0IFCNT0', '101W12', 'MAX SUBSCRIBE OVER')]
        await rig.stream.stop()

    asyncio.run(main())


def test_create_realtime_stream_follows_sandbox_mode() -> None:
    stream = new_kis(sandbox=False).create_realtime_stream(lambda record: None)
    assert isinstance(stream, KisRealtimeStream)
    assert stream.is_connected() is False and stream.is_virtual is False


# ============ KisPriceWs ============

def test_price_ws_connect_failure_logs_the_cause_and_reconnects_after_2s(caplog: pytest.LogCaptureFixture) -> None:
    # TypeScript 판은 핸드셰이크가 실패하면 `error` 만 오고 `close` 가 오지 않아, `error` 에서도 재연결을 걸고 소켓을 닫지 않는다.
    # aiohttp 는 핸드셰이크 실패를 연결 함수의 예외로 알리고 소켓을 만들지 않는다. 원인이 로그에 실리고 2초 뒤 다시 잇는지만 본다.
    async def main() -> ApprovalKey:
        connector, sleep, approval = FakeConnector(failures=1), RecordingSleep(), ApprovalKey('approval-key')
        ws = KisPriceWs(approval, True, connector, sleep=sleep)
        ws.start([])
        await settle(10)
        assert sleep.delays == [2.0] and connector.calls == 2 and ws.is_connected()
        await ws.stop()
        return approval

    caplog.set_level(logging.WARNING, logger='kr_broker')
    assert asyncio.run(main()).calls == 2
    [failure] = [r for r in caplog.records if r.getMessage() == '[KisPriceWs] 연결 실패 — 재연결 예약']
    assert failure.exc_info is not None and 'refused' in str(failure.exc_info[1])


def test_price_ws_server_close_logs_and_reconnects_with_subscriptions(caplog: pytest.LogCaptureFixture) -> None:
    async def main() -> ApprovalKey:
        connector, sleep, approval = FakeConnector(), RecordingSleep(), ApprovalKey('approval-key')
        ws = KisPriceWs(approval, True, connector, sleep=sleep)
        ws.start([('H0STCNT0', '005930')])
        await settle(10)
        first = connector.last
        first.drop()
        await settle(10)
        assert sleep.delays == [2.0] and first.closed and connector.last is not first
        assert [(f['body']['input']['tr_id'], f['header']['approval_key']) for f in frames(connector.last)] == [('H0STCNT0', 'approval-key')]
        await ws.stop()
        return approval

    caplog.set_level(logging.WARNING, logger='kr_broker')
    assert asyncio.run(main()).calls == 2
    assert '[KisPriceWs] 연결 종료(code=1006) — 재연결 예약' in caplog.messages


def test_price_ws_emits_trades_and_orderbooks_and_echoes_pingpong() -> None:
    async def main() -> None:
        connector = FakeConnector()
        trades: List[Tuple[str, float, float]] = []
        books: List[Tuple[str, Any, Any]] = []
        ws = KisPriceWs(ApprovalKey(), False, connector, lambda *args: trades.append(args), lambda *args: books.append(args), RecordingSleep())
        ws.start([('H0STCNT0', '005930'), ('HDFSCNT0', 'DNASAAPL')])
        await settle(10)
        sock = connector.last
        assert sock.url == 'ws://ops.koreainvestment.com:21000/tryitout'
        overseas = ['x'] * 15
        overseas[1], overseas[11], overseas[14] = 'aapl', '185.5', '1.2'
        book = ['0'] * 43
        book[0], book[3], book[13], book[23], book[33] = '005930', '79100', '79000', '10', '30'
        sock.feed('0|H0STCNT0|001|005930^093000^79000^5^100^2.5')
        sock.feed(f"0|HDFSCNT0|001|{'^'.join(overseas)}")
        sock.feed(f"0|H0STASP0|001|{'^'.join(book)}")
        sock.feed('{"header":{"tr_id":"H0STCNT0"},"body":{"rt_cd":"0"}}')
        sock.feed('{"header":{"tr_id":"PINGPONG"}}')
        await settle()
        assert trades == [('005930/KRW', 79000, 2.5), ('AAPL/USD', 185.5, 1.2)]
        assert books == [('005930/KRW', [(79000, 30)], [(79100, 10)])]
        assert sock.sent[-1] == '{"header":{"tr_id":"PINGPONG"}}'
        await ws.stop()

    asyncio.run(main())


def test_price_ws_update_subs_registers_only_new_subscriptions() -> None:
    async def main() -> None:
        connector = FakeConnector()
        ws = KisPriceWs(ApprovalKey(), True, connector, sleep=RecordingSleep())
        ws.start([('H0STCNT0', '005930')])
        await settle(10)
        ws.update_subs([('H0STCNT0', '005930'), ('H0STASP0', '005930')])
        await settle()
        assert [(f['body']['input']['tr_id'], f['body']['input']['tr_key']) for f in frames(connector.last)] == [
            ('H0STCNT0', '005930'), ('H0STASP0', '005930'),
        ]
        await ws.stop()

    asyncio.run(main())


def test_price_ws_update_subs_unsubscribes_removed_subscriptions() -> None:
    async def main() -> None:
        connector = FakeConnector()
        ws = KisPriceWs(ApprovalKey(), True, connector, sleep=RecordingSleep())
        ws.start([('H0STCNT0', '005930'), ('H0STCNT0', '000660')])
        await settle(10)
        ws.update_subs([('H0STCNT0', '000660'), ('H0STASP0', '000660')])
        await settle()
        assert [(f['header']['tr_type'], f['body']['input']['tr_id'], f['body']['input']['tr_key']) for f in frames(connector.last)] == [
            ('1', 'H0STCNT0', '005930'), ('1', 'H0STCNT0', '000660'), ('2', 'H0STCNT0', '005930'), ('1', 'H0STASP0', '000660'),
        ]
        await ws.stop()

    asyncio.run(main())


def test_price_ws_reports_subscribe_rejections_to_the_log_and_the_callback(caplog: pytest.LogCaptureFixture) -> None:
    async def main() -> List[Tuple[str, str, str]]:
        errors: List[Tuple[str, str, str]] = []
        connector = FakeConnector()
        ws = KisPriceWs(ApprovalKey(), True, connector, sleep=RecordingSleep(), on_subscribe_error=lambda *args: errors.append(args))
        silent = KisPriceWs(ApprovalKey(), True, connector, sleep=RecordingSleep())
        ws.start([('H0STCNT0', '005930')])
        await settle(10)
        silent.start([])
        await settle(10)
        ok = json.dumps({'header': {'tr_id': 'H0STCNT0', 'tr_key': '005930'}, 'body': {'rt_cd': '0', 'msg1': 'SUBSCRIBE SUCCESS'}})
        over = json.dumps({'header': {'tr_id': 'H0STCNT0', 'tr_key': '000660'}, 'body': {'rt_cd': '1', 'msg1': 'MAX SUBSCRIBE OVER'}})
        connector.sockets[0].feed(ok)
        connector.sockets[0].feed(over)
        connector.sockets[1].feed(over)
        await settle()
        await ws.stop()
        await silent.stop()
        return errors

    caplog.set_level(logging.WARNING, logger='kr_broker')
    assert asyncio.run(main()) == [('H0STCNT0', '000660', 'MAX SUBSCRIBE OVER')]
    assert caplog.messages.count('[KisPriceWs] 구독 거부 (trId=H0STCNT0, trKey=000660, message=MAX SUBSCRIBE OVER)') == 2


def test_price_ws_keeps_delivering_records_when_a_callback_raises() -> None:
    async def main() -> None:
        seen: List[float] = []

        def on_trade(symbol: str, last: float, change_pct: float) -> None:
            seen.append(last)
            if len(seen) == 1:
                raise RuntimeError('boom')

        connector = FakeConnector()
        ws = KisPriceWs(ApprovalKey(), True, connector, on_trade, sleep=RecordingSleep())
        ws.start([])
        await settle(10)
        connector.last.feed('0|H0STCNT0|002|005930^093000^79000^5^100^2.5^000660^093000^180000^5^100^1.5')
        await settle()
        assert seen == [79000, 180000]
        await ws.stop()

    asyncio.run(main())


def test_price_ws_warns_when_subscriptions_exceed_the_connection_limit(caplog: pytest.LogCaptureFixture) -> None:
    async def main() -> None:
        ws = KisPriceWs(ApprovalKey(), True, FakeConnector(), sleep=RecordingSleep())
        ws.start([('H0STCNT0', f'{i:06d}') for i in range(41)])
        await ws.stop()

    caplog.set_level(logging.WARNING, logger='kr_broker')
    asyncio.run(main())
    assert '[KisPriceWs] 구독 수가 연결당 한계 초과 — 초과분 누락 가능(폴링 폴백 의존) (count=41, limit=40)' in caplog.messages


def test_create_price_stream_follows_sandbox_mode() -> None:
    stream = new_kis(sandbox=True).create_price_stream()
    assert isinstance(stream, KisPriceWs) and stream.is_virtual is True and stream.is_connected() is False


def test_create_price_stream_passes_on_subscribe_error() -> None:
    def on_error(tr_id: str, tr_key: str, message: str) -> None:
        pass

    assert new_kis().create_price_stream(on_subscribe_error=on_error)._on_subscribe_error is on_error


# ============ watch_* ============

class FakeStream:
    """`create_realtime_stream` 대신 끼우는 스트림. 구독과 멈춤을 기록한다."""

    def __init__(self) -> None:
        self.subscribed: List[Tuple[str, str]] = []
        self.stopped = 0

    def subscribe(self, tr_id: str, tr_key: str) -> None:
        self.subscribed.append((tr_id, tr_key))

    async def stop(self) -> None:
        self.stopped += 1


class WatchRig:
    """가짜 스트림을 끼운 인스턴스. `emit` 으로 레코드를, `fail` 로 구독 거부를 흉내 낸다."""

    def __init__(self, options: Optional[Dict[str, Any]] = None) -> None:
        self.ex = new_kis(options=options)
        self.stream = FakeStream()
        self.on_record: Callable[[KisRealtimeRecord], None] = lambda record: None
        self.on_error: Callable[[str, str, str], None] = lambda *args: None

        def create(on_record: Callable[[KisRealtimeRecord], None], on_error: Callable[[str, str, str], None]) -> FakeStream:
            self.on_record, self.on_error = on_record, on_error
            return self.stream

        self.ex.create_realtime_stream = create  # type: ignore[method-assign,assignment]

    def emit(self, tr_id: str, fields: Dict[str, str]) -> None:
        self.on_record(KisRealtimeRecord(tr_id, list(fields.values()), fields))

    def fail(self, tr_id: str, tr_key: str, message: str) -> None:
        self.on_error(tr_id, tr_key, message)


DOMESTIC_TRADE = {
    'mksc_shrn_iscd': '005930', 'stck_cntg_hour': '093001', 'stck_prpr': '71000', 'prdy_vrss': '500', 'prdy_ctrt': '0.71',
    'wghn_avrg_stck_prc': '70800', 'stck_oprc': '70500', 'stck_hgpr': '71200', 'stck_lwpr': '70400', 'askp1': '71100', 'bidp1': '71000',
    'cntg_vol': '15', 'acml_vol': '1200000', 'acml_tr_pbmn': '85000000000', 'ccld_dvsn': '1', 'bsop_date': '20260922', 'askp_rsqn1': '300',
    'bidp_rsqn1': '500',
}


def test_describe_turns_on_ws_capabilities() -> None:
    has = new_kis().has
    assert all(has[name] is True for name in ('ws', 'watchTicker', 'watchTrades', 'watchOrderBook', 'watchOrders'))
    assert has['fetchTicker'] is True
    # 비동기 판은 그대로 꺼져 있다.
    assert kr_broker.async_support.kis(CREDENTIALS).has['ws'] is False


def test_watch_ticker_subscribes_domestic_trade_tr_and_fills_the_ticker() -> None:
    async def main() -> None:
        rig = WatchRig()
        pending = asyncio.ensure_future(rig.ex.watch_ticker('005930/KRW'))
        await settle()
        rig.emit('H0STCNT0', DOMESTIC_TRADE)
        ticker = await pending
        assert rig.stream.subscribed == [('H0STCNT0', '005930')]
        assert {k: ticker[k] for k in ('symbol', 'timestamp', 'last', 'open', 'high', 'low', 'bid', 'ask', 'bidVolume', 'askVolume', 'change',
                                       'percentage', 'vwap', 'baseVolume', 'quoteVolume')} == {
            'symbol': '005930/KRW', 'timestamp': utc('2026-09-22T00:30:01'), 'last': 71000, 'open': 70500, 'high': 71200, 'low': 70400,
            'bid': 71000, 'ask': 71100, 'bidVolume': 500, 'askVolume': 300, 'change': 500, 'percentage': 0.71, 'vwap': 70800,
            'baseVolume': 1200000, 'quoteVolume': 85000000000,
        }

    asyncio.run(main())


def test_watch_trades_buffers_between_calls_and_reads_side() -> None:
    async def main() -> None:
        rig = WatchRig()
        first = asyncio.ensure_future(rig.ex.watch_trades('005930/KRW'))
        await settle()
        rig.emit('H0STCNT0', DOMESTIC_TRADE)
        await first
        rig.emit('H0STCNT0', {**DOMESTIC_TRADE, 'stck_cntg_hour': '093002', 'cntg_vol': '3', 'ccld_dvsn': '5'})
        rig.emit('H0STCNT0', {**DOMESTIC_TRADE, 'stck_cntg_hour': '093003', 'cntg_vol': '4', 'ccld_dvsn': '1'})
        trades = await rig.ex.watch_trades('005930/KRW')
        assert [(t['amount'], t['side']) for t in trades] == [(3, 'sell'), (4, 'buy')]
        assert (trades[0]['symbol'], trades[0]['price'], trades[0]['timestamp']) == ('005930/KRW', 71000, utc('2026-09-22T00:30:02'))

    asyncio.run(main())


def test_watch_ticker_overseas_uses_delayed_trade_tr_and_korean_time() -> None:
    async def main() -> None:
        rig = WatchRig()
        pending = asyncio.ensure_future(rig.ex.watch_ticker('AAPL/USD'))
        await settle()
        rig.emit('HDFSCNT0', {
            'rsym': 'DNASAAPL', 'symb': 'AAPL', 'kymd': '20260924', 'khms': '223000', 'open': '227', 'high': '229', 'low': '226', 'last': '228.5',
            'diff': '1.5', 'rate': '0.66', 'pbid': '228.4', 'pask': '228.6', 'vbid': '100', 'vask': '200', 'evol': '10', 'tvol': '5000000',
            'tamt': '1140000000',
        })
        ticker = await pending
        assert rig.stream.subscribed == [('HDFSCNT0', 'DNASAAPL')]
        assert {k: ticker[k] for k in ('symbol', 'timestamp', 'last', 'change', 'percentage', 'bid', 'ask', 'baseVolume')} == {
            'symbol': 'AAPL/USD', 'timestamp': utc('2026-09-24T13:30:00'), 'last': 228.5, 'change': 1.5, 'percentage': 0.66, 'bid': 228.4,
            'ask': 228.6, 'baseVolume': 5000000,
        }

    asyncio.run(main())


def test_watch_order_book_sorts_ten_levels_and_applies_limit() -> None:
    async def main() -> None:
        rig = WatchRig()
        fields = {'mksc_shrn_iscd': '005930', 'bsop_hour': '093001'}
        for i in range(1, 11):
            fields[f'askp{i}'] = str(71000 + i * 100)
            fields[f'bidp{i}'] = str(71000 - (i - 1) * 100)
            fields[f'askp_rsqn{i}'] = str(i)
            fields[f'bidp_rsqn{i}'] = str(i * 2)
        pending = asyncio.ensure_future(rig.ex.watch_order_book('005930/KRW', 2))
        await settle()
        rig.emit('H0STASP0', fields)
        book = await pending
        assert rig.stream.subscribed == [('H0STASP0', '005930')]
        assert book['bids'] == [[71000, 2], [70900, 4]]
        assert book['asks'] == [[71100, 1], [71200, 2]]
        assert book['symbol'] == '005930/KRW'

    asyncio.run(main())


def test_watch_orders_requires_hts_id_before_subscribing() -> None:
    async def main() -> None:
        rig = WatchRig()
        with pytest.raises(ArgumentsRequired):
            await rig.ex.watch_orders()
        assert rig.stream.subscribed == []

    asyncio.run(main())


def test_watch_orders_subscribes_sandbox_notices_and_accumulates_fills() -> None:
    async def main() -> None:
        rig = WatchRig({'htsId': 'MYHTS'})
        notice = {'oder_no': '0000117057', 'seln_byov_cls': '02', 'stck_shrn_iscd': '005930', 'oder_qty': '10', 'oder_prc': '71000',
                  'stck_cntg_hour': '093001', 'rfus_yn': 'N'}
        receipt = asyncio.ensure_future(rig.ex.watch_orders())
        await settle()
        rig.emit('H0STCNI9', {**notice, 'cntg_yn': '1', 'cntg_qty': '0'})
        [accepted] = await receipt
        rig.emit('H0STCNI9', {**notice, 'cntg_yn': '2', 'cntg_qty': '3', 'cntg_unpr': '71000'})
        rig.emit('H0STCNI9', {**notice, 'cntg_yn': '2', 'cntg_qty': '7', 'cntg_unpr': '71000'})
        fills = await rig.ex.watch_orders()
        # 가짜 스트림은 부를 때마다 기록한다. 실제 스트림은 같은 구독을 한 번만 보낸다.
        assert set(rig.stream.subscribed) == {('H0STCNI9', 'MYHTS'), ('H0GSCNI9', 'MYHTS')}
        assert {k: accepted[k] for k in ('id', 'symbol', 'side', 'amount', 'filled', 'status', 'price')} == {
            'id': '0000117057', 'symbol': '005930/KRW', 'side': 'buy', 'amount': 10, 'filled': 0, 'status': 'open', 'price': 71000,
        }
        assert [(o['filled'], o['status']) for o in fills] == [(3, 'open'), (10, 'closed')]

    asyncio.run(main())


def test_watch_orders_marks_rejected_and_canceled_notices() -> None:
    async def main() -> None:
        rig = WatchRig({'htsId': 'MYHTS'})
        base = {'seln_byov_cls': '01', 'stck_shrn_iscd': '005930', 'oder_qty': '5', 'stck_cntg_hour': '093001', 'cntg_yn': '1', 'cntg_qty': '0'}
        pending = asyncio.ensure_future(rig.ex.watch_orders('005930/KRW'))
        await settle()
        rig.emit('H0STCNI9', {**base, 'oder_no': 'A1', 'rfus_yn': '1', 'rctf_cls': '0'})
        rig.emit('H0STCNI9', {**base, 'oder_no': 'A2', 'rfus_yn': 'N', 'rctf_cls': '2'})
        first = await pending
        rest = await rig.ex.watch_orders('005930/KRW')
        assert [(o['id'], o['side'], o['status']) for o in first + rest] == [('A1', 'sell', 'rejected'), ('A2', 'sell', 'canceled')]

    asyncio.run(main())


def test_watch_ticker_reconnects_in_a_new_event_loop() -> None:
    """앞선 `asyncio.run` 이 끝나며 연결 작업이 취소됐다. 같은 종목을 다시 기다리면 새로 연결해 구독을 등록한다."""
    ex = new_kis()
    connector = FakeConnector()
    ex.create_realtime_stream = lambda on_record, on_error=None: KisRealtimeStream(  # type: ignore[method-assign]
        ApprovalKey(), True, connector, on_record, on_error, RecordingSleep())
    columns = KIS_REALTIME_COLUMNS['H0STCNT0']

    async def next_price(price: str) -> Any:
        pending = asyncio.ensure_future(ex.watch_ticker('005930/KRW'))
        await settle(10)
        ws = connector.last
        assert not ws.closed and [f['body']['input'] for f in frames(ws)] == [{'tr_id': 'H0STCNT0', 'tr_key': '005930'}]
        fields = {**DOMESTIC_TRADE, 'stck_prpr': price}
        ws.feed(f"0|H0STCNT0|001|{'^'.join(fields.get(column, '') for column in columns)}")
        return (await asyncio.wait_for(pending, 1))['last']

    assert asyncio.run(next_price('71000')) == 71000
    assert asyncio.run(next_price('71100')) == 71100
    assert connector.calls == 2
    asyncio.run(ex.close())


def test_close_stops_the_stream_rejects_waiters_and_closes_the_http_session() -> None:
    async def main() -> None:
        rig = WatchRig()
        rig.ex.open()
        session = rig.ex.session
        pending = asyncio.ensure_future(rig.ex.watch_ticker('005930/KRW'))
        await settle()
        await rig.ex.close()
        with pytest.raises(ExchangeClosedByUser):
            await pending
        assert rig.stream.stopped == 1
        assert session is not None and session.closed and rig.ex.session is None

    asyncio.run(main())


def test_subscribe_rejection_rejects_waiters_of_that_symbol() -> None:
    async def main() -> None:
        rig = WatchRig()
        pending = asyncio.ensure_future(rig.ex.watch_ticker('005930/KRW'))
        await settle()
        rig.fail('H0STCNT0', '005930', 'ALREADY IN USE appkey')
        with pytest.raises(ExchangeError, match='ALREADY IN USE appkey'):
            await pending

    asyncio.run(main())


# ============ watch_orders 정정·취소와 체결 금액 ============

ACCEPTED = {'oder_no': 'A', 'seln_byov_cls': '02', 'stck_shrn_iscd': '005930', 'oder_qty': '10', 'oder_prc': '71000', 'stck_cntg_hour': '093001',
            'rfus_yn': '0'}


async def _accepted_rig(symbol: Optional[str] = None) -> WatchRig:
    """접수 통보(주문 A, 10주)를 받은 뒤의 인스턴스."""
    rig = WatchRig({'htsId': 'MYHTS'})
    first = asyncio.ensure_future(rig.ex.watch_orders(symbol))
    await settle()
    rig.emit('H0STCNI9', {**ACCEPTED, 'cntg_yn': '1', 'cntg_qty': '10', 'rctf_cls': '0'})
    await first
    return rig


def test_watch_orders_cancel_notice_reduces_the_original_order_and_is_not_stored_itself() -> None:
    async def main() -> None:
        rig = await _accepted_rig()
        rig.emit('H0STCNI9', {**ACCEPTED, 'cntg_yn': '2', 'cntg_qty': '3', 'cntg_unpr': '71000', 'rctf_cls': '0'})
        rig.emit('H0STCNI9', {**ACCEPTED, 'oder_no': 'B', 'ooder_no': 'A', 'cntg_yn': '1', 'cntg_qty': '7', 'oder_qty': '', 'rctf_cls': '2'})
        orders = await rig.ex.watch_orders()
        assert [(o['id'], o['status'], o['filled'], o['remaining']) for o in orders] == [('A', 'open', 3, 7), ('A', 'canceled', 3, 0)]

    asyncio.run(main())


def test_watch_orders_amend_notice_moves_the_remainder_to_the_new_order_once() -> None:
    async def main() -> None:
        rig = await _accepted_rig('005930/KRW')
        amend = {**ACCEPTED, 'oder_no': 'C', 'ooder_no': 'A', 'cntg_yn': '1', 'cntg_qty': '4', 'cntg_unpr': '70500', 'oder_qty': '', 'oder_prc': '70500',
                 'rctf_cls': '1'}
        rig.emit('H0STCNI9', {**amend, 'acpt_yn': '1'})
        rig.emit('H0STCNI9', {**amend, 'acpt_yn': '2'})
        orders = await rig.ex.watch_orders('005930/KRW')
        assert [(o['id'], o['status'], o['amount'], o['remaining'], o['price']) for o in orders] == [
            ('A', 'open', 10, 6, 71000), ('C', 'open', 4, 4, 70500), ('C', 'open', 4, 4, 70500),
        ]

    asyncio.run(main())


def test_watch_orders_full_amend_cancels_the_original_order() -> None:
    async def main() -> None:
        rig = await _accepted_rig()
        rig.emit('H0STCNI9', {**ACCEPTED, 'oder_no': 'C', 'ooder_no': 'A', 'cntg_yn': '1', 'cntg_qty': '10', 'oder_qty': '', 'oder_prc': '70500',
                              'rctf_cls': '1'})
        orders = await rig.ex.watch_orders()
        assert [(o['id'], o['status']) for o in orders] == [('A', 'canceled'), ('C', 'open')]

    asyncio.run(main())


def test_watch_orders_rejected_cancel_leaves_the_original_order() -> None:
    async def main() -> None:
        rig = await _accepted_rig()
        rig.emit('H0STCNI9', {**ACCEPTED, 'oder_no': 'B', 'ooder_no': 'A', 'cntg_yn': '1', 'cntg_qty': '10', 'rfus_yn': '1', 'rctf_cls': '2'})
        orders = await rig.ex.watch_orders()
        assert [(o['id'], o['status']) for o in orders] == [('B', 'rejected')]

    asyncio.run(main())


def test_watch_orders_accumulates_cost_and_average_from_fill_prices() -> None:
    async def main() -> None:
        rig = WatchRig({'htsId': 'MYHTS'})
        first = asyncio.ensure_future(rig.ex.watch_orders())
        await settle()
        rig.emit('H0STCNI9', {**ACCEPTED, 'cntg_yn': '2', 'cntg_qty': '3', 'cntg_unpr': '71000', 'rctf_cls': '0'})
        await first
        rig.emit('H0STCNI9', {**ACCEPTED, 'cntg_yn': '2', 'cntg_qty': '7', 'cntg_unpr': '71100', 'rctf_cls': '0'})
        [order] = await rig.ex.watch_orders()
        assert {k: order[k] for k in ('filled', 'cost', 'average', 'status', 'remaining')} == {
            'filled': 10, 'cost': 710700, 'average': 71070, 'status': 'closed', 'remaining': 0,
        }

    asyncio.run(main())


def test_watch_orders_reads_overseas_prices_with_four_implied_decimals() -> None:
    async def main() -> None:
        rig = WatchRig({'htsId': 'MYHTS'})
        notice = {'oder_no': 'O1', 'seln_byov_cls': '02', 'stck_shrn_iscd': 'AAPL', 'stck_cntg_hour': '223000', 'rfus_yn': '0', 'rctf_cls': '0'}
        first = asyncio.ensure_future(rig.ex.watch_orders('AAPL/USD'))
        await settle()
        rig.emit('H0GSCNI9', {**notice, 'cntg_yn': '1', 'cntg_qty': '0000000002', 'cntg_unpr': '001480100', 'oder_qty': ''})
        [receipt] = await first
        rig.emit('H0GSCNI9', {**notice, 'cntg_yn': '2', 'cntg_qty': '0000000002', 'cntg_unpr': '001480100', 'oder_qty': '0000000002'})
        [fill] = await rig.ex.watch_orders('AAPL/USD')
        assert {k: receipt[k] for k in ('id', 'symbol', 'amount', 'price', 'status')} == {
            'id': 'O1', 'symbol': 'AAPL/USD', 'amount': 2, 'price': 148.01, 'status': 'open',
        }
        assert {k: fill[k] for k in ('filled', 'cost', 'average', 'status')} == {'filled': 2, 'cost': 296.02, 'average': 148.01, 'status': 'closed'}

    asyncio.run(main())


def test_order_notice_rejection_rejects_per_symbol_watch_orders_too() -> None:
    async def main() -> None:
        rig = WatchRig({'htsId': 'MYHTS'})
        every = asyncio.ensure_future(rig.ex.watch_orders())
        by_symbol = asyncio.ensure_future(rig.ex.watch_orders('005930/KRW'))
        await settle()
        rig.fail('H0STCNI9', 'MYHTS', 'MAX SUBSCRIBE OVER')
        for pending in (every, by_symbol):
            with pytest.raises(ExchangeError, match='MAX SUBSCRIBE OVER'):
                await pending

    asyncio.run(main())
