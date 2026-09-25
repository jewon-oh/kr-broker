"""국내(KRX) 종목 마스터 검색. TypeScript 판 `ts/src/kis/kis-stock-master.ts` 와 같다.

데이터는 인스턴스의 `options['masterData']` 로 받아 함수의 첫 인자로 넘긴다(`kis_master_data` 참고).
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

from kr_broker.kis_master_data import master_rows
from kr_broker.kis_master_search_rank import rank_master_matches

logger = logging.getLogger('kr_broker')

# 신형 영숫자 단축코드 보충. 2026-05-27 상장한 단일종목 인버스2X ETF 가 마스터 스냅샷에 없어 코드로 합친다(마스터에 있으면 마스터가 우선이다).
CURATED_KRX_SUPPLEMENT = (
    {'code': '0193L0', 'name': 'PLUS 삼성전자선물단일종목인버스2X', 'market': 'KOSPI', 'securityType': 'ETF'},
    {'code': '0197X0', 'name': 'SOL SK하이닉스선물단일종목인버스2X', 'market': 'KOSPI', 'securityType': 'ETF'},
)

# 마지막으로 만든 (마스터 데이터 객체, 목록). 같은 객체면 다시 만들지 않는다. 한 쌍으로 두어 스레드가 겹쳐도 짝이 어긋나지 않는다.
_cache: Tuple[Any, List[Dict[str, Any]]] = (None, [])


def _krx_stock_master(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    global _cache
    cached_data, cached_list = _cache
    if cached_data is data:
        return cached_list
    listed = master_rows(data, 'kospi') + master_rows(data, 'kosdaq')
    listed_codes = {row.get('code') for row in listed if isinstance(row, dict)}
    rows = listed + [dict(row) for row in CURATED_KRX_SUPPLEMENT if row['code'] not in listed_codes]
    _cache = (data, rows)
    return rows


def search_krx_stocks(data: Dict[str, Any], query: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    """코드와 한글명(영문명이 있으면 영문명도)으로 찾는다. 대소문자는 가리지 않는다(신형 영숫자 코드 `0193L0`). 검색어가 없으면 마스터 앞쪽을 돌려준다."""
    master = _krx_stock_master(data)
    if not query or len(query.strip()) == 0:
        return master[:limit]
    q = query.strip().lower()
    results = [
        stock for stock in master
        if q in stock['code'].lower() or q in stock['name'].lower() or (stock.get('nameEn') is not None and q in stock['nameEn'].lower())
    ]
    logger.debug('[KIS StockMaster] 종목 검색 query=%s resultCount=%d', query, len(results))
    return rank_master_matches(results, q, lambda s: s['code'])[:limit]


def get_stock_master_count(data: Dict[str, Any]) -> int:
    """종목 마스터 전체 개수."""
    return len(_krx_stock_master(data))


def get_krx_stock_by_code(data: Dict[str, Any], code: str) -> Optional[Dict[str, Any]]:
    """6자리 코드로 국내 종목을 찾는다. 없으면 `None`."""
    return next((stock for stock in _krx_stock_master(data) if stock.get('code') == code), None)
