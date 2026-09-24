/**
 * @fileoverview `kbsec.fetchWorldIndices` — 세계지수(`IVA60140`). 대륙 범위(`lnd_clsf`)를 입력으로 받는다.
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

describe('fetchWorldIndices', () => {
    it('기본값은 주요지수(lnd_clsf=1)를 부르고 공통 필드로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.WORLD_INDICES]: {
                Record1: [{ ntn_nm: '미국', is_cd: '.DJI', is_cd_nm: '다우존스', cls_prc_p2: '42000.5', bdy_cmpr_p2: '150.2', bdy_cmpr_r_p2: '0.36' }],
            },
        });

        const [item] = await newExchange().fetchWorldIndices();

        expect(trBody(mockFetch, KBSEC_TR.WORLD_INDICES).dataBody).toMatchObject({ lnd_clsf: '1' });
        expect(item).toMatchObject({
            countryName: '미국', code: '.DJI', name: '다우존스', close: 42000.5, change: 150.2, percentage: 0.36,
        });
    });

    it('ASIA 는 lnd_clsf=S 로 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.WORLD_INDICES]: { Record1: [] } });

        await newExchange().fetchWorldIndices('ASIA');

        expect(trBody(mockFetch, KBSEC_TR.WORLD_INDICES).dataBody).toMatchObject({ lnd_clsf: 'S' });
    });
});
