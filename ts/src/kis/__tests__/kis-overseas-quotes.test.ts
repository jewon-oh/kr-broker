/**
 * KIS 해외주식 기본시세 확장 메서드: 1호가, 현재가 상세, 체결추이, 종목·지수·환율 기간별 시세, 해외지수 분봉, 해외주식 분봉, 업종 코드와
 * 업종별 시세, 결제일.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, BadSymbol, NotSupported } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

/** 해외 종목 마스터를 넣은 인스턴스. AAPL 의 시세 거래소는 NAS 다. */
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

describe('해외 종목 시세', () => {
    it('fetchOverseasOrderBook 은 종목의 거래소로 1호가를 묻고 한 단계 호가를 돌려준다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { last: '227.5', curr: 'USD' },
            output2: { pbid1: '227.4', pask1: '227.6', vbid1: '300', vask1: '200' },
            output3: { vstm: '' },
        }));

        const book = await newKis().fetchOverseasOrderBook('AAPL/USD');

        const call = find('/overseas-price/v1/quotations/inquire-asking-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHDFS76200100');
        expect(queryOf(call)).toEqual({ AUTH: '', EXCD: 'NAS', SYMB: 'AAPL' });
        expect(book.bids).toEqual([[227.4, 300]]);
        expect(book.asks).toEqual([[227.6, 200]]);
        expect(book.symbol).toBe('AAPL/USD');
        expect(book.info).toHaveProperty('output1');
    });

    it('fetchOverseasStockDetail 은 상세 필드를 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                last: '227.5', open: '225', high: '228', low: '224.5', base: '225.3', tvol: '50000000', tamt: '11000000000', pvol: '48000000',
                tomv: '3400000000000', uplp: '0', dnlp: '0', h52p: '237.2', h52d: '20260715', l52p: '164.1', l52d: '20260408', perx: '34.1', pbrx: '50.2',
                epsx: '6.67', bpsx: '4.53', shar: '15000000000', curr: 'USD', vnit: '1', e_hogau: '0.01', e_icod: '컴퓨터', e_ordyn: '매매 가능', t_xprc: '315000', t_rate: '1385.5',
            },
        }));

        const detail = await newKis().fetchOverseasStockDetail('AAPL/USD');

        const call = find('/quotations/price-detail');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHDFS76200200');
        expect(queryOf(call)).toEqual({ AUTH: '', EXCD: 'NAS', SYMB: 'AAPL' });
        expect(detail).toMatchObject({
            symbol: 'AAPL/USD', last: 227.5, previousClose: 225.3, volume: 50000000, high52Week: 237.2, high52WeekDate: '20260715', low52WeekDate: '20260408',
            per: 34.1, eps: 6.67, currency: 'USD', lotSize: 1, tickSize: 0.01, sector: '컴퓨터', tradable: '매매 가능', krwPrice: 315000, exchangeRate: 1385.5,
        });
    });

    it('fetchOverseasTradeTicks 는 당일·전일 구분을 코드로 옮기고, 배열인 output2 를 행으로 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { zdiv: '4', nrec: '1' },
            output2: [{ khms: '233000', last: '227.5', diff: '2.2', rate: '0.98', evol: '100', tvol: '50000', pbid: '227.4', pask: '227.6', vpow: '101.2', mtyp: '1' }],
        }));

        const [tick] = await newKis().fetchOverseasTradeTicks('AAPL/USD', 'today');

        const call = find('/overseas-price/v1/quotations/inquire-ccnl');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHDFS76200300');
        expect(queryOf(call)).toEqual({ EXCD: 'NAS', TDAY: '1', SYMB: 'AAPL', AUTH: '', KEYB: '' });
        expect(tick).toMatchObject({ time: '233000', price: 227.5, change: 2.2, percentage: 0.98, volume: 100, cumulativeVolume: 50000, bid: 227.4, ask: 227.6, strength: 101.2, marketType: '1' });
    });

    it('fetchOverseasTradeTicks 는 output1 이 행 배열로 오면 그것을 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: [{ khms: '233001', last: '227.6' }] }));

        const [tick] = await newKis().fetchOverseasTradeTicks('AAPL/USD', 'previous');

        expect(queryOf(find('/overseas-price/v1/quotations/inquire-ccnl')).TDAY).toBe('0');
        expect(tick).toMatchObject({ time: '233001', price: 227.6 });
    });

    it('fetchOverseasMinuteOHLCV 는 봉 길이와 처음 조회 입력을 보내고 한국 기준 시각으로 봉을 만든다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { next: '1', more: 'Y' },
            output2: [
                { kymd: '20260923', khms: '223500', open: '227', high: '227.8', low: '226.9', last: '227.5', evol: '1000' },
                { kymd: '20260923', khms: '223000', open: '226.5', high: '227.1', low: '226.4', last: '227', evol: '900' },
            ],
        }));

        const candles = await newKis().fetchOverseasMinuteOHLCV('AAPL/USD', 5);

        const call = find('/quotations/inquire-time-itemchartprice');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHDFS76950200');
        expect(queryOf(call)).toEqual({ AUTH: '', EXCD: 'NAS', SYMB: 'AAPL', NMIN: '5', PINC: '1', NEXT: '', NREC: '120', FILL: '', KEYB: '' });
        expect(candles).toEqual([
            [Date.parse('2026-09-23T13:30:00Z'), 226.5, 227.1, 226.4, 227, 900],
            [Date.parse('2026-09-23T13:35:00Z'), 227, 227.8, 226.9, 227.5, 1000],
        ]);
    });

    it('국내 종목이나 잘못된 입력은 보내기 전에 던진다', async () => {
        const broker = newKis();
        await expect(broker.fetchOverseasOrderBook('005930/KRW')).rejects.toThrow(BadSymbol);
        await expect(broker.fetchOverseasTradeTicks('AAPL/USD', 'yesterday' as never)).rejects.toThrow(ArgumentsRequired);
        await expect(broker.fetchOverseasMinuteOHLCV('AAPL/USD', 0)).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('해외 지수·환율', () => {
    it('fetchGlobalOHLCV 는 종류를 시장 코드로 옮기고 기간을 한국 날짜로 보내며, 봉 시각은 그 날짜의 UTC 0시다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T06:00:00Z'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { ovrs_nmix_prpr: '42000' },
            output2: [
                { stck_bsop_date: '20260919', ovrs_nmix_oprc: '41800', ovrs_nmix_hgpr: '42100', ovrs_nmix_lwpr: '41700', ovrs_nmix_prpr: '42000', acml_vol: '300000000' },
                { stck_bsop_date: '20260918', ovrs_nmix_oprc: '41500', ovrs_nmix_hgpr: '41900', ovrs_nmix_lwpr: '41400', ovrs_nmix_prpr: '41800', acml_vol: '280000000' },
            ],
        }));

        const candles = await newKis().fetchGlobalOHLCV('INDEX', '.DJI', '1d', undefined, 10);

        const call = find('/quotations/inquire-daily-chartprice');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST03030100');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'N', FID_INPUT_ISCD: '.DJI', FID_INPUT_DATE_1: '20260907', FID_INPUT_DATE_2: '20260922', FID_PERIOD_DIV_CODE: 'D' });
        expect(candles).toEqual([
            [Date.UTC(2026, 8, 18), 41500, 41900, 41400, 41800, 280000000],
            [Date.UTC(2026, 8, 19), 41800, 42100, 41700, 42000, 300000000],
        ]);
    });

    it('fetchGlobalMinuteBars 는 예제의 정규장과 과거 포함을 보내고 날짜와 시각을 문자열로 둔다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { ovrs_nmix_prpr: '5600' },
            output2: [{ stck_bsop_date: '20260922', stck_cntg_hour: '100100', optn_oprc: '5600', optn_hgpr: '5602', optn_lwpr: '5599', optn_prpr: '5601', cntg_vol: '10' }],
        }));

        const [bar] = await newKis().fetchGlobalMinuteBars('FX', 'FX@KRW');

        const call = find('/quotations/inquire-time-indexchartprice');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST03030200');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'X', FID_INPUT_ISCD: 'FX@KRW', FID_HOUR_CLS_CODE: '0', FID_PW_DATA_INCU_YN: 'Y' });
        expect(bar).toMatchObject({ date: '20260922', time: '100100', open: 5600, high: 5602, low: 5599, close: 5601, volume: 10 });
    });

    it('종류가 없거나 봉 길이가 틀리면 보내기 전에 던진다', async () => {
        const broker = newKis();
        await expect(broker.fetchGlobalOHLCV('STOCK' as never, '.DJI')).rejects.toThrow(ArgumentsRequired);
        await expect(broker.fetchGlobalOHLCV('INDEX', '.DJI', '1h')).rejects.toThrow(NotSupported);
        await expect(broker.fetchGlobalMinuteBars('BOND' as never, 'X')).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('해외 업종과 결제일', () => {
    it('fetchOverseasIndustries 는 거래소로 업종 코드 목록을 묻는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: { nrec: '1' }, output2: [{ icod: '010', name: '반도체' }] }));

        const [industry] = await newKis().fetchOverseasIndustries('NAS');

        const call = find('/quotations/industry-price');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHDFS76370100');
        expect(queryOf(call)).toEqual({ EXCD: 'NAS', AUTH: '' });
        expect(industry).toMatchObject({ code: '010', name: '반도체' });
    });

    it('fetchOverseasIndustryStocks 는 업종코드와 거래량 전체를 보내고 순위 행 모양으로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { nrec: '1' },
            output2: [{ seqn: '1', symb: 'NVDA', name: '엔비디아', last: '120.5', diff: '2', rate: '1.69', tvol: '300000000' }],
        }));

        const [item] = await newKis().fetchOverseasIndustryStocks('NAS', '010');

        const call = find('/quotations/industry-theme');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHDFS76370000');
        expect(queryOf(call)).toEqual({ EXCD: 'NAS', ICOD: '010', VOL_RANG: '0', AUTH: '', KEYB: '' });
        expect(item).toMatchObject({ rank: 1, symbol: 'NVDA/USD', name: '엔비디아', last: 120.5, change: 2, percentage: 1.69, volume: 300000000 });
    });

    it('fetchSettlementDates 는 기준일자 기본값으로 오늘을 보내고 결제일을 정리한다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ tr_natn_cd: '840', tr_natn_name: '미국', tr_mket_cd: '01', tr_mket_name: '나스닥', acpl_sttl_dt: '20260924', dmst_sttl_dt: '20260925' }],
        }));

        const [row] = await newKis().fetchSettlementDates();

        const call = find('/overseas-stock/v1/quotations/countries-holiday');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTOS5011R');
        expect(queryOf(call)).toEqual({ TRAD_DT: '20260923', CTX_AREA_NK: '', CTX_AREA_FK: '' });
        expect(row).toMatchObject({ countryCode: '840', countryName: '미국', marketCode: '01', marketName: '나스닥', localSettlementDate: '20260924', domesticSettlementDate: '20260925' });
    });

    it('거래소가 설명 밖이거나 업종코드가 없으면 보내기 전에 던진다', async () => {
        const broker = newKis();
        await expect(broker.fetchOverseasIndustries('NASD' as never)).rejects.toThrow(BadRequest);
        await expect(broker.fetchOverseasIndustryStocks('NAS', '')).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
