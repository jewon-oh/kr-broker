/**
 * 타임프레임 → 밀리초.
 */
import { describe, expect, it } from 'vitest';

import { timeframeToMs } from '../broker-time';

describe('timeframeToMs', () => {
    it('분·시·일·주 타임프레임을 밀리초로 바꾼다', () => {
        expect(['1m', '5m', '1h', '4h', '1d', '1w'].map(timeframeToMs)).toEqual([60_000, 300_000, 3_600_000, 14_400_000, 86_400_000, 604_800_000]);
    });

    it('★읽지 못하는 타임프레임(월봉 1M, 대문자 주봉 1W 포함)은 5분이 아니라 NaN 이다', () => {
        for (const timeframe of ['1M', '1W', '30s', '1y', '', 'abc']) {
            expect(timeframeToMs(timeframe), timeframe).toBeNaN();
        }
    });
});
