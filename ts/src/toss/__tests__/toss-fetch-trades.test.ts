/**
 * @fileoverview `toss.fetchTrades` — `GET /trades`. 당일 최근 체결 내역(최대 50건)이다.
 * 체결가·체결수량·체결시각만 오고 방향(매수·매도)과 체결ID는 없다.
 */
import { describe, it, expect } from 'vitest';

import { installFakeToss, jsonOk, makeToss, type FakeToss } from './support/toss-fake';

const requestedQuery = (fake: FakeToss): URLSearchParams => fake.requestsTo('GET /api/v1/trades')[0].query;

describe('fetchTrades', () => {
    it('국내 — 체결 내역을 최신순 그대로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/trades': jsonOk([
                { price: '72000', volume: '120', timestamp: '2026-03-25T09:30:42.000+09:00', currency: 'KRW' },
                { price: '71900', volume: '50', timestamp: '2026-03-25T09:30:41.500+09:00', currency: 'KRW' },
            ]),
        });

        const trades = await makeToss().fetchTrades('005930/KRW');

        expect(trades).toHaveLength(2);
        expect(trades[0]).toMatchObject({ symbol: '005930/KRW', price: 72000, amount: 120, side: undefined, id: undefined });
        expect(requestedQuery(fake).get('symbol')).toBe('005930');
    });

    it('해외 — 소수점 가격도 그대로 옮긴다', async () => {
        installFakeToss({
            'GET /api/v1/trades': jsonOk([{ price: '185.70', volume: '15', timestamp: '2026-03-25T22:30:42.100+09:00', currency: 'USD' }]),
        });

        const trades = await makeToss().fetchTrades('AAPL/USD');

        expect(trades[0]).toMatchObject({ symbol: 'AAPL/USD', price: 185.7, amount: 15 });
    });

    it('limit 을 count 쿼리로 보내고 50을 넘지 않는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/trades': jsonOk([]) });

        await makeToss().fetchTrades('005930/KRW', undefined, 10);
        expect(requestedQuery(fake).get('count')).toBe('10');

        await makeToss().fetchTrades('005930/KRW', undefined, 200);
        expect(fake.requestsTo('GET /api/v1/trades')[1].query.get('count')).toBe('50');
    });

    it('since 이전 체결은 걸러낸다', async () => {
        installFakeToss({
            'GET /api/v1/trades': jsonOk([
                { price: '72000', volume: '120', timestamp: '2026-03-25T09:30:42.000+09:00', currency: 'KRW' },
                { price: '71900', volume: '50', timestamp: '2026-03-25T09:29:00.000+09:00', currency: 'KRW' },
            ]),
        });

        const trades = await makeToss().fetchTrades('005930/KRW', Date.parse('2026-03-25T09:30:00.000+09:00'));

        expect(trades).toHaveLength(1);
        expect(trades[0].price).toBe(72000);
    });
});
