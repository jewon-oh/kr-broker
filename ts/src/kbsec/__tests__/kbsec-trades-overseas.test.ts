/**
 * @fileoverview `kbsec.fetchTrades` 해외 분기 — 시간대별체결(`GSA10020`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

const US_QUOTE = { now_prc_p4: '100.0000' };

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchTrades — 해외', () => {
    it('체결구분(ccls_clsf)으로 side 를 채우고, 한국시각(kor_dt·kor_tm)으로 timestamp 를 만든다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.QUOTE_US]: US_QUOTE,
            [KBSEC_TR.TRADES_TIMELINE_US]: {
                Record1: [
                    { kor_dt: '20260923', kor_tm: '223015', now_prc_p4: '150.25', ccls_q: '10', ccls_clsf: '1' },
                    { kor_dt: '20260923', kor_tm: '223020', now_prc_p4: '150.30', ccls_q: '5', ccls_clsf: '2' },
                ],
            },
        });

        const trades = await newExchange().fetchTrades('AAPL/USD');

        expect(trBody(mockFetch, KBSEC_TR.TRADES_TIMELINE_US).dataBody).toMatchObject({ is_cd: 'AAPL' });
        expect(trades).toMatchObject([
            { symbol: 'AAPL/USD', price: 150.25, amount: 10, side: 'buy' },
            { symbol: 'AAPL/USD', price: 150.3, amount: 5, side: 'sell' },
        ]);
        expect(trades[0].timestamp).toBeTypeOf('number');
    });

    it('거래소코드 캐시를 fetchTicker 와 공유한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.QUOTE_US]: (body: Record<string, unknown>) => (body.krx_cd === 'NYS' ? US_QUOTE : {}),
            [KBSEC_TR.TRADES_TIMELINE_US]: { Record1: [] },
        });
        const exchange = newExchange();

        await exchange.fetchTicker('XOM/USD');
        await exchange.fetchTrades('XOM/USD');

        expect(trBody(mockFetch, KBSEC_TR.TRADES_TIMELINE_US).dataBody).toMatchObject({ krx_cd: 'NYS' });
    });

    it('ccls_clsf 값이 없으면 side 는 undefined 다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.QUOTE_US]: US_QUOTE,
            [KBSEC_TR.TRADES_TIMELINE_US]: { Record1: [{ kor_dt: '20260923', kor_tm: '223015', now_prc_p4: '150.25', ccls_q: '10' }] },
        });

        const [trade] = await newExchange().fetchTrades('AAPL/USD');

        expect(trade.side).toBeUndefined();
    });
});
