/**
 * @fileoverview 휴장일 캘린더(`market-calendar.ts`)가 증권사 API 결과를 어떻게 담고 갱신하는지 고정한다.
 *
 * 캘린더는 저장된 표가 아니라 API 호출 결과이므로, 이 테스트가 확인하는 것은 "값을 넣으면 판정에 쓰인다", "모르는 날짜는 열린 날로
 * 보고 경고한다", "갱신은 TTL 과 실패 재시도 간격을 지킨다" 세 가지다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    expandBusinessDays,
    isMarketClosedDay,
    marketCalendarStatus,
    marketDayStatus,
    refreshMarketCalendar,
    CALENDAR_RETRY_MS,
} from '../market-calendar';
import { applyMarketCalendar, resetMarketCalendar } from '../testing';
import { setLogger, noopLogger, type BrokerLogger } from '../logger';

const warn = vi.fn();

beforeEach(() => {
    warn.mockReset();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as unknown as BrokerLogger);
});

afterEach(() => {
    resetMarketCalendar();
    setLogger(noopLogger);
});

describe('applyMarketCalendar / marketDayStatus', () => {
    it('넣은 날짜의 개장 여부를 그대로 돌려준다', () => {
        applyMarketCalendar('KR', [{ date: '20261005', open: false }, { date: '20261006', open: true }]);

        expect(marketDayStatus('KR', '20261005')).toBe('closed');
        expect(marketDayStatus('KR', '20261006')).toBe('open');
        expect(isMarketClosedDay('KR', '20261005')).toBe(true);
    });

    it('같은 날짜를 다시 넣으면 새 값으로 덮어쓴다 — 임시공휴일이 뒤늦게 지정되는 경우', () => {
        applyMarketCalendar('KR', [{ date: '20261005', open: true }]);
        applyMarketCalendar('KR', [{ date: '20261005', open: false }]);

        expect(marketDayStatus('KR', '20261005')).toBe('closed');
    });

    it('시장마다 따로 담는다', () => {
        applyMarketCalendar('US', [{ date: '20261225', open: false }]);

        expect(marketDayStatus('US', '20261225')).toBe('closed');
        expect(marketDayStatus('KR', '20261225')).toBe('unknown');
    });

    it('주말은 캘린더 없이도 닫혀 있고, 주말 항목은 저장하지 않는다', () => {
        applyMarketCalendar('KR', [{ date: '20261003', open: true }]);

        expect(marketDayStatus('KR', '20261003')).toBe('closed');
        expect(marketCalendarStatus('KR').knownDays).toBe(0);
    });

    it('존재하지 않는 날짜와 형식이 틀린 값은 버린다', () => {
        applyMarketCalendar('KR', [
            { date: '20260231', open: false },
            { date: '2026-10-05', open: false },
            { date: '', open: false },
        ]);

        expect(marketCalendarStatus('KR').knownDays).toBe(0);
        expect(marketDayStatus('KR', '20260231')).toBe('unknown');
    });
});

describe('모르는 날짜', () => {
    it('열린 날로 보지 않고 unknown 으로 알린다 — 닫힌 날로 단정하지 않는다', () => {
        expect(isMarketClosedDay('KR', '20270208')).toBe(false);
        expect(marketDayStatus('KR', '20270208')).toBe('unknown');
    });

    it('같은 달은 한 번만 경고하고, 다른 달은 따로 경고한다', () => {
        marketDayStatus('KR', '20270208');
        marketDayStatus('KR', '20270209');
        marketDayStatus('KR', '20270303');

        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('아는 날짜와 주말에는 경고하지 않는다', () => {
        applyMarketCalendar('KR', [{ date: '20261005', open: false }]);

        marketDayStatus('KR', '20261005');
        marketDayStatus('KR', '20261003');

        expect(warn).not.toHaveBeenCalled();
    });
});

describe('expandBusinessDays — 영업일만 아는 API 응답을 날짜별로 넓힌다', () => {
    it('전일과 익일 영업일 사이의 평일은 닫힌 날이다', () => {
        // 금(9/25) 다음 영업일이 화(9/29)면 월(9/28)은 휴장이다. 토·일은 저장하지 않는다.
        const days = expandBusinessDays(['20260925', '20260929']);
        applyMarketCalendar('US', days);

        expect(marketDayStatus('US', '20260925')).toBe('open');
        expect(marketDayStatus('US', '20260928')).toBe('closed');
        expect(marketDayStatus('US', '20260929')).toBe('open');
    });

    it('API 가 닫혔다고 알려 준 날짜는 닫힌 날이다', () => {
        const days = expandBusinessDays(['20260925', '20260930'], ['20260929']);

        expect(days.find(d => d.date === '20260929')?.open).toBe(false);
        expect(days.find(d => d.date === '20260930')?.open).toBe(true);
    });

    it('열린 날이 하나도 없으면 닫힌 날만 돌려준다', () => {
        expect(expandBusinessDays([], ['20261225'])).toEqual([{ date: '20261225', open: false }]);
    });
});

describe('refreshMarketCalendar', () => {
    const day = (date: string, open: boolean) => ({ date, open });

    it('API 결과를 캘린더에 넣고 true 를 돌려준다', async () => {
        const fetchDays = vi.fn().mockResolvedValue([day('20261005', false)]);

        await expect(refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000 })).resolves.toBe(true);

        expect(marketDayStatus('KR', '20261005')).toBe('closed');
        expect(marketCalendarStatus('KR').refreshedAtMs).not.toBeNull();
    });

    it('TTL 안에서는 다시 호출하지 않는다', async () => {
        const fetchDays = vi.fn().mockResolvedValue([day('20261005', false)]);

        await refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000, nowMs: 1_000 });
        await refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000, nowMs: 30_000 });

        expect(fetchDays).toHaveBeenCalledTimes(1);
    });

    it('TTL 이 지나면 다시 호출한다', async () => {
        const fetchDays = vi.fn().mockResolvedValue([day('20261005', false)]);

        await refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000, nowMs: 1_000 });
        await refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000, nowMs: 62_000 });

        expect(fetchDays).toHaveBeenCalledTimes(2);
    });

    it('동시에 부르면 API 호출은 한 번이다', async () => {
        let release: (days: ReturnType<typeof day>[]) => void = () => undefined;
        const fetchDays = vi.fn().mockReturnValue(new Promise<ReturnType<typeof day>[]>((resolve) => { release = resolve; }));

        const a = refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000 });
        const b = refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000 });
        release([day('20261005', false)]);

        await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
        expect(fetchDays).toHaveBeenCalledTimes(1);
    });

    it('실패하면 던지지 않고 false 를 돌려주며 경고를 남긴다', async () => {
        const fetchDays = vi.fn().mockRejectedValue(new Error('HTTP 500'));

        await expect(refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000 })).resolves.toBe(false);

        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('실패한 뒤 재시도 간격 안에서는 호출하지 않고, 지나면 다시 호출한다', async () => {
        const fetchDays = vi.fn().mockRejectedValue(new Error('HTTP 500'));

        await refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000, nowMs: 1_000 });
        await refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000, nowMs: 1_000 + CALENDAR_RETRY_MS - 1 });
        expect(fetchDays).toHaveBeenCalledTimes(1);

        await refreshMarketCalendar('KR', fetchDays, { ttlMs: 60_000, nowMs: 1_000 + CALENDAR_RETRY_MS });
        expect(fetchDays).toHaveBeenCalledTimes(2);
    });

    it('이전에 성공한 캘린더가 있으면 갱신이 실패해도 true 다 — 아는 값은 그대로 쓴다', async () => {
        const ok = vi.fn().mockResolvedValue([day('20261005', false)]);
        await refreshMarketCalendar('KR', ok, { ttlMs: 1_000, nowMs: 1_000 });

        const failing = vi.fn().mockRejectedValue(new Error('HTTP 500'));
        await expect(refreshMarketCalendar('KR', failing, { ttlMs: 1_000, nowMs: 10_000 })).resolves.toBe(true);

        expect(marketDayStatus('KR', '20261005')).toBe('closed');
    });
});
