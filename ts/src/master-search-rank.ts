/**
 * @fileoverview 종목 마스터 검색 결과의 관련도 정렬.
 *
 * 정렬 없이 `slice(limit)` 하면 **정확히 그 코드인 종목이 한도 밖으로 밀린다**(마스터 순서에 걸린 무관한 종목이 자리를 먼저 차지한다).
 * 코드 정확 일치를 최상단, 접두 일치를 그다음으로 올린다.
 */

/** 관련도 티어 — 낮을수록 앞. 같은 티어면 원래 순서 유지(안정 정렬). */
const TIER = { EXACT: 0, PREFIX: 1, OTHER: 2 } as const;

/**
 * 코드 관련도로 재정렬한다(잘라내지 않음 — 호출하는 쪽이 `slice(limit)` 하기 **전에** 쓴다).
 *
 * @param items 필터를 통과한 검색 결과
 * @param query 검색어 (원문)
 * @param codeOf 항목에서 종목코드를 꺼내는 접근자
 */
export function rankMasterMatches<T>(items: T[], query: string, codeOf: (item: T) => string): T[] {
    const q = query.trim().toLowerCase();
    if (!q) return items;

    const tierOf = (item: T): number => {
        const code = codeOf(item).toLowerCase();
        if (code === q) return TIER.EXACT;
        if (code.startsWith(q)) return TIER.PREFIX;
        return TIER.OTHER;
    };

    return items
        .map((item, index) => ({ item, index, tier: tierOf(item) }))
        .sort((a, b) => a.tier - b.tier || a.index - b.index)
        .map(entry => entry.item);
}
