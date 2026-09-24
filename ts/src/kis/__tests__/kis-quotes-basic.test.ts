/**
 * KIS 국내주식 기본시세 확장 메서드: 체결 목록 세 가지, 시간외 단일가 현재가·호가·일자별 시세, 회원사 매매와 실시간 매매동향,
 * 업종 봉, 날짜별 분봉, 일자별 시세, 거래 상태.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { BadRequest, BadSymbol, NotSupported } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

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

describe('체결 목록', () => {
    it('fetchTradeTicks 는 최근 체결을 시각 문자열 그대로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stck_cntg_hour: '153000', stck_prpr: '71000', prdy_vrss: '500', prdy_vrss_sign: '2', cntg_vol: '120', tday_rltv: '105.3', prdy_ctrt: '0.71' }],
        }));

        const [tick] = await newKis().fetchTradeTicks('005930/KRW');

        const call = find('/quotations/inquire-ccnl');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST01010300');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' });
        expect(tick).toEqual({
            time: '153000', price: 71000, change: 500, percentage: 0.71, volume: 120, cumulativeVolume: undefined, strength: 105.3,
            ask: undefined, bid: undefined, info: expect.objectContaining({ prdy_vrss_sign: '2' }),
        });
    });

    it('fetchTradeTicksBefore 는 기준 시각을 보내고 output2 의 체결가(stck_prpr)와 체결량(cnqn)을 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { stck_prpr: '71000', rprs_mrkt_kor_name: 'KOSPI200' },
            output2: [{ stck_cntg_hour: '115958', stck_prpr: '70900', prdy_vrss: '400', prdy_ctrt: '0.57', askp: '71000', bidp: '70900', tday_rltv: '98.1', acml_vol: '5000', cnqn: '10' }],
        }));

        const [tick] = await newKis().fetchTradeTicksBefore('005930/KRW', { until: Date.parse('2026-09-24T02:59:59Z') });

        const call = find('/quotations/inquire-time-itemconclusion');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST01060000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_HOUR_1: '115959' });
        expect(tick).toMatchObject({ time: '115958', price: 70900, volume: 10, cumulativeVolume: 5000, strength: 98.1, ask: 71000, bid: 70900 });
    });

    it('fetchTradeTicksBefore 는 stck_prpr 가 없으면 예제 필드 목록의 stck_pbpr 를 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output2: [{ stck_cntg_hour: '115958', stck_pbpr: '70900', cnqn: '10' }] }));

        const [tick] = await newKis().fetchTradeTicksBefore('005930/KRW', { until: Date.parse('2026-09-24T02:59:59Z') });

        expect(tick).toMatchObject({ time: '115958', price: 70900, volume: 10 });
    });

    it('fetchTradeTicksBefore 는 until 이 없으면 지금 시각(한국)을 보내고 until 을 요청에 싣지 않는다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-24T01:30:00Z'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output2: [] }));

        await newKis().fetchTradeTicksBefore('005930/KRW');

        const q = queryOf(find('/quotations/inquire-time-itemconclusion'));
        expect(q.FID_INPUT_HOUR_1).toBe('103000');
        expect(q).not.toHaveProperty('until');
    });


    it('fetchOvertimeTradeTicks 는 시간구분 1 을 보내고 output2 를 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { ovtm_untp_prpr: '71100' },
            output2: [{ stck_cntg_hour: '163000', stck_prpr: '71100', prdy_vrss: '600', prdy_ctrt: '0.85', askp: '71200', bidp: '71100', acml_vol: '800', cntg_vol: '30' }],
        }));

        const [tick] = await newKis().fetchOvertimeTradeTicks('005930/KRW');

        const call = find('/quotations/inquire-time-overtimeconclusion');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST02310000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_HOUR_CLS_CODE: '1' });
        expect(tick).toMatchObject({ time: '163000', price: 71100, volume: 30, cumulativeVolume: 800, strength: undefined, ask: 71200, bid: 71100 });
    });
});

describe('시간외 단일가', () => {
    it('fetchOvertimeTicker 는 시간외 단일가 값으로 Ticker 를 채우고, 대비 부호는 등락률을 따른다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                ovtm_untp_prpr: '70500', ovtm_untp_prdy_vrss: '500', ovtm_untp_prdy_ctrt: '-0.70', ovtm_untp_vol: '1200', ovtm_untp_tr_pbmn: '84600000',
                ovtm_untp_oprc: '71000', ovtm_untp_hgpr: '71100', ovtm_untp_lwpr: '70400', bidp: '70500', askp: '70600', ovtm_untp_sdpr: '71000',
            },
        }));

        const ticker = await newKis().fetchOvertimeTicker('005930/KRW');

        const call = find('/quotations/inquire-overtime-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST02300000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' });
        expect(ticker).toMatchObject({
            symbol: '005930/KRW', last: 70500, open: 71000, high: 71100, low: 70400, bid: 70500, ask: 70600,
            change: -500, percentage: -0.7, baseVolume: 1200, quoteVolume: 84600000,
        });
        expect(ticker.previousClose).toBeUndefined();
    });

    it('fetchOvertimeTicker 는 0 가격을 비운다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { ovtm_untp_prpr: '0', ovtm_untp_prdy_vrss: '0', ovtm_untp_prdy_ctrt: '0.00', ovtm_untp_vol: '0', bidp: '0', askp: '0' },
        }));

        const ticker = await newKis().fetchOvertimeTicker('005930/KRW');

        expect(ticker.last).toBeUndefined();
        expect(ticker.bid).toBeUndefined();
        expect(ticker.ask).toBeUndefined();
    });

    it('fetchOvertimeOrderBook 은 10단계를 정렬하고, 호가가 없으면 빈 호가를 돌려준다', async () => {
        const levels: Record<string, string> = {};
        for (let n = 1; n <= 10; n++) {
            levels[`ovtm_untp_askp${n}`] = String(70500 + n * 100);
            levels[`ovtm_untp_askp_rsqn${n}`] = String(n);
            levels[`ovtm_untp_bidp${n}`] = String(70500 - (n - 1) * 100);
            levels[`ovtm_untp_bidp_rsqn${n}`] = String(n * 10);
        }
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: levels }))
            .mockResolvedValueOnce(dataOk({ output: { ovtm_untp_askp1: '0', ovtm_untp_bidp1: '0' } }));
        const broker = newKis();

        const book = await broker.fetchOvertimeOrderBook('005930/KRW', 3);
        const empty = await broker.fetchOvertimeOrderBook('005930/KRW');

        expect(headersOf(mockFetch, find('/quotations/inquire-overtime-asking-price')).tr_id).toBe('FHPST02300400');
        expect(book.asks).toEqual([[70600, 1], [70700, 2], [70800, 3]]);
        expect(book.bids).toEqual([[70500, 10], [70400, 20], [70300, 30]]);
        expect(empty.asks).toEqual([]);
        expect(empty.bids).toEqual([]);
    });

    it('fetchOvertimeDailyPrices 는 output2 의 일자별 시간외 값과 정규장 값을 나눠 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { ovtm_untp_prpr: '70500' },
            output2: [{
                stck_bsop_date: '20260922', ovtm_untp_prpr: '70500', ovtm_untp_prdy_vrss: '-500', ovtm_untp_prdy_ctrt: '-0.70', ovtm_untp_vol: '1200',
                ovtm_untp_tr_pbmn: '84600000', stck_clpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', acml_vol: '9000000',
            }],
        }));

        const [day] = await newKis().fetchOvertimeDailyPrices('005930/KRW');

        const call = find('/quotations/inquire-daily-overtimeprice');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST02320000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' });
        expect(day).toMatchObject({
            businessDate: '20260922', overtimePrice: 70500, overtimeChange: -500, overtimeChangeRate: -0.7, overtimeVolume: 1200,
            overtimeAmount: 84600000, close: 71000, change: 500, percentage: 0.71, volume: 9000000,
        });
    });
});

describe('fetchMemberTrading', () => {
    it('매도·매수 상위 회원사를 순서대로 정리하고, 번호가 빈 자리는 뺀다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                seln_mbcr_no1: '00036', seln_mbcr_name1: '한국증권', total_seln_qty1: '5000', seln_mbcr_rlim1: '25.5', seln_qty_icdc1: '100', seln_mbcr_glob_yn_1: 'N',
                seln_mbcr_no2: '00045', seln_mbcr_name2: '외국계A', total_seln_qty2: '3000', seln_mbcr_rlim2: '15.0', seln_qty_icdc2: '-50', seln_mbcr_glob_yn_2: 'Y',
                seln_mbcr_no3: '',
                shnu_mbcr_no1: '00017', shnu_mbcr_name1: 'KB증권', total_shnu_qty1: '4000', shnu_mbcr_rlim1: '20.0', shnu_qty_icdc1: '0', shnu_mbcr_glob_yn_1: '',
                glob_total_seln_qty: '3000', glob_total_shnu_qty: '1000', glob_ntby_qty: '-2000', glob_seln_rlim: '15.0', glob_shnu_rlim: '5.0',
            },
        }));

        const result = await newKis().fetchMemberTrading('005930/KRW');

        const call = find('/quotations/inquire-member');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST01010600');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' });
        expect(result.sells).toEqual([
            { memberCode: '00036', memberName: '한국증권', volume: 5000, share: 25.5, volumeChange: 100, foreignBroker: false },
            { memberCode: '00045', memberName: '외국계A', volume: 3000, share: 15, volumeChange: -50, foreignBroker: true },
        ]);
        expect(result.buys).toEqual([{ memberCode: '00017', memberName: 'KB증권', volume: 4000, share: 20, volumeChange: 0, foreignBroker: undefined }]);
        expect(result).toMatchObject({ foreignBrokerSellVolume: 3000, foreignBrokerBuyVolume: 1000, foreignBrokerNetBuyVolume: -2000, foreignBrokerSellShare: 15, foreignBrokerBuyShare: 5 });
    });
});

describe('해외 종목', () => {
    const CASES = [
        (b: ReturnType<typeof newKis>) => b.fetchTradeTicks('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchTradeTicksBefore('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchOvertimeTradeTicks('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchOvertimeTicker('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchOvertimeOrderBook('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchOvertimeDailyPrices('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchMemberTrading('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchMemberTradeTicks('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchMinuteOHLCVAt('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchDailyPrices('AAPL/USD'),
        (b: ReturnType<typeof newKis>) => b.fetchStockStatus('AAPL/USD'),
    ];

    it.each(CASES.map((call, i) => [i, call] as const))('%i 번째 메서드는 BadSymbol 이고 요청을 보내지 않는다', async (_i, call) => {
        await expect(call(newKis({ masterData: KIS_MASTER_FIXTURE }))).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchMemberTradeTicks', () => {
    it('회원사 전체(99999)와 시장 전체(A)를 예제대로 보내고, 합계와 틱을 나눠 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ total_seln_qty: '5000', total_shnu_qty: '4000' }],
            output2: [{
                bsop_hour: '100501', mbcr_name: '한국증권', hts_kor_isnm: '삼성전자', stck_prpr: '71000', prdy_vrss: '500', prdy_vrss_sign: '2',
                cntg_vol: '100', acml_ntby_qty: '-300', glob_ntby_qty: '200', frgn_ntby_qty_icdc: '50',
            }],
        }));

        const result = await newKis().fetchMemberTradeTicks('005930/KRW');

        const call = find('/quotations/frgnmem-trade-trend');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST04320000');
        expect(queryOf(call)).toEqual({
            FID_COND_SCR_DIV_CODE: '20432', FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_ISCD_2: '99999', FID_MRKT_CLS_CODE: 'A', FID_VOL_CNT: '',
        });
        expect(result).toMatchObject({ totalSellVolume: 5000, totalBuyVolume: 4000 });
        expect(result.ticks[0]).toMatchObject({
            time: '100501', memberName: '한국증권', price: 71000, change: 500, volume: 100, cumulativeNetBuyVolume: -300, foreignBrokerNetBuyVolume: 200, foreignNetBuyChange: 50,
        });
    });

    it('회원사코드를 주면 그 회원사로 묻는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: [], output2: [] }));

        const result = await newKis().fetchMemberTradeTicks('005930/KRW', '00036');

        expect(queryOf(find('/quotations/frgnmem-trade-trend')).FID_INPUT_ISCD_2).toBe('00036');
        expect(result).toEqual({ totalSellVolume: undefined, totalBuyVolume: undefined, ticks: [] });
    });
});

describe('fetchIndexOHLCV', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('일봉은 기간 시세를 limit 에 휴장일 여유를 더한 구간으로 묻고, 09:00 KST 봉으로 오름차순 정리한다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T06:00:00Z')); // KST 9/22 15:00
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { bstp_nmix_prpr: '2600.00' },
            output2: [
                { stck_bsop_date: '20260922', bstp_nmix_oprc: '2590.1', bstp_nmix_hgpr: '2610.5', bstp_nmix_lwpr: '2580.0', bstp_nmix_prpr: '2600.0', acml_vol: '400000' },
                { stck_bsop_date: '20260921', bstp_nmix_oprc: '2570.0', bstp_nmix_hgpr: '2595.0', bstp_nmix_lwpr: '2565.0', bstp_nmix_prpr: '2590.0', acml_vol: '350000' },
            ],
        }));

        const candles = await newKis().fetchIndexOHLCV('0001', '1d', undefined, 10);

        const call = find('/quotations/inquire-daily-indexchartprice');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKUP03500100');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001', FID_INPUT_DATE_1: '20260907', FID_INPUT_DATE_2: '20260922', FID_PERIOD_DIV_CODE: 'D',
        });
        expect(candles).toEqual([
            [Date.parse('2026-09-21T00:00:00Z'), 2570, 2595, 2565, 2590, 350000],
            [Date.parse('2026-09-22T00:00:00Z'), 2590.1, 2610.5, 2580, 2600, 400000],
        ]);
    });

    it('주봉은 기간 구분 W 를 보내고, since 와 params.until 로 구간을 정하며 until 은 요청에 싣지 않는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: {}, output2: [] }));
        const since = Date.parse('2026-01-05T00:00:00Z');
        const until = since + 30 * DAY;

        await newKis().fetchIndexOHLCV('1001', '1w', since, undefined, { until });

        const q = queryOf(find('/quotations/inquire-daily-indexchartprice'));
        expect(q).toMatchObject({ FID_INPUT_ISCD: '1001', FID_INPUT_DATE_1: '20260105', FID_INPUT_DATE_2: '20260204', FID_PERIOD_DIV_CODE: 'W' });
        expect(q).not.toHaveProperty('until');
    });

    it('분봉은 업종 분봉을 봉 길이(초)로 묻고, since 는 받은 뒤에 거른다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: {},
            output2: [
                { stck_bsop_date: '20260922', stck_cntg_hour: '101000', bstp_nmix_oprc: '2600', bstp_nmix_hgpr: '2602', bstp_nmix_lwpr: '2599', bstp_nmix_prpr: '2601', cntg_vol: '900' },
                { stck_bsop_date: '20260922', stck_cntg_hour: '100000', bstp_nmix_oprc: '2598', bstp_nmix_hgpr: '2600', bstp_nmix_lwpr: '2597', bstp_nmix_prpr: '2600', cntg_vol: '800' },
            ],
        }));

        const candles = await newKis().fetchIndexOHLCV('0001', '10m', Date.parse('2026-09-22T01:05:00Z'));

        const call = find('/quotations/inquire-time-indexchartprice');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKUP03500200');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'U', FID_ETC_CLS_CODE: '0', FID_INPUT_ISCD: '0001', FID_INPUT_HOUR_1: '600', FID_PW_DATA_INCU_YN: 'Y' });
        expect(candles).toEqual([[Date.parse('2026-09-22T01:10:00Z'), 2600, 2602, 2599, 2601, 900]]);
    });

    it('업종코드가 네 자리 숫자가 아니거나 봉 길이가 문서 밖이면 보내기 전에 던진다', async () => {
        const broker = newKis();
        await expect(broker.fetchIndexOHLCV('KOSPI')).rejects.toThrow(BadRequest);
        await expect(broker.fetchIndexOHLCV('0001', '5m')).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchMinuteOHLCVAt', () => {
    it('기준 시각(params.until)의 한국 날짜와 시각을 보내고 1분봉을 오름차순으로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { stck_prpr: '71000' },
            output2: [
                { stck_bsop_date: '20260921', stck_cntg_hour: '125900', stck_oprc: '70900', stck_hgpr: '71000', stck_lwpr: '70900', stck_prpr: '71000', cntg_vol: '20' },
                { stck_bsop_date: '20260921', stck_cntg_hour: '125800', stck_oprc: '70800', stck_hgpr: '70900', stck_lwpr: '70800', stck_prpr: '70900', cntg_vol: '10' },
            ],
        }));

        const candles = await newKis().fetchMinuteOHLCVAt('005930/KRW', undefined, undefined, { until: Date.parse('2026-09-21T04:00:00Z') });

        const call = find('/quotations/inquire-time-dailychartprice');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST03010230');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_HOUR_1: '130000', FID_INPUT_DATE_1: '20260921', FID_PW_DATA_INCU_YN: 'N', FID_FAKE_TICK_INCU_YN: '',
        });
        expect(candles).toEqual([
            [Date.parse('2026-09-21T03:58:00Z'), 70800, 70900, 70800, 70900, 10],
            [Date.parse('2026-09-21T03:59:00Z'), 70900, 71000, 70900, 71000, 20],
        ]);
    });

    it('limit 은 가장 최근 봉부터 남긴다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output2: [
                { stck_bsop_date: '20260921', stck_cntg_hour: '125900', stck_prpr: '71000' },
                { stck_bsop_date: '20260921', stck_cntg_hour: '125800', stck_prpr: '70900' },
            ],
        }));

        const candles = await newKis().fetchMinuteOHLCVAt('005930/KRW', undefined, 1, { until: Date.parse('2026-09-21T04:00:00Z') });

        expect(candles.map((c) => c[0])).toEqual([Date.parse('2026-09-21T03:59:00Z')]);
    });
});

describe('fetchDailyPrices', () => {
    it('주 단위는 기간 구분 W, 수정주가 반영(1)을 보내고 외국인 값까지 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                stck_bsop_date: '20260921', stck_oprc: '70000', stck_hgpr: '72000', stck_lwpr: '69000', stck_clpr: '71000', acml_vol: '9000000',
                prdy_vrss: '1000', prdy_vrss_sign: '2', prdy_ctrt: '1.43', prdy_vrss_vol_rate: '120.5', hts_frgn_ehrt: '51.2', frgn_ntby_qty: '-3000',
                flng_cls_code: '00', acml_prtt_rate: '1.00',
            }],
        }));

        const [day] = await newKis().fetchDailyPrices('005930/KRW', '1w');

        const call = find('/quotations/inquire-daily-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST01010400');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_PERIOD_DIV_CODE: 'W', FID_ORG_ADJ_PRC: '1' });
        expect(day).toMatchObject({
            businessDate: '20260921', open: 70000, high: 72000, low: 69000, close: 71000, volume: 9000000, change: 1000, percentage: 1.43,
            volumeChangeRate: 120.5, foreignHoldingRate: 51.2, foreignNetBuyVolume: -3000, lockCode: '00',
        });
    });

    it('일, 주, 월 밖의 봉 길이는 보내기 전에 NotSupported 다', async () => {
        await expect(newKis().fetchDailyPrices('005930/KRW', '1h')).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchStockStatus', () => {
    it('여부 필드는 Y, N 만 true, false 로 옮기고 코드와 이름은 원문 그대로 둔다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                rprs_mrkt_kor_name: 'KOSPI200', bstp_kor_isnm: '전기·전자', stck_mxpr: '92300', stck_llam: '49700', stck_sdpr: '71000',
                trht_yn: 'N', sltr_yn: 'N', mang_issu_yn: 'N', short_over_yn: 'Y', invt_caful_yn: 'N', stange_runup_yn: 'N', ssts_hot_yn: 'N',
                low_current_yn: '', insn_pbnt_yn: 'N', crdt_able_yn: 'Y', mrkt_warn_cls_code: '01', mrkt_warn_cls_name: '투자주의',
                vi_cls_code: 'N', short_over_cls_code: '1', marg_rate: '20.00', crdt_rate: '0.15',
            },
        }));

        const status = await newKis().fetchStockStatus('005930/KRW');

        const call = find('/quotations/inquire-price-2');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST01010000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' });
        expect(status).toMatchObject({
            symbol: '005930/KRW', marketName: 'KOSPI200', sectorName: '전기·전자', upperLimitPrice: 92300, lowerLimitPrice: 49700, basePrice: 71000,
            tradingHalted: false, shortTermOverheated: true, lowLiquidity: undefined, creditAvailable: true,
            marketWarningCode: '01', marketWarningName: '투자주의', viCode: 'N', shortTermOverheatedCode: '1', marginRate: 20, creditRate: 0.15,
        });
    });
});
