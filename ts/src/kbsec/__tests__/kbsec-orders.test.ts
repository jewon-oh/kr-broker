/**
 * @fileoverview `kbsec` 주문 계열 — `createOrder`·`editOrder`·`cancelOrder`·`cancelAllOrders`·`fetchOpenOrders`·`fetchOrder`·`fetchMyTrades`.
 *
 * 주문 안전 계약을 본다.
 * - 장 시간 밖이면 요청을 보내지 않고 `MarketClosed` 다.
 * - 주문 요청은 재시도하지 않고, 연결이 끊기면 `OrderOutcomeUnknown` 이다.
 * - 접수 응답을 요청값으로 추정하지 않는다. 체결 조회로 확정하고, 확정하지 못하면 `filled` 를 비우고 `info.fillConfirmed` 가 `false` 다.
 * - 국내는 수량을 내림하고 1주 미만은 보내지 않는다. 해외 시장가 매수는 체결 가능 지정가로 바꿔 보낸다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import {
    ArgumentsRequired, BadRequest, ExchangeError, InsufficientFunds, InvalidOrder, MarketClosed, NotSupported, OrderNotFound, OrderOutcomeUnknown,
    PermissionDenied,
} from '../../base/errors';
import { KBSEC_ERROR_DETAIL } from '../kbsec-error-codes';
import { KBSEC_ORDER_TYPE_US, KBSEC_TR } from '../kbsec-types';
import { __resetFillSideWarn, __resetKbsecTokenBreaker, resetMarketCalendar } from '../../testing';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { CREDS, bizError, calledTrs, routeTr, tokenOk, trBody } from './support/kbsec-fetch';

// 해외 종목의 세션 판정은 상장 거래소를 알아야 한다. 패키지는 마스터 파일을 싣지 않으므로 테스트가 쓰는 종목만 넘긴다.
const MASTER_DATA = {
    ...KIS_MASTER_FIXTURE,
    nyse: [...KIS_MASTER_FIXTURE.nyse, { code: 'KO', name: 'COCA-COLA CO', nameKr: '코카콜라', market: 'NYS' as const, currency: 'USD' }],
};

/** `nxtRouting` 옵션을 켤지. 옵션은 함수로 넘겨 주문 때마다 읽는다. */
let nxtRouting = false;

/** 2026-08-19(수) 10:00 KST — 평일·비휴장 KRX 정규장. */
const KRX_REGULAR = new Date('2026-08-19T01:00:00Z');
/** 2026-08-19(수) 21:00 KST — 장 종료 뒤. */
const KRX_CLOSED = new Date('2026-08-19T12:00:00Z');
/** 2026-08-19(수) 10:00 ET — NYSE 정규장. */
const US_REGULAR = new Date('2026-08-19T14:00:00Z');

/** 체결 확정 조회 간격을 0 으로 둔 인스턴스. 시도 횟수는 그대로다. */
const newExchange = () => new kbsec({
    ...CREDS,
    rateLimit: 0,
    options: { masterData: MASTER_DATA, nxtRouting: () => nxtRouting, confirmBudget: { intervalMs: 0 } },
});

const TR_BUY = KBSEC_TR.BUY_KR;
const TR_SELL = KBSEC_TR.SELL_KR;

/** 체결 행은 KB 공식 스펙(SSQM2341 outputSpec)의 이름으로 만든다. */
const fill = (over: Record<string, unknown> = {}) => ({
    ordr_no: 'A123', stnd_is_no: 'KR7005930003', trd_dl_ccd_nm: '현금매수',
    ordr_q: '3', tl_ccls_q: '3', nccls_q: '0', ccls_uprc: '69800', ordr_uprc: '70000',
    ...over,
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(KRX_REGULAR);
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
    __resetFillSideWarn();
    resetMarketCalendar();
    nxtRouting = false;
});
afterEach(() => {
    vi.useRealTimers();
});

describe('createOrder — 국내', () => {
    it('지정가 매수 — 명세 코드값으로 나가고 Order 를 돌려준다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A123' } });

        const order = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 3, 70000);

        expect(trBody(mockFetch, TR_BUY).dataBody).toMatchObject({
            mkt_tm_clsf: '1', ordr_jb_clsf: '2', s_clsf: '', is_cd: '005930', ordr_q: '3', ordr_uprc: '70000',
            ordr_ccd: '00', crdt_typ_cd: '00', sor_ordr_ccd: 'K',
        });
        expect(order).toMatchObject({ id: 'A123', symbol: '005930/KRW', type: 'limit', side: 'buy', price: 70000, amount: 3 });
    });

    it('체결을 확정하지 못하면 filled·average 를 비운다 — 값을 지어내지 않고 fillConfirmed:false 로 알린다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A123' } });

        const order = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 3, 70000);

        expect(order.status).toBe('open');
        expect(order.filled).toBeUndefined();
        expect(order.average).toBeUndefined();
        expect((order.info as { fillConfirmed: boolean }).fillConfirmed).toBe(false);
    });

    it('체결을 확정하면 체결가·수량·금액이 채워지고 closed 다 — 요청가(70000)가 아니라 체결가(69800)', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A123' }, [KBSEC_TR.TRADES_KR]: { Record1: [fill()] } });

        const order = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 3, 70000);

        expect(order).toMatchObject({ status: 'closed', filled: 3, remaining: 0, average: 69800, cost: 209400 });
        expect((order.info as { fillConfirmed: boolean }).fillConfirmed).toBe(true);
    });

    it('부분체결이면 open 이고 남은 수량이 있다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A123' }, [KBSEC_TR.TRADES_KR]: { Record1: [fill({ tl_ccls_q: '1', nccls_q: '2' })] } });

        const order = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 3, 70000);

        expect(order).toMatchObject({ status: 'open', filled: 1, remaining: 2 });
    });

    it('체결수량은 주문수량을 넘을 수 없다 — 넘으면 상한으로 자르고 금액도 같이 자른다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A123' }, [KBSEC_TR.TRADES_KR]: { Record1: [fill({ tl_ccls_q: '9', nccls_q: '0' })] } });

        const order = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 3, 70000);

        expect(order.filled).toBe(3);
        expect(order.cost).toBe(3 * 69800);
    });

    it('다른 주문번호의 체결은 섞이지 않는다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A123' }, [KBSEC_TR.TRADES_KR]: { Record1: [fill({ ordr_no: 'ZZZ' })] } });

        const order = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 3, 70000);

        expect((order.info as { fillConfirmed: boolean }).fillConfirmed).toBe(false);
    });

    it('시장가 매도 — 단가는 빈 값이고 구분은 03 이다(0 을 보내면 거부된다)', async () => {
        routeTr(mockFetch, { [TR_SELL]: { ordr_no: 'S1' } });

        const order = await newExchange().createOrder('005930/KRW', 'market', 'sell', 2);

        expect(trBody(mockFetch, TR_SELL).dataBody).toMatchObject({ ordr_jb_clsf: '1', ordr_uprc: '', ordr_ccd: '03' });
        expect(order.type).toBe('market');
    });

    it('수량은 내림이다 — 8.87 주는 8 주로 나간다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A1' } });

        const order = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 8.87, 70000);

        expect(trBody(mockFetch, TR_BUY).dataBody.ordr_q).toBe('8');
        expect(order.amount).toBe(8);
    });

    it('1주 미만은 요청을 보내지 않고 InvalidOrder(QUANTITY_INVALID)다', async () => {
        routeTr(mockFetch, {});

        const error = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 0.4, 70000).then(() => null, (e: unknown) => e) as InvalidOrder;

        expect(error).toBeInstanceOf(InvalidOrder);
        expect(error.detail).toBe(KBSEC_ERROR_DETAIL.QUANTITY_INVALID);
        expect(error.brokerCode).toBeUndefined();
        expect(calledTrs(mockFetch)).not.toContain(TR_BUY.toLowerCase());
    });

    it('지정가에 가격이 없거나 방향·유형이 틀리면 요청 전에 던진다', async () => {
        const exchange = newExchange();
        await expect(exchange.createOrder('005930/KRW', 'limit', 'buy', 1, undefined)).rejects.toThrow(ArgumentsRequired);
        await expect(exchange.createOrder('005930/KRW', 'limit', 'hold', 1, 100)).rejects.toThrow(InvalidOrder);
        await expect(exchange.createOrder('005930/KRW', 'stop', 'buy', 1, 100)).rejects.toThrow(InvalidOrder);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('소수점 주문 — 수량이 ordr_q_p6 로 소수 6자리로 나간다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_BUY_KR]: { ordr_no: 'F1' } });

        const order = await newExchange().createOrder('005930/KRW', 'market', 'buy', 0.123456, undefined, { fractional: true });

        const body = trBody(mockFetch, KBSEC_TR.FRAC_BUY_KR).dataBody;
        expect(body.ordr_q_p6).toBe('0.123456');
        expect(body.ordr_q).toBeUndefined();
        expect(order.id).toBe('F1');
        expect((order.info as { fractional: boolean }).fractional).toBe(true);
    });

    it('소수점은 국내만이다', async () => {
        vi.setSystemTime(US_REGULAR);
        await expect(newExchange().createOrder('AAPL/USD', 'market', 'buy', 0.5, undefined, { fractional: true })).rejects.toThrow(NotSupported);
    });
});

describe('createOrder — 조건 주문 인자', () => {
    // KB 에는 조건(스톱) 주문 API 를 쓰지 않는다. 이 인자를 조용히 버리면 조건 주문을 의도한 호출이 곧바로 체결되는 일반 주문으로 나간다.
    it.each(['triggerPrice', 'stopPrice', 'stopLossPrice', 'takeProfitPrice'])('%s 가 있으면 요청을 하나도 보내지 않고 NotSupported 다', async (key) => {
        routeTr(mockFetch, { [TR_SELL]: { ordr_no: 'A1' } });

        await expect(newExchange().createOrder('005930/KRW', 'limit', 'sell', 3, 70000, { [key]: 65000 })).rejects.toBeInstanceOf(NotSupported);
        await expect(newExchange().createOrder('005930/KRW', 'market', 'sell', 3, undefined, { [key]: 65000 })).rejects.toBeInstanceOf(NotSupported);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('해외 종목도 같다', async () => {
        vi.setSystemTime(US_REGULAR);
        routeTr(mockFetch, { [KBSEC_TR.ORDER_US]: { ordr_no: 'U1' } });

        await expect(newExchange().createOrder('AAPL/USD', 'limit', 'sell', 1, 230, { stopLossPrice: 200 })).rejects.toBeInstanceOf(NotSupported);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('값이 없는 키(undefined·null)는 조건 주문으로 보지 않는다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A2' } });

        const order = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000, { triggerPrice: undefined, stopPrice: null });

        expect(order.id).toBe('A2');
        expect(calledTrs(mockFetch)).toContain(TR_BUY.toLowerCase());
    });

    it('timeInForce·postOnly·reduceOnly·clientOrderId·cost 는 그대로 받고 요청 본문에 싣지 않는다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A3' } });

        const order = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000, {
            timeInForce: 'GTC', postOnly: false, reduceOnly: false, clientOrderId: 'c-1', cost: 70000,
        });

        expect(order.id).toBe('A3');
        const body = trBody(mockFetch, TR_BUY).dataBody;
        for (const key of ['timeInForce', 'postOnly', 'reduceOnly', 'clientOrderId', 'cost']) expect(body[key], key).toBeUndefined();
    });
});

describe('createOrder — 장 시간', () => {
    it('장 시간 밖이면 MarketClosed 를 던지고 주문 요청은 나가지 않는다', async () => {
        routeTr(mockFetch, {});
        vi.setSystemTime(KRX_CLOSED);

        const error = await newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000).then(() => null, (e: unknown) => e) as MarketClosed;

        expect(error).toBeInstanceOf(MarketClosed);
        expect(error.retryable).toBe(false); // 곧바로 다시 보내도 장이 열려 있지 않다
        expect(calledTrs(mockFetch)).not.toContain(TR_BUY.toLowerCase());
    });

    it('국내 실주문 직전에 휴장일 캘린더를 받는다 — KB 만 쓰는 배포에서도 장 시간 판정이 공휴일을 안다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A1' }, [KBSEC_TR.MARKET_STATUS]: {} });

        await newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000);

        expect(calledTrs(mockFetch)).toContain(KBSEC_TR.MARKET_STATUS.toLowerCase());
    });

    it('종가 동시호가(15:25 KST)의 신규 매수는 기본으로 내고, blockAuctionBuys 를 켜면 막는다. 매도는 켜도 낸다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A1' }, [TR_SELL]: { ordr_no: 'S1' } });
        vi.setSystemTime(new Date('2026-08-19T06:25:00Z'));
        const guarded = () => new kbsec({ ...CREDS, rateLimit: 0, options: { blockAuctionBuys: true, confirmBudget: { intervalMs: 0 } } });

        await expect(newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000)).resolves.toMatchObject({ id: 'A1' });
        await expect(guarded().createOrder('005930/KRW', 'limit', 'buy', 1, 70000)).rejects.toThrow(/종가 동시호가/);
        await expect(guarded().createOrder('005930/KRW', 'limit', 'sell', 1, 70000)).resolves.toMatchObject({ id: 'S1' });
    });
});

describe('createOrder — 해외', () => {
    const usQuote = { now_prc_p4: '100.0000', b_askprc_p4: '99.9000', s_askprc_p4: '100.2000' };
    beforeEach(() => { vi.setSystemTime(US_REGULAR); });

    it('지정가 매수 — SKAM2101 과 소수점 4자리 가격', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDER_US]: { ordr_no: 'U1' } });

        await newExchange().createOrder('AAPL/USD', 'limit', 'buy', 2, 231.5);

        expect(trBody(mockFetch, KBSEC_TR.ORDER_US).dataBody).toMatchObject({
            trd_dl_ccd: '02', is_cd: 'AAPL', frgn_ordr_typ_cd: KBSEC_ORDER_TYPE_US.LIMIT, frgn_ordr_q: '2', frgn_ordr_prc_p4: '231.5000',
        });
    });

    it('현금 코드와 같은 티커는 옛 심볼과 표의 통합 코드 심볼 모두 티커 USD 로 내고, 결과 심볼은 표의 통합 코드다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDER_US]: { ordr_no: 'U2' } });
        const amex = [{ code: 'USD', name: 'PROSHARES ULTRA SEMICONDUCTORS', market: 'AMS' as const, currency: 'USD' }];
        const broker = new kbsec({ ...CREDS, rateLimit: 0, options: { masterData: { ...MASTER_DATA, amex }, confirmBudget: { intervalMs: 0 } } });

        for (const symbol of ['USD/USD', 'ProShares Ultra Semiconductors/USD']) {
            const order = await broker.createOrder(symbol, 'limit', 'buy', 2, 40.5);

            // 세션 게이트도 티커로 상장 거래소(AMEX)를 찾는다. 통합 코드로 찾으면 거래소를 몰라 MarketClosed 다.
            expect(trBody(mockFetch, KBSEC_TR.ORDER_US).dataBody).toMatchObject({ is_cd: 'USD', frgn_ordr_q: '2', frgn_ordr_prc_p4: '40.5000' });
            expect(order.symbol).toBe('ProShares Ultra Semiconductors/USD');
        }
    });

    it('시장가 매수는 체결 가능 지정가로 바꿔 보낸다 — 매도호가 100.20 × 1.005 를 센트로 올린 100.71', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_US]: usQuote, [KBSEC_TR.ORDER_US]: { ordr_no: 'M1' } });

        const order = await newExchange().createOrder('KO/USD', 'market', 'buy', 3);

        const body = trBody(mockFetch, KBSEC_TR.ORDER_US).dataBody;
        expect(body.frgn_ordr_typ_cd).toBe(KBSEC_ORDER_TYPE_US.LIMIT);
        expect(body.frgn_ordr_prc_p4).toBe('100.7100');
        expect(Number(body.frgn_ordr_prc_p4)).toBeGreaterThanOrEqual(100.2); // 항상 매도호가 이상이다
        expect(order).toMatchObject({ type: 'limit', price: 100.71 });
    });

    it('호가를 못 구하면 주문을 보내지 않는다', async () => {
        routeTr(mockFetch, {});

        await expect(newExchange().createOrder('KO/USD', 'market', 'buy', 3)).rejects.toThrow(/호가를 조회하지 못했습니다/);
        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.ORDER_US.toLowerCase());
    });

    it('시장가 매도는 그대로 시장가다 — 청산 경로는 불변', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDER_US]: { ordr_no: 'M4' } });

        await newExchange().createOrder('KO/USD', 'market', 'sell', 3);

        expect(trBody(mockFetch, KBSEC_TR.ORDER_US).dataBody.frgn_ordr_typ_cd).toBe(KBSEC_ORDER_TYPE_US.MARKET);
    });

    it('fetchMarketableBuyPrice — 셸이 모의 주문에서도 같은 가격을 쓸 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_US]: usQuote });

        expect(await newExchange().fetchMarketableBuyPrice('KO/USD')).toBe(100.71);
    });
});

describe('createOrder — 넥스트레이드 라우팅', () => {
    const enableNxt = () => { nxtRouting = true; };
    const sorOf = (index: number): unknown => {
        const bodies = mockFetch.mock.calls
            .filter(c => String(c[0]).endsWith(`/api/v1/${TR_BUY.toLowerCase()}`))
            .map(c => JSON.parse((c[1] as { body: string }).body).dataBody.sor_ordr_ccd);
        return bodies[index];
    };

    it('nxtRouting 옵션이 꺼져 있으면 KRX 고정이다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A1' } });

        await newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000);

        expect(sorOf(0)).toBe('K');
    });

    it('nxtRouting 옵션이 켜져 있으면 SOR 에 맡긴다', async () => {
        enableNxt();
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A1' } });

        await newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000);

        expect(sorOf(0)).toBe('S');
    });

    it('NXT 미상장 종목은 SOR 거부(L545)를 받으면 KRX 로 다시 보내 접수시키고, 다음부터는 KRX 직행이다', async () => {
        enableNxt();
        let sorAttempts = 0;
        routeTr(mockFetch, {
            [TR_BUY]: (body: Record<string, unknown>) => {
                if (body.sor_ordr_ccd === 'S') {
                    sorAttempts++;
                    return 'NXT에서 거래할 수 없는 종목입니다. KRX로 주문해주세요.';
                }
                return { ordr_no: 'A1' };
            },
        });
        // 문자열 응답은 processCode 9999 라 L545 를 직접 만든다
        mockFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
            const u = String(url);
            if (u.includes('/oauth2/token')) return tokenOk();
            const tr = u.split('/api/v1/')[1] ?? '';
            if (tr === TR_BUY.toLowerCase()) {
                const sor = JSON.parse(init!.body!).dataBody.sor_ordr_ccd;
                if (sor === 'S') { sorAttempts++; return bizError('NXT에서 거래할 수 없는 종목입니다.', 'L545'); }
                return { ok: true, status: 200, text: async () => JSON.stringify({ dataHeader: { processFlag: 'A' }, dataBody: { ordr_no: 'A1' } }) };
            }
            return { ok: true, status: 200, text: async () => JSON.stringify({ dataHeader: { processFlag: 'A' }, dataBody: {} }) };
        });
        const exchange = newExchange();

        const first = await exchange.createOrder('005930/KRW', 'limit', 'buy', 1, 70000);
        const second = await exchange.createOrder('005930/KRW', 'limit', 'buy', 1, 70000);

        expect(first.id).toBe('A1');
        expect(second.id).toBe('A1');
        expect(sorAttempts).toBe(1); // 한 번 확인한 종목은 거부를 다시 맞지 않는다
        expect([sorOf(0), sorOf(1), sorOf(2)]).toEqual(['S', 'K', 'K']);
    });

    it('params.sor 가 정책보다 우선한다', async () => {
        enableNxt();
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A1' } });

        await newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000, { sor: 'K' });

        expect(sorOf(0)).toBe('K');
    });
});

describe('createOrder — 실패의 종류', () => {
    const rejectedBy = (code: string) => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/token') ? tokenOk() : bizError('실측 문구', code)));
        return newExchange().createOrder('005930/KRW', 'limit', 'buy', 1, 70000).then(() => null, (e: unknown) => e) as Promise<ExchangeError>;
    };

    it('1896 은 InvalidOrder(PRICE_INVALID), 1951 은 InsufficientFunds(INSUFFICIENT_POSITION), I446 은 PermissionDenied 다', async () => {
        const price = await rejectedBy('1896');
        expect(price).toBeInstanceOf(InvalidOrder);
        expect(price.detail).toBe(KBSEC_ERROR_DETAIL.PRICE_INVALID);

        const position = await rejectedBy('1951');
        expect(position).toBeInstanceOf(InsufficientFunds);
        expect(position.detail).toBe(KBSEC_ERROR_DETAIL.INSUFFICIENT_POSITION);

        expect(await rejectedBy('I446')).toBeInstanceOf(PermissionDenied);
    });

    it('분류 밖의 거절은 추측하지 않는다 — ExchangeError 이고 detail 이 없다', async () => {
        const error = await rejectedBy('9999');
        expect(Object.getPrototypeOf(error)).toBe(ExchangeError.prototype);
        expect(error.detail).toBeUndefined();
    });

    it('연결이 끊기면 OrderOutcomeUnknown 이고 재시도하지 않는다 — 접수됐을 수 있고 다시 보내면 중복 주문이다', async () => {
        let orderRequests = 0;
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('/oauth2/token')) return tokenOk();
            // 휴장일 캘린더 조회는 조회라 재시도 대상이다. 세는 것은 주문 요청뿐이다.
            if (String(url).endsWith(`/api/v1/${TR_BUY.toLowerCase()}`)) orderRequests++;
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        });
        const exchange = new kbsec({ ...CREDS, rateLimit: 0, options: { maxRetriesOnFailure: 3 } });

        const error = await exchange.createOrder('005930/KRW', 'limit', 'buy', 1, 70000).then(() => null, (e: unknown) => e) as OrderOutcomeUnknown;

        expect(error).toBeInstanceOf(OrderOutcomeUnknown);
        expect(error.retryable).toBe(false);
        expect(orderRequests).toBe(1);
    });
});

describe('createOrder·editOrder — 호가 단위', () => {
    /** 마스터가 005930 을 일반 주식(STOCK)이라고 알려 주는 인스턴스. */
    const withStockMaster = () => new kbsec({
        ...CREDS,
        rateLimit: 0,
        options: {
            masterData: { ...MASTER_DATA, kospi: [{ code: '005930', name: '삼성전자', market: 'KOSPI' as const, securityType: 'STOCK' }] },
            confirmBudget: { intervalMs: 0 },
        },
    });

    it('마스터가 주식이라고 알려 주면 호가 단위에 맞지 않는 지정가를 요청 없이 InvalidOrder 로 막는다. 가격을 바꿔 내지 않는다', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A123' } });

        const error = await withStockMaster().createOrder('005930/KRW', 'limit', 'buy', 3, 70_030).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(InvalidOrder);
        expect((error as InvalidOrder).detail).toBe('price-tick-invalid');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('정정 가격도 같다. 원주문 라우팅 조회도 나가지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM1' } });

        await expect(withStockMaster().editOrder('O9', '005930/KRW', 'limit', 'buy', undefined, 70_030)).rejects.toBeInstanceOf(InvalidOrder);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('종목 유형을 모르면 막지 않고 가격을 그대로 보낸다(서버의 1896 에 맡긴다)', async () => {
        routeTr(mockFetch, { [TR_BUY]: { ordr_no: 'A123' } });

        await newExchange().createOrder('005930/KRW', 'limit', 'buy', 3, 70_030);

        expect(trBody(mockFetch, TR_BUY).dataBody.ordr_uprc).toBe('70030');
    });
});

describe('editOrder', () => {
    it('국내 일부정정 — crct_clsf 1, 원주문 번호, 수량과 가격. 정정하면 주문번호가 바뀐다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM1' }, [KBSEC_TR.TRADES_KR]: { Record1: [] } });

        const order = await newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', 2, 71000, { partial: true });

        expect(trBody(mockFetch, KBSEC_TR.AMEND_KR).dataBody).toMatchObject({
            ordr_jb_clsf: '3', crct_clsf: '1', orgn_ordr_no: 'O9', ordr_uprc: '71000', ordr_q: '2',
        });
        expect(order.id).toBe('AM1');
        expect(order.amount).toBe(2);
    });

    /** 원주문 O9 가 5주 가운데 2주 체결된 미체결 목록. */
    const openO9 = { Record1: [{ ordr_no: 'O9', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '5', tl_ccls_q: '2', nccls_q: '3', sor_ordr_ccd: 'K' }] };

    it('국내 전부정정은 수량을 0 으로 보낸다 — 수량을 실으면 거부된다(2329). amount 없이 부르면 반환값에 수량을 싣지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM2' } });

        const order = await newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', undefined, 71000);

        expect(trBody(mockFetch, KBSEC_TR.AMEND_KR).dataBody).toMatchObject({ crct_clsf: '2', ordr_q: '0' });
        expect(order.amount).toBeUndefined();
    });

    it('★amount 는 정정 뒤 총수량이다. 미체결 목록의 체결 + 잔량과 같으면 전부정정하고 그 총수량을 돌려준다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: openO9, [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM2' } });

        const order = await newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', 5, 71000);

        expect(trBody(mockFetch, KBSEC_TR.AMEND_KR).dataBody).toMatchObject({ crct_clsf: '2', ordr_q: '0', sor_ordr_ccd: 'K' });
        expect(order.amount).toBe(5);
    });

    it('★amount 가 총수량과 다르면 받은 수량을 버리지 않고 정정 요청 없이 NotSupported 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: openO9, [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM2' } });

        await expect(newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', 3, 71000)).rejects.toBeInstanceOf(NotSupported);
        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.AMEND_KR.toLowerCase());
    });

    it('amount 를 줬는데 원주문이 미체결 목록에 없으면 발주 정책으로 폴백하지 않고 OrderNotFound 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: { Record1: [] }, [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM2' } });

        await expect(newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', 5, 71000)).rejects.toBeInstanceOf(OrderNotFound);
        expect(calledTrs(mockFetch)).not.toContain(KBSEC_TR.AMEND_KR.toLowerCase());
    });

    it('일부정정(params.partial)에 amount 가 없으면 요청 없이 ArgumentsRequired 다', async () => {
        await expect(newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', undefined, 71000, { partial: true })).rejects.toBeInstanceOf(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('정정은 원주문과 같은 라우팅으로 나간다 — 미체결 목록의 sor_ordr_ccd 가 정본이다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_KR]: { Record1: [{ ordr_no: 'O9', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '2', nccls_q: '2', sor_ordr_ccd: 'S' }] },
            [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM3' },
        });

        await newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', undefined, 71000);

        expect(trBody(mockFetch, KBSEC_TR.AMEND_KR).dataBody.sor_ordr_ccd).toBe('S');
    });

    it('해외 정정은 가격만 바꾼다 — crct_cncl_clsf 1 이고 수량 필드를 보내지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_CANCEL_US]: { ordr_no: 'UM1' } });
        vi.setSystemTime(US_REGULAR);

        const order = await newExchange().editOrder('O9', 'AAPL/USD', 'limit', 'buy', undefined, 230.25);

        const body = trBody(mockFetch, KBSEC_TR.AMEND_CANCEL_US).dataBody;
        expect(body).toMatchObject({ crct_cncl_clsf: '1', orgn_ordr_no: 'O9', frgn_ordr_prc_p4: '230.2500' });
        expect(body.frgn_ordr_q).toBeUndefined();
        expect(order.id).toBe('UM1');
    });

    it('★해외 amount 는 원주문의 체결 수량을 믿을 만한 조회로 확인할 수 없어 요청(조회 포함) 없이 NotSupported 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_CANCEL_US]: { ordr_no: 'UM1' } });

        await expect(newExchange().editOrder('O9', 'AAPL/USD', 'limit', 'buy', 3, 230.25)).rejects.toBeInstanceOf(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('해외 일부정정(params.partial)은 요청 없이 NotSupported 다', async () => {
        await expect(newExchange().editOrder('O9', 'AAPL/USD', 'limit', 'buy', 1, 230.25, { partial: true })).rejects.toBeInstanceOf(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('editOrder — 장 시간', () => {
    it('국내 정규장이 끝나기 직전(15:29:59 KST)에는 정정 요청이 나간다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM5' } });
        vi.setSystemTime(new Date('2026-08-19T06:29:59Z'));

        const order = await newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', undefined, 71000);

        expect(order.id).toBe('AM5');
        expect(calledTrs(mockFetch)).toContain(KBSEC_TR.AMEND_KR.toLowerCase());
    });

    it('★국내 정규장이 끝난 15:30 KST 에는 원주문 조회와 정정 요청 없이 MarketClosed 다. 휴장일 캘린더만 받는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: { Record1: [] }, [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM5' } });
        vi.setSystemTime(new Date('2026-08-19T06:30:00Z'));

        // amount 가 없으면 라우팅을, 있으면 총수량을 확인하려고 미체결 목록을 조회하는 경로다. 둘 다 조회 전에 막는다.
        await expect(newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', undefined, 71000)).rejects.toBeInstanceOf(MarketClosed);
        await expect(newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', 5, 71000)).rejects.toBeInstanceOf(MarketClosed);

        expect(calledTrs(mockFetch)).toEqual([KBSEC_TR.MARKET_STATUS.toLowerCase()]);
    });

    it('미국 정규장이 끝나기 직전(15:59:59 ET)에는 정정 요청이 나간다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_CANCEL_US]: { ordr_no: 'UM2' } });
        vi.setSystemTime(new Date('2026-08-19T19:59:59Z'));

        const order = await newExchange().editOrder('O9', 'AAPL/USD', 'limit', 'buy', undefined, 230.25);

        expect(order.id).toBe('UM2');
    });

    it('★미국 정규장이 끝난 16:00 ET 에는 요청을 하나도 보내지 않고 MarketClosed 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_CANCEL_US]: { ordr_no: 'UM2' } });
        vi.setSystemTime(new Date('2026-08-19T20:00:00Z'));

        await expect(newExchange().editOrder('O9', 'AAPL/USD', 'limit', 'buy', undefined, 230.25)).rejects.toBeInstanceOf(MarketClosed);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('정정은 신규 진입이 아니라서 blockAuctionBuys 를 켜도 종가 동시호가(15:25 KST)의 매수 정정을 막지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM6' } });
        vi.setSystemTime(new Date('2026-08-19T06:25:00Z'));
        const guarded = new kbsec({ ...CREDS, rateLimit: 0, options: { blockAuctionBuys: true, confirmBudget: { intervalMs: 0 } } });

        await expect(guarded.editOrder('O9', '005930/KRW', 'limit', 'buy', undefined, 71000)).resolves.toMatchObject({ id: 'AM6' });
    });
});

describe('editOrder — 가격 생략', () => {
    // 정정은 단가를 바꾸는 주문이다. 가격을 빼면 단가 '0' 이 나가므로 요청 전에 던진다.
    it('국내 정정에 price 가 없으면 요청 없이 ArgumentsRequired 다 — 일부정정·전부정정 모두', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM1' } });

        await expect(newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', 2, undefined, { partial: true })).rejects.toBeInstanceOf(ArgumentsRequired);
        await expect(newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', 5)).rejects.toBeInstanceOf(ArgumentsRequired);

        // 원주문 라우팅을 찾는 미체결 조회도 나가지 않는다.
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('해외 정정에 price 가 없으면 요청 없이 ArgumentsRequired 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_CANCEL_US]: { ordr_no: 'UM1' } });

        await expect(newExchange().editOrder('O9', 'AAPL/USD', 'limit', 'buy', 5)).rejects.toBeInstanceOf(ArgumentsRequired);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('price 가 있으면 그 값이 단가로 나간다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_KR]: { ordr_no: 'AM4' }, [KBSEC_TR.TRADES_KR]: { Record1: [] } });

        await newExchange().editOrder('O9', '005930/KRW', 'limit', 'buy', undefined, 71000);

        expect(trBody(mockFetch, KBSEC_TR.AMEND_KR).dataBody.ordr_uprc).toBe('71000');
    });
});

describe('cancelOrder·cancelAllOrders', () => {
    it('국내 취소 — 전부취소(crct_clsf 2)와 원주문 번호', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CANCEL_KR]: { ordr_no: 'C1' } });

        const order = await newExchange().cancelOrder('O1', '005930/KRW');

        expect(trBody(mockFetch, KBSEC_TR.CANCEL_KR).dataBody).toMatchObject({ ordr_jb_clsf: '4', crct_clsf: '2', orgn_ordr_no: 'O1' });
        expect(order).toMatchObject({ id: 'O1', status: 'canceled', symbol: '005930/KRW' });
    });

    it('해외 취소는 crct_cncl_clsf 2 로 나간다 — 국내 필드명(crct_clsf)이면 구분이 빈 채로 간다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.AMEND_CANCEL_US]: { ordr_no: 'C2' } });

        await newExchange().cancelOrder('O1', 'AAPL/USD');

        const body = trBody(mockFetch, KBSEC_TR.AMEND_CANCEL_US).dataBody;
        expect(body.crct_cncl_clsf).toBe('2');
        expect(body.crct_clsf).toBeUndefined();
    });

    it('종목이 없으면 ArgumentsRequired 다', async () => {
        await expect(newExchange().cancelOrder('O1')).rejects.toThrow(ArgumentsRequired);
    });

    it('취소 실패는 던진다 — 호출하는 쪽이 "이미 사라진 주문"인지 판단한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CANCEL_KR]: '이미 체결된 주문입니다' });

        await expect(newExchange().cancelOrder('O1', '005930/KRW')).rejects.toThrow(/이미 체결된 주문/);
    });

    it('cancelAllOrders — 시도한 주문마다 항목을 돌려준다. 취소된 것은 canceled, 실패한 것은 open 과 cancelError 다', async () => {
        const rows = [
            { ordr_no: 'O1', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '1', nccls_q: '1' },
            { ordr_no: 'O2', stnd_is_no: 'A000660', trd_dl_ccd_nm: '현금매수', ordr_q: '1', nccls_q: '1' },
        ];
        mockFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
            const u = String(url);
            if (u.includes('/oauth2/token')) return tokenOk();
            const tr = u.split('/api/v1/')[1] ?? '';
            if (tr === KBSEC_TR.TRADES_KR.toLowerCase()) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ dataHeader: { processFlag: 'A' }, dataBody: { Record1: rows } }) };
            }
            if (tr === KBSEC_TR.CANCEL_KR.toLowerCase()) {
                const target = JSON.parse(init!.body!).dataBody.orgn_ordr_no;
                return target === 'O2' ? bizError('취소할 수 없는 주문입니다') : { ok: true, status: 200, text: async () => JSON.stringify({ dataHeader: { processFlag: 'A' }, dataBody: { ordr_no: 'C' } }) };
            }
            return { ok: true, status: 200, text: async () => JSON.stringify({ dataHeader: { processFlag: 'A' }, dataBody: {} }) };
        });

        const results = await newExchange().cancelAllOrders();

        expect(results.map(r => [r.id, r.status])).toEqual([['O1', 'canceled'], ['O2', 'open']]);
        expect((results[1]!.info as { cancelError: string }).cancelError).toContain('취소할 수 없는 주문');
    });
});

describe('fetchOpenOrders·fetchOrder', () => {
    const OPEN_ROWS = {
        Record1: [
            { ordr_no: 'O1', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '10', nccls_q: '10', tl_ccls_q: '0', ordr_uprc: '70000', ordr_ccd: '00' },
            { ordr_no: 'O2', stnd_is_no: 'KR7000660001', trd_dl_ccd_nm: '현금매도', ordr_q: '4', nccls_q: '3', tl_ccls_q: '1', ccls_uprc: '120000', ordr_uprc: '121000', ordr_ccd: '00' },
        ],
    };

    it('미체결은 SSQM2341 미체결 구분으로 조회하고 종목코드의 A 접두·ISIN 을 벗긴 심볼로 돌려준다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: OPEN_ROWS });

        const orders = await newExchange().fetchOpenOrders();

        expect(trBody(mockFetch, KBSEC_TR.TRADES_KR).dataBody).toMatchObject({ ccls_clsf: '2', inq_clsf: '1' });
        expect(orders.map(o => [o.id, o.symbol, o.side, o.status, o.amount, o.filled, o.remaining])).toEqual([
            ['O1', '005930/KRW', 'buy', 'open', 10, 0, 10],
            ['O2', '000660/KRW', 'sell', 'open', 4, 1, 3],
        ]);
        expect(orders[0]!.info).toEqual(OPEN_ROWS.Record1[0]); // 원본 행은 info 에 있다
    });

    it('전체 심볼로 걸러도 잡힌다 — 기초코드로 정규화해 비교한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: OPEN_ROWS });

        const orders = await newExchange().fetchOpenOrders('005930/KRW');

        expect(orders.map(o => o.id)).toEqual(['O1']);
    });

    // KB 미체결 행에는 주문 시각의 날짜가 없다. 기본 필터는 timestamp 가 없는 항목을 전부 버려서 since 를 주면 목록이 통째로 비었다.
    it('since 를 주어도 미체결이 사라지지 않는다 — 주문 시각이 없어 since 는 적용하지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: OPEN_ROWS });

        const withSince = await newExchange().fetchOpenOrders(undefined, Date.now() - 60_000);
        const future = await newExchange().fetchOpenOrders(undefined, Date.now() + 86_400_000);

        expect(withSince.map(o => o.id)).toEqual(['O1', 'O2']);
        expect(future.map(o => o.id)).toEqual(['O1', 'O2']);
    });

    it('since 와 함께 준 symbol·limit 은 그대로 적용한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: OPEN_ROWS });

        expect((await newExchange().fetchOpenOrders('005930/KRW', Date.now())).map(o => o.id)).toEqual(['O1']);
        expect((await newExchange().fetchOpenOrders(undefined, Date.now(), 1)).map(o => o.id)).toHaveLength(1);
    });

    it('조회가 실패하면 빈 배열이 아니라 던진다 — 실패와 "미체결 없음"을 구분한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: '조회 실패' });

        await expect(newExchange().fetchOpenOrders()).rejects.toThrow();
    });

    it('미체결이 0건이면(플래그 B + 1861) 빈 배열이다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/token')
            ? tokenOk()
            : { ok: true, status: 200, text: async () => JSON.stringify({ dataHeader: { processFlag: 'B', processCode: '1861' }, dataBody: {} }) }));

        expect(await newExchange().fetchOpenOrders()).toEqual([]);
    });

    it('해외 미체결은 지원하지 않는다', async () => {
        await expect(newExchange().fetchOpenOrders('AAPL/USD')).rejects.toThrow(NotSupported);
    });

    it('fetchOrder — 미체결 목록에 있으면 open 이고 체결내역의 합계가 체결수량이다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_KR]: (body: Record<string, unknown>) => (body.ccls_clsf === '2'
                ? OPEN_ROWS
                : { Record1: [{ ordr_no: 'O2', stnd_is_no: 'A000660', trd_dl_ccd_nm: '현금매도', ordr_q: '4', tl_ccls_q: '1', nccls_q: '3', ccls_uprc: '120000' }] }),
        });

        const order = await newExchange().fetchOrder('O2', '000660/KRW');

        expect(order).toMatchObject({ id: 'O2', status: 'open', amount: 4, filled: 1, remaining: 3, average: 120000, cost: 120000 });
    });

    it('fetchOrder — 체결내역에만 있으면 closed 다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_KR]: (body: Record<string, unknown>) => (body.ccls_clsf === '2'
                ? {}
                : { Record1: [fill({ ordr_no: 'O5' }), fill({ ordr_no: '0000000000', stnd_is_no: ' ', trd_dl_ccd_nm: ' ', ordr_q: '0', tl_ccls_q: '2', ccls_uprc: '69900' })] }),
        });

        const order = await newExchange().fetchOrder('O5', '005930/KRW');

        expect(order).toMatchObject({ id: 'O5', status: 'closed', filled: 5, side: 'buy' });
        expect(order.cost).toBe(3 * 69800 + 2 * 69900);
    });

    it('fetchOrder — 일부 체결 뒤 나머지가 취소된 주문은 미체결 목록에 없어도 closed 가 아니라 canceled 다(fetchOrders 와 같다)', async () => {
        const header = fill({ ordr_no: 'O6', ordr_q: '3', tl_ccls_q: '1', nccls_q: '0' });
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_KR]: (body: Record<string, unknown>) => (body.ccls_clsf === '2' ? {} : { Record1: [header] }),
        });

        const order = await newExchange().fetchOrder('O6', '005930/KRW');

        expect(order).toMatchObject({ id: 'O6', status: 'canceled', amount: 3, filled: 1, remaining: 0 });
        expect((await newExchange().fetchOrders('005930/KRW')).find((o) => o.id === 'O6')?.status).toBe('canceled');
    });

    it('fetchOrder — 어디에도 없으면 OrderNotFound 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: {} });

        await expect(newExchange().fetchOrder('NOPE', '005930/KRW')).rejects.toThrow(OrderNotFound);
    });
});

describe('fetchMyTrades', () => {
    it('분할체결 — 식별자를 지운 연속 행이 앞 헤더에 귀속되고, 다른 주문은 섞이지 않는다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_KR]: { Record1: [
                fill({ ordr_no: '0040000001', ordr_q: '10', tl_ccls_q: '4', ccls_uprc: '12000' }),
                fill({ ordr_no: '0000000000', stnd_is_no: ' ', trd_dl_ccd_nm: ' ', ordr_q: '0', tl_ccls_q: '6', ccls_uprc: '12050' }),
                fill({ ordr_no: '0040000002', ordr_q: '6', tl_ccls_q: '6', ccls_uprc: '12100' }),
            ] },
        });

        const trades = await newExchange().fetchMyTrades('005930/KRW');

        expect(trades.map(t => [t.order, t.amount, t.price, t.cost, t.side])).toEqual([
            ['0040000001', 4, 12000, 48000, 'buy'],
            ['0040000001', 6, 12050, 72300, 'buy'],
            ['0040000002', 6, 12100, 72600, 'buy'],
        ]);
        expect(trades.map(t => t.symbol)).toEqual(['005930/KRW', '005930/KRW', '005930/KRW']);
    });

    it('단가가 0 인 체결은 버린다 — 체결가를 모르는 채 확정처럼 보이게 하지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: { Record1: [fill({ ccls_uprc: '0' })] } });

        expect(await newExchange().fetchMyTrades('005930/KRW')).toEqual([]);
    });

    it('since 가 있으면 그 시각의 한국 날짜부터 조회한다 — UTC 날짜를 쓰면 하루 전을 뒤진다', async () => {
        vi.setSystemTime(new Date('2026-02-13T03:00:00Z'));   // 02-13 12:00 KST
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: {} });

        // 2026-02-12 16:00Z = 02-13 01:00 KST
        await newExchange().fetchMyTrades('068270/KRW', new Date('2026-02-12T16:00:00Z').getTime());

        expect(trBody(mockFetch, KBSEC_TR.TRADES_KR).dataBody).toMatchObject({ ordr_dt: '20260213', is_cd: '068270', ccls_clsf: '1' });
    });

    it('★since 부터 오늘까지 평일마다 조회해 합친다 — since 하루만 보면 그 뒤 체결이 빠진다', async () => {
        vi.setSystemTime(new Date('2026-09-25T03:00:00Z'));   // 금 12:00 KST
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: {} });

        await newExchange().fetchMyTrades('005930/KRW', new Date('2026-09-21T01:00:00Z').getTime());   // 월

        const dates = mockFetch.mock.calls
            .filter((c) => String(c[0]).toLowerCase().includes(KBSEC_TR.TRADES_KR.toLowerCase()))
            .map((c) => JSON.parse((c[1] as { body: string }).body).dataBody.ordr_dt);
        expect(dates).toEqual(['20260921', '20260922', '20260923', '20260924', '20260925']);
    });

    it('since 부터 31일을 넘으면 요청 없이 BadRequest 다', async () => {
        vi.setSystemTime(new Date('2026-09-25T03:00:00Z'));
        await expect(newExchange().fetchMyTrades('005930/KRW', new Date('2026-08-01T00:00:00Z').getTime())).rejects.toBeInstanceOf(BadRequest);
    });

    it('params.date 를 주면 그 날짜를 조회하고 실패는 던진다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: '조회 실패' });

        await expect(newExchange().fetchMyTrades('005930/KRW', undefined, undefined, { date: '20260820' })).rejects.toThrow();
        expect(trBody(mockFetch, KBSEC_TR.TRADES_KR).dataBody.ordr_dt).toBe('20260820');
    });

    it('종목이 없으면 ArgumentsRequired 다', async () => {
        await expect(newExchange().fetchMyTrades()).rejects.toThrow(ArgumentsRequired);
    });

    it('limit 은 최근 체결부터 자른다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_KR]: { Record1: [fill({ ordr_no: 'A1' }), fill({ ordr_no: 'A2' }), fill({ ordr_no: 'A3' })] } });

        const trades = await newExchange().fetchMyTrades('005930/KRW', undefined, 2);

        expect(trades.map(t => t.order)).toEqual(['A2', 'A3']);
    });
});

describe('fetchBuyableAmount', () => {
    it('SSQM1802 의 주문가능현금(ordr_psbl_csh)을 읽는다 — 다른 TR 의 필드명(ordr_psbl_amt)이 아니다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.BUYABLE_KR]: { ordr_psbl_csh: '3500000', ordr_psbl_amt: '1' } });

        expect(await newExchange().fetchBuyableAmount('005930/KRW')).toBe(3_500_000);
        expect(trBody(mockFetch, KBSEC_TR.BUYABLE_KR).dataBody).toMatchObject({ is_no: '005930', bnd_mktio_ccd: '1' });
    });

    it('값이 없거나 0 이면 undefined 이고, 조회 실패는 던진다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.BUYABLE_KR]: { ordr_psbl_csh: '0' } });
        expect(await newExchange().fetchBuyableAmount()).toBeUndefined();

        routeTr(mockFetch, { [KBSEC_TR.BUYABLE_KR]: '조회 권한이 없습니다' });
        await expect(newExchange().fetchBuyableAmount()).rejects.toThrow();
    });
});
