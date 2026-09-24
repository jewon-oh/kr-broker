/**
 * @fileoverview `kbsec.fetchStocks`·`fetchStockWarnings` — 종목기본정보(`SIQM4900`). 한 TR로 이름·유형과 매매제한·위험등급을 함께 준다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { NotSupported } from '../../base/errors';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

const SECURITY_INFO = {
    stnd_is_cd: '005930', shrt_is_cd: '005930', hngl_is_nm: '삼성전자', hngl_shrt_nm: '삼성전자', eng_is_nm: 'SAMSUNG ELECTRONICS',
    is_typ_nm: '주권', is_dtl_typ_nm: '보통주', trd_rstn_clsf_nm: '', trd_rstn_strt_dt: '', trd_rstn_end_dt: '',
    io_rstn_clsf_nm: '', rsk_grd_clsf_cd: '1', rsk_grd_nm: '초저위험',
};

describe('fetchStocks', () => {
    it('종목마다 SIQM4900 을 하나씩 부르고, 이름·유형을 정리해 돌려준다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.SECURITY_INFO]: SECURITY_INFO });

        const [info] = await newExchange().fetchStocks(['005930/KRW']);

        expect(trBody(mockFetch, KBSEC_TR.SECURITY_INFO).dataBody).toEqual({ stnd_is_cd: '005930' });
        expect(info).toMatchObject({
            symbol: '005930/KRW', standardCode: '005930', name: '삼성전자', englishName: 'SAMSUNG ELECTRONICS', typeName: '주권', detailTypeName: '보통주',
        });
    });

    it('해외 종목은 NotSupported', async () => {
        await expect(newExchange().fetchStocks(['AAPL/USD'])).rejects.toThrow(NotSupported);
    });
});

describe('fetchStockWarnings', () => {
    it('매매제한·위험등급을 정리해 돌려준다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.SECURITY_INFO]: SECURITY_INFO });

        const warning = await newExchange().fetchStockWarnings('005930/KRW');

        expect(warning).toMatchObject({ tradingRestriction: undefined, riskGradeCode: '1', riskGradeName: '초저위험' });
    });

    it('매매제한이 있으면 구분명과 기간을 채운다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.SECURITY_INFO]: { ...SECURITY_INFO, trd_rstn_clsf_nm: '거래정지', trd_rstn_strt_dt: '20260901', trd_rstn_end_dt: '20261231' },
        });

        const warning = await newExchange().fetchStockWarnings('005930/KRW');

        expect(warning).toMatchObject({ tradingRestriction: '거래정지', tradingRestrictionStart: '20260901', tradingRestrictionEnd: '20261231' });
    });

    it('해외 종목은 NotSupported', async () => {
        await expect(newExchange().fetchStockWarnings('AAPL/USD')).rejects.toThrow(NotSupported);
    });
});
