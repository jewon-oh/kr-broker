/**
 * @fileoverview `kis` 의 ccxt pro 메서드(`watchTicker`, `watchTrades`, `watchOrderBook`, `watchOrders`, `close`).
 * 실제 웹소켓을 열지 않도록 `createRealtimeStream` 을 가짜로 바꾸고, 받은 콜백에 레코드를 직접 넣는다.
 */
import { describe, it, expect, vi } from 'vitest';

import { ArgumentsRequired, ExchangeClosedByUser, ExchangeError } from '../../base/errors';
import type { KisRealtimeRecord } from '../kis-realtime-stream';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { newKis } from './support/kis-test-utils';

type OnRecord = (record: KisRealtimeRecord) => void;
type OnError = (trId: string, trKey: string, message: string) => void;

/** 가짜 스트림을 끼운 인스턴스. `emit` 으로 레코드를, `fail` 로 구독 거부를 흉내 낸다. */
function withFakeStream(options: Record<string, unknown> = {}) {
    const ex = newKis({ masterData: KIS_MASTER_FIXTURE, options });
    const stream = { subscribe: vi.fn(), stop: vi.fn() };
    let onRecord: OnRecord = () => undefined;
    let onError: OnError = () => undefined;
    vi.spyOn(ex, 'createRealtimeStream').mockImplementation(((record: OnRecord, error: OnError) => {
        onRecord = record;
        onError = error;
        return stream;
    }) as never);
    const emit = (trId: string, fields: Record<string, string>): void => onRecord({ trId, values: Object.values(fields), fields });
    const fail = (trId: string, trKey: string, message: string): void => onError(trId, trKey, message);
    return { ex, stream, emit, fail };
}

/** 구독이 걸릴 때까지 마이크로태스크를 돌린다. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DOMESTIC_TRADE = {
    mksc_shrn_iscd: '005930', stck_cntg_hour: '093001', stck_prpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', wghn_avrg_stck_prc: '70800',
    stck_oprc: '70500', stck_hgpr: '71200', stck_lwpr: '70400', askp1: '71100', bidp1: '71000', cntg_vol: '15', acml_vol: '1200000',
    acml_tr_pbmn: '85000000000', ccld_dvsn: '1', bsop_date: '20260922', askp_rsqn1: '300', bidp_rsqn1: '500',
};

describe('watchTicker, watchTrades', () => {
    it('국내 종목은 KRX 체결 TR(H0STCNT0)을 구독하고, 체결 레코드로 시세를 채운다', async () => {
        const { ex, stream, emit } = withFakeStream();

        const pending = ex.watchTicker('005930/KRW');
        await flush();
        emit('H0STCNT0', DOMESTIC_TRADE);
        const ticker = await pending;

        expect(stream.subscribe).toHaveBeenCalledWith('H0STCNT0', '005930');
        expect(ticker).toMatchObject({
            symbol: '005930/KRW', timestamp: Date.parse('2026-09-22T00:30:01Z'), last: 71000, open: 70500, high: 71200, low: 70400,
            bid: 71000, ask: 71100, bidVolume: 500, askVolume: 300, change: 500, percentage: 0.71, vwap: 70800, baseVolume: 1200000, quoteVolume: 85000000000,
        });
    });

    it('체결은 기다리는 쪽이 없을 때 쌓아 두었다가 다음 호출에 한꺼번에 돌려준다. 체결구분 1 은 매수, 5 는 매도다', async () => {
        const { ex, emit } = withFakeStream();
        const first = ex.watchTrades('005930/KRW');
        await flush();
        emit('H0STCNT0', DOMESTIC_TRADE);
        await first;

        emit('H0STCNT0', { ...DOMESTIC_TRADE, stck_cntg_hour: '093002', cntg_vol: '3', ccld_dvsn: '5' });
        emit('H0STCNT0', { ...DOMESTIC_TRADE, stck_cntg_hour: '093003', cntg_vol: '4', ccld_dvsn: '1' });
        const trades = await ex.watchTrades('005930/KRW');

        expect(trades.map((t) => [t.amount, t.side])).toEqual([[3, 'sell'], [4, 'buy']]);
        expect(trades[0]).toMatchObject({ symbol: '005930/KRW', price: 71000, timestamp: Date.parse('2026-09-22T00:30:02Z') });
    });

    it('해외 종목은 지연체결가(HDFSCNT0)를 D+거래소+티커로 구독하고, 한국 일시로 시각을 채운다', async () => {
        const { ex, stream, emit } = withFakeStream();

        const pending = ex.watchTicker('AAPL/USD');
        await flush();
        emit('HDFSCNT0', {
            rsym: 'DNASAAPL', symb: 'AAPL', kymd: '20260924', khms: '223000', open: '227', high: '229', low: '226', last: '228.5', diff: '1.5', rate: '0.66',
            pbid: '228.4', pask: '228.6', vbid: '100', vask: '200', evol: '10', tvol: '5000000', tamt: '1140000000',
        });

        expect(stream.subscribe).toHaveBeenCalledWith('HDFSCNT0', 'DNASAAPL');
        expect(await pending).toMatchObject({
            symbol: 'AAPL/USD', timestamp: Date.parse('2026-09-24T13:30:00Z'), last: 228.5, change: 1.5, percentage: 0.66, bid: 228.4, ask: 228.6, baseVolume: 5000000,
        });
    });
});

describe('watchOrderBook', () => {
    it('국내 호가 TR(H0STASP0)의 10단계를 매수는 높은 가격순, 매도는 낮은 가격순으로 정리하고 limit 로 자른다', async () => {
        const { ex, stream, emit } = withFakeStream();
        const fields: Record<string, string> = { mksc_shrn_iscd: '005930', bsop_hour: '093001' };
        for (let i = 1; i <= 10; i++) {
            fields[`askp${i}`] = String(71000 + i * 100);
            fields[`bidp${i}`] = String(71000 - (i - 1) * 100);
            fields[`askp_rsqn${i}`] = String(i);
            fields[`bidp_rsqn${i}`] = String(i * 2);
        }

        const pending = ex.watchOrderBook('005930/KRW', 2);
        await flush();
        emit('H0STASP0', fields);
        const book = await pending;

        expect(stream.subscribe).toHaveBeenCalledWith('H0STASP0', '005930');
        expect(book.bids).toEqual([[71000, 2], [70900, 4]]);
        expect(book.asks).toEqual([[71100, 1], [71200, 2]]);
        expect(book.symbol).toBe('005930/KRW');
    });
});

describe('watchOrders', () => {
    it('HTS ID 가 없으면 구독하기 전에 ArgumentsRequired 다', async () => {
        const { ex, stream } = withFakeStream();
        await expect(ex.watchOrders()).rejects.toThrow(ArgumentsRequired);
        expect(stream.subscribe).not.toHaveBeenCalled();
    });

    it('국내와 해외 체결통보를 HTS ID 로 구독하고(모의는 …9), 체결 통보마다 누적 체결 수량과 상태를 갱신한다', async () => {
        const { ex, stream, emit } = withFakeStream({ htsId: 'MYHTS' });
        const notice = { oder_no: '0000117057', seln_byov_cls: '02', stck_shrn_iscd: '005930', oder_qty: '10', oder_prc: '71000', stck_cntg_hour: '093001', rfus_yn: 'N' };

        const receipt = ex.watchOrders();
        await flush();
        emit('H0STCNI9', { ...notice, cntg_yn: '1', cntg_qty: '0' });
        const [accepted] = await receipt;
        emit('H0STCNI9', { ...notice, cntg_yn: '2', cntg_qty: '3', cntg_unpr: '71000' });
        emit('H0STCNI9', { ...notice, cntg_yn: '2', cntg_qty: '7', cntg_unpr: '71000' });
        const fills = await ex.watchOrders();

        expect(stream.subscribe).toHaveBeenCalledWith('H0STCNI9', 'MYHTS');
        expect(stream.subscribe).toHaveBeenCalledWith('H0GSCNI9', 'MYHTS');
        expect(accepted).toMatchObject({ id: '0000117057', symbol: '005930/KRW', side: 'buy', amount: 10, filled: 0, status: 'open', price: 71000 });
        expect(fills.map((o) => [o.filled, o.status])).toEqual([[3, 'open'], [10, 'closed']]);
    });

    it('거부는 rejected, 취소 통보(정정구분 2)는 canceled 다', async () => {
        const { ex, emit } = withFakeStream({ htsId: 'MYHTS' });
        const base = { seln_byov_cls: '01', stck_shrn_iscd: '005930', oder_qty: '5', stck_cntg_hour: '093001', cntg_yn: '1', cntg_qty: '0' };

        const pending = ex.watchOrders('005930/KRW');
        await flush();
        emit('H0STCNI9', { ...base, oder_no: 'A1', rfus_yn: '1', rctf_cls: '0' });
        emit('H0STCNI9', { ...base, oder_no: 'A2', rfus_yn: 'N', rctf_cls: '2' });
        const first = await pending;
        const rest = await ex.watchOrders('005930/KRW');

        expect([...first, ...rest].map((o) => [o.id, o.side, o.status])).toEqual([['A1', 'sell', 'rejected'], ['A2', 'sell', 'canceled']]);
    });
});

describe('close, 구독 거부', () => {
    it('close 는 스트림을 멈추고 기다리던 watch 를 거절한다', async () => {
        const { ex, stream } = withFakeStream();
        const pending = ex.watchTicker('005930/KRW');
        await flush();

        await ex.close();

        // ★ccxt 처럼 ExchangeClosedByUser(ExchangeError 하위)로 끝낸다.
        await expect(pending).rejects.toBeInstanceOf(ExchangeClosedByUser);
        await expect(pending).rejects.toThrow(ExchangeError);
        expect(stream.stop).toHaveBeenCalled();
    });

    it('구독이 거부되면 그 종목을 기다리던 watch 를 거절한다', async () => {
        const { ex, fail } = withFakeStream();
        const pending = ex.watchTicker('005930/KRW');
        await flush();

        fail('H0STCNT0', '005930', 'ALREADY IN USE appkey');

        await expect(pending).rejects.toThrow('ALREADY IN USE appkey');
    });
});

describe('params.signal', () => {
    it('신호가 오면 기다리던 watchTicker·watchOrderBook 을 AbortError 로 거절한다', async () => {
        const { ex } = withFakeStream();
        const controller = new AbortController();
        const ticker = ex.watchTicker('005930/KRW', { signal: controller.signal });
        const book = ex.watchOrderBook('005930/KRW', undefined, { signal: controller.signal });
        await flush();

        controller.abort();

        await expect(ticker).rejects.toMatchObject({ name: 'AbortError' });
        await expect(book).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('포기한 watchTrades·watchOrders 는 체결과 주문을 가져가지 않는다. 다음 호출이 받는다', async () => {
        const { ex, emit } = withFakeStream({ htsId: 'MYHTS' });
        const controller = new AbortController();
        const trades = ex.watchTrades('005930/KRW', undefined, undefined, { signal: controller.signal });
        const orders = ex.watchOrders(undefined, undefined, undefined, { signal: controller.signal });
        await flush();
        controller.abort();
        await expect(trades).rejects.toMatchObject({ name: 'AbortError' });
        await expect(orders).rejects.toMatchObject({ name: 'AbortError' });

        emit('H0STCNT0', DOMESTIC_TRADE);
        emit('H0STCNI9', {
            oder_no: '0000117057', seln_byov_cls: '02', stck_shrn_iscd: '005930', oder_qty: '10', oder_prc: '71000', stck_cntg_hour: '093001', rfus_yn: 'N',
            cntg_yn: '1', cntg_qty: '0',
        });

        expect((await ex.watchTrades('005930/KRW')).map((t) => t.amount)).toEqual([15]);
        expect((await ex.watchOrders()).map((o) => o.id)).toEqual(['0000117057']);
    });
});

describe('watchOrders 정정·취소와 체결 금액', () => {
    const accepted = { oder_no: 'A', seln_byov_cls: '02', stck_shrn_iscd: '005930', oder_qty: '10', oder_prc: '71000', stck_cntg_hour: '093001', rfus_yn: '0' };

    it('취소 통보(정정구분 2)는 원주문번호(ooder_no) 주문을 취소 수량만큼 줄여 canceled 로 두고, 취소 주문번호는 쌓지 않는다', async () => {
        const { ex, emit } = withFakeStream({ htsId: 'MYHTS' });
        const first = ex.watchOrders();
        await flush();
        emit('H0STCNI9', { ...accepted, cntg_yn: '1', cntg_qty: '10', rctf_cls: '0' });
        await first;
        emit('H0STCNI9', { ...accepted, cntg_yn: '2', cntg_qty: '3', cntg_unpr: '71000', rctf_cls: '0' });
        emit('H0STCNI9', { ...accepted, oder_no: 'B', ooder_no: 'A', cntg_yn: '1', cntg_qty: '7', oder_qty: '', rctf_cls: '2' });

        const orders = await ex.watchOrders();

        expect(orders.map((o) => [o.id, o.status, o.filled, o.remaining])).toEqual([['A', 'open', 3, 7], ['A', 'canceled', 3, 0]]);
    });

    it('정정 통보(정정구분 1)는 원주문의 잔량을 새 주문번호로 옮긴다. 같은 번호의 통보가 다시 와도 한 번만 줄인다', async () => {
        const { ex, emit } = withFakeStream({ htsId: 'MYHTS' });
        const first = ex.watchOrders('005930/KRW');
        await flush();
        emit('H0STCNI9', { ...accepted, cntg_yn: '1', cntg_qty: '10', rctf_cls: '0' });
        await first;
        const amend = { ...accepted, oder_no: 'C', ooder_no: 'A', cntg_yn: '1', cntg_qty: '4', cntg_unpr: '70500', oder_qty: '', oder_prc: '70500', rctf_cls: '1' };
        emit('H0STCNI9', { ...amend, acpt_yn: '1' });
        emit('H0STCNI9', { ...amend, acpt_yn: '2' });

        const orders = await ex.watchOrders('005930/KRW');

        expect(orders.map((o) => [o.id, o.status, o.amount, o.remaining, o.price])).toEqual([
            ['A', 'open', 10, 6, 71000], ['C', 'open', 4, 4, 70500], ['C', 'open', 4, 4, 70500],
        ]);
    });

    it('원주문 전량을 정정하면 원주문은 canceled 다', async () => {
        const { ex, emit } = withFakeStream({ htsId: 'MYHTS' });
        const first = ex.watchOrders();
        await flush();
        emit('H0STCNI9', { ...accepted, cntg_yn: '1', cntg_qty: '10', rctf_cls: '0' });
        await first;
        emit('H0STCNI9', { ...accepted, oder_no: 'C', ooder_no: 'A', cntg_yn: '1', cntg_qty: '10', oder_qty: '', oder_prc: '70500', rctf_cls: '1' });

        const orders = await ex.watchOrders();

        expect(orders.map((o) => [o.id, o.status])).toEqual([['A', 'canceled'], ['C', 'open']]);
    });

    it('거부된 취소 통보는 원주문을 바꾸지 않는다', async () => {
        const { ex, emit } = withFakeStream({ htsId: 'MYHTS' });
        const first = ex.watchOrders();
        await flush();
        emit('H0STCNI9', { ...accepted, cntg_yn: '1', cntg_qty: '10', rctf_cls: '0' });
        await first;
        emit('H0STCNI9', { ...accepted, oder_no: 'B', ooder_no: 'A', cntg_yn: '1', cntg_qty: '10', rfus_yn: '1', rctf_cls: '2' });

        const orders = await ex.watchOrders();

        expect(orders.map((o) => [o.id, o.status])).toEqual([['B', 'rejected']]);
    });

    it('체결 통보의 체결단가로 cost 와 average 를 쌓는다', async () => {
        const { ex, emit } = withFakeStream({ htsId: 'MYHTS' });
        const first = ex.watchOrders();
        await flush();
        emit('H0STCNI9', { ...accepted, cntg_yn: '2', cntg_qty: '3', cntg_unpr: '71000', rctf_cls: '0' });
        await first;
        emit('H0STCNI9', { ...accepted, cntg_yn: '2', cntg_qty: '7', cntg_unpr: '71100', rctf_cls: '0' });

        const [order] = await ex.watchOrders();

        expect(order).toMatchObject({ filled: 10, cost: 710700, average: 71070, status: 'closed', remaining: 0 });
    });

    it('해외 체결단가는 소수점 없이 오면 소수 넷째 자리까지로 읽고, 접수 통보의 단가를 주문 가격으로 쓴다', async () => {
        const { ex, emit } = withFakeStream({ htsId: 'MYHTS' });
        const notice = { oder_no: 'O1', seln_byov_cls: '02', stck_shrn_iscd: 'AAPL', stck_cntg_hour: '223000', rfus_yn: '0', rctf_cls: '0' };
        const first = ex.watchOrders('AAPL/USD');
        await flush();
        emit('H0GSCNI9', { ...notice, cntg_yn: '1', cntg_qty: '0000000002', cntg_unpr: '001480100', oder_qty: '' });
        const [receipt] = await first;
        emit('H0GSCNI9', { ...notice, cntg_yn: '2', cntg_qty: '0000000002', cntg_unpr: '001480100', oder_qty: '0000000002' });

        const [fill] = await ex.watchOrders('AAPL/USD');

        expect(receipt).toMatchObject({ id: 'O1', symbol: 'AAPL/USD', amount: 2, price: 148.01, status: 'open' });
        expect(fill).toMatchObject({ filled: 2, cost: 296.02, average: 148.01, status: 'closed' });
    });

    it('체결통보 구독이 거부되면 종목별로 기다리던 watchOrders 도 거절한다', async () => {
        const { ex, fail } = withFakeStream({ htsId: 'MYHTS' });
        const all = ex.watchOrders();
        const bySymbol = ex.watchOrders('005930/KRW');
        await flush();

        fail('H0STCNI9', 'MYHTS', 'MAX SUBSCRIBE OVER');

        await expect(all).rejects.toThrow('MAX SUBSCRIBE OVER');
        await expect(bySymbol).rejects.toThrow('MAX SUBSCRIBE OVER');
    });
});
