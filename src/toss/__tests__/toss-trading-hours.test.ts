/**
 * @fileoverview 토스 KRX 운영시간 가드 검증 — 공용 trading-hours('toss') 위임.
 * 2026-07-16 은 목요일(평일), 2026-07-18 은 토요일(주말).
 */

import { describe, it, expect } from 'vitest';
import { isTossTradingOpen, timeUntilTossOpen } from '../toss-trading-hours';

describe('isTossTradingOpen (KRX 09:00~15:30 KST 평일)', () => {
    it('평일 정규장 중(목 10:00 KST) → open', () => {
        // 2026-07-16T01:00Z = 10:00 KST 목요일
        expect(isTossTradingOpen(new Date('2026-07-16T01:00:00Z'))).toBe(true);
    });

    it('평일 장 마감 후(목 16:00 KST) → closed', () => {
        // 2026-07-16T07:00Z = 16:00 KST 목요일
        expect(isTossTradingOpen(new Date('2026-07-16T07:00:00Z'))).toBe(false);
    });

    it('평일 개장 전(목 08:30 KST) → closed', () => {
        // 2026-07-15T23:30Z = 08:30 KST 목요일(16일)
        expect(isTossTradingOpen(new Date('2026-07-15T23:30:00Z'))).toBe(false);
    });

    it('주말(토 11:00 KST) → closed', () => {
        // 2026-07-18T02:00Z = 11:00 KST 토요일
        expect(isTossTradingOpen(new Date('2026-07-18T02:00:00Z'))).toBe(false);
    });

    it('timeUntilTossOpen — 개장 중이면 0, 마감 후면 >0', () => {
        expect(timeUntilTossOpen(new Date('2026-07-16T01:00:00Z'))).toBe(0);
        expect(timeUntilTossOpen(new Date('2026-07-16T07:00:00Z'))).toBeGreaterThan(0);
    });
});
