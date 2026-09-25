/**
 * KIS 선물옵션, 해외선물옵션, 장내채권 시세 확장 메서드와 블록 원문으로 돌려주는 ELW 조회.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, NotSupported } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import type { kis } from '../../kis';

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

/** KST 2026-09-23 10:15:30 에 고정한다. */
const fixKst = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T01:15:30Z'));
};

/** 블록 원문으로 돌려주는 조회의 공통 확인: 경로, TR, 쿼리, 블록 원문. */
interface RawCase {
    name: string;
    path: string;
    tr: string;
    call: (k: kis) => Promise<unknown>;
    query: Record<string, string>;
    third?: boolean;
}

const RAW_CASES: RawCase[] = [
    {
        name: 'fetchOptionBoard', path: '/domestic-futureoption/v1/quotations/display-board-callput', tr: 'FHPIF05030100', call: (k) => k.fetchOptionBoard('202610'),
        query: { FID_COND_MRKT_DIV_CODE: 'O', FID_COND_SCR_DIV_CODE: '20503', FID_MRKT_CLS_CODE: 'CO', FID_MTRT_CNT: '202610', FID_MRKT_CLS_CODE1: 'PO', FID_COND_MRKT_CLS_CODE: '' },
    },
    {
        name: 'fetchFuturesUnderlyingBoard', path: '/domestic-futureoption/v1/quotations/display-board-top', tr: 'FHPIF05030000', call: (k) => k.fetchFuturesUnderlyingBoard('101w12'),
        query: { FID_COND_MRKT_DIV_CODE: 'F', FID_INPUT_ISCD: '101W12', FID_COND_MRKT_DIV_CODE1: '', FID_COND_SCR_DIV_CODE: '', FID_MTRT_CNT: '', FID_COND_MRKT_CLS_CODE: '' },
    },
    {
        name: 'fetchFuturesExpectedTrend', path: '/domestic-futureoption/v1/quotations/exp-price-trend', tr: 'FHPIF05110100', call: (k) => k.fetchFuturesExpectedTrend('101W12'),
        query: { FID_INPUT_ISCD: '101W12', FID_COND_MRKT_DIV_CODE: 'F' },
    },
    {
        name: 'fetchDerivativeOrderBook', path: '/domestic-futureoption/v1/quotations/inquire-asking-price', tr: 'FHMIF10010000', call: (k) => k.fetchDerivativeOrderBook('101W12'),
        query: { FID_COND_MRKT_DIV_CODE: 'F', FID_INPUT_ISCD: '101W12' },
    },
    {
        name: 'fetchDerivativePrice', path: '/domestic-futureoption/v1/quotations/inquire-price', tr: 'FHMIF10000000', call: (k) => k.fetchDerivativePrice('101W12'),
        query: { FID_COND_MRKT_DIV_CODE: 'F', FID_INPUT_ISCD: '101W12' }, third: true,
    },
    {
        name: 'fetchDerivativeCandles', path: '/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice', tr: 'FHKIF03020100',
        call: (k) => k.fetchDerivativeCandles('101W12', '1w', Date.parse('2026-09-01T00:00:00+09:00')),
        query: { FID_COND_MRKT_DIV_CODE: 'F', FID_INPUT_ISCD: '101W12', FID_INPUT_DATE_1: '20260901', FID_INPUT_DATE_2: '20260923', FID_PERIOD_DIV_CODE: 'W' },
    },
    {
        name: 'fetchDerivativeMinuteCandles', path: '/domestic-futureoption/v1/quotations/inquire-time-fuopchartprice', tr: 'FHKIF03020200', call: (k) => k.fetchDerivativeMinuteCandles('101W12', '30s'),
        query: {
            FID_COND_MRKT_DIV_CODE: 'F', FID_INPUT_ISCD: '101W12', FID_HOUR_CLS_CODE: '30', FID_PW_DATA_INCU_YN: 'Y', FID_FAKE_TICK_INCU_YN: 'N',
            FID_INPUT_DATE_1: '20260923', FID_INPUT_HOUR_1: '101530',
        },
    },
    {
        name: 'fetchOverseasFuturesOrderBook', path: '/overseas-futureoption/v1/quotations/inquire-asking-price', tr: 'HHDFC86000000', call: (k) => k.fetchOverseasFuturesOrderBook('esz26'),
        query: { SRS_CD: 'ESZ26' },
    },
    {
        name: 'fetchOverseasOptionOrderBook', path: '/overseas-futureoption/v1/quotations/opt-asking-price', tr: 'HHDFO86000000', call: (k) => k.fetchOverseasOptionOrderBook('OESZ26 C5500'),
        query: { SRS_CD: 'OESZ26 C5500' },
    },
    {
        name: 'fetchOverseasFuturesOpenInterest', path: '/overseas-futureoption/v1/quotations/investor-unpd-trend', tr: 'HHDDB95030000', call: (k) => k.fetchOverseasFuturesOpenInterest('ES'),
        query: { PROD_ISCD: 'ES', BSOP_DATE: '20260923', UPMU_GUBUN: '0', CTS_KEY: '' },
    },
    {
        name: 'fetchOverseasFuturesTrend(1d)', path: '/overseas-futureoption/v1/quotations/daily-ccnl', tr: 'HHDFC55020100', call: (k) => k.fetchOverseasFuturesTrend('6AZ26', 'cme'),
        query: { SRS_CD: '6AZ26', EXCH_CD: 'CME', START_DATE_TIME: '', CLOSE_DATE_TIME: '20260923', QRY_TP: 'Q', QRY_CNT: '30', QRY_GAP: '', INDEX_KEY: '' },
    },
    {
        name: 'fetchOverseasFuturesTrend(5m)', path: '/overseas-futureoption/v1/quotations/inquire-time-futurechartprice', tr: 'HHDFC55020400', call: (k) => k.fetchOverseasFuturesTrend('BONZ26', 'EUREX', '5m'),
        query: { SRS_CD: 'BONZ26', EXCH_CD: 'EUREX', START_DATE_TIME: '', CLOSE_DATE_TIME: '20260923', QRY_TP: 'Q', QRY_CNT: '120', QRY_GAP: '5', INDEX_KEY: '' },
    },
    {
        name: 'fetchOverseasOptionTrend(1M)', path: '/overseas-futureoption/v1/quotations/opt-monthly-ccnl', tr: 'HHDFO55020300', call: (k) => k.fetchOverseasOptionTrend('DXZ26', 'ICE', '1M'),
        query: { SRS_CD: 'DXZ26', EXCH_CD: 'ICE', QRY_CNT: '30', START_DATE_TIME: '', CLOSE_DATE_TIME: '', QRY_GAP: '', QRY_TP: '', INDEX_KEY: '' },
    },
    {
        name: 'fetchBondEvaluations', path: '/domestic-bond/v1/quotations/avg-unit', tr: 'CTPF2005R', call: (k) => k.fetchBondEvaluations(undefined, Date.parse('2026-09-01T00:00:00+09:00')),
        query: { INQR_STRT_DT: '20260901', INQR_END_DT: '20260923', PDNO: '', PRDT_TYPE_CD: '302', VRFC_KIND_CD: '00', CTX_AREA_NK30: '', CTX_AREA_FK100: '' }, third: true,
    },
    {
        name: 'fetchElwLpTrades', path: '/elw/v1/quotations/lp-trade-trend', tr: 'FHPEW03760000', call: (k) => k.fetchElwLpTrades('52K577'),
        query: { FID_COND_MRKT_DIV_CODE: 'W', FID_INPUT_ISCD: '52K577' },
    },
];

describe('블록 원문으로 돌려주는 조회', () => {
    it.each(RAW_CASES)('$name 는 $path 를 TR $tr 로 부르고 블록을 그대로 돌려준다', async (c) => {
        fixKst();
        const blocks = { output1: { hts_kor_isnm: 'A' }, output2: [{ stck_bsop_date: '20260922' }], output3: { bstp_cls_code: '0001' } };
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk(blocks));

        const result = await c.call(newKis());

        const call = find(c.path);
        expect(headersOf(mockFetch, call).tr_id).toBe(c.tr);
        expect(queryOf(call)).toEqual(c.query);
        expect(result).toEqual(c.third ? blocks : { output1: blocks.output1, output2: blocks.output2 });
    });

    it('간격을 체결추이 TR 로 고른다', async () => {
        const kinds = [
            ['futures', 'tick', '/tick-ccnl', 'HHDFC55020200'], ['futures', '1w', '/weekly-ccnl', 'HHDFC55020000'], ['futures', '1M', '/monthly-ccnl', 'HHDFC55020300'],
            ['option', 'tick', '/opt-tick-ccnl', 'HHDFO55020200'], ['option', '1d', '/opt-daily-ccnl', 'HHDFO55020100'], ['option', '1w', '/opt-weekly-ccnl', 'HHDFO55020000'],
        ] as const;
        for (const [kind, interval, path, tr] of kinds) {
            mockFetch.mockReset();
            mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: {}, output2: [] }));
            const k = newKis();
            await (kind === 'futures' ? k.fetchOverseasFuturesTrend('6AZ26', 'CME', interval) : k.fetchOverseasOptionTrend('DXZ26', 'ICE', interval));
            expect(headersOf(mockFetch, find(`/overseas-futureoption/v1/quotations${path}`)).tr_id).toBe(tr);
        }
    });
});

describe('국내 선물옵션', () => {
    it('fetchFuturesBoard 는 예제값을 보내고 선물 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                futs_shrn_iscd: '101W12', hts_kor_isnm: 'F 202612', futs_prpr: '412.35', futs_prdy_vrss: '1.2', futs_prdy_ctrt: '0.29', futs_hgpr: '413', futs_lwpr: '410.5', acml_vol: '150000',
                hts_otst_stpl_qty: '320000', futs_bidp: '412.3', futs_askp: '412.35', total_bidp_rsqn: '800', total_askp_rsqn: '750', hts_thpr: '413.1', hts_rmnn_dynu: '78',
                futs_antc_cnpr: '0', futs_antc_cntg_vrss: '0', antc_cntg_prdy_ctrt: '0',
            }],
        }));

        const [item] = await newKis().fetchFuturesBoard();

        const call = find('/domestic-futureoption/v1/quotations/display-board-futures');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPIF05030200');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'F', FID_COND_SCR_DIV_CODE: '20503', FID_COND_MRKT_CLS_CODE: 'MKI' });
        expect(item).toMatchObject({
            code: '101W12', name: 'F 202612', price: 412.35, change: 1.2, high: 413, volume: 150000, openInterest: 320000, bid: 412.3, ask: 412.35,
            totalBidSize: 800, theoreticalPrice: 413.1, remainingDays: 78, expectedPrice: 0,
        });
    });

    it('fetchOptionExpiries 는 화면 509 를 보내고 월물 목록을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [{ mtrt_yymm_code: '202610', mtrt_yymm: '2026년10월' }] }));

        const [expiry] = await newKis().fetchOptionExpiries();

        const call = find('/domestic-futureoption/v1/quotations/display-board-option-list');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPIO056104C0');
        expect(queryOf(call)).toEqual({ FID_COND_SCR_DIV_CODE: '509', FID_COND_MRKT_DIV_CODE: '', FID_COND_MRKT_CLS_CODE: '' });
        expect(expiry).toMatchObject({ code: '202610', yearMonth: '2026년10월' });
    });

    it('입력이 틀리면 보내기 전에 거절한다', async () => {
        const k = newKis();
        await expect(k.fetchOptionBoard(undefined as unknown as string)).rejects.toThrow(ArgumentsRequired);
        await expect(k.fetchOptionBoard('2026-10')).rejects.toThrow(BadRequest);
        await expect(k.fetchDerivativePrice('10')).rejects.toThrow(BadRequest);
        await expect(k.fetchDerivativeCandles('101W12', '1h', Date.now())).rejects.toThrow(NotSupported);
        await expect(k.fetchDerivativeCandles('101W12', '1d')).rejects.toThrow(ArgumentsRequired);
        await expect(k.fetchDerivativeMinuteCandles('101W12', '5m')).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('해외 선물옵션', () => {
    const QUOTE = {
        proc_date: '20260922', proc_time: '160000', open_price: '5500.25', high_price: '5520', low_price: '5490', last_price: '5510.5', vol: '1200000', prev_diff_flag: '2',
        prev_diff_price: '10.25', prev_diff_rate: '0.19', bid_qntt: '15', bid_price: '5510.25', ask_qntt: '12', ask_price: '5510.5', prev_price: '5500.25', trst_mgn: '14000',
        exch_cd: 'CME', crc_cd: 'USD', trd_fr_date: '20250920', expr_date: '20261218', trd_to_date: '20261218', remn_cnt: '86', last_qntt: '2', tot_ask_qntt: '300',
        tot_bid_qntt: '320', tick_size: '0.25', open_date: '20260922', open_time: '070000', close_date: '20260923', close_time: '060000', sbsnsdate: '20260922', sttl_price: '5505',
    };

    it('fetchOverseasFuturesQuote 와 fetchOverseasOptionQuote 는 종목코드를 보내고 같은 모양으로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: QUOTE })).mockResolvedValueOnce(dataOk({ output1: { ...QUOTE, prev_price: undefined } }));

        const k = newKis();
        const futures = await k.fetchOverseasFuturesQuote('ESZ26');
        const option = await k.fetchOverseasOptionQuote('OESZ26 C5500');

        const f = find('/overseas-futureoption/v1/quotations/inquire-price');
        expect(headersOf(mockFetch, f).tr_id).toBe('HHDFC55010000');
        expect(queryOf(f)).toEqual({ SRS_CD: 'ESZ26' });
        const o = find('/overseas-futureoption/v1/quotations/opt-price');
        expect(headersOf(mockFetch, o).tr_id).toBe('HHDFO55010000');
        expect(queryOf(o)).toEqual({ SRS_CD: 'OESZ26 C5500' });
        expect(futures).toMatchObject({
            exchangeCode: 'CME', currency: 'USD', price: 5510.5, open: 5500.25, previousClose: 5500.25, settlementPrice: 5505, change: 10.25, percentage: 0.19, changeFlag: '2',
            volume: 1200000, bid: 5510.25, bidSize: 15, ask: 5510.5, askSize: 12, totalBidSize: 320, margin: 14000, tickSize: 0.25, expiryDate: '20261218', remainingDays: 86, businessDate: '20260922',
        });
        expect(option.previousClose).toBeUndefined();
    });

    it('fetchOverseasFuturesDetail, fetchOverseasOptionDetail 은 계약 정보를 정리한다', async () => {
        const detail = {
            exch_cd: 'CME', clas_cd: 'IDX', crc_cd: 'USD', sttl_price: '5505', sttl_date: '20260922', prev_price: '5500.25', trst_mgn: '14000', tick_sz: '0.25', tick_val: '12.5',
            ctrt_size: '50', disp_digit: '10', mrkt_open_date: '20260922', mrkt_open_time: '070000', mrkt_close_date: '20260923', mrkt_close_time: '060000', trd_fr_date: '20250920',
            expr_date: '20261218', trd_to_date: '20261218', remn_cnt: '86', stat_tp: '1', stl_tp: '1', frst_noti_date: '', sprd_srs_cd1: 'ESZ26', sprd_srs_cd2: 'ESH27',
        };
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: detail })).mockResolvedValueOnce(dataOk({ output1: detail }));

        const k = newKis();
        const futures = await k.fetchOverseasFuturesDetail('ESZ26');
        await k.fetchOverseasOptionDetail('C5500');

        expect(headersOf(mockFetch, find('/overseas-futureoption/v1/quotations/stock-detail')).tr_id).toBe('HHDFC55010100');
        expect(queryOf(find('/overseas-futureoption/v1/quotations/opt-detail'))).toEqual({ SRS_CD: 'C5500' });
        expect(futures).toMatchObject({
            exchangeCode: 'CME', classCode: 'IDX', settlementPrice: 5505, previousClose: 5500.25, tickSize: 0.25, tickValue: 12.5, contractSize: 50, priceDisplayDigit: '10',
            marketOpenTime: '070000', expiryDate: '20261218', firstNoticeDate: undefined, remainingDays: 86, tradeStatus: '1', settlementType: '1',
        });
        expect(futures.info.sprd_srs_cd1).toBe('ESZ26');
    });

    it('fetchOverseasFuturesContracts 는 종목 수와 SRS_CD_01~ 을 채우고 output2 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output2: [{ exch_cd: 'CME', sub_exch_nm: 'CBOT' }, { exch_cd: 'EUREX' }] }));

        const rows = await newKis().fetchOverseasFuturesContracts(['6AZ26', 'bonz26']);

        const call = find('/overseas-futureoption/v1/quotations/search-contract-detail');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHDFC55200000');
        expect(queryOf(call)).toEqual({ QRY_CNT: '2', SRS_CD_01: '6AZ26', SRS_CD_02: 'BONZ26' });
        expect(rows.map((r) => r.exchangeCode)).toEqual(['CME', 'EUREX']);
        expect(rows[0]!.info.sub_exch_nm).toBe('CBOT');
    });

    it('fetchOverseasOptionContracts 는 TR HHDFO55200000 이고 한 번에 30개까지다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output2: [] }));

        await newKis().fetchOverseasOptionContracts(['6AM26']);

        const call = find('/overseas-futureoption/v1/quotations/search-opt-detail');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHDFO55200000');
        expect(queryOf(call)).toEqual({ QRY_CNT: '1', SRS_CD_01: '6AM26' });

        mockFetch.mockReset();
        await expect(newKis().fetchOverseasOptionContracts(Array.from({ length: 31 }, () => '6AM26'))).rejects.toThrow(BadRequest);
        await expect(newKis().fetchOverseasFuturesContracts([])).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetchOverseasDerivativeMarketHours 는 선택 입력을 비우고 장운영 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                fm_pdgr_cd: '001', fm_pdgr_name: '지수', fm_excg_cd: 'CME', fm_excg_name: 'CME', fuop_dvsn_name: '선물', fm_clas_cd: 'ES', fm_clas_name: 'E-mini S&P',
                am_mkmn_strt_tmd: '', am_mkmn_end_tmd: '', pm_mkmn_strt_tmd: '070000', pm_mkmn_end_tmd: '235959', mkmn_nxdy_strt_tmd: '000000', mkmn_nxdy_end_tmd: '060000',
                base_mket_strt_tmd: '223000', base_mket_end_tmd: '050000',
            }],
        }));

        const [row] = await newKis().fetchOverseasDerivativeMarketHours();

        const call = find('/overseas-futureoption/v1/quotations/market-time');
        expect(headersOf(mockFetch, call).tr_id).toBe('OTFM2229R');
        expect(queryOf(call)).toEqual({ FM_PDGR_CD: '', FM_CLAS_CD: '', FM_EXCG_CD: '', OPT_YN: 'N', CTX_AREA_NK200: '', CTX_AREA_FK200: '' });
        expect(row).toMatchObject({ exchangeCode: 'CME', classCode: 'ES', typeName: '선물', amStart: undefined, pmStart: '070000', nextDayEnd: '060000', baseStart: '223000' });
    });

    it('입력이 틀리면 보내기 전에 거절한다', async () => {
        const k = newKis();
        await expect(k.fetchOverseasFuturesTrend('6AZ26', undefined as unknown as string)).rejects.toThrow(ArgumentsRequired);
        await expect(k.fetchOverseasFuturesTrend('6AZ26', 'C-M-E')).rejects.toThrow(BadRequest);
        await expect(k.fetchOverseasFuturesTrend('6AZ26', 'CME', '1y')).rejects.toThrow(NotSupported);
        await expect(k.fetchOverseasOptionTrend('DXZ26', 'ICE', '5m')).rejects.toThrow(NotSupported);
        await expect(k.fetchOverseasFuturesOpenInterest('XX')).rejects.toThrow(BadRequest);
        await expect(k.fetchOverseasFuturesQuote('')).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('장내채권', () => {
    it('fetchBondPrice 는 시장 B 와 채권코드를 보내고 가격과 수익률을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                stnd_iscd: 'KR2033022D33', hts_kor_isnm: '국고03250-3306', bond_prpr: '10125.5', prdy_vrss_sign: '2', bond_prdy_vrss: '3.5', prdy_ctrt: '0.03', acml_vol: '50000',
                bond_prdy_clpr: '10122', bond_oprc: '10120', bond_hgpr: '10130', bond_lwpr: '10118', ernn_rate: '2.98', oprc_ert: '3.0', hgpr_ert: '2.97', lwpr_ert: '3.01',
                bond_mxpr: '11000', bond_llam: '9000',
            },
        }));

        const bond = await newKis().fetchBondPrice('kr2033022d33');

        const call = find('/domestic-bond/v1/quotations/inquire-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKBJ773400C0');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'B', FID_INPUT_ISCD: 'KR2033022D33' });
        expect(bond).toMatchObject({
            code: 'KR2033022D33', name: '국고03250-3306', price: 10125.5, change: 3.5, previousClose: 10122, open: 10120, upperLimit: 11000, volume: 50000,
            yieldRate: 2.98, openYield: 3, highYield: 2.97, lowYield: 3.01,
        });
    });

    it('fetchBondOrderBook 은 다섯 단계의 가격, 잔량, 수익 비율을 모은다', async () => {
        const output: Record<string, string> = { aspr_acpt_hour: '101500', total_askp_rsqn: '500', total_bidp_rsqn: '700', ntby_aspr_rsqn: '200' };
        for (let i = 1; i <= 5; i++) {
            output[`bond_askp${i}`] = String(10125 + i);
            output[`bond_bidp${i}`] = String(10125 - i);
            output[`askp_rsqn${i}`] = String(100 * i);
            output[`bidp_rsqn${i}`] = String(110 * i);
            output[`seln_ernn_rate${i}`] = (2.9 + i / 100).toFixed(2);
            output[`shnu_ernn_rate${i}`] = (3.0 + i / 100).toFixed(2);
        }
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output }));

        const book = await newKis().fetchBondOrderBook('KR2033022D33');

        expect(headersOf(mockFetch, find('/domestic-bond/v1/quotations/inquire-asking-price')).tr_id).toBe('FHKBJ773401C0');
        expect(book.asks[0]).toEqual({ price: 10126, size: 100, yieldRate: 2.91 });
        expect(book.bids[4]).toEqual({ price: 10120, size: 550, yieldRate: 3.05 });
        expect(book).toMatchObject({ time: '101500', totalAskSize: 500, totalBidSize: 700, netBidSize: 200 });
    });

    it('fetchBondTrades, fetchBondDailyPrices, fetchBondDailyChart 는 행을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: [{ stck_cntg_hour: '101500', bond_prpr: '10125.5', bond_prdy_vrss: '3.5', prdy_ctrt: '0.03', cntg_vol: '1000', acml_vol: '50000' }] }))
            .mockResolvedValueOnce(dataOk({ output: [{ stck_bsop_date: '20260922', bond_prpr: '10122', bond_prdy_vrss: '-1', prdy_ctrt: '-0.01', acml_vol: '40000', bond_oprc: '10123', bond_hgpr: '10125', bond_lwpr: '10120' }] }))
            .mockResolvedValueOnce(dataOk({ output: [{ stck_bsop_date: '20260922', bond_oprc: '10123', bond_hgpr: '10125', bond_lwpr: '10120', bond_prpr: '10122', acml_vol: '40000' }] }));

        const k = newKis();
        const [trade] = await k.fetchBondTrades('KR2033022D33');
        const [daily] = await k.fetchBondDailyPrices('KR2033022D33');
        const [chart] = await k.fetchBondDailyChart('KR2033022D33');

        expect(headersOf(mockFetch, find('/domestic-bond/v1/quotations/inquire-ccnl')).tr_id).toBe('FHKBJ773403C0');
        expect(headersOf(mockFetch, find('/domestic-bond/v1/quotations/inquire-daily-price')).tr_id).toBe('FHKBJ773404C0');
        expect(headersOf(mockFetch, find('/domestic-bond/v1/quotations/inquire-daily-itemchartprice')).tr_id).toBe('FHKBJ773701C0');
        expect(trade).toMatchObject({ time: '101500', price: 10125.5, volume: 1000, cumulativeVolume: 50000 });
        expect(daily).toMatchObject({ date: '20260922', open: 10123, high: 10125, low: 10120, close: 10122, change: -1, volume: 40000 });
        expect(chart).toMatchObject({ date: '20260922', close: 10122, change: undefined });
    });

    it('fetchBondIssueInfo, fetchBondInfo 는 상품유형코드 302 를 보내고 주요 값을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({
                output: {
                    pdno: 'KR6449111CB8', prdt_name: '회사채', prdt_eng_name: 'Corp Bond', bond_clsf_kor_name: '회사채', issu_istt_name: '발행사', papr: '10000', issu_amt: '100000000000',
                    lstg_rmnd: '100000000000', srfc_inrt: '4.2', expd_rdpt_rt: '100', expd_asrc_erng_rt: '0', int_dfrm_mcnt: '3', issu_dt: '20240101', lstg_dt: '20240102',
                    expd_dt: '20270101', rdpt_dt: '20270101', rgbf_int_dfrm_dt: '20260701', nxtm_int_dfrm_dt: '20261001', kis_crdt_grad_text: 'AA', kbp_crdt_grad_text: 'AA',
                    nice_crdt_grad_text: 'AA-', fnp_crdt_grad_text: '', ivst_heed_prdt_yn: 'N',
                },
            }))
            .mockResolvedValueOnce(dataOk({
                output: {
                    pdno: 'KR2033022D33', ksd_bond_item_name: '국고채권', ksd_bond_item_eng_name: 'KTB', bond_clsf_kor_name: '국고채', iso_crcy_cd: 'KRW', ksd_tot_issu_amt: '5000000000000',
                    ksd_rcvg_bond_srfc_inrt: '3.25', ksd_rcvg_bond_dsct_rt: '0', bond_expd_rdpt_rt: '100', bond_expd_asrc_erng_rt: '0', issu_dt: '20230610', rdpt_dt: '20330610',
                    lstg_dt: '20230612', lstg_abol_dt: '', rgbf_int_dfrm_dt: '20260610', nxtm_int_dfrm_dt: '20261210', dshn_occr_yn: 'N',
                },
            }));

        const k = newKis();
        const issue = await k.fetchBondIssueInfo('KR6449111CB8');
        const info = await k.fetchBondInfo('KR2033022D33');

        const a = find('/domestic-bond/v1/quotations/issue-info');
        expect(headersOf(mockFetch, a).tr_id).toBe('CTPF1101R');
        expect(queryOf(a)).toEqual({ PDNO: 'KR6449111CB8', PRDT_TYPE_CD: '302' });
        const b = find('/domestic-bond/v1/quotations/search-bond-info');
        expect(headersOf(mockFetch, b).tr_id).toBe('CTPF1114R');
        expect(queryOf(b)).toEqual({ PDNO: 'KR2033022D33', PRDT_TYPE_CD: '302' });
        expect(issue).toMatchObject({
            code: 'KR6449111CB8', faceValue: 10000, couponRate: 4.2, interestIntervalMonths: 3, maturityDate: '20270101', nextInterestDate: '20261001',
            creditRatings: { kis: 'AA', kbp: 'AA', nice: 'AA-', fnp: undefined }, investmentCaution: false,
        });
        expect(info).toMatchObject({ code: 'KR2033022D33', name: '국고채권', currency: 'KRW', couponRate: 3.25, redemptionDate: '20330610', delistingDate: undefined, defaulted: false });
    });

    it('채권코드 모양이 틀리거나 기간 시작이 없으면 보내기 전에 거절한다', async () => {
        await expect(newKis().fetchBondPrice('005930')).rejects.toThrow(BadRequest);
        await expect(newKis().fetchBondEvaluations()).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('ELW 원문 조회', () => {
    it('fetchElwSearch 는 필수 네 입력과 빈 선택 입력 53개를 보내고 행을 원문으로 돌려준다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [{ bond_shrn_iscd: '58J297', hts_kor_isnm: 'KBJ297삼성전자콜' }] }));

        const rows = await newKis().fetchElwSearch({ FID_UNAS_INPUT_ISCD: '005930' });

        const call = find('/elw/v1/quotations/cond-search');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKEW15100000');
        const query = queryOf(call);
        expect(query).toMatchObject({ FID_COND_MRKT_DIV_CODE: 'W', FID_COND_SCR_DIV_CODE: '11510', FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_CNT_1: '1', FID_UNAS_INPUT_ISCD: '005930', FID_THETA2: '' });
        expect(Object.keys(query)).toHaveLength(57);
        expect(rows).toEqual([{ bond_shrn_iscd: '58J297', hts_kor_isnm: 'KBJ297삼성전자콜' }]);
    });

    it('fetchElwVolatilityTicks 는 ELW 코드를 보내고 행을 원문으로 돌려준다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [{ bsop_date: '20260923', stck_cntg_hour: '101500', elw_prpr: '155', hts_ints_vltl: '28.5' }] }));

        const rows = await newKis().fetchElwVolatilityTicks('58J297');

        const call = find('/elw/v1/quotations/volatility-trend-tick');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPEW02840400');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'W', FID_INPUT_ISCD: '58J297' });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.elw_prpr).toBe('155');
    });
});
