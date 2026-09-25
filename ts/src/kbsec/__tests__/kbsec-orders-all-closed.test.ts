/**
 * @fileoverview `kbsec.fetchOrders`·`fetchClosedOrders` — 계좌별주문체결조회(`SSQM2341`)를 체결구분만 바꿔 재사용한다.
 * `fetchOpenOrders`(미체결)와 같은 TR, 같은 파싱(`parseOrder`)이다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { NotSupported } from '../../base/errors';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

const ROWS = {
    Record1: [
        { ordr_no: 'O1', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '10', nccls_q: '0', tl_ccls_q: '10', ccls_uprc: '70000', ordr_uprc: '70000', ordr_ccd: '00' },
        { ordr_no: 'O2', stnd_is_no: 'KR7000660001', trd_dl_ccd_nm: '현금매도', ordr_q: '4', nccls_q: '3', tl_ccls_q: '1', ccls_uprc: '120000', ordr_uprc: '121000', ordr_ccd: '00' },
    ],
};

describe('fetchOrders', () => {
    it('체결구분 전체(0)로 SSQM2341을 부르고, 체결·미체결을 함께 Order 로 정리한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: ROWS });

        const orders = await newExchange().fetchOrders();

        expect(trBody(mockFetch, KBSEC_TR.TRADES_KR).dataBody).toMatchObject({ ccls_clsf: '0', inq_clsf: '1' });
        expect(orders.map(o => [o.id, o.status])).toEqual([['O1', 'closed'], ['O2', 'open']]);
    });

    it('symbol 로 거른다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: ROWS });

        const orders = await newExchange().fetchOrders('005930/KRW');

        expect(orders.map(o => o.id)).toEqual(['O1']);
    });

    it('params.date 를 주면 영업일 되감기 없이 그 날짜로 바로 조회한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: ROWS });

        await newExchange().fetchOrders(undefined, undefined, undefined, { date: '20260101' });

        expect(trBody(mockFetch, KBSEC_TR.TRADES_KR).dataBody).toMatchObject({ ordr_dt: '20260101' });
    });

    it('해외는 NotSupported', async () => {
        await expect(newExchange().fetchOrders('AAPL/USD')).rejects.toThrow(NotSupported);
    });
});

describe('fetchClosedOrders', () => {
    it('★체결구분 전체(0)로 SSQM2341을 부르고, 종료된 주문만 돌려준다 — 아직 남은 O2 는 open 이라 빠진다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: ROWS });

        const orders = await newExchange().fetchClosedOrders();

        expect(trBody(mockFetch, KBSEC_TR.TRADES_KR).dataBody).toMatchObject({ ccls_clsf: '0', inq_clsf: '1' });
        expect(orders.map(o => [o.id, o.status])).toEqual([['O1', 'closed']]);
    });

    it('★분할체결 연속 행은 앞 주문에 더하고, 남은 수량 없이 덜 체결된 주문은 canceled 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: { Record1: [
            { ordr_no: 'O3', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '4', nccls_q: '0', tl_ccls_q: '1', ccls_uprc: '70000', ordr_uprc: '70000', ordr_ccd: '00' },
            { ordr_no: '0000000000', stnd_is_no: '', trd_dl_ccd_nm: '', ordr_q: '0', nccls_q: '0', tl_ccls_q: '3', ccls_uprc: '70000' },
            { ordr_no: 'O4', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '5', nccls_q: '0', tl_ccls_q: '2', ccls_uprc: '70000', ordr_uprc: '70000', ordr_ccd: '00' },
        ] } });

        const orders = await newExchange().fetchClosedOrders();

        expect(orders.map(o => [o.id, o.status, o.filled, o.remaining])).toEqual([['O3', 'closed', 4, 0], ['O4', 'canceled', 2, 0]]);
    });

    it('해외는 NotSupported', async () => {
        await expect(newExchange().fetchClosedOrders('AAPL/USD')).rejects.toThrow(NotSupported);
    });
});
