/**
 * KIS 해외 계좌 조회 확장 메서드: 지정가주문번호, 통화별 증거금, 결제기준잔고, 기간손익, 일별거래내역, 매수가능금액, 예약주문.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (sandbox = true) => newKisBase({ sandbox, masterData: KIS_MASTER_FIXTURE });

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

describe('해외 잔고와 증거금', () => {
    it('fetchOverseasMarginByCurrency 는 계좌만 보내고 통화별 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ natn_name: '미국', crcy_cd: 'USD', frcr_dncl_amt1: '1500.25', ustl_buy_amt: '100', ustl_sll_amt: '0', frcr_rcvb_amt: '0', frcr_mgn_amt: '50', frcr_gnrl_ord_psbl_amt: '1400', frcr_ord_psbl_amt1: '1350.25', itgr_ord_psbl_amt: '2000', bass_exrt: '1380.5' }],
        }));

        const [usd] = await newKis().fetchOverseasMarginByCurrency();

        const call = find('/overseas-stock/v1/trading/foreign-margin');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC2101R');
        expect(queryOf(call)).toEqual(ACCOUNT);
        expect(usd).toMatchObject({
            countryName: '미국', currency: 'USD', deposit: 1500.25, unsettledBuyAmount: 100, margin: 50,
            generalOrderable: 1400, orderable: 1350.25, integratedOrderable: 2000, exchangeRate: 1380.5,
        });
    });

    it('fetchOverseasSettlementBalance 는 오늘(한국 날짜)과 예제의 원화기준을 보내고 종목, 통화, 합계를 정리한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ pdno: 'AAPL', prdt_name: '애플', ovrs_excg_cd: 'NASD', tr_mket_name: '나스닥', natn_kor_name: '미국', buy_crcy_cd: 'USD', cblc_qty13: '3', ord_psbl_qty1: '3', avg_unpr3: '200', ovrs_now_pric1: '227.5', frcr_pchs_amt: '600', evlu_pfls_amt2: '113850', evlu_pfls_rt1: '13.75', bass_exrt: '1380' }],
            output2: [{ crcy_cd: 'USD', crcy_cd_name: '미국달러', frcr_dncl_amt_2: '1500', frcr_evlu_amt2: '682.5', frst_bltn_exrt: '1379' }],
            output3: { pchs_amt_smtl_amt: '828000', tot_evlu_pfls_amt: '113850', evlu_erng_rt1: '13.75', tot_dncl_amt: '2070000', wcrc_evlu_amt_smtl: '941850', tot_asst_amt2: '3011850', tot_loan_amt: '0' },
        }));

        const balance = await newKis().fetchOverseasSettlementBalance();

        const call = find('/trading/inquire-paymt-stdr-balance');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTRP6010R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, BASS_DT: '20260923', WCRC_FRCR_DVSN_CD: '01', INQR_DVSN_CD: '00' });
        expect(balance.positions).toEqual([expect.objectContaining({
            code: 'AAPL', name: '애플', exchangeCode: 'NASD', currency: 'USD', quantity: 3, averagePrice: 200, price: 227.5, unrealizedPnlRate: 13.75, exchangeRate: 1380,
        })]);
        expect(balance.currencies).toEqual([expect.objectContaining({ currency: 'USD', currencyName: '미국달러', deposit: 1500, evaluationAmount: 682.5, exchangeRate: 1379 })]);
        expect(balance).toMatchObject({ purchaseAmount: 828000, unrealizedPnl: 113850, totalDeposit: 2070000, evaluationAmount: 941850, totalAssets: 3011850, loanAmount: 0 });
    });

    it('fetchOverseasBuyableAmount 는 주문 거래소 코드와 단가를 보내고, 모의와 실전 TR 을 가린다', async () => {
        const output = { tr_crcy_cd: 'USD', ord_psbl_frcr_amt: '1350.25', sll_ruse_psbl_amt: '0', ovrs_ord_psbl_amt: '1350.25', max_ord_psbl_qty: '5', echm_af_ord_psbl_amt: '0', echm_af_ord_psbl_qty: '0', ord_psbl_qty: '5', exrt: '1380.5', frcr_ord_psbl_amt1: '1350.25', ovrs_max_ord_psbl_qty: '5' };
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output }));

        const buyable = await newKis().fetchOverseasBuyableAmount('AAPL/USD', 227.5);

        const call = find('/trading/inquire-psamount');
        expect(headersOf(mockFetch, call).tr_id).toBe('VTTS3007R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, OVRS_EXCG_CD: 'NASD', OVRS_ORD_UNPR: '227.5', ITEM_CD: 'AAPL' });
        expect(buyable).toMatchObject({ currency: 'USD', exchangeRate: 1380.5, orderableForeignAmount: 1350.25, orderableQuantity: 5, maxOrderableQuantity: 5 });

        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output }));
        await newKis(false).fetchOverseasBuyableAmount('V/USD', 330);
        const real = find('/trading/inquire-psamount');
        expect(headersOf(mockFetch, real).tr_id).toBe('TTTS3007R');
        expect(queryOf(real)).toMatchObject({ OVRS_EXCG_CD: 'NYSE', ITEM_CD: 'V' });
    });

    it('fetchOverseasBuyableAmount 는 국내 종목이나 단가 누락을 보내기 전에 거절한다', async () => {
        await expect(newKis().fetchOverseasBuyableAmount('005930/KRW', 70000)).rejects.toThrow(BadSymbol);
        await expect(newKis().fetchOverseasBuyableAmount('AAPL/USD', undefined)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('해외 주문과 거래 내역', () => {
    it('fetchOverseasAlgoOrders 는 거래일자를 보내고 주문 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ odno: '0030001', trad_dvsn_name: '매수', pdno: 'AAPL', item_name: '애플', ft_ord_qty: '10', ft_ord_unpr3: '225', splt_buy_attr_name: 'TWAP', ft_ccld_qty: '4', ord_gno_brno: '01790' }],
        }));

        const [order] = await newKis().fetchOverseasAlgoOrders({ until: Date.parse('2026-09-22T03:00:00Z') });

        const call = find('/trading/algo-ordno');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTS6058R');
        expect(queryOf(call)).toEqual({ ...ACCOUNT, TRAD_DT: '20260922', CTX_AREA_FK200: '', CTX_AREA_NK200: '' });
        expect(order).toMatchObject({ orderId: '0030001', branchNo: '01790', code: 'AAPL', name: '애플', tradeTypeName: '매수', splitBuyTypeName: 'TWAP', quantity: 10, price: 225, filledQuantity: 4 });
    });

    it('fetchOverseasRealizedPnl 은 전체 거래소와 통화, 예제의 외화 기준을 보내고 매매 행과 합계를 정리한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ trad_day: '20260915', ovrs_pdno: 'TSLA', ovrs_item_name: '테슬라', ovrs_excg_cd: 'NASD', slcl_qty: '2', pchs_avg_pric: '240', frcr_pchs_amt1: '480', avg_sll_unpr: '260', frcr_sll_amt_smtl1: '520', stck_sll_tlex: '0.5', ovrs_rlzt_pfls_amt: '39.5', pftrt: '8.23', exrt: '1380' }],
            output2: { stck_sll_amt_smtl: '717600', stck_buy_amt_smtl: '662400', smtl_fee1: '690', excc_dfrm_amt: '716910', ovrs_rlzt_pfls_tot_amt: '54510', tot_pftrt: '8.23', bass_dt: '20260922', exrt: '1380' },
        }));

        const pnl = await newKis().fetchOverseasRealizedPnl(Date.parse('2026-09-01T00:00:00+09:00'));

        const call = find('/trading/inquire-period-profit');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTS3039R');
        expect(queryOf(call)).toEqual({
            ...ACCOUNT, OVRS_EXCG_CD: '', NATN_CD: '', CRCY_CD: '', PDNO: '', INQR_STRT_DT: '20260901', INQR_END_DT: '20260923', WCRC_FRCR_DVSN_CD: '01', CTX_AREA_FK200: '', CTX_AREA_NK200: '',
        });
        expect(pnl.trades).toEqual([expect.objectContaining({ tradeDate: '20260915', code: 'TSLA', name: '테슬라', quantity: 2, averageSellPrice: 260, sellCost: 0.5, realizedPnl: 39.5, returnRate: 8.23 })]);
        expect(pnl).toMatchObject({ sellAmount: 717600, buyAmount: 662400, fee: 690, settlementAmount: 716910, realizedPnl: 54510, returnRate: 8.23 });
    });

    it('fetchOverseasTransactions 는 전체 거래소와 매도매수 전체를 보내고 거래 행과 합계를 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [
                { trad_dt: '20260915', sttl_dt: '20260916', sll_buy_dvsn_cd: '01', pdno: 'TSLA', ovrs_item_name: '테슬라', ccld_qty: '2', ovrs_stck_ccld_unpr: '260', tr_frcr_amt2: '520', frcr_excc_amt_1: '519.5', wcrc_excc_amt: '716910', frcr_fee1: '0.5', dmst_frcr_fee1: '0', crcy_cd: 'USD', erlm_exrt: '1380' },
                { trad_dt: '20260910', sll_buy_dvsn_cd: '02', pdno: 'TSLA' },
                { trad_dt: '20260910', sll_buy_dvsn_cd: '99', pdno: 'TSLA' },
            ],
            output2: { frcr_buy_amt_smtl: '480', frcr_sll_amt_smtl: '520', dmst_fee_smtl: '0', ovrs_fee_smtl: '0.5' },
        }));

        const result = await newKis().fetchOverseasTransactions(Date.parse('2026-09-01T00:00:00+09:00'), undefined, { until: Date.parse('2026-09-20T00:00:00+09:00') });

        const call = find('/trading/inquire-period-trans');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTOS4001R');
        expect(queryOf(call)).toEqual({
            ...ACCOUNT, ERLM_STRT_DT: '20260901', ERLM_END_DT: '20260920', OVRS_EXCG_CD: '', PDNO: '', SLL_BUY_DVSN_CD: '00', LOAN_DVSN_CD: '', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
        });
        expect(result.transactions[0]).toMatchObject({
            tradeDate: '20260915', settlementDate: '20260916', side: 'sell', code: 'TSLA', quantity: 2, price: 260, foreignAmount: 520, krwSettlementAmount: 716910, foreignFee: 0.5, currency: 'USD', exchangeRate: 1380,
        });
        expect(result.transactions.map((t) => t.side)).toEqual(['sell', 'buy', 'unknown']);
        expect(result).toMatchObject({ foreignBuyAmount: 480, foreignSellAmount: 520, domesticFee: 0, overseasFee: 0.5 });
    });

    it('fetchOverseasReservedOrders 는 거래소로 TR 을 고르고 예약주문 행을 정리한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({
                output: [{ cncl_yn: 'N', rsvn_ord_rcit_dt: '20260922', ovrs_rsvn_odno: '0000456', ord_dt: '', ord_gno_brno: '', odno: '', sll_buy_dvsn_cd: '02', sll_buy_dvsn_cd_name: '매수', ovrs_rsvn_ord_stat_cd: '01', ovrs_rsvn_ord_stat_cd_name: '접수', pdno: 'AAPL', prdt_type_cd: '512', prdt_name: '애플', ord_rcit_tmd: '203015', ord_fwdg_tmd: '', tr_dvsn_name: '현금', ovrs_excg_cd: 'NASD', tr_mket_name: '나스닥', ft_ord_qty: '1', ft_ord_unpr3: '220', ft_ccld_qty: '0', nprc_rson_text: '' }],
            }))
            .mockResolvedValueOnce(dataOk({ output: [{ ovrs_rsvn_odno: '0000457', cncl_yn: 'Y', sll_buy_dvsn_cd: '01', pdno: '00700' }] }));

        const kis = newKis();
        const [us] = await kis.fetchOverseasReservedOrders('NAS', Date.parse('2026-09-01T00:00:00+09:00'));
        const [hk] = await kis.fetchOverseasReservedOrders('HKS', Date.parse('2026-09-01T00:00:00+09:00'));

        const calls = mockFetch.mock.calls.flatMap((c, i) => (String(c[0]).includes('/trading/order-resv-list') ? [i] : []));
        expect(calls).toHaveLength(2);
        expect(headersOf(mockFetch, calls[0]).tr_id).toBe('TTTT3039R');
        expect(queryOf(calls[0])).toEqual({
            ...ACCOUNT, INQR_STRT_DT: '20260901', INQR_END_DT: '20260923', INQR_DVSN_CD: '00', OVRS_EXCG_CD: 'NASD', PRDT_TYPE_CD: '', CTX_AREA_FK200: '', CTX_AREA_NK200: '',
        });
        expect(headersOf(mockFetch, calls[1]).tr_id).toBe('TTTS3014R');
        expect(queryOf(calls[1])).toMatchObject({ OVRS_EXCG_CD: 'SEHK' });
        expect(us).toMatchObject({
            reservationId: '0000456', orderId: undefined, receivedDate: '20260922', cancelled: false, side: 'buy', statusCode: '01', statusName: '접수',
            code: 'AAPL', productTypeCode: '512', exchangeCode: 'NASD', quantity: 1, price: 220, filledQuantity: 0, receivedTime: '203015', rejectReason: undefined,
        });
        expect(hk).toMatchObject({ reservationId: '0000457', cancelled: true, side: 'sell', code: '00700' });
    });

    it('기간 시작이나 거래소가 잘못되면 보내기 전에 거절한다', async () => {
        const kis = newKis();
        await expect(kis.fetchOverseasRealizedPnl(undefined)).rejects.toThrow(ArgumentsRequired);
        await expect(kis.fetchOverseasTransactions(undefined)).rejects.toThrow(ArgumentsRequired);
        await expect(kis.fetchOverseasReservedOrders('NAS', undefined)).rejects.toThrow(ArgumentsRequired);
        await expect(kis.fetchOverseasReservedOrders('NASD', Date.now())).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
