/**
 * `kis` 확장세션(NXT) 주문 — 종목이 NXT 에서 거래되는지 종목정보(`search-stock-info`)로 먼저 확인한다.
 *
 * NXT 거래 대상이 아니거나 NXT 에서 거래정지인 종목은 KIS 가 주문을 거절한다. 그런 주문은 보내지 않고 `MarketClosed` 로 알린다.
 * 확인은 실전에서만 한다(종목정보 조회가 모의투자를 지원하지 않는다). 확인이 실패하면 막지 않고 주문 응답이 판단하게 둔다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { MarketClosed } from '../../base/errors';
import { bodyOf, businessError, dataOk, headersOf, MARKET_TIMES, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

/** `nxtRouting` 옵션을 켠 인스턴스. */
const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase({ options: { nxtRouting: true }, ...config });

const INFO_PATH = '/quotations/search-stock-info';
const ORDER_PATH = '/trading/order-cash';

/** 종목정보 응답을 `info` 로 주고, 주문은 접수로 응답하는 서버. `info` 가 함수면 매번 호출한다. */
function serve(info: () => unknown): void {
    mockFetch.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/oauth2/')) return tokenOk();
        if (u.includes(INFO_PATH)) return info();
        if (u.includes(ORDER_PATH)) return dataOk({ output: { ODNO: '0000000009', ORD_TMD: '160000' } });
        throw new Error(`예상 밖의 요청: ${u}`);
    });
}

const infoOf = (output: Record<string, string>) => () => dataOk({ output });
const callsTo = (fragment: string) => mockFetch.mock.calls.filter((c) => String(c[0]).includes(fragment));
const placeExtended = (broker = newKis({ sandbox: false }), symbol = '005930') => broker.createOrder(symbol, 'limit', 'buy', 3, 70000);

// 정규장은 닫혔고 NXT 애프터마켓인 시각으로 고정한다.
beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MARKET_TIMES.nxtAfterMarket);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('확장세션 주문 전 종목정보 확인', () => {
    it('★NXT 거래 대상이면 종목정보를 한 번 조회한 뒤 주문을 낸다. 조회는 공식 TR 과 상품유형 300 이다', async () => {
        serve(infoOf({ cptt_trad_tr_psbl_yn: 'Y', nxt_tr_stop_yn: 'N' }));

        await placeExtended();

        const info = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(INFO_PATH));
        expect(String(mockFetch.mock.calls[info]![0])).toContain('PRDT_TYPE_CD=300');
        expect(String(mockFetch.mock.calls[info]![0])).toContain('PDNO=005930');
        expect(headersOf(mockFetch, info).tr_id).toBe('CTPF1002R');
        const order = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(ORDER_PATH));
        expect(order).toBeGreaterThan(info);
        expect(bodyOf(mockFetch, order)).toMatchObject({ EXCG_ID_DVSN_CD: 'SOR', PDNO: '005930' });
        expect(headersOf(mockFetch, order).tr_id).toBe('TTTC0012U');
    });

    it('★NXT 거래 대상이 아니면 MarketClosed 이고 주문 요청은 나가지 않는다', async () => {
        serve(infoOf({ cptt_trad_tr_psbl_yn: 'N', nxt_tr_stop_yn: 'N' }));

        const error = await placeExtended().catch((e: unknown) => e) as Error;

        expect(error).toBeInstanceOf(MarketClosed);
        expect(error.message).toContain('NXT 거래 대상 종목이 아니다');
        expect(callsTo(ORDER_PATH)).toHaveLength(0);
    });

    it('NXT 거래정지 종목도 MarketClosed 이고 주문 요청은 나가지 않는다', async () => {
        serve(infoOf({ cptt_trad_tr_psbl_yn: 'Y', nxt_tr_stop_yn: 'Y' }));

        const error = await placeExtended().catch((e: unknown) => e) as Error;

        expect(error).toBeInstanceOf(MarketClosed);
        expect(error.message).toContain('NXT 거래정지');
        expect(callsTo(ORDER_PATH)).toHaveLength(0);
    });

    it('종목별로 결과를 캐시한다. 같은 종목의 두 번째 주문은 종목정보를 다시 조회하지 않는다', async () => {
        serve(infoOf({ cptt_trad_tr_psbl_yn: 'Y', nxt_tr_stop_yn: 'N' }));
        const broker = newKis({ sandbox: false });

        await placeExtended(broker);
        await placeExtended(broker);

        expect(callsTo(INFO_PATH)).toHaveLength(1);
        expect(callsTo(ORDER_PATH)).toHaveLength(2);
    });

    it('거래할 수 없다는 결과도 캐시한다. 매 주기마다 같은 조회가 되풀이되지 않는다', async () => {
        serve(infoOf({ cptt_trad_tr_psbl_yn: 'N' }));
        const broker = newKis({ sandbox: false });

        await placeExtended(broker).catch(() => undefined);
        await placeExtended(broker).catch(() => undefined);

        expect(callsTo(INFO_PATH)).toHaveLength(1);
    });

    it('종목정보 조회가 실패하면 막지 않고 주문을 보낸다. 실패는 캐시하지 않아 다음 주문이 다시 조회한다', async () => {
        serve(() => businessError('APBK0001', '조회 실패'));
        const broker = newKis({ sandbox: false });

        await placeExtended(broker);
        await placeExtended(broker);

        expect(callsTo(ORDER_PATH)).toHaveLength(2);
        expect(callsTo(INFO_PATH)).toHaveLength(2);
    });

    it('응답에 NXT 필드가 하나도 없으면 막지 않는다', async () => {
        serve(infoOf({ pdno: '005930' }));

        await placeExtended();

        expect(callsTo(ORDER_PATH)).toHaveLength(1);
    });
});

describe('확인하지 않는 경우', () => {
    it('모의투자는 종목정보 조회가 없어 확인하지 않는다', async () => {
        serve(infoOf({ cptt_trad_tr_psbl_yn: 'N' }));

        await placeExtended(newKis({ sandbox: true }));

        expect(callsTo(INFO_PATH)).toHaveLength(0);
        expect(callsTo(ORDER_PATH)).toHaveLength(1);
    });

    it('정규장 주문은 확인하지 않는다', async () => {
        vi.setSystemTime(MARKET_TIMES.krxClosed);
        serve(infoOf({ cptt_trad_tr_psbl_yn: 'N' }));

        // NXT 도 닫힌 시각이라 정규장 게이트를 거치고, 정규장도 닫혀 있으므로 MarketClosed 로 끝나지만, 그전에 종목정보를 부르지 않아야 한다.
        await placeExtended().catch(() => undefined);

        expect(callsTo(INFO_PATH)).toHaveLength(0);
    });
});
