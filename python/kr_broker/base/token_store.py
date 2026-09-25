"""접근 토큰과 발급 락을 프로세스 사이에 나누는 저장소 계약, 그리고 그 락을 거는 발급 함수.

TypeScript 판의 `BrokerTokenStore`(`ts/src/options.ts`)와 `refreshTokenWithLock`(`ts/src/token-refresh-lock.ts`)을 옮겼다.
증권사 토큰은 발급 횟수에 제한이 있고(KIS 분당 1회), 토스는 클라이언트당 유효 토큰이 하나뿐이라 재발급이 직전 토큰을 무효로 만든다.
그래서 여러 프로세스가 토큰을 나눠 쓰고, 발급은 저장소의 락으로 한 번에 한 곳만 한다. 저장소가 없으면 프로세스 메모리 캐시만 쓴다.

`options['tokenStore']` 에 이 계약을 따르는 객체(또는 호출할 때마다 그 객체나 `None` 을 돌려주는 함수)를 넘긴다.
메서드는 실패하면 던진다. 호출하는 쪽이 로그와 대체 동작(새로 발급 등)을 정한다.
"""

import hashlib
import inspect
import logging
import math
import os
import time
from typing import Any, Callable, Dict, Optional, Protocol, TypeVar, runtime_checkable

from kr_broker.base import functions as fn
from kr_broker.base.errors import NotSupported

logger = logging.getLogger('kr_broker')

T = TypeVar('T')

# 락을 못 잡았을 때 다른 프로세스의 발급을 기다리는 최대 시간(초). 토스 발급 상한(10초)보다 길게 잡는다.
DEFAULT_WAIT_SECONDS = 12.0
# 기다리는 동안 저장소를 다시 읽는 간격(초).
DEFAULT_POLL_SECONDS = 0.25


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


def token_store_key(prefix: str, credential_id: str) -> str:
    """토큰 저장소 키. 자격증명의 SHA-256 앞 32자(128비트)를 쓴다. 원문이 저장소에 드러나지 않고 다른 계정과 키가 겹치지 않는다."""
    return prefix + hashlib.sha256(credential_id.encode('utf-8')).hexdigest()[:32]


def legacy_token_store_key(prefix: str, credential_id: str) -> str:
    """옛 키 형식(자격증명 앞 12자). 앞 12자가 같은 두 계정이 키를 나눠 썼다. 이행 기간에만 읽고 쓴다."""
    return prefix + credential_id[:12]


def _legacy_lock_key(legacy_of: Dict[str, str], key: str) -> str:
    old = legacy_of.get(key[:-len(':lock')]) if key.endswith(':lock') else None
    return key if old is None else f'{old}:lock'


class LegacyKeyTokenStore:
    """키 형식을 바꾸는 판의 이행용 저장소. TypeScript 판 `withLegacyTokenKeys`(`ts/src/token-store-key.ts`)와 같다.

    옛 판 프로세스와 함께 도는 동안(롤링 배포) 서로 "토큰 없음"으로 보고 새로 발급하지 않게 한다. 읽기는 새 키에 없으면 옛 키에서 읽고,
    쓰기와 삭제는 두 키에 모두 하며, 발급 락은 옛 키로 잡는다. `legacy_of` 는 새 키 → 옛 키 대응표다. 다음 판에서 걷어낸다.
    """

    def __init__(self, store: Any, legacy_of: Dict[str, str]) -> None:
        self.store = store
        self.legacy_of = dict(legacy_of)

    def get(self, key: str) -> Optional[str]:
        value = self.store.get(key)
        old = self.legacy_of.get(key)
        return value if value is not None or old is None else self.store.get(old)

    def set(self, key: str, value: str, ttl_ms: int) -> None:
        self.store.set(key, value, ttl_ms)
        old = self.legacy_of.get(key)
        if old is not None:
            self.store.set(old, value, ttl_ms)

    def delete(self, key: str) -> None:
        self.store.delete(key)
        old = self.legacy_of.get(key)
        if old is not None:
            self.store.delete(old)

    def delete_if_access_token_equals(self, key: str, access_token: str) -> bool:
        current = self.store.delete_if_access_token_equals(key, access_token)
        old = self.legacy_of.get(key)
        previous = self.store.delete_if_access_token_equals(old, access_token) if old is not None else False
        return bool(current or previous)

    def try_lock(self, key: str, owner: str, ttl_ms: int) -> bool:
        return self.store.try_lock(_legacy_lock_key(self.legacy_of, key), owner, ttl_ms)

    def unlock(self, key: str, owner: str) -> None:
        self.store.unlock(_legacy_lock_key(self.legacy_of, key), owner)


def resolve_token_store(option: Any) -> Optional[BrokerTokenStore]:
    """옵션 값에서 토큰 저장소를 꺼낸다. 호출할 수 있는 값(함수)이면 지금 호출한다. 함수는 저장소를 바로 돌려줘야 하고,
    코루틴을 돌려주면 `NotSupported` 다(저장소의 메서드는 코루틴이어도 된다)."""
    if option is None:
        return None
    if callable(option) and not isinstance(option, BrokerTokenStore):
        store = option()
        if inspect.isawaitable(store):
            close = getattr(store, 'close', None)
            if callable(close):
                close()
            raise NotSupported('options.tokenStore 함수가 코루틴을 돌려줬다. 저장소를 바로 돌려주는 함수만 받는다(저장소의 메서드는 코루틴이어도 된다)')
        return store
    return option


def refresh_token_with_lock(label: str, store: Optional[BrokerTokenStore], store_key: str, lock_ttl_ms: int,
                            read_cached: Callable[[], Optional[T]], issue_and_cache: Callable[[], T],
                            wait_seconds: float = DEFAULT_WAIT_SECONDS, sleep: Callable[[float], None] = time.sleep,
                            poll_seconds: float = DEFAULT_POLL_SECONDS) -> T:
    """교차 프로세스 락을 걸고 토큰을 발급한다.

    1. 저장소가 없으면 그냥 발급한다.
    2. 락을 잡으면 저장소를 한 번 더 읽고, 없을 때만 발급한다. 자기 락일 때만 푼다.
    3. 못 잡으면 `poll_seconds` 간격으로 저장소를 다시 보며 `wait_seconds` 까지 기다린다. 다른 프로세스가 넣었으면 그것을 쓴다.
    4. 그래도 없으면 직접 발급한다. 이 경로도 `issue_and_cache` 를 거치므로 저장이 빠지지 않는다.
    """
    if store is None:
        return issue_and_cache()
    lock_key = f'{store_key}:lock'
    lock_value = f'{os.getpid()}:{fn.milliseconds()}'
    # 락 획득만 감싼다. 발급이 실패하면 그 실패를 그대로 던져야 발급 횟수 제한이 있는 증권사에 실패한 요청을 또 보내지 않는다.
    acquired = False
    try:
        acquired = store.try_lock(lock_key, lock_value, lock_ttl_ms)
    except Exception:
        logger.warning('%s 토큰 저장소 락 획득 실패, 락 없이 진행한다', label, exc_info=True)
    if acquired:
        try:
            # 락을 잡기 직전에 다른 프로세스가 발급을 마치고 락을 풀었을 수 있다. 저장소에 있으면 발급하지 않는다.
            try:
                cached = read_cached()
            except Exception:
                cached = None
            if cached is not None:
                return cached
            return issue_and_cache()
        finally:
            try:
                store.unlock(lock_key, lock_value)
            except Exception:
                logger.debug('%s 토큰 저장소 락 해제 실패(저절로 만료된다)', label, exc_info=True)
    # 대기는 횟수로 센다. 한 번만 보고 직접 발급하면 상대의 발급이 길어질 때 두 곳이 발급한다.
    for _ in range(max(1, math.ceil(wait_seconds / poll_seconds))):
        sleep(poll_seconds)
        try:
            cached = read_cached()
            if cached is not None:
                logger.info('%s 다른 프로세스가 발급한 토큰을 쓴다', label)
                return cached
        except Exception:
            logger.debug('%s 저장소 재조회 실패', label, exc_info=True)
    logger.warning('%s 다른 프로세스의 발급을 기다렸지만 토큰이 없어 직접 발급한다', label)
    return issue_and_cache()
