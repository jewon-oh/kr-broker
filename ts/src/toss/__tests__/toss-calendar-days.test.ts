/**
 * @fileoverview 토스 캘린더 응답(전일·당일·익일 영업일)을 날짜별 개장 여부로 바꾸는 변환을 고정한다.
 */

import { describe, it, expect } from 'vitest';

import { tossKrCalendarDays, tossUsCalendarDays } from '../toss-trading-hours';
import type { TossKrMarketCalendar, TossUsMarketCalendar } from '../toss-types';

const window = { startTime: '2026-09-29T09:00:00+09:00', endTime: '2026-09-29T15:30:00+09:00' };
const usDay = (date: string, open: boolean) => ({
    date,
    dayMarket: null,
    preMarket: null,
    regularMarket: open ? window : null,
    afterMarket: null,
});
const krDay = (date: string, regular: boolean) => ({
    date,
    integrated: { preMarket: null, regularMarket: regular ? window : null, afterMarket: null },
});

const openOf = (days: { date: string; open: boolean }[], date: string) => days.find(d => d.date === date)?.open;

describe('tossKrCalendarDays', () => {
    it('정규장이 있는 날은 열린 날이다', () => {
        const cal: TossKrMarketCalendar = {
            previousBusinessDay: krDay('2026-09-29', true),
            today: krDay('2026-09-30', true),
            nextBusinessDay: krDay('2026-10-01', true),
        };

        const days = tossKrCalendarDays(cal);

        expect(openOf(days, '20260929')).toBe(true);
        expect(openOf(days, '20260930')).toBe(true);
        expect(openOf(days, '20261001')).toBe(true);
    });

    it('오늘이 휴장이면 integrated 가 null 이고 그날은 닫힌 날이다', () => {
        const cal: TossKrMarketCalendar = {
            previousBusinessDay: krDay('2026-10-02', true),
            today: { date: '2026-10-05', integrated: null },
            nextBusinessDay: krDay('2026-10-06', true),
        };

        const days = tossKrCalendarDays(cal);

        expect(openOf(days, '20261005')).toBe(false);
        expect(openOf(days, '20261002')).toBe(true);
        expect(openOf(days, '20261006')).toBe(true);
    });

    it('오늘 항목이 없어도 전일과 익일 영업일 사이의 평일은 닫힌 날이다', () => {
        const cal: TossKrMarketCalendar = {
            previousBusinessDay: krDay('2026-10-02', true),
            nextBusinessDay: krDay('2026-10-06', true),
        };

        expect(openOf(tossKrCalendarDays(cal), '20261005')).toBe(false);
    });

    it('NXT 프리마켓만 쉬는 부분 휴장일은 정규장이 있으므로 열린 날이다', () => {
        const cal: TossKrMarketCalendar = {
            today: { date: '2026-09-30', integrated: { preMarket: null, regularMarket: window, afterMarket: null } },
        };

        expect(openOf(tossKrCalendarDays(cal), '20260930')).toBe(true);
    });

    it('응답이 없으면 빈 목록이다', () => {
        expect(tossKrCalendarDays(null)).toEqual([]);
        expect(tossKrCalendarDays(undefined)).toEqual([]);
    });
});

describe('tossUsCalendarDays', () => {
    it('4 세션 가운데 하나라도 있으면 열린 날이다', () => {
        const cal: TossUsMarketCalendar = {
            today: { date: '2026-09-29', dayMarket: window, preMarket: null, regularMarket: null, afterMarket: null },
        };

        expect(openOf(tossUsCalendarDays(cal), '20260929')).toBe(true);
    });

    it('세션이 전부 null 이면 닫힌 날이다', () => {
        const cal: TossUsMarketCalendar = {
            previousBusinessDay: usDay('2026-12-24', true),
            today: usDay('2026-12-25', false),
            nextBusinessDay: usDay('2026-12-28', true),
        };

        const days = tossUsCalendarDays(cal);

        expect(openOf(days, '20261225')).toBe(false);
        expect(openOf(days, '20261224')).toBe(true);
        expect(openOf(days, '20261228')).toBe(true);
    });

    it('세션 키가 아예 없는 날(undefined)도 세션이 없는 날이라 닫힌 날이다', () => {
        const cal = {
            previousBusinessDay: usDay('2026-12-24', true),
            today: { date: '2026-12-25' },
            nextBusinessDay: usDay('2026-12-28', true),
        } as unknown as TossUsMarketCalendar;

        const days = tossUsCalendarDays(cal);

        expect(openOf(days, '20261225')).toBe(false);
        expect(openOf(days, '20261224')).toBe(true);
        expect(openOf(days, '20261228')).toBe(true);
    });

    it('날짜가 없는 항목({})은 던지지 않고 건너뛴다', () => {
        const cal = {
            previousBusinessDay: {},
            today: usDay('2026-12-24', true),
            nextBusinessDay: usDay('2026-12-28', true),
        } as unknown as TossUsMarketCalendar;

        const days = tossUsCalendarDays(cal);

        expect(openOf(days, '20261224')).toBe(true);
        expect(openOf(days, '20261228')).toBe(true);
        expect(days.every((d) => /^\d{8}$/.test(d.date))).toBe(true);
    });

    it('응답이 없으면 빈 목록이다', () => {
        expect(tossUsCalendarDays(undefined)).toEqual([]);
    });
});
