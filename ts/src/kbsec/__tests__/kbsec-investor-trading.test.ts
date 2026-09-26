/**
 * @fileoverview `kbsec.fetchInvestorTrading` — 종목별투자자(`IVU10430`). 세 증권사 공통 모양(`InvestorTradingRecord`)으로 준다.
 * 13개 투자자 유형 가운데 개인·외국인·기관만 필드로 싣고, 나머지는 `info` 원문에 있다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { NotSupported } from '../../base/errors';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchInvestorTrading', () => {
    it('기본은 오늘 하루·순매수·금액 기준이고, 개인·외국인·기관을 공통 모양으로 돌려준다. 나머지 유형은 info 원문에 있다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.INVESTOR_TRADING]: {
                Record1: [{
                    dt: '20260922', cls_prc: '71000', bdy_cmpr: '500', up_dwn_r_p2: '0.71', vlm: '123456',
                    indv: '-1000000', fgnr: '800000', ogn: '200000', scrt: '10000', insr: '20000', invst_trst: '30000', invst_bnk: '0',
                    bnk: '0', fnd: '5000', prv_o_fnd: '1000', etc_corp: '2000', ntn: '0', ntv_fgnr: '0', pgm: '15000', frgn_afflt_dl_orgn_sum: '3000',
                }],
            },
        });

        const [record] = await newExchange().fetchInvestorTrading('005930/KRW');

        const body = trBody(mockFetch, KBSEC_TR.INVESTOR_TRADING).dataBody;
        expect(body).toMatchObject({ excg_clsf: '1', is_cd: '005930', amt_q_clsf: '1', trd_clsf: '1', acml_clsf: '0' });
        expect(body.strt_dt).toBe(body.end_dt);
        expect(record).toEqual({
            timestamp: Date.parse('2026-09-21T15:00:00Z'), datetime: '2026-09-21T15:00:00.000Z',
            date: '20260922', close: 71000, change: 500, individual: -1000000, foreign: 800000, institution: 200000,
            info: expect.objectContaining({ up_dwn_r_p2: '0.71', vlm: '123456', scrt: '10000', pgm: '15000' }),
        });
    });

    it('params 로 trd_clsf·amt_q_clsf 를 덮어쓸 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.INVESTOR_TRADING]: { Record1: [{ dt: '20260922' }] } });

        await newExchange().fetchInvestorTrading('005930/KRW', undefined, undefined, { trd_clsf: '2', amt_q_clsf: '2' });

        expect(trBody(mockFetch, KBSEC_TR.INVESTOR_TRADING).dataBody).toMatchObject({ trd_clsf: '2', amt_q_clsf: '2' });
    });

    it('기간 끝은 params.until 의 한국 날짜로 보내고 요청에 싣지 않는다. 행마다 한국 날짜의 timestamp 를 채우고 limit 을 적용한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.INVESTOR_TRADING]: { Record1: [{ dt: '20260922' }, { dt: '20260921' }, { dt: '20260918' }] } });

        const records = await newExchange().fetchInvestorTrading('005930/KRW', Date.parse('2026-09-01T03:00:00Z'), 2, { until: Date.parse('2026-09-22T03:00:00Z') });

        const body = trBody(mockFetch, KBSEC_TR.INVESTOR_TRADING).dataBody;
        expect(body).toMatchObject({ strt_dt: '20260901', end_dt: '20260922' });
        expect(body).not.toHaveProperty('until');
        expect(records.map((r) => r.date)).toEqual(['20260921', '20260918']);
        expect(records[0]).toMatchObject({ timestamp: Date.parse('2026-09-20T15:00:00Z'), datetime: '2026-09-20T15:00:00.000Z' });
    });

    it('해외 종목은 NotSupported', async () => {
        await expect(newExchange().fetchInvestorTrading('AAPL/USD')).rejects.toThrow(NotSupported);
    });
});
