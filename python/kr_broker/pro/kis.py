"""한국투자증권 실시간 판. ccxt 의 `ccxt.pro` 처럼 비동기 판 `kis` 를 상속하고 `watch_*` 를 더한다. TypeScript 판 `ts/src/kis.ts` 의 실시간 부분을
옮겼다.

.. code-block:: python

    import asyncio
    from kr_broker.pro.kis import kis

    async def main():
        broker = kis({'apiKey': APP_KEY, 'secret': APP_SECRET, 'uid': '12345678-01'})
        try:
            while True:
                print(await broker.watch_ticker('005930/KRW'))
        finally:
            await broker.close()

    asyncio.run(main())

`watch_*` 는 호출마다 다음 갱신을 돌려주고, 처음 부를 때 구독한다. 체결과 주문은 기다리는 쪽이 없을 때 쌓아 두었다가 다음 호출에 한꺼번에
돌려준다. 같은 앱키와 접속키로 다른 프로그램이 이미 연결돼 있으면 KIS 가 이 연결을 곧바로 끊는다(2026-09-24 실측).
"""

from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Set

import kr_broker.async_support
from kr_broker.async_support.base.ws.client import session_connector
from kr_broker.async_support.base.ws.watch_hub import WatchHub
from kr_broker.async_support.kis import _tpl
from kr_broker.base import functions as fn
from kr_broker.base.errors import ArgumentsRequired, BadSymbol, ExchangeClosedByUser, ExchangeError
from kr_broker.base.precise import Precise
from kr_broker.base.types import Int, Str
from kr_broker.broker_time import kst_ymd
from kr_broker.kis_types import KIS_WS_PATH
from kr_broker.pro.kis_price_ws import KisPriceWs, OnOrderbook, OnSubscribeError, OnTrade
from kr_broker.pro.kis_realtime_stream import KisRealtimeRecord, KisRealtimeStream


class kis(kr_broker.async_support.kis):

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self._watch_stream: Optional[KisRealtimeStream] = None
        self._watch_hub = WatchHub()
        # 구독 키(`005930`, `DNASAAPL`) → 통합 심볼
        self._watch_keys: Dict[str, str] = {}
        # 체결통보로 쌓은 주문 상태(주문번호 → 주문). 통보는 한 건씩 오므로 누적 체결 수량을 여기서 더한다
        self._watch_order_state: Dict[str, Any] = {}
        # 원주문에 반영한 정정·취소 통보의 주문번호. 같은 번호로 통보가 다시 와도 한 번만 반영한다
        self._watch_revision_ids: Set[str] = set()
        # `watch_orders` 가 기다리는 해시(`orders`, `orders:<심볼>`). 체결통보 구독이 거부되면 모두 거절한다
        self._watch_order_hashes: Set[str] = {'orders'}
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
                            on_subscribe_error: Optional[OnSubscribeError] = None) -> KisPriceWs:
        """실시간 시세 스트림을 만든다. 이 인스턴스의 접속키와 모의 여부를 쓴다. 구독은 반환값의 `start(subs)` 로 시작한다."""
        return KisPriceWs(self.get_approval_key, self.isSandboxModeEnabled, session_connector(self), on_trade, on_orderbook, url=self._realtime_url(),
                          on_subscribe_error=on_subscribe_error, common_stock_codes=self.commonStockCodes)

    def create_realtime_stream(self, on_record: Callable[[KisRealtimeRecord], None],
                               on_subscribe_error: Optional[Callable[[str, str, str], None]] = None) -> KisRealtimeStream:
        """범용 실시간 구독. 어떤 실시간 TR 이든 `subscribe(tr_id, tr_key)` 로 구독하고 `unsubscribe` 로 해지한다. 받은 값은 공식 예제의 필드
        순서로 이름을 붙여 원문 문자열 그대로 `on_record` 에 넘긴다. 체결통보 TR 의 구독 키는 HTS ID 이고, 모의투자 체결통보는 `H0STCNI9`,
        `H0GSCNI9` 다. 체결과 호가를 가격으로만 받으려면 `create_price_stream` 을 쓴다."""
        return KisRealtimeStream(self.get_approval_key, self.isSandboxModeEnabled, session_connector(self), on_record, on_subscribe_error,
                                 url=self._realtime_url())

    def _realtime_url(self) -> Optional[str]:
        """실시간 접속 주소. `urls['ws']`(모의는 `urls['wsTest']`)의 `public` 에 경로를 붙인다. 사용하는 쪽이 `urls` 로 바꿀 수 있다."""
        base = self.safe_string(self.urls.get('wsTest' if self.isSandboxModeEnabled else 'ws'), 'public')
        return None if base is None else base + KIS_WS_PATH

    # ============ 실시간(ccxt pro) ============

    def _ensure_watch_stream(self) -> KisRealtimeStream:
        if self._watch_stream is None:
            self._watch_stream = self.create_realtime_stream(self._on_watch_record, self._on_watch_subscribe_error)
        return self._watch_stream

    def _on_watch_subscribe_error(self, tr_id: str, tr_key: str, message: str) -> None:
        symbol = self._watch_keys.get(tr_key)
        hashes = sorted(self._watch_order_hashes) if symbol is None else [f'ticker:{symbol}', f'trades:{symbol}', f'orderbook:{symbol}']
        self._watch_hub.reject(ExchangeError(f'{self.id} 실시간 구독이 거부됐다 {tr_id} {tr_key}: {message}'), hashes)

    async def _watch_subscribe(self, symbol: str, kind: str) -> str:
        """종목의 체결(`trade`)이나 호가(`book`) TR 을 구독하고 통합 심볼을 돌려준다. 국내는 NXT 통합 시세를 쓸 때 통합 TR 이다."""
        instrument = self._instrument_of(symbol)
        if instrument.overseas:
            if instrument.quote_exchange is None:
                raise BadSymbol(f'{self.id} 실시간 구독에 쓸 해외 거래소를 모른다: {symbol}')
            tr_id = 'HDFSCNT0' if kind == 'trade' else 'HDFSASP0'
            key = f'D{instrument.quote_exchange}{instrument.code}'
        else:
            integrated = (await self._quote_market_division()) == 'UN'
            tr_id = ('H0UNCNT0' if integrated else 'H0STCNT0') if kind == 'trade' else ('H0UNASP0' if integrated else 'H0STASP0')
            key = instrument.code
        self._watch_keys[key] = instrument.symbol
        self._ensure_watch_stream().subscribe(tr_id, key)
        return instrument.symbol

    async def watch_ticker(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """다음 시세. 국내는 체결 TR 이 시가, 고가, 저가, 누적거래량까지 준다. 해외는 지연체결가(`HDFSCNT0`)다."""
        return await self._watch_hub.next(f"ticker:{await self._watch_subscribe(symbol, 'trade')}")

    async def watch_trades(self, symbol: str, since: Int = None, limit: Int = None, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """새 체결. 지난 호출 뒤로 받은 체결을 한꺼번에 돌려준다."""
        trades = await self._watch_hub.next_batch(f"trades:{await self._watch_subscribe(symbol, 'trade')}")
        return self.filter_by_since_limit(trades, since, limit, 'timestamp', True)

    async def watch_order_book(self, symbol: str, limit: Int = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """다음 호가. 국내는 10단계, 해외 지연호가는 1단계다."""
        book = await self._watch_hub.next(f"orderbook:{await self._watch_subscribe(symbol, 'book')}")
        return book if limit is None else {**book, 'bids': book['bids'][:limit], 'asks': book['asks'][:limit]}

    async def watch_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                           params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """주문 변화(체결통보). 국내(`H0STCNI0`)와 해외(`H0GSCNI0`) 체결통보를 구독한다. 모의투자는 `H0STCNI9`, `H0GSCNI9` 다. 구독 키가
        HTS ID 라 `options['htsId']` 가 필요하다. 통보 필드 해석은 공식 예제의 설명을 따랐고 실계좌로는 확인하지 못했다."""
        hts_id = self._hts_id('watchOrders')
        stream = self._ensure_watch_stream()
        stream.subscribe('H0STCNI9' if self.isSandboxModeEnabled else 'H0STCNI0', hts_id)
        stream.subscribe('H0GSCNI9' if self.isSandboxModeEnabled else 'H0GSCNI0', hts_id)
        hash = 'orders' if symbol is None else f'orders:{self._instrument_of(symbol).symbol}'
        self._watch_order_hashes.add(hash)
        orders = await self._watch_hub.next_batch(hash)
        return self.filter_by_since_limit(orders, since, limit, 'timestamp', True)

    async def close(self) -> None:
        """실시간 연결을 닫고 기다리던 `watch_*` 를 거절한 뒤 HTTP 세션을 닫는다."""
        stream, self._watch_stream = self._watch_stream, None
        if stream is not None:
            await stream.stop()
        self._watch_keys.clear()
        self._watch_order_state.clear()
        self._watch_revision_ids.clear()
        self._watch_hub.reject(ExchangeClosedByUser(f'{self.id} 실시간 연결을 닫았다'))
        await super().close()

    def _on_watch_record(self, record: KisRealtimeRecord) -> None:
        f = record.fields
        if f is None:
            return

        def num(key: str) -> Optional[float]:
            return self.safe_number(f, key)

        def or_zero(value: Optional[float]) -> float:
            return 0 if value is None else value

        tr_id = record.tr_id
        if tr_id in ('H0STCNT0', 'H0UNCNT0'):
            symbol = self._watch_symbol(f.get('mksc_shrn_iscd'), f"{_tpl(f.get('mksc_shrn_iscd'))}/KRW")
            stamp = self.kst_stamp(f.get('bsop_date'), f.get('stck_cntg_hour'))
            # 체결구분은 1 매수, 5 매도다(KRX 는 `ccld_dvsn`, 통합은 `cntg_cls_code`).
            side_code = f.get('ccld_dvsn') if f.get('ccld_dvsn') is not None else f.get('cntg_cls_code')
            self._watch_hub.resolve(f'ticker:{symbol}', self.safe_ticker({
                'symbol': symbol, **stamp, 'last': num('stck_prpr'), 'open': num('stck_oprc'), 'high': num('stck_hgpr'), 'low': num('stck_lwpr'),
                'bid': num('bidp1'), 'ask': num('askp1'), 'bidVolume': num('bidp_rsqn1'), 'askVolume': num('askp_rsqn1'), 'change': num('prdy_vrss'),
                'percentage': num('prdy_ctrt'), 'vwap': num('wghn_avrg_stck_prc'), 'baseVolume': num('acml_vol'), 'quoteVolume': num('acml_tr_pbmn'),
                'info': f,
            }))
            self._watch_hub.push(f'trades:{symbol}', self.safe_trade({
                'symbol': symbol, **stamp, 'price': num('stck_prpr'), 'amount': num('cntg_vol'),
                'side': 'buy' if side_code == '1' else 'sell' if side_code == '5' else None, 'info': f,
            }))
            return
        if tr_id in ('H0STASP0', 'H0UNASP0'):
            symbol = self._watch_symbol(f.get('mksc_shrn_iscd'), f"{_tpl(f.get('mksc_shrn_iscd'))}/KRW")

            def levels(price: str, size: str) -> List[List[float]]:
                pairs = [[or_zero(num(f'{price}{i + 1}')), or_zero(num(f'{size}{i + 1}'))] for i in range(10)]
                return [pair for pair in pairs if pair[0] > 0]

            # 호가 프레임에는 일자가 없다. 방금 받은 호가라 오늘(한국 날짜)이다.
            stamp = self.kst_stamp(kst_ymd(self.milliseconds()), f.get('bsop_hour'))
            self._watch_hub.resolve(f'orderbook:{symbol}', self.safe_order_book({
                'symbol': symbol, 'timestamp': stamp['timestamp'], 'datetime': stamp['datetime'],
                'bids': levels('bidp', 'bidp_rsqn'), 'asks': levels('askp', 'askp_rsqn'),
            }))
            return
        if tr_id == 'HDFSCNT0':
            symbol = self._watch_symbol(f.get('rsym'), f"{self.common_stock_code(_tpl(f.get('symb')))}/USD")
            # 해외 체결에는 현지 일시(`xymd`, `xhms`)와 한국 일시(`kymd`, `khms`)가 함께 온다.
            stamp = self.kst_stamp(f.get('kymd'), f.get('khms'))
            self._watch_hub.resolve(f'ticker:{symbol}', self.safe_ticker({
                'symbol': symbol, **stamp, 'last': num('last'), 'open': num('open'), 'high': num('high'), 'low': num('low'), 'bid': num('pbid'),
                'ask': num('pask'), 'bidVolume': num('vbid'), 'askVolume': num('vask'), 'change': num('diff'), 'percentage': num('rate'),
                'baseVolume': num('tvol'), 'quoteVolume': num('tamt'), 'info': f,
            }))
            self._watch_hub.push(f'trades:{symbol}', self.safe_trade({'symbol': symbol, **stamp, 'price': num('last'), 'amount': num('evol'), 'info': f}))
            return
        if tr_id == 'HDFSASP0':
            symbol = self._watch_symbol(f.get('rsym'), f"{self.common_stock_code(_tpl(f.get('symb')))}/USD")
            stamp = self.kst_stamp(f.get('kymd'), f.get('khms'))
            bid = num('pbid1')
            ask = num('pask1')
            self._watch_hub.resolve(f'orderbook:{symbol}', self.safe_order_book({
                'symbol': symbol, 'timestamp': stamp['timestamp'], 'datetime': stamp['datetime'],
                'bids': [[bid, or_zero(num('vbid1'))]] if bid is not None and bid > 0 else [],
                'asks': [[ask, or_zero(num('vask1'))]] if ask is not None and ask > 0 else [],
            }))
            return
        if tr_id in ('H0STCNI0', 'H0STCNI9', 'H0GSCNI0', 'H0GSCNI9'):
            self._on_order_notice(tr_id, f)

    def _watch_symbol(self, key: Optional[str], fallback: str) -> str:
        """구독 키로 기억한 통합 심볼. 모르는 키면 `fallback` 이다."""
        symbol = None if key is None else self._watch_keys.get(key)
        return fallback if symbol is None else symbol

    def _on_order_notice(self, tr_id: str, f: Dict[str, str]) -> None:
        """체결통보 한 건을 주문으로 쌓는다. 체결여부(`cntg_yn`) 2 가 체결 통보이고 1 은 접수·정정·취소·거부 통보다. 매도매수구분은 01 매도,
        02 매수, 정정구분(`rctf_cls`)은 1 정정, 2 취소이고 거부여부(`rfus_yn`)는 1 이 거부다. 체결수량(`cntg_qty`)과 체결단가(`cntg_unpr`) 자리에는
        체결 통보면 체결 값이, 접수 통보면 주문(정정, 취소) 수량과 단가가 온다(공식 예제의 필드 설명)."""
        order_id = f.get('oder_no')
        if not order_id:
            return
        overseas = tr_id.startswith('H0GS')
        code = f.get('stck_shrn_iscd')
        code = '' if code is None else code
        symbol = self._instrument_of(code).symbol if overseas else f'{code}/KRW'
        stamp = self.kst_stamp(kst_ymd(self.milliseconds()), f.get('stck_cntg_hour'))

        def positive(key: str) -> Optional[float]:
            value = self.safe_number(f, key)
            return value if value is not None and value > 0 else None

        executed = f.get('cntg_yn') == '2'
        rejected = f.get('rfus_yn') == '1'
        quantity = positive('cntg_qty')
        # 해외 체결단가는 소수점 없이 오면 미국 종목 기준 소수 넷째 자리까지다(공식 예제: 001480100 은 148.01).
        raw_price = f.get('cntg_unpr')
        unit_price = None if not raw_price else Precise.string_div(raw_price, '10000') if overseas and '.' not in raw_price else raw_price
        # 정정·취소 통보의 `ooder_no` 는 원주문번호로 본다(필드 이름과 공식 예제 설명에 기댄 추정이다).
        original = f.get('ooder_no') if not executed and not rejected and f.get('rctf_cls') in ('1', '2') and f.get('ooder_no') else None
        if original is not None:
            if order_id not in self._watch_revision_ids:
                self._watch_revision_ids.add(order_id)
                self._reduce_watch_order(original, quantity if quantity is not None else positive('oder_qty'), symbol, stamp, f)
            # 취소 통보의 주문번호는 취소 요청의 번호라 주문으로 쌓지 않는다. 정정 통보의 주문번호는 새 주문이다.
            if f.get('rctf_cls') == '2':
                return
        previous = self._watch_order_state.get(order_id)
        fill = (quantity or 0) if executed else 0
        amount = positive('oder_qty')
        if amount is None and not executed:
            amount = quantity
        if amount is None and previous is not None:
            amount = previous.get('amount')
        previous_filled = (previous.get('filled') if previous is not None else None) or 0
        filled = previous_filled + fill
        before = None if previous is None else previous.get('remaining')
        if before is None and amount is not None:
            before = amount - previous_filled
        remaining = None if before is None else max(before - fill, 0)
        # 체결 금액은 체결 통보의 체결단가로 쌓는다. 앞선 체결의 금액을 모르면 쌓지 않는다.
        previous_cost = '0' if previous_filled == 0 else None if previous is None or previous.get('cost') is None else fn.number_to_string(previous['cost'])
        if fill == 0:
            cost = previous_cost
        elif previous_cost is None or unit_price is None:
            cost = None
        else:
            cost = Precise.string_add(previous_cost, Precise.string_mul(fn.number_to_string(fill), unit_price))
        if rejected:
            status = 'rejected'
        elif f.get('rctf_cls') == '2':
            status = 'canceled'
        else:
            status = 'closed' if remaining is not None and remaining <= 0 else 'open'
        price = self.safe_number(f, 'oder_prc')
        if price is None and not executed:
            price = fn.parse_number(unit_price)
        if price is None and previous is not None:
            price = previous.get('price')
        seln_byov_cls = f.get('seln_byov_cls')
        order = self.safe_order({
            'id': order_id, 'symbol': symbol, **stamp, 'side': 'sell' if seln_byov_cls == '01' else 'buy' if seln_byov_cls == '02' else None,
            'amount': amount, 'filled': filled, 'remaining': remaining, 'cost': cost, 'price': price, 'status': status,
            'lastTradeTimestamp': stamp['timestamp'] if fill > 0 else None if previous is None else previous.get('lastTradeTimestamp'),
            'trades': [], 'info': f,
        })
        self._watch_order_state[order_id] = order
        self._watch_hub.push('orders', order)
        self._watch_hub.push(f'orders:{symbol}', order)

    def _reduce_watch_order(self, order_id: str, quantity: Optional[float], symbol: str, stamp: Dict[str, Any], f: Dict[str, str]) -> None:
        """정정·취소 통보를 원주문에 반영한다. 정정·취소 수량만큼 잔량을 줄이고, 잔량이 남지 않으면 `canceled` 다(정정한 수량은 새 주문번호로
        옮겨 간다). 줄일 수량이나 원주문의 잔량을 모르면 잔량을 모두 줄인 것으로 본다."""
        previous = self._watch_order_state.get(order_id) or {}
        before = previous.get('remaining')
        if before is None and previous.get('amount') is not None:
            before = previous['amount'] - (previous.get('filled') or 0)
        remaining = 0 if before is None or quantity is None else max(before - quantity, 0)
        seln_byov_cls = f.get('seln_byov_cls')
        side = previous.get('side')
        if side is None:
            side = 'sell' if seln_byov_cls == '01' else 'buy' if seln_byov_cls == '02' else None
        order = self.safe_order({
            'id': order_id, 'symbol': previous.get('symbol') or symbol, **stamp, 'side': side, 'amount': previous.get('amount'),
            'filled': previous.get('filled'), 'remaining': remaining, 'cost': previous.get('cost'), 'price': previous.get('price'),
            'status': 'open' if remaining > 0 else 'canceled', 'lastTradeTimestamp': previous.get('lastTradeTimestamp'), 'trades': [], 'info': f,
        })
        self._watch_order_state[order_id] = order
        self._watch_hub.push('orders', order)
        self._watch_hub.push(f"orders:{order['symbol']}", order)

    def _hts_id(self, method: str) -> str:
        """HTS 사용자 ID(`options['htsId']`). 체결통보 구독 키라 없으면 구독하기 전에 `ArgumentsRequired` 다."""
        hts_id = self.safe_string(self.options, 'htsId')
        if not hts_id:
            raise ArgumentsRequired(f'{self.id} {method}() 는 options.htsId(HTS 사용자 ID)가 필요하다')
        return hts_id

    # 생성자가 붙이는 camelCase 별칭을 타입 검사기에 알린다. 빠지거나 남는 줄은 test_base.py 가 잡는다.
    if TYPE_CHECKING:
        createPriceStream = create_price_stream
        createRealtimeStream = create_realtime_stream
        watchTicker = watch_ticker
        watchTrades = watch_trades
        watchOrderBook = watch_order_book
        watchOrders = watch_orders
