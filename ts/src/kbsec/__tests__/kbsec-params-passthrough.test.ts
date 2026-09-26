/**
 * @fileoverview `params` 를 요청 입력에 합치는지 본다. ccxt 에서 `params` 는 호출하는 쪽이 원문 입력을 덮어쓰는 통로라, 받기만 하고 버리면 안 된다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('params 를 요청에 합친다', () => {
    it('fetchTicker 국내와 해외', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.QUOTE_KR]: { now_prc: '70000' },
            [KBSEC_TR.QUOTE_US]: { now_prc_p4: '100.0000' },
        });
        const ex = newExchange();

        await ex.fetchTicker('005930/KRW', { excg_clsf: '2' });
        await ex.fetchTicker('AAPL/USD', { extra: 'x' });

        expect(trBody(mockFetch, KBSEC_TR.QUOTE_KR).dataBody).toEqual({ excg_clsf: '2', shrt_cd: '005930' });
        expect(trBody(mockFetch, KBSEC_TR.QUOTE_US).dataBody).toMatchObject({ is_cd: 'AAPL', extra: 'x' });
    });

    it('fetchOrderBook', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDERBOOK_KR]: { b1_aprc: '69900', b_pstn_b1_aprc_q: '10' } });

        await newExchange().fetchOrderBook('005930/KRW', undefined, { ovtm_mkt_clsf: '2' });

        expect(trBody(mockFetch, KBSEC_TR.ORDERBOOK_KR).dataBody).toEqual({ is_cd: '005930', ovtm_mkt_clsf: '2' });
    });

    it('fetchBalance 는 기준이 되는 예수금 조회에 합친다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.DEPOSIT]: { ordr_psbl_csh: '1000' } });

        await newExchange().fetchBalance({ extra: 'x' });

        expect(trBody(mockFetch, KBSEC_TR.DEPOSIT).dataBody).toMatchObject({ extra: 'x' });
    });

    it('fetchBuyableAmount', async () => {
        routeTr(mockFetch, { [KBSEC_TR.BUYABLE_KR]: { ordr_psbl_csh: '1000' } });

        await newExchange().fetchBuyableAmount('005930/KRW', { bnd_mktio_ccd: '2' });

        expect(trBody(mockFetch, KBSEC_TR.BUYABLE_KR).dataBody).toMatchObject({ is_no: '005930', bnd_mktio_ccd: '2' });
    });

    it('cancelOrder 국내와 해외', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CANCEL_KR]: { ordr_no: 'C1' }, [KBSEC_TR.AMEND_CANCEL_US]: { ordr_no: 'C2' } });
        const ex = newExchange();

        await ex.cancelOrder('O1', '005930/KRW', { extra: 'x' });
        await ex.cancelOrder('O2', 'AAPL/USD', { extra: 'y' });

        expect(trBody(mockFetch, KBSEC_TR.CANCEL_KR).dataBody).toMatchObject({ crct_clsf: '2', orgn_ordr_no: 'O1', extra: 'x' });
        expect(trBody(mockFetch, KBSEC_TR.AMEND_CANCEL_US).dataBody).toMatchObject({ crct_cncl_clsf: '2', orgn_ordr_no: 'O2', extra: 'y' });
    });

    it('fetchOpenOrders', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: {} });

        await newExchange().fetchOpenOrders(undefined, undefined, undefined, { extra: 'x' });

        expect(trBody(mockFetch, KBSEC_TR.TRADES_KR).dataBody).toMatchObject({ extra: 'x' });
    });

    it('fetchMarketCalendar', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: { std_bsnss_dt: '20260923' } });

        await newExchange().fetchMarketCalendar({ extra: 'x' });

        expect(trBody(mockFetch, KBSEC_TR.MARKET_STATUS).dataBody).toMatchObject({ extra: 'x' });
    });
});
