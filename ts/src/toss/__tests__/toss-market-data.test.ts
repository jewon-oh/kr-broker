/**
 * @fileoverview 종목·시세·호가·봉·잔고·수수료·캘린더.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArgumentsRequired, NotSupported, NullResponse } from '../../base';
import { krxSellTaxRate } from '../../krx-sell-tax';
import { TOSS_BROKERAGE_FEE, TOSS_US_BROKERAGE_FEE } from '../toss-types';
import { errorReply, installFakeToss, jsonOk, makeToss, type FakeRequest } from './support/toss-fake';

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('종목', () => {
    it('loadMarkets 없이도 코드의 모양으로 시장을 판별한다', () => {
        const exchange = makeToss();
        expect(exchange.market('005930/KRW')).toMatchObject({ id: '005930', symbol: '005930/KRW', quote: 'KRW', type: 'spot' });
        expect(exchange.market('AAPL')).toMatchObject({ id: 'AAPL', symbol: 'AAPL/USD', quote: 'USD' });
        // 영숫자 신형 국내 코드는 국내다. 미국 티커로 오판하면 미국 세션과 수수료가 잘못 걸린다.
        expect(exchange.market('0101N0')).toMatchObject({ id: '0101N0', symbol: '0101N0/KRW', quote: 'KRW' });
        expect(exchange.market('BRK.B')).toMatchObject({ id: 'BRK.B', symbol: 'BRK.B/USD' });
    });

    it('loadMarkets 는 마켓별로 /stocks/all 을 불러 종목 유형을 싣는다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/stocks/all': (request: FakeRequest) => {
                const market = request.query.get('market');
                if (market === 'KOSPI') return jsonOk([{ symbol: '005930', name: '삼성전자', securityType: 'STOCK', isCommonShare: true, isinCode: 'KR7005930003' }]);
                if (market === 'KR_ETC') return jsonOk([{ symbol: '0101N0', name: '테스트 ETF', securityType: 'ETF', isCommonShare: true, isinCode: 'KR0101N00000' }]);
                if (market === 'NASDAQ') return jsonOk([{ symbol: 'AAPL', name: '애플', securityType: 'STOCK', isCommonShare: true, isinCode: 'US0378331005' }]);
                return jsonOk([]);
            },
        });
        const exchange = makeToss();
        const markets = await exchange.loadMarkets();
        expect(fake.requestsTo('GET /api/v1/stocks/all')).toHaveLength(7);
        expect(Object.keys(markets).sort()).toEqual(['005930/KRW', '0101N0/KRW', 'AAPL/USD']);
        expect(markets['005930/KRW'].options).toMatchObject({ market: 'KOSPI', securityType: 'STOCK', country: 'KR' });
        expect(markets['AAPL/USD']).toMatchObject({ quote: 'USD', precision: { amount: 1e-6 } });
    });

    it('종목의 taker·maker 는 시장별 기본 위탁수수료율이다 — 미국에 국내 요율을 넣지 않는다', async () => {
        installFakeToss({
            'GET /api/v1/stocks/all': (request: FakeRequest) => {
                const market = request.query.get('market');
                if (market === 'KOSPI') return jsonOk([{ symbol: '005930', name: '삼성전자', securityType: 'STOCK', isCommonShare: true, isinCode: 'KR7005930003' }]);
                if (market === 'NASDAQ') return jsonOk([{ symbol: 'AAPL', name: '애플', securityType: 'STOCK', isCommonShare: true, isinCode: 'US0378331005' }]);
                return jsonOk([]);
            },
        });
        const exchange = makeToss();
        const markets = await exchange.loadMarkets();
        expect(markets['005930/KRW']).toMatchObject({ taker: TOSS_BROKERAGE_FEE, maker: TOSS_BROKERAGE_FEE });
        expect(markets['AAPL/USD']).toMatchObject({ taker: TOSS_US_BROKERAGE_FEE, maker: TOSS_US_BROKERAGE_FEE });
        // 종목 표의 값이 fetchTradingFee 의 미국 기본값과 같다(공시 요율 조회에 실패해 기본값을 쓰는 경우).
        expect(exchange.effectiveFeeRate('AAPL', 'buy')).toBe(markets['AAPL/USD'].taker);
    });

    it('종목 유형을 불러온 ETF 는 매도에도 증권거래세가 붙지 않는다', async () => {
        installFakeToss({
            'GET /api/v1/stocks/all': (request: FakeRequest) => (request.query.get('market') === 'KR_ETC'
                ? jsonOk([{ symbol: '0101N0', name: '테스트 ETF', securityType: 'ETF', isCommonShare: true, isinCode: 'x' }])
                : jsonOk([])),
        });
        const exchange = makeToss();
        const at = new Date('2026-08-03T00:00:00Z');
        expect(exchange.effectiveFeeRate('0101N0', 'sell', at)).toBeCloseTo(krxSellTaxRate(at) + 0.00015, 8);
        await exchange.loadMarkets();
        expect(exchange.effectiveFeeRate('0101N0', 'sell', at)).toBeCloseTo(0.00015, 8);
    });
});

describe('시세', () => {
    it('fetchTicker 는 최종가를 싣고 호가·거래량은 지어내지 않는다', async () => {
        installFakeToss({ 'GET /api/v1/prices': jsonOk([{ symbol: '005930', lastPrice: '71000', currency: 'KRW', timestamp: '2026-07-16T02:00:00Z' }]) });
        const ticker = await makeToss().fetchTicker('005930/KRW');
        expect(ticker.symbol).toBe('005930/KRW');
        expect(ticker.last).toBe(71000);
        expect(ticker.timestamp).toBe(Date.parse('2026-07-16T02:00:00Z'));
        expect(ticker.bid).toBeUndefined();
        expect(ticker.ask).toBeUndefined();
        expect(ticker.baseVolume).toBeUndefined();
    });

    it('응답에 종목이 없으면 NullResponse', async () => {
        installFakeToss({ 'GET /api/v1/prices': jsonOk([]) });
        await expect(makeToss().fetchTicker('005930')).rejects.toBeInstanceOf(NullResponse);
    });

    it('fetchTickers 는 200종목씩 나눠 불러 통합 심볼로 색인한다', async () => {
        const codes = Array.from({ length: 250 }, (_, i) => String(100000 + i));
        const fake = installFakeToss({
            'GET /api/v1/prices': (request: FakeRequest) => jsonOk((request.query.get('symbols') ?? '').split(',').map((symbol) => ({ symbol, lastPrice: '1000' }))),
        });
        const tickers = await makeToss().fetchTickers(codes.map((code) => `${code}/KRW`));
        expect(fake.requestsTo('GET /api/v1/prices')).toHaveLength(2);
        expect(Object.keys(tickers)).toHaveLength(250);
        expect(tickers['100249/KRW'].last).toBe(1000);
    });

    it('fetchTickers 는 종목 없이 부를 수 없다', async () => {
        await expect(makeToss().fetchTickers()).rejects.toBeInstanceOf(ArgumentsRequired);
    });

    it('fetchOrderBook: 매수는 높은 가격순, 매도는 낮은 가격순이고 무효 호가는 거른다', async () => {
        installFakeToss({
            'GET /api/v1/orderbook': jsonOk({
                asks: [{ price: '71100', volume: '3' }, { price: '71000', volume: '10' }, { price: '0', volume: '1' }],
                bids: [{ price: '70800', volume: '2' }, { price: '70900', volume: '5' }],
                timestamp: '2026-07-16T02:00:00Z',
            }),
        });
        const book = await makeToss().fetchOrderBook('005930');
        expect(book.asks[0]).toEqual([71000, 10]);
        expect(book.bids[0]).toEqual([70900, 5]);
        expect(book.asks).toHaveLength(2);
        expect((await makeToss().fetchOrderBook('005930', 1)).bids).toHaveLength(1);
    });
});

describe('봉', () => {
    const candle = (timestamp: string, close: string): Record<string, string> => ({
        timestamp, openPrice: close, highPrice: close, lowPrice: close, closePrice: close, volume: '100',
    });

    it('1m 과 1d 만 제공한다. 다른 주기는 던진다', async () => {
        installFakeToss({});
        const exchange = makeToss();
        for (const timeframe of ['1h', '5m', '15m', '4h', '1w', '1M']) {
            await expect(exchange.fetchOHLCV('005930', timeframe), timeframe).rejects.toBeInstanceOf(NotSupported);
        }
        await expect(exchange.fetchOHLCV('005930', '1h')).rejects.toThrow(/미지원 타임프레임/);
    });

    it('일봉을 오래된 순으로 돌려주고 페이지를 이어 받으며 무효 봉을 거른다', async () => {
        installFakeToss({
            'GET /api/v1/candles': (request: FakeRequest) => {
                if (request.query.has('before')) return jsonOk({ candles: [candle('2026-07-14T00:00:00+09:00', '68500')], nextBefore: null });
                return jsonOk({
                    candles: [candle('2026-07-16T00:00:00+09:00', '70500'), candle('2026-07-15T00:00:00+09:00', '69500'), candle('bad', '0')],
                    nextBefore: '2026-07-15T00:00:00+09:00',
                });
            },
        });
        const rows = await makeToss().fetchOHLCV('005930', '1d', undefined, 3);
        expect(rows.map((row) => row[4])).toEqual([68500, 69500, 70500]);
    });

    it('1분봉의 timestamp 는 봉의 시작 시각이다(토스는 종료 시각으로 준다)', async () => {
        installFakeToss({ 'GET /api/v1/candles': jsonOk({ candles: [candle('2026-07-16T09:01:00+09:00', '70500')], nextBefore: null }) });
        const rows = await makeToss().fetchOHLCV('005930', '1m', undefined, 1);
        expect(rows[0][0]).toBe(Date.parse('2026-07-16T09:00:00+09:00'));
    });

    it('since 이전 봉은 받지 않고, until 은 before 로 보낸다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/candles': jsonOk({
                candles: [candle('2026-07-16T00:00:00+09:00', '70500'), candle('2026-07-15T00:00:00+09:00', '69500')],
                nextBefore: '2026-07-15T00:00:00+09:00',
            }),
        });
        const until = Date.parse('2026-07-17T00:00:00Z');
        const rows = await makeToss().fetchOHLCV('005930', '1d', Date.parse('2026-07-16T00:00:00+09:00'), 10, { until });
        expect(rows.map((row) => row[4])).toEqual([70500]);
        expect(fake.requestsTo('GET /api/v1/candles')[0].query.get('before')).toBe('2026-07-17T00:00:00.000Z');
    });
});

describe('잔고', () => {
    const holdings = {
        items: [
            { symbol: '005930', name: '삼성전자', quantity: '4', currency: 'KRW', averagePurchasePrice: '249250', marketValue: { amount: '1098000' } },
            { symbol: '000660', quantity: '0', currency: 'KRW' },
        ],
    };
    const buyingPower = (request: FakeRequest) => (request.query.get('currency') === 'USD'
        ? jsonOk({ currency: 'USD', cashBuyingPower: '2609.73' })
        : jsonOk({ currency: 'KRW', cashBuyingPower: '300000' }));

    it('현금은 통화 키, 보유 종목은 종목코드 키이고 total 이 수량이다', async () => {
        installFakeToss({ 'GET /api/v1/holdings': jsonOk(holdings), 'GET /api/v1/buying-power': buyingPower });
        const balance = await makeToss().fetchBalance();
        expect(balance.KRW).toMatchObject({ free: 300000, used: 0, total: 300000 });
        expect(balance.USD).toMatchObject({ free: 2609.73, total: 2609.73 });
        expect(balance['005930']).toMatchObject({ free: 4, total: 4 });
        expect(balance['005930'].info).toMatchObject({ name: '삼성전자', averagePurchasePrice: '249250' });
        // 수량이 0 인 보유는 싣지 않는다.
        expect(balance['000660']).toBeUndefined();
        expect(balance.total).toMatchObject({ KRW: 300000, '005930': 4 });
    });

    it('종목을 지정하면 그 종목의 보유만 받고 현금은 부르지 않는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/holdings': jsonOk(holdings), 'GET /api/v1/buying-power': buyingPower });
        const balance = await makeToss().fetchBalance({ symbol: '005930/KRW' });
        expect(balance['005930'].total).toBe(4);
        expect(balance.KRW).toBeUndefined();
        expect(fake.requestsTo('GET /api/v1/holdings')[0].query.get('symbol')).toBe('005930');
        expect(fake.requestsTo('GET /api/v1/buying-power')).toHaveLength(0);
    });

    it('통화를 지정하면 그 현금만 받고 보유는 부르지 않는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/holdings': jsonOk(holdings), 'GET /api/v1/buying-power': buyingPower });
        const balance = await makeToss().fetchBalance({ currency: 'KRW' });
        expect(balance.KRW.free).toBe(300000);
        expect(fake.requestsTo('GET /api/v1/holdings')).toHaveLength(0);
        expect(fake.requestsTo('GET /api/v1/buying-power')).toHaveLength(1);
    });

    it('조회에 실패하면 빈 잔고가 아니라 던진다', async () => {
        installFakeToss({ 'GET /api/v1/holdings': errorReply(500, 'internal-error'), 'GET /api/v1/buying-power': buyingPower });
        await expect(makeToss().fetchBalance()).rejects.toThrow('토스 API 오류: 500');
    });

    it('계좌 요청에는 계좌 헤더를 싣는다. uid 가 없으면 /accounts 로 첫 계좌를 찾는다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/accounts': jsonOk([{ accountNo: '123-45', accountSeq: 9, accountType: 'BROKERAGE' }]),
            'GET /api/v1/buying-power': buyingPower,
        });
        const exchange = makeToss({ uid: undefined });
        await exchange.fetchBalance({ currency: 'KRW' });
        expect(fake.requestsTo('GET /api/v1/buying-power')[0].headers['X-Tossinvest-Account']).toBe('9');
        expect(exchange.uid).toBe('9');
        expect(fake.requestsTo('GET /api/v1/accounts')[0].headers['X-Tossinvest-Account']).toBeUndefined();
    });

    describe('통합증거금', () => {
        const usdAndKrw = (usd: string, krw: string) => (request: FakeRequest) => (request.query.get('currency') === 'USD'
            ? jsonOk({ currency: 'USD', cashBuyingPower: usd })
            : jsonOk({ currency: 'KRW', cashBuyingPower: krw }));
        const rate = jsonOk({ baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1450' });

        it('옵션이 꺼져 있으면 순수 달러만 돌려주고 원화와 환율을 조회하지 않는다', async () => {
            const fake = installFakeToss({ 'GET /api/v1/buying-power': usdAndKrw('0', '1450000'), 'GET /api/v1/exchange-rate': rate });
            const balance = await makeToss().fetchBalance({ currency: 'USD' });
            expect(balance.USD.free).toBe(0);
            expect(fake.requestsTo('GET /api/v1/exchange-rate')).toHaveLength(0);
            expect(fake.requestsTo('GET /api/v1/buying-power')).toHaveLength(1);
        });

        it('옵션이 켜져 있으면 원화 예수금을 환산해 달러에 더한다', async () => {
            installFakeToss({ 'GET /api/v1/buying-power': usdAndKrw('3.5', '1450000'), 'GET /api/v1/exchange-rate': rate });
            const balance = await makeToss({ options: { krwIntegratedMargin: true } }).fetchBalance({ currency: 'USD' });
            expect(balance.USD.free).toBeCloseTo(1003.5, 2);
            expect(balance.USD.info.integratedMargin).toMatchObject({ krw: 1450000, usdKrw: 1450 });
        });

        it('원화 잔고가 0 이면 달러만이다', async () => {
            installFakeToss({ 'GET /api/v1/buying-power': usdAndKrw('250', '0'), 'GET /api/v1/exchange-rate': rate });
            const balance = await makeToss({ options: { krwIntegratedMargin: true } }).fetchBalance({ currency: 'USD' });
            expect(balance.USD.free).toBe(250);
        });

        it('전체 잔고에는 합산하지 않는다(이중 계상이 된다)', async () => {
            installFakeToss({ 'GET /api/v1/holdings': jsonOk({ items: [] }), 'GET /api/v1/buying-power': usdAndKrw('3.5', '1450000'), 'GET /api/v1/exchange-rate': rate });
            const balance = await makeToss({ options: { krwIntegratedMargin: true } }).fetchBalance();
            expect(balance.USD.free).toBe(3.5);
        });

        it('토스 환율 조회가 실패하면 usdKrwRate 옵션으로 폴백한다', async () => {
            installFakeToss({ 'GET /api/v1/buying-power': usdAndKrw('0', '500000'), 'GET /api/v1/exchange-rate': errorReply(500, 'internal-error') });
            const balance = await makeToss({ options: { krwIntegratedMargin: true, usdKrwRate: async () => 1000 } }).fetchBalance({ currency: 'USD' });
            expect(balance.USD.free).toBeCloseTo(500, 2);
        });
    });
});

describe('수수료', () => {
    it('fetchTradingFee: 공식 형식(소수 비율)과 백분율 응답을 모두 소수 비율로 읽는다', async () => {
        installFakeToss({ 'GET /api/v1/commissions': jsonOk([{ marketCountry: 'KR', commissionRate: '0.02' }, { marketCountry: 'US', commissionRate: '0.001' }]) });
        const exchange = makeToss();
        expect((await exchange.fetchTradingFee('005930')).taker).toBeCloseTo(0.0002, 8);
        // 미국 0.1% 를 소수 비율 문서 형식(`0.001`)으로 받아도 100배 작게 읽지 않는다.
        const us = await exchange.fetchTradingFee('AAPL');
        expect(us).toMatchObject({ symbol: 'AAPL/USD', percentage: true, tierBased: false });
        expect(us.taker).toBeCloseTo(0.001, 8);
    });

    it('effectiveFeeRate 는 국내 매도에 증권거래세를 더한다', async () => {
        installFakeToss({ 'GET /api/v1/commissions': jsonOk([{ marketCountry: 'KR', commissionRate: '0.00015' }, { marketCountry: 'US', commissionRate: '0.1' }]) });
        const exchange = makeToss();
        await exchange.refreshCommissions();
        const at = new Date('2026-08-03T00:00:00Z');
        expect(exchange.effectiveFeeRate('005930', 'buy', at)).toBeCloseTo(0.00015, 10);
        expect(exchange.effectiveFeeRate('005930', 'sell', at)).toBeCloseTo(0.00015 + krxSellTaxRate(at), 10);
        expect(exchange.effectiveFeeRate('AAPL', 'sell', at)).toBeCloseTo(0.001, 10);
    });

    it('무료(0%)는 유효한 값이고, 있을 수 없는 요율은 기본값을 유지한다', async () => {
        installFakeToss({ 'GET /api/v1/commissions': jsonOk([{ marketCountry: 'KR', commissionRate: '0' }, { marketCountry: 'US', commissionRate: '95' }]) });
        const exchange = makeToss();
        await exchange.refreshCommissions();
        expect(exchange.effectiveFeeRate('005930', 'buy')).toBe(0);
        expect(exchange.effectiveFeeRate('AAPL', 'buy')).toBeCloseTo(0.001, 10);
    });

    it('적용 기간이 지난 행은 쓰지 않는다', async () => {
        installFakeToss({
            'GET /api/v1/commissions': jsonOk([
                { marketCountry: 'KR', commissionRate: '0', startDate: '2020-01-01', endDate: '2020-12-31' },
                { marketCountry: 'KR', commissionRate: '0.00025', startDate: null, endDate: null },
            ]),
        });
        const exchange = makeToss();
        await exchange.refreshCommissions();
        expect(exchange.effectiveFeeRate('005930', 'buy')).toBeCloseTo(0.00025, 10);
    });

    it('미조회 상태에서는 기본 요율을 쓴다', () => {
        expect(makeToss().effectiveFeeRate('005930', 'buy')).toBeCloseTo(0.00015, 10);
        expect(makeToss().effectiveFeeRate('AAPL', 'buy')).toBeCloseTo(0.001, 10);
    });

    it('수수료율을 24시간 안에는 다시 조회하지 않는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/commissions': jsonOk([{ marketCountry: 'KR', commissionRate: '0.00015' }]) });
        const exchange = makeToss();
        await exchange.refreshCommissions();
        await exchange.refreshCommissions();
        expect(fake.requestsTo('GET /api/v1/commissions')).toHaveLength(1);
    });

    it('수수료율 조회가 실패하면 던지고, 그동안 기본 요율이 유지된다', async () => {
        installFakeToss({});
        const exchange = makeToss();
        await expect(exchange.refreshCommissions()).rejects.toThrow();
        expect(exchange.effectiveFeeRate('005930', 'buy')).toBeCloseTo(0.00015, 10);
    });
});

describe('장 운영 캘린더', () => {
    it('받은 캘린더를 30분 동안 다시 부르지 않고, refresh 로 강제한다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/market-calendar/US': jsonOk({ today: { date: '2026-08-03', dayMarket: null, preMarket: null, regularMarket: null, afterMarket: null } }) });
        const exchange = makeToss();
        await exchange.fetchMarketCalendar('US');
        await exchange.fetchMarketCalendar('US');
        expect(fake.requestsTo('GET /api/v1/market-calendar/US')).toHaveLength(1);
        await exchange.fetchMarketCalendar('US', { refresh: true });
        expect(fake.requestsTo('GET /api/v1/market-calendar/US')).toHaveLength(2);
    });

    it('currentKrSession: 세션이 없으면 closed, 캘린더를 못 받으면 null', async () => {
        installFakeToss({ 'GET /api/v1/market-calendar/KR': jsonOk({ today: { date: '2026-05-05', integrated: null } }) });
        expect(await makeToss().currentKrSession(new Date('2026-05-05T01:00:00Z'))).toBe('closed');
        installFakeToss({});
        expect(await makeToss().currentKrSession()).toBeNull();
    });
});

describe('종목 부가 정보', () => {
    it('유의사항·투자자별 매매대금·랭킹·종목 상세를 받아 온다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/stocks/005930/warnings': jsonOk([{ warningType: 'OVERHEATED' }]),
            'GET /api/v1/market-indicators/KOSPI/investor-trading': jsonOk({ records: [{ date: '2026-07-30', updatedAt: '', foreigner: { buyAmount: '100', sellAmount: '50' } }] }),
            'GET /api/v1/rankings': jsonOk({ rankings: [{ rank: 1, symbol: '005930', currency: 'KRW' }] }),
            'GET /api/v1/stocks': jsonOk([{ symbol: '005930', name: '삼성전자', sharesOutstanding: '5846278608' }]),
        });
        const exchange = makeToss();
        expect(await exchange.fetchStockWarnings('005930/KRW')).toEqual([{ warningType: 'OVERHEATED' }]);
        expect((await exchange.fetchInvestorTrading('KOSPI'))[0].foreigner?.buyAmount).toBe('100');
        expect((await exchange.fetchRankings('TOSS_SECURITIES_TRADING_AMOUNT'))[0].rank).toBe(1);
        expect((await exchange.fetchStocks(['005930/KRW', 'AAPL']))[0].name).toBe('삼성전자');
        expect(fake.requestsTo('GET /api/v1/stocks')[0].query.get('symbols')).toBe('005930,AAPL');
    });
});

describe('샌드박스', () => {
    it('토스에는 모의투자 환경이 없어 NotSupported', () => {
        expect(() => makeToss().setSandboxMode(true)).toThrow(NotSupported);
    });
});
