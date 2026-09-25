/**
 * @fileoverview `fetchLedgerEntryDetail`(`SWQM2412`), `fetchCorporateActions`(`SRQM3051`), `fetchOverseasOrders`(`SPQM1818`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { BadResponse } from '../../base/errors';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fetchLedgerEntryDetail', () => {
    it('일자와 거래일련번호로 부르고 한 건짜리 응답을 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.LEDGER_DETAIL]: {
                nxt_key: '', dl_sq: '17', dl_knd_cd: '1101', dl_knd_nm: '현금매수', is_no: 'A005930', is_nm: '삼성전자', dl_q: '10',
                uprc_p4: '71000', dl_amt: '710000', fee: '100', dl_tx: '0', ec_amt: '710100', smry: '장내매수', tfnd_tdy_ra: '289900',
                rsdnt_rno: '900101-1******',
            },
        });

        const d = await newExchange().fetchLedgerEntryDetail('20260922', '17');

        expect(trBody(mockFetch, KBSEC_TR.LEDGER_DETAIL).dataBody).toEqual({ inq_dt: '20260922', dl_sq: '17', nxt_key: '' });
        expect(d).toMatchObject({
            sequence: '17', kindCode: '1101', kindName: '현금매수', code: 'A005930', name: '삼성전자', quantity: 10, price: 71000,
            amount: 710000, fee: 100, tax: 0, settledAmount: 710100, summary: '장내매수', cashBalance: 289900,
        });
        expect(d.info).toHaveProperty('rsdnt_rno', '900101-1******');
    });

    it('거래일련번호와 거래종류 필드가 둘 다 없으면 BadResponse 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.LEDGER_DETAIL]: { nxt_key: '' } });

        await expect(newExchange().fetchLedgerEntryDetail('20260922', '17')).rejects.toBeInstanceOf(BadResponse);
    });
});

describe('fetchCorporateActions', () => {
    it('권리구분은 전체(0)를 보내고, since 가 없으면 시작일자를 비운다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CORPORATE_ACTIONS]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchCorporateActions();

        expect(trBody(mockFetch, KBSEC_TR.CORPORATE_ACTIONS).dataBody).toEqual({ strt_dt: '', rgt_clsf: '0', is_cd: '', nxt_key: '' });
    });

    it('since 를 한국 날짜로 보내고 한 줄을 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.CORPORATE_ACTIONS]: {
                nxt_key: '',
                Record1: [{
                    bss_dt: '20260630', is_cd: 'A005930', is_nm: '삼성전자', rgt_ccd_nm: '배당', hld_q: '100', alct_q: '0', rgt_rt: '0',
                    isng_prc: '0', csh_py_dt: '20260820', stck_io_stck_dt: '', dvdnd_expt_amt: '36100', dvdnd_dfnt_amt: '36100', hndl_p_nm: '시스템',
                }],
            },
        });

        const { rows } = await newExchange().fetchCorporateActions(Date.UTC(2026, 0, 1, 0, 0));

        expect(trBody(mockFetch, KBSEC_TR.CORPORATE_ACTIONS).dataBody).toMatchObject({ strt_dt: '20260101' });
        expect(rows).toMatchObject([{
            baseDate: '20260630', symbol: '005930/KRW', rightName: '배당', quantity: 100, cashPaymentDate: '20260820',
            expectedDividend: 36100, confirmedDividend: 36100,
        }]);
    });
});

describe('fetchOverseasOrders', () => {
    it('설명된 전체와 외화(0)를 보내고, since 가 없으면 주문일자와 시간을 비운다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDER_HISTORY_US]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchOverseasOrders();

        expect(trBody(mockFetch, KBSEC_TR.ORDER_HISTORY_US).dataBody).toEqual({
            strt_ordr_dt: '', end_ordr_dt: '', ccls_clsf: '0', frgn_krx_ccd: '', trd_clsf: '99', stnd_is_cd: '', iso_cd: '',
            krw_unty_mgn_rqst_f: '0', start_tm: '', end_tm: '', dl_clsf: '0', nxt_key: '',
        });
    });

    it('since 는 미국 현지 일자로 바꾸고 끝은 오늘이다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-23T02:00:00Z')); // 미국 동부 9/22 22:00
        routeTr(mockFetch, { [KBSEC_TR.ORDER_HISTORY_US]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchOverseasOrders(Date.UTC(2026, 8, 21, 2, 0)); // 미국 동부 9/20 22:00

        expect(trBody(mockFetch, KBSEC_TR.ORDER_HISTORY_US).dataBody).toMatchObject({ strt_ordr_dt: '20260920', end_ordr_dt: '20260922' });
    });

    it('한 줄을 옮기고 표준종목코드와 상태명은 원문으로 둔다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.ORDER_HISTORY_US]: {
                nxt_key: '',
                Record1: [{
                    ordr_dt: '20260922', ordr_tm: '223001', ordr_no: '9001', orgn_ordr_no: '', ac_no: '12345678901', stnd_is_cd: 'US0378331005',
                    is_nm: '애플', ordr_st_nm: '미체결', ordr_clsf_nm: '매수', crncy_cd: 'USD', frgn_ordr_q_p6: '2', frgn_ordr_prc_p6: '230.5',
                    ccls_q_p6: '0', frgn_ccls_prc_p6: '0', nccls_q_p6: '2', rfsl_rsn: '',
                }],
            },
        });

        const { rows } = await newExchange().fetchOverseasOrders();

        expect(rows).toMatchObject([{
            date: '20260922', time: '223001', id: '9001', standardCode: 'US0378331005', name: '애플', statusName: '미체결', currency: 'USD',
            quantity: 2, price: 230.5, filledQuantity: 0, remainingQuantity: 2,
        }]);
        expect(rows[0]).not.toHaveProperty('symbol');
        expect(rows[0]!.info).toHaveProperty('ac_no', '12345678901');
    });
});
