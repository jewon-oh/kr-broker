/**
 * 같은 계정을 여러 프로세스가 쓰면 호출 한도(스로틀과 429 휴식)가 프로세스마다 따로 세어져 합이 한도를 넘는다.
 * `options.sharedRateLimit` 을 켜고 `options.tokenStore` 가 있으면 주문 그룹(`order`)의 슬롯과 429 휴식을 같은 계정의 프로세스끼리 나눈다.
 * 기본(꺼짐)이나 저장소가 없을 때는 종전처럼 프로세스 메모리로 센다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../toss-trading-hours', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../toss-trading-hours')>()),
    isTossOrderable: () => true,
}));

import { RateLimitExceeded } from '../../base';
import type { BrokerTokenStore } from '../../options';
import { installFakeToss, jsonOk, makeToss, type FakeReply } from './support/toss-fake';

const SLOT_MS = 125; // 주문 그룹의 간격(`rateLimitBuckets.order`)

/** TTL 이 있는 락과 값을 가진 공유 저장소(두 프로세스가 같은 것을 본다). 토큰은 저장소에 없어 각자 발급한다. */
function sharedStore(): BrokerTokenStore & { calls: string[] } {
    const locks = new Map<string, number>();
    const values = new Map<string, { value: string; expiresAt: number }>();
    const calls: string[] = [];
    return {
        calls,
        get: async (key) => { calls.push(`get ${key}`); const e = values.get(key); return e !== undefined && e.expiresAt > Date.now() ? e.value : null; },
        set: async (key, value, ttlMs) => { calls.push(`set ${key}`); values.set(key, { value, expiresAt: Date.now() + ttlMs }); },
        delete: async (key) => { values.delete(key); },
        deleteIfAccessTokenEquals: async () => false,
        tryLock: async (key, _owner, ttlMs) => {
            calls.push(`tryLock ${key}`);
            // 토큰 발급 락은 늘 잡게 둔다. 슬롯 락만 TTL 로 겨룬다.
            if (!key.includes(':rate:') && !key.startsWith('rate:')) return true;
            if ((locks.get(key) ?? 0) > Date.now()) return false;
            locks.set(key, Date.now() + ttlMs);
            return true;
        },
        unlock: async () => undefined,
    };
}

/** 대기 없이 도는 토스 인스턴스. 주문 그룹만 간격을 두고 나머지 그룹과 계정 전체 간격은 0 이다. */
function processOf(store: BrokerTokenStore, options: Record<string, unknown>, slotMs = SLOT_MS) {
    return makeToss({
        enableRateLimit: true,
        rateLimit: 0,
        rateLimitBuckets: { order: { rateLimit: slotMs }, market_info: { rateLimit: 0 }, auth: { rateLimit: 0 }, order_history: { rateLimit: 0 }, account: { rateLimit: 0 } },
        options: { tokenStore: store, ...options },
    });
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

const order = (broker: ReturnType<typeof processOf>) => broker.createOrder('005930/KRW', 'limit', 'buy', 1, 70000, { confirmExecution: false });

/** 주문 요청이 서버에 닿은 시각을 모으는 가짜 서버. */
function orderServer(reply: (n: number) => FakeReply = () => jsonOk({ orderId: 'OID-1' })) {
    const arrivals: number[] = [];
    let n = 0;
    installFakeToss({ 'POST /api/v1/orders': () => { arrivals.push(Date.now()); return reply(++n); } });
    return arrivals;
}

describe('options.sharedRateLimit — 주문 그룹의 슬롯을 같은 계정의 프로세스끼리 나눈다', () => {
    it('★켜면 두 프로세스의 주문이 합쳐서 한 간격에 하나씩만 서버에 닿는다', async () => {
        // 프로세스 안의 간격 조절기(`Throttler`)는 단조 시계를 읽어 가짜 타이머로는 돌지 않는다. 이 테스트만 진짜 타이머로 짧은 간격을 쓴다.
        vi.useRealTimers();
        const slot = 80;
        const store = sharedStore();
        const arrivals = orderServer();
        const a = processOf(store, { sharedRateLimit: true }, slot);
        const b = processOf(store, { sharedRateLimit: true }, slot);

        await Promise.all([order(a), order(b), order(a), order(b), order(a), order(b)]);

        arrivals.sort((x, y) => x - y);
        expect(arrivals).toHaveLength(6);
        // 타이머 오차를 감안해 간격의 90% 를 하한으로 본다. 나누지 않으면 두 프로세스의 첫 주문이 같은 시각에 닿는다.
        for (let i = 1; i < arrivals.length; i++) expect(arrivals[i]! - arrivals[i - 1]!).toBeGreaterThanOrEqual(slot * 0.9);
    });

    it('★기본(꺼짐)은 프로세스마다 따로 세서 두 프로세스의 첫 주문이 동시에 닿는다 — 종전 동작', async () => {
        const store = sharedStore();
        const arrivals = orderServer();
        const a = processOf(store, {});
        const b = processOf(store, {});

        const all = Promise.all([order(a), order(b)]);
        await vi.advanceTimersByTimeAsync(1_000);
        await all;

        expect(Math.abs(arrivals[1]! - arrivals[0]!)).toBeLessThan(SLOT_MS);
        expect(store.calls.some((call) => call.includes('rate:'))).toBe(false); // 저장소에 한도 키를 쓰지 않았다
    });

    it('토큰 저장소가 없으면 켜도 나누지 않는다 — 프로세스 메모리로 동작한다', async () => {
        orderServer();
        const broker = makeToss({
            enableRateLimit: true, rateLimit: 0,
            rateLimitBuckets: { order: { rateLimit: SLOT_MS }, market_info: { rateLimit: 0 }, auth: { rateLimit: 0 } },
            options: { sharedRateLimit: true },
        });

        const done = order(broker);
        await vi.advanceTimersByTimeAsync(500);

        await expect(done).resolves.toBeDefined();
    });

    it('나누는 그룹은 지정한 것뿐이다 — 문자열 배열로 고르고, 나머지 그룹은 저장소를 쓰지 않는다', async () => {
        const store = sharedStore();
        orderServer();
        const broker = processOf(store, { sharedRateLimit: ['stock'] });

        const done = order(broker);
        await vi.advanceTimersByTimeAsync(500);
        await done;

        expect(store.calls.some((call) => call.includes('rate:toss:') && call.includes(':order:'))).toBe(false);
    });

    it('★저장소가 끝나지 않아도 주문은 250ms 안에 나간다 — 한도 공유가 주문을 저장소 장애에 묶지 않는다', async () => {
        const stuck: BrokerTokenStore = { ...sharedStore(), tryLock: (key) => (key.includes('rate:') ? new Promise<boolean>(() => undefined) : Promise.resolve(true)) };
        const arrivals = orderServer();
        const broker = processOf(stuck, { sharedRateLimit: true });
        const startedAt = Date.now();

        const done = order(broker);
        await vi.advanceTimersByTimeAsync(600);
        await done;

        expect(arrivals).toHaveLength(1);
        expect(arrivals[0]! - startedAt).toBeLessThanOrEqual(300);
    });
});

describe('options.sharedRateLimit — 429 휴식을 같은 계정의 프로세스끼리 나눈다', () => {
    const limited = (): FakeReply => ({ status: 429, body: { error: { code: 'rate-limit-exceeded' } }, headers: { 'Retry-After': '2' } });

    it('★한 프로세스가 주문 429 를 받으면 다른 프로세스도 쉬라고 한 시간이 지나기 전에는 주문을 보내지 않는다', async () => {
        const store = sharedStore();
        const arrivals = orderServer((n) => (n === 1 ? limited() : jsonOk({ orderId: 'OID-2' })));
        const a = processOf(store, { sharedRateLimit: true });
        const b = processOf(store, { sharedRateLimit: true });

        const firstFailed = order(a).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(10);
        expect(await firstFailed).toBeInstanceOf(RateLimitExceeded);
        const rejectedAt = arrivals[0]!;

        const next = order(b); // 다른 프로세스, 같은 계정
        await vi.advanceTimersByTimeAsync(1_900);
        expect(arrivals).toHaveLength(1); // 아직 쉬는 중이라 보내지 않았다
        await vi.advanceTimersByTimeAsync(400);
        await next;

        expect(arrivals).toHaveLength(2);
        expect(arrivals[1]! - rejectedAt).toBeGreaterThanOrEqual(2_000);
    });

    it('★기본(꺼짐)은 429 를 받은 프로세스만 쉬고 다른 프로세스는 바로 보낸다 — 종전 동작', async () => {
        const store = sharedStore();
        const arrivals = orderServer((n) => (n === 1 ? limited() : jsonOk({ orderId: 'OID-2' })));
        const a = processOf(store, {});
        const b = processOf(store, {});

        const firstFailed = order(a).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(10);
        await firstFailed;
        const next = order(b);
        await vi.advanceTimersByTimeAsync(10);
        await next;

        expect(arrivals).toHaveLength(2);
        expect(arrivals[1]! - arrivals[0]!).toBeLessThan(500);
    });
});
