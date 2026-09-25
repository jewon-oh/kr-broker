"""주문 요청이 어떤 실패에서 `OrderOutcomeUnknown`(접수 미상)이 되는지 동기 판과 비동기 판에서 본다. TS 판 `exchange.test.ts` 의 '주문 요청' 절과 같은 규칙이다."""

import asyncio
from typing import Any, Dict, List, Optional

import pytest

from kr_broker.async_support.base.exchange import Exchange as AsyncExchange, HttpResponse
from kr_broker.base.errors import BadRequest, ExchangeError, ExchangeNotAvailable, OrderOutcomeUnknown
from kr_broker.base.exchange import Exchange as SyncExchange


class _Response:
    def __init__(self, status: int, body: str) -> None:
        self.status_code = status
        self.reason = ''
        self.headers: Dict[str, str] = {}
        self.encoding = 'utf-8'
        self.content = body.encode('utf-8')


def _describe(base: Dict[str, Any], deep_extend: Any) -> Dict[str, Any]:
    return deep_extend(base, {
        'id': 'fake',
        'urls': {'api': {'private': 'https://example.invalid'}},
        'requiredCredentials': {'apiKey': False, 'secret': False, 'uid': False},
        'exceptions': {'exact': {'SVC_DOWN': ExchangeNotAvailable}},
    })


def _handle_errors(self: Any, code: int, response: Any, body: str) -> Optional[bool]:
    error_code = self.safe_string(response, 'code')
    if error_code is None:
        return None
    self.throw_exactly_matched_exception(self.exceptions.get('exact'), error_code, body)
    raise ExchangeError(body)


class SyncFake(SyncExchange):
    def __init__(self, responses: List[_Response], config: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(config)
        self.responses = responses
        self.calls = 0

    def describe(self) -> Dict[str, Any]:
        return _describe(super().describe(), self.deep_extend)

    def http_request(self, method: str, url: str, headers: Any = None, body: Any = None, timeout_ms: Any = None) -> Any:
        self.calls += 1
        return self.responses.pop(0)

    def handle_errors(self, code: int, reason: str, url: str, method: str, headers: Any, body: str, response: Any,
                      request_headers: Any, request_body: Any) -> Optional[bool]:
        return _handle_errors(self, code, response, body)


class AsyncFake(AsyncExchange):
    def __init__(self, responses: List[_Response], config: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(config)
        self.responses = responses
        self.calls = 0

    def describe(self) -> Dict[str, Any]:
        return _describe(super().describe(), self.deep_extend)

    async def http_request(self, method: str, url: str, headers: Any = None, body: Any = None, timeout_ms: Any = None) -> Any:
        self.calls += 1
        r = self.responses.pop(0)
        return HttpResponse(r.status_code, r.reason, r.headers, r.encoding, r.content)

    def handle_errors(self, code: int, reason: str, url: str, method: str, headers: Any, body: str, response: Any,
                      request_headers: Any, request_body: Any) -> Optional[bool]:
        return _handle_errors(self, code, response, body)


def _order(ex: Any, retries: int = 3) -> Any:
    """주문 요청 하나를 보내고 결과나 오류를 돌려준다."""
    try:
        call = ex.fetch2('orders', 'private', 'POST', {'maxRetriesOnFailure': retries}, None, None, {'order': True})
        return asyncio.run(call) if asyncio.iscoroutine(call) else call
    except Exception as e:
        return e


@pytest.mark.parametrize('cls', [SyncFake, AsyncFake])
@pytest.mark.parametrize('status', [500, 502, 503, 524])
def test_envelope_less_5xx_is_outcome_unknown(cls: Any, status: int) -> None:
    ex = cls([_Response(status, '<html>bad gateway</html>')])
    error = _order(ex)
    assert isinstance(error, OrderOutcomeUnknown)
    assert isinstance(error.__cause__, ExchangeNotAvailable)
    assert ex.calls == 1


@pytest.mark.parametrize('cls', [SyncFake, AsyncFake])
def test_classified_5xx_and_4xx_are_definite_rejections(cls: Any) -> None:
    classified = _order(cls([_Response(503, '{"code": "SVC_DOWN"}')]))
    assert isinstance(classified, ExchangeNotAvailable) and not isinstance(classified, OrderOutcomeUnknown)
    bad = _order(cls([_Response(400, 'bad')]))
    assert isinstance(bad, ExchangeNotAvailable) and not isinstance(bad, OrderOutcomeUnknown)


@pytest.mark.parametrize('cls', [SyncFake, AsyncFake])
def test_non_json_order_response_is_outcome_unknown_but_empty_body_passes(cls: Any) -> None:
    error = _order(cls([_Response(200, '<html>점검 중</html>')]))
    assert isinstance(error, OrderOutcomeUnknown) and 'JSON 이 아니다' in str(error)
    assert _order(cls([_Response(200, '')])) == ''


def test_sync_pre_send_failure_is_bad_request_not_outcome_unknown() -> None:
    # requests 는 헤더 값이 문자열이 아니면 보내기 전에 InvalidHeader 를 던진다. 서버에 간 요청이 없으므로 접수 미상이 아니다.
    ex = SyncExchange({'urls': {'api': {'private': 'https://example.invalid'}},
                       'requiredCredentials': {'apiKey': False, 'secret': False, 'uid': False}})
    error = None
    try:
        ex.fetch2('orders', 'private', 'POST', {}, {'X-Test': 1}, None, {'order': True})  # type: ignore[dict-item]
    except Exception as e:
        error = e
    assert isinstance(error, BadRequest) and not isinstance(error, OrderOutcomeUnknown)


def test_confirm_budget_never_raises_after_order_is_sent() -> None:
    defaults = {'attempts': 5, 'intervalMs': 1000}

    def boom() -> Dict[str, int]:
        raise RuntimeError('boom')

    async def coroutine_budget() -> Dict[str, int]:
        return {'attempts': 2}

    for option in (boom, coroutine_budget, [3, 100], 'x'):
        assert SyncExchange({'options': {'confirmBudget': option}}).get_confirm_budget(defaults) == defaults
    assert SyncExchange({'options': {'confirmBudget': {'attempts': 2}}}).get_confirm_budget(defaults) == {'attempts': 2, 'intervalMs': 1000}


@pytest.mark.parametrize('cls', [SyncFake, AsyncFake])
@pytest.mark.parametrize('status', [301, 302, 307, 308])
def test_redirect_is_not_followed_but_raised(cls: Any, status: int) -> None:
    # 리다이렉트를 따르면 앱키와 시크릿을 다른 호스트로 다시 보낸다. 3xx 는 오류로 던진다.
    error = _order(cls([_Response(status, 'moved')]))
    assert isinstance(error, ExchangeNotAvailable) and not isinstance(error, OrderOutcomeUnknown)


def test_sync_http_request_disables_redirects() -> None:
    seen: Dict[str, Any] = {}

    class Session:
        def request(self, method: str, url: str, **kwargs: Any) -> Any:
            seen.update(kwargs)
            return _Response(200, '{}')

    SyncExchange({'session': Session()}).http_request('GET', 'https://example.invalid/x')
    assert seen['allow_redirects'] is False
