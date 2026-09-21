/**
 * @fileoverview 휴장일 캘린더 — 증권사 API 가 알려 준 날짜별 개장 여부를 메모리에 들고 있는다.
 *
 * ## 왜 표를 저장하지 않는가
 *
 * 한국 휴장일은 계산으로 구할 수 없다. 설날·추석·부처님오신날은 음력이고, 대체공휴일 규칙은 바뀌고, 정부는 임시공휴일과 선거일을
 * 언제든 지정한다. 연도별 표를 손으로 적어 두면 빠진 날이 생기고(실제로 2025년과 2026년에 평일 휴장일이 여러 날 빠져 있었다),
 * 해가 바뀌면 조용히 낡는다. 그래서 휴장일은 증권사 API 를 호출해 받는다.
 *
 * | 시장 | API |
 * |---|---|
 * | 국내(KR) | 한국투자증권 국내휴장일조회(`chk-holiday`), 토스증권 `market-calendar/KR`, KB증권 장운영상태(`SZQM0771`) |
 * | 미국(US) | 토스증권 `market-calendar/US` |
 *
 * KB증권은 장운영상태 조회(`SZQM0771`)가 전영업일·기준영업일·익영업일을 주므로, 그 사이의 평일을 닫힌 날로 넓혀 넣는다(`expandBusinessDays`).
 * 앞뒤 며칠뿐이라 먼 날짜는 모른다. 같은 프로세스에서 다른 증권사 어댑터가 받은 캘린더는 이 모듈을 거쳐 공유된다.
 *
 * ## 동작
 *
 * - 어댑터는 `refreshMarketCalendar()` 로 API 를 호출하고 결과를 `applyMarketCalendar()` 로 넣는다. 성공하면 `ttlMs` 동안 다시 부르지 않고,
 *   실패하면 10분 뒤에 다시 시도한다. 같은 시장에 대한 동시 호출은 하나로 합친다.
 * - 장 시간 판정 함수(`krx-trading-hours.ts`, `us-market-hours.ts`)는 동기 함수라 API 를 부르지 않고 이 모듈의 값을 읽는다.
 * - 캘린더에 없는 평일은 **열린 날로 본다.** 증권사가 휴장일 주문을 거절하므로 열린 것으로 잘못 보는 쪽이 주문을 막는 쪽보다 피해가
 *   작다. 대신 그 달마다 한 번 경고를 남겨 캘린더를 받지 못했다는 사실이 드러나게 한다.
 * - 값은 프로세스 메모리에만 있다. 재시작하면 다시 받는다.
 */

import { logger } from './logger';

export type CalendarMarket = 'KR' | 'US';

/** 시장 현지 달력 날짜(국내는 KST, 미국은 ET)의 개장 여부. `date` 는 `YYYYMMDD`. */
export interface CalendarDay {
    date: string;
    open: boolean;
}

export type CalendarDayStatus = 'open' | 'closed' | 'unknown';

/** 갱신에 실패한 뒤 다시 시도하기까지의 간격. */
export const CALENDAR_RETRY_MS = 10 * 60_000;

const DATE_RE = /^\d{8}$/;

const knownDays: Record<CalendarMarket, Map<string, boolean>> = { KR: new Map(), US: new Map() };
const warnedUnknownDays = new Set<string>();

interface RefreshState {
    okAtMs: number | null;
    failedAtMs: number | null;
    inflight: Promise<boolean> | null;
}

const refreshState: Record<CalendarMarket, RefreshState> = {
    KR: { okAtMs: null, failedAtMs: null, inflight: null },
    US: { okAtMs: null, failedAtMs: null, inflight: null },
};

/** `YYYYMMDD` 가 실제 달력에 있는 날짜인지. `20260231` 같은 값은 거른다. */
function parseYmd(ymd: string): Date | null {
    if (!DATE_RE.test(ymd)) return null;
    const year = Number(ymd.slice(0, 4));
    const month = Number(ymd.slice(4, 6));
    const day = Number(ymd.slice(6, 8));
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

function isWeekend(d: Date): boolean {
    const wd = d.getUTCDay();
    return wd === 0 || wd === 6;
}

/**
 * 증권사 API 가 알려 준 날짜별 개장 여부를 넣는다. 같은 날짜가 이미 있으면 새 값으로 덮어쓴다.
 * 형식이 틀린 날짜와 주말은 버린다(주말은 캘린더 없이도 닫혀 있다).
 */
export function applyMarketCalendar(market: CalendarMarket, days: readonly CalendarDay[]): void {
    const target = knownDays[market];
    for (const day of days) {
        const d = parseYmd(day.date);
        if (!d || isWeekend(d)) continue;
        target.set(day.date, day.open);
    }
}

/**
 * 열린 날짜만 아는 API(토스처럼 전일·당일·익일 영업일을 주는 응답)를 날짜별 개장 여부로 넓힌다.
 * 가장 이른 열린 날과 가장 늦은 열린 날 사이에서 열린 날로 적히지 않은 평일은 닫힌 날이다.
 * `closedDates` 는 API 가 직접 닫혔다고 알려 준 날짜다.
 */
export function expandBusinessDays(openDates: readonly string[], closedDates: readonly string[] = []): CalendarDay[] {
    const opens = openDates.filter((d) => parseYmd(d) !== null).sort();
    const out = new Map<string, boolean>();
    if (opens.length > 0) {
        const first = parseYmd(opens[0])!;
        const last = parseYmd(opens[opens.length - 1])!;
        for (let t = first.getTime(); t <= last.getTime(); t += 86_400_000) {
            out.set(new Date(t).toISOString().slice(0, 10).replace(/-/g, ''), false);
        }
    }
    for (const d of opens) out.set(d, true);
    for (const d of closedDates) if (parseYmd(d)) out.set(d, false);
    return [...out].map(([date, open]) => ({ date, open }));
}

/** 그 날짜가 열린 날인지 닫힌 날인지, 캘린더가 모르는 날짜인지. 주말은 항상 `closed` 다. */
export function marketDayStatus(market: CalendarMarket, ymd: string): CalendarDayStatus {
    const d = parseYmd(ymd);
    if (!d) return 'unknown';
    if (isWeekend(d)) return 'closed';
    const known = knownDays[market].get(ymd);
    if (known !== undefined) return known ? 'open' : 'closed';
    const key = `${market}:${ymd.slice(0, 6)}`;
    if (!warnedUnknownDays.has(key)) {
        warnedUnknownDays.add(key);
        logger.warn({ market, date: ymd },
            '[market-calendar] 휴장일 정보를 받지 못한 날짜가 있다 — 그 달의 평일은 열린 날로 보고 주말만 거른다. 증권사 캘린더 API 호출을 확인한다');
    }
    return 'unknown';
}

/** 캘린더가 그 날짜를 닫힌 날로 알고 있는가. 모르는 날짜는 `false` 다. */
export function isMarketClosedDay(market: CalendarMarket, ymd: string): boolean {
    return marketDayStatus(market, ymd) === 'closed';
}

export interface MarketCalendarStatus {
    /** 캘린더가 아는 평일 날짜 수. */
    knownDays: number;
    /** 아는 날짜 가운데 가장 늦은 날짜(`YYYYMMDD`). 없으면 `null`. */
    latestDate: string | null;
    /** 마지막으로 갱신에 성공한 시각(epoch ms). 없으면 `null`. */
    refreshedAtMs: number | null;
}

/** 시장별 캘린더 상태 — 호출하는 쪽이 캘린더를 못 받고 있는지 감시하는 데 쓴다. */
export function marketCalendarStatus(market: CalendarMarket): MarketCalendarStatus {
    const dates = [...knownDays[market].keys()].sort();
    return {
        knownDays: dates.length,
        latestDate: dates.length > 0 ? dates[dates.length - 1] : null,
        refreshedAtMs: refreshState[market].okAtMs,
    };
}

/**
 * 캘린더를 API 로 갱신한다. 아직 신선하면 호출하지 않고, 실패하면 결과를 `false` 로 알린다(던지지 않는다).
 *
 * @param fetchDays API 를 호출해 날짜별 개장 여부를 돌려주는 함수. 던지면 실패로 센다.
 * @param opts.ttlMs 성공한 갱신을 신선하게 보는 시간.
 * @param opts.nowMs 지금 시각(테스트용).
 * @returns 신선한 캘린더가 있으면 `true`.
 */
export function refreshMarketCalendar(
    market: CalendarMarket,
    fetchDays: () => Promise<readonly CalendarDay[]>,
    opts: { ttlMs: number; nowMs?: number },
): Promise<boolean> {
    const state = refreshState[market];
    const now = opts.nowMs ?? Date.now();
    if (state.inflight) return state.inflight;
    if (state.okAtMs !== null && now - state.okAtMs < opts.ttlMs) return Promise.resolve(true);
    if (state.failedAtMs !== null && now - state.failedAtMs < CALENDAR_RETRY_MS) return Promise.resolve(state.okAtMs !== null);

    state.inflight = (async () => {
        try {
            applyMarketCalendar(market, await fetchDays());
            state.okAtMs = now;
            state.failedAtMs = null;
            return true;
        } catch (err) {
            state.failedAtMs = now;
            logger.warn({ err, market }, '[market-calendar] 캘린더 API 호출 실패 — 10분 뒤 다시 시도한다');
            return state.okAtMs !== null;
        } finally {
            state.inflight = null;
        }
    })();
    return state.inflight;
}

/** 캘린더와 갱신 상태를 비운다. 테스트 전용이다. */
export function resetMarketCalendar(): void {
    for (const market of ['KR', 'US'] as const) {
        knownDays[market].clear();
        refreshState[market] = { okAtMs: null, failedAtMs: null, inflight: null };
    }
    warnedUnknownDays.clear();
}
