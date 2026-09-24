"""KRX 정규장(09:00~15:30 KST)과 NXT 확장세션 판정. TypeScript 판 `ts/src/krx-trading-hours.ts` 와 같다.

한국 시각은 고정 +09:00 으로 계산하므로 프로세스의 시간대와 상관없다. 휴장일은 증권사 캘린더(`market_calendar`)가 알려 준 날짜만 안다.
시각 인자는 UTC 밀리초이고, 생략하면 지금이다.
"""

import calendar
import datetime
import re
from typing import Any, Dict, Optional

from kr_broker.base import functions as fn
from kr_broker.market_calendar import is_market_closed_day

MARKET_OPEN_HOUR = 9
MARKET_OPEN_MINUTE = 0
MARKET_CLOSE_HOUR = 15
MARKET_CLOSE_MINUTE = 30
KST_OFFSET_MS = 9 * 60 * 60 * 1000
DAY_MS = 24 * 60 * 60 * 1000

# 시초가 결정 동시호가 시작(08:30 KST)과 종가 결정 동시호가 시작(15:20 KST).
PRE_AUCTION_OPEN_HOUR = 8
PRE_AUCTION_OPEN_MINUTE = 30
CLOSING_AUCTION_OPEN_HOUR = 15
CLOSING_AUCTION_OPEN_MINUTE = 20

# NXT 프리마켓(08:00~08:50)과 애프터마켓 종료(20:00).
NXT_PRE_OPEN_HOUR = 8
NXT_PRE_OPEN_MINUTE = 0
NXT_PRE_CLOSE_HOUR = 8
NXT_PRE_CLOSE_MINUTE = 50
NXT_AFTER_CLOSE_HOUR = 20
NXT_AFTER_CLOSE_MINUTE = 0

_EPOCH = datetime.datetime(1970, 1, 1)


def _now(now_ms: Optional[int]) -> int:
    return fn.milliseconds() if now_ms is None else now_ms


def _kst_wall(now_ms: int) -> datetime.datetime:
    """`now_ms` 의 한국 벽시계 시각(시간대 없는 datetime)."""
    return _EPOCH + datetime.timedelta(milliseconds=now_ms + KST_OFFSET_MS)


def _is_weekend(wall: datetime.datetime) -> bool:
    return wall.weekday() >= 5


def _krx_holiday_mmdd(kst_wall: datetime.datetime) -> Optional[str]:
    """휴장일이면 `MMDD`, 아니면 `None`."""
    if _is_weekend(kst_wall):
        return None
    mmdd = f'{kst_wall.month:02d}{kst_wall.day:02d}'
    return mmdd if is_market_closed_day('KR', f'{kst_wall.year}{mmdd}') else None


def _is_krx_holiday(kst_wall: datetime.datetime) -> bool:
    return _krx_holiday_mmdd(kst_wall) is not None


def check_krx_trading_hours() -> Dict[str, Any]:
    """지금이 KRX 정규장인가. `{'tradable': bool, 'reason': str}`(열려 있으면 `reason` 이 없다)."""
    return check_krx_trading_hours_at(fn.milliseconds())


def check_krx_trading_hours_at(now_ms: int) -> Dict[str, Any]:
    """KRX 거래 가능 시간 판정의 유일한 구현. 주말, 휴장일, 정규장(09:00~15:30 KST) 순으로 본다. 사유는 주문 실패 메시지에 그대로 실린다."""
    wall = _kst_wall(now_ms)
    if _is_weekend(wall):
        return {'tradable': False, 'reason': '주말 — KRX 휴장'}
    holiday = _krx_holiday_mmdd(wall)
    if holiday:
        return {'tradable': False, 'reason': f'공휴일 — KRX 휴장 ({holiday})'}
    minutes = wall.hour * 60 + wall.minute
    open_min = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE
    close_min = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE
    clock = f'{wall.hour}:{wall.minute:02d} KST'
    if minutes < open_min:
        return {'tradable': False, 'reason': f'장 개장 전 (현재: {clock}, 개장: {MARKET_OPEN_HOUR}:{MARKET_OPEN_MINUTE:02d})'}
    if minutes >= close_min:
        return {'tradable': False, 'reason': f'장 마감 (현재: {clock}, 마감: {MARKET_CLOSE_HOUR}:{MARKET_CLOSE_MINUTE:02d})'}
    return {'tradable': True}


def get_krx_market_phase(now_ms: Optional[int] = None) -> str:
    """KRX 시장 단계: `'pre-auction'`(08:30~09:00), `'open'`(09:00~15:20), `'closing-auction'`(15:20~15:30), `'closed'`."""
    wall = _kst_wall(_now(now_ms))
    if _is_weekend(wall) or _is_krx_holiday(wall):
        return 'closed'
    minutes = wall.hour * 60 + wall.minute
    pre_auction_start = PRE_AUCTION_OPEN_HOUR * 60 + PRE_AUCTION_OPEN_MINUTE
    open_min = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE
    closing_auction_start = CLOSING_AUCTION_OPEN_HOUR * 60 + CLOSING_AUCTION_OPEN_MINUTE
    close_min = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE
    if minutes < pre_auction_start or minutes >= close_min:
        return 'closed'
    if minutes < open_min:
        return 'pre-auction'
    if minutes < closing_auction_start:
        return 'open'
    return 'closing-auction'


def get_time_until_krx_open(now_ms: Optional[int] = None) -> int:
    """다음 KRX 개장(09:00 KST, 주말·휴장일은 건너뛴다)까지의 밀리초. 지금 거래할 수 있으면 0."""
    now = _now(now_ms)
    if check_krx_trading_hours_at(now)['tradable']:
        return 0
    wall = _kst_wall(now)
    candidate = calendar.timegm((wall.year, wall.month, wall.day, MARKET_OPEN_HOUR, MARKET_OPEN_MINUTE, 0, 0, 0, 0)) * 1000 - KST_OFFSET_MS
    if candidate <= now:
        candidate += DAY_MS
    for _ in range(14):
        candidate_wall = _kst_wall(candidate)
        if _is_weekend(candidate_wall) or _is_krx_holiday(candidate_wall):
            candidate += DAY_MS
            continue
        break
    return max(0, candidate - now)


def get_nxt_session(now_ms: Optional[int] = None) -> str:
    """NXT 세션: `'pre-market'`(08:00~08:50), `'pre-pause'`(08:50~09:00), `'main'`(09:00~15:20), `'krx-closing-auction'`(15:20~15:30),
    `'after-market'`(15:30~20:00), `'closed'`(그 밖과 주말·휴장일)."""
    wall = _kst_wall(_now(now_ms))
    if _is_weekend(wall) or _is_krx_holiday(wall):
        return 'closed'
    minutes = wall.hour * 60 + wall.minute
    pre_open = NXT_PRE_OPEN_HOUR * 60 + NXT_PRE_OPEN_MINUTE
    pre_pause = NXT_PRE_CLOSE_HOUR * 60 + NXT_PRE_CLOSE_MINUTE
    main_open = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE
    main_close = CLOSING_AUCTION_OPEN_HOUR * 60 + CLOSING_AUCTION_OPEN_MINUTE
    after_open = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE
    after_close = NXT_AFTER_CLOSE_HOUR * 60 + NXT_AFTER_CLOSE_MINUTE
    if minutes < pre_open:
        return 'closed'
    if minutes < pre_pause:
        return 'pre-market'
    if minutes < main_open:
        return 'pre-pause'
    if minutes < main_close:
        return 'main'
    if minutes < after_open:
        return 'krx-closing-auction'
    if minutes < after_close:
        return 'after-market'
    return 'closed'


def is_nxt_extended_tradable(now_ms: Optional[int] = None) -> bool:
    """NXT 확장 거래 시간(프리마켓 08:00~08:50, 애프터마켓 15:30~20:00)인가."""
    return get_nxt_session(now_ms) in ('pre-market', 'after-market')


def is_krx_business_day_kst(ymd: str) -> bool:
    """한국 날짜(`YYYYMMDD`)가 KRX 영업일(주말도 휴장일도 아닌 날)인가. 시각은 보지 않는다. 형식이 틀리면 `False`."""
    if not isinstance(ymd, str) or re.fullmatch(r'[0-9]{8}', ymd) is None:
        return False
    try:
        day = datetime.datetime(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:8]))
    except ValueError:
        return False
    if _is_weekend(day):
        return False
    return not _is_krx_holiday(day)
