/**
 * KIS 확장 계좌 조회와 확장 주문: 국내 선물옵션, 장내채권, 해외선물옵션 계좌 조회와 채권, 선물옵션, 신용, 예약, 미국 주간, 해외 예약 주문.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, BadSymbol, InvalidOrder, NotSupported } from '../../base/errors';
import { bodyOf, dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import type { kis } from '../../kis';

const newKis = (sandbox = false) => newKisBase({ sandbox, masterData: KIS_MASTER_FIXTURE });

/** 테스트 계좌(`12345678-01`)의 입력. */
const ACCOUNT = { CANO: '12345678', ACNT_PRDT_CD: '01' };

beforeEach(() => {
    mockFetch.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

/** 경로가 들어간 첫 호출의 순번. */
const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index][0])).searchParams);

/** KST 2026-09-23 10:15:30 에 고정한다. */
const fixKst = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T01:15:30Z'));
};

const SEP1 = Date.parse('2026-09-01T00:00:00+09:00');

interface QueryCase {
    name: string;
    path: string;
    tr: string;
    call: (k: kis) => Promise<unknown>;
    query: Record<string, string>;
}

const QUERY_CASES: QueryCase[] = [
    { name: 'fetchDerivativeBalance', path: '/domestic-futureoption/v1/trading/inquire-balance', tr: 'CTFO6118R', call: (k) => k.fetchDerivativeBalance(),
        query: { ...ACCOUNT, MGNA_DVSN: '01', EXCC_STAT_CD: '1', CTX_AREA_FK200: '', CTX_AREA_NK200: '' } },
    { name: 'fetchDerivativeSettlementPnl', path: '/domestic-futureoption/v1/trading/inquire-balance-settlement-pl', tr: 'CTFO6117R', call: (k) => k.fetchDerivativeSettlementPnl(),
        query: { ...ACCOUNT, INQR_DT: '20260923', CTX_AREA_FK200: '', CTX_AREA_NK200: '' } },
    { name: 'fetchDerivativeValuationPnl', path: '/domestic-futureoption/v1/trading/inquire-balance-valuation-pl', tr: 'CTFO6159R', call: (k) => k.fetchDerivativeValuationPnl(),
        query: { ...ACCOUNT, MGNA_DVSN: '01', EXCC_STAT_CD: '1', CTX_AREA_FK200: '', CTX_AREA_NK200: '' } },
    { name: 'fetchDerivativeOrders', path: '/domestic-futureoption/v1/trading/inquire-ccnl', tr: 'TTTO5201R', call: (k) => k.fetchDerivativeOrders(SEP1),
        query: { ...ACCOUNT, STRT_ORD_DT: '20260901', END_ORD_DT: '20260923', SLL_BUY_DVSN_CD: '00', CCLD_NCCS_DVSN: '00', SORT_SQN: 'DS', PDNO: '', STRT_ODNO: '', MKET_ID_CD: '', CTX_AREA_FK200: '', CTX_AREA_NK200: '' } },
    { name: 'fetchDerivativeFillsByDate', path: '/domestic-futureoption/v1/trading/inquire-ccnl-bstime', tr: 'CTFO5139R', call: (k) => k.fetchDerivativeFillsByDate({ until: Date.parse('2026-09-22T03:00:00Z') }),
        query: { ...ACCOUNT, ORD_DT: '20260922', FUOP_TR_STRT_TMD: '000000', FUOP_TR_END_TMD: '240000', CTX_AREA_FK200: '', CTX_AREA_NK200: '' } },
    { name: 'fetchDerivativeDailyFees', path: '/domestic-futureoption/v1/trading/inquire-daily-amount-fee', tr: 'CTFO6119R', call: (k) => k.fetchDerivativeDailyFees(SEP1),
        query: { ...ACCOUNT, INQR_STRT_DAY: '20260901', INQR_END_DAY: '20260923', CTX_AREA_FK200: '', CTX_AREA_NK200: '' } },
    { name: 'fetchNightDerivativeBalance', path: '/domestic-futureoption/v1/trading/inquire-ngt-balance', tr: 'CTFN6118R', call: (k) => k.fetchNightDerivativeBalance(),
        query: { ...ACCOUNT, MGNA_DVSN: '01', EXCC_STAT_CD: '1', ACNT_PWD: '', CTX_AREA_FK200: '', CTX_AREA_NK200: '' } },
    { name: 'fetchNightDerivativeOrders', path: '/domestic-futureoption/v1/trading/inquire-ngt-ccnl', tr: 'STTN5201R', call: (k) => k.fetchNightDerivativeOrders(SEP1),
        query: {
            ...ACCOUNT, STRT_ORD_DT: '20260901', END_ORD_DT: '20260924', SLL_BUY_DVSN_CD: '00', CCLD_NCCS_DVSN: '00', SORT_SQN: '', STRT_ODNO: '', PDNO: '', MKET_ID_CD: '',
            FUOP_DVSN_CD: '', SCRN_DVSN: '02', CTX_AREA_FK200: '', CTX_AREA_NK200: '',
        } },
    { name: 'fetchNightDerivativeMargin', path: '/domestic-futureoption/v1/trading/ngt-margin-detail', tr: 'CTFN7107R', call: (k) => k.fetchNightDerivativeMargin(),
        query: { ...ACCOUNT, MGNA_DVSN_CD: '01' } },
    { name: 'fetchBondOrders', path: '/domestic-bond/v1/trading/inquire-daily-ccld', tr: 'CTSC8013R', call: (k) => k.fetchBondOrders(SEP1),
        query: { ...ACCOUNT, INQR_STRT_DT: '20260901', INQR_END_DT: '20260923', SLL_BUY_DVSN_CD: '%', SORT_SQN_DVSN: '01', PDNO: '', NCCS_YN: 'N', CTX_AREA_NK200: '', CTX_AREA_FK200: '' } },
    { name: 'fetchOverseasDerivativeFills', path: '/overseas-futureoption/v1/trading/inquire-daily-ccld', tr: 'OTFM3122R', call: (k) => k.fetchOverseasDerivativeFills(SEP1),
        query: {
            ...ACCOUNT, STRT_DT: '20260901', END_DT: '20260923', FUOP_DVSN_CD: '00', FM_PDGR_CD: '', CRCY_CD: '%%%', FM_ITEM_FTNG_YN: 'N', SLL_BUY_DVSN_CD: '%%',
            CTX_AREA_FK200: '', CTX_AREA_NK200: '',
        } },
    { name: 'fetchOverseasDerivativePeriodPnl', path: '/overseas-futureoption/v1/trading/inquire-period-ccld', tr: 'OTFM3118R', call: (k) => k.fetchOverseasDerivativePeriodPnl(SEP1),
        query: { INQR_TERM_FROM_DT: '20260901', INQR_TERM_TO_DT: '20260923', ...ACCOUNT, CRCY_CD: '%%%', WHOL_TRSL_YN: 'N', FUOP_DVSN: '00', CTX_AREA_FK200: '', CTX_AREA_NK200: '' } },
];

describe('블록 원문으로 돌려주는 계좌 조회', () => {
    it.each(QUERY_CASES)('$name 는 $path 를 TR $tr 로 부른다', async (c) => {
        fixKst();
        const blocks = { output1: [{ a: '1' }], output2: { b: '2' }, output3: { c: '3' } };
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk(blocks));

        const result = await c.call(newKis()) as Record<string, unknown>;

        const call = find(c.path);
        expect(headersOf(mockFetch, call).tr_id).toBe(c.tr);
        expect(queryOf(call)).toEqual(c.query);
        expect(result.output1).toEqual(blocks.output1);
        expect(result.output2).toEqual(blocks.output2);
    });

    it('모의 TR 이 있는 조회는 모의투자에서 모의 TR 을 쓴다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValue(dataOk({ output1: [], output2: {} }));

        const k = newKis(true);
        await k.fetchDerivativeBalance();
        await k.fetchDerivativeOrders(SEP1);

        expect(headersOf(mockFetch, find('/domestic-futureoption/v1/trading/inquire-balance')).tr_id).toBe('VTFO6118R');
        expect(headersOf(mockFetch, find('/domestic-futureoption/v1/trading/inquire-ccnl')).tr_id).toBe('VTTO5201R');
    });
});

describe('정리해서 돌려주는 계좌 조회', () => {
    it('fetchDerivativeDeposit 은 주요 금액을 옮긴다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { dnca_tota: '10000000', ord_psbl_cash: '8000000', ord_psbl_tota: '9000000', wdrw_psbl_tot_amt: '7000000', brkg_mgna_cash: '2000000', mtnc_rt: '350', trad_pfls_smtl: '150000', evlu_pfls_smtl: '-20000', brkg_fee: '3000', nxdy_dnca: '10100000', prsm_dpast_amt: '12000000' },
        }));

        const deposit = await newKis().fetchDerivativeDeposit();

        const call = find('/domestic-futureoption/v1/trading/inquire-deposit');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTRP6550R');
        expect(queryOf(call)).toEqual(ACCOUNT);
        expect(deposit).toMatchObject({
            deposit: 10000000, orderableCash: 8000000, orderableTotal: 9000000, withdrawable: 7000000, marginCash: 2000000, maintenanceRate: 350,
            tradingPnl: 150000, evaluationPnl: -20000, fee: 3000, nextDayDeposit: 10100000, estimatedAssets: 12000000,
        });
    });

    it('fetchDerivativeOrderable 과 야간 조회는 가격이 있으면 지정가, 없으면 시장가로 묻는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: { tot_psbl_qty: '12', lqd_psbl_qty1: '2', ord_psbl_qty: '10', bass_idx: '412.3' } }))
            .mockResolvedValueOnce(dataOk({ output: { max_ord_psbl_qty: '15', tot_psbl_qty: '12', lqd_psbl_qty: '3', ord_psbl_qty: '9', bass_idx: '412.3' } }));

        const k = newKis();
        const day = await k.fetchDerivativeOrderable('101W12', 'buy', 412.35);
        const night = await k.fetchNightDerivativeOrderable('101W12', 'sell');

        const a = find('/domestic-futureoption/v1/trading/inquire-psbl-order');
        expect(headersOf(mockFetch, a).tr_id).toBe('TTTO5105R');
        expect(queryOf(a)).toEqual({ ...ACCOUNT, PDNO: '101W12', SLL_BUY_DVSN_CD: '02', UNIT_PRICE: '412.35', ORD_DVSN_CD: '01' });
        const b = find('/domestic-futureoption/v1/trading/inquire-psbl-ngt-order');
        expect(headersOf(mockFetch, b).tr_id).toBe('STTN5105R');
        expect(queryOf(b)).toEqual({ ...ACCOUNT, PDNO: '101W12', PRDT_TYPE_CD: '301', SLL_BUY_DVSN_CD: '01', UNIT_PRICE: '0', ORD_DVSN_CD: '02' });
        expect(day).toMatchObject({ orderableQuantity: 10, totalQuantity: 12, liquidatableQuantity: 2, maxQuantity: undefined, baseIndex: 412.3 });
        expect(night).toMatchObject({ orderableQuantity: 9, liquidatableQuantity: 3, maxQuantity: 15 });
    });

    it('채권 잔고, 매수가능, 정정취소가능주문을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: [{ pdno: 'KR2033022D33', buy_dt: '20260901', buy_sqno: '1', cblc_qty: '10', agrx_qty: '10', sprx_qty: '0', exdt: '20330610', buy_erng_rt: '3.1', buy_unpr: '10050', buy_amt: '100500', ord_psbl_qty: '10' }] }))
            .mockResolvedValueOnce(dataOk({ output: { ord_psbl_cash: '1000000', ord_psbl_sbst: '0', ruse_psbl_amt: '0', bond_ord_unpr2: '10125', buy_psbl_amt: '990000', buy_psbl_qty: '97', cma_evlu_amt: '0' } }))
            .mockResolvedValueOnce(dataOk({ output: [{ odno: '0000123', pdno: 'KR2033022D33', rvse_cncl_dvsn_name: '정상', ord_qty: '10', bond_ord_unpr: '10120', ord_tmd: '101500', tot_ccld_qty: '0', tot_ccld_amt: '0', ord_psbl_qty: '10', orgn_odno: '', sll_buy_dvsn_cd: '02', ord_dvsn_cd: '01' }] }));

        const k = newKis();
        const [holding] = await k.fetchBondHoldings();
        const buyable = await k.fetchBondBuyableAmount('KR2033022D33', 10125);
        const [order] = await k.fetchBondModifiableOrders();

        expect(queryOf(find('/domestic-bond/v1/trading/inquire-balance'))).toEqual({ ...ACCOUNT, INQR_CNDT: '00', PDNO: '', BUY_DT: '', CTX_AREA_FK200: '', CTX_AREA_NK200: '' });
        expect(queryOf(find('/domestic-bond/v1/trading/inquire-psbl-order'))).toEqual({ ...ACCOUNT, PDNO: 'KR2033022D33', BOND_ORD_UNPR: '10125' });
        expect(queryOf(find('/domestic-bond/v1/trading/inquire-psbl-rvsecncl'))).toEqual({ ...ACCOUNT, ORD_DT: '', ODNO: '', CTX_AREA_FK200: '', CTX_AREA_NK200: '' });
        expect(holding).toMatchObject({ code: 'KR2033022D33', buyDate: '20260901', quantity: 10, orderableQuantity: 10, buyPrice: 10050, buyYield: 3.1, maturityDate: '20330610' });
        expect(buyable).toMatchObject({ orderableCash: 1000000, price: 10125, buyableAmount: 990000, buyableQuantity: 97 });
        expect(order).toMatchObject({ orderId: '0000123', originalOrderId: undefined, side: 'buy', quantity: 10, price: 10120, modifiableQuantity: 10, orderTime: '101500' });
    });

    it('해외선물옵션 주문내역, 예수금, 거래내역, 주문가능, 미결제, 증거금을 정리한다', async () => {
        fixKst();
        const orderRow = { ord_dt: '20260922', odno: '00360686', orgn_ord_dt: '', orgn_odno: '', ovrs_futr_fx_pdno: '6AZ26', sll_buy_dvsn_cd: '02', fm_ord_qty: '1', fm_ord_pric: '0.6512', fm_stop_ord_pric: '', fm_ccld_qty: '1', fm_ccld_pric: '0.6512', fm_ord_rmn_qty: '0', ccld_cndt_cd: '6', ccld_dtl_dtime: '20260922213000' };
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: [orderRow] }))
            .mockResolvedValueOnce(dataOk({ output: [orderRow] }))
            .mockResolvedValueOnce(dataOk({ output: { crcy_cd: 'TUS', fm_dnca_rmnd: '50000', fm_nxdy_dncl_amt: '50100', fm_tot_asst_evlu_amt: '52000', fm_lqd_pfls_amt: '120', fm_fuop_evlu_pfls_amt: '-30', fm_fee: '5', fm_rcvb_amt: '0', fm_brkg_mgn_amt: '3000', fm_mntn_mgn_amt: '2700', fm_add_mgn_amt: '0', fm_risk_rt: '5.8', fm_ord_psbl_amt: '47000', fm_drwg_psbl_amt: '46000' } }))
            .mockResolvedValueOnce(dataOk({ output: [{ bass_dt: '20260922', crcy_cd: 'USD', fm_ldgr_inog_seq: '1', fm_iofw_amt: '1000', fm_fee: '0', fm_tax_amt: '0', fm_sttl_amt: '1000', fm_bf_dncl_amt: '49000', fm_dncl_amt: '50000', rmks_text: '입금' }] }))
            .mockResolvedValueOnce(dataOk({ output: { crcy_cd: 'USD', fm_ustl_qty: '1', fm_lqd_psbl_qty: '1', fm_new_ord_psbl_qty: '15', fm_tot_ord_psbl_qty: '16', fm_mkpr_tot_ord_psbl_qty: '14' } }))
            .mockResolvedValueOnce(dataOk({ output: [{ ovrs_futr_fx_pdno: '6AZ26', prdt_type_cd: '911', crcy_cd: 'USD', sll_buy_dvsn_cd: '01', fm_ustl_qty: '1', fm_ccld_avg_pric: '0.6512', fm_now_pric: '0.6500', fm_evlu_pfls_amt: '120', fm_opt_evlu_amt: '0', fm_otp_evlu_pfls_amt: '0', fuop_dvsn: '01', fm_lqd_psbl_qty: '1' }] }))
            .mockResolvedValueOnce(dataOk({ output: { crcy_cd: 'USD', fm_ord_psbl_amt: '47000', fm_brkg_mgn_amt: '3000', fm_mntn_mgn_amt: '2700', fm_add_mgn_amt: '0', fm_ustl_mgn_amt: '3000', fm_ord_mgn_amt: '0' } }));

        const k = newKis();
        const [today] = await k.fetchOverseasDerivativeOrdersToday();
        await k.fetchOverseasDerivativeOrders(SEP1);
        const deposit = await k.fetchOverseasDerivativeDeposit('tus');
        const [transaction] = await k.fetchOverseasDerivativeTransactions(SEP1);
        const orderable = await k.fetchOverseasDerivativeOrderable('6AZ26', 'buy');
        const [position] = await k.fetchOverseasDerivativePositions();
        const margin = await k.fetchOverseasDerivativeMargin('USD', { until: Date.parse('2026-09-22T03:00:00Z') });

        expect(queryOf(find('/overseas-futureoption/v1/trading/inquire-ccld'))).toEqual({ ...ACCOUNT, CCLD_NCCS_DVSN: '01', SLL_BUY_DVSN_CD: '%%', FUOP_DVSN: '00', CTX_AREA_FK200: '', CTX_AREA_NK200: '' });
        expect(headersOf(mockFetch, find('/overseas-futureoption/v1/trading/inquire-daily-order')).tr_id).toBe('OTFM3120R');
        expect(queryOf(find('/overseas-futureoption/v1/trading/inquire-deposit'))).toEqual({ ...ACCOUNT, CRCY_CD: 'TUS', INQR_DT: '20260923' });
        expect(queryOf(find('/overseas-futureoption/v1/trading/inquire-period-trans'))).toEqual({
            INQR_TERM_FROM_DT: '20260901', INQR_TERM_TO_DT: '20260923', ...ACCOUNT, ACNT_TR_TYPE_CD: '1', CRCY_CD: '%%%', CTX_AREA_FK100: '', CTX_AREA_NK100: '', PWD_CHK_YN: '',
        });
        expect(queryOf(find('/overseas-futureoption/v1/trading/inquire-psamount'))).toEqual({ ...ACCOUNT, OVRS_FUTR_FX_PDNO: '6AZ26', SLL_BUY_DVSN_CD: '02', FM_ORD_PRIC: '', ECIS_RSVN_ORD_YN: '' });
        expect(queryOf(find('/overseas-futureoption/v1/trading/inquire-unpd'))).toEqual({ ...ACCOUNT, FUOP_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '' });
        expect(queryOf(find('/overseas-futureoption/v1/trading/margin-detail'))).toEqual({ ...ACCOUNT, CRCY_CD: 'USD', INQR_DT: '20260922' });
        expect(today).toMatchObject({ orderDate: '20260922', orderId: '00360686', originalOrderId: undefined, code: '6AZ26', side: 'buy', quantity: 1, price: 0.6512, filledQuantity: 1, remainingQuantity: 0, fillConditionCode: '6', filledAt: '20260922213000' });
        expect(deposit).toMatchObject({ currency: 'TUS', deposit: 50000, totalAssets: 52000, realizedPnl: 120, margin: 3000, riskRate: 5.8, orderable: 47000, withdrawable: 46000 });
        expect(transaction).toMatchObject({ date: '20260922', currency: 'USD', amount: 1000, depositBefore: 49000, depositAfter: 50000, remarks: '입금' });
        expect(orderable).toMatchObject({ currency: 'USD', openQuantity: 1, newOrderableQuantity: 15, totalOrderableQuantity: 16, marketTotalOrderableQuantity: 14 });
        expect(position).toMatchObject({ code: '6AZ26', side: 'sell', quantity: 1, averagePrice: 0.6512, price: 0.65, unrealizedPnl: 120, typeCode: '01' });
        expect(margin).toMatchObject({ currency: 'USD', orderable: 47000, margin: 3000, maintenanceMargin: 2700, openPositionMargin: 3000 });
    });

    it('통화와 기간 시작이 없으면 보내기 전에 거절한다', async () => {
        const k = newKis();
        await expect(k.fetchOverseasDerivativeDeposit(undefined as unknown as string)).rejects.toThrow(ArgumentsRequired);
        await expect(k.fetchOverseasDerivativeMargin('US')).rejects.toThrow(BadRequest);
        await expect(k.fetchDerivativeOrders(undefined)).rejects.toThrow(ArgumentsRequired);
        await expect(k.fetchBondBuyableAmount('KR2033022D33', undefined)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

/** 주문 확인: 경로, TR, 본문. */
interface OrderCase {
    name: string;
    path: string;
    tr: string;
    call: (k: kis) => Promise<unknown>;
    body: Record<string, string>;
}

const ORDER_CASES: OrderCase[] = [
    { name: 'createBondOrder(buy)', path: '/domestic-bond/v1/trading/buy', tr: 'TTTC0952U', call: (k) => k.createBondOrder('KR2033022D33', 'buy', 10, 10125),
        body: { ...ACCOUNT, PDNO: 'KR2033022D33', ORD_QTY2: '10', BOND_ORD_UNPR: '10125', SAMT_MKET_PTCI_YN: 'N', BOND_RTL_MKET_YN: 'N', IDCR_STFNO: '', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0', CTAC_TLNO: '' } },
    { name: 'createBondOrder(sell)', path: '/domestic-bond/v1/trading/sell', tr: 'TTTC0958U', call: (k) => k.createBondOrder('KR2033022D33', 'sell', 1, 10130.5),
        body: {
            ...ACCOUNT, PDNO: 'KR2033022D33', ORD_QTY2: '1', BOND_ORD_UNPR: '10130.5', SAMT_MKET_PTCI_YN: 'N', BOND_RTL_MKET_YN: 'N', ORD_DVSN: '01', SPRX_YN: 'N', BUY_DT: '', BUY_SEQ: '',
            SLL_AGCO_OPPS_SLL_YN: 'N', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0', CTAC_TLNO: '',
        } },
    { name: 'editBondOrder', path: '/domestic-bond/v1/trading/order-rvsecncl', tr: 'TTTC0953U', call: (k) => k.editBondOrder('0004357900', 'KR2033022D33', 10470),
        body: { ...ACCOUNT, PDNO: 'KR2033022D33', ORGN_ODNO: '0004357900', ORD_QTY2: '0', BOND_ORD_UNPR: '10470', QTY_ALL_ORD_YN: 'Y', RVSE_CNCL_DVSN_CD: '01', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0', CTAC_TLNO: '' } },
    { name: 'cancelBondOrder', path: '/domestic-bond/v1/trading/order-rvsecncl', tr: 'TTTC0953U', call: (k) => k.cancelBondOrder('0004357900', 'KR2033022D33', 3),
        body: { ...ACCOUNT, PDNO: 'KR2033022D33', ORGN_ODNO: '0004357900', ORD_QTY2: '3', BOND_ORD_UNPR: '0', QTY_ALL_ORD_YN: 'N', RVSE_CNCL_DVSN_CD: '02', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0', CTAC_TLNO: '' } },
    { name: 'createDerivativeOrder(limit)', path: '/domestic-futureoption/v1/trading/order', tr: 'TTTO1101U', call: (k) => k.createDerivativeOrder('101W12', 'limit', 'buy', 2, 412.35),
        body: {
            ORD_PRCS_DVSN_CD: '02', ...ACCOUNT, SLL_BUY_DVSN_CD: '02', SHTN_PDNO: '101W12', ORD_QTY: '2', UNIT_PRICE: '412.35', NMPR_TYPE_CD: '01', KRX_NMPR_CNDT_CD: '0',
            ORD_DVSN_CD: '01', CTAC_TLNO: '', FUOP_ITEM_DVSN_CD: '',
        } },
    { name: 'createDerivativeOrder(night market)', path: '/domestic-futureoption/v1/trading/order', tr: 'STTN1101U', call: (k) => k.createDerivativeOrder('101W12', 'market', 'sell', 1, undefined, { session: 'night' }),
        body: {
            ORD_PRCS_DVSN_CD: '02', ...ACCOUNT, SLL_BUY_DVSN_CD: '01', SHTN_PDNO: '101W12', ORD_QTY: '1', UNIT_PRICE: '0', NMPR_TYPE_CD: '02', KRX_NMPR_CNDT_CD: '0',
            ORD_DVSN_CD: '02', CTAC_TLNO: '', FUOP_ITEM_DVSN_CD: '',
        } },
    { name: 'editDerivativeOrder', path: '/domestic-futureoption/v1/trading/order-rvsecncl', tr: 'TTTO1103U', call: (k) => k.editDerivativeOrder('0000004018', 413, 1),
        body: {
            ORD_PRCS_DVSN_CD: '02', ...ACCOUNT, RVSE_CNCL_DVSN_CD: '01', ORGN_ODNO: '0000004018', ORD_QTY: '1', UNIT_PRICE: '413', NMPR_TYPE_CD: '01', KRX_NMPR_CNDT_CD: '0',
            RMN_QTY_YN: 'N', ORD_DVSN_CD: '01', FUOP_ITEM_DVSN_CD: '',
        } },
    { name: 'cancelDerivativeOrder(night)', path: '/domestic-futureoption/v1/trading/order-rvsecncl', tr: 'TTTN1103U', call: (k) => k.cancelDerivativeOrder('0000004018', undefined, { session: 'night' }),
        body: {
            ORD_PRCS_DVSN_CD: '02', ...ACCOUNT, RVSE_CNCL_DVSN_CD: '02', ORGN_ODNO: '0000004018', ORD_QTY: '0', UNIT_PRICE: '0', NMPR_TYPE_CD: '02', KRX_NMPR_CNDT_CD: '0',
            RMN_QTY_YN: 'Y', ORD_DVSN_CD: '01', FUOP_ITEM_DVSN_CD: '',
        } },
    { name: 'createCreditOrder(buy)', path: '/domestic-stock/v1/trading/order-credit', tr: 'TTTC0052U', call: (k) => k.createCreditOrder('005930/KRW', 'limit', 'buy', 3, 70000, '21'),
        body: { ...ACCOUNT, PDNO: '005930', CRDT_TYPE: '21', LOAN_DT: '20260923', ORD_DVSN: '00', ORD_QTY: '3', ORD_UNPR: '70000' } },
    { name: 'createCreditOrder(sell market)', path: '/domestic-stock/v1/trading/order-credit', tr: 'TTTC0051U', call: (k) => k.createCreditOrder('005930/KRW', 'market', 'sell', 3, undefined, '25', '20260810'),
        body: { ...ACCOUNT, PDNO: '005930', CRDT_TYPE: '25', LOAN_DT: '20260810', ORD_DVSN: '01', ORD_QTY: '3', ORD_UNPR: '0' } },
    { name: 'createReservedOrder', path: '/domestic-stock/v1/trading/order-resv', tr: 'CTSC0008U', call: (k) => k.createReservedOrder('005930/KRW', 'limit', 'buy', 1, 55000, { RSVN_ORD_END_DT: '20261002' }),
        body: { ...ACCOUNT, PDNO: '005930', ORD_QTY: '1', ORD_UNPR: '55000', SLL_BUY_DVSN_CD: '02', ORD_DVSN_CD: '00', ORD_OBJT_CBLC_DVSN_CD: '10', RSVN_ORD_END_DT: '20261002' } },
    { name: 'cancelReservedOrder', path: '/domestic-stock/v1/trading/order-resv-rvsecncl', tr: 'CTSC0009U', call: (k) => k.cancelReservedOrder('88793', '001', '20260923'),
        body: { ...ACCOUNT, RSVN_ORD_SEQ: '88793', RSVN_ORD_ORGNO: '001', RSVN_ORD_ORD_DT: '20260923' } },
    { name: 'editReservedOrder', path: '/domestic-stock/v1/trading/order-resv-rvsecncl', tr: 'CTSC0013U', call: (k) => k.editReservedOrder('88793', '001', '20260923', '005930/KRW', 'buy', 2, 55500),
        body: {
            ...ACCOUNT, RSVN_ORD_SEQ: '88793', RSVN_ORD_ORGNO: '001', RSVN_ORD_ORD_DT: '20260923', PDNO: '005930', ORD_QTY: '2', ORD_UNPR: '55500', SLL_BUY_DVSN_CD: '02',
            ORD_DVSN_CD: '00', ORD_OBJT_CBLC_DVSN_CD: '10',
        } },
    { name: 'createOverseasDerivativeOrder', path: '/overseas-futureoption/v1/trading/order', tr: 'OTFM3001U', call: (k) => k.createOverseasDerivativeOrder('6AZ26', 'limit', 'buy', 1, 0.6512),
        body: {
            ...ACCOUNT, OVRS_FUTR_FX_PDNO: '6AZ26', SLL_BUY_DVSN_CD: '02', FM_LQD_USTL_CCLD_DT: '', FM_LQD_USTL_CCNO: '', PRIC_DVSN_CD: '1', FM_LIMIT_ORD_PRIC: '0.6512',
            FM_STOP_ORD_PRIC: '', FM_ORD_QTY: '1', FM_LQD_LMT_ORD_PRIC: '', FM_LQD_STOP_ORD_PRIC: '', CCLD_CNDT_CD: '6', CPLX_ORD_DVSN_CD: '0', ECIS_RSVN_ORD_YN: 'N', FM_HDGE_ORD_SCRN_YN: 'N',
        } },
    { name: 'editOverseasDerivativeOrder', path: '/overseas-futureoption/v1/trading/order-rvsecncl', tr: 'OTFM3002U', call: (k) => k.editOverseasDerivativeOrder('00360686', '20260922', 0.652),
        body: {
            ...ACCOUNT, ORGN_ORD_DT: '20260922', ORGN_ODNO: '00360686', FM_LIMIT_ORD_PRIC: '0.652', FM_STOP_ORD_PRIC: '', FM_LQD_LMT_ORD_PRIC: '', FM_LQD_STOP_ORD_PRIC: '',
            FM_HDGE_ORD_SCRN_YN: 'N', FM_MKPR_CVSN_YN: '',
        } },
    { name: 'cancelOverseasDerivativeOrder', path: '/overseas-futureoption/v1/trading/order-rvsecncl', tr: 'OTFM3003U', call: (k) => k.cancelOverseasDerivativeOrder('00360686', '20260922'),
        body: {
            ...ACCOUNT, ORGN_ORD_DT: '20260922', ORGN_ODNO: '00360686', FM_LIMIT_ORD_PRIC: '', FM_STOP_ORD_PRIC: '', FM_LQD_LMT_ORD_PRIC: '', FM_LQD_STOP_ORD_PRIC: '',
            FM_HDGE_ORD_SCRN_YN: 'N', FM_MKPR_CVSN_YN: 'N',
        } },
    { name: 'createDaytimeOrder', path: '/overseas-stock/v1/trading/daytime-order', tr: 'TTTS6037U', call: (k) => k.createDaytimeOrder('V/USD', 'sell', 2, 330.5),
        body: { ...ACCOUNT, OVRS_EXCG_CD: 'NYSE', PDNO: 'V', ORD_QTY: '2', OVRS_ORD_UNPR: '330.5', CTAC_TLNO: '', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0', ORD_DVSN: '00' } },
    { name: 'cancelDaytimeOrder', path: '/overseas-stock/v1/trading/daytime-order-rvsecncl', tr: 'TTTS6038U', call: (k) => k.cancelDaytimeOrder('1234567890', 'AAPL/USD', 10),
        body: { ...ACCOUNT, OVRS_EXCG_CD: 'NASD', PDNO: 'AAPL', ORGN_ODNO: '1234567890', RVSE_CNCL_DVSN_CD: '02', ORD_QTY: '10', OVRS_ORD_UNPR: '0', CTAC_TLNO: '', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0' } },
    { name: 'createOverseasReservedOrder(us buy)', path: '/overseas-stock/v1/trading/order-resv', tr: 'TTTT3014U', call: (k) => k.createOverseasReservedOrder('TSLA/USD', 'buy', 1, 900),
        body: { ...ACCOUNT, PDNO: 'TSLA', OVRS_EXCG_CD: 'NASD', FT_ORD_QTY: '1', FT_ORD_UNPR3: '900' } },
    { name: 'cancelOverseasReservedOrder', path: '/overseas-stock/v1/trading/order-resv-ccnl', tr: 'TTTT3017U', call: (k) => k.cancelOverseasReservedOrder('0030008244', '20260922'),
        body: { ...ACCOUNT, RSVN_ORD_RCIT_DT: '20260922', OVRS_RSVN_ODNO: '0030008244' } },
];

describe('확장 주문', () => {
    it.each(ORDER_CASES)('$name 는 $path 에 TR $tr 로 본문을 보내고 접수 결과를 돌려준다', async (c) => {
        fixKst();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '0000117057', ORD_TMD: '101530', RSVN_ORD_SEQ: '88794', OVRS_RSVN_ODNO: '0030008245', ORD_DT: '20260922' } }));

        const ack = await c.call(newKis()) as { orderId: string };

        const call = find(c.path);
        expect(headersOf(mockFetch, call).tr_id).toBe(c.tr);
        expect(bodyOf(mockFetch, call)).toEqual(c.body);
        expect(ack.orderId).toBeDefined();
    });

    it('접수 결과는 API 마다 다른 주문번호 필드를 읽고, 소문자 필드도 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: { KRX_FWDG_ORD_ORGNO: '91252', ODNO: '0000117057', ORD_TMD: '121052' } }))
            .mockResolvedValueOnce(dataOk({ output: { rsvn_ord_seq: '88794' } }))
            .mockResolvedValueOnce(dataOk({ output: { ODNO: '0030008244', RSVN_ORD_RCIT_DT: '20260922', OVRS_RSVN_ODNO: '0030008245' } }))
            .mockResolvedValueOnce(dataOk({ output: { ORD_DT: '20260922', ODNO: '00360687' } }));

        const k = newKis();
        const bond = await k.createBondOrder('KR2033022D33', 'buy', 1, 10125);
        const reserved = await k.createReservedOrder('005930/KRW', 'market', 'sell', 1);
        const overseas = await k.createOverseasReservedOrder('AAPL/USD', 'sell', 1, 230);
        const futures = await k.createOverseasDerivativeOrder('6AZ26', 'market', 'sell', 1);

        // 응답에 주문일자가 없으면 오늘(한국 날짜)과 주문시각으로 timestamp 를 채운다.
        expect(bond).toEqual({
            timestamp: expect.any(Number), datetime: expect.any(String),
            orderId: '0000117057', orderDate: undefined, orderTime: '121052', info: { KRX_FWDG_ORD_ORGNO: '91252', ODNO: '0000117057', ORD_TMD: '121052' },
        });
        expect(reserved.orderId).toBe('88794');
        expect(overseas).toMatchObject({ orderId: '0030008245', orderDate: '20260922' });
        expect(futures).toMatchObject({ orderId: '00360687', orderDate: '20260922' });
        expect(bodyOf(mockFetch, find('/overseas-futureoption/v1/trading/order'))).toMatchObject({ PRIC_DVSN_CD: '2', FM_LIMIT_ORD_PRIC: '', CCLD_CNDT_CD: '2' });
        expect(headersOf(mockFetch, find('/overseas-stock/v1/trading/order-resv')).tr_id).toBe('TTTT3016U');
    });

    it('모의투자는 모의 TR 이 있는 주문만 모의 TR 로 바꾸고, 야간 선물옵션은 NotSupported 다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValue(dataOk({ output: { ODNO: '1' } }));

        const k = newKis(true);
        await k.createDerivativeOrder('101W12', 'limit', 'buy', 1, 412);
        await k.cancelOverseasReservedOrder('0030008244', '20260922');

        expect(headersOf(mockFetch, find('/domestic-futureoption/v1/trading/order')).tr_id).toBe('VTTO1101U');
        expect(headersOf(mockFetch, find('/overseas-stock/v1/trading/order-resv-ccnl')).tr_id).toBe('VTTT3017U');
        await expect(k.createDerivativeOrder('101W12', 'limit', 'buy', 1, 412, { session: 'night' })).rejects.toThrow(NotSupported);
    });

    it('새 주문 경로는 모두 API 트리에 order 로 표시되어 재시도하지 않는다', () => {
        const post = (newKis().describe() as { api: { private: { post: Record<string, { order?: boolean }> } } }).api.private.post;
        const paths = [
            'domestic-stock/v1/trading/order-credit', 'domestic-stock/v1/trading/order-resv', 'domestic-stock/v1/trading/order-resv-rvsecncl',
            'overseas-stock/v1/trading/daytime-order', 'overseas-stock/v1/trading/daytime-order-rvsecncl', 'overseas-stock/v1/trading/order-resv',
            'overseas-stock/v1/trading/order-resv-ccnl', 'domestic-futureoption/v1/trading/order', 'domestic-futureoption/v1/trading/order-rvsecncl',
            'overseas-futureoption/v1/trading/order', 'overseas-futureoption/v1/trading/order-rvsecncl', 'domestic-bond/v1/trading/buy',
            'domestic-bond/v1/trading/sell', 'domestic-bond/v1/trading/order-rvsecncl',
        ];
        for (const path of paths) expect(post[`uapi/${path}`]?.order, path).toBe(true);
    });

    it('주문 입력이 틀리면 보내기 전에 거절한다', async () => {
        const k = newKis();
        await expect(k.createBondOrder('KR2033022D33', 'buy', 1.5, 10125)).rejects.toThrow(InvalidOrder);
        await expect(k.createBondOrder('KR2033022D33', 'buy', 1, 0)).rejects.toThrow(InvalidOrder);
        await expect(k.createDerivativeOrder('101W12', 'limit', 'buy', 1)).rejects.toThrow(ArgumentsRequired);
        await expect(k.createDerivativeOrder('101W12', 'stop' as never, 'buy', 1, 412)).rejects.toThrow(BadRequest);
        await expect(k.createCreditOrder('005930/KRW', 'limit', 'buy', 1, 70000, '25')).rejects.toThrow(BadRequest);
        await expect(k.createCreditOrder('005930/KRW', 'limit', 'sell', 1, 70000, '25')).rejects.toThrow(ArgumentsRequired);
        await expect(k.cancelReservedOrder('88793', '001', '2026-09-23')).rejects.toThrow(BadRequest);
        await expect(k.createDaytimeOrder('005930/KRW', 'buy', 1, 100)).rejects.toThrow(BadSymbol);
        await expect(k.cancelOverseasDerivativeOrder('00360686', undefined as unknown as string)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
