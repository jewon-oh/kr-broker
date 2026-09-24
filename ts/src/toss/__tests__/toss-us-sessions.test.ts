/**
 * @fileoverview 토스 장 세션 판정 — findUsSession / findKrSession / usSessionOrderRestriction.
 *
 * 배경: 기존 게이트가 KIS us-market-hours(NYSE 정규장)만 봐서 토스가 실제 운영하는
 * 주간거래(09:00~16:50 KST)·프리마켓(17:00~22:30)·애프터마켓(05:00~07:00)이 통째로
 * '휴장' 처리됐다. 캘린더(`GET /api/v1/market-calendar/US`) 기준으로 바로잡는다.
 *
 * 픽스처는 공식 스펙(openapi v1.2.5) 의 businessDay 예시를 그대로 옮긴 것 — 시간은 전부 KST.
 */

import { describe, it, expect } from 'vitest';
import { findUsSession, findKrSession, usSessionOrderRestriction } from '../toss-trading-hours';
import type {
    TossUsMarketCalendar, TossUsBusinessDay, TossKrMarketCalendar, TossKrBusinessDay,
} from '../toss-types';

/** 3/25(수) 기준 영업일 — regularMarket 은 22:30 시작 → 익일 05:00 종료. */
const day = (d: string, next: string): TossUsBusinessDay => ({
    date: d,
    dayMarket: { startTime: `${d}T09:00:00+09:00`, endTime: `${d}T16:50:00+09:00` },
    preMarket: { startTime: `${d}T17:00:00+09:00`, endTime: `${d}T22:30:00+09:00` },
    regularMarket: { startTime: `${d}T22:30:00+09:00`, endTime: `${next}T05:00:00+09:00` },
    afterMarket: { startTime: `${d}T05:00:00+09:00`, endTime: `${d}T07:00:00+09:00` },
});

const CAL: TossUsMarketCalendar = {
    previousBusinessDay: day('2026-03-24', '2026-03-25'),
    today: day('2026-03-25', '2026-03-26'),
    nextBusinessDay: day('2026-03-26', '2026-03-27'),
};

/** KST 시각 → Date. */
const kst = (iso: string): Date => new Date(`${iso}+09:00`);

describe('findUsSession — 4세션 판정 (KST)', () => {
    it('주간거래(dayMarket) 09:00~16:50', () => {
        expect(findUsSession(CAL, kst('2026-03-25T09:00:00'))).toBe('dayMarket');
        expect(findUsSession(CAL, kst('2026-03-25T14:30:00'))).toBe('dayMarket');
    });

    it('프리마켓 17:00~22:30 — NYSE 정규장만 보는 판정이 closed 로 오판하던 구간', () => {
        expect(findUsSession(CAL, kst('2026-03-25T17:00:00'))).toBe('preMarket');
        expect(findUsSession(CAL, kst('2026-03-25T21:55:00'))).toBe('preMarket');
    });

    it('정규장 22:30~익일 05:00 — 자정을 넘어 today 엔트리에 걸쳐 있다', () => {
        expect(findUsSession(CAL, kst('2026-03-25T22:30:00'))).toBe('regularMarket');
        expect(findUsSession(CAL, kst('2026-03-26T03:00:00'))).toBe('regularMarket');
    });

    it('새벽 애프터마켓은 previousBusinessDay 엔트리에서 찾는다', () => {
        // 3/25 05:30 은 today.afterMarket(3/25 05:00~07:00) 구간.
        expect(findUsSession(CAL, kst('2026-03-25T05:30:00'))).toBe('afterMarket');
    });

    it('세션 간 공백(16:50~17:00)·휴장·캘린더 없음 → null', () => {
        expect(findUsSession(CAL, kst('2026-03-25T16:55:00'))).toBeNull();
        expect(findUsSession(null, kst('2026-03-25T21:00:00'))).toBeNull();
        const holiday: TossUsMarketCalendar = {
            today: { date: '2026-07-03', dayMarket: null, preMarket: null, regularMarket: null, afterMarket: null },
        };
        expect(findUsSession(holiday, kst('2026-07-03T23:00:00'))).toBeNull();
    });

    it('경계는 [start, end) — 22:30 정각은 프리마켓 종료가 아니라 정규장 시작', () => {
        expect(findUsSession(CAL, kst('2026-03-25T22:29:59'))).toBe('preMarket');
        expect(findUsSession(CAL, kst('2026-03-25T22:30:00'))).toBe('regularMarket');
    });
});

/** KR 은 세션이 `integrated`(KRX+NXT 통합) 아래 중첩되고 부분 휴장이 가능하다. */
const krDay = (d: string): TossKrBusinessDay => ({
    date: d,
    integrated: {
        preMarket: { startTime: `${d}T08:00:00+09:00`, endTime: `${d}T09:00:00+09:00` },
        regularMarket: { startTime: `${d}T09:00:00+09:00`, endTime: `${d}T15:30:00+09:00` },
        afterMarket: { startTime: `${d}T15:30:00+09:00`, endTime: `${d}T20:00:00+09:00` },
    },
});

describe('findKrSession — KRX+NXT 통합 세션 (휴장일 반영)', () => {
    const CAL_KR: TossKrMarketCalendar = {
        previousBusinessDay: krDay('2026-03-24'),
        today: krDay('2026-03-25'),
        nextBusinessDay: krDay('2026-03-26'),
    };

    it('정규장 09:00~15:30 / 프리 08:00~09:00 / 애프터 15:30~20:00', () => {
        expect(findKrSession(CAL_KR, kst('2026-03-25T10:00:00'))).toBe('regularMarket');
        expect(findKrSession(CAL_KR, kst('2026-03-25T08:30:00'))).toBe('preMarket');
        expect(findKrSession(CAL_KR, kst('2026-03-25T17:00:00'))).toBe('afterMarket');
    });

    it('경계는 [start, end) — 09:00 은 정규장, 15:30 은 애프터마켓', () => {
        expect(findKrSession(CAL_KR, kst('2026-03-25T09:00:00'))).toBe('regularMarket');
        expect(findKrSession(CAL_KR, kst('2026-03-25T15:30:00'))).toBe('afterMarket');
    });

    it('전 시장 휴장(integrated=null) → null — 정적 시간표가 놓치던 공휴일', () => {
        const holiday: TossKrMarketCalendar = { today: { date: '2026-05-05', integrated: null } };
        expect(findKrSession(holiday, kst('2026-05-05T10:00:00'))).toBeNull();
    });

    it('부분 휴장(NXT 프리마켓만 null) → 정규장은 정상 판정', () => {
        const partial: TossKrMarketCalendar = {
            today: { ...krDay('2026-03-25'), integrated: { ...krDay('2026-03-25').integrated!, preMarket: null } },
        };
        expect(findKrSession(partial, kst('2026-03-25T08:30:00'))).toBeNull();
        expect(findKrSession(partial, kst('2026-03-25T10:00:00'))).toBe('regularMarket');
    });

    it('장 마감 후(20:00 이후)·캘린더 없음 → null', () => {
        expect(findKrSession(CAL_KR, kst('2026-03-25T21:00:00'))).toBeNull();
        expect(findKrSession(null, kst('2026-03-25T10:00:00'))).toBeNull();
    });
});

describe('usSessionOrderRestriction — 세션별 허용 주문 형태', () => {
    const qty1 = { isMarket: false, useAmountBased: false, quantity: 1 };

    it('정규장은 형태 제한 없음', () => {
        expect(usSessionOrderRestriction('regularMarket', qty1)).toBeNull();
        expect(usSessionOrderRestriction('regularMarket', { ...qty1, isMarket: true })).toBeNull();
        expect(usSessionOrderRestriction('regularMarket', { ...qty1, useAmountBased: true })).toBeNull();
        expect(usSessionOrderRestriction('regularMarket', { ...qty1, quantity: 0.5 })).toBeNull();
    });

    it('정규장 외: 정수 수량 지정가만 허용', () => {
        expect(usSessionOrderRestriction('preMarket', qty1)).toBeNull();
        expect(usSessionOrderRestriction('dayMarket', qty1)).toBeNull();
        expect(usSessionOrderRestriction('afterMarket', qty1)).toBeNull();
    });

    it('정규장 외: 금액 주문 차단 (422 amount-order-outside-regular-hours 사전 차단)', () => {
        expect(usSessionOrderRestriction('preMarket', { ...qty1, useAmountBased: true }))
            .toContain('금액(orderAmount) 주문은 정규장 전용');
    });

    it('정규장 외: 시장가 차단', () => {
        expect(usSessionOrderRestriction('preMarket', { ...qty1, isMarket: true }))
            .toContain('시장가 주문은 정규장 전용');
    });

    it('정규장 외: 소수점 수량 차단 (422 fractional-quantity-outside-regular-hours)', () => {
        expect(usSessionOrderRestriction('afterMarket', { ...qty1, quantity: 0.5 }))
            .toContain('소수점 수량 주문은 정규장 전용');
    });
});
