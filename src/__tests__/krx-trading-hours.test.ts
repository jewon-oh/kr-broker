import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyMarketCalendar, resetMarketCalendar } from '../market-calendar';
import {
    getTimeUntilKrxOpen, getKrxMarketPhase, getNxtSession, isNxtExtendedTradable,
    isKrxBusinessDayKst,
} from '../krx-trading-hours';

/**
 * UTC 시각으로 Date 만들기.
 * KST 09:00 = UTC 00:00, KST 15:30 = UTC 06:30.
 */
function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
    return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

const MS_HOUR = 60 * 60 * 1000;

/** 증권사 캘린더 API 가 알려 준 2026년 평일 휴장일(어린이날, 추석 연휴 이틀). */
const KR_CLOSED_DAYS = ['20260505', '20260924', '20260925'];

beforeEach(() => {
    applyMarketCalendar('KR', KR_CLOSED_DAYS.map(date => ({ date, open: false })));
});
afterEach(() => {
    resetMarketCalendar();
});

describe('getTimeUntilKrxOpen', () => {
    describe('KRX 정규장 인식', () => {
        it('정규장 중(KST 11:00 = UTC 02:00)에는 0', () => {
            // 2026-05-22 (금)
            expect(getTimeUntilKrxOpen(utc(2026, 5, 22, 2))).toBe(0);
        });

        it('장 마감 직후(KST 15:30 = UTC 06:30) → 다음 영업일 09:00 까지', () => {
            // 2026-05-22 (금) 마감 → 다음 영업일은 2026-05-25 (월)
            // 마감(UTC 06:30) → 월요일 09:00 KST = 월요일 00:00 UTC
            const ms = getTimeUntilKrxOpen(utc(2026, 5, 22, 6, 30));
            const expectedHours = 2 * 24 + 17.5; // 금 06:30 UTC → 월 00:00 UTC = 65.5h
            expect(ms / MS_HOUR).toBeCloseTo(expectedHours, 1);
        });

        it('금요일 야간(KST 22:00 = 금 UTC 13:00) → 월요일 09:00 KST', () => {
            const ms = getTimeUntilKrxOpen(utc(2026, 5, 22, 13));
            // 금 13:00 UTC → 월 00:00 UTC = 59h
            expect(ms / MS_HOUR).toBeCloseTo(59, 1);
        });

        it('일요일 → 월요일 09:00 KST 까지', () => {
            // 2026-05-24 (일) 12:00 UTC
            const ms = getTimeUntilKrxOpen(utc(2026, 5, 24, 12));
            // 일 12:00 UTC → 월 00:00 UTC = 12h
            expect(ms / MS_HOUR).toBeCloseTo(12, 1);
        });

        it('공휴일(2026-05-24 부처님오신날 일요일은 자체 공휴일) skip', () => {
            // 2026-06-05 (금) 마감 후 → 6/6 토 (현충일) → 6/7 일 → 6/8 월 09:00 KST
            const ms = getTimeUntilKrxOpen(utc(2026, 6, 5, 7));
            // 금 07:00 UTC → 월 00:00 UTC = 65h (마감 직후라 일~월 점프 + 토 = 3일+)
            // 금 07:00 → 월 00:00 = 2일 17시간 = 65시간
            expect(ms / MS_HOUR).toBeCloseTo(65, 1);
        });

        it('정규장 시작 직전(KST 08:59 = UTC -1분 = 전날 23:59)도 정상 처리', () => {
            // KST 08:59 = 전날(KST date 기준 보면 같은 날) UTC 23:59 — 까다로움
            // 단순화: KST 06:00 = 전일 21:00 UTC → 같은 날 09:00 KST = 같은 날 00:00 UTC
            const ms = getTimeUntilKrxOpen(utc(2026, 5, 21, 21));
            // 2026-05-21 21:00 UTC = KST 5/22 06:00 → 5/22 09:00 KST = 5/22 00:00 UTC
            // 21:00 → 24:00 = 3h
            expect(ms / MS_HOUR).toBeCloseTo(3, 1);
        });

        it('정규장 종료 시각(KST 15:30)에는 다음 영업일까지 점프', () => {
            // 2026-05-22 (금) UTC 06:30 = KST 15:30
            const ms = getTimeUntilKrxOpen(utc(2026, 5, 22, 6, 30));
            expect(ms).toBeGreaterThan(0);
        });

        it('월~목 마감 후엔 다음 날 09:00 KST (1일 점프)', () => {
            // 2026-05-19 (화) UTC 07:00 = KST 16:00 (마감 후 30분)
            const ms = getTimeUntilKrxOpen(utc(2026, 5, 19, 7));
            // 화 07:00 → 수 00:00 UTC = 17h
            expect(ms / MS_HOUR).toBeCloseTo(17, 1);
        });
    });
});

describe('getKrxMarketPhase', () => {
    it('주말 (토요일) → closed', () => {
        // 2026-05-23 토 12:00 UTC
        expect(getKrxMarketPhase(utc(2026, 5, 23, 12))).toBe('closed');
    });

    it('공휴일 (2026-05-05 어린이날, 화) → closed', () => {
        // KST 11:00 = UTC 02:00
        expect(getKrxMarketPhase(utc(2026, 5, 5, 2))).toBe('closed');
    });

    it('정규장 마감 후 (KST 16:00 = UTC 07:00) → closed', () => {
        expect(getKrxMarketPhase(utc(2026, 5, 22, 7))).toBe('closed');
    });

    it('시초가 동시호가 (KST 08:45 = UTC -15분, 전날 23:45) → pre-auction', () => {
        // 2026-05-22 (금) KST 08:45 = 2026-05-21 (목) UTC 23:45
        expect(getKrxMarketPhase(utc(2026, 5, 21, 23, 45))).toBe('pre-auction');
    });

    it('정규 매매 (KST 11:00 = UTC 02:00) → open', () => {
        expect(getKrxMarketPhase(utc(2026, 5, 22, 2))).toBe('open');
    });

    it('정규 매매 (KST 15:00 = UTC 06:00) → open (closing-auction 시작 전)', () => {
        expect(getKrxMarketPhase(utc(2026, 5, 22, 6))).toBe('open');
    });

    it('종가 동시호가 (KST 15:25 = UTC 06:25) → closing-auction', () => {
        expect(getKrxMarketPhase(utc(2026, 5, 22, 6, 25))).toBe('closing-auction');
    });

    it('정규장 시작 직전 (KST 08:59 = UTC -1분) → pre-auction', () => {
        expect(getKrxMarketPhase(utc(2026, 5, 21, 23, 59))).toBe('pre-auction');
    });

    it('정규장 시작 (KST 09:00 = UTC 00:00) → open', () => {
        expect(getKrxMarketPhase(utc(2026, 5, 22, 0))).toBe('open');
    });

    it('정규장 마감 (KST 15:30 = UTC 06:30) → closed', () => {
        expect(getKrxMarketPhase(utc(2026, 5, 22, 6, 30))).toBe('closed');
    });
});

describe('getNxtSession — NXT 확장 세션', () => {
    // 2026-05-22 (금) 기준. KST = UTC + 9h.
    it('프리마켓 (KST 08:30 = 전날 UTC 23:30) → pre-market', () => {
        expect(getNxtSession(utc(2026, 5, 21, 23, 30))).toBe('pre-market');
    });

    it('프리마켓 정지 (KST 08:55 = 전날 UTC 23:55) → pre-pause', () => {
        expect(getNxtSession(utc(2026, 5, 21, 23, 55))).toBe('pre-pause');
    });

    it('메인마켓 (KST 11:00 = UTC 02:00) → main', () => {
        expect(getNxtSession(utc(2026, 5, 22, 2))).toBe('main');
    });

    it('KRX 종가 동시호가 (KST 15:25 = UTC 06:25) → krx-closing-auction (NXT 정지)', () => {
        expect(getNxtSession(utc(2026, 5, 22, 6, 25))).toBe('krx-closing-auction');
    });

    it('애프터마켓 개시 (KST 15:30 = UTC 06:30) → after-market', () => {
        expect(getNxtSession(utc(2026, 5, 22, 6, 30))).toBe('after-market');
    });

    it('애프터마켓 종료 직전 (KST 19:59 = UTC 10:59) → after-market', () => {
        expect(getNxtSession(utc(2026, 5, 22, 10, 59))).toBe('after-market');
    });

    it('애프터마켓 종료 (KST 20:00 = UTC 11:00) → closed', () => {
        expect(getNxtSession(utc(2026, 5, 22, 11))).toBe('closed');
    });

    it('프리마켓 개시 전 (KST 07:30 = 전날 UTC 22:30) → closed', () => {
        expect(getNxtSession(utc(2026, 5, 21, 22, 30))).toBe('closed');
    });

    it('주말 (2026-05-23 토, KST 16:00 = UTC 07:00) → closed', () => {
        expect(getNxtSession(utc(2026, 5, 23, 7))).toBe('closed');
    });

    it('공휴일 (2026-05-05 어린이날 화, KST 16:00 = UTC 07:00) → closed', () => {
        expect(getNxtSession(utc(2026, 5, 5, 7))).toBe('closed');
    });
});

describe('isNxtExtendedTradable — 확장 라우팅 게이트', () => {
    it('애프터마켓 (KST 16:00 = UTC 07:00) → true', () => {
        expect(isNxtExtendedTradable(utc(2026, 5, 22, 7))).toBe(true);
    });

    it('프리마켓 (KST 08:30 = 전날 UTC 23:30) → true', () => {
        expect(isNxtExtendedTradable(utc(2026, 5, 21, 23, 30))).toBe(true);
    });

    it('정규장 (KST 11:00 = UTC 02:00) → false (기존 KRX 경로 처리)', () => {
        expect(isNxtExtendedTradable(utc(2026, 5, 22, 2))).toBe(false);
    });

    it('KRX 종가 동시호가 (KST 15:25 = UTC 06:25) → false (NXT 정지)', () => {
        expect(isNxtExtendedTradable(utc(2026, 5, 22, 6, 25))).toBe(false);
    });

    it('애프터마켓 종료 후 (KST 20:00 = UTC 11:00) → false', () => {
        expect(isNxtExtendedTradable(utc(2026, 5, 22, 11))).toBe(false);
    });

    it('주말 (2026-05-23 토, KST 16:00) → false', () => {
        expect(isNxtExtendedTradable(utc(2026, 5, 23, 7))).toBe(false);
    });
});

/**
 * `isKrxBusinessDayKst` — 정산 지연을 영업일 단위로 셀 때 쓰는 기본 판정.
 *
 * 기대값은 2026년 달력과 KRX 휴장일 공고에서 가져왔다. 휴장일은 위 `KR_CLOSED_DAYS` 로
 * 캘린더에 넣은 값이다.
 */
describe('isKrxBusinessDayKst — 영업일 판정', () => {
    it('평일은 영업일이다', () => {
        expect(isKrxBusinessDayKst('20260908')).toBe(true);   // 화
        expect(isKrxBusinessDayKst('20260911')).toBe(true);   // 금
        expect(isKrxBusinessDayKst('20260914')).toBe(true);   // 월
    });

    it('주말은 영업일이 아니다', () => {
        expect(isKrxBusinessDayKst('20260912')).toBe(false);  // 토
        expect(isKrxBusinessDayKst('20260913')).toBe(false);  // 일
    });

    it('추석 연휴(9/24 목·9/25 금)는 영업일이 아니다', () => {
        expect(isKrxBusinessDayKst('20260924')).toBe(false);
        expect(isKrxBusinessDayKst('20260925')).toBe(false);
        // 연휴 직전·직후 평일은 영업일이다.
        expect(isKrxBusinessDayKst('20260923')).toBe(true);   // 수
        expect(isKrxBusinessDayKst('20260928')).toBe(true);   // 월
    });

    it('형식이 어긋나거나 없는 날짜는 영업일이 아니다', () => {
        expect(isKrxBusinessDayKst('2026-09-08')).toBe(false);
        expect(isKrxBusinessDayKst('')).toBe(false);
        // 2026-02-31 은 존재하지 않는다 — Date 롤오버로 3/3 이 되어 true 가 되면 안 된다.
        expect(isKrxBusinessDayKst('20260231')).toBe(false);
    });
});
