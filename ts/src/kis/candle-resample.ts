/**
 * @fileoverview OHLCV 캔들을 더 긴 분 단위로 합친다(리샘플링). 야후와 KIS 분봉 경로가 같이 쓴다.
 */

/** `[시각(ms), 시가, 고가, 저가, 종가, 거래량]` */
export type OhlcvRow = [number, number, number, number, number, number];

/**
 * OHLCV 캔들을 N분 단위로 합친다. 입력은 오름차순이어야 하고, 각 봉은 `[시각(ms), 시가, 고가, 저가, 종가, 거래량]` 이다.
 * 구간의 시작 시각은 `intervalMinutes` 의 배수로 내림한다.
 */
export function resampleCandles(candles: number[][], intervalMinutes: number): number[][] {
    const [first, ...rest] = candles as OhlcvRow[];
    if (first === undefined) return [];

    const intervalMs = intervalMinutes * 60 * 1000;
    const result: number[][] = [];
    let bucketStart = Math.floor(first[0] / intervalMs) * intervalMs;
    let open = first[1];
    let high = first[2];
    let low = first[3];
    let close = first[4];
    let volume = first[5];

    for (const c of rest) {
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
