/**
 * @fileoverview 소수점 내역 조회 — `fetchFractionalTrades`(`SSQM5765`), `fetchFractionalOrders`(`SSQM5475`),
 * `fetchOverseasFractionalOrders`(`SPQN5473`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = (options: Record<string, unknown> = {}) => new kbsec({ ...CREDS, rateLimit: 0, options });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fetchFractionalTrades', () => {
    const trade = (side: string) => ({
        trd_dt: '20260922', acpt_no: '101', is_cd: 'A005930', is_nm: '삼성전자', trd_dl_ccd: side, ordr_amt: '10000',
        dmstc_stk_dcml_ordr_q_p6: '0.140845', ordr_prc: '71000', dmstc_stk_dcml_ccls_q_p6: '0.140845', ccls_prc: '71000',
        ccls_amt: '10000', fee: '15', dl_tx: '0', ec_amt: '10015', rfsl_rsn: '', hndl_p_eno_nm: '시스템',
    });

    it('전체(0)를 보내고, since 가 없으면 매매일자를 비운다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_TRADES_KR]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchFractionalTrades();

        expect(trBody(mockFetch, KBSEC_TR.FRAC_TRADES_KR).dataBody).toEqual({
            ordr_clsf: '0', trd_clsf: '0', trd_strt_dt: '', trd_end_dt: '', is_cd: '', nxt_key: '',
        });
    });

    it('since 를 주면 한국 날짜로 시작일을 채우고 끝은 오늘이다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z')); // KST 9/23
        routeTr(mockFetch, { [KBSEC_TR.FRAC_TRADES_KR]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchFractionalTrades(Date.UTC(2026, 8, 1, 16, 0));

        expect(trBody(mockFetch, KBSEC_TR.FRAC_TRADES_KR).dataBody).toMatchObject({ trd_strt_dt: '20260902', trd_end_dt: '20260923' });
    });

    it('매매거래구분코드 01, 02 만 방향으로 옮기고 나머지는 unknown 이다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_TRADES_KR]: { nxt_key: '', Record1: [trade('02'), trade('01'), trade('9')] } });

        const { rows } = await newExchange().fetchFractionalTrades();

        expect(rows.map(r => r.side)).toEqual(['buy', 'sell', 'unknown']);
        expect(rows[0]).toMatchObject({
            date: '20260922', symbol: '005930/KRW', orderQuantity: 0.140845, filledAmount: 10000, fee: 15, settledAmount: 10015,
        });
        expect(rows[0]!.info).toHaveProperty('hndl_p_eno_nm', '시스템');
    });
});

describe('fetchFractionalOrders', () => {
    it('필수 조회일자는 since 가 없으면 오늘 하루이고, 구분 입력은 설명된 전체 값을 보낸다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z')); // KST 9/23
        routeTr(mockFetch, { [KBSEC_TR.FRAC_ORDERS_KR]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchFractionalOrders();

        expect(trBody(mockFetch, KBSEC_TR.FRAC_ORDERS_KR).dataBody).toEqual({
            inq_strt_dt: '20260923', inq_end_dt: '20260923', trd_clsf: '99', is_cd: '', ordr_st: '0', dl_clsf: '0', nxt_key: '',
        });
    });

    it('한 줄을 옮기고 방향은 매매구분명 원문으로만 둔다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.FRAC_ORDERS_KR]: {
                nxt_key: '', prd_pr_dmstc_stk_b_sum: '99999',
                Record1: [{
                    dl_clsf: '2', ordr_dt: '20260922', ordr_no: '5001', orgn_ordr_no: '', shrt_is_cd: 'A005930', hngl_shrt_nm: '삼성전자',
                    cs_nm: '홍길동', trd_clsf_nm: '매수', krw_ordr_amt: '10000', ordr_q_p6: '0.140845', ordr_prc_p4: '71000',
                    dcml_ccls_q_p6: '0.140845', ccls_prc_p4: '71000', ccls_amt: '10000', fee: '15', nccls_q: '0', hndl_rslt: '정상',
                    rfsl_rsn_cntnt: '', ordr_tm: '093015',
                }],
            },
        });

        const { rows } = await newExchange().fetchFractionalOrders();

        expect(rows).toMatchObject([{
            date: '20260922', time: '093015', id: '5001', symbol: '005930/KRW', name: '삼성전자', dealType: '2', sideName: '매수',
            orderAmount: 10000, orderQuantity: 0.140845, filledQuantity: 0.140845, filledAmount: 10000, fee: 15, remainingQuantity: 0,
            result: '정상',
        }]);
        expect(rows[0]).not.toHaveProperty('side');
        expect(rows[0]!.info).toHaveProperty('cs_nm', '홍길동');
    });
});

describe('fetchOverseasFractionalOrders', () => {
    it('전체 값(99, 3)을 보내고 행마다 방향과 통화를 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.FRAC_ORDERS_US]: {
                nxt_key: '',
                Record1: [
                    { ordr_dt: '20260922', acpt_no: '7', shrt_is_cd: 'AAPL', is_nm: '애플', trd_clsf: '02', crncy_cd: 'USD', fcrncy_ordr_amt: '50',
                        ordr_q: '0', frgn_ordr_prc_p4: '0', fee: '0.12', ordr_st: '1', hndl_rslt: '접수', acpt_tm: '223001' },
                    { ordr_dt: '20260922', acpt_no: '8', shrt_is_cd: 'MSFT', trd_clsf: 'XX', crncy_cd: '' },
                ],
            },
        });

        const { rows } = await newExchange().fetchOverseasFractionalOrders();

        expect(trBody(mockFetch, KBSEC_TR.FRAC_ORDERS_US).dataBody).toEqual({
            trd_clsf: '99', is_cd: '', frgn_krx_ccd: '', ordr_st: '3', nxt_key: '', spclz_ordr_ccd: '',
        });
        expect(rows[0]).toMatchObject({
            date: '20260922', time: '223001', acceptNo: '7', symbol: 'AAPL/USD', side: 'buy', currency: 'USD', amount: 50, fee: 0.12,
            statusCode: '1', result: '접수',
        });
        expect(rows[1]).toMatchObject({ symbol: 'MSFT/USD', side: 'unknown', currency: '' });
    });
});
