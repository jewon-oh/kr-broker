/**
 * @fileoverview 이름이나 경로를 바꾼 공개 이름의 옛 별칭이 새 이름과 같은 값과 타입을 가리키는지 본다. 별칭은 다음 판에서 지운다.
 *
 * 타입 비교(`expectTypeOf`)는 실행 시 아무것도 하지 않고 `pnpm typecheck` 가 검사한다.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { InvestorTradingRecord } from '../base/types';
import type { StockMarketGroup } from '../broker-market-group';
import { kbsec, type KbsecInvestorTradingRecord } from '../kbsec';
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
import { kis, type KisInvestorTradingRecord } from '../kis';
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
import {
    applyMarketCalendar as applyMarketCalendarOldPath,
    marketDayStatus,
    resetMarketCalendar as resetMarketCalendarOldPath,
    type CalendarMarket,
} from '../market-calendar';
import { applyMarketCalendar, resetMarketCalendar } from '../testing';
import { toss } from '../toss';
import type { TossMarketCountry } from '../toss/toss-types';

afterEach(() => {
    vi.restoreAllMocks();
    resetMarketCalendar();
});

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
        expectTypeOf<KisInvestorTradingRecord>().toEqualTypeOf<InvestorTradingRecord>();
        expectTypeOf<KbsecInvestorTradingRecord>().toEqualTypeOf<InvestorTradingRecord>();
    });

    it('kr-broker/market-calendar 에 남긴 캘린더 훅은 kr-broker/testing 의 훅과 같은 캘린더를 바꾼다', () => {
        expectTypeOf(applyMarketCalendarOldPath).toEqualTypeOf(applyMarketCalendar);
        expectTypeOf(resetMarketCalendarOldPath).toEqualTypeOf(resetMarketCalendar);

        applyMarketCalendarOldPath('KR', [{ date: '20261005', open: false }]);
        expect(marketDayStatus('KR', '20261005')).toBe('closed');
        resetMarketCalendar();
        expect(marketDayStatus('KR', '20261005')).toBe('unknown');

        applyMarketCalendar('KR', [{ date: '20261005', open: false }]);
        resetMarketCalendarOldPath();
        expect(marketDayStatus('KR', '20261005')).toBe('unknown');
    });

    it("'KR' | 'US' 의 옛 이름은 모두 StockMarketGroup 이다", () => {
        expectTypeOf<StockMarketGroup>().toEqualTypeOf<'KR' | 'US'>();
        expectTypeOf<KBSecMarketCountry>().toEqualTypeOf<StockMarketGroup>();
        expectTypeOf<TossMarketCountry>().toEqualTypeOf<StockMarketGroup>();
        expectTypeOf<CalendarMarket>().toEqualTypeOf<StockMarketGroup>();
    });
});

describe('옛 메서드 이름', () => {
    it('옛 이름은 새 이름과 같은 인자와 결과 타입이다', () => {
        expectTypeOf<kis['fetchStockWarnings']>().toEqualTypeOf<kis['fetchVolatilityInterruptions']>();
        expectTypeOf<kbsec['fetchStockWarnings']>().toEqualTypeOf<kbsec['fetchTradingRestriction']>();
        expectTypeOf<toss['fetchInvestorTrading']>().toEqualTypeOf<toss['fetchMarketInvestorTrading']>();
    });

    it('옛 이름과 옛 호출 모양은 받은 인자를 그대로 새 이름에 넘기고 그 결과를 돌려준다', async () => {
        const result = [{ marker: 'new' }];
        const params = { extra: 'x' };
        const kisNew = vi.spyOn(kis.prototype, 'fetchVolatilityInterruptions').mockResolvedValue(result as never);
        const kbsecNew = vi.spyOn(kbsec.prototype, 'fetchTradingRestriction').mockResolvedValue(result as never);
        const tossNew = vi.spyOn(toss.prototype, 'fetchMarketInvestorTrading').mockResolvedValue(result as never);
        const tossSessions = vi.spyOn(toss.prototype, 'fetchMarketSessions').mockResolvedValue(result as never);

        expect(await new kis().fetchStockWarnings('005930/KRW', params)).toBe(result);
        expect(await new kbsec().fetchStockWarnings('005930/KRW', params)).toBe(result);
        expect(await new toss().fetchInvestorTrading('KOSDAQ', '1w', 3, params)).toBe(result);
        expect(await new toss().fetchMarketCalendar('kr', params)).toBe(result);

        expect(kisNew).toHaveBeenCalledWith('005930/KRW', params);
        expect(kbsecNew).toHaveBeenCalledWith('005930/KRW', params);
        expect(tossNew).toHaveBeenCalledWith('KOSDAQ', '1w', 3, params);
        expect(tossSessions).toHaveBeenCalledWith('kr', params);
    });
});
