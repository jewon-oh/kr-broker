"""비동기 증권사 클래스의 부모 클래스. ccxt 의 `ccxt/async_support/base/exchange.py` 처럼 동기 판 `Exchange` 를 상속하고,
I/O 에 닿는 메서드(요청 경로, `load_markets`, 통합 메서드의 기본 구현, `close`)만 코루틴으로 다시 정의한다.
응답 해석, 정밀도, `safe_*` 같은 순수 메서드는 동기 판의 것을 그대로 쓴다.

HTTP 는 aiohttp 로 보낸다. 세션은 처음 요청할 때 열리고, 다 쓴 뒤에는 `await broker.close()` 로 닫는다.
`async with kr_broker.async_support.kis(config) as broker:` 로 쓰면 블록을 나갈 때 닫힌다.
설정에 `session` 을 넣으면 그 세션을 쓰고 `close()` 가 닫지 않는다.

요청 경로(`fetch2`)는 동기 판과 같은 순서로 쓴다. 한쪽을 고치면 다른 쪽도 고친다.
"""

import asyncio
import logging
from typing import Any, Callable, Dict, List, Optional, Set

import aiohttp

from kr_broker.async_support.base.runtime import maybe_await
from kr_broker.async_support.base.throttler import Throttler
from kr_broker.base import functions as fn
from kr_broker.base.errors import (
    BaseError, ExchangeError, NetworkError, NotSupported, NullResponse, OperationFailed, OrderOutcomeUnknown, RequestTimeout,
)
from kr_broker.base.exchange import Exchange as BaseExchange, assert_secure_url, redact_body_for_log, redact_headers_for_log
from kr_broker.base.types import ApiName, Int, Num, Str, Strings

logger = logging.getLogger('kr_broker')

# `close()` 가 `spawn` 으로 띄운 작업(토큰 저장소 정리 등)을 기다리는 상한(초). 저장소가 응답하지 않아도 세션은 닫힌다.
CLOSE_WAIT_SECONDS = 5.0


class HttpResponse:
    """aiohttp 응답을 다 읽은 뒤 동기 판 `requests.Response` 와 같은 이름의 속성으로 담는다. `handle_rest_response` 가 이 속성만 읽는다."""

    def __init__(self, status_code: int, reason: str, headers: Any, encoding: Optional[str], content: bytes) -> None:
        self.status_code = status_code
        self.reason = reason
        self.headers = headers
        self.encoding = encoding
        self.content = content


class Exchange(BaseExchange):
    synchronous = False
    # 환경 변수의 프록시 설정(HTTP_PROXY 등)을 따를지. ccxt 와 같은 이름이다.
    aiohttp_trust_env = False

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        # `load_markets` 가 진행 중이면 그 태스크. 동시에 부른 쪽이 함께 기다린다.
        self._markets_loading: Optional['asyncio.Task[Dict[str, Any]]'] = None
        # `spawn` 으로 띄운 태스크. 참조를 쥐고 있어야 끝나기 전에 가비지 컬렉션으로 사라지지 않는다.
        self._background_tasks: Set['asyncio.Task[Any]'] = set()
        # `open()` 이 연 세션의 이벤트 루프. 세션은 이 루프에서만 쓸 수 있다. 지금 세션을 `open()` 이 열지 않았으면 None 이다.
        self._session_loop: Optional[asyncio.AbstractEventLoop] = None
        super().__init__(config)

    @staticmethod
    async def sleep(milliseconds: float) -> None:  # type: ignore[override]
        await asyncio.sleep(milliseconds / 1000)

    # ============ 세션 ============

    def open(self) -> None:
        """HTTP 세션이 없으면 연다. 실행 중인 이벤트 루프 안에서 불러야 한다.
        직접 연 세션이 닫혔거나 다른 이벤트 루프에서 열렸으면 새로 열고, 옛 세션은 이 루프에서 닫는다. 설정으로 넘긴 세션은 그대로 쓴다."""
        loop = asyncio.get_running_loop()
        session = self.session
        if session is not None and self._session_loop is not None and (session.closed or self._session_loop is not loop):
            self.session = None
            if not session.closed:
                self.spawn(session.close)
        if self.session is None:
            self.session = aiohttp.ClientSession(trust_env=self.aiohttp_trust_env)
            self.own_session = True
            self._session_loop = loop

    async def close(self) -> None:  # type: ignore[override]
        """`spawn` 으로 띄운 작업을 `CLOSE_WAIT_SECONDS` 까지 기다린 뒤 이 인스턴스가 연 HTTP 세션을 닫는다. 그때까지 안 끝난 작업은 취소한다."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + CLOSE_WAIT_SECONDS
        while self._background_tasks:
            remaining = deadline - loop.time()
            if remaining <= 0:
                pending = list(self._background_tasks)
                logger.warning('%s close(): 끝나지 않은 백그라운드 작업 %d개를 취소한다', self.id, len(pending))
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                break
            await asyncio.wait(list(self._background_tasks), timeout=remaining)
        if self.session is not None and self.own_session:
            await self.session.close()
            self.session = None
            self._session_loop = None

    async def __aenter__(self) -> 'Exchange':
        self.open()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    def spawn(self, method: Callable[..., Any], *args: Any) -> 'asyncio.Task[Any]':  # type: ignore[override]
        """`method(*args)` 코루틴을 기다리지 않는 태스크로 띄운다. 실행 중인 이벤트 루프 안에서 불러야 한다. 던진 오류는 로그만 남긴다."""
        task = asyncio.ensure_future(method(*args))
        self._background_tasks.add(task)
        task.add_done_callback(self._background_done)
        return task

    def _background_done(self, task: 'asyncio.Task[Any]') -> None:
        self._background_tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.warning('%s 백그라운드 작업 실패', self.id, exc_info=task.exception())

    # ============ 요청 ============

    async def request(self, path: str, api: ApiName = 'public', method: str = 'GET',  # type: ignore[override]
                      params: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None, body: Str = None,
                      config: Optional[Dict[str, Any]] = None) -> Any:
        return await self.fetch2(path, api, method, {} if params is None else params, headers, body, {} if config is None else config)

    async def fetch2(self, path: str, api: ApiName = 'public', method: str = 'GET',  # type: ignore[override]
                     params: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None, body: Str = None,
                     config: Optional[Dict[str, Any]] = None) -> Any:
        """요청 하나를 처리한다: (비공개면) 자격증명 확인 → 재시도 루프 { `throttle` → (비공개면) `authenticate` → `sign` → `fetch` }."""
        params = {} if params is None else params
        config = {} if config is None else config
        is_order = fn.safe_bool(config, 'order', False) is True
        is_private = self.is_private_api(api)
        if is_private:
            self.check_required_credentials()
        retries, params = self.handle_option_and_params(params, path, 'maxRetriesOnFailure', 0)
        retry_delay, params = self.handle_option_and_params(params, path, 'maxRetriesOnFailureDelay', 0)
        if is_order:
            retries = 0
        timeout = self.orderTimeout if is_order and self.orderTimeout is not None else self.timeout
        attempt = 0
        while True:
            # 재시도도 간격 조절을 거치고, 인증은 그 뒤에 한다(동기 판과 같다).
            if self.enableRateLimit:
                await self.throttle(self.calculate_rate_limiter_cost(api, method, path, params, config), fn.safe_string(config, 'bucket'))
            if is_private:
                await self.authenticate(path, api, method, params, headers, body)
            try:
                self.lastRestRequestTimestamp = fn.milliseconds()
                request = self.sign(path, api, method, params, headers, body)
                self.last_request_url = request['url']
                self.last_request_method = request['method']
                self.last_request_headers = request.get('headers')
                self.last_request_body = request.get('body')
                response = await self.fetch(request['url'], request['method'], request.get('headers'), request.get('body'), timeout)
                self.check_order_response(is_order, method, path, response)
                return response
            except BaseError as e:
                error: BaseError = e
                if is_order and not isinstance(e, OrderOutcomeUnknown) and self.is_outcome_unknown(e):
                    error = OrderOutcomeUnknown(f'{self.id} {method} {path} 주문 요청이 접수됐는지 알 수 없다: {e}')
                    error.__cause__ = e
                retryable = isinstance(error, OperationFailed) and error.retryable is not False
                if not retryable or attempt >= retries:
                    if error is e:
                        raise
                    raise error from e
                attempt += 1
                self.log(f'요청 실패, 다시 시도한다({attempt}/{retries}): {error}')
                retry_after = getattr(error, 'retry_after_ms', None)
                wait_ms = max(retry_delay, retry_after if isinstance(retry_after, (int, float)) else 0)
                if wait_ms > 0:
                    await self.sleep(wait_ms)

    async def authenticate(self, path: str, api: ApiName, method: str, params: Dict[str, Any],  # type: ignore[override]
                           headers: Optional[Dict[str, str]], body: Str) -> None:
        """비공개 호출 앞에서 부르는 훅. 기본 구현은 아무것도 하지 않는다."""

    async def fetch(self, url: str, method: str = 'GET', headers: Optional[Dict[str, str]] = None,  # type: ignore[override]
                    body: Str = None, timeout_ms: Optional[float] = None) -> Any:
        """HTTP 요청을 보내고 응답을 `handle_rest_response` 로 읽는다. 오류 규칙은 동기 판과 같다."""
        timeout_ms = self.timeout if timeout_ms is None else timeout_ms
        request_headers = self.prepare_request_headers(headers)
        if self.verbose:
            self.log(f'{self.id} {method} {url}', {'headers': redact_headers_for_log(request_headers), 'body': redact_body_for_log(body)})
        response = await self.http_request(method, url, request_headers, body, timeout_ms)
        return self.handle_rest_response(response, url, method, request_headers, body)

    async def http_request(self, method: str, url: str, headers: Optional[Dict[str, str]] = None,  # type: ignore[override]
                           body: Str = None, timeout_ms: Optional[float] = None) -> HttpResponse:
        """HTTP 요청 하나를 그대로 보내고 본문까지 읽은 응답을 돌려준다. 시간 초과는 `RequestTimeout`, 그 밖의 전송 실패는 `NetworkError` 다."""
        assert_secure_url(self.id, url, self.options.get('allowInsecureUrl') is True)
        timeout_ms = self.timeout if timeout_ms is None else timeout_ms
        self.open()
        try:
            # 리다이렉트를 따르지 않는다(동기 판과 같다).
            async with self.session.request(method, url, headers=headers, data=None if body is None else body.encode('utf-8'),
                                            timeout=aiohttp.ClientTimeout(total=timeout_ms / 1000), allow_redirects=False) as response:
                content = await response.read()
                return HttpResponse(response.status, response.reason or '', response.headers, response.charset, content)
        except asyncio.TimeoutError as e:
            raise RequestTimeout(f'{self.id} {method} {url} 요청이 {int(timeout_ms)}ms 안에 끝나지 않았다') from e
        except aiohttp.ClientError as e:
            raise NetworkError(f'{self.id} {method} {url} 연결에 실패했다: {e}') from e

    # ---- 호출 간격 ----

    @staticmethod
    def _new_throttler(rate_limit: float) -> Optional[Throttler]:
        # rateLimit 이 0 이면 기다릴 이유가 없으므로 조절기를 만들지 않는다.
        return Throttler(refill_rate=1 / rate_limit, capacity=1, cost=1) if rate_limit > 0 else None

    async def throttle(self, cost: Num = None, bucket: Str = None) -> None:  # type: ignore[override]
        # 모르는 버킷을 기본 한도로 넘기면 그룹 한도를 넘겨 429 를 받는다(동기 판, TS 판과 같다).
        if bucket is not None and bucket not in self._bucket_throttlers:
            raise ExchangeError(f'{self.id} 에 없는 rateLimitBuckets 이름이다: {bucket}')
        throttler = self._throttler if bucket is None else self._bucket_throttlers[bucket]
        if throttler is not None:
            await throttler.throttle(cost)

    # ============ 종목 ============

    async def is_option_enabled(self, name: str) -> bool:  # type: ignore[override]
        """켜고 끄는 옵션(`nxtRouting` 등)이 켜져 있는가. 불리언이나 불리언을 돌려주는 함수를 받고, 비동기 판은 코루틴 함수도 받는다."""
        option = self.options.get(name)
        if callable(option):
            option = await maybe_await(option())
        return option is True

    async def load_markets(self, reload: bool = False, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # type: ignore[override]
        """종목 목록을 받는다. 진행 중인 조회가 있으면 새로 부르지 않고 그 결과를 함께 기다린다(`reload` 는 새 조회를 띄운다).
        조회가 실패하면 진행 중 표시를 지워 다음 호출이 다시 부르게 한다."""
        task = self._markets_loading
        # 취소된 조회(앞선 이벤트 루프가 끝나며 멈춘 것)는 결과가 없으므로 새로 띄운다.
        if task is None or task.cancelled() or (reload and task.done()):
            task = asyncio.ensure_future(self._load_markets_helper(reload, params))
            self._markets_loading = task
        try:
            return await asyncio.shield(task)
        except BaseException:
            if self._markets_loading is task and task.done():
                self._markets_loading = None
            raise

    async def _load_markets_helper(self, reload: bool, params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not reload and self.markets is not None:
            if self.markets_by_id is None:
                return self.set_markets(self.markets)
            return self.markets
        currencies = await self.fetch_currencies() if self.has.get('fetchCurrencies') is True else None
        markets = await self.fetch_markets({} if params is None else params)
        return self.set_markets(markets, currencies)

    async def fetch_markets(self, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:  # type: ignore[override]
        return list((self.markets or {}).values())

    async def fetch_currencies(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # type: ignore[override]
        return self.currencies

    # ============ 통합 메서드(기본 구현) ============

    async def fetch_time(self, params: Optional[Dict[str, Any]] = None) -> Int:  # type: ignore[override]
        raise NotSupported(f'{self.id} fetch_time() is not supported yet')

    async def fetch_status(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # type: ignore[override]
        raise NotSupported(f'{self.id} fetch_status() is not supported yet')

    async def fetch_ticker(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # type: ignore[override]
        if self.has.get('fetchTickers') not in (None, False):
            await self.load_markets()
            market = self.market(symbol)
            tickers = await self.fetch_tickers([market['symbol']], params)
            ticker = fn.safe_dict(tickers, market['symbol'])
            if ticker is None:
                raise NullResponse(f'{self.id} fetch_tickers() could not find a ticker for {market["symbol"]}')
            return ticker
        raise NotSupported(f'{self.id} fetch_ticker() is not supported yet')

    async def fetch_tickers(self, symbols: Strings = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # type: ignore[override]
        raise NotSupported(f'{self.id} fetch_tickers() is not supported yet')

    async def fetch_order_book(self, symbol: str, limit: Int = None,  # type: ignore[override]
                               params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} fetch_order_book() is not supported yet')

    async def fetch_ohlcv(self, symbol: str, timeframe: str = '1m', since: Int = None, limit: Int = None,  # type: ignore[override]
                          params: Optional[Dict[str, Any]] = None) -> List[List[Num]]:
        raise NotSupported(f'{self.id} fetch_ohlcv() is not supported yet')

    async def fetch_balance(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # type: ignore[override]
        raise NotSupported(f'{self.id} fetch_balance() is not supported yet')

    async def create_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None,  # type: ignore[override]
                           params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} create_order() is not supported yet')

    async def create_trigger_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None,  # type: ignore[override]
                                   trigger_price: Num = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} create_trigger_order() is not supported yet')

    async def edit_order(self, id: str, symbol: str, type: str, side: str, amount: Num = None, price: Num = None,  # type: ignore[override]
                         params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} edit_order() is not supported yet')

    async def create_limit_order(self, symbol: str, side: str, amount: float, price: float,  # type: ignore[override]
                                 params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return await self.create_order(symbol, 'limit', side, amount, price, params)

    async def create_market_order(self, symbol: str, side: str, amount: float, price: Num = None,  # type: ignore[override]
                                  params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return await self.create_order(symbol, 'market', side, amount, price, params)

    async def create_limit_buy_order(self, symbol: str, amount: float, price: float,  # type: ignore[override]
                                     params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return await self.create_order(symbol, 'limit', 'buy', amount, price, params)

    async def create_limit_sell_order(self, symbol: str, amount: float, price: float,  # type: ignore[override]
                                      params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return await self.create_order(symbol, 'limit', 'sell', amount, price, params)

    async def create_market_buy_order(self, symbol: str, amount: float,  # type: ignore[override]
                                      params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return await self.create_order(symbol, 'market', 'buy', amount, None, params)

    async def create_market_sell_order(self, symbol: str, amount: float,  # type: ignore[override]
                                       params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return await self.create_order(symbol, 'market', 'sell', amount, None, params)

    async def cancel_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # type: ignore[override]
        raise NotSupported(f'{self.id} cancel_order() is not supported yet')

    async def cancel_all_orders(self, symbol: Str = None,  # type: ignore[override]
                                params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        raise NotSupported(f'{self.id} cancel_all_orders() is not supported yet')

    async def fetch_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # type: ignore[override]
        raise NotSupported(f'{self.id} fetch_order() is not supported yet')

    async def fetch_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,  # type: ignore[override]
                           params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        raise NotSupported(f'{self.id} fetch_orders() is not supported yet')

    async def fetch_open_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,  # type: ignore[override]
                                params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        if self.has.get('fetchOrders') not in (None, False):
            return fn.filter_by(await self.fetch_orders(symbol, since, limit, params), 'status', 'open')
        raise NotSupported(f'{self.id} fetch_open_orders() is not supported yet')

    async def fetch_closed_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,  # type: ignore[override]
                                  params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        if self.has.get('fetchOrders') not in (None, False):
            return fn.filter_by(await self.fetch_orders(symbol, since, limit, params), 'status', 'closed')
        raise NotSupported(f'{self.id} fetch_closed_orders() is not supported yet')

    async def fetch_my_trades(self, symbol: Str = None, since: Int = None, limit: Int = None,  # type: ignore[override]
                              params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        raise NotSupported(f'{self.id} fetch_my_trades() is not supported yet')

    async def fetch_trading_fee(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # type: ignore[override]
        raise NotSupported(f'{self.id} fetch_trading_fee() is not supported yet')
