"""KB 응답 행의 값 읽기. TypeScript 판 `ts/src/kbsec/kbsec-number.ts` 에서 Python 판이 쓰는 것만 옮겼다.

KB 는 필드가 전부 문자열이라 숫자도 문자열로 오고, 값이 없으면 공백으로 채워 보내기도 한다. 공백만 있는 값은 빈 값으로 보고 다음 후보로 넘어간다.
"""

import math
from typing import Any, Mapping, Optional

from kr_broker.base import functions as fn


def kbsec_number_of(value: Any) -> Optional[float]:
    """값 하나를 숫자로 읽는다. 쉼표는 지운다. 비었거나(공백만 있는 값 포함) 숫자가 아니면 `None` 이다."""
    if value is None:
        return None
    text = fn.js_string(value).replace(',', '').strip()
    if text == '':
        return None
    n = fn.js_number(text)
    return n if math.isfinite(n) else None


def kbsec_number(raw: Optional[Mapping[str, Any]], *keys: str) -> float:
    """문자열·쉼표 섞인 KB 숫자를 읽는다. 키를 앞에서부터 시도하고 하나도 못 읽으면 0 이다."""
    if not raw:
        return 0
    for key in keys:
        n = kbsec_number_of(raw.get(key))
        if n is not None:
            return n
    return 0


def kbsec_string(raw: Optional[Mapping[str, Any]], *keys: str) -> str:
    """공백이 아닌 첫 후보 문자열(앞뒤 공백을 뗀 값). 없으면 `''` 이다."""
    if not raw:
        return ''
    for key in keys:
        value = raw.get(key)
        if value is not None and fn.js_string(value).strip() != '':
            return fn.js_string(value).strip()
    return ''
