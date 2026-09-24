"""해외 종목 마스터(나스닥·뉴욕·아멕스) 검색. TypeScript 판 `ts/src/kis/kis-overseas-master.ts` 와 같다.

KIS 는 거래소 코드를 두 가지로 쓴다. 시세 조회는 세 글자(`NAS`, `NYS`, `AMS` …, 요청의 `EXCD`), 주문과 잔고는 네 글자
(`NASD`, `NYSE`, `AMEX` …, 요청의 `OVRS_EXCG_CD`)다. 마스터 행의 `market` 은 시세 코드이고, 주문 코드는 `to_order_market_code` 로 바꾼다.
티커는 KIS 표기(`BRK/B`)다.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

from kr_broker.kis_master_data import master_rows
from kr_broker.kis_master_search_rank import rank_master_matches

logger = logging.getLogger('kr_broker')

# 시세 거래소 코드 → 주문·잔고 거래소 코드.
ORDER_MARKET_CODES = {
    'NAS': 'NASD',
    'NYS': 'NYSE',
    'AMS': 'AMEX',
    'HKS': 'SEHK',
    'SHS': 'SHAA',
    'SZS': 'SZAA',
    'HSX': 'VNSE',
    'HNX': 'HASE',
    'TSE': 'TKSE',
}

# 마지막으로 만든 (마스터 데이터 객체, 목록). 같은 객체면 다시 만들지 않는다. 한 쌍으로 두어 스레드가 겹쳐도 짝이 어긋나지 않는다.
_cache: Tuple[Any, List[Dict[str, Any]]] = (None, [])


def to_order_market_code(quote_code: Optional[str]) -> Optional[str]:
    """시세 거래소 코드(`NAS`)를 주문 거래소 코드(`NASD`)로 바꾼다. 모르는 코드면 `None`."""
    return ORDER_MARKET_CODES.get(quote_code) if isinstance(quote_code, str) else None


def _overseas_stock_master(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    global _cache
    cached_data, cached_list = _cache
    if cached_data is data:
        return cached_list
    rows = master_rows(data, 'nasdaq') + master_rows(data, 'nyse') + master_rows(data, 'amex')
    _cache = (data, rows)
    return rows


def search_overseas_stocks(data: Dict[str, Any], query: Optional[str] = None, limit: int = 50,
                           market: Optional[str] = None) -> List[Dict[str, Any]]:
    """티커, 영문명, 한글명으로 찾는다. `market`(시세 거래소 코드)을 주면 그 거래소만 본다. 검색어가 없으면 앞쪽을 돌려준다."""
    master = _overseas_stock_master(data)
    filtered = [s for s in master if s.get('market') == market] if market else master
    if not query or len(query.strip()) == 0:
        return filtered[:limit]
    q = query.strip().lower()
    results = [
        stock for stock in filtered
        if q in stock['code'].lower() or q in stock['name'].lower() or (stock.get('nameKr') is not None and q in stock['nameKr'].lower())
    ]
    logger.debug('[KIS OverseasMaster] 종목 검색 query=%s market=%s resultCount=%d', query, market, len(results))
    return rank_master_matches(results, q, lambda s: s['code'])[:limit]


def get_overseas_stock_by_code(data: Dict[str, Any], code: str) -> Optional[Dict[str, Any]]:
    """티커로 해외 종목 행을 찾는다. 찾는 티커는 대문자로 바꿔 비교한다."""
    upper = code.upper()
    return next((stock for stock in _overseas_stock_master(data) if stock.get('code') == upper), None)


def get_overseas_market_for_code(data: Dict[str, Any], code: str) -> Optional[str]:
    """티커의 시세 거래소 코드. 마스터에 없으면 `None`."""
    stock = get_overseas_stock_by_code(data, code)
    return None if stock is None else stock.get('market')
