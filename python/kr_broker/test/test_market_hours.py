"""휴장일 캘린더와 장 시간 판정. 기대값은 TypeScript 판의 같은 테스트(`ts/src/__tests__/*-hours.test.ts`, `market-calendar.test.ts`)에서 가져왔다."""

import calendar
from typing import Any, Iterator

import pytest

from kr_broker import us_market_hours
from kr_broker.krx_sell_tax import krx_sell_tax_rate
from kr_broker.krx_trading_hours import (
    check_krx_trading_hours_at, get_krx_market_phase, get_nxt_session, get_time_until_krx_open, is_krx_business_day_kst,
    is_nxt_extended_tradable, krx_order_block_reason,
)
from kr_broker.market_calendar import (
    expand_business_days, is_market_closed_day, market_calendar_status, market_day_status, refresh_market_calendar,
)
from kr_broker.testing import apply_market_calendar, reset_market_calendar
from kr_broker.trading_hours import get_time_until_market_open, is_trading_hours, market_session_block_reason, trading_hours_block_reason
from kr_broker.us_market_hours import (
    et_wall_clock_to_utc_ms, format_et_wall_clock, get_time_until_us_market_open, get_us_market_phase, us_order_block_reason,
)

HOUR = 60 * 60 * 1000
KR_CLOSED_DAYS = ['20260505', '20260924', '20260925']
US_CLOSED_DAYS = ['20260525', '20260703', '20261225']


def utc(year: int, month: int, day: int, hour: int, minute: int = 0) -> int:
    return calendar.timegm((year, month, day, hour, minute, 0, 0, 0, 0)) * 1000


@pytest.fixture(autouse=True)
def _calendar() -> Iterator[None]:
    reset_market_calendar()
    apply_market_calendar('KR', [{'date': d, 'open': False} for d in KR_CLOSED_DAYS])
    apply_market_calendar('US', [{'date': d, 'open': False} for d in US_CLOSED_DAYS])
    yield
    reset_market_calendar()


# ============ 휴장일 캘린더 ============

def test_market_day_status_and_weekend() -> None:
    assert market_day_status('KR', '20260505') == 'closed'
    assert is_market_closed_day('KR', '20260505') is True
    assert market_day_status('KR', '20260506') == 'unknown'
    assert market_day_status('KR', '20260509') == 'closed'  # 토요일
    assert market_day_status('KR', '20260231') == 'unknown'  # 없는 날짜


def test_apply_market_calendar_drops_weekend_and_bad_dates() -> None:
    reset_market_calendar()
    apply_market_calendar('KR', [{'date': '20261003', 'open': False}, {'date': 'x', 'open': False}, {'date': '20261005', 'open': True}])
    assert market_calendar_status('KR')['knownDays'] == 1
    assert market_calendar_status('KR')['latestDate'] == '20261005'


def test_expand_business_days_closes_gaps_between_open_days() -> None:
    days = expand_business_days(['20261006', '20261002'], ['20261009'])
    assert days == [
        {'date': '20261002', 'open': True}, {'date': '20261003', 'open': False}, {'date': '20261004', 'open': False},
        {'date': '20261005', 'open': False}, {'date': '20261006', 'open': True}, {'date': '20261009', 'open': False},
    ]


def test_refresh_market_calendar_keeps_fresh_and_backs_off_after_failure() -> None:
    reset_market_calendar()
    calls = {'n': 0}

    def fetch_ok() -> Any:
        calls['n'] += 1
        return [{'date': '20261005', 'open': False}]

    assert refresh_market_calendar('KR', fetch_ok, 60_000, now_ms=1_000) is True
    assert refresh_market_calendar('KR', fetch_ok, 60_000, now_ms=2_000) is True
    assert calls['n'] == 1
    assert market_calendar_status('KR')['refreshedAtMs'] == 1_000

    def fetch_fail() -> Any:
        raise RuntimeError('down')

    assert refresh_market_calendar('US', fetch_fail, 60_000, now_ms=1_000) is False
    assert refresh_market_calendar('US', fetch_ok, 60_000, now_ms=2_000) is False  # 10분 안에는 다시 부르지 않는다
    assert calls['n'] == 1


# ============ KRX ============

def test_check_krx_trading_hours_reasons() -> None:
    assert check_krx_trading_hours_at(utc(2026, 5, 22, 2)) == {'tradable': True}
    assert check_krx_trading_hours_at(utc(2026, 5, 21, 23, 59))['reason'] == '장 개장 전 (현재: 8:59 KST, 개장: 9:00)'
    assert check_krx_trading_hours_at(utc(2026, 5, 22, 6, 30))['reason'] == '장 마감 (현재: 15:30 KST, 마감: 15:30)'
    assert check_krx_trading_hours_at(utc(2026, 5, 23, 2))['reason'] == '주말 — KRX 휴장'
    assert check_krx_trading_hours_at(utc(2026, 5, 5, 2))['reason'] == '공휴일 — KRX 휴장 (0505)'


@pytest.mark.parametrize('now,phase', [
    (utc(2026, 5, 23, 12), 'closed'),
    (utc(2026, 5, 5, 2), 'closed'),
    (utc(2026, 5, 22, 7), 'closed'),
    (utc(2026, 5, 21, 23, 45), 'pre-auction'),
    (utc(2026, 5, 22, 2), 'open'),
    (utc(2026, 5, 22, 6), 'open'),
    (utc(2026, 5, 22, 6, 25), 'closing-auction'),
    (utc(2026, 5, 22, 0), 'open'),
    (utc(2026, 5, 22, 6, 30), 'closed'),
])
def test_krx_market_phase(now: int, phase: str) -> None:
    assert get_krx_market_phase(now) == phase


def test_time_until_krx_open() -> None:
    assert get_time_until_krx_open(utc(2026, 5, 22, 2)) == 0
    assert get_time_until_krx_open(utc(2026, 5, 22, 6, 30)) == 65.5 * HOUR  # 금 마감 → 월 09:00
    assert get_time_until_krx_open(utc(2026, 5, 22, 13)) == 59 * HOUR
    assert get_time_until_krx_open(utc(2026, 5, 4, 7)) == 41 * HOUR  # 월 16:00 → 어린이날(화) 건너뛰고 수 09:00
    assert get_time_until_krx_open(utc(2026, 5, 21, 23, 59)) == 60 * 1000


@pytest.mark.parametrize('now,session', [
    (utc(2026, 5, 21, 23, 30), 'pre-market'),
    (utc(2026, 5, 21, 23, 55), 'pre-pause'),
    (utc(2026, 5, 22, 2), 'main'),
    (utc(2026, 5, 22, 6, 25), 'krx-closing-auction'),
    (utc(2026, 5, 22, 6, 30), 'after-market'),
    (utc(2026, 5, 22, 10, 59), 'after-market'),
    (utc(2026, 5, 22, 11), 'closed'),
    (utc(2026, 5, 21, 22, 30), 'closed'),
    (utc(2026, 5, 23, 7), 'closed'),
    (utc(2026, 5, 5, 7), 'closed'),
])
def test_nxt_session(now: int, session: str) -> None:
    assert get_nxt_session(now) == session
    assert is_nxt_extended_tradable(now) is (session in ('pre-market', 'after-market'))


def test_krx_business_day() -> None:
    assert is_krx_business_day_kst('20260908') is True
    assert is_krx_business_day_kst('20260912') is False
    assert is_krx_business_day_kst('20260924') is False
    assert is_krx_business_day_kst('20260928') is True
    assert is_krx_business_day_kst('2026-09-08') is False
    assert is_krx_business_day_kst('20260231') is False


def test_trading_hours_by_exchange_id() -> None:
    assert is_trading_hours('toss', utc(2026, 5, 22, 2)) is True
    assert is_trading_hours('toss', utc(2026, 5, 5, 2)) is False
    assert is_trading_hours('binance', utc(2026, 5, 5, 2)) is True
    assert trading_hours_block_reason('kis', utc(2026, 5, 23, 2)) == 'KRX 주말 — KRX 휴장'
    assert trading_hours_block_reason('kis', utc(2026, 5, 22, 2)) is None
    assert get_time_until_market_open('stock', utc(2026, 5, 23, 2)) == 0
    assert get_time_until_market_open('toss', utc(2026, 5, 22, 13)) == 59 * HOUR


# ============ 미국 ============

@pytest.mark.parametrize('now,phase', [
    (utc(2026, 5, 23, 18), 'closed'),
    (utc(2026, 5, 25, 18), 'closed'),  # Memorial Day
    (utc(2026, 12, 25, 18), 'closed'),
    (utc(2026, 5, 22, 13, 31), 'open'),
    (utc(2026, 5, 22, 13, 25), 'pre-auction'),
    (utc(2026, 5, 22, 13, 30), 'open'),
    (utc(2026, 5, 22, 19, 50), 'closing-auction'),
    (utc(2026, 5, 22, 19, 49), 'open'),
    (utc(2026, 5, 22, 20), 'closed'),
    (utc(2026, 11, 2, 14, 31), 'open'),
    (utc(2026, 11, 2, 20, 55), 'closing-auction'),
    (utc(2026, 3, 6, 14, 30), 'open'),
    (utc(2026, 3, 9, 13, 30), 'open'),
    (utc(2026, 10, 30, 13, 30), 'open'),
    (utc(2026, 11, 2, 13, 30), 'closed'),
    (utc(2026, 3, 8, 7), 'closed'),
])
def test_us_market_phase(now: int, phase: str) -> None:
    assert get_us_market_phase(now) == phase


def test_us_time_until_open_and_format() -> None:
    assert get_time_until_us_market_open(utc(2026, 7, 10, 18)) == 0
    assert get_time_until_us_market_open(utc(2026, 7, 10, 20, 30)) == 65 * HOUR
    assert get_time_until_us_market_open(utc(2026, 7, 11, 12)) == 49.5 * HOUR
    assert get_time_until_us_market_open(utc(2026, 7, 10, 11)) == 2.5 * HOUR
    assert get_time_until_us_market_open(utc(2026, 7, 3, 12)) == 73.5 * HOUR
    assert get_time_until_us_market_open(utc(2026, 12, 1, 22)) == 16.5 * HOUR
    assert format_et_wall_clock(utc(2026, 5, 22, 13, 30)) == '2026-05-22 09:30 ET'
    assert format_et_wall_clock(utc(2026, 11, 2, 14, 30)) == '2026-11-02 09:30 ET'
    assert et_wall_clock_to_utc_ms(2026, 7, 13, 9, 30) == utc(2026, 7, 13, 13, 30)
    assert et_wall_clock_to_utc_ms(2026, 12, 2, 9, 30) == utc(2026, 12, 2, 14, 30)


def test_us_rule_fallback_matches_zoneinfo(monkeypatch: pytest.MonkeyPatch) -> None:
    """시간대 자료가 없을 때 쓰는 서머타임 규칙이 IANA 자료와 같은 동부 시각을 낸다(전환 경계 앞뒤 포함)."""
    samples = [utc(2026, 3, 8, 6, 59), utc(2026, 3, 8, 7), utc(2026, 11, 1, 5, 59), utc(2026, 11, 1, 6)]
    samples += [utc(year, month, 15, hour) for year in (2025, 2026, 2027) for month in range(1, 13) for hour in (0, 13, 21)]
    expected = [us_market_hours._to_et_wall_clock(ms) for ms in samples]
    monkeypatch.setattr(us_market_hours, '_et_zone', None)
    assert [us_market_hours._to_et_wall_clock(ms) for ms in samples] == expected


# ============ 증권거래세 ============

def test_krx_sell_tax_schedule() -> None:
    assert krx_sell_tax_rate(utc(2026, 8, 3, 0)) == 0.002
    assert krx_sell_tax_rate(utc(2025, 6, 1, 0)) == 0.0015
    assert krx_sell_tax_rate(utc(2024, 12, 31, 14, 59)) == 0.0018  # 2024-12-31 23:59 KST
    assert krx_sell_tax_rate(utc(2024, 12, 31, 15)) == 0.0015  # 2025-01-01 00:00 KST
    assert krx_sell_tax_rate(utc(2020, 1, 1, 0)) == 0.002


# ============ 세 증권사 공용 주문 게이트 ============

def _kst(hour: int, minute: int, second: int = 0) -> int:
    """2026-09-22(화) 한국 시각."""
    return utc(2026, 9, 22, hour - 9, minute) + second * 1000


def _et(hour: int, minute: int, second: int = 0) -> int:
    """2026-09-22(화) 미국 동부 시각(서머타임)."""
    return utc(2026, 9, 22, hour + 4, minute) + second * 1000


def test_krx_order_block_reason() -> None:
    assert krx_order_block_reason(_kst(10, 0)) is None
    assert krx_order_block_reason(_kst(21, 30)) == '거래시간 외: 장 마감 (현재: 21:30 KST, 마감: 15:30)'
    # 종가 동시호가의 신규 매수는 시장이 받으므로 기본으로 연다. 옵션을 켜면 15:20:00 부터 매수만 막는다.
    assert krx_order_block_reason(_kst(15, 25), 'buy') is None
    assert krx_order_block_reason(_kst(15, 19, 59), 'buy', True) is None
    assert '종가 동시호가' in (krx_order_block_reason(_kst(15, 20), 'buy', True) or '')
    assert krx_order_block_reason(_kst(15, 20), 'sell', True) is None
    assert krx_order_block_reason(_kst(16, 30), sessions=('nxt',)) is None
    assert krx_order_block_reason(_kst(15, 25), sessions=('nxt',)) == 'NXT 거래시간 외 (session=krx-closing-auction)'
    assert krx_order_block_reason(_kst(16, 30), sessions=('regular', 'nxt')) is None
    assert (krx_order_block_reason(_kst(21, 30), sessions=('regular', 'nxt')) or '').endswith('(NXT session=closed)')


def test_us_order_block_reason() -> None:
    assert 'phase=closed' in (us_order_block_reason(_et(9, 24, 59)) or '')
    assert 'phase=pre-auction' in (us_order_block_reason(_et(9, 25)) or '')
    assert us_order_block_reason(_et(9, 25), sessions=('regular', 'opening-auction')) is None
    assert us_order_block_reason(_et(9, 30)) is None
    assert us_order_block_reason(_et(15, 55), 'buy') is None
    assert us_order_block_reason(_et(15, 49, 59), 'buy', True) is None
    assert '종가 동시호가' in (us_order_block_reason(_et(15, 50), 'buy', True) or '')
    assert us_order_block_reason(_et(15, 50), 'sell', True) is None
    assert 'phase=closed' in (us_order_block_reason(_et(16, 0)) or '')


def test_market_session_block_reason_auction_policy() -> None:
    assert market_session_block_reason('kbsec', '005930/KRW', _kst(15, 25), side='buy') is None
    assert '종가 동시호가' in (market_session_block_reason('kbsec', '005930/KRW', _kst(15, 25), side='buy', block_auction_buys=True) or '')

