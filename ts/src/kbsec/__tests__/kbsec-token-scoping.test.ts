/**
 * @fileoverview KB 토큰 차단기와 토큰 캐시의 범위.
 *
 * - 차단기는 앱키마다 따로 센다. 한 계정의 실패가 같은 프로세스의 다른 계정을 막지 않는다.
 * - `invalidate(failedToken)` 은 캐시 토큰이 실패한 토큰일 때만 비운다.
 * - 만료 직전의 짧은 `expires_in` 도 수명의 절반 동안은 캐시해 TR 마다 발급하지 않는다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { BadRequest, ExchangeNotAvailable } from '../../base/errors';
import { __resetKbsecTokenBreaker, kbsecTokenBreakerState } from '../kbsec-token-breaker';

const envelope = (header: Record<string, unknown>, body: unknown, status = 200) => {
    const text = JSON.stringify({ dataHeader: header, dataBody: body });
    return { ok: status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
};
const ok = (body: unknown) => envelope({ processFlag: 'A', processCode: '0011' }, body);
const i445 = () => envelope({ processFlag: 'B', processCode: 'I445', processMessage: '토큰 검증에 실패했습니다.' }, {}, 500);
const token = (accessToken: string, expiresIn = 86400) => {
    const text = JSON.stringify({ access_token: accessToken, expires_in: expiresIn });
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};
const tokenCalls = () => mockFetch.mock.calls.filter((c) => String(c[0]).includes('/oauth2/token')).length;
const make = (appKey = 'kb-app-key-123456') => new kbsec({ apiKey: appKey, secret: 'kb-secret', rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('KB 토큰 차단기는 앱키마다 따로 센다', () => {
    it('★계정 A 의 토큰 실패가 이어져도 계정 B 의 호출은 막지 않는다', async () => {
        mockFetch.mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
            if (String(url).includes('/oauth2/token')) return token('T');
            if (init.headers.appKey === 'kb-app-key-AAAAAA') return i445();
            return ok({ ndy_o_amt_psbl_amt: '1' });
        });
        const a = make('kb-app-key-AAAAAA');
        for (let i = 0; i < 5; i++) await a.fetchWithdrawableAmount().catch(() => undefined);

        expect(kbsecTokenBreakerState('kb-app-key-AAAAAA').openUntil).toBeGreaterThan(Date.now());
        await expect(a.fetchWithdrawableAmount()).rejects.toBeInstanceOf(ExchangeNotAvailable);
        await expect(make('kb-app-key-BBBBBB').fetchWithdrawableAmount()).resolves.toMatchObject({ nextDay: 1 });
        expect(kbsecTokenBreakerState('kb-app-key-BBBBBB').streak).toBe(0);
    });
});

describe('KB 토큰 캐시', () => {
    it('★동시 요청 두 건이 같은 무효 토큰으로 실패해도 새 토큰을 두 번 받지 않는다', async () => {
        let issued = 0;
        mockFetch.mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
            if (String(url).includes('/oauth2/token')) return token(`T${++issued}`);
            if (init.headers.Authorization === 'bearer T1' || init.headers.authorization === 'bearer T1' || init.headers.Authorization === 'Bearer T1') {
                await new Promise((resolve) => setTimeout(resolve, 5));
                return i445();
            }
            return ok({ ndy_o_amt_psbl_amt: '1' });
        });
        const exchange = make('kb-app-key-999999');

        await Promise.all([exchange.fetchWithdrawableAmount(), exchange.fetchWithdrawableAmount()]);

        expect(tokenCalls()).toBe(2);   // 처음 발급 한 번과 회전 한 번
    });

    it('★만료 직전의 짧은 expires_in 도 수명의 절반 동안 캐시해 TR 마다 발급하지 않는다', async () => {
        mockFetch.mockImplementation(async (url: string) => String(url).includes('/oauth2/token') ? token('T1', 30) : ok({ ndy_o_amt_psbl_amt: '1' }));
        const exchange = make();

        for (let i = 0; i < 3; i++) await exchange.fetchWithdrawableAmount();

        expect(tokenCalls()).toBe(1);
    });
});

describe('KB 요청 주소와 호스트 주소', () => {
    it('★options.hostAddr 로 준 IP 와 MAC 을 TR 본문 dataHeader 에 싣는다(빠진 값만 자동으로 모은다)', async () => {
        mockFetch.mockImplementation(async (url: string) => String(url).includes('/oauth2/token') ? token('T1') : ok({ ndy_o_amt_psbl_amt: '1' }));
        const exchange = new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0, options: { hostAddr: { ipAddr: '192.0.2.7', macAddr: 'AA-BB-CC-DD-EE-FF' } } });

        await exchange.fetchWithdrawableAmount();

        const trCall = mockFetch.mock.calls.find((c) => !String(c[0]).includes('/oauth2/token'));
        expect(JSON.parse(trCall?.[1].body as string).dataHeader).toMatchObject({ ipAddr: '192.0.2.7', macAddr: 'AA-BB-CC-DD-EE-FF' });
    });

    it('★https 가 아닌 주소로는 토큰도 TR 도 보내지 않고 BadRequest 다(options.allowInsecureUrl 로만 허용)', async () => {
        const exchange = new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0, urls: { api: { public: 'http://example.invalid:9443', private: 'http://example.invalid:9443' } } });

        const error = await exchange.fetchWithdrawableAmount().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequest);
        expect((error as Error).message).toContain('https 가 아니다');
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
