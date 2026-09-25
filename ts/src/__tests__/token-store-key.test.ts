/**
 * @fileoverview 토큰 저장소 키. 자격증명 원문 대신 해시를 쓰고, 키 형식을 바꾸는 판은 옛 키와 함께 읽고 쓴다.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BrokerTokenStore } from '../options';
import { legacyTokenStoreKey, tokenStoreKey, withLegacyTokenKeys } from '../token-store-key';
import { TossAuth } from '../toss/toss-auth';

function makeStore(): BrokerTokenStore & { data: Map<string, string>; locks: Set<string> } {
    const data = new Map<string, string>();
    const locks = new Set<string>();
    return {
        data,
        locks,
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

const token = (accessToken: string) => JSON.stringify({ accessToken, expiresAt: Date.now() + 3_600_000 });

describe('tokenStoreKey', () => {
    it('★앞 12자가 같은 두 자격증명도 서로 다른 키를 받고, 키에 원문이 드러나지 않는다', () => {
        const a = tokenStoreKey('toss:token:', 'client-shared-prefix-A');
        const b = tokenStoreKey('toss:token:', 'client-shared-prefix-B');
        expect(a).not.toBe(b);
        expect(a).toMatch(/^toss:token:[0-9a-f]{32}$/);
        expect(a).not.toContain('client-shar');
        expect(legacyTokenStoreKey('toss:token:', 'client-shared-prefix-A')).toBe(legacyTokenStoreKey('toss:token:', 'client-shared-prefix-B'));
    });
});

describe('withLegacyTokenKeys — 옛 키 형식과의 이행', () => {
    const NEW = 'toss:token:new';
    const OLD = 'toss:token:old';

    it('읽기는 새 키에 없으면 옛 키에서 읽는다', async () => {
        const raw = makeStore();
        const old = token('from-old-version');
        raw.data.set(OLD, old);
        expect(await withLegacyTokenKeys(raw, { [NEW]: OLD }).get(NEW)).toBe(old);
    });

    it('쓰기와 삭제는 두 키에 모두 한다', async () => {
        const raw = makeStore();
        const store = withLegacyTokenKeys(raw, { [NEW]: OLD });
        await store.set(NEW, token('t'), 1000);
        expect([...raw.data.keys()].sort()).toEqual([NEW, OLD].sort());
        await store.delete(NEW);
        expect(raw.data.size).toBe(0);
    });

    it('같은 토큰일 때만 지우기는 키마다 따로 판정한다 — 옛 키에 다른 프로세스의 새 토큰이 있으면 남긴다', async () => {
        const raw = makeStore();
        const fresh = token('fresh-from-old-version');
        raw.data.set(NEW, token('failed'));
        raw.data.set(OLD, fresh);
        expect(await withLegacyTokenKeys(raw, { [NEW]: OLD }).deleteIfAccessTokenEquals(NEW, 'failed')).toBe(true);
        expect(raw.data.has(NEW)).toBe(false);
        expect(raw.data.get(OLD)).toBe(fresh);
    });

    it('★발급 락은 옛 키로 잡는다 — 옛 판 프로세스와 같은 락이라 롤링 배포 중에도 동시 발급이 막힌다', async () => {
        const raw = makeStore();
        const store = withLegacyTokenKeys(raw, { [NEW]: OLD });
        expect(await store.tryLock(`${NEW}:lock`, 'me', 1000)).toBe(true);
        expect([...raw.locks]).toEqual([`${OLD}:lock`]);
        expect(await raw.tryLock(`${OLD}:lock`, 'old-version', 1000)).toBe(false);
        await store.unlock(`${NEW}:lock`, 'me');
        expect(raw.locks.size).toBe(0);
    });
});

describe('토스 인증과 공유 저장소', () => {
    it('★앞 12자가 같은 두 클라이언트가 저장소를 나눠 써도 서로의 토큰을 쓰지 않는다', async () => {
        const raw = makeStore();
        const a = new TossAuth('toss-client-shared-AAAA', async () => ({ accessToken: 'token-A', expiresInSeconds: 86400 }), () => raw);
        const issueB = vi.fn(async () => ({ accessToken: 'token-B', expiresInSeconds: 86400 }));
        const b = new TossAuth('toss-client-shared-BBBB', issueB, () => raw);

        expect(await a.getAccessToken()).toBe('token-A');
        // 이행 기간에는 옛 키(앞 12자)가 겹친다. 새 키가 먼저라, 새 판끼리는 서로의 토큰을 읽지 않는다.
        raw.data.delete(legacyTokenStoreKey('toss:token:', 'toss-client-shared-AAAA'));
        expect(await b.getAccessToken()).toBe('token-B');
        expect(issueB).toHaveBeenCalledTimes(1);
    });

    it('옛 판이 옛 키에 넣은 토큰을 새 판이 읽어 새로 발급하지 않는다', async () => {
        const raw = makeStore();
        raw.data.set(legacyTokenStoreKey('toss:token:', 'toss-client-id-abcdef'), token('old-version-token'));
        const issue = vi.fn(async () => ({ accessToken: 'new', expiresInSeconds: 86400 }));

        expect(await new TossAuth('toss-client-id-abcdef', issue, () => raw).getAccessToken()).toBe('old-version-token');
        expect(issue).not.toHaveBeenCalled();
    });
});
