/**
 * @fileoverview `kbsec.fetchInvestorRanking` — 외국인·기관매매상위(`IVU10020`, 국내만).
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

describe('fetchInvestorRanking', () => {
    it('FOREIGNER·BUY 는 투자자구분코드=0, 순위구분=0 으로 부르고 공통 필드로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.INVESTOR_RANKING]: {
                Record1: [{
                    shrt_is_cd: '005930', is_nm: '삼성전자', now_prc: '85000', bdy_cmpr: '1200', bdy_cmpr_r_p2: '1.43',
                    vlm: '5000000', nt_b_s_q: '120000', hld_rt_p2: '51.2',
                }],
            },
        });

        const [item] = await newExchange().fetchInvestorRanking('FOREIGNER', 'BUY');

        const body = trBody(mockFetch, KBSEC_TR.INVESTOR_RANKING).dataBody;
        expect(body).toMatchObject({ invstr_ccd: '0', rnk_clsf: '0', excg_clsf: '1', mkt_clsf: '1' });
        expect(item).toMatchObject({
            symbol: '005930/KRW', name: '삼성전자', last: 85000, change: 1200, percentage: 1.43,
            volume: 5000000, netQuantity: 120000, holdingRate: 51.2,
        });
    });

    it('INSTITUTION·SELL 은 투자자구분코드=1, 순위구분=1 로 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.INVESTOR_RANKING]: { Record1: [] } });

        await newExchange().fetchInvestorRanking('INSTITUTION', 'SELL');

        expect(trBody(mockFetch, KBSEC_TR.INVESTOR_RANKING).dataBody).toMatchObject({ invstr_ccd: '1', rnk_clsf: '1' });
    });

    it('params 로 기간구분을 덮어쓸 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.INVESTOR_RANKING]: { Record1: [] } });

        await newExchange().fetchInvestorRanking('FOREIGNER', 'BUY', { prd_clsf: '5' });

        expect(trBody(mockFetch, KBSEC_TR.INVESTOR_RANKING).dataBody).toMatchObject({ prd_clsf: '5' });
    });
});
