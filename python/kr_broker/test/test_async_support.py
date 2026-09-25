"""비동기 판(`kr_broker.async_support`)의 구조와 비동기에만 있는 동작을 본다.

요청과 응답 해석은 `test_request_fixtures.py` 가 세 판(동기, 비동기, 비동기+비동기 토큰 저장소)으로 대조한다. 여기서는
- 비동기 소스에서 코루틴 호출에 `await` 를 빠뜨리지 않았는지(정적 검사, 픽스처가 지나지 않는 분기까지 본다)
- 손으로 쓰는 동기·비동기 짝(베이스, 실행 도구, 토큰 락, 캘린더 갱신)의 이름과 인자가 같은지
- 루프별 락, 전송 오류 변환, 세션 수명, 띄운 작업 정리, 야후 동시 요청 상한
을 본다.
"""

import ast
import asyncio
import inspect
import json
import logging
import re
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, List, Optional, Set

import aiohttp
import pytest

import kr_broker
import kr_broker.async_support
from kr_broker import market_calendar
from kr_broker.async_support import execution_confirm as async_execution_confirm
from kr_broker.async_support import extended_session_limit as async_extended_session_limit
from kr_broker.async_support import kis_yahoo_candles as async_yahoo
from kr_broker.async_support import market_calendar as async_market_calendar
from kr_broker.async_support.base import exchange as async_exchange_module
from kr_broker.async_support.base import runtime as async_runtime
from kr_broker.async_support.base import token_store as async_token_store
from kr_broker.async_support.base.exchange import Exchange as AsyncExchange
from kr_broker.async_support.base.throttler import Throttler as AsyncThrottler
from kr_broker.base import exchange as sync_exchange_module
from kr_broker.base import runtime as sync_runtime
from kr_broker.base import token_store as sync_token_store
from kr_broker.base.errors import AuthenticationError, NetworkError, RequestTimeout
from kr_broker.base.exchange import Exchange as SyncExchange
from kr_broker.base.types import Entry

PACKAGE = Path(kr_broker.__file__).resolve().parent
ASYNC_ROOT = PACKAGE / 'async_support'
GENERATOR = PACKAGE.parents[1] / 'scripts' / 'gen-python-sync.mjs'
STORE_METHODS = {'get', 'set', 'delete', 'delete_if_access_token_equals', 'try_lock', 'unlock'}
EXCHANGE_RECEIVERS = {'exchange', 'source'}


def generated_modules() -> List[str]:
    """생성 스크립트의 `GENERATED_MODULES` 목록. 두 곳에 적지 않으려고 스크립트에서 읽는다."""
    block = re.search(r'GENERATED_MODULES = \[(.*?)\]', GENERATOR.read_text(encoding='utf-8'), re.S)
    assert block is not None
    return re.findall(r"'(\w+)\.py'", block.group(1))


def async_modules() -> Dict[str, ModuleType]:
    modules = {}
    for name in generated_modules():
        modules[name] = __import__(f'kr_broker.async_support.{name}', fromlist=['_'])
    return modules


# ============ await 누락 정적 검사 ============

def _is_coroutine_attr(value: Any) -> Optional[bool]:
    """호출하면 코루틴이 나오는가. 모르면 `None`."""
    if value is None:
        return None
    if isinstance(value, Entry):
        return True  # 암묵 API 는 비동기 판에서 `request` 코루틴을 돌려준다
    if isinstance(value, (staticmethod, classmethod)):
        value = value.__func__
    if inspect.iscoroutinefunction(value):
        return True
    if isinstance(value, property):
        return None
    if callable(value):
        return False
    return None


def _class_attr(cls: Any, name: str) -> Any:
    """클래스 속성을 디스크립터를 풀지 않고 꺼낸다(암묵 API 의 `Entry` 를 그대로 보려는 것이다)."""
    try:
        return inspect.getattr_static(cls, name)
    except AttributeError:
        return None


def _exchange_method(name: str) -> Any:
    for cls in (kr_broker.async_support.kis, kr_broker.async_support.toss):
        value = _class_attr(cls, name)
        if value is not None:
            return value
    return None


def _await_problems(module: ModuleType) -> List[str]:
    path = Path(module.__file__ or '')
    tree = ast.parse(path.read_text(encoding='utf-8'))
    parents: Dict[ast.AST, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    problems: List[str] = []

    def enclosing_async_names(node: ast.AST) -> Set[str]:
        """이 노드를 감싼 함수들 안에 정의된 async 중첩 함수 이름."""
        names: Set[str] = set()
        current = parents.get(node)
        while current is not None:
            if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for child in ast.walk(current):
                    if isinstance(child, ast.AsyncFunctionDef) and child is not current:
                        names.add(child.name)
            current = parents.get(current)
        return names

    def enclosing_class(node: ast.AST) -> Any:
        current = parents.get(node)
        while current is not None:
            if isinstance(current, ast.ClassDef):
                return getattr(module, current.name, None)
            current = parents.get(current)
        return None

    for call in (n for n in ast.walk(tree) if isinstance(n, ast.Call)):
        func = call.func
        is_coroutine: Optional[bool] = None
        if isinstance(func, ast.Attribute):
            receiver = func.value
            is_self = isinstance(receiver, ast.Name) and receiver.id == 'self'
            is_super = isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name) and receiver.func.id == 'super'
            if is_self or is_super:
                cls = enclosing_class(call)
                is_coroutine = _is_coroutine_attr(_class_attr(cls, func.attr)) if cls is not None else None
            elif isinstance(receiver, ast.Name) and receiver.id == 'store' and func.attr in STORE_METHODS:
                # 저장소는 동기 구현과 비동기 구현을 다 받으므로 `await maybe_await(store.x(...))` 로 불러야 한다.
                wrapper = parents.get(call)
                ok = isinstance(wrapper, ast.Call) and isinstance(wrapper.func, ast.Name) and wrapper.func.id == 'maybe_await' \
                    and isinstance(parents.get(wrapper), ast.Await)
                if not ok:
                    problems.append(f'{path.name}:{call.lineno} 저장소 호출을 await maybe_await(...) 로 감싸지 않았다')
                continue
            elif (isinstance(receiver, ast.Name) and receiver.id in EXCHANGE_RECEIVERS) or \
                    (isinstance(receiver, ast.Attribute) and receiver.attr == 'exchange'):
                is_coroutine = _is_coroutine_attr(_exchange_method(func.attr))
        elif isinstance(func, ast.Name):
            if func.id in enclosing_async_names(call):
                is_coroutine = True
            else:
                is_coroutine = _is_coroutine_attr(getattr(module, func.id, None))
        if is_coroutine is None:
            continue
        awaited = isinstance(parents.get(call), ast.Await)
        if is_coroutine and not awaited:
            problems.append(f'{path.name}:{call.lineno} 코루틴 {ast.unparse(func)}() 를 await 하지 않았다')
        if awaited and not is_coroutine:
            problems.append(f'{path.name}:{call.lineno} 코루틴이 아닌 {ast.unparse(func)}() 를 await 했다')
    return problems


@pytest.mark.parametrize('name', generated_modules())
def test_async_source_awaits_every_coroutine_call(name: str) -> None:
    assert _await_problems(async_modules()[name]) == []


PRO_MODULES = ['kis', 'toss', 'kis_price_ws', 'kis_realtime_stream', 'toss_price_ws']


@pytest.mark.parametrize('name', PRO_MODULES)
def test_pro_source_awaits_every_coroutine_call(name: str) -> None:
    assert _await_problems(__import__(f'kr_broker.pro.{name}', fromlist=['_'])) == []


@pytest.mark.parametrize('name', generated_modules())
def test_async_source_does_not_block_the_event_loop(name: str) -> None:
    text = (ASYNC_ROOT / f'{name}.py').read_text(encoding='utf-8')
    for blocking in ('time.sleep', 'import threading', 'import requests', 'import asyncio'):
        assert blocking not in text, f'{name}.py 에 {blocking} 이 있다. async_support/base/runtime.py 의 도구를 쓴다'


def test_await_check_catches_a_missing_await(tmp_path: Path) -> None:
    source = tmp_path / 'broken.py'
    source.write_text('async def io():\n    return 1\n\n\nasync def caller():\n    return io()\n', encoding='utf-8')
    module = ModuleType('broken')
    module.__file__ = str(source)
    exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), module.__dict__)  # noqa: S102 - 검사기 자체를 시험한다
    assert _await_problems(module) == ['broken.py:6 코루틴 io() 를 await 하지 않았다']


# ============ 동기·비동기 짝 ============

def _params(fn: Any) -> List[str]:
    return list(inspect.signature(fn).parameters)


def test_runtime_pairs_share_names_and_parameters() -> None:
    def public(module: ModuleType) -> Dict[str, Any]:
        return {name: value for name, value in vars(module).items()
                if inspect.isfunction(value) and not name.startswith('_') and value.__module__ == module.__name__}
    sync_fns, async_fns = public(sync_runtime), public(async_runtime)
    assert sorted(sync_fns) == sorted(async_fns) == ['maybe_await', 'new_lock', 'new_semaphore', 'sleep_seconds']
    for name in sync_fns:
        assert _params(sync_fns[name]) == _params(async_fns[name]), name
    assert inspect.iscoroutinefunction(async_runtime.sleep_seconds) and inspect.iscoroutinefunction(async_runtime.maybe_await)


@pytest.mark.parametrize('sync_fn,async_fn', [
    (sync_token_store.refresh_token_with_lock, async_token_store.refresh_token_with_lock),
    (market_calendar.refresh_market_calendar, async_market_calendar.refresh_market_calendar),
])
def test_hand_written_pairs_share_parameters(sync_fn: Any, async_fn: Any) -> None:
    assert _params(sync_fn) == _params(async_fn)
    assert inspect.iscoroutinefunction(async_fn) and not inspect.iscoroutinefunction(sync_fn)


def test_async_base_overrides_keep_the_sync_signature() -> None:
    for name, value in vars(AsyncExchange).items():
        if inspect.iscoroutinefunction(value) and not name.startswith('__'):
            assert _params(value) == _params(getattr(SyncExchange, name)), name


def test_sync_base_methods_that_reach_io_are_overridden_as_coroutines() -> None:
    """동기 베이스에서 코루틴이 된 메서드를 부르는 메서드는 비동기 베이스에서도 코루틴으로 다시 정의돼 있어야 한다."""
    coroutines = {name for name, value in vars(AsyncExchange).items() if inspect.iscoroutinefunction(value)}
    tree = ast.parse(Path(sync_exchange_module.__file__ or '').read_text(encoding='utf-8'))
    exchange_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Exchange')
    missing = []
    for method in exchange_class.body:
        if not isinstance(method, ast.FunctionDef) or method.name in coroutines:
            continue
        for call in (n for n in ast.walk(method) if isinstance(n, ast.Call)):
            f = call.func
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == 'self' and f.attr in coroutines:
                missing.append(f'{method.name} → {f.attr}')
    assert missing == []


@pytest.mark.parametrize('broker', ['kis', 'toss'])
def test_broker_overrides_match_base_coroutine_kind(broker: str) -> None:
    """부모의 코루틴을 동기 메서드로 덮거나, 부모의 동기 메서드(`handle_errors` 등)를 코루틴으로 덮지 않았다."""
    cls = getattr(kr_broker.async_support, broker)
    wrong = []
    for name in dir(AsyncExchange):
        base_value = getattr(AsyncExchange, name)
        value = getattr(cls, name)
        if name.startswith('__') or not callable(base_value) or value is base_value:
            continue
        if inspect.iscoroutinefunction(base_value) != inspect.iscoroutinefunction(value):
            wrong.append(name)
    assert wrong == []


def test_async_and_pro_packages_export_same_names_as_sync() -> None:
    import kr_broker.pro
    for package in (kr_broker.async_support, kr_broker.pro):
        assert package.exchanges == kr_broker.exchanges
        assert set(package.__all__) == set(kr_broker.__all__)
        assert package.__version__ == kr_broker.__version__
        assert package.ExchangeError is kr_broker.ExchangeError
    assert issubclass(kr_broker.pro.kis, kr_broker.async_support.kis) and issubclass(kr_broker.pro.toss, kr_broker.async_support.toss)
    assert kr_broker.pro.kis({}).has['watchTicker'] is True and kr_broker.async_support.kis({}).has['watchTicker'] is False


# ============ 실행 도구 ============

def test_per_loop_lock_works_across_event_loops() -> None:
    """asyncio.Lock 은 처음 기다린 루프에 묶인다. 루프별 락은 `asyncio.run` 을 여러 번 불러도 된다."""
    lock = async_runtime.new_lock()

    async def contend() -> List[int]:
        order: List[int] = []

        async def worker(i: int) -> None:
            async with lock:
                order.append(i)
                await asyncio.sleep(0)

        await asyncio.gather(*(worker(i) for i in range(3)))
        return order

    assert asyncio.run(contend()) == [0, 1, 2]
    assert asyncio.run(contend()) == [0, 1, 2]


def test_maybe_await_accepts_values_and_coroutines() -> None:
    async def value() -> int:
        return 7

    async def main() -> List[Any]:
        return [await async_runtime.maybe_await(3), await async_runtime.maybe_await(value())]

    assert asyncio.run(main()) == [3, 7]
    assert sync_runtime.maybe_await(3) == 3


def test_async_throttler_waits_rate_limit_times_cost() -> None:
    now = [0.0]
    slept: List[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)
        now[0] += seconds

    throttler = AsyncThrottler(refill_rate=1 / 100, clock=lambda: now[0], sleep=sleep)

    async def main() -> None:
        await throttler.throttle(1)
        await throttler.throttle(2)
        await throttler.throttle(1)

    asyncio.run(main())
    assert [round(s, 3) for s in slept] == [0.1, 0.2]


class _AsyncStore:
    def __init__(self, lock_ok: bool) -> None:
        self.lock_ok = lock_ok
        self.unlocked: List[str] = []

    async def try_lock(self, key: str, owner: str, ttl_ms: int) -> bool:
        return self.lock_ok

    async def unlock(self, key: str, owner: str) -> None:
        self.unlocked.append(key)


def test_async_refresh_token_with_lock() -> None:
    async def none() -> None:
        return None

    async def new() -> str:
        return 'new'

    async def theirs() -> str:
        return 'theirs'

    async def no_sleep(seconds: float) -> None:
        return None

    locked = _AsyncStore(lock_ok=True)
    assert asyncio.run(async_token_store.refresh_token_with_lock('[t]', locked, 'k', 1000, none, new)) == 'new'
    assert locked.unlocked == ['k:lock']
    busy = _AsyncStore(lock_ok=False)
    assert asyncio.run(async_token_store.refresh_token_with_lock('[t]', busy, 'k', 1000, theirs, new, sleep=no_sleep)) == 'theirs'
    assert asyncio.run(async_token_store.refresh_token_with_lock('[t]', None, 'k', 1000, none, new)) == 'new'


def test_async_refresh_market_calendar_shares_state_with_sync() -> None:
    market_calendar.reset_market_calendar()
    calls = {'n': 0}

    async def fetch_ok() -> Any:
        calls['n'] += 1
        return [{'date': '20261005', 'open': False}]

    async def fetch_fail() -> Any:
        raise RuntimeError('down')

    try:
        assert asyncio.run(async_market_calendar.refresh_market_calendar('KR', fetch_ok, 60_000, now_ms=1_000)) is True
        assert asyncio.run(async_market_calendar.refresh_market_calendar('KR', fetch_ok, 60_000, now_ms=2_000)) is True
        assert calls['n'] == 1
        # 동기 판 모듈의 캘린더와 상태를 함께 쓴다.
        assert market_calendar.is_market_closed_day('KR', '20261005') is True
        assert market_calendar.refresh_market_calendar('KR', lambda: [], 60_000, now_ms=3_000) is True
        assert asyncio.run(async_market_calendar.refresh_market_calendar('US', fetch_fail, 60_000, now_ms=1_000)) is False
        assert asyncio.run(async_market_calendar.refresh_market_calendar('US', fetch_ok, 60_000, now_ms=2_000)) is False
        assert calls['n'] == 1
    finally:
        market_calendar.reset_market_calendar()


# ============ HTTP ============

class _RaisingSession:
    def __init__(self, error: BaseException) -> None:
        self.error = error
        self.closed = False

    def request(self, *args: Any, **kwargs: Any) -> Any:
        error = self.error

        class Context:
            async def __aenter__(self) -> Any:
                raise error

            async def __aexit__(self, *exc: Any) -> None:
                return None

        return Context()

    async def close(self) -> None:
        self.closed = True


@pytest.mark.parametrize('error,expected', [
    (asyncio.TimeoutError(), RequestTimeout),
    (aiohttp.ServerTimeoutError('slow'), RequestTimeout),
    (aiohttp.ClientConnectionError('reset'), NetworkError),
    (aiohttp.ClientOSError(104, 'Connection reset by peer'), NetworkError),
])
def test_http_request_maps_transport_errors(error: BaseException, expected: type) -> None:
    broker = AsyncExchange({'session': _RaisingSession(error)})
    with pytest.raises(expected) as raised:
        asyncio.run(broker.http_request('GET', 'https://example.invalid/', timeout_ms=5))
    # 주문의 접수 여부 판정(`is_outcome_unknown`)은 `NetworkError` 그 자체만 본다. 하위 클래스로 바뀌면 안 된다.
    assert type(raised.value) is expected


def test_session_is_opened_lazily_and_closed_with_the_block() -> None:
    async def main() -> None:
        broker = kr_broker.async_support.toss({'apiKey': 'id', 'secret': 's'})
        assert broker.session is None
        async with broker:
            session = broker.session
            assert isinstance(session, aiohttp.ClientSession) and not session.closed
        assert session.closed and broker.session is None

        mine = aiohttp.ClientSession()
        broker = kr_broker.async_support.toss({'apiKey': 'id', 'secret': 's', 'session': mine})
        await broker.close()
        assert broker.session is mine and not mine.closed
        await mine.close()

    asyncio.run(main())


def test_sync_broker_still_opens_a_requests_session() -> None:
    import requests
    assert isinstance(kr_broker.toss({'apiKey': 'id', 'secret': 's'}).session, requests.Session)


# ============ 기다리지 않는 작업 ============

def test_spawn_runs_in_background_and_close_waits(caplog: pytest.LogCaptureFixture) -> None:
    done: List[int] = []

    async def ok() -> None:
        await asyncio.sleep(0)
        done.append(1)

    async def boom() -> None:
        raise ValueError('boom')

    async def main() -> None:
        broker = AsyncExchange()
        broker.spawn(ok)
        broker.spawn(boom)
        assert done == []  # 띄운 자리에서는 아직 돌지 않는다
        await broker.close()
        assert done == [1] and not broker._background_tasks

    with caplog.at_level(logging.WARNING, logger='kr_broker'):
        asyncio.run(main())
    assert any('백그라운드 작업 실패' in r.getMessage() for r in caplog.records)


def test_sync_spawn_calls_at_once_and_logs_failure(caplog: pytest.LogCaptureFixture) -> None:
    broker = SyncExchange()
    assert broker.spawn(lambda: 5) == 5
    with caplog.at_level(logging.WARNING, logger='kr_broker'):
        assert broker.spawn(lambda: 1 // 0) is None
    assert any('백그라운드 작업 실패' in r.getMessage() for r in caplog.records)


class _DictStore:
    def __init__(self, values: Dict[str, str]) -> None:
        self.values = dict(values)

    def get(self, key: str) -> Optional[str]:
        return self.values.get(key)

    def set(self, key: str, value: str, ttl_ms: int) -> None:
        self.values[key] = value

    def delete(self, key: str) -> None:
        self.values.pop(key, None)

    def try_lock(self, key: str, owner: str, ttl_ms: int) -> bool:
        return True

    def unlock(self, key: str, owner: str) -> None:
        return None


def test_kis_auth_failure_clears_memory_token_at_once_and_store_in_background() -> None:
    """TypeScript 판처럼 토큰 저장소 삭제는 기다리지 않는다. 메모리 캐시는 오류를 던지기 전에 비워 다음 호출이 새 토큰을 받는다."""
    async def main() -> None:
        broker = kr_broker.async_support.kis({'apiKey': 'kis-app-key-abcdefgh', 'secret': 's', 'uid': '12345678-01'})
        auth = broker.auth_manager()
        auth.cached_token = {'accessToken': 'old', 'expiresAt': 2 ** 60}
        store = _DictStore({auth.store_key: json.dumps(auth.cached_token)})
        broker.options['tokenStore'] = store
        broker.token = 'old'
        with pytest.raises(AuthenticationError):
            broker.handle_rest_response(_Response(401, {'msg_cd': 'EGW00123', 'msg1': '기간이 만료된 token 입니다.'}),
                                        'https://openapi.koreainvestment.com:9443/uapi/x', 'GET')
        assert broker.token is None and auth.cached_token is None
        assert auth.store_key in store.values  # 저장소 삭제는 아직 돌지 않았다
        await broker.close()
        assert auth.store_key not in store.values

    asyncio.run(main())


class _RawResponse:
    def __init__(self, status: int, content: bytes) -> None:
        self.status_code = status
        self.reason = ''
        self.headers: Dict[str, str] = {}
        self.encoding = 'utf-8'
        self.content = content


class _Response(_RawResponse):
    def __init__(self, status: int, body: Any) -> None:
        super().__init__(status, json.dumps(body, ensure_ascii=False).encode('utf-8'))


# ============ 생성 대상 도우미 ============

def test_async_confirm_execution_and_extended_session_limit() -> None:
    async def probe(attempt: int) -> Dict[str, Any]:
        return {'snapshot': {'filled': 4, 'average': 10.0}, 'terminal': True}

    snapshot = asyncio.run(async_execution_confirm.confirm_execution('[t]', 'o1', 't', probe, budget={'intervalMs': 0}))
    assert snapshot == {'filled': 4, 'average': 10.0}

    class Source:
        async def fetch_open_orders(self, symbol: str) -> List[Dict[str, Any]]:
            return []

        async def fetch_ticker(self, symbol: str) -> Dict[str, Any]:
            return {'last': 231.5}

    limit = asyncio.run(async_extended_session_limit.build_extended_session_limit(Source(), {'symbol': 'AAPL/USD', 'side': 'sell'}, '[T]'))
    assert limit == {'price': 231.5}


def test_async_yahoo_caps_concurrent_requests() -> None:
    payload = json.dumps({'chart': {'result': [{
        'timestamp': [1_700_000_000], 'indicators': {'quote': [{'open': [1], 'high': [2], 'low': [0.5], 'close': [1.5], 'volume': [100]}]},
    }], 'error': None}}).encode('utf-8')

    class SlowHttp:
        active = 0
        max_active = 0

        async def http_request(self, method: str, url: str, headers: Any = None, body: Any = None, timeout_ms: Any = None) -> Any:
            SlowHttp.active += 1
            SlowHttp.max_active = max(SlowHttp.max_active, SlowHttp.active)
            await asyncio.sleep(0.01)
            SlowHttp.active -= 1
            return _RawResponse(200, payload)

    http = SlowHttp()

    async def main() -> List[Any]:
        return await asyncio.gather(*(async_yahoo.fetch_yahoo_candles('005930', '1d', 10, exchange=http) for _ in range(20)))

    results = asyncio.run(main())
    assert all(r == [[1_700_000_000_000, 1, 2, 0.5, 1.5, 100]] for r in results)
    assert 1 < SlowHttp.max_active <= async_yahoo.YAHOO_MAX_CONCURRENT


def test_async_modules_are_distinct_from_sync() -> None:
    # 생성된 동기 판은 비동기 모듈을 가져오지 않는다(동기 사용자에게 aiohttp 경로가 섞이지 않는다).
    for name in generated_modules():
        text = (PACKAGE / f'{name}.py').read_text(encoding='utf-8')
        assert 'async_support' not in text.split('\n', 1)[1], name
    assert async_exchange_module.Exchange.synchronous is False and sync_exchange_module.Exchange.synchronous is True
