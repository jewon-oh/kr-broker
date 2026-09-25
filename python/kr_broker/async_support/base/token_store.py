"""`kr_broker/base/token_store.py` 의 `refresh_token_with_lock` 비동기 판.

저장소는 동기 구현(`get()` 이 값을 돌려준다)과 비동기 구현(`get()` 이 코루틴을 돌려준다, 예: `redis.asyncio`) 가운데 무엇이든 된다.
`read_cached` 와 `issue_and_cache` 는 코루틴 함수다.
"""

import logging
import os
from typing import Any, Awaitable, Callable, Optional, TypeVar

from kr_broker.async_support.base.runtime import maybe_await, sleep_seconds
from kr_broker.base import functions as fn
from kr_broker.base.token_store import DEFAULT_WAIT_SECONDS

logger = logging.getLogger('kr_broker')

T = TypeVar('T')


async def refresh_token_with_lock(label: str, store: Any, store_key: str, lock_ttl_ms: int,
                                  read_cached: Callable[[], Awaitable[Optional[T]]], issue_and_cache: Callable[[], Awaitable[T]],
                                  wait_seconds: float = DEFAULT_WAIT_SECONDS,
                                  sleep: Callable[[float], Awaitable[Any]] = sleep_seconds) -> T:
    """교차 프로세스 락을 걸고 토큰을 발급한다. 순서는 동기 판과 같다."""
    if store is None:
        return await issue_and_cache()
    lock_key = f'{store_key}:lock'
    lock_value = f'{os.getpid()}:{fn.milliseconds()}'
    # 락 획득만 감싼다. 발급이 실패하면 그 실패를 그대로 던져야 발급 횟수 제한이 있는 증권사에 실패한 요청을 또 보내지 않는다.
    acquired = False
    try:
        acquired = await maybe_await(store.try_lock(lock_key, lock_value, lock_ttl_ms))
    except Exception:
        logger.warning('%s 토큰 저장소 락 획득 실패, 락 없이 진행한다', label, exc_info=True)
    if acquired:
        try:
            return await issue_and_cache()
        finally:
            try:
                await maybe_await(store.unlock(lock_key, lock_value))
            except Exception:
                logger.debug('%s 토큰 저장소 락 해제 실패(저절로 만료된다)', label, exc_info=True)
    await sleep(wait_seconds)
    try:
        cached = await read_cached()
        if cached is not None:
            logger.info('%s 다른 프로세스가 발급한 토큰을 쓴다', label)
            return cached
    except Exception:
        logger.debug('%s 저장소 재조회 실패, 직접 발급한다', label, exc_info=True)
    logger.warning('%s 다른 프로세스의 발급을 기다렸지만 토큰이 없어 직접 발급한다', label)
    return await issue_and_cache()
