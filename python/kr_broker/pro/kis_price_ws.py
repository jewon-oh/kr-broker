"""KIS 실시간 시세 웹소켓. TypeScript 판 `ts/src/kis/kis-price-ws.ts` 를 옮겼다. `kis.create_price_stream()` 이 돌려주는 클래스다.

연결 하나로 체결가(`H0STCNT0`, `HDFSCNT0`)와 호가(`H0STASP0`)를 구독해 콜백으로 넘긴다. 연결과 재연결(접속키 재발급, 2초에서 30초까지
지수 백오프, 구독 재등록), PINGPONG 되돌림, 구독 거부 알림은 `KisRealtimeStream` 이 맡고, 이 클래스는 그 위에서 프레임을 가격으로만 읽는다.
프레임 해석은 순수 함수(`kis_realtime_parser`)가 맡는다.

TypeScript 판은 전역 `WebSocket` 이 없는 Node 에서 `ws` 패키지로 폴백하는 판정(`isKisWsSupported`, `isUsingGlobalWebSocket`)을 둔다.
Python 판은 aiohttp 가 필수 의존성이라 그 판정이 없다.
"""

import logging
from typing import Any, Awaitable, Callable, List, Optional, Sequence, Tuple

from kr_broker.async_support.base.runtime import sleep_seconds
from kr_broker.async_support.base.ws.client import WsConnect
from kr_broker.kis_realtime_parser import KisTradeRecord, parse_kis_realtime_payload, to_stream_symbol
from kr_broker.pro.kis_realtime_stream import MAX_REGISTRATIONS, KisRealtimeStream, KisWsSub

__all__ = ['KisWsSub', 'KisPriceWs']

logger = logging.getLogger('kr_broker')

OnTrade = Callable[[str, float, float], None]
OnOrderbook = Callable[[str, List[Tuple[float, float]], List[Tuple[float, float]]], None]
OnSubscribeError = Callable[[str, str, str], None]


class KisPriceWs(KisRealtimeStream):
    """`start(subs)` 로 구독을 시작하고 체결은 `on_trade(스트림 심볼, 현재가, 등락률)`, 호가는 `on_orderbook(스트림 심볼, 매수, 매도)` 로 넘긴다.
    구독 응답이 실패(`rt_cd` 가 `0` 이 아님)면 로그를 남기고 `on_subscribe_error(tr_id, tr_key, 메시지)` 로 알린다. 실행 중인 이벤트 루프 안에서 쓴다."""

    label = '[KisPriceWs]'

    def __init__(self, get_approval_key: Callable[[], Awaitable[str]], is_virtual: bool, connect: WsConnect,
                 on_trade: Optional[OnTrade] = None, on_orderbook: Optional[OnOrderbook] = None,
                 sleep: Callable[[float], Awaitable[Any]] = sleep_seconds, url: Optional[str] = None,
                 on_subscribe_error: Optional[OnSubscribeError] = None) -> None:
        # 프레임은 `_on_frame` 이 가격으로 읽는다.
        super().__init__(get_approval_key, is_virtual, connect, lambda record: None, on_subscribe_error, sleep, url)
        self._on_trade = on_trade
        self._on_orderbook = on_orderbook

    def start(self, subs: Sequence[Tuple[str, str]] = ()) -> None:  # type: ignore[override]
        wanted = [KisWsSub(*sub) for sub in subs]
        if len(wanted) > MAX_REGISTRATIONS:
            logger.warning('[KisPriceWs] 구독 수가 연결당 한계 초과 — 초과분 누락 가능(폴링 폴백 의존) (count=%s, limit=%s)',
                           len(wanted), MAX_REGISTRATIONS)
        self._set_subs(wanted)
        super().start()

    def update_subs(self, subs: Sequence[Tuple[str, str]]) -> None:
        """구독을 바꾼다. 연결돼 있으면 빠진 구독은 해지(`tr_type` 2)하고 새로 생긴 구독은 등록한다."""
        self._replace_subs([KisWsSub(*sub) for sub in subs])

    def _on_frame(self, tr_id: str, count_text: str, payload: str) -> None:
        for record in parse_kis_realtime_payload(tr_id, count_text, payload):
            stream_symbol = to_stream_symbol(record.symbol)
            # 한 건의 콜백이 던져도 나머지 건은 계속 넘긴다.
            try:
                if isinstance(record, KisTradeRecord):
                    if self._on_trade is not None:
                        self._on_trade(stream_symbol, record.last, record.change_pct)
                elif self._on_orderbook is not None:
                    self._on_orderbook(stream_symbol, record.bids, record.asks)
            except Exception:
                logger.warning('[KisPriceWs] 콜백 처리 실패 (symbol=%s)', stream_symbol, exc_info=True)
