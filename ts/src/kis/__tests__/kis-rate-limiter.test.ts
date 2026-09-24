/**
 * @fileoverview KIS 전역 예약 스케줄러 (EGW00201 프로액티브 방지)
 *
 * 핵심 회귀: 동시(병렬) 진입해도 슬롯이 동기 예약돼 MIN_INTERVAL 간격으로 직렬화되는가.
 * (기존 per-instance rateLimit 은 100개 동시 진입 시 모두 통과 → 버스트 → EGWN.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { acquireKisSlot, resetKisRateLimiter, KIS_MIN_INTERVAL_MS } from '../kis-rate-limiter';

describe('kis-rate-limiter — acquireKisSlot', () => {
    afterEach(() => {
        resetKisRateLimiter();
        vi.useRealTimers();
    });

    it('동시 진입 N개가 MIN_INTERVAL 간격으로 직렬화된다 (버스트 방지)', async () => {
        vi.useFakeTimers();
        const start = Date.now();
        const fired: number[] = [];
        const N = 5;

        // 5개를 동기적으로 동시 진입 — 예약은 진입 즉시(await 이전) 확정돼야 한다.
        const ps = Array.from({ length: N }, () =>
            acquireKisSlot('key-a').then(() => fired.push(Date.now() - start)),
        );

        await vi.advanceTimersByTimeAsync(KIS_MIN_INTERVAL_MS * N + 10);
        await Promise.all(ps);

        expect(fired).toEqual([
            0,
            KIS_MIN_INTERVAL_MS,
            KIS_MIN_INTERVAL_MS * 2,
            KIS_MIN_INTERVAL_MS * 3,
            KIS_MIN_INTERVAL_MS * 4,
        ]);
    });

    it('앱키가 다르면 독립 스케줄 — 서로 대기하지 않음', async () => {
        vi.useFakeTimers();
        const start = Date.now();
        const fired: Record<string, number> = {};

        const pa = acquireKisSlot('key-a').then(() => { fired.a = Date.now() - start; });
        const pb = acquireKisSlot('key-b').then(() => { fired.b = Date.now() - start; });

        await vi.advanceTimersByTimeAsync(10);
        await Promise.all([pa, pb]);

        expect(fired.a).toBe(0);
        expect(fired.b).toBe(0); // 다른 키 → 즉시 (서로 무관)
    });

    it('버스트 후 백로그가 빠지면 now 로 자가 회복 (불필요 대기 누적 없음)', async () => {
        vi.useFakeTimers();
        // 첫 호출 → 즉시(waitMs 0), 다음 슬롯 예약 = now + MIN_INTERVAL
        await acquireKisSlot('key-c');

        // 예약 슬롯을 한참 추월하도록 시간 진행
        await vi.advanceTimersByTimeAsync(1000);

        const start = Date.now();
        let firedAt = -1;
        const p = acquireKisSlot('key-c').then(() => { firedAt = Date.now() - start; });
        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(firedAt).toBe(0); // 백로그 없음 → 즉시 발사
    });

    it('MIN_INTERVAL 은 목표율(15/s) 기준 — 하드 한도 20/s(50ms) 대비 헤드룸', () => {
        expect(KIS_MIN_INTERVAL_MS).toBe(Math.ceil(1000 / 15)); // 67ms
        expect(KIS_MIN_INTERVAL_MS).toBeGreaterThan(50);
    });
});
