import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyMarketCalendar, resetMarketCalendar } from '../testing';
import {
    KRX_SPECIAL_SESSION_DAYS, checkKRXTradingHoursAt, getTimeUntilKrxOpen, getKrxMarketPhase, getNxtSession, isNxtExtendedTradable,
    isKrxBusinessDayKst, krxAuctionBuyBlockReason, krxOrderBlockReason, krxRegularSessionOf,
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

describe('krxOrderBlockReason — 세 증권사 공용 주문 게이트', () => {
    /** 2026-09-22(화) KST 시:분:초. */
    const kst = (hour: number, minute: number, second = 0) => new Date(Date.UTC(2026, 8, 22, hour - 9, minute, second));

    it('정규장은 열고, 장 밖과 휴장일은 막는다', () => {
        expect(krxOrderBlockReason({ now: kst(10, 0) })).toBeNull();
        expect(krxOrderBlockReason({ now: kst(21, 30) })).toBe('거래시간 외: 장 마감 (현재: 21:30 KST, 마감: 15:30)');
        expect(krxOrderBlockReason({ now: new Date(Date.UTC(2026, 8, 24, 1)) })).toMatch(/^거래시간 외: 공휴일/);
    });

    it('★종가 동시호가의 신규 매수는 시장이 받으므로 기본으로 연다', () => {
        expect(krxOrderBlockReason({ now: kst(15, 25), side: 'buy' })).toBeNull();
    });

    it('blockAuctionBuys 를 켜면 15:20:00 부터 신규 매수만 막는다', () => {
        expect(krxOrderBlockReason({ now: kst(15, 19, 59), side: 'buy', blockAuctionBuys: true })).toBeNull();
        expect(krxOrderBlockReason({ now: kst(15, 20), side: 'buy', blockAuctionBuys: true })).toMatch(/종가 동시호가/);
        expect(krxOrderBlockReason({ now: kst(15, 20), side: 'sell', blockAuctionBuys: true })).toBeNull();
        expect(krxOrderBlockReason({ now: kst(15, 20), blockAuctionBuys: true })).toBeNull();
    });

    it('sessions 에 nxt 를 주면 NXT 세션으로 판정하고, 둘을 주면 하나라도 열려 있을 때 연다', () => {
        expect(krxOrderBlockReason({ now: kst(16, 30), sessions: ['nxt'] })).toBeNull();
        expect(krxOrderBlockReason({ now: kst(15, 25), sessions: ['nxt'] })).toBe('NXT 거래시간 외 (session=krx-closing-auction)');
        expect(krxOrderBlockReason({ now: kst(16, 30), sessions: ['regular', 'nxt'] })).toBeNull();
        expect(krxOrderBlockReason({ now: kst(21, 30), sessions: ['regular', 'nxt'] })).toMatch(/\(NXT session=closed\)$/);
    });
});

describe('특수 거래일 — 2026-11-19(목) 수능일은 개장과 마감이 한 시간 늦다(10:00~16:30)', () => {
    /** 2026-11-19(목) KST 시:분. */
    const csat = (hour: number, minute = 0, second = 0) => new Date(Date.UTC(2026, 10, 19, hour - 9, minute, second));
    /** 평소 날(2026-11-18 수) KST 시:분. */
    const normal = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 18, hour - 9, minute));

    it('표에 수능일이 있고 평소 날은 평소 시각이다', () => {
        expect(Object.keys(KRX_SPECIAL_SESSION_DAYS)).toContain('20261119');
        expect(krxRegularSessionOf('20261119')).toMatchObject({ preAuctionMin: 9 * 60 + 30, openMin: 10 * 60, closingAuctionMin: 16 * 60 + 20, closeMin: 16 * 60 + 30 });
        expect(krxRegularSessionOf('20261119').special).toMatch(/수학능력/);
        expect(krxRegularSessionOf('20261118')).toEqual({ preAuctionMin: 8 * 60 + 30, openMin: 9 * 60, closingAuctionMin: 15 * 60 + 20, closeMin: 15 * 60 + 30 });
        expect(krxRegularSessionOf('20261118').special).toBeUndefined();
    });

    it('★09:00~10:00 은 아직 열리지 않았다 — 고정 시각이면 열린 것으로 읽었다', () => {
        expect(checkKRXTradingHoursAt(csat(9, 0)).tradable).toBe(false);
        expect(checkKRXTradingHoursAt(csat(9, 59)).reason).toBe('장 개장 전 (현재: 9:59 KST, 개장: 10:00)');
        expect(checkKRXTradingHoursAt(csat(10, 0))).toEqual({ tradable: true });
        expect(checkKRXTradingHoursAt(normal(9, 0))).toEqual({ tradable: true }); // 평소 날은 09:00 에 열린다
    });

    it('★15:30~16:30 은 아직 열려 있다 — 고정 시각이면 닫힌 것으로 읽었다', () => {
        expect(checkKRXTradingHoursAt(csat(15, 30))).toEqual({ tradable: true });
        expect(checkKRXTradingHoursAt(csat(16, 29, 59))).toEqual({ tradable: true });
        expect(checkKRXTradingHoursAt(csat(16, 30)).reason).toBe('장 마감 (현재: 16:30 KST, 마감: 16:30)');
        expect(checkKRXTradingHoursAt(normal(15, 30)).reason).toBe('장 마감 (현재: 15:30 KST, 마감: 15:30)');
    });

    it('시장 단계도 한 시간씩 늦다 — 시초가 동시호가 09:30, 종가 동시호가 16:20', () => {
        expect(getKrxMarketPhase(csat(9, 29))).toBe('closed');
        expect(getKrxMarketPhase(csat(9, 30))).toBe('pre-auction');
        expect(getKrxMarketPhase(csat(10, 0))).toBe('open');
        expect(getKrxMarketPhase(csat(16, 19))).toBe('open');
        expect(getKrxMarketPhase(csat(16, 20))).toBe('closing-auction');
        expect(getKrxMarketPhase(csat(16, 30))).toBe('closed');
        expect(getKrxMarketPhase(normal(15, 20))).toBe('closing-auction'); // 평소 날은 그대로
    });

    it('수능일 전날 마감 뒤에는 다음 개장이 10:00 이다(평소 09:00 이 아니다)', () => {
        // 2026-11-18(수) 20:00 KST → 11-19 10:00 KST = 14시간 뒤
        expect(getTimeUntilKrxOpen(normal(20, 0)) / MS_HOUR).toBeCloseTo(14, 5);
        // 수능일 당일 08:00 KST 에는 두 시간 뒤다.
        expect(getTimeUntilKrxOpen(csat(8, 0)) / MS_HOUR).toBeCloseTo(2, 5);
        // 수능일 09:30 에는 30분 뒤다.
        expect(getTimeUntilKrxOpen(csat(9, 30)) / MS_HOUR).toBeCloseTo(0.5, 5);
        // 정규장 중이면 0
        expect(getTimeUntilKrxOpen(csat(13, 0))).toBe(0);
    });

    it('수능일 마감 뒤에는 다음 영업일(11-20 금) 평소 09:00 이 다음 개장이다', () => {
        // 11-19(목) 17:00 KST → 11-20(금) 09:00 KST = 16시간 뒤
        expect(getTimeUntilKrxOpen(csat(17, 0)) / MS_HOUR).toBeCloseTo(16, 5);
    });

    it('주문 게이트는 수능일 시각을 따른다', () => {
        expect(krxOrderBlockReason({ now: csat(9, 30) })).toBe('거래시간 외: 장 개장 전 (현재: 9:30 KST, 개장: 10:00)');
        expect(krxOrderBlockReason({ now: csat(10, 0) })).toBeNull();
        expect(krxOrderBlockReason({ now: csat(16, 0) })).toBeNull();
        expect(krxOrderBlockReason({ now: csat(16, 30) })).toBe('거래시간 외: 장 마감 (현재: 16:30 KST, 마감: 16:30)');
    });

    it('종가 동시호가 신규 매수 차단은 수능일 16:20 부터이고 사유 문구도 그 시각이다', () => {
        expect(krxAuctionBuyBlockReason(csat(15, 25), 'buy')).toBeNull(); // 평소의 동시호가 시각이지만 수능일에는 정규 매매 중이다
        expect(krxAuctionBuyBlockReason(csat(16, 20), 'buy')).toBe('종가 동시호가 (16:20-16:30) — 신규 매수 진입 금지 (options.blockAuctionBuys)');
        expect(krxAuctionBuyBlockReason(normal(15, 25), 'buy')).toBe('종가 동시호가 (15:20-15:30) — 신규 매수 진입 금지 (options.blockAuctionBuys)');
    });

    it('NXT 세션은 바꾸지 않았다 — 수능일의 NXT 시각은 공지로 확인하지 못해 평소 시각 그대로다', () => {
        expect(getNxtSession(csat(8, 30))).toBe('pre-market');
        expect(getNxtSession(csat(15, 30))).toBe('after-market');
    });
});
