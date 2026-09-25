/**
 * @fileoverview KRX 거래시간 유틸리티(세 증권사 공용)
 * @description 한국 주식시장(KRX) 정규장 시간 체크
 *
 * KRX 정규장: 09:00 ~ 15:30 (KST)
 * - 시간외 단일가: 16:00 ~ 18:00 (미구현)
 * - 주말/휴장일: 휴장. 휴장일은 공용 캘린더(`market-calendar.ts`)가 아는 날만 막는다
 *
 * NXT(넥스트레이드) 확장 세션: 프리 08:00~08:50 / 애프터 15:30~20:00 —
 * 정규장 밖 확장 거래는 `getNxtSession` / `isNxtExtendedTradable` 참조.
 */

import { isMarketClosedDay } from './market-calendar';

// ============ 상수 ============

/** 정규장 시작 시간 (시) */
const MARKET_OPEN_HOUR = 9;
/** 정규장 시작 시간 (분) */
const MARKET_OPEN_MINUTE = 0;
/** 정규장 종료 시간 (시) */
const MARKET_CLOSE_HOUR = 15;
/** 정규장 종료 시간 (분) */
const MARKET_CLOSE_MINUTE = 30;

/** 한국 시간대 오프셋 (UTC+9) */
const KST_OFFSET_HOURS = 9;

// ============ 유틸리티 ============

// ============ 공개 API ============

/**
 * KRX 정규장 거래 가능 시간인지 확인
 *
 * 체크 항목:
 * 1. 주말 여부 (토/일 = 휴장)
 * 2. 휴장일 여부 (공용 캘린더의 `isMarketClosedDay`)
 * 3. 정규장 시간 (09:00 ~ 15:30 KST)
 *
 * @returns { tradable, reason } — 거래 가능 여부 + 사유
 */
export function checkKRXTradingHours(): { tradable: boolean; reason?: string } {
    return checkKRXTradingHoursAt(new Date());
}

// ============ KRX 시장 단계 인식 ============

/**
 * KRX 정규장의 세부 단계 — 동시호가 시간대는 호가 처리 방식이 다름.
 *
 * - `pre-auction` (08:30-09:00 KST): 시초가 결정 동시호가. 주문 수집만 (미체결).
 * - `open` (09:00-15:20 KST): 정규 매매 시간.
 * - `closing-auction` (15:20-15:30 KST): 종가 결정 동시호가. 시장가 주문 시
 * 실제 체결 가격이 예상과 크게 다를 수 있어 신규 진입 금지 권장.
 * - `closed`: 정규장 외 (주말/공휴일 포함).
 */
export type KrxMarketPhase = 'pre-auction' | 'open' | 'closing-auction' | 'closed';

/** 시초가 결정 동시호가 시작 (08:30 KST) */
const PRE_AUCTION_OPEN_HOUR = 8;
const PRE_AUCTION_OPEN_MINUTE = 30;
/** 종가 결정 동시호가 시작 (15:20 KST) */
const CLOSING_AUCTION_OPEN_HOUR = 15;
const CLOSING_AUCTION_OPEN_MINUTE = 20;

/**
 * `now` 기준 KRX 시장 단계 반환.
 * 주말/공휴일 → `closed`. 신규 진입 가드는 `open` 단계만 허용 권장.
 */
export function getKrxMarketPhase(now: Date = new Date()): KrxMarketPhase {
    const kstWall = new Date(now.getTime() + KST_OFFSET_HOURS * 60 * 60 * 1000);

    // 주말 / 공휴일 → closed
    if (kstWall.getUTCDay() === 0 || kstWall.getUTCDay() === 6) return 'closed';
    if (isKRXHolidayUTC(kstWall)) return 'closed';

    const minutes = kstWall.getUTCHours() * 60 + kstWall.getUTCMinutes();
    const preAuctionStart = PRE_AUCTION_OPEN_HOUR * 60 + PRE_AUCTION_OPEN_MINUTE;
    const openMin = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const closingAuctionStart = CLOSING_AUCTION_OPEN_HOUR * 60 + CLOSING_AUCTION_OPEN_MINUTE;
    const closeMin = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;

    if (minutes < preAuctionStart || minutes >= closeMin) return 'closed';
    if (minutes < openMin) return 'pre-auction';
    if (minutes < closingAuctionStart) return 'open';
    return 'closing-auction';
}

// ============ 다음 개장까지의 시간 ============

/**
 * `now` 기준 다음 KRX 개장(09:00 KST, 휴장일 skip)까지의 밀리초.
 *
 * @param now 현재 시각. 미지정 시 `new Date()`
 * @returns ms (음수 없음). 지금 거래 가능하면 0
 */
export function getTimeUntilKrxOpen(now: Date = new Date()): number {
    // 현재가 KRX 거래 가능 시간이면 0 — 호출자는 max(intervalMs, 0)로 처리
    if (checkKRXTradingHoursAt(now).tradable) return 0;

    // 1) 오늘 09:00 KST 의 UTC ms 계산
    const nowKstWall = new Date(now.getTime() + KST_OFFSET_HOURS * 60 * 60 * 1000);
    const todayKstY = nowKstWall.getUTCFullYear();
    const todayKstM = nowKstWall.getUTCMonth();
    const todayKstD = nowKstWall.getUTCDate();

    let candidate = Date.UTC(todayKstY, todayKstM, todayKstD, MARKET_OPEN_HOUR, MARKET_OPEN_MINUTE)
        - KST_OFFSET_HOURS * 60 * 60 * 1000;

    // 2) 이미 지났으면 다음 날로
    if (candidate <= now.getTime()) {
        candidate += 24 * 60 * 60 * 1000;
    }

    // 3) 주말/휴일 skip (최대 14일 안전 루프)
    for (let i = 0; i < 14; i++) {
        const candKst = new Date(candidate + KST_OFFSET_HOURS * 60 * 60 * 1000);
        const day = candKst.getUTCDay();
        if (day === 0 || day === 6) {
            candidate += 24 * 60 * 60 * 1000;
            continue;
        }
        if (isKRXHolidayUTC(candKst)) {
            candidate += 24 * 60 * 60 * 1000;
            continue;
        }
        break;
    }

    return Math.max(0, candidate - now.getTime());
}

/**
 * KRX 거래 가능 시간 체크 — **유일 구현**.
 *
 * 모든 필드 비교는 `getUTC*` 로 한다: `now+9h` 의 wall-clock 이 곧 KST 라, 프로세스가
 * 어느 타임존에서 돌든 같은 답이 나온다.
 *
 * 사유 문자열은 `tradingHoursBlockReason` 을 거쳐 주문을 막는 오류 메시지에 그대로 실린다.
 */
export function checkKRXTradingHoursAt(now: Date): { tradable: boolean; reason?: string } {
    const kstWall = new Date(now.getTime() + KST_OFFSET_HOURS * 60 * 60 * 1000);
    if (kstWall.getUTCDay() === 0 || kstWall.getUTCDay() === 6) {
        return { tradable: false, reason: '주말 — KRX 휴장' };
    }
    const holiday = krxHolidayMmdd(kstWall);
    if (holiday) {
        return { tradable: false, reason: `공휴일 — KRX 휴장 (${holiday})` };
    }
    const hours = kstWall.getUTCHours();
    const mins = kstWall.getUTCMinutes();
    const minutes = hours * 60 + mins;
    const openMin = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const closeMin = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;
    const clock = `${hours}:${String(mins).padStart(2, '0')} KST`;
    if (minutes < openMin) {
        return {
            tradable: false,
            reason: `장 개장 전 (현재: ${clock}, 개장: ${MARKET_OPEN_HOUR}:${String(MARKET_OPEN_MINUTE).padStart(2, '0')})`,
        };
    }
    if (minutes >= closeMin) {
        return {
            tradable: false,
            reason: `장 마감 (현재: ${clock}, 마감: ${MARKET_CLOSE_HOUR}:${String(MARKET_CLOSE_MINUTE).padStart(2, '0')})`,
        };
    }
    return { tradable: true };
}

/** 휴장일이면 `MMDD`, 아니면 `null`. 인자는 `now+KST_OFFSET` 으로 만든 KST-shifted Date. */
function krxHolidayMmdd(kstShiftedDate: Date): string | null {
    const weekday = kstShiftedDate.getUTCDay();
    if (weekday === 0 || weekday === 6) return null;
    const mmdd = String(kstShiftedDate.getUTCMonth() + 1).padStart(2, '0')
        + String(kstShiftedDate.getUTCDate()).padStart(2, '0');
    const ymd = String(kstShiftedDate.getUTCFullYear()) + mmdd;
    return isMarketClosedDay('KR', ymd) ? mmdd : null;
}

/**
 * KRX 휴장일 여부.
 * 인자는 `now+KST_OFFSET` 으로 만든 KST-shifted Date 이고, UTC 메서드만 써서 시스템 시간대와 무관하게 동작한다.
 */
function isKRXHolidayUTC(kstShiftedDate: Date): boolean {
    return krxHolidayMmdd(kstShiftedDate) !== null;
}

// ============ NXT (넥스트레이드) 확장 세션 ============

/**
 * NXT(대체거래소) 세션 — KRX 정규장(09:00~15:30) 밖에서도 NXT 상장 종목(일부)이 거래됨.
 *
 * - `pre-market` (08:00~08:50 KST): 프리마켓 단일가. 지정가 계열만.
 * - `pre-pause` (08:50~09:00 KST): NXT 정지 — 주문 접수만, 미체결.
 * - `main` (09:00~15:20 KST): 메인마켓 연속매매. KRX 정규장과 병행 → SOR 최선집행 대상.
 * - `krx-closing-auction` (15:20~15:30 KST): KRX 종가 동시호가 동안 NXT 정지.
 * - `after-market` (15:30~20:00 KST): 애프터마켓. 15:30~15:40 개시 단일가 → 이후 연속.
 * 지정가/최유리/최우선만 허용(시장가 불가), 가격제한 ±30% 전일 기준.
 * - `closed`: 그 외 시간 + 주말/공휴일.
 *
 * 정규장 관련 상수(09:00·15:20·15:30)는 위 `MARKET_*` / `CLOSING_AUCTION_*` 를 재사용.
 */
export type NxtSession =
    | 'pre-market'
    | 'pre-pause'
    | 'main'
    | 'krx-closing-auction'
    | 'after-market'
    | 'closed';

/** NXT 프리마켓 시작 (08:00 KST) */
const NXT_PRE_OPEN_HOUR = 8;
const NXT_PRE_OPEN_MINUTE = 0;
/** NXT 프리마켓 종료 = 매칭 정지 시작 (08:50 KST) */
const NXT_PRE_CLOSE_HOUR = 8;
const NXT_PRE_CLOSE_MINUTE = 50;
/** NXT 애프터마켓 종료 (20:00 KST) */
const NXT_AFTER_CLOSE_HOUR = 20;
const NXT_AFTER_CLOSE_MINUTE = 0;

/**
 * `now` 기준 NXT 세션 단계 반환.
 * 주말/공휴일 → `closed`. 시각 비교는 `getKrxMarketPhase` 와 동일하게 `now+KST_OFFSET`
 * 의 UTC 필드로 수행 → 시스템 TZ 무관.
 */
export function getNxtSession(now: Date = new Date()): NxtSession {
    const kstWall = new Date(now.getTime() + KST_OFFSET_HOURS * 60 * 60 * 1000);

    if (kstWall.getUTCDay() === 0 || kstWall.getUTCDay() === 6) return 'closed';
    if (isKRXHolidayUTC(kstWall)) return 'closed';

    const minutes = kstWall.getUTCHours() * 60 + kstWall.getUTCMinutes();
    const preOpen = NXT_PRE_OPEN_HOUR * 60 + NXT_PRE_OPEN_MINUTE;                        // 08:00
    const prePause = NXT_PRE_CLOSE_HOUR * 60 + NXT_PRE_CLOSE_MINUTE;                     // 08:50
    const mainOpen = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;                         // 09:00
    const mainClose = CLOSING_AUCTION_OPEN_HOUR * 60 + CLOSING_AUCTION_OPEN_MINUTE;      // 15:20
    const afterOpen = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;                      // 15:30
    const afterClose = NXT_AFTER_CLOSE_HOUR * 60 + NXT_AFTER_CLOSE_MINUTE;               // 20:00

    if (minutes < preOpen) return 'closed';
    if (minutes < prePause) return 'pre-market';
    if (minutes < mainOpen) return 'pre-pause';
    if (minutes < mainClose) return 'main';
    if (minutes < afterOpen) return 'krx-closing-auction';
    if (minutes < afterClose) return 'after-market';
    return 'closed';
}

/**
 * NXT 확장 거래(정규장 밖) 가능 시간인지 — 주문 라우팅 게이트용.
 *
 * 프리마켓(08:00~08:50) 또는 애프터마켓(15:30~20:00) 이면 `true`.
 * 정규장(09:00~15:30)·정지(08:50~09:00, 15:20~15:30)·휴장은 `false`
 * — 정규장은 기존 KRX 경로가 처리하므로 확장 라우팅 대상이 아님.
 */
export function isNxtExtendedTradable(now: Date = new Date()): boolean {
    const session = getNxtSession(now);
    return session === 'pre-market' || session === 'after-market';
}

// ============ 주문 게이트 ============

/** KRX 주문 게이트가 여는 세션. `regular` 는 KRX 정규장(09:00~15:30), `nxt` 는 NXT 프리마켓·메인마켓·애프터마켓이다. */
export type KrxOrderSession = 'regular' | 'nxt';

/** KRX 주문 게이트의 입력. */
export interface KrxOrderGate {
    /** 판정 시각. 증권사 클래스는 인스턴스 시계(`new Date(this.milliseconds())`)를 넘긴다. */
    now: Date;
    /** 신규 주문의 방향. 정정처럼 신규 진입이 아닌 주문은 비운다. */
    side?: string | undefined;
    /** 종가 동시호가(15:20~15:30)의 신규 매수를 막는다. 시장 규칙이 아니라 진입 정책이라 기본은 `false` 다. */
    blockAuctionBuys?: boolean | undefined;
    /** 주문을 받는 세션. 하나라도 열려 있으면 보낸다. 기본은 정규장만이다. */
    sessions?: readonly KrxOrderSession[] | undefined;
}

/**
 * 종가 동시호가(15:20~15:30)의 신규 매수를 막는 사유. 매수가 아니거나 동시호가가 아니면 `null`.
 *
 * KRX 는 이 시간에도 호가를 받는다(시장 규칙으로 막히는 주문이 아니다). 단일가라 시장가 체결가가 예상과 크게 다를 수 있어 진입을
 * 피하려는 호출하는 쪽의 정책이므로, 증권사 클래스는 `options.blockAuctionBuys` 가 켜졌을 때만 이 판정을 건다.
 */
export function krxAuctionBuyBlockReason(now: Date, side: string | undefined): string | null {
    if (side !== 'buy' || getKrxMarketPhase(now) !== 'closing-auction') return null;
    return '종가 동시호가 (15:20-15:30) — 신규 매수 진입 금지 (options.blockAuctionBuys)';
}

/**
 * KRX 주문을 지금 막는 사유. 보내도 되면 `null`. 세 증권사가 같은 시각에 같은 판정을 내도록 한 곳에 둔다.
 *
 * 시장 규칙(정규장·NXT 세션, 휴장일)은 늘 판정한다. 휴장일은 공용 캘린더가 아는 날만 막으므로 호출하는 쪽이 캘린더를 먼저 받는다.
 * 동시호가 신규 매수 차단은 `blockAuctionBuys` 를 켰을 때만 건다.
 */
export function krxOrderBlockReason(gate: KrxOrderGate): string | null {
    const { now, side, blockAuctionBuys = false, sessions = ['regular'] } = gate;
    const regular = sessions.includes('regular') ? checkKRXTradingHoursAt(now) : undefined;
    const nxt = sessions.includes('nxt') ? getNxtSession(now) : undefined;
    const nxtOpen = nxt === 'pre-market' || nxt === 'main' || nxt === 'after-market';
    if (regular?.tradable !== true && !nxtOpen) {
        if (regular === undefined) return `NXT 거래시간 외 (session=${nxt ?? 'closed'})`;
        return nxt === undefined ? `거래시간 외: ${regular.reason}` : `거래시간 외: ${regular.reason} (NXT session=${nxt})`;
    }
    return blockAuctionBuys ? krxAuctionBuyBlockReason(now, side) : null;
}

// ============ 영업일 판정 ============

/**
 * KST 달력 날짜(`YYYYMMDD`)가 **KRX 영업일**인지 — 주말도 휴장일도 아니면 true.
 *
 * 위의 시간대 판정과 달리 **시각을 보지 않는다.** 정산·결제처럼 하루 단위로 세는 로직이
 * 쓴다. 장 마감 뒤에도 그날은 여전히 영업일이다.
 *
 * 휴장일은 증권사 캘린더 API 가 알려 준 값(`market-calendar.ts`)으로 판정한다. 캘린더를 받지
 * 못한 날짜는 주말만 걸러지므로, 휴장일이 영업일로 세어져 날짜 간격이 실제보다 좁게 나온다.
 * 어댑터가 캘린더를 받고 있는지는 `marketCalendarStatus('KR')` 로 확인한다.
 *
 * @param ymd KST 달력 날짜 `YYYYMMDD`. 형식이 어긋나면 false.
 */
export function isKrxBusinessDayKst(ymd: string): boolean {
    if (!/^\d{8}$/.test(ymd)) return false;
    const year = Number(ymd.slice(0, 4));
    const month = Number(ymd.slice(4, 6));
    const day = Number(ymd.slice(6, 8));
    // UTC 로 만든 뒤 `getUTC*` 로 읽는다 — 이 파일의 다른 판정과 같은 관례라 시스템 TZ 와 무관하다.
    const asUtc = new Date(Date.UTC(year, month - 1, day));
    // 존재하지 않는 날짜(`20260231`)는 롤오버되므로 되짚어 확인한다.
    if (asUtc.getUTCFullYear() !== year || asUtc.getUTCMonth() !== month - 1 || asUtc.getUTCDate() !== day) {
        return false;
    }
    const weekday = asUtc.getUTCDay();
    if (weekday === 0 || weekday === 6) return false;
    return !isKRXHolidayUTC(asUtc);
}
