"""토스증권 도우미(수수료율, 시장 판정, 세션 판정, 체결 확정, 확장세션 지정가)와 봉 조회. 기대값은 TypeScript 판의 같은 테스트에서 가져왔다."""

import calendar
import logging
import time
from typing import Any, Dict, Iterator, List, Optional

import pytest

import kr_broker
from kr_broker.base import functions as fn
from kr_broker.execution_confirm import confirm_execution, fill_deviation_bps, resolve_confirm_budget, trade_list_probe
from kr_broker.extended_session_limit import build_extended_session_limit
from kr_broker.krx_sell_tax import krx_sell_tax_rate
from kr_broker.market_calendar import reset_market_calendar
from kr_broker.toss_fee import normalize_commission_rate, pick_commission_rate
from kr_broker.toss_trading_hours import (
    find_kr_session, find_us_regular_close_ms, find_us_session, is_toss_orderable, is_toss_trading_open, kr_session_order_restriction,
    time_until_toss_open, toss_kr_calendar_days, toss_us_calendar_days, us_session_order_restriction,
)
from kr_broker.toss_types import get_toss_effective_fee_rate, toss_market_country


def kst(text: str) -> int:
    """`YYYY-MM-DDTHH:MM:SS` 한국 시각 → UTC 밀리초."""
    date, clock = text.split('T')
    y, m, d = (int(x) for x in date.split('-'))
    hh, mm, ss = (int(x) for x in clock.split(':'))
    return (calendar.timegm((y, m, d, hh, mm, ss, 0, 0, 0)) - 9 * 3600) * 1000


@pytest.fixture(autouse=True)
def _calendar() -> Iterator[None]:
    reset_market_calendar()
    yield
    reset_market_calendar()


# ============ 수수료율 ============

@pytest.mark.parametrize('raw,expected', [
    ('0.00015', 0.00015), ('0.001', 0.001), ('0.1', 0.001), ('0.015', 0.00015), ('0.02', 0.0002), ('0.05', 0.0005), ('0', 0),
    (0.00015, 0.00015),
])
def test_normalize_commission_rate(raw: Any, expected: float) -> None:
    assert normalize_commission_rate(raw) == pytest.approx(expected, abs=1e-12)


@pytest.mark.parametrize('raw', ['95', '-1', 'abc', '', ' ', '10'])
def test_normalize_commission_rate_rejects_implausible(raw: str) -> None:
    assert normalize_commission_rate(raw) is None


def test_normalize_commission_rate_null_is_unknown() -> None:
    # 수수료율이 null 로 오면 무료(0%)가 아니라 모르는 값이다. 호출하는 쪽이 기본 요율을 쓴다.
    assert normalize_commission_rate(None) is None
    unknown = {'marketCountry': 'KR', 'commissionRate': None, 'startDate': '2026-08-01', 'endDate': None}
    known = {'marketCountry': 'KR', 'commissionRate': '0.00025', 'startDate': None, 'endDate': None}
    assert pick_commission_rate([unknown, known], 'KR', '2026-08-03') is None


def test_pick_commission_rate() -> None:
    rows = [
        {'marketCountry': 'KR', 'commissionRate': '0', 'startDate': '2026-01-01', 'endDate': '2026-03-31'},
        {'marketCountry': 'KR', 'commissionRate': '0.00025', 'startDate': None, 'endDate': None},
        {'marketCountry': 'KR', 'commissionRate': '0.0001', 'startDate': '2026-06-01', 'endDate': '2026-12-31'},
        {'marketCountry': 'US', 'commissionRate': '0.001', 'startDate': None, 'endDate': None},
    ]
    assert pick_commission_rate(rows, 'KR', '2026-08-03') == 0.0001
    assert pick_commission_rate(rows, 'KR', '2026-05-01') == 0.00025
    assert pick_commission_rate(rows, 'KR', '2026-03-31') == 0
    assert pick_commission_rate([rows[0]], 'KR', '2026-08-03') is None
    assert pick_commission_rate(rows, 'US', '2026-08-03') == 0.001


def test_effective_fee_rate_and_market_country() -> None:
    at = kst('2026-08-03T09:00:00')
    assert get_toss_effective_fee_rate('KR', 'buy', at) == pytest.approx(0.00015)
    assert get_toss_effective_fee_rate('KR', 'sell', at) == pytest.approx(0.00015 + krx_sell_tax_rate(at))
    assert get_toss_effective_fee_rate('US', 'sell', at) == pytest.approx(0.001)
    assert get_toss_effective_fee_rate('KR', 'sell', at, None, True) == pytest.approx(0.00015)
    assert get_toss_effective_fee_rate('KR', 'buy', at, 0) == 0
    for symbol, country in [('005930', 'KR'), ('005930/KRW', 'KR'), ('0101N0', 'KR'), ('0197X0/KRW', 'KR'),
                            ('AAPL', 'US'), ('AAPL/USD', 'US'), ('BRK.B', 'US'), ('T', 'US')]:
        assert toss_market_country(symbol) == country


# ============ 세션 판정 ============

def us_day(d: str, nxt: str) -> Dict[str, Any]:
    return {
        'date': d,
        'dayMarket': {'startTime': f'{d}T09:00:00+09:00', 'endTime': f'{d}T16:50:00+09:00'},
        'preMarket': {'startTime': f'{d}T17:00:00+09:00', 'endTime': f'{d}T22:30:00+09:00'},
        'regularMarket': {'startTime': f'{d}T22:30:00+09:00', 'endTime': f'{nxt}T05:00:00+09:00'},
        'afterMarket': {'startTime': f'{d}T05:00:00+09:00', 'endTime': f'{d}T07:00:00+09:00'},
    }


US_CAL = {'previousBusinessDay': us_day('2026-03-24', '2026-03-25'), 'today': us_day('2026-03-25', '2026-03-26'),
          'nextBusinessDay': us_day('2026-03-26', '2026-03-27')}


def kr_day(d: str) -> Dict[str, Any]:
    return {'date': d, 'integrated': {
        'preMarket': {'startTime': f'{d}T08:00:00+09:00', 'endTime': f'{d}T09:00:00+09:00'},
        'regularMarket': {'startTime': f'{d}T09:00:00+09:00', 'endTime': f'{d}T15:30:00+09:00'},
        'afterMarket': {'startTime': f'{d}T15:30:00+09:00', 'endTime': f'{d}T20:00:00+09:00'},
    }}


KR_CAL = {'previousBusinessDay': kr_day('2026-03-24'), 'today': kr_day('2026-03-25'), 'nextBusinessDay': kr_day('2026-03-26')}


@pytest.mark.parametrize('when,session', [
    ('2026-03-25T09:00:00', 'dayMarket'), ('2026-03-25T14:30:00', 'dayMarket'),
    ('2026-03-25T17:00:00', 'preMarket'), ('2026-03-25T22:29:59', 'preMarket'),
    ('2026-03-25T22:30:00', 'regularMarket'), ('2026-03-26T03:00:00', 'regularMarket'),
    ('2026-03-25T05:30:00', 'afterMarket'), ('2026-03-25T16:55:00', None),
])
def test_find_us_session(when: str, session: Optional[str]) -> None:
    assert find_us_session(US_CAL, kst(when)) == session


def test_find_us_session_holiday_and_close() -> None:
    holiday = {'today': {'date': '2026-07-03', 'dayMarket': None, 'preMarket': None, 'regularMarket': None, 'afterMarket': None}}
    assert find_us_session(holiday, kst('2026-07-03T23:00:00')) is None
    assert find_us_session(None, kst('2026-03-25T21:00:00')) is None
    assert find_us_regular_close_ms(US_CAL, kst('2026-03-26T03:00:00')) == kst('2026-03-26T05:00:00')
    assert find_us_regular_close_ms(US_CAL, kst('2026-03-25T14:00:00')) is None


def test_find_kr_session() -> None:
    assert find_kr_session(KR_CAL, kst('2026-03-25T10:00:00')) == 'regularMarket'
    assert find_kr_session(KR_CAL, kst('2026-03-25T08:30:00')) == 'preMarket'
    assert find_kr_session(KR_CAL, kst('2026-03-25T17:00:00')) == 'afterMarket'
    assert find_kr_session(KR_CAL, kst('2026-03-25T09:00:00')) == 'regularMarket'
    assert find_kr_session(KR_CAL, kst('2026-03-25T15:30:00')) == 'afterMarket'
    assert find_kr_session({'today': {'date': '2026-05-05', 'integrated': None}}, kst('2026-05-05T10:00:00')) is None
    partial = {'today': {'date': '2026-03-25', 'integrated': dict(kr_day('2026-03-25')['integrated'], preMarket=None)}}
    assert find_kr_session(partial, kst('2026-03-25T08:30:00')) is None
    assert find_kr_session(partial, kst('2026-03-25T10:00:00')) == 'regularMarket'
    assert find_kr_session(KR_CAL, kst('2026-03-25T21:00:00')) is None


def test_session_order_restrictions() -> None:
    qty1 = {'isMarket': False, 'useAmountBased': False, 'quantity': 1}
    assert us_session_order_restriction('regularMarket', dict(qty1, isMarket=True)) is None
    assert us_session_order_restriction('regularMarket', dict(qty1, quantity=0.5)) is None
    assert us_session_order_restriction('preMarket', qty1) is None
    assert '금액(orderAmount) 주문은 정규장 전용' in us_session_order_restriction('preMarket', dict(qty1, useAmountBased=True))
    assert '시장가 주문은 정규장 전용' in us_session_order_restriction('preMarket', dict(qty1, isMarket=True))
    assert '소수점 수량 주문은 정규장 전용' in us_session_order_restriction('afterMarket', dict(qty1, quantity=0.5))
    cutoff = {'nowMs': kst('2026-03-26T04:30:00'), 'regularCloseMs': kst('2026-03-26T05:00:00')}
    assert '금액(orderAmount)' in us_session_order_restriction('regularMarket', dict(qty1, useAmountBased=True), cutoff)
    assert '소수점 수량' in us_session_order_restriction('regularMarket', dict(qty1, quantity=0.5), cutoff)
    assert us_session_order_restriction('regularMarket', qty1, cutoff) is None
    assert kr_session_order_restriction('regularMarket', dict(qty1, isMarket=True)) is None
    assert kr_session_order_restriction('afterMarket', qty1) is None
    assert kr_session_order_restriction('afterMarket', dict(qty1, isMarket=True)) == 'KRX afterMarket 세션: 시장가 주문은 정규장 전용 — 지정가로 발주 필요'
    assert kr_session_order_restriction('preMarket', dict(qty1, quantity=2.5)) == 'KRX preMarket 세션: 소수점 수량 주문 불가'


def test_static_fallback() -> None:
    assert is_toss_trading_open(kst('2026-07-16T10:00:00')) is True
    assert is_toss_trading_open(kst('2026-07-16T16:00:00')) is False
    assert is_toss_trading_open(kst('2026-07-16T08:30:00')) is False
    assert is_toss_trading_open(kst('2026-07-18T11:00:00')) is False
    assert time_until_toss_open(kst('2026-07-16T10:00:00')) == 0
    assert time_until_toss_open(kst('2026-07-16T16:00:00')) > 0
    assert is_toss_orderable('AAPL', kst('2026-03-25T23:30:00')) is True  # 10:30 EDT
    assert is_toss_orderable('AAPL', kst('2026-01-14T23:10:00')) is False  # 09:10 EST
    assert is_toss_orderable('005930', kst('2026-03-25T10:00:00')) is True


def open_of(days: List[Dict[str, Any]], date: str) -> Optional[bool]:
    return next((day['open'] for day in days if day['date'] == date), None)


def test_toss_calendar_days() -> None:
    days = toss_kr_calendar_days({'previousBusinessDay': kr_day('2026-10-02'), 'today': {'date': '2026-10-05', 'integrated': None},
                                  'nextBusinessDay': kr_day('2026-10-06')})
    assert open_of(days, '20261005') is False and open_of(days, '20261002') is True and open_of(days, '20261006') is True
    assert toss_kr_calendar_days(None) == []
    us = toss_us_calendar_days({'previousBusinessDay': us_day('2026-12-24', '2026-12-25'),
                                'today': {'date': '2026-12-25', 'dayMarket': None, 'preMarket': None, 'regularMarket': None, 'afterMarket': None},
                                'nextBusinessDay': us_day('2026-12-28', '2026-12-29')})
    assert open_of(us, '20261225') is False and open_of(us, '20261224') is True and open_of(us, '20261228') is True
    assert toss_us_calendar_days(None) == []


def test_toss_us_calendar_days_missing_session_keys_and_date() -> None:
    # 세션 키가 아예 없는 날도 세션이 없는 날(닫힌 날)이다.
    missing = toss_us_calendar_days({'previousBusinessDay': us_day('2026-12-24', '2026-12-25'), 'today': {'date': '2026-12-25'},
                                     'nextBusinessDay': us_day('2026-12-28', '2026-12-29')})
    assert open_of(missing, '20261225') is False and open_of(missing, '20261224') is True and open_of(missing, '20261228') is True
    # 날짜가 없는 항목은 건너뛴다.
    skipped = toss_us_calendar_days({'previousBusinessDay': {}, 'today': us_day('2026-12-24', '2026-12-25'),
                                     'nextBusinessDay': us_day('2026-12-28', '2026-12-29')})
    assert open_of(skipped, '20261224') is True and open_of(skipped, '20261228') is True
    assert all(len(day['date']) == 8 and day['date'].isdigit() for day in skipped)


# ============ 체결 확정 ============

def poller(snapshots: List[Any]) -> Any:
    calls = {'count': 0}

    def probe(attempt: int) -> Dict[str, Any]:
        calls['count'] += 1
        item = snapshots[min(attempt, len(snapshots)) - 1]
        if isinstance(item, Exception):
            raise item
        return item

    probe.calls = calls  # type: ignore[attr-defined]
    return probe


def test_confirm_execution_polls_until_terminal() -> None:
    pending = {'snapshot': None, 'terminal': False}
    filled = {'snapshot': {'filled': 4, 'average': 114100}, 'terminal': True}
    probe = poller([pending, pending, filled])
    assert confirm_execution('[t]', 'o1', 't', probe, budget={'intervalMs': 0}) == {'filled': 4, 'average': 114100}
    assert probe.calls['count'] == 3
    canceled = poller([{'snapshot': None, 'terminal': True}])
    assert confirm_execution('[t]', 'o1', 't', canceled, budget={'intervalMs': 0}) is None and canceled.calls['count'] == 1
    partial = poller([{'snapshot': {'filled': 1}, 'terminal': False}, {'snapshot': {'filled': 2}, 'terminal': False}])
    assert confirm_execution('[t]', 'o1', 't', partial, budget={'attempts': 3, 'intervalMs': 0}) == {'filled': 2}
    flaky = poller([RuntimeError('x'), RuntimeError('y'), filled])
    assert confirm_execution('[t]', 'o1', 't', flaky, budget={'intervalMs': 0})['filled'] == 4


def test_resolve_confirm_budget_layers() -> None:
    assert resolve_confirm_budget() == {'attempts': 6, 'intervalMs': 350}
    assert resolve_confirm_budget({'attempts': 5, 'intervalMs': 1000}, {'intervalMs': 50}) == {'attempts': 5, 'intervalMs': 50}
    assert resolve_confirm_budget({'attempts': 5}) == {'attempts': 5, 'intervalMs': 350}
    assert resolve_confirm_budget({'attempts': 5, 'intervalMs': 1000}, {'attempts': 0, 'intervalMs': 20_000}) == {'attempts': 5, 'intervalMs': 1000}
    assert resolve_confirm_budget(None, {'attempts': 1.5}) == {'attempts': 6, 'intervalMs': 350}


def test_trade_list_probe_and_deviation() -> None:
    rows = [{'order': 'o1', 'amount': 1, 'price': 100, 'cost': 100, 'fee': {'cost': 0.3}},
            {'order': 'o1', 'amount': 3, 'price': 200, 'cost': 600, 'fee': {'cost': 0.5}},
            {'order': 'o2', 'amount': 9, 'price': 1, 'cost': 9}]
    result = trade_list_probe(lambda: rows, 'o1', 4, 'KRW')()
    assert result['terminal'] is True
    assert result['snapshot'] == {'filled': 4, 'average': 175, 'amount': 700, 'fee': 0.8, 'feeCurrency': 'KRW'}
    assert trade_list_probe(lambda: rows, 'o1', 5)()['terminal'] is False
    assert trade_list_probe(lambda: [], 'o1', 5)() == {'snapshot': None, 'terminal': False}
    assert fill_deviation_bps(114200, 114100) == -9
    assert fill_deviation_bps(100, 101) == 100
    assert fill_deviation_bps(None, 100) is None and fill_deviation_bps(0, 100) is None


# ============ 확장세션 지정가 ============

class Source:
    def __init__(self, open_orders: Any = (), ticker: Any = None) -> None:
        self.open_orders = open_orders
        self.ticker = ticker

    def fetch_open_orders(self, symbol: str) -> List[Dict[str, Any]]:
        if isinstance(self.open_orders, Exception):
            raise self.open_orders
        return list(self.open_orders)

    def fetch_ticker(self, symbol: str) -> Dict[str, Any]:
        if isinstance(self.ticker, Exception):
            raise self.ticker
        return {'last': self.ticker}


def test_build_extended_session_limit() -> None:
    order = {'symbol': 'AAPL', 'side': 'sell'}
    assert build_extended_session_limit(Source(ticker=231.5), order, '[T]') == {'price': 231.5}
    dup = build_extended_session_limit(Source([{'id': 'x', 'side': 'SELL'}], 231.5), order, '[T]')
    assert '중복 발주' in dup['error']
    assert build_extended_session_limit(Source([{'id': 'x', 'side': 'buy'}], 231.5), order, '[T]') == {'price': 231.5}
    warned: List[str] = []
    failed = build_extended_session_limit(Source(RuntimeError('down'), 231.5), order, '[T]', lambda err, msg: warned.append(msg))
    assert '조회 실패' in failed['error'] and warned
    assert '기준가' in build_extended_session_limit(Source(ticker=None), order, '[T]')['error']
    assert '기준가' in build_extended_session_limit(Source(ticker=RuntimeError('boom')), order, '[T]')['error']
    assert '기준가' in build_extended_session_limit(Source(ticker=0), order, '[T]')['error']


# ============ 봉 ============

def _daily_pages(per_page: int) -> Any:
    """`before`(없으면 07-21 0시) 전날부터 거꾸로 하루 한 봉씩, 쪽마다 `per_page` 봉을 준다. 종가는 그날의 일(日)이다."""
    def candles(params: Dict[str, Any]) -> Dict[str, Any]:
        before = params.get('before')
        end = fn.parse8601(before) if before is not None else kst('2026-07-21T00:00:00')
        rows = []
        for i in range(per_page):
            day = time.gmtime((end - (i + 1) * 86_400_000 + 9 * 3_600_000) // 1000)
            stamp = f'{day.tm_year:04d}-{day.tm_mon:02d}-{day.tm_mday:02d}T00:00:00+09:00'
            price = str(day.tm_mday)
            rows.append({'timestamp': stamp, 'openPrice': price, 'highPrice': price, 'lowPrice': price, 'closePrice': price, 'volume': '100'})
        return {'result': {'candles': rows, 'nextBefore': rows[-1]['timestamp']}}

    return candles


def test_fetch_ohlcv_since_reads_back_from_since() -> None:
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    seen: List[Dict[str, Any]] = []
    pages = _daily_pages(3)
    broker.private_market_get_candles = lambda params: seen.append(params) or pages(params)
    rows = broker.fetch_ohlcv('005930', '1d', kst('2026-07-11T00:00:00'), 3)
    assert [row[4] for row in rows] == [11, 12, 13]
    assert [params['count'] for params in seen] == [200, 200, 200, 200]


def test_fetch_ohlcv_warns_when_page_cap_stops_before_since(caplog: pytest.LogCaptureFixture) -> None:
    broker = kr_broker.toss({'apiKey': 'k', 'secret': 's'})
    seen: List[Dict[str, Any]] = []
    pages = _daily_pages(1)
    broker.private_market_get_candles = lambda params: seen.append(params) or pages(params)
    with caplog.at_level(logging.WARNING, logger='kr_broker'):
        rows = broker.fetch_ohlcv('005930', '1d', kst('2026-01-01T00:00:00'), 2)
    assert len(seen) == 10
    assert [row[4] for row in rows] == [11, 12]
    assert any('since 까지 받지 못했다' in record.getMessage() for record in caplog.records)
