/**
 * @fileoverview `kbsec.fetchExchangeRates` — 환율종합(`IVA60190`). 입력 없이 전 통화 종가를 받는다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchExchangeRates', () => {
    it('환율종합(IVA60190)을 입력 없이 부르고 공통 필드로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.EXCHANGE_RATES]: {
                Record1: [
                    { crncy_cd: 'USD', ntn_nm: '미국', crncy_cd_nm: '미국달러', cls_prc_p4: '1350.5', bdy_cmpr_p4: '5.2', bdy_cmpr_r_p2: '0.39' },
                ],
            },
        });

        const [item] = await newExchange().fetchExchangeRates();

        expect(trBody(mockFetch, KBSEC_TR.EXCHANGE_RATES).dataBody).toEqual({});
        expect(item).toMatchObject({
            currency: 'USD', countryName: '미국', currencyName: '미국달러', close: 1350.5, change: 5.2, percentage: 0.39,
        });
    });

    it('통화가 여럿이면 전부 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.EXCHANGE_RATES]: {
                Record1: [
                    { crncy_cd: 'USD', ntn_nm: '미국', crncy_cd_nm: '미국달러', cls_prc_p4: '1350.5', bdy_cmpr_p4: '5.2', bdy_cmpr_r_p2: '0.39' },
                    { crncy_cd: 'JPY', ntn_nm: '일본', crncy_cd_nm: '일본엔', cls_prc_p4: '9.05', bdy_cmpr_p4: '-0.02', bdy_cmpr_r_p2: '-0.22' },
                ],
            },
        });

        const rates = await newExchange().fetchExchangeRates();

        expect(rates).toHaveLength(2);
        expect(rates[1]).toMatchObject({ currency: 'JPY', close: 9.05, percentage: -0.22 });
    });
});
