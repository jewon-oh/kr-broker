/**
 * KIS 일봉 페이지네이션 창 계산 계약.
 *
 * 검증하는 것은 **창이 겹치지도 벌어지지도 않는다** 이다. 벌어지면 그 구간이 조용히 빈
 * 채로 남는데(캔들은 "없는 날" 과 "못 받은 날" 이 같은 모습이다), 실제로 그
 * 실패로 한 달치 캔들을 잃은 적이 있다.
 */
import { describe, it, expect } from 'vitest';

import {
    planWindows, windowBefore, toKisDate, mergeCandles,
    KIS_DAILY_PAGE_DAYS, KIS_DAILY_PAGE_ROWS, KIS_DAILY_MAX_PAGES,
} from '../kis-candle-pagination';

const NOW = Date.UTC(2026, 7, 21); // 2026-08-21

describe('toKisDate', () => {
    it('YYYYMMDD 로 0 패딩한다', () => {
        expect(toKisDate(new Date(Date.UTC(2026, 0, 5)))).toBe('20260105');
    });
});

describe('windowBefore', () => {
    it('창 길이가 정확히 days 일이다 (양끝 포함)', () => {
        const w = windowBefore(NOW, 10);
        expect(w.end).toBe('20260821');
        expect(w.start).toBe('20260812'); // 21 - 9 = 12
    });
});

describe('planWindows', () => {
    it('이미 충분하면 창이 0개 — 안 부른다', () => {
        expect(planWindows(0, NOW)).toEqual([]);
        expect(planWindows(-5, NOW)).toEqual([]);
    });

    it('100봉 이하면 창 1개', () => {
        expect(planWindows(100, NOW)).toHaveLength(1);
        expect(planWindows(1, NOW)).toHaveLength(1);
    });

    it('800봉이면 8창 — 100행/창', () => {
        expect(planWindows(800, NOW)).toHaveLength(8);
    });

    it('안전 상한을 넘지 않는다', () => {
        expect(planWindows(100_000, NOW).length).toBeLessThanOrEqual(KIS_DAILY_MAX_PAGES);
    });

    it('창이 겹치지도 벌어지지도 않는다 — 빈틈은 곧 조용한 데이터 손실', () => {
        const ws = planWindows(800, NOW);
        const parse = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
        for (let i = 0; i + 1 < ws.length; i++) {
            const thisStart = parse(ws[i].start);
            const nextEnd = parse(ws[i + 1].end);
            // 다음 창의 끝은 이 창의 시작 **하루 전**이어야 한다.
            expect((thisStart - nextEnd) / 86_400_000).toBe(1);
        }
    });

    it('창은 과거로 간다 — 순서가 뒤집히지 않는다', () => {
        const ws = planWindows(400, NOW);
        for (let i = 0; i + 1 < ws.length; i++) {
            expect(ws[i + 1].end < ws[i].start).toBe(true);
        }
    });

    it('창 하나가 100행 상한을 넘길 만큼 길지 않다 — KRX 거래일 ≈ 달력일 68%', () => {
        expect(KIS_DAILY_PAGE_DAYS * 0.68).toBeLessThanOrEqual(KIS_DAILY_PAGE_ROWS);
    });
});

describe('mergeCandles', () => {
    const c = (ts: number, close: number) => [ts, 1, 2, 0, close, 10];

    it('시간순으로 합친다', () => {
        const out = mergeCandles([[c(300, 3)], [c(100, 1), c(200, 2)]]);
        expect(out.map(x => x[0])).toEqual([100, 200, 300]);
    });

    it('중복 타임스탬프는 한 번만 — 창 경계가 겹쳐도 안전', () => {
        const out = mergeCandles([[c(100, 1)], [c(100, 9), c(200, 2)]]);
        expect(out).toHaveLength(2);
        expect(out[0][4]).toBe(9); // 나중 페이지가 이긴다
    });

    it('빈 페이지·잘못된 타임스탬프를 걸러낸다', () => {
        expect(mergeCandles([[], [[NaN, 1, 2, 3, 4, 5]]])).toEqual([]);
    });
});
