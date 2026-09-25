/**
 * KIS ETF/ETN 시세 확장 메서드: 현재가, 구성종목시세, NAV 비교추이(종목, 일, 분).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadSymbol, NotSupported } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = () => newKisBase({ masterData: KIS_MASTER_FIXTURE });

beforeEach(() => {
    mockFetch.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

/** 경로가 들어간 첫 호출의 순번. */
const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index]![0])).searchParams);

/** KST 2026-09-23 01:30 에 고정한다. */
const fixKstSep23 = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
};

describe('ETF/ETN 현재가와 구성종목', () => {
    it('fetchEtfPrice 는 예제의 KRX 시장구분을 보내고 NAV, 괴리율, 순자산을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                stck_prpr: '35120', prdy_vrss: '-80', prdy_ctrt: '-0.23', stck_oprc: '35200', stck_hgpr: '35300', stck_lwpr: '35050', stck_prdy_clpr: '35200',
                acml_vol: '3120000', prdy_vol: '2800000', stck_mxpr: '45760', stck_llam: '24640', nav: '35131.52', nav_prdy_vrss: '-75.1', nav_prdy_ctrt: '-0.21',
                prdy_last_nav: '35206.62', dprt: '-0.03', trc_errt: '0.12', etf_ntas_ttam: '71234', etf_crcl_stcn: '203000000', lstn_stcn: '203000000',
                etf_cu_unit_scrt_cnt: '50000', etf_cnfg_issu_cnt: '201', etf_div_name: '시장대표', etf_dvdn_cycl: '분기', crcd: 'KRW', mtrt_date: '', lp_hldn_rate: '1.2',
            },
        }));

        const etf = await newKis().fetchEtfPrice('069500/KRW');

        const call = find('/etfetn/v1/quotations/inquire-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST02400000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '069500' });
        expect(etf).toMatchObject({
            symbol: '069500/KRW', price: 35120, change: -80, percentage: -0.23, open: 35200, previousClose: 35200, volume: 3120000, upperLimit: 45760,
            nav: 35131.52, navChange: -75.1, previousNav: 35206.62, premiumRate: -0.03, trackingErrorRate: 0.12, netAssets: 71234,
            circulatingShares: 203000000, creationUnitShares: 50000, constituentCount: 201, categoryName: '시장대표', dividendCycle: '분기', currency: 'KRW', maturityDate: undefined,
        });
        expect(etf.info.lp_hldn_rate).toBe('1.2');
    });

    it('fetchEtfConstituents 는 예제의 화면분류코드를 보내고 ETF 요약과 구성종목 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: {
                stck_prpr: '35120', prdy_vrss: '-80', prdy_ctrt: '-0.23', etf_cnfg_issu_avls: '1756000000', nav: '35131.52', nav_prdy_vrss_sign: '5', nav_prdy_vrss: '-75.1',
                nav_prdy_ctrt: '-0.21', etf_ntas_ttam: '71234', prdy_clpr_nav: '35206.62', oprc_nav: '35180', hprc_nav: '35290', lprc_nav: '35060', etf_cu_unit_scrt_cnt: '50000', etf_cnfg_issu_cnt: '201',
            },
            output2: [
                { stck_shrn_iscd: '005930', hts_kor_isnm: '삼성전자', stck_prpr: '70000', prdy_vrss: '500', prdy_vrss_sign: '2', prdy_ctrt: '0.72', acml_vol: '12000000', acml_tr_pbmn: '840000000000', tday_rsfl_rate: '1.1', prdy_vrss_vol: '100', tr_pbmn_tnrt: '0.2', hts_avls: '4180000', etf_cnfg_issu_avls: '0', etf_cnfg_issu_rlim: '28.5', etf_cu_unit_scrt_cnt: '8150', etf_vltn_amt: '570500000' },
            ],
        }));

        const result = await newKis().fetchEtfConstituents('069500/KRW');

        const call = find('/etfetn/v1/quotations/inquire-component-stock-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST121600C0');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '069500', FID_COND_SCR_DIV_CODE: '11216' });
        expect(result.etf).toMatchObject({
            price: 35120, nav: 35131.52, navChange: -75.1, previousNav: 35206.62, navOpen: 35180, navHigh: 35290, navLow: 35060,
            netAssets: 71234, constituentsMarketCap: 1756000000, creationUnitShares: 50000, constituentCount: 201,
        });
        expect(result.constituents).toEqual([expect.objectContaining({
            symbol: '005930/KRW', name: '삼성전자', price: 70000, percentage: 0.72, tradingValue: 840000000000, marketCap: 4180000, creationUnitShares: 8150, weight: 28.5, valuationAmount: 570500000,
        })]);
    });

    it('해외 종목이면 보내기 전에 BadSymbol 이다', async () => {
        await expect(newKis().fetchEtfPrice('AAPL/USD')).rejects.toThrow(BadSymbol);
        await expect(newKis().fetchEtfConstituents('AAPL/USD')).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('NAV 비교추이', () => {
    it('fetchEtfNavComparison 은 가격 쪽과 NAV 쪽을 나눠 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { stck_prpr: '35120', prdy_vrss: '-80', prdy_vrss_sign: '5', prdy_ctrt: '-0.23', acml_vol: '3120000', acml_tr_pbmn: '109000000000', stck_prdy_clpr: '35200', stck_oprc: '35200', stck_hgpr: '35300', stck_lwpr: '35050', stck_mxpr: '45760', stck_llam: '24640' },
            output2: { nav: '35131.52', nav_prdy_vrss_sign: '5', nav_prdy_vrss: '-75.1', nav_prdy_ctrt: '-0.21', prdy_clpr_nav: '35206.62', oprc_nav: '35180', hprc_nav: '35290', lprc_nav: '35060' },
        }));

        const result = await newKis().fetchEtfNavComparison('069500/KRW');

        const call = find('/etfetn/v1/quotations/nav-comparison-trend');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST02440000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '069500' });
        expect(result.market).toMatchObject({ price: 35120, change: -80, open: 35200, high: 35300, low: 35050, previousClose: 35200, volume: 3120000, tradingValue: 109000000000, lowerLimit: 24640 });
        expect(result.nav).toMatchObject({ nav: 35131.52, navChange: -75.1, navChangeRate: -0.21, previousNav: 35206.62, open: 35180, high: 35290, low: 35060 });
    });

    it('fetchEtfNavDailyTrend 는 기간을 보내고 종가와 괴리율 행을 정리한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stck_bsop_date: '20260922', stck_clpr: '35200', prdy_vrss: '100', prdy_vrss_sign: '2', prdy_ctrt: '0.28', acml_vol: '2800000', cntg_vol: '0', dprt: '-0.02', nav_vrss_prpr: '-6.62', nav: '35206.62', nav_prdy_vrss_sign: '2', nav_prdy_vrss: '98.1', nav_prdy_ctrt: '0.28' }],
        }));

        const [day] = await newKis().fetchEtfNavDailyTrend('069500/KRW', Date.parse('2026-09-01T00:00:00+09:00'));

        const call = find('/etfetn/v1/quotations/nav-comparison-daily-trend');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST02440200');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '069500', FID_INPUT_DATE_1: '20260901', FID_INPUT_DATE_2: '20260923' });
        expect(day).toMatchObject({
            date: '20260922', time: undefined, price: 35200, change: 100, volume: 2800000, tradeVolume: 0, nav: 35206.62, navChange: 98.1, navPriceGap: -6.62, premiumRate: -0.02,
        });
    });

    it('fetchEtfNavMinuteTrend 는 간격을 초로 바꾸고 예제의 시장구분 E 를 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ bsop_hour: '101500', nav: '35131.52', nav_prdy_vrss_sign: '5', nav_prdy_vrss: '-75.1', nav_prdy_ctrt: '-0.21', nav_vrss_prpr: '-11.52', dprt: '-0.03', stck_prpr: '35120', prdy_vrss: '-80', prdy_vrss_sign: '5', prdy_ctrt: '-0.23', acml_vol: '1500000', cntg_vol: '1200' }],
        }));

        const [minute] = await newKis().fetchEtfNavMinuteTrend('069500/KRW', '3m');

        const call = find('/etfetn/v1/quotations/nav-comparison-time-trend');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST02440100');
        expect(queryOf(call)).toEqual({ FID_HOUR_CLS_CODE: '180', FID_INPUT_ISCD: '069500', FID_COND_MRKT_DIV_CODE: 'E' });
        expect(minute).toMatchObject({ date: undefined, time: '101500', price: 35120, tradeVolume: 1200, nav: 35131.52, navPriceGap: -11.52, premiumRate: -0.03 });
    });

    it('기간 시작이 없거나 문서에 없는 간격이면 보내기 전에 거절한다', async () => {
        await expect(newKis().fetchEtfNavDailyTrend('069500/KRW', undefined)).rejects.toThrow(ArgumentsRequired);
        await expect(newKis().fetchEtfNavMinuteTrend('069500/KRW', '5m')).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
