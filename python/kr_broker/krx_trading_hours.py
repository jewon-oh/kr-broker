"""KRX 정규장(09:00~15:30 KST)과 NXT 확장세션 판정. TypeScript 판 `ts/src/krx-trading-hours.ts` 와 같다. 수능일처럼 개장·마감이 다른 날은 `KRX_SPECIAL_SESSION_DAYS` 표가 안다.

한국 시각은 고정 +09:00 으로 계산하므로 프로세스의 시간대와 상관없다. 휴장일은 증권사 캘린더(`market_calendar`)가 알려 준 날짜만 안다.
시각 인자는 UTC 밀리초이고, 생략하면 지금이다.
"""

import calendar
import datetime
import re
from typing import Any, Dict, Optional, Sequence

from kr_broker.base import functions as fn
from kr_broker.broker_time import KST_OFFSET_MS
from kr_broker.market_calendar import is_market_closed_day

MARKET_OPEN_HOUR = 9
MARKET_OPEN_MINUTE = 0
MARKET_CLOSE_HOUR = 15
MARKET_CLOSE_MINUTE = 30
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

# 시초가 동시호가는 개장 30분 전, 종가 동시호가는 마감 10분 전에 시작한다(평소 08:30·15:20).
PRE_AUCTION_LEAD_MIN = 30
CLOSING_AUCTION_LEAD_MIN = 10

# 정규장 개장·마감 시각이 평소(09:00~15:30)와 다른 날. 키는 KST 달력 날짜 `YYYYMMDD`, 값은 자정부터의 분이다. 표에 없는 날은 평소 시각이다.
# 연도마다 거래소 공지를 보고 손으로 더한다(규칙으로 계산하지 않는다).
# - 20261119: 2027학년도 대학수학능력시험일(2026-11-19 목). 정규장 10:00~16:30. 출처: 한국거래소의 수능일 거래시간 변경 공지(2026-11-05). 공지 원문은
#   열람하지 못했고 같은 날 보도(뉴스핌, 뉴스웨이)가 전한 내용을 따랐다.
#   동시호가는 개장·마감과 같은 폭(한 시간)으로 늦춘다(시초가 09:30~10:00, 종가 16:20~16:30). 공지가 동시호가 시각을 따로 적었는지는 확인하지 못했다.
#   NXT 의 수능일 시각은 다루지 않는다. `get_nxt_session` 은 평소 시각 그대로다.
KRX_SPECIAL_SESSION_DAYS: Dict[str, Dict[str, Any]] = {
    '20261119': {'openMin': 10 * 60, 'closeMin': 16 * 60 + 30, 'note': '대학수학능력시험일(개장·마감 1시간 연기)'},
}

_EPOCH = datetime.datetime(1970, 1, 1)


def krx_regular_session_of(ymd: str) -> Dict[str, Any]:
    """KST 날짜 `YYYYMMDD` 의 정규장 시각 `{'preAuctionMin', 'openMin', 'closingAuctionMin', 'closeMin', 'special'?}`(자정부터의 분).
    표(`KRX_SPECIAL_SESSION_DAYS`)에 있으면 그 날의 시각이고 없으면 평소 시각이다. 휴장 여부는 보지 않는다. `special` 은 평소와 다른 날의 사유다."""
    special = KRX_SPECIAL_SESSION_DAYS.get(ymd)
    open_min = special['openMin'] if special is not None else MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE
    close_min = special['closeMin'] if special is not None else MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE
    session: Dict[str, Any] = {
        'preAuctionMin': open_min - PRE_AUCTION_LEAD_MIN,
        'openMin': open_min,
        'closingAuctionMin': close_min - CLOSING_AUCTION_LEAD_MIN,
        'closeMin': close_min,
    }
    if special is not None:
        session['special'] = special['note']
    return session


def _kst_ymd(wall: datetime.datetime) -> str:
    return f'{wall.year:04d}{wall.month:02d}{wall.day:02d}'


def _clock(minutes: int) -> str:
    return f'{minutes // 60}:{minutes % 60:02d}'


def _hhmm(minutes: int) -> str:
    return f'{minutes // 60:02d}:{minutes % 60:02d}'


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
    """지금이 KRX 정규장인가. `{'tradable': bool, 'reason': str}`(열려 있으면 `reason` 이 없다).

    라이브러리 안에서 쓰지 않는다. `check_krx_trading_hours_at` 을 쓴다. 다음 판에서 지운다.
    """
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
    session = krx_regular_session_of(_kst_ymd(wall))
    open_min, close_min = session['openMin'], session['closeMin']
    clock = f'{wall.hour}:{wall.minute:02d} KST'
    if minutes < open_min:
        return {'tradable': False, 'reason': f'장 개장 전 (현재: {clock}, 개장: {_clock(open_min)})'}
    if minutes >= close_min:
        return {'tradable': False, 'reason': f'장 마감 (현재: {clock}, 마감: {_clock(close_min)})'}
    return {'tradable': True}


def get_krx_market_phase(now_ms: Optional[int] = None) -> str:
    """KRX 시장 단계: `'pre-auction'`(08:30~09:00), `'open'`(09:00~15:20), `'closing-auction'`(15:20~15:30), `'closed'`."""
    wall = _kst_wall(_now(now_ms))
    if _is_weekend(wall) or _is_krx_holiday(wall):
        return 'closed'
    minutes = wall.hour * 60 + wall.minute
    session = krx_regular_session_of(_kst_ymd(wall))
    if minutes < session['preAuctionMin'] or minutes >= session['closeMin']:
        return 'closed'
    if minutes < session['openMin']:
        return 'pre-auction'
    if minutes < session['closingAuctionMin']:
        return 'open'
    return 'closing-auction'


def get_time_until_krx_open(now_ms: Optional[int] = None) -> int:
    """다음 KRX 개장(평소 09:00 KST, 수능일은 10:00. 주말·휴장일은 건너뛴다)까지의 밀리초. 지금 거래할 수 있으면 0."""
    now = _now(now_ms)
    if check_krx_trading_hours_at(now)['tradable']:
        return 0
    wall = _kst_wall(now)

    def open_ms_of(day_start_ms: int) -> int:
        return day_start_ms + krx_regular_session_of(_kst_ymd(_kst_wall(day_start_ms)))['openMin'] * 60_000

    # 한국 자정의 UTC 밀리초. 개장 시각은 날짜별 표를 따른다.
    day_start = calendar.timegm((wall.year, wall.month, wall.day, 0, 0, 0, 0, 0, 0)) * 1000 - KST_OFFSET_MS
    candidate = open_ms_of(day_start)
    if candidate <= now:
        day_start += DAY_MS
        candidate = open_ms_of(day_start)
    for _ in range(14):
        candidate_wall = _kst_wall(day_start)
        if _is_weekend(candidate_wall) or _is_krx_holiday(candidate_wall):
            day_start += DAY_MS
            candidate = open_ms_of(day_start)
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


def krx_auction_buy_block_reason(now_ms: int, side: Optional[str]) -> Optional[str]:
    """종가 동시호가(15:20~15:30)의 신규 매수를 막는 사유. 매수가 아니거나 동시호가가 아니면 `None`.
    KRX 는 이 시간에도 호가를 받는다. 진입을 피하려는 정책이라 증권사 클래스는 `options['blockAuctionBuys']` 가 켜졌을 때만 건다."""
    if side != 'buy' or get_krx_market_phase(now_ms) != 'closing-auction':
        return None
    session = krx_regular_session_of(_kst_ymd(_kst_wall(now_ms)))
    return f"종가 동시호가 ({_hhmm(session['closingAuctionMin'])}-{_hhmm(session['closeMin'])}) — 신규 매수 진입 금지 (options.blockAuctionBuys)"


def krx_order_block_reason(now_ms: int, side: Optional[str] = None, block_auction_buys: bool = False,
                           sessions: Sequence[str] = ('regular',)) -> Optional[str]:
    """KRX 주문을 지금 막는 사유. 보내도 되면 `None`. 세 증권사가 같은 시각에 같은 판정을 내도록 한 곳에 둔다.
    `sessions` 는 주문을 받는 세션(`'regular'` KRX 정규장, `'nxt'` NXT 프리·메인·애프터마켓)이고 하나라도 열려 있으면 보낸다.
    시장 규칙은 늘 판정하고, 동시호가 신규 매수 차단은 `block_auction_buys` 를 켰을 때만 건다."""
    regular = check_krx_trading_hours_at(now_ms) if 'regular' in sessions else None
    nxt = get_nxt_session(now_ms) if 'nxt' in sessions else None
    nxt_open = nxt in ('pre-market', 'main', 'after-market')
    if not (regular is not None and regular['tradable']) and not nxt_open:
        if regular is None:
            return f"NXT 거래시간 외 (session={nxt if nxt is not None else 'closed'})"
        if nxt is None:
            return f"거래시간 외: {regular.get('reason')}"
        return f"거래시간 외: {regular.get('reason')} (NXT session={nxt})"
    return krx_auction_buy_block_reason(now_ms, side) if block_auction_buys else None


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
