"""KIS 실시간 시세 웹소켓. TypeScript 판 `ts/src/kis/kis-price-ws.ts` 를 옮겼다. `kis.create_price_stream()` 이 돌려주는 클래스다.

연결 하나로 체결가(`H0STCNT0`, `HDFSCNT0`)와 호가(`H0STASP0`)를 구독해 콜백으로 넘긴다. 인증은 접속키(approval_key)로 하고, 끊기면
접속키를 다시 받아 지수 백오프(2초에서 30초까지)로 다시 잇고 구독을 다시 등록한다. PINGPONG 은 받은 그대로 되돌려 보낸다.
프레임 해석은 순수 함수(`kis_realtime_parser`)가 맡는다.

TypeScript 판은 전역 `WebSocket` 이 없는 Node 에서 `ws` 패키지로 폴백하는 판정(`isKisWsSupported`, `isUsingGlobalWebSocket`)을 둔다.
Python 판은 aiohttp 가 필수 의존성이라 그 판정이 없다.
"""

import logging
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Sequence, Tuple

from kr_broker.async_support.base.runtime import sleep_seconds
from kr_broker.async_support.base.ws.client import ReconnectingWebSocket, WsConnect
from kr_broker.kis_realtime_parser import KisTradeRecord, is_ping_pong, parse_kis_realtime_frame, to_stream_symbol
from kr_broker.kis_types import KIS_WS_DOMAINS, KIS_WS_PATH
from kr_broker.pro.kis_realtime_stream import subscription_frame

__all__ = ['KisWsSub', 'KisPriceWs']

logger = logging.getLogger('kr_broker')

RECONNECT_BASE_MS = 2_000
RECONNECT_MAX_MS = 30_000
# KIS 연결당 등록 한계(41 안팎). 넘는 구독은 빠지므로 폴링으로 메워야 한다.
MAX_REGISTRATIONS = 40

OnTrade = Callable[[str, float, float], None]
OnOrderbook = Callable[[str, List[Tuple[float, float]], List[Tuple[float, float]]], None]


class KisWsSub(NamedTuple):
    """구독 하나."""
    # `KIS_WS_TR` 값(H0STCNT0, H0STASP0, HDFSCNT0)
    tr_id: str
    # 구독 키. 국내는 종목코드(005930), 해외는 D + 거래소 + 심볼(DNASAAPL)
    tr_key: str


class KisPriceWs(ReconnectingWebSocket):
    """`start(subs)` 로 구독을 시작하고 체결은 `on_trade(스트림 심볼, 현재가, 등락률)`, 호가는 `on_orderbook(스트림 심볼, 매수, 매도)` 로 넘긴다.
    실행 중인 이벤트 루프 안에서 쓴다."""

    label = '[KisPriceWs]'
    reconnect_base_ms = RECONNECT_BASE_MS
    reconnect_max_ms = RECONNECT_MAX_MS

    def __init__(self, get_approval_key: Callable[[], Awaitable[str]], is_virtual: bool, connect: WsConnect,
                 on_trade: Optional[OnTrade] = None, on_orderbook: Optional[OnOrderbook] = None,
                 sleep: Callable[[float], Awaitable[Any]] = sleep_seconds) -> None:
        super().__init__(connect, sleep)
        self._get_approval_key = get_approval_key
        self.is_virtual = is_virtual
        self._on_trade = on_trade
        self._on_orderbook = on_orderbook
        self._approval_key = ''
        self._subs: List[KisWsSub] = []

    def start(self, subs: Sequence[Tuple[str, str]] = ()) -> None:  # type: ignore[override]
        self._subs = [KisWsSub(*sub) for sub in subs]
        if len(self._subs) > MAX_REGISTRATIONS:
            logger.warning('[KisPriceWs] 구독 수가 연결당 한계 초과 — 초과분 누락 가능(폴링 폴백 의존) (count=%s, limit=%s)',
                           len(self._subs), MAX_REGISTRATIONS)
        super().start()

    def update_subs(self, subs: Sequence[Tuple[str, str]]) -> None:
        """구독을 바꾼다. 연결돼 있으면 새로 생긴 구독만 등록한다."""
        existing = {f'{sub.tr_id}:{sub.tr_key}' for sub in self._subs}
        self._subs = [KisWsSub(*sub) for sub in subs]
        if self.is_connected():
            for sub in self._subs:
                if f'{sub.tr_id}:{sub.tr_key}' not in existing:
                    self._register(sub)

    async def connect_target(self) -> Tuple[str, Dict[str, str]]:
        self._approval_key = await self._get_approval_key()
        return (KIS_WS_DOMAINS['VIRTUAL'] if self.is_virtual else KIS_WS_DOMAINS['REAL']) + KIS_WS_PATH, {}

    def on_open(self) -> None:
        logger.info('[KisPriceWs] WS 연결 완료 — 구독 등록 (subs=%s)', len(self._subs))
        for sub in self._subs:
            self._register(sub)

    def _register(self, sub: KisWsSub) -> None:
        self.send(subscription_frame(self._approval_key, sub.tr_id, sub.tr_key, '1'))

    def on_message(self, text: str) -> None:
        if is_ping_pong(text):
            self.send(text)
            return
        if text[:1] == '{':
            return  # 구독 응답(JSON)은 버린다
        for record in parse_kis_realtime_frame(text):
            stream_symbol = to_stream_symbol(record.symbol)
            if isinstance(record, KisTradeRecord):
                if self._on_trade is not None:
                    self._on_trade(stream_symbol, record.last, record.change_pct)
            elif self._on_orderbook is not None:
                self._on_orderbook(stream_symbol, record.bids, record.asks)
