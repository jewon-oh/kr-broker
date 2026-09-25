/**
 * @fileoverview `toss.editOrder` — `POST /orders/{orderId}/modify`. 국내는 가격·수량을 함께,
 * 미국은 가격만 정정한다. 정정하면 새 `orderId` 가 발급된다.
 */
import { describe, it, expect } from 'vitest';

import { ArgumentsRequired, NotSupported, OrderOutcomeUnknown } from '../../base';
import { errorReply, installFakeToss, jsonOk, makeToss, networkFailure, type FakeToss } from './support/toss-fake';

const modified = (fake: FakeToss, path: string): Record<string, unknown> => fake.requestsTo(`POST /api/v1/${path}`)[0]!.body as Record<string, unknown>;

/** 미국 정정 전에 읽는 주문 상세(`GET /orders/{orderId}`). */
const usOrder = (quantity: string, filledQuantity: string) => jsonOk({
    orderId: 'O1', symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', status: 'PARTIAL_FILLED', price: '228', quantity, execution: { filledQuantity },
});

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

    it('1억원 이상은 confirmHighValueOrder 를 켠다. 명목가는 amount × price 이고 주문 상세는 조회하지 않는다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 2000, 70000);

        expect(modified(fake, 'orders/O1/modify').confirmHighValueOrder).toBe(true);
        expect(fake.requestsTo('GET /api/v1/orders/O1')).toHaveLength(0);
    });
});

describe('editOrder — 해외', () => {
    it('지정가 — 가격만 정정한다(수량 필드 없음)', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': usOrder('3', '1'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        const order = await makeToss().editOrder('O1', 'AAPL/USD', 'limit', 'buy', undefined, 185.5);

        expect(modified(fake, 'orders/O1/modify')).toEqual({ orderType: 'LIMIT', price: '185.5' });
        expect(order).toMatchObject({ symbol: 'AAPL/USD', price: 185.5 });
    });

    it('정정 전에 주문 상세를 읽어 남은 수량 × 새 가격이 고액이면 confirmHighValueOrder 를 켠다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': usOrder('400', '50'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await makeToss().editOrder('O1', 'AAPL/USD', 'limit', 'buy', undefined, 229.5);

        expect(fake.requests().map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/orders/O1', 'POST /api/v1/orders/O1/modify']);
        expect(modified(fake, 'orders/O1/modify')).toEqual({ orderType: 'LIMIT', price: '229.5', confirmHighValueOrder: true });
    });

    it('체결된 수량은 빼고 본다: 남은 수량의 명목가가 기준 아래면 켜지 않는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': usOrder('400', '390'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await makeToss().editOrder('O1', 'AAPL/USD', 'limit', 'buy', undefined, 229.5);

        expect(modified(fake, 'orders/O1/modify').confirmHighValueOrder).toBeUndefined();
    });

    it('주문 조회가 실패하면 표시 없이 정정 요청을 한 번만 보낸다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': errorReply(500, 'internal-error'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        const order = await makeToss().editOrder('O1', 'AAPL/USD', 'limit', 'buy', undefined, 229.5);

        expect(order.id).toBe('O2');
        expect(fake.requestsTo('GET /api/v1/orders/O1')).toHaveLength(1);
        expect(fake.requestsTo('POST /api/v1/orders/O1/modify')).toHaveLength(1);
        expect(modified(fake, 'orders/O1/modify').confirmHighValueOrder).toBeUndefined();
    });

    it('정정 요청이 연결 오류로 끝나면 OrderOutcomeUnknown 이고 정정 요청을 다시 보내지 않는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': usOrder('400', '50'), 'POST /api/v1/orders/O1/modify': () => networkFailure('ECONNRESET') });

        await expect(makeToss({ options: { maxRetriesOnFailure: 3 } }).editOrder('O1', 'AAPL/USD', 'limit', 'buy', undefined, 229.5))
            .rejects.toBeInstanceOf(OrderOutcomeUnknown);
        expect(fake.requestsTo('GET /api/v1/orders/O1')).toHaveLength(1);
        expect(fake.requestsTo('POST /api/v1/orders/O1/modify')).toHaveLength(1);
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
