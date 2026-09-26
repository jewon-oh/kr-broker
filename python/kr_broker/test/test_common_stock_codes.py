"""현금 코드와 같은 티커의 통합 코드 표(`COMMON_STOCK_CODES`, 인스턴스의 `commonStockCodes`). TypeScript 판 `common-stock-codes.test.ts` 와 같다."""

import calendar
from typing import Any, Dict

import pytest

import kr_broker
from kr_broker.broker_market_group import COMMON_STOCK_CODES, common_stock_code, stock_ticker, symbol_base_code
from kr_broker.kis_realtime_parser import to_stream_symbol
from kr_broker.trading_hours import market_session_block_reason

NAME = 'ProShares Ultra Semiconductors'
MASTER: Dict[str, Any] = {
    'kospi': [{'code': '005930', 'name': '삼성전자', 'market': 'KOSPI'}],
    'kosdaq': [],
    'nasdaq': [{'code': 'AAPL', 'name': 'APPLE INC', 'market': 'NAS', 'currency': 'USD'}],
    'nyse': [],
    'amex': [{'code': 'USD', 'name': 'PROSHARES ULTRA SEMICONDUCTORS', 'market': 'AMS', 'currency': 'USD'}],
}


def test_default_table_has_one_row() -> None:
    assert dict(COMMON_STOCK_CODES) == {'USD': NAME}


def test_lookups_ignore_case_and_pass_unknown_codes_through() -> None:
    assert [common_stock_code(t) for t in ('USD', 'usd', 'AAPL')] == [NAME, NAME, 'AAPL']
    assert [stock_ticker(c) for c in (NAME, NAME.lower(), 'USD', 'AAPL')] == ['USD', 'USD', 'USD', 'AAPL']
    assert common_stock_code('USD', {'USD': 'Foo'}) == 'Foo'
    assert stock_ticker('foo', {'USD': 'Foo'}) == 'USD'


def test_symbol_base_code_maps_table_codes_back_to_the_ticker() -> None:
    assert [symbol_base_code(s) for s in (f'{NAME}/USD', 'USD/USD', 'USD')] == ['USD', 'USD', 'USD']


def test_to_stream_symbol_uses_the_table() -> None:
    assert to_stream_symbol('usd') == f'{NAME}/USD'
    assert to_stream_symbol('USD', {'USD': 'Foo'}) == 'Foo/USD'
    assert to_stream_symbol('005930') == '005930/KRW'


def test_market_session_block_reason_finds_the_venue_by_ticker() -> None:
    us_regular = calendar.timegm((2026, 8, 19, 14, 0, 0, 0, 0, 0)) * 1000  # 수요일 10:00 ET
    assert market_session_block_reason('kbsec', f'{NAME}/USD', us_regular, MASTER) is None
    assert market_session_block_reason('kbsec', 'USD/USD', us_regular, MASTER) is None


def _kis(config: Dict[str, Any]) -> Any:
    return kr_broker.kis({**config, 'options': {'masterData': MASTER}})


def _toss(config: Dict[str, Any]) -> Any:
    return kr_broker.toss(config)


@pytest.mark.parametrize('make', [_kis, _toss], ids=['kis', 'toss'])
def test_market_accepts_ticker_old_symbol_and_table_code(make: Any) -> None:
    broker = make({})
    for symbol in ('USD', 'USD/USD', NAME, f'{NAME}/USD', f'{NAME.upper()}/USD'):
        market = broker.market(symbol)
        assert (market['id'], market['baseId'], market['base'], market['quote'], market['symbol']) == ('USD', 'USD', NAME, 'USD', f'{NAME}/USD'), symbol
    assert broker.market('AAPL/USD')['symbol'] == 'AAPL/USD'


@pytest.mark.parametrize('make', [_kis, _toss], ids=['kis', 'toss'])
def test_constructor_overrides_the_table_and_default_codes_still_resolve(make: Any) -> None:
    broker = make({'commonStockCodes': {'USD': 'Foo'}})
    assert broker.market('Foo/USD')['symbol'] == 'Foo/USD'
    assert broker.market('Foo/USD')['id'] == 'USD'
    assert broker.market(f'{NAME}/USD')['symbol'] == 'Foo/USD'


def test_kis_loaded_markets_use_the_table_and_old_symbols_find_them() -> None:
    broker = _kis({})
    broker.load_markets()
    market = broker.markets[f'{NAME}/USD']
    assert (market['id'], market['baseId'], market['base']) == ('USD', 'USD', NAME)
    assert 'USD/USD' not in broker.markets
    assert broker.market('USD/USD') is market
    assert broker.market('USD') is market


def test_toss_old_symbol_returns_the_loaded_market() -> None:
    broker = _toss({})
    broker.set_markets([broker.parse_market({'symbol': 'USD', 'market': 'AMEX'}), broker.parse_market({'symbol': 'AAPL', 'market': 'NASDAQ'})])
    market = broker.markets[f'{NAME}/USD']
    assert (market['id'], market['base']) == ('USD', NAME)
    assert broker.market('USD/USD') is market
    assert broker.safe_market('USD') is market


@pytest.mark.parametrize('codes', [{}, {'USD': 'Zeta Fund'}])
def test_cash_keeps_its_currency_id_when_a_stock_shares_it(codes: Dict[str, str]) -> None:
    broker = kr_broker.kis({'commonStockCodes': codes, 'options': {'masterData': MASTER}})
    broker.load_markets()
    code = broker.common_stock_code('USD')
    assert (broker.currencies[code]['id'], broker.currencies[code]['code']) == ('USD', code)
    assert broker.safe_currency_code('USD') == 'USD'
