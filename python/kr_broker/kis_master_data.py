"""한국투자증권 종목 마스터 데이터의 모양. TypeScript 판 `ts/src/kis/kis-master-data.ts` 와 같다.

종목 검색과 해외 주문의 거래소 판별에는 KIS 공식 마스터 파일(코스피·코스닥, 나스닥·뉴욕·아멕스)이 필요하다. 그 파일은 재배포 조건이
명시돼 있지 않아 라이브러리에 싣지 않는다. 사용하는 쪽이 내려받아 아래 모양의 사전으로 `options['masterData']` 에 넘긴다.

- `kospi`, `kosdaq`: 국내 종목 행 목록. 행은 `{'code', 'name', 'market'('KOSPI'·'KOSDAQ'), 'nameEn'?, 'isin'?, 'securityType'?}` 다.
- `nasdaq`, `nyse`, `amex`: 해외 종목 행 목록. 행은 `{'code', 'name', 'market'(시세 거래소 코드 'NAS' 등), 'currency', 'nameKr'?, 'isEtf'?}` 다.
"""

from typing import Any, Dict, List

MASTER_KEYS = ('kospi', 'kosdaq', 'nasdaq', 'nyse', 'amex')

# 데이터가 없는 상태. `options['masterData']` 를 넘기지 않았을 때의 기본값이다. 검색은 빈 결과, 조회는 미등록이다.
EMPTY_KIS_MASTER_DATA: Dict[str, List[Dict[str, Any]]] = {key: [] for key in MASTER_KEYS}


def master_data_of(options: Dict[str, Any]) -> Dict[str, Any]:
    """인스턴스 옵션에서 마스터 데이터를 꺼낸다. 넘기지 않았으면 빈 데이터다."""
    data = options.get('masterData') if isinstance(options, dict) else None
    return EMPTY_KIS_MASTER_DATA if data is None else data


def master_rows(data: Dict[str, Any], key: str) -> List[Dict[str, Any]]:
    """마스터 데이터의 한 목록. 없으면 빈 목록이다."""
    rows = data.get(key) if isinstance(data, dict) else None
    return list(rows) if isinstance(rows, (list, tuple)) else []
