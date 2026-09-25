/**
 * @fileoverview `toss.fetchStockInvestorTrading` — `GET /stocks/{symbol}/investor-trading`(국내 전용).
 * 종목 단위 투자자별 매매동향. 시장 단위인 `fetchInvestorTrading`와는 다른 엔드포인트다.
 */
import { describe, it, expect } from 'vitest';

import { installFakeToss, jsonOk, makeToss, type FakeToss } from './support/toss-fake';

const requestedQuery = (fake: FakeToss): URLSearchParams => fake.requestsTo('GET /api/v1/stocks/005930/investor-trading')[0]!.query;

describe('fetchStockInvestorTrading', () => {
    it('기록과 다음 페이지 커서를 그대로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/stocks/005930/investor-trading': jsonOk({
                nextUntil: '2026-07-15',
                records: [
                    {
                        date: '2026-07-16',
                        updatedAt: '2026-07-17T09:12:43+09:00',
                        individual: { buyVolume: '8412300', sellVolume: '8120450', netBuyVolume: '291850' },
                        foreigner: { buyVolume: '4210500', sellVolume: '4530200', netBuyVolume: '-319700' },
                        institution: { buyVolume: '1953200', sellVolume: '1915300', netBuyVolume: '37900', breakdown: null },
                        otherCorporation: null,
                        foreignerHolding: null,
                        cfd: null,
                    },
                ],
            }),
        });

        const result = await makeToss().fetchStockInvestorTrading('005930/KRW');

        expect(result.nextUntil).toBe('2026-07-15');
        expect(result.records).toHaveLength(1);
        expect(result.records[0]).toMatchObject({ date: '2026-07-16', individual: { netBuyVolume: '291850' } });
        expect(fake.requestsTo('GET /api/v1/stocks/005930/investor-trading')).toHaveLength(1);
        expect(requestedQuery(fake).get('count')).toBe('5');
    });

    it('당일 잠정치는 일부 필드가 null이다', async () => {
        installFakeToss({
            'GET /api/v1/stocks/005930/investor-trading': jsonOk({
                nextUntil: null,
                records: [{
                    date: '2026-07-17',
                    updatedAt: '2026-07-17T14:35:08+09:00',
                    individual: null,
                    foreigner: { buyVolume: '2105300', sellVolume: '1985400', netBuyVolume: '119900' },
                    institution: { buyVolume: '910200', sellVolume: '1023400', netBuyVolume: '-113200', breakdown: null },
                    otherCorporation: null,
                    foreignerHolding: null,
                    cfd: null,
                }],
            }),
        });

        const result = await makeToss().fetchStockInvestorTrading('005930/KRW');

        expect(result.records[0]!.individual).toBeNull();
        expect(result.records[0]!.otherCorporation).toBeNull();
    });

    it('데이터가 없으면 빈 배열과 null 커서를 돌려준다', async () => {
        installFakeToss({ 'GET /api/v1/stocks/005930/investor-trading': jsonOk({ nextUntil: null, records: [] }) });

        const result = await makeToss().fetchStockInvestorTrading('005930/KRW');

        expect(result).toEqual({ nextUntil: null, records: [] });
    });

    it('count 와 until 을 쿼리로 보낸다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/stocks/005930/investor-trading': jsonOk({ nextUntil: null, records: [] }) });

        await makeToss().fetchStockInvestorTrading('005930/KRW', 10, { until: '2026-07-15' });

        const query = requestedQuery(fake);
        expect(query.get('count')).toBe('10');
        expect(query.get('until')).toBe('2026-07-15');
    });
});
