"""KRX 매도 증권거래세. TypeScript 판 `ts/src/krx-sell-tax.ts` 와 같다.

세율은 증권사가 아니라 법이 정하고 해마다 바뀌므로 시행일별 표로 둔다. 코스피(증권거래세 + 농어촌특별세)와 코스닥의 총 세율은
2023~2026년에 같아서 시장을 나누지 않는다.
"""

import calendar
import logging
from typing import Optional

from kr_broker.base import functions as fn

logger = logging.getLogger('kr_broker')


def _kst_new_year_utc_ms(year: int) -> int:
    """`year` 년 1월 1일 00:00 KST 의 UTC 밀리초(전년 12월 31일 15:00 UTC)."""
    return calendar.timegm((year - 1, 12, 31, 15, 0, 0, 0, 0, 0)) * 1000


# 시행일별 세율. 위에서부터 훑으므로 최신 시행일이 먼저 온다.
KRX_SELL_TAX_SCHEDULE = (
    {'fromUtcMs': _kst_new_year_utc_ms(2026), 'rate': 0.002},
    {'fromUtcMs': _kst_new_year_utc_ms(2025), 'rate': 0.0015},
    {'fromUtcMs': _kst_new_year_utc_ms(2024), 'rate': 0.0018},
    {'fromUtcMs': _kst_new_year_utc_ms(2023), 'rate': 0.002},
)

# 표가 덮는 마지막 해의 끝(2026-12-31 24:00 KST). 넘어가면 최신 값으로 계산하고 프로세스당 한 번 경고한다.
KRX_SELL_TAX_SCHEDULE_HORIZON_MS = _kst_new_year_utc_ms(2027)

_stale_schedule_warned = False


def reset_krx_sell_tax_warn_latch_for_test() -> None:
    """테스트 전용: 경고 래치를 푼다."""
    global _stale_schedule_warned
    _stale_schedule_warned = False


def krx_sell_tax_rate(at_ms: Optional[int] = None) -> float:
    """체결 시각(UTC 밀리초)의 매도 증권거래세율. 생략하면 지금이다. 과거 거래를 다시 계산할 때는 그 거래의 체결 시각을 넘긴다."""
    global _stale_schedule_warned
    ms = fn.milliseconds() if at_ms is None else at_ms
    if ms >= KRX_SELL_TAX_SCHEDULE_HORIZON_MS and not _stale_schedule_warned:
        _stale_schedule_warned = True
        logger.warning('[krxSellTax] 증권거래세 시행일 표가 덮지 않는 시각이다(%s). 최신 시행일 값으로 계산한다. 표를 갱신할 것', fn.iso8601(ms))
    for entry in KRX_SELL_TAX_SCHEDULE:
        if ms >= entry['fromUtcMs']:
            return entry['rate']
    # 표의 가장 오래된 시행일보다 앞선 거래. 이 패키지가 다루는 데이터는 여기 닿지 않는다.
    return KRX_SELL_TAX_SCHEDULE[-1]['rate']
