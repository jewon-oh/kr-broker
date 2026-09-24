/**
 * @fileoverview 응답 정리(`safeTicker`·`safeOrder`·`safeTrade`·`safeBalance`), 목록 파싱, 정밀도 맞춤.
 */

import { describe, it, expect } from 'vitest';

import { InvalidOrder } from '../errors';
import { DECIMAL_PLACES, ROUND, TICK_SIZE, decimalToPrecision } from '../functions/number';
import type { Dict, OHLCV } from '../types';
import { FakeExchange, marketOf } from './support/fake-exchange';

/** 종목 `005930`·`X` 가 로드된 가짜 증권사. */
function loaded(config: Dict = {}): FakeExchange {
    return new FakeExchange({ markets: { '005930/KRW': marketOf('005930'), 'X/KRW': marketOf('X') }, ...config });
}

describe('safeTicker', () => {
    const ex = loaded();

    it('종가와 변동액으로 시가·변동률·평균을 채운다', () => {
        const ticker = ex.safeTicker({ close: '105', change: '5' });
        expect(ticker).toEqual(expect.objectContaining({ open: 100, close: 105, last: 105, change: 5, percentage: 5, average: 102.5 }));
    });

    it('시가와 종가로 변동액·변동률·평균을 채운다', () => {
        const ticker = ex.safeTicker({ open: '100', close: '110' });
        expect(ticker).toEqual(expect.objectContaining({ open: 100, close: 110, change: 10, percentage: 10, average: 105 }));
    });

    it('종가와 변동률로 시가와 변동액을 채운다', () => {
        const ticker = ex.safeTicker({ close: '110', percentage: '10' });
        expect(ticker).toEqual(expect.objectContaining({ open: 100, change: 10, percentage: 10 }));
    });

    it('보합이면 변동액과 변동률이 0 이다(값 없음이 아니다)', () => {
        const ticker = ex.safeTicker({ open: '100', close: '100' });
        expect(ticker.change).toBe(0);
        expect(ticker.percentage).toBe(0);
    });

    it('0 으로 온 시가·고가·호가는 값 없음으로 본다', () => {
        const ticker = ex.safeTicker({ open: '0', high: '0', low: '0', bid: '0', ask: '0', close: '100' });
        expect(ticker.open).toBeUndefined();
        expect(ticker.high).toBeUndefined();
        expect(ticker.bid).toBeUndefined();
        expect(ticker.ask).toBeUndefined();
        expect(ticker.close).toBe(100);
        expect(ticker.last).toBe(100);
    });

    it('거래대금 / 거래량으로 vwap 을 계산한다', () => {
        expect(ex.safeTicker({ baseVolume: '10', quoteVolume: '1000' }).vwap).toBe(100);
        expect(ex.safeTicker({ baseVolume: '0', quoteVolume: '1000' }).vwap).toBeUndefined();
    });

    it('평균은 종목의 호가 단위 자릿수에서 버린다', () => {
        const market = ex.market('005930/KRW'); // 호가 단위 0.01
        expect(ex.safeTicker({ open: '100.01', close: '100.02' }, market).average).toBe(100.01);
        expect(ex.safeTicker({ open: '100.01', close: '100.02' }).average).toBe(100.015);
    });

    it('입력의 다른 키(info 등)를 그대로 남긴다', () => {
        const info = { raw: true };
        expect(ex.safeTicker({ close: '1', info, symbol: 'X/KRW' })).toEqual(expect.objectContaining({ info, symbol: 'X/KRW' }));
    });
});

describe('safeOrder', () => {
    const ex = loaded();

    it('amount 와 filled 로 remaining 과 cost 를 채운다', () => {
        const order = ex.safeOrder({ amount: '10', filled: '4', status: 'open', price: '100', type: 'limit', side: 'buy' });
        expect(order).toEqual(expect.objectContaining({ amount: 10, filled: 4, remaining: 6, cost: 400, price: 100, status: 'open', type: 'limit', side: 'buy' }));
    });

    it('체결 완료 주문은 amount 에서 filled 를, remaining 은 0 으로 채운다', () => {
        const order = ex.safeOrder({ amount: '5', status: 'closed', price: '100' });
        expect(order).toEqual(expect.objectContaining({ amount: 5, filled: 5, remaining: 0, cost: 500 }));
    });

    it('filled 와 remaining 으로 amount 를 채운다', () => {
        expect(ex.safeOrder({ filled: '3', remaining: '7' })).toEqual(expect.objectContaining({ amount: 10, filled: 3, remaining: 7 }));
    });

    it('시장가는 평균가를 계산해 price 로 쓰고 timeInForce 는 IOC 이다', () => {
        const order = ex.safeOrder({ type: 'market', amount: '2', filled: '2', cost: '200', status: 'closed' });
        expect(order).toEqual(expect.objectContaining({ average: 100, price: 100, cost: 200, timeInForce: 'IOC' }));
    });

    it('조건 주문(triggerPrice)의 시장가는 IOC 로 바꾸지 않고 stopPrice 에도 같은 값을 둔다', () => {
        const order = ex.safeOrder({ type: 'market', amount: '1', triggerPrice: '95' });
        expect(order.timeInForce).toBeUndefined();
        expect(order.triggerPrice).toBe(95);
        expect(order.stopPrice).toBe(95);
    });

    it('timeInForce 가 PO 면 postOnly 가 true 이다', () => {
        expect(ex.safeOrder({ timeInForce: 'PO' }).postOnly).toBe(true);
        expect(ex.safeOrder({ postOnly: true }).timeInForce).toBe('PO');
    });

    it('시각이 있으면 datetime 을 채운다', () => {
        const order = ex.safeOrder({ timestamp: 1_700_000_000_000 });
        expect(order.datetime).toBe('2023-11-14T22:13:20.000Z');
        expect(ex.safeOrder({}).datetime).toBeUndefined();
    });

    it('체결 목록에서 filled·cost·수수료·마지막 체결 시각·평균가를 합산한다', () => {
        const market = ex.market('X/KRW');
        const order = ex.safeOrder({
            trades: [
                { id: 't1', order: 'o1', code: 'X', side: 'buy', price: '100', amount: '1', timestamp: 1000, fee: { currency: 'KRW', cost: '1' } },
                { id: 't2', order: 'o1', code: 'X', side: 'buy', price: '110', amount: '2', timestamp: 2000, fee: { currency: 'KRW', cost: '2' } },
            ],
            info: { raw: 1 },
        }, market);
        expect(order).toEqual(expect.objectContaining({
            id: 'o1',
            symbol: 'X/KRW',
            side: 'buy',
            filled: 3,
            cost: 320,
            lastTradeTimestamp: 2000,
            fee: { currency: 'KRW', cost: 3 },
            fees: [{ currency: 'KRW', cost: 3 }],
        }));
        expect(order.average).toBeCloseTo(106.6666666667, 8);
        expect(order.info).toEqual({ raw: 1 });
        expect(order.trades).toHaveLength(2);
        expect(order.trades[1]).toEqual(expect.objectContaining({ price: 110, amount: 2, cost: 220, fee: { currency: 'KRW', cost: 2 } }));
    });

    it('이미 통합 구조로 파싱된 체결은 다시 파싱하지 않는다', () => {
        const parsedTrade = { info: {}, id: 't1', order: 'o1', symbol: 'X/KRW', side: 'sell', price: '10', amount: '2', cost: '20', timestamp: 5 };
        const order = ex.safeOrder({ trades: [parsedTrade] });
        expect(order.filled).toBe(2);
        expect(order.cost).toBe(20);
        expect(order.side).toBe('sell');
    });

    it('체결이 없으면 수수료는 비고 fees 는 빈 배열', () => {
        const order = ex.safeOrder({ amount: '1' });
        expect(order.fee).toBeUndefined();
        expect(order.fees).toEqual([]);
        expect(order.trades).toEqual([]);
    });

    it('주어진 수수료가 있으면 fees 에 숫자로 바꿔 넣는다', () => {
        const order = ex.safeOrder({ fee: { currency: 'KRW', cost: '5' } });
        expect(order.fees).toEqual([{ currency: 'KRW', cost: 5 }]);
    });

    it('모르는 상태 문자열은 그대로 둔다', () => {
        expect(ex.safeOrder({ status: 'pending_review' }).status).toBe('pending_review');
    });
});

describe('safeTrade', () => {
    const ex = loaded();

    it('금액이 없으면 가격 × 수량이고 수치는 number 로 바뀐다', () => {
        const trade = ex.safeTrade({ price: '100', amount: '3', fee: { currency: 'KRW', cost: '4.5' } });
        expect(trade).toEqual(expect.objectContaining({
            price: 100,
            amount: 3,
            cost: 300,
            fee: { currency: 'KRW', cost: 4.5 },
            fees: [{ currency: 'KRW', cost: 4.5 }],
        }));
    });

    it('주어진 금액은 계산하지 않고 그대로 쓴다', () => {
        expect(ex.safeTrade({ price: '100', amount: '3', cost: '299' }).cost).toBe(299);
    });

    it('수수료가 없으면 빈 수수료와 빈 목록', () => {
        const trade = ex.safeTrade({ price: '1', amount: '1' });
        expect(trade.fee).toEqual({ cost: undefined, currency: undefined });
        expect(trade.fees).toEqual([]);
    });

    it('수수료 목록은 통화별로 합친다', () => {
        const trade = ex.safeTrade({ price: '1', amount: '1', fees: [{ currency: 'KRW', cost: '1' }, { currency: 'KRW', cost: '2' }, { currency: 'USD', cost: '3' }] });
        expect(trade.fees).toEqual([{ currency: 'KRW', cost: 3 }, { currency: 'USD', cost: 3 }]);
    });

    it('계약 승수가 있는 종목(선물)은 승수를 곱하고 역수 계약은 가격의 역수를 쓴다', () => {
        const future = marketOf('F', { contractSize: 10 });
        expect(ex.safeTrade({ price: '2', amount: '3' }, future).cost).toBe(60);
        const inverse = marketOf('F', { contractSize: 10, inverse: true });
        expect(ex.safeTrade({ price: '2', amount: '3' }, inverse).cost).toBe(15);
    });

    it('reduceFeesByCurrency 는 통화와 요율이 같은 수수료를 합친다', () => {
        expect(ex.reduceFeesByCurrency([
            { currency: 'KRW', cost: '1' },
            { currency: 'KRW', cost: '2' },
            { currency: 'KRW', cost: '2', rate: '0.1' },
            { currency: 'KRW', cost: '1', rate: '0.1' },
            { currency: 'USD', cost: '5' },
        ])).toEqual([
            { currency: 'KRW', cost: '3' },
            { currency: 'KRW', cost: '3', rate: '0.1' },
            { currency: 'USD', cost: '5' },
        ]);
    });
});

describe('safeBalance', () => {
    const ex = loaded();

    it('빠진 값을 채우고 free·used·total 사전을 함께 만든다', () => {
        const info = { raw: true };
        const balances = ex.safeBalance({
            info,
            KRW: { free: '1000', used: '200' },
            '005930': { total: '10', free: '7', info: { avgPrice: '70000' } },
            USD: { total: '5', used: '1' },
        });
        expect(balances.KRW).toEqual({ free: 1000, used: 200, total: 1200 });
        expect(balances['005930']).toEqual({ free: 7, used: 3, total: 10, info: { avgPrice: '70000' } });
        expect(balances.USD).toEqual({ free: 4, used: 1, total: 5 });
        expect(balances.free).toEqual({ KRW: 1000, '005930': 7, USD: 4 });
        expect(balances.used).toEqual({ KRW: 200, '005930': 3, USD: 1 });
        expect(balances.total).toEqual({ KRW: 1200, '005930': 10, USD: 5 });
        expect(balances.info).toBe(info);
    });

    it('계산할 수 없는 값은 undefined 로 남긴다', () => {
        const balances = ex.safeBalance({ info: {}, KRW: { free: '5' } });
        expect(balances.KRW).toEqual({ free: 5, used: undefined, total: undefined });
    });

    it('부채가 있으면 debt 사전도 만든다', () => {
        const balances = ex.safeBalance({ info: {}, KRW: { total: '5', free: '5', debt: '2' } });
        expect(balances.KRW.debt).toBe(2);
        expect(balances.debt).toEqual({ KRW: 2 });
        expect(ex.safeBalance({ info: {}, KRW: { total: '5', free: '5' } }).debt).toBeUndefined();
    });

    it('종목이 하나도 없으면 빈 잔고다(조회 실패와 구분된다)', () => {
        const balances = ex.safeBalance({ info: { output1: [] } });
        expect(Object.keys(balances).sort()).toEqual(['free', 'info', 'total', 'used']);
        expect(balances.total).toEqual({});
    });

    it('account() 는 빈 항목', () => {
        expect(ex.account()).toEqual({ free: undefined, used: undefined, total: undefined });
    });
});

describe('목록 파싱', () => {
    const ex = loaded();
    const raw = [
        { id: 'a', code: '005930', side: 'buy', type: 'limit', status: 'open', price: '100', amount: '1', timestamp: 3000 },
        { id: 'b', code: '005930', side: 'buy', type: 'limit', status: 'closed', price: '100', amount: '1', filled: '1', timestamp: 1000 },
        { id: 'c', code: 'X', side: 'sell', type: 'limit', status: 'open', price: '100', amount: '1', timestamp: 2000 },
    ];

    it('parseOrders: 시각 순으로 정렬한다', () => {
        expect(ex.parseOrders(raw).map((o) => o.id)).toEqual(['b', 'c', 'a']);
    });

    it('parseOrders: since 이후만, limit 은 since 가 있으면 앞에서 없으면 뒤(최근)에서 자른다', () => {
        expect(ex.parseOrders(raw, undefined, 2000).map((o) => o.id)).toEqual(['c', 'a']);
        expect(ex.parseOrders(raw, undefined, 2000, 1).map((o) => o.id)).toEqual(['c']);
        expect(ex.parseOrders(raw, undefined, undefined, 1).map((o) => o.id)).toEqual(['a']);
    });

    it('parseOrders: 종목을 주면 그 종목만 남긴다', () => {
        expect(ex.parseOrders(raw, ex.market('005930/KRW')).map((o) => o.id)).toEqual(['b', 'a']);
    });

    it('parseOrders: id 를 키로 한 사전도 받고 params 를 덧씌운다', () => {
        const orders = ex.parseOrders({ x1: { code: 'X', timestamp: 1 }, x2: { code: 'X', timestamp: 2 } }, undefined, undefined, undefined, { tag: 't' });
        expect(orders.map((o) => o.id)).toEqual(['x1', 'x2']);
        expect(orders.every((o) => (o as Dict).tag === 't')).toBe(true);
        expect(ex.parseOrders(undefined)).toEqual([]);
    });

    it('parseTrades: 시각·id 순으로 정렬한다', () => {
        const trades = ex.parseTrades([
            { id: 'z', code: 'X', price: '1', amount: '1', timestamp: 2 },
            { id: 'b', code: 'X', price: '1', amount: '1', timestamp: 1 },
            { id: 'a', code: 'X', price: '1', amount: '1', timestamp: 1 },
        ]);
        expect(trades.map((t) => t.id)).toEqual(['a', 'b', 'z']);
    });

    it('parseTickers: 심볼로 색인하고 symbols 로 거른다', () => {
        const rows = [{ code: '005930', close: '10' }, { code: 'X', close: '20' }];
        expect(Object.keys(ex.parseTickers(rows))).toEqual(['005930/KRW', 'X/KRW']);
        expect(Object.keys(ex.parseTickers(rows, ['X/KRW']))).toEqual(['X/KRW']);
    });

    it('parseOHLCVs: 시각 오름차순으로 정렬하고 since·limit 으로 자른다', () => {
        class WithOhlcv extends FakeExchange {
            override parseOHLCV(row: Dict): OHLCV {
                return [row.t, row.o, row.h, row.l, row.c, row.v];
            }
        }
        const candles = new WithOhlcv();
        const rows = [
            { t: 3000, o: 3, h: 3, l: 3, c: 3, v: 3 },
            { t: 1000, o: 1, h: 1, l: 1, c: 1, v: 1 },
            { t: 2000, o: 2, h: 2, l: 2, c: 2, v: 2 },
        ];
        expect(candles.parseOHLCVs(rows).map((c) => c[0])).toEqual([1000, 2000, 3000]);
        expect(candles.parseOHLCVs(rows, undefined, '1m', 2000).map((c) => c[0])).toEqual([2000, 3000]);
        expect(candles.parseOHLCVs(rows, undefined, '1m', undefined, 2).map((c) => c[0])).toEqual([2000, 3000]);
        expect(candles.parseOHLCVs(rows, undefined, '1m', 1000, 2).map((c) => c[0])).toEqual([1000, 2000]);
        expect(candles.parseOHLCVs(undefined)).toEqual([]);
    });

    it('parseOrderBook: 매수는 내림차순, 매도는 오름차순으로 정렬하고 수치를 number 로 바꾼다', () => {
        const book = ex.parseOrderBook({ bids: [['99', '5'], ['100', '2']], asks: [['102', '1'], ['101', '3']] }, 'X/KRW', 1_700_000_000_000);
        expect(book).toEqual({
            symbol: 'X/KRW',
            bids: [[100, 2], [99, 5]],
            asks: [[101, 3], [102, 1]],
            timestamp: 1_700_000_000_000,
            datetime: '2023-11-14T22:13:20.000Z',
            nonce: undefined,
        });
    });

    it('parseOrderBook: 키 이름을 바꿔 읽을 수 있고, 비어 있어도 된다', () => {
        const book = ex.parseOrderBook({ buy: [{ p: '100', q: '2' }] }, 'X/KRW', undefined, 'buy', 'sell', 'p', 'q');
        expect(book.bids).toEqual([[100, 2]]);
        expect(book.asks).toEqual([]);
        expect(ex.parseOrderBook(undefined, 'X/KRW').bids).toEqual([]);
    });

    it('filterBySinceLimit: 0·없는 값은 since 조건에 맞지 않는 것으로 본다', () => {
        const rows = [{ timestamp: 0 }, { timestamp: 5 }, {}, { timestamp: 10 }];
        expect(ex.filterBySinceLimit(rows, 5)).toEqual([{ timestamp: 5 }, { timestamp: 10 }]);
        expect(ex.filterBySinceLimit(rows, 5, 1, 'timestamp', true)).toEqual([{ timestamp: 10 }]);
        expect(ex.filterBySinceLimit(undefined)).toEqual([]);
    });

    it('safeCurrencyCode: commonCurrencies 로 옮기고 없으면 대문자로', () => {
        const withCommon = new FakeExchange({ commonCurrencies: { XBT: 'BTC' } });
        expect(withCommon.safeCurrencyCode('xbt')).toBe('BTC');
        expect(withCommon.safeCurrencyCode('krw')).toBe('KRW');
        expect(withCommon.safeCurrencyCode(undefined)).toBeUndefined();
    });
});

describe('정밀도 맞춤', () => {
    const ex = loaded(); // 수량 단위 1, 호가 단위 0.01

    it('amountToPrecision 은 수량을 버린다', () => {
        expect(ex.amountToPrecision('005930/KRW', 10.7)).toBe('10');
        expect(ex.amountToPrecision('005930/KRW', '7')).toBe('7');
        expect(ex.amountToPrecision('005930/KRW', undefined)).toBeUndefined();
    });

    it('amountToPrecision 은 최소 단위보다 작으면 InvalidOrder', () => {
        expect(() => ex.amountToPrecision('005930/KRW', 0.5)).toThrow(InvalidOrder);
        expect(() => ex.amountToPrecision('005930/KRW', 0.5)).toThrow('minimum amount precision');
    });

    it('priceToPrecision 은 가격을 반올림한다', () => {
        expect(ex.priceToPrecision('005930/KRW', 100.126)).toBe('100.13');
        expect(ex.priceToPrecision('005930/KRW', 100.124)).toBe('100.12');
        expect(ex.priceToPrecision('005930/KRW', '100.125')).toBe('100.13');
        expect(ex.priceToPrecision('005930/KRW', undefined)).toBeUndefined();
    });

    it('priceToPrecision 은 0 으로 떨어지면 InvalidOrder', () => {
        expect(() => ex.priceToPrecision('005930/KRW', 0.004)).toThrow(InvalidOrder);
    });

    it('costToPrecision 은 precision.cost, 없으면 precision.price 로 버린다', () => {
        expect(ex.costToPrecision('005930/KRW', 1234.567)).toBe('1234.56');
        const withCost = new FakeExchange({ markets: { 'C/KRW': marketOf('C', { precision: { amount: 1, price: 0.01, cost: 1 } }) } });
        expect(withCost.costToPrecision('C/KRW', 1234.567)).toBe('1234');
    });

    it('정밀도가 없는 종목은 값을 손대지 않고 돌려준다(가격대별 호가 단위처럼 단일 값으로 못 적는 경우)', () => {
        const noTick = new FakeExchange({ markets: { 'N/KRW': marketOf('N', { precision: { amount: undefined, price: undefined } }) } });
        expect(noTick.priceToPrecision('N/KRW', 70123.4)).toBe('70123.4');
        expect(noTick.amountToPrecision('N/KRW', 3)).toBe('3');
        expect(noTick.costToPrecision('N/KRW', 1e-7)).toBe('0.0000001');
    });

    it('증권사 클래스가 호가 단위 표로 override 할 수 있다', () => {
        class KrxTick extends FakeExchange {
            override priceToPrecision(_symbol: string, price: number): string {
                const tick = price >= 500_000 ? 1000 : price >= 100_000 ? 500 : 100;
                return decimalToPrecision(price, ROUND, tick, TICK_SIZE);
            }
        }
        const krx = new KrxTick({ markets: { '005930/KRW': marketOf('005930') } });
        expect(krx.priceToPrecision('005930/KRW', 70_130)).toBe('70100');
        expect(krx.priceToPrecision('005930/KRW', 120_300)).toBe('120500');
    });

    it('precisionMode 가 DECIMAL_PLACES 면 자릿수로 읽는다', () => {
        const decimals = new FakeExchange({
            precisionMode: DECIMAL_PLACES,
            markets: { 'D/KRW': marketOf('D', { precision: { amount: 0, price: 2 } }) },
        });
        expect(decimals.amountToPrecision('D/KRW', 10.7)).toBe('10');
        expect(decimals.priceToPrecision('D/KRW', 100.126)).toBe('100.13');
    });

    it('소수 주식(수량 단위 1e-6)도 정확하다', () => {
        const fractional = new FakeExchange({ markets: { 'F/KRW': marketOf('F', { precision: { amount: 1e-6, price: 0.01 } }) } });
        expect(fractional.amountToPrecision('F/KRW', 0.1234567)).toBe('0.123456');
        expect(fractional.amountToPrecision('F/KRW', 1e-6)).toBe('0.000001');
    });
});
