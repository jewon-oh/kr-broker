/**
 * @fileoverview `toss.editOrder(..., { trigger: true })` — 조건주문 정정. `POST /conditional-orders/{conditionalOrderId}/modify`.
 * 수정은 재설정이라 등록과 같은 필드(타입·수량·호가유형·만료일·감시조건 전체)를 다시 보낸다.
 */
import { describe, it, expect } from 'vitest';

import { ArgumentsRequired, OrderOutcomeUnknown } from '../../base';
import { OrderNotSent } from '../toss-errors';
import { errorReply, installFakeToss, jsonOk, makeToss, type FakeToss } from './support/toss-fake';

const expireDate = '2026-08-30';
const modifiedBody = (fake: FakeToss): Record<string, unknown> =>
    fake.requestsTo('POST /api/v1/conditional-orders/COND-1/modify')[0]!.body as Record<string, unknown>;

describe('editOrder — 조건주문 정정', () => {
    it('SINGLE — 조건 전체를 다시 보내고 새 conditionalOrderId 를 돌려준다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/conditional-orders/COND-1/modify': jsonOk({ conditionalOrderId: 'COND-2' }) });

        const order = await makeToss().editOrder('COND-1', '005930/KRW', 'market', 'sell', 10, undefined, { trigger: true, triggerPrice: 65000, expireDate });

        expect(order.id).toBe('COND-2');
        expect(order.triggerPrice).toBe(65000);
        expect(modifiedBody(fake)).toMatchObject({ type: 'SINGLE', orderType: 'MARKET', quantity: '10', expireDate });
        expect(modifiedBody(fake).first).toEqual({ orderSide: 'SELL', triggerPrice: '65000' });
        // symbol 은 conditionalOrderId 로 식별되니 본문에 없다.
        expect(modifiedBody(fake).symbol).toBeUndefined();
    });

    it('OCO — 지정가·second leg 를 그대로 옮긴다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/conditional-orders/COND-1/modify': jsonOk({ conditionalOrderId: 'COND-3' }) });

        await makeToss().editOrder('COND-1', '005930/KRW', 'limit', 'sell', 10, 79900, {
            trigger: true, triggerPrice: 80000, conditionalType: 'OCO', expireDate,
            second: { side: 'sell', triggerPrice: 65000, price: 64900 },
        });

        const body = modifiedBody(fake);
        expect(body).toMatchObject({ type: 'OCO', orderType: 'LIMIT', quantity: '10' });
        expect(body.first).toEqual({ orderSide: 'SELL', triggerPrice: '80000', orderPrice: '79900' });
        expect(body.second).toEqual({ orderSide: 'SELL', triggerPrice: '65000', orderPrice: '64900' });
    });

    it('amount 가 없으면 요청 전에 ArgumentsRequired', async () => {
        const fake = installFakeToss({});

        await expect(makeToss().editOrder('COND-1', '005930/KRW', 'market', 'sell', undefined, undefined, { trigger: true, triggerPrice: 65000, expireDate }))
            .rejects.toBeInstanceOf(ArgumentsRequired);
        expect(fake.requests()).toHaveLength(0);
    });

    it('expireDate 가 없으면 요청 전에 던진다(등록과 같은 검사를 재사용한다)', async () => {
        const fake = installFakeToss({});

        await expect(makeToss().editOrder('COND-1', '005930/KRW', 'market', 'sell', 10, undefined, { trigger: true, triggerPrice: 65000 }))
            .rejects.toThrow(/expireDate/);
        expect(fake.requests()).toHaveLength(0);
    });

    it('★둘째 조건의 triggerPrice 가 없으면 요청 전에 ArgumentsRequired', async () => {
        const fake = installFakeToss({});

        await expect(makeToss().editOrder('COND-1', '005930/KRW', 'limit', 'sell', 10, 79900, {
            trigger: true, triggerPrice: 80000, conditionalType: 'OCO', expireDate, second: { side: 'sell', price: 64900 },
        })).rejects.toBeInstanceOf(ArgumentsRequired);
        expect(fake.requests()).toHaveLength(0);
    });

    it('OCO 인데 second 가 없으면 OrderNotSent', async () => {
        const fake = installFakeToss({});

        await expect(makeToss().editOrder('COND-1', '005930/KRW', 'limit', 'sell', 10, 79900, {
            trigger: true, triggerPrice: 80000, conditionalType: 'OCO', expireDate,
        })).rejects.toBeInstanceOf(OrderNotSent);
        expect(fake.requests()).toHaveLength(0);
    });

    it('1억원 이상은 confirmHighValueOrder 를 켠다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/conditional-orders/COND-1/modify': jsonOk({ conditionalOrderId: 'COND-4' }) });

        await makeToss().editOrder('COND-1', '005930/KRW', 'limit', 'sell', 2000, 70000, { trigger: true, triggerPrice: 71000, expireDate });

        expect(modifiedBody(fake).confirmHighValueOrder).toBe(true);
    });

    it('응답에 conditionalOrderId 가 없으면 OrderOutcomeUnknown', async () => {
        installFakeToss({ 'POST /api/v1/conditional-orders/COND-1/modify': jsonOk({}) });

        await expect(makeToss().editOrder('COND-1', '005930/KRW', 'market', 'sell', 10, undefined, { trigger: true, triggerPrice: 65000, expireDate }))
            .rejects.toBeInstanceOf(OrderOutcomeUnknown);
    });

    it('brokerage 거절(reason 코드)은 그대로 전달된다', async () => {
        installFakeToss({ 'POST /api/v1/conditional-orders/COND-1/modify': errorReply(400, 'invalid-request') });

        await expect(makeToss().editOrder('COND-1', '005930/KRW', 'market', 'sell', 10, undefined, { trigger: true, triggerPrice: 65000, expireDate }))
            .rejects.toThrow();
    });
});
