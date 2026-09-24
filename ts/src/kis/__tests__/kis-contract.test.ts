/**
 * 한국투자증권: 공통 계약 스위트(`__tests__/support/broker-contract-suite.ts`)를 실제 `kis` 클래스에 돌린다.
 * 이 파일은 KIS 요청을 어떻게 가짜로 응답하는지(하네스)만 안다. 계약의 내용은 스위트 머리말에 있다.
 *
 * 스위트 뒤에는 KIS 에만 해당하는 계약이 이어진다: 조회는 연결 오류를 몇 번 다시 보내고, 보유가 없는 잔고는 실패가 아니다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch, tradable } = vi.hoisted(() => ({ mockFetch: vi.fn(), tradable: { value: true } }));

vi.mock('../kis-trading-hours', () => ({
    checkKRXTradingHours: () => (tradable.value ? { tradable: true, reason: '' } : { tradable: false, reason: '장 마감' }),
    getKrxMarketPhase: () => 'regular',
    isNxtExtendedTradable: () => false,
}));
vi.mock('../us-market-hours', () => ({ getUsMarketPhase: () => 'regular', formatEtWallClock: () => '10:00 ET' }));
global.fetch = mockFetch as unknown as typeof fetch;

import { NetworkError, RateLimitExceeded } from '../../base/errors';
import { defineBrokerContractSuite, type BrokerContractHarness } from '../../__tests__/support/broker-contract-suite';
import { businessError, dataOk, jsonResponse, newKis, tokenOk } from './support/kis-test-utils';

const ORDER_PATH = '/trading/order-cash';
const BALANCE_PATH = '/trading/inquire-balance';
const PRICE_PATH = '/quotations/inquire-price';

type OrderMode =
    | { type: 'accepted' }
    | { type: 'business'; msgCd: string; msg1: string }
    | { type: 'network'; code: string };

const state: { order: OrderMode; balanceFails: boolean; readFailure: string | undefined; orderRequests: number } = {
    order: { type: 'accepted' }, balanceFails: false, readFailure: undefined, orderRequests: 0,
};

const connectionError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

function route(): void {
    mockFetch.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/oauth2/tokenP')) return tokenOk('t');
        if (u.includes(ORDER_PATH)) {
            state.orderRequests += 1;
            if (state.order.type === 'network') throw connectionError(state.order.code);
            if (state.order.type === 'business') return businessError(state.order.msgCd, state.order.msg1);
            return jsonResponse({ rt_cd: '0', msg_cd: 'APBK0013', msg1: '주문 전송 완료', output: { KRX_FWDG_ORD_ORGNO: '91252', ODNO: '0000066666', ORD_TMD: '121052' } });
        }
        if (u.includes(BALANCE_PATH) && state.balanceFails) throw connectionError('UND_ERR_CONNECT_TIMEOUT');
        if (u.includes(PRICE_PATH) && state.readFailure !== undefined) throw connectionError(state.readFailure);
        return dataOk({ output: {}, output1: [], output2: [{}] });
    });
}

const businessOrder = (msgCd: string, msg1: string) => () => { state.order = { type: 'business', msgCd, msg1 }; };

const harness: BrokerContractHarness = {
    name: '한국투자증권',
    reset() {
        state.order = { type: 'accepted' };
        state.balanceFails = false;
        state.readFailure = undefined;
        state.orderRequests = 0;
        tradable.value = true;
        mockFetch.mockReset();
        route();
    },
    placeOrder: () => newKis().createOrder('005930', 'limit', 'buy', 1, 70000),
    fetchTicker: () => newKis().fetchTicker('005930'),
    fetchBalance: () => newKis().fetchBalance({ scope: 'kr' }),
    classified: [
        { label: '초당 거래건수 초과(EGW00201)', wire: businessOrder('EGW00201', '초당 거래건수를 초과하였습니다.'), error: RateLimitExceeded, detail: 'EGW00201' },
    ],
    wireUnclassifiedBusinessError: businessOrder('APBK0919', '알 수 없는 거절'),
    wireOrderNetworkFailure: (code) => { state.order = { type: 'network', code }; },
    wireReadNetworkFailure: (code) => { state.readFailure = code; },
    wireOrderAccepted: () => { state.order = { type: 'accepted' }; },
    setMarketOpen: (open) => { tradable.value = open; },
    orderRequestsSent: () => state.orderRequests,
    wireBalanceFailure: () => { state.balanceFails = true; },
};

defineBrokerContractSuite(harness);

describe('한국투자증권 고유 계약', () => {
    beforeEach(() => harness.reset());

    it('조회의 연결 오류는 다시 보내고, 끝내 실패하면 NetworkError 다', async () => {
        state.readFailure = 'ECONNRESET';

        await expect(newKis().fetchTicker('005930')).rejects.toThrow(NetworkError);

        expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes(PRICE_PATH))).toHaveLength(4); // 최초 + 재시도 3회
    });

    it('원문 메시지가 오류에 남는다', async () => {
        state.order = { type: 'business', msgCd: 'APBK0919', msg1: '알 수 없는 거절' };

        const error = await harness.placeOrder().catch((e: unknown) => e) as Error;

        expect(error.message).toContain('알 수 없는 거절');
    });

    it('보유가 없으면 빈 잔고다(실패가 아니다)', async () => {
        const balances = await newKis().fetchBalance({ scope: 'kr', orderable: false });

        expect(Object.keys(balances).filter((k) => !['info', 'free', 'used', 'total', 'timestamp', 'datetime'].includes(k))).toEqual(['KRW']);
    });
});
