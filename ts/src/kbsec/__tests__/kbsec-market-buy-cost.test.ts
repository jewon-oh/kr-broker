/**
 * @fileoverview `kbsec.createMarketBuyOrderWithCost` — 미국 주식 시장가 매수를 금액으로 낸다.
 * 소수점매도/매수주문(`SKAM2201`)을 금액 기준(`amt_q_clsf='0'`)으로 부른다. 국내·해외 정규 주문(`SKAM2101`)과는
 * 별도 TR 이고 주문유형코드 값도 다르다(시장가 `1` 없이 유사시장가 `E`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { ArgumentsRequired, MarketClosed, NotSupported } from '../../base/errors';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker, resetMarketCalendar } from '../../testing';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

/** 2026-08-19(수) 10:00 ET — NYSE 정규장. */
const US_REGULAR = new Date('2026-08-19T14:00:00Z');
/** 2026-08-19(수) 21:00 ET 뒤 — NYSE 정규장 종료. */
const US_CLOSED = new Date('2026-08-20T02:00:00Z');

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0, options: { masterData: KIS_MASTER_FIXTURE } });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(US_REGULAR);
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
    resetMarketCalendar();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('createMarketBuyOrderWithCost', () => {
    it('SKAM2201 을 금액 기준으로 부른다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_ORDER_US]: { ordr_no: 'F1' } });

        const order = await newExchange().createMarketBuyOrderWithCost('AAPL/USD', 100);

        expect(trBody(mockFetch, KBSEC_TR.FRAC_ORDER_US).dataBody).toMatchObject({
            frgn_krx_ccd: 'US', trd_dl_ccd: '02', is_cd: 'AAPL', amt_q_clsf: '0', frgn_ordr_typ_cd: 'E', crncy_ccd: '1',
            ordr_amt: '100', spclz_ordr_ccd: '33',
        });
        expect(order).toMatchObject({ id: 'F1', type: 'market', side: 'buy', cost: 100, status: 'open' });
        expect((order.info as { fractional: boolean }).fractional).toBe(true);
        expect((order.info as { fillConfirmed: boolean }).fillConfirmed).toBe(false);
    });

    it('금액은 내림값으로 나간다 — 반올림하면 예산을 넘는 주문이 나간다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_ORDER_US]: { ordr_no: 'F2' } });

        const order = await newExchange().createMarketBuyOrderWithCost('AAPL/USD', 100.9);

        expect(trBody(mockFetch, KBSEC_TR.FRAC_ORDER_US).dataBody.ordr_amt).toBe('100');
        expect(order.cost).toBe(100);
    });

    it('국내 종목은 NotSupported 다', async () => {
        await expect(newExchange().createMarketBuyOrderWithCost('005930/KRW', 100)).rejects.toThrow(NotSupported);
        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.FRAC_ORDER_US.toLowerCase());
    });

    it('금액이 0 이하면 ArgumentsRequired 다', async () => {
        await expect(newExchange().createMarketBuyOrderWithCost('AAPL/USD', 0)).rejects.toThrow(ArgumentsRequired);
        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.FRAC_ORDER_US.toLowerCase());
    });

    it('장 시간 밖이면 MarketClosed 를 던지고 요청을 보내지 않는다', async () => {
        vi.setSystemTime(US_CLOSED);

        await expect(newExchange().createMarketBuyOrderWithCost('AAPL/USD', 100)).rejects.toThrow(MarketClosed);
        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.FRAC_ORDER_US.toLowerCase());
    });
});
