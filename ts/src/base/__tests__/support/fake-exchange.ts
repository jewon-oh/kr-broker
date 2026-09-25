/**
 * @fileoverview 베이스 클래스 테스트용 가짜 증권사와 가짜 `fetch`.
 */

import { vi } from 'vitest';

import { Exchange, type SignedRequest } from '../../Exchange';
import { ExchangeError, InsufficientFunds, MarketClosed, OrderNotFound, OrderOutcomeUnknown } from '../../errors';
import { deepExtend } from '../../functions/generic';
import { safeString, safeValue } from '../../functions/type';
import { TICK_SIZE } from '../../functions/number';
import type { Dict, Dictionary, MarketInterface, Order, Ticker, Trade, Market } from '../../types';

/** `Exchange` 를 상속해 `api` 트리·오류 표·파서를 갖춘 가짜 증권사. 호출 순서를 `calls` 에 남긴다. */
export class FakeExchange extends Exchange {
    /** 실행 중인 단계 이름을 순서대로 남긴다. */
    calls: string[] = [];

    override describe(): Dict {
        return deepExtend(super.describe(), {
            id: 'fake',
            name: 'Fake Securities',
            countries: ['KR'],
            rateLimit: 100,
            timeout: 5000,
            hostname: 'api.fake.test',
            has: {
                fetchMarkets: true,
                fetchTickers: false,
                sandbox: true,
            },
            urls: {
                api: {
                    public: 'https://{hostname}/v1',
                    private: 'https://{hostname}/v1',
                    trader: 'https://{hostname}/trader',
                },
                test: {
                    public: 'https://sandbox.fake.test/v1',
                    private: 'https://sandbox.fake.test/v1',
                    trader: 'https://sandbox.fake.test/trader',
                },
            },
            requiredCredentials: { apiKey: true, secret: true, uid: true },
            api: {
                public: {
                    get: {
                        'market/all': { cost: 1 },
                        'ticker/{code}': 2,
                        'candles/{unit}/{code}': { cost: 1 },
                        'slow/status': { cost: 1, bucket: 'slow' },
                        'bad/bucket': { cost: 1, bucket: 'nowhere' },
                    },
                },
                private: {
                    get: { accounts: { cost: 1 } },
                    post: { orders: { cost: 3, order: true } },
                    delete: { 'orders/{id}': { cost: 1, order: true } },
                },
                trader: {
                    private: { get: { 'v2/assets': { cost: 1 } } },
                },
            },
            rateLimitBuckets: { slow: { rateLimit: 1000 } },
            fees: { trading: { maker: 0.0015, taker: 0.0015, percentage: true } },
            exceptions: {
                exact: { E100: InsufficientFunds },
                broad: { 'order not found': OrderNotFound, 'closed market': MarketClosed },
            },
            precisionMode: TICK_SIZE,
            options: { tradingFeesByQuoteCurrency: { KRW: 0.0015 } },
        });
    }

    override sign(path: string, api: string | string[] = 'public', method = 'GET', params: Dict = {}, headers?: Dictionary<string>, body?: string): SignedRequest {
        this.calls.push('sign');
        const request = super.sign(path, api, method, params, headers, body);
        if (this.isPrivateApi(api)) {
            request.headers = { ...request.headers, Authorization: `Bearer ${this.token ?? 'none'}` };
        }
        return request;
    }

    override async authenticate(): Promise<void> {
        this.calls.push('authenticate');
        this.token = 'issued-token';
    }

    override async throttle(cost?: number, bucket?: string): Promise<void> {
        this.calls.push('throttle');
        return super.throttle(cost, bucket);
    }

    override handleErrors(
        _statusCode: number,
        _statusText: string,
        _url: string,
        _method: string,
        _responseHeaders: Dictionary<string>,
        responseBody: string,
        response: unknown,
    ): boolean | undefined {
        this.calls.push('handleErrors');
        const code = safeString(response, 'code');
        if (code === undefined) return undefined;
        const message = safeString(response, 'message');
        const feedback = `${this.id} ${responseBody}`;
        if (code === 'UNKNOWN_OUTCOME') throw new OrderOutcomeUnknown(feedback);
        this.throwExactlyMatchedException((this.exceptions as { exact?: Dictionary<any> }).exact, code, feedback, { detail: code });
        this.throwBroadlyMatchedException((this.exceptions as { broad?: Dictionary<any> }).broad, message, feedback);
        if (code === 'OK') return true;
        throw new ExchangeError(feedback);
    }

    override async fetchMarkets(params: Dict = {}): Promise<MarketInterface[]> {
        const response = await this.publicGetMarketAll(params);
        return this.parseMarkets(response);
    }

    override parseMarket(market: Dict): MarketInterface {
        const id = safeString(market, 'code') as string;
        return this.safeMarketStructure({
            id,
            symbol: `${id}/KRW`,
            base: id,
            quote: 'KRW',
            baseId: id,
            quoteId: 'KRW',
            type: 'spot',
            spot: true,
            active: true,
            precision: { amount: 1, price: 0.01 },
            info: market,
        });
    }

    override parseTicker(ticker: Dict, market: Market = undefined): Ticker {
        const marketId = safeString(ticker, 'code');
        const resolved = this.safeMarket(marketId, market);
        return this.safeTicker({
            symbol: resolved.symbol,
            timestamp: undefined,
            datetime: undefined,
            open: safeString(ticker, 'open'),
            close: safeString(ticker, 'close'),
            info: ticker,
        }, resolved);
    }

    override parseOrder(order: Dict, market: Market = undefined): Order {
        const resolved = this.safeMarket(safeString(order, 'code'), market);
        return this.safeOrder({
            id: safeString(order, 'id'),
            symbol: resolved.symbol,
            type: safeString(order, 'type'),
            side: safeString(order, 'side'),
            status: safeString(order, 'status'),
            price: safeString(order, 'price'),
            amount: safeString(order, 'amount'),
            filled: safeString(order, 'filled'),
            timestamp: safeValue(order, 'timestamp'),
            info: order,
        }, resolved);
    }

    override parseTrade(trade: Dict, market: Market = undefined): Trade {
        const resolved = this.safeMarket(safeString(trade, 'code'), market);
        return this.safeTrade({
            id: safeString(trade, 'id'),
            order: safeString(trade, 'order'),
            symbol: resolved.symbol,
            side: safeString(trade, 'side'),
            price: safeString(trade, 'price'),
            amount: safeString(trade, 'amount'),
            timestamp: safeValue(trade, 'timestamp'),
            fee: trade.fee,
            info: trade,
        }, resolved);
    }
}

// ============ 가짜 fetch ============

export type FetchStep = Response | Error | ((url: string, init: RequestInit) => Response | Promise<Response>);

export interface RecordedCall {
    url: string;
    init: RequestInit;
}

/** 전역 `fetch` 를 가짜로 바꾼다. 단계가 배열이면 호출 순서대로 쓰고 마지막 단계를 반복한다. */
export function stubFetch(steps: FetchStep | FetchStep[]): { calls: RecordedCall[]; impl: ReturnType<typeof vi.fn> } {
    const calls: RecordedCall[] = [];
    let index = 0;
    const impl = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const step = (Array.isArray(steps) ? steps[Math.min(index++, steps.length - 1)] : steps)!;
        if (step instanceof Error) throw step;
        if (typeof step === 'function') return step(url, init);
        return step.clone();
    });
    vi.stubGlobal('fetch', impl);
    return { calls, impl };
}

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, statusText: `status ${status}`, headers: { 'content-type': 'application/json' } });
}

export function text(body: string, status = 200): Response {
    return new Response(body, { status, statusText: `status ${status}` });
}

/** 요청이 끝나지 않는 `fetch` 단계. 취소 신호를 받으면 `AbortError` 로 끝난다. */
export function hanging(): FetchStep {
    return (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
}

/** 테스트용 종목 하나(`<id>/KRW` 현물, 수량 단위 1·호가 단위 0.01). */
export function marketOf(id: string, overrides: Dict = {}): MarketInterface {
    return new FakeExchange().safeMarketStructure({
        id,
        symbol: `${id}/KRW`,
        base: id,
        quote: 'KRW',
        baseId: id,
        quoteId: 'KRW',
        type: 'spot',
        spot: true,
        active: true,
        precision: { amount: 1, price: 0.01 },
        info: { code: id },
        ...overrides,
    });
}
