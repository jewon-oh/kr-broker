/**
 * @fileoverview 토스증권: 공통 계약 스위트(`__tests__/support/broker-contract-suite.ts`)를 실제 `toss` 클래스에 돌린다.
 * 이 파일은 토스 요청을 어떻게 가짜로 응답하는지(하네스)만 안다. 계약의 내용은 스위트 머리말에 있다.
 *
 * 스위트 뒤에는 토스에만 해당하는 계약이 이어진다: 연결 오류의 원인 코드가 오류 사슬에 남고, 업무 오류의 원문 메시지가 오류에 남는다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { orderable } = vi.hoisted(() => ({ orderable: { value: true } }));
vi.mock('../toss-trading-hours', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../toss-trading-hours')>()),
    isTossOrderable: () => orderable.value,
}));

import { InsufficientFunds, InvalidOrder, RateLimitExceeded } from '../../base';
import { defineBrokerContractSuite, type BrokerContractHarness } from '../../__tests__/support/broker-contract-suite';
import { errorReply, installFakeToss, jsonOk, makeToss, networkFailure, type FakeToss, type Route } from './support/toss-fake';

/** 경로마다 다음 요청에 줄 응답. `wire*` 가 바꾼다. */
const state: { order: Route; balance: Route; ticker: Route; server: FakeToss | undefined } = {
    order: jsonOk({ orderId: 'OID-1' }),
    balance: jsonOk({ items: [] }),
    ticker: jsonOk([{ symbol: '005930', lastPrice: '70000' }]),
    server: undefined,
};

/** 상태를 초기 값으로 되돌리고 가짜 서버를 새로 세운다. 캘린더 경로는 없어서 장 시간은 정적 판정(`orderable`)이 정한다. */
function reset(): void {
    orderable.value = true;
    state.order = jsonOk({ orderId: 'OID-1' });
    state.balance = jsonOk({ items: [] });
    state.ticker = jsonOk([{ symbol: '005930', lastPrice: '70000' }]);
    state.server = installFakeToss({
        'POST /api/v1/orders': (request) => (typeof state.order === 'function' ? state.order(request) : state.order),
        'GET /api/v1/holdings': (request) => (typeof state.balance === 'function' ? state.balance(request) : state.balance),
        'GET /api/v1/buying-power': jsonOk({ cashBuyingPower: '0' }),
        'GET /api/v1/prices': (request) => (typeof state.ticker === 'function' ? state.ticker(request) : state.ticker),
    });
}

const businessOrder = (status: number, code: string, message?: string) => () => { state.order = errorReply(status, code, message); };

const harness: BrokerContractHarness = {
    name: '토스증권',
    reset,
    placeOrder: () => makeToss().createOrder('005930', 'limit', 'buy', 1, 70000, { confirmExecution: false }),
    fetchTicker: () => makeToss().fetchTicker('005930'),
    fetchBalance: () => makeToss().fetchBalance(),
    classified: [
        { label: '거래 정지 종목(422 stock-restricted)', wire: businessOrder(422, 'stock-restricted'), error: InvalidOrder, detail: 'stock-restricted' },
        { label: '매수 가능 금액 부족(422 insufficient-buying-power)', wire: businessOrder(422, 'insufficient-buying-power'), error: InsufficientFunds, detail: 'insufficient-buying-power' },
        { label: '주문 금액 상한 초과(422 max-order-amount-exceeded)', wire: businessOrder(422, 'max-order-amount-exceeded'), error: InvalidOrder, detail: 'max-order-amount-exceeded' },
        { label: '호출 빈도 제한(429 rate-limit-exceeded)', wire: businessOrder(429, 'rate-limit-exceeded'), error: RateLimitExceeded, detail: 'rate-limit-exceeded' },
    ],
    wireUnclassifiedBusinessError: businessOrder(422, 'something-new', '새 오류'),
    wireOrderNetworkFailure: (code) => { state.order = () => networkFailure(code); },
    wireReadNetworkFailure: (code) => { state.ticker = () => networkFailure(code); },
    wireOrderAccepted: () => { state.order = jsonOk({ orderId: 'OID-1' }); },
    setMarketOpen: (open) => { orderable.value = open; },
    orderRequestsSent: () => state.server?.requestsTo('POST /api/v1/orders').length ?? 0,
    wireBalanceFailure: () => { state.balance = errorReply(500, 'internal-error'); },
    cancelAllTargets: { canceled: 'OID-A', rejected: 'OID-B' },
    async cancelAllWithOneRejected() {
        const open = (orderId: string) => ({
            orderId, symbol: '005930', side: 'BUY', orderType: 'LIMIT', status: 'PENDING', price: '70000', quantity: '1', currency: 'KRW',
            orderedAt: '2026-03-25T01:00:00Z', execution: { filledQuantity: '0' },
        });
        state.server = installFakeToss({
            'GET /api/v1/orders': jsonOk({ orders: [open('OID-A'), open('OID-B')] }),
            'POST /api/v1/orders/OID-A/cancel': jsonOk({ orderId: 'OID-C' }),
            'POST /api/v1/orders/OID-B/cancel': errorReply(422, 'something-new', '취소 거절'),
        });
        return makeToss().cancelAllOrders();
    },
};

defineBrokerContractSuite(harness);

describe('토스증권 고유 계약', () => {
    beforeEach(reset);

    it('주문 요청의 연결 오류는 원인 코드를 오류 사슬에 남긴다', async () => {
        for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET']) {
            harness.wireOrderNetworkFailure(code);
            const error = await harness.placeOrder().catch((e: unknown) => e) as Error;
            const transport = (error.cause as Error).cause as { cause?: { code?: string } };
            expect(transport.cause?.code, code).toBe(code);
        }
    });

    it('업무 오류의 원문 메시지가 오류에 남는다', async () => {
        harness.wireUnclassifiedBusinessError();

        const error = await harness.placeOrder().catch((e: unknown) => e) as Error;

        expect(error.message).toContain('새 오류');
    });

    it('접수 응답에 주문번호가 없으면 접수 여부를 모르는 오류다', async () => {
        state.order = jsonOk({});

        const error = await harness.placeOrder().catch((e: unknown) => e) as Error;

        expect(error.name).toBe('OrderOutcomeUnknown');
    });
});
