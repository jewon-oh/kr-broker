"""토스 실시간 시세 WS 프레임 파서. TypeScript 판 `ts/src/toss/toss-realtime-parser.ts` 를 옮겼다.

토스 WS 는 KIS 와 달리 프레임이 전부 JSON 이다(파이프 구분 텍스트나 암호화가 없다). `type` 으로 프레임 종류를 가르고,
시세(`message`)는 `topic`(`trade:{시장}:{심볼}`, `orderbook:{시장}:{심볼}`, `personal:order:{accountSeq}`)으로 채널과 시장(또는 계좌)을 가른다.

돌려주는 사건은 `kind` 로 가르는 사전이다. 키 이름은 TypeScript 판의 타입 선언과 같다.

- `{'kind': 'trade', 'data': {'market', 'symbol', 'price', 'volume', 'timestamp'}}`
- `{'kind': 'orderbook', 'data': {'market', 'symbol', 'bids', 'asks', 'timestamp'}}`: 호가는 `[가격, 잔량]` 목록이다.
- `{'kind': 'order', 'data': {'accountSeq', 'event', 'order'}}`: `order` 는 `GET /orders/{orderId}` 응답과 같은 모양의 원본이다
  (`execution.filledAt` 은 없다). 주문 구조로 바꾸는 일은 호출하는 쪽이 `parse_order` 로 한다.
- `{'kind': 'subscriptions', 'rejected': [...]}`, `{'kind': 'error', 'code', 'message'}`, `{'kind': 'pong'}`, `{'kind': 'unknown'}`

`timestamp` 는 프레임의 ISO 8601 시각을 읽은 밀리초이고, 없거나 못 읽으면 `None` 이다.
"""

import json
import math
from typing import Any, Dict, List, Optional

from kr_broker.base import functions as fn

PERSONAL_ORDER_PREFIX = 'personal:order:'


def _unknown() -> Dict[str, Any]:
    return {'kind': 'unknown'}


def _number(obj: Dict[str, Any], key: str) -> float:
    """JavaScript `Number(obj[key])` 와 같다. 키가 없으면(`undefined`) NaN 이다."""
    return fn.js_number(obj[key]) if key in obj else math.nan


def _to_price_levels(value: Any) -> List[List[float]]:
    if not isinstance(value, list):
        return []
    levels = []
    for row in value:
        if not isinstance(row, dict):
            continue
        price = _number(row, 'price')
        volume = _number(row, 'volume')
        if math.isfinite(price) and math.isfinite(volume):
            levels.append([price, volume])
    return levels


def _frame_timestamp(value: Any) -> Optional[int]:
    """프레임의 ISO 8601 시각 → ms. 없거나 못 읽으면 `None` 이다."""
    return fn.parse8601(value) if isinstance(value, str) else None


def _parse_message_frame(topic: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """시세(`message`) 프레임 하나를 옮긴다. `topic` 이 `trade:`, `orderbook:`, `personal:order:` 접두가 아니면 `unknown` 이다."""
    if topic.startswith(PERSONAL_ORDER_PREFIX):
        account_seq = topic[len(PERSONAL_ORDER_PREFIX):]
        event = data.get('event')
        order = data.get('order')
        if account_seq == '' or not isinstance(event, str) or not isinstance(order, dict):
            return _unknown()
        return {'kind': 'order', 'data': {'accountSeq': account_seq, 'event': event, 'order': order}}
    parts = topic.split(':')
    channel = parts[0]
    market = parts[1] if len(parts) > 1 else None
    symbol = ':'.join(parts[2:])
    if symbol == '' or market not in ('us', 'kr'):
        return _unknown()
    if channel == 'trade':
        price = _number(data, 'price')
        volume = _number(data, 'volume')
        if not math.isfinite(price) or not math.isfinite(volume):
            return _unknown()
        return {'kind': 'trade', 'data': {
            'market': market, 'symbol': symbol, 'price': price, 'volume': volume, 'timestamp': _frame_timestamp(data.get('timestamp')),
        }}
    if channel == 'orderbook':
        return {'kind': 'orderbook', 'data': {
            'market': market, 'symbol': symbol, 'bids': _to_price_levels(data.get('bids')), 'asks': _to_price_levels(data.get('asks')),
            'timestamp': _frame_timestamp(data.get('timestamp')),
        }}
    return _unknown()


def _reject_constant(name: str) -> Any:
    # `JSON.parse` 처럼 `NaN`, `Infinity` 를 JSON 으로 받지 않는다.
    raise ValueError(name)


def parse_toss_ws_frame(raw: str) -> Dict[str, Any]:
    """텍스트 프레임 하나를 옮긴다. JSON 이 아니거나 알 수 없는 `type` 이면 `unknown` 이다."""
    try:
        payload = json.loads(raw, parse_constant=_reject_constant)
    except ValueError:
        return _unknown()
    if not isinstance(payload, dict):
        return _unknown()
    frame_type = payload.get('type')
    if frame_type == 'pong':
        return {'kind': 'pong'}
    if frame_type == 'subscriptions':
        rejected = payload.get('rejected')
        return {'kind': 'subscriptions', 'rejected': rejected if isinstance(rejected, list) else []}
    if frame_type == 'error':
        error = payload.get('error')
        error = error if isinstance(error, dict) else {}
        code = error.get('code')
        message = error.get('message')
        return {'kind': 'error', 'code': '' if code is None else code, 'message': '' if message is None else message}
    if frame_type == 'message':
        topic = payload.get('topic')
        if not isinstance(topic, str):
            return _unknown()
        data = payload.get('data')
        return _parse_message_frame(topic, data if isinstance(data, dict) else {})
    return _unknown()
