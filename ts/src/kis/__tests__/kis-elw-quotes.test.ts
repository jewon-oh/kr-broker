/**
 * KIS ELW 시세 확장 메서드: 현재가, 비교대상종목, 만기, 신규상장, 기초자산 목록과 종목시세, 투자지표, 민감도, 변동성 추이.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, NotSupported } from '../../base/errors';
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
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index][0])).searchParams);

/** KST 2026-09-23 01:30 에 고정한다. */
const fixKstSep23 = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
};

describe('ELW 현재가와 종목 목록', () => {
    it('fetchElwPrice 는 ELW 코드를 시장구분 W 로 보내고 기초자산과 이론가를 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                elw_shrn_iscd: '58J297', hts_kor_isnm: 'KBJ297삼성전자콜', elw_prpr: '155', prdy_vrss: '15', prdy_ctrt: '10.71', acml_vol: '1250000', acml_tr_pbmn: '190000000',
                elw_oprc: '140', elw_hgpr: '160', elw_lwpr: '138', elw_sdpr: '140', bidp: '150', askp: '155', unas_shrn_iscd: '005930', unas_isnm: '삼성전자',
                unas_prpr: '70000', unas_prdy_vrss: '500', unas_prdy_ctrt: '0.72', acpr: '75000', hts_thpr: '152', dprt: '1.97', hts_ints_vltl: '28.5', atm_cls_name: 'OTM', apprch_rate: '93.3', pvt_pont_val: '151',
            },
        }));

        const elw = await newKis().fetchElwPrice('58j297/KRW');

        const call = find('/domestic-stock/v1/quotations/inquire-elw-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKEW15010000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'W', FID_INPUT_ISCD: '58J297' });
        expect(elw).toMatchObject({
            code: '58J297', name: 'KBJ297삼성전자콜', price: 155, change: 15, open: 140, basePrice: 140, volume: 1250000, bid: 150, ask: 155,
            underlyingCode: '005930', underlyingName: '삼성전자', underlyingPrice: 70000, strikePrice: 75000, theoreticalPrice: 152, premiumRate: 1.97,
            impliedVolatility: 28.5, moneynessName: 'OTM', approachRate: 93.3,
        });
        expect(elw.info.pvt_pont_val).toBe('151');
    });

    it('fetchElwComparables 는 기초자산 코드와 예제의 화면분류코드를 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [{ elw_shrn_iscd: '58J297', elw_kor_isnm: 'KBJ297삼성전자콜' }] }));

        const [item] = await newKis().fetchElwComparables('005930/KRW');

        const call = find('/elw/v1/quotations/compare-stocks');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKEW151701C0');
        expect(queryOf(call)).toEqual({ FID_COND_SCR_DIV_CODE: '11517', FID_INPUT_ISCD: '005930' });
        expect(item).toMatchObject({ code: '58J297', name: 'KBJ297삼성전자콜', price: undefined });
    });

    it('fetchElwExpirations 는 기간과 설명의 전체 값을 보낸다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ elw_shrn_iscd: '57K281', elw_kor_isnm: '미래K281삼성전자콜', unas_isnm: '삼성전자', unas_shrn_iscd: '005930', unas_prpr: '70000', acpr: '65000', stck_cnvr_rate: '0.01', elw_prpr: '55', stck_lstn_date: '20260301', stck_last_tr_date: '20260924', lstn_stcn: '10000000', stlm_date: '20260929' }],
        }));

        const [item] = await newKis().fetchElwExpirations(Date.parse('2026-09-23T00:00:00+09:00'));

        const call = find('/elw/v1/quotations/expiration-stocks');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKEW154700C0');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'W', FID_COND_SCR_DIV_CODE: '11547', FID_INPUT_DATE_1: '20260923', FID_INPUT_DATE_2: '20260923', FID_DIV_CLS_CODE: '2',
            FID_ETC_CLS_CODE: '', FID_UNAS_INPUT_ISCD: '000000', FID_INPUT_ISCD_2: '00000', FID_BLNG_CLS_CODE: '0', FID_INPUT_OPTION_1: '',
        });
        expect(item).toMatchObject({
            code: '57K281', underlyingCode: '005930', underlyingPrice: 70000, strikePrice: 65000, conversionRatio: 0.01, price: 55, listingDate: '20260301', lastTradeDate: '20260924', listedShares: 10000000,
        });
        expect(item.info.stlm_date).toBe('20260929');
    });

    it('fetchElwListings 는 발행사와 오늘(한국 날짜)을 보내고, 발행사가 없거나 모양이 틀리면 거절한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ elw_shrn_iscd: '52K577', unas_isnm: '코스닥150', lstn_stcn: '20000000', acpr: '1400', stck_last_tr_date: '20270325', elw_ko_barrier: '0' }],
        }));

        const [item] = await newKis().fetchElwListings('00003');

        const call = find('/elw/v1/quotations/newly-listed');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKEW154800C0');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'W', FID_COND_SCR_DIV_CODE: '11548', FID_DIV_CLS_CODE: '02', FID_UNAS_INPUT_ISCD: '000000', FID_INPUT_ISCD_2: '00003', FID_INPUT_DATE_1: '20260923', FID_BLNG_CLS_CODE: '0',
        });
        expect(item).toMatchObject({ code: '52K577', underlyingName: '코스닥150', listedShares: 20000000, strikePrice: 1400, lastTradeDate: '20270325', knockOutBarrier: 0 });

        mockFetch.mockReset();
        await expect(newKis().fetchElwListings(undefined as unknown as string)).rejects.toThrow(ArgumentsRequired);
        await expect(newKis().fetchElwListings('3')).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetchElwUnderlyings 는 전체 발행사와 예제의 정렬을 보내고 기초자산 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ unas_shrn_iscd: '005930', unas_isnm: '삼성전자', unas_prpr: '70000', unas_prdy_vrss: '500', unas_prdy_vrss_sign: '2', unas_prdy_ctrt: '0.72' }],
        }));

        const [underlying] = await newKis().fetchElwUnderlyings();

        const call = find('/elw/v1/quotations/udrl-asset-list');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKEW154100C0');
        expect(queryOf(call)).toEqual({ FID_COND_SCR_DIV_CODE: '11541', FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_ISCD: '00000' });
        expect(underlying).toMatchObject({ code: '005930', name: '삼성전자', price: 70000, change: 500, percentage: 0.72 });
    });

    it('fetchElwsByUnderlying 은 기초자산과 전체 값을 보내고 거름 범위는 비운다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                elw_shrn_iscd: '58J297', hts_kor_isnm: 'KBJ297삼성전자콜', elw_prpr: '155', prdy_vrss: '15', prdy_ctrt: '10.71', acml_vol: '1250000', acpr: '75000',
                prls_qryr_stpr_prc: '90500', hts_rmnn_dynu: '62', hts_ints_vltl: '28.5', stck_cnvr_rate: '0.01', lp_hvol: '900000', lp_rlim: '90', lvrg_val: '4.5',
                gear: '45.2', delta_val: '0.35', gama: '0.00002', vega: '120', theta: '-3.1', prls_qryr_rate: '29.3', cfp: '31.2', prit: '93.3', invl_val: '0', tmvl_val: '155', hts_thpr: '152',
            }],
        }));

        const [item] = await newKis().fetchElwsByUnderlying('2001');

        const call = find('/elw/v1/quotations/udrl-asset-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKEW154101C0');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'W', FID_COND_SCR_DIV_CODE: '11541', FID_MRKT_CLS_CODE: 'A', FID_INPUT_ISCD: '00000', FID_UNAS_INPUT_ISCD: '2001', FID_VOL_CNT: '',
            FID_TRGT_EXLS_CLS_CODE: '0', FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '', FID_INPUT_VOL_1: '', FID_INPUT_VOL_2: '', FID_INPUT_RMNN_DYNU_1: '', FID_INPUT_RMNN_DYNU_2: '',
            FID_OPTION: '0', FID_INPUT_OPTION_1: '', FID_INPUT_OPTION_2: '',
        });
        expect(item).toMatchObject({
            code: '58J297', price: 155, strikePrice: 75000, remainingDays: 62, breakEvenPrice: 90500, breakEvenRate: 29.3, capitalFulcrumPoint: 31.2, parity: 93.3,
            leverage: 4.5, gearing: 45.2, delta: 0.35, gamma: 0.00002, vega: 120, theta: -3.1, lpHolding: 900000, lpWeight: 90, theoreticalPrice: 152, timeValue: 155,
        });
    });

    it('코드나 기초자산 모양이 틀리면 보내기 전에 BadRequest 다', async () => {
        await expect(newKis().fetchElwPrice('58J29')).rejects.toThrow(BadRequest);
        await expect(newKis().fetchElwComparables('AAPL/USD')).rejects.toThrow(BadRequest);
        await expect(newKis().fetchElwsByUnderlying('00593')).rejects.toThrow(BadRequest);
        await expect(newKis().fetchElwExpirations(undefined)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('ELW 추이', () => {
    it('fetchElwIndicatorTrend 는 체결, 일별, 분별 TR 을 간격으로 고른다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: [{ stck_cntg_hour: '101530', elw_prpr: '155', prdy_vrss: '15', prdy_ctrt: '10.71', acml_vol: '1250000', lvrg_val: '4.5', gear: '45.2', tmvl_val: '155', invl_val: '0', prit: '93.3', apprch_rate: '93.3' }] }))
            .mockResolvedValueOnce(dataOk({ output: [{ stck_bsop_date: '20260922', elw_prpr: '140', elw_oprc: '130', elw_hgpr: '145', elw_lwpr: '128' }] }))
            .mockResolvedValueOnce(dataOk({ output: [{ stck_bsop_date: '20260923', stck_cntg_hour: '101500', elw_prpr: '155', cntg_vol: '3000', prmm_val: '28.1' }] }));

        const kis = newKis();
        const [tick] = await kis.fetchElwIndicatorTrend('58J297');
        const [day] = await kis.fetchElwIndicatorTrend('58J297', '1d');
        const [minute] = await kis.fetchElwIndicatorTrend('58J297', '5m');

        const tickCall = find('/elw/v1/quotations/indicator-trend-ccnl');
        expect(headersOf(mockFetch, tickCall).tr_id).toBe('FHPEW02740100');
        expect(queryOf(tickCall)).toEqual({ FID_COND_MRKT_DIV_CODE: 'W', FID_INPUT_ISCD: '58J297' });
        expect(headersOf(mockFetch, find('/elw/v1/quotations/indicator-trend-daily')).tr_id).toBe('FHPEW02740200');
        const minuteCall = find('/elw/v1/quotations/indicator-trend-minute');
        expect(headersOf(mockFetch, minuteCall).tr_id).toBe('FHPEW02740300');
        expect(queryOf(minuteCall)).toEqual({ FID_COND_MRKT_DIV_CODE: 'W', FID_INPUT_ISCD: '58J297', FID_HOUR_CLS_CODE: '300', FID_PW_DATA_INCU_YN: 'N' });
        expect(tick).toMatchObject({ date: undefined, time: '101530', price: 155, leverage: 4.5, gearing: 45.2, timeValue: 155, intrinsicValue: 0, parity: 93.3, approachRate: 93.3 });
        expect(day).toMatchObject({ date: '20260922', open: 130, high: 145, low: 128 });
        expect(minute).toMatchObject({ date: '20260923', time: '101500', tradeVolume: 3000, premium: 28.1 });
    });

    it('fetchElwSensitivityTrend 는 그릭스를 정리하고, 분별 간격은 NotSupported 다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stck_bsop_date: '20260922', elw_prpr: '140', prdy_vrss: '-5', prdy_ctrt: '-3.45', hts_thpr: '141', delta_val: '0.33', gama: '0.00002', theta: '-3.0', vega: '118', rho: '12' }],
        }));

        const [day] = await newKis().fetchElwSensitivityTrend('58J438', '1d');

        const call = find('/elw/v1/quotations/sensitivity-trend-daily');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPEW02830200');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'W', FID_INPUT_ISCD: '58J438' });
        expect(day).toMatchObject({ date: '20260922', price: 140, change: -5, theoreticalPrice: 141, delta: 0.33, gamma: 0.00002, theta: -3, vega: 118, rho: 12 });

        mockFetch.mockReset();
        await expect(newKis().fetchElwSensitivityTrend('58J438', '1m')).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetchElwVolatilityTrend 는 분별 가격을 stck_prpr 에서 읽고 일별 역사적 변동성을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: [{ stck_bsop_date: '20260923', stck_cntg_hour: '101500', stck_prpr: '155', elw_oprc: '150', hts_ints_vltl: '28.5', hist_vltl: '24.1' }] }))
            .mockResolvedValueOnce(dataOk({ output: [{ stck_bsop_date: '20260922', elw_prpr: '140', d10_hist_vltl: '22', d20_hist_vltl: '23', d30_hist_vltl: '24', d60_hist_vltl: '25', d90_hist_vltl: '26', hts_ints_vltl: '27' }] }))
            .mockResolvedValueOnce(dataOk({ output: [{ stck_cntg_hour: '101530', elw_prpr: '155', bidp: '150', askp: '155', hts_ints_vltl: '28.5' }] }));

        const kis = newKis();
        const [minute] = await kis.fetchElwVolatilityTrend('58J297', '1m');
        const [day] = await kis.fetchElwVolatilityTrend('58J297', '1d');
        const [tick] = await kis.fetchElwVolatilityTrend('58J297', 'tick');

        const minuteCall = find('/elw/v1/quotations/volatility-trend-minute');
        expect(headersOf(mockFetch, minuteCall).tr_id).toBe('FHPEW02840300');
        expect(queryOf(minuteCall)).toMatchObject({ FID_HOUR_CLS_CODE: '60', FID_PW_DATA_INCU_YN: 'N' });
        expect(headersOf(mockFetch, find('/elw/v1/quotations/volatility-trend-daily')).tr_id).toBe('FHPEW02840200');
        expect(headersOf(mockFetch, find('/elw/v1/quotations/volatility-trend-ccnl')).tr_id).toBe('FHPEW02840100');
        expect(minute).toMatchObject({ price: 155, open: 150, impliedVolatility: 28.5, historicalVolatility: 24.1 });
        expect(day).toMatchObject({ price: 140, historicalVolatility10d: 22, historicalVolatility20d: 23, historicalVolatility30d: 24, historicalVolatility60d: 25, historicalVolatility90d: 26, impliedVolatility: 27 });
        expect(tick).toMatchObject({ time: '101530', price: 155, bid: 150, ask: 155 });
    });

    it('문서에 없는 간격이면 보내기 전에 NotSupported 다', async () => {
        await expect(newKis().fetchElwIndicatorTrend('58J297', '2h')).rejects.toThrow(NotSupported);
        await expect(newKis().fetchElwVolatilityTrend('58J297', '1w')).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
