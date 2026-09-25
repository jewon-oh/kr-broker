/**
 * @fileoverview 토스의 시각 판정이 인스턴스 시계(`milliseconds()`)를 따른다. 실제 시각이 아니라 바꿔 끼운 시계로 세션을 고른다.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorReply, installFakeToss, jsonOk, makeToss } from './support/toss-fake';

afterEach(() => {
    vi.useRealTimers();
});

// 2026-03-25 의 미국 장 운영 캘린더(한국 시각). 정규장은 22:30 부터 다음 날 05:00 까지다.
const session = (day: string, next: string) => ({
    date: day,
    dayMarket: { startTime: `${day}T09:00:00+09:00`, endTime: `${day}T16:50:00+09:00` },
    preMarket: { startTime: `${day}T17:00:00+09:00`, endTime: `${day}T22:30:00+09:00` },
    regularMarket: { startTime: `${day}T22:30:00+09:00`, endTime: `${next}T05:00:00+09:00` },
    afterMarket: { startTime: `${next}T05:00:00+09:00`, endTime: `${next}T07:00:00+09:00` },
});

describe('인스턴스 시계', () => {
    it('currentUsSession 은 milliseconds() 로 지금을 읽는다', async () => {
        installFakeToss({
            'GET /api/v1/market-calendar/US': jsonOk({
                previousBusinessDay: session('2026-03-24', '2026-03-25'),
                today: session('2026-03-25', '2026-03-26'),
                nextBusinessDay: session('2026-03-26', '2026-03-27'),
            }),
        });
        const toss = makeToss();
        toss.milliseconds = () => Date.parse('2026-03-25T14:30:00Z');   // 23:30 KST

        await expect(toss.currentUsSession()).resolves.toBe('regularMarket');
    });

    it('캘린더를 받지 못했을 때의 정적 시간표도 milliseconds() 로 판정한다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-03-28T01:00:00Z'));   // 토요일. 벽시계로는 장 밖이다
        installFakeToss({
            'GET /api/v1/market-calendar/KR': errorReply(500, 'internal-error'),
            'POST /api/v1/orders': jsonOk({ orderId: 'OID-1' }),
        });
        const toss = makeToss({ options: { maxRetriesOnFailure: 0 } });
        toss.milliseconds = () => Date.parse('2026-03-25T01:00:00Z');   // 수요일 10:00 KST

        await expect(toss.createOrder('005930', 'limit', 'buy', 1, 70000, { confirmExecution: false })).resolves.toMatchObject({ id: 'OID-1' });
    });
});
