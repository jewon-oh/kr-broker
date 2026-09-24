/**
 * @fileoverview `kbsec.fetchMarketFundFlow` — 증시주변자금동향(`IVA10370`). 입력 없이 헤드라인 지표만 정리한다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchMarketFundFlow', () => {
    it('고객예탁금·미수금·신용잔고·선물예수금을 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.MARKET_FUND_FLOW]: {
                dt: '20260923',
                cs_dpst: '55000000000000', cs_dpst_cmpr_amt: '120000000000',
                rcvamt: '300000000000', rcvamt_cmpr_amt: '-5000000000',
                crdt_blnc: '19000000000000', crdt_blnc_cmpr_amt: '80000000000',
                fts_tfnd: '12000000000000', fts_tfnd_cmpr_amt: '-30000000000',
            },
        });

        const result = await newExchange().fetchMarketFundFlow();

        expect(trBody(mockFetch, KBSEC_TR.MARKET_FUND_FLOW).dataBody).toEqual({});
        expect(result).toMatchObject({
            date: '20260923',
            customerDeposit: 55000000000000, customerDepositChange: 120000000000,
            receivables: 300000000000, receivablesChange: -5000000000,
            creditBalance: 19000000000000, creditBalanceChange: 80000000000,
            futuresDeposit: 12000000000000, futuresDepositChange: -30000000000,
        });
    });
});
