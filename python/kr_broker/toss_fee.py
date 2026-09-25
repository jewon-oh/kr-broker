"""토스증권 수수료율 해석. TypeScript 판 `ts/src/toss/toss-fee.ts` 와 같다.

`GET /commissions` 의 `commissionRate` 는 문서에 소수 비율(`0.00015` = 0.015%)로 적혀 있지만 백분율(`0.015`)로 온 적이 있다.
단위를 하나로 단정하면 100배 틀린 요율이 조용히 들어오므로, 소매 위탁수수료로 있을 수 있는 범위에 드는 쪽을 고른다.
"""

import logging
import math
from typing import Any, Dict, Iterable, Optional

from kr_broker.base.functions import js_number

logger = logging.getLogger('kr_broker')

# 있을 수 있는 위탁수수료율(소수 비율)의 범위: 0.001% 이상 1% 이하.
PLAUSIBLE_FEE_RATE_MIN = 0.00001
PLAUSIBLE_FEE_RATE_MAX = 0.01
PERCENT_TO_RATIO = 100


def _in_band(rate: float) -> bool:
    return PLAUSIBLE_FEE_RATE_MIN <= rate <= PLAUSIBLE_FEE_RATE_MAX


def normalize_commission_rate(raw: Any) -> Optional[float]:
    """수수료율 응답을 소수 비율로 바꾼다. 그대로 범위에 들면 그 값(문서 형식)이고, 아니면 100으로 나눈 값이 범위에 드는지 본다.
    둘 다 범위 밖이면 `None` 이다. 0 은 무료 이벤트라 유효한 값이다. 값이 없으면(`None`·빈 문자열) 무료가 아니라 모르는 값이라 `None` 이다."""
    if raw is None:
        return None
    if isinstance(raw, str) and raw.strip() == '':
        return None
    value = js_number(raw)
    if not math.isfinite(value) or value < 0:
        return None
    if value == 0:
        return 0
    if _in_band(value):
        return value
    as_percent = value / PERCENT_TO_RATIO
    if _in_band(as_percent):
        return as_percent
    return None


def pick_commission_rate(rows: Iterable[Dict[str, Any]], country: str, today: str) -> Optional[float]:
    """오늘(`YYYY-MM-DD`, 한국 날짜) 적용되는 시장별 수수료율. `startDate` 이상 `endDate` 이하인 행이 유효하고(비어 있으면 열려 있다),
    여럿이면 시작일이 가장 늦은 행을 쓴다. 유효한 행이 없거나 값을 해석하지 못하면 `None` 이다."""
    active = [row for row in rows
              if row.get('marketCountry') == country
              and (row.get('startDate') is None or row['startDate'] <= today)
              and (row.get('endDate') is None or today <= row['endDate'])]
    active.sort(key=lambda row: row.get('startDate') or '', reverse=True)
    if not active:
        return None
    picked = active[0]
    rate = normalize_commission_rate(picked.get('commissionRate'))
    if rate is None:
        logger.warning('[toss] 수수료율이 비었거나 있을 수 있는 범위 밖이라 기본 요율을 유지한다(%s %r)', country, picked.get('commissionRate'))
    return rate
