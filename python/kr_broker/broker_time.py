"""타임프레임 변환과 봉 시각 규칙. TypeScript 판 `ts/src/broker-time.ts` 와 같다."""

import calendar
import math
import re
import time

from kr_broker.us_market_hours import et_ymd

MS_PER_MINUTE = 60_000
MS_PER_HOUR = 60 * MS_PER_MINUTE
MS_PER_DAY = 24 * MS_PER_HOUR
MS_PER_WEEK = 7 * MS_PER_DAY

_TIMEFRAME_UNIT_MS = {'m': MS_PER_MINUTE, 'h': MS_PER_HOUR, 'd': MS_PER_DAY, 'w': MS_PER_WEEK}
_TIMEFRAME_RE = re.compile(r'([0-9]+)([mhdw])')


def timeframe_to_ms(timeframe: str) -> float:
    """타임프레임(`5m`, `1h`, `1d`, `1w`)을 밀리초로 바꾼다. 읽지 못하면 NaN 이다. 월봉 `1M` 과 대문자 주봉 `1W` 도 NaN 이다."""
    match = _TIMEFRAME_RE.fullmatch(timeframe) if isinstance(timeframe, str) else None
    if match is None:
        return math.nan
    return int(match.group(1)) * _TIMEFRAME_UNIT_MS.get(match.group(2), MS_PER_MINUTE)

_KST_OFFSET_MS = 9 * MS_PER_HOUR
_DAILY_OR_LONGER_RE = re.compile(r'[0-9]+[dwWMy]')


def is_daily_or_longer_timeframe(timeframe: str) -> bool:
    """일·주·월·연봉인가(`1d`, `1w`, `1W`, `1M`, `1y` 등). 분봉과 시봉은 아니다."""
    return _DAILY_OR_LONGER_RE.fullmatch(timeframe) is not None


def candle_period_utc_ms(timestamp: int, timeframe: str, market: str) -> int:
    """일·주·월·연봉의 시각 규칙: 그 봉이 덮는 기간 첫날(그 시장의 현지 날짜)의 00:00 UTC 다. 주봉은 월요일, 월봉은 1일, 연봉은 1월 1일이다.
    TypeScript 판 `candlePeriodUtcMs` 와 같다."""
    if market == 'KR':
        day = (int(timestamp) + _KST_OFFSET_MS) // MS_PER_DAY * MS_PER_DAY
    else:
        ymd = et_ymd(int(timestamp))
        day = calendar.timegm((int(ymd[0:4]), int(ymd[4:6]), int(ymd[6:8]), 0, 0, 0, 0, 0, 0)) * 1000
    unit = timeframe[-1:]
    if unit in ('w', 'W'):
        # 1970-01-01 은 목요일이다. 월요일을 0 으로 센 요일만큼 되돌린다.
        return day - ((day // MS_PER_DAY + 3) % 7) * MS_PER_DAY
    if unit in ('M', 'y'):
        year, month = time.gmtime(day // 1000)[0:2]
        return calendar.timegm((year, month if unit == 'M' else 1, 1, 0, 0, 0, 0, 0, 0)) * 1000
    return day
