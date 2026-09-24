/**
 * KB증권: 공통 계약 스위트(`__tests__/support/broker-contract-suite.ts`)를 실제 `kbsec` 클래스에 돌린다.
 * 이 파일은 KB 요청을 어떻게 가짜로 응답하는지(하네스)만 안다. 계약의 내용은 스위트 머리말에 있다.
 */
import { beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { InsufficientFunds, InvalidOrder, PermissionDenied } from '../../base/errors';
import { resetMarketCalendar } from '../../market-calendar';
import { defineBrokerContractSuite, type BrokerContractHarness } from '../../__tests__/support/broker-contract-suite';
import { KBSEC_ERROR_DETAIL } from '../kbsec-error-codes';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, bizError, jsonOk, tokenOk } from './support/kbsec-fetch';

type OrderMode =
    | { type: 'accepted' }
    | { type: 'business'; code: string; message: string }
    | { type: 'network'; code: string };

const state: { order: OrderMode; balanceFails: boolean; readFailure: string | undefined; orderRequests: number } = {
    order: { type: 'accepted' }, balanceFails: false, readFailure: undefined, orderRequests: 0,
};

const connectionError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

function route(): void {
    mockFetch.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/oauth2/token')) return tokenOk();
        const tr = u.split('/api/v1/')[1] ?? '';
        if (tr === KBSEC_TR.BUY_KR.toLowerCase()) {
            state.orderRequests += 1;
            if (state.order.type === 'network') throw connectionError(state.order.code);
            if (state.order.type === 'business') return bizError(state.order.message, state.order.code);
            return jsonOk({ ordr_no: '0000012345' });
        }
        if (tr === KBSEC_TR.DEPOSIT.toLowerCase() && state.balanceFails) throw connectionError('UND_ERR_CONNECT_TIMEOUT');
        if (tr === KBSEC_TR.QUOTE_KR.toLowerCase() && state.readFailure !== undefined) throw connectionError(state.readFailure);
        return jsonOk({});
    });
}

/** 체결 확정 조회 간격을 0 으로 둔 인스턴스. 시도 횟수는 그대로다. */
const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0, options: { confirmBudget: { intervalMs: 0 } } });

const businessOrder = (code: string, message: string) => () => { state.order = { type: 'business', code, message }; };

const OPEN = new Date('2026-09-22T01:30:00Z'); // 화요일 10:30 KST, 정규장
const CLOSED = new Date('2026-09-22T12:00:00Z'); // 21:00 KST, 장 종료 뒤

const harness: BrokerContractHarness = {
    name: 'KB증권',
    reset() {
        state.order = { type: 'accepted' };
        state.balanceFails = false;
        state.readFailure = undefined;
        state.orderRequests = 0;
        mockFetch.mockReset();
        route();
        __resetKbsecTokenBreaker();
        resetMarketCalendar();
        vi.setSystemTime(OPEN);
    },
    placeOrder: () => newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000),
    fetchTicker: () => newExchange().fetchTicker('005930/KRW'),
    fetchBalance: () => newExchange().fetchBalance(),
    classified: [
        { label: '권한 없음(I446)', wire: businessOrder('I446', 'API 사용 권한이 없습니다.'), error: PermissionDenied },
        { label: '주문단가 오류(1896)', wire: businessOrder('1896', '주문단가를 확인하십시오'), error: InvalidOrder, detail: KBSEC_ERROR_DETAIL.PRICE_INVALID },
        { label: '증거수량 부족(1951)', wire: businessOrder('1951', '증거수량이 부족하여 주문불가합니다'), error: InsufficientFunds, detail: KBSEC_ERROR_DETAIL.INSUFFICIENT_POSITION },
    ],
    wireUnclassifiedBusinessError: businessOrder('9999', '알 수 없는 거절'),
    wireOrderNetworkFailure: (code) => { state.order = { type: 'network', code }; },
    wireReadNetworkFailure: (code) => { state.readFailure = code; },
    wireOrderAccepted: () => { state.order = { type: 'accepted' }; },
    setMarketOpen: (open) => { vi.setSystemTime(open ? OPEN : CLOSED); },
    orderRequestsSent: () => state.orderRequests,
    wireBalanceFailure: () => { state.balanceFails = true; },
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
    vi.useRealTimers();
});

defineBrokerContractSuite(harness);
