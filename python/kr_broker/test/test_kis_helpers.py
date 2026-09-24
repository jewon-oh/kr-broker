"""한국투자증권 도우미(봉 페이지 창, 야후 봉, 종목 마스터, 시각 변환, 세션 판정). 기대값은 TypeScript 판의 같은 테스트에서 가져왔다."""

import calendar
import datetime
import json
import threading
import time
from typing import Any, Dict, Iterator, List, Optional

import pytest

import kr_broker
from kr_broker import kis_yahoo_candles
from kr_broker.base import functions as fn
from kr_broker.base.errors import BadSymbol
from kr_broker.kis import kst_timestamp, kst_ymd, et_ymd
from kr_broker.kis_candle_pagination import (
    KIS_DAILY_MAX_PAGES, KIS_DAILY_PAGE_DAYS, KIS_DAILY_PAGE_ROWS, merge_candles, plan_windows, to_kis_date, window_before,
)
from kr_broker.kis_candle_resample import resample_candles
from kr_broker.kis_candle_service import KISCandleService
from kr_broker.kis_master_search_rank import rank_master_matches
from kr_broker.kis_overseas_master import search_overseas_stocks, to_order_market_code
from kr_broker.kis_stock_master import get_krx_stock_by_code, search_krx_stocks
from kr_broker.kis_types import get_tick_size
from kr_broker.kis_yahoo_candles import (
    UnsupportedTimeframeError, align_tail_to_series_grid, dedupe_by_timestamp_keep_last, fetch_yahoo_candles, to_yahoo_range,
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


def test_dedupe_keeps_last() -> None:
    rows = [[1000, 1, 1, 1, 10, 5], [1000, 1, 2, 1, 20, 9], [2000, 2, 2, 2, 30, 1]]
    dedupe_by_timestamp_keep_last(rows)
    assert rows == [[1000, 1, 2, 1, 20, 9], [2000, 2, 2, 2, 30, 1]]


def test_to_yahoo_range_buckets() -> None:
    day = 86_400_000
    assert [to_yahoo_range(n * day) for n in (1, 5, 30, 90, 180, 200, 731, 1826, 3651, 4000)] == [
        '1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']


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

    def request(self, method: str, url: str, headers: Optional[Dict[str, str]] = None, data: Any = None, timeout: Any = None) -> Any:
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
ONE = [[1_700_000_000_000, 1, 2, 0.5, 1.5, 100]]


@pytest.fixture
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kis_yahoo_candles, '_backoff', lambda attempt: None)


@pytest.mark.parametrize('timeframe', ['3m', '8h', '2d'])
def test_yahoo_rejects_unsupported_timeframe(timeframe: str) -> None:
    with pytest.raises(UnsupportedTimeframeError, match='미지원 타임프레임'):
        fetch_yahoo_candles('005930', timeframe, session=FakeSession([YAHOO_EMPTY]))


def test_yahoo_retries_empty_then_succeeds(no_backoff: None) -> None:
    session = FakeSession([YAHOO_EMPTY, yahoo_ok(ONE)])
    out = fetch_yahoo_candles('005930', '1d', 10, session=session)
    assert len(session.urls) == 2
    assert out == [[1_700_000_000_000, 1, 2, 0.5, 1.5, 100]]


def test_yahoo_chart_error_does_not_retry(no_backoff: None) -> None:
    session = FakeSession([YAHOO_CHART_ERROR])
    assert fetch_yahoo_candles('BADSYM', '1d', 10, session=session) == []
    assert len(session.urls) == 1


def test_yahoo_gives_up_after_three_empty(no_backoff: None) -> None:
    session = FakeSession([YAHOO_EMPTY])
    assert fetch_yahoo_candles('005930', '1d', 10, session=session) == []
    assert len(session.urls) == 3


def test_yahoo_retries_429(no_backoff: None) -> None:
    session = FakeSession([YAHOO_429, yahoo_ok(ONE)])
    assert len(fetch_yahoo_candles('NVDA', '1d', 10, session=session)) == 1
    assert len(session.urls) == 2


def test_yahoo_uses_range_not_period(no_backoff: None) -> None:
    session = FakeSession([yahoo_ok(ONE)])
    now = fn.milliseconds()
    fetch_yahoo_candles('005930', '4h', 200, now - 200 * 24 * 3600 * 1000, now, session=session)
    assert 'range=1y' in session.urls[0] and 'interval=1h' in session.urls[0] and 'period1' not in session.urls[0]
    assert session.urls[0].startswith('https://query1.finance.yahoo.com/v8/finance/chart/005930.KS?')


def test_yahoo_ticker_suffix(no_backoff: None) -> None:
    session = FakeSession([yahoo_ok(ONE)])
    fetch_yahoo_candles('247540/KRW', '1d', 10, kr_market='KOSDAQ', session=session)
    fetch_yahoo_candles('stock:AAPL', '1d', 10, session=session)
    assert '/247540.KQ?' in session.urls[0] and '/AAPL?' in session.urls[1]


def test_yahoo_concurrency_is_capped() -> None:
    session = FakeSession([yahoo_ok(ONE)], delay=0.03)
    threads = [threading.Thread(target=fetch_yahoo_candles, args=('005930', '1d', 10), kwargs={'session': session}) for _ in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert 1 < session.max_active <= kis_yahoo_candles.YAHOO_MAX_CONCURRENT


# ============ KIS 원본 봉 ============

class FakeKis:
    def __init__(self, pages: List[Any]) -> None:
        self.pages = list(pages)
        self.calls: List[Dict[str, Any]] = []

    def private_get_uapi_overseas_price_v1_quotations_dailyprice(self, params: Dict[str, Any]) -> Any:
        self.calls.append(params)
        return self.pages.pop(0)

    def private_get_uapi_domestic_stock_v1_quotations_inquire_time_itemchartprice(self, params: Dict[str, Any]) -> Any:
        self.calls.append(params)
        return self.pages.pop(0)


def local_ymd(ms: int) -> str:
    d = datetime.datetime.fromtimestamp(ms / 1000)
    return f'{d.year}{d.month:02d}{d.day:02d}'


def test_overseas_daily_pages_back_from_last_day(monkeypatch: pytest.MonkeyPatch) -> None:
    now = utc('2026-03-25T12:00:00')
    monkeypatch.setattr(fn, 'milliseconds', lambda: now)
    days = [datetime.date(2026, 3, 24) - datetime.timedelta(days=i) for i in range(101)]

    def row(day: datetime.date) -> Dict[str, str]:
        return {'xymd': day.strftime('%Y%m%d'), 'open': '1', 'high': '2', 'low': '0.5', 'clos': '1.5', 'tvol': '10'}

    fake = FakeKis([{'output2': [row(d) for d in days[:100]]}, {'output2': [row(days[100])]}])
    out = KISCandleService(fake).fetch_overseas_daily_ohlcv('aapl', 'NAS', '1d', 150)
    # 다음 페이지의 기준일은 앞 페이지 마지막 날의 하루 전(UTC)을 지역 시간대 날짜로 적은 것이다.
    last_utc = calendar.timegm(days[99].timetuple()) * 1000
    assert [call['BYMD'] for call in fake.calls] == [local_ymd(now), local_ymd(last_utc - 86_400_000)]
    assert fake.calls[0]['SYMB'] == 'AAPL' and fake.calls[0]['GUBN'] == '0'
    assert len(out) == 101 and out[0][0] == calendar.timegm(days[100].timetuple()) * 1000 and out[-1][0] == utc('2026-03-24T00:00:00')


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


# ============ 시각 ============

def test_kst_timestamp_follows_javascript_date_parse() -> None:
    assert kst_timestamp('20260325', '093000') == utc('2026-03-25T00:30:00')
    assert kst_timestamp('20260325', None) == utc('2026-03-24T15:00:00')
    assert kst_timestamp('20260325', '9300') == utc('2026-03-24T15:00:00')
    assert kst_timestamp('20260230', None) == utc('2026-03-01T15:00:00')  # 2월 30일은 3월 2일로 넘어간다
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


@pytest.mark.parametrize('amount', [0, -1, float('nan'), float('inf'), '3', True])
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
