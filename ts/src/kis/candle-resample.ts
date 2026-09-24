/**
 * @fileoverview OHLCV 캔들을 더 긴 분 단위로 합친다(리샘플링). 야후와 KIS 분봉 경로가 같이 쓴다.
 */

/**
 * OHLCV 캔들을 N분 단위로 합친다. 입력은 오름차순이어야 하고, 각 봉은 `[시각(ms), 시가, 고가, 저가, 종가, 거래량]` 이다.
 * 구간의 시작 시각은 `intervalMinutes` 의 배수로 내림한다.
 */
export function resampleCandles(candles: number[][], intervalMinutes: number): number[][] {
    if (candles.length === 0) return [];

    const intervalMs = intervalMinutes * 60 * 1000;
    const result: number[][] = [];
    let bucketStart = Math.floor(candles[0][0] / intervalMs) * intervalMs;
    let open = candles[0][1];
    let high = candles[0][2];
    let low = candles[0][3];
    let close = candles[0][4];
    let volume = candles[0][5];

    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const cBucket = Math.floor(c[0] / intervalMs) * intervalMs;

        if (cBucket !== bucketStart) {
            result.push([bucketStart, open, high, low, close, volume]);
            bucketStart = cBucket;
            open = c[1];
            high = c[2];
            low = c[3];
            close = c[4];
            volume = c[5];
        } else {
            high = Math.max(high, c[2]);
            low = Math.min(low, c[3]);
            close = c[4];
            volume += c[5];
        }
    }
    result.push([bucketStart, open, high, low, close, volume]);

    return result;
}
