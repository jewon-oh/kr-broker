/**
 * @fileoverview `toss.fetchProgramTrades` — `GET /stocks/{symbol}/program-trades`(국내 전용).
 * 차익거래·비차익거래 각각의 매수·매도·순매수 거래량이다.
 */
import { describe, it, expect } from 'vitest';

import { installFakeToss, jsonOk, makeToss, type FakeToss } from './support/toss-fake';

const requestedQuery = (fake: FakeToss): URLSearchParams => fake.requestsTo('GET /api/v1/stocks/005930/program-trades')[0]!.query;

describe('fetchProgramTrades', () => {
    it('기록과 다음 페이지 커서를 그대로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/stocks/005930/program-trades': jsonOk({
                nextUntil: '2026-07-15',
                records: [
                    {
                        date: '2026-07-17',
                        arbitrage: { buyVolume: '152300', sellVolume: '183400', netBuyVolume: '-31100' },
                        nonArbitrage: { buyVolume: '1210500', sellVolume: '1105200', netBuyVolume: '105300' },
                    },
                ],
            }),
        });

        const result = await makeToss().fetchProgramTrades('005930/KRW');

        expect(result.nextUntil).toBe('2026-07-15');
        expect(result.records[0]).toMatchObject({ date: '2026-07-17', arbitrage: { netBuyVolume: '-31100' } });
        expect(requestedQuery(fake).get('count')).toBe('5');
    });

    it('데이터가 없으면 빈 배열과 null 커서를 돌려준다', async () => {
        installFakeToss({ 'GET /api/v1/stocks/005930/program-trades': jsonOk({ nextUntil: null, records: [] }) });

        const result = await makeToss().fetchProgramTrades('005930/KRW');

        expect(result).toEqual({ nextUntil: null, records: [] });
    });

    it('count 와 until 을 쿼리로 보낸다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/stocks/005930/program-trades': jsonOk({ nextUntil: null, records: [] }) });

        await makeToss().fetchProgramTrades('005930/KRW', 10, { until: '2026-07-15' });

        const query = requestedQuery(fake);
        expect(query.get('count')).toBe('10');
        expect(query.get('until')).toBe('2026-07-15');
    });
});
