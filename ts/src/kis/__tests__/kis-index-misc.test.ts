/**
 * KIS 국내주식 업종/기타 확장 메서드: 업종 지수 현재가, 일자별, 시간별(분, 초), 구분별 전체시세, 예상체결지수 추이와 전체지수, 금리 종합,
 * 국내선물 영업일.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, NotSupported } from '../../base/errors';
import { dataOk, headersOf, newKis, tokenOk } from './support/kis-test-utils';

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

describe('업종 지수', () => {
    it('fetchIndexQuote 는 업종코드로 현재가와 등락 종목 수를 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                bstp_nmix_prpr: '2600.5', bstp_nmix_prdy_vrss: '10.5', bstp_nmix_prdy_ctrt: '0.41', bstp_nmix_oprc: '2590', bstp_nmix_hgpr: '2605',
                bstp_nmix_lwpr: '2588', acml_vol: '400000', acml_tr_pbmn: '9000000', ascn_issu_cnt: '500', uplm_issu_cnt: '3', stnr_issu_cnt: '80',
                down_issu_cnt: '350', lslm_issu_cnt: '1',
            },
        }));

        const quote = await newKis().fetchIndexQuote('0001');

        const call = find('/quotations/inquire-index-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPUP02100000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001' });
        expect(quote).toMatchObject({
            index: '0001', price: 2600.5, change: 10.5, percentage: 0.41, open: 2590, high: 2605, low: 2588, volume: 400000, amount: 9000000,
            advancers: 500, upperLimitCount: 3, unchanged: 80, decliners: 350, lowerLimitCount: 1,
        });
    });

    it('fetchIndexDailyPrices 는 기간 구분과 오늘 날짜를 보내고 output2 를 정리한다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { bstp_nmix_prpr: '2600' },
            output2: [{
                stck_bsop_date: '20260922', bstp_nmix_prpr: '2600', bstp_nmix_prdy_vrss: '10', bstp_nmix_prdy_ctrt: '0.39', bstp_nmix_oprc: '2590',
                bstp_nmix_hgpr: '2605', bstp_nmix_lwpr: '2588', acml_vol: '400000', acml_tr_pbmn: '9000000', acml_vol_rlim: '1.2', invt_new_psdg: '60', d20_dsrt: '101.5',
            }],
        }));

        const [day] = await newKis().fetchIndexDailyPrices('1001', '1w');

        const call = find('/quotations/inquire-index-daily-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPUP02120000');
        expect(queryOf(call)).toEqual({ FID_PERIOD_DIV_CODE: 'W', FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '1001', FID_INPUT_DATE_1: '20260923' });
        expect(day).toMatchObject({ date: '20260922', price: 2600, volumeShare: 1.2, investorSentiment: 60, disparity20: 101.5 });
    });

    it('fetchIndexTimePrices 는 봉 간격을 초로 보내고, fetchIndexTicks 는 체결 시각으로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: [{ bsop_hour: '100500', bstp_nmix_prpr: '2601', bstp_nmix_prdy_vrss: '11', bstp_nmix_prdy_ctrt: '0.42', acml_vol: '1000', acml_tr_pbmn: '2000', cntg_vol: '10' }] }))
            .mockResolvedValueOnce(dataOk({ output: [{ stck_cntg_hour: '100501', bstp_nmix_prpr: '2602', cntg_vol: '3' }] }));
        const broker = newKis();

        const [minute] = await broker.fetchIndexTimePrices('0001', '5m');
        const [tick] = await broker.fetchIndexTicks('0001');

        const first = find('/quotations/inquire-index-timeprice');
        expect(headersOf(mockFetch, first).tr_id).toBe('FHPUP02110200');
        expect(queryOf(first)).toEqual({ FID_INPUT_HOUR_1: '300', FID_INPUT_ISCD: '0001', FID_COND_MRKT_DIV_CODE: 'U' });
        const second = find('/quotations/inquire-index-tickprice');
        expect(headersOf(mockFetch, second).tr_id).toBe('FHPUP02110100');
        expect(queryOf(second)).toEqual({ FID_INPUT_ISCD: '0001', FID_COND_MRKT_DIV_CODE: 'U' });
        expect(minute).toMatchObject({ time: '100500', price: 2601, change: 11, percentage: 0.42, cumulativeVolume: 1000, cumulativeAmount: 2000, volume: 10 });
        expect(tick).toMatchObject({ time: '100501', price: 2602, volume: 3 });
    });

    it('fetchIndexCategoryPrices 는 시장을 업종코드와 시장구분 짝으로 보내고 업종별 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { bstp_nmix_prpr: '350' },
            output2: [{ bstp_cls_code: '2002', hts_kor_isnm: '코스피200 대형', bstp_nmix_prpr: '350.5', bstp_nmix_prdy_ctrt: '0.5', acml_vol: '100', acml_tr_pbmn: '200', acml_vol_rlim: '30', acml_tr_pbmn_rlim: '40' }],
        }));

        const [sector] = await newKis().fetchIndexCategoryPrices('KOSPI200');

        const call = find('/quotations/inquire-index-category-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPUP02140000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '2001', FID_COND_SCR_DIV_CODE: '20214', FID_MRKT_CLS_CODE: 'K2', FID_BLNG_CLS_CODE: '0' });
        expect(sector).toMatchObject({ sectorCode: '2002', name: '코스피200 대형', price: 350.5, percentage: 0.5, volume: 100, amount: 200, volumeShare: 30, amountShare: 40, basePrice: undefined });
    });

    it('업종코드 형식이나 봉 간격, 시장이 틀리면 보내기 전에 던진다', async () => {
        const broker = newKis();
        await expect(broker.fetchIndexQuote('KOSPI')).rejects.toThrow(BadRequest);
        await expect(broker.fetchIndexDailyPrices('0001', '1h')).rejects.toThrow(NotSupported);
        await expect(broker.fetchIndexTimePrices('0001', '30s')).rejects.toThrow(NotSupported);
        await expect(broker.fetchIndexCategoryPrices('KONEX' as never)).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('예상체결지수', () => {
    it('fetchExpectedIndexTrend 는 구분을 코드로 옮기고 빈 봉 간격을 보내며, 전일대비율은 prdy_ctrt 로 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stck_cntg_hour: '085500', bstp_nmix_prpr: '2595', prdy_vrss_sign: '2', bstp_nmix_prdy_vrss: '5', prdy_ctrt: '0.19', acml_vol: '3000', acml_tr_pbmn: '6000' }],
        }));

        const [point] = await newKis().fetchExpectedIndexTrend('0001', 'preopen');

        const call = find('/quotations/exp-index-trend');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST01840000');
        expect(queryOf(call)).toEqual({ FID_MKOP_CLS_CODE: '1', FID_INPUT_HOUR_1: '', FID_INPUT_ISCD: '0001', FID_COND_MRKT_DIV_CODE: 'U' });
        expect(point).toMatchObject({ time: '085500', price: 2595, change: 5, percentage: 0.19, cumulativeVolume: 3000, cumulativeAmount: 6000, volume: undefined });
    });

    it('fetchExpectedIndices 는 시장과 업종 전체를 소문자 키로 보내고 장 마감은 2 다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { bstp_nmix_prpr: '2600' },
            output2: [{ bstp_cls_code: '0001', hts_kor_isnm: '종합', bstp_nmix_prpr: '2601', bstp_nmix_prdy_ctrt: '0.2', acml_vol: '100', nmix_sdpr: '2596' }],
        }));

        const [sector] = await newKis().fetchExpectedIndices('closing');

        const call = find('/quotations/exp-total-index');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKUP11750000');
        expect(queryOf(call)).toEqual({ fid_mrkt_cls_code: '0', fid_cond_mrkt_div_code: 'U', fid_cond_scr_div_code: '11175', fid_input_iscd: '0000', fid_mkop_cls_code: '2' });
        expect(sector).toMatchObject({ sectorCode: '0001', name: '종합', price: 2601, percentage: 0.2, basePrice: 2596 });
    });

    it('구분이 없으면 보내기 전에 ArgumentsRequired 다', async () => {
        const broker = newKis();
        await expect(broker.fetchExpectedIndices(undefined as never)).rejects.toThrow(ArgumentsRequired);
        await expect(broker.fetchExpectedIndexTrend('0001', 'open' as never)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('기타', () => {
    it('fetchInterestRates 는 예제값을 보내고 두 목록을 합치며 원래 키를 남긴다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ bcdt_code: 'Y0101', hts_kor_isnm: '국고채 3년', bond_mnrt_prpr: '2.85', bond_mnrt_prdy_vrss: '-0.02', prdy_ctrt: '-0.7', stck_bsop_date: '20260922' }],
            output2: [{ bcdt_code: 'Y0201', hts_kor_isnm: 'CD 91일', bond_mnrt_prpr: '3.1', bond_mnrt_prdy_vrss: '0', bstp_nmix_prdy_ctrt: '0.0' }],
        }));

        const rates = await newKis().fetchInterestRates();

        const call = find('/quotations/comp-interest');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST07020000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'I', FID_COND_SCR_DIV_CODE: '20702', FID_DIV_CLS_CODE: '1', FID_DIV_CLS_CODE1: '' });
        expect(rates).toHaveLength(2);
        expect(rates[0]).toMatchObject({ code: 'Y0101', name: '국고채 3년', rate: 2.85, change: -0.02, percentage: -0.7, date: '20260922', outputKey: 'output1' });
        expect(rates[1]).toMatchObject({ code: 'Y0201', rate: 3.1, percentage: 0, outputKey: 'output2' });
    });

    it('fetchMarketTime 은 입력 없이 부르고 영업일 빈 칸을 뺀다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { date1: '20260923', date2: '20260924', date3: '', date4: '', date5: '', today: '20260923', time: '101500', s_time: '084500', e_time: '154500' },
        }));

        const time = await newKis().fetchMarketTime();

        const call = find('/quotations/market-time');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHMCM000002C0');
        expect(queryOf(call)).toEqual({});
        expect(time).toMatchObject({ businessDays: ['20260923', '20260924'], today: '20260923', time: '101500', openTime: '084500', closeTime: '154500' });
    });
});
