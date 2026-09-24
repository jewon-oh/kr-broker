/**
 * @fileoverview 토스 실시간 WS 프레임 파서 회귀. 공식 AsyncAPI 스펙의 예시 프레임을 그대로 쓴다.
 */
import { describe, it, expect } from 'vitest';

import { parseTossWsFrame } from '../toss-realtime-parser';

describe('parseTossWsFrame — 체결', () => {
    it('trade:us:AAPL — market·symbol·price·volume', () => {
        const raw = JSON.stringify({
            type: 'message', topic: 'trade:us:AAPL', data: { price: '185.5', volume: '10', timestamp: '2026-03-25T09:30:00.123+09:00', currency: 'USD' },
        });
        expect(parseTossWsFrame(raw)).toEqual({ kind: 'trade', data: { market: 'us', symbol: 'AAPL', price: 185.5, volume: 10, timestamp: Date.parse('2026-03-25T09:30:00.123+09:00') } });
    });

    it('trade:kr:005930', () => {
        const raw = JSON.stringify({ type: 'message', topic: 'trade:kr:005930', data: { price: '72000', volume: '120', currency: 'KRW' } });
        expect(parseTossWsFrame(raw)).toEqual({ kind: 'trade', data: { market: 'kr', symbol: '005930', price: 72000, volume: 120 } });
    });

    it('가격이나 수량을 숫자로 못 읽으면 unknown', () => {
        const raw = JSON.stringify({ type: 'message', topic: 'trade:us:AAPL', data: { price: 'n/a', volume: '10' } });
        expect(parseTossWsFrame(raw)).toEqual({ kind: 'unknown' });
    });
});

describe('parseTossWsFrame — 호가', () => {
    it('orderbook:kr:005930 — 매수·매도호가를 [가격,잔량] 쌍으로 옮긴다', () => {
        const raw = JSON.stringify({
            type: 'message',
            topic: 'orderbook:kr:005930',
            data: { currency: 'KRW', asks: [{ price: '71500', volume: '5' }], bids: [{ price: '71400', volume: '10' }] },
        });
        expect(parseTossWsFrame(raw)).toEqual({
            kind: 'orderbook', data: { market: 'kr', symbol: '005930', asks: [[71500, 5]], bids: [[71400, 10]] },
        });
    });

    it('빈 호가창은 빈 배열이다', () => {
        const raw = JSON.stringify({ type: 'message', topic: 'orderbook:us:TSLA', data: { currency: 'USD', asks: [], bids: [] } });
        expect(parseTossWsFrame(raw)).toEqual({ kind: 'orderbook', data: { market: 'us', symbol: 'TSLA', asks: [], bids: [] } });
    });
});

describe('parseTossWsFrame — 본인 주문 이벤트', () => {
    it('personal:order:3 — accountSeq·event·order 원본을 옮긴다', () => {
        const order = {
            orderId: 'bAGzNvMOOTa5Uy0xVzYNbxDJ3Qpobwau4jDF3hyZZGWbpHm7wha8CFZc7aXVOWAl',
            symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'FILLED',
            price: '100.5', quantity: '10', orderAmount: null, currency: 'USD',
            orderedAt: '2026-06-23T09:30:00.000+09:00', canceledAt: null,
            execution: { filledQuantity: '10', averageFilledPrice: '100', filledAmount: '1000', commission: '1.23', tax: '0', settlementDate: '2026-06-25' },
        };
        const raw = JSON.stringify({ type: 'message', topic: 'personal:order:3', data: { event: 'FILL', accountSeq: '3', order } });

        expect(parseTossWsFrame(raw)).toEqual({ kind: 'order', data: { accountSeq: '3', event: 'FILL', order } });
    });

    it('event 나 order 가 없으면 unknown', () => {
        expect(parseTossWsFrame(JSON.stringify({ type: 'message', topic: 'personal:order:3', data: { accountSeq: '3' } }))).toEqual({ kind: 'unknown' });
    });
});

describe('parseTossWsFrame — 제어 프레임', () => {
    it('구독 ack — 거부 목록을 그대로 옮긴다', () => {
        const raw = JSON.stringify({
            type: 'subscriptions', id: 'req-1', subscribed: ['trade:kr:005930'],
            rejected: [{ target: 'trade:kr:999999', code: 'stock-not-found', message: '해당 종목을 찾을 수 없습니다.' }],
        });
        expect(parseTossWsFrame(raw)).toEqual({
            kind: 'subscriptions', rejected: [{ target: 'trade:kr:999999', code: 'stock-not-found', message: '해당 종목을 찾을 수 없습니다.' }],
        });
    });

    it('에러 프레임', () => {
        const raw = JSON.stringify({ type: 'error', error: { code: 'rate-limit-exceeded', message: 'declare rate limit exceeded' } });
        expect(parseTossWsFrame(raw)).toEqual({ kind: 'error', code: 'rate-limit-exceeded', message: 'declare rate limit exceeded' });
    });

    it('pong', () => {
        expect(parseTossWsFrame('{"type":"pong"}')).toEqual({ kind: 'pong' });
    });

    it('JSON 이 아니거나 알 수 없는 type 은 unknown', () => {
        expect(parseTossWsFrame('not json')).toEqual({ kind: 'unknown' });
        expect(parseTossWsFrame('{"type":"something-else"}')).toEqual({ kind: 'unknown' });
        expect(parseTossWsFrame('"a string"')).toEqual({ kind: 'unknown' });
    });
});
