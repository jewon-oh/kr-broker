/**
 * @fileoverview `kbsec.fetchMarketOverview` — 시장종합(`IVSA0070`). 머리 필드와 그리드 네 개를 한 번에 준다.
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

const HEADER = {
    inq_dy_tm: '20260923101500',
    kspi_ulmt_is_c: '3', kspi_up_is_c: '512', kspi_unchng_is_c: '80', kspi_dwn_is_c: '310', kspi_llmt_is_c: '1',
    ksdq_ulmt_is_c: '7', ksdq_up_is_c: '900', ksdq_unchng_is_c: '120', ksdq_dwn_is_c: '640', ksdq_llmt_is_c: '0',
    mprft_nt_b: '-1,200', nmp_nt_b: '3400',
    cs_dpst_5: '55000000',
};
const INDEX = { indx_id: '001', indx_nm: '코스피', now_indx_p2: '2650.12', bdy_cmpr_ccd: '2', bdy_cmpr_p2: '12.34', up_dwn_r_p2: '0.47', vlm: '400000', dl_tw_amt: '9000000' };
const DERIV = { is_cd: '101W9000', is_nm: '코스피200 선물', now_prc_p2: '350.25', bdy_cmpr_ccd: '5', bdy_cmpr_p2: '-1.5', up_dwn_r_p2: '-0.43', vlm: '200000', nstmt_agr_q: '310000' };
const WORLD = { symbl_cd: 'NAS@IXIC', symbl_nm: '나스닥', now_prc: '18000.5', bdy_cmpr_ccd: '2', bdy_cmpr_p2: '100.1', up_dwn_r_p2: '0.56', dt_tm: '20260922170000' };
const INVESTOR = {
    invstr_cd: '8', invstr_clsf_nm: '개인', kspi_nt_b: '-500', ksdq_nt_b: '700', fts_nt_b: '10', call_opt_nt_b: '2', put_opt_nt_b: '-3',
    star_fts_nt_b: '0', stk_fts_nt_b: '4',
};

describe('fetchMarketOverview', () => {
    it('입력 없이 부르고 머리 필드의 등락 종목 수와 차익, 비차익 순매수를 옮긴다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_OVERVIEW]: { ...HEADER } });

        const o = await newExchange().fetchMarketOverview();

        expect(trBody(mockFetch, KBSEC_TR.MARKET_OVERVIEW).dataBody).toEqual({});
        expect(o.queriedAt).toBe('20260923101500');
        expect(o.kospi).toEqual({ upperLimit: 3, advancing: 512, unchanged: 80, declining: 310, lowerLimit: 1 });
        expect(o.kosdaq).toEqual({ upperLimit: 7, advancing: 900, unchanged: 120, declining: 640, lowerLimit: 0 });
        expect(o).toMatchObject({ arbitrageNetBuy: -1200, nonArbitrageNetBuy: 3400, indices: [], derivatives: [], globals: [], investors: [] });
        expect(o.info).toHaveProperty('cs_dpst_5', '55000000');
    });

    it('그리드는 순서가 아니라 저마다 있는 필드로 고른다', async () => {
        // 응답의 그리드 순서를 일부러 뒤섞는다. 전일대비 같은 이름은 여러 그리드에 같이 있다.
        routeTr(mockFetch, {
            [KBSEC_TR.MARKET_OVERVIEW]: { ...HEADER, Record4: [INVESTOR], Record3: [WORLD], Record1: [DERIV], Record2: [INDEX] },
        });

        const o = await newExchange().fetchMarketOverview();

        expect(o.indices).toMatchObject([{ id: '001', name: '코스피', value: 2650.12, change: 12.34, percentage: 0.47, volume: 400000, tradingValue: 9000000 }]);
        expect(o.derivatives).toMatchObject([{ code: '101W9000', price: 350.25, change: -1.5, percentage: -0.43, openInterest: 310000 }]);
        expect(o.globals).toMatchObject([{ code: 'NAS@IXIC', name: '나스닥', price: 18000.5, dateTime: '20260922170000' }]);
        expect(o.investors).toMatchObject([{
            code: '8', name: '개인', kospi: -500, kosdaq: 700, futures: 10, callOptions: 2, putOptions: -3, starFutures: 0, stockFutures: 4,
        }]);
        expect(o.indices[0].info).toHaveProperty('bdy_cmpr_ccd', '2');
    });
});
