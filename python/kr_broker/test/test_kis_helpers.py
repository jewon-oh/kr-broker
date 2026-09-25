"""한국투자증권 도우미(봉 페이지 창, 야후 봉, 종목 마스터, 시각 변환, 세션 판정). 기대값은 TypeScript 판의 같은 테스트에서 가져왔다."""

import calendar
import datetime
import json
import math
import threading
import time
from decimal import Decimal
from typing import Any, Dict, Iterator, List, Optional

import pytest

import kr_broker
from kr_broker import kis_yahoo_candles
from kr_broker.base import functions as fn
from kr_broker.base.errors import BadSymbol, ExchangeNotAvailable, NotSupported
from kr_broker.base.exchange import Exchange
from kr_broker.broker_time import timeframe_to_ms
from kr_broker.kis import et_timestamp, kst_timestamp, kst_ymd, et_ymd
from kr_broker.kis_candle_pagination import (
    KIS_DAILY_MAX_PAGES, KIS_DAILY_PAGE_DAYS, KIS_DAILY_PAGE_ROWS, merge_candles, plan_windows, slice_candle_window, to_kis_date,
    window_before,
)
from kr_broker.kis_candle_resample import resample_candles
from kr_broker.kis_candle_service import KISCandleService
from kr_broker.kis_master_search_rank import rank_master_matches
from kr_broker.kis_overseas_master import search_overseas_stocks, to_order_market_code
from kr_broker.kis_stock_master import get_krx_stock_by_code, search_krx_stocks
from kr_broker.kis_types import get_tick_size
from kr_broker.kis_yahoo_candles import (
    align_tail_to_series_grid, dedupe_by_timestamp_keep_last, fetch_yahoo_candles, to_yahoo_range, to_yahoo_ticker,
)
from kr_broker.market_calendar import reset_market_calendar
from kr_broker.trading_hours import market_session_block_reason

MASTER = {
    'kospi': [{'code': '005930', 'name': '삼성전자', 'market': 'KOSPI'}],
    'kosdaq': [{'code': '247540', 'name': '에코프로비엠', 'market': 'KOSDAQ'}],
    'nasdaq': [
        {'code': 'AAPL', 'name': 'APPLE INC', 'nameKr': '애플', 'market': 'NAS', 'currency': 'USD'},
        {'code': 'AVGO', 'name': 'BROADCOM INC', 'nameKr': '브로드컴', 'market': 'NAS', 'currency': 'USD'},
    ],
    'nyse': [
        {'code': 'VZ', 'name': 'VERIZON', 'nameKr': '버라이즌', 'market': 'NYS', 'currency': 'USD'},
        {'code': 'V', 'name': 'VISA INC-CLASS A SHARES', 'nameKr': '비자', 'market': 'NYS', 'currency': 'USD'},
        {'code': 'BRK/B', 'name': 'BERKSHIRE HATHAWAY INC-CL B', 'market': 'NYS', 'currency': 'USD'},
    ],
    'amex': [],
}


def utc(text: str) -> int:
    """`YYYY-MM-DDTHH:MM:SS` UTC → 밀리초."""
    date, clock = text.split('T')
    y, m, d = (int(x) for x in date.split('-'))
    hh, mm, ss = (int(x) for x in clock.split(':'))
    return calendar.timegm((y, m, d, hh, mm, ss, 0, 0, 0)) * 1000


@pytest.fixture(autouse=True)
def _calendar() -> Iterator[None]:
    reset_market_calendar()
    yield
    reset_market_calendar()


# ============ 봉 페이지 창 ============

NOW = utc('2026-08-21T00:00:00')


def test_to_kis_date_pads() -> None:
    assert to_kis_date(utc('2026-01-05T00:00:00')) == '20260105'


def test_to_kis_date_is_kst_date() -> None:
    # 실행 환경의 시간대가 아니라 한국 날짜다. UTC 20시는 한국 다음 날 새벽이다.
    assert to_kis_date(utc('2026-09-25T20:00:00')) == '20260926'
    assert to_kis_date(utc('2026-09-25T14:59:59')) == '20260925'
    assert plan_windows(1, utc('2026-09-25T20:00:00'))[0] == {'start': '20260510', 'end': '20260926'}


def test_window_before_is_days_long() -> None:
    assert window_before(NOW, 10) == {'start': '20260812', 'end': '20260821'}


def test_plan_windows_counts() -> None:
    assert plan_windows(0, NOW) == []
    assert plan_windows(-5, NOW) == []
    assert len(plan_windows(100, NOW)) == 1
    assert len(plan_windows(1, NOW)) == 1
    assert len(plan_windows(800, NOW)) == 8
    assert len(plan_windows(100_000, NOW)) <= KIS_DAILY_MAX_PAGES
    assert KIS_DAILY_PAGE_DAYS * 0.68 <= KIS_DAILY_PAGE_ROWS


def test_plan_windows_leave_no_gap() -> None:
    windows = plan_windows(800, NOW)

    def parse(ymd: str) -> int:
        return calendar.timegm((int(ymd[:4]), int(ymd[4:6]), int(ymd[6:]), 0, 0, 0, 0, 0, 0)) * 1000

    for current, following in zip(windows, windows[1:]):
        assert (parse(current['start']) - parse(following['end'])) / 86_400_000 == 1
        assert following['end'] < current['start']


def test_merge_candles() -> None:
    def c(ts: float, close: float) -> List[float]:
        return [ts, 1, 2, 0, close, 10]

    assert [x[0] for x in merge_candles([[c(300, 3)], [c(100, 1), c(200, 2)]])] == [100, 200, 300]
    merged = merge_candles([[c(100, 1)], [c(100, 9), c(200, 2)]])
    assert len(merged) == 2 and merged[0][4] == 9
    assert merge_candles([[], [[float('nan'), 1, 2, 3, 4, 5]]]) == []


def test_slice_candle_window() -> None:
    rows = [[ts, 1, 2, 0, 1, 10] for ts in (100, 200, 300, 400, 500)]
    assert [c[0] for c in slice_candle_window(rows, 150, None, 2)] == [200, 300]
    assert [c[0] for c in slice_candle_window(rows, None, None, 2)] == [400, 500]
    assert [c[0] for c in slice_candle_window(rows, 200, 400, 10)] == [200, 300, 400]
    assert [c[0] for c in slice_candle_window(rows, None, 300, 2)] == [200, 300]


def test_resample_candles() -> None:
    hour = 3_600_000
    candles = [[0, 1, 5, 1, 4, 10], [hour, 4, 6, 3, 5, 20], [4 * hour, 5, 7, 5, 6, 30]]
    assert resample_candles(candles, 4 * 60) == [[0, 1, 6, 1, 5, 30], [4 * hour, 5, 7, 5, 6, 30]]
    assert resample_candles([], 60) == []


# ============ 야후 봉 ============

def bar(ts: int, close: float = 100) -> List[float]:
    return [ts, close, close, close, close, 1]


def test_align_tail_snaps_to_previous_bar_grid() -> None:
    candles = [bar(utc('2026-08-06T00:00:00')), bar(utc('2026-08-06T01:00:00')), bar(utc('2026-08-06T02:30:18'))]
    align_tail_to_series_grid(candles, '1h')
    assert candles[2][0] == utc('2026-08-06T02:00:00')


def test_align_tail_keeps_us_session_phase() -> None:
    candles = [bar(utc('2026-08-05T13:30:00')), bar(utc('2026-08-05T14:30:00')), bar(utc('2026-08-05T15:47:10'))]
    align_tail_to_series_grid(candles, '1h')
    assert [c[0] for c in candles] == [utc('2026-08-05T13:30:00'), utc('2026-08-05T14:30:00'), utc('2026-08-05T15:30:00')]


def test_align_tail_leaves_daily_and_single_bar() -> None:
    for tf in ('1d', '1w'):
        candles = [bar(utc('2026-08-04T00:00:00')), bar(utc('2026-08-06T02:31:00'))]
        before = json.loads(json.dumps(candles))
        align_tail_to_series_grid(candles, tf)
        assert candles == before
    single = [bar(utc('2026-08-06T02:30:18'))]
    align_tail_to_series_grid(single, '1h')
    assert single[0][0] == utc('2026-08-06T02:30:18')


def test_align_tail_leaves_monthly_and_uppercase_weekly() -> None:
    # 예전에는 표에 없는 타임프레임이 5분이 되어 월봉과 대문자 주봉의 진행 중 봉이 5분 격자로 내려갔다.
    for tf in ('1M', '1W'):
        candles = [bar(utc('2026-07-31T15:00:00')), bar(utc('2026-09-24T06:20:17'))]
        before = json.loads(json.dumps(candles))
        align_tail_to_series_grid(candles, tf)
        assert candles == before, tf


def test_timeframe_to_ms() -> None:
    assert [timeframe_to_ms(tf) for tf in ('1m', '5m', '1h', '4h', '1d', '1w')] == [
        60_000, 300_000, 3_600_000, 14_400_000, 86_400_000, 604_800_000]
    for tf in ('1M', '1W', '30s', '1y', '', 'abc'):
        assert math.isnan(timeframe_to_ms(tf)), tf


def test_dedupe_keeps_last() -> None:
    rows = [[1000, 1, 1, 1, 10, 5], [1000, 1, 2, 1, 20, 9], [2000, 2, 2, 2, 30, 1]]
    dedupe_by_timestamp_keep_last(rows)
    assert rows == [[1000, 1, 2, 1, 20, 9], [2000, 2, 2, 2, 30, 1]]


def test_to_yahoo_range_buckets() -> None:
    day = 86_400_000
    assert [to_yahoo_range(n * day) for n in (1, 5, 30, 90, 180, 200, 731, 1826, 3651, 4000)] == [
        '1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']


def test_to_yahoo_range_uses_days_over_cap() -> None:
    # 버킷(3mo·1mo)이 분봉 조회 폭 상한을 넘으면 야후가 422 로 거절하므로 일수로 적는다.
    day = 86_400_000
    assert to_yahoo_range(40 * day, 59 * day) == '40d'
    assert to_yahoo_range(59 * day, 59 * day) == '59d'
    assert to_yahoo_range(5.5 * day, 6 * day) == '6d'
    assert to_yahoo_range(20 * day, 59 * day) == '1mo'
    assert to_yahoo_range(200 * day, 729 * day) == '1y'


class FakeResponse:
    def __init__(self, status: int, body: Any) -> None:
        self.status_code = status
        self.content = json.dumps(body).encode('utf-8')
        self.encoding = 'utf-8'


class FakeSession:
    def __init__(self, responses: List[Any], delay: float = 0) -> None:
        self.responses = list(responses)
        self.urls: List[str] = []
        self.delay = delay
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()

    def request(self, method: str, url: str, headers: Optional[Dict[str, str]] = None, data: Any = None, timeout: Any = None,
                allow_redirects: bool = True) -> Any:
        with self.lock:
            self.urls.append(url)
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            reply = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if self.delay:
            time.sleep(self.delay)
        with self.lock:
            self.active -= 1
        return reply


def yahoo_ok(candles: List[List[float]]) -> FakeResponse:
    return FakeResponse(200, {'chart': {'result': [{
        'timestamp': [c[0] // 1000 for c in candles],
        'indicators': {'quote': [{
            'open': [c[1] for c in candles], 'high': [c[2] for c in candles], 'low': [c[3] for c in candles],
            'close': [c[4] for c in candles], 'volume': [c[5] for c in candles],
        }]},
    }], 'error': None}})


YAHOO_EMPTY = FakeResponse(200, {'chart': {'result': None, 'error': None}})
YAHOO_CHART_ERROR = FakeResponse(200, {'chart': {'result': None, 'error': {'code': 'Not Found', 'description': 'No data'}}})
YAHOO_429 = FakeResponse(429, {})
# 봉 시각은 규칙(거래일의 00:00 UTC)에 맞는 값을 쓴다. 재시도 테스트라 시각을 옮기지 않게 한다.
ONE = [[1_699_920_000_000, 1, 2, 0.5, 1.5, 100]]


@pytest.fixture
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kis_yahoo_candles, '_backoff', lambda attempt: None)


@pytest.mark.parametrize('timeframe', ['3m', '8h', '2d'])
def test_yahoo_rejects_unsupported_timeframe(timeframe: str) -> None:
    session = FakeSession([YAHOO_EMPTY])
    with pytest.raises(NotSupported, match=f"미지원 타임프레임 '{timeframe}'"):
        fetch_yahoo_candles('005930', timeframe, exchange=Exchange({'session': session}))
    assert session.urls == []


def test_yahoo_retries_empty_then_succeeds(no_backoff: None) -> None:
    session = FakeSession([YAHOO_EMPTY, yahoo_ok(ONE)])
    out = fetch_yahoo_candles('005930', '1d', 10, exchange=Exchange({'session': session}))
    assert len(session.urls) == 2
    assert out == ONE


def test_yahoo_chart_error_does_not_retry(no_backoff: None) -> None:
    session = FakeSession([YAHOO_CHART_ERROR])
    with pytest.raises(BadSymbol):
        fetch_yahoo_candles('BADSYM', '1d', 10, exchange=Exchange({'session': session}))
    assert len(session.urls) == 1


def test_yahoo_raises_after_three_empty(no_backoff: None) -> None:
    # 조회 실패를 "봉 없음"과 같은 빈 목록으로 돌려주지 않는다.
    session = FakeSession([YAHOO_EMPTY])
    with pytest.raises(ExchangeNotAvailable):
        fetch_yahoo_candles('005930', '1d', 10, exchange=Exchange({'session': session}))
    assert len(session.urls) == 3


def test_yahoo_other_4xx_is_bad_request_without_retry(no_backoff: None) -> None:
    # 조회 폭 초과(422) 같은 4xx 는 일시 장애가 아니라 요청 문제다.
    from kr_broker.base.errors import BadRequest
    session = FakeSession([FakeResponse(422, {})])
    with pytest.raises(BadRequest):
        fetch_yahoo_candles('XOM', '15m', 10, exchange=Exchange({'session': session}))
    assert len(session.urls) == 1


def test_yahoo_retries_429(no_backoff: None) -> None:
    session = FakeSession([YAHOO_429, yahoo_ok(ONE)])
    assert len(fetch_yahoo_candles('NVDA', '1d', 10, exchange=Exchange({'session': session}))) == 1
    assert len(session.urls) == 2


def test_yahoo_uses_range_not_period(no_backoff: None) -> None:
    session = FakeSession([yahoo_ok(ONE)])
    now = fn.milliseconds()
    fetch_yahoo_candles('005930', '4h', 200, now - 200 * 24 * 3600 * 1000, now, exchange=Exchange({'session': session}))
    assert 'range=1y' in session.urls[0] and 'interval=1h' in session.urls[0] and 'period1' not in session.urls[0]
    assert session.urls[0].startswith('https://query1.finance.yahoo.com/v8/finance/chart/005930.KS?')


US_DAILY = [[utc(t), 1, 2, 0.5, 1.5, 100] for t in (
    '2023-12-29T14:30:00', '2024-01-02T14:30:00', '2024-01-03T14:30:00', '2024-01-04T14:30:00', '2024-01-05T14:30:00',
    '2024-01-08T14:30:00', '2026-03-24T13:30:00')]


def test_yahoo_since_until_takes_first_limit_from_since(no_backoff: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fn, 'milliseconds', lambda: utc('2026-03-25T12:00:00'))
    session = FakeSession([yahoo_ok(US_DAILY)])
    exchange = Exchange({'session': session})
    out = fetch_yahoo_candles('AAPL', '1d', 3, utc('2024-01-01T00:00:00'), utc('2024-01-06T00:00:00'), exchange=exchange)
    # 야후는 미국 일봉을 개장 시각(09:30 ET)에 두지만, 일봉은 거래일의 00:00 UTC 로 옮긴다.
    assert [c[0] for c in out] == [utc('2024-01-02T00:00:00'), utc('2024-01-03T00:00:00'), utc('2024-01-04T00:00:00')]
    # range 는 지금에서 거슬러 세므로 until 이 아니라 since 부터 지금까지를 덮는다(814일 → 5y).
    assert 'range=5y' in session.urls[0]
    out = fetch_yahoo_candles('AAPL', '1d', 2, None, utc('2024-01-06T00:00:00'), exchange=exchange)
    assert [c[0] for c in out] == [utc('2024-01-04T00:00:00'), utc('2024-01-05T00:00:00')]


def test_yahoo_minute_since_beyond_cap_warns(no_backoff: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setattr(fn, 'milliseconds', lambda: utc('2026-03-25T12:00:00'))
    session = FakeSession([yahoo_ok(ONE)])
    with caplog.at_level('WARNING', logger='kr_broker'):
        fetch_yahoo_candles('AAPL', '5m', 10, utc('2024-01-01T00:00:00'), exchange=Exchange({'session': session}))
    assert 'range=59d' in session.urls[0]
    assert any('상한' in record.getMessage() for record in caplog.records)


def test_yahoo_ticker_suffix(no_backoff: None) -> None:
    session = FakeSession([yahoo_ok(ONE)])
    fetch_yahoo_candles('247540/KRW', '1d', 10, kr_market='KOSDAQ', exchange=Exchange({'session': session}))
    fetch_yahoo_candles('stock:AAPL', '1d', 10, exchange=Exchange({'session': session}))
    assert '/247540.KQ?' in session.urls[0] and '/AAPL?' in session.urls[1]


def test_yahoo_ticker_uses_hyphen_for_us_class_shares() -> None:
    assert to_yahoo_ticker('BRK.B/USD') == 'BRK-B'
    assert to_yahoo_ticker('BRK.B') == 'BRK-B'
    assert to_yahoo_ticker('005930.KS') == '005930.KS'
    assert to_yahoo_ticker('247540', 'KOSDAQ') == '247540.KQ'


def test_yahoo_concurrency_is_capped() -> None:
    session = FakeSession([yahoo_ok(ONE)], delay=0.03)
    threads = [threading.Thread(target=fetch_yahoo_candles, args=('005930', '1d', 10), kwargs={'exchange': Exchange({'session': session})}) for _ in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert 1 < session.max_active <= kis_yahoo_candles.YAHOO_MAX_CONCURRENT


# ============ KIS 원본 봉 ============

class FakeKis:
    def __init__(self, pages: List[Any], now: Optional[int] = None) -> None:
        self.pages = list(pages)
        self.calls: List[Dict[str, Any]] = []
        self.now = now

    def milliseconds(self) -> int:
        return fn.milliseconds() if self.now is None else self.now

    def private_get_uapi_domestic_stock_v1_quotations_inquire_daily_itemchartprice(self, params: Dict[str, Any]) -> Any:
        self.calls.append(params)
        return {'output2': []}

    def private_get_uapi_overseas_price_v1_quotations_dailyprice(self, params: Dict[str, Any]) -> Any:
        self.calls.append(params)
        return self.pages.pop(0)

    def private_get_uapi_domestic_stock_v1_quotations_inquire_time_itemchartprice(self, params: Dict[str, Any]) -> Any:
        self.calls.append(params)
        return self.pages.pop(0)


def test_overseas_daily_pages_back_from_last_day(monkeypatch: pytest.MonkeyPatch) -> None:
    # 동부 3/24 22:00(EDT). UTC·한국 날짜로는 3/25 다. 기준일은 실행 환경의 시간대와 상관없이 동부 날짜다.
    now = utc('2026-03-25T02:00:00')
    monkeypatch.setattr(fn, 'milliseconds', lambda: now)
    days = [datetime.date(2026, 3, 24) - datetime.timedelta(days=i) for i in range(101)]

    def row(day: datetime.date) -> Dict[str, str]:
        return {'xymd': day.strftime('%Y%m%d'), 'open': '1', 'high': '2', 'low': '0.5', 'clos': '1.5', 'tvol': '10'}

    fake = FakeKis([{'output2': [row(d) for d in days[:100]]}, {'output2': [row(days[100])]}])
    out = KISCandleService(fake).fetch_overseas_daily_ohlcv('aapl', 'NAS', '1d', 150)
    # 다음 페이지의 기준일은 앞 페이지 마지막 날(2025-12-15)의 하루 전 달력 날짜다.
    assert [call['BYMD'] for call in fake.calls] == ['20260324', '20251214']
    assert fake.calls[0]['SYMB'] == 'AAPL' and fake.calls[0]['GUBN'] == '0'
    assert len(out) == 101 and out[0][0] == calendar.timegm(days[100].timetuple()) * 1000 and out[-1][0] == utc('2026-03-24T00:00:00')


def test_overseas_daily_since_pages_until_reached() -> None:
    # 첫 기준일은 지금이 아니라 since 에서 150개를 덮는 날(since + 232일)이고, 한 쪽을 다 받아도 since 에 못 닿았으면 더 넘긴다.
    since = utc('2025-01-01T00:00:00')

    def rows(start: datetime.date, count: int, step: int) -> List[Dict[str, str]]:
        days = [start - datetime.timedelta(days=i * step) for i in range(count)]
        return [{'xymd': d.strftime('%Y%m%d'), 'open': '1', 'high': '2', 'low': '0.5', 'clos': '1.5', 'tvol': '10'} for d in days]

    fake = FakeKis([{'output2': rows(datetime.date(2025, 8, 20), 100, 1)}, {'output2': rows(datetime.date(2025, 5, 11), 30, 5)}],
                   now=utc('2026-03-25T00:00:00'))
    out = KISCandleService(fake).fetch_overseas_daily_ohlcv('AAPL', 'NAS', '1d', 150, since)
    assert [call['BYMD'] for call in fake.calls] == ['20250820', '20250512']
    assert len(out) == 127 and out[0][0] == since


def test_overseas_daily_since_until_first_limit() -> None:
    row = {'open': '1', 'high': '2', 'low': '0.5', 'clos': '1.5', 'tvol': '10'}
    fake = FakeKis([{'output2': [dict(row, xymd=d) for d in ('20240105', '20240104', '20240103', '20240102', '20231229')]}])
    out = KISCandleService(fake).fetch_overseas_daily_ohlcv('AAPL', 'NAS', '1d', 3, utc('2024-01-01T00:00:00'), utc('2024-01-06T00:00:00'))
    # 기준일은 until 의 미국 동부 날짜(1/5 19:00 EST)다.
    assert fake.calls[0]['BYMD'] == '20240105'
    assert [c[0] for c in out] == [utc('2024-01-02T00:00:00'), utc('2024-01-03T00:00:00'), utc('2024-01-04T00:00:00')]


def test_domestic_daily_dates_are_kst_from_exchange_clock() -> None:
    # 한국 9/26 05:00. 실행 환경의 시간대와 상관없이 한국 날짜로 적고, 시각은 인스턴스의 시계로 읽는다.
    fake = FakeKis([], now=utc('2026-09-25T20:00:00'))
    service = KISCandleService(fake)
    service.fetch_daily_ohlcv('005930', 'D', 10)
    service.fetch_daily_ohlcv_paged('005930', 'D', 1)
    assert [(call['FID_INPUT_DATE_1'], call['FID_INPUT_DATE_2']) for call in fake.calls] == [
        ('20260911', '20260926'), ('20260510', '20260926')]


def test_overseas_daily_rejects_minute_timeframe() -> None:
    fake = FakeKis([])
    assert KISCandleService(fake).fetch_overseas_daily_ohlcv('AAPL', 'NAS', '5m', 10) == []
    assert fake.calls == []


def test_minute_candles_follow_cursor_and_resample() -> None:
    def row(hms: str, close: str) -> Dict[str, str]:
        return {'stck_bsop_date': '20260325', 'stck_cntg_hour': hms, 'stck_oprc': close, 'stck_hgpr': close, 'stck_lwpr': close,
                'stck_prpr': close, 'cntg_vol': '1'}

    page1 = [row(f'10{59 - i:02d}00', str(100 + i)) for i in range(30)]
    page2 = [row('102900', '99')]
    fake = FakeKis([{'output2': page1}, {'output2': page2}])
    out = KISCandleService(fake).fetch_minute_ohlcv('005930', 1, 100)
    assert [call['FID_INPUT_HOUR_1'] for call in fake.calls] == ['', '103000']
    assert len(out) == 31 and out[0][0] == utc('2026-03-25T01:29:00')
    fake = FakeKis([{'output2': page1}, {'output2': page2}])
    assert len(KISCandleService(fake).fetch_minute_ohlcv('005930', 10, 100)) == 4


def test_minute_candles_keep_cursor_bar_once() -> None:
    # 연속조회가 커서(10:30)의 봉을 다시 줘도 한 번만 담는다. 10분봉 거래량을 두 번 더하지 않는다.
    def row(hms: str) -> Dict[str, str]:
        return {'stck_bsop_date': '20260325', 'stck_cntg_hour': hms, 'stck_oprc': '1', 'stck_hgpr': '1', 'stck_lwpr': '1',
                'stck_prpr': '1', 'cntg_vol': '1'}

    page1 = [row(f'10{59 - i:02d}00') for i in range(30)]
    page2 = [row('103000'), row('102900')]
    out = KISCandleService(FakeKis([{'output2': page1}, {'output2': page2}])).fetch_minute_ohlcv('005930', 1, 100)
    assert len(out) == 31 and len({c[0] for c in out}) == 31
    ten = KISCandleService(FakeKis([{'output2': page1}, {'output2': page2}])).fetch_minute_ohlcv('005930', 10, 100)
    assert next(c for c in ten if c[0] == utc('2026-03-25T01:30:00'))[5] == 10


# ============ 시각 ============

def test_kst_timestamp_follows_kst_stamp() -> None:
    assert kst_timestamp('20260325', '093000') == utc('2026-03-25T00:30:00')
    assert kst_timestamp('20260325', None) == utc('2026-03-24T15:00:00')
    assert kst_timestamp('20260325', '93000') == utc('2026-03-25T00:30:00')  # 앞의 0 이 빠진 시각은 채운다
    assert kst_timestamp('20260325', '9300') == utc('2026-03-24T15:00:00')  # 채우면 93분이라 읽지 못한 시각이다
    assert kst_timestamp('20260325', '250000') == utc('2026-03-24T15:00:00')
    assert kst_timestamp('20260230', None) is None  # 달력에 없는 날짜를 다른 날로 넘기지 않는다
    assert kst_timestamp('20261301', None) is None
    assert kst_timestamp('20260132', None) is None
    assert kst_timestamp('2026032', None) is None
    assert kst_timestamp(None, '093000') is None


def test_js_date_parse_iso() -> None:
    assert fn.js_date_parse_iso('2026-03-25T09:00:00+09:00') == utc('2026-03-25T00:00:00')
    assert fn.js_date_parse_iso('2026-03-25T00:00:00Z') == utc('2026-03-25T00:00:00')
    assert fn.js_date_parse_iso('2026-01-01T24:00:00Z') == utc('2026-01-02T00:00:00')
    for text in ('2026-01-01T24:00:01Z', '2026-13-01T00:00:00Z', '2026-01-01T00:60:00Z', '2026--T09:00:00+09:00', ' 2026-01-01T00:00:00Z'):
        assert fn.js_date_parse_iso(text) is None


def test_kst_and_et_dates() -> None:
    at = utc('2026-03-25T02:00:00')
    assert kst_ymd(at) == '20260325'
    assert et_ymd(at) == '20260324'


def test_et_timestamp_follows_daylight_saving() -> None:
    assert et_timestamp('20260324', '110000') == utc('2026-03-24T15:00:00')  # EDT(UTC-4)
    assert et_timestamp('20260115', '103015') == utc('2026-01-15T15:30:15')  # EST(UTC-5)
    assert et_timestamp('20260115', None) == utc('2026-01-15T05:00:00')
    assert et_timestamp('', '110000') is None
    assert et_timestamp(None, '110000') is None


# ============ 종목 마스터 ============

def test_rank_master_matches_puts_exact_code_first() -> None:
    rows = search_overseas_stocks(MASTER, 'V', 2)
    assert [row['code'] for row in rows] == ['V', 'VZ']
    assert rank_master_matches([{'code': 'AB'}, {'code': 'A'}], '  ', lambda r: r['code']) == [{'code': 'AB'}, {'code': 'A'}]


def test_krx_master_adds_curated_etf_once() -> None:
    assert get_krx_stock_by_code(MASTER, '0193L0')['securityType'] == 'ETF'
    assert [row['code'] for row in search_krx_stocks(MASTER, '삼성')] == ['005930', '0193L0']
    patched = dict(MASTER, kospi=MASTER['kospi'] + [{'code': '0193L0', 'name': '마스터판', 'market': 'KOSPI'}])
    assert get_krx_stock_by_code(patched, '0193L0')['name'] == '마스터판'


def test_krx_search_ignores_code_case() -> None:
    for query in ('0193L0', '0193l0', '193l'):
        assert [row['code'] for row in search_krx_stocks(MASTER, query)] == ['0193L0'], query


def test_order_market_code() -> None:
    assert [to_order_market_code(c) for c in ('NAS', 'NYS', 'AMS', 'HKS', 'TSE', 'XXX', None)] == [
        'NASD', 'NYSE', 'AMEX', 'SEHK', 'TKSE', None, None]


def test_tick_size_table() -> None:
    assert [get_tick_size(p) for p in (1999, 2000, 4999, 5000, 19999, 20000, 49999, 50000, 199999, 200000, 499999, 500000)] == [
        1, 5, 5, 10, 10, 50, 50, 100, 100, 500, 500, 1000]


def test_instrument_and_price_precision() -> None:
    broker = kr_broker.kis({'apiKey': 'k', 'secret': 's', 'uid': '12345678-01', 'options': {'masterData': MASTER}})
    assert broker._instrument_of('BRK.B/USD').code == 'BRK/B'
    assert broker._instrument_of('brk.b').symbol == 'BRK.B/USD'
    assert broker._instrument_of('AAPL').order_exchange == 'NASD'
    assert broker._instrument_of('MSFT/USD').quote_exchange is None
    assert broker.price_to_precision('005930/KRW', 71234) == '71200'
    assert broker.price_to_precision('005930', 1234.4) == '1234'
    assert broker.price_to_precision('0193L0', 12345.67) == '12345.67'
    assert broker.price_to_precision('AAPL/USD', 172.456) == '172.46'
    with pytest.raises(BadSymbol):
        broker.fetch_ticker('MSFT/USD')


# ============ 세션 판정 ============

def test_market_session_block_reason() -> None:
    kr_open = utc('2026-03-25T01:00:00')
    us_open = utc('2026-03-25T15:00:00')
    assert market_session_block_reason('kis', '005930/KRW', kr_open, MASTER) is None
    assert market_session_block_reason('kis', '005930', utc('2026-03-25T08:00:00'), MASTER).startswith('KRX 장 마감')
    assert market_session_block_reason('kis', 'AAPL/USD', us_open, MASTER) is None
    assert market_session_block_reason('kis', 'aapl', kr_open, MASTER).startswith('미국장 정규장 외')
    assert market_session_block_reason('kis', 'MSFT', us_open, MASTER) == '상장 거래소 미상 — 해외 마스터에 없는 티커 (MSFT)'
    tokyo = dict(MASTER, amex=[{'code': '7203', 'name': 'TOYOTA', 'market': 'TSE', 'currency': 'JPY'}])
    assert market_session_block_reason('kis', '7203', us_open, tokyo) == '세션 표에 없는 거래소 — venue=TSE (7203)'
    assert market_session_block_reason('upbit', '005930', us_open, MASTER) is None


# ============ 주문 도우미 ============

def test_account_params_default_suffix() -> None:
    assert kr_broker.kis({'uid': '12345678'})._account_params() == {'CANO': '12345678', 'ACNT_PRDT_CD': '01'}
    assert kr_broker.kis({'uid': '12345678-22'})._account_params() == {'CANO': '12345678', 'ACNT_PRDT_CD': '22'}
    assert kr_broker.kis({})._account_params() == {'CANO': '', 'ACNT_PRDT_CD': '01'}


@pytest.mark.parametrize('amount', [0, -1, float('nan'), float('inf'), '3', True, Decimal('NaN'), Decimal('-1')])
def test_create_order_rejects_invalid_quantity_before_request(amount: Any) -> None:
    broker = kr_broker.kis({'apiKey': 'k', 'secret': 's', 'uid': '12345678-01'})
    with pytest.raises(kr_broker.InvalidOrder):
        broker.create_order('005930/KRW', 'limit', 'buy', amount, 70000)


def test_order_status_of() -> None:
    broker = kr_broker.kis({})
    assert broker._order_status_of('3', '7', 'Y') == 'canceled'
    assert broker._order_status_of('3', '7', 'N') == 'open'
    assert broker._order_status_of('10', '0', None) == 'closed'
    assert broker._order_status_of('0', '0', None) is None


def test_candle_period_utc_ms_uses_utc_midnight_of_the_local_period_start() -> None:
    from kr_broker.broker_time import candle_period_utc_ms, is_daily_or_longer_timeframe
    assert candle_period_utc_ms(utc('2026-09-23T00:00:00'), '1d', 'KR') == utc('2026-09-23T00:00:00')
    assert candle_period_utc_ms(utc('2026-09-22T15:00:00'), '1d', 'KR') == utc('2026-09-23T00:00:00')
    assert candle_period_utc_ms(utc('2026-09-24T13:30:00'), '1d', 'US') == utc('2026-09-24T00:00:00')
    assert candle_period_utc_ms(utc('2026-01-15T05:00:00'), '1d', 'US') == utc('2026-01-15T00:00:00')
    assert candle_period_utc_ms(utc('2026-09-23T06:30:00'), '1w', 'KR') == utc('2026-09-21T00:00:00')
    assert candle_period_utc_ms(utc('2026-03-08T05:00:00'), '1w', 'US') == utc('2026-03-02T00:00:00')
    assert candle_period_utc_ms(utc('2026-09-24T20:00:00'), '1M', 'US') == utc('2026-09-01T00:00:00')
    assert candle_period_utc_ms(utc('2026-09-24T20:00:00'), '1y', 'US') == utc('2026-01-01T00:00:00')
    assert [is_daily_or_longer_timeframe(t) for t in ('1d', '1w', '1W', '1M', '1y', '1m', '4h')] == [True] * 5 + [False] * 2
