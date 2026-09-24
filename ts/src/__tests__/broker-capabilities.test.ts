/**
 * 능력표 계약. 증권사 클래스의 `has`(ccxt 의 `exchange.has` 에 해당한다)와 실제 구현이 어긋나지 않는다.
 *
 * `has` 만 고치거나 메서드만 고치면 이 테스트가 실패한다. 호출하는 쪽은 `has` 를 믿고 분기하므로 표가 거짓이면 조용히 엉뚱한 분기로 빠진다.
 *
 * - `true`·`'emulated'`: 클래스가 그 메서드를 구현한다. 부모 클래스의 기본 구현이 다른 메서드로 대신해 주는 경우(`fetchClosedOrders` 는 `fetchOrders` 로)도 구현으로 본다.
 * - `false`(또는 적지 않음): 구현하지 않는다. 부르면 요청을 보내지 않고 `NotSupported` 를 던진다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { Exchange, NotSupported } from '../base';
import { kbsec } from '../kbsec';
import { kis } from '../kis';
import { toss } from '../toss';

const BROKERS: ReadonlyArray<[string, () => Exchange]> = [
    ['kis', () => new kis({ apiKey: 'kis-app-key-123456', secret: 'kis-secret', uid: '12345678-01' })],
    ['toss', () => new toss({ apiKey: 'toss-client-id-123456', secret: 'toss-secret', uid: 'ACC-001' })],
    ['kbsec', () => new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret' })],
];

/** 부모 클래스가 `NotSupported` 를 던지는 기본 구현으로 둔 통합 메서드. 증권사가 지원하는 것만 override 한다. */
const UNIFIED_METHODS = [
    'fetchTime', 'fetchStatus', 'fetchTicker', 'fetchTickers', 'fetchOrderBook', 'fetchOHLCV', 'fetchBalance',
    'createOrder', 'editOrder', 'createTriggerOrder', 'cancelOrder', 'cancelAllOrders', 'fetchOrder', 'fetchOrders', 'fetchOpenOrders', 'fetchClosedOrders',
    'fetchCanceledOrders', 'fetchMyTrades', 'fetchTradingFee',
] as const;

/** 부모 클래스가 기본 구현을 가진 것들의 `has` 는 구현 여부를 뜻하지 않는다(`fetchMarkets` 는 이미 넣어 둔 종목을 돌려주는 기본 구현이 있다). */
const HAS_ONLY_FLAGS: ReadonlySet<string> = new Set(['fetchMarkets', 'fetchCurrencies', 'createLimitOrder', 'createMarketOrder']);

/** 별도 메서드가 아니라 다른 메서드의 `params` 로 구현하는 능력. 키가 `true` 이면 값의 메서드를 구현해야 한다. */
const IMPLEMENTED_BY: Readonly<Record<string, string>> = {};

/** 메서드 이름꼴의 `has` 키. `spot`·`sandbox` 같은 성질 플래그는 뺀다. */
const isMethodKey = (key: string): boolean => /^(fetch|create|cancel|edit|watch)[A-Z]/.test(key);

/** 부모 클래스의 기본 구현이 다른 메서드로 대신해 주는 경우. 원천이 되는 `has` 키가 켜져 있으면 그 메서드는 부모 구현으로 동작한다. */
const DERIVED_FROM: Readonly<Record<string, string>> = {
    fetchTicker: 'fetchTickers',
    fetchOpenOrders: 'fetchOrders',
    fetchClosedOrders: 'fetchOrders',
};

/** 클래스가 부모의 기본 구현을 덮어썼거나, 부모의 기본 구현이 다른 메서드로 대신해 주는가. 부모에 없는 메서드는 있기만 하면 구현이다. */
function isImplemented(exchange: Exchange, method: string): boolean {
    const own = (exchange as unknown as Record<string, unknown>)[method];
    if (typeof own !== 'function') return false;
    if (own !== (Exchange.prototype as unknown as Record<string, unknown>)[method]) return true;
    const source = DERIVED_FROM[method];
    return source !== undefined && exchange.has[source] !== undefined && exchange.has[source] !== false;
}

beforeEach(() => {
    // 능력을 확인하는 호출이 네트워크로 나가면 안 된다.
    mockFetch.mockReset().mockRejectedValue(new Error('요청이 나가면 안 된다'));
});

afterEach(() => {
    expect(mockFetch).not.toHaveBeenCalled();
});

describe.each(BROKERS)('%s — has 와 실제 구현의 일치', (_name, make) => {
    it.each(UNIFIED_METHODS)('통합 메서드 %s: has 가 true·emulated 면 구현하고, 아니면 구현하지 않는다', (method) => {
        const exchange = make();
        const declared = exchange.has[method];
        const expectImplemented = declared === true || declared === 'emulated';

        expect(isImplemented(exchange, method), `${exchange.id}.${method}: has=${String(declared)}`).toBe(expectImplemented);
    });

    it.each(UNIFIED_METHODS)('통합 메서드 %s: 구현하지 않으면 부를 때 요청 없이 NotSupported 다', async (method) => {
        const exchange = make();
        if (isImplemented(exchange, method)) return;

        const call = (exchange as unknown as Record<string, () => Promise<unknown>>)[method].call(exchange);

        await expect(call).rejects.toBeInstanceOf(NotSupported);
    });

    it('통합 메서드가 아닌 has 키도 true·emulated 면 그 메서드가 있다', () => {
        const exchange = make();
        const missing = Object.entries(exchange.has)
            .filter(([key, value]) => isMethodKey(key) && (value === true || value === 'emulated'))
            .filter(([key]) => !(UNIFIED_METHODS as readonly string[]).includes(key))
            .filter(([key]) => !HAS_ONLY_FLAGS.has(key))
            .filter(([key]) => !isImplemented(exchange, IMPLEMENTED_BY[key] ?? key))
            .map(([key]) => key);

        expect(missing).toEqual([]);
    });

    it('fetchMarkets 가 true 면 종목을 직접 받아 온다. false 면 받아 오지 않는다', () => {
        const exchange = make();
        const declared = exchange.has.fetchMarkets;

        expect(isImplemented(exchange, 'fetchMarkets'), `${exchange.id}.fetchMarkets: has=${String(declared)}`).toBe(declared === true);
    });
});

describe.each(BROKERS)('%s — 모의투자 능력', (_name, make) => {
    it('has.sandbox 가 true 면 setSandboxMode 가 되고, false 면 NotSupported 다', () => {
        const exchange = make();

        if (exchange.has.sandbox === true) {
            exchange.setSandboxMode(true);
            expect(exchange.isSandboxModeEnabled).toBe(true);
            exchange.setSandboxMode(false);
            expect(exchange.isSandboxModeEnabled).toBe(false);
        } else {
            expect(() => exchange.setSandboxMode(true)).toThrow(NotSupported);
        }
    });
});

describe('세 증권사가 같은 모양의 표를 쓴다', () => {
    it('시세·호가·잔고·주문·취소·미체결·체결·휴장일 캘린더는 세 증권사 모두 지원한다', () => {
        for (const [name, make] of BROKERS) {
            const has = make().has;
            for (const method of ['fetchTicker', 'fetchOrderBook', 'fetchBalance', 'createOrder', 'cancelOrder', 'fetchOrder', 'fetchOpenOrders', 'fetchMyTrades']) {
                expect(has[method], `${name}.${method}`).toBeTruthy();
            }
            expect(has.cancelAllOrders, `${name}.cancelAllOrders`).toBe('emulated');
            expect(has.fetchMarketCalendar, `${name}.fetchMarketCalendar`).toBe(true);
        }
    });
});
