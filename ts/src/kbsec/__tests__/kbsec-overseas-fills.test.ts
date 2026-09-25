/**
 * 해외 체결 확정이 **국내 전용 TR** 을 보고 있었다.
 *
 * `fetchMyTrades` 가 심볼과 무관하게 `TRADES_KR`(SSQM2341)만 불렀다. 그래서 해외 주문의
 * 체결 확정은 **국내 체결내역에서 US 티커를 찾는** 꼴이라 구조적으로 항상 실패했고,
 * 매번 발주값(요청 수량·요청가)이 진입가로 기록됐다. 확정 절차는 실행되는데 결과가 언제나 같았다.
 *
 * 해외 TR(`SPQM2103`)은 상수로 존재했지만 **`[미배선]` 이라고 적혀 있었다.**
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';

const CREDS = { appKey: 'kb-app-key-123456', appSecret: 'kb-secret' };

const jsonOk = (body: unknown) => ({
    ok: true, status: 200,
    json: async () => ({ dataHeader: { resultCode: '00000' }, dataBody: body }),
    text: async () => JSON.stringify({ dataHeader: { resultCode: '00000' }, dataBody: body }),
});
const tokenOk = () => ({
    ok: true, status: 200,
    json: async () => ({ access_token: 'tok', expires_in: 86400 }),
    text: async () => '{"access_token":"tok","expires_in":86400}',
});

/** 호출된 TR 코드를 순서대로 수집한다. */
function calledTrs(): string[] {
    return mockFetch.mock.calls
        .map(c => String(c[0]))
        .filter(u => u.includes('/api/v1/'))
        .map(u => u.split('/api/v1/')[1]);
}

function makeService(): kbsec {
    return new kbsec({ apiKey: CREDS.appKey, secret: CREDS.appSecret, rateLimit: 0 });
}

beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string) =>
        (String(url).includes('/oauth2/token') ? tokenOk() : jsonOk({})));
});

describe('체결내역 조회는 시장으로 갈린다', () => {
    it('해외 티커면 해외 TR(SPQM2103) 을 부른다 (종전: 국내 TR 만 불렀다)', async () => {
        await makeService().fetchMyTrades('AAPL/USD');

        const trs = calledTrs();
        expect(trs).toContain(KBSEC_TR.ORDERS_US.toLowerCase());
        expect(trs).not.toContain(KBSEC_TR.TRADES_KR.toLowerCase());
    });

    it('국내 종목은 종전대로 국내 TR(SSQM2341) 이다 — 회귀 방지', async () => {
        await makeService().fetchMyTrades('005930/KRW');

        const trs = calledTrs();
        expect(trs).toContain(KBSEC_TR.TRADES_KR.toLowerCase());
        expect(trs).not.toContain(KBSEC_TR.ORDERS_US.toLowerCase());
    });

    it('해외 조회가 실패하면 던진다 — 빈 배열("체결 없음")과 구분한다. 확정은 호출하는 쪽이 발주값으로 폴백한다', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('/oauth2/token')) return tokenOk();
            throw new Error('권한 없음');
        });

        await expect(makeService().fetchMyTrades('AAPL/USD')).rejects.toThrow();
    });

    it('업무 오류(권한 없음)로 실패한 뒤에는 다시 부르지 않는다 — 반복 실패는 계정 제한 사유', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('/oauth2/token')) return tokenOk();
            const text = JSON.stringify({ dataHeader: { processFlag: 'B', processCode: 'I446', processMessage: 'API 사용 권한이 없습니다.' }, dataBody: {} });
            return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
        });
        const svc = makeService();

        await expect(svc.fetchMyTrades('AAPL/USD')).rejects.toThrow();
        const afterFirst = calledTrs().length;
        await expect(svc.fetchMyTrades('AAPL/USD')).rejects.toThrow(/다시 부르지 않는다/);

        expect(calledTrs().length).toBe(afterFirst);
    });

    it('★연결 끊김 같은 일시 오류는 래치하지 않는다 — 다음 호출에서 다시 부른다', async () => {
        let failOnce = true;
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('/oauth2/token')) return tokenOk();
            if (failOnce) { failOnce = false; throw new TypeError('fetch failed'); }
            return jsonOk({ grid: [] });
        });
        const svc = makeService();

        await expect(svc.fetchMyTrades('AAPL/USD', undefined, undefined, { date: '20260922' })).rejects.toThrow();
        await expect(svc.fetchMyTrades('AAPL/USD', undefined, undefined, { date: '20260922' })).resolves.toEqual([]);
    });
});
