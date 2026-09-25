/**
 * @fileoverview `toss.editOrder` — `POST /orders/{orderId}/modify`. 잔량 전부를 새 가격으로 옮긴다. 국내는 주문 상세로 읽은 잔량을 수량으로
 * 싣고, 미국은 가격만 정정한다. `amount` 는 정정 뒤 총수량이다. 정정하면 새 `orderId` 가 발급된다.
 */
import { describe, it, expect } from 'vitest';

import { ArgumentsRequired, NotSupported, OrderOutcomeUnknown } from '../../base';
import { errorReply, installFakeToss, jsonOk, makeToss, networkFailure, type FakeToss } from './support/toss-fake';

const modified = (fake: FakeToss, path: string): Record<string, unknown> => fake.requestsTo(`POST /api/v1/${path}`)[0]!.body as Record<string, unknown>;

/** 국내 정정 전에 읽는 주문 상세(`GET /orders/{orderId}`). */
const krOrder = (quantity: string, filledQuantity: string) => jsonOk({
    orderId: 'O1', symbol: '005930', side: 'BUY', orderType: 'LIMIT', status: 'PENDING', price: '70000', quantity, execution: { filledQuantity },
});

/** 미국 정정 전에 읽는 주문 상세(`GET /orders/{orderId}`). */
const usOrder = (quantity: string, filledQuantity: string) => jsonOk({
    orderId: 'O1', symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', status: 'PARTIAL_FILLED', price: '228', quantity, execution: { filledQuantity },
});

describe('editOrder — 국내', () => {
    it('지정가 — 주문 상세의 잔량을 수량으로 싣고 가격을 정정해 새 orderId 를 돌려준다. amount 는 정정 뒤 총수량이다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': krOrder('3', '0'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        const order = await makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 3, 71000);

        expect(fake.requests().map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/orders/O1', 'POST /api/v1/orders/O1/modify']);
        expect(modified(fake, 'orders/O1/modify')).toEqual({ orderType: 'LIMIT', quantity: '3', price: '71000' });
        expect(order).toMatchObject({ id: 'O2', symbol: '005930/KRW', side: 'buy', amount: 3, price: 71000, status: 'open' });
    });

    it('시장가 — 수량만 보내고 가격은 싣지 않는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': krOrder('3', '0'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await makeToss().editOrder('O1', '005930/KRW', 'market', 'buy', 3);

        const body = modified(fake, 'orders/O1/modify');
        expect(body.orderType).toBe('MARKET');
        expect(body.quantity).toBe('3');
        expect(body.price).toBeUndefined();
    });

    it('amount 가 없으면 주문 상세의 잔량 전부를 정정하고, 확인한 총수량을 돌려준다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': krOrder('3', '0'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        const order = await makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', undefined, 71000);

        expect(modified(fake, 'orders/O1/modify')).toEqual({ orderType: 'LIMIT', quantity: '3', price: '71000' });
        expect(order.amount).toBe(3);
    });

    it('★amount 가 총수량과 다르면(수량을 바꾸는 정정) 정정 요청 없이 NotSupported 다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': krOrder('3', '0'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await expect(makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 2, 71000)).rejects.toThrow(NotSupported);
        expect(fake.requestsTo('POST /api/v1/orders/O1/modify')).toHaveLength(0);
    });

    it('★일부 체결된 주문은 quantity 의 뜻을 확인하기 전까지 정정 요청 없이 NotSupported 다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': krOrder('3', '1'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await expect(makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 3, 71000)).rejects.toThrow(NotSupported);
        expect(fake.requestsTo('POST /api/v1/orders/O1/modify')).toHaveLength(0);
    });

    it('주문 상세 조회가 실패하면 정정 요청 없이 던진다. 추정한 잔량으로 정정하지 않는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': errorReply(500, 'internal-error'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await expect(makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 3, 71000)).rejects.toThrow();
        expect(fake.requestsTo('POST /api/v1/orders/O1/modify')).toHaveLength(0);
    });

    it('params.partial(일부정정)은 요청 없이 NotSupported 다', async () => {
        const fake = installFakeToss({});

        await expect(makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 1, 71000, { partial: true })).rejects.toThrow(NotSupported);
        expect(fake.requests()).toHaveLength(0);
    });

    it('1억원 이상은 confirmHighValueOrder 를 켠다. 명목가는 잔량 × price 다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': krOrder('2000', '0'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', undefined, 70000);

        expect(modified(fake, 'orders/O1/modify').confirmHighValueOrder).toBe(true);
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

    it('amount 가 총수량(체결 + 잔량)과 같으면 가격만 정정하고 그 총수량을 돌려준다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': usOrder('3', '1'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        const order = await makeToss().editOrder('O1', 'AAPL/USD', 'limit', 'buy', 3, 185.5);

        expect(modified(fake, 'orders/O1/modify')).toEqual({ orderType: 'LIMIT', price: '185.5' });
        expect(order.amount).toBe(3);
    });

    it('★amount 가 총수량과 다르면 주문 상세를 확인한 뒤 정정 요청 없이 NotSupported 다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': usOrder('3', '1'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await expect(makeToss().editOrder('O1', 'AAPL/USD', 'limit', 'buy', 1, 185.5)).rejects.toThrow(NotSupported);
        expect(fake.requestsTo('POST /api/v1/orders/O1/modify')).toHaveLength(0);
    });

    it('amount 를 줬는데 주문 상세 조회가 실패하면 대조할 수 없어 정정 요청 없이 던진다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders/O1': errorReply(500, 'internal-error'), 'POST /api/v1/orders/O1/modify': jsonOk({ orderId: 'O2' }) });

        await expect(makeToss().editOrder('O1', 'AAPL/USD', 'limit', 'buy', 3, 185.5)).rejects.toThrow();
        expect(fake.requestsTo('POST /api/v1/orders/O1/modify')).toHaveLength(0);
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
        installFakeToss({ 'GET /api/v1/orders/O1': krOrder('3', '0'), 'POST /api/v1/orders/O1/modify': jsonOk({}) });

        await expect(makeToss().editOrder('O1', '005930/KRW', 'limit', 'buy', 3, 71000)).rejects.toThrow(OrderOutcomeUnknown);
    });
});
