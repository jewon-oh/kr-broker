/**
 * @fileoverview `kis` 가 국내휴장일조회(`chk-holiday`, CTCA0903R)로 휴장일을 받아 공용 캘린더에 넣는지, 국내 실주문 직전에 그 캘린더로 게이트를 거는지 고정한다.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock('../us-market-hours', () => ({
    getUsMarketPhase: () => 'open',
    formatEtWallClock: () => '10:00 ET',
}) satisfies Partial<typeof import('../us-market-hours')>);
global.fetch = mockFetch as unknown as typeof fetch;

import { kis } from '../../kis';
import { NotSupported, MarketClosed } from '../../base/errors';
import { marketDayStatus, resetMarketCalendar } from '../../market-calendar';
import { dataOk, headersOf, jsonResponse, newKis, tokenOk } from './support/kis-test-utils';

const holidayOk = (rows: Array<Record<string, string>>) => dataOk({ output: rows });

const ROWS = [
    { bass_dt: '20261002', bzdy_yn: 'Y', tr_day_yn: 'Y', opnd_yn: 'Y', sttl_day_yn: 'Y' },
    { bass_dt: '20261005', bzdy_yn: 'N', tr_day_yn: 'N', opnd_yn: 'N', sttl_day_yn: 'N' },
    { bass_dt: '20261006', bzdy_yn: 'Y', tr_day_yn: 'Y', opnd_yn: 'Y', sttl_day_yn: 'N' },
];

beforeEach(() => {
    mockFetch.mockReset();
});

afterEach(() => {
    resetMarketCalendar();
    vi.useRealTimers();
});

describe('kis.fetchMarketCalendar', () => {
    it('★개장·영업·거래·결제 여부를 모두 돌려준다(개장일과 결제일은 다른 개념이다)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(holidayOk(ROWS)).mockResolvedValueOnce(holidayOk(ROWS));

        const days = await newKis({ sandbox: false }).fetchMarketCalendar();

        expect(days.find((d) => d.date === '20261005')).toMatchObject({ open: false, business: false, trading: false, settlement: false });
        // 개장일이지만 결제일이 아닌 날.
        expect(days.find((d) => d.date === '20261006')).toMatchObject({ open: true, business: true, trading: true, settlement: false });
    });

    it('chk-holiday 를 CTCA0903R 로 두 번(30일 전 기준일과 오늘 기준일) 부른다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(holidayOk(ROWS)).mockResolvedValueOnce(holidayOk(ROWS));

        await newKis({ sandbox: false }).fetchMarketCalendar();

        const [url] = mockFetch.mock.calls[1] as [string];
        expect(url).toContain('/uapi/domestic-stock/v1/quotations/chk-holiday');
        expect(headersOf(mockFetch, 1).tr_id).toBe('CTCA0903R');
        const bases = [1, 2].map((i) => (mockFetch.mock.calls[i][0] as string).match(/BASS_DT=(\d{8})/)?.[1]);
        expect(bases[0]! < bases[1]!).toBe(true);
    });

    it('모의투자는 지원하지 않는다', async () => {
        await expect(newKis({ sandbox: true }).fetchMarketCalendar()).rejects.toThrow(NotSupported);

        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('kis.refreshMarketCalendar', () => {
    it('개장일 여부를 공용 캘린더에 넣는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(holidayOk(ROWS)).mockResolvedValueOnce(holidayOk(ROWS));

        await expect(newKis({ sandbox: false }).refreshMarketCalendar()).resolves.toBe(true);

        expect(marketDayStatus('KR', '20261005')).toBe('closed');
        expect(marketDayStatus('KR', '20261006')).toBe('open');
    });

    it('모의계좌는 이 API 를 호출하지 않는다', async () => {
        await expect(newKis({ sandbox: true }).refreshMarketCalendar()).resolves.toBe(false);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('자격증명이 없으면 호출하지 않고 false 다', async () => {
        await expect(new kis().refreshMarketCalendar()).resolves.toBe(false);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('호출이 실패해도 던지지 않는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValue(jsonResponse('boom', 500));

        await expect(newKis({ sandbox: false }).refreshMarketCalendar()).resolves.toBe(false);
    });

    it('12시간 안에 다시 부르면 API 를 호출하지 않는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(holidayOk(ROWS)).mockResolvedValueOnce(holidayOk(ROWS));
        const broker = newKis({ sandbox: false });

        await broker.refreshMarketCalendar();
        const calls = mockFetch.mock.calls.length;
        await broker.refreshMarketCalendar();

        expect(mockFetch.mock.calls.length).toBe(calls);
    });
});

describe('국내 실주문 게이트', () => {
    it('캘린더 API 가 휴장이라고 알려 준 평일에는 주문을 내지 않고 MarketClosed 를 던진다', async () => {
        // 2026-10-05(월) KST 10:00 — 개천절 대체공휴일. 표가 없어도 API 응답이 이 날을 막는다.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(holidayOk(ROWS)).mockResolvedValueOnce(holidayOk(ROWS));

        await expect(newKis({ sandbox: false }).createOrder('005930', 'limit', 'buy', 1, 70000)).rejects.toThrow(MarketClosed);

        // 주문 API 는 호출하지 않았다: 토큰 한 번과 휴장일 조회 두 번뿐이다.
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });
});

