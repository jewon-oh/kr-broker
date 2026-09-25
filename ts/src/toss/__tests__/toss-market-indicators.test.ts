/**
 * @fileoverview `toss.fetchMarketIndicators`·`toss.fetchMarketIndicatorOHLCV` — 시장 지표(국내 지수·국채) 현재가와 캔들.
 * 심볼 카탈로그는 KOSPI, KOSDAQ, KR_BOND_2Y·3Y·5Y·10Y·20Y·30Y 8종이다.
 */
import { describe, it, expect } from 'vitest';

import { installFakeToss, jsonOk, makeToss } from './support/toss-fake';

describe('fetchMarketIndicators', () => {
    it('심볼을 콤마로 이어 보내고 응답을 그대로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-indicators/prices': jsonOk([
                { symbol: 'KOSPI', timestamp: '2026-06-11T15:30:00+09:00', lastPrice: '2812.45' },
                { symbol: 'KOSDAQ', timestamp: '2026-06-11T15:30:00+09:00', lastPrice: '845.32' },
            ]),
        });

        const result = await makeToss().fetchMarketIndicators(['KOSPI', 'KOSDAQ']);

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ symbol: 'KOSPI', lastPrice: '2812.45' });
        expect(fake.requestsTo('GET /api/v1/market-indicators/prices')[0]!.query.get('symbols')).toBe('KOSPI,KOSDAQ');
    });

    it('국채 수익률도 그대로 옮긴다', async () => {
        installFakeToss({
            'GET /api/v1/market-indicators/prices': jsonOk([
                { symbol: 'KR_BOND_10Y', timestamp: '2026-06-11T15:29:58+09:00', lastPrice: '3.25' },
            ]),
        });

        const result = await makeToss().fetchMarketIndicators(['KR_BOND_10Y']);

        expect(result[0]).toMatchObject({ symbol: 'KR_BOND_10Y', lastPrice: '3.25' });
    });
});

describe('fetchMarketIndicatorOHLCV', () => {
    it('일봉을 ccxt OHLCV 튜플로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/market-indicators/KOSPI/candles': jsonOk({
                candles: [
                    { timestamp: '2026-06-11T09:00:00+09:00', openPrice: '2798.32', highPrice: '2820.15', lowPrice: '2790.1', closePrice: '2812.45', volume: '542000000' },
                ],
                nextBefore: '2026-06-10T09:00:00+09:00',
            }),
        });

        const result = await makeToss().fetchMarketIndicatorOHLCV('KOSPI', '1d');

        expect(result).toEqual([[Date.parse('2026-06-11T09:00:00+09:00'), 2798.32, 2820.15, 2790.1, 2812.45, 542000000]]);
        const query = fake.requestsTo('GET /api/v1/market-indicators/KOSPI/candles')[0]!.query;
        expect(query.get('interval')).toBe('1d');
        expect(query.get('count')).toBe('100');
    });

    it('분봉도 지수는 받는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/market-indicators/KOSPI/candles': jsonOk({ candles: [], nextBefore: null }) });

        await makeToss().fetchMarketIndicatorOHLCV('KOSPI', '1m', 50);

        const query = fake.requestsTo('GET /api/v1/market-indicators/KOSPI/candles')[0]!.query;
        expect(query.get('interval')).toBe('1m');
        expect(query.get('count')).toBe('50');
    });

    it('데이터가 없으면 빈 배열이다', async () => {
        installFakeToss({ 'GET /api/v1/market-indicators/KOSPI/candles': jsonOk({ candles: [], nextBefore: null }) });

        expect(await makeToss().fetchMarketIndicatorOHLCV('KOSPI')).toEqual([]);
    });
});
