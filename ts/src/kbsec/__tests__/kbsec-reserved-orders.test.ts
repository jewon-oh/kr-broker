/**
 * @fileoverview 예약주문 — `createReservedOrder`(`SSAM0831`·`SPAO2104`), `cancelReservedOrder`(`SPAO2106`),
 * `fetchReservedOrderResults`(`SSQM0831`), `fetchReservedOrders`(`SSQM0834`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { InvalidOrder, NotSupported } from '../../base/errors';
import { isKBSecOrderTr, KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('예약주문 TR 은 주문 TR 로 분류된다', () => {
    it('접수와 취소 TR 은 재시도하지 않는 주문 TR 이고, 조회 TR 은 아니다', () => {
        expect(isKBSecOrderTr(KBSEC_TR.RESERVED_ORDER_KR)).toBe(true);
        expect(isKBSecOrderTr(KBSEC_TR.RESERVED_ORDER_US)).toBe(true);
        expect(isKBSecOrderTr(KBSEC_TR.RESERVED_CANCEL_US)).toBe(true);
        expect(isKBSecOrderTr(KBSEC_TR.RESERVED_RESULTS_KR)).toBe(false);
        expect(isKBSecOrderTr(KBSEC_TR.RESERVED_ORDERS_KR)).toBe(false);
    });
});

describe('createReservedOrder', () => {
    it('국내 지정가 매수는 SSAM0831 에 매수(2), 지정가(00), 현금(00)으로 보내고 수량을 내림한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.RESERVED_ORDER_KR]: { ordr_no: '0000123', inpt_vl: '' } });

        const r = await newExchange().createReservedOrder('005930/KRW', 'limit', 'buy', 3.9, 70000);

        expect(trBody(mockFetch, KBSEC_TR.RESERVED_ORDER_KR).dataBody).toEqual({
            ordr_jb_clsf: '2', is_cd: '005930', ordr_uprc: '70000', ordr_q: '3', ordr_ccd: '00', crdt_typ_cd: '00',
            ln_dt: '', cncl_ordr_no: '', tv_rv_ccd: '', strt_dt: '', end_dt: '', mkt_tm_ccd: '',
        });
        expect(r).toMatchObject({ id: '0000123', symbol: '005930/KRW', side: 'buy', type: 'limit', amount: 3, price: 70000 });
    });

    it('국내 시장가 매도는 매도(1), 시장가(03)이고 주문단가를 비운다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.RESERVED_ORDER_KR]: { ordr_no: '0000124' } });

        const r = await newExchange().createReservedOrder('005930/KRW', 'market', 'sell', 2);

        expect(trBody(mockFetch, KBSEC_TR.RESERVED_ORDER_KR).dataBody).toMatchObject({ ordr_jb_clsf: '1', ordr_uprc: '', ordr_q: '2', ordr_ccd: '03' });
        expect(r).toMatchObject({ type: 'market', price: undefined });
    });

    it('미국 지정가는 SPAO2104 에 매수(02), 지정가(2), 네 자리 가격으로 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.RESERVED_ORDER_US]: { rsrv_ordr_no: 'R77' } });

        const r = await newExchange().createReservedOrder('AAPL/USD', 'limit', 'buy', 1, 230.5);

        expect(trBody(mockFetch, KBSEC_TR.RESERVED_ORDER_US).dataBody).toEqual({
            is_cd: 'AAPL', trd_dl_ccd: '02', ordr_typ_cd: '2', ordr_q: '1', frgn_ordr_prc_p4: '230.5000',
            strt_tm: '', end_tm: '', ovtm_ordr_ccd: '', bskt_ordr_no: '', frgn_stp_prc_p4: '',
        });
        expect(r.id).toBe('R77');
    });

    it('응답에 예약주문번호가 없으면 id 는 undefined 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.RESERVED_ORDER_KR]: { ordr_no: '' } });

        const r = await newExchange().createReservedOrder('005930/KRW', 'limit', 'buy', 1, 70000);

        expect(r.id).toBeUndefined();
    });

    it('미국 시장가, 지원하지 않는 유형, 1주 미만은 보내기 전에 막는다', async () => {
        const ex = newExchange();
        await expect(ex.createReservedOrder('AAPL/USD', 'market', 'buy', 1)).rejects.toBeInstanceOf(NotSupported);
        await expect(ex.createReservedOrder('005930/KRW', 'stop' as 'limit', 'buy', 1, 70000)).rejects.toBeInstanceOf(NotSupported);
        await expect(ex.createReservedOrder('005930/KRW', 'limit', 'buy', 0.5, 70000)).rejects.toBeInstanceOf(InvalidOrder);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('cancelReservedOrder', () => {
    it('미국은 SPAO2106 에 종목코드와 취소주문번호를 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.RESERVED_CANCEL_US]: { ordr_no: 'C9', inpt_vl: '' } });

        const r = await newExchange().cancelReservedOrder('R77', 'AAPL/USD');

        expect(trBody(mockFetch, KBSEC_TR.RESERVED_CANCEL_US).dataBody).toEqual({
            is_cd: 'AAPL', trd_clsf: '', ordr_typ: '', ordr_q: '', frgn_ordr_prc_p4: '', cncl_ordr_no: 'R77',
        });
        expect(r).toMatchObject({ id: 'C9', reservedOrderId: 'R77' });
    });

    it('국내는 취소 TR 이 명세에 없어 NotSupported 다', async () => {
        await expect(newExchange().cancelReservedOrder('1', '005930/KRW')).rejects.toBeInstanceOf(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchReservedOrderResults', () => {
    it('주문일자는 오늘, 구분 입력은 설명된 전체(0)를 보내고 한 줄을 옮긴다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z')); // KST 9/23
        routeTr(mockFetch, {
            [KBSEC_TR.RESERVED_RESULTS_KR]: {
                nxt_key: '',
                Record1: [{
                    sq: '1', is_no: 'A005930', is_nm: '삼성전자', ordr_clsf_nm: '매수', ordr_ccd: '00', ordr_q: '3', ordr_uprc: '70000',
                    ordr_no: '5001', ordr_f_nm: '주문', msg: '정상처리', ordr_dt: '20260923',
                }],
            },
        });

        const { rows } = await newExchange().fetchReservedOrderResults();

        expect(trBody(mockFetch, KBSEC_TR.RESERVED_RESULTS_KR).dataBody).toEqual({
            ordr_dt: '20260923', nxt_key: '', trd_clsf: '0', hndl_clsf: '0', tv_rv_ccd: '0', end_dt: '', is_cd: '',
        });
        expect(rows).toMatchObject([{
            date: '20260923', sequence: '1', symbol: '005930/KRW', sideName: '매수', orderTypeCode: '00', quantity: 3, price: 70000,
            orderId: '5001', orderedName: '주문', message: '정상처리',
        }]);
    });
});

describe('fetchReservedOrders', () => {
    it('고정값과 전체(3)를 보내고, 방향은 01, 02 만 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.RESERVED_ORDERS_KR]: {
                nxt_key: '',
                Record1: [
                    { sq: '1', is_no: 'A005930', is_nm: '삼성전자', trd_dl_ccd: '02', trd_ccd_nm: '매수', ordr_q: '3', ordr_uprc: '70000',
                        tv_rv_ccd_nm: '일반', cncl_clsf_nm: '', rgst_dt: '20260922', ordr_dt: '20260923' },
                    { sq: '2', is_no: '000660', trd_dl_ccd: '1', trd_ccd_nm: '매도' },
                ],
            },
        });

        const { rows } = await newExchange().fetchReservedOrders();

        expect(trBody(mockFetch, KBSEC_TR.RESERVED_ORDERS_KR).dataBody).toEqual({
            hndl_clsf: '1', nxt_key: '', chc_clsf: '1', inq_clsf: '3', strt_dt: '', end_dt: '', is_cd: '',
        });
        expect(rows.map(r => [r.side, r.sideName])).toEqual([['buy', '매수'], ['unknown', '매도']]);
        expect(rows[0]).toMatchObject({ symbol: '005930/KRW', quantity: 3, price: 70000, reservationTypeName: '일반', registeredDate: '20260922' });
    });
});
