/**
 * @fileoverview 시각 변환. 모든 시각은 UTC 밀리초(`number`)이며, 문자열은 ISO 8601 이다.
 *
 * `now`·`sleep` 은 호출할 때마다 전역 `Date`·`setTimeout` 을 읽는다(가짜 타이머를 쓰는 테스트가 그대로 통한다).
 */

import { NotSupported } from '../errors';
import type { Int, Str } from '../types';

export const now = (): number => Date.now();

/**
 * 경과 시간을 재는 단조 시계(밀리초). 벽시계(`Date`)가 고정되거나 뒤로 가도 앞으로만 간다.
 * 요청 간격 조절기가 이 시계로 토큰을 채우므로, 테스트가 `Date` 만 고정해도 대기가 끝난다.
 */
export const monotonic = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
export const milliseconds = now;
export const seconds = (): number => Math.floor(now() / 1000);

/** 지정한 밀리초만큼 기다린다. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 밀리초 시각을 `2018-04-10T06:42:23.000Z` 꼴로 바꾼다.
 * 숫자가 아니거나(숫자로만 된 문자열은 허용) 음수이거나 표현 범위를 넘으면 `undefined` 이다.
 */
export function iso8601(timestamp: unknown): Str {
    let ms: number | undefined;
    if (typeof timestamp === 'number') {
        ms = Math.floor(timestamp);
    } else if (typeof timestamp === 'string' && /^[0-9]+$/.test(timestamp)) {
        ms = parseInt(timestamp, 10);
    }
    if (ms === undefined || Number.isNaN(ms) || ms < 0 || ms > 8640000000000000) return undefined;
    return new Date(ms).toISOString();
}

/**
 * ISO 8601 문자열을 밀리초 시각으로 읽는다. 읽을 수 없으면 `undefined` 이다.
 *
 * ★시간대 표기(`Z`, `+09:00`, `-0500`)가 없는 문자열은 **UTC 로 해석한다**. 시간대 없이 한국 시각(KST)만 적어 보내는 증권사 응답은
 * 이 함수로 읽으면 9시간 어긋나므로 호출하는 쪽이 직접 9시간을 빼야 한다. 숫자로만 된 문자열(`20260921`)도 날짜로 보지 않는다.
 */
export function parse8601(x: unknown): Int {
    if (typeof x !== 'string' || !x) return undefined;
    if (/^[0-9]+$/.test(x)) return undefined;
    if (x.indexOf('-') < 0 || x.indexOf(':') < 0) return undefined;
    // 시간대는 끝의 Z 나 오프셋이다. 날짜 구분자의 `-` 와 헷갈리지 않게 꼬리만 본다. 두 자리 오프셋(`+09`)은 `+` 가 있어야 한다.
    const zoned = x.indexOf('+') >= 0 || x.slice(-1) === 'Z' || /-\d\d:?\d\d$/.test(x);
    const candidate = Date.parse(zoned ? x : (x + 'Z').replace(/\s(\d\d):/, 'T$1:'));
    return Number.isNaN(candidate) ? undefined : candidate;
}

const SECONDS_PER_UNIT: Readonly<Record<string, number>> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 60 * 60 * 24,
    w: 60 * 60 * 24 * 7,
    M: 60 * 60 * 24 * 30,
    y: 60 * 60 * 24 * 365,
};

/** `'1m'`·`'4h'`·`'1d'` 같은 봉 주기를 초로 바꾼다. 월(`M`)은 30일, 연(`y`)은 365일로 잡는다. */
export function parseTimeframe(timeframe: string | undefined): number {
    if (timeframe === undefined) throw new NotSupported('timeframe is required');
    const unit = timeframe.slice(-1);
    const scale = SECONDS_PER_UNIT[unit];
    if (scale === undefined) throw new NotSupported(`timeframe unit ${unit} is not supported`);
    return parseFloat(timeframe.slice(0, -1)) * scale;
}
