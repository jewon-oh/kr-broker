"""`KISCandleService`(`kis.candles()`)의 국내 봉 메서드 네 개: 요청 인자와 결과. 기대값은 TypeScript 판 `kis-candle-service.test.ts` 와 같다.

날짜 경계와 한국, 미국 동부 시각 변환은 실행 환경의 시간대(`TZ`)를 바꿔 가며 같은 값이 나오는지 본다. 동기 판과 비동기 판을 함께 돈다.
"""

import asyncio
import calendar
import datetime
import logging
import os
import time
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

import pytest

from kr_broker.async_support.kis_candle_service import KISCandleService as AsyncCandleService
from kr_broker.kis_candle_service import KISCandleService as SyncCandleService

Params = Dict[str, Any]


def utc(text: str) -> int:
    """`YYYY-MM-DDTHH:MM:SS` UTC → 밀리초."""
    return int(calendar.timegm(datetime.datetime.fromisoformat(text).timetuple())) * 1000


def kst(text: str) -> int:
    """`YYYY-MM-DDTHH:MM:SS` 한국 시각 → 밀리초."""
    return utc(text) - 9 * 3_600_000


NOW = utc('2026-09-25T06:00:00')  # 한국 9/25 15:00


class _Recorder:
    """시계와 봉 조회 응답. 인자를 기록하고 준비한 응답을 차례로 준다. 응답이 떨어지면 빈 `output2` 다."""

    def __init__(self, now: int, daily: Sequence[Any] = (), minute: Sequence[Any] = (), overseas: Sequence[Any] = ()) -> None:
        self.now = now
        self.replies: Dict[str, List[Any]] = {'daily': list(daily), 'minute': list(minute), 'overseas': list(overseas)}
        self.calls: Dict[str, List[Params]] = {'daily': [], 'minute': [], 'overseas': []}

    def milliseconds(self) -> int:
        return self.now

    def answer(self, kind: str, params: Params) -> Any:
        self.calls[kind].append(params)
        queue = self.replies[kind]
        reply = queue.pop(0) if queue else {'output2': []}
        if isinstance(reply, Exception):
            raise reply
        return reply


class FakeKis(_Recorder):
    def private_get_uapi_domestic_stock_v1_quotations_inquire_daily_itemchartprice(self, params: Params) -> Any:
        return self.answer('daily', params)

    def private_get_uapi_domestic_stock_v1_quotations_inquire_time_itemchartprice(self, params: Params) -> Any:
        return self.answer('minute', params)

    def private_get_uapi_overseas_price_v1_quotations_dailyprice(self, params: Params) -> Any:
        return self.answer('overseas', params)


class AsyncFakeKis(_Recorder):
    async def private_get_uapi_domestic_stock_v1_quotations_inquire_daily_itemchartprice(self, params: Params) -> Any:
        return self.answer('daily', params)

    async def private_get_uapi_domestic_stock_v1_quotations_inquire_time_itemchartprice(self, params: Params) -> Any:
        return self.answer('minute', params)

    async def private_get_uapi_overseas_price_v1_quotations_dailyprice(self, params: Params) -> Any:
        return self.answer('overseas', params)


class Rig:
    """동기 판이나 비동기 판의 서비스를 만들고 부른다."""

    def __init__(self, flavor: str) -> None:
        self.flavor = flavor

    def make(self, now: int = NOW, daily: Sequence[Any] = (), minute: Sequence[Any] = (), overseas: Sequence[Any] = ()) -> Tuple[Any, _Recorder]:
        if self.flavor == 'async':
            fake: _Recorder = AsyncFakeKis(now, daily, minute, overseas)
            return AsyncCandleService(fake), fake
        fake = FakeKis(now, daily, minute, overseas)
        return SyncCandleService(fake), fake

    def run(self, result: Any) -> Any:
        return asyncio.run(result) if self.flavor == 'async' else result


@pytest.fixture(params=['sync', 'async'])
def rig(request: pytest.FixtureRequest) -> Rig:
    return Rig(request.param)


def daily_row(date: str, close: int) -> Dict[str, str]:
    return {'stck_bsop_date': date, 'stck_oprc': str(close - 1), 'stck_hgpr': str(close + 1), 'stck_lwpr': str(close - 2),
            'stck_clpr': str(close), 'acml_vol': '100'}


def minute_row(hms: str, close: int, date: str = '20260925') -> Dict[str, str]:
    return {'stck_bsop_date': date, 'stck_cntg_hour': hms, 'stck_oprc': str(close), 'stck_hgpr': str(close + 1), 'stck_lwpr': str(close - 1),
            'stck_prpr': str(close), 'cntg_vol': '10'}


def minutes_back(count: int, close: int = 100) -> List[Dict[str, str]]:
    """10:59 부터 1분씩 거슬러 `count` 개. 분봉 API 가 주는 순서(최근 먼저)다."""
    return [minute_row(f'10{59 - i:02d}00', close + i) for i in range(count)]


def dates(calls: List[Params]) -> List[Tuple[Any, Any]]:
    return [(p['FID_INPUT_DATE_1'], p['FID_INPUT_DATE_2']) for p in calls]


# ============ fetch_daily_ohlcv ============

def test_daily_asks_kst_dates_from_limit_times_margin_with_request_fields(rig: Rig) -> None:
    service, fake = rig.make()
    rig.run(service.fetch_daily_ohlcv('005930', 'D', 10))
    rig.run(service.fetch_daily_ohlcv('005930', 'W', 4))
    rig.run(service.fetch_daily_ohlcv('005930', 'M', 2))
    assert fake.calls['daily'][0] == {
        'FID_COND_MRKT_DIV_CODE': 'J', 'FID_INPUT_ISCD': '005930', 'FID_INPUT_DATE_1': '20260910', 'FID_INPUT_DATE_2': '20260925',
        'FID_PERIOD_DIV_CODE': 'D', 'FID_ORG_ADJ_PRC': '0', 'tr_id': 'FHKST03010100',
    }
    assert [(p['FID_PERIOD_DIV_CODE'], p['FID_INPUT_DATE_1'], p['FID_INPUT_DATE_2']) for p in fake.calls['daily']] == [
        ('D', '20260910', '20260925'), ('W', '20260814', '20260925'), ('M', '20260627', '20260925')]


def test_daily_returns_the_last_limit_rows_oldest_first_at_0900_kst(rig: Rig) -> None:
    rows = [daily_row('20260924', 30), daily_row('20260922', 10), daily_row('20260925', 40), daily_row('20260923', 20)]
    service, _ = rig.make(daily=[{'output2': rows}])
    assert rig.run(service.fetch_daily_ohlcv('005930', 'D', 3)) == [
        [kst('2026-09-23T09:00:00'), 19, 21, 18, 20, 100],
        [kst('2026-09-24T09:00:00'), 29, 31, 28, 30, 100],
        [kst('2026-09-25T09:00:00'), 39, 41, 38, 40, 100],
    ]


# ============ fetch_daily_ohlcv_paged ============

def test_paged_does_not_call_when_nothing_is_needed(rig: Rig) -> None:
    service, fake = rig.make()
    assert rig.run(service.fetch_daily_ohlcv_paged('005930', 'D', 0)) == []
    assert rig.run(service.fetch_daily_ohlcv_paged('005930', 'D', -5)) == []
    assert fake.calls['daily'] == []


def test_paged_moves_140_day_windows_back_stops_at_an_empty_one_and_merges(rig: Rig) -> None:
    pages = [{'output2': [daily_row('20260925', 30), daily_row('20260508', 20)]}, {'output2': [daily_row('20260508', 21), daily_row('20251220', 10)]},
             {'output2': []}]
    service, fake = rig.make(now=0, daily=pages)
    seen: List[int] = []
    candles = rig.run(service.fetch_daily_ohlcv_paged('005930', 'W', 250, NOW, seen.append))
    assert dates(fake.calls['daily']) == [('20260509', '20260925'), ('20251220', '20260508'), ('20250802', '20251219')]
    assert all(p['FID_PERIOD_DIV_CODE'] == 'W' and p['FID_INPUT_ISCD'] == '005930' for p in fake.calls['daily'])
    # 겹친 5/8 봉은 뒤 창의 것을 쓴다.
    assert [(c[0], c[4]) for c in candles] == [(kst('2025-12-20T09:00:00'), 10), (kst('2026-05-08T09:00:00'), 21), (kst('2026-09-25T09:00:00'), 30)]
    assert seen == [0, 1]


def test_paged_asks_one_window_per_100_rows_up_to_12(rig: Rig) -> None:
    service, fake = rig.make(daily=[{'output2': [daily_row('20260925', 1)]} for _ in range(20)])
    rig.run(service.fetch_daily_ohlcv_paged('005930', 'D', 5_000))
    assert len(fake.calls['daily']) == 12


def test_paged_raises_the_error_of_a_failed_window(rig: Rig) -> None:
    boom = RuntimeError('EGW00201')
    service, _ = rig.make(daily=[{'output2': [daily_row('20260925', 1)]}, boom])
    with pytest.raises(RuntimeError) as raised:
        rig.run(service.fetch_daily_ohlcv_paged('005930', 'D', 200))
    assert raised.value is boom


# ============ fetch_daily_ohlcv_range ============

def test_range_sends_the_given_dates_and_returns_numbers_oldest_first(rig: Rig) -> None:
    service, fake = rig.make(daily=[{'output2': [daily_row('20260522', 2), daily_row('20260521', 1)]}])
    candles = rig.run(service.fetch_daily_ohlcv_range('000660', 'M', '20260101', '20260522'))
    assert fake.calls['daily'] == [{
        'FID_COND_MRKT_DIV_CODE': 'J', 'FID_INPUT_ISCD': '000660', 'FID_INPUT_DATE_1': '20260101', 'FID_INPUT_DATE_2': '20260522',
        'FID_PERIOD_DIV_CODE': 'M', 'FID_ORG_ADJ_PRC': '0', 'tr_id': 'FHKST03010100',
    }]
    assert candles == [[kst('2026-05-21T09:00:00'), 0, 2, -1, 1, 100], [kst('2026-05-22T09:00:00'), 1, 3, 0, 2, 100]]


def test_range_is_empty_when_output2_is_not_a_list(rig: Rig) -> None:
    service, _ = rig.make(daily=[{'output2': None}, {'output2': {'stck_bsop_date': '20260522'}}])
    assert rig.run(service.fetch_daily_ohlcv_range('005930', 'D', '20260501', '20260522')) == []
    assert rig.run(service.fetch_daily_ohlcv_range('005930', 'D', '20260501', '20260522')) == []


def test_range_logs_and_raises_instead_of_returning_empty(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    boom = RuntimeError('network')
    service, _ = rig.make(daily=[boom])
    caplog.set_level(logging.ERROR, logger='kr_broker')
    with pytest.raises(RuntimeError) as raised:
        rig.run(service.fetch_daily_ohlcv_range('005930', 'D', '20260501', '20260522'))
    assert raised.value is boom
    assert '[KISCandleService] 기간별 캔들 조회 실패 (stockCode=005930, periodCode=D, 20260501~20260522)' in caplog.messages


# ============ fetch_minute_ohlcv ============

def test_minute_asks_without_cursor_then_with_the_last_time_and_stops_on_a_short_page(rig: Rig) -> None:
    service, fake = rig.make(minute=[{'output2': minutes_back(30)}, {'output2': [minute_row('102900', 99)]}])
    candles = rig.run(service.fetch_minute_ohlcv('005930', 1, 100))
    request = {'FID_COND_MRKT_DIV_CODE': 'J', 'FID_INPUT_ISCD': '005930', 'FID_PW_DATA_INCU_YN': 'N', 'FID_ETC_CLS_CODE': '', 'tr_id': 'FHKST03010200'}
    assert fake.calls['minute'] == [{**request, 'FID_INPUT_HOUR_1': ''}, {**request, 'FID_INPUT_HOUR_1': '103000'}]
    assert len(candles) == 31
    assert candles[0] == [kst('2026-09-25T10:29:00'), 99, 100, 98, 99, 10]
    assert candles[-1][0] == kst('2026-09-25T10:59:00')


def test_minute_stops_once_limit_rows_are_collected_and_returns_the_latest(rig: Rig) -> None:
    service, fake = rig.make(minute=[{'output2': minutes_back(30)}, {'output2': minutes_back(30)}])
    candles = rig.run(service.fetch_minute_ohlcv('005930', 1, 20))
    assert len(fake.calls['minute']) == 1
    assert [c[0] for c in candles] == [kst(f'2026-09-25T10:{40 + i}:00') for i in range(20)]


def test_minute_stops_when_the_cursor_stalls_and_skips_rows_without_date_or_time(rig: Rig) -> None:
    page = [*minutes_back(29), minute_row('103000', 1)]
    service, fake = rig.make(minute=[{'output2': page}, {'output2': page}, {'output2': [minute_row('', 5)]}])
    candles = rig.run(service.fetch_minute_ohlcv('005930', 1, 100))
    assert [p['FID_INPUT_HOUR_1'] for p in fake.calls['minute']] == ['', '103000']
    assert len(candles) == 30
    blanks, _ = rig.make(minute=[{'output2': [minute_row('', 5), minute_row('100000', 5, ''), minute_row('100100', 7)]}])
    assert rig.run(blanks.fetch_minute_ohlcv('005930', 1, 100)) == [[kst('2026-09-25T10:01:00'), 7, 8, 6, 7, 10]]


def test_minute_resamples_into_n_minute_buckets_on_kst_boundaries(rig: Rig) -> None:
    # 10:39 부터 10:30 까지. 종가는 10:30 이 0, 10:39 가 9 다.
    rows = [minute_row(f'10{39 - i}00', 9 - i) for i in range(10)]
    service, _ = rig.make(minute=[{'output2': rows}])
    assert rig.run(service.fetch_minute_ohlcv('005930', 5, 10)) == [
        [kst('2026-09-25T10:30:00'), 0, 5, -1, 4, 50],
        [kst('2026-09-25T10:35:00'), 5, 10, 4, 9, 50],
    ]


def test_minute_logs_and_raises_instead_of_returning_empty(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    boom = RuntimeError('network')
    service, _ = rig.make(minute=[boom])
    caplog.set_level(logging.ERROR, logger='kr_broker')
    with pytest.raises(RuntimeError) as raised:
        rig.run(service.fetch_minute_ohlcv('005930', 1, 10))
    assert raised.value is boom
    assert '[KISCandleService] 분봉 캔들 조회 실패 (stockCode=005930, minuteInterval=1)' in caplog.messages


# ============ 실행 환경 시간대 ============

# 한국, 미국 동부와 함께 날짜선 양 끝(UTC+14, 서부)도 돈다. 값은 1월의 UTC 와의 차이(초)다.
ZONES = [('UTC', 0), ('Asia/Seoul', 32_400), ('America/New_York', -18_000), ('America/Los_Angeles', -28_800), ('Pacific/Kiritimati', 50_400)]


@pytest.fixture(params=ZONES, ids=[name for name, _ in ZONES])
def zone(request: pytest.FixtureRequest) -> Iterator[str]:
    if not hasattr(time, 'tzset'):
        pytest.skip('time.tzset 은 Unix 에만 있다')
    name, january_offset = request.param
    original: Optional[str] = os.environ.get('TZ')
    os.environ['TZ'] = name
    time.tzset()
    try:
        # 시간대가 실제로 바뀌었는지 먼저 본다. 바뀌지 않으면 아래 테스트는 아무것도 검사하지 않는다.
        assert time.localtime(utc('2026-01-15T00:00:00') // 1000).tm_gmtoff == january_offset
        yield name
    finally:
        if original is None:
            del os.environ['TZ']
        else:
            os.environ['TZ'] = original
        time.tzset()


def test_tz_domestic_daily_dates_switch_at_kst_midnight(rig: Rig, zone: str) -> None:
    before, before_fake = rig.make(now=utc('2026-09-25T14:59:59') + 999)  # 한국 9/25 23:59:59.999
    after, after_fake = rig.make(now=utc('2026-09-25T15:00:00'))  # 한국 9/26 00:00
    for service in (before, after):
        rig.run(service.fetch_daily_ohlcv('005930', 'D', 2))
        rig.run(service.fetch_daily_ohlcv_paged('005930', 'D', 1))
    assert dates(before_fake.calls['daily']) == [('20260922', '20260925'), ('20260509', '20260925')]
    assert dates(after_fake.calls['daily']) == [('20260923', '20260926'), ('20260510', '20260926')]


def test_tz_domestic_daily_and_minute_times_are_read_as_kst(rig: Rig, zone: str) -> None:
    service, _ = rig.make(daily=[{'output2': [daily_row('20260101', 1), daily_row('20261231', 2)]}],
                          minute=[{'output2': [minute_row('000000', 1, '20260101'), minute_row('235900', 2, '20261231')]}])
    daily = rig.run(service.fetch_daily_ohlcv_range('005930', 'D', '20260101', '20261231'))
    minute = rig.run(service.fetch_minute_ohlcv('005930', 1, 10))
    assert [c[0] for c in daily] == [utc('2026-01-01T00:00:00'), utc('2026-12-31T00:00:00')]
    assert [c[0] for c in minute] == [utc('2025-12-31T15:00:00'), utc('2026-12-31T14:59:00')]


def test_tz_n_minute_buckets_start_on_the_kst_hour(rig: Rig, zone: str) -> None:
    service, _ = rig.make(minute=[{'output2': [minute_row('091500', 3), minute_row('090100', 2), minute_row('085900', 1)]}])
    candles = rig.run(service.fetch_minute_ohlcv('005930', 60, 10))
    assert [(c[0], c[5]) for c in candles] == [(kst('2026-09-25T08:00:00'), 10), (kst('2026-09-25T09:00:00'), 20)]


@pytest.mark.parametrize('now, bymd', [
    # 서머타임(EDT, UTC-4): 동부 자정은 04:00Z 다.
    ('2026-09-25T03:59:59', '20260924'), ('2026-09-25T04:00:00', '20260925'),
    # 표준시(EST, UTC-5): 동부 자정은 05:00Z 다.
    ('2026-01-15T04:59:59', '20260114'), ('2026-01-15T05:00:00', '20260115'),
    # 서머타임 시작일(3/8)의 자정은 아직 표준시, 끝나는 날(11/1)의 자정은 아직 서머타임이다.
    ('2026-03-08T04:59:59', '20260307'), ('2026-03-08T05:00:00', '20260308'),
    ('2026-11-01T03:59:59', '20261031'), ('2026-11-01T04:00:00', '20261101'),
])
def test_tz_overseas_base_date_is_the_us_eastern_date(rig: Rig, zone: str, now: str, bymd: str) -> None:
    service, fake = rig.make(now=utc(now))
    rig.run(service.fetch_overseas_daily_ohlcv('AAPL', 'NAS', '1d', 10))
    assert [p['BYMD'] for p in fake.calls['overseas']] == [bymd]


def test_tz_overseas_next_base_date_is_the_day_before_the_last_row(rig: Rig, zone: str) -> None:
    def row(day: datetime.date) -> Dict[str, str]:
        return {'xymd': day.strftime('%Y%m%d'), 'open': '1', 'high': '2', 'low': '0.5', 'clos': '1.5', 'tvol': '10'}

    first = [row(datetime.date(2026, 6, 7) - datetime.timedelta(days=i)) for i in range(100)]
    service, fake = rig.make(now=utc('2026-06-08T12:00:00'), overseas=[{'output2': first}, {'output2': [row(datetime.date(2026, 2, 27))]}])
    candles = rig.run(service.fetch_overseas_daily_ohlcv('AAPL', 'NAS', '1d', 150))
    # 100번째 날은 2026-02-28 이다. 그 하루 전은 2/27 이다.
    assert [p['BYMD'] for p in fake.calls['overseas']] == ['20260608', '20260227']
    assert candles[0][0] == utc('2026-02-27T00:00:00') and candles[-1][0] == utc('2026-06-07T00:00:00')
