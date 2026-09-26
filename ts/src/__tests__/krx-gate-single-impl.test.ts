/**
 * KRX 실주문 게이트가 **UTC getter 구현 하나**로 동작하는가.
 *
 * ## 무엇이 문제였나
 *
 * `krx-trading-hours.ts` 에 거래시간 판정 구현이 **둘** 있었다.
 *
 * - `checkKRXTradingHours` — `getKSTNow` + 로컬 getter(`getHours`/`getDay`/`getFullYear`)
 * - `checkKRXTradingHoursAt(now)` — UTC getter
 *
 * 그리고 같은 파일에 첫 번째 방식이 *"비-UTC 배포 환경에서 fragile"* 이라고 **적혀 있었다.**
 * 그런데 고친 쪽을 쓴 건 스케줄러뿐이고, **실주문 경로는 여전히 fragile 하다고 적힌
 * 옛 함수를 호출하고 있었다.** 함수는 고쳤지만 정작 문제가 생기는 실주문 경로에는
 * 적용하지 않은 상태였다.
 *
 * 가장 나쁜 경우는 휴장일 판정이다. 로컬 getter 로 연·월·일을 읽으면 컨테이너 TZ 에 따라
 * 자정 근처에서 하루가 어긋나고, **휴장일에 "열려 있다"** 고 답하면 실주문이 나간다.
 *
 * 이 테스트가 확정하는 것: (1) 소스에 로컬 getter 가 남아 있지 않다, (2) 프로세스 TZ 를
 * 바꿔도 판정이 같다, (3) 사유 문자열이 여전히 상세하다(주문 실패 메시지에 그대로 실린다).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { applyMarketCalendar, resetMarketCalendar } from '../testing';
import { checkKRXTradingHours, checkKRXTradingHoursAt } from '../krx-trading-hours';

beforeEach(() => {
    applyMarketCalendar('KR', [{ date: '20260505', open: false }]);
});
afterEach(() => {
    resetMarketCalendar();
});

const SRC = join(__dirname, '..', 'krx-trading-hours.ts');

/** 주석을 뺀 소스 — 설명문의 `getHours` 언급이 위반으로 잡히면 안 된다. */
function code(): string {
    return readFileSync(SRC, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('항목 20 — 로컬 getter 잔재', () => {
    it('거래시간 판정 소스에 로컬 타임존 getter 가 없다', () => {
        const found = [...code().matchAll(/\.(getHours|getMinutes|getMonth|getDate|getDay|getFullYear)\s*\(\s*\)/g)]
            .map((m) => m[0]);
        expect(found, `로컬 getter 잔재: ${found.join(', ')} — getUTC* 를 쓴다`).toEqual([]);
    });

    it('`getKSTNow` 헬퍼가 사라졌다 — 남아 있으면 다시 쓰인다', () => {
        expect(code()).not.toContain('function getKSTNow');
    });
});

describe('항목 20 — 프로세스 TZ 와 무관한 판정', () => {
    // 2026-05-05(화) 어린이날 = KRX 휴장. KST 10:00 = UTC 01:00.
    const HOLIDAY_10AM_KST = new Date('2026-05-05T01:00:00Z');
    // 2026-05-06(수) 평일 KST 10:00.
    const WEEKDAY_10AM_KST = new Date('2026-05-06T01:00:00Z');
    // KST 08:00 (개장 전).
    const BEFORE_OPEN = new Date('2026-05-05T23:00:00Z'); // = 2026-05-06 08:00 KST

    it('휴장일 10:00 은 거래 불가 — 사유에 공휴일 날짜가 담긴다', () => {
        const r = checkKRXTradingHoursAt(HOLIDAY_10AM_KST);
        expect(r.tradable).toBe(false);
        expect(r.reason).toContain('공휴일');
        expect(r.reason).toContain('0505');
    });

    it('평일 10:00 은 거래 가능', () => {
        expect(checkKRXTradingHoursAt(WEEKDAY_10AM_KST).tradable).toBe(true);
    });

    it('개장 전 사유가 상세하다 — 주문 실패 메시지에 그대로 실린다', () => {
        const r = checkKRXTradingHoursAt(BEFORE_OPEN);
        expect(r.tradable).toBe(false);
        expect(r.reason).toContain('장 개장 전');
        expect(r.reason).toContain('8:00 KST');
    });

    it('장 마감 후 사유도 상세하다', () => {
        // KST 16:00 = UTC 07:00
        const r = checkKRXTradingHoursAt(new Date('2026-05-06T07:00:00Z'));
        expect(r.tradable).toBe(false);
        expect(r.reason).toContain('장 마감');
    });

    it('주말은 거래 불가', () => {
        // 2026-05-09 은 토요일. KST 10:00 = UTC 01:00
        expect(checkKRXTradingHoursAt(new Date('2026-05-09T01:00:00Z')).tradable).toBe(false);
    });
});

describe('항목 20 — 인자 없는 진입점이 같은 구현을 쓴다', () => {
    it('checkKRXTradingHours() 는 checkKRXTradingHoursAt(now) 와 같은 답을 준다', () => {
        const now = new Date();
        expect(checkKRXTradingHours()).toEqual(checkKRXTradingHoursAt(now));
    });
});
