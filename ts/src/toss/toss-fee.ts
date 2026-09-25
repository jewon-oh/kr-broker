/**
 * @fileoverview 토스증권 수수료율 해석.
 *
 * `GET /commissions` 의 `commissionRate` 는 공식 문서에 소수 비율(`0.00015` 는 0.015%)로 적혀 있지만, 백분율(`0.015`)로 온 적이 있다.
 * 단위를 응답 형식 하나로 단정하면 100배 틀린 요율이 조용히 들어오므로, 소매 위탁수수료로 있을 수 있는 범위에 들어오는 쪽을 고른다.
 */

import type { StockMarketGroup } from '../broker-market-group';
import { logger } from '../logger';
import type { TossCommission } from './toss-types';

/** 있을 수 있는 위탁수수료율(소수 비율)의 범위: 0.001% 이상 1% 이하. 이 밖이면 단위를 잘못 읽었다는 신호다. */
const PLAUSIBLE_FEE_RATE = { MIN: 0.00001, MAX: 0.01 } as const;

const PERCENT_TO_RATIO = 100;

const inBand = (rate: number): boolean => rate >= PLAUSIBLE_FEE_RATE.MIN && rate <= PLAUSIBLE_FEE_RATE.MAX;

/**
 * 수수료율 응답을 소수 비율로 바꾼다.
 *
 * 값을 그대로 소수 비율로 읽어 범위에 들면 그것을 쓰고(공식 문서의 형식), 아니면 백분율로 보고 100으로 나눈 값이 범위에 드는지 본다.
 * 둘 다 범위 밖이면 `null` 이다. 0 은 무료 이벤트라 유효한 값이다. 값이 없으면(`null`·`undefined`·빈 문자열) 무료가 아니라 모르는 값이라 `null` 이다.
 *
 * 두 해석이 모두 범위에 드는 값(0.1%~1% 사이의 소수 비율, 곧 `0.001`~`0.01`)은 문서 형식대로 소수 비율로 읽는다.
 */
export function normalizeCommissionRate(raw: string | number | null | undefined): number | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string' && raw.trim() === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    if (value === 0) return 0;
    if (inBand(value)) return value;
    const asPercent = value / PERCENT_TO_RATIO;
    if (inBand(asPercent)) return asPercent;
    return null;
}

/**
 * 오늘 적용되는 시장별 수수료율을 고른다. `startDate` 이상 `endDate` 이하인 행이 유효하고(비어 있으면 열려 있다),
 * 여럿이면 시작일이 가장 늦은 행(가장 최근에 시작한 이벤트)을 쓴다. 유효한 행이 없거나 값을 해석하지 못하면 `null` 이다.
 *
 * @param today `YYYY-MM-DD`(한국 시각)
 */
export function pickCommissionRate(rows: readonly TossCommission[], country: StockMarketGroup, today: string): number | null {
    const active = rows
        .filter((row) => row.marketCountry === country)
        .filter((row) => (row.startDate == null || row.startDate <= today) && (row.endDate == null || today <= row.endDate))
        .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
    const picked = active[0];
    if (picked === undefined) return null;
    const rate = normalizeCommissionRate(picked.commissionRate);
    if (rate === null) {
        logger.warn({ country, raw: picked.commissionRate }, '[toss] 수수료율이 비었거나 있을 수 있는 범위 밖이라 기본 요율을 유지한다');
    }
    return rate;
}
