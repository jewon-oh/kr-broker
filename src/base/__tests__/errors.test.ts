/**
 * @fileoverview 오류 계층: 상속 관계, `name`, `instanceof`, 선택 필드.
 */

import { describe, it, expect } from 'vitest';

import * as errors from '../errors';
import {
    AccountNotEnabled, AccountSuspended, ArgumentsRequired, AuthenticationError, BadRequest, BadResponse, BadSymbol, BaseError, DDoSProtection,
    DuplicateOrderId, ExchangeError, ExchangeNotAvailable, InsufficientFunds, InvalidOrder, ManualInteractionNeeded, MarketClosed, NetworkError,
    NoChange, NotSupported, NullResponse, OnMaintenance, OperationFailed, OperationRejected, OrderNotFound, OrderOutcomeUnknown, PermissionDenied,
    RateLimitExceeded, RequestTimeout,
} from '../errors';

type ErrorCtor = new (message: string) => BaseError;

/** [클래스, 부모] 쌍. 트리 전체를 한 번에 고정한다. */
const TREE: Array<[ErrorCtor, ErrorCtor]> = [
    [ExchangeError, BaseError],
    [AuthenticationError, ExchangeError],
    [PermissionDenied, AuthenticationError],
    [AccountNotEnabled, PermissionDenied],
    [AccountSuspended, AuthenticationError],
    [ArgumentsRequired, ExchangeError],
    [BadRequest, ExchangeError],
    [BadSymbol, BadRequest],
    [OperationRejected, ExchangeError],
    [NoChange, OperationRejected],
    [ManualInteractionNeeded, OperationRejected],
    [InsufficientFunds, ExchangeError],
    [InvalidOrder, ExchangeError],
    [OrderNotFound, InvalidOrder],
    [DuplicateOrderId, InvalidOrder],
    [NotSupported, ExchangeError],
    [OperationFailed, BaseError],
    [NetworkError, OperationFailed],
    [DDoSProtection, NetworkError],
    [RateLimitExceeded, NetworkError],
    [ExchangeNotAvailable, NetworkError],
    [OnMaintenance, ExchangeNotAvailable],
    [MarketClosed, OperationRejected],
    [RequestTimeout, NetworkError],
    [OrderOutcomeUnknown, RequestTimeout],
    [BadResponse, OperationFailed],
    [NullResponse, BadResponse],
];

describe('오류 계층', () => {
    it.each(TREE.map(([Ctor, Parent]) => [Ctor.name, Ctor, Parent] as const))('%s 는 부모 클래스의 하위이고 name 이 클래스 이름이다', (_name, Ctor, Parent) => {
        const error = new Ctor('message');
        expect(error).toBeInstanceOf(Ctor);
        expect(error).toBeInstanceOf(Parent);
        expect(error).toBeInstanceOf(BaseError);
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe(Ctor.name);
        expect(error.message).toBe('message');
        expect(Object.getPrototypeOf(error)).toBe(Ctor.prototype);
    });

    it('BaseError 의 name 도 클래스 이름이다', () => {
        expect(new BaseError('x').name).toBe('BaseError');
    });

    it('거절(ExchangeError)과 일시 장애(OperationFailed)는 서로의 하위가 아니다', () => {
        expect(new InsufficientFunds('x')).not.toBeInstanceOf(OperationFailed);
        expect(new RateLimitExceeded('x')).not.toBeInstanceOf(ExchangeError);
        expect(new NotSupported('x')).not.toBeInstanceOf(NetworkError);
    });

    it('내보내는 모든 오류 클래스가 트리에 들어 있다', () => {
        const exported = Object.entries(errors)
            .filter(([, value]) => typeof value === 'function')
            .map(([name]) => name)
            .sort();
        const inTree = new Set(['BaseError', ...TREE.map(([Ctor]) => Ctor.name)]);
        expect(exported).toEqual([...inTree].sort());
    });

    it('detail·retryable·cause 는 선택 필드다', () => {
        const cause = new Error('원인');
        const error = new ExchangeError('m', { detail: 'PRICE_INVALID', retryable: false, cause });
        expect(error.detail).toBe('PRICE_INVALID');
        expect(error.retryable).toBe(false);
        expect(error.cause).toBe(cause);
        const plain = new ExchangeError('m');
        expect(plain.detail).toBeUndefined();
        expect(plain.retryable).toBeUndefined();
        expect(plain.cause).toBeUndefined();
    });

    it('MarketClosed 와 OrderOutcomeUnknown 은 다시 보내면 안 되는 오류로 시작한다', () => {
        expect(new MarketClosed('x').retryable).toBe(false);
        expect(new OrderOutcomeUnknown('x').retryable).toBe(false);
        expect(new NetworkError('x').retryable).toBeUndefined();
    });

    it('MarketClosed·OrderOutcomeUnknown 의 retryable 은 호출한 쪽이 바꿀 수 있다', () => {
        expect(new MarketClosed('x', { retryable: true }).retryable).toBe(true);
        expect(new OrderOutcomeUnknown('x', { detail: 'TIMEOUT' }).detail).toBe('TIMEOUT');
    });

    it('MarketClosed 는 ccxt 와 같이 OperationRejected 아래에 있다 — 일시 장애(OperationFailed·NetworkError)가 아니라 거절이다', () => {
        const error = new MarketClosed('x');
        expect(error).toBeInstanceOf(OperationRejected);
        expect(error).toBeInstanceOf(ExchangeError);
        expect(error).not.toBeInstanceOf(OperationFailed);
        expect(error).not.toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(ExchangeNotAvailable);
        expect(Object.getPrototypeOf(MarketClosed.prototype)).toBe(OperationRejected.prototype);
    });

    it('OrderOutcomeUnknown 은 시간 초과이기도 하다', () => {
        const error = new OrderOutcomeUnknown('x');
        expect(error).toBeInstanceOf(RequestTimeout);
        expect(error).toBeInstanceOf(OperationFailed);
        expect(error).not.toBeInstanceOf(MarketClosed);
    });

    it('스택과 toString 에 클래스 이름이 실린다', () => {
        const error = new OrderNotFound('주문이 없다');
        expect(String(error)).toBe('OrderNotFound: 주문이 없다');
        expect(error.stack).toContain('OrderNotFound');
    });

    it('catch 에서 instanceof 로 가른다', () => {
        const classify = (e: unknown): string => {
            if (e instanceof OrderOutcomeUnknown) return 'unknown';
            if (e instanceof RequestTimeout) return 'timeout';
            if (e instanceof OperationFailed) return 'transient';
            if (e instanceof ExchangeError) return 'rejected';
            return 'other';
        };
        expect(classify(new OrderOutcomeUnknown('x'))).toBe('unknown');
        expect(classify(new RequestTimeout('x'))).toBe('timeout');
        expect(classify(new ExchangeNotAvailable('x'))).toBe('transient');
        expect(classify(new MarketClosed('x'))).toBe('rejected');
        expect(classify(new BadSymbol('x'))).toBe('rejected');
        expect(classify(new Error('x'))).toBe('other');
    });
});
