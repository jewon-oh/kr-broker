"""동기 판과 비동기 판이 이름만 같게 쓰는 실행 도구. 짝은 `kr_broker/async_support/base/runtime.py` 다.

비동기 판 소스(`async_support/*.py`)가 이 이름들을 `kr_broker.async_support.base.runtime` 에서 가져다 쓰고,
`scripts/gen-python-sync.mjs` 가 동기 판을 만들 때 가져오는 곳을 이 모듈로 바꾼다. 그래서 두 모듈은 이름과 인자가 같아야 한다.
"""

import threading
import time
from typing import Any, TypeVar

T = TypeVar('T')


def sleep_seconds(seconds: float) -> None:
    """`seconds` 초 기다린다."""
    time.sleep(seconds)


def new_lock() -> Any:
    """`with` 로 잡는 락. 동기 판은 스레드 락이다."""
    return threading.Lock()


def new_semaphore(value: int) -> Any:
    """`with` 로 잡는 세마포어. 동기 판은 스레드 세마포어다."""
    return threading.BoundedSemaphore(value)


def maybe_await(value: T) -> T:
    """비동기 판에서는 값이 코루틴이면 기다린다. 동기 판은 받은 값을 그대로 돌려준다."""
    return value
