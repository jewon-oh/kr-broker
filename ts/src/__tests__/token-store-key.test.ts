/**
 * @fileoverview 토큰 저장소 키. 자격증명 원문 대신 해시를 쓴다.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BrokerTokenStore } from '../options';
import { tokenStoreKey } from '../token-store-key';
import { TossAuth } from '../toss/toss-auth';

function makeStore(): BrokerTokenStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    const locks = new Set<string>();
    return {
        data,
        get: async (key) => data.get(key) ?? null,
        set: async (key, value) => { data.set(key, value); },
        delete: async (key) => { data.delete(key); },
        deleteIfAccessTokenEquals: async (key, accessToken) => {
            const raw = data.get(key);
            if (raw === undefined || (JSON.parse(raw) as { accessToken?: string }).accessToken !== accessToken) return false;
            data.delete(key);
            return true;
        },
        tryLock: async (key) => { if (locks.has(key)) return false; locks.add(key); return true; },
        unlock: async (key) => { locks.delete(key); },
    };
}

describe('tokenStoreKey', () => {
    it('★앞 12자가 같은 두 자격증명도 서로 다른 키를 받고, 키에 원문이 드러나지 않는다', () => {
        const a = tokenStoreKey('toss:token:', 'client-shared-prefix-A');
        const b = tokenStoreKey('toss:token:', 'client-shared-prefix-B');
        expect(a).not.toBe(b);
        expect(a).toMatch(/^toss:token:[0-9a-f]{32}$/);
        expect(a).not.toContain('client-shar');
    });
});

describe('토스 인증과 공유 저장소', () => {
    it('★앞 12자가 같은 두 클라이언트가 저장소를 나눠 써도 서로의 토큰을 쓰지 않는다', async () => {
        const raw = makeStore();
        const a = new TossAuth('toss-client-shared-AAAA', async () => ({ accessToken: 'token-A', expiresInSeconds: 86400 }), () => raw);
        const issueB = vi.fn(async () => ({ accessToken: 'token-B', expiresInSeconds: 86400 }));
        const b = new TossAuth('toss-client-shared-BBBB', issueB, () => raw);

        expect(await a.getAccessToken()).toBe('token-A');
        expect(await b.getAccessToken()).toBe('token-B');
        expect(issueB).toHaveBeenCalledTimes(1);
    });
});
