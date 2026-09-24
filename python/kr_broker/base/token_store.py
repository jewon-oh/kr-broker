"""접근 토큰과 발급 락을 프로세스 사이에 나누는 저장소 계약, 그리고 그 락을 거는 발급 함수.

TypeScript 판의 `BrokerTokenStore`(`ts/src/options.ts`)와 `refreshTokenWithLock`(`ts/src/token-refresh-lock.ts`)을 옮겼다.
증권사 토큰은 발급 횟수에 제한이 있고(KIS 분당 1회), 토스는 클라이언트당 유효 토큰이 하나뿐이라 재발급이 직전 토큰을 무효로 만든다.
그래서 여러 프로세스가 토큰을 나눠 쓰고, 발급은 저장소의 락으로 한 번에 한 곳만 한다. 저장소가 없으면 프로세스 메모리 캐시만 쓴다.

`options['tokenStore']` 에 이 계약을 따르는 객체(또는 호출할 때마다 그 객체나 `None` 을 돌려주는 함수)를 넘긴다.
메서드는 실패하면 던진다. 호출하는 쪽이 로그와 대체 동작(새로 발급 등)을 정한다.
"""

import logging
import os
import time
from typing import Any, Callable, Optional, Protocol, TypeVar, runtime_checkable

logger = logging.getLogger('kr_broker')

T = TypeVar('T')

# 락을 못 잡았을 때 다른 프로세스의 발급을 기다리는 시간(초).
DEFAULT_WAIT_SECONDS = 1.5


@runtime_checkable
class BrokerTokenStore(Protocol):
    def get(self, key: str) -> Optional[str]: ...

    def set(self, key: str, value: str, ttl_ms: int) -> None:
        """`ttl_ms` 뒤에 사라지게 저장한다."""

    def delete(self, key: str) -> None: ...

    def delete_if_access_token_equals(self, key: str, access_token: str) -> bool:
        """저장된 값(JSON)의 `accessToken` 이 같을 때만 지운다. 남의 새 토큰을 지우지 않기 위해서다. 지웠으면 `True`."""

    def try_lock(self, key: str, owner: str, ttl_ms: int) -> bool:
        """`ttl_ms` 동안 유효한 락을 잡는다. 이미 잡혀 있으면 `False`."""

    def unlock(self, key: str, owner: str) -> None:
        """`owner` 가 잡은 락일 때만 푼다."""


def resolve_token_store(option: Any) -> Optional[BrokerTokenStore]:
    """옵션 값에서 토큰 저장소를 꺼낸다. 호출할 수 있는 값(함수)이면 지금 호출한다."""
    if option is None:
        return None
    if callable(option) and not isinstance(option, BrokerTokenStore):
        return option()
    return option


def refresh_token_with_lock(label: str, store: Optional[BrokerTokenStore], store_key: str, lock_ttl_ms: int,
                            read_cached: Callable[[], Optional[T]], issue_and_cache: Callable[[], T],
                            wait_seconds: float = DEFAULT_WAIT_SECONDS, sleep: Callable[[float], None] = time.sleep) -> T:
    """교차 프로세스 락을 걸고 토큰을 발급한다.

    1. 저장소가 없으면 그냥 발급한다.
    2. 락을 잡으면 발급하고 자기 락일 때만 푼다.
    3. 못 잡으면 잠깐 기다렸다가 저장소를 다시 본다. 다른 프로세스가 넣었으면 그것을 쓴다.
    4. 그래도 없으면 직접 발급한다. 이 경로도 `issue_and_cache` 를 거치므로 저장이 빠지지 않는다.
    """
    if store is None:
        return issue_and_cache()
    lock_key = f'{store_key}:lock'
    lock_value = f'{os.getpid()}:{int(time.time() * 1000)}'
    # 락 획득만 감싼다. 발급이 실패하면 그 실패를 그대로 던져야 발급 횟수 제한이 있는 증권사에 실패한 요청을 또 보내지 않는다.
    acquired = False
    try:
        acquired = store.try_lock(lock_key, lock_value, lock_ttl_ms)
    except Exception:
        logger.warning('%s 토큰 저장소 락 획득 실패, 락 없이 진행한다', label, exc_info=True)
    if acquired:
        try:
            return issue_and_cache()
        finally:
            try:
                store.unlock(lock_key, lock_value)
            except Exception:
                logger.debug('%s 토큰 저장소 락 해제 실패(저절로 만료된다)', label, exc_info=True)
    sleep(wait_seconds)
    try:
        cached = read_cached()
        if cached is not None:
            logger.info('%s 다른 프로세스가 발급한 토큰을 쓴다', label)
            return cached
    except Exception:
        logger.debug('%s 저장소 재조회 실패, 직접 발급한다', label, exc_info=True)
    logger.warning('%s 다른 프로세스의 발급을 기다렸지만 토큰이 없어 직접 발급한다', label)
    return issue_and_cache()
