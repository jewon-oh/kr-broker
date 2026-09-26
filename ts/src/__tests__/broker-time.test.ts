/**
 * 타임프레임 → 밀리초, 봉 시각 규칙, 한국 시각 도우미.
 */
import { describe, expect, it } from 'vitest';

import { KST_OFFSET_MS, candlePeriodUtcMs, isDailyOrLongerTimeframe, kstHms, kstYmd, timeframeToMs } from '../broker-time';

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

describe('candlePeriodUtcMs — 일·주·월·연봉은 기간 첫날의 00:00 UTC', () => {
    it('한국 일봉: 09:00 KST 와 00:00 KST 모두 그 거래일의 00:00 UTC 다', () => {
        expect(candlePeriodUtcMs(Date.parse('2026-09-23T00:00:00Z'), '1d', 'KR')).toBe(Date.parse('2026-09-23T00:00:00Z'));
        expect(candlePeriodUtcMs(Date.parse('2026-09-22T15:00:00Z'), '1d', 'KR')).toBe(Date.parse('2026-09-23T00:00:00Z'));
    });

    it('미국 일봉: 09:30 ET 와 00:00 ET 모두 그 거래일의 00:00 UTC 다(서머타임과 표준시)', () => {
        expect(candlePeriodUtcMs(Date.parse('2026-09-24T13:30:00Z'), '1d', 'US')).toBe(Date.parse('2026-09-24T00:00:00Z'));
        expect(candlePeriodUtcMs(Date.parse('2026-01-15T05:00:00Z'), '1d', 'US')).toBe(Date.parse('2026-01-15T00:00:00Z'));
    });

    it('주봉은 월요일, 월봉은 1일, 연봉은 1월 1일이다', () => {
        expect(candlePeriodUtcMs(Date.parse('2026-09-23T06:30:00Z'), '1w', 'KR')).toBe(Date.parse('2026-09-21T00:00:00Z'));
        expect(candlePeriodUtcMs(Date.parse('2026-03-08T05:00:00Z'), '1w', 'US')).toBe(Date.parse('2026-03-02T00:00:00Z'));
        expect(candlePeriodUtcMs(Date.parse('2026-09-24T20:00:00Z'), '1M', 'US')).toBe(Date.parse('2026-09-01T00:00:00Z'));
        expect(candlePeriodUtcMs(Date.parse('2026-09-24T20:00:00Z'), '1y', 'US')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    });

    it('일봉 이상인지 가린다', () => {
        expect(['1d', '1w', '1W', '1M', '1y'].map(isDailyOrLongerTimeframe)).toEqual([true, true, true, true, true]);
        expect(['1m', '4h', '30m'].map(isDailyOrLongerTimeframe)).toEqual([false, false, false]);
    });
});

describe('한국 시각 도우미', () => {
    it('15:00 UTC 부터 다음 날이다', () => {
        expect(KST_OFFSET_MS).toBe(9 * 3_600_000);
        expect(kstYmd(Date.parse('2026-09-25T14:59:59Z'))).toBe('20260925');
        expect(kstYmd(Date.parse('2026-09-25T15:00:00Z'))).toBe('20260926');
        expect(kstHms(Date.parse('2026-09-25T00:30:05Z'))).toBe('093005');
        expect(kstHms(Date.parse('2026-09-25T15:00:00Z'))).toBe('000000');
    });
});
