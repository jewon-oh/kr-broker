/**
 * `kis.createOrder` — 심볼 라우팅 회귀.
 *
 * 접미사(`/KRW`)를 떼지 않으면 '005930/KRW' 풀형식이 해외 주문으로 오라우팅되어 "해외 마스터에 없는 ticker" 로 실패한다.
 * 국내는 order-cash(PDNO=base), 해외는 overseas order(PDNO=base) 로 가야 한다. 거래시간 게이트는 실시간 의존이라 '거래 가능'으로 고정하고
 * 라우팅만 본다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock('../kis-trading-hours', () => ({
    checkKRXTradingHours: () => ({ tradable: true, reason: '' }),
    getKrxMarketPhase: () => 'open',
    isNxtExtendedTradable: () => false, // 정규장 라우팅 회귀 테스트 — 확장시간 아님
    getNxtSession: () => 'main',
}) satisfies Partial<typeof import('../kis-trading-hours')>);
vi.mock('../us-market-hours', () => ({
    getUsMarketPhase: () => 'open',
    formatEtWallClock: () => '10:00 ET',
}) satisfies Partial<typeof import('../us-market-hours')>);
global.fetch = mockFetch as unknown as typeof fetch;

import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { bodyOf, dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

/** 종목 마스터 픽스처를 넘긴 인스턴스. */
const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase({ masterData: KIS_MASTER_FIXTURE, ...config });

beforeEach(() => {
    mockFetch.mockReset();
});

/** 주문을 내고 주문 요청(호출 1번)의 URL·본문을 돌려준다. */
async function routeOrder(symbol: string, side: 'buy' | 'sell', amount: number, price: number) {
    mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '0000000001', ORD_TMD: '093000' } }));

    const order = await newKis().createOrder(symbol, 'limit', side, amount, price);

    return { url: String(mockFetch.mock.calls[1]![0]), body: bodyOf(mockFetch, 1), headers: headersOf(mockFetch, 1), order };
}

describe('createOrder — 심볼 라우팅 (base 추출)', () => {
    it("bare '005930' 매수 → 국내 order-cash(PDNO=005930)", async () => {
        const { url, body } = await routeOrder('005930', 'buy', 10, 70000);

        expect(url).toContain('/domestic-stock/v1/trading/order-cash');
        expect(body.PDNO).toBe('005930');
    });

    it("풀형식 '005930/KRW' 매수 → 국내 order-cash(PDNO=005930, /KRW 제거)", async () => {
        const { url, body } = await routeOrder('005930/KRW', 'buy', 10, 70000);

        expect(url).toContain('/domestic-stock/v1/trading/order-cash');
        expect(body.PDNO).toBe('005930');
    });

    it("풀형식 '005930/KRW' 매도도 국내 order-cash 로", async () => {
        const { url, body, headers } = await routeOrder('005930/KRW', 'sell', 3, 71000);

        expect(url).toContain('/domestic-stock/v1/trading/order-cash');
        expect(body.PDNO).toBe('005930');
        expect(headers.tr_id).toBe('VTTC0801U'); // 모의 매도
    });

    it("'AAPL' 매수 → 해외 overseas order(PDNO=AAPL)", async () => {
        const { url, body } = await routeOrder('AAPL', 'buy', 5, 150);

        expect(url).toContain('/overseas-stock/v1/trading/order');
        expect(body.PDNO).toBe('AAPL');
        expect(body.OVRS_EXCG_CD).toBe('NASD');
    });

    it("풀형식 'AAPL/USD' 매수 → 해외 overseas order(PDNO=AAPL, /USD 제거)", async () => {
        const { url, body } = await routeOrder('AAPL/USD', 'buy', 5, 150);

        expect(url).toContain('/overseas-stock/v1/trading/order');
        expect(body.PDNO).toBe('AAPL');
    });

    it('뉴욕 종목은 NYSE 거래소로 나가고, 매도는 매도 TR 과 SLL_TYPE=00 이다', async () => {
        const { body, headers } = await routeOrder('V/USD', 'sell', 2, 280);

        expect(body).toMatchObject({ OVRS_EXCG_CD: 'NYSE', SLL_TYPE: '00' });
        expect(headers.tr_id).toBe('VTTT1006U');
    });
});

describe('createOrder — 접수 응답', () => {
    it('접수 결과를 Order 로 돌려준다: 주문번호, 요청값(심볼·방향·수량·가격), open. 체결은 알 수 없어 filled 는 비어 있다', async () => {
        const { order } = await routeOrder('005930/KRW', 'buy', 10, 70000);

        expect(order).toMatchObject({ id: '0000000001', symbol: '005930/KRW', type: 'limit', side: 'buy', price: 70000, amount: 10, status: 'open' });
        expect(order.filled).toBeUndefined();
        expect(order.info.output.ODNO).toBe('0000000001');
        expect(order.timestamp).toBeGreaterThan(0);
    });

    it('시장가 주문은 ORD_DVSN=01, 단가 0 으로 나간다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '2' } }));

        const order = await newKis().createOrder('005930', 'market', 'buy', 4);

        expect(bodyOf(mockFetch, 1)).toMatchObject({ ORD_DVSN: '01', ORD_UNPR: '0', ORD_QTY: '4' });
        expect(order.type).toBe('market');
    });

    it('추가 params 는 요청 본문에 그대로 합친다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '3' } }));

        await newKis().createOrder('005930', 'limit', 'buy', 1, 70000, { ORD_DVSN: '02' });

        expect(bodyOf(mockFetch, 1).ORD_DVSN).toBe('02');
    });
});
