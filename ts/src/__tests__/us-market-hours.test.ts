/**
 * @fileoverview NYSE/NASDAQ 시장 단계
 *
 * DST 경계 케이스 — 2026 spring forward (3/8) / fall back (11/1) 포함.
 * UTC 시각 기준 입력 → ET wall-clock 변환의 정확성을 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyMarketCalendar, resetMarketCalendar } from '../market-calendar';
import { getUsMarketPhase, formatEtWallClock, getTimeUntilUsMarketOpen, usOrderBlockReason } from '../us-market-hours';

/** 증권사 캘린더 API 가 알려 준 2026년 평일 휴장일(Memorial Day, 독립기념일 관측일, 크리스마스). */
const US_CLOSED_DAYS = ['20260525', '20260703', '20261225'];

beforeEach(() => {
    applyMarketCalendar('US', US_CLOSED_DAYS.map(date => ({ date, open: false })));
});
afterEach(() => {
    resetMarketCalendar();
});

/** UTC 시각으로 Date 만들기. */
function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
    return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

describe('getUsMarketPhase', () => {
    describe('주말 / 휴장일', () => {
        it('주말 (토요일) → closed', () => {
            // 2026-05-23 (토) UTC 18:00 = 14:00 EDT
            expect(getUsMarketPhase(utc(2026, 5, 23, 18))).toBe('closed');
        });

        it('주말 (일요일) → closed', () => {
            expect(getUsMarketPhase(utc(2026, 5, 24, 18))).toBe('closed');
        });

        it('Memorial Day (2026-05-25 월) → closed', () => {
            // UTC 18:00 = 14:00 EDT (정규장 시간이지만 휴장)
            expect(getUsMarketPhase(utc(2026, 5, 25, 18))).toBe('closed');
        });

        it('Christmas Day (2026-12-25 금) → closed', () => {
            // UTC 18:00 = 13:00 EST (DST 이후 일정)
            expect(getUsMarketPhase(utc(2026, 12, 25, 18))).toBe('closed');
        });

        it('Independence Day observed (2026-07-03 금) → closed', () => {
            expect(getUsMarketPhase(utc(2026, 7, 3, 18))).toBe('closed');
        });
    });

    describe('EDT 기간 (3월 둘째 일요일 ~ 11월 첫째 일요일 = UTC-4)', () => {
        it('정규 매매 — 09:31 EDT = UTC 13:31 → open', () => {
            // 2026-05-22 (금)
            expect(getUsMarketPhase(utc(2026, 5, 22, 13, 31))).toBe('open');
        });

        it('opening cross 직전 — 09:25 EDT = UTC 13:25 → pre-auction', () => {
            expect(getUsMarketPhase(utc(2026, 5, 22, 13, 25))).toBe('pre-auction');
        });

        it('opening cross 직후 — 09:30 EDT = UTC 13:30 → open', () => {
            expect(getUsMarketPhase(utc(2026, 5, 22, 13, 30))).toBe('open');
        });

        it('closing cross 시작 — 15:50 EDT = UTC 19:50 → closing-auction', () => {
            expect(getUsMarketPhase(utc(2026, 5, 22, 19, 50))).toBe('closing-auction');
        });

        it('closing cross 직전 — 15:49 EDT = UTC 19:49 → open', () => {
            expect(getUsMarketPhase(utc(2026, 5, 22, 19, 49))).toBe('open');
        });

        it('마감 후 — 16:00 EDT = UTC 20:00 → closed', () => {
            expect(getUsMarketPhase(utc(2026, 5, 22, 20))).toBe('closed');
        });

        it('새벽 (pre-market) — 08:00 EDT = UTC 12:00 → closed', () => {
            expect(getUsMarketPhase(utc(2026, 5, 22, 12))).toBe('closed');
        });
    });

    describe('EST 기간 (11월 첫째 일요일 ~ 3월 둘째 일요일 = UTC-5)', () => {
        it('정규 매매 — 09:31 EST = UTC 14:31 (DST 종료 직후) → open', () => {
            // 2026-11-02 (월) — fall back 다음 날 (월요일)
            expect(getUsMarketPhase(utc(2026, 11, 2, 14, 31))).toBe('open');
        });

        it('closing cross — 15:55 EST = UTC 20:55 → closing-auction', () => {
            expect(getUsMarketPhase(utc(2026, 11, 2, 20, 55))).toBe('closing-auction');
        });
    });

    describe('DST 경계 케이스 (핵심)', () => {
        it('Spring forward 전 — 2026-03-06 (금) 09:30 EST = UTC 14:30 → open', () => {
            // 2026-03-08 (일) 02:00 EST → 03:00 EDT 점프 전, 정상 EST
            expect(getUsMarketPhase(utc(2026, 3, 6, 14, 30))).toBe('open');
        });

        it('Spring forward 후 — 2026-03-09 (월) 09:30 EDT = UTC 13:30 → open', () => {
            // DST 시작된 다음 영업일. UTC offset 이 -5 → -4 로 바뀌었으므로
            // EDT 09:30 의 UTC 시각이 14:30 → 13:30 으로 1시간 앞당겨짐
            expect(getUsMarketPhase(utc(2026, 3, 9, 13, 30))).toBe('open');
            // 동일 시점 EST 기준 (UTC 14:30) 은 EDT 로는 10:30 (정규 매매 중)
            expect(getUsMarketPhase(utc(2026, 3, 9, 14, 30))).toBe('open');
        });

        it('Fall back 전 — 2026-10-30 (금) 09:30 EDT = UTC 13:30 → open', () => {
            // 2026-11-01 (일) 02:00 EDT → 01:00 EST 되돌리기 전, 정상 EDT
            expect(getUsMarketPhase(utc(2026, 10, 30, 13, 30))).toBe('open');
        });

        it('Fall back 후 — 2026-11-02 (월) 09:30 EST = UTC 14:30 → open', () => {
            // DST 종료 다음 영업일. UTC offset 이 -4 → -5 로 바뀌었으므로
            // EST 09:30 의 UTC 시각이 13:30 → 14:30 으로 1시간 뒤로
            expect(getUsMarketPhase(utc(2026, 11, 2, 14, 30))).toBe('open');
            // 동일 시점 EDT 기준 (UTC 13:30) 은 EST 로는 08:30 (장 외)
            expect(getUsMarketPhase(utc(2026, 11, 2, 13, 30))).toBe('closed');
        });

        it('Spring forward 당일 (일요일) → closed (주말)', () => {
            // DST 전환 자체 시점은 주말이라 거래 영향 없음 — 단순 closed 확인
            expect(getUsMarketPhase(utc(2026, 3, 8, 7))).toBe('closed');
        });
    });

    describe('formatEtWallClock', () => {
        it('EDT 시간을 정확히 포맷', () => {
            // UTC 13:30 = 09:30 EDT
            expect(formatEtWallClock(utc(2026, 5, 22, 13, 30))).toBe('2026-05-22 09:30 ET');
        });

        it('EST 시간을 정확히 포맷', () => {
            // UTC 14:30 (DST 종료 후) = 09:30 EST
            expect(formatEtWallClock(utc(2026, 11, 2, 14, 30))).toBe('2026-11-02 09:30 ET');
        });
    });
});

describe('getTimeUntilUsMarketOpen', () => {
    const HOUR = 60 * 60 * 1000;

    describe('정규장/동시호가 중 → 0 (계속 사이클)', () => {
        it('정규장 중 (14:00 EDT) → 0', () => {
            // 2026-07-10 (금) UTC 18:00 = 14:00 EDT
            expect(getTimeUntilUsMarketOpen(utc(2026, 7, 10, 18))).toBe(0);
        });

        it('opening 동시호가 (09:27 EDT) → 0', () => {
            // UTC 13:27 = 09:27 EDT (pre-auction)
            expect(getTimeUntilUsMarketOpen(utc(2026, 7, 10, 13, 27))).toBe(0);
        });

        it('closing 동시호가 (15:55 EDT) → 0', () => {
            // UTC 19:55 = 15:55 EDT (closing-auction)
            expect(getTimeUntilUsMarketOpen(utc(2026, 7, 10, 19, 55))).toBe(0);
        });
    });

    describe('장 외 → 다음 개장(09:30 ET)까지 점프', () => {
        it('금 장 마감 직후 → 다음 월요일 09:30 ET (KRX 09:00 KST 아님)', () => {
            // 2026-07-10 (금) UTC 20:30 = 16:30 EDT (마감 30분 후)
            // → 2026-07-13 (월) 13:30 UTC (= 09:30 EDT). 65h.
            // 실제 사고: KRX 캘린더를 쓰면 월요일 00:00 UTC(51.5h)로 잘못 건너뛰어 미국장을 놓친다.
            expect(getTimeUntilUsMarketOpen(utc(2026, 7, 10, 20, 30))).toBe(65 * HOUR);
        });

        it('주말(토) → 다음 월요일 09:30 ET', () => {
            // 2026-07-11 (토) UTC 12:00 → 2026-07-13 (월) 13:30 UTC. 49.5h.
            expect(getTimeUntilUsMarketOpen(utc(2026, 7, 11, 12))).toBe(49.5 * HOUR);
        });

        it('개장 전 당일 (07:00 EDT) → 같은 날 09:30 ET', () => {
            // 2026-07-10 (금) UTC 11:00 = 07:00 EDT → 같은 날 13:30 UTC. 2.5h.
            expect(getTimeUntilUsMarketOpen(utc(2026, 7, 10, 11))).toBe(2.5 * HOUR);
        });

        it('휴장일(Independence Day 07-03) skip → 다음 영업일(월 07-06) 09:30 ET', () => {
            // 2026-07-03 (금, 휴장) UTC 12:00 → 07-04 토 / 07-05 일 skip → 07-06 월 13:30 UTC. 73.5h.
            expect(getTimeUntilUsMarketOpen(utc(2026, 7, 3, 12))).toBe(73.5 * HOUR);
        });

        it('EST(DST 종료 후) 마감 후 → 다음 개장 09:30 EST = 14:30 UTC', () => {
            // 2026-12-01 (화) UTC 22:00 = 17:00 EST (마감 후) → 12-02 (수) 14:30 UTC. 16.5h.
            // EDT(-4) 였다면 13:30 UTC 라 결과가 달라짐 → DST 인식 검증.
            expect(getTimeUntilUsMarketOpen(utc(2026, 12, 1, 22))).toBe(16.5 * HOUR);
        });
    });
});

describe('usOrderBlockReason — 세 증권사 공용 주문 게이트', () => {
    /** 2026-09-22(화) ET(서머타임, UTC-4) 시:분:초. */
    const et = (hour: number, minute: number, second = 0) => new Date(Date.UTC(2026, 8, 22, hour + 4, minute, second));

    it('★정규장(09:30~16:00)만 연다. 시초가 동시호가(09:25~09:30)는 기본으로 막는다', () => {
        expect(usOrderBlockReason({ now: et(9, 24, 59) })).toMatch(/phase=closed/);
        expect(usOrderBlockReason({ now: et(9, 25) })).toMatch(/phase=pre-auction/);
        expect(usOrderBlockReason({ now: et(9, 30) })).toBeNull();
        expect(usOrderBlockReason({ now: et(15, 55), side: 'buy' })).toBeNull();
        expect(usOrderBlockReason({ now: et(16, 0) })).toMatch(/phase=closed/);
    });

    it('sessions 에 opening-auction 을 주면 09:25 부터 연다', () => {
        expect(usOrderBlockReason({ now: et(9, 25), sessions: ['regular', 'opening-auction'] })).toBeNull();
    });

    it('blockAuctionBuys 를 켜면 15:50:00 부터 신규 매수만 막는다', () => {
        expect(usOrderBlockReason({ now: et(15, 49, 59), side: 'buy', blockAuctionBuys: true })).toBeNull();
        expect(usOrderBlockReason({ now: et(15, 50), side: 'buy', blockAuctionBuys: true })).toMatch(/종가 동시호가/);
        expect(usOrderBlockReason({ now: et(15, 50), side: 'sell', blockAuctionBuys: true })).toBeNull();
    });
});
