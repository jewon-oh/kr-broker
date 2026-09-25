/**
 * @fileoverview 오류 계층. ccxt 의 구조를 따르되 주식 브로커에 의미 있는 가지만 남기고, 증권사에서 필요한 `OrderOutcomeUnknown` 하나를 더했다.
 *
 * ```
 * BaseError
 * ├─ ExchangeError                 요청이 거절됐다. 같은 요청을 그대로 다시 보내도 소용없다
 * │  ├─ AuthenticationError
 * │  │  ├─ PermissionDenied
 * │  │  │  └─ AccountNotEnabled    계좌에 해당 거래(해외주식·신용 등) 신청이 안 돼 있다
 * │  │  └─ AccountSuspended
 * │  ├─ ArgumentsRequired
 * │  ├─ BadRequest
 * │  │  └─ BadSymbol
 * │  ├─ OperationRejected
 * │  │  ├─ NoChange
 * │  │  ├─ ManualInteractionNeeded 약관 동의·투자자 정보 갱신처럼 사람이 해야 하는 절차가 남았다
 * │  │  └─ MarketClosed           장 시간 밖이거나 휴장이다. ccxt 와 같은 자리다
 * │  ├─ InsufficientFunds
 * │  ├─ InvalidOrder
 * │  │  ├─ OrderNotFound
 * │  │  └─ DuplicateOrderId
 * │  └─ NotSupported
 * └─ OperationFailed               일시 장애. 조회는 다시 시도할 수 있다
 *    ├─ NetworkError
 *    │  ├─ DDoSProtection
 *    │  ├─ RateLimitExceeded
 *    │  ├─ ExchangeNotAvailable
 *    │  │  └─ OnMaintenance
 *    │  └─ RequestTimeout
 *    │     └─ OrderOutcomeUnknown (추가) 주문이 접수됐는지 모른다
 *    └─ BadResponse
 *       └─ NullResponse
 * ```
 *
 * `OrderOutcomeUnknown` 과 `MarketClosed` 는 `retryable` 이 `false` 로 시작한다. 앞의 것은 다시 보내면 중복 주문이 되고, 뒤의 것은
 * 곧바로 다시 보내도 장이 열려 있지 않기 때문이다. `Exchange.fetch2` 의 재시도는 `OperationFailed` 계열이면서 `retryable !== false` 인 오류만 다시 보낸다.
 * `MarketClosed` 는 거절(`ExchangeError` 계열)이라 `retryable` 을 `true` 로 줘도 `fetch2` 는 다시 보내지 않는다. 그 값은 호출한 쪽이 읽는 표시다.
 */

export interface BaseErrorOptions extends ErrorOptions {
    /** 증권사가 알려 준 세부 원인 코드. 어댑터가 종류보다 구체적인 원인을 알 때만 채운다. */
    detail?: string;
    /** 같은 요청을 다시 보내도 되는가. `undefined` 는 이 클래스만으로는 판정하지 않는다는 뜻이다. */
    retryable?: boolean;
}

export class BaseError extends Error {
    override name = 'BaseError';
    detail?: string;
    retryable?: boolean;

    constructor(message: string, options: BaseErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        // 컴파일 대상이 낮아도 `instanceof` 가 깨지지 않게 프로토타입을 고정한다.
        Object.setPrototypeOf(this, new.target.prototype);
        this.detail = options.detail;
        this.retryable = options.retryable;
    }
}

// ---- ExchangeError: 거절된 요청 ----

export class ExchangeError extends BaseError { override name = 'ExchangeError'; }
export class AuthenticationError extends ExchangeError { override name = 'AuthenticationError'; }
export class PermissionDenied extends AuthenticationError { override name = 'PermissionDenied'; }
export class AccountNotEnabled extends PermissionDenied { override name = 'AccountNotEnabled'; }
export class AccountSuspended extends AuthenticationError { override name = 'AccountSuspended'; }
export class ArgumentsRequired extends ExchangeError { override name = 'ArgumentsRequired'; }
export class BadRequest extends ExchangeError { override name = 'BadRequest'; }
export class BadSymbol extends BadRequest { override name = 'BadSymbol'; }
/** 사용자가 `close()` 로 연결을 닫아 기다리던 `watch*` 를 끝낸다. ccxt 와 같다. */
export class ExchangeClosedByUser extends ExchangeError { override name = 'ExchangeClosedByUser'; }
export class OperationRejected extends ExchangeError { override name = 'OperationRejected'; }
export class NoChange extends OperationRejected { override name = 'NoChange'; }
export class ManualInteractionNeeded extends OperationRejected { override name = 'ManualInteractionNeeded'; }
export class InsufficientFunds extends ExchangeError { override name = 'InsufficientFunds'; }
export class InvalidOrder extends ExchangeError { override name = 'InvalidOrder'; }
export class OrderNotFound extends InvalidOrder { override name = 'OrderNotFound'; }
export class DuplicateOrderId extends InvalidOrder { override name = 'DuplicateOrderId'; }
export class NotSupported extends ExchangeError { override name = 'NotSupported'; }

// ---- OperationFailed: 일시 장애 ----

export class OperationFailed extends BaseError { override name = 'OperationFailed'; }
export class NetworkError extends OperationFailed { override name = 'NetworkError'; }
export class DDoSProtection extends NetworkError { override name = 'DDoSProtection'; }
export class RateLimitExceeded extends NetworkError { override name = 'RateLimitExceeded'; }
export class ExchangeNotAvailable extends NetworkError { override name = 'ExchangeNotAvailable'; }
export class OnMaintenance extends ExchangeNotAvailable { override name = 'OnMaintenance'; }
export class RequestTimeout extends NetworkError { override name = 'RequestTimeout'; }
export class BadResponse extends OperationFailed { override name = 'BadResponse'; }
export class NullResponse extends BadResponse { override name = 'NullResponse'; }

// ---- 재시도하지 않는 클래스. `MarketClosed` 는 ccxt 에도 있고, `OrderOutcomeUnknown` 은 이 패키지가 더했다 ----

/**
 * 장 시간 밖이거나 휴장일이라 주문·조회를 받을 수 없다. ccxt 와 같이 `OperationRejected`(거절) 아래에 둔다.
 * 곧바로 다시 보내도 같은 결과이므로 재시도 대상이 아니다.
 */
export class MarketClosed extends OperationRejected {
    override name = 'MarketClosed';

    constructor(message: string, options: BaseErrorOptions = {}) {
        super(message, { retryable: false, ...options });
    }
}

/**
 * 주문 요청이 시간 초과나 연결 끊김으로 끝나 증권사가 접수했는지 알 수 없다.
 * 다시 보내면 같은 주문이 두 번 들어갈 수 있으므로 재시도 대상이 아니다. 호출한 쪽은 주문 조회로 접수 여부를 확인해야 한다.
 */
export class OrderOutcomeUnknown extends RequestTimeout {
    override name = 'OrderOutcomeUnknown';

    constructor(message: string, options: BaseErrorOptions = {}) {
        super(message, { retryable: false, ...options });
    }
}

/** 증권사 오류 코드·메시지를 오류 클래스로 잇는 생성자 모양. `exceptions` 표의 값이다. */
export type ErrorClass = new (message: string, options?: BaseErrorOptions) => BaseError;
