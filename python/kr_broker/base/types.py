"""타입 별칭, 통합 구조와 암묵 API 선언(`Entry`). ccxt 의 `ccxt/base/types.py` 와 같은 자리다.

통합 구조(`Order`, `Trade`, `Ticker` 등)는 ccxt 처럼 `TypedDict` 이고 필드는 TypeScript 판 `ts/src/base/types.ts` 와 같다. 실행 중에는
보통의 `dict` 다. 값이 없으면 키를 두고 `None` 을 넣으므로 필드는 대부분 필수 키다. 키가 빠질 수 있는 필드만 선택 키이고, Python 3.10 의
`typing` 에는 `NotRequired` 가 없어 `total=False` 부모 클래스에 둔다.
"""

import types
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Literal, Optional, TypedDict, Union, overload

Str = Optional[str]
Strings = Optional[List[str]]
Int = Optional[int]
# ccxt 처럼 숫자 인자에 `Decimal` 도 받는다. 주문 메서드가 입구에서 `float` 로 바꾼다.
Num = Optional[Union[int, float, Decimal]]
# 통합 구조의 숫자. 결과는 `float` 로 바꿔 돌려주므로 `Decimal` 을 넣지 않는다.
Float = Optional[float]
Bool = Optional[bool]
Currency = Optional[Dict[str, Any]]
OrderSide = str
OrderType = str
OHLCV = List[Num]
ApiName = Union[str, List[str]]


class MinMax(TypedDict):
    min: Float
    max: Float


class _PrecisionOptional(TypedDict, total=False):
    cost: Float
    base: Float
    quote: Float


class Precision(_PrecisionOptional):
    """수량·가격·금액의 최소 단위. 뜻은 `Exchange.precisionMode` 를 따른다(기본은 호가 단위)."""

    amount: Float
    price: Float


class _MarketLimitsOptional(TypedDict, total=False):
    market: MinMax


class MarketLimits(_MarketLimitsOptional):
    amount: MinMax
    cost: MinMax
    leverage: MinMax
    price: MinMax


class _MarketOptional(TypedDict, total=False):
    percentage: Bool
    tierBased: Bool
    feeSide: Str
    # 종목별 옵션. 증권사 클래스가 시장 구분 같은 값을 싣는다.
    options: Dict[str, Any]


class MarketInterface(_MarketOptional):
    """종목. `symbol` 은 `005930/KRW`, `AAPL/USD` 이고, 시장 구분 같은 증권사 고유 값은 `info` 와 `options` 에 있다."""

    id: Str
    lowercaseId: Str
    symbol: str
    base: str
    quote: str
    baseId: Str
    quoteId: Str
    active: Bool
    type: Str
    subType: Str
    spot: Bool
    margin: Bool
    swap: Bool
    future: Bool
    option: Bool
    index: Bool
    contract: Bool
    settle: Str
    settleId: Str
    contractSize: Float
    linear: Bool
    inverse: Bool
    expiry: Int
    expiryDatetime: Str
    strike: Float
    optionType: Str
    taker: Float
    maker: Float
    precision: Precision
    limits: MarketLimits
    created: Int
    info: Any


Market = Optional[MarketInterface]


class Ticker(TypedDict):
    symbol: Str
    info: Any
    timestamp: Int
    datetime: Str
    high: Float
    low: Float
    bid: Float
    bidVolume: Float
    ask: Float
    askVolume: Float
    vwap: Float
    open: Float
    close: Float
    last: Float
    previousClose: Float
    change: Float
    percentage: Float
    average: Float
    quoteVolume: Float
    baseVolume: Float
    indexPrice: Float
    markPrice: Float


Tickers = Dict[str, Ticker]


class OrderBook(TypedDict):
    """호가. `[가격, 수량]` 쌍이고 매수는 가격 내림차순, 매도는 오름차순이다."""

    asks: List[List[Float]]
    bids: List[List[Float]]
    datetime: Str
    timestamp: Int
    nonce: Int
    symbol: Str


class _FeeOptional(TypedDict, total=False):
    rate: Float


class Fee(_FeeOptional):
    currency: Str
    cost: Float


class Trade(TypedDict):
    info: Any
    amount: Float
    datetime: Str
    id: Str
    order: Str
    price: Float
    timestamp: Int
    type: Str
    side: Str
    symbol: Str
    takerOrMaker: Str
    cost: Float
    fee: Fee
    fees: List[Fee]


class Order(TypedDict):
    id: Str
    clientOrderId: Str
    datetime: Str
    timestamp: Int
    lastTradeTimestamp: Int
    lastUpdateTimestamp: Int
    # `open`·`closed`·`canceled`·`expired`·`rejected`
    status: Str
    symbol: Str
    type: Str
    timeInForce: Str
    side: Str
    price: Float
    average: Float
    amount: Float
    filled: Float
    remaining: Float
    stopPrice: Float
    triggerPrice: Float
    takeProfitPrice: Float
    stopLossPrice: Float
    cost: Float
    trades: List[Trade]
    # 수수료를 알 수 없으면 `None`
    fee: Optional[Fee]
    fees: List[Fee]
    reduceOnly: Bool
    postOnly: Bool
    info: Any


class _BalanceOptional(TypedDict, total=False):
    debt: Float


class Balance(_BalanceOptional):
    """통화나 보유 종목 하나의 잔고. 종목이면 `total` 이 보유 수량이고, 평균 단가 같은 증권사 고유 값은 `info` 에 있다."""

    free: Float
    used: Float
    total: Float
    info: Any


class Balances(Dict[str, Any]):
    """통화(`KRW`, `USD`)나 보유 종목 코드(`005930`)로 색인한 `Balance` 사전. 같은 값을 `free`·`used`·`total`(·`debt`) 사전으로도 담고,
    `info` 에 응답 원본을 둔다. ccxt 처럼 `dict` 를 상속해 적은 타입이며, `fetch_balance` 는 보통의 `dict` 를 돌려준다."""

    if TYPE_CHECKING:
        @overload
        def __getitem__(self, key: Literal['info']) -> Any: ...
        @overload
        def __getitem__(self, key: Literal['timestamp']) -> Int: ...
        @overload
        def __getitem__(self, key: Literal['datetime']) -> Str: ...
        @overload
        def __getitem__(self, key: Literal['free', 'used', 'total', 'debt']) -> Dict[str, Float]: ...
        @overload
        def __getitem__(self, key: str) -> Balance: ...
        def __getitem__(self, key: str) -> Any: ...


class TradingFeeInterface(TypedDict):
    info: Any
    symbol: Str
    maker: Float
    taker: Float
    percentage: Bool
    tierBased: Bool


class Entry:
    """생성된 암묵 API 엔드포인트 하나. 클래스 속성으로 두면 인스턴스 메서드처럼 불린다.

    `abstract/<증권사>.py` 에 `private_get_foo = privateGetFoo = Entry('foo', 'private', 'GET', {'cost': 1})` 처럼 쓰이고,
    `broker.private_get_foo({'a': 1})` 은 `broker.request('foo', 'private', 'GET', {'a': 1}, config={'cost': 1})` 가 된다.
    """

    def __init__(self, path: str, api: ApiName, method: str, config: Dict[str, Any]) -> None:
        self.name: Optional[str] = None
        self.path = path
        self.api = api
        self.method = method
        self.config = config

        def unbound_method(_self: Any, params: Optional[Dict[str, Any]] = None) -> Any:
            return _self.request(self.path, self.api, self.method, {} if params is None else params, config=self.config)

        self.unbound_method = unbound_method

    def __get__(self, instance: Any, owner: Any) -> Callable[..., Any]:
        if instance is None:
            return self.unbound_method
        return types.MethodType(self.unbound_method, instance)

    def __set_name__(self, owner: Any, name: str) -> None:
        self.name = name
