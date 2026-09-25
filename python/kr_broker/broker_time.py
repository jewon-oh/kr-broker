"""타임프레임 변환. TypeScript 판 `ts/src/broker-time.ts` 와 같다."""

import math
import re

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
