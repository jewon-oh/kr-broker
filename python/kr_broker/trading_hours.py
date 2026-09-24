"""거래소 ID 축의 거래시간 판정. TypeScript 판 `ts/src/trading-hours.ts` 와 같다.

KRX 시간표는 `krx_trading_hours` 한 곳에만 있고, 이 모듈은 거래소 ID 를 시장으로 잇기만 한다. 주식 증권사(kis·toss·kbsec)는 모두 KRX 정규장을 쓰고,
이 패키지가 모르는 거래소는 시간 제한이 없다고 본다.
"""

from typing import Optional

from kr_broker.base import functions as fn
from kr_broker.broker_market_group import is_stock_broker_exchange
from kr_broker.krx_trading_hours import check_krx_trading_hours_at, get_time_until_krx_open


def is_trading_hours(exchange_id: str, now_ms: Optional[int] = None) -> bool:
    """거래소가 지금 운영 중인가. 증권사는 KRX 정규장(휴장일 포함)으로 보고, 모르는 거래소는 항상 `True` 다."""
    if not is_stock_broker_exchange(exchange_id):
        return True
    return check_krx_trading_hours_at(fn.milliseconds() if now_ms is None else now_ms)['tradable']


def trading_hours_block_reason(exchange_id: str, now_ms: Optional[int] = None) -> Optional[str]:
    """거래할 수 없는 사유. 열려 있으면 `None`."""
    if not is_stock_broker_exchange(exchange_id):
        return None
    result = check_krx_trading_hours_at(fn.milliseconds() if now_ms is None else now_ms)
    if result['tradable']:
        return None
    reason = result.get('reason')
    return f"KRX {reason if reason is not None else '거래시간 외'}"


def get_time_until_market_open(exchange_id: str, now_ms: Optional[int] = None) -> int:
    """다음 거래 시작까지 남은 밀리초. 거래 중이거나 모르는 거래소면 0."""
    if not is_stock_broker_exchange(exchange_id):
        return 0
    return get_time_until_krx_open(now_ms)
