/**
 * 확장세션 시장가는 직전가 지정가로 바꿔 낸다. 그 지정가가 체결되지 않은 채 남으면 다음 시도가 "같은 방향 미체결 있음"으로 건너뛰어져 첫 기준가에 묶인다.
 * `options.extendedSessionReplaceOpen` 을 켜면 그 낡은 미체결을 현재가로 바꾼다(정정이 먼저, 정정할 수 없으면 취소를 확인한 뒤 새로 낸다).
 * 기본(꺼짐)은 종전처럼 건너뛴다. 이 파일은 켰을 때 이중 주문이 생기지 않는 경계를 고정한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { orderable } = vi.hoisted(() => ({ orderable: { value: false } }));

vi.mock('../toss-trading-hours', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../toss-trading-hours')>()),
    isTossOrderable: () => orderable.value,
}));

import { OrderNotSent } from '../toss-errors';
import { errorReply, installFakeToss, jsonOk, makeToss, type FakeToss, type Route } from './support/toss-fake';

beforeEach(() => { orderable.value = false; });

const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const open = (): { startTime: string; endTime: string } => ({ startTime: iso(-HOUR), endTime: iso(3 * HOUR) });
const krCalendar = (): Route => jsonOk({ today: { date: '2026-08-03', integrated: { afterMarket: open() } } });
const usCalendar = (): Route => jsonOk({ today: { date: '2026-08-03', dayMarket: open() } });

/** 미체결 목록의 주문 하나(`GET /orders`). */
const stale = (o: Partial<{ orderId: string; symbol: string; price: string; quantity: string; filled: string; side: string }> = {}) => ({
    orderId: 'STALE-1', symbol: '005930', side: 'SELL', orderType: 'LIMIT', status: 'PENDING', price: '70000', quantity: '3',
    execution: { filledQuantity: o.filled ?? '0' }, ...o,
});

const OPTIONS = { nxtRouting: true, extendedSessionReplaceOpen: true } as const;

interface Scenario {
    openOrders?: unknown[];
    /** `GET /orders/STALE-1` 응답을 호출 순서대로. 마지막 값을 반복한다. */
    details?: Route[];
    modify?: Route;
    cancel?: Route;
    lastPrice?: string;
}

function krAfterMarket(s: Scenario = {}): FakeToss {
    let detailCalls = 0;
    const details = s.details ?? [jsonOk(stale())];
    return installFakeToss({
        'GET /api/v1/market-calendar/KR': krCalendar(),
        'GET /api/v1/prices': jsonOk([{ symbol: '005930', lastPrice: s.lastPrice ?? '70500' }]),
        'GET /api/v1/orders': jsonOk({ orders: s.openOrders ?? [stale()], hasNext: false, nextCursor: null }),
        'GET /api/v1/orders/STALE-1': () => details[Math.min(detailCalls++, details.length - 1)] as never,
        'POST /api/v1/orders/STALE-1/modify': s.modify ?? jsonOk({ orderId: 'EDITED-1' }),
        'POST /api/v1/orders/STALE-1/cancel': s.cancel ?? jsonOk({ orderId: 'CXL-1' }),
        'POST /api/v1/orders': jsonOk({ orderId: 'NEW-1' }),
    });
}

const posts = (fake: FakeToss, path: string): number => fake.requestsTo(`POST /api/v1/${path}`).length;
const sell = (options: Record<string, unknown> = OPTIONS) => makeToss({ options }).createOrder('005930', 'market', 'sell', 3, undefined, { confirmExecution: false });
const rejection = async (promise: Promise<unknown>): Promise<Error> => (await promise.then(() => undefined, (e: unknown) => e)) as Error;

describe('extendedSessionReplaceOpen — 꺼짐이 기본이다', () => {
    it('★옵션이 꺼져 있으면 종전처럼 건너뛰고 정정·취소 요청을 보내지 않는다', async () => {
        const fake = krAfterMarket();

        const error = await rejection(sell({ nxtRouting: true }));

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(error.message).toContain('중복 발주 스킵');
        expect(posts(fake, 'orders')).toBe(0);
        expect(posts(fake, 'orders/STALE-1/modify')).toBe(0);
        expect(posts(fake, 'orders/STALE-1/cancel')).toBe(0);
    });
});

describe('extendedSessionReplaceOpen — 정정이 먼저다', () => {
    it('★낡은 지정가를 현재가로 정정하고 새 주문은 내지 않는다 — 정정된 주문이 결과다', async () => {
        const fake = krAfterMarket();

        const order = await sell();

        expect(posts(fake, 'orders/STALE-1/modify')).toBe(1);
        expect(fake.requestsTo('POST /api/v1/orders/STALE-1/modify')[0]!.body).toMatchObject({ orderType: 'LIMIT', price: '70500', quantity: '3' });
        expect(posts(fake, 'orders')).toBe(0); // 두 주문이 동시에 서지 않는다
        expect(posts(fake, 'orders/STALE-1/cancel')).toBe(0);
        expect(order.id).toBe('EDITED-1'); // 정정하면 주문번호가 바뀐다
        expect(order.status).toBe('open');
        expect(order.type).toBe('limit');
        expect(order.info).toMatchObject({ replacedOrderId: 'STALE-1', extendedSession: 'afterMarket', orderOpen: true });
    });

    it('미국 주간거래도 정정한다(usExtendedLimit)', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-calendar/US': usCalendar(),
            'GET /api/v1/prices': jsonOk([{ symbol: 'XOM', lastPrice: '80.4' }]),
            'GET /api/v1/orders': jsonOk({ orders: [stale({ symbol: 'XOM', price: '79.9' })], hasNext: false, nextCursor: null }),
            'GET /api/v1/orders/STALE-1': jsonOk(stale({ symbol: 'XOM', price: '79.9' })),
            'POST /api/v1/orders/STALE-1/modify': jsonOk({ orderId: 'US-EDITED' }),
            'POST /api/v1/orders': jsonOk({ orderId: 'US-NEW' }),
        });

        const order = await makeToss({ options: { usExtendedLimit: true, extendedSessionReplaceOpen: true } })
            .createOrder('XOM', 'market', 'sell', 3, undefined, { confirmExecution: false });

        expect(order.id).toBe('US-EDITED');
        expect(fake.requestsTo('POST /api/v1/orders/STALE-1/modify')[0]!.body).toMatchObject({ orderType: 'LIMIT', price: '80.4' });
        expect(posts(fake, 'orders')).toBe(0);
    });

    it('★정정이 실패하면 취소도 새 주문도 하지 않는다 — 정정이 적용됐는지 모를 수 있다', async () => {
        const fake = krAfterMarket({ modify: errorReply(422, 'something-new', '정정 거절') });

        const error = await rejection(sell());

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(error.message).toMatch(/정정에 실패해 새 주문을 보류/);
        expect(posts(fake, 'orders/STALE-1/cancel')).toBe(0);
        expect(posts(fake, 'orders')).toBe(0);
    });
});

describe('extendedSessionReplaceOpen — 정정할 수 없으면 취소를 확인한 뒤에만 새로 낸다', () => {
    /** 일부(2주) 체결된 국내 주문. 남은 수량이 이번 주문 수량(3)과 같다. 토스는 일부 체결된 국내 주문의 정정을 받지 않는다. */
    const partial = () => stale({ quantity: '5', filled: '2' });
    const detail = (status: string, filledQuantity: string) => jsonOk({ ...stale({ quantity: '5' }), status, execution: { filledQuantity } });

    it('★취소가 확정(canceled)되면 현재가로 새 주문을 낸다 — 취소 요청이 새 주문보다 먼저 나갔다', async () => {
        const fake = krAfterMarket({
            openOrders: [partial()],
            details: [detail('PARTIAL_FILLED', '2'), detail('CANCELED', '2')],
        });

        const order = await sell();

        expect(posts(fake, 'orders/STALE-1/modify')).toBe(0); // 일부 체결된 국내 주문은 정정 요청 없이 NotSupported
        expect(posts(fake, 'orders/STALE-1/cancel')).toBe(1);
        expect(posts(fake, 'orders')).toBe(1);
        const sequence = fake.requests().filter((r) => r.method === 'POST').map((r) => r.path);
        expect(sequence.indexOf('/api/v1/orders/STALE-1/cancel')).toBeLessThan(sequence.indexOf('/api/v1/orders'));
        expect(fake.requestsTo('POST /api/v1/orders')[0]!.body).toMatchObject({ orderType: 'LIMIT', price: '70500', quantity: '3' });
        expect(order.id).toBe('NEW-1');
        expect(order.info).toMatchObject({ replacedOrderId: 'STALE-1', extendedSession: 'afterMarket' });
    });

    it('★취소를 확정하지 못하면 새 주문을 내지 않는다 — 이중 주문 방지', async () => {
        const fake = krAfterMarket({
            openOrders: [partial()],
            details: [detail('PARTIAL_FILLED', '2'), detail('PENDING_CANCEL', '2')],
        });

        const error = await rejection(sell());

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(error.message).toMatch(/취소를 확정하지 못해/);
        expect(posts(fake, 'orders/STALE-1/cancel')).toBe(1);
        expect(posts(fake, 'orders')).toBe(0);
    });

    it('취소하는 사이 전량 체결됐으면(FILLED) 새 주문을 내지 않는다', async () => {
        const fake = krAfterMarket({
            openOrders: [partial()],
            details: [detail('PARTIAL_FILLED', '2'), detail('FILLED', '5')],
        });

        const error = await rejection(sell());

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(posts(fake, 'orders')).toBe(0);
    });

    it('취소하는 사이 일부가 더 체결됐으면 수량이 달라졌으므로 새 주문을 내지 않는다', async () => {
        const fake = krAfterMarket({
            openOrders: [partial()],
            details: [detail('PARTIAL_FILLED', '2'), detail('CANCELED', '3')],
        });

        const error = await rejection(sell());

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(error.message).toMatch(/1주가 체결돼/);
        expect(posts(fake, 'orders')).toBe(0);
    });

    it('취소 요청이 실패하면 새 주문을 내지 않는다', async () => {
        const fake = krAfterMarket({
            openOrders: [partial()],
            details: [detail('PARTIAL_FILLED', '2')],
            cancel: errorReply(422, 'something-new', '취소 거절'),
        });

        const error = await rejection(sell());

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(error.message).toMatch(/취소에 실패해 새 주문을 보류/);
        expect(posts(fake, 'orders')).toBe(0);
    });
});

describe('extendedSessionReplaceOpen — 같은 주문으로 보기 어려우면 건드리지 않는다', () => {
    it('같은 방향 미체결이 둘 이상이면 어느 것인지 모르므로 건드리지 않는다', async () => {
        const fake = krAfterMarket({ openOrders: [stale(), stale({ orderId: 'OTHER-2' })] });

        const error = await rejection(sell());

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(error.message).toContain('2건');
        expect(posts(fake, 'orders/STALE-1/modify')).toBe(0);
        expect(posts(fake, 'orders/STALE-1/cancel')).toBe(0);
        expect(posts(fake, 'orders')).toBe(0);
    });

    it('남은 수량이 이번 주문 수량과 다르면 남의 주문일 수 있으므로 건드리지 않는다', async () => {
        const fake = krAfterMarket({ openOrders: [stale({ quantity: '10' })] });

        const error = await rejection(sell());

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(error.message).toMatch(/남은 수량\(10\)이 이번 주문 수량\(3\)과 달라/);
        expect(posts(fake, 'orders/STALE-1/modify')).toBe(0);
        expect(posts(fake, 'orders/STALE-1/cancel')).toBe(0);
    });

    it('이미 현재가에 걸려 있으면 바꿀 이유가 없으므로 기다린다', async () => {
        const fake = krAfterMarket({ openOrders: [stale({ price: '70500' })] });

        const error = await rejection(sell());

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(error.message).toContain('이미 현재가(70500)에 걸려 있어 대기');
        expect(posts(fake, 'orders/STALE-1/modify')).toBe(0);
        expect(posts(fake, 'orders')).toBe(0);
    });

    it('미체결 조회가 실패하면 종전처럼 보류한다', async () => {
        installFakeToss({
            'GET /api/v1/market-calendar/KR': krCalendar(),
            'GET /api/v1/orders': errorReply(500, 'internal', '장애'),
        });

        const error = await rejection(sell());

        expect(error).toBeInstanceOf(OrderNotSent);
        expect(error.message).toContain('미체결 주문 조회 실패');
    });

    it('반대 방향 미체결은 건드리지 않고 종전처럼 새로 낸다', async () => {
        const fake = krAfterMarket({ openOrders: [stale({ side: 'BUY' })] });

        const order = await sell();

        expect(order.id).toBe('NEW-1');
        expect(posts(fake, 'orders/STALE-1/modify')).toBe(0);
        expect(posts(fake, 'orders/STALE-1/cancel')).toBe(0);
    });
});
