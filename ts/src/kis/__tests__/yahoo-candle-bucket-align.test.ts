/**
 * @fileoverview — Yahoo 진행 중 봉 타임스탬프를 시리즈 그리드에 스냅.
 *
 * Yahoo 는 완성된 봉엔 버킷 시작 시각을, **진행 중인 마지막 봉엔 (지연된) 현재 시각**을 준다.
 * 그대로 저장하면 폴링마다 타임스탬프가 달라져 캔들 저장소의 유니크 키
 * (exchange, symbol, timeframe, marketType, timestamp) 상 **새 행**이 계속 쌓인다.
 *
 * 실측(005930 `1h`): 1초 간격 4번 폴링 → 02:30:15/16/17/18 네 행.
 * 이런 행이 누적돼 최근 60봉이 60시간이 아니라 24.3시간만 커버했고,
 * 그 위에서 지표 계산이 노이즈를 추세로 읽었다.
 *
 * 절대 격자(UTC 정시) 정렬은 금지 — 미국장 시간봉은 개장(13:30 UTC) 앵커라
 * 13:30·14:30 이 **정상**이다. 직전 완성봉 기준 tf 배수로 스냅해 세션 위상을 지킨다.
 */
import { describe, it, expect } from 'vitest';
import { alignTailToSeriesGrid, dedupeByTimestampKeepLast } from '../yahoo-finance-candles';

const ts = (iso: string) => Date.parse(iso);
/** [timestamp, o, h, l, c, v] 최소 형태. */
const bar = (t: number, close = 100): number[] => [t, close, close, close, close, 1];

describe('alignTailToSeriesGrid', () => {
    it('KR 1h — 진행 중 봉(02:30:18)을 직전 완성봉 기준 02:00 으로 스냅', () => {
        const candles = [
            bar(ts('2026-08-06T00:00:00Z')),
            bar(ts('2026-08-06T01:00:00Z')),
            bar(ts('2026-08-06T02:30:18Z')),
        ];
        alignTailToSeriesGrid(candles, '1h');

        expect(candles[2]![0]).toBe(ts('2026-08-06T02:00:00Z'));
    });

    it('US 1h — 개장 앵커(13:30) 위상을 보존한다. UTC 정시로 내리면 안 된다', () => {
        const candles = [
            bar(ts('2026-08-05T13:30:00Z')),
            bar(ts('2026-08-05T14:30:00Z')),
            bar(ts('2026-08-05T15:47:10Z')),   // 진행 중
        ];
        alignTailToSeriesGrid(candles, '1h');

        expect(candles[2]![0]).toBe(ts('2026-08-05T15:30:00Z'));
        // 완성봉은 변경하지 않는다.
        expect(candles[0]![0]).toBe(ts('2026-08-05T13:30:00Z'));
        expect(candles[1]![0]).toBe(ts('2026-08-05T14:30:00Z'));
    });

    it('이미 그리드 위면 아무것도 바꾸지 않는다', () => {
        const candles = [
            bar(ts('2026-08-05T13:30:00Z')),
            bar(ts('2026-08-05T14:30:00Z')),
            bar(ts('2026-08-05T15:30:00Z')),
        ];
        const before = JSON.parse(JSON.stringify(candles));
        alignTailToSeriesGrid(candles, '1h');

        expect(candles).toEqual(before);
    });

    it('연속 폴링이 같은 버킷으로 모인다 — 새 행이 안 쌓이는 조건', () => {
        const snapped = ['02:30:15', '02:30:16', '02:30:17', '02:30:18'].map(t => {
            const c = [
                bar(ts('2026-08-06T01:00:00Z')),
                bar(ts(`2026-08-06T${t}Z`)),
            ];
            alignTailToSeriesGrid(c, '1h');
            return c[1]![0];
        });

        expect(new Set(snapped).size).toBe(1);
        expect(snapped[0]).toBe(ts('2026-08-06T02:00:00Z'));
    });

    it('일봉·주봉은 대상이 아니다 — 키를 바꾸면 기존 적재분과 어긋난다', () => {
        for (const tf of ['1d', '1w']) {
            const candles = [bar(ts('2026-08-04T00:00:00Z')), bar(ts('2026-08-06T02:31:00Z'))];
            const before = JSON.parse(JSON.stringify(candles));
            alignTailToSeriesGrid(candles, tf);
            expect(candles).toEqual(before);
        }
    });

    it('★월봉(1M)과 대문자 주봉(1W)도 대상이 아니다 — 5분 격자로 내리지 않는다', () => {
        for (const tf of ['1M', '1W']) {
            const candles = [bar(ts('2026-07-31T15:00:00Z')), bar(ts('2026-09-24T06:20:17Z'))];
            const before = JSON.parse(JSON.stringify(candles));
            alignTailToSeriesGrid(candles, tf);
            expect(candles, tf).toEqual(before);
        }
    });

    it('봉이 하나뿐이면 그리드를 추론할 수 없어 그대로 둔다', () => {
        const candles = [bar(ts('2026-08-06T02:30:18Z'))];
        alignTailToSeriesGrid(candles, '1h');
        expect(candles[0]![0]).toBe(ts('2026-08-06T02:30:18Z'));
    });
});

describe('dedupeByTimestampKeepLast', () => {
    it('같은 버킷이 겹치면 마지막 것(최신 체결)만 남긴다', () => {
        const rows = [
            [1000, 1, 1, 1, 10, 5],
            [1000, 1, 2, 1, 20, 9],
            [2000, 2, 2, 2, 30, 1],
        ];
        dedupeByTimestampKeepLast(rows);

        expect(rows).toEqual([[1000, 1, 2, 1, 20, 9], [2000, 2, 2, 2, 30, 1]]);
    });

    it('중복이 없으면 순서를 그대로 보존한다', () => {
        const rows = [[1000, 1, 1, 1, 1, 1], [2000, 2, 2, 2, 2, 2]];
        const before = JSON.parse(JSON.stringify(rows));
        dedupeByTimestampKeepLast(rows);
        expect(rows).toEqual(before);
    });
});
