/**
 * @fileoverview 토스의 시각 판정이 인스턴스 시계(`milliseconds()`)를 따른다. 실제 시각이 아니라 바꿔 끼운 시계로 세션을 고른다.
 */

import { describe, expect, it } from 'vitest';

import { installFakeToss, jsonOk, makeToss } from './support/toss-fake';

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
});
