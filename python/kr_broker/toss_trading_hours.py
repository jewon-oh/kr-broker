"""토스증권의 세션 판정과 세션별 주문 형태 제한. TypeScript 판 `ts/src/toss/toss-trading-hours.ts` 와 같다.

국내는 `GET /market-calendar/KR`(KRX 와 NXT 통합)의 세션 구간으로, 미국은 `GET /market-calendar/US` 의 네 세션(주간거래·프리마켓·정규장·애프터마켓,
전부 한국 시각)으로 지금 열려 있는 세션을 찾는다. 캘린더를 받지 못했을 때만 정적 시간표(`is_toss_orderable`)로 판정한다.
시각 인자는 UTC 밀리초이고, 생략하면 지금이다. 주문 형태는 `{'isMarket', 'useAmountBased', 'quantity'}` 사전이다.
"""

import math
from typing import Any, Callable, Dict, Iterable, List, Optional

from kr_broker.base import functions as fn
from kr_broker.market_calendar import expand_business_days
from kr_broker.toss_types import toss_market_country
from kr_broker.krx_trading_hours import krx_order_block_reason
from kr_broker.trading_hours import get_time_until_market_open, is_trading_hours
from kr_broker.us_market_hours import us_order_block_reason

# 캘린더를 훑는 순서. 경계 시각(22:30 등)은 앞선 세션에 귀속된다.
US_SESSION_ORDER = ('regularMarket', 'preMarket', 'dayMarket', 'afterMarket')
KR_SESSION_ORDER = ('regularMarket', 'preMarket', 'afterMarket')

# 금액 주문과 소수점 수량 주문은 정규장 종료 이 시간 전까지만 접수된다.
FRACTIONAL_ORDER_CUTOFF_MS = 60 * 60 * 1000

_BUSINESS_DAY_KEYS = ('previousBusinessDay', 'today', 'nextBusinessDay')


def _now(now_ms: Optional[int]) -> int:
    return fn.milliseconds() if now_ms is None else now_ms


def _is_integer(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value) and value.is_integer()


def _days(calendar: Dict[str, Any]) -> List[Any]:
    return [calendar.get(key) for key in _BUSINESS_DAY_KEYS]


def _find_session_at(order: Iterable[str], days: List[Any], window_of: Callable[[Dict[str, Any], str], Any], now_ms: int) -> Optional[str]:
    """영업일 목록에서 `now_ms` 가 속한 세션. 세션을 `order` 순으로 훑어 먼저 겹치는 것을 돌려준다. 구간은 `[시작, 종료)` 다."""
    for session in order:
        for day in days:
            if not isinstance(day, dict):
                continue
            window = window_of(day, session)
            if not isinstance(window, dict) or not window.get('startTime') or not window.get('endTime'):
                continue
            start = fn.parse8601(window['startTime'])
            end = fn.parse8601(window['endTime'])
            if start is None or end is None:
                continue
            if start <= now_ms < end:
                return session
    return None


def find_us_session(calendar: Optional[Dict[str, Any]], now_ms: Optional[int] = None) -> Optional[str]:
    """미국 캘린더에서 지금의 세션. 휴장이거나 세션 사이의 공백이면 `None`. 정규장이 한국 시각 자정을 넘으므로 세 영업일을 모두 훑는다."""
    if not calendar:
        return None
    return _find_session_at(US_SESSION_ORDER, _days(calendar), lambda day, session: day.get(session), _now(now_ms))


def find_us_regular_close_ms(calendar: Optional[Dict[str, Any]], now_ms: Optional[int] = None) -> Optional[int]:
    """지금을 품은 미국 정규장 구간의 종료 시각(UTC 밀리초). 정규장이 아니면 `None`."""
    if not calendar:
        return None
    t = _now(now_ms)
    for day in _days(calendar):
        window = day.get('regularMarket') if isinstance(day, dict) else None
        if not isinstance(window, dict) or not window.get('startTime') or not window.get('endTime'):
            continue
        start = fn.parse8601(window['startTime'])
        end = fn.parse8601(window['endTime'])
        if start is not None and end is not None and start <= t < end:
            return end
    return None


def find_kr_session(calendar: Optional[Dict[str, Any]], now_ms: Optional[int] = None) -> Optional[str]:
    """국내 캘린더에서 지금의 세션. 세션은 `integrated`(KRX 와 NXT 통합) 아래에 있고, 전 시장이 쉬면 `integrated` 가 `None` 이다."""
    if not calendar:
        return None
    return _find_session_at(KR_SESSION_ORDER, _days(calendar), lambda day, session: (day.get('integrated') or {}).get(session), _now(now_ms))


def us_session_order_restriction(session: str, form: Dict[str, Any], cutoff: Optional[Dict[str, int]] = None) -> Optional[str]:
    """미국 세션별로 허용하는 주문 형태를 검사한다. 막는 사유(한국어)이고, 접수할 수 있으면 `None`.

    금액 주문과 소수점 수량 주문은 정규장 전용이며 정규장 종료 1시간 전까지만 접수된다. 시장가도 정규장 밖에서는 막는다.
    `cutoff` 는 `{'nowMs', 'regularCloseMs'}` 다.
    """
    fractional = form['useAmountBased'] or not _is_integer(form['quantity'])
    if session == 'regularMarket':
        if fractional and cutoff is not None and cutoff['nowMs'] >= cutoff['regularCloseMs'] - FRACTIONAL_ORDER_CUTOFF_MS:
            if form['useAmountBased']:
                return '정규장 종료 1시간 전 이후: 금액(orderAmount) 주문은 접수되지 않는다'
            return '정규장 종료 1시간 전 이후: 소수점 수량 주문은 접수되지 않는다'
        return None
    label = f'{session} 세션'
    if form['useAmountBased']:
        return f'{label}: 금액(orderAmount) 주문은 정규장 전용'
    if form['isMarket']:
        return f'{label}: 시장가 주문은 정규장 전용 — 지정가로 발주 필요'
    if not _is_integer(form['quantity']):
        return f'{label}: 소수점 수량 주문은 정규장 전용'
    return None


def kr_session_order_restriction(session: str, form: Dict[str, Any]) -> Optional[str]:
    """국내 확장세션(프리마켓·애프터마켓)에서 허용하는 주문 형태. 금액 주문, 시장가, 소수점 수량을 막는다. 접수할 수 있으면 `None`."""
    if session == 'regularMarket':
        return None
    label = f'KRX {session} 세션'
    if form['useAmountBased']:
        return f'{label}: 금액(orderAmount) 주문은 정규장 전용'
    if form['isMarket']:
        return f'{label}: 시장가 주문은 정규장 전용 — 지정가로 발주 필요'
    if not _is_integer(form['quantity']):
        return f'{label}: 소수점 수량 주문 불가'
    return None


def is_toss_trading_open(now_ms: Optional[int] = None) -> bool:
    """국내 정규장이 열려 있는가(정적 시간표)."""
    return is_trading_hours('toss', now_ms)


def time_until_toss_open(now_ms: Optional[int] = None) -> int:
    """다음 국내 개장까지 남은 밀리초. 열려 있으면 0."""
    return get_time_until_market_open('toss', now_ms)


def is_toss_orderable(symbol: str, now_ms: Optional[int] = None) -> bool:
    """종목의 시장 기준으로 지금 주문할 수 있는 시간대인가. 캘린더를 받지 못했을 때의 폴백이고, 세 증권사 공용 게이트의 시장 규칙과 같다.
    국내는 KRX 정규장, 미국은 정규장과 종가 동시호가만 본다(확장세션은 모르므로 좁게 막힌다)."""
    now = _now(now_ms)
    if toss_market_country(symbol) == 'US':
        return us_order_block_reason(now) is None
    return krx_order_block_reason(now) is None


def _to_ymd(date: Any) -> str:
    return str(date).replace('-', '')


def toss_us_calendar_days(calendar: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """미국 캘린더를 날짜별 개장 여부로 바꾼다. 네 세션 가운데 하나라도 있는 날이 열린 날이다.
    세션이 `None` 이거나 키가 아예 없으면 그 세션은 없다. 날짜가 없는 항목은 건너뛴다."""
    if not calendar:
        return []
    opened: List[str] = []
    closed: List[str] = []
    for day in _days(calendar):
        if not isinstance(day, dict) or not isinstance(day.get('date'), str) or day.get('date') == '':
            continue
        has_session = any(day.get(key) is not None for key in ('dayMarket', 'preMarket', 'regularMarket', 'afterMarket'))
        (opened if has_session else closed).append(_to_ymd(day.get('date')))
    return expand_business_days(opened, closed)


def toss_kr_calendar_days(calendar: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """국내 캘린더를 날짜별 개장 여부로 바꾼다. KRX 정규장이 열리는 날만 열린 날이다(NXT 프리마켓만 쉬는 날도 열린 날이다)."""
    if not calendar:
        return []
    opened: List[str] = []
    closed: List[str] = []
    for day in _days(calendar):
        if not isinstance(day, dict):
            continue
        (opened if (day.get('integrated') or {}).get('regularMarket') else closed).append(_to_ymd(day.get('date')))
    return expand_business_days(opened, closed)
