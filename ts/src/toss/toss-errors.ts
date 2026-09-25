/**
 * @fileoverview 토스증권 클래스가 쓰는 오류. 모두 ccxt 오류 계층의 하위 클래스라서 `catch (e) { if (e instanceof AuthenticationError) ... }` 처럼 받으면 된다.
 */

import { AuthenticationError, InvalidOrder, RateLimitExceeded, type BaseErrorOptions } from '../base/errors';

/**
 * 액세스 토큰을 브로커가 거절했다(401). 토스는 클라이언트 하나에 유효한 토큰이 하나뿐이라, 다른 프로세스가 새 토큰을 발급하면
 * 이 프로세스의 토큰이 무효가 된다. `failedToken` 은 거절된 요청이 실제로 쓴 토큰이며, 다시 인증할 때 캐시에 남은 새 토큰을 지우지 않는 데 쓴다.
 */
export class TossTokenRejected extends AuthenticationError {
    override name = 'TossTokenRejected';
    declare readonly failedToken: string | undefined;

    constructor(message: string, options: BaseErrorOptions = {}, failedToken?: string) {
        super(message, options);
        // 열거할 수 없게 둔다. 로거와 오류 수집기는 열거 가능한 속성을 모두 기록해서 토큰 원문이 밖으로 나간다.
        Object.defineProperty(this, 'failedToken', { value: failedToken, enumerable: false, writable: false });
    }
}

/** 호출 빈도 제한(429). `retryAfterMs` 는 `Retry-After` 헤더가 알려 준 대기 시간이다. */
export class TossRateLimited extends RateLimitExceeded {
    override name = 'TossRateLimited';
    readonly retryAfterMs: number | undefined;

    constructor(message: string, options: BaseErrorOptions = {}, retryAfterMs?: number) {
        super(message, options);
        this.retryAfterMs = retryAfterMs;
    }
}

/**
 * 주문 조건이 맞지 않아 요청을 보내지 않았다. 브로커가 거절한 것이 아니라 클래스가 보내기 전에 막았다는 점이 `InvalidOrder` 와 다르다
 * (조건주문 인자 오류, 확장세션 지정가를 만들 수 없는 경우 등).
 */
export class OrderNotSent extends InvalidOrder {
    override name = 'OrderNotSent';
}
