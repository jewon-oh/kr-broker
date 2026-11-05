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
        const owner = vi.mocked(store.tryLock).mock.calls[0]![1];
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

describe('refreshTokenWithLock — 대기는 횟수가 아니라 벽시계 마감으로 센다', () => {
    /** 저장소 읽기가 `readMs` 걸리는 락 미획득 상황(저장소 장애처럼 읽기마다 오래 매달린다). */
    function slowReads(readMs: number, value: string | null = null) {
        return vi.fn(() => new Promise<string | null>((resolve) => setTimeout(() => resolve(value), readMs)));
    }

    it('★읽기마다 오래 매달려도 총 대기는 waitMs 를 크게 넘지 않는다 — 횟수로 세면 (간격+읽기) × 횟수만큼 걸렸다', async () => {
        const store = fakeStore({ tryLock: vi.fn().mockResolvedValue(false) });
        // 옛 구현: ceil(300 / 20) = 15번 × (20ms + 100ms) = 1800ms. 새 구현: 마감 300ms 에 읽기 하나가 잘려 ≈ 300ms.
        const p = params({ store, waitMs: 300, pollMs: 20, readCached: slowReads(100) });

        const startedAt = Date.now();
        await expect(refreshTokenWithLock(p)).resolves.toBe('issued');
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(900);
        expect(p.issueAndCache).toHaveBeenCalledTimes(1);
    });

    it('★영원히 끝나지 않는 읽기도 마감에서 잘리고 직접 발급으로 넘어간다', async () => {
        const store = fakeStore({ tryLock: vi.fn().mockResolvedValue(false) });
        const p = params({ store, waitMs: 120, pollMs: 20, readCached: vi.fn(() => new Promise<string | null>(() => undefined)) });

        const startedAt = Date.now();
        await expect(refreshTokenWithLock(p)).resolves.toBe('issued');

        expect(Date.now() - startedAt).toBeLessThan(800);
        expect(p.issueAndCache).toHaveBeenCalledTimes(1);
    });

    it('마감 안에 다른 프로세스가 넣은 토큰을 읽으면 그것을 쓴다', async () => {
        const store = fakeStore({ tryLock: vi.fn().mockResolvedValue(false) });
        let calls = 0;
        const readCached = vi.fn(async () => (++calls >= 3 ? 'from-peer' : null));
        const p = params({ store, waitMs: 500, pollMs: 10, readCached });

        await expect(refreshTokenWithLock(p)).resolves.toBe('from-peer');

        expect(p.issueAndCache).not.toHaveBeenCalled();
        expect(readCached).toHaveBeenCalledTimes(3);
    });

    it('마감 뒤에 늦게 실패하는 읽기가 처리 안 된 거부를 만들지 않는다', async () => {
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown): void => { rejections.push(reason); };
        process.on('unhandledRejection', onRejection);
        try {
            const store = fakeStore({ tryLock: vi.fn().mockResolvedValue(false) });
            const readCached = vi.fn(() => new Promise<string | null>((_resolve, reject) => setTimeout(() => reject(new Error('late')), 150)));
            await refreshTokenWithLock(params({ store, waitMs: 40, pollMs: 10, readCached }));
            await new Promise((resolve) => setTimeout(resolve, 250));
        } finally {
            process.off('unhandledRejection', onRejection);
        }
        expect(rejections).toEqual([]);
    });
});
