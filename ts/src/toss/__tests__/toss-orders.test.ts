/**
 * @fileoverview 주문 생성: 본문, 수량 규칙, 세션 게이트, 확장세션 지정가 전환, 체결 확정, 조건주문.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { orderable } = vi.hoisted(() => ({ orderable: { value: true } }));

// 캘린더를 받지 못했을 때의 폴백 판정만 가로채고 세션 판정은 실물을 쓴다.
vi.mock('../toss-trading-hours', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../toss-trading-hours')>()),
    isTossOrderable: () => orderable.value,
}));

import { ArgumentsRequired, InvalidOrder, MarketClosed, OrderOutcomeUnknown } from '../../base';
import { OrderNotSent } from '../toss-errors';
import { errorReply, installFakeToss, jsonOk, makeToss, networkFailure, type FakeToss, type Route } from './support/toss-fake';

beforeEach(() => {
    orderable.value = true;
});

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;
// 세션 종료가 한참 뒤라서 정규장 종료 1시간 전 마감에 걸리지 않는다.
const open = (): { startTime: string; endTime: string } => ({ startTime: iso(-HOUR), endTime: iso(3 * HOUR) });

const usCalendar = (session: 'dayMarket' | 'preMarket' | 'regularMarket' | 'afterMarket', window = open()): Route => jsonOk({
    today: {
        date: '2026-08-03',
        dayMarket: session === 'dayMarket' ? window : null,
        preMarket: session === 'preMarket' ? window : null,
        regularMarket: session === 'regularMarket' ? window : null,
        afterMarket: session === 'afterMarket' ? window : null,
    },
});

const krCalendar = (session: 'preMarket' | 'regularMarket' | 'afterMarket'): Route => jsonOk({
    today: {
        date: '2026-08-03',
        integrated: {
            preMarket: session === 'preMarket' ? open() : null,
            regularMarket: session === 'regularMarket' ? open() : null,
            afterMarket: session === 'afterMarket' ? open() : null,
        },
    },
});

/** `GET /orders/{id}` 응답. */
function orderDetail(o: Partial<{
    status: string; filledQuantity: string; averageFilledPrice: string | null;
    filledAmount: string | null; commission: string | null; tax: string | null;
}>): Route {
    const { status = 'FILLED', ...execution } = o;
    return jsonOk({ orderId: 'OID-X', symbol: '005930', side: 'BUY', status, execution });
}

const postedOrder = (fake: FakeToss): Record<string, unknown> => fake.requestsTo('POST /api/v1/orders')[0].body as Record<string, unknown>;

describe('주문 본문', () => {
    it('지정가는 LIMIT 본문을 보낸다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders': jsonOk({ orderId: 'OID-1', clientOrderId: null }) });
        const order = await makeToss().createOrder('005930/KRW', 'limit', 'buy', 2, 70000, { confirmExecution: false });
        expect(order.id).toBe('OID-1');
        expect(order.symbol).toBe('005930/KRW');
        expect(postedOrder(fake)).toEqual({ symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '2', price: '70000' });
    });

    it('시장가는 가격 없이 MARKET 으로 보낸다. 가격을 함께 주어도 기준가일 뿐 본문에 싣지 않는다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders': jsonOk({ orderId: 'OID-M' }) });
        await makeToss().createOrder('005930', 'market', 'buy', 3, 70000, { confirmExecution: false });
        const body = postedOrder(fake);
        expect(body.orderType).toBe('MARKET');
        expect(body.price).toBeUndefined();
        expect(body.quantity).toBe('3');
    });

    it('clientOrderId 와 timeInForce 를 전달한다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders': jsonOk({ orderId: 'OID-3' }) });
        await makeToss().createOrder('005930', 'limit', 'buy', 1, 70000, { clientOrderId: 't-bot-abc', timeInForce: 'opg', confirmExecution: false });
        expect(postedOrder(fake)).toMatchObject({ clientOrderId: 't-bot-abc', timeInForce: 'OPG' });
    });

    it('지원하지 않는 timeInForce 는 요청 없이 던진다', async () => {
        const fake = installFakeToss({});
        await expect(makeToss().createOrder('005930', 'limit', 'buy', 1, 70000, { timeInForce: 'IOC' })).rejects.toThrow(InvalidOrder);
        expect(fake.requests()).toHaveLength(0);
    });

    it('지정가에 가격이 없으면 ArgumentsRequired', async () => {
        installFakeToss({});
        await expect(makeToss().createOrder('005930', 'limit', 'buy', 1)).rejects.toThrow(ArgumentsRequired);
    });

    it('국내 1억원 이상은 confirmHighValueOrder 를 켠다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders': jsonOk({ orderId: 'OID-HV' }) });
        await makeToss().createOrder('005930', 'limit', 'buy', 2000, 70000, { confirmExecution: false });
        expect(postedOrder(fake).confirmHighValueOrder).toBe(true);
    });

    it('미국 고액주문 기준은 환율로 계산한다: 환율이 높으면 7만 달러보다 낮은 금액에서도 켠다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/exchange-rate': jsonOk({ baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1600' }),
            'GET /api/v1/market-calendar/US': usCalendar('regularMarket'),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-HV' }),
        });
        // 1억원 / 1,600원 = 62,500달러. 여유 5% 를 두면 59,375달러부터 켠다.
        await makeToss().createOrder('AAPL', 'limit', 'buy', 350, 170, { confirmExecution: false }); // 59,500달러
        expect(postedOrder(fake).confirmHighValueOrder).toBe(true);
    });

    it('미국 소액 주문은 환율을 조회하지 않는다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/US': usCalendar('regularMarket'),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-S' }),
        });
        await makeToss().createOrder('AAPL', 'limit', 'buy', 2, 150, { confirmExecution: false });
        expect(fake.requestsTo('GET /api/v1/exchange-rate')).toHaveLength(0);
        expect(postedOrder(fake).confirmHighValueOrder).toBeUndefined();
    });
});

describe('수량 규칙', () => {
    it('국내 분수 수량은 정수로 내린다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders': jsonOk({ orderId: 'OID-2' }) });
        await makeToss().createOrder('005930', 'limit', 'sell', 2.9, 70000, { confirmExecution: false });
        expect(postedOrder(fake).quantity).toBe('2');
    });

    it('미국 시장가 매도는 소수점 수량을 보존한다(6자리에서 버린다)', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/US': usCalendar('regularMarket'),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-2' }),
        });
        await makeToss().createOrder('AAPL', 'market', 'sell', 0.5, undefined, { confirmExecution: false });
        expect(postedOrder(fake).quantity).toBe('0.5');
    });

    it('미국 지정가의 소수점은 정수로 내린다. 소수점은 시장가 매도 전용이다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/US': usCalendar('regularMarket'),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-3' }),
        });
        await makeToss().createOrder('AAPL', 'limit', 'sell', 2.7, 150, { confirmExecution: false });
        expect(postedOrder(fake).quantity).toBe('2');
    });

    it('미국 소수점 시장가 매수는 내린 뒤 0 이라 던지고 금액 주문을 안내한다', async () => {
        installFakeToss({});
        await expect(makeToss().createOrder('AAPL', 'market', 'buy', 0.5)).rejects.toThrow('금액(cost) 주문');
    });

    it('수량이 0 이하이거나 유한하지 않으면 ArgumentsRequired', async () => {
        const exchange = makeToss();
        expect(() => exchange.normalizeQuantity('005930', 'limit', 'buy', 0)).toThrow(ArgumentsRequired);
        expect(() => exchange.normalizeQuantity('005930', 'limit', 'buy', Number.NaN)).toThrow(ArgumentsRequired);
    });

    it('미국 시장가 매수에 cost 를 주면 금액(orderAmount) 주문이다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/US': usCalendar('regularMarket'),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-1' }),
        });
        const order = await makeToss().createMarketBuyOrderWithCost('AAPL', 100.5, { confirmExecution: false });
        expect(postedOrder(fake)).toEqual({ symbol: 'AAPL', side: 'BUY', orderType: 'MARKET', orderAmount: '100.5' });
        expect(order.amount).toBeUndefined();
    });

    it('국내 주문에 cost 를 주어도 수량 기준이다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders': jsonOk({ orderId: 'KR-C' }) });
        await makeToss().createOrder('005930', 'market', 'buy', 3, undefined, { cost: 200000, confirmExecution: false });
        expect(postedOrder(fake)).toMatchObject({ quantity: '3' });
        expect(postedOrder(fake).orderAmount).toBeUndefined();
    });
});

describe('세션 게이트', () => {
    it('국내 거래시간 밖이면 요청을 보내지 않고 MarketClosed 를 던진다', async () => {
        orderable.value = false;
        const fake = installFakeToss({});
        // 캘린더 조회가 실패하므로 정적 시간표로 판정한다.
        await expect(makeToss().createOrder('005930', 'limit', 'buy', 1, 70000)).rejects.toThrow(MarketClosed);
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(0);
    });

    it('국내 공휴일이면 정적 시간표가 열려 있어도 막는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/market-calendar/KR': jsonOk({ today: { date: '2026-05-05', integrated: null } }) });
        await expect(makeToss().createOrder('005930', 'limit', 'buy', 1, 70000)).rejects.toThrow('휴장');
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(0);
    });

    it('미국 프리마켓은 정규장이 아니어도 정수 지정가를 접수한다', async () => {
        orderable.value = false;
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/US': usCalendar('preMarket'),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-PRE' }),
        });
        await makeToss().createOrder('PEP', 'limit', 'buy', 1, 49.3, { confirmExecution: false });
        expect(postedOrder(fake)).toMatchObject({ symbol: 'PEP', orderType: 'LIMIT', quantity: '1' });
    });

    it('미국 프리마켓의 시장가와 금액 주문은 정규장 전용이라 막는다', async () => {
        installFakeToss({ 'GET /api/v1/market-calendar/US': usCalendar('preMarket') });
        const exchange = makeToss();
        await expect(exchange.createOrder('PEP', 'market', 'buy', 1)).rejects.toThrow('시장가 주문은 정규장 전용');
        await expect(exchange.createMarketBuyOrderWithCost('PEP', 50)).rejects.toThrow('금액(orderAmount) 주문은 정규장 전용');
    });

    it('미국 정규장에서는 금액 주문이 통과한다', async () => {
        orderable.value = false;
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/US': usCalendar('regularMarket'),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-REG' }),
        });
        await makeToss().createMarketBuyOrderWithCost('AAPL', 100.5, { confirmExecution: false });
        expect(postedOrder(fake).orderAmount).toBe('100.5');
    });

    it('금액 주문과 소수점 수량 주문은 정규장 종료 1시간 전부터 막는다', async () => {
        // 정규장이 30분 뒤에 끝난다. 정규장 안이지만 종료 1시간 전을 지났다.
        const closing = { startTime: iso(-5 * HOUR), endTime: iso(HOUR / 2) };
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/US': usCalendar('regularMarket', closing),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-LATE' }),
        });
        const exchange = makeToss();
        await expect(exchange.createMarketBuyOrderWithCost('AAPL', 100)).rejects.toThrow('정규장 종료 1시간 전 이후');
        await expect(exchange.createOrder('AAPL', 'market', 'sell', 0.5)).rejects.toThrow('정규장 종료 1시간 전 이후');
        // 정수 수량 주문은 정규장 종료까지 접수된다.
        await exchange.createOrder('AAPL', 'limit', 'buy', 1, 150, { confirmExecution: false });
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(1);
    });

    it('supportsFractionalBuy: 정규장 종료 1시간 전까지만 true, 국내는 false', async () => {
        installFakeToss({ 'GET /api/v1/market-calendar/US': usCalendar('regularMarket') });
        expect(await makeToss().supportsFractionalBuy('AAPL')).toBe(true);
        expect(await makeToss().supportsFractionalBuy('005930')).toBe(false);

        installFakeToss({ 'GET /api/v1/market-calendar/US': usCalendar('regularMarket', { startTime: iso(-5 * HOUR), endTime: iso(HOUR / 2) }) });
        expect(await makeToss().supportsFractionalBuy('AAPL')).toBe(false);
    });

    it('미국 캘린더를 받지 못하면 정적 판정으로 폴백한다(닫혀 있으면 막는다)', async () => {
        orderable.value = false;
        installFakeToss({});
        await expect(makeToss().createOrder('PEP', 'limit', 'buy', 1, 49.3)).rejects.toThrow('캘린더 조회 실패');
    });

    it('국내 애프터마켓은 nxtRouting 옵션이 꺼져 있으면 막는다', async () => {
        installFakeToss({ 'GET /api/v1/market-calendar/KR': krCalendar('afterMarket') });
        await expect(makeToss().createOrder('005930', 'limit', 'buy', 1, 70000)).rejects.toThrow('nxtRouting');
    });

    it('국내 애프터마켓은 옵션이 켜져 있으면 지정가 정수 수량을 접수한다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/KR': krCalendar('afterMarket'),
            'POST /api/v1/orders': jsonOk({ orderId: 'NXT-1' }),
        });
        const order = await makeToss({ options: { nxtRouting: true } }).createOrder('005930', 'limit', 'sell', 3, 70000, { confirmExecution: false });
        expect(order.id).toBe('NXT-1');
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(1);
    });
});

describe('확장세션 시장가를 지정가로 바꿔 낸다', () => {
    function krAfterMarket(opts: { openOrders?: unknown[]; openAfterPost?: unknown[]; lastPrice?: string } = {}): FakeToss {
        let posted = false;
        return installFakeToss({
            'GET /api/v1/market-calendar/KR': krCalendar('afterMarket'),
            'GET /api/v1/prices': jsonOk([{ symbol: '005930', lastPrice: opts.lastPrice ?? '70000' }]),
            'GET /api/v1/orders': () => jsonOk({ orders: posted ? (opts.openAfterPost ?? []) : (opts.openOrders ?? []), hasNext: false, nextCursor: null }),
            'POST /api/v1/orders': () => { posted = true; return jsonOk({ orderId: 'EXT-1' }); },
        });
    }

    it('최종가를 지정가로 삼아 발주하고 체결됐으면 체결로 돌려준다', async () => {
        const fake = krAfterMarket();
        const exchange = makeToss({ options: { nxtRouting: true } });
        const order = await exchange.createOrder('005930', 'market', 'sell', 3);
        expect(postedOrder(fake)).toMatchObject({ orderType: 'LIMIT', price: '70000' });
        expect(order.type).toBe('limit');
        expect(order.info.extendedSession).toBe('afterMarket');
    });

    it('접수 뒤에도 미체결 장부에 남아 있으면 체결로 가정하지 않고 open 으로 돌려준다', async () => {
        krAfterMarket({ openAfterPost: [{ orderId: 'EXT-1', symbol: '005930', side: 'SELL', quantity: '3' }] });
        const order = await makeToss({ options: { nxtRouting: true } }).createOrder('005930', 'market', 'sell', 3);
        expect(order.status).toBe('open');
        expect(order.filled).toBeUndefined();
    });

    it('같은 종목·같은 방향 미체결이 있으면 발주하지 않는다', async () => {
        const fake = krAfterMarket({ openOrders: [{ orderId: 'PREV-1', symbol: '005930', side: 'SELL', quantity: '3' }] });
        const promise = makeToss({ options: { nxtRouting: true } }).createOrder('005930', 'market', 'sell', 3);
        await expect(promise).rejects.toThrow('중복 발주 스킵');
        await expect(promise).rejects.toBeInstanceOf(OrderNotSent);
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(0);
    });

    it('다른 종목의 같은 방향 미체결은 중복으로 보지 않는다', async () => {
        const fake = krAfterMarket({ openOrders: [{ orderId: 'OTHER-1', symbol: '000660', side: 'SELL', quantity: '3' }] });
        await makeToss({ options: { nxtRouting: true } }).createOrder('005930', 'market', 'sell', 3, undefined, { confirmExecution: false });
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(1);
        // 미체결 조회는 종목으로 좁혀서 한다.
        expect(fake.requestsTo('GET /api/v1/orders')[0].query.get('symbol')).toBe('005930');
    });

    it('기준가를 구하지 못하면 발주하지 않는다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/KR': krCalendar('afterMarket'),
            'GET /api/v1/orders': jsonOk({ orders: [] }),
        });
        await expect(makeToss({ options: { nxtRouting: true } }).createOrder('005930', 'market', 'sell', 3)).rejects.toThrow('기준가');
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(0);
    });

    it('옵션이 꺼져 있으면 전환하지 않고 게이트가 막는다', async () => {
        krAfterMarket();
        await expect(makeToss().createOrder('005930', 'market', 'sell', 3)).rejects.toThrow('nxtRouting');
    });

    it('정규장에서는 시장가 그대로 낸다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/KR': krCalendar('regularMarket'),
            'POST /api/v1/orders': jsonOk({ orderId: 'REG-1' }),
        });
        await makeToss({ options: { nxtRouting: true } }).createOrder('005930', 'market', 'sell', 3, undefined, { confirmExecution: false });
        expect(postedOrder(fake).orderType).toBe('MARKET');
    });

    function usDayMarket(opts: { openOrders?: unknown[]; session?: 'dayMarket' | 'regularMarket' } = {}): FakeToss {
        return installFakeToss({
            'GET /api/v1/market-calendar/US': usCalendar(opts.session ?? 'dayMarket'),
            'GET /api/v1/prices': jsonOk([{ symbol: 'XOM', lastPrice: '80.4' }]),
            'GET /api/v1/orders': jsonOk({ orders: opts.openOrders ?? [], hasNext: false, nextCursor: null }),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-EXT-1' }),
        });
    }

    it('미국 주간거래 시장가 청산(정수)도 지정가로 바꿔 낸다', async () => {
        orderable.value = false;
        const fake = usDayMarket();
        await makeToss({ options: { usExtendedLimit: true } }).createOrder('XOM', 'market', 'sell', 3, undefined, { confirmExecution: false });
        expect(postedOrder(fake)).toMatchObject({ orderType: 'LIMIT', quantity: '3', price: '80.4' });
    });

    it('소수점 수량은 전환하지 않고 정규장 전용으로 막는다', async () => {
        orderable.value = false;
        const fake = usDayMarket();
        await expect(makeToss({ options: { usExtendedLimit: true } }).createOrder('XOM', 'market', 'sell', 0.309628))
            .rejects.toThrow('시장가 주문은 정규장 전용');
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(0);
    });

    it('미국 정규장에서는 소수점 시장가 매도가 그대로 나간다', async () => {
        const fake = usDayMarket({ session: 'regularMarket' });
        await makeToss({ options: { usExtendedLimit: true } }).createOrder('XOM', 'market', 'sell', 0.309628, undefined, { confirmExecution: false });
        expect(postedOrder(fake)).toMatchObject({ orderType: 'MARKET', quantity: '0.309628' });
    });

    it('미국도 같은 방향 미체결이 있으면 발주하지 않는다', async () => {
        orderable.value = false;
        usDayMarket({ openOrders: [{ orderId: 'US-PREV', symbol: 'XOM', side: 'SELL', quantity: '3' }] });
        await expect(makeToss({ options: { usExtendedLimit: true } }).createOrder('XOM', 'market', 'sell', 3)).rejects.toThrow('중복 발주 스킵');
    });
});

describe('체결 확정', () => {
    /** 접수 뒤 `GET /orders/{id}` 를 폴링하는 서버. */
    function fill(detail: (poll: number) => Route): { fake: FakeToss; polls: () => number } {
        let polls = 0;
        const fake = installFakeToss({
            'POST /api/v1/orders': jsonOk({ orderId: 'OID-FILL' }),
            'GET /api/v1/orders/OID-FILL': () => { polls++; return detail(polls) as never; },
        });
        return { fake, polls: () => polls };
    }

    it('접수 직후 미체결이어도 폴링해 체결가·수량·금액을 확정한다', async () => {
        const { polls } = fill((n) => (n < 3
            ? orderDetail({ status: 'PENDING', filledQuantity: '0' })
            : orderDetail({ status: 'FILLED', filledQuantity: '4', averageFilledPrice: '114100', filledAmount: '456400' })));
        const order = await makeToss().createOrder('051910', 'market', 'buy', 4, 114200);
        expect(order.average).toBe(114100);
        expect(order.filled).toBe(4);
        expect(order.cost).toBe(456400);
        expect(order.status).toBe('closed');
        expect(polls()).toBe(3);
    });

    it('평균 체결가가 비어 있으면 체결 금액에서 거꾸로 구한다', async () => {
        fill(() => orderDetail({ filledQuantity: '4', averageFilledPrice: null, filledAmount: '456400' }));
        const order = await makeToss().createOrder('051910', 'market', 'buy', 4, 114200);
        expect(order.average).toBe(114100);
    });

    it('수수료와 세금을 합쳐 확정한다', async () => {
        fill(() => orderDetail({ filledQuantity: '4', averageFilledPrice: '114100', filledAmount: '456400', commission: '68', tax: '821' }));
        const order = await makeToss().createOrder('051910', 'market', 'sell', 4, 114200);
        expect(order.fee).toEqual({ currency: 'KRW', cost: 889 });
        expect((order.info.execution as { fee: number }).fee).toBe(889);
    });

    it('부분 체결이 진행 중이면 더 지켜보고 최종 체결분을 돌려준다', async () => {
        fill((n) => (n < 2
            ? orderDetail({ status: 'PARTIAL_FILLED', filledQuantity: '1', averageFilledPrice: '114000', filledAmount: '114000' })
            : orderDetail({ filledQuantity: '4', averageFilledPrice: '114100', filledAmount: '456400' })));
        const order = await makeToss().createOrder('051910', 'market', 'buy', 4, 114200);
        expect(order.filled).toBe(4);
        expect(order.cost).toBe(456400);
    });

    it('체결 없이 취소되면 즉시 끝내고 체결을 채우지 않는다', async () => {
        const { polls } = fill(() => orderDetail({ status: 'CANCELED', filledQuantity: '0' }));
        const order = await makeToss().createOrder('051910', 'market', 'buy', 4, 114200);
        expect(polls()).toBe(1);
        expect(order.status).toBe('canceled');
        expect(order.filled).toBeUndefined();
        expect(order.info.execution).toBeUndefined();
    });

    it('예산을 소진해도 미체결이면 요청값으로 추정하지 않고 filled 를 비운다', async () => {
        const { polls } = fill(() => orderDetail({ status: 'PENDING', filledQuantity: '0' }));
        const order = await makeToss({ options: { confirmBudget: { attempts: 3, intervalMs: 0 } } }).createOrder('051910', 'limit', 'buy', 4, 114200);
        expect(polls()).toBe(3);
        expect(order.filled).toBeUndefined();
        expect(order.status).toBe('open');
        expect(order.amount).toBe(4);
    });

    it('confirmExecution: false 면 체결 조회를 하지 않는다', async () => {
        const { polls } = fill(() => orderDetail({}));
        await makeToss().createOrder('051910', 'limit', 'buy', 4, 114200, { confirmExecution: false });
        expect(polls()).toBe(0);
    });

    it('체결 조회가 실패해도 주문 접수는 성공이다', async () => {
        installFakeToss({
            'POST /api/v1/orders': jsonOk({ orderId: 'OID-FILL' }),
            'GET /api/v1/orders/OID-FILL': errorReply(500, 'internal-error'),
        });
        const order = await makeToss({ options: { confirmBudget: { attempts: 2, intervalMs: 0 } } }).createOrder('051910', 'limit', 'buy', 4, 114200);
        expect(order.id).toBe('OID-FILL');
        expect(order.filled).toBeUndefined();
    });
});

describe('주문 요청 실패', () => {
    it('주문 요청이 연결 오류로 끝나면 접수 여부를 알 수 없다(OrderOutcomeUnknown)', async () => {
        installFakeToss({ 'POST /api/v1/orders': () => networkFailure('ECONNRESET') });
        await expect(makeToss().createOrder('005930', 'limit', 'buy', 1, 70000)).rejects.toBeInstanceOf(OrderOutcomeUnknown);
    });

    it('주문 요청은 다시 보내지 않는다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/orders': () => networkFailure('ECONNRESET') });
        await makeToss({ options: { maxRetriesOnFailure: 3 } }).createOrder('005930', 'limit', 'buy', 1, 70000).catch(() => undefined);
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(1);
    });

    it('주문 접수 응답에 orderId 가 없으면 접수 여부를 모르는 것으로 본다', async () => {
        installFakeToss({ 'POST /api/v1/orders': jsonOk({}) });
        await expect(makeToss().createOrder('005930', 'limit', 'buy', 1, 70000)).rejects.toBeInstanceOf(OrderOutcomeUnknown);
    });

    it('order-hours-closed 는 MarketClosed 다', async () => {
        installFakeToss({ 'POST /api/v1/orders': errorReply(422, 'order-hours-closed') });
        await expect(makeToss().createOrder('005930', 'limit', 'buy', 1, 70000, { confirmExecution: false })).rejects.toBeInstanceOf(MarketClosed);
    });
});

describe('조건주문', () => {
    const expireDate = '2026-08-30';
    const conditionalBody = (fake: FakeToss): Record<string, unknown> => fake.requestsTo('POST /api/v1/conditional-orders')[0].body as Record<string, unknown>;

    it('SINGLE 시장가는 orderPrice 없이 등록한다(서버측 손절)', async () => {
        const fake = installFakeToss({ 'POST /api/v1/conditional-orders': jsonOk({ conditionalOrderId: 'COND-M' }) });
        const order = await makeToss().createOrder('005930', 'market', 'sell', 10, undefined, { triggerPrice: 65000, expireDate });
        expect(order.id).toBe('COND-M');
        expect(order.triggerPrice).toBe(65000);
        expect(order.status).toBe('open');
        const body = conditionalBody(fake);
        expect(body).toMatchObject({ symbol: '005930', type: 'SINGLE', orderType: 'MARKET', quantity: '10', expireDate });
        expect(body.first).toEqual({ orderSide: 'SELL', triggerPrice: '65000' });
    });

    it('createTriggerOrder 는 createOrder(..., { triggerPrice }) 와 같은 조건주문을 등록한다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/conditional-orders': jsonOk({ conditionalOrderId: 'COND-T' }) });
        const order = await makeToss().createTriggerOrder('005930', 'market', 'sell', 10, undefined, 65000, { expireDate });
        expect(order.id).toBe('COND-T');
        expect(order.triggerPrice).toBe(65000);
        const body = conditionalBody(fake);
        expect(body).toMatchObject({ symbol: '005930', type: 'SINGLE', orderType: 'MARKET', quantity: '10', expireDate });
        expect(body.first).toEqual({ orderSide: 'SELL', triggerPrice: '65000' });
        expect(fake.requestsTo('POST /api/v1/orders')).toHaveLength(0);
    });

    it('createTriggerOrder 는 지정가 가격과 params(OCO 의 second 등)를 그대로 넘긴다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/conditional-orders': jsonOk({ conditionalOrderId: 'COND-T2' }) });
        await makeToss().createTriggerOrder('005930', 'limit', 'sell', 10, 79900, 80000, {
            conditionalType: 'OCO', expireDate, second: { side: 'sell', triggerPrice: 65000, price: 64900 },
        });
        const body = conditionalBody(fake);
        expect(body).toMatchObject({ type: 'OCO', orderType: 'LIMIT', quantity: '10' });
        expect(body.first).toEqual({ orderSide: 'SELL', triggerPrice: '80000', orderPrice: '79900' });
        expect(body.second).toEqual({ orderSide: 'SELL', triggerPrice: '65000', orderPrice: '64900' });
    });

    it('createTriggerOrder 에 triggerPrice 가 없으면 요청 없이 ArgumentsRequired 다(일반 주문으로 나가지 않는다)', async () => {
        const fake = installFakeToss({});
        await expect(makeToss().createTriggerOrder('005930', 'market', 'sell', 10, undefined, undefined, { expireDate })).rejects.toBeInstanceOf(ArgumentsRequired);
        expect(fake.requests()).toHaveLength(0);
    });

    it('OCO 는 양쪽 매도 지정가 브래킷이다', async () => {
        const fake = installFakeToss({ 'POST /api/v1/conditional-orders': jsonOk({ conditionalOrderId: 'COND-1' }) });
        const order = await makeToss().createOrder('005930', 'limit', 'sell', 10, 79900, {
            triggerPrice: 80000, conditionalType: 'OCO', expireDate,
            second: { side: 'sell', triggerPrice: 65000, price: 64900 },
        });
        expect(order.id).toBe('COND-1');
        const body = conditionalBody(fake);
        expect(body).toMatchObject({ type: 'OCO', orderType: 'LIMIT', quantity: '10' });
        expect(body.first).toEqual({ orderSide: 'SELL', triggerPrice: '80000', orderPrice: '79900' });
        expect(body.second).toEqual({ orderSide: 'SELL', triggerPrice: '65000', orderPrice: '64900' });
    });

    it.each([
        ['OCO second 누락', { triggerPrice: 80000, conditionalType: 'OCO', expireDate }, 'limit', 79900, /second/],
        ['OCO 매수 leg', { triggerPrice: 80000, conditionalType: 'OCO', expireDate, second: { side: 'sell', triggerPrice: 65000, price: 64900 } }, 'limit', 79900, /SELL/],
        ['MARKET 은 SINGLE 만', { triggerPrice: 80000, conditionalType: 'OCO', expireDate, second: { side: 'sell', triggerPrice: 65000 } }, 'market', undefined, /SINGLE/],
        ['LIMIT 인데 orderPrice 누락', { triggerPrice: 65000, expireDate }, 'limit', undefined, /orderPrice/],
    ])('%s 은 요청 없이 OrderNotSent 로 막는다', async (_label, params, type, price, message) => {
        const fake = installFakeToss({});
        const side = _label === 'OCO 매수 leg' ? 'buy' : 'sell';
        await expect(makeToss().createOrder('005930', type as 'limit' | 'market', side, 10, price, params)).rejects.toThrow(message);
        await expect(makeToss().createOrder('005930', type as 'limit' | 'market', side, 10, price, params)).rejects.toBeInstanceOf(OrderNotSent);
        expect(fake.requests()).toHaveLength(0);
    });

    it('만료일이 없으면 ArgumentsRequired', async () => {
        installFakeToss({});
        await expect(makeToss().createOrder('005930', 'market', 'sell', 10, undefined, { triggerPrice: 65000 })).rejects.toThrow(ArgumentsRequired);
    });

    it('조건주문 등록 응답에 id 가 없으면 접수 여부를 모르는 것으로 본다', async () => {
        installFakeToss({ 'POST /api/v1/conditional-orders': jsonOk({}) });
        await expect(makeToss().createOrder('005930', 'market', 'sell', 10, undefined, { triggerPrice: 65000, expireDate })).rejects.toBeInstanceOf(OrderOutcomeUnknown);
    });
});
