/**
 * @fileoverview `kbsec.fetchCoupons` — 개인별 쿠폰(`SZQM6019`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

const coupon = (cd: string) => ({
    st_clsf: '1', cpn_cd: cd, amt: '10,000', rmd_dy_c: '12', cpn_isng_nm: '국내주식 수수료 우대', strt_dt: '20260901',
    end_dt: '20261004', use_dt: '', cpn_aplc_psbl_gds_nm: '국내주식', knd_ccd: '01',
});

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchCoupons', () => {
    it('설명이 없는 상태구분과 대표고객번호를 비워 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.COUPONS]: { grid_cnt: '0', Record1: [] } });

        await expect(newExchange().fetchCoupons()).resolves.toEqual([]);

        expect(trBody(mockFetch, KBSEC_TR.COUPONS).dataBody).toEqual({ rprst_cs_no: '', st_clsf: '' });
        expect(calledTrs(mockFetch).filter(tr => tr === KBSEC_TR.COUPONS.toLowerCase())).toHaveLength(1);
    });

    it('쿠폰 한 장을 옮기고 코드는 원문으로 둔다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.COUPONS]: { grid_cnt: '1', Record1: [coupon('C001')] } });

        const [first] = await newExchange().fetchCoupons();

        expect(first).toMatchObject({
            code: 'C001', name: '국내주식 수수료 우대', statusCode: '1', amount: 10000, remainingDays: 12,
            startDate: '20260901', endDate: '20261004', usedDate: '', applicableProduct: '국내주식',
        });
        expect(first!.info).toHaveProperty('knd_ccd', '01');
    });

    it('쿠폰코드와 쿠폰명이 모두 빈 행은 거르고, 하나라도 있으면 남긴다', async () => {
        const blank = { ...coupon(''), cpn_isng_nm: '', amt: '0' };
        const nameOnly = { ...coupon(''), cpn_isng_nm: '이름만 있는 쿠폰' };
        routeTr(mockFetch, { [KBSEC_TR.COUPONS]: { Record1: [coupon('C001'), blank, nameOnly, blank] } });

        const rows = await newExchange().fetchCoupons();

        expect(rows.map(r => r.name)).toEqual(['국내주식 수수료 우대', '이름만 있는 쿠폰']);
    });

    it('params 로 상태구분을 정해 보낼 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.COUPONS]: { Record1: [] } });

        await newExchange().fetchCoupons({ st_clsf: '1' });

        expect(trBody(mockFetch, KBSEC_TR.COUPONS).dataBody).toMatchObject({ st_clsf: '1' });
    });
});
