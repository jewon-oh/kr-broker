/**
 * KIS 국내 계좌 조회 확장 메서드: 자산현황, 실현손익 잔고, 신용매수가능, 기간별 손익, 매도가능수량, 통합증거금, 예약주문, 계좌 권리.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = () => newKisBase({ masterData: KIS_MASTER_FIXTURE });

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

/** KST 2026-09-23 01:30 에 고정한다. */
const fixKstSep23 = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
};

describe('잔고와 자산', () => {
    it('fetchAccountAssets 는 계좌와 빈 선택 입력을 보내고 요약과 자산 구분별 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ pchs_amt: '1000000', evlu_amt: '1100000', evlu_pfls_amt: '100000', crdt_lnd_amt: '0', real_nass_amt: '1100000', whol_weit_rt: '55' }],
            output2: {
                tot_asst_amt: '2000000', nass_tot_amt: '1900000', pchs_amt_smtl: '1000000', evlu_amt_smtl: '1100000', evlu_pfls_amt_smtl: '100000',
                loan_amt_smtl: '100000', dncl_amt: '800000', tot_dncl_amt: '850000', cma_evlu_amt: '0', frcr_evlu_tota: '50000', ovrs_stck_evlu_amt1: '40000', thdt_rcvb_amt: '0',
            },
        }));

        const assets = await newKis().fetchAccountAssets();

        const call = find('/trading/inquire-account-balance');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTRP6548R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, INQR_DVSN_1: '', BSPR_BF_DT_APLY_YN: '' });
        expect(assets).toMatchObject({
            totalAssets: 2000000, netAssets: 1900000, purchaseAmount: 1000000, evaluationAmount: 1100000, unrealizedPnl: 100000, loanAmount: 100000,
            deposit: 800000, totalDeposit: 850000, foreignCurrencyEvaluation: 50000, overseasStockEvaluation: 40000, receivable: 0,
        });
        expect(assets.categories[0]).toMatchObject({ purchaseAmount: 1000000, evaluationAmount: 1100000, unrealizedPnl: 100000, realNetAssets: 1100000, weight: 55 });
    });

    it('fetchRealizedPnlBalance 는 조회구분 전체(00)와 기본값을 보내고 보유 종목과 실현손익을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ pdno: '005930', prdt_name: '삼성전자', hldg_qty: '10', ord_psbl_qty: '10', pchs_avg_pric: '70000', pchs_amt: '700000', prpr: '71000', evlu_amt: '710000', evlu_pfls_amt: '10000', evlu_pfls_rt: '1.43' }],
            output2: [{ rlzt_pfls: '5000', rlzt_erng_rt: '0.7', tot_evlu_amt: '1510000', nass_amt: '1500000', dnca_tot_amt: '800000', pchs_amt_smtl_amt: '700000', evlu_amt_smtl_amt: '710000', evlu_pfls_smtl_amt: '10000' }],
        }));

        const balance = await newKis().fetchRealizedPnlBalance();

        const call = find('/trading/inquire-balance-rlz-pl');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC8494R');
        expect(queryOf(call)).toEqual({
            ...ACCOUNT, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '00', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '01',
            COST_ICLD_YN: 'N', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
        });
        expect(balance.positions[0]).toMatchObject({ symbol: '005930/KRW', name: '삼성전자', quantity: 10, averagePrice: 70000, price: 71000, unrealizedPnl: 10000, unrealizedPnlRate: 1.43 });
        expect(balance).toMatchObject({ realizedPnl: 5000, realizedPnlRate: 0.7, totalEvaluation: 1510000, netAssets: 1500000, deposit: 800000, unrealizedPnl: 10000 });
    });

    it('fetchSellableQuantity 는 종목을 보내고 매도가능수량을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { pdno: '005930', ord_psbl_qty: '7', cblc_qty: '10', buy_qty: '10', sll_qty: '3', pchs_avg_pric: '70000', pchs_amt: '700000', now_pric: '71000', evlu_amt: '710000', evlu_pfls_amt: '10000', evlu_pfls_rt: '1.43' },
        }));

        const sellable = await newKis().fetchSellableQuantity('005930/KRW');

        const call = find('/trading/inquire-psbl-sell');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC8408R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, PDNO: '005930' });
        expect(sellable).toMatchObject({ symbol: '005930/KRW', orderableQuantity: 7, balanceQuantity: 10, sellQuantity: 3, price: 71000, unrealizedPnlRate: 1.43 });
    });

    it('fetchIntegratedMargin 은 예제의 외화기준을 보내고 주문가능금액을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { acmga_rt: '20', stck_cash_ord_psbl_amt: '500000', stck_sbst_ord_psbl_amt: '100000', stck_evlu_ord_psbl_amt: '600000', rcvb_amt: '0', usd_ord_psbl_amt: '300.5', hkd_ord_psbl_amt: '0', jpy_ord_psbl_amt: '0', cny_ord_psbl_amt: '0' },
        }));

        const margin = await newKis().fetchIntegratedMargin();

        const call = find('/trading/intgr-margin');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC0869R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, CMA_EVLU_AMT_ICLD_YN: 'N', WCRC_FRCR_DVSN_CD: '01', FWEX_CTRT_FRCR_DVSN_CD: '01' });
        expect(margin).toMatchObject({ marginRate: 20, cashOrderable: 500000, substituteOrderable: 100000, evaluationOrderable: 600000, usdOrderable: 300.5 });
    });
});

describe('신용과 손익', () => {
    it('fetchCreditBuyableAmount 는 신용유형과 예제의 주문구분을 보내고, 단가가 없으면 비운다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { ord_psbl_cash: '1000000', ord_psbl_sbst: '200000', ruse_psbl_amt: '0', max_buy_amt: '2500000', max_buy_qty: '35', nrcvb_buy_amt: '1000000', nrcvb_buy_qty: '14', psbl_qty_calc_unpr: '71000' },
        }));

        const buyable = await newKis().fetchCreditBuyableAmount('005930/KRW', '21');

        const call = find('/trading/inquire-credit-psamount');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC8909R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, PDNO: '005930', ORD_DVSN: '00', CRDT_TYPE: '21', CMA_EVLU_AMT_ICLD_YN: 'N', OVRS_ICLD_YN: 'N', ORD_UNPR: '' });
        expect(buyable).toMatchObject({ orderableCash: 1000000, maxBuyAmount: 2500000, maxBuyQuantity: 35, noReceivableBuyQuantity: 14, calculationPrice: 71000 });
    });

    it('fetchCreditBuyableAmount 는 설명 밖의 신용유형이면 보내기 전에 ArgumentsRequired 다', async () => {
        await expect(newKis().fetchCreditBuyableAmount('005930/KRW', '99')).rejects.toThrow(ArgumentsRequired);
        await expect(newKis().fetchCreditBuyableAmount('AAPL/USD', '21')).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetchDailyRealizedPnl 은 기간과 예제값을 보내고 일별 행과 합계를 정리한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ trad_dt: '20260922', buy_amt: '700000', sll_amt: '720000', rlzt_pfls: '18000', pfls_rt: '2.57', fee: '100', tl_tax: '1500', loan_int: '0' }],
            output2: { tot_rlzt_pfls: '18000', tot_fee: '100', tot_tltx: '1500' },
        }));

        const pnl = await newKis().fetchDailyRealizedPnl(Date.parse('2026-09-01T00:00:00Z'));

        const call = find('/trading/inquire-period-profit');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC8708R');
        expect(queryOf(call)).toEqual({
            ...ACCOUNT, INQR_STRT_DT: '20260901', INQR_END_DT: '20260923', SORT_DVSN: '00', INQR_DVSN: '00', CBLC_DVSN: '00', PDNO: '', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
        });
        expect(pnl.days[0]).toMatchObject({ tradeDate: '20260922', buyAmount: 700000, sellAmount: 720000, realizedPnl: 18000, pnlRate: 2.57, fee: 100, tax: 1500, loanInterest: 0 });
        expect(pnl).toMatchObject({ totalRealizedPnl: 18000, totalFee: 100, totalTax: 1500 });
    });
});

describe('예약주문과 권리', () => {
    it('fetchReservedOrders 는 기간과 예제값을 보내고 매도매수 코드를 방향으로 옮긴다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [
                { rsvn_ord_seq: '1', rsvn_ord_ord_dt: '20260922', rsvn_ord_rcit_dt: '20260922', rsvn_end_dt: '20260930', pdno: '005930', kor_item_shtn_name: '삼성전자', sll_buy_dvsn_cd: '02', ord_dvsn_cd: '00', ord_dvsn_name: '지정가', ord_rsvn_qty: '5', ord_rsvn_unpr: '70000', tot_ccld_qty: '0', tot_ccld_amt: '0', odno: '', prcs_rslt: '미처리' },
                { rsvn_ord_seq: '2', pdno: '000660', sll_buy_dvsn_cd: '01' },
                { rsvn_ord_seq: '3', pdno: '000660', sll_buy_dvsn_cd: '' },
            ],
        }));

        const orders = await newKis().fetchReservedOrders(Date.parse('2026-09-01T00:00:00Z'));

        const call = find('/trading/order-resv-ccnl');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTSC0004R');
        expect(queryOf(call)).toEqual({
            RSVN_ORD_ORD_DT: '20260901', RSVN_ORD_END_DT: '20260923', TMNL_MDIA_KIND_CD: '00', ...ACCOUNT, PRCS_DVSN_CD: '0', CNCL_YN: 'Y', RSVN_ORD_SEQ: '', PDNO: '',
            SLL_BUY_DVSN_CD: '', CTX_AREA_FK200: '', CTX_AREA_NK200: '',
        });
        expect(orders[0]).toMatchObject({
            sequence: '1', orderDate: '20260922', endDate: '20260930', symbol: '005930/KRW', name: '삼성전자', side: 'buy', orderTypeCode: '00', orderTypeName: '지정가',
            quantity: 5, price: 70000, filledQuantity: 0, orderId: undefined, result: '미처리',
        });
        expect(orders.map((o) => o.side)).toEqual(['buy', 'sell', 'unknown']);
    });

    it('fetchAccountRights 는 예제의 조회구분과 기간을 보내고 권리 행을 정리한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                bass_dt: '20260915', rght_type_cd: '03', pdno: 'KR7005930003', shtn_pdno: '005930', prdt_name: '삼성전자', cblc_qty: '10', tot_alct_qty: '0',
                last_alct_amt: '3610', last_ftsk_chgs: '0', cash_dfrm_dt: '20261120', lstg_dt: '', sbsc_end_dt: '', sbsc_unpr: '0', tax_amt: '555',
            }],
        }));

        const [right] = await newKis().fetchAccountRights(Date.parse('2026-09-01T00:00:00Z'));

        const call = find('/domestic-stock/v1/trading/period-rights');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTRGA011R');
        expect(queryOf(call)).toEqual({
            INQR_DVSN: '03', ...ACCOUNT, INQR_STRT_DT: '20260901', INQR_END_DT: '20260923', CUST_RNCNO25: '', HMID: '', RGHT_TYPE_CD: '', PDNO: '', PRDT_TYPE_CD: '',
            CTX_AREA_NK100: '', CTX_AREA_FK100: '',
        });
        expect(right).toMatchObject({
            date: '20260915', rightTypeCode: '03', code: 'KR7005930003', shortCode: '005930', name: '삼성전자', balanceQuantity: 10, allocatedAmount: 3610,
            cashPaymentDate: '20261120', listingDate: undefined, taxAmount: 555,
        });
    });

    it('기간 시작이 없으면 보내기 전에 ArgumentsRequired 다', async () => {
        const broker = newKis();
        await expect(broker.fetchReservedOrders(undefined as unknown as number)).rejects.toThrow(ArgumentsRequired);
        await expect(broker.fetchAccountRights(undefined as unknown as number)).rejects.toThrow(ArgumentsRequired);
        await expect(broker.fetchDailyRealizedPnl(undefined as unknown as number)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
