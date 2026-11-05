/**
 * 토스 주문이 401 을 받으면 토큰을 무효화하고 한 번 다시 보낸다. 그 무효화·재발급이 토큰 저장소 장애로 길어져도 주문이 뒤늦게 나가면 안 된다.
 * 첫 시도와 재시도는 한 토큰 준비 마감을 나눠 쓰고, 넘으면 두 번째 주문 요청은 나가지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../toss-trading-hours', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../toss-trading-hours')>()),
    isTossOrderable: () => true,
}));

import { OrderTokenNotReady } from '../../base';
import type { BrokerTokenStore } from '../../options';
import { errorReply, installFakeToss, jsonOk, makeToss } from './support/toss-fake';

/** 저장소 쓰기는 되고, 토큰 비교 삭제(401 뒤 무효화)는 끝나지 않는 저장소. */
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

beforeEach(() => { vi.restoreAllMocks(); });

describe('토스 주문의 401 재시도와 토큰 준비 마감', () => {
    it('★401 뒤의 토큰 무효화가 마감을 넘기면 두 번째 주문 요청을 보내지 않는다', async () => {
        const fake = installFakeToss({
            'POST /api/v1/orders': errorReply(401, 'token-revoked', '이전 토큰이 무효화되었다'),
        });
        const broker = makeToss({ orderTokenDeadline: 60, options: { tokenStore: storeWithStuckInvalidation() } });

        const error = await broker.createOrder('005930/KRW', 'limit', 'buy', 1, 70000, { confirmExecution: false }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(OrderTokenNotReady);
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(1); // 첫 시도만 나갔다
    });

    it('무효화가 마감 안에 끝나면 종전대로 한 번 다시 보낸다', async () => {
        let posts = 0;
        const fake = installFakeToss({
            'POST /api/v1/orders': () => (++posts === 1 ? errorReply(401, 'token-revoked', '이전 토큰이 무효화되었다') : jsonOk({ orderId: 'OID-2' })),
        });

        const order = await makeToss({ orderTokenDeadline: 5_000 }).createOrder('005930/KRW', 'limit', 'buy', 1, 70000, { confirmExecution: false });

        expect(order.id).toBe('OID-2');
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(2);
    });
});
