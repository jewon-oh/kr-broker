"""KB증권 도우미 가운데 요청 픽스처로 재현할 수 없는 동작(`jti` 읽기, 호스트 주소, 토큰 차단기, `price_to_precision`, `kbsec_num`).
기대값은 TypeScript 판의 같은 테스트에서 가져왔다."""

import base64
import json
import socket
import uuid
from types import SimpleNamespace
from typing import Any, Dict, Iterator, List

import pytest

import kr_broker
from kr_broker import kbsec_envelope
from kr_broker.async_support.kbsec import token_jti
from kr_broker.base import functions as fn
from kr_broker.base.errors import ExchangeNotAvailable
from kr_broker.kbsec_token_breaker import (
    TOKEN_BREAKER_OPEN_MS, TOKEN_BREAKER_THRESHOLD, kbsec_token_breaker_state, record_kbsec_call_ok, record_token_failure,
    throw_if_token_breaker_open,
)
from kr_broker.kbsec_types import kbsec_num
from kr_broker.testing import reset_kbsec_token_breaker

MASTER: Dict[str, Any] = {
    'kospi': [{'code': '005930', 'name': '삼성전자', 'market': 'KOSPI', 'securityType': 'STOCK'},
              {'code': '069500', 'name': 'KODEX 200', 'market': 'KOSPI', 'securityType': 'ETF'}],
    'kosdaq': [], 'nasdaq': [], 'nyse': [], 'amex': [],
}


@pytest.fixture(autouse=True)
def _breaker() -> Iterator[None]:
    reset_kbsec_token_breaker()
    yield
    reset_kbsec_token_breaker()


def _b64url(value: Any) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode('utf-8')).decode('ascii').rstrip('=')


# ============ jti ============

def test_token_jti_reads_unpadded_base64url_payloads() -> None:
    for jti in ('aaa', 'jti-01', 'x12'):
        payload = _b64url({'sub': 'token', 'jti': jti})
        assert token_jti(f'{_b64url({"typ": "JWT"})}.{payload}.sig') == jti
    assert token_jti(f'h.{_b64url({"jti": "aaa"})}.s') != token_jti(f'h.{_b64url({"jti": "bbb"})}.s')


@pytest.mark.parametrize('token', ['TOK1', 'a.b.c', f'h.{_b64url({"sub": "token"})}.s', f'h.{_b64url({"jti": ""})}.s', 'h.!!!.s', 'h..s'])
def test_token_jti_is_none_when_unknown(token: str) -> None:
    assert token_jti(token) is None


# ============ 호스트 주소 ============

def test_host_addr_uses_the_given_values_and_fills_only_the_missing_one(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kbsec_envelope, '_cached_host_addr', {'ipAddr': '198.51.100.7', 'macAddr': '00-00-5E-00-53-FF'})
    broker = kr_broker.kbsec({'apiKey': 'k', 'secret': 's', 'options': {'hostAddr': {'ipAddr': '203.0.113.10'}}})
    body = json.loads(broker.sign('ivu10140', 'private', 'POST', {'shrt_cd': '005930'})['body'])
    assert body['dataHeader'] == {'ipAddr': '203.0.113.10', 'macAddr': '00-00-5E-00-53-FF'}
    assert body['dataBody'] == {'excg_clsf': '', 'shrt_cd': '005930'}


class _Probe:
    def __init__(self, address: str) -> None:
        self.address = address

    def __enter__(self) -> '_Probe':
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def connect(self, target: Any) -> None:
        if self.address == '':
            raise OSError('Network is unreachable')

    def getsockname(self) -> Any:
        return (self.address, 40000)


@pytest.mark.parametrize('address,node,expected', [
    ('203.0.113.10', 0x00005E005301, {'ipAddr': '203.0.113.10', 'macAddr': '00-00-5E-00-53-01'}),
    # MAC 을 찾지 못한 `getnode` 는 멀티캐스트 비트를 켠 임의 값을 준다.
    ('203.0.113.10', 0x010203040506, {'ipAddr': '203.0.113.10', 'macAddr': '00-00-00-00-00-00'}),
    # 밖으로 나가는 경로가 없으면 루프백 주소다.
    ('', 0x00005E005301, {'ipAddr': '127.0.0.1', 'macAddr': '00-00-00-00-00-00'}),
    ('127.0.0.1', 0x00005E005301, {'ipAddr': '127.0.0.1', 'macAddr': '00-00-00-00-00-00'}),
])
def test_host_addr_fallbacks(monkeypatch: pytest.MonkeyPatch, address: str, node: int, expected: Dict[str, str]) -> None:
    monkeypatch.setattr(kbsec_envelope, '_cached_host_addr', None)
    monkeypatch.setattr(socket, 'socket', lambda *args: _Probe(address))
    monkeypatch.setattr(uuid, 'getnode', lambda: node)
    assert kbsec_envelope.kbsec_host_addr() == expected
    assert kbsec_envelope.kbsec_host_addr() is kbsec_envelope.kbsec_host_addr()


# ============ 토큰 차단기 ============

def test_breaker_opens_after_the_threshold_and_refuses_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fn, 'milliseconds', lambda: 1_000_000)
    for _ in range(TOKEN_BREAKER_THRESHOLD - 1):
        record_token_failure('app-a', 'IVU10140', 'TOKEN_INVALID')
    throw_if_token_breaker_open('app-a', 'IVU10140')
    record_token_failure('app-a', 'IVU10140', 'TOKEN_INVALID')
    assert kbsec_token_breaker_state('app-a') == {'streak': TOKEN_BREAKER_THRESHOLD, 'openUntil': 1_000_000 + TOKEN_BREAKER_OPEN_MS}
    with pytest.raises(ExchangeNotAvailable) as caught:
        throw_if_token_breaker_open('app-a', 'IVU10140')
    assert caught.value.retryable is False
    # 앱키마다 따로 센다.
    throw_if_token_breaker_open('app-b', 'IVU10140')


def test_breaker_closes_on_a_good_response_and_after_the_open_window(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1_000_000]
    monkeypatch.setattr(fn, 'milliseconds', lambda: now[0])
    for _ in range(TOKEN_BREAKER_THRESHOLD):
        record_token_failure('app-a', 'IVU10140', 'TOKEN_INVALID')
    now[0] += TOKEN_BREAKER_OPEN_MS
    throw_if_token_breaker_open('app-a', 'IVU10140')
    record_kbsec_call_ok('app-a')
    assert kbsec_token_breaker_state('app-a') == {'streak': 0, 'openUntil': 0}
    record_token_failure('app-a', 'IVU10140', 'TOKEN_INVALID')
    reset_kbsec_token_breaker()
    assert kbsec_token_breaker_state('app-a') == {'streak': 0, 'openUntil': 0}


class _ScriptedSession:
    """응답을 순서대로 돌려주는 동기 판 세션. 요청 경로의 끝(`token`, TR 코드)만 기록한다."""

    def __init__(self, replies: List[Dict[str, Any]]) -> None:
        self.replies = replies
        self.seen: List[str] = []

    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        self.seen.append(url.rsplit('/', 1)[-1])
        reply = self.replies[len(self.seen) - 1]
        return SimpleNamespace(status_code=reply['status'], reason='', headers={}, encoding='utf-8',
                               content=json.dumps(reply['body']).encode('utf-8'))

    def close(self) -> None:
        pass


def _broker(replies: List[Dict[str, Any]]) -> Any:
    broker = kr_broker.kbsec({'apiKey': 'app-a', 'secret': 's', 'enableRateLimit': False,
                              'options': {'hostAddr': {'ipAddr': '203.0.113.10', 'macAddr': '00-00-5E-00-53-01'}}})
    broker.session = _ScriptedSession(replies)
    return broker


TOKEN = {'status': 200, 'body': {'dataBody': {'access_token': 'kb-token', 'expires_in': 86400}}}
I445 = {'status': 500, 'body': {'dataHeader': {'processFlag': 'B', 'processCode': 'I445'}, 'dataBody': {}}}


def test_token_failure_after_rotation_is_counted_and_an_open_breaker_sends_nothing() -> None:
    broker = _broker([TOKEN, I445, TOKEN, I445])
    with pytest.raises(kr_broker.AuthenticationError):
        broker.private_post_ssqm1801({})
    assert broker.session.seen == ['token', 'ssqm1801', 'token', 'ssqm1801']
    assert kbsec_token_breaker_state('app-a')['streak'] == 1
    for _ in range(TOKEN_BREAKER_THRESHOLD - 1):
        record_token_failure('app-a', 'SSQM1801', 'TOKEN_INVALID')
    blocked = _broker([])
    with pytest.raises(ExchangeNotAvailable):
        blocked.fetch_ticker('005930/KRW')
    assert blocked.session.seen == []


def test_a_business_rejection_closes_the_breaker_but_a_bare_5xx_does_not() -> None:
    record_token_failure('app-a', 'SSQM1801', 'TOKEN_INVALID')
    with pytest.raises(ExchangeNotAvailable):
        _broker([TOKEN, {'status': 503, 'body': 'down'}]).private_post_ssqm1801({})
    assert kbsec_token_breaker_state('app-a')['streak'] == 1
    with pytest.raises(kr_broker.PermissionDenied):
        _broker([TOKEN, {'status': 500, 'body': {'dataHeader': {'processFlag': 'B', 'processCode': 'I446'}}}]).private_post_ssqm1801({})
    assert kbsec_token_breaker_state('app-a')['streak'] == 0


# ============ price_to_precision ============

def test_price_to_precision_rounds_domestic_stock_prices_with_the_krx_table() -> None:
    broker = kr_broker.kbsec({'apiKey': 'k', 'secret': 's', 'options': {'masterData': MASTER}})
    assert broker.price_to_precision('005930/KRW', 70030) == '70000'
    assert broker.price_to_precision('005930/KRW', 4997) == '4995'
    assert broker.price_to_precision('069500/KRW', 35005) == '35005'
    assert broker.price_to_precision('AAPL/USD', 229.456) == '229.456'


# ============ kbsec_num ============

# 기대값은 TypeScript 판 `kbsecNum` 을 돌려 얻었다. `toFixed` 는 가운데 값을 0 에서 먼 쪽으로 올리고, Python `round` 는 짝수 쪽으로 보낸다.
@pytest.mark.parametrize('value,decimals,expected', [
    (30, 0, '30'), (2.5, 0, '3'), (-2.5, 0, '-3'), (0.03125, 4, '0.0313'), (1.005, 2, '1.00'), (1e-7, 8, '0.00000010'), (float('nan'), 0, '0'),
])
def test_kbsec_num_rounds_like_javascript_to_fixed(value: float, decimals: int, expected: str) -> None:
    assert kbsec_num(value, decimals) == expected
