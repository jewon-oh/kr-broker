/**
 * @fileoverview NYSE/NASDAQ 거래시간 + 시장 단계 유틸리티
 * @description KRX 동시호가 가드의 미국장 대응.
 *
 * NYSE/NASDAQ 정규장: 09:30 ~ 16:00 ET (월~금, 휴장일 제외). 휴장일은 증권사 캘린더 API 가 알려 준 값을 쓴다.
 * - Opening Auction (Cross): 09:25 ~ 09:30 ET — 시초가 결정
 * - Closing Auction (Cross): 15:50 ~ 16:00 ET — 종가 결정
 *
 * ET ↔ UTC 변환은 `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' })`
 * 사용 — DST (3월 둘째 일요일 02:00 EST → 03:00 EDT / 11월 첫째 일요일
 * 02:00 EDT → 01:00 EST) 자동 처리. 오프셋을 직접 계산하면 DST 규칙을 매년
 * 검증해야 한다.
 */

import { isMarketClosedDay } from './market-calendar';

// ============ 상수 ============

/** 정규장 시작 시간 (시:분, ET) */
const MARKET_OPEN_HOUR_ET = 9;
const MARKET_OPEN_MINUTE_ET = 30;
/** 정규장 종료 시간 (시:분, ET) */
const MARKET_CLOSE_HOUR_ET = 16;
const MARKET_CLOSE_MINUTE_ET = 0;

/** 시초가 동시호가 시작 (09:25 ET) — opening cross window */
const PRE_AUCTION_OPEN_HOUR_ET = 9;
const PRE_AUCTION_OPEN_MINUTE_ET = 25;
/** 종가 동시호가 시작 (15:50 ET) — closing cross window */
const CLOSING_AUCTION_OPEN_HOUR_ET = 15;
const CLOSING_AUCTION_OPEN_MINUTE_ET = 50;

// ============ ET 시간 변환 ============

/**
 * UTC `Date` 를 ET wall-clock 부분 (연/월/일/시/분/요일) 으로 분해.
 * DST 자동 처리 — Intl 가 IANA 'America/New_York' 룰 사용.
 */
interface EtWallClock {
    /** 연도 (4자리) */
    year: number;
    /** 월 (1-12) */
    month: number;
    /** 일 (1-31) */
    day: number;
    /** 시 (0-23) */
    hour: number;
    /** 분 (0-59) */
    minute: number;
    /** 요일 (0=Sun, 1=Mon, ..., 6=Sat) */
    weekday: number;
}

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
});

const WEEKDAY_MAP: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function toEtWallClock(now: Date): EtWallClock {
    const parts = ET_FORMATTER.formatToParts(now);
    const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '0';
    let hour = parseInt(get('hour'), 10);
    if (hour === 24) hour = 0; // Intl 가 자정을 '24' 로 리턴하는 케이스 보정
    return {
        year: parseInt(get('year'), 10),
        month: parseInt(get('month'), 10),
        day: parseInt(get('day'), 10),
        hour,
        minute: parseInt(get('minute'), 10),
        weekday: WEEKDAY_MAP[get('weekday')] ?? 0,
    };
}

/** 그 ET 날짜가 휴장일인가. 증권사 캘린더 API(`market-calendar.ts`)가 알려 준 날짜만 안다. */
function isUsHoliday(et: EtWallClock): boolean {
    if (et.weekday === 0 || et.weekday === 6) return false;
    const ymd = String(et.year) + String(et.month).padStart(2, '0') + String(et.day).padStart(2, '0');
    return isMarketClosedDay('US', ymd);
}

// ============ 공개 API ============

/**
 * NYSE/NASDAQ 시장 단계.
 *
 * - `pre-auction`: 09:25-09:30 ET (opening cross window). 주문 가능하나 09:30 시점에 일괄 매칭.
 * - `open`: 09:30-15:50 ET. 정규 매매.
 * - `closing-auction`: 15:50-16:00 ET (closing cross window). 시장가 주문 시
 * 실제 체결 가격이 예상과 크게 다를 수 있음 — 신규 진입 금지 권장.
 * - `closed`: 주말 / 휴장일 / 정규장 외 시각.
 *
 * Pre/post-market (04:00-09:30, 16:00-20:00 ET) 은 KIS API 미지원 가정으로 `closed` 처리.
 */
export type UsMarketPhase = 'pre-auction' | 'open' | 'closing-auction' | 'closed';

export function getUsMarketPhase(now: Date = new Date()): UsMarketPhase {
    const et = toEtWallClock(now);

    // 주말 → closed
    if (et.weekday === 0 || et.weekday === 6) return 'closed';

    // 휴장일 → closed
    if (isUsHoliday(et)) return 'closed';

    const minutes = et.hour * 60 + et.minute;
    const preAuctionStart = PRE_AUCTION_OPEN_HOUR_ET * 60 + PRE_AUCTION_OPEN_MINUTE_ET;
    const openMin = MARKET_OPEN_HOUR_ET * 60 + MARKET_OPEN_MINUTE_ET;
    const closingAuctionStart = CLOSING_AUCTION_OPEN_HOUR_ET * 60 + CLOSING_AUCTION_OPEN_MINUTE_ET;
    const closeMin = MARKET_CLOSE_HOUR_ET * 60 + MARKET_CLOSE_MINUTE_ET;

    if (minutes < preAuctionStart || minutes >= closeMin) return 'closed';
    if (minutes < openMin) return 'pre-auction';
    if (minutes < closingAuctionStart) return 'open';
    return 'closing-auction';
}

/**
 * `now` 기준 다음 미국 정규장 개장(09:30 ET)까지의 밀리초.
 *
 * 호출하는 쪽의 스케줄러가 야간/주말/휴장에 무의미한 사이클을 돌리지 않고
 * 다음 개장까지 한 번에 건너뛰기 위한 헬퍼 — KRX 용 `getTimeUntilKrxOpen()`
 * 의 NYSE/NASDAQ 대응. 정규장/동시호가 윈도우(pre-auction·open·closing-auction) 중이면
 * 0 반환 — 호출자는 `max(intervalMs, 0)` 로 처리해 사이클을 계속.
 *
 * ET↔UTC 오프셋은 DST 로 -4(EDT)/-5(EST) 가 바뀌므로 `Intl` 기반 1-pass 역산 사용
 * (09:30 은 spring-forward gap 02:00-03:00 과 무관해 단일 패스로 정확).
 *
 * @param now 현재 시각. 미지정 시 `new Date`
 * @returns ms (음수 없음). 정규장 중이면 0
 */
export function getTimeUntilUsMarketOpen(now: Date = new Date()): number {
    // 정규장(및 opening/closing 동시호가) 중이면 계속 사이클.
    if (getUsMarketPhase(now) !== 'closed') return 0;

    const nowMs = now.getTime();
    const etNow = toEtWallClock(now);

    // 오늘(ET) 부터 최대 14일 내 첫 거래일의 09:30 ET 를 찾는다.
    for (let i = 0; i < 14; i++) {
        // i일 뒤 ET 캘린더 날짜 — 정오 UTC 앵커로 DST 무관하게 Y/M/D/요일 도출.
        const anchor = new Date(Date.UTC(etNow.year, etNow.month - 1, etNow.day + i, 12, 0));
        const year = anchor.getUTCFullYear();
        const month = anchor.getUTCMonth() + 1;
        const day = anchor.getUTCDate();
        const weekday = anchor.getUTCDay();

        if (weekday === 0 || weekday === 6) continue; // 주말
        if (isUsHoliday({ year, month, day, hour: 12, minute: 0, weekday })) continue; // 휴장일

        const openUtcMs = etWallClockToUtcMs(
            year, month, day, MARKET_OPEN_HOUR_ET, MARKET_OPEN_MINUTE_ET,
        );
        if (openUtcMs <= nowMs) continue; // 오늘 개장은 이미 지남 → 다음 날
        return openUtcMs - nowMs;
    }

    // 14일 내 개장을 못 찾는 경우는 사실상 불가 — 안전상 건너뛰지 않는다(0).
    return 0;
}

/**
 * ET wall-clock(연/월/일/시/분) 을 UTC epoch ms 로 변환 — DST 오프셋 `Intl` 역산(1-pass).
 * `asIfUtc`(그 wall-clock 을 UTC 로 가정) 를 ET 로 해석했을 때의 편차만큼 되돌려
 * 정확한 UTC 순간을 얻는다. 예: 09:30 EDT → 13:30 UTC.
 */
function etWallClockToUtcMs(
    year: number, month: number, day: number, hour: number, minute: number,
): number {
    const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);
    const et = toEtWallClock(new Date(asIfUtc));
    const etAsIfUtc = Date.UTC(et.year, et.month - 1, et.day, et.hour, et.minute);
    const offsetMs = etAsIfUtc - asIfUtc; // ET 가 UTC 보다 앞선 정도(서쪽이라 음수)
    return asIfUtc - offsetMs;
}

/**
 * 디버깅 / 로그 용 — 현재 ET wall-clock 문자열.
 * Test 의 phase 가드 메시지 등에 사용.
 */
export function formatEtWallClock(now: Date = new Date()): string {
    const et = toEtWallClock(now);
    const date = `${et.year}-${String(et.month).padStart(2, '0')}-${String(et.day).padStart(2, '0')}`;
    const time = `${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`;
    return `${date} ${time} ET`;
}
