/**
 * @fileoverview `kbsec.fetchCompanyProfile` — 종목기업개요(`IVM10050`). 응답이 종목 하나짜리 단일 객체다(배열 아님).
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

describe('fetchCompanyProfile', () => {
    it('종목코드로 부르고 공통 필드로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.COMPANY_PROFILE]: {
                cptl_amt: '7780000000', lstng_stk_c: '5969782550', opn_prc_tl_amt: '423000000000000',
                dvdnd_yld_p2: '2.15', per: '13.5', pbr_p2: '1.2', eps_p2: '5200', bps_p2: '58000', fgnr_hld_sgrvt_p2: '51.2',
            },
        });

        const profile = await newExchange().fetchCompanyProfile('005930/KRW');

        expect(trBody(mockFetch, KBSEC_TR.COMPANY_PROFILE).dataBody).toMatchObject({ is_cd: '005930' });
        expect(profile).toMatchObject({
            capital: 7780000000, sharesOutstanding: 5969782550, marketCap: 423000000000000,
            dividendYield: 2.15, per: 13.5, pbr: 1.2, eps: 5200, bps: 58000, foreignHoldingRate: 51.2,
        });
    });

    it('PER 이 숫자로 안 읽히면 0이고 원본은 info 에 남는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.COMPANY_PROFILE]: { per: '적자', pbr_p2: '0.8' } });

        const profile = await newExchange().fetchCompanyProfile('005930/KRW');

        expect(profile.per).toBe(0);
        expect(profile.info.per).toBe('적자');
    });
});
