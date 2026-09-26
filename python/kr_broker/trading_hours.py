"""거래소 ID 축의 거래시간 판정. TypeScript 판 `ts/src/trading-hours.ts` 와 같다.

KRX 시간표는 `krx_trading_hours` 한 곳에만 있고, 이 모듈은 거래소 ID 를 시장으로 잇기만 한다. 주식 증권사(kis·toss·kbsec)는 모두 KRX 정규장을 쓰고,
이 패키지가 모르는 거래소는 시간 제한이 없다고 본다. 해외 종목은 상장 거래소(`market_session_block_reason`)로 세션을 고른다.
"""

from typing import Any, Dict, Optional

from kr_broker.base import functions as fn
from kr_broker.broker_krx_code import is_krx_domestic_code
from kr_broker.broker_market_group import is_stock_broker_exchange, market_group_of, stock_ticker
from kr_broker.kis_master_data import EMPTY_KIS_MASTER_DATA
from kr_broker.kis_overseas_master import get_overseas_market_for_code
from kr_broker.krx_trading_hours import check_krx_trading_hours_at, get_time_until_krx_open, krx_auction_buy_block_reason
from kr_broker.us_market_hours import us_order_block_reason


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


def market_session_block_reason(exchange_id: str, symbol: str, now_ms: Optional[int] = None,
                                master_data: Optional[Dict[str, Any]] = None, side: Optional[str] = None,
                                block_auction_buys: bool = False) -> Optional[str]:
    """지금 이 심볼이 주문을 받지 않는 사유. 받으면 `None` 이다.

    판정 축은 통화나 심볼 모양이 아니라 상장 거래소다. "국내가 아니면 미국"으로 보면 도쿄 종목에 미국 시간이 걸려 장중에 막고 마감 뒤에 연다.
    그래서 해외 종목은 마스터 데이터(`options['masterData']`)로 거래소를 찾고, 그 거래소의 시장 그룹을 모르면 막는다. 이 패키지가 모르는
    거래소 ID 면 제한하지 않는다. 시간표는 세 증권사 공용 게이트(`krx_order_block_reason`·`us_order_block_reason`)와 같고,
    동시호가 신규 매수 차단은 `block_auction_buys` 를 켰을 때만 건다. `COMMON_STOCK_CODES` 의 통합 코드는 티커로 돌려 찾는다.
    """
    if not is_stock_broker_exchange(exchange_id):
        return None
    now = fn.milliseconds() if now_ms is None else now_ms
    base = stock_ticker(symbol.split('/')[0].strip()).upper()

    def krx() -> Optional[str]:
        reason = trading_hours_block_reason(exchange_id, now)
        if reason is not None:
            return reason
        return krx_auction_buy_block_reason(now, side) if block_auction_buys else None

    if is_krx_domestic_code(base):
        return krx()
    venue = get_overseas_market_for_code(EMPTY_KIS_MASTER_DATA if master_data is None else master_data, base)
    group = market_group_of(venue)
    if group == 'KR':
        return krx()
    if group == 'US':
        # 미국은 정규장과 종가 동시호가만 받는다. 프리·애프터는 증권사 계약이 달라 여기서 막는다.
        return us_order_block_reason(now, side, block_auction_buys)
    # 상장 거래소를 모르면 어느 세션을 적용할지도 모르므로 막는다.
    if venue:
        return f'세션 표에 없는 거래소 — venue={venue} ({base})'
    return f'상장 거래소 미상 — 해외 마스터에 없는 티커 ({base})'
