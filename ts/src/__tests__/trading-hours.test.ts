import { describe, it, expect } from 'vitest';
import { isTradingHours, getTimeUntilMarketOpen, tradingHoursBlockReason } from '../trading-hours';

/**
 * UTC 기준 Date 헬퍼.
 * KST = UTC+9이므로 KST 시각 → UTC 변환 시 -9시간.
 * 예: KST 월 09:00 = UTC 월 00:00
 */
function utcDate(iso: string): Date {
    return new Date(iso);
}

describe('isTradingHours', () => {
    describe('이 패키지가 모르는 거래소 (시간 제한 없음)', () => {
        it('항상 true', () => {
            expect(isTradingHours('unknown-exchange', utcDate('2026-04-27T00:00:00Z'))).toBe(true);
            expect(isTradingHours('another-exchange', utcDate('2026-04-26T15:00:00Z'))).toBe(true);
            expect(tradingHoursBlockReason('unknown-exchange', utcDate('2026-04-26T15:00:00Z'))).toBeNull();
        });
    });

    describe('KIS (KRX 정규장 09:00~15:30 KST, 평일만)', () => {
        it('월요일 KST 09:00 정각 (개장 경계 ≥ 조건) → true', () => {
            // 월요일 09:00 KST = 월요일 00:00 UTC
            // 구현: localMinutes >= openMinutes 조건이라 정각 포함
            expect(isTradingHours('kis', utcDate('2026-04-27T00:00:00Z'))).toBe(true);
        });

        it('월요일 KST 12:00 (점심 시간이지만 KRX는 무휴) → true', () => {
            // 월요일 12:00 KST = 월요일 03:00 UTC
            expect(isTradingHours('kis', utcDate('2026-04-27T03:00:00Z'))).toBe(true);
        });

        it('월요일 KST 15:29 (마감 직전) → true', () => {
            // 15:29 KST = 06:29 UTC
            expect(isTradingHours('kis', utcDate('2026-04-27T06:29:00Z'))).toBe(true);
        });

        it('월요일 KST 15:30 (마감 정각) → false (close 미만 조건)', () => {
            // 15:30 KST = 06:30 UTC
            expect(isTradingHours('kis', utcDate('2026-04-27T06:30:00Z'))).toBe(false);
        });

        it('월요일 KST 08:59 (개장 직전) → false', () => {
            // 08:59 KST = 23:59 UTC 일요일
            expect(isTradingHours('kis', utcDate('2026-04-26T23:59:00Z'))).toBe(false);
        });

        it('월요일 KST 16:00 (장 마감 후) → false', () => {
            // 16:00 KST = 07:00 UTC
            expect(isTradingHours('kis', utcDate('2026-04-27T07:00:00Z'))).toBe(false);
        });

        it('토요일 KST 10:00 (주말) → false', () => {
            // 토요일 10:00 KST = 토요일 01:00 UTC
            expect(isTradingHours('kis', utcDate('2026-04-25T01:00:00Z'))).toBe(false);
        });

        it('일요일 KST 10:00 (주말) → false', () => {
            // 일요일 10:00 KST = 일요일 01:00 UTC
            expect(isTradingHours('kis', utcDate('2026-04-26T01:00:00Z'))).toBe(false);
        });
    });
});

describe('getTimeUntilMarketOpen', () => {
    it('현재 거래 중이면 0 반환', () => {
        // 월 09:00 KST
        const now = utcDate('2026-04-27T00:00:00Z');
        expect(getTimeUntilMarketOpen('kis', now)).toBe(0);
    });

    it('이 패키지가 모르는 거래소는 항상 0 반환', () => {
        expect(getTimeUntilMarketOpen('unknown-exchange', utcDate('2026-04-27T00:00:00Z'))).toBe(0);
    });

    it('월요일 KST 08:00 → 1시간 뒤 개장', () => {
        // 08:00 KST = 23:00 UTC 일요일 (직전 일요일)
        const now = utcDate('2026-04-26T23:00:00Z');
        const ms = getTimeUntilMarketOpen('kis', now);
        // 약 1시간 (60분 단위 검색이라 정확히 60*60*1000 또는 그 이상)
        expect(ms).toBeGreaterThanOrEqual(60 * 60 * 1000 - 60_000);
        expect(ms).toBeLessThanOrEqual(60 * 60 * 1000 + 60_000);
    });

    it('금요일 16:00 KST 마감 후 → 정확히 65시간 후 월요일 09:00 개장', () => {
        // 금 16:00 KST = 금 07:00 UTC
        const now = utcDate('2026-04-24T07:00:00Z');
        const ms = getTimeUntilMarketOpen('kis', now);
        // 금16시→월9시: 토요일 24h + 일요일 24h + 일요일 16시→월요일 9시 17h = 65h
        // 구현이 60초 단위로 검색하므로 ±60s 허용
        const expected = 65 * 60 * 60 * 1000;
        expect(ms).toBeGreaterThanOrEqual(expected - 60_000);
        expect(ms).toBeLessThanOrEqual(expected + 60_000);
    });
});
