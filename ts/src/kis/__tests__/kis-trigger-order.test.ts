/**
 * `kis.createTriggerOrder` — 스탑지정가(국내만). `order-cash` 에 조건가격(`CNDT_PRIC`)을 실어 보낸다.
 * KIS 공식 예제 `order_cash.py`의 인자 설명("조건가격 — 스탑지정가호가 주문 시 사용")으로 확인했다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, NotSupported } from '../../base/errors';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { bodyOf, dataOk, headersOf, MARKET_TIMES, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase({ masterData: KIS_MASTER_FIXTURE, ...config });

const ORDER_PATH = '/trading/order-cash';

beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MARKET_TIMES.krxRegular);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('createTriggerOrder', () => {
    it('조건가격(CNDT_PRIC)을 실어 보내고, 정규 주문 TR(TTTC0012U 계열)을 쓴다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '1', ORD_TMD: '090000' } }));

        const order = await newKis().createTriggerOrder('005930/KRW', 'limit', 'buy', 1, 70000, 65000);

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(ORDER_PATH));
        expect(bodyOf(mockFetch, call)).toMatchObject({
            PDNO: '005930', ORD_DVSN: '00', ORD_QTY: '1', ORD_UNPR: '70000', EXCG_ID_DVSN_CD: 'KRX', SLL_TYPE: '', CNDT_PRIC: '65000',
        });
        expect(headersOf(mockFetch, call).tr_id).toBe('VTTC0012U');
        expect(order).toMatchObject({ symbol: '005930/KRW', side: 'buy', amount: 1, price: 70000, type: 'limit' });
    });

    it('매도는 SLL_TYPE=01, TR은 VTTC0011U', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '2', ORD_TMD: '090000' } }));

        await newKis().createTriggerOrder('005930/KRW', 'limit', 'sell', 1, 70000, 75000);

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(ORDER_PATH));
        expect(bodyOf(mockFetch, call)).toMatchObject({ SLL_TYPE: '01', CNDT_PRIC: '75000' });
        expect(headersOf(mockFetch, call).tr_id).toBe('VTTC0011U');
    });

    it('triggerPrice 가 없으면 ArgumentsRequired, 요청을 보내지 않는다', async () => {
        await expect(newKis().createTriggerOrder('005930/KRW', 'limit', 'buy', 1, 70000)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('price 가 없으면 ArgumentsRequired(스탑지정가는 지정가만 지원)', async () => {
        await expect(newKis().createTriggerOrder('005930/KRW', 'limit', 'buy', 1, undefined, 65000)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('해외 종목은 NotSupported', async () => {
        await expect(newKis().createTriggerOrder('AAPL/USD', 'limit', 'buy', 1, 150, 140)).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('거래시간 밖은 MarketClosed, 요청을 보내지 않는다', async () => {
        vi.setSystemTime(MARKET_TIMES.krxClosed);

        await expect(newKis().createTriggerOrder('005930/KRW', 'limit', 'buy', 1, 70000, 65000)).rejects.toThrow('거래시간 외');
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
