"""타입 별칭과 암묵 API 선언(`Entry`). ccxt 의 `ccxt/base/types.py` 와 같은 자리다."""

import types
from typing import Any, Callable, Dict, List, Optional, Union

Str = Optional[str]
Strings = Optional[List[str]]
Int = Optional[int]
Num = Optional[Union[int, float]]
Bool = Optional[bool]
Market = Optional[Dict[str, Any]]
Currency = Optional[Dict[str, Any]]
OrderSide = str
OrderType = str
Ticker = Dict[str, Any]
Tickers = Dict[str, Ticker]
OrderBook = Dict[str, Any]
Order = Dict[str, Any]
Trade = Dict[str, Any]
Balances = Dict[str, Any]
OHLCV = List[Num]
ApiName = Union[str, List[str]]


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
