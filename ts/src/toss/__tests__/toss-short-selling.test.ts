/**
 * @fileoverview `toss.fetchShortSelling` — `GET /stocks/{symbol}/short-selling`(국내 전용).
 * 공매도 거래량·거래대금과 해당 일자 전체 대비 비중을 일별로 준다.
 */
import { describe, it, expect } from 'vitest';

import { installFakeToss, jsonOk, makeToss, type FakeToss } from './support/toss-fake';

const requestedQuery = (fake: FakeToss): URLSearchParams => fake.requestsTo('GET /api/v1/stocks/005930/short-selling')[0]!.query;

describe('fetchShortSelling', () => {
    it('기록과 다음 페이지 커서를 그대로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/stocks/005930/short-selling': jsonOk({
                nextUntil: '2026-07-14',
                records: [
                    {
                        date: '2026-07-16',
                        updatedAt: '2026-07-16T17:25:43+09:00',
                        shortSellingVolume: '512300',
                        shortSellingAmount: '41250000000',
                        shortSellingVolumeRate: '0.03215',
                        shortSellingAmountRate: '0.0318',
                    },
                ],
            }),
        });

        const result = await makeToss().fetchShortSelling('005930/KRW');

        expect(result.nextUntil).toBe('2026-07-14');
        expect(result.records[0]).toMatchObject({ date: '2026-07-16', shortSellingVolume: '512300', shortSellingVolumeRate: '0.03215' });
        expect(requestedQuery(fake).get('count')).toBe('5');
    });

    it('분모 데이터가 없는 날짜는 비중이 null이다', async () => {
        installFakeToss({
            'GET /api/v1/stocks/005930/short-selling': jsonOk({
                nextUntil: null,
                records: [{
                    date: '2026-07-16',
                    updatedAt: '2026-07-16T17:25:43+09:00',
                    shortSellingVolume: '512300',
                    shortSellingAmount: '41250000000',
                    shortSellingVolumeRate: null,
                    shortSellingAmountRate: null,
                }],
            }),
        });

        const result = await makeToss().fetchShortSelling('005930/KRW');

        expect(result.records[0]!.shortSellingVolumeRate).toBeNull();
        expect(result.records[0]!.shortSellingAmountRate).toBeNull();
    });

    it('데이터가 없으면 빈 배열과 null 커서를 돌려준다', async () => {
        installFakeToss({ 'GET /api/v1/stocks/005930/short-selling': jsonOk({ nextUntil: null, records: [] }) });

        const result = await makeToss().fetchShortSelling('005930/KRW');

        expect(result).toEqual({ nextUntil: null, records: [] });
    });

    it('count 와 until 을 쿼리로 보낸다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/stocks/005930/short-selling': jsonOk({ nextUntil: null, records: [] }) });

        await makeToss().fetchShortSelling('005930/KRW', 10, { until: '2026-07-14' });

        const query = requestedQuery(fake);
        expect(query.get('count')).toBe('10');
        expect(query.get('until')).toBe('2026-07-14');
    });
});
