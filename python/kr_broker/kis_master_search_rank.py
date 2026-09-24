"""종목 마스터 검색 결과의 관련도 정렬. TypeScript 판 `ts/src/kis/master-search-rank.ts` 와 같다.

부분 문자열로 거른 결과를 원래 순서(코드 오름차순)대로 자르면 정확히 그 코드인 종목이 한도 밖으로 밀린다(`V` 로 찾으면 Visa 가 없었다).
그래서 자르기 전에 코드가 정확히 같은 것, 코드가 검색어로 시작하는 것, 나머지 순으로 세운다.
"""

from typing import Callable, List, TypeVar

T = TypeVar('T')

_EXACT = 0
_PREFIX = 1
_OTHER = 2


def rank_master_matches(items: List[T], query: str, code_of: Callable[[T], str]) -> List[T]:
    """코드 관련도로 다시 세운다. 자르지 않으므로 호출하는 쪽이 자르기 전에 부른다. 같은 등급 안에서는 원래 순서를 지킨다."""
    q = query.strip().lower()
    if not q:
        return items

    def tier_of(item: T) -> int:
        code = code_of(item).lower()
        if code == q:
            return _EXACT
        if code.startswith(q):
            return _PREFIX
        return _OTHER

    return sorted(items, key=tier_of)
