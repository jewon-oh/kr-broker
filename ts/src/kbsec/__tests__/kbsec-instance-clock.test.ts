/**
 * @fileoverview KB 의 날짜 기본값이 인스턴스 시계(`milliseconds()`)를 따른다. 실제 날짜가 아니라 바꿔 끼운 시계의 한국 날짜로 조회한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR, kbsecBusinessDateKst } from '../kbsec-types';
import { applyMarketCalendar, resetMarketCalendar } from '../../market-calendar';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';

const ok = (body: unknown) => {
    const text = JSON.stringify({ dataHeader: { processFlag: 'A', processCode: '0011' }, dataBody: body });
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};
const tokenOk = () => ({ ok: true, status: 200, text: async () => '{"access_token":"tok","expires_in":86400}' });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

afterEach(() => {
    resetMarketCalendar();
});

describe('인스턴스 시계', () => {
    it('계좌원장 조회의 끝 날짜 기본값은 milliseconds() 의 한국 날짜다', async () => {
        const seen: Record<string, string>[] = [];
        mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
            if (String(url).includes('/oauth2/token')) return tokenOk();
            if (String(url).toUpperCase().endsWith(KBSEC_TR.LEDGER_CMA)) seen.push(JSON.parse(init.body).dataBody);
            return ok({ nxt_key: '', Record1: [] });
        });
        const exchange = new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0 });
        exchange.milliseconds = () => Date.parse('2026-03-24T15:30:00Z');   // 2026-03-25 00:30 KST

        await exchange.fetchCmaLedger();

        expect(seen.map((b) => [b.strt_dt, b.end_dt])).toEqual([['20260325', '20260325']]);
    });
});

describe('조회 기준 영업일', () => {
    // 2026-09-25(금) 12:00 KST. 24·25일이 추석 연휴이고 26·27일은 주말이다.
    const friday = new Date('2026-09-25T03:00:00Z');

    it('휴장일 캘린더를 받았으면 주말과 함께 휴장일도 건너뛴다', () => {
        applyMarketCalendar('KR', [{ date: '20260924', open: false }, { date: '20260925', open: false }]);
        expect(kbsecBusinessDateKst(0, friday)).toBe('20260923');
        expect(kbsecBusinessDateKst(1, friday)).toBe('20260922');
    });

    it('캘린더가 없으면 주말만 건너뛴다(모르는 휴장일은 호출부가 2854 로 되감는다)', () => {
        expect(kbsecBusinessDateKst(0, friday)).toBe('20260925');
        expect(kbsecBusinessDateKst(0, new Date('2026-09-27T03:00:00Z'))).toBe('20260925');   // 일요일
    });
});
