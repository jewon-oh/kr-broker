/**
 * `kis` 클래스의 종목·정밀도·수수료·능력표·캔들.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch, mockYahoo } = vi.hoisted(() => ({ mockFetch: vi.fn(), mockYahoo: vi.fn() }));

vi.mock('../yahoo-finance-candles', () => ({ fetchYahooCandles: mockYahoo }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kis } from '../../kis';
import type { Exchange } from '../../base';
import { BadSymbol, ExchangeNotAvailable, NotSupported } from '../../base/errors';
import { KISCandleService } from '../kis-candle-service';
import { krxSellTaxRate } from '../../krx-sell-tax';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { dataOk, dataUrls, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

/** 종목 마스터 픽스처를 넘긴 인스턴스. */
const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase({ masterData: KIS_MASTER_FIXTURE, ...config });

beforeEach(() => {
    mockFetch.mockReset();
    mockYahoo.mockReset();
});

describe('describe() — 능력표와 선언', () => {
    const broker = new kis();

    it('id·국가·모의 지원·필수 자격증명', () => {
        expect(broker).toMatchObject({ id: 'kis', countries: ['KR'] });
        expect(broker.has.sandbox).toBe(true);
        expect(broker.requiredCredentials).toMatchObject({ apiKey: true, secret: true, uid: true });
    });

    it('★능력표는 실제 구현과 어긋나지 않는다 — has 가 true 인 통합 메서드는 부모의 기본 구현(NotSupported)이 아니다', () => {
        const base = Object.getPrototypeOf(kis.prototype) as Record<string, unknown>;
        const supported = ['fetchBalance', 'fetchMarkets', 'fetchTicker', 'fetchOrderBook', 'fetchOHLCV', 'fetchOrder', 'fetchOrders',
            'fetchOpenOrders', 'fetchMyTrades', 'fetchTradingFee', 'createOrder', 'cancelOrder', 'cancelAllOrders'];
        for (const name of supported) {
            expect(broker.has[name], name).toBeTruthy();
            expect(kis.prototype[name as keyof kis], `${name} 가 구현되지 않았다`).not.toBe(base[name]);
        }
    });

    it('지원하지 않는 것은 has 가 false 이고 부모의 기본 구현이 NotSupported 를 던진다', async () => {
        expect(broker.has.fetchTime).toBe(false);
        await expect(broker.fetchTime()).rejects.toThrow(NotSupported);
    });

    it('api 트리의 엔드포인트마다 암묵 메서드가 만들어진다 — 주문 엔드포인트는 order 표시가 있다', () => {
        expect(typeof broker.privateGetUapiDomesticStockV1QuotationsInquirePrice).toBe('function');
        expect(typeof broker.privatePostUapiOverseasStockV1TradingOrderRvsecncl).toBe('function');
        expect(broker.api?.private.post['uapi/domestic-stock/v1/trading/order-cash'].order).toBe(true);
        expect(broker.api?.private.get['uapi/domestic-stock/v1/trading/inquire-daily-ccld'].order).toBeUndefined();
    });

    it('조회는 20초, 주문은 25초 상한이다 — 주문 상한이 더 길다', () => {
        expect(broker.timeout).toBe(20_000);
        expect(broker.orderTimeout).toBe(25_000);
    });
});

describe('fetchMarkets / loadMarkets — 종목 마스터 데이터로 만든다', () => {
    it('국내와 미국 종목을 통합 심볼로 옮긴다', async () => {
        const markets = await newKis().loadMarkets();

        expect(markets['005930/KRW']).toMatchObject({
            id: '005930', base: '005930', quote: 'KRW', type: 'spot', spot: true, active: true, info: { name: '삼성전자', market: 'KOSPI' },
        });
        expect(markets['AAPL/USD']).toMatchObject({ id: 'AAPL', quote: 'USD', precision: { amount: 1, price: 0.01 } });
        expect(markets['AAPL/USD'].options).toMatchObject({ exchange: 'NAS', orderExchange: 'NASD' });
        expect(markets['V/USD'].options?.orderExchange).toBe('NYSE');
    });

    it('슬래시가 든 티커(BRK/B)는 BRK.B/USD 로 통합하고 market.id 에 KIS 표기를 둔다', async () => {
        const masterData = { ...KIS_MASTER_FIXTURE, nyse: [{ code: 'BRK/B', name: 'BERKSHIRE HATHAWAY INC-CL B', market: 'NYS' as const, currency: 'USD' }] };

        const markets = await newKis({ masterData }).loadMarkets();

        expect(markets['BRK.B/USD']).toMatchObject({ id: 'BRK/B', base: 'BRK.B', baseId: 'BRK/B' });
    });

    it('market 옵션으로 국내나 미국만 받는다', async () => {
        const domestic = await newKis().fetchMarkets({ market: 'domestic' });
        const overseas = await newKis().fetchMarkets({ market: 'overseas' });

        expect(domestic.every((m) => m.quote === 'KRW')).toBe(true);
        expect(overseas.every((m) => m.quote === 'USD')).toBe(true);
        expect(overseas.map((m) => m.symbol)).toContain('AAPL/USD');
    });

    it('★loadMarkets 없이도 주문·시세 호출이 된다(국내는 종목코드 모양만으로 가른다)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { stck_prpr: '70000', prdy_ctrt: '0', prdy_vrss: '0' } }));

        const ticker = await newKis({ masterData: { kospi: [], kosdaq: [], nasdaq: [], nyse: [], amex: [] } }).fetchTicker('005930/KRW'); // 마스터가 비어 있다

        expect(ticker.symbol).toBe('005930/KRW');
    });

    it('★market() 과 amountToPrecision() 은 종목 마스터 없이도 심볼 모양으로 종목을 만든다', async () => {
        const k = newKis({ masterData: { kospi: [], kosdaq: [], nasdaq: [], nyse: [], amex: [] } });
        expect(k.market('005930/KRW').symbol).toBe('005930/KRW');   // loadMarkets 전에도 된다
        await k.loadMarkets();
        expect(k.amountToPrecision('005930/KRW', 3.7)).toBe('3');
        expect(k.market('AAPL/USD')).toMatchObject({ symbol: 'AAPL/USD', quote: 'USD' }); // 해외는 상장 거래소만 모른다
    });

    it('★등락률이 반올림으로 0 이면 전일대비 부호를 전일대비부호(prdy_vrss_sign)로 정한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: { stck_prpr: '999950', prdy_ctrt: '0.00', prdy_vrss: '50', prdy_vrss_sign: '5' } }))
            .mockResolvedValueOnce(dataOk({ output: { stck_prpr: '1000050', prdy_ctrt: '0.00', prdy_vrss: '50', prdy_vrss_sign: '2' } }))
            .mockResolvedValueOnce(dataOk({ output: { stck_prpr: '70000', prdy_ctrt: '-0.71', prdy_vrss: '500', prdy_vrss_sign: '2' } }));
        const k = newKis();

        expect((await k.fetchTicker('005930/KRW')).change).toBe(-50);
        expect((await k.fetchTicker('005930/KRW')).change).toBe(50);
        expect((await k.fetchTicker('005930/KRW')).change).toBe(-500); // 등락률이 0 이 아니면 등락률의 부호를 쓴다
    });
});

describe('priceToPrecision — 호가 단위', () => {
    const broker = newKis();

    it.each([
        ['1999', '1999'], ['4996', '4995'], ['19996', '20000'], ['49960', '49950'], ['70040', '70000'], ['70050', '70100'], ['300240', '300000'], ['600700', '601000'],
    ])('국내 일반 주식은 가격대별 호가 단위로 반올림한다 %s → %s', (price, expected) => {
        expect(broker.priceToPrecision('005930/KRW', price)).toBe(expected);
    });

    it('미국은 0.01 달러 단위다', () => {
        expect(broker.priceToPrecision('AAPL/USD', 150.126)).toBe('150.13');
    });

    it('ETF·ETN 은 표가 달라 손대지 않는다', () => {
        const masterData = { ...KIS_MASTER_FIXTURE, kospi: [{ code: '069500', name: 'KODEX 200', market: 'KOSPI' as const, securityType: 'ETF' }] };

        expect(newKis({ masterData }).priceToPrecision('069500/KRW', '35123')).toBe('35123');
    });

    it('가격이 없으면 undefined', () => {
        expect(broker.priceToPrecision('005930/KRW', undefined)).toBeUndefined();
    });
});

describe('fetchTradingFee', () => {
    it('국내는 위탁수수료율이고 매도 거래세는 info 에 있다', async () => {
        const fee = await newKis().fetchTradingFee('005930/KRW');

        expect(fee).toMatchObject({ symbol: '005930/KRW', maker: 0.00015, taker: 0.00015, percentage: true, tierBased: false });
        expect(fee.info.sellTaxRate).toBe(krxSellTaxRate());
    });

    it('미국은 0.25% 이고 거래세가 없다', async () => {
        const fee = await newKis().fetchTradingFee('AAPL/USD');

        expect(fee).toMatchObject({ symbol: 'AAPL/USD', taker: 0.0025 });
        expect(fee.info.sellTaxRate).toBe(0);
    });
});

describe('fetchOHLCV — 야후 우선, 미국 일봉은 KIS 폴백', () => {
    const daily = [[1_700_000_000_000, 1, 2, 0.5, 1.5, 10]];

    it('국내는 항상 야후로 받고 params.until 을 넘긴다', async () => {
        mockYahoo.mockResolvedValueOnce(daily);

        const candles = await newKis().fetchOHLCV('005930/KRW', '1h', 5, 100, { until: 1_800_000_000_000 });

        expect(candles).toEqual(daily);
        expect(mockYahoo).toHaveBeenCalledWith('005930/KRW', '1h', 100, 5, 1_800_000_000_000, 'KOSPI'); // 마스터가 KOSPI 로 알려 준 시장 구분이 야후 티커 접미사(.KS)가 된다
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('★미국 일봉인데 야후가 비면 KIS 해외 일봉으로 폴백한다', async () => {
        mockYahoo.mockResolvedValueOnce([]);
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output2: [
                { xymd: '20260522', open: '300', high: '310', low: '299', clos: '308.82', tvol: '1000' },
                { xymd: '20260521', open: '299', high: '305', low: '298', clos: '305.00', tvol: '900' },
            ],
        }));

        const candles = await newKis().fetchOHLCV('AAPL/USD', '1d', undefined, 100);

        expect(candles).toHaveLength(2);
        expect(candles[1][4]).toBe(308.82); // 오래된 봉이 앞이므로 최근 봉이 뒤에 있다
    });

    it('★미국 일봉인데 야후가 실패하면 KIS 해외 일봉으로 폴백하고, KIS 도 비면 야후의 오류를 던진다', async () => {
        mockYahoo.mockRejectedValueOnce(new BadSymbol('야후에 없다'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output2: [{ xymd: '20260522', open: '300', high: '310', low: '299', clos: '308.82', tvol: '1000' }],
        }));
        expect(await newKis().fetchOHLCV('AAPL/USD', '1d', undefined, 100)).toHaveLength(1);

        mockYahoo.mockRejectedValueOnce(new BadSymbol('야후에 없다'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output2: [] }));
        await expect(newKis().fetchOHLCV('AAPL/USD', '1d', undefined, 100)).rejects.toBeInstanceOf(BadSymbol);
    });

    it('국내 캔들은 야후 실패를 그대로 던진다 — 빈 배열로 바꾸지 않는다', async () => {
        mockYahoo.mockRejectedValueOnce(new ExchangeNotAvailable('야후 장애'));
        await expect(newKis().fetchOHLCV('005930/KRW', '1d')).rejects.toBeInstanceOf(ExchangeNotAvailable);
    });

    it('분봉은 야후가 비어도 KIS 로 폴백하지 않는다(KIS 해외 분봉은 받지 않는다)', async () => {
        mockYahoo.mockResolvedValueOnce([]);

        expect(await newKis().fetchOHLCV('AAPL/USD', '5m')).toEqual([]);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('★야후에는 통합 심볼을 넘긴다 — KIS 표기(BRK/B)로 불러도 BRK.B/USD 다', async () => {
        const nyse = [...KIS_MASTER_FIXTURE.nyse, { code: 'BRK/B', name: 'BERKSHIRE HATHAWAY INC-CL B', market: 'NYS' as const, currency: 'USD' }];
        mockYahoo.mockResolvedValueOnce(daily);

        await newKis({ masterData: { ...KIS_MASTER_FIXTURE, nyse } }).fetchOHLCV('BRK/B', '1d', undefined, 2);

        expect(mockYahoo.mock.calls[0][0]).toBe('BRK.B/USD');
    });

    it('★미국 일봉 KIS 폴백도 since 부터 until 까지의 봉을 앞에서부터 limit 개 준다', async () => {
        const since = Date.UTC(2024, 0, 1);
        const until = Date.UTC(2024, 0, 6);
        const row = (xymd: string) => ({ xymd, open: '1', high: '2', low: '0.5', clos: '1.5', tvol: '10' });
        mockYahoo.mockResolvedValueOnce([]);
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output2: ['20240105', '20240104', '20240103', '20240102', '20231229'].map(row),
        }));

        const candles = await newKis().fetchOHLCV('AAPL/USD', '1d', since, 3, { until });

        expect(dataUrls(mockFetch)[0]).toContain('BYMD=20240105'); // until 의 미국 동부 날짜(1/5 19:00 EST)
        expect(candles.map((c) => c[0])).toEqual([Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3), Date.UTC(2024, 0, 4)]);
    });
});

describe('candles() — KIS 원본 캔들', () => {
    it('★해외 일봉은 output2 배열을 통째로 받는다(예전에 첫 원소 하나로 줄여 항상 빈 결과가 됐다)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { nrec: '3' },
            output2: [{ xymd: '20260522', clos: '308.82' }, { xymd: '20260521', clos: '305.00' }, { xymd: '20260520', clos: '301.10' }],
        }));

        const candles = await newKis().candles().fetchOverseasDailyOHLCV('AAPL', 'NAS', '1d', 10);

        expect(candles).toHaveLength(3);
    });

    it('★해외 일봉의 기준일(BYMD)은 미국 동부 날짜이고 다음 페이지는 마지막 일자의 하루 전이다 — 실행 환경의 시간대와 무관하다', async () => {
        // 동부 3/24 22:00(EDT). UTC·KST·UTC+14 로는 3/25 이고, UTC-7(로스앤젤레스)로는 다음 페이지 기준일이 이틀 전으로 밀리던 시각이다.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-03-25T02:00:00Z'));
        try {
            const ymd = (daysBefore: number) => new Date(Date.UTC(2026, 2, 24 - daysBefore)).toISOString().slice(0, 10).replace(/-/g, '');
            const row = (xymd: string) => ({ xymd, open: '1', high: '2', low: '0.5', clos: '1.5', tvol: '10' });
            const pages = [{ output2: Array.from({ length: 100 }, (_, i) => row(ymd(i))) }, { output2: [row(ymd(100))] }];
            const bymds: unknown[] = [];
            const fake = {
                milliseconds: () => Date.now(),
                privateGetUapiOverseasPriceV1QuotationsDailyprice: async (params: Record<string, unknown>) => {
                    bymds.push(params.BYMD);
                    return pages.shift();
                },
            };

            const candles = await new KISCandleService(fake as unknown as Exchange).fetchOverseasDailyOHLCV('AAPL', 'NAS', '1d', 150);

            expect(bymds).toEqual(['20260324', '20251214']);
            expect(candles).toHaveLength(101);
        } finally {
            vi.useRealTimers();
        }
    });

    it('★해외 일봉에 since 를 주면 since 에 닿을 때까지 넘기고 since 부터 limit 개를 준다', async () => {
        const since = Date.UTC(2025, 0, 1);
        const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
        const row = (ms: number) => ({ xymd: ymd(ms), open: '1', high: '2', low: '0.5', clos: '1.5', tvol: '10' });
        const back = (fromMs: number, count: number, stepDays: number) =>
            Array.from({ length: count }, (_, i) => row(fromMs - i * stepDays * 86_400_000));
        const pages = [{ output2: back(Date.UTC(2025, 7, 20), 100, 1) }, { output2: back(Date.UTC(2025, 4, 11), 30, 5) }];
        const bymds: unknown[] = [];
        const fake = {
            milliseconds: () => Date.UTC(2026, 2, 25),
            privateGetUapiOverseasPriceV1QuotationsDailyprice: async (params: Record<string, unknown>) => {
                bymds.push(params.BYMD);
                return pages.shift();
            },
        };

        const candles = await new KISCandleService(fake as unknown as Exchange).fetchOverseasDailyOHLCV('AAPL', 'NAS', '1d', 150, since);

        // 첫 기준일은 지금이 아니라 since 에서 150개를 덮는 날(since + 232일)이고, 한 쪽을 다 받아도 since 에 못 닿았으면 더 넘긴다.
        expect(bymds).toEqual(['20250820', '20250512']);
        expect(candles).toHaveLength(127);
        expect(candles[0][0]).toBe(Date.UTC(2025, 0, 1));
    });

    it('★국내 일봉의 조회 기간은 실행 환경의 시간대가 아니라 한국 날짜이고, 시각은 인스턴스의 시계로 읽는다', async () => {
        const dates: unknown[] = [];
        const fake = {
            milliseconds: () => Date.parse('2026-09-25T20:00:00Z'), // 한국 9/26 05:00
            privateGetUapiDomesticStockV1QuotationsInquireDailyItemchartprice: async (params: Record<string, unknown>) => {
                dates.push([params.FID_INPUT_DATE_1, params.FID_INPUT_DATE_2]);
                return { output2: [] };
            },
        };
        const service = new KISCandleService(fake as unknown as Exchange);

        await service.fetchDailyOHLCV('005930', 'D', 10);
        await service.fetchDailyOHLCVPaged('005930', 'D', 1);

        // 10봉 × 1.5 = 15일 전(한국 9/11)부터 오늘(한국 9/26)까지, 페이지 창도 한국 9/26 에서 끝난다.
        expect(dates).toEqual([['20260911', '20260926'], ['20260510', '20260926']]);
    });

    it('★분봉 연속조회가 커서 시각의 봉을 다시 줘도 한 번만 담는다 — N분봉 거래량을 두 번 더하지 않는다', async () => {
        const row = (hms: string) => ({
            stck_bsop_date: '20260325', stck_cntg_hour: hms, stck_oprc: '1', stck_hgpr: '1', stck_lwpr: '1', stck_prpr: '1', cntg_vol: '1',
        });
        const page1 = Array.from({ length: 30 }, (_, i) => row(`10${String(59 - i).padStart(2, '0')}00`)); // 10:59 ~ 10:30
        const page2 = [row('103000'), row('102900')]; // 커서(10:30)의 봉을 다시 준다
        const pagesFor = () => [{ output2: page1 }, { output2: page2 }];
        const fakeWith = (pages: Array<{ output2: unknown[] }>) => ({
            privateGetUapiDomesticStockV1QuotationsInquireTimeItemchartprice: async () => pages.shift(),
        }) as unknown as Exchange;

        const oneMinute = await new KISCandleService(fakeWith(pagesFor())).fetchMinuteOHLCV('005930', 1, 100);
        const tenMinute = await new KISCandleService(fakeWith(pagesFor())).fetchMinuteOHLCV('005930', 10, 100);

        expect(oneMinute).toHaveLength(31);
        expect(new Set(oneMinute.map((c) => c[0])).size).toBe(31);
        expect(tenMinute.find((c) => c[0] === Date.parse('2026-03-25T10:30:00+09:00'))?.[5]).toBe(10);
    });

    it('국내 일봉을 오래된 순으로 돌려준다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output2: [
                { stck_bsop_date: '20260522', stck_oprc: '1', stck_hgpr: '3', stck_lwpr: '1', stck_clpr: '2', acml_vol: '10' },
                { stck_bsop_date: '20260521', stck_oprc: '1', stck_hgpr: '2', stck_lwpr: '1', stck_clpr: '1', acml_vol: '9' },
            ],
        }));

        const candles = await newKis().candles().fetchDailyOHLCVRange('005930', 'D', '20260501', '20260522');

        expect(candles.map((c) => c[0])).toEqual([Date.parse('2026-05-21T09:00:00+09:00'), Date.parse('2026-05-22T09:00:00+09:00')]);
    });
});
