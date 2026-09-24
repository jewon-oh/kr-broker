"""NYSE·NASDAQ 정규장(09:30~16:00 ET)과 시장 단계. TypeScript 판 `ts/src/us-market-hours.ts` 와 같다.

미 동부 시각은 TypeScript 판(`Intl` 의 `America/New_York`)처럼 IANA 시간대 자료(`zoneinfo`)로 구해 서머타임을 따른다.
시간대 자료가 없는 환경(tzdata 가 없는 Windows 등)에서는 2007년부터의 미국 서머타임 규칙(3월 둘째 일요일 ~ 11월 첫째 일요일)으로 계산한다.
휴장일은 증권사 캘린더(`market_calendar`)가 알려 준 날짜만 안다. 시각 인자는 UTC 밀리초이고, 생략하면 지금이다.
"""

import calendar
import datetime
import logging
from typing import NamedTuple, Optional

from kr_broker.base import functions as fn
from kr_broker.market_calendar import is_market_closed_day

logger = logging.getLogger('kr_broker')

MARKET_OPEN_HOUR_ET = 9
MARKET_OPEN_MINUTE_ET = 30
MARKET_CLOSE_HOUR_ET = 16
MARKET_CLOSE_MINUTE_ET = 0
# 시초가 동시호가(09:25 ET)와 종가 동시호가(15:50 ET) 시작.
PRE_AUCTION_OPEN_HOUR_ET = 9
PRE_AUCTION_OPEN_MINUTE_ET = 25
CLOSING_AUCTION_OPEN_HOUR_ET = 15
CLOSING_AUCTION_OPEN_MINUTE_ET = 50

_ET_ZONE_NAME = 'America/New_York'
_EPOCH_UTC = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
_MISSING = object()
_et_zone = _MISSING


class EtWallClock(NamedTuple):
    """미 동부 벽시계 시각. `weekday` 는 TypeScript 판처럼 0=일요일 … 6=토요일이다."""
    year: int
    month: int
    day: int
    hour: int
    minute: int
    weekday: int


def _zone():
    """`America/New_York` 시간대. 시간대 자료가 없으면 `None`(처음 한 번 경고한다)."""
    global _et_zone
    if _et_zone is _MISSING:
        try:
            from zoneinfo import ZoneInfo
            _et_zone = ZoneInfo(_ET_ZONE_NAME)
        except Exception:
            logger.warning('[us-market-hours] 시간대 자료(%s)가 없어 미국 서머타임 규칙으로 동부 시각을 계산한다', _ET_ZONE_NAME)
            _et_zone = None
    return _et_zone


def _nth_sunday(year: int, month: int, nth: int) -> int:
    first_weekday = datetime.date(year, month, 1).weekday()  # 월요일 0 … 일요일 6
    return 1 + (6 - first_weekday) % 7 + 7 * (nth - 1)


def _rule_offset(utc: datetime.datetime) -> datetime.timedelta:
    """시간대 자료가 없을 때 쓰는 동부 시각의 UTC 편차. 서머타임은 3월 둘째 일요일 02:00 EST ~ 11월 첫째 일요일 02:00 EDT 다."""
    year = utc.year
    start = datetime.datetime(year, 3, _nth_sunday(year, 3, 2), 7, tzinfo=datetime.timezone.utc)
    end = datetime.datetime(year, 11, _nth_sunday(year, 11, 1), 6, tzinfo=datetime.timezone.utc)
    return datetime.timedelta(hours=-4 if start <= utc < end else -5)


def _to_et_wall_clock(now_ms: int) -> EtWallClock:
    utc = _EPOCH_UTC + datetime.timedelta(milliseconds=now_ms)
    zone = _zone()
    et = utc.astimezone(zone) if zone is not None else (utc + _rule_offset(utc)).replace(tzinfo=None)
    return EtWallClock(et.year, et.month, et.day, et.hour, et.minute, (et.weekday() + 1) % 7)


def et_wall_clock(now_ms: Optional[int] = None) -> EtWallClock:
    """미국 동부 벽시계 시각(연, 월, 일, 시, 분, 요일). 해외 체결 조회처럼 현지 날짜가 필요한 곳에서 쓴다."""
    return _to_et_wall_clock(fn.milliseconds() if now_ms is None else now_ms)


def _is_us_holiday(et: EtWallClock) -> bool:
    """그 동부 날짜가 휴장일인가. 증권사 캘린더가 알려 준 날짜만 안다."""
    if et.weekday in (0, 6):
        return False
    return is_market_closed_day('US', f'{et.year}{et.month:02d}{et.day:02d}')


def get_us_market_phase(now_ms: Optional[int] = None) -> str:
    """미국 시장 단계: `'pre-auction'`(09:25~09:30 ET), `'open'`(09:30~15:50), `'closing-auction'`(15:50~16:00), `'closed'`.
    프리·애프터마켓은 `'closed'` 다."""
    et = _to_et_wall_clock(fn.milliseconds() if now_ms is None else now_ms)
    if et.weekday in (0, 6):
        return 'closed'
    if _is_us_holiday(et):
        return 'closed'
    minutes = et.hour * 60 + et.minute
    pre_auction_start = PRE_AUCTION_OPEN_HOUR_ET * 60 + PRE_AUCTION_OPEN_MINUTE_ET
    open_min = MARKET_OPEN_HOUR_ET * 60 + MARKET_OPEN_MINUTE_ET
    closing_auction_start = CLOSING_AUCTION_OPEN_HOUR_ET * 60 + CLOSING_AUCTION_OPEN_MINUTE_ET
    close_min = MARKET_CLOSE_HOUR_ET * 60 + MARKET_CLOSE_MINUTE_ET
    if minutes < pre_auction_start or minutes >= close_min:
        return 'closed'
    if minutes < open_min:
        return 'pre-auction'
    if minutes < closing_auction_start:
        return 'open'
    return 'closing-auction'


def get_time_until_us_market_open(now_ms: Optional[int] = None) -> int:
    """다음 미국 정규장 개장(09:30 ET)까지의 밀리초. 정규장이나 동시호가 중이면 0. 14일 안에 개장을 못 찾으면 0 이다."""
    now = fn.milliseconds() if now_ms is None else now_ms
    if get_us_market_phase(now) != 'closed':
        return 0
    et_now = _to_et_wall_clock(now)
    for i in range(14):
        # i일 뒤 동부 날짜. 정오 UTC 를 기준으로 삼아 서머타임과 상관없이 연·월·일·요일을 구한다.
        anchor = datetime.datetime(et_now.year, et_now.month, et_now.day, 12) + datetime.timedelta(days=i)
        weekday = (anchor.weekday() + 1) % 7
        if weekday in (0, 6):
            continue
        if _is_us_holiday(EtWallClock(anchor.year, anchor.month, anchor.day, 12, 0, weekday)):
            continue
        open_utc_ms = et_wall_clock_to_utc_ms(anchor.year, anchor.month, anchor.day, MARKET_OPEN_HOUR_ET, MARKET_OPEN_MINUTE_ET)
        if open_utc_ms <= now:
            continue
        return open_utc_ms - now
    return 0


def et_wall_clock_to_utc_ms(year: int, month: int, day: int, hour: int, minute: int) -> int:
    """동부 벽시계 시각을 UTC 밀리초로 바꾼다. 그 시각을 UTC 로 가정했을 때의 동부 시각과의 차이만큼 되돌린다(한 번 역산)."""
    as_if_utc = calendar.timegm((year, month, day, hour, minute, 0, 0, 0, 0)) * 1000
    et = _to_et_wall_clock(as_if_utc)
    et_as_if_utc = calendar.timegm((et.year, et.month, et.day, et.hour, et.minute, 0, 0, 0, 0)) * 1000
    return as_if_utc - (et_as_if_utc - as_if_utc)


def format_et_wall_clock(now_ms: Optional[int] = None) -> str:
    """로그용 동부 벽시계 문자열(`2026-03-25 10:30 ET`)."""
    et = _to_et_wall_clock(fn.milliseconds() if now_ms is None else now_ms)
    return f'{et.year}-{et.month:02d}-{et.day:02d} {et.hour:02d}:{et.minute:02d} ET'
