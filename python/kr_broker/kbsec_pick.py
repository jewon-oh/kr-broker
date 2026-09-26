"""KB 응답 행에서 값을 뽑는 함수. TypeScript 판 `ts/src/kbsec/kbsec-pick.ts` 에서 Python 판이 쓰는 것만 옮겼다."""

import logging
from typing import Any, Mapping, Optional

from kr_broker.kbsec_number import kbsec_number_of

logger = logging.getLogger('kr_broker')


def pick_num(row: Optional[Mapping[str, Any]], *keys: str) -> float:
    """후보 필드를 순서대로 시도해 숫자를 뽑는다. 값이 있으면 0 이어도 그 키에서 멈추고, 하나도 못 읽으면 0 이다.

    필드 이름이 틀려도 0 으로 조용히 넘어가지 않게, 후보가 하나도 없고 응답에 다른 키가 있으면 DEBUG 로그를 남긴다.
    """
    if not row:
        return 0
    for key in keys:
        n = kbsec_number_of(row.get(key))
        if n is not None:
            return n
    if not any(key in row for key in keys):
        logger.debug('[kbsec] 응답에 후보 필드가 하나도 없음 — 명세 대조 필요: tried=%s available=%s', list(keys), list(row)[:12])
    return 0


def pick_positive_num(row: Optional[Mapping[str, Any]], *keys: str) -> float:
    """`pick_num` 과 같되 양수인 첫 후보를 고른다. KB 는 값 없음을 0 으로 준다(장 밖 국내 현재가의 `now_prc` 등)."""
    if not row:
        return 0
    for key in keys:
        n = kbsec_number_of(row.get(key))
        if n is not None and n > 0:
            return n
    return 0
