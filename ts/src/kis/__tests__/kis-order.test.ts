/**
 * `kis` 주문 규칙 — 세션 게이트(MarketClosed), 수량 정규화, NXT 확장세션, 취소, 미체결 조회.
 *
 * 장 시간 밖은 실패가 아니라 예정된 조건이다. 마감 후 재시도마다 실패 거래가 쌓이지 않도록 `MarketClosed` 로 구분해 던지고 주문 요청은 보내지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { logger } from '../../logger';
import { ExchangeError, InvalidOrder, MarketClosed, NotSupported, OrderNotFound, ArgumentsRequired } from '../../base/errors';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { bodyOf, businessError, dataOk, headersOf, MARKET_TIMES, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

/** 종목 마스터 픽스처를 넘긴 인스턴스. */
const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase({ masterData: KIS_MASTER_FIXTURE, ...config });

// 장 시간 게이트는 인스턴스 시계를 읽으므로 시각을 고정해 판정을 정한다. 기본은 KRX 정규장이다.
beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MARKET_TIMES.krxRegular);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const buyKr = (broker = newKis()) => broker.createOrder('005930/KRW', 'limit', 'buy', 1, 70000);

describe('세션 게이트가 MarketClosed 를 던진다', () => {
    it('★국내 거래시간 외 → MarketClosed, 주문 요청은 나가지 않는다', async () => {
        vi.setSystemTime(MARKET_TIMES.krxClosed);

        const error = await buyKr().catch((e: unknown) => e) as Error;

        expect(error).toBeInstanceOf(MarketClosed);
        expect(error.message).toBe('거래시간 외: 장 마감 (현재: 21:30 KST, 마감: 15:30)');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('거래시간 내에는 MarketClosed 가 아니다 — 진짜 실패와 섞이면 안 된다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(businessError('APBK0919', '주문가능금액 부족'));

        const error = await buyKr().catch((e: unknown) => e) as Error;

        expect(error).toBeInstanceOf(ExchangeError);
        expect(error).not.toBeInstanceOf(MarketClosed);
    });

    it('★종가 동시호가(15:20~15:30)의 신규 매수는 시장이 받으므로 기본으로 보낸다', async () => {
        vi.setSystemTime(MARKET_TIMES.krxClosingAuction);
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '8' } }));

        const bought = await buyKr();

        expect(bought.id).toBe('8');
    });

    it('종가 동시호가의 신규 매수는 blockAuctionBuys 를 켜면 막고, 매도(청산)는 켜도 허용한다', async () => {
        vi.setSystemTime(MARKET_TIMES.krxClosingAuction);
        const guarded = newKis({ options: { blockAuctionBuys: true } });

        await expect(buyKr(guarded)).rejects.toThrow(MarketClosed);

        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '9' } }));
        const sold = await guarded.createOrder('005930', 'limit', 'sell', 1, 70000);
        expect(sold.id).toBe('9');
    });

    it('미국장이 완전히 닫혀 있으면(closed) 양방향 모두 MarketClosed 다', async () => {
        vi.setSystemTime(MARKET_TIMES.usClosed);

        await expect(newKis().createOrder('AAPL', 'limit', 'buy', 1, 150)).rejects.toThrow(MarketClosed);
        await expect(newKis().createOrder('AAPL', 'limit', 'sell', 1, 150)).rejects.toThrow(MarketClosed);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('미국 종가 동시호가의 신규 매수는 blockAuctionBuys 를 켰을 때만 막는다', async () => {
        vi.setSystemTime(MARKET_TIMES.usClosingAuction);

        await expect(newKis({ options: { blockAuctionBuys: true } }).createOrder('AAPL', 'limit', 'buy', 1, 150)).rejects.toThrow('종가 동시호가');

        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: 'U1' } }));
        const bought = await newKis().createOrder('AAPL', 'limit', 'buy', 1, 150);
        expect(bought.id).toBe('U1');
    });

    it('장 시간 게이트는 벽시계가 아니라 인스턴스 시계(milliseconds)를 읽는다', async () => {
        vi.setSystemTime(MARKET_TIMES.krxClosed);
        const broker = newKis();
        broker.milliseconds = () => MARKET_TIMES.krxRegular.getTime();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '7' } }));

        await expect(buyKr(broker)).resolves.toMatchObject({ id: '7' });
    });

    it('MarketClosed 는 재시도 대상이 아니다(곧바로 다시 보내도 장은 닫혀 있다)', async () => {
        vi.setSystemTime(MARKET_TIMES.krxClosed);

        const error = await buyKr().catch((e: unknown) => e) as MarketClosed;

        expect(error.retryable).toBe(false);
    });
});

describe('주문 수량 정규화', () => {
    beforeEach(() => {
        vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });

    it('정수 수량은 그대로 통과하고 경고가 없다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '1' } }));

        await newKis().createOrder('005930', 'limit', 'buy', 100, 70000);

        expect(bodyOf(mockFetch, 1).ORD_QTY).toBe('100');
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('분수 수량은 내림하고 경고를 남긴다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '1' } }));

        const order = await newKis().createOrder('005930', 'limit', 'buy', 102.04, 70000);

        expect(bodyOf(mockFetch, 1).ORD_QTY).toBe('102');
        expect(order.amount).toBe(102);
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(vi.mocked(logger.warn).mock.calls[0]![0]).toMatchObject({ requested: 102.04, floored: 102, lost: expect.any(Number) });
    });

    it.each([
        ['0', 0, /비정상/],
        ['음수', -5, /비정상/],
        ['NaN', NaN, /비정상/],
        ['Infinity', Infinity, /비정상/],
        ['0 < amount < 1 (0.4)', 0.4, /floor 후 0/],
    ])('%s 수량은 InvalidOrder 이고 요청을 보내지 않는다', async (_label, amount, message) => {
        const error = await newKis().createOrder('005930', 'limit', 'buy', amount, 70000).catch((e: unknown) => e) as Error;

        expect(error).toBeInstanceOf(InvalidOrder);
        expect(error.message).toMatch(message);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('지정가 주문에 가격이 없으면 ArgumentsRequired', async () => {
        await expect(newKis().createOrder('005930', 'limit', 'buy', 1)).rejects.toThrow(ArgumentsRequired);
    });
});

describe('NXT 확장세션 — 정규장 게이트를 우회하고 SOR 로 낸다', () => {
    /** `nxtRouting` 옵션을 켠 인스턴스. */
    const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase({ masterData: KIS_MASTER_FIXTURE, options: { nxtRouting: true }, ...config });

    beforeEach(() => {
        vi.setSystemTime(MARKET_TIMES.nxtAfterMarket); // 정규장 게이트는 닫혀 있고 NXT 애프터마켓이다
    });

    async function extendedOrder(symbol: string, side: 'buy' | 'sell', price: number) {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '1' } }));
        await newKis().createOrder(symbol, 'limit', side, 3, price);
        return { body: bodyOf(mockFetch, 1), headers: headersOf(mockFetch, 1) };
    }

    it('지정가 매수 → 게이트 우회 + EXCG=SOR + 신형 tr_id(VTTC0012U)', async () => {
        const { body, headers } = await extendedOrder('005930', 'buy', 70000);

        expect(body).toMatchObject({ EXCG_ID_DVSN_CD: 'SOR', ORD_DVSN: '00', ORD_UNPR: '70000', SLL_TYPE: '' });
        expect(headers.tr_id).toBe('VTTC0012U');
    });

    it('지정가 매도 → SLL_TYPE=01 + tr_id(VTTC0011U)', async () => {
        const { body, headers } = await extendedOrder('005930/KRW', 'sell', 71000);

        expect(body).toMatchObject({ PDNO: '005930', EXCG_ID_DVSN_CD: 'SOR', SLL_TYPE: '01' });
        expect(headers.tr_id).toBe('VTTC0011U');
    });

    it('★시장가는 차단이 아니라 지정가로 전환한다. 기준가는 현재가다', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/')) return tokenOk();
            if (u.includes('inquire-psbl-rvsecncl')) return dataOk({ output: [] });
            if (u.includes('inquire-price')) return dataOk({ output: { stck_prpr: '70500', prdy_ctrt: '0', prdy_vrss: '0' } });
            return dataOk({ output: { ODNO: '7' } });
        });

        await newKis().createOrder('005930', 'market', 'buy', 3);

        const order = mockFetch.mock.calls.find((c) => String(c[0]).includes('order-cash'))!;
        expect(JSON.parse((order[1] as { body: string }).body)).toMatchObject({ ORD_DVSN: '00', ORD_UNPR: '70500' });
    });

    it('★같은 방향 미체결이 이미 있으면 재발주하지 않는다(호가 중복 방지)', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('/oauth2/')) return tokenOk();
            return dataOk({ output: [{ odno: 'PENDING', pdno: '005930', sll_buy_dvsn_cd: '02', ord_qty: '3', tot_ccld_qty: '0', psbl_qty: '3' }] });
        });

        await expect(newKis().createOrder('005930', 'market', 'buy', 3)).rejects.toThrow(/중복 발주/);

        expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('order-cash'))).toBe(false);
    });

    it('★기준가를 못 구하면 발주하지 않는다 — 지정가를 지어내지 않는다', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('/oauth2/')) return tokenOk();
            if (String(url).includes('inquire-psbl-rvsecncl')) return dataOk({ output: [] });
            return businessError('APBK0001', '시세 조회 실패');
        });

        await expect(newKis().createOrder('005930', 'market', 'buy', 3)).rejects.toThrow(/기준가/);

        expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('order-cash'))).toBe(false);
    });

    it('nxtRouting 옵션이 꺼져 있으면 확장시간이라도 정규장 게이트가 적용된다', async () => {
        await expect(newKis({ options: { nxtRouting: false } }).createOrder('005930', 'limit', 'buy', 1, 70000)).rejects.toThrow('거래시간 외');
    });

    it('params.session 으로 강제할 수 있다: regular 는 옵션이 켜져 있어도 정규장 규칙', async () => {
        await expect(newKis().createOrder('005930', 'limit', 'buy', 1, 70000, { session: 'regular' })).rejects.toThrow(MarketClosed);
    });
});

describe('미체결 조회', () => {
    it('★매도매수구분은 01=매도, 02=매수다. 남은 수량은 가능수량(psbl_qty)이다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [
                { odno: 'A', pdno: '005930', sll_buy_dvsn_cd: '01', ord_qty: '10', ord_unpr: '71000', tot_ccld_qty: '4', psbl_qty: '6', ord_dvsn_name: '지정가', ord_dvsn_cd: '00', ord_tmd: '093000' },
                { odno: 'B', pdno: '000660', sll_buy_dvsn_cd: '02', ord_qty: '2', ord_unpr: '150000', tot_ccld_qty: '0', psbl_qty: '2', ord_dvsn_cd: '00' },
            ],
        }));

        const orders = await newKis().fetchOpenOrders(undefined, undefined, undefined, { market: 'domestic' });

        expect(orders).toHaveLength(2);
        expect(orders.find((o) => o.id === 'A')).toMatchObject({
            symbol: '005930/KRW', side: 'sell', amount: 10, filled: 4, remaining: 6, price: 71000, status: 'open', type: 'limit',
        });
        expect(orders.find((o) => o.id === 'B')).toMatchObject({ symbol: '000660/KRW', side: 'buy', remaining: 2 });
        expect(orders[0]!.info.ord_dvsn_name ?? orders[1]!.info.ord_dvsn_name).toBe('지정가');
    });

    it('실전은 신형 TR(TTTC0084R), 모의는 종전 TR(VTTC8036R)로 조회한다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/') ? tokenOk() : dataOk({ output: [] })));

        await newKis({ sandbox: false }).fetchOpenOrders('005930/KRW');
        await newKis({ sandbox: true }).fetchOpenOrders('005930/KRW');

        const trs = mockFetch.mock.calls.filter((c) => String(c[0]).includes('inquire-psbl-rvsecncl')).map((c) => (c[1] as { headers: Record<string, string> }).headers.tr_id);
        expect(trs).toEqual(['TTTC0084R', 'VTTC8036R']);
    });

    it('종목을 주면 그 종목만 돌려준다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [
                { odno: 'A', pdno: '005930', sll_buy_dvsn_cd: '01', ord_qty: '1', psbl_qty: '1' },
                { odno: 'B', pdno: '000660', sll_buy_dvsn_cd: '02', ord_qty: '1', psbl_qty: '1' },
            ],
        }));

        const orders = await newKis().fetchOpenOrders('005930/KRW');

        expect(orders.map((o) => o.id)).toEqual(['A']);
    });

    it('실전에서 종목 없이 조회하면 미국 미체결(inquire-nccs, TTTS3018R)도 본다', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('/oauth2/')) return tokenOk();
            if (String(url).includes('inquire-nccs')) {
                return dataOk({ output: [{ odno: 'US-1', pdno: 'AAPL', sll_buy_dvsn_cd: '02', ft_ord_qty: '5', ft_ccld_qty: '1', nccs_qty: '4', ft_ord_unpr3: '150', ord_dt: '20260921', ord_tmd: '223000' }] });
            }
            return dataOk({ output: [] });
        });

        const orders = await newKis({ sandbox: false }).fetchOpenOrders();

        expect(orders).toHaveLength(1);
        expect(orders[0]).toMatchObject({ id: 'US-1', symbol: 'AAPL/USD', side: 'buy', amount: 5, filled: 1, remaining: 4, price: 150, status: 'open' });
        const nccs = mockFetch.mock.calls.find((c) => String(c[0]).includes('inquire-nccs'))!;
        expect((nccs[1] as { headers: Record<string, string> }).headers.tr_id).toBe('TTTS3018R');
    });

    it('조회가 실패하면 빈 목록이 아니라 던진다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(businessError('APBK0001', '조회 실패'));

        await expect(newKis().fetchOpenOrders('005930/KRW')).rejects.toThrow(ExchangeError);
    });
});

describe('fetchOrder / fetchOrders', () => {
    const rows = [
        { ord_dt: '20260921', ord_tmd: '093000', odno: 'F', pdno: '005930', sll_buy_dvsn_cd: '02', ord_qty: '10', ord_unpr: '70000', tot_ccld_qty: '10', rmn_qty: '0', avg_prvs: '69900', tot_ccld_amt: '699000', cncl_yn: 'N', ord_dvsn_cd: '00' },
        { ord_dt: '20260921', ord_tmd: '093100', odno: 'O', pdno: '005930', sll_buy_dvsn_cd: '02', ord_qty: '5', ord_unpr: '70000', tot_ccld_qty: '2', rmn_qty: '3', cncl_yn: 'N', ord_dvsn_cd: '00' },
        { ord_dt: '20260921', ord_tmd: '093200', odno: 'C', pdno: '005930', sll_buy_dvsn_cd: '01', ord_qty: '5', ord_unpr: '71000', tot_ccld_qty: '0', rmn_qty: '0', cncl_yn: 'Y', ord_dvsn_cd: '01' },
    ];

    beforeEach(() => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/') ? tokenOk() : dataOk({ output1: rows })));
    });

    it('상태를 체결·미체결·취소로 옮긴다', async () => {
        const orders = await newKis().fetchOrders('005930/KRW');

        expect(orders.map((o) => [o.id, o.status])).toEqual([['F', 'closed'], ['O', 'open'], ['C', 'canceled']]);
        expect(orders[0]).toMatchObject({ average: 69900, cost: 699000, filled: 10, remaining: 0 });
        expect(orders[2]!.type).toBe('market');
    });

    it('fetchClosedOrders 는 체결 완료만, 그 밖은 fetchOrder 로 하나를 찾는다', async () => {
        const closed = await newKis().fetchClosedOrders('005930/KRW');
        expect(closed.map((o) => o.id)).toEqual(['F']);

        const one = await newKis().fetchOrder('O', '005930/KRW');
        expect(one.id).toBe('O');
    });

    it('★국내는 주문번호(ODNO)로 좁혀 조회한다', async () => {
        await newKis().fetchOrder('O', '005930/KRW');

        const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('inquire-daily-ccld'))!;
        expect(new URL(String(call[0])).searchParams.get('ODNO')).toBe('O');
    });

    it('없는 주문은 OrderNotFound', async () => {
        await expect(newKis().fetchOrder('NOPE', '005930/KRW')).rejects.toThrow(OrderNotFound);
    });
});

describe('취소', () => {
    it('국내 주문 취소 → order-rvsecncl 전량 취소, 결과는 canceled 주문이다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '2' } }));

        const canceled = await newKis().cancelOrder('0000001', '005930/KRW');

        expect(bodyOf(mockFetch, 1)).toMatchObject({ ORGN_ODNO: '0000001', RVSE_CNCL_DVSN_CD: '02', ORD_QTY: '0', QTY_ALL_ORD_YN: 'Y' });
        expect(headersOf(mockFetch, 1).tr_id).toBe('VTTC0803U');
        expect(canceled).toMatchObject({ id: '0000001', status: 'canceled', symbol: '005930/KRW' });
    });

    it('★해외 주문은 해외 취소 TR 로 낸다(예전에는 국내 TR 로 해외 주문번호를 취소하려 했다). 취소 수량은 미체결 조회에서 찾는다', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/')) return tokenOk();
            if (u.includes('inquire-nccs')) return dataOk({ output: [{ odno: 'US-1', pdno: 'AAPL', sll_buy_dvsn_cd: '02', ft_ord_qty: '5', ft_ccld_qty: '1', nccs_qty: '4' }] });
            return dataOk({ output: { ODNO: 'X' } });
        });

        const canceled = await newKis({ sandbox: false }).cancelOrder('US-1', 'AAPL/USD');

        const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/overseas-stock/v1/trading/order-rvsecncl'))!;
        expect((call[1] as { headers: Record<string, string> }).headers.tr_id).toBe('TTTT1004U');
        expect(JSON.parse((call[1] as { body: string }).body)).toMatchObject({ OVRS_EXCG_CD: 'NASD', PDNO: 'AAPL', ORGN_ODNO: 'US-1', RVSE_CNCL_DVSN_CD: '02', ORD_QTY: '4', OVRS_ORD_UNPR: '0' });
        expect(canceled.status).toBe('canceled');
    });

    it('해외 미체결 목록에 없는 주문은 OrderNotFound 이고 취소 요청을 보내지 않는다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/') ? tokenOk() : dataOk({ output: [] })));

        await expect(newKis({ sandbox: false }).cancelOrder('GONE', 'AAPL/USD')).rejects.toThrow(OrderNotFound);

        expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('order-rvsecncl'))).toBe(false);
    });

    it('모의투자의 해외 취소는 미체결 조회가 없어 취소 수량(params.amount)을 받는다', async () => {
        await expect(newKis({ sandbox: true }).cancelOrder('US-1', 'AAPL/USD')).rejects.toThrow(ArgumentsRequired);

        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: 'X' } }));
        await newKis({ sandbox: true }).cancelOrder('US-1', 'AAPL/USD', { amount: '4' });
        expect(bodyOf(mockFetch, 1).ORD_QTY).toBe('4');
        expect(headersOf(mockFetch, 1).tr_id).toBe('VTTT1004U');
    });

    it('★cancelAllOrders 는 종목을 주면 그 종목의 미체결만 취소한다', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/')) return tokenOk();
            if (u.includes('inquire-psbl-rvsecncl')) {
                return dataOk({ output: [
                    { odno: 'A', pdno: '005930', sll_buy_dvsn_cd: '02', ord_qty: '1', psbl_qty: '1' },
                    { odno: 'B', pdno: '000660', sll_buy_dvsn_cd: '02', ord_qty: '1', psbl_qty: '1' },
                ] });
            }
            return dataOk({ output: { ODNO: 'X' } });
        });

        const canceled = await newKis().cancelAllOrders('005930/KRW');

        const cancelBodies = mockFetch.mock.calls.filter((c) => String(c[0]).includes('order-rvsecncl')).map((c) => JSON.parse((c[1] as { body: string }).body).ORGN_ODNO);
        expect(cancelBodies).toEqual(['A']);
        expect(canceled.map((o) => o.id)).toEqual(['A']);
    });

    it('★일부를 취소하지 못해도 던지지 않는다 — 실패한 주문은 원래 상태(open)와 사유로 돌려주고 나머지도 시도한다', async () => {
        mockFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
            const u = String(url);
            if (u.includes('/oauth2/')) return tokenOk();
            if (u.includes('inquire-psbl-rvsecncl')) {
                return dataOk({ output: [
                    { odno: 'A', pdno: '005930', sll_buy_dvsn_cd: '02', ord_qty: '1', psbl_qty: '1' },
                    { odno: 'B', pdno: '000660', sll_buy_dvsn_cd: '02', ord_qty: '1', psbl_qty: '1' },
                ] });
            }
            if (JSON.parse(init?.body ?? '{}').ORGN_ODNO === 'A') return businessError('APBK0001', '취소 불가');
            return dataOk({ output: { ODNO: 'X' } });
        });

        const results = await newKis().cancelAllOrders();

        // 살아 있을 수 있는 주문을 canceled 로 적지 않는다.
        expect(results.map((o) => [o.id, o.status])).toEqual([['A', 'open'], ['B', 'canceled']]);
        expect(results[0]!.info).toMatchObject({ cancelErrorDetail: 'APBK0001' });
        expect((results[0]!.info as { cancelError: string }).cancelError).toContain('취소 불가');
        // B 도 시도했다.
        const attempted = mockFetch.mock.calls.filter((c) => String(c[0]).includes('order-rvsecncl')).map((c) => JSON.parse((c[1] as { body: string }).body).ORGN_ODNO);
        expect(attempted.sort()).toEqual(['A', 'B']);
    });
});

describe('정정', () => {
    it('price 없이 부르면 ArgumentsRequired 이고 요청을 보내지 않는다', async () => {
        await expect(newKis().editOrder('0000001', '005930/KRW', 'limit', 'buy')).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('국내 정정 — amount 를 안 주면 전량정정(취소와 같은 엔드포인트, 구분코드 01)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '3' } }));

        const edited = await newKis().editOrder('0000001', '005930/KRW', 'limit', 'buy', undefined, 71000);

        expect(bodyOf(mockFetch, 1)).toMatchObject({ ORGN_ODNO: '0000001', RVSE_CNCL_DVSN_CD: '01', ORD_QTY: '0', ORD_UNPR: '71000', QTY_ALL_ORD_YN: 'Y' });
        expect(headersOf(mockFetch, 1).tr_id).toBe('VTTC0803U');
        expect(edited).toMatchObject({ id: '3', status: 'open', symbol: '005930/KRW', price: 71000 });
    });

    it('국내 일부정정은 params.partial 과 옮길 수량 amount 로 낸다(QTY_ALL_ORD_YN: N)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '0000001' } }));

        const edited = await newKis().editOrder('0000001', '005930/KRW', 'limit', 'buy', 5, 71000, { partial: true });

        expect(bodyOf(mockFetch, 1)).toMatchObject({ ORD_QTY: '5', ORD_UNPR: '71000', QTY_ALL_ORD_YN: 'N' });
        expect(bodyOf(mockFetch, 1).partial).toBeUndefined();
        expect(edited.amount).toBe(5);
    });

    it('일부정정(params.partial)에 amount 가 없으면 요청 없이 ArgumentsRequired', async () => {
        await expect(newKis().editOrder('0000001', '005930/KRW', 'limit', 'buy', undefined, 71000, { partial: true })).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    /** 원주문이 10주 가운데 3주 체결된 미체결 목록. */
    const openRow = () => dataOk({ output: [
        { odno: '0000001', pdno: '005930', sll_buy_dvsn_cd: '02', ord_qty: '10', ord_unpr: '70000', tot_ccld_qty: '3', psbl_qty: '7', ord_dvsn_cd: '00' },
    ] });

    it('★국내 amount 는 정정 뒤 총수량이다. 미체결 조회로 체결 + 잔량과 같은지 확인한 뒤 잔량 전부를 정정한다(QTY_ALL_ORD_YN: Y)', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/')) return tokenOk();
            if (u.includes('inquire-psbl-rvsecncl')) return openRow();
            return dataOk({ output: { ODNO: '2' } });
        });

        const edited = await newKis().editOrder('0000001', '005930/KRW', 'limit', 'buy', 10, 71000);

        const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('order-rvsecncl'))!;
        expect(JSON.parse((call[1] as { body: string }).body)).toMatchObject({ ORD_QTY: '0', ORD_UNPR: '71000', QTY_ALL_ORD_YN: 'Y' });
        expect(edited).toMatchObject({ id: '2', amount: 10 });
    });

    it('★국내 amount 로 수량을 바꾸는 정정은 한 요청으로 낼 수 없어 정정 요청 없이 NotSupported 다(주문이 두 가격으로 나뉘지 않는다)', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/')) return tokenOk();
            if (u.includes('inquire-psbl-rvsecncl')) return openRow();
            return dataOk({ output: { ODNO: '2' } });
        });

        await expect(newKis().editOrder('0000001', '005930/KRW', 'limit', 'buy', 5, 71000)).rejects.toThrow(NotSupported);
        expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('order-rvsecncl'))).toBe(false);
    });

    it('해외 정정 — 해외 정정 TR 로 낸다. 수량은 params.amount 로 받는다', async () => {
        vi.setSystemTime(MARKET_TIMES.usRegular);
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: 'US-1' } }));

        const edited = await newKis({ sandbox: false }).editOrder('US-1', 'AAPL/USD', 'limit', 'buy', undefined, 226, { amount: '1' });

        const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/overseas-stock/v1/trading/order-rvsecncl'))!;
        expect((call[1] as { headers: Record<string, string> }).headers.tr_id).toBe('TTTT1004U');
        expect(JSON.parse((call[1] as { body: string }).body)).toMatchObject({ OVRS_EXCG_CD: 'NASD', PDNO: 'AAPL', ORGN_ODNO: 'US-1', RVSE_CNCL_DVSN_CD: '01', ORD_QTY: '1', OVRS_ORD_UNPR: '226' });
        expect(edited).toMatchObject({ id: 'US-1', status: 'open', symbol: 'AAPL/USD', price: 226 });
    });

    it('해외 정정 — 수량을 안 주면 미체결 조회에서 잔량을 찾는다', async () => {
        vi.setSystemTime(MARKET_TIMES.usRegular);
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/')) return tokenOk();
            if (u.includes('inquire-nccs')) return dataOk({ output: [{ odno: 'US-1', pdno: 'AAPL', sll_buy_dvsn_cd: '02', ft_ord_qty: '5', ft_ccld_qty: '1', nccs_qty: '4' }] });
            return dataOk({ output: { ODNO: 'US-1' } });
        });

        await newKis({ sandbox: false }).editOrder('US-1', 'AAPL/USD', 'limit', 'buy', undefined, 226);

        const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/overseas-stock/v1/trading/order-rvsecncl'))!;
        expect(JSON.parse((call[1] as { body: string }).body)).toMatchObject({ ORD_QTY: '4' });
    });

    it('모의투자의 해외 정정은 미체결 조회가 없어 수량이 없으면 ArgumentsRequired', async () => {
        await expect(newKis({ sandbox: true }).editOrder('US-1', 'AAPL/USD', 'limit', 'buy', undefined, 226)).rejects.toThrow(ArgumentsRequired);
    });

    it('모의투자의 해외 정정은 amount 를 원주문과 대조할 수 없어 요청 없이 NotSupported 다(params.amount 로 준다)', async () => {
        vi.setSystemTime(MARKET_TIMES.usRegular);

        await expect(newKis({ sandbox: true }).editOrder('US-1', 'AAPL/USD', 'limit', 'buy', 5, 226)).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('해외 정정의 일부정정(params.partial)은 요청 없이 NotSupported 다', async () => {
        await expect(newKis({ sandbox: false }).editOrder('US-1', 'AAPL/USD', 'limit', 'buy', 1, 226, { partial: true })).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
