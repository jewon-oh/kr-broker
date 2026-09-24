/**
 * @fileoverview KIS 일봉 페이지네이션 창 계산 — **순수 모듈**.
 *
 * KIS `inquire-daily-itemchartprice` 는 한 응답에 **약 100행**만 준다. 그래서 800봉을
 * 요청해도 최근 100봉만 오는데, 호출부가 길이가 0 이 아니면 성공으로 읽고 심층 구간을
 * Yahoo 로 폴백했다. Yahoo 는 KR 티커에서 429 를 내 재시도를 모두 소모한다. 결과적으로
 * **종목당 31초를 낭비하면서 심층 이력은 쌓이지 않았다.**
 *
 * 창을 과거로 옮겨 가며 반복 호출하면 KIS 만으로 채울 수 있다. 그 창 계산을 여기 둔다 —
 * 날짜 산술은 조용히 틀리기 쉬운데 부수효과에 섞여 있으면 테스트하기 어렵다.
 */

/** KIS 한 응답의 최대 행수(실측). 창 크기는 이걸 넘지 않게 잡는다. */
export const KIS_DAILY_PAGE_ROWS = 100;

/**
 * 한 창에 담을 **달력일** 수.
 *
 * 거래일이 아니라 달력일로 창을 잡는다(API 인자가 날짜라서). KRX 거래일은 달력일의
 * 대략 68%(주말·공휴일 제외)라 100 거래일 ≈ 147 달력일인데, **140** 으로 약간 좁게 잡아
 * 한 창이 100행 상한을 넘지 않게 한다. 넘치면 KIS 가 잘라서 주고, 잘린 쪽은 **조용히
 * 빈 구간**이 된다 — 페이지네이션이 만들 수 있는 최악의 결과다.
 */
export const KIS_DAILY_PAGE_DAYS = 140;

/** 안전 상한 — 창이 과거로 무한히 이어지지 않게. 800봉이면 9창에 도달한다. */
export const KIS_DAILY_MAX_PAGES = 12;

export interface DateWindow {
    /** `YYYYMMDD` */
    start: string;
    /** `YYYYMMDD` */
    end: string;
}

/** `Date` → `YYYYMMDD` (KIS 인자 형식). */
export function toKisDate(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

const MS_PER_DAY = 86_400_000;

/**
 * `endExclusiveMs` 이전으로 한 창을 만든다.
 *
 * 창은 **겹치지 않게** 이어 붙인다 — `end` 는 이전 창의 `start` 보다 하루 전이다.
 * 겹치면 같은 캔들을 두 번 받고(업서트라 무해하지만 호출이 낭비), 벌어지면 **빈틈이 생긴다**.
 */
export function windowBefore(endMs: number, days: number = KIS_DAILY_PAGE_DAYS): DateWindow {
    const end = new Date(endMs);
    const start = new Date(endMs - (days - 1) * MS_PER_DAY);
    return { start: toKisDate(start), end: toKisDate(end) };
}

/**
 * 오늘부터 과거로 거슬러 가며 필요한 창 목록을 만든다.
 *
 * @param neededCandles 더 받아야 할 캔들 수. 0 이하면 창 0개 — **이미 충분하면 호출하지 않는다**.
 * @param nowMs 기준 시각(테스트 주입).
 */
export function planWindows(
    neededCandles: number,
    nowMs: number,
    opts: { pageRows?: number; pageDays?: number; maxPages?: number } = {},
): DateWindow[] {
    const pageRows = opts.pageRows ?? KIS_DAILY_PAGE_ROWS;
    const pageDays = opts.pageDays ?? KIS_DAILY_PAGE_DAYS;
    const maxPages = opts.maxPages ?? KIS_DAILY_MAX_PAGES;

    if (!Number.isFinite(neededCandles) || neededCandles <= 0) return [];

    const pages = Math.min(maxPages, Math.ceil(neededCandles / pageRows));
    const out: DateWindow[] = [];
    let cursor = nowMs;
    for (let i = 0; i < pages; i++) {
        const w = windowBefore(cursor, pageDays);
        out.push(w);
        cursor -= pageDays * MS_PER_DAY;
    }
    return out;
}

/**
 * 여러 창에서 받은 캔들을 **타임스탬프 기준으로 합친다.**
 *
 * 창이 겹치거나 KIS 가 경계를 포함해서 주면 중복이 생긴다. 시간순 정렬 + 중복 제거를
 * 여기서 한 번만 한다 — 호출부마다 하면 빠뜨리는 곳이 생긴다.
 */
export function mergeCandles(pages: ReadonlyArray<number[][]>): number[][] {
    const byTs = new Map<number, number[]>();
    for (const page of pages) {
        for (const c of page) {
            const ts = c[0];
            if (!Number.isFinite(ts)) continue;
            byTs.set(ts, c);
        }
    }
    return [...byTs.values()].sort((a, b) => a[0] - b[0]);
}
