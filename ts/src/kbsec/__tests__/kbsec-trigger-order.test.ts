/**
 * @fileoverview `kbsec.createTriggerOrder` — 스탑지정가. 국내(`ordr_ccd='S0'`, `stpd_prc`)와 해외
 * (`frgn_ordr_typ_cd='C'`, `frgn_stp_prc_p4`) 모두 지정가만 지원한다. 공식 필드 스펙(`kbsecurities/kb-openapi`)의
 * `SSAM1802`·`SKAM2101` inputSpec에서 확인했다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { ArgumentsRequired, MarketClosed } from '../../base/errors';
import { resetMarketCalendar } from '../../market-calendar';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { calledTrs, CREDS, routeTr, trBody } from './support/kbsec-fetch';

/** 2026-08-19(수) 10:00 KST — 평일·비휴장 KRX 정규장. */
const KRX_REGULAR = new Date('2026-08-19T01:00:00Z');
/** 2026-08-19(수) 21:00 KST — 장 종료 뒤. */
const KRX_CLOSED = new Date('2026-08-19T12:00:00Z');
/** 2026-08-19(수) 10:00 ET — NYSE 정규장. */
const US_REGULAR = new Date('2026-08-19T14:00:00Z');

const newExchange = () => new kbsec({
    ...CREDS, rateLimit: 0, options: { masterData: KIS_MASTER_FIXTURE, confirmBudget: { intervalMs: 0 } },
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(KRX_REGULAR);
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
    resetMarketCalendar();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('createTriggerOrder — 국내', () => {
    it('스톱지정가(S0)로 나가고 stpd_prc 에 조건가격을 싣는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.BUY_KR]: { ordr_no: 'A1' } });

        const order = await newExchange().createTriggerOrder('005930/KRW', 'limit', 'buy', 3, 70000, 65000);

        expect(trBody(mockFetch, KBSEC_TR.BUY_KR).dataBody).toMatchObject({
            ordr_jb_clsf: '2', is_cd: '005930', ordr_q: '3', ordr_uprc: '70000', ordr_ccd: 'S0', stpd_prc: '65000',
        });
        expect(order).toMatchObject({ id: 'A1', symbol: '005930/KRW', side: 'buy', amount: 3, price: 70000, type: 'limit' });
    });

    it('매도는 SELL_KR 을 쓴다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.SELL_KR]: { ordr_no: 'A2' } });

        await newExchange().createTriggerOrder('005930/KRW', 'limit', 'sell', 1, 65000, 70000);

        expect(trBody(mockFetch, KBSEC_TR.SELL_KR).dataBody).toMatchObject({ ordr_jb_clsf: '1', ordr_ccd: 'S0', stpd_prc: '70000' });
    });

    it('1주 미만은 요청을 보내지 않고 InvalidOrder', async () => {
        routeTr(mockFetch, {});

        await expect(newExchange().createTriggerOrder('005930/KRW', 'limit', 'buy', 0.4, 70000, 65000)).rejects.toThrow();
        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.BUY_KR.toLowerCase());
    });

    it('장 시간 밖이면 MarketClosed', async () => {
        routeTr(mockFetch, {});
        vi.setSystemTime(KRX_CLOSED);

        await expect(newExchange().createTriggerOrder('005930/KRW', 'limit', 'buy', 1, 70000, 65000)).rejects.toThrow(MarketClosed);
        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.BUY_KR.toLowerCase());
    });
});

describe('createTriggerOrder — 해외', () => {
    beforeEach(() => { vi.setSystemTime(US_REGULAR); });

    it('스톱지정가(C)로 나가고 frgn_stp_prc_p4 에 조건가격을 싣는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDER_US]: { ordr_no: 'U1' } });

        const order = await newExchange().createTriggerOrder('AAPL/USD', 'limit', 'buy', 2, 231.5, 225);

        expect(trBody(mockFetch, KBSEC_TR.ORDER_US).dataBody).toMatchObject({
            trd_dl_ccd: '02', is_cd: 'AAPL', frgn_ordr_typ_cd: 'C', frgn_ordr_q: '2', frgn_ordr_prc_p4: '231.5000', frgn_stp_prc_p4: '225.0000',
        });
        expect(order).toMatchObject({ symbol: 'AAPL/USD', side: 'buy', amount: 2, price: 231.5, type: 'limit' });
    });
});

describe('createTriggerOrder — 인자 검사', () => {
    it('triggerPrice 가 없으면 ArgumentsRequired, 요청을 보내지 않는다', async () => {
        await expect(newExchange().createTriggerOrder('005930/KRW', 'limit', 'buy', 1, 70000)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('price 가 없으면 ArgumentsRequired(스탑지정가는 지정가만 지원)', async () => {
        await expect(newExchange().createTriggerOrder('005930/KRW', 'limit', 'buy', 1, undefined, 65000)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
