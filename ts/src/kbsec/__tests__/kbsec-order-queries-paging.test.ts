/**
 * @fileoverview KB 주문·체결 조회의 연속조회와 날짜 축.
 *
 * - `SSQM2341`(국내)과 `SPQM2103`(해외)은 연속조회 TR 이다. 첫 페이지만 읽으면 2쪽의 주문이 빠지고 `cancelAllOrders` 가 주문을 남긴다.
 * - 해외 체결 조회의 `ordr_dt` 는 미국 현지 날짜다. 되감기 캐시는 시장별이라 해외 조회의 휴장일 되감기가 국내 조회 날짜를 밀어내지 않는다.
 * - 미국 `fetchOrder` 는 체결내역에 없어도 해외 체결현황에 있으면 `OrderNotFound` 가 아니다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { InvalidOrder, OrderNotFound } from '../../base/errors';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

type Body = Record<string, string>;
const envelope = (header: Record<string, unknown>, body: unknown) => {
    const text = JSON.stringify({ dataHeader: header, dataBody: body });
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};
const ok = (body: unknown) => envelope({ processFlag: 'A', processCode: '0011' }, body);
const futureDate = () => envelope({ processFlag: 'B', processCode: '2854', processMessage: '주문일자가 현재일자보다 큽니다' }, {});
const tokenOk = () => ({ ok: true, status: 200, text: async () => '{"access_token":"tok","expires_in":86400}' });

/** TR 코드별 응답 함수를 받아 가짜 서버를 세우고, TR 마다 받은 요청 본문을 모은다. */
function serve(routes: Record<string, (body: Body) => unknown>): Record<string, Body[]> {
    const seen: Record<string, Body[]> = {};
    mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
        if (String(url).includes('/oauth2/token')) return tokenOk();
        const tr = String(url).split('/').pop()!.toUpperCase();
        const body = JSON.parse(init.body).dataBody as Body;
        (seen[tr] ??= []).push(body);
        const route = routes[tr];
        return route === undefined ? ok({}) : route(body);
    });
    return seen;
}

const newExchange = () => new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T01:00:00Z'));   // 수 10:00 KST, 화 21:00 EDT
});

afterEach(() => {
    vi.useRealTimers();
});

describe('국내 주문·체결 조회(SSQM2341)의 연속조회', () => {
    const pending = (ordr_no: string, code: string) => ({ ordr_no, stnd_is_no: code, trd_dl_ccd_nm: '현금매수', ordr_q: '1', tl_ccls_q: '0', nccls_q: '1', ordr_uprc: '70000', ordr_ccd: '00' });

    it('★다음키를 따라 2쪽까지 읽고, 둘째 페이지부터 연속구분(cn_clsf)을 1 로 보낸다', async () => {
        const seen = serve({
            [KBSEC_TR.TRADES_KR]: (b) => b.nxt_key === ''
                ? ok({ nxt_key: 'K2', Record1: [pending('0000000001', 'A000660')] })
                : ok({ nxt_key: '', Record1: [pending('0000000002', 'A005930')] }),
        });

        const open = await newExchange().fetchOpenOrders('005930/KRW');

        expect(open.map((o) => o.id)).toEqual(['0000000002']);
        expect(seen[KBSEC_TR.TRADES_KR]!.map((b) => [b.nxt_key, b.cn_clsf])).toEqual([['', '0'], ['K2', '1']]);
    });

    it('페이지 상한에서 잘리면 일부만 돌려주지 않고 던진다', async () => {
        serve({ [KBSEC_TR.TRADES_KR]: (b) => ok({ nxt_key: `K${Number(b.nxt_key!.slice(1) || 0) + 1}`, Record1: [pending('0000000001', 'A005930')] }) });

        const exchange = new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0, options: { holdingsMaxPages: 2 } });

        await expect(exchange.fetchOpenOrders('005930/KRW')).rejects.toThrow('잘렸다');
    });
});

describe('해외 체결 조회(SPQM2103)의 날짜 축', () => {
    it('★조회일자는 미국 현지 날짜다 — KST 00:30 에도 전날(ET) 날짜를 보낸다', async () => {
        vi.setSystemTime(new Date('2026-09-22T15:30:00Z'));   // 수 00:30 KST, 화 11:30 EDT
        const seen = serve({ [KBSEC_TR.ORDERS_US]: () => ok({ nxt_key: '', Record1: [] }) });

        await newExchange().fetchMyTrades('AAPL/USD');

        expect(seen[KBSEC_TR.ORDERS_US]![0]!.ordr_dt).toBe('20260922');
    });

    it('★해외 조회의 휴장일 되감기가 같은 날 국내 조회 날짜를 밀어내지 않는다(되감기 캐시는 시장별)', async () => {
        vi.setSystemTime(new Date('2026-09-22T15:30:00Z'));   // 수 00:30 KST, 화 11:30 EDT
        const seen = serve({
            [KBSEC_TR.ORDERS_US]: (b) => b.ordr_dt === '20260922' ? futureDate() : ok({ nxt_key: '', Record1: [] }),
            [KBSEC_TR.TRADES_KR]: () => ok({ nxt_key: '', Record1: [] }),
        });
        const exchange = newExchange();

        await exchange.fetchMyTrades('AAPL/USD');
        vi.setSystemTime(new Date('2026-09-23T00:30:00Z'));   // 같은 날 09:30 KST
        await exchange.fetchOpenOrders('005930/KRW');

        expect(seen[KBSEC_TR.ORDERS_US]!.map((b) => b.ordr_dt)).toEqual(['20260922', '20260921']);
        expect(seen[KBSEC_TR.TRADES_KR]!.map((b) => b.ordr_dt)).toEqual(['20260923']);
    });
});

describe('체결 id', () => {
    const filled = (ordr_no: string, price: string) => ({
        ordr_no, stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '1', tl_ccls_q: '1', nccls_q: '0', ccls_uprc: price, ordr_uprc: price, ordr_ccd: '00',
    });

    it('★같은 체결의 id 는 조회 범위에 따라 바뀌지 않는다 — since 로 여러 날을 조회해도 그날만 조회한 것과 같다', async () => {
        serve({
            [KBSEC_TR.TRADES_KR]: (b) => ok({ nxt_key: '', Record1: [b.ordr_dt === '20260922' ? filled('0000000001', '70000') : filled('0000000002', '70100')] }),
        });
        const exchange = newExchange();

        const range = await exchange.fetchMyTrades('005930/KRW', Date.parse('2026-09-22T00:00:00+09:00'));   // 22일(화)과 23일(수)
        const single = await exchange.fetchMyTrades('005930/KRW', undefined, undefined, { date: '20260923' });

        expect(range.map((t) => t.id)).toEqual(['0000000001#0', '0000000002#0']);
        expect(single.map((t) => t.id)).toEqual(['0000000002#0']);
    });
});

describe('주문 경로', () => {
    it('미국 주문도 1주 미만이면 0주로 보내지 않고 요청 없이 InvalidOrder 다', async () => {
        vi.setSystemTime(new Date('2026-09-23T15:00:00Z'));   // 수 11:00 EDT, 미국 정규장
        const seen = serve({});
        const exchange = new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0, options: { masterData: KIS_MASTER_FIXTURE } });

        await expect(exchange.createOrder('AAPL/USD', 'limit', 'buy', 0.5, 200)).rejects.toBeInstanceOf(InvalidOrder);
        expect(seen[KBSEC_TR.ORDER_US]).toBeUndefined();
    });

    it('★국내 취소는 미체결 목록의 원주문 라우팅(SOR)을 싣는다 — KRX 로 보내면 SOR 주문 취소가 거부될 수 있다', async () => {
        const seen = serve({
            [KBSEC_TR.TRADES_KR]: () => ok({ nxt_key: '', Record1: [{
                ordr_no: '0000000007', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '1', tl_ccls_q: '0', nccls_q: '1',
                ordr_uprc: '70000', ordr_ccd: '00', sor_ordr_ccd: 'S',
            }] }),
            [KBSEC_TR.CANCEL_KR]: () => ok({ ordr_no: '0000000008' }),
        });

        await newExchange().cancelAllOrders('005930/KRW');

        expect(seen[KBSEC_TR.CANCEL_KR]![0]).toMatchObject({ orgn_ordr_no: '0000000007', sor_ordr_ccd: 'S' });
        expect(seen[KBSEC_TR.TRADES_KR]).toHaveLength(1);   // 주문마다 목록을 다시 조회하지 않는다
    });
});

describe('미국 fetchOrder', () => {
    const statusRow = (ordr_no: string, remaining: string) => ({
        ordr_dt: '20260922', ordr_no, shrt_is_cd: 'AAPL', ordr_st_nm: '접수', frgn_ordr_q_p6: '3', frgn_ordr_prc_p6: '200',
        ccls_q_p6: '0', frgn_ccls_prc_p6: '0', nccls_q_p6: remaining, rfsl_rsn: '',
    });

    it('★체결내역에 없어도 해외 체결현황에 남은 수량이 있으면 OrderNotFound 가 아니라 open 이다', async () => {
        serve({
            [KBSEC_TR.ORDERS_US]: () => ok({ nxt_key: '', Record1: [] }),
            [KBSEC_TR.ORDER_STATUS_US]: () => ok({ nxt_key: '', Record1: [statusRow('0000012345', '3')] }),
        });

        const order = await newExchange().fetchOrder('0000012345', 'AAPL/USD');

        expect(order).toMatchObject({ id: '0000012345', status: 'open', amount: 3, filled: 0, remaining: 3 });
    });

    it('체결현황에서 남은 수량 없이 체결도 없으면 canceled 다', async () => {
        serve({
            [KBSEC_TR.ORDERS_US]: () => ok({ nxt_key: '', Record1: [] }),
            [KBSEC_TR.ORDER_STATUS_US]: () => ok({ nxt_key: '', Record1: [statusRow('0000012345', '0')] }),
        });

        expect((await newExchange().fetchOrder('0000012345', 'AAPL/USD')).status).toBe('canceled');
    });

    it('체결내역과 체결현황 어디에도 없을 때만 OrderNotFound 다', async () => {
        serve({
            [KBSEC_TR.ORDERS_US]: () => ok({ nxt_key: '', Record1: [] }),
            [KBSEC_TR.ORDER_STATUS_US]: () => ok({ nxt_key: '', Record1: [statusRow('0000099999', '3')] }),
        });

        await expect(newExchange().fetchOrder('0000012345', 'AAPL/USD')).rejects.toBeInstanceOf(OrderNotFound);
    });
});
