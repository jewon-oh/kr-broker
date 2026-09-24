"""휴장일 캘린더. 증권사 API 가 알려 준 날짜별 개장 여부를 프로세스 메모리에 둔다. TypeScript 판 `ts/src/market-calendar.ts` 와 같다.

한국 휴장일은 계산으로 구할 수 없어(음력 명절, 대체공휴일, 임시공휴일) 표를 적어 두지 않고 증권사 캘린더 API 로 받는다.

- 어댑터는 `refresh_market_calendar()` 로 API 를 부르고 결과를 `apply_market_calendar()` 로 넣는다.
- 장 시간 판정(`krx_trading_hours`, `us_market_hours`)은 API 를 부르지 않고 이 모듈의 값을 읽는다.
- 캘린더에 없는 평일은 열린 날로 본다. 그 달마다 한 번 경고를 남긴다.

날짜는 시장 현지 달력 날짜(국내는 KST, 미국은 ET)의 `YYYYMMDD` 이고, 하루는 `{'date': 'YYYYMMDD', 'open': bool}` 사전이다.
"""

import datetime
import logging
import re
import threading
from typing import Any, Callable, Dict, Iterable, List, Optional

from kr_broker.base import functions as fn

logger = logging.getLogger('kr_broker')

# 갱신에 실패한 뒤 다시 시도하기까지의 간격.
CALENDAR_RETRY_MS = 10 * 60_000

_DATE_RE = re.compile(r'[0-9]{8}')
_MARKETS = ('KR', 'US')

_known_days: Dict[str, Dict[str, bool]] = {'KR': {}, 'US': {}}
_warned_unknown_days: set = set()
_refresh_state: Dict[str, Dict[str, Optional[int]]] = {market: {'okAtMs': None, 'failedAtMs': None} for market in _MARKETS}
# 같은 시장의 동시 갱신을 하나로 합친다. 뒤에 들어온 호출은 앞 호출이 끝난 뒤 신선도를 다시 본다.
_refresh_locks = {market: threading.Lock() for market in _MARKETS}


def _parse_ymd(ymd: Any) -> Optional[datetime.date]:
    """`YYYYMMDD` 가 실제 달력에 있는 날짜면 그 날짜. `20260231` 같은 값은 거른다."""
    if not isinstance(ymd, str) or _DATE_RE.fullmatch(ymd) is None:
        return None
    try:
        return datetime.date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:8]))
    except ValueError:
        return None


def _is_weekend(d: datetime.date) -> bool:
    return d.weekday() >= 5


def apply_market_calendar(market: str, days: Iterable[Dict[str, Any]]) -> None:
    """증권사 API 가 알려 준 날짜별 개장 여부를 넣는다. 같은 날짜는 새 값으로 덮어쓰고, 형식이 틀린 날짜와 주말은 버린다."""
    target = _known_days[market]
    for day in days:
        d = _parse_ymd(day.get('date'))
        if d is None or _is_weekend(d):
            continue
        target[day['date']] = bool(day.get('open'))


def expand_business_days(open_dates: Iterable[str], closed_dates: Iterable[str] = ()) -> List[Dict[str, Any]]:
    """열린 날짜만 아는 API 응답을 날짜별 개장 여부로 넓힌다. 가장 이른 열린 날과 가장 늦은 열린 날 사이에서
    열린 날로 적히지 않은 평일은 닫힌 날이다. `closed_dates` 는 API 가 직접 닫혔다고 알려 준 날짜다."""
    opens = sorted(d for d in open_dates if _parse_ymd(d) is not None)
    out: Dict[str, bool] = {}
    if opens:
        first = _parse_ymd(opens[0])
        last = _parse_ymd(opens[-1])
        current = first
        while current <= last:
            out[current.strftime('%Y%m%d')] = False
            current += datetime.timedelta(days=1)
    for d in opens:
        out[d] = True
    for d in closed_dates:
        if _parse_ymd(d) is not None:
            out[d] = False
    return [{'date': date, 'open': is_open} for date, is_open in out.items()]


def market_day_status(market: str, ymd: str) -> str:
    """그 날짜가 `'open'`·`'closed'` 인지, 캘린더가 모르는 날짜(`'unknown'`)인지. 주말은 항상 `'closed'` 다."""
    d = _parse_ymd(ymd)
    if d is None:
        return 'unknown'
    if _is_weekend(d):
        return 'closed'
    known = _known_days[market].get(ymd)
    if known is not None:
        return 'open' if known else 'closed'
    key = f'{market}:{ymd[:6]}'
    if key not in _warned_unknown_days:
        _warned_unknown_days.add(key)
        logger.warning('[market-calendar] 휴장일 정보를 받지 못한 날짜가 있다(%s %s). 그 달의 평일은 열린 날로 보고 주말만 거른다. '
                       '증권사 캘린더 API 호출을 확인한다', market, ymd)
    return 'unknown'


def is_market_closed_day(market: str, ymd: str) -> bool:
    """캘린더가 그 날짜를 닫힌 날로 알고 있는가. 모르는 날짜는 `False` 다."""
    return market_day_status(market, ymd) == 'closed'


def market_calendar_status(market: str) -> Dict[str, Any]:
    """시장별 캘린더 상태 `{knownDays, latestDate, refreshedAtMs}`. 캘린더를 못 받고 있는지 감시하는 데 쓴다."""
    dates = sorted(_known_days[market].keys())
    return {
        'knownDays': len(dates),
        'latestDate': dates[-1] if dates else None,
        'refreshedAtMs': _refresh_state[market]['okAtMs'],
    }


def refresh_market_calendar(market: str, fetch_days: Callable[[], Iterable[Dict[str, Any]]], ttl_ms: int,
                            now_ms: Optional[int] = None) -> bool:
    """캘린더를 API 로 갱신한다. 아직 신선하면 부르지 않고, 실패하면 `False` 를 돌려준다(던지지 않는다).

    `fetch_days` 는 API 를 불러 날짜별 개장 여부를 돌려주는 함수이고, 던지면 실패로 센다. 신선한 캘린더가 있으면 `True` 다.
    """
    now = fn.milliseconds() if now_ms is None else now_ms
    with _refresh_locks[market]:
        state = _refresh_state[market]
        if state['okAtMs'] is not None and now - state['okAtMs'] < ttl_ms:
            return True
        if state['failedAtMs'] is not None and now - state['failedAtMs'] < CALENDAR_RETRY_MS:
            return state['okAtMs'] is not None
        try:
            apply_market_calendar(market, fetch_days())
            state['okAtMs'] = now
            state['failedAtMs'] = None
            return True
        except Exception:
            state['failedAtMs'] = now
            logger.warning('[market-calendar] %s 캘린더 API 호출 실패. 10분 뒤 다시 시도한다', market, exc_info=True)
            return state['okAtMs'] is not None


def reset_market_calendar() -> None:
    """캘린더와 갱신 상태를 비운다. 테스트 전용이다."""
    for market in _MARKETS:
        _known_days[market].clear()
        _refresh_state[market] = {'okAtMs': None, 'failedAtMs': None}
    _warned_unknown_days.clear()
