/**
 * KIS 퇴직연금 조회 확장 메서드: 잔고, 미체결내역, 예수금, 체결기준잔고, 매수가능.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = () => newKisBase({ masterData: KIS_MASTER_FIXTURE });

/** 테스트 계좌(`12345678-01`)의 입력. */
const ACCOUNT = { CANO: '12345678', ACNT_PRDT_CD: '01' };

beforeEach(() => {
    mockFetch.mockReset();
});

/** 경로가 들어간 첫 호출의 순번. */
const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index][0])).searchParams);

describe('퇴직연금 잔고', () => {
    it('fetchPensionBalance 는 예제값을 보내고 보유 종목과 예수금 요약을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ cblc_dvsn_name: '주식', prdt_name: 'KODEX 200', pdno: '069500', item_dvsn_name: 'ETF', thdt_buyqty: '2', thdt_sll_qty: '0', hldg_qty: '10', ord_psbl_qty: '8', pchs_avg_pric: '30000', pchs_amt: '300000', prpr: '31000', evlu_amt: '310000', evlu_pfls_amt: '10000', evlu_erng_rt: '3.33' }],
            output2: [{ dnca_tot_amt: '500000', nxdy_excc_amt: '480000', prvs_rcdl_excc_amt: '470000', thdt_buy_amt: '60000', thdt_sll_amt: '0', thdt_tlex_amt: '15', scts_evlu_amt: '310000', tot_evlu_amt: '790000' }],
        }));

        const balance = await newKis().fetchPensionBalance();

        const call = find('/trading/pension/inquire-balance');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC2208R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, ACCA_DVSN_CD: '00', INQR_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '' });
        expect(balance.positions).toEqual([expect.objectContaining({
            symbol: '069500/KRW', name: 'KODEX 200', balanceTypeName: '주식', itemTypeName: 'ETF', quantity: 10, orderableQuantity: 8,
            todayBuyQuantity: 2, todaySellQuantity: 0, averagePrice: 30000, price: 31000, evaluationAmount: 310000, unrealizedPnl: 10000, unrealizedPnlRate: 3.33,
        })]);
        expect(balance).toMatchObject({ deposit: 500000, nextDaySettlement: 480000, provisionalSettlement: 470000, todayBuyAmount: 60000, todayCost: 15, securitiesEvaluation: 310000, totalEvaluation: 790000 });
    });

    it('fetchPensionExecutionBalance 는 예제의 사용자구분을 보내고 체결 기준 보유 종목과 손익 합계를 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ cblc_dvsn: '00', cblc_dvsn_name: '현금', pdno: '069500', prdt_name: 'KODEX 200', hldg_qty: '10', slpsb_qty: '10', pchs_avg_pric: '30000', evlu_pfls_amt: '10000', evlu_pfls_rt: '3.33', prpr: '31000', evlu_amt: '310000', pchs_amt: '300000', cblc_weit: '100' }],
            output2: [{ pchs_amt_smtl_amt: '300000', evlu_amt_smtl_amt: '310000', evlu_pfls_smtl_amt: '10000', trad_pfls_smtl: '2000', thdt_tot_pfls_amt: '500', pftrt: '3.33' }],
        }));

        const balance = await newKis().fetchPensionExecutionBalance();

        const call = find('/trading/pension/inquire-present-balance');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC2202R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, USER_DVSN_CD: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '' });
        expect(balance.positions).toEqual([expect.objectContaining({
            symbol: '069500/KRW', balanceType: '00', balanceTypeName: '현금', quantity: 10, sellableQuantity: 10, unrealizedPnlRate: 3.33, weight: 100,
        })]);
        expect(balance).toMatchObject({ purchaseAmount: 300000, evaluationAmount: 310000, unrealizedPnl: 10000, tradingPnl: 2000, todayPnl: 500, returnRate: 3.33 });
    });

    it('fetchPensionDeposit 은 예제의 적립금구분을 보내고 예수금과 결제 예정액을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { dnca_tota: '500000', nxdy_excc_amt: '480000', nxdy_sttl_amt: '-20000', nx2_day_sttl_amt: '0' },
        }));

        const deposit = await newKis().fetchPensionDeposit();

        const call = find('/trading/pension/inquire-deposit');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC0506R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, ACCA_DVSN_CD: '00' });
        expect(deposit).toMatchObject({ deposit: 500000, nextDaySettlement: 480000, nextDayPayment: -20000, secondDayPayment: 0 });
    });
});

describe('퇴직연금 주문과 매수가능', () => {
    it('fetchPensionOrders 는 전체 값을 보내고 매도매수 코드를 방향으로 옮긴다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [
                { ord_gno_brno: '06010', sll_buy_dvsn_cd: '02', trad_dvsn_name: '현금매수', odno: '0000123', pdno: '069500', prdt_name: 'KODEX 200', ord_unpr: '31000', ord_qty: '3', tot_ccld_qty: '1', nccs_qty: '2', ord_dvsn_cd: '00', ord_dvsn_name: '지정가', orgn_odno: '', ord_tmd: '093015', objt_cust_dvsn_name: '본인', pchs_avg_pric: '31000' },
                { odno: '0000124', pdno: '069500', sll_buy_dvsn_cd: '01' },
                { odno: '0000125', pdno: '069500', sll_buy_dvsn_cd: '' },
            ],
        }));

        const orders = await newKis().fetchPensionOrders();

        const call = find('/trading/pension/inquire-daily-ccld');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC2201R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, USER_DVSN_CD: '%%', SLL_BUY_DVSN_CD: '00', CCLD_NCCS_DVSN: '%%', INQR_DVSN_3: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '' });
        expect(orders[0]).toMatchObject({
            orderId: '0000123', originalOrderId: undefined, branchNo: '06010', symbol: '069500/KRW', side: 'buy', tradeTypeName: '현금매수', orderTypeCode: '00',
            price: 31000, quantity: 3, filledQuantity: 1, remainingQuantity: 2, orderTime: '093015', customerTypeName: '본인',
        });
        expect(orders.map((o) => o.side)).toEqual(['buy', 'sell', 'unknown']);
    });

    it('fetchPensionBuyableAmount 는 단가를 주면 지정가로, 주지 않으면 시장가와 단가 0으로 묻는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: { ord_psbl_cash: '500000', ruse_psbl_amt: '0', psbl_qty_calc_unpr: '30800', max_buy_amt: '492800', max_buy_qty: '16' } }))
            .mockResolvedValueOnce(dataOk({ output: { ord_psbl_cash: '500000', max_buy_qty: '15' } }));

        const kis = newKis();
        const limit = await kis.fetchPensionBuyableAmount('069500/KRW', 30800);
        const market = await kis.fetchPensionBuyableAmount('069500/KRW');

        const calls = mockFetch.mock.calls.flatMap((c, i) => (String(c[0]).includes('/trading/pension/inquire-psbl-order') ? [i] : []));
        expect(calls).toHaveLength(2);
        expect(headersOf(mockFetch, calls[0]).tr_id).toBe('TTTC0503R');
        expect(queryOf(calls[0])).toEqual({ ...ACCOUNT, PDNO: '069500', ACCA_DVSN_CD: '00', CMA_EVLU_AMT_ICLD_YN: 'Y', ORD_UNPR: '30800', ORD_DVSN: '00' });
        expect(queryOf(calls[1])).toMatchObject({ ORD_UNPR: '0', ORD_DVSN: '01' });
        expect(limit).toMatchObject({ orderableCash: 500000, reusableAmount: 0, calculationPrice: 30800, maxBuyAmount: 492800, maxBuyQuantity: 16 });
        expect(market.maxBuyQuantity).toBe(15);
    });

    it('fetchPensionBuyableAmount 는 국내 종목이 아니면 보내기 전에 BadSymbol 이다', async () => {
        await expect(newKis().fetchPensionBuyableAmount('AAPL/USD')).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
