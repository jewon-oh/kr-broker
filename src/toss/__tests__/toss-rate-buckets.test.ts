/**
 * @fileoverview 레이트리밋: 엔드포인트마다 그룹 버킷이 있고, 그룹 한도와 계정 전체 상한이 함께 걸리는지.
 *
 * 토스는 클라이언트와 API 그룹 단위로 초당 요청을 제한한다. 버킷 이름을 잘못 적으면 요청이 `ExchangeError` 로 실패하므로 정합성을 여기서 본다.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Dict } from '../../base';
import { installFakeToss, jsonOk, makeToss } from './support/toss-fake';

const exchange = makeToss();
const api = exchange.api as Dict;

/** `api` 트리의 모든 엔드포인트. */
function endpoints(): Array<{ method: string; path: string; config: Dict; group: string }> {
    const out: Array<{ method: string; path: string; config: Dict; group: string }> = [];
    const walk = (node: Dict, group: string): void => {
        for (const [key, value] of Object.entries(node)) {
            if (/^(get|post|delete|put)$/.test(key)) {
                for (const [path, config] of Object.entries(value as Dict)) out.push({ method: key.toUpperCase(), path, config: config as Dict, group });
            } else {
                walk(value as Dict, group === '' ? key : `${group}.${key}`);
            }
        }
    };
    walk(api, '');
    return out;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('그룹 버킷', () => {
    it('모든 엔드포인트가 선언된 버킷을 가리킨다', () => {
        const buckets = Object.keys(exchange.rateLimitBuckets);
        for (const { method, path, config } of endpoints()) {
            expect(buckets, `${method} ${path}`).toContain(config.bucket);
        }
    });

    it('같은 경로도 메서드로 그룹이 갈린다: 주문 생성과 주문 조회', () => {
        const byKey = new Map(endpoints().map((e) => [`${e.method} ${e.path}`, e.config]));
        expect(byKey.get('POST orders')?.bucket).toBe('order');
        expect(byKey.get('GET orders')?.bucket).toBe('order_history');
        expect(byKey.get('POST orders/{orderId}/cancel')?.bucket).toBe('order');
        expect(byKey.get('GET conditional-orders')?.bucket).toBe('conditional_order_history');
        expect(byKey.get('POST conditional-orders')?.bucket).toBe('conditional_order');
        expect(byKey.get('DELETE conditional-orders/{conditionalOrderId}')?.bucket).toBe('conditional_order');
    });

    it('시세는 시세 그룹, 캔들은 차트 그룹, 종목 전체 목록은 별도 그룹이다', () => {
        const byKey = new Map(endpoints().map((e) => [`${e.method} ${e.path}`, e.config]));
        expect(byKey.get('GET prices')?.bucket).toBe('market_data');
        expect(byKey.get('GET orderbook')?.bucket).toBe('market_data');
        expect(byKey.get('GET candles')?.bucket).toBe('market_data_chart');
        expect(byKey.get('GET stocks/all')?.bucket).toBe('stock_all');
        expect(byKey.get('GET stocks')?.bucket).toBe('stock');
    });

    it('주문 요청만 order 로 표시되고, 주문 요청은 재시도·시간 상한에서 조회와 다르게 다뤄진다', () => {
        const orders = endpoints().filter((e) => e.config.order === true).map((e) => `${e.method} ${e.path}`).sort();
        expect(orders).toEqual([
            'DELETE conditional-orders/{conditionalOrderId}',
            'POST conditional-orders',
            'POST orders',
            'POST orders/{orderId}/cancel',
        ]);
    });

    it('개장 직후 한도가 줄어드는 그룹(매수여력·수수료)만 peak 로 표시된다. 주문 그룹은 줄지 않는다', () => {
        const peak = endpoints().filter((e) => e.config.peak === true).map((e) => e.path).sort();
        expect(peak).toEqual(['buying-power', 'commissions']);
    });

    it('가장 엄격한 그룹(계좌 목록·보유 주식)은 1 TPS 이하로 직렬화한다', () => {
        expect(exchange.rateLimitBuckets.account.rateLimit).toBeGreaterThanOrEqual(1000);
        expect(exchange.rateLimitBuckets.asset.rateLimit).toBeGreaterThanOrEqual(1000);
        expect(exchange.rateLimitBuckets.stock_all.rateLimit).toBeGreaterThanOrEqual(1000);
    });

    it('계정 전체 상한은 초당 10건이다', () => {
        expect(exchange.rateLimit).toBe(100);
    });
});

describe('개장 직후(09:00~09:10 KST)', () => {
    const cost = (path: string, now: string): number => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(now));
        const config = endpoints().find((e) => e.path === path)!.config;
        return exchange.calculateRateLimiterCost(['private', 'account'], 'GET', path, {}, config);
    };

    it('윈도우 경계', () => {
        expect(cost('buying-power', '2026-08-03T08:59:59+09:00')).toBe(1);
        expect(cost('buying-power', '2026-08-03T09:00:00+09:00')).toBe(2);
        expect(cost('buying-power', '2026-08-03T09:09:59+09:00')).toBe(2);
        expect(cost('buying-power', '2026-08-03T09:10:00+09:00')).toBe(1);
    });

    it('주문 조회·주문 생성은 개장 직후에도 그대로다', () => {
        expect(cost('orders', '2026-08-03T09:05:00+09:00')).toBe(1);
    });
});

describe('실제로 기다린다', () => {
    it('같은 그룹의 연속 요청은 그룹 간격만큼 늦추고, 다른 그룹은 서로 기다리지 않는다', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date', 'performance'] });
        installFakeToss({
            'GET /api/v1/prices': jsonOk([{ symbol: '005930', lastPrice: '1' }]),
            'GET /api/v1/market-calendar/KR': jsonOk({}),
        });
        const limited = makeToss({ enableRateLimit: true, rateLimit: 0, rateLimitBuckets: { auth: { rateLimit: 0 }, market_data: { rateLimit: 400 }, market_info: { rateLimit: 400 } } });
        await limited.fetchTicker('005930');
        const second = limited.fetchTicker('005930');
        let secondDone = false;
        void second.then(() => { secondDone = true; });
        await vi.advanceTimersByTimeAsync(300);
        expect(secondDone).toBe(false);
        await vi.advanceTimersByTimeAsync(150);
        await second;
        expect(secondDone).toBe(true);
        // 다른 그룹은 시세 그룹의 대기에 걸리지 않는다.
        await limited.fetchMarketCalendar('KR');
    });

    it('그룹 한도가 느슨해도 계정 전체 상한(rateLimit)이 함께 걸린다', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date', 'performance'] });
        installFakeToss({ 'GET /api/v1/prices': jsonOk([{ symbol: '005930', lastPrice: '1' }]) });
        const limited = makeToss({ enableRateLimit: true, rateLimit: 500, rateLimitBuckets: { auth: { rateLimit: 0 }, market_data: { rateLimit: 1 } } });
        // 첫 요청은 토큰 발급과 시세 조회가 계정 전체 상한을 차례로 써서 500ms 뒤에 끝난다.
        const first = limited.fetchTicker('005930');
        await vi.advanceTimersByTimeAsync(600);
        await first;
        const second = limited.fetchTicker('005930');
        let done = false;
        void second.then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(300);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(400);
        await second;
        expect(done).toBe(true);
    });
});
