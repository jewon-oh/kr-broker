# 이 파일은 scripts/gen-python-sync.mjs 가 python/kr_broker/async_support/kis_candle_service.py 에서 만든다. 직접 고치지 않는다.
"""한국투자증권이 직접 주는 봉(OHLCV). TypeScript 판 `ts/src/kis/kis-candle-service.ts` 와 같다.

`kis.fetch_ohlcv` 는 이력이 긴 야후를 먼저 쓴다. 이 모듈은 KIS 원본 봉이 필요한 경로(깊은 이력 채우기, 당일 분봉, 야후가 빈 해외 일봉)를
`kis` 인스턴스의 암묵 API 로 조회한다. 인스턴스의 `candles()` 가 이 서비스를 돌려준다.

국내 날짜 인자(`YYYYMMDD`)는 실행 환경의 시간대가 아니라 한국 날짜로 적는다.
해외 기간별 시세의 기준일(`BYMD`)은 미국 거래일이라 미국 동부 날짜로 적는다.
"""

import datetime
import logging
import math
from typing import Any, Callable, Dict, List, Optional

from kr_broker.base import functions as fn
from kr_broker.kis_candle_pagination import merge_candles, plan_windows, slice_candle_window, to_kis_date
from kr_broker.kis_candle_resample import resample_candles
from kr_broker.us_market_hours import et_ymd

logger = logging.getLogger('kr_broker')

CANDLE_TR_IDS = {
    # 국내 기간별 시세(일·주·월·년)
    'DAILY_CHART': 'FHKST03010100',
    # 국내 당일 분봉
    'MINUTE_CHART': 'FHKST03010200',
    # 해외 기간별 시세(일·주·월)
    'OVERSEAS_DAILY_CHART': 'HHDFS76240000',
}
# 해외 일·주·월 구분(GUBN).
OVERSEAS_GUBN_MAP = {'1d': '0', '1w': '1', '1W': '1', '1M': '2'}
# 분봉 API 한 번의 최대 행 수.
MINUTE_PAGE_SIZE = 30
# 기간 코드별 일수 승수와 주말·휴장일 여유.
PERIOD_DAY_MULTIPLIER = {'W': 7, 'M': 30}
DATE_MARGIN_FACTOR = 1.5
# 해외 일·주·월봉 한 개가 차지하는 달력일 수와, `since` 에서 `limit` 개를 덮는 기준일을 어림할 때 더하는 달력일(연휴를 덮는다).
OVERSEAS_PERIOD_DAYS = {'1d': 1, '1w': 7, '1W': 7, '1M': 31}
OVERSEAS_END_PAD_DAYS = 7
# 해외 기간별 시세 한 번의 행 수와 페이지 상한.
OVERSEAS_PAGE_SIZE = 100
OVERSEAS_MAX_PAGES = 10
DAY_MS = 24 * 60 * 60 * 1000


def _format_utc_date(ms: float) -> str:
    """UTC 밀리초의 UTC 달력 날짜 `YYYYMMDD`. 시각이 아니면 JavaScript 처럼 `NaNNaNNaN` 이다."""
    if not isinstance(ms, (int, float)) or not math.isfinite(ms):
        return 'NaNNaNNaN'
    d = datetime.datetime(1970, 1, 1) + datetime.timedelta(milliseconds=ms)
    return f'{d.year}{d.month:02d}{d.day:02d}'


def _number(row: Dict[str, Any], key: str) -> float:
    """JavaScript 의 `Number(row.key)`. 키가 없으면 NaN 이다."""
    return fn.js_number(row[key]) if key in row else math.nan


def _parse_ms(text: str) -> float:
    """JavaScript 의 `new Date(text).getTime()`. 못 읽으면 NaN 이다."""
    parsed = fn.js_date_parse_iso(text)
    return math.nan if parsed is None else parsed


def _output2(response: Any) -> Any:
    return response.get('output2') if isinstance(response, dict) else None


class KISCandleService:
    """KIS 원본 봉 조회. `exchange` 는 자격증명을 채운 `kis` 인스턴스다."""

    def __init__(self, exchange: Any) -> None:
        self.exchange = exchange

    def fetch_daily_ohlcv(self, stock_code: str, period_code: str, limit: int) -> List[List[float]]:
        """국내 기간별(일·주·월) 봉. 오늘(한국 날짜)로 끝나는 기간을 계산해 부르므로 한 번에 100행쯤까지다."""
        now = self.exchange.milliseconds()
        multiplier = PERIOD_DAY_MULTIPLIER.get(period_code, 1)
        start_date = to_kis_date(now - limit * multiplier * DATE_MARGIN_FACTOR * DAY_MS)
        rows = self.fetch_daily_ohlcv_range(stock_code, period_code, start_date, to_kis_date(now))
        return rows[-limit:]

    def fetch_daily_ohlcv_paged(self, stock_code: str, period_code: str, needed_candles: float, now_ms: Optional[int] = None,
                                on_page: Optional[Callable[[int], None]] = None) -> List[List[float]]:
        """창을 과거로 옮겨 가며 여러 번 불러 깊은 이력을 모은다. 빈 창이 나오면(상장 전) 멈춘다. `needed_candles` 가 0 이하면 부르지 않는다."""
        windows = plan_windows(needed_candles, self.exchange.milliseconds() if now_ms is None else now_ms)
        if len(windows) == 0:
            return []
        pages: List[List[List[float]]] = []
        for i, window in enumerate(windows):
            rows = self.fetch_daily_ohlcv_range(stock_code, period_code, window['start'], window['end'])
            if len(rows) == 0:
                logger.debug('[KISCandleService] 빈 창 — 페이지네이션 중단(상장 이전 추정) (stockCode=%s, page=%d)', stock_code, i + 1)
                break
            pages.append(rows)
            if on_page is not None:
                on_page(i)
        merged = merge_candles(pages)
        logger.info('[KISCandleService] 페이지네이션 완료 (stockCode=%s, periodCode=%s, pages=%d, candles=%d)',
                    stock_code, period_code, len(pages), len(merged))
        return merged

    def fetch_daily_ohlcv_range(self, stock_code: str, period_code: str, start_date: str, end_date: str) -> List[List[float]]:
        """기간(`YYYYMMDD`)을 정해 국내 일·주·월 봉을 받는다. 한 응답이 100행쯤이다. 실패하면 로그를 남기고 던진다."""
        try:
            response = self.exchange.private_get_uapi_domestic_stock_v1_quotations_inquire_daily_itemchartprice({
                'FID_COND_MRKT_DIV_CODE': 'J',
                'FID_INPUT_ISCD': stock_code,
                'FID_INPUT_DATE_1': start_date,
                'FID_INPUT_DATE_2': end_date,
                'FID_PERIOD_DIV_CODE': period_code,
                'FID_ORG_ADJ_PRC': '0',
                'tr_id': CANDLE_TR_IDS['DAILY_CHART'],
            })
            data = _output2(response)
            logger.info('[KISCandleService] fetchDailyOHLCV 응답 (stockCode=%s, periodCode=%s, %s~%s, length=%s)', stock_code, period_code,
                        start_date, end_date, len(data) if isinstance(data, list) else 'N/A')
            if not isinstance(data, list):
                return []
            candles = []
            for candle in data:
                date_str = candle['stck_bsop_date']
                timestamp = _parse_ms(f'{date_str[0:4]}-{date_str[4:6]}-{date_str[6:8]}T09:00:00+09:00')
                candles.append([timestamp, _number(candle, 'stck_oprc'), _number(candle, 'stck_hgpr'), _number(candle, 'stck_lwpr'),
                                _number(candle, 'stck_clpr'), _number(candle, 'acml_vol')])
            return sorted(candles, key=lambda c: c[0])
        except Exception:
            # 실패를 빈 목록으로 바꾸지 않는다(분봉과 같다). 빈 창은 페이지네이션이 "상장 이전"으로 읽는다.
            logger.error('[KISCandleService] 기간별 캔들 조회 실패 (stockCode=%s, periodCode=%s, %s~%s)', stock_code, period_code, start_date,
                         end_date, exc_info=True)
            raise

    def fetch_minute_ohlcv(self, stock_code: str, minute_interval: int, limit: int) -> List[List[float]]:
        """국내 당일 분봉. 한 번에 30건씩 이어서 `limit` 개까지 모은다. 실패는 빈 목록으로 바꾸지 않고 던진다.
        빈 목록은 휴장·거래정지로 읽히므로, 묻지 못한 것과 데이터가 없는 것을 같은 값으로 두지 않는다."""
        try:
            # 연속조회는 커서 시각의 봉을 다음 쪽에 다시 줄 수 있어, 시각마다 한 봉만 담는다.
            by_timestamp: Dict[float, List[float]] = {}
            cursor = ''
            while len(by_timestamp) < limit:
                response = self.exchange.private_get_uapi_domestic_stock_v1_quotations_inquire_time_itemchartprice({
                    'FID_COND_MRKT_DIV_CODE': 'J',
                    'FID_INPUT_ISCD': stock_code,
                    'FID_INPUT_HOUR_1': cursor,
                    'FID_PW_DATA_INCU_YN': 'N',
                    'FID_ETC_CLS_CODE': '',
                    'tr_id': CANDLE_TR_IDS['MINUTE_CHART'],
                })
                data = _output2(response)
                if not isinstance(data, list) or len(data) == 0:
                    break
                for item in data:
                    date_str = item.get('stck_bsop_date')
                    time_str = item.get('stck_cntg_hour')
                    if not date_str or not time_str:
                        continue
                    timestamp = _parse_ms(f'{date_str[0:4]}-{date_str[4:6]}-{date_str[6:8]}'
                                          f'T{time_str[0:2]}:{time_str[2:4]}:{time_str[4:6]}+09:00')
                    by_timestamp[timestamp] = [timestamp, _number(item, 'stck_oprc'), _number(item, 'stck_hgpr'),
                                               _number(item, 'stck_lwpr'), _number(item, 'stck_prpr'), _number(item, 'cntg_vol')]
                if len(data) < MINUTE_PAGE_SIZE:
                    break
                last_time = data[-1].get('stck_cntg_hour')
                if not last_time or last_time == cursor:
                    break
                cursor = last_time
            logger.info('[KISCandleService] fetchMinuteOHLCV 완료 (stockCode=%s, minuteInterval=%s, count=%d)', stock_code, minute_interval,
                        len(by_timestamp))
            ordered = sorted(by_timestamp.values(), key=lambda c: c[0])
            if minute_interval <= 1:
                return ordered[-limit:]
            return self.resample_minute_candles(ordered, minute_interval)[-limit:]
        except Exception:
            logger.error('[KISCandleService] 분봉 캔들 조회 실패 (stockCode=%s, minuteInterval=%s)', stock_code, minute_interval, exc_info=True)
            raise

    def resample_minute_candles(self, candles: List[List[float]], interval_minutes: int) -> List[List[float]]:
        """1분봉을 N분봉으로 합친다. 입력은 시각 오름차순이다."""
        return resample_candles(candles, interval_minutes)

    def fetch_overseas_daily_ohlcv(self, ticker: str, market: str, timeframe: str, limit: int, since: Optional[int] = None,
                                   until: Optional[int] = None) -> List[List[float]]:
        """해외 기간별(일·주·월) 봉(`HHDFS76240000`). 한 번에 100건이라, 더 필요하면 기준일(`BYMD`)을 앞 페이지 마지막 날의 하루 전으로
        옮겨 다시 부른다. `1d`·`1w`·`1M` 만 받고 다른 봉은 빈 목록이다(KIS 해외 분봉은 이 경로에 없다). 실패하면 로그를 남기고 던진다.
        `BYMD` 는 미국 거래일이라 실행 환경의 시간대가 아니라 미국 동부 날짜로 적는다.
        `since <= 시각 <= until` 인 봉을 ccxt 규칙대로 `limit` 개 돌려준다. `since` 가 있으면 그 시각에 닿을 때까지 넘긴다."""
        gubn = OVERSEAS_GUBN_MAP.get(timeframe)
        if not gubn:
            logger.warning('[KISCandleService] 해외 timeframe 미지원 — 1d/1w/1M 만 사용 가능 (ticker=%s, market=%s, timeframe=%s)',
                           ticker, market, timeframe)
            return []
        try:
            collected: List[List[float]] = []
            # `since` 가 있으면 첫 기준일을 `since` 에서 `limit` 개를 덮는 날로 당긴다.
            end = self.exchange.milliseconds() if until is None else until
            if since is not None:
                end = min(end, since + (limit * OVERSEAS_PERIOD_DAYS[timeframe] * DATE_MARGIN_FACTOR + OVERSEAS_END_PAD_DAYS) * DAY_MS)
            bymd = et_ymd(end)
            reached_since = False
            exhausted = False
            page = 0
            while page < OVERSEAS_MAX_PAGES and (len(collected) < limit if since is None else not reached_since):
                response = self.exchange.private_get_uapi_overseas_price_v1_quotations_dailyprice({
                    'AUTH': '',
                    'EXCD': market,
                    'SYMB': ticker.upper(),
                    'GUBN': gubn,
                    'BYMD': bymd,
                    'MODP': '1',
                    'tr_id': CANDLE_TR_IDS['OVERSEAS_DAILY_CHART'],
                })
                data = _output2(response)
                if not isinstance(data, list) or len(data) == 0:
                    exhausted = True
                    break
                for c in data:
                    date_str = c.get('xymd')
                    if not date_str:
                        continue
                    ts = _parse_ms(f'{date_str[0:4]}-{date_str[4:6]}-{date_str[6:8]}T00:00:00Z')
                    if since is not None and ts <= since:
                        reached_since = True
                    collected.append([ts, _number(c, 'open'), _number(c, 'high'), _number(c, 'low'), _number(c, 'clos'), _number(c, 'tvol')])
                last_xymd = data[-1].get('xymd')
                if len(data) < OVERSEAS_PAGE_SIZE or not last_xymd:
                    exhausted = True
                    break
                # 다음 페이지는 마지막 날의 하루 전을 달력 날짜 그대로(UTC) 적어 부른다.
                last_date = _parse_ms(f'{last_xymd[0:4]}-{last_xymd[4:6]}-{last_xymd[6:8]}T00:00:00Z')
                bymd = _format_utc_date(last_date - DAY_MS)
                page += 1
            if since is not None and not reached_since and not exhausted:
                logger.warning('[KISCandleService] 페이지 상한에 걸려 since 까지 거슬러 가지 못했다 '
                               '(ticker=%s, market=%s, timeframe=%s, since=%s, pages=%d)', ticker, market, timeframe, since,
                               OVERSEAS_MAX_PAGES)
            ordered = sorted(collected, key=lambda c: c[0])
            logger.info('[KISCandleService] fetchOverseasDailyOHLCV 완료 (ticker=%s, market=%s, timeframe=%s, count=%d)', ticker, market,
                        timeframe, len(ordered))
            return slice_candle_window(ordered, since, until, limit)
        except Exception:
            logger.error('[KISCandleService] 해외 기간별 캔들 조회 실패 (ticker=%s, market=%s, timeframe=%s)', ticker, market, timeframe,
                         exc_info=True)
            raise
