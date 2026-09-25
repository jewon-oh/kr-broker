/**
 * @fileoverview 이름을 바꾼 공개 이름의 옛 별칭이 새 이름과 같은 값과 타입을 가리키는지 본다. 별칭은 다음 판에서 지운다.
 *
 * 타입 비교(`expectTypeOf`)는 실행 시 아무것도 하지 않고 `pnpm typecheck` 가 검사한다.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { StockMarketGroup } from '../broker-market-group';
import { KbsecAuth, KBSecAuth } from '../kbsec/kbsec-auth';
import {
    isKbsecBusinessError,
    isKBSecBusinessError,
    isKbsecTokenFailure,
    isKBSecTokenFailure,
    type KbsecResponseHeader,
    type KBSecResponseHeader,
} from '../kbsec/kbsec-envelope';
import type { KbsecErrorMapping, KBSecErrorMapping } from '../kbsec/kbsec-error-codes';
import {
    isKbsecOrderTr,
    isKBSecOrderTr,
    type KbsecCachedToken,
    type KBSecCachedToken,
    type KbsecCommonOutput,
    type KBSecCommonOutput,
    type KbsecCredentials,
    type KBSecCredentials,
    type KbsecDataHeader,
    type KBSecDataHeader,
    type KBSecMarketCountry,
    type KbsecRequestEnvelope,
    type KBSecRequestEnvelope,
    type KbsecResponseEnvelope,
    type KBSecResponseEnvelope,
    type KbsecTokenResponse,
    type KBSecTokenResponse,
} from '../kbsec/kbsec-types';
import { KisAuth, KISAuth } from '../kis/kis-auth';
import { KisCandleService, KISCandleService } from '../kis/kis-candle-service';
import type {
    KisApprovalResponse,
    KISApprovalResponse,
    KisCachedToken,
    KISCachedToken,
    KisCredentials,
    KISCredentials,
    KisDailyCandle,
    KISDailyCandle,
    KisOverseasDailyCandle,
    KISOverseasDailyCandle,
} from '../kis/kis-types';
import { getTickSize } from '../kis/kis-types';
import { getKrxTickSize } from '../krx-tick-size';
import type { CalendarMarket } from '../market-calendar';
import type { TossMarketCountry } from '../toss/toss-types';

describe('옛 이름 별칭', () => {
    it('클래스와 함수의 옛 이름은 새 이름과 같은 값이다', () => {
        expect(KISAuth).toBe(KisAuth);
        expect(KISCandleService).toBe(KisCandleService);
        expect(KBSecAuth).toBe(KbsecAuth);
        expect(isKBSecOrderTr).toBe(isKbsecOrderTr);
        expect(isKBSecTokenFailure).toBe(isKbsecTokenFailure);
        expect(isKBSecBusinessError).toBe(isKbsecBusinessError);
        expect(getTickSize).toBe(getKrxTickSize);
    });

    it('옛 클래스 이름으로 만든 인스턴스는 새 클래스의 인스턴스다', () => {
        const auth = new KISAuth('app-key', {
            requestToken: () => Promise.reject(new Error('부르지 않는다')),
            requestApprovalKey: () => Promise.reject(new Error('부르지 않는다')),
        });
        expect(auth).toBeInstanceOf(KisAuth);
    });

    it('타입의 옛 이름은 새 이름과 같은 타입이다', () => {
        expectTypeOf<KISAuth>().toEqualTypeOf<KisAuth>();
        expectTypeOf<KISCandleService>().toEqualTypeOf<KisCandleService>();
        expectTypeOf<KISCredentials>().toEqualTypeOf<KisCredentials>();
        expectTypeOf<KISCachedToken>().toEqualTypeOf<KisCachedToken>();
        expectTypeOf<KISDailyCandle>().toEqualTypeOf<KisDailyCandle>();
        expectTypeOf<KISOverseasDailyCandle>().toEqualTypeOf<KisOverseasDailyCandle>();
        expectTypeOf<KISApprovalResponse>().toEqualTypeOf<KisApprovalResponse>();
        expectTypeOf<KBSecAuth>().toEqualTypeOf<KbsecAuth>();
        expectTypeOf<KBSecErrorMapping>().toEqualTypeOf<KbsecErrorMapping>();
        expectTypeOf<KBSecResponseHeader>().toEqualTypeOf<KbsecResponseHeader>();
        expectTypeOf<KBSecCredentials>().toEqualTypeOf<KbsecCredentials>();
        expectTypeOf<KBSecDataHeader>().toEqualTypeOf<KbsecDataHeader>();
        expectTypeOf<KBSecRequestEnvelope>().toEqualTypeOf<KbsecRequestEnvelope>();
        expectTypeOf<KBSecRequestEnvelope<{ a: 1 }>>().toEqualTypeOf<KbsecRequestEnvelope<{ a: 1 }>>();
        expectTypeOf<KBSecResponseEnvelope>().toEqualTypeOf<KbsecResponseEnvelope>();
        expectTypeOf<KBSecCommonOutput>().toEqualTypeOf<KbsecCommonOutput>();
        expectTypeOf<KBSecTokenResponse>().toEqualTypeOf<KbsecTokenResponse>();
        expectTypeOf<KBSecCachedToken>().toEqualTypeOf<KbsecCachedToken>();
    });

    it("'KR' | 'US' 의 옛 이름은 모두 StockMarketGroup 이다", () => {
        expectTypeOf<StockMarketGroup>().toEqualTypeOf<'KR' | 'US'>();
        expectTypeOf<KBSecMarketCountry>().toEqualTypeOf<StockMarketGroup>();
        expectTypeOf<TossMarketCountry>().toEqualTypeOf<StockMarketGroup>();
        expectTypeOf<CalendarMarket>().toEqualTypeOf<StockMarketGroup>();
    });
});
