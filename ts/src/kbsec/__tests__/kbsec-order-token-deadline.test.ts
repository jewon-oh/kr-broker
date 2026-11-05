/**
 * KB 주문 TR 이 I445(토큰 검증 실패)로 거절되면 토큰을 회전하고 한 번 다시 보낸다. 그 회전이 토큰 저장소 장애로 길어지면
 * 주문이 뒤늦게 나가므로, 첫 시도와 재시도가 한 토큰 준비 마감을 나눠 쓰고 넘으면 두 번째 주문 요청을 보내지 않는다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

global.fetch = mockFetch as unknown as typeof fetch;

import { OrderTokenNotReady } from '../../base/errors';
import { kbsec } from '../../kbsec';
import type { BrokerTokenStore } from '../../options';

const CREDS = { appKey: 'kb-app-key-123456', appSecret: 'kb-secret' };

const tokenOk = () => ({ ok: true, status: 200, text: async () => '{"access_token":"tok","expires_in":86400}' });
const i445 = () => {
    const text = JSON.stringify({ dataHeader: { processFlag: 'B', processCode: 'I445', processMessage: '토큰 검증에 실패했습니다.' }, dataBody: {} });
    return { ok: false, status: 500, text: async () => text };
};
const accepted = () => {
    const text = JSON.stringify({ dataHeader: { processFlag: 'A' }, dataBody: { ordr_no: 'A1' } });
    return { ok: true, status: 200, text: async () => text };
};

/** 토큰 비교 삭제(I445 뒤 무효화)가 끝나지 않는 저장소. 나머지는 정상이다. */
function storeWithStuckInvalidation(): BrokerTokenStore {
    const data = new Map<string, string>();
    return {
        get: async (key) => data.get(key) ?? null,
        set: async (key, value) => { data.set(key, value); },
        delete: async (key) => { data.delete(key); },
        deleteIfAccessTokenEquals: () => new Promise<boolean>(() => undefined),
        tryLock: async () => true,
        unlock: async () => undefined,
    };
}

const trCalls = (): number => mockFetch.mock.calls.filter((c) => String(c[0]).includes('/api/v1/ssam1802')).length;

beforeEach(() => { mockFetch.mockReset(); });

describe('KB 주문의 I445 재시도와 토큰 준비 마감', () => {
    it('★I445 뒤의 토큰 회전이 마감을 넘기면 두 번째 주문 요청을 보내지 않는다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/token') ? tokenOk() : i445()));
        const exchange = new kbsec({
            apiKey: CREDS.appKey, secret: CREDS.appSecret, rateLimit: 0, orderTokenDeadline: 60,
            options: { tokenStore: storeWithStuckInvalidation() },
        });

        const error = await exchange.privatePostSsam1802({}).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(OrderTokenNotReady);
        expect(trCalls()).toBe(1); // 첫 시도만 나갔다
    });

    it('회전이 마감 안에 끝나면 종전대로 한 번 다시 보낸다', async () => {
        let attempts = 0;
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('/oauth2/token')) return tokenOk();
            return ++attempts === 1 ? i445() : accepted();
        });
        const exchange = new kbsec({ apiKey: CREDS.appKey, secret: CREDS.appSecret, rateLimit: 0, orderTokenDeadline: 5_000 });

        await expect(exchange.privatePostSsam1802({})).resolves.toBeDefined();
        expect(trCalls()).toBe(2);
    });
});
