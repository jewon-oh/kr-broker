# 이 파일은 scripts/gen-python-sync.mjs 가 python/kr_broker/async_support/kis_yahoo_candles.py 에서 만든다. 직접 고치지 않는다.
"""야후 파이낸스 차트 API(v8)로 받는 OHLCV 봉. TypeScript 판 `ts/src/kis/yahoo-finance-candles.ts` 와 같다.

KIS 분봉은 당일뿐이고 일봉도 한 번에 100행이라, 한국투자증권 `fetch_ohlcv` 는 이력이 긴 야후를 먼저 쓴다. 키가 필요 없다.
국내 종목코드는 `005930.KS`(코스피)·`247540.KQ`(코스닥)로, 미국 티커는 점을 하이픈으로 바꿔(`BRK.B` → `BRK-B`) 쓴다.

요청은 증권사 인스턴스의 `http_request` 로 보낸다. 증권사 API 가 아니라서 서명, 호출 간격, 오류 봉투 처리를 거치지 않는다.
"""

import json
import logging
import math
import random
from typing import Any, List, Optional

from kr_broker.base.runtime import new_semaphore, sleep_seconds
from kr_broker.base import functions as fn
from kr_broker.base.errors import BadRequest, BadSymbol, BaseError, ExchangeNotAvailable, NetworkError, NotSupported, RateLimitExceeded, RequestTimeout
from kr_broker.broker_krx_code import is_krx_domestic_code
from kr_broker.broker_market_group import symbol_base_code
from kr_broker.broker_time import candle_period_utc_ms, is_daily_or_longer_timeframe, timeframe_to_ms
from kr_broker.kis_candle_pagination import slice_candle_window
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
_yahoo_slots = new_semaphore(YAHOO_MAX_CONCURRENT)


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

    야후는 완성된 봉에 구간 시작 시각을 주지만 진행 중인 마지막 봉에는 지연된 현재 시각을 준다. 그대로 두면 부를 때마다 마지막 봉의
    시각이 달라진다. 정시로 내리면 미국장 시간봉(13:30 UTC 앵커)의 시각이 모두 바뀌므로 직전 봉 기준으로 맞춘다.
    일봉·주봉·월봉(`d`, `w`, `W`, `M`)은 건드리지 않는다.
    """
    if timeframe.endswith(('d', 'w', 'W', 'M')):
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


def dedupe_by_timestamp_keep_first(candles: List[List[float]]) -> None:
    """같은 시각의 봉이 여러 개면 앞엣것만 남긴다(제자리 수정, 시간순 유지). 주·월봉 끝에 붙는 하루치 시세 봉을 버릴 때 쓴다."""
    kept: List[List[float]] = []
    for candle in candles:
        if kept and kept[-1][0] == candle[0]:
            continue
        kept.append(candle)
    candles[:] = kept


def dedupe_by_timestamp_keep_last(candles: List[List[float]]) -> None:
    """같은 시각의 봉이 여럿이면 마지막 것만 남긴다. 제자리에서 바꾸고 시간 순서는 지킨다."""
    last_index = {c[0]: i for i, c in enumerate(candles)}
    kept = [c for i, c in enumerate(candles) if last_index[c[0]] == i]
    candles[:] = kept


# 표준 야후 `range` 값과 그 달력일 수.
YAHOO_RANGE_BUCKETS = [(1, '1d'), (5, '5d'), (30, '1mo'), (90, '3mo'), (180, '6mo'), (366, '1y'), (731, '2y'), (1826, '5y'), (3651, '10y')]


def to_yahoo_range(window_ms: float, max_range_ms: Optional[float] = None) -> str:
    """요청 기간(ms)을 덮는 가장 작은 야후 `range` 값. 그 값이 조회 폭 상한(`max_range_ms`)을 넘으면 야후가 422 로 거절하므로
    일수(`59d`)로 적는다."""
    bucket = next((b for b in YAHOO_RANGE_BUCKETS if window_ms <= b[0] * _DAY_MS), None)
    if max_range_ms is not None and (bucket is None or bucket[0] * _DAY_MS > max_range_ms):
        return f'{math.ceil(min(window_ms, max_range_ms) / _DAY_MS)}d'
    return 'max' if bucket is None else bucket[1]


def to_yahoo_ticker(stock_code: str, kr_market: Optional[str] = None) -> str:
    """종목코드를 야후 티커로 바꾼다. 국내는 `.KS`(코스닥은 `.KQ`)를 붙이고 미국 티커는 점과 슬래시를 하이픈으로 바꾼다(`BRK.B`, `BRK/B` → `BRK-B`).
    `stock:` 접두사와 `/KRW` 같은 접미사는 뗀다."""
    code = stock_code[6:] if stock_code.startswith('stock:') else stock_code
    code = symbol_base_code(code)
    if code.endswith('.KS') or code.endswith('.KQ'):
        return code
    if is_krx_domestic_code(code):
        suffix = YAHOO_KR_SUFFIX['KOSDAQ'] if kr_market == 'KOSDAQ' else YAHOO_KR_SUFFIX['KOSPI']
        return f'{code}{suffix}'
    return code.replace('.', '-')


def _backoff(attempt: int) -> None:
    sleep_seconds((YAHOO_RETRY_BASE_MS * attempt + math.floor(random.random() * 250)) / 1000)


def fetch_yahoo_candles(stock_code: str, timeframe: str = '1d', limit: int = 500, since: Optional[int] = None,
                              until: Optional[int] = None, kr_market: Optional[str] = None, exchange: Any = None) -> List[List[float]]:
    """야후에서 봉 `[[시각(ms), 시가, 고가, 저가, 종가, 거래량], ...]` 을 받는다. `since <= 시각 <= until` 인 봉을 ccxt 규칙대로
    `limit` 개 돌려준다(`since` 가 있으면 가장 이른 것부터, 없으면 가장 최근 것부터).

    조회에 성공했는데 봉이 없을 때만 빈 목록이다. 없는 심볼은 `BadSymbol`, 재시도를 다 쓴 실패는 `ExchangeNotAvailable`·`RateLimitExceeded`·
    `NetworkError` 를 던진다. 지원하지 않는 타임프레임은 `NotSupported` 를 던진다.
    `range` 는 지금에서 거슬러 센 기간이라 `since` 가 있으면 `since` 부터 지금까지를 덮는 값으로, 없으면 타임프레임별 기본값으로 조회한다.
    분봉은 `since` 가 조회 폭 상한(`YAHOO_MAX_RANGE_MS`)보다 오래되면 상한 안의 봉만 받고 경고를 남긴다.
    요청은 `exchange.http_request` 로 보낸다(증권사 인스턴스).
    """
    yahoo_symbol = to_yahoo_ticker(stock_code, kr_market)
    interval = YAHOO_INTERVAL_MAP.get(timeframe)
    if not interval:
        logger.error('[YahooFinance] 미지원 timeframe — silent 폴백 차단 (timeframe=%s, stockCode=%s)', timeframe, stock_code)
        raise NotSupported(f"[YahooFinance] 미지원 타임프레임 '{timeframe}'. 지원: {', '.join(YAHOO_INTERVAL_MAP)}.")
    # period1·period2 는 Node 의 fetch 에서 400 이 나서 두 판 모두 range 로만 조회한다.
    max_range_ms = YAHOO_MAX_RANGE_MS.get(timeframe)
    if since is not None:
        now = fn.milliseconds()
        window_ms = now - since
        if max_range_ms is not None and window_ms > max_range_ms:
            logger.warning('[YahooFinance] since 가 조회 폭 상한보다 오래돼 상한 안의 봉만 받는다 (symbol=%s, timeframe=%s, since=%s, earliest=%s)',
                           yahoo_symbol, timeframe, since, now - max_range_ms)
            window_ms = max_range_ms
        query = {'interval': interval, 'range': to_yahoo_range(window_ms, max_range_ms)}
    else:
        query = {'interval': interval, 'range': YAHOO_DEFAULT_RANGE.get(timeframe, '1y')}
    url = f'{YAHOO_CHART_BASE_URL}/{yahoo_symbol}?{fn.form_urlencode(query)}'
    logger.debug('[YahooFinance] 캔들 요청 url=%s', url)
    with _yahoo_slots:
        for attempt in range(1, YAHOO_MAX_ATTEMPTS + 1):
            can_retry = attempt < YAHOO_MAX_ATTEMPTS
            try:
                response = exchange.http_request('GET', url, {'User-Agent': YAHOO_USER_AGENT}, None, YAHOO_REQUEST_TIMEOUT_MS)
                status = response.status_code
                if not 200 <= status < 300:
                    # 429·5xx 는 일시적 조절이라 다시 보낸다. 그 밖의 4xx 는 바로 끝낸다.
                    retryable = status == 429 or status >= 500
                    logger.warning('[YahooFinance] API 응답 에러 (status=%s, symbol=%s, attempt=%d)', status, yahoo_symbol, attempt)
                    if retryable and can_retry:
                        _backoff(attempt)
                        continue
                    message = f'야후 캔들 조회 실패({yahoo_symbol} {timeframe}): HTTP {status}'
                    if status == 404:
                        raise BadSymbol(message)
                    if status != 429 and status < 500:
                        # 그 밖의 4xx(조회 폭 초과 422 등)는 요청 문제라 다시 보내도 같다.
                        raise BadRequest(message)
                    if status == 429:
                        raise RateLimitExceeded(message)
                    raise ExchangeNotAvailable(message)
                data = json.loads(response.content.decode(response.encoding or 'utf-8', errors='replace'))
                chart = _prop(data, 'chart')
                chart_error = _prop(chart, 'error')
                if _truthy(chart_error):
                    logger.warning('[YahooFinance] 차트 에러 (symbol=%s, error=%s)', yahoo_symbol, chart_error)
                    raise BadSymbol(f'야후 캔들 조회 실패({yahoo_symbol} {timeframe}): {chart_error}')
                results = _prop(chart, 'result')
                result = results[0] if isinstance(results, list) and len(results) > 0 else None
                if not isinstance(result, dict):
                    # 빈 응답(result: null)은 한꺼번에 많이 부를 때의 조절 신호라 간격을 두고 다시 보낸다.
                    if can_retry:
                        logger.debug('[YahooFinance] 빈 응답 — 재시도 (symbol=%s, attempt=%d)', yahoo_symbol, attempt)
                        _backoff(attempt)
                        continue
                    logger.warning('[YahooFinance] 빈 응답 (재시도 소진) (symbol=%s)', yahoo_symbol)
                    raise ExchangeNotAvailable(f'야후 캔들 조회 실패({yahoo_symbol} {timeframe}): {YAHOO_MAX_ATTEMPTS}번 모두 빈 응답')
                timestamps = result.get('timestamp')
                indicators = result.get('indicators')
                quotes = indicators.get('quote') if isinstance(indicators, dict) else None
                quote = quotes[0] if isinstance(quotes, list) and len(quotes) > 0 else None
                if not _truthy(timestamps) or not _truthy(quote):
                    # 결과는 왔는데 시각이 없으면 그 구간에 봉이 없는 것이다.
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
                # 일·주·월봉은 기간 첫날의 00:00 UTC 로 옮긴다(`candle_period_utc_ms`). 야후는 일봉을 개장 시각에, 주·월봉을 현지 자정에 둔다.
                # 주·월봉 끝에는 오늘 하루치 시세 봉이 한 번 더 붙는다. 같은 기간의 앞 봉이 오늘까지 담은 기간 봉이라 뒤엣것을 버린다.
                if is_daily_or_longer_timeframe(timeframe):
                    market = 'KR' if yahoo_symbol.endswith(('.KS', '.KQ')) else 'US'
                    for candle in candles:
                        candle[0] = candle_period_utc_ms(candle[0], timeframe, market)
                    if not timeframe.endswith('d'):
                        dedupe_by_timestamp_keep_first(candles)
                # 4h 는 받은 1h 봉의 격자로 맞춘 뒤 합친다.
                needs_resample = timeframe == '4h'
                align_tail_to_series_grid(candles, '1h' if needs_resample else timeframe)
                dedupe_by_timestamp_keep_last(candles)
                logger.debug('[YahooFinance] 캔들 조회 완료 (symbol=%s, timeframe=%s, raw=%d, valid=%d)', yahoo_symbol, timeframe,
                             len(timestamps), len(candles))
                final = resample_candles(candles, 4 * 60) if needs_resample else candles
                return slice_candle_window(final, since, until, limit)
            except Exception as err:
                # 위에서 일부러 던진 오류는 그대로 올린다. 전송 실패(`NetworkError`·`RequestTimeout` 그 자체)와 해석 실패만 다시 보낸다.
                if isinstance(err, BaseError) and type(err) not in (NetworkError, RequestTimeout):
                    raise
                if can_retry:
                    logger.debug('[YahooFinance] 요청 실패 — 재시도 (symbol=%s, attempt=%d, err=%s)', yahoo_symbol, attempt, err)
                    _backoff(attempt)
                    continue
                logger.warning('[YahooFinance] 캔들 조회 실패 (재시도 소진) (stockCode=%s, symbol=%s, timeframe=%s, err=%s)',
                               stock_code, yahoo_symbol, timeframe, err)
                raise NetworkError(f'야후 캔들 조회 실패({yahoo_symbol} {timeframe}): {err}') from err
        raise ExchangeNotAvailable(f'야후 캔들 조회 실패({yahoo_symbol} {timeframe})')
