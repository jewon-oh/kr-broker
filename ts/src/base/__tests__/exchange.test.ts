/**
 * @fileoverview `Exchange` 베이스 클래스: 생성자 병합, 암묵 API, 요청 파이프라인, 오류 매핑, 재시도, 시간 초과, 속도 제한, 종목 로딩.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { Exchange } from '../Exchange';
import {
    AuthenticationError, BadSymbol, ArgumentsRequired, DDoSProtection, ExchangeError, ExchangeNotAvailable, InsufficientFunds, InvalidOrder, MarketClosed,
    NetworkError, NotSupported, NullResponse, OperationFailed, OrderNotFound, OrderOutcomeUnknown, RateLimitExceeded, RequestTimeout,
} from '../errors';
import { deepExtend } from '../functions/generic';
import type { Dict, MarketInterface, Order } from '../types';
import { FakeExchange, hanging, json, marketOf, stubFetch, text } from './support/fake-exchange';

const CREDENTIALS = { apiKey: 'key', secret: 'secret', uid: '12345678-01' };

const MARKET_ROWS = [{ code: '005930' }, { code: '000660' }];

/** 이 함수가 끝난 뒤의 전역 fetch 를 원래대로 돌린다. */
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('생성자', () => {
    it('describe() 위에 사용자 설정을 얹고, 일반 객체는 깊게 합친다', () => {
        const ex = new FakeExchange({
            timeout: 1234,
            apiKey: 'k',
            options: { extra: 1, tradingFeesByQuoteCurrency: { USD: 0.1 } },
            has: { fetchOrders: true },
        });
        expect(ex.id).toBe('fake');
        expect(ex.rateLimit).toBe(100); // describe 값
        expect(ex.timeout).toBe(1234); // 사용자 설정이 describe 를 이긴다
        expect(ex.apiKey).toBe('k');
        expect(ex.options).toEqual({ extra: 1, tradingFeesByQuoteCurrency: { KRW: 0.0015, USD: 0.1 } });
        expect(ex.has.fetchOrders).toBe(true);
        expect(ex.has.fetchMarkets).toBe(true); // describe 의 값이 부모의 값을 이긴다
        expect(ex.has.createLimitOrder).toBe('emulated'); // 부모의 값이 남는다
    });

    it('부모 describe 의 기본 키가 들어 있다', () => {
        const ex = new FakeExchange();
        expect(ex.precisionMode).toBe(4); // TICK_SIZE
        expect(ex.paddingMode).toBe(5); // NO_PADDING
        expect(ex.httpExceptions['429']).toBe(RateLimitExceeded);
        expect(ex.requiredCredentials).toEqual(expect.objectContaining({ apiKey: true, secret: true, uid: true, token: false }));
        expect(ex.status).toEqual({ status: 'ok' });
    });

    it('능력표는 부모가 실제로 하는 것만 적고 나머지는 밝히지 않는다', () => {
        class Bare extends Exchange {}
        const has = new Bare().has;
        expect(has.createLimitOrder).toBe('emulated');
        expect(has.createMarketOrder).toBe('emulated');
        expect(has.fetchTicker).toBeUndefined();
        expect(has.fetchOrderBook).toBeUndefined();
        expect(has.createOrder).toBeUndefined();
        expect(has.cancelOrder).toBeUndefined();
    });

    it('getDefaultOptions() 의 값 위에 describe().options 가 얹힌다', () => {
        class WithDefaults extends FakeExchange {
            override getDefaultOptions(): Dict {
                return { fromDefaults: true, tradingFeesByQuoteCurrency: { KRW: 1, EUR: 2 } };
            }
        }
        const ex = new WithDefaults({ options: { fromUser: true } });
        expect(ex.options).toEqual({
            fromDefaults: true,
            fromUser: true,
            tradingFeesByQuoteCurrency: { KRW: 0.0015, EUR: 2 },
        });
    });

    it('userConfig 의 원본 객체를 바꾸지 않는다', () => {
        const config = { options: { a: { b: 1 } } };
        const ex = new FakeExchange(config);
        ex.options.a.b = 2;
        expect(config.options.a.b).toBe(1);
    });

    it('describe() 의 값을 인스턴스 사이에서 공유하지 않는다', () => {
        const a = new FakeExchange();
        const b = new FakeExchange();
        a.options.mutated = true;
        a.urls.api.public = 'https://changed';
        expect(b.options.mutated).toBeUndefined();
        expect(b.urls.api.public).toBe('https://{hostname}/v1');
    });

    it('종목을 미리 넣어 두면 생성 직후부터 조회된다', () => {
        const ex = new FakeExchange({ markets: { '005930/KRW': marketOf('005930') } });
        expect(ex.market('005930/KRW').id).toBe('005930');
        expect(ex.symbols).toEqual(['005930/KRW']);
    });
});

describe('암묵 API 메서드', () => {
    it('api 트리에서 이름 규칙대로 메서드를 만든다', () => {
        const ex = new FakeExchange();
        for (const name of [
            'publicGetMarketAll',
            'publicGetTickerCode',
            'publicGetCandlesUnitCode',
            'privateGetAccounts',
            'privatePostOrders',
            'privateDeleteOrdersId',
            'traderPrivateGetV2Assets',
        ]) {
            expect(typeof ex[name], name).toBe('function');
        }
    });

    it('옛 배열 형식(경로 목록)과 숫자 비용도 받는다', () => {
        class Legacy extends Exchange {
            override describe(): Dict {
                return deepExtend(super.describe(), {
                    id: 'legacy',
                    urls: { api: { public: 'https://legacy.test' } },
                    api: { public: { get: ['status', 'time/now'], post: { 'a-b/c_d': 5 } } },
                });
            }
        }
        const ex = new Legacy();
        expect(typeof ex.publicGetStatus).toBe('function');
        expect(typeof ex.publicGetTimeNow).toBe('function');
        expect(typeof ex.publicPostABCD).toBe('function');
    });

    it('잎이 객체·숫자가 아니면 생성에서 NotSupported', () => {
        class Broken extends Exchange {
            override describe(): Dict {
                return deepExtend(super.describe(), { id: 'broken', api: { public: { get: { 'x': 'nope' } } } });
            }
        }
        expect(() => new Broken()).toThrow(NotSupported);
    });

    it('호출하면 경로의 {자리}를 params 로 채우고 남은 params 는 쿼리로 보낸다', async () => {
        const { calls } = stubFetch(json({ ok: 1 }));
        const ex = new FakeExchange();
        await ex.publicGetTickerCode({ code: '005930', foo: 'bar baz' });
        expect(calls[0].url).toBe('https://api.fake.test/v1/ticker/005930?foo=bar%20baz');
        expect(calls[0].init.method).toBe('GET');
        expect(calls[0].init.body).toBeUndefined();
        await ex.publicGetCandlesUnitCode({ unit: 1, code: 'X' });
        expect(calls[1].url).toBe('https://api.fake.test/v1/candles/1/X');
    });

    it('POST 는 JSON 본문으로, DELETE 는 쿼리로 보낸다', async () => {
        const { calls } = stubFetch(json({ ok: 1 }));
        const ex = new FakeExchange(CREDENTIALS);
        await ex.privatePostOrders({ code: '005930', side: 'buy' });
        expect(calls[0].url).toBe('https://api.fake.test/v1/orders');
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.body).toBe('{"code":"005930","side":"buy"}');
        expect((calls[0].init.headers as Dict)['Content-Type']).toBe('application/json');
        await ex.privateDeleteOrdersId({ id: 'abc' });
        expect(calls[1].url).toBe('https://api.fake.test/v1/orders/abc');
        expect(calls[1].init.method).toBe('DELETE');
    });

    it('api 이름이 두 단계면 배열로 넘어가고 비공개로 취급한다', async () => {
        const { calls } = stubFetch(json({ ok: 1 }));
        const ex = new FakeExchange(CREDENTIALS);
        await ex.traderPrivateGetV2Assets();
        expect(calls[0].url).toBe('https://api.fake.test/trader/v2/assets');
        expect(ex.calls).toContain('authenticate');
    });
});

describe('fetch2 파이프라인', () => {
    it('공개 호출: throttle → sign → fetch → handleErrors', async () => {
        const { impl } = stubFetch(json([]));
        const ex = new FakeExchange();
        impl.mockImplementationOnce(async () => {
            ex.calls.push('fetch');
            return json([]);
        });
        await ex.publicGetMarketAll();
        expect(ex.calls).toEqual(['throttle', 'sign', 'fetch', 'handleErrors']);
    });

    it('비공개 호출은 자격증명을 확인하고 authenticate 를 먼저 부른다', async () => {
        const { calls } = stubFetch(json({}));
        const ex = new FakeExchange(CREDENTIALS);
        await ex.privateGetAccounts();
        expect(ex.calls).toEqual(['authenticate', 'throttle', 'sign', 'handleErrors']);
        expect((calls[0].init.headers as Dict).Authorization).toBe('Bearer issued-token');
    });

    it('공개 호출에는 authenticate 를 부르지 않는다', async () => {
        stubFetch(json([]));
        const ex = new FakeExchange();
        await ex.publicGetMarketAll();
        expect(ex.calls).not.toContain('authenticate');
    });

    it('자격증명이 비면 요청을 보내기 전에 AuthenticationError', async () => {
        const { impl } = stubFetch(json({}));
        const ex = new FakeExchange({ apiKey: 'k', secret: 's' }); // uid 없음
        await expect(ex.privateGetAccounts()).rejects.toThrow(AuthenticationError);
        await expect(ex.privateGetAccounts()).rejects.toThrow('requires "uid" credential');
        expect(impl).not.toHaveBeenCalled();
        expect(ex.calls).not.toContain('authenticate');
    });

    it('checkRequiredCredentials: 채워지면 true, 비면 던지거나 false', () => {
        const ex = new FakeExchange({ apiKey: 'k', secret: 's', uid: '' });
        expect(ex.checkRequiredCredentials(false)).toBe(false);
        expect(() => ex.checkRequiredCredentials()).toThrow(AuthenticationError);
        ex.uid = '1';
        expect(ex.checkRequiredCredentials()).toBe(true);
        ex.requiredCredentials.uid = false;
        ex.uid = undefined;
        expect(ex.checkRequiredCredentials()).toBe(true);
    });

    it('호출 시점의 globalThis.fetch 를 읽는다', async () => {
        const ex = new FakeExchange();
        const first = stubFetch(json({ from: 'first' }));
        expect(await ex.publicGetMarketAll()).toEqual({ from: 'first' });
        const second = stubFetch(json({ from: 'second' }));
        expect(await ex.publicGetMarketAll()).toEqual({ from: 'second' });
        expect(first.calls).toHaveLength(1);
        expect(second.calls).toHaveLength(1);
    });

    it('fetch 가 없는 환경이면 NotSupported', async () => {
        vi.stubGlobal('fetch', undefined);
        await expect(new FakeExchange().publicGetMarketAll()).rejects.toThrow(NotSupported);
    });

    it('기본 헤더와 User-Agent 를 요청에 싣는다', async () => {
        const { calls } = stubFetch(json({}));
        const ex = new FakeExchange({ headers: { 'X-Team': 'a' }, userAgent: 'sample-agent' });
        await ex.publicGetMarketAll();
        expect(calls[0].init.headers).toEqual({ 'X-Team': 'a', 'User-Agent': 'sample-agent' });
    });

    it('응답 본문·헤더를 마지막 응답으로 남긴다', async () => {
        stubFetch(new Response('[{"code":"005930"}]', { status: 200, headers: { 'x-request-id': 'abc' } }));
        const ex = new FakeExchange();
        await ex.publicGetMarketAll();
        expect(ex.last_http_response).toBe('[{"code":"005930"}]');
        expect(ex.last_json_response).toEqual([{ code: '005930' }]);
        expect(ex.last_response_headers?.['X-Request-Id']).toBe('abc');
        expect(ex.last_request_url).toBe('https://api.fake.test/v1/market/all');
        expect(ex.last_request_method).toBe('GET');
    });

    it('JSON 이 아닌 본문은 원문 문자열로 돌려준다', async () => {
        stubFetch(text('plain text'));
        expect(await new FakeExchange().publicGetMarketAll()).toBe('plain text');
        stubFetch(text(''));
        expect(await new FakeExchange().publicGetMarketAll()).toBe('');
        stubFetch(text('{broken'));
        expect(await new FakeExchange().publicGetMarketAll()).toBe('{broken');
    });

    it('sign 을 override 하지 않은 기본 구현은 urls.api 가 없으면 ExchangeError', async () => {
        class Bare extends Exchange {
            override describe(): Dict {
                return deepExtend(super.describe(), { id: 'bare', api: { public: { get: { x: 1 } } } });
            }
        }
        await expect(new Bare().publicGetX()).rejects.toThrow(ExchangeError);
    });
});

describe('setSandboxMode', () => {
    it('urls.test 로 바꾸고 끄면 되돌린다', async () => {
        const { calls } = stubFetch(json([]));
        const ex = new FakeExchange();
        ex.setSandboxMode(true);
        expect(ex.isSandboxModeEnabled).toBe(true);
        expect(ex.urls.api.public).toBe('https://sandbox.fake.test/v1');
        await ex.publicGetMarketAll();
        expect(calls[0].url).toBe('https://sandbox.fake.test/v1/market/all');
        ex.setSandboxMode(false);
        expect(ex.isSandboxModeEnabled).toBe(false);
        expect(ex.urls.api.public).toBe('https://{hostname}/v1');
        expect(ex.urls.apiBackup).toBeUndefined();
        expect(ex.urls.test.public).toBe('https://sandbox.fake.test/v1'); // 원본은 남는다
    });

    it('생성 설정의 sandbox: true 와 options.sandbox 도 켠다', () => {
        expect(new FakeExchange({ sandbox: true }).urls.api.public).toBe('https://sandbox.fake.test/v1');
        expect(new FakeExchange({ options: { sandbox: true } }).urls.api.public).toBe('https://sandbox.fake.test/v1');
        expect(new FakeExchange({ sandbox: false }).urls.api.public).toBe('https://{hostname}/v1');
    });

    it('urls.test 가 없는 증권사는 NotSupported', () => {
        class NoSandbox extends Exchange {
            override describe(): Dict {
                return deepExtend(super.describe(), { id: 'nosandbox', urls: { api: 'https://real.test' } });
            }
        }
        expect(() => new NoSandbox().setSandboxMode(true)).toThrow(NotSupported);
        expect(() => new NoSandbox({ sandbox: true })).toThrow(NotSupported);
        expect(() => new NoSandbox().setSandboxMode(false)).not.toThrow();
    });

    it('urls.api 가 문자열이어도 바꾸고 되돌린다', () => {
        class Flat extends Exchange {
            override describe(): Dict {
                return deepExtend(super.describe(), { id: 'flat', urls: { api: 'https://real.test', test: 'https://test.test' } });
            }
        }
        const ex = new Flat();
        ex.setSandboxMode(true);
        expect(ex.urls.api).toBe('https://test.test');
        ex.setSandboxMode(false);
        expect(ex.urls.api).toBe('https://real.test');
    });
});

describe('오류 매핑', () => {
    it('exceptions.exact 는 완전 일치로, detail 을 실어 던진다', async () => {
        stubFetch(json({ code: 'E100', message: '잔고 부족' }));
        const ex = new FakeExchange(CREDENTIALS);
        const error = await ex.privateGetAccounts().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(InsufficientFunds);
        expect((error as InsufficientFunds).detail).toBe('E100');
        expect((error as Error).message).toContain('fake');
    });

    it('exact 는 부분 일치하지 않는다', async () => {
        stubFetch(json({ code: 'E1000', message: 'x' }));
        const ex = new FakeExchange(CREDENTIALS);
        const error = await ex.privateGetAccounts().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ExchangeError);
        expect(error).not.toBeInstanceOf(InsufficientFunds);
    });

    it('exact 표는 Object.prototype 의 이름(constructor·toString)에 걸리지 않는다', async () => {
        for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
            stubFetch(json({ code, message: 'x' }));
            const error = await new FakeExchange(CREDENTIALS).privateGetAccounts().catch((e: unknown) => e);
            expect(error, code).toBeInstanceOf(ExchangeError);
            expect((error as Error).name, code).toBe('ExchangeError');
        }
    });

    it('exceptions.broad 는 부분 일치이고 선언 순서대로 처음 맞는 키를 쓴다', async () => {
        const ex = new FakeExchange(CREDENTIALS);
        stubFetch(json({ code: 'E200', message: 'the order not found in closed market' }));
        expect(await ex.privateGetAccounts().catch((e: unknown) => e)).toBeInstanceOf(OrderNotFound);
        stubFetch(json({ code: 'E201', message: 'closed market until 09:00' }));
        expect(await ex.privateGetAccounts().catch((e: unknown) => e)).toBeInstanceOf(MarketClosed);
    });

    it('표에 없는 오류 코드는 ExchangeError 로 던진다(조용히 통과시키지 않는다)', async () => {
        stubFetch(json({ code: 'E999', message: 'something new' }));
        await expect(new FakeExchange(CREDENTIALS).privateGetAccounts()).rejects.toThrow(ExchangeError);
    });

    it('오류 봉투가 없으면 handleErrors 는 통과시킨다', async () => {
        stubFetch(json({ balance: 1 }));
        expect(await new FakeExchange(CREDENTIALS).privateGetAccounts()).toEqual({ balance: 1 });
    });

    it('findBroadlyMatchedKey 는 문자열이 없으면 undefined', () => {
        const ex = new FakeExchange();
        expect(ex.findBroadlyMatchedKey({ a: InsufficientFunds }, undefined)).toBeUndefined();
        expect(ex.findBroadlyMatchedKey({ a: InsufficientFunds, b: InvalidOrder }, 'xxbxx')).toBe('b');
    });

    describe('HTTP 상태 표', () => {
        const CASES: Array<[number, new (m: string) => Error]> = [
            [400, ExchangeNotAvailable],
            [401, AuthenticationError],
            [407, AuthenticationError],
            [408, RequestTimeout],
            [418, DDoSProtection],
            [422, ExchangeError],
            [429, RateLimitExceeded],
            [500, ExchangeNotAvailable],
            [502, ExchangeNotAvailable],
            [503, ExchangeNotAvailable],
            [504, RequestTimeout],
            [511, AuthenticationError],
        ];

        it.each(CASES)('%i 는 %o 로 매핑한다', async (status, ErrorClass) => {
            stubFetch(text('server says no', status));
            const error = await new FakeExchange().publicGetMarketAll().catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ErrorClass);
            const message = (error as Error).message;
            expect(message).toContain('fake GET https://api.fake.test/v1/market/all');
            expect(message).toContain(String(status));
            expect(message).toContain('server says no');
        });

        it('표에 없는 5xx(524)는 ExchangeNotAvailable 로 던진다', async () => {
            stubFetch(text('timeout', 524));
            expect(await new FakeExchange().publicGetMarketAll().catch((e: unknown) => e)).toBeInstanceOf(ExchangeNotAvailable);
        });

        it('표에 없는 상태(200·202·302)는 던지지 않는다', async () => {
            for (const status of [200, 202, 302]) {
                stubFetch(new Response('ok', { status }));
                expect(await new FakeExchange().publicGetMarketAll()).toBe('ok');
            }
        });

        it('handleErrors 가 먼저 돈다: 본문의 오류 코드가 상태보다 우선한다', async () => {
            stubFetch(json({ code: 'E100', message: 'x' }, 401));
            const ex = new FakeExchange(CREDENTIALS);
            expect(await ex.privateGetAccounts().catch((e: unknown) => e)).toBeInstanceOf(InsufficientFunds);
        });

        it('handleErrors 가 true 를 돌려주면 상태 표를 건너뛴다', async () => {
            stubFetch(json({ code: 'OK' }, 500));
            expect(await new FakeExchange().publicGetMarketAll()).toEqual({ code: 'OK' });
        });

        it('증권사가 httpExceptions 를 덮어쓰면 그것을 쓴다', async () => {
            stubFetch(text('bad', 400));
            const ex = new FakeExchange({ httpExceptions: { 400: InvalidOrder } });
            expect(await ex.publicGetMarketAll().catch((e: unknown) => e)).toBeInstanceOf(InvalidOrder);
        });
    });
});

describe('재시도', () => {
    it('조회는 OperationFailed 계열이면 maxRetriesOnFailure 번까지 다시 보낸다', async () => {
        const { calls } = stubFetch([text('down', 503), text('down', 503), json(MARKET_ROWS)]);
        const ex = new FakeExchange({ options: { maxRetriesOnFailure: 2 } });
        expect(await ex.publicGetMarketAll()).toEqual(MARKET_ROWS);
        expect(calls).toHaveLength(3);
    });

    it('횟수를 넘으면 마지막 오류를 던진다', async () => {
        const { calls } = stubFetch(text('down', 503));
        const ex = new FakeExchange({ options: { maxRetriesOnFailure: 1 } });
        await expect(ex.publicGetMarketAll()).rejects.toBeInstanceOf(ExchangeNotAvailable);
        expect(calls).toHaveLength(2);
    });

    it('기본은 재시도하지 않는다', async () => {
        const { calls } = stubFetch(text('down', 503));
        await expect(new FakeExchange().publicGetMarketAll()).rejects.toBeInstanceOf(ExchangeNotAvailable);
        expect(calls).toHaveLength(1);
    });

    it('params 로도 줄 수 있고, 요청 쿼리에는 새지 않는다', async () => {
        const { calls } = stubFetch([text('down', 503), json(MARKET_ROWS)]);
        const ex = new FakeExchange();
        expect(await ex.publicGetMarketAll({ maxRetriesOnFailure: 1, maxRetriesOnFailureDelay: 1 })).toEqual(MARKET_ROWS);
        expect(calls).toHaveLength(2);
        expect(calls[0].url).toBe('https://api.fake.test/v1/market/all');
        expect(calls[1].url).toBe('https://api.fake.test/v1/market/all');
    });

    it('재시도 사이에 maxRetriesOnFailureDelay 만큼 기다린다', async () => {
        vi.useFakeTimers();
        const { calls } = stubFetch([text('down', 503), json(MARKET_ROWS)]);
        const ex = new FakeExchange({ options: { maxRetriesOnFailure: 1, maxRetriesOnFailureDelay: 500 } });
        const result = ex.publicGetMarketAll();
        await vi.advanceTimersByTimeAsync(499);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toEqual(MARKET_ROWS);
        expect(calls).toHaveLength(2);
    });

    it('연결 실패(NetworkError)도 조회는 다시 보낸다', async () => {
        const { calls } = stubFetch([new TypeError('fetch failed'), json(MARKET_ROWS)]);
        const ex = new FakeExchange({ options: { maxRetriesOnFailure: 1 } });
        expect(await ex.publicGetMarketAll()).toEqual(MARKET_ROWS);
        expect(calls).toHaveLength(2);
    });

    it('거절(ExchangeError 계열)은 다시 보내지 않는다', async () => {
        for (const status of [401, 422]) {
            const { calls } = stubFetch(text('no', status));
            const ex = new FakeExchange({ options: { maxRetriesOnFailure: 3 } });
            await expect(ex.publicGetMarketAll()).rejects.toBeInstanceOf(ExchangeError);
            expect(calls, String(status)).toHaveLength(1);
        }
    });

    it('OrderOutcomeUnknown 은 OperationFailed 지만 재시도 대상이 아니다', async () => {
        const { calls } = stubFetch(json({ code: 'UNKNOWN_OUTCOME' }));
        const ex = new FakeExchange({ options: { maxRetriesOnFailure: 3 } });
        const error = await ex.publicGetMarketAll().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OperationFailed);
        expect(error).toBeInstanceOf(OrderOutcomeUnknown);
        expect(calls).toHaveLength(1);
    });

    it('MarketClosed 도 곧바로 다시 보내지 않는다', async () => {
        const { calls } = stubFetch(json({ code: 'E1', message: 'closed market' }));
        const ex = new FakeExchange({ options: { maxRetriesOnFailure: 3 } });
        expect(await ex.publicGetMarketAll().catch((e: unknown) => e)).toBeInstanceOf(MarketClosed);
        expect(calls).toHaveLength(1);
    });

    it('MarketClosed 는 OperationFailed 계열이 아니라 거절이므로 retryable 을 true 로 줘도 다시 보내지 않는다', async () => {
        class Eager extends FakeExchange {
            override handleErrors(...args: Parameters<FakeExchange['handleErrors']>): boolean | undefined {
                if (args[6] && (args[6] as Dict).code === 'MARKET_CLOSED_BUT_SOON') throw new MarketClosed('soon', { retryable: true });
                return super.handleErrors(...args);
            }
        }
        const { calls } = stubFetch(json({ code: 'MARKET_CLOSED_BUT_SOON' }));
        const ex = new Eager({ options: { maxRetriesOnFailure: 3 } });
        const error = await ex.publicGetMarketAll().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MarketClosed);
        expect(error).not.toBeInstanceOf(OperationFailed);
        expect(calls).toHaveLength(1);
    });

    it('증권사가 던진 오류의 retryable 을 true 로 주면 재시도한다(OperationFailed 계열 가운데 기본이 false 인 것)', async () => {
        class Eager extends FakeExchange {
            override handleErrors(...args: Parameters<FakeExchange['handleErrors']>): boolean | undefined {
                if (args[6] && (args[6] as Dict).code === 'SLOW_BUT_SAFE') throw new OrderOutcomeUnknown('slow', { retryable: true });
                return super.handleErrors(...args);
            }
        }
        const { calls } = stubFetch([json({ code: 'SLOW_BUT_SAFE' }), json(MARKET_ROWS)]);
        const ex = new Eager({ options: { maxRetriesOnFailure: 1 } });
        expect(await ex.publicGetMarketAll()).toEqual(MARKET_ROWS);
        expect(calls).toHaveLength(2);
    });

    describe('주문 요청', () => {
        it('증권사가 오류 코드로 거절한 5xx 는 확정된 거절이라 그대로 던지고 다시 보내지 않는다', async () => {
            const { calls } = stubFetch(json({ code: 'SVC_DOWN', message: 'x' }, 503));
            const ex = new FakeExchange({ ...CREDENTIALS, exceptions: { exact: { SVC_DOWN: ExchangeNotAvailable } }, options: { maxRetriesOnFailure: 3 } });
            const error = await ex.privatePostOrders({ code: '005930' }).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ExchangeNotAvailable);
            expect(error).not.toBeInstanceOf(OrderOutcomeUnknown);
            expect(calls).toHaveLength(1);
        });

        it('오류 코드 없이 상태만 5xx 면 앞단 뒤에서 접수됐을 수 있어 OrderOutcomeUnknown 이다', async () => {
            for (const status of [500, 502, 503, 524]) {
                const { calls } = stubFetch(text('<html>bad gateway</html>', status));
                const ex = new FakeExchange({ ...CREDENTIALS, options: { maxRetriesOnFailure: 3 } });
                const error = (await ex.privatePostOrders({ code: '005930' }).catch((e: unknown) => e)) as OrderOutcomeUnknown;
                expect(error).toBeInstanceOf(OrderOutcomeUnknown);
                expect(error.retryable).toBe(false);
                expect(error.cause).toBeInstanceOf(ExchangeNotAvailable);
                expect(calls).toHaveLength(1);
            }
        });

        it('오류 코드 없는 4xx 는 처리 전 거절이라 OrderOutcomeUnknown 이 아니다', async () => {
            stubFetch(text('bad', 400));
            const error = await new FakeExchange(CREDENTIALS).privatePostOrders({}).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ExchangeNotAvailable);
            expect(error).not.toBeInstanceOf(OrderOutcomeUnknown);
        });

        it('주문 응답이 2xx 인데 JSON 이 아니면 OrderOutcomeUnknown 이고, 빈 본문은 그대로 돌려준다', async () => {
            stubFetch(text('<html>점검 중</html>', 200));
            const error = (await new FakeExchange(CREDENTIALS).privatePostOrders({}).catch((e: unknown) => e)) as OrderOutcomeUnknown;
            expect(error).toBeInstanceOf(OrderOutcomeUnknown);
            expect(error.message).toContain('JSON 이 아니다');
            stubFetch(text('', 200));
            expect(await new FakeExchange(CREDENTIALS).privateDeleteOrdersId({ id: '1' })).toBe('');
        });

        it('params 로 재시도를 켜도 주문은 한 번만 보낸다', async () => {
            const { calls } = stubFetch(text('down', 503));
            const ex = new FakeExchange(CREDENTIALS);
            await expect(ex.privateDeleteOrdersId({ id: '1', maxRetriesOnFailure: 5 })).rejects.toBeInstanceOf(OrderOutcomeUnknown);
            expect(calls).toHaveLength(1);
        });

        it('접수 여부를 모르는 실패(504)는 OrderOutcomeUnknown 이고 원인을 cause 로 남긴다', async () => {
            const { calls } = stubFetch(text('gateway', 504));
            const ex = new FakeExchange({ ...CREDENTIALS, options: { maxRetriesOnFailure: 3 } });
            const error = (await ex.privatePostOrders({}).catch((e: unknown) => e)) as OrderOutcomeUnknown;
            expect(error).toBeInstanceOf(OrderOutcomeUnknown);
            expect(error).toBeInstanceOf(RequestTimeout);
            expect(error.retryable).toBe(false);
            expect(error.cause).toBeInstanceOf(RequestTimeout);
            expect(calls).toHaveLength(1);
        });

        it('연결이 끊기면 OrderOutcomeUnknown, 조회는 NetworkError', async () => {
            stubFetch(new TypeError('fetch failed'));
            const ex = new FakeExchange(CREDENTIALS);
            const order = (await ex.privatePostOrders({}).catch((e: unknown) => e)) as OrderOutcomeUnknown;
            expect(order).toBeInstanceOf(OrderOutcomeUnknown);
            expect(order.cause).toBeInstanceOf(NetworkError);
            const query = await ex.privateGetAccounts().catch((e: unknown) => e);
            expect(query).toBeInstanceOf(NetworkError);
            expect(query).not.toBeInstanceOf(OrderOutcomeUnknown);
        });

        it('증권사가 읽고 거절한 오류(429·MarketClosed)는 접수 미확정으로 바꾸지 않는다', async () => {
            const ex = new FakeExchange(CREDENTIALS);
            stubFetch(text('slow down', 429));
            expect(await ex.privatePostOrders({}).catch((e: unknown) => e)).toBeInstanceOf(RateLimitExceeded);
            stubFetch(json({ code: 'E1', message: 'closed market' }));
            const closed = await ex.privatePostOrders({}).catch((e: unknown) => e);
            expect(closed).toBeInstanceOf(MarketClosed);
            expect(closed).not.toBeInstanceOf(OrderOutcomeUnknown);
        });

        it('isOutcomeUnknown: 시간 초과와 전송 오류만 참이다', () => {
            const ex = new FakeExchange();
            expect(ex.isOutcomeUnknown(new RequestTimeout('x'))).toBe(true);
            expect(ex.isOutcomeUnknown(new OrderOutcomeUnknown('x'))).toBe(true);
            expect(ex.isOutcomeUnknown(new NetworkError('x'))).toBe(true);
            expect(ex.isOutcomeUnknown(new RateLimitExceeded('x'))).toBe(false);
            expect(ex.isOutcomeUnknown(new ExchangeNotAvailable('x'))).toBe(false);
            expect(ex.isOutcomeUnknown(new MarketClosed('x'))).toBe(false);
            expect(ex.isOutcomeUnknown(new InsufficientFunds('x'))).toBe(false);
            expect(ex.isOutcomeUnknown(new Error('x'))).toBe(false);
        });

        it('주문이 아닌 오류는 그대로 던진다(주문 요청이 아니면 바꾸지 않는다)', async () => {
            stubFetch(new TypeError('boom'));
            const error = await new FakeExchange().publicGetMarketAll().catch((e: unknown) => e);
            expect(error).toBeInstanceOf(NetworkError);
        });
    });
});

describe('시간 초과', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    async function settle<T>(promise: Promise<T>, advanceMs: number): Promise<unknown> {
        const outcome = promise.then((v) => v, (e: unknown) => e);
        await vi.advanceTimersByTimeAsync(advanceMs);
        return outcome;
    }

    it('조회가 timeout 안에 끝나지 않으면 RequestTimeout(주문 미확정이 아니다)', async () => {
        const { impl } = stubFetch(hanging());
        const ex = new FakeExchange();
        const promise = ex.publicGetMarketAll();
        let done = false;
        void promise.then(() => (done = true), () => (done = true));
        await vi.advanceTimersByTimeAsync(4999);
        expect(done).toBe(false);
        const error = await settle(promise, 1);
        expect(error).toBeInstanceOf(RequestTimeout);
        expect(error).not.toBeInstanceOf(OrderOutcomeUnknown);
        expect((error as Error).message).toContain('5000ms');
        expect(impl).toHaveBeenCalledTimes(1);
    });

    it('취소 신호를 무시하는 fetch 도 상한을 지킨다', async () => {
        stubFetch(() => new Promise<Response>(() => undefined));
        const error = await settle(new FakeExchange().publicGetMarketAll(), 5000);
        expect(error).toBeInstanceOf(RequestTimeout);
    });

    it('시간 초과 때 요청을 취소한다(AbortSignal)', async () => {
        const { calls } = stubFetch(hanging());
        await settle(new FakeExchange().publicGetMarketAll(), 5000);
        expect((calls[0].init.signal as AbortSignal).aborted).toBe(true);
    });

    it('응답 본문을 읽는 중에 멈춰도 상한이 적용된다', async () => {
        stubFetch(() => {
            const stalled = new Response(new ReadableStream({ start() { /* 본문이 끝나지 않는다 */ } }), { status: 200 });
            return stalled;
        });
        const error = await settle(new FakeExchange().publicGetMarketAll(), 5000);
        expect(error).toBeInstanceOf(RequestTimeout);
    });

    it('주문 요청의 시간 초과는 OrderOutcomeUnknown 이다', async () => {
        stubFetch(hanging());
        const ex = new FakeExchange(CREDENTIALS);
        const error = (await settle(ex.privatePostOrders({ code: '005930' }), 5000)) as OrderOutcomeUnknown;
        expect(error).toBeInstanceOf(OrderOutcomeUnknown);
        expect(error).toBeInstanceOf(RequestTimeout);
        expect(error.retryable).toBe(false);
        expect(error.cause).toBeInstanceOf(RequestTimeout);
    });

    it('orderTimeout 이 있으면 주문에는 그 값을, 조회에는 timeout 을 쓴다', async () => {
        stubFetch(hanging());
        const ex = new FakeExchange({ ...CREDENTIALS, orderTimeout: 20_000 });
        const order = ex.privatePostOrders({}); // 비용 3 이라 조회는 300ms 뒤에 나간다
        let orderDone = false;
        void order.then(() => (orderDone = true), () => (orderDone = true));
        const query = await settle(ex.privateGetAccounts(), 300 + 5000);
        expect(query).toBeInstanceOf(RequestTimeout);
        expect(orderDone).toBe(false);
        expect(await settle(order, 20_000 - 5300)).toBeInstanceOf(OrderOutcomeUnknown);
    });

    it('fetch 가 스스로 AbortError 를 던져도 RequestTimeout 이다', async () => {
        stubFetch(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        expect(await settle(new FakeExchange().publicGetMarketAll(), 0)).toBeInstanceOf(RequestTimeout);
    });

    it('끝난 요청은 타이머를 남기지 않는다', async () => {
        stubFetch(json([]));
        const ex = new FakeExchange({ rateLimit: 0 });
        await ex.publicGetMarketAll();
        expect(vi.getTimerCount()).toBe(0);
        stubFetch(text('x', 503));
        await ex.publicGetMarketAll().catch(() => undefined);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('속도 제한(throttle)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    function track<T>(promise: Promise<T>): { done: () => boolean } {
        let finished = false;
        void promise.then(() => (finished = true), () => (finished = true));
        return { done: () => finished };
    }

    it('앞 요청의 비용 × rateLimit 만큼 지난 뒤에 다음 요청이 나간다', async () => {
        const ex = new FakeExchange(); // rateLimit 100ms
        const first = track(ex.throttle(3));
        const second = track(ex.throttle(1));
        await vi.advanceTimersByTimeAsync(0);
        expect(first.done()).toBe(true);
        expect(second.done()).toBe(false);
        await vi.advanceTimersByTimeAsync(299);
        expect(second.done()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(second.done()).toBe(true);
    });

    it('벽시계(Date)가 고정돼 있어도 대기가 끝난다 — 요청 간격은 단조 시계로 잰다', async () => {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
        const ex = new FakeExchange(); // rateLimit 100ms
        const started = performance.now();

        await ex.throttle(1);
        await ex.throttle(1);
        await ex.throttle(1);

        expect(performance.now() - started).toBeGreaterThanOrEqual(90);
    });

    it('비용을 주지 않으면 1 이다', async () => {
        const ex = new FakeExchange();
        await ex.throttle();
        const second = track(ex.throttle());
        await vi.advanceTimersByTimeAsync(99);
        expect(second.done()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(second.done()).toBe(true);
    });

    it('쉬는 동안 토큰이 하나까지 쌓여 연달아 두 번은 바로 나가고 세 번째부터 기다린다', async () => {
        const ex = new FakeExchange();
        await vi.advanceTimersByTimeAsync(10_000);
        const results = [track(ex.throttle(1)), track(ex.throttle(1)), track(ex.throttle(1))];
        await vi.advanceTimersByTimeAsync(0);
        expect(results.map((r) => r.done())).toEqual([true, true, false]);
        await vi.advanceTimersByTimeAsync(100);
        expect(results[2].done()).toBe(true);
    });

    it('들어온 순서대로 나간다', async () => {
        const ex = new FakeExchange();
        const order: number[] = [];
        const runs = [3, 1, 2].map((cost, index) => ex.throttle(cost).then(() => order.push(index)));
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.all(runs);
        expect(order).toEqual([0, 1, 2]);
    });

    it('엔드포인트의 cost 가 fetch2 의 대기에 반영된다', async () => {
        const { calls } = stubFetch(json({}));
        const ex = new FakeExchange();
        void ex.publicGetTickerCode({ code: 'A' }); // cost 2
        void ex.publicGetMarketAll(); // cost 1
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(199);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toHaveLength(2);
    });

    it('enableRateLimit: false 면 기다리지 않는다', async () => {
        const { calls } = stubFetch(json({}));
        const ex = new FakeExchange({ enableRateLimit: false });
        void ex.publicGetTickerCode({ code: 'A' });
        void ex.publicGetTickerCode({ code: 'B' });
        void ex.publicGetTickerCode({ code: 'C' });
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(3);
        expect(ex.calls).not.toContain('throttle');
    });

    it('rateLimit 이 0 이면 기다리지 않는다', async () => {
        const ex = new FakeExchange({ rateLimit: 0 });
        const results = [1, 2, 3, 4].map(() => track(ex.throttle(5)));
        await vi.advanceTimersByTimeAsync(0);
        expect(results.every((r) => r.done())).toBe(true);
    });

    it('rateLimit 이 음수면 생성에서 ExchangeError', () => {
        expect(() => new FakeExchange({ rateLimit: -1 })).toThrow(ExchangeError);
    });

    it('엔드포인트의 bucket 은 자기 버킷의 한도로 기다리고 기본 버킷과 섞이지 않는다', async () => {
        const { calls } = stubFetch(json({}));
        const ex = new FakeExchange();
        void ex.publicGetSlowStatus(); // slow 버킷(1000ms)
        void ex.publicGetSlowStatus();
        void ex.publicGetMarketAll(); // 기본 버킷
        await vi.advanceTimersByTimeAsync(0);
        expect(calls.map((c) => c.url.split('/v1/')[1])).toEqual(['slow/status', 'market/all']);
        await vi.advanceTimersByTimeAsync(999);
        expect(calls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls.map((c) => c.url.split('/v1/')[1])).toEqual(['slow/status', 'market/all', 'slow/status']);
    });

    it('rateLimitBuckets 에 없는 bucket 이름은 ExchangeError(조용히 기본 한도로 넘어가지 않는다)', async () => {
        const { impl } = stubFetch(json({}));
        const ex = new FakeExchange();
        await expect(ex.publicGetBadBucket()).rejects.toThrow(ExchangeError);
        await expect(ex.publicGetBadBucket()).rejects.toThrow('nowhere');
        expect(impl).not.toHaveBeenCalled();
    });
});

describe('종목 로딩', () => {
    it('loadMarkets 가 fetchMarkets → setMarkets 로 색인을 만든다', async () => {
        stubFetch(json(MARKET_ROWS));
        const ex = new FakeExchange();
        const markets = await ex.loadMarkets();
        expect(Object.keys(markets)).toEqual(['005930/KRW', '000660/KRW']);
        expect(ex.symbols).toEqual(['000660/KRW', '005930/KRW']);
        expect(ex.ids).toEqual(['000660', '005930']);
        expect(ex.markets_by_id?.['005930']).toHaveLength(1);
        const market = ex.market('005930/KRW');
        expect(market).toEqual(expect.objectContaining({
            id: '005930',
            symbol: '005930/KRW',
            base: '005930',
            quote: 'KRW',
            type: 'spot',
            spot: true,
            swap: false,
            future: false,
            option: false,
            contract: false,
            taker: 0.0015, // 기본 수수료가 종목에 들어간다
            maker: 0.0015,
        }));
        expect(market.precision).toEqual(expect.objectContaining({ amount: 1, price: 0.01 }));
        expect(market.limits.amount).toEqual({ min: undefined, max: undefined });
        expect(market.info).toEqual({ code: '005930' });
    });

    it('통화 목록을 종목의 base·quote 에서 만든다', async () => {
        stubFetch(json(MARKET_ROWS));
        const ex = new FakeExchange();
        await ex.loadMarkets();
        expect(ex.codes).toEqual(['000660', '005930', 'KRW']);
        expect(ex.currencies.KRW).toEqual(expect.objectContaining({ id: 'KRW', code: 'KRW' }));
        expect(ex.currencies['005930'].precision).toBe(1); // 수량 단위
        expect(ex.currencies_by_id?.KRW.code).toBe('KRW');
    });

    it('동시에 여러 번 불러도 한 번만 받는다', async () => {
        const { impl } = stubFetch(json(MARKET_ROWS));
        const ex = new FakeExchange();
        const [a, b, c] = await Promise.all([ex.loadMarkets(), ex.loadMarkets(), ex.loadMarkets()]);
        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(impl).toHaveBeenCalledTimes(1);
        await ex.loadMarkets();
        expect(impl).toHaveBeenCalledTimes(1);
    });

    it('reload 는 다시 받는다', async () => {
        const { impl } = stubFetch([json(MARKET_ROWS), json([{ code: '035720' }])]);
        const ex = new FakeExchange();
        await ex.loadMarkets();
        await ex.loadMarkets(true);
        expect(impl).toHaveBeenCalledTimes(2);
        expect(ex.symbols).toEqual(['035720/KRW']);
    });

    it('받기에 실패하면 다음 호출이 다시 시도한다', async () => {
        stubFetch(text('down', 503));
        const ex = new FakeExchange();
        await expect(ex.loadMarkets()).rejects.toBeInstanceOf(ExchangeNotAvailable);
        stubFetch(json(MARKET_ROWS));
        expect(Object.keys(await ex.loadMarkets())).toHaveLength(2);
    });

    it('종목을 미리 넣어 두면 fetchMarkets 를 부르지 않는다', async () => {
        const { impl } = stubFetch(json(MARKET_ROWS));
        const ex = new FakeExchange({ markets: { '005930/KRW': marketOf('005930') } });
        await ex.loadMarkets();
        expect(impl).not.toHaveBeenCalled();
    });

    it('market(): 심볼 → id 순으로 찾고, 없으면 BadSymbol, 로드 전이면 ExchangeError', async () => {
        const ex = new FakeExchange();
        expect(() => ex.market('005930/KRW')).toThrow('markets not loaded');
        expect(() => ex.market('005930/KRW')).toThrow(ExchangeError);
        stubFetch(json(MARKET_ROWS));
        await ex.loadMarkets();
        expect(ex.market('005930/KRW').id).toBe('005930');
        expect(ex.market('005930').symbol).toBe('005930/KRW');
        expect(() => ex.market('999999/KRW')).toThrow(BadSymbol);
        expect(() => ex.market(undefined)).toThrow(ArgumentsRequired);
    });

    it('marketId·symbol·marketIds·marketSymbols', async () => {
        stubFetch(json(MARKET_ROWS));
        const ex = new FakeExchange();
        await ex.loadMarkets();
        expect(ex.marketId('000660/KRW')).toBe('000660');
        expect(ex.symbol('000660')).toBe('000660/KRW');
        expect(ex.marketIds(['005930/KRW', '000660/KRW'])).toEqual(['005930', '000660']);
        expect(ex.marketIds(undefined)).toBeUndefined();
        expect(ex.marketSymbols(['005930'])).toEqual(['005930/KRW']);
        expect(ex.marketSymbols(undefined)).toBeUndefined();
        expect(() => ex.marketSymbols(undefined, false)).toThrow(ArgumentsRequired);
        expect(() => ex.symbol(undefined)).toThrow(ArgumentsRequired);
    });

    it('safeSymbol·safeMarket: 로드한 종목이 우선, 없으면 구분자로 쪼개거나 인자를 쓴다', async () => {
        stubFetch(json(MARKET_ROWS));
        const ex = new FakeExchange();
        await ex.loadMarkets();
        expect(ex.safeSymbol('005930')).toBe('005930/KRW');
        expect(ex.safeSymbol('AAPL-USD', undefined, '-')).toBe('AAPL/USD');
        expect(ex.safeMarket('AAPL-USD', undefined, '-')).toEqual(expect.objectContaining({ baseId: 'AAPL', quoteId: 'USD', base: 'AAPL', quote: 'USD' }));
        expect(ex.safeSymbol('NOPE')).toBe('NOPE');
        expect(ex.safeSymbol(undefined, ex.market('005930/KRW'))).toBe('005930/KRW');
        expect(ex.safeSymbol('NOPE', ex.market('000660/KRW'))).toBe('000660/KRW');
        expect(ex.safeMarket(undefined).symbol).toBeUndefined();
    });

    it('같은 id 의 종목이 둘이면 marketType 으로 고르고, 없으면 spot 을 우선한다', () => {
        const spot = marketOf('X');
        const future = { ...marketOf('X'), symbol: 'X/KRW:KRW-260925', type: 'future', spot: false, future: true } as MarketInterface;
        const ex = new FakeExchange({ markets: { 'X/KRW:KRW-260925': future, 'X/KRW': spot } });
        expect(() => ex.safeMarket('X')).toThrow(ArgumentsRequired);
        expect(ex.safeMarket('X', undefined, undefined, 'future').symbol).toBe('X/KRW:KRW-260925');
        expect(ex.safeMarket('X', undefined, undefined, 'spot').symbol).toBe('X/KRW');
        expect(ex.safeMarket('X', spot).symbol).toBe('X/KRW');
        expect(ex.market('X').symbol).toBe('X/KRW');
        expect(ex.markets_by_id?.X.map((m) => m.symbol)).toEqual(['X/KRW', 'X/KRW:KRW-260925']);
    });

    it('종목에 id 가 없으면 setMarkets 가 ExchangeError', () => {
        const ex = new FakeExchange();
        expect(() => ex.setMarkets([{ ...marketOf('A'), id: undefined }])).toThrow(ExchangeError);
    });

    it('describe 에 적은 통화 정밀도는 종목에서 만든 값보다 우선한다', async () => {
        stubFetch(json(MARKET_ROWS));
        const ex = new FakeExchange({ currencies: { KRW: { id: 'KRW', code: 'KRW', precision: 1, info: undefined } } });
        await ex.loadMarkets();
        expect(ex.currencies.KRW.precision).toBe(1);
    });
});

describe('handleOptionAndParams', () => {
    it('params → options[메서드] → options → 기본값 순으로 찾는다', () => {
        const ex = new FakeExchange({ options: { flag: 'global', fetchThing: { flag: 'method' } } });
        expect(ex.handleOptionAndParams({ flag: 'param', keep: 1 }, 'fetchThing', 'flag', 'dflt')).toEqual(['param', { keep: 1 }]);
        expect(ex.handleOptionAndParams({ keep: 1 }, 'fetchThing', 'flag', 'dflt')).toEqual(['method', { keep: 1 }]);
        expect(ex.handleOptionAndParams({ keep: 1 }, 'otherMethod', 'flag', 'dflt')).toEqual(['global', { keep: 1 }]);
        expect(ex.handleOptionAndParams({}, 'otherMethod', 'unset', 'dflt')).toEqual(['dflt', {}]);
        expect(ex.handleOptionAndParams({}, 'otherMethod', 'unset')).toEqual([undefined, {}]);
    });

    it('defaultXxx 이름도 함께 본다', () => {
        const ex = new FakeExchange({ options: { defaultMode: 'opt' } });
        expect(ex.handleOptionAndParams({}, 'm', 'mode', 'dflt')[0]).toBe('opt');
        expect(ex.handleOptionAndParams({ defaultMode: 'p' }, 'm', 'mode', 'dflt')).toEqual(['p', {}]);
    });

    it('입력 params 를 바꾸지 않는다', () => {
        const params = { flag: 'param' };
        new FakeExchange().handleOptionAndParams(params, 'm', 'flag');
        expect(params).toEqual({ flag: 'param' });
    });
});

describe('통합 메서드 기본 구현', () => {
    const NOT_SUPPORTED_CALLS: Array<[string, (ex: Exchange) => Promise<unknown>]> = [
        ['fetchTime', (ex) => ex.fetchTime()],
        ['fetchStatus', (ex) => ex.fetchStatus()],
        ['fetchTicker', (ex) => ex.fetchTicker('A/KRW')],
        ['fetchTickers', (ex) => ex.fetchTickers()],
        ['fetchOrderBook', (ex) => ex.fetchOrderBook('A/KRW')],
        ['fetchOHLCV', (ex) => ex.fetchOHLCV('A/KRW')],
        ['fetchBalance', (ex) => ex.fetchBalance()],
        ['createOrder', (ex) => ex.createOrder('A/KRW', 'limit', 'buy', 1, 100)],
        ['editOrder', (ex) => ex.editOrder('1', 'A/KRW', 'limit', 'buy', 1, 100)],
        ['createTriggerOrder', (ex) => ex.createTriggerOrder('A/KRW', 'limit', 'buy', 1, 100, 90)],
        ['cancelOrder', (ex) => ex.cancelOrder('1')],
        ['cancelAllOrders', (ex) => ex.cancelAllOrders()],
        ['fetchOrder', (ex) => ex.fetchOrder('1')],
        ['fetchOrders', (ex) => ex.fetchOrders()],
        ['fetchOpenOrders', (ex) => ex.fetchOpenOrders()],
        ['fetchClosedOrders', (ex) => ex.fetchClosedOrders()],
        ['fetchCanceledOrders', (ex) => ex.fetchCanceledOrders()],
        ['fetchMyTrades', (ex) => ex.fetchMyTrades()],
        ['fetchTradingFee', (ex) => ex.fetchTradingFee('A/KRW')],
    ];

    it.each(NOT_SUPPORTED_CALLS)('%s 는 NotSupported 를 던진다', async (name, call) => {
        const ex = new FakeExchange();
        const error = await call(ex).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotSupported);
        expect((error as Error).message).toContain(`fake ${name}()`);
    });

    it('createLimit*·createMarket* 은 createOrder 로 위임한다', async () => {
        class Recording extends FakeExchange {
            recorded: unknown[][] = [];
            override async createOrder(symbol: string, type: string, side: string, amount: number, price?: number, params: Dict = {}): Promise<Order> {
                this.recorded.push([symbol, type, side, amount, price, params]);
                return {} as Order;
            }
        }
        const ex = new Recording();
        await ex.createLimitOrder('A/KRW', 'buy', 1, 100, { tif: 'day' });
        await ex.createMarketOrder('A/KRW', 'sell', 2);
        await ex.createLimitBuyOrder('A/KRW', 3, 300);
        await ex.createLimitSellOrder('A/KRW', 4, 400);
        await ex.createMarketBuyOrder('A/KRW', 5);
        await ex.createMarketSellOrder('A/KRW', 6, { x: 1 });
        expect(ex.recorded).toEqual([
            ['A/KRW', 'limit', 'buy', 1, 100, { tif: 'day' }],
            ['A/KRW', 'market', 'sell', 2, undefined, {}],
            ['A/KRW', 'limit', 'buy', 3, 300, {}],
            ['A/KRW', 'limit', 'sell', 4, 400, {}],
            ['A/KRW', 'market', 'buy', 5, undefined, {}],
            ['A/KRW', 'market', 'sell', 6, undefined, { x: 1 }],
        ]);
    });

    it('fetchTicker 는 has.fetchTickers 가 있으면 fetchTickers 로 대신한다', async () => {
        class WithTickers extends FakeExchange {
            override async fetchTickers(symbols?: string[]): Promise<Record<string, any>> {
                return symbols?.[0] === '005930/KRW' ? { '005930/KRW': { symbol: '005930/KRW', last: 1 } } : {};
            }
        }
        stubFetch(json(MARKET_ROWS));
        const ex = new WithTickers({ has: { fetchTickers: true } });
        expect(await ex.fetchTicker('005930')).toEqual({ symbol: '005930/KRW', last: 1 });
        await expect(ex.fetchTicker('000660')).rejects.toBeInstanceOf(NullResponse);
    });

    it('fetchOpenOrders·fetchClosedOrders 는 has.fetchOrders 가 있으면 fetchOrders 결과를 거른다', async () => {
        class WithOrders extends FakeExchange {
            override async fetchOrders(): Promise<Order[]> {
                return [{ id: '1', status: 'open' }, { id: '2', status: 'closed' }, { id: '3', status: 'canceled' }, { id: '4', status: 'open' }] as Order[];
            }
        }
        const ex = new WithOrders({ has: { fetchOrders: true } });
        expect((await ex.fetchOpenOrders()).map((o) => o.id)).toEqual(['1', '4']);
        expect((await ex.fetchClosedOrders()).map((o) => o.id)).toEqual(['2']);
    });

    it('checkOrderArguments: 방향·종류·가격·수량을 검사한다', () => {
        const ex = new FakeExchange();
        expect(() => ex.checkOrderArguments(undefined, 'limit', 'buy', 1, 100)).not.toThrow();
        expect(() => ex.checkOrderArguments(undefined, 'market', 'sell', 1, undefined)).not.toThrow();
        expect(() => ex.checkOrderArguments(undefined, 'limit', 'hold', 1, 100)).toThrow(InvalidOrder);
        expect(() => ex.checkOrderArguments(undefined, 'stop', 'buy', 1, 100)).toThrow(InvalidOrder);
        expect(() => ex.checkOrderArguments(undefined, 'limit', 'buy', 1, undefined)).toThrow(ArgumentsRequired);
        expect(() => ex.checkOrderArguments(undefined, 'limit', 'buy', 0, 100)).toThrow(ArgumentsRequired);
        expect(() => ex.checkOrderArguments(undefined, 'limit', 'buy', -1, 100)).toThrow(ArgumentsRequired);
        expect(() => ex.checkOrderArguments(undefined, 'limit', 'buy', NaN, 100)).toThrow(ArgumentsRequired);
        expect(() => ex.checkOrderArguments(undefined, 'limit', 'buy', undefined, 100)).toThrow(ArgumentsRequired);
    });
});
