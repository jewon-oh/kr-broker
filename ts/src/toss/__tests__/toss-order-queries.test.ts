/**
 * @fileoverview 주문 조회와 취소: 미체결, 체결 완료, 체결 내역, 단건 조회, 취소, 전체 취소, 조건주문 장부.
 */

import { describe, expect, it } from 'vitest';

import { MarketClosed, NetworkError, OrderNotFound } from '../../base';
import { errorReply, installFakeToss, jsonOk, makeToss, type FakeRequest, type Route } from './support/toss-fake';

const order = (id: string, symbol: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    orderId: id, symbol, side: 'BUY', orderType: 'LIMIT', status: 'PENDING', quantity: '5', price: '70000',
    orderedAt: '2026-07-16T01:00:00Z', execution: { filledQuantity: '0' }, ...extra,
});

describe('미체결 주문', () => {
    it('status=OPEN 으로 받고 체결·시각·상태를 통합 구조로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': jsonOk({
                orders: [order('O1', '005930', { side: 'SELL', status: 'PARTIAL_FILLED', execution: { filledQuantity: '2', averageFilledPrice: '70000', filledAt: '2026-07-16T01:00:03Z' } })],
                hasNext: false, nextCursor: null,
            }),
        });
        const orders = await makeToss().fetchOpenOrders();
        expect(orders).toHaveLength(1);
        expect(orders[0]).toMatchObject({ id: 'O1', symbol: '005930/KRW', side: 'sell', type: 'limit', status: 'open', amount: 5, filled: 2, remaining: 3, price: 70000, average: 70000 });
        expect(orders[0].timestamp).toBe(Date.parse('2026-07-16T01:00:00Z'));
        expect(fake.requestsTo('GET /api/v1/orders')[0].query.get('status')).toBe('OPEN');
        expect(fake.requestsTo('GET /api/v1/orders')[0].query.has('symbol')).toBe(false);
    });

    it('종목을 주면 서버 조회에 symbol 을 넣고, 응답에 섞인 다른 종목은 거른다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [order('O1', '005930'), order('O2', '000660')] }),
        });
        const orders = await makeToss().fetchOpenOrders('005930/KRW');
        expect(fake.requestsTo('GET /api/v1/orders')[0].query.get('symbol')).toBe('005930');
        expect(orders.map((o) => o.id)).toEqual(['O1']);
    });

    it('조회에 실패하면 빈 목록이 아니라 던진다', async () => {
        installFakeToss({ 'GET /api/v1/orders': errorReply(500, 'internal-error') });
        await expect(makeToss().fetchOpenOrders()).rejects.toThrow('토스 API 오류: 500');
    });

    describe('조건주문 장부', () => {
        const stop = { conditionalOrderId: 'C-1', symbol: '005930', type: 'OCO', quantity: '10', first: { orderSide: 'SELL', triggerPrice: '80000', orderPrice: '79900' } };

        it('includeTrigger 는 일반 주문과 조건주문을 합친다', async () => {
            installFakeToss({
                'GET /api/v1/orders': jsonOk({ orders: [order('O-1', '005930', { quantity: '5' })] }),
                'GET /api/v1/conditional-orders': jsonOk({ conditionalOrders: [stop] }),
            });
            const orders = await makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true });
            expect(orders).toHaveLength(2);
            const conditional = orders.find((o) => o.id === 'C-1')!;
            expect(conditional).toMatchObject({ side: 'sell', triggerPrice: 80000, price: 79900, status: 'open', amount: 10 });
            expect((conditional.info as { type: string }).type).toBe('OCO');
        });

        it('trigger 는 조건주문만 받는다', async () => {
            const fake = installFakeToss({ 'GET /api/v1/conditional-orders': jsonOk({ conditionalOrders: [stop] }) });
            const orders = await makeToss().fetchOpenOrders(undefined, undefined, undefined, { trigger: true });
            expect(orders.map((o) => o.id)).toEqual(['C-1']);
            expect(fake.requestsTo('GET /api/v1/orders')).toHaveLength(0);
        });

        it('조건주문 장부만 실패해도 일반 주문만 돌려주지 않고 던진다(불완전한 답이다)', async () => {
            installFakeToss({
                'GET /api/v1/orders': jsonOk({ orders: [] }),
                'GET /api/v1/conditional-orders': errorReply(500, 'internal-error'),
            });
            await expect(makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true })).rejects.toThrow('토스 API 오류: 500');
        });

        it('일반 주문 조회가 토큰 오류로 계속 실패하면 던진다. 스톱 없음으로 위장하지 않는다', async () => {
            installFakeToss({
                'GET /api/v1/orders': errorReply(401, 'token-revoked'),
                'GET /api/v1/conditional-orders': jsonOk({ conditionalOrders: [stop] }),
            });
            await expect(makeToss().fetchOpenOrders('005930', undefined, undefined, { includeTrigger: true })).rejects.toThrow('토스 API 오류: 401');
        });

        it('leg 에 orderSide 키가 없어도 값으로 방향을 찾는다', async () => {
            installFakeToss({
                'GET /api/v1/orders': jsonOk({ orders: [] }),
                'GET /api/v1/conditional-orders': jsonOk({
                    conditionalOrders: [{ conditionalOrderId: 'C-9', symbol: '051910', type: 'SINGLE', quantity: '4', createdAt: '2026-01-17T08:46:17Z', first: { tradeType: 'SELL', triggerPrice: '110000', status: 'HOLDING' } }],
                }),
            });
            const [conditional] = await makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true });
            expect(conditional.side).toBe('sell');
            expect(conditional.triggerPrice).toBe(110000);
        });

        it('leg 이 오면 상세를 부르지 않는다. leg 자체가 없을 때만 상세로 채운다', async () => {
            const fake = installFakeToss({
                'GET /api/v1/orders': jsonOk({ orders: [] }),
                'GET /api/v1/conditional-orders': jsonOk({
                    conditionalOrders: [
                        { conditionalOrderId: 'C-6', symbol: '005930', type: 'SINGLE', quantity: '2', first: { triggerPrice: '70000' } },
                        { conditionalOrderId: 'C-5', symbol: '005930', type: 'SINGLE', quantity: '3' },
                    ],
                }),
                'GET /api/v1/conditional-orders/C-5': jsonOk({ conditionalOrderId: 'C-5', symbol: '005930', type: 'SINGLE', quantity: '3', first: { orderSide: 'SELL', triggerPrice: '65000' } }),
            });
            const orders = await makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true });
            expect(fake.requestsTo('GET /api/v1/conditional-orders/C-6')).toHaveLength(0);
            expect(orders.find((o) => o.id === 'C-5')).toMatchObject({ side: 'sell', triggerPrice: 65000 });
        });

        it('상세 조회가 실패해도 조건주문은 돌려준다. OCO 는 양쪽 매도로 유추한다', async () => {
            installFakeToss({
                'GET /api/v1/orders': jsonOk({ orders: [] }),
                'GET /api/v1/conditional-orders': jsonOk({ conditionalOrders: [{ conditionalOrderId: 'C-8', symbol: '005930', type: 'OCO', quantity: '2' }] }),
            });
            const [conditional] = await makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true });
            expect(conditional.side).toBe('sell');
        });

        it('방향 대소문자가 달라도 매도로 읽는다', async () => {
            installFakeToss({
                'GET /api/v1/orders': jsonOk({ orders: [] }),
                'GET /api/v1/conditional-orders': jsonOk({ conditionalOrders: [{ conditionalOrderId: 'C-7', symbol: '005930', type: 'SINGLE', quantity: '1', first: { orderSide: 'sell', triggerPrice: '70000' } }] }),
            });
            const [conditional] = await makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true });
            expect(conditional.side).toBe('sell');
        });
    });
});

describe('조건주문 목록 페이지', () => {
    const cond = (id: string, symbol = '005930'): Record<string, unknown> => ({
        conditionalOrderId: id, symbol, type: 'SINGLE', quantity: '1', first: { orderSide: 'SELL', triggerPrice: '70000' },
    });
    /** 커서 `c1`, `c2`… 로 이어지는 조건주문 목록 응답기. `pages` 의 각 원소가 한 쪽이다. */
    const paged = (pages: Array<Array<Record<string, unknown>>>) => (request: FakeRequest) => {
        const cursor = request.query.get('cursor');
        const index = cursor === null ? 0 : Number(cursor.slice(1));
        const last = index >= pages.length - 1;
        return jsonOk({ conditionalOrders: pages[index], hasNext: !last, nextCursor: last ? null : `c${index + 1}` });
    };

    it('limit 100 을 보내고 hasNext 가 끝날 때까지 커서로 이어 받는다 — 기본 20건에서 잘리지 않는다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [] }),
            'GET /api/v1/conditional-orders': paged([[cond('C-1'), cond('C-2')], [cond('C-3')], [cond('C-4')]]),
        });

        const orders = await makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true });

        expect(orders.map((o) => o.id).sort()).toEqual(['C-1', 'C-2', 'C-3', 'C-4']);
        const requests = fake.requestsTo('GET /api/v1/conditional-orders');
        expect(requests.map((r) => r.query.get('cursor'))).toEqual([null, 'c1', 'c2']);
        for (const request of requests) {
            expect(request.query.get('status')).toBe('OPEN');
            expect(request.query.get('limit')).toBe('100');
        }
    });

    it('trigger 만 받아도 같다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/conditional-orders': paged([[cond('C-1')], [cond('C-2')]]) });

        const orders = await makeToss().fetchOpenOrders(undefined, undefined, undefined, { trigger: true });

        expect(orders.map((o) => o.id).sort()).toEqual(['C-1', 'C-2']);
        expect(fake.requestsTo('GET /api/v1/conditional-orders')).toHaveLength(2);
        expect(fake.requestsTo('GET /api/v1/orders')).toHaveLength(0);
    });

    it('symbol 은 서버 조회에 넣고 매 쪽마다 같은 조건으로 요청한다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/conditional-orders': paged([[cond('C-1')], [cond('C-2')]]) });

        await makeToss().fetchOpenOrders('005930/KRW', undefined, undefined, { trigger: true });

        const requests = fake.requestsTo('GET /api/v1/conditional-orders');
        expect(requests).toHaveLength(2);
        for (const request of requests) expect(request.query.get('symbol')).toBe('005930');
    });

    it('cancelAllOrders({ includeTrigger }) 는 뒤쪽 페이지의 조건주문까지 취소한다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [] }),
            'GET /api/v1/conditional-orders': paged([[cond('C-1')], [cond('C-2')]]),
            'DELETE /api/v1/conditional-orders/C-1': { status: 204, body: undefined },
            'DELETE /api/v1/conditional-orders/C-2': { status: 204, body: undefined },
        });

        const results = await makeToss().cancelAllOrders(undefined, { includeTrigger: true });

        expect(results.map((o) => [o.id, o.status]).sort()).toEqual([['C-1', 'canceled'], ['C-2', 'canceled']]);
        expect(fake.requestsTo('DELETE /api/v1/conditional-orders/C-2')).toHaveLength(1);
    });

    it('뒤쪽 페이지 조회가 실패하면 앞쪽만 돌려주지 않고 던진다 — 일부만 보고 "스톱이 없다"로 읽히지 않게', async () => {
        installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [] }),
            'GET /api/v1/conditional-orders': (request: FakeRequest) => (request.query.get('cursor') === null
                ? jsonOk({ conditionalOrders: [cond('C-1')], hasNext: true, nextCursor: 'c1' })
                : errorReply(500, 'internal-error')),
        });

        await expect(makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true })).rejects.toThrow();
    });

    it('hasNext 가 없으면 한 번만 부른다(커서 없는 응답)', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [] }),
            'GET /api/v1/conditional-orders': jsonOk({ conditionalOrders: [cond('C-1')] }),
        });

        await makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true });

        expect(fake.requestsTo('GET /api/v1/conditional-orders')).toHaveLength(1);
    });

    it('쪽 수 상한을 넘으면 거기까지만 받고 무한히 이어 받지 않는다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [] }),
            'GET /api/v1/conditional-orders': () => jsonOk({ conditionalOrders: [cond('C-1')], hasNext: true, nextCursor: 'same' }),
        });

        await makeToss({ options: { conditionalOrdersMaxPages: 3 } }).fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true });

        expect(fake.requestsTo('GET /api/v1/conditional-orders')).toHaveLength(3);
    });

    it('일반 미체결(GET /orders?status=OPEN)은 전량을 한 번에 돌려주므로 limit·cursor 를 보내지 않는다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [order('O1', '005930')], hasNext: true, nextCursor: 'ignored' }),
            'GET /api/v1/conditional-orders': jsonOk({ conditionalOrders: [] }),
        });

        await makeToss().fetchOpenOrders(undefined, undefined, undefined, { includeTrigger: true });

        const [request] = fake.requestsTo('GET /api/v1/orders');
        expect(fake.requestsTo('GET /api/v1/orders')).toHaveLength(1);
        expect(request.query.has('limit')).toBe(false);
        expect(request.query.has('cursor')).toBe(false);
    });
});

describe('체결 완료 주문과 체결 내역', () => {
    const closed = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => order(id, '005930', { status: 'FILLED', quantity: '1', execution: { filledQuantity: '1' }, ...extra });

    it('커서로 이어 받고 오래된 순으로 돌려준다', async () => {
        installFakeToss({
            'GET /api/v1/orders': (request: FakeRequest) => (request.query.get('cursor') === 'NEXT'
                ? jsonOk({ orders: [closed('P2', { orderedAt: '2026-07-16T02:00:00Z' })], hasNext: false, nextCursor: null })
                : jsonOk({ orders: [closed('P1')], hasNext: true, nextCursor: 'NEXT' })),
        });
        const orders = await makeToss().fetchClosedOrders();
        expect(orders.map((o) => o.id)).toEqual(['P1', 'P2']);
    });

    it('페이지 크기는 토스 상한 100 이하이고 종목·시작일을 서버 조회에 넣는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders': jsonOk({ orders: [], hasNext: false }) });
        const since = Date.parse('2026-07-16T03:00:00Z');
        await makeToss().fetchClosedOrders('005930/KRW', since, 50);
        const query = fake.requestsTo('GET /api/v1/orders')[0].query;
        expect(query.get('status')).toBe('CLOSED');
        expect(Number(query.get('limit'))).toBeLessThanOrEqual(100);
        expect(query.get('symbol')).toBe('005930');
        // 자정을 넘겨 체결되는 주문이 빠지지 않도록 하루 앞에서 받는다.
        expect(query.get('from')).toBe('2026-07-15');
    });

    it('since 이전에 낸 주문은 거른다', async () => {
        installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [closed('OLD', { orderedAt: '2026-07-15T01:00:00Z' }), closed('NEW', { orderedAt: '2026-07-16T05:00:00Z' })], hasNext: false }),
        });
        const orders = await makeToss().fetchClosedOrders('005930', Date.parse('2026-07-16T00:00:00Z'));
        expect(orders.map((o) => o.id)).toEqual(['NEW']);
    });

    it('페이지 상한을 넘으면 거기서 자른다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/orders': jsonOk({ orders: [closed('X')], hasNext: true, nextCursor: 'MORE' }) });
        await makeToss().fetchClosedOrders();
        expect(fake.requestsTo('GET /api/v1/orders')).toHaveLength(10);
    });

    /** 종료 목록(`status=CLOSED`)과 미체결 목록(`status=OPEN`)을 따로 답한다. */
    const byStatus = (closedRows: Record<string, unknown>[], openRows: Record<string, unknown>[] = []): Route => (request) =>
        (request.query.get('status') === 'OPEN' ? jsonOk({ orders: openRows }) : jsonOk({ orders: closedRows, hasNext: false }));

    it('fetchMyTrades: 체결된 주문만 거래로 옮기고 수수료는 확정값을 쓴다', async () => {
        installFakeToss({
            'GET /api/v1/orders': byStatus([
                order('C1', '005930', { status: 'FILLED', currency: 'KRW', execution: { filledQuantity: '3', averageFilledPrice: '70000', commission: '31', tax: '0', filledAt: '2026-07-16T01:00:05Z' } }),
                order('C2', '005930', { status: 'CANCELED', execution: { filledQuantity: '0' } }),
            ]),
        });
        const trades = await makeToss().fetchMyTrades('005930/KRW');
        expect(trades).toHaveLength(1);
        expect(trades[0]).toMatchObject({ order: 'C1', symbol: '005930/KRW', side: 'buy', amount: 3, price: 70000, cost: 210000 });
        expect(trades[0].fee).toMatchObject({ currency: 'KRW', cost: 31 });
        expect(trades[0].timestamp).toBe(Date.parse('2026-07-16T01:00:05Z'));
    });

    it('★fetchMyTrades 는 일부 체결된 채 걸려 있는 미체결 주문의 누적 체결도 거래로 넣는다(id 는 주문번호)', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': byStatus([], [
                order('P1', '005930', { status: 'PARTIAL_FILLED', quantity: '100', execution: { filledQuantity: '40', averageFilledPrice: '69900', filledAt: '2026-07-16T02:30:00Z' } }),
                order('P2', '005930', { status: 'PENDING', quantity: '10', execution: { filledQuantity: '0' } }),
            ]),
        });
        const trades = await makeToss().fetchMyTrades('005930/KRW');
        expect(trades.map((t) => [t.id, t.amount])).toEqual([['P1', 40]]);
        expect(fake.requestsTo('GET /api/v1/orders').map((r) => r.query.get('status'))).toEqual(['CLOSED', 'OPEN']);
    });

    it('fetchMyTrades 는 since 를 체결 시각으로 거르고 종목을 주지 않으면 전 종목이다', async () => {
        installFakeToss({
            'GET /api/v1/orders': byStatus([
                order('A', '005930', { status: 'FILLED', execution: { filledQuantity: '1', averageFilledPrice: '70000', filledAt: '2026-07-16T01:00:00Z' } }),
                order('B', '000660', { status: 'FILLED', execution: { filledQuantity: '1', averageFilledPrice: '200000', filledAt: '2026-07-16T05:00:00Z' } }),
            ]),
        });
        const trades = await makeToss().fetchMyTrades(undefined, Date.parse('2026-07-16T03:00:00Z'));
        expect(trades.map((t) => t.order)).toEqual(['B']);
    });
});

describe('단건 조회', () => {
    it('fetchOrder 는 주문 상세를 옮기고 없으면 OrderNotFound', async () => {
        installFakeToss({
            'GET /api/v1/orders/O1': jsonOk(order('O1', '005930', { status: 'FILLED', execution: { filledQuantity: '5', averageFilledPrice: '70100', filledAmount: '350500', commission: '52' } })),
            'GET /api/v1/orders/NOPE': errorReply(404, 'order-not-found'),
        });
        const exchange = makeToss();
        expect(await exchange.fetchOrder('O1')).toMatchObject({ id: 'O1', status: 'closed', filled: 5, average: 70100, cost: 350500, remaining: 0 });
        await expect(exchange.fetchOrder('NOPE')).rejects.toBeInstanceOf(OrderNotFound);
    });

    it('fee.cost 는 fees[0].cost 와 같은 숫자다(수수료와 세금의 합)', async () => {
        installFakeToss({
            'GET /api/v1/orders/O1': jsonOk(order('O1', '005930', {
                side: 'SELL', status: 'FILLED', currency: 'KRW',
                execution: { filledQuantity: '5', averageFilledPrice: '70100', filledAmount: '350500', commission: '52', tax: '630' },
            })),
        });
        const fetched = await makeToss().fetchOrder('O1');
        expect(fetched.fee).toEqual({ currency: 'KRW', cost: 682 });
        expect(fetched.fee?.cost).toBe(fetched.fees?.[0]?.cost);
    });

    it('trigger 는 조건주문 상세를 받는다', async () => {
        installFakeToss({
            'GET /api/v1/conditional-orders/C-1': jsonOk({ conditionalOrderId: 'C-1', symbol: '005930', type: 'SINGLE', status: 'COMPLETED', quantity: '3', first: { orderSide: 'SELL', triggerPrice: '65000' } }),
        });
        expect(await makeToss().fetchOrder('C-1', '005930', { trigger: true })).toMatchObject({ id: 'C-1', status: 'closed', triggerPrice: 65000 });
    });
});

describe('취소', () => {
    it('일반 주문은 POST cancel 이고 토스가 발급한 새 주문번호는 info 에 있다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders/O1/cancel': jsonOk({ orderId: 'NEW-OID' }) });
        const result = await makeToss().cancelOrder('O1', '005930/KRW');
        expect(result).toMatchObject({ id: 'O1', status: 'canceled', symbol: '005930/KRW' });
        expect(result.info).toEqual({ orderId: 'NEW-OID' });
        expect(fake.requestsTo('POST /api/v1/orders/O1/cancel')).toHaveLength(1);
    });

    it('조건주문은 DELETE 이고 본문이 비어 있어도 성공이다', async () => {
        const fake = installFakeToss({ 'DELETE /api/v1/conditional-orders/COND-1': { status: 204, body: undefined } });
        const result = await makeToss().cancelOrder('COND-1', '005930/KRW', { trigger: true });
        expect(result.status).toBe('canceled');
        expect(fake.requestsTo('DELETE /api/v1/conditional-orders/COND-1')).toHaveLength(1);
    });

    it.each(['already-filled', 'already-canceled', 'already-modified', 'already-rejected', 'order-not-found'])(
        '%s 는 이미 사라진 주문이라 OrderNotFound 다',
        async (code) => {
            installFakeToss({ 'POST /api/v1/orders/O1/cancel': errorReply(code === 'order-not-found' ? 404 : 409, code) });
            const error = await makeToss().cancelOrder('O1').catch((e: unknown) => e);
            expect(error).toBeInstanceOf(OrderNotFound);
            expect((error as OrderNotFound).detail).toBe(code);
        },
    );

    it('주문 접수 불가 시간(order-hours-closed)의 취소 실패는 이미 사라진 주문이 아니다', async () => {
        // 오류 메시지에 `closed` 가 들어 있어도 문구로 판정하지 않고 오류 코드로 판정한다.
        installFakeToss({ 'POST /api/v1/orders/O1/cancel': errorReply(422, 'order-hours-closed') });
        const error = await makeToss().cancelOrder('O1').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MarketClosed);
        expect(error).not.toBeInstanceOf(OrderNotFound);
    });

    it('주문번호는 경로에 인코딩해 넣는다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders/*': jsonOk({ orderId: 'N' }) });
        await makeToss().cancelOrder('A/B C');
        expect(fake.requests()[0].path).toBe('/api/v1/orders/A%2FB%20C/cancel');
    });
});

describe('전체 취소', () => {
    it('종목을 주면 그 종목의 미체결만 취소한다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': (request: FakeRequest) => jsonOk({
                orders: [order('O1', '005930'), order('O2', '000660')].filter((o) => !request.query.has('symbol') || o.symbol === request.query.get('symbol')),
            }),
            'POST /api/v1/orders/*': jsonOk({ orderId: 'N' }),
        });
        const results = await makeToss().cancelAllOrders('005930/KRW');
        expect(results.map((o) => o.id)).toEqual(['O1']);
        expect(fake.requests().filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/v1/orders/O1/cancel']);
    });

    it('응답에 다른 종목이 섞여 와도 취소하지 않는다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [order('O1', '005930'), order('O2', '000660')] }),
            'POST /api/v1/orders/*': jsonOk({ orderId: 'N' }),
        });
        await makeToss().cancelAllOrders('005930');
        expect(fake.requests().filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/v1/orders/O1/cancel']);
    });

    it('일부가 실패하면 그 주문을 open 으로 돌려주고, 이미 끝난 주문은 원인 코드대로 옮긴다', async () => {
        installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [order('O1', '005930'), order('O2', '005930'), order('O3', '005930'), order('O4', '005930'), order('O5', '005930')] }),
            'POST /api/v1/orders/O1/cancel': jsonOk({ orderId: 'N1' }),
            'POST /api/v1/orders/O2/cancel': errorReply(409, 'already-filled'),
            'POST /api/v1/orders/O3/cancel': () => new NetworkError('끊김'),
            'POST /api/v1/orders/O4/cancel': errorReply(409, 'already-canceled'),
            'POST /api/v1/orders/O5/cancel': errorReply(409, 'already-modified'),
        });
        const results = await makeToss().cancelAllOrders();
        // ★취소 사이에 전량 체결된 주문을 취소로 적지 않는다. 정정으로 대체된 주문은 새 주문이 살아 있을 수 있어 open 으로 둔다.
        expect(results.map((o) => [o.id, o.status])).toEqual([['O1', 'canceled'], ['O2', 'closed'], ['O3', 'open'], ['O4', 'canceled'], ['O5', 'open']]);
        expect(results[1]).toMatchObject({ filled: results[1].amount, remaining: 0 });
        expect(results[1].info).toMatchObject({ alreadyGone: true, cancelErrorDetail: 'already-filled' });
        expect(results[4].info).toMatchObject({ alreadyGone: true, cancelErrorDetail: 'already-modified' });
        expect((results[2].info as { cancelError: string }).cancelError).toContain('알 수 없다');
    });

    it('includeTrigger 는 조건주문도 취소한다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [] }),
            'GET /api/v1/conditional-orders': jsonOk({ conditionalOrders: [{ conditionalOrderId: 'C-1', symbol: '005930', type: 'SINGLE', quantity: '1', first: { orderSide: 'SELL', triggerPrice: '70000' } }] }),
            'DELETE /api/v1/conditional-orders/C-1': { status: 204, body: undefined },
        });
        const results = await makeToss().cancelAllOrders(undefined, { includeTrigger: true });
        expect(results.map((o) => o.status)).toEqual(['canceled']);
        expect(fake.requestsTo('DELETE /api/v1/conditional-orders/C-1')).toHaveLength(1);
    });
});
