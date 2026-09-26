/**
 * @fileoverview `kbsec.fetchFractionalBuyableAmount`(`SSQN5472`·`SPQN5472`)와 `kbsec.fetchOverseasFractionalHoldings`(`SPQM5472`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = (options: Record<string, unknown> = {}) => new kbsec({ ...CREDS, rateLimit: 0, options });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchFractionalBuyableAmount', () => {
    it('국내 종목은 SSQN5472 에 종목코드와 내림한 주문금액을 보내고 원화로 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.FRAC_BUYABLE_KR]: {
                mx_ordr_psbl_amt: '1,500,000', pcnt100_ordr_psbl_amt: '1400000', fee_r_p10: '0.0015', expct_fee: '15',
                val_sprc_p8: '71000', expct_stk_q_p6: '0.140845',
            },
        });

        const r = await newExchange().fetchFractionalBuyableAmount('005930/KRW', 10000.9);

        expect(trBody(mockFetch, KBSEC_TR.FRAC_BUYABLE_KR).dataBody).toEqual({ is_cd: '005930', ordr_amt: '10000' });
        expect(r).toMatchObject({
            amount: 1500000, currency: 'KRW', expectedQuantity: 0.140845, expectedFee: 15, feeRate: 0.0015, referencePrice: 71000,
        });
        expect(r.info).toHaveProperty('pcnt100_ordr_psbl_amt', '1400000');
        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.FRAC_BUYABLE_US.toLowerCase());
    });

    it('주문금액을 주지 않으면 비워 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_BUYABLE_KR]: { mx_ordr_psbl_amt: '0' } });

        await newExchange().fetchFractionalBuyableAmount('005930/KRW');

        expect(trBody(mockFetch, KBSEC_TR.FRAC_BUYABLE_KR).dataBody).toEqual({ is_cd: '005930', ordr_amt: '' });
    });

    it('미국 종목은 SPQN5472 에 짝 주문 TR 과 같은 값(US, 금액, 외화, 유사시장가)을 보내고 외화로 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.FRAC_BUYABLE_US]: {
                krw_exch_unty_ordr_psbl_amt: '1,380,000', fcrncy_unty_ordr_psbl_amt_p2: '1000.25', aplc_exch_r: '1380',
                fee_r_p10: '0.0025', expct_fee: '345', val_sprc_p8: '230.5', expct_stk_q_p6: '0.216919', fcrncy_fee_p2: '0.25',
            },
        });

        const r = await newExchange().fetchFractionalBuyableAmount('AAPL/USD', 50);

        expect(trBody(mockFetch, KBSEC_TR.FRAC_BUYABLE_US).dataBody).toEqual({
            is_cd: 'AAPL', frgn_krx_ccd: 'US', ordr_amt: '50', dcml_ordr_q_p6: '', amt_q_clsf: '0', crncy_ccd: '1',
            frgn_ordr_typ_cd: 'E', frgn_ordr_prc_p4: '',
        });
        expect(r).toMatchObject({
            amount: 1000.25, currency: 'USD', expectedQuantity: 0.216919, expectedFee: 0.25, feeRate: 0.0025, referencePrice: 230.5,
        });
        expect(r.info).toHaveProperty('krw_exch_unty_ordr_psbl_amt', '1,380,000');
    });
});

describe('fetchOverseasFractionalHoldings', () => {
    const holding = (code: string, currency = 'USD') => ({
        mkt_clsf_nm: '나스닥', iso_cd: 'US0378331005', is_cd: code, is_nm: code, val_pl: '1.5', val_pl_r: '2.1', hld_q: '0.35',
        ordr_psbl_q: '0.35', avr_uprc: '200', val_sprc: '204.3', byng_amt: '70', val_amt: '71.5', crncy_cd: currency,
    });

    it('외화 축(krw_fcrncy_ccd=2)으로 부르고 설명 없는 입력은 비워 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_HOLDINGS_US]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchOverseasFractionalHoldings();

        expect(trBody(mockFetch, KBSEC_TR.FRAC_HOLDINGS_US).dataBody).toEqual({
            is_cd: '', frgn_krx_ccd: '', std_dt: '', krw_fcrncy_ccd: '2', nxt_key: '',
        });
    });

    it('행마다 통화코드를 돌려주고 심볼의 통화도 그 코드로 만든다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_HOLDINGS_US]: { nxt_key: '', Record1: [holding('AAPL'), holding('0700', 'HKD'), holding('MSFT', '')] } });

        const { rows, truncated } = await newExchange().fetchOverseasFractionalHoldings();

        expect(truncated).toBe(false);
        expect(rows.map(r => [r.symbol, r.currency])).toEqual([['AAPL/USD', 'USD'], ['0700/HKD', 'HKD'], ['MSFT/USD', '']]);
        expect(rows[0]).toMatchObject({
            quantity: 0.35, orderableQuantity: 0.35, averagePrice: 200, cost: 70, marketValue: 71.5, unrealizedPnl: 1.5, unrealizedPnlRate: 2.1,
        });
    });

    it('연속조회를 끝까지 따라가고 상한에 걸리면 truncated 다', async () => {
        let n = 0;
        routeTr(mockFetch, { [KBSEC_TR.FRAC_HOLDINGS_US]: () => ({ nxt_key: `K${++n}`, Record1: [holding(`T${n}`)] }) });

        const { rows, truncated } = await newExchange({ holdingsMaxPages: 2 }).fetchOverseasFractionalHoldings();

        expect(rows).toHaveLength(2);
        expect(truncated).toBe(true);
    });
});
