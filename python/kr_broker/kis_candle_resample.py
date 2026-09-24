"""OHLCV 봉을 더 긴 분 단위로 합친다. TypeScript 판 `ts/src/kis/candle-resample.ts` 와 같다. 야후와 KIS 분봉 경로가 같이 쓴다."""

import math
from typing import List


def resample_candles(candles: List[List[float]], interval_minutes: float) -> List[List[float]]:
    """봉을 `interval_minutes` 분 단위로 합친다. 입력은 시각 오름차순이고 봉은 `[시각(ms), 시가, 고가, 저가, 종가, 거래량]` 이다.
    구간의 시작 시각은 `interval_minutes` 의 배수로 내린다."""
    if len(candles) == 0:
        return []
    interval_ms = interval_minutes * 60 * 1000
    result: List[List[float]] = []
    first = candles[0]
    bucket_start = math.floor(first[0] / interval_ms) * interval_ms
    open_, high, low, close, volume = first[1], first[2], first[3], first[4], first[5]
    for c in candles[1:]:
        c_bucket = math.floor(c[0] / interval_ms) * interval_ms
        if c_bucket != bucket_start:
            result.append([bucket_start, open_, high, low, close, volume])
            bucket_start = c_bucket
            open_, high, low, close, volume = c[1], c[2], c[3], c[4], c[5]
        else:
            high = max(high, c[2])
            low = min(low, c[3])
            close = c[4]
            volume += c[5]
    result.append([bucket_start, open_, high, low, close, volume])
    return result
