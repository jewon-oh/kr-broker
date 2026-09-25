/**
 * @fileoverview `toss.fetchSellableQuantity` — `GET /sellable-quantity`. 보유 수량에서 미체결 매도 주문·미결제분 등 지금 못 파는 수량을 뺀 값이다.
 * `fetchBalance({ symbol })` 가 이 값을 그 종목의 `free` 로 쓴다.
 */
import { describe, it, expect } from 'vitest';

import { BadResponse } from '../../base';
import { installFakeToss, jsonOk, makeToss, type FakeToss } from './support/toss-fake';

const requestedQuery = (fake: FakeToss): URLSearchParams => fake.requestsTo('GET /api/v1/sellable-quantity')[0]!.query;

describe('fetchSellableQuantity', () => {
    it('국내 — 정수 수량을 숫자로 돌려준다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/sellable-quantity': jsonOk({ sellableQuantity: '100' }) });

        const quantity = await makeToss().fetchSellableQuantity('005930/KRW');

        expect(quantity).toBe(100);
        expect(requestedQuery(fake).get('symbol')).toBe('005930');
    });

    it('해외 — 소수점 수량도 그대로 옮긴다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/sellable-quantity': jsonOk({ sellableQuantity: '5.5' }) });

        const quantity = await makeToss().fetchSellableQuantity('AAPL/USD');

        expect(quantity).toBe(5.5);
        expect(requestedQuery(fake).get('symbol')).toBe('AAPL');
    });

    it('응답을 숫자로 못 읽으면 0 이 아니라 모르는 것이라 BadResponse 로 던진다', async () => {
        installFakeToss({ 'GET /api/v1/sellable-quantity': jsonOk({}) });

        await expect(makeToss().fetchSellableQuantity('005930/KRW')).rejects.toBeInstanceOf(BadResponse);
    });
});
