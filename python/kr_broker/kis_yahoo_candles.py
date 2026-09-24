"""야후 파이낸스 차트 API(v8)로 받는 OHLCV 봉. TypeScript 판 `ts/src/kis/yahoo-finance-candles.ts` 와 같다.

KIS 분봉은 당일뿐이고 일봉도 한 번에 100행이라, 한국투자증권 `fetch_ohlcv` 는 이력이 긴 야후를 먼저 쓴다. 키가 필요 없다.
국내 종목코드는 `005930.KS`(코스피)·`247540.KQ`(코스닥)로, 미국 티커는 그대로 쓴다.

요청은 증권사 인스턴스의 HTTP 세션(`session`)으로 보낸다. 증권사 API 가 아니라서 서명, 호출 간격, 오류 봉투 처리를 거치지 않는다.
"""

import json
import logging
import math
import random
import threading
import time
from typing import Any, List, Optional

import requests

from kr_broker.base import functions as fn
from kr_broker.broker_krx_code import is_krx_domestic_code
from kr_broker.broker_time import timeframe_to_ms
from kr_broker.kis_candle_resample import resample_candles

logger = logging.getLogger('kr_broker')

YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'
YAHOO_KR_SUFFIX = {'KOSPI': '.KS', 'KOSDAQ': '.KQ'}

# 타임프레임 → 야후 interval. 야후에 4h 가 없어 1h 로 받아 합친다.
YAHOO_INTERVAL_MAP = {
    '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '1h', '1d': '1d', '1w': '1wk', '1W': '1wk', '1M': '1mo',
}
# `since` 가 없을 때의 조회 범위(range).
YAHOO_DEFAULT_RANGE = {
    '1m': '1d', '5m': '60d', '15m': '60d', '30m': '60d', '1h': '1y', '4h': '1y', '1d': '5y', '1w': '10y', '1W': '10y', '1M': 'max',
}
# 타임프레임별 최대 조회 기간. 분봉은 60일 경계를 엄격히 적용해 경계에 딱 맞추면 빈 응답이 오므로 하루씩 여유를 둔다.
_DAY_MS = 24 * 60 * 60 * 1000
YAHOO_MAX_RANGE_MS = {
    '1m': 6 * _DAY_MS, '5m': 59 * _DAY_MS, '15m': 59 * _DAY_MS, '30m': 59 * _DAY_MS, '1h': 729 * _DAY_MS, '4h': 729 * _DAY_MS,
}
YAHOO_REQUEST_TIMEOUT_MS = 10_000
YAHOO_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
# 빈 응답(result 가 null)과 일시적 실패(429·5xx·시간 초과)는 흔들어 준 간격으로 다시 보낸다. 없는 심볼(chart.error)은 바로 끝낸다.
YAHOO_MAX_ATTEMPTS = 3
YAHOO_RETRY_BASE_MS = 500
# 프로세스 전체의 동시 요청 상한. 한꺼번에 많이 부르면 야후가 빈 응답을 대량으로 준다.
YAHOO_MAX_CONCURRENT = 6
_yahoo_slots = threading.BoundedSemaphore(YAHOO_MAX_CONCURRENT)


class UnsupportedTimeframeError(ValueError):
    """야후가 주지 않는 타임프레임. 예전에는 1d 로 몰래 바꿨는데 지표가 틀리게 계산되는 사고가 나서 던진다."""


def _truthy(value: Any) -> bool:
    """JavaScript 의 참 거짓 판정. 빈 사전과 빈 배열도 참이다."""
    if value is None or value is False:
        return False
    if isinstance(value, bool):
        return True
    if isinstance(value, (int, float)):
        return value != 0 and not math.isnan(value)
    if isinstance(value, str):
        return value != ''
    return True


def _prop(obj: Any, key: str) -> Any:
    """JavaScript 의 `obj.key`. `obj` 가 비어 있으면 던지고, 사전이 아니면 값이 없다."""
    if obj is None:
        raise TypeError(f'Cannot read properties of null (reading {key!r})')
    return obj.get(key) if isinstance(obj, dict) else None


def _at(values: Any, index: int) -> Any:
    """JavaScript 의 `values[index]`. `values` 가 비어 있으면 던지고, 범위 밖이면 값이 없다."""
    if values is None:
        raise TypeError(f'Cannot read properties of null (reading {index})')
    if isinstance(values, list):
        return values[index] if 0 <= index < len(values) else None
    return None


def align_tail_to_series_grid(candles: List[List[float]], timeframe: str) -> None:
    """진행 중인 마지막 봉의 시각을 시리즈의 격자(직전 봉에서 타임프레임의 배수)로 내린다. 제자리에서 바꾼다.

    야후는 완성된 봉에 구간 시작 시각을 주지만 진행 중인 마지막 봉에는 지연된 현재 시각을 준다. 그대로 두면 폴링할 때마다 시각이 달라져
    같은 봉이 새 행으로 쌓인다. 정시로 내리면 미국장 시간봉(13:30 UTC 앵커)의 키가 모두 바뀌므로 직전 봉 기준으로 맞춘다. 일봉·주봉은 건드리지 않는다.
    """
    if timeframe.endswith('d') or timeframe.endswith('w'):
        return
    if len(candles) < 2:
        return
    tf_ms = timeframe_to_ms(timeframe)
    if not tf_ms > 0:
        return
    last = candles[-1]
    prev = candles[-2]
    delta = last[0] - prev[0]
    if delta <= 0 or delta % tf_ms == 0:
        return
    last[0] = prev[0] + math.floor(delta / tf_ms) * tf_ms


def dedupe_by_timestamp_keep_last(candles: List[List[float]]) -> None:
    """같은 시각의 봉이 여럿이면 마지막 것만 남긴다. 제자리에서 바꾸고 시간 순서는 지킨다."""
    last_index = {c[0]: i for i, c in enumerate(candles)}
    kept = [c for i, c in enumerate(candles) if last_index[c[0]] == i]
    candles[:] = kept


def to_yahoo_range(window_ms: float) -> str:
    """요청 기간(ms)을 덮는 가장 작은 야후 `range` 값."""
    days = window_ms / _DAY_MS
    if days <= 1:
        return '1d'
    if days <= 5:
        return '5d'
    if days <= 30:
        return '1mo'
    if days <= 90:
        return '3mo'
    if days <= 180:
        return '6mo'
    if days <= 366:
        return '1y'
    if days <= 731:
        return '2y'
    if days <= 1826:
        return '5y'
    if days <= 3651:
        return '10y'
    return 'max'


def to_yahoo_ticker(stock_code: str, kr_market: Optional[str] = None) -> str:
    """종목코드를 야후 티커로 바꾼다. 국내는 `.KS`(코스닥은 `.KQ`)를 붙이고 미국 티커는 그대로 둔다. `stock:` 접두사와 `/KRW` 같은 접미사는 뗀다."""
    code = stock_code[6:] if stock_code.startswith('stock:') else stock_code
    code = code.split('/')[0] if '/' in code else code
    if code.endswith('.KS') or code.endswith('.KQ'):
        return code
    if is_krx_domestic_code(code):
        suffix = YAHOO_KR_SUFFIX['KOSDAQ'] if kr_market == 'KOSDAQ' else YAHOO_KR_SUFFIX['KOSPI']
        return f'{code}{suffix}'
    return code


def _backoff(attempt: int) -> None:
    time.sleep((YAHOO_RETRY_BASE_MS * attempt + math.floor(random.random() * 250)) / 1000)


def fetch_yahoo_candles(stock_code: str, timeframe: str = '1d', limit: int = 500, since: Optional[int] = None, until: Optional[int] = None,
                        kr_market: Optional[str] = None, session: Any = None) -> List[List[float]]:
    """야후에서 봉 `[[시각(ms), 시가, 고가, 저가, 종가, 거래량], ...]` 을 받는다. 최신 `limit` 개를 돌려준다.

    받지 못하면(없는 심볼, 재시도를 다 쓴 빈 응답이나 실패) 빈 목록이다. 지원하지 않는 타임프레임은 `UnsupportedTimeframeError` 를 던진다.
    `since` 가 있으면 `until`(없으면 지금)까지의 기간을 덮는 `range` 로, 없으면 타임프레임별 기본 `range` 로 조회한다.
    """
    yahoo_symbol = to_yahoo_ticker(stock_code, kr_market)
    interval = YAHOO_INTERVAL_MAP.get(timeframe)
    if not interval:
        logger.error('[YahooFinance] 미지원 timeframe — silent 폴백 차단 (timeframe=%s, stockCode=%s)', timeframe, stock_code)
        raise UnsupportedTimeframeError(f"[YahooFinance] 미지원 타임프레임 '{timeframe}'. 지원: {', '.join(YAHOO_INTERVAL_MAP)}. "
                                        '이전 동작(1d silent 폴백)은 지표 오계산 사고로 폐기.')
    # period1·period2 는 Node 의 fetch 에서 400 이 나서 두 판 모두 range 로만 조회한다.
    max_range_ms = YAHOO_MAX_RANGE_MS.get(timeframe)
    if since:
        window_ms = (fn.milliseconds() if until is None else until) - since
        if max_range_ms:
            window_ms = min(window_ms, max_range_ms)
        query = {'interval': interval, 'range': to_yahoo_range(window_ms)}
    else:
        query = {'interval': interval, 'range': YAHOO_DEFAULT_RANGE.get(timeframe, '1y')}
    url = f'{YAHOO_CHART_BASE_URL}/{yahoo_symbol}?{fn.form_urlencode(query)}'
    logger.debug('[YahooFinance] 캔들 요청 url=%s', url)
    http = session if session is not None else requests.Session()
    with _yahoo_slots:
        for attempt in range(1, YAHOO_MAX_ATTEMPTS + 1):
            can_retry = attempt < YAHOO_MAX_ATTEMPTS
            try:
                response = http.request('GET', url, headers={'User-Agent': YAHOO_USER_AGENT}, data=None,
                                        timeout=YAHOO_REQUEST_TIMEOUT_MS / 1000)
                status = response.status_code
                if not 200 <= status < 300:
                    # 429·5xx 는 일시적 조절이라 다시 보낸다. 그 밖의 4xx 는 바로 끝낸다.
                    retryable = status == 429 or status >= 500
                    logger.warning('[YahooFinance] API 응답 에러 (status=%s, symbol=%s, attempt=%d)', status, yahoo_symbol, attempt)
                    if retryable and can_retry:
                        _backoff(attempt)
                        continue
                    return []
                data = json.loads(response.content.decode(response.encoding or 'utf-8', errors='replace'))
                chart = _prop(data, 'chart')
                chart_error = _prop(chart, 'error')
                if _truthy(chart_error):
                    logger.warning('[YahooFinance] 차트 에러 (symbol=%s, error=%s)', yahoo_symbol, chart_error)
                    return []
                results = _prop(chart, 'result')
                result = results[0] if isinstance(results, list) and len(results) > 0 else None
                timestamps = result.get('timestamp') if isinstance(result, dict) else None
                indicators = result.get('indicators') if isinstance(result, dict) else None
                quotes = indicators.get('quote') if isinstance(indicators, dict) else None
                quote = quotes[0] if isinstance(quotes, list) and len(quotes) > 0 else None
                if not _truthy(timestamps) or not _truthy(quote):
                    # 빈 응답은 한꺼번에 많이 부를 때의 조절 신호라 간격을 두고 다시 보낸다.
                    if can_retry:
                        logger.debug('[YahooFinance] 빈 응답 — 재시도 (symbol=%s, attempt=%d)', yahoo_symbol, attempt)
                        _backoff(attempt)
                        continue
                    logger.warning('[YahooFinance] 빈 응답 (재시도 소진) (symbol=%s)', yahoo_symbol)
                    return []
                if not isinstance(timestamps, list):
                    raise TypeError('timestamp 가 배열이 아니다')
                candles: List[List[float]] = []
                for i in range(len(timestamps)):
                    open_ = _at(_prop(quote, 'open'), i)
                    high = _at(_prop(quote, 'high'), i)
                    low = _at(_prop(quote, 'low'), i)
                    close = _at(_prop(quote, 'close'), i)
                    volume = _at(_prop(quote, 'volume'), i)
                    # 거래가 없던 봉(null)은 건너뛴다.
                    if open_ is None or high is None or low is None or close is None:
                        continue
                    ts = timestamps[i]
                    candles.append([0 if ts is None else ts * 1000, open_, high, low, close, 0 if volume is None else volume])
                align_tail_to_series_grid(candles, timeframe)
                dedupe_by_timestamp_keep_last(candles)
                logger.debug('[YahooFinance] 캔들 조회 완료 (symbol=%s, timeframe=%s, raw=%d, valid=%d)', yahoo_symbol, timeframe,
                             len(timestamps), len(candles))
                final = resample_candles(candles, 4 * 60) if timeframe == '4h' else candles
                return final if limit is None else final[-limit:]
            except Exception as err:
                if can_retry:
                    logger.debug('[YahooFinance] 요청 실패 — 재시도 (symbol=%s, attempt=%d, err=%s)', yahoo_symbol, attempt, err)
                    _backoff(attempt)
                    continue
                logger.warning('[YahooFinance] 캔들 조회 실패 (재시도 소진) (stockCode=%s, symbol=%s, timeframe=%s, err=%s)',
                               stock_code, yahoo_symbol, timeframe, err)
                return []
        return []
