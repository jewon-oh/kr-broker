"""토스 실시간 시세 WebSocket 클라이언트. TypeScript 판 `ts/src/toss/toss-price-ws.ts` 를 옮겼다.

연결 하나로 체결(`trade:us`, `trade:kr`), 호가(`orderbook:us`, `orderbook:kr`), 본인 주문 이벤트(`personal:order`)를 구독해 콜백으로 넘긴다.
공식 AsyncAPI 스펙(`openapi.tossinvest.com/openapi-docs/latest/asyncapi.json`)을 따른다.

- 인증: 연결(handshake) 요청의 `Authorization: Bearer {access_token}` 헤더. REST 와 같은 토큰을 쓴다.
- 구독: 선언형 full-replace 다. 연결마다, 그리고 구독을 바꿀 때마다 현재 구독 전체를 배열 하나로 다시 보낸다(KIS 처럼 종목을 하나씩
  더하는 방식이 아니다). 빈 배열은 전체 해제다.
- keepalive: 순수 텍스트 `PING`(60초 권장, JSON 아님)을 보내면 서버가 `{"type":"pong"}` 으로 답한다.
- 재연결: 지수 백오프(1초에서 30초까지). 재연결 전에 이전 연결을 닫는다(공식 문서 권고). 연결 관리는 `ReconnectingWebSocket` 이 한다.
- `rate-limit-exceeded` 오류 프레임을 받으면 1초 뒤 구독을 다시 선언한다(공식 문서 권고 값).

구독은 사전이다. 시세는 `{'channel': 'trade' | 'orderbook', 'market': 'us' | 'kr', 'symbol': 토스 종목 코드}` 이고(통합 심볼이 아니라
미국은 대문자 티커, 국내는 6자리 숫자다), 본인 주문은 `{'channel': 'order', 'accountSeq': 계좌 순번 문자열}` 이다.
"""

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from kr_broker.async_support.base.runtime import sleep_seconds
from kr_broker.async_support.base.ws.client import ReconnectingWebSocket, WsConnect
from kr_broker.toss_realtime_parser import parse_toss_ws_frame

logger = logging.getLogger('kr_broker')

WSS_URL = 'wss://openapi-ws.tossinvest.com/ws/v1'
RECONNECT_BASE_MS = 1_000
RECONNECT_MAX_MS = 30_000
PING_INTERVAL_MS = 60_000
# 연결당 구독 한계(공식 문서, `codes` 합산). 넘친 것은 서버가 `too-many-topics` 로 거부한다.
MAX_SUBSCRIPTIONS = 100
# `rate-limit-exceeded` 뒤 다시 선언하기까지 대기(공식 문서 권고 값).
RATE_LIMIT_RETRY_MS = 1_000

TossWsSub = Dict[str, str]
# (시장, 종목 코드, 가격, 수량, 체결 시각 ms 또는 None)
OnTrade = Callable[[str, str, float, float, Optional[int]], Any]
# (시장, 종목 코드, 매수호가, 매도호가, 호가 시각 ms 또는 None). 호가는 `[가격, 잔량]` 목록이다.
OnOrderbook = Callable[[str, str, List[List[float]], List[List[float]], Optional[int]], Any]
# (계좌 순번, 이벤트, 주문 원본). 주문 구조가 필요하면 `exchange.parse_order(order)` 를 부른다.
OnOrder = Callable[[str, str, Dict[str, Any]], Any]


class TossPriceWs(ReconnectingWebSocket):
    label = '[TossPriceWs]'
    reconnect_base_ms = RECONNECT_BASE_MS
    reconnect_max_ms = RECONNECT_MAX_MS
    ping_interval_ms = PING_INTERVAL_MS
    ping_text = 'PING'
    rate_limit_retry_ms = RATE_LIMIT_RETRY_MS

    def __init__(self, get_access_token: Callable[[], Awaitable[str]], connect: WsConnect, on_trade: Optional[OnTrade] = None,
                 on_orderbook: Optional[OnOrderbook] = None, on_order: Optional[OnOrder] = None,
                 sleep: Callable[[float], Awaitable[Any]] = sleep_seconds) -> None:
        super().__init__(connect, sleep)
        self._get_access_token = get_access_token
        self._on_trade = on_trade
        self._on_orderbook = on_orderbook
        self._on_order = on_order
        self.subs: List[TossWsSub] = []

    def start(self, subs: List[TossWsSub]) -> None:  # type: ignore[override]
        self.subs = subs
        if len(subs) > MAX_SUBSCRIPTIONS:
            logger.warning('[TossPriceWs] 구독 수가 연결당 한계 초과 — 초과분 누락 가능(%d > %d)', len(subs), MAX_SUBSCRIPTIONS)
        super().start()

    def update_subs(self, subs: List[TossWsSub]) -> None:
        """구독을 통째로 바꾼다(선언형 full-replace 라 KIS 처럼 새 것만 더하지 않는다)."""
        self.subs = subs
        if self.is_connected():
            self._declare()

    async def connect_target(self) -> Tuple[str, Dict[str, str]]:
        access_token = await self._get_access_token()
        return WSS_URL, {'Authorization': f'Bearer {access_token}'}

    def on_open(self) -> None:
        logger.info('[TossPriceWs] WS 연결 완료 — 구독 선언(구독 %d개)', len(self.subs))
        self._declare()

    def _declare(self) -> None:
        """현재 구독 전체를 채널(과 시장 또는 계좌)별로 묶어 한 번에 선언한다(선언형 full-replace)."""
        if not self.is_connected():
            return
        grouped: Dict[str, List[str]] = {}
        for sub in self.subs:
            if sub['channel'] == 'order':
                key, code = 'personal:order', sub['accountSeq']
            else:
                key, code = f"{sub['channel']}:{sub['market']}", sub['symbol']
            grouped.setdefault(key, []).append(code)
        frame = [{'type': key, 'codes': codes} for key, codes in grouped.items()]
        self.send(json.dumps(frame, ensure_ascii=False, separators=(',', ':')))

    def on_message(self, text: str) -> None:
        event = parse_toss_ws_frame(text)
        kind = event['kind']
        if kind == 'trade':
            data = event['data']
            if self._on_trade is not None:
                self._on_trade(data['market'], data['symbol'], data['price'], data['volume'], data['timestamp'])
        elif kind == 'orderbook':
            data = event['data']
            if self._on_orderbook is not None:
                self._on_orderbook(data['market'], data['symbol'], data['bids'], data['asks'], data['timestamp'])
        elif kind == 'order':
            data = event['data']
            if self._on_order is not None:
                self._on_order(data['accountSeq'], data['event'], data['order'])
        elif kind == 'subscriptions':
            if event['rejected']:
                logger.warning('[TossPriceWs] 일부 구독이 거부됐다: %s', event['rejected'])
        elif kind == 'error':
            logger.warning('[TossPriceWs] 에러 프레임(%s): %s', event['code'], event['message'])
            if event['code'] == 'rate-limit-exceeded':
                asyncio.get_running_loop().call_later(self.rate_limit_retry_ms / 1000, self._declare)
