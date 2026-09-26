"""오류 계층. ccxt 의 구조를 따르되 주식 브로커에 의미 있는 가지만 남기고, 증권사에서 필요한 것을 더했다.

TypeScript 판(`ts/src/base/errors.ts`)과 클래스 이름과 계층이 같다::

    BaseError
    ├─ ExchangeError                 요청이 거절됐다. 같은 요청을 그대로 다시 보내도 소용없다
    │  ├─ AuthenticationError
    │  │  ├─ PermissionDenied
    │  │  │  └─ AccountNotEnabled    계좌에 해당 거래(해외주식·신용 등) 신청이 안 돼 있다
    │  │  └─ AccountSuspended
    │  ├─ ArgumentsRequired
    │  ├─ BadRequest
    │  │  └─ BadSymbol
    │  ├─ OperationRejected
    │  │  ├─ NoChange
    │  │  ├─ ManualInteractionNeeded 약관 동의·투자자 정보 갱신처럼 사람이 해야 하는 절차가 남았다
    │  │  └─ MarketClosed           장 시간 밖이거나 휴장이다
    │  ├─ InsufficientFunds
    │  ├─ InvalidOrder
    │  │  ├─ OrderNotFound
    │  │  └─ DuplicateOrderId
    │  └─ NotSupported
    └─ OperationFailed               일시 장애. 조회는 다시 시도할 수 있다
       ├─ NetworkError
       │  ├─ DDoSProtection
       │  ├─ RateLimitExceeded
       │  ├─ ExchangeNotAvailable
       │  │  └─ OnMaintenance
       │  └─ RequestTimeout
       │     └─ OrderOutcomeUnknown  주문이 접수됐는지 모른다
       └─ BadResponse
          └─ NullResponse

`OrderOutcomeUnknown` 과 `MarketClosed` 는 `retryable` 이 `False` 로 시작한다. 앞의 것은 다시 보내면 중복 주문이 되고,
뒤의 것은 곧바로 다시 보내도 장이 열려 있지 않기 때문이다.
"""

from typing import Optional

__all__ = [
    'BaseError', 'ExchangeError', 'AuthenticationError', 'PermissionDenied', 'AccountNotEnabled', 'AccountSuspended',
    'ArgumentsRequired', 'BadRequest', 'BadSymbol', 'ExchangeClosedByUser', 'OperationRejected', 'NoChange', 'ManualInteractionNeeded', 'MarketClosed',
    'InsufficientFunds', 'InvalidOrder', 'OrderNotFound', 'DuplicateOrderId', 'NotSupported', 'OperationFailed', 'NetworkError',
    'DDoSProtection', 'RateLimitExceeded', 'ExchangeNotAvailable', 'OnMaintenance', 'RequestTimeout', 'OrderOutcomeUnknown',
    'BadResponse', 'NullResponse', 'TossTokenRejected', 'TossRateLimited', 'OrderNotSent',
]


class BaseError(Exception):
    """모든 오류의 부모. `retryable` 은 같은 요청을 다시 보내도 되는지다.

    `detail` 은 라이브러리가 가른 원인 이름이다. 값 체계는 증권사마다 다르다. 한국투자증권과 토스증권은 대개 증권사 오류 코드와 같고,
    요청 전에 막은 오류는 라이브러리가 정한 이름(`price-tick-invalid` 등)이다. `broker_code` 는 증권사가 응답에 실어 보낸 원래 오류 코드다
    (한국투자증권 `msg_cd`, 토스증권 오류 코드). 코드 표에 없는 코드도 싣고, 증권사 응답 없이 라이브러리가 막은 오류에는 없다."""

    def __init__(self, message: str = '', *, detail: Optional[str] = None, retryable: Optional[bool] = None,
                 broker_code: Optional[str] = None) -> None:
        super().__init__(message)
        self.detail = detail
        self.broker_code = broker_code
        self.retryable = retryable


# ---- ExchangeError: 거절된 요청 ----

class ExchangeError(BaseError):
    pass


class AuthenticationError(ExchangeError):
    pass


class PermissionDenied(AuthenticationError):
    pass


class AccountNotEnabled(PermissionDenied):
    pass


class AccountSuspended(AuthenticationError):
    pass


class ArgumentsRequired(ExchangeError):
    pass


class BadRequest(ExchangeError):
    pass


class BadSymbol(BadRequest):
    pass


class ExchangeClosedByUser(ExchangeError):
    """사용자가 `close()` 로 연결을 닫아 기다리던 `watch_*` 를 끝낸다. ccxt 와 같다."""


class OperationRejected(ExchangeError):
    pass


class NoChange(OperationRejected):
    pass


class ManualInteractionNeeded(OperationRejected):
    pass


class MarketClosed(OperationRejected):
    """장 시간 밖이거나 휴장일이다. 곧바로 다시 보내도 같은 결과이므로 재시도 대상이 아니다."""

    def __init__(self, message: str = '', *, detail: Optional[str] = None, retryable: Optional[bool] = False,
                 broker_code: Optional[str] = None) -> None:
        super().__init__(message, detail=detail, retryable=retryable, broker_code=broker_code)


class InsufficientFunds(ExchangeError):
    pass


class InvalidOrder(ExchangeError):
    pass


class OrderNotFound(InvalidOrder):
    pass


class DuplicateOrderId(InvalidOrder):
    pass


class NotSupported(ExchangeError):
    pass


# ---- OperationFailed: 일시 장애 ----

class OperationFailed(BaseError):
    pass


class NetworkError(OperationFailed):
    pass


class DDoSProtection(NetworkError):
    pass


class RateLimitExceeded(NetworkError):
    pass


class ExchangeNotAvailable(NetworkError):
    pass


class OnMaintenance(ExchangeNotAvailable):
    pass


class RequestTimeout(NetworkError):
    pass


class OrderOutcomeUnknown(RequestTimeout):
    """주문 요청이 시간 초과나 연결 끊김으로 끝나 접수 여부를 모른다. 다시 보내면 중복 주문이 될 수 있어 재시도하지 않는다.
    호출한 쪽은 주문 조회로 접수 여부를 확인해야 한다."""

    def __init__(self, message: str = '', *, detail: Optional[str] = None, retryable: Optional[bool] = False,
                 broker_code: Optional[str] = None) -> None:
        super().__init__(message, detail=detail, retryable=retryable, broker_code=broker_code)


class BadResponse(OperationFailed):
    pass


class NullResponse(BadResponse):
    pass


# ---- 토스증권 ----

class TossTokenRejected(AuthenticationError):
    """토스가 액세스 토큰을 거절했다(401). `failed_token` 은 거절된 요청이 실제로 쓴 토큰이다. 다시 인증할 때
    다른 프로세스가 방금 넣은 새 토큰을 지우지 않는 데 쓴다."""

    def __init__(self, message: str = '', *, detail: Optional[str] = None, failed_token: Optional[str] = None,
                 broker_code: Optional[str] = None) -> None:
        super().__init__(message, detail=detail, broker_code=broker_code)
        self.failed_token = failed_token


class TossRateLimited(RateLimitExceeded):
    """토스 호출 빈도 제한(429). `retry_after_ms` 는 `Retry-After` 헤더가 알려 준 대기 시간이다."""

    def __init__(self, message: str = '', *, detail: Optional[str] = None, retry_after_ms: Optional[float] = None,
                 broker_code: Optional[str] = None) -> None:
        super().__init__(message, detail=detail, broker_code=broker_code)
        self.retry_after_ms = retry_after_ms


class OrderNotSent(InvalidOrder):
    """주문 조건이 맞지 않아 요청을 보내지 않았다. 브로커가 거절한 것이 아니라 클래스가 보내기 전에 막았다."""
