/**
 * @fileoverview `toss.fetchCreditTrades`·`toss.fetchSecuritiesLending`(국내 전용).
 * 신용대주(개인)와 대차거래(기관)는 서로 다른 데이터다.
 */
import { describe, it, expect } from 'vitest';

import { installFakeToss, jsonOk, makeToss, type FakeToss } from './support/toss-fake';

const creditQuery = (fake: FakeToss): URLSearchParams => fake.requestsTo('GET /api/v1/stocks/005930/credit-trades')[0]!.query;
const lendingQuery = (fake: FakeToss): URLSearchParams => fake.requestsTo('GET /api/v1/stocks/005930/securities-lending')[0]!.query;

describe('fetchCreditTrades', () => {
    it('기록과 다음 페이지 커서를 그대로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/stocks/005930/credit-trades': jsonOk({
                nextUntil: '2026-07-14',
                records: [{
                    date: '2026-07-16',
                    updatedAt: '2026-07-17T02:35:00+09:00',
                    marginLoan: { newQuantity: '125300', returnQuantity: '98200', balanceQuantity: '2513400', balanceRate: '0.0042', tradingRate: '0.09' },
                    stockLoan: { newQuantity: '5200', returnQuantity: '3100', balanceQuantity: '45200', balanceRate: '0.0001', tradingRate: '0.0004' },
                }],
            }),
        });

        const result = await makeToss().fetchCreditTrades('005930/KRW');

        expect(result.nextUntil).toBe('2026-07-14');
        expect(result.records[0]!.marginLoan).toMatchObject({ balanceQuantity: '2513400' });
        expect(creditQuery(fake).get('count')).toBe('5');
    });

    it('한쪽 데이터만 있으면 없는 쪽은 null이다', async () => {
        installFakeToss({
            'GET /api/v1/stocks/005930/credit-trades': jsonOk({
                nextUntil: null,
                records: [{ date: '2026-07-16', updatedAt: '2026-07-17T02:35:00+09:00', marginLoan: null, stockLoan: { newQuantity: '5200', returnQuantity: '3100', balanceQuantity: '45200', balanceRate: '0.0001', tradingRate: '0.0004' } }],
            }),
        });

        const result = await makeToss().fetchCreditTrades('005930/KRW');

        expect(result.records[0]!.marginLoan).toBeNull();
        expect(result.records[0]!.stockLoan).not.toBeNull();
    });

    it('데이터가 없으면 빈 배열과 null 커서를 돌려준다', async () => {
        installFakeToss({ 'GET /api/v1/stocks/005930/credit-trades': jsonOk({ nextUntil: null, records: [] }) });

        expect(await makeToss().fetchCreditTrades('005930/KRW')).toEqual({ nextUntil: null, records: [] });
    });

    it('count 와 until 을 쿼리로 보낸다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/stocks/005930/credit-trades': jsonOk({ nextUntil: null, records: [] }) });

        await makeToss().fetchCreditTrades('005930/KRW', 10, { until: '2026-07-14' });

        expect(creditQuery(fake).get('count')).toBe('10');
        expect(creditQuery(fake).get('until')).toBe('2026-07-14');
    });
});

describe('fetchSecuritiesLending', () => {
    it('기록과 다음 페이지 커서를 그대로 옮긴다', async () => {
        const fake = installFakeToss({
            'GET /api/v1/stocks/005930/securities-lending': jsonOk({
                nextUntil: '2026-07-15',
                records: [{ date: '2026-07-17', updatedAt: '2026-07-17T19:03:21+09:00', executionQuantity: '210500', repaymentQuantity: '185300', balanceQuantity: '15234000', balanceAmount: '1218720000000' }],
            }),
        });

        const result = await makeToss().fetchSecuritiesLending('005930/KRW');

        expect(result.nextUntil).toBe('2026-07-15');
        expect(result.records[0]).toMatchObject({ date: '2026-07-17', balanceAmount: '1218720000000' });
        expect(lendingQuery(fake).get('count')).toBe('5');
    });

    it('데이터가 없으면 빈 배열과 null 커서를 돌려준다', async () => {
        installFakeToss({ 'GET /api/v1/stocks/005930/securities-lending': jsonOk({ nextUntil: null, records: [] }) });

        expect(await makeToss().fetchSecuritiesLending('005930/KRW')).toEqual({ nextUntil: null, records: [] });
    });

    it('count 와 until 을 쿼리로 보낸다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/stocks/005930/securities-lending': jsonOk({ nextUntil: null, records: [] }) });

        await makeToss().fetchSecuritiesLending('005930/KRW', 10, { until: '2026-07-15' });

        expect(lendingQuery(fake).get('count')).toBe('10');
        expect(lendingQuery(fake).get('until')).toBe('2026-07-15');
    });
});
