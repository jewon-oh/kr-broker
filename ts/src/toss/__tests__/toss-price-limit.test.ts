/**
 * @fileoverview `toss.fetchPriceLimit` — `GET /price-limits`. 당일 상·하한가 원본이다.
 * 해외는 가격 제한이 없어 두 값 모두 `null`이다.
 */
import { describe, it, expect } from 'vitest';

import { installFakeToss, jsonOk, makeToss, type FakeToss } from './support/toss-fake';

const requestedQuery = (fake: FakeToss): URLSearchParams => fake.requestsTo('GET /api/v1/price-limits')[0]!.query;

describe('fetchPriceLimit', () => {
    it('국내 — 상·하한가를 원본 그대로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/price-limits': jsonOk({
                timestamp: '2026-03-25T09:30:00.123+09:00',
                upperLimitPrice: '93000',
                lowerLimitPrice: '50400',
                currency: 'KRW',
            }),
        });

        const limit = await makeToss().fetchPriceLimit('005930/KRW');

        expect(limit).toEqual({ timestamp: '2026-03-25T09:30:00.123+09:00', upperLimitPrice: '93000', lowerLimitPrice: '50400', currency: 'KRW' });
        expect(requestedQuery(fake).get('symbol')).toBe('005930');
    });

    it('해외 — 가격 제한이 없어 두 값 모두 null이다', async () => {
        installFakeToss({
            'GET /api/v1/price-limits': jsonOk({
                timestamp: '2026-03-25T22:30:00.456+09:00',
                upperLimitPrice: null,
                lowerLimitPrice: null,
                currency: 'USD',
            }),
        });

        const limit = await makeToss().fetchPriceLimit('AAPL/USD');

        expect(limit.upperLimitPrice).toBeNull();
        expect(limit.lowerLimitPrice).toBeNull();
    });
});
