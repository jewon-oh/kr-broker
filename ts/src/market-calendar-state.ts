/**
 * @fileoverview 휴장일 캘린더의 모듈 상태와 그 상태를 바꾸는 함수. `exports` 에 없는 내부 모듈이다.
 *
 * 읽기 함수와 갱신 함수는 `market-calendar.ts` 에 있다. 캘린더를 채우는 `applyMarketCalendar` 는 증권사 클래스가, 비우는
 * `resetMarketCalendar` 는 테스트가 쓴다. 테스트는 두 함수를 테스트 전용 경로(`kr-broker/testing`)로 가져온다.
 */

import type { StockMarketGroup } from './broker-market-group';
import type { CalendarDay } from './market-calendar';

const DATE_RE = /^\d{8}$/;

export const knownDays: Record<StockMarketGroup, Map<string, boolean>> = { KR: new Map(), US: new Map() };
export const warnedUnknownDays = new Set<string>();

export interface RefreshState {
    okAtMs: number | null;
    failedAtMs: number | null;
    inflight: Promise<boolean> | null;
}

export const refreshState: Record<StockMarketGroup, RefreshState> = {
    KR: { okAtMs: null, failedAtMs: null, inflight: null },
    US: { okAtMs: null, failedAtMs: null, inflight: null },
};

/** `YYYYMMDD` 가 실제 달력에 있는 날짜인지. `20260231` 같은 값은 거른다. */
export function parseYmd(ymd: string): Date | null {
    if (!DATE_RE.test(ymd)) return null;
    const year = Number(ymd.slice(0, 4));
    const month = Number(ymd.slice(4, 6));
    const day = Number(ymd.slice(6, 8));
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

export function isWeekend(d: Date): boolean {
    const wd = d.getUTCDay();
    return wd === 0 || wd === 6;
}

/**
 * 증권사 API 가 알려 준 날짜별 개장 여부를 넣는다. 같은 날짜가 이미 있으면 새 값으로 덮어쓴다.
 * 형식이 틀린 날짜와 주말은 버린다(주말은 캘린더 없이도 닫혀 있다).
 */
export function applyMarketCalendar(market: StockMarketGroup, days: readonly CalendarDay[]): void {
    const target = knownDays[market];
    for (const day of days) {
        const d = parseYmd(day.date);
        if (!d || isWeekend(d)) continue;
        target.set(day.date, day.open);
    }
}

/** 캘린더와 갱신 상태를 비운다. 테스트 전용이다. */
export function resetMarketCalendar(): void {
    for (const market of ['KR', 'US'] as const) {
        knownDays[market].clear();
        refreshState[market] = { okAtMs: null, failedAtMs: null, inflight: null };
    }
    warnedUnknownDays.clear();
}
