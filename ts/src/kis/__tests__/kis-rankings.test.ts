/**
 * `kis.fetchRankings` — 등락률 순위(`ranking/fluctuation`, TR `FHPST01700000`), 거래량 순위(`quotations/volume-rank`,
 * TR `FHPST01710000`), 그리고 표(`KIS_RANKING_SPECS`)로 정의한 순위들.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, NotSupported } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

const FLUCTUATION_PATH = '/ranking/fluctuation';
const VOLUME_PATH = '/quotations/volume-rank';

beforeEach(() => {
    mockFetch.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index]![0])).searchParams);

describe('fetchRankings', () => {
    it('FLUCTUATION은 등락률 순위 엔드포인트를 부르고 공통 필드로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ data_rank: '1', stck_shrn_iscd: '005930', hts_kor_isnm: '삼성전자', stck_prpr: '71000', prdy_vrss: '1500', prdy_ctrt: '2.16', acml_vol: '12345' }],
        }));

        const [item] = await newKis().fetchRankings('FLUCTUATION');

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(FLUCTUATION_PATH));
        expect(String(mockFetch.mock.calls[call]![0])).toContain('fid_rank_sort_cls_code=0');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST01700000');
        expect(item).toMatchObject({ rank: 1, symbol: '005930/KRW', name: '삼성전자', last: 71000, change: 1500, percentage: 2.16, volume: 12345 });
    });

    it('VOLUME은 거래량 순위 엔드포인트를 부르고 같은 모양으로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ data_rank: '1', mksc_shrn_iscd: '000660', hts_kor_isnm: 'SK하이닉스', stck_prpr: '180000', prdy_vrss: '3000', prdy_ctrt: '1.7', acml_vol: '987654' }],
        }));

        const [item] = await newKis().fetchRankings('VOLUME');

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(VOLUME_PATH));
        expect(String(mockFetch.mock.calls[call]![0])).toContain('FID_COND_MRKT_DIV_CODE=J');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST01710000');
        expect(item).toMatchObject({ rank: 1, symbol: '000660/KRW', name: 'SK하이닉스', last: 180000, change: 3000, percentage: 1.7, volume: 987654 });
    });

    it('구현하지 않은 종류는 NotSupported', async () => {
        await expect(newKis().fetchRankings('NOT_A_RANKING' as never)).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchRankings — 표로 정의한 순위', () => {
    const CASES = [
        { type: 'AFTER_HOUR_BALANCE', path: '/ranking/after-hour-balance', tr: 'FHPST01760000', screen: '20176', symbolKey: 'stck_shrn_iscd' },
        { type: 'BULK_TRANS', path: '/ranking/bulk-trans-num', tr: 'FHKST190900C0', screen: '11909', symbolKey: 'mksc_shrn_iscd' },
        { type: 'DISPARITY', path: '/ranking/disparity', tr: 'FHPST01780000', screen: '20178', symbolKey: 'mksc_shrn_iscd' },
        { type: 'MARKET_CAP', path: '/ranking/market-cap', tr: 'FHPST01740000', screen: '20174', symbolKey: 'mksc_shrn_iscd' },
        { type: 'NEAR_NEW_HIGH', path: '/ranking/near-new-highlow', tr: 'FHPST01870000', screen: '20187', symbolKey: 'mksc_shrn_iscd' },
        { type: 'NEAR_NEW_LOW', path: '/ranking/near-new-highlow', tr: 'FHPST01870000', screen: '20187', symbolKey: 'mksc_shrn_iscd' },
        { type: 'PREFERRED_DISPARITY', path: '/ranking/prefer-disparate-ratio', tr: 'FHPST01770000', screen: '20177', symbolKey: 'mksc_shrn_iscd' },
        { type: 'QUOTE_BALANCE', path: '/ranking/quote-balance', tr: 'FHPST01720000', screen: '20172', symbolKey: 'mksc_shrn_iscd' },
        { type: 'TOP_INTEREST', path: '/ranking/top-interest-stock', tr: 'FHPST01800000', screen: '20180', symbolKey: 'mksc_shrn_iscd' },
        { type: 'TRADED_BY_COMPANY', path: '/ranking/traded-by-company', tr: 'FHPST01860000', screen: '20186', symbolKey: 'mksc_shrn_iscd' },
        { type: 'VOLUME_POWER', path: '/ranking/volume-power', tr: 'FHPST01680000', screen: '20168', symbolKey: 'stck_shrn_iscd' },
        { type: 'FINANCE_RATIO', path: '/ranking/finance-ratio', tr: 'FHPST01750000', screen: '20175', symbolKey: 'mksc_shrn_iscd' },
        { type: 'MARKET_VALUE', path: '/ranking/market-value', tr: 'FHPST01790000', screen: '20179', symbolKey: 'mksc_shrn_iscd' },
        { type: 'PROFIT_ASSET', path: '/ranking/profit-asset-index', tr: 'FHPST01730000', screen: '20173', symbolKey: 'mksc_shrn_iscd' },
        { type: 'SHORT_SALE', path: '/ranking/short-sale', tr: 'FHPST04820000', screen: '20482', symbolKey: 'mksc_shrn_iscd', screenKey: 'FID_COND_SCR_DIV_CODE' },
    ] as const;

    it.each(CASES)('$type 는 $path 를 TR $tr, 화면코드 $screen 으로 부르고 공통 필드로 정리한다', async (c) => {
        const { type, path, tr, screen, symbolKey } = c;
        const screenKey = 'screenKey' in c ? c.screenKey : 'fid_cond_scr_div_code';
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ data_rank: '1', [symbolKey]: '005930', hts_kor_isnm: '삼성전자', stck_prpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', acml_vol: '1000', extra: 'x' }],
        }));

        const [item] = await newKis().fetchRankings(type);

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));
        expect(call).toBeGreaterThan(-1);
        expect(headersOf(mockFetch, call).tr_id).toBe(tr);
        expect(queryOf(call)[screenKey]).toBe(screen);
        expect(item).toMatchObject({ rank: 1, symbol: '005930/KRW', name: '삼성전자', last: 71000, change: 500, percentage: 0.71, volume: 1000 });
        expect(item!.info).toHaveProperty('extra', 'x');
    });

    it('신고가 근접과 신저가 근접은 가격구분(fid_prc_cls_code)으로 갈린다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [] })).mockResolvedValueOnce(dataOk({ output: [] }));
        const ex = newKis();

        await ex.fetchRankings('NEAR_NEW_HIGH');
        await ex.fetchRankings('NEAR_NEW_LOW');

        const calls = mockFetch.mock.calls.map((c, i) => [String(c[0]), i] as const).filter(([u]) => u.includes('/ranking/near-new-highlow'));
        expect(calls.map(([, i]) => queryOf(i).fid_prc_cls_code)).toEqual(['0', '1']);
    });

    it('설명 없는 가격·거래량 범위는 비우고, 예제에 없는 키는 보내지 않는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [] }));

        await newKis().fetchRankings('BULK_TRANS');

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes('/ranking/bulk-trans-num'));
        const q = queryOf(call);
        expect(q).toMatchObject({ fid_input_price_1: '', fid_aply_rang_prc_1: '', fid_aply_rang_prc_2: '', fid_vol_cnt: '', fid_input_iscd: '0000' });
        expect(q).not.toHaveProperty('fid_input_price_2');
    });

    it('당사매매종목의 기간 기본값은 오늘 하루(한국 날짜)이고, params 가 정렬과 기간을 덮어쓴다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z')); // KST 9/23
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [] })).mockResolvedValueOnce(dataOk({ output: [] }));
        const ex = newKis();

        await ex.fetchRankings('TRADED_BY_COMPANY');
        await ex.fetchRankings('TRADED_BY_COMPANY', { fid_rank_sort_cls_code: '1', fid_input_date_1: '20260901' });

        const calls = mockFetch.mock.calls.map((c, i) => [String(c[0]), i] as const).filter(([u]) => u.includes('/ranking/traded-by-company'));
        expect(queryOf(calls[0]![1])).toMatchObject({ fid_input_date_1: '20260923', fid_input_date_2: '20260923', fid_rank_sort_cls_code: '0' });
        expect(queryOf(calls[1]![1])).toMatchObject({ fid_input_date_1: '20260901', fid_input_date_2: '20260923', fid_rank_sort_cls_code: '1' });
    });

    it('예상체결 상승·하락은 예상 체결량(cntg_vol)을 거래량으로 쓴다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stck_shrn_iscd: '005930', hts_kor_isnm: '삼성전자', stck_prpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', cntg_vol: '300' }],
        }));

        const [item] = await newKis().fetchRankings('EXPECTED_CHANGE');

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes('/ranking/exp-trans-updown'));
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST01820000');
        expect(queryOf(call).fid_cond_scr_div_code).toBe('20182');
        expect(item).toMatchObject({ symbol: '005930/KRW', name: '삼성전자', last: 71000, change: 500, percentage: 0.71, volume: 300 });
    });

    it('응답에 순위 필드가 없으면 rank 를 지어내지 않는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [{ stck_shrn_iscd: '005930', stck_prpr: '71000' }] }));

        const [item] = await newKis().fetchRankings('EXPECTED_CHANGE');

        expect(item!.rank).toBeUndefined();
        expect(item!.symbol).toBe('005930/KRW');
    });
});

describe('fetchRankings — 행 키나 필드가 다른 순위', () => {
    const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

    it('신용잔고는 행을 output2 에서 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ bstp_cls_code: '0001', hts_kor_isnm: '종합', stnd_date1: '20260922' }],
            output2: [{ mksc_shrn_iscd: '005930', hts_kor_isnm: '삼성전자', stck_prpr: '71000', whol_loan_rmnd_rate: '0.5' }],
        }));

        const items = await newKis().fetchRankings('CREDIT_BALANCE');

        expect(headersOf(mockFetch, find('/ranking/credit-balance')).tr_id).toBe('FHKST17010000');
        expect(queryOf(find('/ranking/credit-balance'))).toMatchObject({ FID_COND_SCR_DIV_CODE: '11701', FID_OPTION: '2' });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ symbol: '005930/KRW', last: 71000 });
    });

    it.each([
        ['OVERTIME_CHANGE', '/ranking/overtime-fluctuation', 'mksc_shrn_iscd'],
        ['OVERTIME_VOLUME', '/ranking/overtime-volume', 'stck_shrn_iscd'],
    ] as const)('%s 는 행을 output2 에서 읽고 공통 필드를 시간외 단일가 값으로 채운다', async (type, path, symbolKey) => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { ovtm_untp_acml_vol: '999' },
            output2: [{ [symbolKey]: '005930', hts_kor_isnm: '삼성전자', ovtm_untp_prpr: '71500', ovtm_untp_prdy_vrss: '500', ovtm_untp_prdy_ctrt: '0.7',
                ovtm_untp_vol: '3000', stck_prpr: '71000', acml_vol: '100000' }],
        }));

        const [item] = await newKis().fetchRankings(type);

        expect(find(path)).toBeGreaterThan(-1);
        expect(item).toMatchObject({ symbol: '005930/KRW', last: 71500, change: 500, percentage: 0.7, volume: 3000 });
    });

    it('시간외 예상체결 등락률은 예상 체결가와 예상 체결량으로 채운다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ data_rank: '1', stck_shrn_iscd: '005930', ovtm_untp_antc_cnpr: '72000', ovtm_untp_antc_cntg_vrss: '1000',
                ovtm_untp_antc_cntg_ctrt: '1.41', ovtm_untp_antc_cnqn: '50', stck_prpr: '71000' }],
        }));

        const [item] = await newKis().fetchRankings('OVERTIME_EXPECTED_CHANGE');

        expect(item).toMatchObject({ rank: 1, last: 72000, change: 1000, percentage: 1.41, volume: 50 });
    });

    it('HTS 조회상위는 입력 없이 부르고 행을 output1 에서 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: [{ mrkt_div_cls_code: 'J', mksc_shrn_iscd: '005930' }] }));

        const [item] = await newKis().fetchRankings('HTS_TOP_VIEW');

        const call = find('/ranking/hts-top-view');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHMCM000100C0');
        expect(queryOf(call)).toEqual({});
        expect(item).toMatchObject({ symbol: '005930/KRW', rank: undefined, name: undefined });
    });

    it('배당률 순위는 배당 종류가 없으면 보내기 전에 ArgumentsRequired 다', async () => {
        await expect(newKis().fetchRankings('DIVIDEND_RATE')).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('배당률 순위는 dividendType 을 GB3 로 옮기고 최근 1년을 기준일 범위로 보낸다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z')); // KST 9/23
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ rank: '1', sht_cd: '005930', isin_name: '삼성전자', record_date: '20251231', per_sto_divi_amt: '361', divi_rate: '2.3' }],
        }));

        const [item] = await newKis().fetchRankings('DIVIDEND_RATE', { dividendType: 'cash' });

        const q = queryOf(find('/ranking/dividend-rate'));
        expect(q).toMatchObject({ GB1: '1', UPJONG: '0001', GB3: '2', F_DT: '20250923', T_DT: '20260923', GB4: '0' });
        expect(q).not.toHaveProperty('dividendType');
        expect(item).toMatchObject({ rank: 1, symbol: '005930/KRW', name: '삼성전자' });
        expect(item!.info).toHaveProperty('divi_rate', '2.3');
    });

    it('재무 순위의 회계연도 기본값은 직전 연도, 분기는 결산(3)이다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [] }));

        await newKis().fetchRankings('PROFIT_ASSET');

        expect(queryOf(find('/ranking/profit-asset-index'))).toMatchObject({ fid_input_option_1: '2025', fid_input_option_2: '3' });
    });

    it('장마감 예상체결가는 전체를 보내고, 순위 없이 체결거래량을 거래량으로 쓴다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stck_shrn_iscd: '005930', hts_kor_isnm: '삼성전자', stck_prpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', cntg_vol: '300', sdpr_vrss_prpr: '100' }],
        }));

        const [item] = await newKis().fetchRankings('CLOSING_EXPECTED');

        const call = find('/quotations/exp-closing-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST117300C0');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '0000', FID_RANK_SORT_CLS_CODE: '0', FID_COND_SCR_DIV_CODE: '11173', FID_BLNG_CLS_CODE: '0',
        });
        expect(item).toMatchObject({ rank: undefined, symbol: '005930/KRW', last: 71000, change: 500, percentage: 0.71, volume: 300 });
        expect(item!.info).toHaveProperty('sdpr_vrss_prpr', '100');
    });

    it('외국인·기관 가집계와 외국계 가집계는 예제의 시장구분, 화면 코드, 정렬을 보내고 전체를 묻는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: [{ mksc_shrn_iscd: '005930', hts_kor_isnm: '삼성전자', stck_prpr: '71000', acml_vol: '9000000', frgn_ntby_qty: '1000' }] }))
            .mockResolvedValueOnce(dataOk({ output: [{ stck_shrn_iscd: '000660', hts_kor_isnm: 'SK하이닉스', stck_prpr: '200000', acml_vol: '3000000', glob_ntsl_qty: '500' }] }));
        const ex = newKis();

        const [institution] = await ex.fetchRankings('FOREIGN_INSTITUTION_ESTIMATE');
        const [broker] = await ex.fetchRankings('FOREIGN_BROKER_ESTIMATE');

        const first = find('/quotations/foreign-institution-total');
        expect(headersOf(mockFetch, first).tr_id).toBe('FHPTJ04400000');
        expect(queryOf(first)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'V', FID_COND_SCR_DIV_CODE: '16449', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '0', FID_RANK_SORT_CLS_CODE: '0', FID_ETC_CLS_CODE: '0',
        });
        const second = find('/quotations/frgnmem-trade-estimate');
        expect(headersOf(mockFetch, second).tr_id).toBe('FHKST644100C0');
        expect(queryOf(second)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '16441', FID_INPUT_ISCD: '0000', FID_RANK_SORT_CLS_CODE: '0', FID_RANK_SORT_CLS_CODE_2: '0',
        });
        expect(institution).toMatchObject({ rank: undefined, symbol: '005930/KRW', last: 71000, volume: 9000000 });
        expect(broker).toMatchObject({ rank: undefined, symbol: '000660/KRW', last: 200000, volume: 3000000 });
        expect(broker!.info).toHaveProperty('glob_ntsl_qty', '500');
    });

    it('상하한가 포착은 상하한 구분이 없으면 보내기 전에 ArgumentsRequired 다', async () => {
        await expect(newKis().fetchRankings('PRICE_LIMIT')).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('상하한가 포착은 priceLimit 을 FID_PRC_CLS_CODE 로 옮기고 나머지는 전체나 빈 값을 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [] })).mockResolvedValueOnce(dataOk({ output: [] }));
        const ex = newKis();

        await ex.fetchRankings('PRICE_LIMIT', { priceLimit: 'upper' });
        await ex.fetchRankings('PRICE_LIMIT', { priceLimit: 'lower', FID_DIV_CLS_CODE: '6' });

        const calls = mockFetch.mock.calls.map((c, i) => [String(c[0]), i] as const).filter(([u]) => u.includes('/quotations/capture-uplowprice'));
        expect(headersOf(mockFetch, calls[0]![1]).tr_id).toBe('FHKST130000C0');
        expect(queryOf(calls[0]![1])).toEqual({
            FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '11300', FID_PRC_CLS_CODE: '0', FID_DIV_CLS_CODE: '0', FID_INPUT_ISCD: '0000',
            FID_TRGT_CLS_CODE: '', FID_TRGT_EXLS_CLS_CODE: '', FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '', FID_VOL_CNT: '',
        });
        expect(queryOf(calls[1]![1])).toMatchObject({ FID_PRC_CLS_CODE: '1', FID_DIV_CLS_CODE: '6' });
        expect(queryOf(calls[1]![1])).not.toHaveProperty('priceLimit');
    });
});

describe('fetchRankings — 해외 순위', () => {
    const CASES = [
        { type: 'OVERSEAS_MARKET_CAP', path: '/ranking/market-cap', tr: 'HHDFS76350100', extra: { CURR_GB: '0' }, name: 'name' },
        {
            type: 'OVERSEAS_NEW_HIGH', path: '/ranking/new-highlow', tr: 'HHDFS76300000', extra: { MINX: '0', GUBN: '1', GUBN2: '1', NDAY: '6' }, name: 'name',
            params: { period: '52w' },
        },
        {
            type: 'OVERSEAS_NEW_LOW', path: '/ranking/new-highlow', tr: 'HHDFS76300000', extra: { MINX: '0', GUBN: '0', GUBN2: '1', NDAY: '6' }, name: 'name',
            params: { period: '52w' },
        },
        { type: 'OVERSEAS_PRICE_SURGE', path: '/ranking/price-fluct', tr: 'HHDFS76260000', extra: { GUBN: '1', MINX: '0' }, name: 'knam' },
        { type: 'OVERSEAS_PRICE_PLUNGE', path: '/ranking/price-fluct', tr: 'HHDFS76260000', extra: { GUBN: '0', MINX: '0' }, name: 'knam' },
        { type: 'OVERSEAS_GAINERS', path: '/ranking/updown-rate', tr: 'HHDFS76290000', extra: { NDAY: '0', GUBN: '1' }, name: 'name' },
        { type: 'OVERSEAS_LOSERS', path: '/ranking/updown-rate', tr: 'HHDFS76290000', extra: { NDAY: '0', GUBN: '0' }, name: 'name' },
        { type: 'OVERSEAS_VOLUME', path: '/ranking/trade-vol', tr: 'HHDFS76310010', extra: { NDAY: '0', PRC1: '', PRC2: '' }, name: 'name' },
        { type: 'OVERSEAS_TRADE_AMOUNT', path: '/ranking/trade-pbmn', tr: 'HHDFS76320010', extra: { NDAY: '0', PRC1: '', PRC2: '' }, name: 'name' },
        { type: 'OVERSEAS_TRADE_GROWTH', path: '/ranking/trade-growth', tr: 'HHDFS76330000', extra: { NDAY: '0' }, name: 'name' },
        { type: 'OVERSEAS_TURNOVER', path: '/ranking/trade-turnover', tr: 'HHDFS76340000', extra: { NDAY: '0' }, name: 'name' },
        { type: 'OVERSEAS_VOLUME_POWER', path: '/ranking/volume-power', tr: 'HHDFS76280000', extra: { NDAY: '0' }, name: 'name' },
        { type: 'OVERSEAS_VOLUME_SURGE', path: '/ranking/volume-surge', tr: 'HHDFS76270000', extra: { MINX: '0' }, name: 'knam' },
    ] as const;

    it.each(CASES)('$type 는 $path 를 TR $tr 로 부르고 거래소와 예제의 구분값을 보낸다', async (c) => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { nrec: '1' },
            output2: [{ rank: '1', symb: 'AAPL', [c.name]: '애플', last: '227.5', diff: '2.5', rate: '1.11', tvol: '50000000', excd: 'NAS' }],
        }));

        const [item] = await newKis().fetchRankings(c.type, { exchange: 'NAS', ...('params' in c ? c.params : {}) });

        const call = mockFetch.mock.calls.findIndex((x) => String(x[0]).includes(`/overseas-stock/v1${c.path}`));
        expect(headersOf(mockFetch, call).tr_id).toBe(c.tr);
        expect(queryOf(call)).toEqual({ EXCD: 'NAS', VOL_RANG: '0', KEYB: '', AUTH: '', ...c.extra });
        expect(item).toMatchObject({ rank: 1, symbol: 'AAPL/USD', name: '애플', last: 227.5, change: 2.5, percentage: 1.11, volume: 50000000 });
    });

    it('거래소의 거래 통화를 심볼에 붙인다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output2: [{ symb: '00700', name: '텐센트' }] }));

        const [item] = await newKis().fetchRankings('OVERSEAS_MARKET_CAP', { exchange: 'HKS' });

        expect(item!.symbol).toBe('00700/HKD');
        expect(queryOf(mockFetch.mock.calls.findIndex((x) => String(x[0]).includes('/overseas-stock/v1/ranking/market-cap'))).EXCD).toBe('HKS');
    });

    it('거래소가 없으면 ArgumentsRequired, 설명 밖의 거래소면 BadRequest 이고 요청을 보내지 않는다', async () => {
        const ex = newKis();
        await expect(ex.fetchRankings('OVERSEAS_VOLUME')).rejects.toThrow(ArgumentsRequired);
        await expect(ex.fetchRankings('OVERSEAS_VOLUME', { exchange: 'NASD' })).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('신고가·신저가는 기간이 없거나 설명 밖이면 ArgumentsRequired 이고, NDAY 를 직접 주면 그대로 보낸다', async () => {
        const ex = newKis();
        await expect(ex.fetchRankings('OVERSEAS_NEW_HIGH', { exchange: 'NAS' })).rejects.toThrow(ArgumentsRequired);
        await expect(ex.fetchRankings('OVERSEAS_NEW_LOW', { exchange: 'NAS', period: '2y' })).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();

        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output2: [] }));
        await ex.fetchRankings('OVERSEAS_NEW_HIGH', { exchange: 'NAS', NDAY: '2' });

        const q = queryOf(mockFetch.mock.calls.findIndex((x) => String(x[0]).includes('/overseas-stock/v1/ranking/new-highlow')));
        expect(q).toMatchObject({ EXCD: 'NAS', NDAY: '2' });
        expect(q).not.toHaveProperty('period');
    });
});

describe('fetchRankings — ELW 순위', () => {
    /** 다섯 순위가 공유하는 입력. */
    const COMMON = {
        FID_COND_MRKT_DIV_CODE: 'W', FID_UNAS_INPUT_ISCD: '000000', FID_INPUT_ISCD: '00000',
        FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '', FID_INPUT_VOL_1: '', FID_INPUT_VOL_2: '', FID_BLNG_CLS_CODE: '0',
    };
    const CASES = [
        {
            type: 'ELW_UPDOWN_RATE', path: '/ranking/updown-rate', tr: 'FHPEW02770000', name: 'hts_kor_isnm',
            extra: { FID_COND_SCR_DIV_CODE: '20277', FID_INPUT_RMNN_DYNU_1: '0', FID_DIV_CLS_CODE: '0', FID_INPUT_DATE_1: '', FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_DATE_2: '' },
        },
        {
            type: 'ELW_VOLUME', path: '/ranking/volume-rank', tr: 'FHPEW02780000', name: 'elw_kor_isnm',
            extra: { FID_COND_SCR_DIV_CODE: '20278', FID_INPUT_RMNN_DYNU_1: '', FID_DIV_CLS_CODE: '0', FID_INPUT_DATE_1: '', FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_ISCD_2: '0000', FID_INPUT_DATE_2: '' },
        },
        {
            type: 'ELW_INDICATOR', path: '/ranking/indicator', tr: 'FHPEW02790000', name: 'elw_kor_isnm',
            extra: { FID_COND_SCR_DIV_CODE: '20279', FID_DIV_CLS_CODE: '0', FID_RANK_SORT_CLS_CODE: '0' },
        },
        {
            type: 'ELW_SENSITIVITY', path: '/ranking/sensitivity', tr: 'FHPEW02850000', name: 'elw_kor_isnm',
            extra: { FID_COND_SCR_DIV_CODE: '20285', FID_DIV_CLS_CODE: '0', FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_RMNN_DYNU_1: '', FID_INPUT_DATE_1: '' },
        },
        {
            type: 'ELW_QUICK_CHANGE', path: '/ranking/quick-change', tr: 'FHPEW02870000', name: 'elw_kor_isnm',
            extra: { FID_COND_SCR_DIV_CODE: '20287', FID_MRKT_CLS_CODE: 'A', FID_HOUR_CLS_CODE: '1', FID_INPUT_HOUR_1: '', FID_INPUT_HOUR_2: '', FID_RANK_SORT_CLS_CODE: '1' },
        },
    ] as const;

    it.each(CASES)('$type 는 $path 를 TR $tr 로 부르고 ELW 공통 입력과 예제값을 보낸다', async (c) => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ elw_shrn_iscd: '58J297', [c.name]: 'KBJ297삼성전자콜', elw_prpr: '155', prdy_vrss: '15', prdy_ctrt: '10.71', acml_vol: '1250000' }],
        }));

        const [item] = await newKis().fetchRankings(c.type);

        const call = mockFetch.mock.calls.findIndex((x) => String(x[0]).includes(`/elw/v1${c.path}`));
        expect(headersOf(mockFetch, call).tr_id).toBe(c.tr);
        expect(queryOf(call)).toEqual({ ...COMMON, ...c.extra });
        expect(item).toMatchObject({ rank: undefined, symbol: '58J297/KRW', name: 'KBJ297삼성전자콜', last: 155, change: 15, percentage: 10.71, volume: 1250000 });
    });
});
