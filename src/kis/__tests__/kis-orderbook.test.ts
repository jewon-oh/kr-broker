/**
 * `kis.fetchOrderBook` — 국내 호가(FHKST01010200) 파싱 회귀.
 * askp1/bidp1 이 최우선(best) 호가라 매수는 높은 가격부터, 매도는 낮은 가격부터 정렬되어야 한다.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

global.fetch = mockFetch as unknown as typeof fetch;

import { NotSupported, NullResponse } from '../../base/errors';
import { dataOk, newKis, tokenOk } from './support/kis-test-utils';

beforeEach(() => {
    mockFetch.mockReset();
});

describe('fetchOrderBook — 국내', () => {
    it('askp/bidp 10단계를 best-first 로 파싱한다 (잔량 포함)', async () => {
        const output1 = {
            askp1: '79000', askp2: '79100', askp3: '79200',
            askp_rsqn1: '100', askp_rsqn2: '200', askp_rsqn3: '300',
            bidp1: '78900', bidp2: '78800', bidp3: '78700',
            bidp_rsqn1: '150', bidp_rsqn2: '250', bidp_rsqn3: '350',
        };
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1 }));

        const book = await newKis().fetchOrderBook('005930/KRW');

        expect(book.symbol).toBe('005930/KRW');
        expect(book.asks).toEqual([[79000, 100], [79100, 200], [79200, 300]]); // 최저 매도가 먼저
        expect(book.bids).toEqual([[78900, 150], [78800, 250], [78700, 350]]); // 최고 매수가 먼저
        expect(book.timestamp).toBeGreaterThan(0);
    });

    it('bare 6자리 코드도 처리한다 (005930)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: { askp1: '100', askp_rsqn1: '5', bidp1: '99', bidp_rsqn1: '7' } }));

        const book = await newKis().fetchOrderBook('005930');

        expect(book.asks).toEqual([[100, 5]]);
        expect(book.bids).toEqual([[99, 7]]);
    });

    it('limit 으로 단계를 자른다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { askp1: '100', askp2: '101', bidp1: '99', bidp2: '98', askp_rsqn1: '1', askp_rsqn2: '1', bidp_rsqn1: '1', bidp_rsqn2: '1' },
        }));

        const book = await newKis().fetchOrderBook('005930', 1);

        expect(book.asks).toEqual([[100, 1]]);
        expect(book.bids).toEqual([[99, 1]]);
    });

    it('호가가 하나도 없으면 NullResponse 다 (빈 호가를 정상으로 넘기지 않는다)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: {} }));

        await expect(newKis().fetchOrderBook('005930')).rejects.toThrow(NullResponse);
    });

    it('해외 심볼은 NotSupported 이고 호출하지 않는다', async () => {
        await expect(newKis().fetchOrderBook('AAPL')).rejects.toThrow(NotSupported);

        expect(mockFetch).not.toHaveBeenCalled();
    });
});
