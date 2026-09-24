/**
 * @fileoverview 입력 규칙과 실계좌 확인으로 보류를 푼 KB 조회 7개: 공휴일관리(`SPAM2508`), 총 잔고 조회(`SSQM0005`), 주식자산평가 실시간(`SSQN2952`),
 * 해외 소수점 주문접수내역(`SPQM5473`), 일자별실현손익상세(`SSQM2442`), 종목별기간실현손익(`SSQM2443`), 종합계좌 잔고현황(`SSQM2932`).
 * 설명과 공식 예제가 다르면 설명을 따르고, 필터일 수 있는 필수 입력은 호출하는 쪽이 고른다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { ArgumentsRequired, NotSupported } from '../../base/errors';
import { KBSEC_ORDER_TR_CODES, KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fetchHolidays', () => {
    it('처리구분은 설명의 조회(4), ISO코드는 US 를 보내고 종료일자는 params.until 의 한국 날짜다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.HOLIDAYS_US]: {
                nxt_bsnss_dy: '20260925', nxt_stlmt_dt: '20260926',
                Record1: [{ mm: '11', bsnss_dy: '20', hldy: '1127', stmt_dy: '21', nxt_bsnss_dy: '20261130', nxt_stlmt_dt: '20261201', frgn_stk_ordr_psbl_f: 'N' }],
            },
        });

        const h = await newExchange().fetchHolidays({ until: Date.parse('2026-12-31T03:00:00Z') });

        expect(trBody(mockFetch, KBSEC_TR.HOLIDAYS_US).dataBody).toEqual({
            hndl_clsf: '4', iso_cd: 'US', dr_dt: '', end_dt: '20261231', nxt_bsnss_dy: '', nxt_stlmt_dt: '', hldy_ccd: '', frgn_stk_ordr_psbl_f: '',
        });
        expect(h.fields).toEqual({ nxt_bsnss_dy: '20260925', nxt_stlmt_dt: '20260926' });
        expect(h.rows).toEqual([{
            month: '11', businessDay: '20', holiday: '1127', settlementDay: '21', nextBusinessDay: '20261130', nextSettlementDate: '20261201',
            overseasOrderable: 'N', info: expect.objectContaining({ mm: '11' }),
        }]);
    });

    it('종료일자가 없으면 오늘(한국 날짜)을 보낸다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-23T16:00:00Z')); // 한국 9/24 01:00
        routeTr(mockFetch, { [KBSEC_TR.HOLIDAYS_US]: {} });

        await newExchange().fetchHolidays();

        expect(trBody(mockFetch, KBSEC_TR.HOLIDAYS_US).dataBody).toMatchObject({ end_dt: '20260924' });
    });
});

describe('fetchAccountSummary', () => {
    it('조회구분은 설명의 계좌정보(3), 상품그룹은 전체(00)를 보내고 연속조회를 따라간다', async () => {
        const row = (no: string) => ({
            ac_no: no, ac_ncknm: '주식', gds_typ_cd: '01', gds_typ_dtls_nm: '위탁', gds_st_ccd: '1', val_amt: '1,500,000', tfnd_amt: '200000',
            o_amt_psbl_amt: '150000', nxt2_dy_tfnd: '180000', fnl_dl_dt: '20260922',
        });
        routeTr(mockFetch, {
            [KBSEC_TR.ACCOUNT_SUMMARY]: (sent: Record<string, unknown>) => (sent.nxt_key === ''
                ? { tl_val_amt: '1500000', nxt_key: 'K2', Record1: [row('11111111101')] }
                : { tl_val_amt: '1500000', nxt_key: '', Record1: [row('11111111102')] }),
        });

        const result = await newExchange().fetchAccountSummary();

        expect(trBody(mockFetch, KBSEC_TR.ACCOUNT_SUMMARY).dataBody).toEqual({
            inq_clsf: '3', tl_val_amt: '', tl_tfnd_amt: '', tl_o_amt_psbl_amt: '', nxt_key: 'K2', gds_grp_cd: '00', ccls_stmt_clsf: '1',
        });
        expect(result.truncated).toBe(false);
        expect(result.rows.map((r) => r.accountNumber)).toEqual(['11111111101', '11111111102']);
        expect(result.rows[0]).toMatchObject({
            nickname: '주식', productTypeCode: '01', productTypeName: '위탁', statusCode: '1', valuation: 1500000, deposit: 200000,
            withdrawable: 150000, dayAfterNextDeposit: 180000, lastTradeDate: '20260922',
        });
    });
});

describe('fetchRealtimeAssetValuation', () => {
    it('거래소시세구분은 설명의 통합(A)을 보내고 퇴직연금 코드만 설명된 특화주문구분은 비운다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.ASSET_EVAL_REALTIME]: {
                thdy_rlztn_pl: '-3000', byng_amt_sum: '700000', tl_crdt_ln_amt: '0', ndy_tfnd: '100000', nxt2_dy_tfnd: '90000', cnt: '1',
                Record1: [{
                    shrt_is_cd: 'A005930', stnd_is_cd: 'KR7005930003', is_nm: '삼성전자', crdt_typ_nm: '현금', blnc_q_p6: '10.000000',
                    ordr_psbl_q_p6: '8.000000', byng_avr_prc: '70000', byng_amt: '700000', now_prc: '72000', val_amt: '720000', val_pl: '20000',
                    val_yld: '2.85',
                }],
            },
        });

        const v = await newExchange().fetchRealtimeAssetValuation();

        expect(trBody(mockFetch, KBSEC_TR.ASSET_EVAL_REALTIME).dataBody).toEqual({
            is_cd: '', sum_clsf: '1', spclz_ordr_ccd: '', nxt2_dy_tfnd_xcl_f: '', excg_mktpr_ccd: 'A',
        });
        expect(v).toMatchObject({ realizedPnlToday: -3000, purchaseAmount: 700000, creditLoan: 0, nextDayDeposit: 100000, dayAfterNextDeposit: 90000 });
        expect(v.holdings).toEqual([{
            shortCode: 'A005930', standardCode: 'KR7005930003', name: '삼성전자', creditTypeName: '현금', quantity: 10, orderableQuantity: 8,
            averagePrice: 70000, purchaseAmount: 700000, price: 72000, valuation: 720000, unrealizedPnl: 20000, returnRate: 2.85,
            info: expect.objectContaining({ shrt_is_cd: 'A005930' }),
        }]);
    });
});

describe('fetchOverseasFractionalOrderHistory', () => {
    const SUMMARY = { trd_clsf_nm: '매수', trd_amt: '100', dcml_sum_q_p6: '0.5', clt_expt_fee: '0', ordr_cnt: '1', tl_ac_c: '1', is_c: '1' };
    const ORDER = {
        trd_dt: '20260922', acpt_no: '77', shrt_is_cd: 'AAPL', stnd_is_cd: 'US0378331005', is_nm: '애플', crncy_cd: 'USD', ordr_st: '1', hndl_st: '2',
        trd_clsf: '02', trd_clsf_nm: '매수', ordr_q: '0.5', ccls_q: '0.5', ordr_acpt_tm: '223001', ordr_prc: '180.5', ccls_amt: '90.25',
    };

    it('설명의 고정값과 전체값을 보내고, since 가 없으면 매매일자를 비운다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_ORDER_HISTORY_US]: { nxt_key: '', Record1: [SUMMARY], Record2: [ORDER] } });

        const result = await newExchange().fetchOverseasFractionalOrderHistory();

        expect(trBody(mockFetch, KBSEC_TR.FRAC_ORDER_HISTORY_US).dataBody).toEqual({
            dprt_clsf: '1', brn_no: '999', inq_clsf: '1', sum_clsf: '', ordr_st: '3', trd_strt_dt: '', trd_end_dt: '', trd_clsf: '99',
            krw_fcrncy_ccd: '0', is_cd: '', frgn_krx_ccd: '', mngr_eno: '', nxt_key: '',
        });
        // 요약 그리드가 앞에 와도 접수번호가 있는 그리드에서 행을 읽는다.
        expect(result.rows).toEqual([{
            date: '20260922', acceptNumber: '77', shortCode: 'AAPL', standardCode: 'US0378331005', name: '애플', currency: 'USD', sideName: '매수',
            orderStatus: '1', processStatus: '2', quantity: 0.5, filledQuantity: 0.5, acceptTime: '223001', info: expect.objectContaining({ ordr_prc: '180.5' }),
        }]);
        expect(result.rows[0]).not.toHaveProperty('price');
    });

    it('since 는 미국 현지 일자로 바꾸고 끝은 오늘이다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-23T02:00:00Z')); // 미국 동부 9/22 22:00
        routeTr(mockFetch, { [KBSEC_TR.FRAC_ORDER_HISTORY_US]: { nxt_key: '' } });

        await newExchange().fetchOverseasFractionalOrderHistory(Date.UTC(2026, 8, 21, 2, 0)); // 미국 동부 9/20 22:00

        expect(trBody(mockFetch, KBSEC_TR.FRAC_ORDER_HISTORY_US).dataBody).toMatchObject({ trd_strt_dt: '20260920', trd_end_dt: '20260922' });
    });
});

describe('fetchRealizedPnlDaily / fetchRealizedPnlBySymbol', () => {
    it('일자별은 매체구분에 공식 예제값 1 을 보내고(실계좌에서 1·2·3 결과가 같았다), 기간은 한국 날짜다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-23T16:00:00Z')); // 한국 9/24 01:00
        routeTr(mockFetch, {
            [KBSEC_TR.PNL_DAILY]: {
                s_q_sum: '10', nxt_key: '',
                Record1: [{
                    trd_dt: '20260922', shrt_is_cd: 'A005930', stnd_is_cd: 'KR7005930003', is_nm: '삼성전자', crdt_typ_cd: '00', trd_dl_ccd: '01',
                    ccls_q: '10', ccls_uprc: '72000', b_uprc: '70000', s_amt: '720000', b_amt: '700000', fee: '100', svrl_tx: '1300', rlztn_pl: '18600', yld: '2.65',
                }],
            },
        });

        const result = await newExchange().fetchRealizedPnlDaily(Date.UTC(2026, 8, 20, 15, 0)); // 한국 9/21 00:00

        expect(trBody(mockFetch, KBSEC_TR.PNL_DAILY).dataBody).toEqual({
            is_cd: '', inq_strt_dt: '20260921', inq_end_dt: '20260924', md_clsf: '1', nxt_key: '',
        });
        expect(result.rows).toEqual([{
            timestamp: Date.parse('2026-09-21T15:00:00Z'), datetime: '2026-09-21T15:00:00.000Z',
            date: '20260922', shortCode: 'A005930', standardCode: 'KR7005930003', name: '삼성전자', creditTypeCode: '00', tradeTypeCode: '01',
            quantity: 10, price: 72000, buyPrice: 70000, sellAmount: 720000, buyAmount: 700000, fee: 100, tax: 1300, realizedPnl: 18600, returnRate: 2.65,
            info: expect.objectContaining({ trd_dt: '20260922' }),
        }]);
    });

    it('종목별은 오프라인 1 과 params.until 을 보내고 한 줄을 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.PNL_BY_SYMBOL]: {
                nxt_key: '',
                Record1: [{
                    is_cd: 'A005930', shrt_is_cd: '005930', is_nm: '삼성전자', rlztn_pl: '18600', pl_r: '2.65', thdy_s_q: '10', s_ccls_uprc: '72000',
                    s_amt: '720000', s_fee: '100', s_svrl_tx: '1300', b_avr_uprc: '70000', b_amt: '700000', b_fee: '100',
                }],
            },
        });

        const result = await newExchange().fetchRealizedPnlBySymbol('OFFLINE', Date.UTC(2026, 8, 20, 15, 0), { until: Date.UTC(2026, 8, 22, 15, 0) });

        expect(trBody(mockFetch, KBSEC_TR.PNL_BY_SYMBOL).dataBody).toEqual({
            inq_strt_dt: '20260921', inq_end_dt: '20260923', md_clsf: '1', nxt_key: '',
        });
        expect(result.rows[0]).toMatchObject({
            code: 'A005930', shortCode: '005930', name: '삼성전자', realizedPnl: 18600, pnlRate: 2.65, sellQuantity: 10, sellPrice: 72000,
            sellAmount: 720000, sellFee: 100, sellTax: 1300, buyAveragePrice: 70000, buyAmount: 700000, buyFee: 100,
        });
    });

    it('since 가 없거나 매체구분을 모르면 요청 없이 거절한다', async () => {
        routeTr(mockFetch, {});
        const ex = newExchange();

        await expect(ex.fetchRealizedPnlDaily()).rejects.toThrow(ArgumentsRequired);
        await expect(ex.fetchRealizedPnlBySymbol('MOBILE' as never, Date.UTC(2026, 8, 20))).rejects.toThrow(NotSupported);
        expect(calledTrs(mockFetch)).toEqual([]);
    });
});

describe('fetchIntegratedBalance', () => {
    it('계좌별, 전체, 통합(A)을 보내고 머리 합계와 종목 행을 옮긴다. 수량은 blnc_q_p6 로 읽는다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.INTEGRATED_BALANCE]: {
                val_amt_sum: '720000', byng_amt_sum: '700000', pl_amt_sum: '20000', tfnd: '100000', ordr_psbl_csh: '90000', o_amt_psbl_amt: '80000',
                Record1: [{
                    is_cd: '005930', is_nm: '삼성전자', gds_typ: '01 종합위탁', clsf: '현금', crncy_cd: '', blnc_q_p6: '10.000000', blnc_q: '0',
                    ordr_psbl_q_p6: '10.000000', byng_avr_prc: '70000', now_prc: '72000', val_amt: '720000', pl_amt: '20000', yld: '2.85',
                }, { is_cd: '', is_nm: '', blnc_q_p6: '0' }],
            },
        });

        const b = await newExchange().fetchIntegratedBalance();

        expect(trBody(mockFetch, KBSEC_TR.INTEGRATED_BALANCE).dataBody).toEqual({ inq_clsf: '1', scrts_ccd: '0', bnd_val_wy_cd: '', excg_mktpr_ccd: 'A' });
        expect(b).toMatchObject({ valuation: 720000, purchaseAmount: 700000, pnl: 20000, deposit: 100000, orderableCash: 90000, withdrawable: 80000 });
        expect(b.holdings).toEqual([{
            code: '005930', name: '삼성전자', productType: '01 종합위탁', kind: '현금', currency: '', quantity: 10, orderableQuantity: 10,
            averagePrice: 70000, price: 72000, valuation: 720000, pnl: 20000, returnRate: 2.85, info: expect.objectContaining({ blnc_q: '0' }),
        }]);
    });
});

describe('배선', () => {
    it('새 TR 7개가 API 트리에 조회로 올라 있다', () => {
        const api = newExchange().describe().api as Record<string, Record<string, Record<string, { cost: number; order?: boolean }>>>;
        const leaves = Object.values(api).flatMap((section) => Object.values(section).flatMap((methods) => Object.entries(methods)));
        const codes = [
            KBSEC_TR.HOLIDAYS_US, KBSEC_TR.ACCOUNT_SUMMARY, KBSEC_TR.ASSET_EVAL_REALTIME, KBSEC_TR.FRAC_ORDER_HISTORY_US, KBSEC_TR.PNL_DAILY,
            KBSEC_TR.PNL_BY_SYMBOL, KBSEC_TR.INTEGRATED_BALANCE,
        ];
        for (const code of codes) {
            const leaf = leaves.find(([name]) => name === code.toLowerCase());
            expect(leaf, code).toBeDefined();
            expect(leaf?.[1].order, code).toBeUndefined();
            expect(KBSEC_ORDER_TR_CODES.has(code), code).toBe(false);
        }
    });
});
