/**
 * @fileoverview `toss.editOrder` — `POST /orders/{orderId}/modify`. 국내는 가격·수량을 함께,
 * 미국은 가격만 정정한다. 정정하면 새 `orderId` 가 발급된다.
 */
import { describe, it, expect } from 'vitest';

import { ArgumentsRequired, NotSupported, OrderOutcomeUnknown } from '../../base';
import { installFakeToss, jsonOk, makeToss, type FakeToss } from './support/toss-fake';

const modified = (fake: FakeToss, path: string): Record<string, unknown> => fake.requestsTo(`POST /api/v1/${path}`)[0].body as Record<string, unknown>;

describe('editOrder — 국내', () => {
    it('지정가 — 가격·수량을 함께 정정하고 새 orderId 를 돌려준다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        const order = await makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 3, 71000);

        expect(modified(fake, 'orders/O1/modify')).toEqual({ orderType: 'LIMIT', quantity: '3', price: '71000' });
        expect(order).toMatchObject({ id: 'O2', symbol: '005930/KRW', side: 'buy', amount: 3, price: 71000, status: 'open' });
    });

    it('시장가 — 수량만 보내고 가격은 싣지 않는다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await makeToss().editOrder('O1', '005930/KRW', 'market', 'buy', 3);

        const body = modified(fake, 'orders/O1/modify');
        expect(body.orderType).toBe('MARKET');
        expect(body.quantity).toBe('3');
        expect(body.price).toBeUndefined();
    });

    it('amount 가 없으면 요청 전에 ArgumentsRequired', async () => {
        const fake = installFakeToss({});

        await expect(makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', undefined, 71000)).rejects.toThrow(ArgumentsRequired);
        expect(fake.requests()).toHaveLength(0);
    });

    it('1억원 이상은 confirmHighValueOrder 를 켠다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 2000, 70000);

        expect(modified(fake, 'orders/O1/modify').confirmHighValueOrder).toBe(true);
    });
});

describe('editOrder — 해외', () => {
    it('지정가 — 가격만 정정한다(수량 필드 없음)', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        const order = await makeToss().editOrder('O1', 'AAPL/USD', 'limit', 'buy', undefined, 185.5);

        expect(modified(fake, 'orders/O1/modify')).toEqual({ orderType: 'LIMIT', price: '185.5' });
        expect(order).toMatchObject({ symbol: 'AAPL/USD', price: 185.5 });
    });

    it('amount 를 주면 NotSupported(가격만 가능)', async () => {
        const fake = installFakeToss({});

        await expect(makeToss().editOrder('O1', 'AAPL/USD', 'limit', 'buy', 1, 185.5)).rejects.toThrow(NotSupported);
        expect(fake.requests()).toHaveLength(0);
    });
});

describe('editOrder — 공통', () => {
    it('지정가에 가격이 없으면 ArgumentsRequired', async () => {
        const fake = installFakeToss({});

        await expect(makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 3)).rejects.toThrow(ArgumentsRequired);
        expect(fake.requests()).toHaveLength(0);
    });

    // 조건주문 정정(trigger:true)은 `toss-modify-conditional-order.test.ts`에서 다룬다.

    it('응답에 orderId 가 없으면 OrderOutcomeUnknown', async () => {
        installFakeToss({ 'POST /api/v1/orders/O1/modify': jsonOk({}) });

        await expect(makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 3, 71000)).rejects.toThrow(OrderOutcomeUnknown);
    });
});
