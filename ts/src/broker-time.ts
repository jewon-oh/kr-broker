/**
 * @fileoverview 타임프레임 변환과 봉 시각 규칙 — 이 패키지가 쓰는 최소 유틸.
 */

import type { StockMarketGroup } from './broker-market-group';
import { etYmd } from './us-market-hours';

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

/**
 * 타임프레임 문자열(`5m`, `1h`, `1d`, `1w`)을 밀리초로 바꾼다. 읽지 못하면 `NaN` 이다. 월봉 `1M` 과 대문자 주봉 `1W` 도 `NaN` 이다.
 */
export function timeframeToMs(timeframe: string): number {
    const match = timeframe.match(/^(\d+)([mhdw])$/);
    if (!match) return Number.NaN;

    const value = parseInt(match[1]);
    const unit = match[2];
    return value * (TIMEFRAME_UNIT_MS[unit] || MS_PER_MINUTE);
}

const KST_OFFSET_MS = 9 * MS_PER_HOUR;

/** 일·주·월·연봉인가(`1d`, `1w`, `1W`, `1M`, `1y` 등). 분봉과 시봉은 아니다. */
export function isDailyOrLongerTimeframe(timeframe: string): boolean {
    return /^\d+[dwWMy]$/.test(timeframe);
}

/**
 * 일·주·월·연봉의 시각 규칙: 그 봉이 덮는 기간 첫날(그 시장의 현지 날짜)의 00:00 UTC 다. 주봉은 월요일, 월봉은 1일, 연봉은 1월 1일이다.
 * ccxt 의 일봉 관례와 같다. 증권사가 현지 자정(`00:00 KST`, `00:00 ET`)이나 개장 시각(`09:30 ET`)으로 준 봉 시각을 이 규칙으로 옮긴다.
 * 한국 일봉의 09:00 KST 는 00:00 UTC 라 그대로다.
 */
export function candlePeriodUtcMs(timestamp: number, timeframe: string, market: StockMarketGroup): number {
    let day: number;
    if (market === 'KR') {
        day = Math.floor((timestamp + KST_OFFSET_MS) / MS_PER_DAY) * MS_PER_DAY;
    } else {
        const ymd = etYmd(timestamp);
        day = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
    }
    const unit = timeframe.slice(-1);
    if (unit === 'w' || unit === 'W') return day - ((new Date(day).getUTCDay() + 6) % 7) * MS_PER_DAY;
    if (unit === 'M' || unit === 'y') {
        const date = new Date(day);
        return Date.UTC(date.getUTCFullYear(), unit === 'M' ? date.getUTCMonth() : 0, 1);
    }
    return day;
}
