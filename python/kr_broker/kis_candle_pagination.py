"""KIS 국내 일봉 페이지 창 계산. TypeScript 판 `ts/src/kis/kis-candle-pagination.ts` 와 같다.

KIS `inquire-daily-itemchartprice` 는 한 응답에 100행쯤만 준다. 800봉이 필요하면 창을 과거로 옮겨 가며 여러 번 불러야 한다.
그 창을 여기서 계산한다. 날짜 계산은 부수효과와 섞이면 시험하기 어려워 따로 둔다.
"""

import datetime
import math
from typing import Dict, Iterable, List, Optional

# 한 응답의 최대 행 수(실측).
KIS_DAILY_PAGE_ROWS = 100
# 한 창에 담는 달력일 수. 거래일은 달력일의 68% 쯤이라 100 거래일은 147 달력일쯤이다. 한 창이 100행을 넘지 않게 140일로 좁힌다.
KIS_DAILY_PAGE_DAYS = 140
# 창이 과거로 끝없이 이어지지 않게 막는 상한.
KIS_DAILY_MAX_PAGES = 12

MS_PER_DAY = 86_400_000
KST_OFFSET_MS = 9 * 60 * 60 * 1000
_EPOCH = datetime.datetime(1970, 1, 1)


def to_kis_date(ms: float) -> str:
    """UTC 밀리초 → `YYYYMMDD`. KIS 인자 형식이고, 실행 환경의 시간대가 아니라 한국 날짜다. 시각이 아니면 JavaScript 처럼 `NaNNaNNaN` 이다."""
    if not isinstance(ms, (int, float)) or not math.isfinite(ms):
        return 'NaNNaNNaN'
    d = _EPOCH + datetime.timedelta(milliseconds=ms + KST_OFFSET_MS)
    return f'{d.year:04d}{d.month:02d}{d.day:02d}'


def window_before(end_ms: float, days: int = KIS_DAILY_PAGE_DAYS) -> Dict[str, str]:
    """`end_ms` 가 끝인 창 하나(`{'start', 'end'}`, `YYYYMMDD`). 창은 겹치지 않게 이어 붙인다."""
    return {'start': to_kis_date(end_ms - (days - 1) * MS_PER_DAY), 'end': to_kis_date(end_ms)}


def plan_windows(needed_candles: float, now_ms: float, page_rows: Optional[int] = None, page_days: Optional[int] = None,
                 max_pages: Optional[int] = None) -> List[Dict[str, str]]:
    """오늘부터 과거로 거슬러 가며 필요한 창 목록을 만든다. `needed_candles` 가 0 이하면 창이 없다(이미 충분하면 부르지 않는다)."""
    rows = KIS_DAILY_PAGE_ROWS if page_rows is None else page_rows
    days = KIS_DAILY_PAGE_DAYS if page_days is None else page_days
    limit = KIS_DAILY_MAX_PAGES if max_pages is None else max_pages
    if not isinstance(needed_candles, (int, float)) or not math.isfinite(needed_candles) or needed_candles <= 0:
        return []
    pages = min(limit, math.ceil(needed_candles / rows))
    out = []
    cursor = now_ms
    for _ in range(pages):
        out.append(window_before(cursor, days))
        cursor -= days * MS_PER_DAY
    return out


def merge_candles(pages: Iterable[List[List[float]]]) -> List[List[float]]:
    """여러 창에서 받은 봉을 시각으로 합친다. 같은 시각은 뒤의 것을 쓰고, 시각 오름차순으로 돌려준다."""
    by_ts: Dict[float, List[float]] = {}
    for page in pages:
        for candle in page:
            ts = candle[0]
            if not isinstance(ts, (int, float)) or not math.isfinite(ts):
                continue
            by_ts[ts] = candle
    return sorted(by_ts.values(), key=lambda c: c[0])


def slice_candle_window(candles: List[List[float]], since: Optional[float], until: Optional[float],
                        limit: Optional[int]) -> List[List[float]]:
    """시각 오름차순 봉에서 `since <= 시각 <= until` 인 것만 골라 ccxt 규칙대로 `limit` 개를 남긴다.
    `since` 가 있으면 가장 이른 것부터, 없으면 가장 최근 것부터다."""
    in_window = [c for c in candles if (since is None or c[0] >= since) and (until is None or c[0] <= until)]
    if limit is None:
        return in_window
    return in_window[-limit:] if since is None else in_window[:limit]
