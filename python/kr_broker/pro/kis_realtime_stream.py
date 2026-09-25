"""KIS 실시간(웹소켓) 범용 구독. TypeScript 판 `ts/src/kis/kis-realtime-stream.ts` 를 옮겼다.

`KisPriceWs` 는 체결, 호가 세 TR 만 가격으로 읽고 나머지 프레임을 버린다. 이 클래스는 어떤 TR 이든 구독과 해지를 하고, 받은 값을
`KIS_REALTIME_COLUMNS` 의 필드 이름으로 묶어 원문 문자열 그대로 넘긴다. 체결통보(맨 앞이 `1`)는 구독 응답이 준 key 와 iv 로 AES-CBC 복호한 뒤
같은 방식으로 읽는다(공식 예제 `kis_auth.py` 의 `aes_cbc_base64_dec` 와 같다).

연결과 재연결은 `ReconnectingWebSocket` 이 맡는다. 재연결 대기는 2초에서 시작해 두 배씩 늘고 30초에서 멈춘다.
"""

import base64
import json
import logging
import math
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Tuple

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from kr_broker.async_support.base.runtime import sleep_seconds
from kr_broker.async_support.base.ws.client import ReconnectingWebSocket, WsConnect
from kr_broker.base import functions as fn
from kr_broker.kis_realtime_columns import kis_realtime_columns
from kr_broker.kis_realtime_parser import is_ping_pong
from kr_broker.kis_types import KIS_WS_DOMAINS, KIS_WS_PATH

__all__ = ['KisRealtimeRecord', 'KisRealtimeStream', 'split_kis_realtime_records', 'decrypt_kis_payload']

# 늘 암호화되어 오는 체결통보 TR(국내, 해외, 실전, 모의).
_ENCRYPTED_NOTICE_TRS = frozenset(['H0STCNI0', 'H0STCNI9', 'H0GSCNI0', 'H0GSCNI9'])

logger = logging.getLogger('kr_broker')

RECONNECT_BASE_MS = 2_000
RECONNECT_MAX_MS = 30_000
# KIS 연결당 등록 한계(`KisPriceWs` 와 같다). 넘으면 경고만 남기고 등록한다.
MAX_REGISTRATIONS = 40


class KisRealtimeRecord(NamedTuple):
    """실시간 수신 한 건."""
    tr_id: str
    # 필드 순서대로의 원문 값
    values: List[str]
    # 필드 이름을 아는 TR 이면 이름으로 묶은 값. 모르는 TR 이면 None 이다
    fields: Optional[Dict[str, str]]


def split_kis_realtime_records(tr_id: str, count: float, payload: str) -> List[KisRealtimeRecord]:
    """받은 값을 건수만큼 나눈다. 값 수가 건수로 나눠떨어지면 그 몫으로 자른다. 나눠떨어지지 않으면 필드 이름을 아는 TR 은 필드 수로 자르고,
    값이 모자라거나 모르는 TR 이면 전체 값 수를 건수로 나눈 길이로 자른다. 필드 이름은 위치대로 붙인다."""
    values = payload.split('^')
    columns = kis_realtime_columns(tr_id)
    # JavaScript 의 `Number.isInteger(count) && count > 0 ? count : 1`
    n = int(count) if isinstance(count, (int, float)) and math.isfinite(count) and count == int(count) and count > 0 else 1
    # KIS 가 필드를 뒤에 더해도 두 번째 건부터 어긋나지 않게 필드 수보다 값 수를 먼저 믿는다.
    if len(values) % n == 0:
        size = len(values) // n
    else:
        size = len(columns) if columns is not None and len(columns) * n <= len(values) else len(values) // n
    if size <= 0:
        return []
    records: List[KisRealtimeRecord] = []
    for i in range(n):
        chunk = values[i * size:(i + 1) * size]
        fields = None if columns is None else {column: chunk[j] for j, column in enumerate(columns) if j < len(chunk)}
        records.append(KisRealtimeRecord(tr_id, chunk, fields))
    return records


def decrypt_kis_payload(cipher_text: str, key: str, iv: str) -> str:
    """체결통보 본문 복호. base64 암호문을 key, iv(구독 응답의 UTF-8 문자열)로 AES-CBC(PKCS7) 복호한다."""
    decryptor = Cipher(algorithms.AES(key.encode('utf-8')), modes.CBC(iv.encode('utf-8'))).decryptor()
    padded = decryptor.update(base64.b64decode(cipher_text)) + decryptor.finalize()
    unpadder = padding.PKCS7(algorithms.AES.block_size).unpadder()
    plain = unpadder.update(padded) + unpadder.finalize()
    # TypeScript 판의 `TextDecoder` 처럼 깨진 바이트는 대체 문자로 바꾼다.
    return plain.decode('utf-8', errors='replace')


def subscription_frame(approval_key: str, tr_id: str, tr_key: str, tr_type: str) -> str:
    """구독(`tr_type` 1)과 해지(2) 요청 프레임."""
    return fn.json_stringify({
        'header': {'approval_key': approval_key, 'custtype': 'P', 'tr_type': tr_type, 'content-type': 'utf-8'},
        'body': {'input': {'tr_id': tr_id, 'tr_key': tr_key}},
    })


def _text(value: Any) -> str:
    """JavaScript 의 `String(value ?? '')`."""
    return '' if value is None else fn.js_string(value)


class KisRealtimeStream(ReconnectingWebSocket):
    """`subscribe(tr_id, tr_key)` 로 구독하고 받은 값을 `on_record` 에 넘긴다. 실행 중인 이벤트 루프 안에서 쓴다."""

    label = '[KisRealtimeStream]'
    reconnect_base_ms = RECONNECT_BASE_MS
    reconnect_max_ms = RECONNECT_MAX_MS

    def __init__(self, get_approval_key: Callable[[], Awaitable[str]], is_virtual: bool, connect: WsConnect,
                 on_record: Callable[[KisRealtimeRecord], None], on_subscribe_error: Optional[Callable[[str, str, str], None]] = None,
                 sleep: Callable[[float], Awaitable[Any]] = sleep_seconds, url: Optional[str] = None) -> None:
        super().__init__(connect, sleep)
        self._get_approval_key = get_approval_key
        self.is_virtual = is_virtual
        # 접속 주소. 없으면 `is_virtual` 에 따라 KIS 기본 주소다.
        self.url = url
        self._on_record = on_record
        # 구독 응답이 실패(`rt_cd` 가 `0` 이 아님)면 부른다
        self._on_subscribe_error = on_subscribe_error
        self._approval_key = ''
        self._subs: Dict[str, Tuple[str, str]] = {}
        self._cipher_keys: Dict[str, Tuple[str, str]] = {}

    def subscribe(self, tr_id: str, tr_key: str) -> None:
        """구독을 등록한다. 처음 부르면 접속하고, 접속 뒤에는 바로 등록 프레임(`tr_type` 1)을 보낸다. 같은 구독은 한 번만 보낸다."""
        sub_id = f'{tr_id}|{tr_key}'
        if sub_id in self._subs:
            # 앞선 이벤트 루프가 끝나 연결 작업이 멈췄으면 다시 연결한다. 연결되면 등록된 구독을 모두 다시 보낸다.
            if not self.running:
                self.start()
            return
        if len(self._subs) >= MAX_REGISTRATIONS:
            logger.warning('[KisRealtimeStream] 연결당 등록 한계를 넘는다 (trId=%s, trKey=%s, subs=%s)', tr_id, tr_key, len(self._subs))
        self._subs[sub_id] = (tr_id, tr_key)
        if not self.running:
            self.start()
            return
        self._send_sub(tr_id, tr_key, '1')

    def unsubscribe(self, tr_id: str, tr_key: str) -> None:
        """구독을 해지한다(`tr_type` 2)."""
        if self._subs.pop(f'{tr_id}|{tr_key}', None) is None:
            return
        self._send_sub(tr_id, tr_key, '2')

    async def connect_target(self) -> Tuple[str, Dict[str, str]]:
        self._approval_key = await self._get_approval_key()
        return self.url or (KIS_WS_DOMAINS['VIRTUAL'] if self.is_virtual else KIS_WS_DOMAINS['REAL']) + KIS_WS_PATH, {}

    def on_open(self) -> None:
        for tr_id, tr_key in list(self._subs.values()):
            self._send_sub(tr_id, tr_key, '1')

    def _send_sub(self, tr_id: str, tr_key: str, tr_type: str) -> None:
        self.send(subscription_frame(self._approval_key, tr_id, tr_key, tr_type))

    def on_message(self, text: str) -> None:
        if is_ping_pong(text):
            self.send(text)
            return
        if text[:1] == '{':
            self._on_system_message(text)
            return
        self._on_data(text)

    def _on_system_message(self, raw: str) -> None:
        """구독 응답. 실패면 그 구독을 지우고 알린다. 성공이면 체결통보의 복호 key 와 iv 를 TR 별로 기억한다."""
        try:
            message = json.loads(raw)
        except ValueError:
            return
        if not isinstance(message, dict):
            return
        header = message.get('header') if isinstance(message.get('header'), dict) else {}
        body = message.get('body') if isinstance(message.get('body'), dict) else {}
        tr_id = _text(header.get('tr_id'))
        # TypeScript 판처럼 `rt_cd` 가 없을 때만 넘어가고, null 은 실패로 본다.
        if 'rt_cd' in body and fn.js_string(body['rt_cd']) != '0':
            tr_key = _text(header.get('tr_key'))
            # 거부된 구독을 남겨 두면 같은 구독을 다시 불러도 등록 프레임을 보내지 않는다.
            self._subs.pop(f'{tr_id}|{tr_key}', None)
            if self._on_subscribe_error is not None:
                self._on_subscribe_error(tr_id, tr_key, _text(body.get('msg1')))
            return
        output = body.get('output') if isinstance(body.get('output'), dict) else {}
        key, iv = output.get('key'), output.get('iv')
        if isinstance(key, str) and isinstance(iv, str) and key != '' and iv != '':
            self._cipher_keys[tr_id] = (key, iv)

    def _on_data(self, raw: str) -> None:
        parts = raw.split('|')
        if len(parts) < 4:
            return
        flag, tr_id, count_text = parts[0], parts[1], parts[2]
        payload = '|'.join(parts[3:])
        # KIS 실시간 연결은 평문이다. 체결통보는 늘 암호화되어 오므로, 평문 체결통보는 경로 위에서 끼워 넣은 프레임으로 보고 버린다.
        if flag != '1' and tr_id in _ENCRYPTED_NOTICE_TRS:
            logger.warning('[KisRealtimeStream] 암호화되지 않은 체결통보 프레임 — 버린다 (trId=%s)', tr_id)
            return
        if flag == '1':
            cipher = self._cipher_keys.get(tr_id)
            if cipher is None:
                logger.warning('[KisRealtimeStream] 복호 key 를 받기 전에 암호화 프레임이 왔다 — 버린다 (trId=%s)', tr_id)
                return
            try:
                payload = decrypt_kis_payload(payload, cipher[0], cipher[1])
            except Exception:
                logger.warning('[KisRealtimeStream] 복호 실패 — 버린다 (trId=%s)', tr_id, exc_info=True)
                return
        for record in split_kis_realtime_records(tr_id, fn.js_number(count_text), payload):
            # 한 건의 콜백이 던져도 나머지 건은 계속 넘긴다.
            try:
                self._on_record(record)
            except Exception:
                logger.warning('[KisRealtimeStream] on_record 처리 실패 (trId=%s)', tr_id, exc_info=True)
