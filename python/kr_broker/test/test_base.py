"""기반 계층(`kr_broker.base`) 단위 테스트. 기대값은 TypeScript 판이 도는 JavaScript 런타임(node)으로 계산한 값이다."""

import hashlib
import re
from decimal import Decimal
from typing import Any, Dict, List, Optional

import pytest

import kr_broker
from kr_broker.base import functions as fn
from kr_broker.base.errors import BadRequest, BaseError, MarketClosed, OrderOutcomeUnknown, RequestTimeout
from kr_broker.base.exchange import Exchange
from kr_broker.base.throttler import Throttler
from kr_broker.base.token_store import refresh_token_with_lock


# ============ JavaScript 와 같은 문자열 변환 ============

@pytest.mark.parametrize('value,expected', [
    (0.1, '0.1'), (5.0, '5'), (-0.0, '0'), (71000, '71000'), (228.5, '228.5'), (1e21, '1e+21'), (1.5e21, '1.5e+21'),
    (1e-7, '1e-7'), (1.5e-7, '1.5e-7'), (0.000001, '0.000001'), (1.5e-6, '0.0000015'), (123456789012345680000.0, '123456789012345680000'),
    (0.1 + 0.2, '0.30000000000000004'), (-12.5, '-12.5'),
])
def test_js_number_string(value: float, expected: str) -> None:
    assert fn.js_number_string(value) == expected


def test_js_string_booleans_and_lists() -> None:
    assert fn.js_string(True) == 'true'
    assert fn.js_string([1, 'a', None]) == '1,a,'


def test_urlencode_matches_encode_uri_component() -> None:
    assert fn.urlencode({'a': 'x y', 'b': "!~*'()", 'c': '한', 'd': None, 'e': True}) == "a=x%20y&b=!~*'()&c=%ED%95%9C&e=true"


def test_form_urlencode_matches_url_search_params() -> None:
    assert fn.form_urlencode({'a': "x y!~'()*-._"}) == 'a=x+y%21%7E%27%28%29*-._'


def test_json_stringify_matches_javascript() -> None:
    assert fn.json_stringify({'a': 71000.0, 'b': '한"', 'c': [1.5, None, True], 'd': {}}) == '{"a":71000,"b":"한\\"","c":[1.5,null,true],"d":{}}'


# ============ 시각 ============

def test_iso8601() -> None:
    assert fn.iso8601(0) == '1970-01-01T00:00:00.000Z'
    assert fn.iso8601(1790219606532) == '2026-09-24T03:13:26.532Z'
    assert fn.iso8601('1790219606532') == '2026-09-24T03:13:26.532Z'
    assert fn.iso8601(-1) is None
    assert fn.iso8601('abc') is None
    assert fn.iso8601(True) is None


@pytest.mark.parametrize('text,expected', [
    ('2026-09-24T02:33:26.532Z', 1790217206532),
    ('2026-09-24T11:33:26.532+09:00', 1790217206532),
    ('2026-09-24T11:33:26.532+0900', 1790217206532),
    ('2026-09-24 02:33:26', 1790217206000),
    ('2026-09-24T02:33', 1790217180000),
    ('20260924', None),
    ('2026-09-24', None),
    ('', None),
])
def test_parse8601(text: str, expected: Optional[int]) -> None:
    assert fn.parse8601(text) == expected


def test_parse_timeframe() -> None:
    assert fn.parse_timeframe('1m') == 60
    assert fn.parse_timeframe('1d') == 86400


# ============ safe* ============

def test_safe_string_treats_empty_and_none_as_missing() -> None:
    row = {'a': '', 'b': None, 'c': 0, 'd': 1.0, 'e': False, 'f': 'x'}
    assert fn.safe_string(row, 'a', 'd') == 'd'
    assert fn.safe_string(row, 'b') is None
    assert fn.safe_string(row, 'c') == '0'
    assert fn.safe_string(row, 'd') == '1'
    assert fn.safe_string(row, 'e') is None  # 불리언은 숫자가 아니다
    assert fn.safe_string_2(row, 'a', 'f') == 'x'


def test_safe_number_and_integer() -> None:
    row = {'a': '12.7', 'b': '12abc', 'c': ' 5 ', 'd': '1e3', 'e': 'NaN'}
    assert fn.safe_number(row, 'a') == 12.7
    assert fn.safe_integer(row, 'a') == 12
    assert fn.safe_float(row, 'b') == 12.0  # parseFloat 처럼 앞부분을 읽는다
    assert fn.safe_integer(row, 'b') is None  # Number() 처럼 전체가 숫자여야 한다
    assert fn.safe_integer(row, 'c') == 5
    assert fn.safe_integer(row, 'd') == 1000
    assert fn.safe_number(row, 'e', 7) == 7


def test_decimal_values_read_as_numbers() -> None:
    # ccxt 처럼 사용자가 넘긴 `Decimal` 을 숫자로 읽는다. 전에는 `safe_*` 가 `None` 을 돌려줘 조건주문 가격과 금액이 빠졌다.
    params = {'triggerPrice': Decimal('64000'), 'cost': Decimal('1.5'), 'big': Decimal('1E+2'), 'nan': Decimal('NaN')}
    assert fn.safe_number(params, 'triggerPrice') == 64000.0
    assert fn.safe_string(params, 'cost') == '1.5'
    assert fn.safe_integer(params, 'big') == 100
    assert fn.safe_number(params, 'nan', 7) == 7
    assert isinstance(fn.safe_value(params, 'cost'), float)
    assert fn.decimal_to_float(Decimal('0.1')) == 0.1
    assert fn.decimal_to_float('0.1') == '0.1'
    # 요청 본문과 쿼리에도 숫자로 쓴다(따옴표로 감싼 문자열이나 지수 표기가 아니다).
    assert fn.json_stringify({'qty': Decimal('3'), 'price': Decimal('1E+2')}) == '{"qty":3,"price":100}'
    assert fn.js_string(Decimal('1E+2')) == '100'


def test_safe_list_index_and_dict() -> None:
    assert fn.safe_value([10, 20], 1) == 20
    assert fn.safe_value([10, 20], 5, 'x') == 'x'
    assert fn.safe_dict({'a': []}, 'a') is None
    assert fn.safe_list({'a': []}, 'a') == []


def test_deep_extend_does_not_share_nested_dicts() -> None:
    base = {'options': {'a': 1, 'nested': {'x': 1}}}
    merged = fn.deep_extend(base, {'options': {'b': 2, 'nested': {'y': 2}}})
    merged['options']['nested']['x'] = 99
    assert base['options']['nested']['x'] == 1
    assert merged['options'] == {'a': 1, 'b': 2, 'nested': {'x': 99, 'y': 2}}


def test_omit_and_implode_params() -> None:
    assert fn.omit({'a': 1, 'b': 2, 'c': 3}, 'a', ['b']) == {'c': 3}
    assert fn.implode_params('stocks/{symbol}/warnings', {'symbol': '005930', 'x': 1}) == 'stocks/005930/warnings'
    assert fn.extract_params('a/{b}/{c-d}') == ['b', 'c-d']


def test_number_to_string_has_no_exponent() -> None:
    assert fn.number_to_string(1e-8) == '0.00000001'
    assert fn.number_to_string(1e21) == '1000000000000000000000'
    assert fn.number_to_string(5.0) == '5'


def test_precision_from_string() -> None:
    assert fn.precision_from_string('0.0001') == 4
    assert fn.precision_from_string('1e-4') == 4
    assert fn.precision_from_string('100') == 0


# ============ Exchange ============

def test_camelcase_aliases_follow_ccxt() -> None:
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    assert broker.fetchOHLCV.__func__ is kr_broker.toss.fetch_ohlcv
    assert broker.loadMarkets.__func__ is kr_broker.toss.load_markets
    assert broker.safeString({'a': 1}, 'a') == '1'
    assert callable(broker.private_market_get_exchange_rate) and callable(broker.privateMarketGetExchangeRate)


def test_describe_merges_user_config() -> None:
    broker = kr_broker.kis({'apiKey': 'k', 'secret': 's', 'uid': 'u', 'options': {'maxRetriesOnFailure': 1}})
    assert broker.options['maxRetriesOnFailure'] == 1
    assert broker.options['maxRetriesOnFailureDelay'] == 500
    assert broker.has['sandbox'] is True


def test_check_required_credentials() -> None:
    broker = kr_broker.kis({'apiKey': 'k', 'secret': 's'})
    with pytest.raises(kr_broker.AuthenticationError):
        broker.check_required_credentials()
    assert broker.check_required_credentials(False) is False


def test_handle_until_param_and_limit_rows() -> None:
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    until, rest = broker.handle_until_param('fetchX', 10, {'until': 1_780_000_000_000, 'other': 'x'})
    assert until == 1_780_000_000_000 and rest == {'other': 'x'}
    with pytest.raises(BadRequest):
        broker.handle_until_param('fetchX', 1_780_000_000_000, {})
    rows = [{'timestamp': 3}, {'timestamp': 2}, {'timestamp': 1}]
    assert broker.limit_rows(rows, None, 2) == [{'timestamp': 3}, {'timestamp': 2}]
    assert broker.limit_rows(rows, 1, 2) == [{'timestamp': 2}, {'timestamp': 1}]


def test_kst_stamp() -> None:
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    assert broker.kst_stamp('20260922', '153000') == {'timestamp': 1790058600000, 'datetime': '2026-09-22T06:30:00.000Z'}
    assert broker.kst_stamp('20260922', '93000')['timestamp'] == 1790037000000
    assert broker.kst_stamp('') == {'timestamp': None, 'datetime': None}


def test_safe_ticker_fills_change_and_percentage() -> None:
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    ticker = broker.safe_ticker({'symbol': '005930/KRW', 'open': '70000', 'last': '71400'})
    assert ticker['last'] == 71400 and ticker['change'] == 1400 and ticker['percentage'] == 2


def test_safe_order_derives_remaining_and_cost() -> None:
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    order = broker.safe_order({'id': '1', 'amount': '10', 'filled': '4', 'price': '100', 'status': 'open', 'type': 'limit'})
    assert order['remaining'] == 6 and order['cost'] == 400 and order['timeInForce'] is None


def test_filter_by_since_limit() -> None:
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    rows = [{'timestamp': 1}, {'timestamp': 2}, {'timestamp': 3}]
    assert broker.filter_by_since_limit(rows, 2) == [{'timestamp': 2}, {'timestamp': 3}]
    assert broker.filter_by_since_limit(rows, None, 2) == [{'timestamp': 2}, {'timestamp': 3}]


def test_kis_sandbox_switches_domain_tr_and_rate_limit() -> None:
    broker = kr_broker.kis({'apiKey': 'k', 'secret': 's', 'uid': 'u'})
    assert broker.tr('TTTC8434R') == 'TTTC8434R'
    broker.set_sandbox_mode(True)
    assert broker.tr('TTTC8434R') == 'VTTC8434R'
    assert broker.tr('TTTC0012U', 'VTTC0012U') == 'VTTC0012U'
    with pytest.raises(kr_broker.NotSupported):
        broker.tr('CTSC9215R', None)
    assert broker.urls['api']['private'].startswith('https://openapivts.')
    assert broker.rateLimit == 500


# ============ 오류 ============

def test_errors_keep_detail_and_retryable() -> None:
    error = kr_broker.InsufficientFunds('부족', detail='insufficient-buying-power')
    assert isinstance(error, kr_broker.ExchangeError) and error.detail == 'insufficient-buying-power'
    assert MarketClosed('장 마감').retryable is False
    assert OrderOutcomeUnknown('모름').retryable is False and isinstance(OrderOutcomeUnknown(), RequestTimeout)
    assert BaseError('x').retryable is None


# ============ 조절기와 토큰 락 ============

def test_throttler_waits_rate_limit_times_cost() -> None:
    now = [0.0]
    slept: List[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        now[0] += seconds

    throttler = Throttler(refill_rate=1 / 100, clock=lambda: now[0], sleep=sleep)
    throttler.throttle(1)
    throttler.throttle(2)
    throttler.throttle(1)
    assert [round(s, 3) for s in slept] == [0.1, 0.2]


class _Store:
    def __init__(self, lock_ok: bool, cached: Optional[str] = None) -> None:
        self.lock_ok = lock_ok
        self.cached = cached
        self.unlocked: List[str] = []

    def try_lock(self, key: str, owner: str, ttl_ms: int) -> bool:
        return self.lock_ok

    def unlock(self, key: str, owner: str) -> None:
        self.unlocked.append(key)


def test_refresh_token_with_lock_issues_when_locked() -> None:
    store: Any = _Store(lock_ok=True)
    assert refresh_token_with_lock('[t]', store, 'k', 1000, lambda: None, lambda: 'new') == 'new'
    assert store.unlocked == ['k:lock']


def test_refresh_token_with_lock_uses_other_process_token() -> None:
    store: Any = _Store(lock_ok=False)
    calls: Dict[str, int] = {'issue': 0}

    def issue() -> str:
        calls['issue'] += 1
        return 'mine'

    token = refresh_token_with_lock('[t]', store, 'k', 1000, lambda: 'theirs', issue, sleep=lambda s: None)
    assert token == 'theirs' and calls['issue'] == 0


def test_refresh_token_with_lock_without_store_issues() -> None:
    assert refresh_token_with_lock('[t]', None, 'k', 1000, lambda: None, lambda: 'new') == 'new'


def test_token_store_key_hashes_whole_credential() -> None:
    from kr_broker.base.token_store import legacy_token_store_key, token_store_key
    a = token_store_key('toss:token:', 'client-shared-prefix-A')
    b = token_store_key('toss:token:', 'client-shared-prefix-B')
    assert a != b and re.fullmatch(r'toss:token:[0-9a-f]{32}', a) and 'client-shar' not in a
    # TS 판(`tokenStoreKey`)과 같은 값이다. 두 판이 한 저장소를 나눠 쓴다.
    assert token_store_key('kis:token:', 'kis-app-key-abcdefgh') == 'kis:token:' + hashlib.sha256(b'kis-app-key-abcdefgh').hexdigest()[:32]
    assert legacy_token_store_key('toss:token:', 'client-shared-prefix-A') == 'toss:token:client-share'


def test_legacy_key_token_store_reads_old_writes_both_and_locks_old() -> None:
    from kr_broker.base.token_store import LegacyKeyTokenStore
    data: Dict[str, str] = {'old': 'v-old'}
    locks: List[str] = []

    class Store:
        def get(self, key: str) -> Optional[str]:
            return data.get(key)

        def set(self, key: str, value: str, ttl_ms: int) -> None:
            data[key] = value

        def delete(self, key: str) -> None:
            data.pop(key, None)

        def delete_if_access_token_equals(self, key: str, access_token: str) -> bool:
            return False

        def try_lock(self, key: str, owner: str, ttl_ms: int) -> bool:
            locks.append(key)
            return True

        def unlock(self, key: str, owner: str) -> None:
            pass

    store = LegacyKeyTokenStore(Store(), {'new': 'old'})
    assert store.get('new') == 'v-old'
    store.set('new', 'v', 1)
    assert data == {'old': 'v', 'new': 'v'}
    assert store.try_lock('new:lock', 'me', 1) and locks == ['old:lock']


def test_kst_stamp_empties_dates_that_are_not_on_the_calendar() -> None:
    broker = Exchange({})
    for ymd in ('00000000', '20261300', '20260230', '20260000'):
        assert broker.kst_stamp(ymd, '153000') == {'timestamp': None, 'datetime': None}, ymd


def test_sync_session_ignores_netrc_and_proxy_env_and_close_keeps_user_session() -> None:
    assert Exchange({}).session.trust_env is False

    class UserSession:
        closed = False

        def close(self) -> None:
            UserSession.closed = True

    shared = UserSession()
    broker = Exchange({'session': shared})
    broker.close()
    assert UserSession.closed is False and broker.session is shared
    owned = Exchange({})
    owned.close()
    assert owned.session is None


def test_sync_reads_text_without_charset_as_utf8() -> None:
    class Response:
        status_code = 502
        reason = 'Bad Gateway'
        headers = {'Content-Type': 'text/html'}
        encoding = 'ISO-8859-1'          # requests 가 charset 없는 text/* 에 주는 값
        content = '<html>게이트웨이 오류</html>'.encode('utf-8')

    broker = Exchange({})
    with pytest.raises(Exception):
        broker.handle_rest_response(Response(), 'https://example.com/x')
    assert broker.last_http_response == '<html>게이트웨이 오류</html>'


def test_toss_us_fractional_sell_quantity_is_truncated_as_decimal() -> None:
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    broker.market = lambda symbol: {'id': 'AAPL', 'symbol': 'AAPL/USD', 'base': 'AAPL', 'quote': 'USD', 'info': {'market': 'US'}}  # type: ignore[method-assign]
    broker._country_of = lambda market: 'US'  # type: ignore[method-assign]
    for amount, expected in ((8.2, 8.2), (1.005, 1.005), (1.001, 1.001), (0.1234567, 0.123456)):
        assert broker.normalize_quantity('AAPL', 'market', 'sell', amount) == expected, amount


def test_kis_balance_merges_rows_of_the_same_holding_and_subtracts_usd_as_decimal() -> None:
    broker = kr_broker.kis({'apiKey': 'k', 'secret': 's', 'uid': '12345678-01'})
    balance = broker.parse_balance({
        'domestic': {'summary': {'dnca_tot_amt': '0'}, 'holdings': [
            {'pdno': '005930', 'trad_dvsn_name': '현금', 'hldg_qty': '10', 'ord_psbl_qty': '10'},
            {'pdno': '005930', 'trad_dvsn_name': '자기융자', 'hldg_qty': '5', 'ord_psbl_qty': '3'},
        ]},
        'usd': {'currencies': [{'crcy_cd': 'USD', 'frcr_dncl_amt_2': '1000.1', 'frcr_buy_mgn_amt': '200.2'}], 'stocks': []},
    })
    assert (balance['005930']['free'], balance['005930']['total']) == (13, 15)
    assert len(balance['005930']['info']['rows']) == 2 and balance['005930']['info']['trad_dvsn_name'] == '현금'
    assert (balance['USD']['free'], balance['USD']['used'], balance['USD']['total']) == (799.9, 200.2, 1000.1)


def test_kis_change_sign_falls_back_to_the_sign_code_when_the_rate_rounds_to_zero() -> None:
    from kr_broker.kis import _signed_change
    assert _signed_change('50', '0.00', '5') == '-50'
    assert _signed_change('50', '0.00', '2') == '50'
    assert _signed_change('500', '-0.71', '2') == '-500'
    assert _signed_change('0', '0.00', '3') == '0'


def test_kis_market_works_without_master_data() -> None:
    broker = kr_broker.kis({'apiKey': 'k', 'secret': 's', 'uid': '12345678-01'})
    assert broker.market('005930/KRW')['symbol'] == '005930/KRW'
    broker.load_markets()
    assert broker.amount_to_precision('005930/KRW', 3.7) == '3'
    assert broker.market('AAPL/USD')['quote'] == 'USD'


def test_toss_domestic_cost_order_is_not_supported_before_any_request() -> None:
    from kr_broker.base.errors import NotSupported
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    with pytest.raises(NotSupported):
        broker.create_market_buy_order_with_cost('005930', 100000)


def test_exchange_closed_by_user_is_an_exchange_error() -> None:
    from kr_broker.base.errors import ExchangeClosedByUser, ExchangeError
    assert issubclass(ExchangeClosedByUser, ExchangeError) and kr_broker.ExchangeClosedByUser is ExchangeClosedByUser


def test_non_https_urls_are_rejected_before_sending() -> None:
    from kr_broker.base.exchange import assert_secure_url

    with pytest.raises(BadRequest):
        assert_secure_url('x', 'http://openapi.example.com/a', False)
    for url in ('https://openapi.example.com/a', 'http://127.0.0.1:8080/a', 'http://localhost/a', 'http://[::1]:9/a'):
        assert_secure_url('x', url, False)
    assert_secure_url('x', 'http://openapi.example.com/a', True)

    class Boom:
        def request(self, *args: object, **kwargs: object) -> None:
            raise AssertionError('보내면 안 된다')

    broker = Exchange({'session': Boom()})
    with pytest.raises(BadRequest):
        broker.http_request('GET', 'http://openapi.example.com/a')
