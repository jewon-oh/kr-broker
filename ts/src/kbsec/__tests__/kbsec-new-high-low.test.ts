/**
 * @fileoverview `kbsec.fetchNewHighLow` — 신고가/신저가(`IVU10550`, 국내만).
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

describe('fetchNewHighLow', () => {
    it('HIGH 는 신고저구분코드=1 로 부르고 공통 필드로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.NEW_HIGH_LOW]: {
                Record1: [{ is_cd: '005930', is_nm: '삼성전자', now_prc: '85000', bdy_cmpr: '1200', up_dwn_r_p2: '1.43', vlm: '5000000', hgh_prc: '85500', lw_prc: '83800' }],
            },
        });

        const [item] = await newExchange().fetchNewHighLow('HIGH');

        const body = trBody(mockFetch, KBSEC_TR.NEW_HIGH_LOW).dataBody;
        expect(body).toMatchObject({ nw_stk_lw_ccd: '1', inq_cnt: '10', excg_clsf: '1', mkt_clsf: '1' });
        expect(item).toMatchObject({
            symbol: '005930/KRW', name: '삼성전자', last: 85000, change: 1200, percentage: 1.43, volume: 5000000, high: 85500, low: 83800,
        });
    });

    it('LOW 는 신고저구분코드=2 로 부른다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.NEW_HIGH_LOW]: { Record1: [] } });

        await newExchange().fetchNewHighLow('LOW', 5);

        expect(trBody(mockFetch, KBSEC_TR.NEW_HIGH_LOW).dataBody).toMatchObject({ nw_stk_lw_ccd: '2', inq_cnt: '5' });
    });

    it('params 로 시장 범위를 덮어쓸 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.NEW_HIGH_LOW]: { Record1: [] } });

        await newExchange().fetchNewHighLow('HIGH', 10, { mkt_clsf: '2' });

        expect(trBody(mockFetch, KBSEC_TR.NEW_HIGH_LOW).dataBody).toMatchObject({ mkt_clsf: '2' });
    });
});
