/**
 * @fileoverview `toss` 의 ccxt pro 메서드(`watchTicker`, `watchTrades`, `watchOrderBook`, `watchOrders`, `close`).
 * 실제 웹소켓을 열지 않도록 `createPriceStream` 을 가짜로 바꾸고, 받은 콜백에 이벤트를 직접 넣는다.
 */
import { describe, it, expect, vi } from 'vitest';

import { ExchangeError } from '../../base/errors';
import type { TossPriceWsOptions } from '../toss-price-ws';
import { makeToss } from './support/toss-fake';

type Handlers = Pick<TossPriceWsOptions, 'onTrade' | 'onOrderbook' | 'onOrder'>;

function withFakeSocket() {
    const ex = makeToss();
    const socket = { start: vi.fn(), updateSubs: vi.fn(), stop: vi.fn() };
    let handlers: Handlers = {};
    vi.spyOn(ex, 'createPriceStream').mockImplementation(((h: Handlers) => {
        handlers = h;
        return socket;
    }) as never);
    return { ex, socket, on: () => handlers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const AT = Date.parse('2026-09-24T12:23:00.000Z');

describe('watchTicker, watchTrades', () => {
    it('처음 부를 때 연결하고 국내 체결 채널을 구독한다. 시세는 체결 가격으로 채운다', async () => {
        const { ex, socket, on } = withFakeSocket();

        const pending = ex.watchTicker('005930/KRW');
        on().onTrade?.('kr', '005930', 71000, 15, AT);

        expect(socket.start).toHaveBeenCalledWith([{ channel: 'trade', market: 'kr', symbol: '005930' }]);
        expect(await pending).toMatchObject({ symbol: '005930/KRW', last: 71000, timestamp: AT, datetime: '2026-09-24T12:23:00.000Z' });
    });

    it('두 번째 구독부터는 전체 구독을 다시 선언하고, 체결은 쌓았다가 한꺼번에 돌려준다', async () => {
        const { ex, socket, on } = withFakeSocket();
        const first = ex.watchTrades('AAPL/USD');
        on().onTrade?.('us', 'AAPL', 228.5, 10, AT);
        await first;

        const book = ex.watchOrderBook('AAPL/USD');
        on().onTrade?.('us', 'AAPL', 228.6, 5, AT + 1000);
        on().onTrade?.('us', 'AAPL', 228.7, 7, AT + 2000);
        const trades = await ex.watchTrades('AAPL/USD');

        expect(socket.updateSubs).toHaveBeenCalledWith([
            { channel: 'trade', market: 'us', symbol: 'AAPL' }, { channel: 'orderbook', market: 'us', symbol: 'AAPL' },
        ]);
        expect(trades.map((t) => [t.symbol, t.price, t.amount])).toEqual([['AAPL/USD', 228.6, 5], ['AAPL/USD', 228.7, 7]]);
        void book.catch(() => undefined);
        await ex.close();
    });
});

describe('watchOrderBook', () => {
    it('호가를 받아 limit 로 자른다', async () => {
        const { ex, on } = withFakeSocket();

        const pending = ex.watchOrderBook('005930/KRW', 1);
        on().onOrderbook?.('kr', '005930', [[71000, 10], [70900, 20]], [[71100, 5], [71200, 6]], AT);
        const book = await pending;

        expect(book).toMatchObject({ symbol: '005930/KRW', bids: [[71000, 10]], asks: [[71100, 5]], timestamp: AT });
    });
});

describe('watchOrders', () => {
    it('계좌 순번으로 본인 주문 채널을 구독하고, 주문 이벤트를 parseOrder 로 옮긴다', async () => {
        const { ex, socket, on } = withFakeSocket();

        const pending = ex.watchOrders();
        await flush();
        on().onOrder?.('ACC-001', 'FILL', {
            orderId: 'O1', symbol: '005930', side: 'BUY', orderType: 'LIMIT', price: '71000', quantity: '10', status: 'FILLED',
            orderedAt: '2026-09-24T01:00:00Z', execution: { filledQuantity: '10', averageFilledPrice: '71000' },
        });
        const [order] = await pending;

        expect(socket.start).toHaveBeenCalledWith([{ channel: 'order', accountSeq: 'ACC-001' }]);
        expect(order).toMatchObject({ id: 'O1', side: 'buy', amount: 10, filled: 10 });
    });
});

describe('close', () => {
    it('연결을 멈추고 기다리던 watch 를 거절한다', async () => {
        const { ex, socket } = withFakeSocket();
        const pending = ex.watchTicker('005930/KRW');

        await ex.close();

        await expect(pending).rejects.toThrow(ExchangeError);
        expect(socket.stop).toHaveBeenCalled();
    });
});
