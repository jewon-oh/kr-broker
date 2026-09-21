/**
 * `kis` 클래스의 종목·정밀도·수수료·능력표·캔들.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch, mockYahoo } = vi.hoisted(() => ({ mockFetch: vi.fn(), mockYahoo: vi.fn() }));

vi.mock('../yahoo-finance-candles', () => ({ fetchYahooCandles: mockYahoo }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kis } from '../../kis';
import { NotSupported } from '../../base/errors';
import { krxSellTaxRate } from '../../krx-sell-tax';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { dataOk, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

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
        expect(broker.has.fetchTickers).toBe(false);
        expect(broker.has.fetchTime).toBe(false);
        await expect(broker.fetchTickers()).rejects.toThrow(NotSupported);
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

    it('분봉은 야후가 비어도 KIS 로 폴백하지 않는다(KIS 해외 분봉은 받지 않는다)', async () => {
        mockYahoo.mockResolvedValueOnce([]);

        expect(await newKis().fetchOHLCV('AAPL/USD', '5m')).toEqual([]);

        expect(mockFetch).not.toHaveBeenCalled();
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
