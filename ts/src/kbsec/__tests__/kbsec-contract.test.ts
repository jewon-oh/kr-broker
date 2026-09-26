/**
 * KB증권: 공통 계약 스위트(`__tests__/support/broker-contract-suite.ts`)를 실제 `kbsec` 클래스에 돌린다.
 * 이 파일은 KB 요청을 어떻게 가짜로 응답하는지(하네스)만 안다. 계약의 내용은 스위트 머리말에 있다.
 */
import { beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { InsufficientFunds, InvalidOrder, PermissionDenied } from '../../base/errors';
import { defineBrokerContractSuite, type BrokerContractHarness } from '../../__tests__/support/broker-contract-suite';
import { KBSEC_ERROR_DETAIL } from '../kbsec-error-codes';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker, resetMarketCalendar } from '../../testing';
import { CREDS, bizError, jsonOk, tokenOk } from './support/kbsec-fetch';

type OrderMode =
    | { type: 'accepted' }
    | { type: 'business'; code: string; message: string }
    | { type: 'network'; code: string };

const state: {
    order: OrderMode;
    balanceFails: boolean;
    readFailure: string | undefined;
    orderRequests: number;
    /** 해외 보유 행. 있으면 잔고 조회가 국내·해외 보유 종목과 현금을 함께 준다. */
    overseasHoldings: Record<string, string>[] | undefined;
} = {
    order: { type: 'accepted' }, balanceFails: false, readFailure: undefined, orderRequests: 0, overseasHoldings: undefined,
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
        if (state.overseasHoldings !== undefined) {
            if (tr === KBSEC_TR.DEPOSIT.toLowerCase()) return jsonOk({ ordr_psbl_csh: '5000000' });
            if (tr === KBSEC_TR.ASSET_EVAL.toLowerCase()) return jsonOk({ Record2: [{ is_cd: 'A005930', is_nm: '삼성전자', ec_q: '10', ordr_psbl_q: '8', val_amt: '700000' }] });
            if (tr === KBSEC_TR.HOLDINGS_US.toLowerCase()) {
                return jsonOk({ Record1: [{ crncy_clsf_nm: 'USD', tfnd: '1000.00', ordr_psbl_amt_p2: '850.50' }], Record2: state.overseasHoldings });
            }
        }
        return jsonOk({});
    });
}

/** 국내·해외 보유 종목과 현금이 함께 있는 잔고를 조회한다. */
function fetchBalanceWith(overseasHoldings: Record<string, string>[]) {
    state.overseasHoldings = overseasHoldings;
    return newExchange().fetchBalance();
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
        state.overseasHoldings = undefined;
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
    cancelAllTargets: { canceled: 'O1', rejected: 'O2' },
    async cancelAllWithOneRejected() {
        const rows = [
            { ordr_no: 'O1', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '1', nccls_q: '1', sor_ordr_ccd: 'K' },
            { ordr_no: 'O2', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '1', nccls_q: '1', sor_ordr_ccd: 'K' },
        ];
        mockFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
            const u = String(url);
            if (u.includes('/oauth2/token')) return tokenOk();
            const tr = u.split('/api/v1/')[1] ?? '';
            if (tr === KBSEC_TR.TRADES_KR.toLowerCase()) return jsonOk({ Record1: rows });
            if (tr === KBSEC_TR.CANCEL_KR.toLowerCase()) {
                const target = (JSON.parse(init?.body ?? '{}') as { dataBody?: { orgn_ordr_no?: string } }).dataBody?.orgn_ordr_no;
                return target === 'O2' ? bizError('취소할 수 없는 주문입니다') : jsonOk({ ordr_no: 'C1' });
            }
            return jsonOk({});
        });
        return newExchange().cancelAllOrders('005930/KRW');
    },
    fetchBalanceWithHoldings: () => fetchBalanceWith([{ is_cd: 'JNJ', is_nm: '존슨앤드존슨', frgn_hld_q_p6: '2', now_prc_p4: '366.0000' }]),
    fetchBalanceWithCollidingKey: () => fetchBalanceWith([{ is_cd: 'USD', is_nm: '프로셰어즈 울트라 반도체', frgn_hld_q_p6: '2', now_prc_p4: '45.0000' }]),
    fetchBalanceWithUnlistedCollidingKey: () => fetchBalanceWith([{ is_cd: 'KRW', is_nm: '표에 없는 겹침', frgn_hld_q_p6: '1', now_prc_p4: '10.0000' }]),
    market: (symbol) => newExchange().market(symbol),
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
    vi.useRealTimers();
});

defineBrokerContractSuite(harness);
