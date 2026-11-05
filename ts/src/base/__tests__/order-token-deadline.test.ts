/**
 * 주문 요청 앞의 토큰 준비에는 마감이 있다. 마감을 넘기면 주문을 보내지 않고 `OrderTokenNotReady` 로 끝낸다(결과 불명이 아니다).
 *
 * 배경: 토큰 저장소 장애와 토큰 만료가 겹치면 토큰 준비가 몇 분 걸리고, 그 뒤에 주문이 나갔다. 호출한 쪽은 이미 포기한 뒤다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrderOutcomeUnknown, OrderTokenNotReady, RequestTimeout } from '../errors';
import { ORDER_TOKEN_READY_DEADLINE_MS } from '../Exchange';
import { FakeExchange, json, stubFetch } from './support/fake-exchange';

const CREDENTIALS = { apiKey: 'key', secret: 'secret', uid: '12345678-01' };

/** `authenticate` 가 `ms` 뒤에 끝나는 가짜 증권사. `ms` 가 `Infinity` 면 끝나지 않는다. */
class SlowTokenExchange extends FakeExchange {
    constructor(private readonly tokenMs: number, config: Record<string, unknown> = CREDENTIALS) {
        super(config);
    }

    override async authenticate(): Promise<void> {
        this.calls.push('authenticate');
        if (Number.isFinite(this.tokenMs)) await new Promise((resolve) => setTimeout(resolve, this.tokenMs));
        else await new Promise(() => undefined);
        this.token = 'issued-token';
    }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('주문 앞의 토큰 준비 마감', () => {
    it('★마감 안에 준비되지 않으면 주문 요청을 보내지 않고 OrderTokenNotReady 로 끝낸다', async () => {
        const { impl } = stubFetch(json({ id: 'O1' }));
        const ex = new SlowTokenExchange(Infinity);

        const result = ex.privatePostOrders({ code: '005930' }).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(ORDER_TOKEN_READY_DEADLINE_MS + 1);
        const error = await result;

        expect(error).toBeInstanceOf(OrderTokenNotReady);
        expect(impl).not.toHaveBeenCalled(); // 요청이 나가지 않았다
        expect(ex.calls).not.toContain('sign');
    });

    it('이 오류는 결과 불명이 아니다 — OrderOutcomeUnknown·RequestTimeout 이 아니고 다시 내도 되는 오류다', async () => {
        stubFetch(json({}));
        const ex = new SlowTokenExchange(Infinity);

        const result = ex.privatePostOrders({}).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(ORDER_TOKEN_READY_DEADLINE_MS + 1);
        const error = await result as OrderTokenNotReady;

        expect(error).not.toBeInstanceOf(OrderOutcomeUnknown);
        expect(error).not.toBeInstanceOf(RequestTimeout);
        expect(error.retryable).toBe(true);
        expect(error.detail).toBe('order-token-not-ready');
        expect(error.name).toBe('OrderTokenNotReady');
    });

    it('마감 안에 준비되면 그대로 보낸다', async () => {
        const { impl } = stubFetch(json({ id: 'O1' }));
        const ex = new SlowTokenExchange(ORDER_TOKEN_READY_DEADLINE_MS - 1_000);

        const result = ex.privatePostOrders({ code: '005930' });
        await vi.advanceTimersByTimeAsync(ORDER_TOKEN_READY_DEADLINE_MS - 1_000);

        await expect(result).resolves.toEqual({ id: 'O1' });
        expect(impl).toHaveBeenCalledTimes(1);
    });

    it('마감은 인스턴스마다 바꿀 수 있다(orderTokenDeadline)', async () => {
        const { impl } = stubFetch(json({}));
        const ex = new SlowTokenExchange(Infinity, { ...CREDENTIALS, orderTokenDeadline: 2_000 });

        const result = ex.privatePostOrders({}).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(2_001);

        expect(await result).toBeInstanceOf(OrderTokenNotReady);
        expect(impl).not.toHaveBeenCalled();
    });

    it('밀린 토큰 준비가 나중에 실패해도 처리 안 된 거부를 만들지 않는다', async () => {
        stubFetch(json({}));
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown): void => { rejections.push(reason); };
        process.on('unhandledRejection', onRejection);
        try {
            class LateFailure extends FakeExchange {
                override async authenticate(): Promise<void> {
                    await new Promise((resolve) => setTimeout(resolve, ORDER_TOKEN_READY_DEADLINE_MS + 5_000));
                    throw new Error('late token failure');
                }
            }
            const result = new LateFailure(CREDENTIALS).privatePostOrders({}).catch((e: unknown) => e);
            await vi.advanceTimersByTimeAsync(ORDER_TOKEN_READY_DEADLINE_MS + 10_000);
            expect(await result).toBeInstanceOf(OrderTokenNotReady);
            await vi.advanceTimersByTimeAsync(0);
        } finally {
            process.off('unhandledRejection', onRejection);
        }
        expect(rejections).toEqual([]);
    });

    it('조회(주문이 아닌 비공개 호출)에는 마감을 걸지 않는다 — 기다렸다가 정상 응답을 받는다', async () => {
        const { impl } = stubFetch(json({ accounts: [] }));
        const ex = new SlowTokenExchange(ORDER_TOKEN_READY_DEADLINE_MS + 20_000);

        const result = ex.privateGetAccounts();
        await vi.advanceTimersByTimeAsync(ORDER_TOKEN_READY_DEADLINE_MS + 20_000);

        await expect(result).resolves.toEqual({ accounts: [] });
        expect(impl).toHaveBeenCalledTimes(1);
    });
});
