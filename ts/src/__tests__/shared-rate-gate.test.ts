/**
 * 호출 한도를 프로세스 사이에 나누는 선택 장치(`SharedRateGate`).
 *
 * 저장소는 진짜 Redis 가 아니라 `BrokerTokenStore` 의 연산(`tryLock`·`get`·`set`)만 흉내 낸 가짜다. 락은 TTL 이 지나면 사라진다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrokerTokenStore } from '../options';
import { SharedRateGate } from '../shared-rate-gate';

function memoryStore(overrides: Partial<BrokerTokenStore> = {}): BrokerTokenStore & { locks: Map<string, number>; values: Map<string, { value: string; expiresAt: number }> } {
    const locks = new Map<string, number>(); // 키 → 만료 시각
    const values = new Map<string, { value: string; expiresAt: number }>();
    return {
        locks,
        values,
        get: async (key) => {
            const entry = values.get(key);
            return entry !== undefined && entry.expiresAt > Date.now() ? entry.value : null;
        },
        set: async (key, value, ttlMs) => { values.set(key, { value, expiresAt: Date.now() + ttlMs }); },
        delete: async (key) => { values.delete(key); },
        deleteIfAccessTokenEquals: async () => false,
        tryLock: async (key, _owner, ttlMs) => {
            if ((locks.get(key) ?? 0) > Date.now()) return false;
            locks.set(key, Date.now() + ttlMs);
            return true;
        },
        unlock: async () => undefined,
        ...overrides,
    };
}

const gateOn = (store: BrokerTokenStore | null, prefix = 'rate:toss:acct-A:') => new SharedRateGate(() => store, prefix);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('SharedRateGate — 슬롯', () => {
    it('★같은 계정의 두 프로세스가 같은 버킷을 쓰면 한 간격에 요청 하나만 나간다', async () => {
        const store = memoryStore();
        const processA = gateOn(store);
        const processB = gateOn(store);
        const startedAt = Date.now();
        const passedAt: number[] = [];
        const pass = async (gate: SharedRateGate): Promise<void> => { await gate.acquire('order', 125); passedAt.push(Date.now() - startedAt); };

        const all = Promise.all([pass(processA), pass(processB), pass(processA), pass(processB), pass(processA)]);
        await vi.advanceTimersByTimeAsync(2_000);
        await all;

        passedAt.sort((a, b) => a - b);
        expect(passedAt).toHaveLength(5);
        for (let i = 1; i < passedAt.length; i++) expect(passedAt[i]! - passedAt[i - 1]!).toBeGreaterThanOrEqual(125);
    });

    it('다른 계정이나 다른 버킷은 서로 기다리지 않는다', async () => {
        const store = memoryStore();

        await gateOn(store, 'rate:toss:acct-A:').acquire('order', 125);
        const started = Date.now();
        await gateOn(store, 'rate:toss:acct-B:').acquire('order', 125); // 다른 계정
        await gateOn(store, 'rate:toss:acct-A:').acquire('stock', 125); // 같은 계정의 다른 버킷

        expect(Date.now() - started).toBe(0);
    });

    it('저장소가 없으면 기다리지 않는다 — 종전처럼 프로세스 메모리 한도만 쓴다', async () => {
        const started = Date.now();
        await gateOn(null).acquire('order', 125);
        await gateOn(null).acquire('order', 125);
        expect(Date.now() - started).toBe(0);
    });

    it('★저장소 명령이 실패하면 기다리지 않고 보내며, 한동안 저장소를 다시 부르지 않는다', async () => {
        const tryLock = vi.fn().mockRejectedValue(new Error('redis down'));
        const gate = gateOn(memoryStore({ tryLock }));

        await gate.acquire('order', 125);
        await gate.acquire('order', 125);
        await gate.acquire('order', 125);

        expect(tryLock).toHaveBeenCalledTimes(1); // 첫 실패 뒤 쿨다운 동안 저장소를 부르지 않는다
    });

    it('★저장소 명령이 끝나지 않으면 짧은 마감(250ms)에서 포기하고 보낸다 — Redis 명령 상한(10초)만큼 주문이 매달리지 않는다', async () => {
        const gate = gateOn(memoryStore({ tryLock: () => new Promise<boolean>(() => undefined) }));
        const startedAt = Date.now();

        const done = gate.acquire('order', 125).then(() => Date.now() - startedAt);
        await vi.advanceTimersByTimeAsync(300);

        expect(await done).toBe(250);
    });

    it('슬롯을 계속 못 얻어도 대기 상한(2초)을 넘기지 않는다', async () => {
        const gate = gateOn(memoryStore({ tryLock: async () => false }));
        const startedAt = Date.now();

        const done = gate.acquire('order', 125).then(() => Date.now() - startedAt);
        await vi.advanceTimersByTimeAsync(2_500);

        const waited = await done;
        expect(waited).toBeGreaterThanOrEqual(2_000);
        expect(waited).toBeLessThan(2_100);
    });

    it('간격이 0 이하면 저장소를 부르지 않는다', async () => {
        const tryLock = vi.fn();
        await gateOn(memoryStore({ tryLock })).acquire('order', 0);
        expect(tryLock).not.toHaveBeenCalled();
    });
});

describe('SharedRateGate — 429 휴식', () => {
    it('한 프로세스가 적은 휴식 시각을 다른 프로세스가 읽는다', async () => {
        const store = memoryStore();
        const until = Date.now() + 1_500;

        await gateOn(store).markBlocked('order', until);

        expect(await gateOn(store).blockedUntil('order')).toBe(until);
        expect(await gateOn(store).blockedUntil('stock')).toBe(0); // 다른 버킷은 쉬지 않는다
        expect(await gateOn(store, 'rate:toss:acct-B:').blockedUntil('order')).toBe(0); // 다른 계정도 쉬지 않는다
    });

    it('휴식이 끝나면 저장소의 값도 사라진다(TTL)', async () => {
        const store = memoryStore();
        await gateOn(store).markBlocked('order', Date.now() + 1_000);

        await vi.advanceTimersByTimeAsync(1_001);

        expect(await gateOn(store).blockedUntil('order')).toBe(0);
    });

    it('이미 지난 시각은 적지 않고, 저장소가 없거나 실패하면 0 이다', async () => {
        const set = vi.fn();
        await gateOn(memoryStore({ set })).markBlocked('order', Date.now() - 1);
        expect(set).not.toHaveBeenCalled();

        expect(await gateOn(null).blockedUntil('order')).toBe(0);
        const broken = gateOn(memoryStore({ get: vi.fn().mockRejectedValue(new Error('redis down')) }));
        expect(await broken.blockedUntil('order')).toBe(0);
        await expect(gateOn(memoryStore({ set: vi.fn().mockRejectedValue(new Error('redis down')) })).markBlocked('order', Date.now() + 1_000)).resolves.toBeUndefined();
    });
});
