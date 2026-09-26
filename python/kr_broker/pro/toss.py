"""토스증권 실시간 판. ccxt 의 `ccxt.pro` 처럼 비동기 판 `kr_broker.async_support.toss` 를 상속하고 `watch_*` 를 더한다.
TypeScript 판 `ts/src/toss.ts` 의 `createPriceStream` 과 실시간(ccxt pro) 절을 옮겼다.

.. code-block:: python

    import asyncio
    from kr_broker.pro.toss import toss

    async def main():
        async with toss({'apiKey': CLIENT_ID, 'secret': CLIENT_SECRET}) as broker:
            while True:
                print(await broker.watch_ticker('005930/KRW'))

    asyncio.run(main())

`watch_*` 는 호출마다 다음 갱신을 돌려주고, 처음 부를 때 구독한다. 토스 구독은 선언형이라 구독 목록 전체를 다시 보낸다.
체결 프레임은 가격과 수량만 주므로 `watch_ticker` 의 시세도 현재가뿐이다. `close()` 는 실시간 연결과 HTTP 세션을 함께 닫는다.
"""

from typing import Any, Dict, List, Optional, cast

import kr_broker.async_support
from kr_broker.async_support.base.ws.client import session_connector
from kr_broker.async_support.base.ws.watch_hub import WatchHub
from kr_broker.base.errors import ExchangeClosedByUser
from kr_broker.base.types import Int, Str
from kr_broker.pro.toss_price_ws import OnOrder, OnOrderbook, OnTrade, TossPriceWs, TossWsSub


class toss(kr_broker.async_support.toss):

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self._watch_socket: Optional[TossPriceWs] = None
        self._watch_hub = WatchHub()
        # 구독 키(`trade:kr:005930`, `order:<계좌>`) → 구독
        self._watch_subs: Dict[str, TossWsSub] = {}
        super().__init__(config)

    def describe(self) -> Dict[str, Any]:
        return self.deep_extend(super().describe(), {
            'has': {
                'ws': True,
                'watchTicker': True,
                'watchTrades': True,
                'watchOrderBook': True,
                'watchOrders': True,
            },
        })

    def create_price_stream(self, on_trade: Optional[OnTrade] = None, on_orderbook: Optional[OnOrderbook] = None,
                            on_order: Optional[OnOrder] = None) -> TossPriceWs:
        """실시간 시세·주문 스트림을 만든다. 이 인스턴스의 액세스 토큰(REST 와 같은 토큰)과 HTTP 세션을 쓴다. 구독은 반환값의 `start(subs)` 로 시작한다.

        시세 구독(`{'channel': 'trade' | 'orderbook', 'market', 'symbol'}`)의 `symbol` 은 통합 심볼이 아니라 토스 원본 코드다(미국은 대문자 티커,
        국내는 6자리 숫자). 본인 주문 구독(`{'channel': 'order', 'accountSeq'}`)은 종목이 아니라 계좌 순번을 넣는다. 인증된 호출을 한 번 한 뒤의
        `self.uid` 나 `GET /accounts` 응답에서 얻는다. `on_order` 가 주는 `order` 는 REST 주문 조회와 같은 원본이라, 주문 구조가 필요하면
        `self.parse_order(order)` 를 부른다.
        """
        return TossPriceWs(lambda: self.token_auth().get_access_token(), session_connector(self),
                           on_trade=on_trade, on_orderbook=on_orderbook, on_order=on_order)

    # ============ 실시간(ccxt pro) ============

    def _watch_subscribe(self, key: str, sub: TossWsSub) -> None:
        """구독을 더한다. 연결 작업이 돌고 있지 않으면(처음이거나 앞선 이벤트 루프가 끝났으면) 띄우고, 돌고 있으면 새 구독일 때 전체 구독을
        다시 선언한다."""
        added = key not in self._watch_subs
        self._watch_subs[key] = sub
        if self._watch_socket is None:
            self._watch_socket = self.create_price_stream(on_trade=self._watch_on_trade, on_orderbook=self._watch_on_orderbook,
                                                          on_order=self._watch_on_order)
        if not self._watch_socket.running:
            self._watch_socket.start(list(self._watch_subs.values()))
        elif added:
            self._watch_socket.update_subs(list(self._watch_subs.values()))

    def _watch_on_trade(self, market: str, code: str, price: float, volume: float, timestamp: Optional[int]) -> None:
        symbol = self._watch_symbol_of(market, code)
        stamp = self.ms_stamp(timestamp if timestamp is not None else self.milliseconds())
        self._watch_hub.resolve(f'ticker:{symbol}', self.safe_ticker({
            'symbol': symbol, **stamp, 'last': price, 'info': {'market': market, 'symbol': code, 'price': price, 'volume': volume},
        }))
        self._watch_hub.push(f'trades:{symbol}', self.safe_trade({
            'symbol': symbol, **stamp, 'price': price, 'amount': volume, 'info': {'market': market, 'symbol': code, 'price': price, 'volume': volume},
        }))

    def _watch_on_orderbook(self, market: str, code: str, bids: List[List[float]], asks: List[List[float]], timestamp: Optional[int]) -> None:
        symbol = self._watch_symbol_of(market, code)
        stamp = self.ms_stamp(timestamp if timestamp is not None else self.milliseconds())
        self._watch_hub.resolve(f'orderbook:{symbol}', self.safe_order_book({
            'symbol': symbol, 'timestamp': stamp['timestamp'], 'datetime': stamp['datetime'], 'bids': bids, 'asks': asks,
        }))

    def _watch_on_order(self, account_seq: str, event: str, order: Dict[str, Any]) -> None:
        parsed = self.parse_order(order)
        self._watch_hub.push('orders', parsed)
        if parsed.get('symbol') is not None:
            self._watch_hub.push(f"orders:{parsed['symbol']}", parsed)

    def _watch_symbol_of(self, market: str, code: str) -> str:
        """토스 원본 코드 → 통합 심볼. 종목 목록에 없으면 `commonStockCodes` 를 거친 코드에 시장의 통화를 붙인다."""
        candidates = (self.markets_by_id or {}).get(code) or []
        known = candidates[0].get('symbol') if candidates else None
        return known if known is not None else f"{self.common_stock_code(code)}/{'USD' if market == 'us' else 'KRW'}"

    def _watch_market_sub(self, channel: str, symbol: str) -> str:
        market = self.market(symbol)
        country = 'us' if self._country_of(market) == 'US' else 'kr'
        code = cast(str, market['id'])
        self._watch_subscribe(f'{channel}:{country}:{code}', {'channel': channel, 'market': country, 'symbol': code})
        return market['symbol']

    async def watch_ticker(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """다음 시세. 체결 프레임으로 만들어 현재가만 채운다."""
        return await self._watch_hub.next(f"ticker:{self._watch_market_sub('trade', symbol)}")

    async def watch_trades(self, symbol: str, since: Int = None, limit: Int = None, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """새 체결. 지난 호출 뒤로 받은 체결을 한꺼번에 돌려준다."""
        trades = await self._watch_hub.next_batch(f"trades:{self._watch_market_sub('trade', symbol)}")
        return self.filter_by_since_limit(trades, since, limit, 'timestamp', True)

    async def watch_order_book(self, symbol: str, limit: Int = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """다음 호가. 토스는 구독 직후 스냅샷을 보내지 않는다. 첫 값은 다음 호가 변경 때 온다."""
        book = await self._watch_hub.next(f"orderbook:{self._watch_market_sub('orderbook', symbol)}")
        return book if limit is None else {**book, 'bids': book['bids'][:limit], 'asks': book['asks'][:limit]}

    async def watch_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                           params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """본인 주문 변화. 계좌 순번(`accountSeq`)이 없으면 계좌 조회로 먼저 얻는다. 주문은 REST 주문 조회와 같은 원본을 `parse_order` 로 옮긴다."""
        if self.uid is None:
            await self.load_account_seq()
        account_seq = str(self.uid)
        self._watch_subscribe(f'order:{account_seq}', {'channel': 'order', 'accountSeq': account_seq})
        orders = await self._watch_hub.next_batch('orders' if symbol is None else f"orders:{self.market(symbol)['symbol']}")
        return self.filter_by_since_limit(orders, since, limit, 'timestamp', True)

    async def close(self) -> None:
        """실시간 연결을 닫고 기다리던 `watch_*` 를 거절한 뒤 HTTP 세션을 닫는다."""
        socket, self._watch_socket = self._watch_socket, None
        if socket is not None:
            await socket.stop()
        self._watch_subs.clear()
        self._watch_hub.reject(ExchangeClosedByUser(f'{self.id} 실시간 연결을 닫았다'))
        await super().close()
