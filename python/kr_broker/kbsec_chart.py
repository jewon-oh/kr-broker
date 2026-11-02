"""통합차트(`IVS11560`) 요청 파라미터와 봉 시각 변환. TypeScript 판 `ts/src/kbsec/kbsec-chart.ts` 에서 Python 판이 쓰는 것만 옮겼다."""

import re
from typing import Dict, Optional, Tuple

from kr_broker.base.errors import NotSupported
from kr_broker.base.exchange import strict_kst_timestamp_of
from kr_broker.kbsec_types import KBSEC_CHART_KIND
from kr_broker.us_market_hours import et_wall_clock_to_utc_ms

# `describe()['timeframes']` 의 표. 값은 통합차트의 `chrt_clsf`(일·주·월) 또는 분 단위 숫자 문자열이다.
KBSEC_TIMEFRAMES: Dict[str, str] = {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '10m': '10',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '4h': '240',
    '1d': KBSEC_CHART_KIND['DAY'],
    '1w': KBSEC_CHART_KIND['WEEK'],
    '1M': KBSEC_CHART_KIND['MONTH'],
}

# 통합차트 조회건수(`inq_cnt`, 4자리)의 상한.
KBSEC_CHART_MAX = 9999

# 해외 차트(`GSC10060`)의 차트구분(`chrt_clsf`).
KBSEC_OVERSEAS_CHART_CODE: Dict[str, str] = {'tick': '1', 'minute': '2', 'day': '3', 'week': '4', 'month': '5', 'year': '6'}
# 해외 차트 종류 가운데 기간 봉의 타임프레임. 틱과 분봉은 없다.
KBSEC_OVERSEAS_CHART_PERIOD: Dict[str, str] = {'day': '1d', 'week': '1w', 'month': '1M', 'year': '1y'}
# 해외 차트 레코드수 상한(명세의 최대요청개수).
KBSEC_OVERSEAS_CHART_MAX = 5000

_DAY_MS = 24 * 60 * 60 * 1000


def kbsec_chart_params(timeframe: str) -> Tuple[str, str]:
    """timeframe → 통합차트 파라미터 `(chrt_clsf, minute)`. 분봉은 `B` 와 분 단위를 함께 넘긴다(`5m` → `B`, `5`). 시간봉은 분으로 환산한다
    (`4h` → `B`, `240`). 알 수 없는 timeframe 은 일봉으로 바꾸지 않고 `NotSupported` 를 던진다."""
    tf = timeframe.strip()
    if tf == '1d':
        return KBSEC_CHART_KIND['DAY'], ''
    if tf == '1w':
        return KBSEC_CHART_KIND['WEEK'], ''
    if tf in ('1M', '1mo'):
        return KBSEC_CHART_KIND['MONTH'], ''
    minute = re.fullmatch(r'([0-9]+)m', tf)
    if minute is not None:
        return KBSEC_CHART_KIND['MINUTE'], minute.group(1)
    hour = re.fullmatch(r'([0-9]+)h', tf)
    if hour is not None:
        return KBSEC_CHART_KIND['MINUTE'], str(int(hour.group(1)) * 60)
    raise NotSupported(f'kbsec 이 지원하지 않는 timeframe 이다: {timeframe}')


def kbsec_bar_ms(timeframe: str) -> int:
    """봉 하나가 덮는 시간(ms)의 하한. 기간을 덮을 봉 수를 넉넉히 셀 때 쓰므로 월봉은 가장 짧은 달(28일)로 잡는다."""
    chrt_clsf, minute = kbsec_chart_params(timeframe)
    if chrt_clsf == KBSEC_CHART_KIND['MINUTE']:
        return max(1, int(minute)) * 60 * 1000
    if chrt_clsf == KBSEC_CHART_KIND['WEEK']:
        return 7 * _DAY_MS
    if chrt_clsf == KBSEC_CHART_KIND['MONTH']:
        return 28 * _DAY_MS
    return _DAY_MS


def kbsec_candle_timestamp(dt: str, tm: str) -> Optional[int]:
    """국내 봉의 `dt`(YYYYMMDD)와 `tm`(HHMMSS) → UTC 밀리초. 두 값은 한국 시각이다. `long` 형이라 앞의 0 이 빠져 올 수 있어 자리를 채운다.
    일자나 시각을 읽을 수 없거나 달력에 없는 날짜면 `None` 이다. 일봉은 시각이 없거나 0 이라 자정(KST)이 된다."""
    # 시각을 읽을 수 없는 봉(`240000` 등)은 0시로 두지 않고 버린다.
    return strict_kst_timestamp_of(dt.strip(), tm.strip())


def kbsec_us_candle_timestamp(dt: str, tm: str) -> Optional[int]:
    """해외 차트(`GSC10060`) 봉의 `dt` 와 `tm` → UTC 밀리초. 두 값은 미국 동부 현지 시각이다(조회시간 `inq_tm` 만 한국 시각이다).
    서머타임은 `et_wall_clock_to_utc_ms` 가 반영한다. 일봉은 시각이 비어 현지 자정이 된다.
    일자나 시각을 읽을 수 없거나 달력에 없는 날짜면 `None` 이다."""
    # 달력에 없는 날짜와 범위를 넘는 시각(`240000`)은 `et_wall_clock_to_utc_ms` 가 다른 날이나 시각으로 넘기므로 버린다(검증만 `strict_kst_timestamp_of` 에 맡긴다).
    if strict_kst_timestamp_of(dt.strip(), tm.strip()) is None:
        return None
    date = re.fullmatch(r'([0-9]{4})([0-9]{2})([0-9]{2})', dt.strip())
    time = re.fullmatch(r'([0-9]{2})([0-9]{2})([0-9]{2})', '000000' if tm.strip() == '' else tm.strip().rjust(6, '0'))
    if date is None or time is None:
        return None
    return et_wall_clock_to_utc_ms(int(date.group(1)), int(date.group(2)), int(date.group(3)), int(time.group(1)),
                                   int(time.group(2))) + int(time.group(3)) * 1000
