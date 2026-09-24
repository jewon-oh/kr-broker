/**
 * @fileoverview `kbsec.fetchAccountLedger`·`fetchCmaLedger` — 계좌원장 거래내역(`SWQA2301`·`SWQB2301`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = (options: Record<string, unknown> = {}) => new kbsec({ ...CREDS, rateLimit: 0, options });

const entry = (sq: string) => ({
    dl_dt: '20260922', dl_sq: sq, smry_nm: '현금매수', stnd_is_cd: 'KR7005930003', is_nm: '삼성전자', q: '10', dl_uprc: '71000',
    dl_amt: '710000', ec_amt: '710100', fee: '100', tfnd_blnc: '289900',
});

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fetchAccountLedger', () => {
    it('since 가 없으면 오늘(한국 날짜) 하루치를 부른다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z')); // KST 9/23 01:30
        routeTr(mockFetch, { [KBSEC_TR.LEDGER]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchAccountLedger();

        expect(trBody(mockFetch, KBSEC_TR.LEDGER).dataBody).toMatchObject({ strt_dt: '20260923', end_dt: '20260923' });
    });

    it('since·until 을 한국 날짜로 바꿔 보내고, until 은 요청 본문에 싣지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.LEDGER]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchAccountLedger(Date.UTC(2026, 8, 1, 16, 0), { until: Date.UTC(2026, 8, 10, 0, 0) });

        const body = trBody(mockFetch, KBSEC_TR.LEDGER).dataBody;
        expect(body).toMatchObject({ strt_dt: '20260902', end_dt: '20260910' });
        expect(body).not.toHaveProperty('until');
    });

    it('설명이 있는 입력은 설명대로, 설명이 없는 선택 입력은 비워 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.LEDGER]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchAccountLedger();

        expect(trBody(mockFetch, KBSEC_TR.LEDGER).dataBody).toMatchObject({
            inq_clsf: '1', inq_clsf1: '1', inq_clsf2: '1', inq_clsf3: '1', inq_clsf4: '1', inq_clsf5: '1', inq_clsf6: '1',
            srt_clsf: '1', dl_clsf: '', dl_md_ccd: '', onl_prt_ccd: '', md_isnc_tno: '', crdt_crd_isnc_info: '', isng_bl_at_trsns_xcl_f: '',
        });
    });

    it('원장 한 줄을 원문 그대로 옮긴다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.LEDGER]: { nxt_key: '', Record1: [entry('17')] } });

        const { rows, truncated } = await newExchange().fetchAccountLedger();

        expect(truncated).toBe(false);
        expect(rows).toMatchObject([{
            date: '20260922', sequence: '17', summary: '현금매수', standardCode: 'KR7005930003', name: '삼성전자', quantity: 10,
            price: 71000, amount: 710000, settledAmount: 710100, fee: 100, cashBalance: 289900,
        }]);
    });

    it('연속조회 상한은 ledgerMaxPages 를 따른다', async () => {
        let n = 0;
        routeTr(mockFetch, { [KBSEC_TR.LEDGER]: () => ({ nxt_key: `K${++n}`, Record1: [entry(String(n))] }) });

        const { rows, truncated } = await newExchange({ ledgerMaxPages: 3, holdingsMaxPages: 1 }).fetchAccountLedger();

        expect(rows).toHaveLength(3);
        expect(truncated).toBe(true);
        expect(calledTrs(mockFetch).filter(tr => tr === KBSEC_TR.LEDGER.toLowerCase())).toHaveLength(3);
    });
});

describe('fetchCmaLedger', () => {
    it('CMA 원장 TR 을 부르고, dl_clsf 대신 현금자산이자입금제외여부를 비워 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.LEDGER_CMA]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchCmaLedger(Date.UTC(2026, 8, 1, 16, 0), { until: Date.UTC(2026, 8, 10, 0, 0) });

        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.LEDGER.toLowerCase());
        const body = trBody(mockFetch, KBSEC_TR.LEDGER_CMA).dataBody;
        expect(body).toMatchObject({
            strt_dt: '20260902', end_dt: '20260910', inq_clsf: '1', srt_clsf: '1', csh_asts_itst_i_amt_xcl_f: '', isng_bl_at_trsns_xcl_f: '',
        });
        expect(body).not.toHaveProperty('dl_clsf');
        expect(body).not.toHaveProperty('until');
    });

    it('거래단가는 uprc 에서 읽는다', async () => {
        const { dl_uprc: _unused, ...rest } = entry('3');
        routeTr(mockFetch, { [KBSEC_TR.LEDGER_CMA]: { nxt_key: '', Record1: [{ ...rest, uprc: '1000' }] } });

        const { rows } = await newExchange().fetchCmaLedger();

        expect(rows).toMatchObject([{ sequence: '3', price: 1000, amount: 710000, cashBalance: 289900 }]);
    });

    it('연속조회 상한은 위탁 원장과 같은 ledgerMaxPages 를 따른다', async () => {
        let n = 0;
        routeTr(mockFetch, { [KBSEC_TR.LEDGER_CMA]: () => ({ nxt_key: `K${++n}`, Record1: [entry(String(n))] }) });

        const { rows, truncated } = await newExchange({ ledgerMaxPages: 2 }).fetchCmaLedger();

        expect(rows).toHaveLength(2);
        expect(truncated).toBe(true);
    });
});
