/**
 * @fileoverview 토큰 발급 락(`refreshTokenWithLock`)이 토큰 저장소(`BrokerTokenStore`)를 어떻게 쓰는지 고정한다.
 *
 * 저장소는 진짜 Redis 가 아니라 `BrokerTokenStore` 를 흉내 낸 가짜다. 이 패키지는 저장소 구현을 모르므로, 락의 동작은 인터페이스의 계약만으로
 * 검증할 수 있어야 한다.
 */

import { describe, it, expect, vi } from 'vitest';

import type { BrokerTokenStore } from '../options';
import { refreshTokenWithLock } from '../token-refresh-lock';

const STORE_KEY = 'test:token';
const LOCK_KEY = `${STORE_KEY}:lock`;
const WAIT_MS = 5;

function fakeStore(overrides: Partial<BrokerTokenStore> = {}): BrokerTokenStore {
    return {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        deleteIfAccessTokenEquals: vi.fn().mockResolvedValue(false),
        tryLock: vi.fn().mockResolvedValue(true),
        unlock: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function params(overrides: Partial<Parameters<typeof refreshTokenWithLock<string>>[0]> = {}) {
    return {
        label: '[Test]',
        store: null as BrokerTokenStore | null,
        storeKey: STORE_KEY,
        lockTtlMs: 10_000,
        waitMs: WAIT_MS,
        readCached: vi.fn().mockResolvedValue(null),
        issueAndCache: vi.fn().mockResolvedValue('issued'),
        ...overrides,
    };
}

describe('refreshTokenWithLock — 토큰 저장소가 없을 때', () => {
    it('락 없이 바로 발급한다', async () => {
        const p = params();

        await expect(refreshTokenWithLock(p)).resolves.toBe('issued');

        expect(p.issueAndCache).toHaveBeenCalledTimes(1);
        expect(p.readCached).not.toHaveBeenCalled();
    });
});

describe('refreshTokenWithLock — 락을 잡았을 때', () => {
    it('발급하고, 자기가 잡은 락을 같은 소유자 값으로 푼다', async () => {
        const store = fakeStore();
        const p = params({ store });

        await expect(refreshTokenWithLock(p)).resolves.toBe('issued');

        expect(store.tryLock).toHaveBeenCalledWith(LOCK_KEY, expect.any(String), 10_000);
        const owner = vi.mocked(store.tryLock).mock.calls[0][1];
        expect(store.unlock).toHaveBeenCalledWith(LOCK_KEY, owner);
        expect(p.issueAndCache).toHaveBeenCalledTimes(1);
        expect(p.readCached).toHaveBeenCalledTimes(1);   // 락을 잡은 직후 한 번 다시 읽는다
    });

    it('★락을 잡았는데 저장소에 이미 토큰이 있으면 발급하지 않는다 — 다른 프로세스가 발급을 마치고 락을 막 풀었다', async () => {
        const store = fakeStore();
        const p = params({ store, readCached: vi.fn().mockResolvedValue('from-other-process') });

        await expect(refreshTokenWithLock(p)).resolves.toBe('from-other-process');

        expect(p.issueAndCache).not.toHaveBeenCalled();
        expect(store.unlock).toHaveBeenCalled();
    });

    it('락 해제가 실패해도 발급한 토큰을 돌려준다(락은 TTL 로 만료된다)', async () => {
        const store = fakeStore({ unlock: vi.fn().mockRejectedValue(new Error('unlock failed')) });

        await expect(refreshTokenWithLock(params({ store }))).resolves.toBe('issued');
    });
});

describe('refreshTokenWithLock — 락을 못 잡았을 때', () => {
    it('다른 프로세스가 캐시에 넣은 토큰이 있으면 발급하지 않고 그것을 쓴다', async () => {
        const store = fakeStore({ tryLock: vi.fn().mockResolvedValue(false) });
        const p = params({ store, readCached: vi.fn().mockResolvedValue('cached-by-peer') });

        await expect(refreshTokenWithLock(p)).resolves.toBe('cached-by-peer');

        expect(p.issueAndCache).not.toHaveBeenCalled();
        expect(store.unlock).not.toHaveBeenCalled();
    });

    it('기다린 뒤에도 캐시가 비어 있으면 직접 발급한다', async () => {
        const store = fakeStore({ tryLock: vi.fn().mockResolvedValue(false) });
        const p = params({ store });

        await expect(refreshTokenWithLock(p)).resolves.toBe('issued');

        expect(p.readCached).toHaveBeenCalledTimes(1);
        expect(p.issueAndCache).toHaveBeenCalledTimes(1);
    });

    it('캐시 조회가 던져도 직접 발급으로 넘어간다', async () => {
        const store = fakeStore({ tryLock: vi.fn().mockResolvedValue(false) });
        const p = params({ store, readCached: vi.fn().mockRejectedValue(new Error('read failed')) });

        await expect(refreshTokenWithLock(p)).resolves.toBe('issued');

        expect(p.issueAndCache).toHaveBeenCalledTimes(1);
    });
});

describe('refreshTokenWithLock — 저장소가 락 연산에서 실패할 때', () => {
    it('락 획득이 던지면 기다린 뒤 직접 발급한다', async () => {
        const store = fakeStore({ tryLock: vi.fn().mockRejectedValue(new Error('redis down')) });
        const p = params({ store });

        await expect(refreshTokenWithLock(p)).resolves.toBe('issued');

        expect(p.issueAndCache).toHaveBeenCalledTimes(1);
    });
});

describe('refreshTokenWithLock — 락을 잡은 채 발급이 실패할 때', () => {
    it('발급을 한 번만 시도하고 실패를 그대로 던진다', async () => {
        const store = fakeStore();
        const failure = new Error('issue failed');
        const p = params({ store, issueAndCache: vi.fn().mockRejectedValue(failure) });

        await expect(refreshTokenWithLock(p)).rejects.toBe(failure);

        expect(p.issueAndCache).toHaveBeenCalledTimes(1);
        expect(store.unlock).toHaveBeenCalledTimes(1);
    });
});
