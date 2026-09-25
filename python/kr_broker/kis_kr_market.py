"""국내 종목의 코스피·코스닥 구분. TypeScript 판 `ts/src/kis/kr-market.ts` 와 같다.

야후 티커의 접미사(`.KS`·`.KQ`)를 맞게 붙이려면 시장 구분이 필요하다. 종목 디렉터리(`options['stockDirectory']`)가 있으면 그것을,
없으면 마스터 데이터(`options['masterData']`)를 본다. 모르면 `None` 이고 호출하는 쪽은 `.KS` 를 쓴다.
"""

import logging
from typing import Any, Awaitable, Dict, Optional, Protocol, Union, runtime_checkable

from kr_broker.broker_krx_code import is_krx_domestic_code
from kr_broker.kis_stock_master import get_krx_stock_by_code

logger = logging.getLogger('kr_broker')


@runtime_checkable
class BrokerStockDirectory(Protocol):
    def find_kr_market(self, code: str) -> Union[Optional[str], Awaitable[Optional[str]]]:
        """6자리 종목코드의 시장(`'KOSPI'`·`'KOSDAQ'`). 모르면 `None` 이고, 조회가 실패하면 던진다. 비동기 판에는 코루틴 함수도 넘길 수 있다."""


def resolve_kr_market(symbol: str, stock_directory: Any, master_data: Dict[str, Any]) -> Optional[str]:
    """국내 종목의 시장 구분. 국내 종목코드가 아니거나 조회에 실패하면 `None` 이다."""
    code = symbol.split('/')[0]
    if not is_krx_domestic_code(code):
        return None
    try:
        if stock_directory:
            return stock_directory.find_kr_market(code)
        stock = get_krx_stock_by_code(master_data, code)
        return None if stock is None else stock.get('market')
    except Exception as err:
        # 못 읽은 것도 None 이라 호출하는 쪽은 코스피(.KS)로 읽는다. 코스닥 종목이면 틀린 티커로 조회되므로 사유를 남긴다.
        logger.warning('[KrMarket] 종목 디렉터리 조회 실패 — 기본값(.KS/KOSPI) 사용. KOSDAQ 종목이면 잘못된 티커로 조회된다 (code=%s, err=%s)',
                       code, err)
    return None
