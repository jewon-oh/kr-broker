"""KB 응답 행의 값 읽기. TypeScript 판 `ts/src/kbsec/kbsec-number.ts` 에서 Python 판이 쓰는 것만 옮겼다.

KB 는 필드가 전부 문자열이라 숫자도 문자열로 오고, 값이 없으면 공백으로 채워 보내기도 한다. 공백만 있는 값은 빈 값으로 보고 다음 후보로 넘어간다.
"""

import math
from typing import Any, Optional

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

