/**
 * @fileoverview 타임프레임 변환 — 이 패키지가 쓰는 최소 유틸.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

const TIMEFRAME_UNIT_MS: Record<string, number> = {
    'm': MS_PER_MINUTE,
    'h': MS_PER_HOUR,
    'd': MS_PER_DAY,
    'w': MS_PER_WEEK,
};

const DEFAULT_TIMEFRAME_MS = 5 * MS_PER_MINUTE;

/**
 * 타임프레임 문자열(`5m`, `1h`, `1d`, `1w`)을 밀리초로 바꾼다. 파싱에 실패하면 5분을 돌려준다.
 */
export function timeframeToMs(timeframe: string): number {
    const match = timeframe.match(/^(\d+)([mhdw])$/);
    if (!match) return DEFAULT_TIMEFRAME_MS;

    const value = parseInt(match[1]);
    const unit = match[2];
    return value * (TIMEFRAME_UNIT_MS[unit] || MS_PER_MINUTE);
}
