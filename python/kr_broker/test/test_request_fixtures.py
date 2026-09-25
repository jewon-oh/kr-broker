"""`ts/src/test/static/request/*.json` 을 Python 판으로 돌린다. TypeScript 판(`ts/src/__tests__/request-fixtures.test.ts`)도 같은 파일을 돌리므로,
둘 다 통과하면 두 판이 같은 요청(URL·헤더·본문)을 만들고 같은 응답을 같은 결과와 오류로 바꾼다는 뜻이다.
케이스마다 동기 판(`kr_broker`)과 비동기 판(`kr_broker.async_support`)을 돌리고, 비동기 판은 비동기 토큰 저장소로도 한 번 더 돌린다.

케이스마다 새 인스턴스를 만들고, 가짜 HTTP 세션이 `http` 목록을 순서대로 응답한다. 케이스에 `now` 가 있으면 패키지의 시계
(`kr_broker.base.functions.milliseconds`)를 그 시각으로 바꿔 끼운다. 형식은 `ts/src/test/static/README.md` 에 있다.
"""

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiohttp
import pytest
import requests

import kr_broker
import kr_broker.async_support
from kr_broker.base import functions as fn
from kr_broker.base.functions import deep_extend
from kr_broker.market_calendar import reset_market_calendar

FIXTURES = Path(__file__).resolve().parents[3] / 'ts' / 'src' / 'test' / 'static' / 'request'


class MemoryTokenStore:
    """픽스처용 토큰 저장소. 값은 JSON 문자열로 둔다(실제 저장소와 같다)."""

    def __init__(self, initial: Dict[str, Any]) -> None:
        self.values = {key: json.dumps(value) for key, value in initial.items()}
        self.locks: Dict[str, str] = {}

    def get(self, key: str) -> Optional[str]:
        return self.values.get(key)

    def set(self, key: str, value: str, ttl_ms: int) -> None:
        self.values[key] = value

    def delete(self, key: str) -> None:
        self.values.pop(key, None)

    def delete_if_access_token_equals(self, key: str, access_token: str) -> bool:
        raw = self.values.get(key)
        if raw is None:
            return False
        try:
            if json.loads(raw).get('accessToken') != access_token:
                return False
        except ValueError:
            return False
        del self.values[key]
        return True

    def try_lock(self, key: str, owner: str, ttl_ms: int) -> bool:
        if key in self.locks:
            return False
        self.locks[key] = owner
        return True

    def unlock(self, key: str, owner: str) -> None:
        if self.locks.get(key) == owner:
            del self.locks[key]


class AsyncMemoryTokenStore:
    """`MemoryTokenStore` 의 메서드가 코루틴을 돌려주는 판(`redis.asyncio` 같은 저장소). 비동기 판만 받는다."""

    def __init__(self, store: MemoryTokenStore) -> None:
        self.store = store

    def __getattr__(self, name: str) -> Any:
        method = getattr(self.store, name)

        async def call(*args: Any) -> Any:
            return method(*args)

        return call


class FakeResponse:
    def __init__(self, status: int, headers: Dict[str, str], text: str) -> None:
        self.status_code = status
        self.reason = ''
        self.headers = headers
        self.content = text.encode('utf-8')
        self.encoding = 'utf-8'


class FakeSession:
    """`requests.Session` 대신 픽스처의 `http` 목록을 순서대로 응답한다."""

    def __init__(self, exchanges: List[Dict[str, Any]]) -> None:
        self.exchanges = exchanges
        self.seen: List[Dict[str, Any]] = []

    def reply(self, method: str, url: str, headers: Optional[Dict[str, str]], data: Optional[bytes]) -> Dict[str, Any]:
        """요청을 기록하고 픽스처의 다음 항목을 돌려준다."""
        self.seen.append({
            'method': method,
            'url': url,
            'headers': dict(headers or {}),
            'body': None if data is None else data.decode('utf-8'),
        })
        index = len(self.seen) - 1
        if index >= len(self.exchanges):
            raise AssertionError(f'픽스처에 없는 요청: {method} {url}')
        return self.exchanges[index]

    @staticmethod
    def body_text(exchange: Dict[str, Any]) -> str:
        body = exchange['response']['body']
        return body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)

    def request(self, method: str, url: str, headers: Optional[Dict[str, str]] = None, data: Optional[bytes] = None,
                timeout: Optional[float] = None) -> FakeResponse:
        exchange = self.reply(method, url, headers, data)
        if exchange.get('network') == 'timeout':
            raise requests.exceptions.ReadTimeout('timed out')
        if exchange.get('network') == 'reset':
            raise requests.exceptions.ConnectionError('connection reset')
        reply = exchange['response']
        return FakeResponse(reply['status'], reply.get('headers', {}), self.body_text(exchange))

    def close(self) -> None:
        pass


class FakeAsyncResponse:
    def __init__(self, status: int, headers: Dict[str, str], text: str) -> None:
        self.status = status
        self.reason = ''
        self.headers = headers
        self.charset = 'utf-8'
        self._content = text.encode('utf-8')

    async def read(self) -> bytes:
        return self._content


class _FakeRequestContext:
    def __init__(self, session: 'FakeAsyncSession', args: Any) -> None:
        self.session = session
        self.args = args

    async def __aenter__(self) -> FakeAsyncResponse:
        exchange = self.session.reply(*self.args)
        if exchange.get('network') == 'timeout':
            raise asyncio.TimeoutError()
        if exchange.get('network') == 'reset':
            raise aiohttp.ClientConnectionError('connection reset')
        reply = exchange['response']
        return FakeAsyncResponse(reply['status'], reply.get('headers', {}), self.session.body_text(exchange))

    async def __aexit__(self, *exc: Any) -> None:
        return None


class FakeAsyncSession(FakeSession):
    """`aiohttp.ClientSession` 대신 응답한다. 기록과 응답 규칙은 `FakeSession` 과 같고, 연결 오류만 aiohttp 의 것으로 던진다."""

    def request(self, method: str, url: str, headers: Optional[Dict[str, str]] = None, data: Optional[bytes] = None,  # type: ignore[override]
                timeout: Any = None) -> _FakeRequestContext:
        return _FakeRequestContext(self, (method, url, headers, data))

    async def close(self) -> None:  # type: ignore[override]
        pass


def comparable(value: Any) -> Any:
    """결과를 비교할 모양으로 바꾼다. 사전에서 값이 `None` 인 키를 뺀다(TypeScript 판의 `null`·`undefined` 와 맞춘다)."""
    if isinstance(value, dict):
        return {key: comparable(item) for key, item in value.items() if item is not None}
    if isinstance(value, (list, tuple)):
        return [comparable(item) for item in value]
    return value


@pytest.fixture(autouse=True)
def _fresh_market_calendar() -> Any:
    # 휴장일 캘린더는 모듈 전역이라 앞 케이스가 받은 캘린더가 다음 케이스의 세션 판정에 섞이지 않게 비운다.
    reset_market_calendar()
    yield
    reset_market_calendar()


def _load_cases() -> List[Any]:
    params = []
    for file in sorted(FIXTURES.glob('*.json')):
        fixture = json.loads(file.read_text(encoding='utf-8'))
        for case in fixture['cases']:
            params.append(pytest.param(fixture, case, id=f'{file.stem}: {case["description"]}'))
    return params


@pytest.mark.parametrize('flavor', ['sync', 'async', 'async-store'])
@pytest.mark.parametrize('fixture,case', _load_cases())
def test_request_fixture(fixture: Dict[str, Any], case: Dict[str, Any], flavor: str, monkeypatch: pytest.MonkeyPatch) -> None:
    if 'now' in case:
        monkeypatch.setattr(fn, 'milliseconds', lambda: case['now'])
    store = MemoryTokenStore(case.get('tokenStore', fixture.get('tokenStore', {})))
    store_option: Any = AsyncMemoryTokenStore(store) if flavor == 'async-store' else store
    config = deep_extend(fixture['config'], case.get('config', {}), {'options': {'tokenStore': store_option}})

    result: Any = None
    error: Optional[BaseException] = None
    if flavor == 'sync':
        broker = getattr(kr_broker, fixture['broker'])(config)
        session: FakeSession = FakeSession(case['http'])
        broker.session = session
        try:
            result = getattr(broker, case['method'])(*case['args'])
        except Exception as e:  # noqa: BLE001 - 픽스처가 기대한 오류인지 아래에서 가린다
            error = e
    else:
        async_broker = getattr(kr_broker.async_support, fixture['broker'])(config)
        session = FakeAsyncSession(case['http'])
        async_broker.session = session

        async def run() -> Any:
            try:
                return await getattr(async_broker, case['method'])(*case['args'])
            finally:
                # 기다리지 않고 띄운 작업(토큰 저장소 정리 등)까지 끝나야 `tokenStoreAfter` 를 볼 수 있다.
                await async_broker.close()

        try:
            result = asyncio.run(run())
        except Exception as e:  # noqa: BLE001
            error = e

    assert session.seen == [h['request'] for h in case['http']]
    expected_error = case.get('error')
    if expected_error is not None:
        assert error is not None, '오류를 던져야 한다'
        assert type(error).__name__ == expected_error['class']
        if 'detail' in expected_error:
            assert getattr(error, 'detail', None) == expected_error['detail']
    else:
        if error is not None:
            raise error
        assert comparable(result) == comparable(case['output'])
    for key, state in case.get('tokenStoreAfter', {}).items():
        assert (key in store.values) == (state == 'present'), f'{key} 는 {state} 여야 한다'
