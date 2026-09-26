/**
 * @fileoverview 토스증권의 세션 판정과 세션별 주문 형태 제한.
 *
 * 국내는 `GET /market-calendar/KR`(KRX 와 NXT 통합)의 세션 구간으로, 미국은 `GET /market-calendar/US` 의 네 세션(주간거래·프리마켓·정규장·애프터마켓,
 * 전부 한국 시각)으로 지금 열려 있는 세션을 찾는다. 캘린더는 공휴일과 부분 휴장을 그대로 담고 있다.
 * 캘린더를 받지 못했을 때만 정적 시간표(`isTossOrderable`)로 판정한다. 그 폴백에서 국내 휴장일은 공용 캘린더가 알 때만 막고(모르면 연다),
 * 미국 확장세션은 막는다(좁히는 쪽).
 */

import { isTradingHours, getTimeUntilMarketOpen } from '../trading-hours';
import { krxOrderBlockReason } from '../krx-trading-hours';
import { usOrderBlockReason } from '../us-market-hours';
import { expandBusinessDays, type CalendarDay } from '../market-calendar';
import {
    tossMarketCountry,
    type TossUsMarketCalendar, type TossUsSession,
    type TossKrMarketCalendar, type TossKrSession,
} from './toss-types';

/**
 * 영업일 목록에서 `now` 가 속한 세션을 찾는다. `windowOf` 는 그 날의 세션 구간을 돌려주고, 구간이 없거나 시각이 깨졌으면 건너뛴다.
 * 세션을 정해진 순서(`order`)로 훑어 먼저 겹치는 것을 돌려주므로 경계 시각은 앞선 세션에 귀속된다.
 */
function findSessionAt<S extends string, D>(
    order: readonly S[],
    days: ReadonlyArray<D | null | undefined>,
    windowOf: (day: D, session: S) => { startTime?: string; endTime?: string } | null | undefined,
    now: Date,
): S | null {
    const t = now.getTime();
    for (const session of order) {
        for (const day of days) {
            if (!day) continue;
            const w = windowOf(day, session);
            if (!w?.startTime || !w?.endTime) continue;
            const start = Date.parse(w.startTime);
            const end = Date.parse(w.endTime);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            if (t >= start && t < end) return session;
        }
    }
    return null;
}

/** 캘린더 응답에서 세션을 훑는 순서. 세션 구간은 겹치지 않으므로 결과를 항상 같게 만들려는 순서다. */
const US_SESSION_ORDER: readonly TossUsSession[] = [
    'regularMarket', 'preMarket', 'dayMarket', 'afterMarket',
] as const;

/** 국내 세션을 훑는 순서. 경계 시각을 정규장으로 귀속시키려고 정규장을 먼저 본다. */
const KR_SESSION_ORDER: readonly TossKrSession[] = ['regularMarket', 'preMarket', 'afterMarket'] as const;

/** 금액 주문과 소수점 수량 주문은 정규장 종료 이 시간 전까지만 접수된다. */
export const FRACTIONAL_ORDER_CUTOFF_MS = 60 * 60 * 1000;

/**
 * 미국 캘린더에서 `now` 가 속한 세션을 찾는다. 휴장이거나 세션 사이의 공백이면 `null`.
 *
 * 전일·당일·익일 세 영업일을 모두 훑는다. 정규장은 한국 시각 22:30 에 시작해 다음날 05:00 에 끝나서, 새벽 시각의 현재 세션은 전일 항목에 들어 있다.
 * 구간은 `[시작, 종료)` 이다. 22:30 정각은 프리마켓의 종료이자 정규장의 시작이라 양쪽에 걸리는데, 정규장을 먼저 보므로 정규장으로 귀속된다.
 */
export function findUsSession(
    calendar: TossUsMarketCalendar | null | undefined,
    now: Date = new Date(),
): TossUsSession | null {
    if (!calendar) return null;
    const days = [calendar.previousBusinessDay, calendar.today, calendar.nextBusinessDay];
    return findSessionAt(US_SESSION_ORDER, days, (day, session) => day[session], now);
}

/** `now` 를 품은 미국 정규장 구간의 종료 시각(epoch ms). 정규장이 아니면 `null`. */
export function findUsRegularCloseMs(
    calendar: TossUsMarketCalendar | null | undefined,
    now: Date = new Date(),
): number | null {
    if (!calendar) return null;
    const t = now.getTime();
    for (const day of [calendar.previousBusinessDay, calendar.today, calendar.nextBusinessDay]) {
        const w = day?.regularMarket;
        if (!w?.startTime || !w?.endTime) continue;
        const start = Date.parse(w.startTime);
        const end = Date.parse(w.endTime);
        if (Number.isFinite(start) && Number.isFinite(end) && t >= start && t < end) return end;
    }
    return null;
}

/**
 * 국내 캘린더에서 `now` 가 속한 세션을 찾는다. 휴장이거나 세션 사이의 공백이면 `null`.
 *
 * 미국과 달리 세션이 `integrated`(KRX 와 NXT 통합) 아래 들어 있다. 전 시장이 쉬면 `integrated` 가 `null`이고 일부만 쉬면 그 세션만 `null` 이다.
 * 국내 세션은 자정을 넘지 않지만 전일과 익일도 함께 본다. 응답의 세 영업일 가운데 오늘이 어디에 있든 상관없게 하려는 것이다.
 */
export function findKrSession(
    calendar: TossKrMarketCalendar | null | undefined,
    now: Date = new Date(),
): TossKrSession | null {
    if (!calendar) return null;
    const days = [calendar.previousBusinessDay, calendar.today, calendar.nextBusinessDay];
    return findSessionAt(KR_SESSION_ORDER, days, (day, session) => day.integrated?.[session], now);
}

/** 주문 형태. 세션마다 허용하는 형태가 다르다. */
export interface TossOrderForm {
    /** 시장가인가. */
    isMarket: boolean;
    /** 금액(`orderAmount`) 주문인가. */
    useAmountBased: boolean;
    /** 주문 수량. 금액 주문이면 0. */
    quantity: number;
}

/** 금액 주문과 소수점 수량 주문의 접수 마감을 판정하는 데 쓰는 시각. */
export interface TossFractionalCutoff {
    nowMs: number;
    /** 지금 열려 있는 정규장의 종료 시각(epoch ms). */
    regularCloseMs: number;
}

/**
 * 미국 세션별로 허용하는 주문 형태를 검사한다(공식 스펙의 `POST /orders` 제약).
 *
 * - 금액 주문(`orderAmount`)과 소수점 수량 주문은 정규장 전용이며 정규장 종료 1시간 전까지만 접수된다.
 *   어기면 `422 amount-order-outside-regular-hours` 또는 `422 fractional-quantity-outside-regular-hours` 다.
 * - 시장가는 정규장 밖에서 접수되지 않는 것이 브로커의 관행이라 막는다. 스펙에 명시가 없어 `422 order-type-not-allowed` 로 거절될 수 있는데,
 *   요청을 보내 확인하기 전에 막는 편이 낫다.
 *
 * @returns 막는 사유(한국어). 접수할 수 있으면 `null`.
 */
export function usSessionOrderRestriction(
    session: TossUsSession,
    form: TossOrderForm,
    cutoff?: TossFractionalCutoff,
): string | null {
    const fractional = form.useAmountBased || !Number.isInteger(form.quantity);
    if (session === 'regularMarket') {
        if (fractional && cutoff !== undefined && cutoff.nowMs >= cutoff.regularCloseMs - FRACTIONAL_ORDER_CUTOFF_MS) {
            return form.useAmountBased
                ? '정규장 종료 1시간 전 이후: 금액(orderAmount) 주문은 접수되지 않는다'
                : '정규장 종료 1시간 전 이후: 소수점 수량 주문은 접수되지 않는다';
        }
        return null;
    }
    const label = `${session} 세션`;
    if (form.useAmountBased) return `${label}: 금액(orderAmount) 주문은 정규장 전용`;
    if (form.isMarket) return `${label}: 시장가 주문은 정규장 전용 — 지정가로 발주 필요`;
    if (!Number.isInteger(form.quantity)) return `${label}: 소수점 수량 주문은 정규장 전용`;
    return null;
}

/**
 * 국내 확장세션(프리마켓·애프터마켓)에서 허용하는 주문 형태.
 *
 * 토스의 국내 캘린더는 KRX 와 NXT 를 통합해 프리·애프터 세션이 그대로 내려오고, 주문 본문에 거래소를 지정하는 필드가 없다(라우팅은 토스가 한다).
 * 확장세션은 지정가만 받는 것이 브로커의 관행이라 미국 확장세션과 같은 규칙을 적용한다. 금액 주문, 시장가, 소수점 수량을 막는다.
 *
 * @returns 막는 사유(한국어). 접수할 수 있으면 `null`.
 */
export function krSessionOrderRestriction(
    session: TossKrSession,
    form: TossOrderForm,
): string | null {
    if (session === 'regularMarket') return null;
    const label = `KRX ${session} 세션`;
    if (form.useAmountBased) return `${label}: 금액(orderAmount) 주문은 정규장 전용`;
    if (form.isMarket) return `${label}: 시장가 주문은 정규장 전용 — 지정가로 발주 필요`;
    if (!Number.isInteger(form.quantity)) return `${label}: 소수점 수량 주문 불가`;
    return null;
}

/**
 * 국내 정규장이 열려 있는가(정적 시간표).
 *
 * @deprecated 라이브러리 안에서 쓰지 않는다. `kr-broker/trading-hours` 의 `isTradingHours('toss', now)` 를 쓴다. 다음 판에서 지운다.
 */
export function isTossTradingOpen(now: Date = new Date()): boolean {
    return isTradingHours('toss', now);
}

/**
 * 다음 국내 개장까지 남은 시간(ms). 열려 있으면 0.
 *
 * @deprecated 라이브러리 안에서 쓰지 않는다. `kr-broker/trading-hours` 의 `getTimeUntilMarketOpen('toss', now)` 를 쓴다. 다음 판에서 지운다.
 */
export function timeUntilTossOpen(now: Date = new Date()): number {
    return getTimeUntilMarketOpen('toss', now);
}

/**
 * 종목의 시장 기준으로 지금 주문할 수 있는 시간대인가. 캘린더를 받지 못했을 때의 폴백이고, 세 증권사 공용 게이트의 시장 규칙과 같다.
 *
 * - 국내: KRX 정규장(평일 09:00~15:30). 휴장일은 공용 캘린더가 알 때만 막고, 모르는 평일은 열린 것으로 본다.
 * - 미국: 미국 정규장과 종가 단일가만. 토스가 운영하는 주간거래·프리마켓·애프터마켓은 이 판정에 보이지 않아 좁게 막힌다.
 */
export function isTossOrderable(symbol: string, now: Date = new Date()): boolean {
    return tossMarketCountry(symbol) === 'US' ? usOrderBlockReason({ now }) === null : krxOrderBlockReason({ now }) === null;
}

/** 토스 캘린더의 `YYYY-MM-DD` 를 공용 캘린더의 `YYYYMMDD` 로 바꾼다. */
const toYmd = (date: string): string => date.replace(/-/g, '');

/**
 * 미국 캘린더(전일·당일·익일 영업일)를 날짜별 개장 여부로 바꾼다.
 * 네 세션 가운데 하나라도 있는 날이 열린 날이다. 세션이 `null` 이거나 키가 아예 없으면 그 세션은 없고, 네 세션이 모두 없는 날은 닫힌 날이다.
 * 전일과 익일 영업일 사이에서 응답에 없는 평일도 닫힌 날이다. 날짜가 없는 항목은 건너뛴다.
 */
export function tossUsCalendarDays(calendar: TossUsMarketCalendar | null | undefined): CalendarDay[] {
    if (!calendar) return [];
    const open: string[] = [];
    const closed: string[] = [];
    for (const day of [calendar.previousBusinessDay, calendar.today, calendar.nextBusinessDay]) {
        if (!day || typeof day.date !== 'string' || day.date === '') continue;
        const hasSession = day.dayMarket != null || day.preMarket != null
            || day.regularMarket != null || day.afterMarket != null;
        (hasSession ? open : closed).push(toYmd(day.date));
    }
    return expandBusinessDays(open, closed);
}

/**
 * 국내 캘린더를 날짜별 개장 여부로 바꾼다. KRX 정규장이 열리는 날만 열린 날이다.
 * NXT 프리마켓만 쉬는 부분 휴장일에도 정규장이 있으므로 열린 날로 본다.
 */
export function tossKrCalendarDays(calendar: TossKrMarketCalendar | null | undefined): CalendarDay[] {
    if (!calendar) return [];
    const open: string[] = [];
    const closed: string[] = [];
    for (const day of [calendar.previousBusinessDay, calendar.today, calendar.nextBusinessDay]) {
        if (!day) continue;
        (day.integrated?.regularMarket ? open : closed).push(toYmd(day.date));
    }
    return expandBusinessDays(open, closed);
}
