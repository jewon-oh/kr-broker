/**
 * @fileoverview 오류 매핑: 토스의 오류 코드와 HTTP 상태가 ccxt 오류 계층으로 옮겨지는지, 시간 초과와 429 를 어떻게 다루는지.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    AccountNotEnabled, AuthenticationError, BadRequest, BadSymbol, DuplicateOrderId, ExchangeError, ExchangeNotAvailable,
    InsufficientFunds, InvalidOrder, ManualInteractionNeeded, MarketClosed, NetworkError, OnMaintenance, OperationRejected, OrderNotFound,
    OrderOutcomeUnknown, PermissionDenied, RateLimitExceeded, RequestTimeout,
    type ErrorClass,
} from '../../base';
import { TossRateLimited, TossTokenRejected } from '../toss-errors';
import { errorReply, installFakeToss, jsonOk, makeToss, networkFailure, tokenOk } from './support/toss-fake';

afterEach(() => {
    vi.useRealTimers();
});

/** 조회 하나를 보내 그 오류를 받는다. */
async function thrown(status: number, body: unknown): Promise<Error & { detail?: string }> {
    installFakeToss({ 'GET /api/v1/prices': { status, body } });
    const error = await makeToss().fetchTicker('005930').catch((e: unknown) => e);
    return error as Error & { detail?: string };
}

describe('오류 코드 → 오류 클래스', () => {
    const cases: Array<[number, string, ErrorClass]> = [
        [400, 'invalid-request', BadRequest],
        [400, 'confirm-high-value-required', InvalidOrder],
        [400, 'account-header-required', BadRequest],
        [400, 'unsupported-symbol', BadSymbol],
        [403, 'forbidden', PermissionDenied],
        [404, 'stock-not-found', BadSymbol],
        [404, 'account-not-found', AuthenticationError],
        [404, 'order-not-found', OrderNotFound],
        [404, 'conditional-order-not-found', OrderNotFound],
        [409, 'already-filled', OrderNotFound],
        [409, 'already-processing', OperationRejected],
        [409, 'opposite-pending-order-exists', InvalidOrder],
        [409, 'request-in-progress', OrderOutcomeUnknown],
        [422, 'insufficient-buying-power', InsufficientFunds],
        [422, 'insufficient-sellable-quantity', InsufficientFunds],
        [422, 'order-hours-closed', MarketClosed],
        [422, 'amount-order-outside-regular-hours', MarketClosed],
        [422, 'fractional-quantity-outside-regular-hours', MarketClosed],
        [422, 'stock-restricted', InvalidOrder],
        [422, 'price-out-of-range', InvalidOrder],
        [422, 'order-type-not-allowed', InvalidOrder],
        [422, 'max-order-amount-exceeded', InvalidOrder],
        [422, 'idempotency-key-conflict', DuplicateOrderId],
        [422, 'account-restricted', AccountNotEnabled],
        [422, 'prerequisite-required', ManualInteractionNeeded],
        [422, 'cancel-restricted', OperationRejected],
        [500, 'internal-error', ExchangeNotAvailable],
        [500, 'maintenance', OnMaintenance],
    ];

    it.each(cases)('%i %s', async (status, code, ErrorType) => {
        const error = await thrown(status, { error: { code, message: '거절' } });
        expect(error).toBeInstanceOf(ErrorType);
        // 토스의 오류 코드는 detail 에 남는다.
        expect(error.detail).toBe(code);
    });

    it('오류 값이 { error: "코드" } 문자열이어도 같다', async () => {
        const error = await thrown(422, { error: 'stock-restricted', error_description: '거래 정지' });
        expect(error).toBeInstanceOf(InvalidOrder);
        expect(error.detail).toBe('stock-restricted');
    });

    it('메시지에 상태와 본문을 담는다', async () => {
        const error = await thrown(422, { error: { code: 'stock-restricted', message: '거래 정지' } });
        expect(error.message).toContain('토스 API 오류: 422');
        expect(error.message).toContain('거래 정지');
    });

    it('표에 없는 코드는 추측하지 않는다. 422 는 ExchangeError 다', async () => {
        const error = await thrown(422, { error: { code: 'something-new', message: '새 오류' } });
        expect(error).toBeInstanceOf(ExchangeError);
        expect(error.constructor).toBe(ExchangeError);
        expect(error.detail).toBe('something-new');
    });

    it('JSON 이 아닌 본문도 상태로 옮긴다', async () => {
        const error = await thrown(502, '<html>bad gateway</html>');
        expect(error).toBeInstanceOf(ExchangeNotAvailable);
        expect(error.detail).toBeUndefined();
    });

    it('200 으로 온 비즈니스 오류도 던진다', async () => {
        const error = await thrown(200, { error: 'max-order-amount-exceeded', error_description: '주문금액 초과' });
        expect(error).toBeInstanceOf(InvalidOrder);
        expect(error.message).toBe('토스 API 비즈니스 오류 [max-order-amount-exceeded]: 주문금액 초과');
    });

    it('호가 단위를 어긴 주문은 InvalidOrder 로 옮기고 detail 에 표시한다', async () => {
        const error = await thrown(400, { error: { code: 'invalid-request', message: '호가 단위', data: { tickSize: '100', nearestPrices: ['70000', '70100'] } } });
        expect(error).toBeInstanceOf(InvalidOrder);
        expect(error.detail).toBe('price-tick-invalid');
        expect(error.message).toContain('tickSize');
    });

    it('403 은 코드와 상관없이 PermissionDenied 다. 상태가 앞선다', async () => {
        expect(await thrown(403, { error: { code: 'edge-blocked' } })).toBeInstanceOf(PermissionDenied);
        expect(await thrown(403, '{}')).toBeInstanceOf(PermissionDenied);
    });
});

describe('토큰 거절과 재인증', () => {
    it('401 이면 그 토큰만 무효로 만들고 한 번 다시 보낸다', async () => {
        let call = 0;
        let issued = 0;
        const fake = installFakeToss(
            {
                'GET /api/v1/prices': (request) => {
                    call += 1;
                    return call === 1 ? errorReply(401, 'token-revoked') : (request.headers.Authorization === 'Bearer tok-2' ? jsonOk([{ symbol: '005930', lastPrice: '1' }]) : errorReply(401, 'token-revoked'));
                },
            },
            () => tokenOk(`tok-${++issued}`),
        );
        const ticker = await makeToss().fetchTicker('005930');
        expect(ticker.last).toBe(1);
        expect(fake.requestsTo('GET /api/v1/prices')).toHaveLength(2);
        expect(fake.requestsTo('POST /oauth2/token')).toHaveLength(2);
    });

    it('다시 보내도 401 이면 그대로 던진다(무한 반복하지 않는다)', async () => {
        const fake = installFakeToss({ 'GET /api/v1/prices': errorReply(401, 'token-revoked') });
        const error = await makeToss().fetchTicker('005930').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TossTokenRejected);
        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as Error).message).toContain('토스 API 오류: 401');
        expect(fake.requestsTo('GET /api/v1/prices')).toHaveLength(2);
    });

    it('자격증명이 없으면 요청 없이 AuthenticationError', async () => {
        const fake = installFakeToss({});
        await expect(makeToss({ apiKey: undefined }).fetchTicker('005930')).rejects.toBeInstanceOf(AuthenticationError);
        expect(fake.requests(true)).toHaveLength(0);
    });

    it('토큰 발급이 실패하면 AuthenticationError 다', async () => {
        installFakeToss({}, { status: 401, body: 'invalid_client' });
        const error = await makeToss().fetchTicker('005930').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as Error).message).toContain('토스 토큰 발급 실패');
    });
});

describe('시간 초과와 연결 오류', () => {
    it('조회의 연결 오류는 NetworkError 이고 주문이 아니라서 미확정이 아니다', async () => {
        installFakeToss({ 'GET /api/v1/prices': () => networkFailure('ECONNRESET') });
        const error = await makeToss().fetchTicker('005930').catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(OrderOutcomeUnknown);
        expect(error).toBeInstanceOf(NetworkError);
    });

    it('조회는 상한 시간 안에 끝나지 않으면 RequestTimeout 이다', async () => {
        globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })) as unknown as typeof fetch;
        const error = await makeToss({ timeout: 30, options: { authTimeout: 30 } }).fetchTicker('005930').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RequestTimeout);
    });

    it('주문은 조회와 다른 상한을 쓰고, 넘으면 미확정이다', async () => {
        const reply = (body: unknown): unknown => ({ status: 200, statusText: '', headers: new Headers(), text: async () => JSON.stringify(body) });
        const calendar = { result: { today: { date: '2026-08-03', integrated: { preMarket: null, afterMarket: null, regularMarket: { startTime: new Date(Date.now() - 3_600_000).toISOString(), endTime: new Date(Date.now() + 3_600_000).toISOString() } } } } };
        globalThis.fetch = ((url: string, init?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
            if (String(url).endsWith('/oauth2/token')) return resolve(reply(tokenOk().body));
            if (String(url).endsWith('/market-calendar/KR')) return resolve(reply(calendar));
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })) as unknown as typeof fetch;
        const exchange = makeToss({ timeout: 5_000, orderTimeout: 30 });
        const error = await exchange.createOrder('005930', 'limit', 'buy', 1, 70000).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OrderOutcomeUnknown);
        expect(error).toBeInstanceOf(RequestTimeout);
    });
});

describe('호출 빈도 제한(429)', () => {
    it('TossRateLimited 로 던지고 Retry-After 를 밀리초로 싣는다', async () => {
        installFakeToss({ 'GET /api/v1/prices': { status: 429, body: { error: { code: 'rate-limit-exceeded' } }, headers: { 'Retry-After': '2' } } });
        const error = await makeToss().fetchTicker('005930').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RateLimitExceeded);
        expect((error as TossRateLimited).retryAfterMs).toBe(2000);
    });

    it('429 를 받은 그룹은 쉬라고 한 시간이 지날 때까지 다음 요청을 늦춘다', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        let call = 0;
        const fake = installFakeToss({
            'GET /api/v1/prices': () => (++call === 1
                ? { status: 429, body: { error: { code: 'rate-limit-exceeded' } }, headers: { 'Retry-After': '2' } }
                : jsonOk([{ symbol: '005930', lastPrice: '1' }])),
        });
        // 그룹 한도로는 기다리지 않고, 429 뒤의 휴식만 관찰한다.
        const exchange = makeToss({ enableRateLimit: true, rateLimit: 0, rateLimitBuckets: { market_data: { rateLimit: 0 }, auth: { rateLimit: 0 } } });
        await exchange.fetchTicker('005930').catch(() => undefined);
        const started = Date.now();
        const next = exchange.fetchTicker('005930');
        await vi.advanceTimersByTimeAsync(1_900);
        expect(fake.requestsTo('GET /api/v1/prices')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(300);
        await next;
        expect(fake.requestsTo('GET /api/v1/prices')).toHaveLength(2);
        expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    });

    it('조회는 maxRetriesOnFailure 만큼 다시 보낸다(일시 장애만)', async () => {
        let call = 0;
        const fake = installFakeToss({ 'GET /api/v1/prices': () => (++call < 3 ? errorReply(502, 'internal-error') : jsonOk([{ symbol: '005930', lastPrice: '1' }])) });
        await makeToss({ options: { maxRetriesOnFailure: 3 } }).fetchTicker('005930');
        expect(fake.requestsTo('GET /api/v1/prices')).toHaveLength(3);
    });

    it('MarketClosed 는 재시도하지 않는다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/prices': errorReply(422, 'order-hours-closed') });
        await makeToss({ options: { maxRetriesOnFailure: 3 } }).fetchTicker('005930').catch(() => undefined);
        expect(fake.requestsTo('GET /api/v1/prices')).toHaveLength(1);
    });
});
