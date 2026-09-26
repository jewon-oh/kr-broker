/**
 * @fileoverview KB 의 날짜 기본값이 인스턴스 시계(`milliseconds()`)를 따른다. 실제 날짜가 아니라 바꿔 끼운 시계의 한국 날짜로 조회한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { MarketClosed } from '../../base/errors';
import { KBSEC_TR, kbsecBusinessDateKst } from '../kbsec-types';
import { applyMarketCalendar, resetMarketCalendar } from '../../market-calendar';
import { __resetKbsecTokenBreaker } from '../../testing';

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

describe('주문 게이트의 시계', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('장 시간 게이트는 milliseconds() 로 지금을 읽는다 — 인스턴스 시계가 일요일이면 주문을 보내지 않는다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-23T01:00:00Z'));   // 수요일 10:00 KST, 벽시계로는 장중이다
        mockFetch.mockImplementation(async () => ok({}));
        const exchange = new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0 });
        exchange.milliseconds = () => Date.parse('2026-09-27T01:00:00Z');   // 일요일 10:00 KST

        await expect(exchange.createOrder('005930/KRW', 'limit', 'buy', 1, 70000)).rejects.toBeInstanceOf(MarketClosed);
        // 게이트가 휴장일 캘린더를 받는 요청은 나갈 수 있다. 주문 TR 은 나가지 않아야 한다.
        const sent = mockFetch.mock.calls.map((call) => String(call[0]).split('/').pop()!.toUpperCase());
        expect(sent).not.toContain(KBSEC_TR.BUY_KR);
    });
});
