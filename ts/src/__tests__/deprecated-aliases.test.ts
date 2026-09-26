/**
 * @fileoverview 이름이나 경로를 바꾼 공개 이름의 옛 별칭이 새 이름과 같은 값과 타입을 가리키는지 본다. 별칭은 다음 판에서 지운다.
 *
 * 타입 비교(`expectTypeOf`)는 실행 시 아무것도 하지 않고 `pnpm typecheck` 가 검사한다.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { InvestorTradingRecord } from '../base/types';
import { kbsec, type KbsecInvestorTradingRecord } from '../kbsec';
import { kis, type KisInvestorTradingRecord } from '../kis';
import { getTickSize } from '../kis/kis-types';
import { getKrxTickSize } from '../krx-tick-size';
import {
    applyMarketCalendar as applyMarketCalendarOldPath,
    marketDayStatus,
    resetMarketCalendar as resetMarketCalendarOldPath,
} from '../market-calendar';
import { applyMarketCalendar, resetMarketCalendar } from '../testing';
import { toss } from '../toss';

afterEach(() => {
    vi.restoreAllMocks();
    resetMarketCalendar();
});

describe('옛 이름 별칭', () => {
    it('함수의 옛 이름은 새 이름과 같은 값이다', () => {
        expect(getTickSize).toBe(getKrxTickSize);
    });

    it('타입의 옛 이름은 새 이름과 같은 타입이다', () => {
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
