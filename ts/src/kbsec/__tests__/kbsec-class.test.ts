/**
 * @fileoverview `kbsec` 클래스의 선언(`describe()`)과 요청 흐름(`sign`·`authenticate`·`handleErrors`).
 *
 * KB 는 조회도 `POST /api/v1/{trcode}` 이고 응답이 `{ dataHeader, dataBody }` 봉투다. 업무 오류가 HTTP 200 으로도, HTTP 500 으로도 온다.
 * 이 파일은 그 규격이 클래스의 각 자리에서 지켜지는지 본다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import {
    AccountNotEnabled, AuthenticationError, BadRequest, BadResponse, ExchangeError, ExchangeNotAvailable, InsufficientFunds,
    InvalidOrder, NotSupported, PermissionDenied,
} from '../../base/errors';
import { KBSEC_ERROR_DETAIL, KBSEC_PROCESS_CODES } from '../kbsec-error-codes';
import { KBSEC_ORDER_TR_CODES, KBSEC_TR } from '../kbsec-types';
import { KBSEC_TIMEFRAMES, kbsecChartParams } from '../kbsec-chart';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, bizError, envelope, jsonOk, routeTr, tokenOk, trBody, trHeaders } from './support/kbsec-fetch';

const newExchange = (config: Record<string, unknown> = {}) => new kbsec({ ...CREDS, rateLimit: 0, ...config });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('describe() — 선언', () => {
    const exchange = newExchange();

    it('이름·국가·버전', () => {
        expect(exchange.id).toBe('kbsec');
        expect(exchange.name).toBe('KB증권');
        expect(exchange.countries).toEqual(['KR']);
        expect(exchange.version).toBe('v1');
    });

    it('KB 전용 레이트리밋이다 — 기본값(50ms)이 아니라 초당 2~3회', () => {
        // 과거에는 이 증권사에 전용 값이 없어 다른 거래소의 기본값(초당 10회)이 조용히 적용됐다.
        expect(kbsec.prototype.describe.call(exchange).rateLimit).toBe(400);
        expect(new kbsec(CREDS).rateLimit).toBe(400);
    });

    it('조회 상한 20초, 주문 상한 25초 — 주문 상한이 호출하는 쪽의 바깥 상한(30초)보다 짧다', () => {
        expect(exchange.timeout).toBe(20_000);
        expect(exchange.orderTimeout).toBe(25_000);
    });

    it('자격증명: 앱키와 시크릿이 필수이고 uid(계좌 메모)는 선택이다', () => {
        expect(exchange.requiredCredentials).toMatchObject({ apiKey: true, secret: true, uid: false });
    });

    it('모의투자 서버가 없다 — setSandboxMode(true) 는 NotSupported 다', () => {
        expect(exchange.has.sandbox).toBe(false);
        expect(() => exchange.setSandboxMode(true)).toThrow(NotSupported);
    });

    it('has 표 — 지원하는 것과 지원하지 않는 것을 밝힌다', () => {
        expect(exchange.has).toMatchObject({
            spot: true, margin: false, swap: false, future: false, option: false,
            fetchTicker: true, fetchOrderBook: true, fetchOHLCV: true, fetchBalance: true,
            createOrder: true, editOrder: true, cancelOrder: true, cancelAllOrders: 'emulated',
            fetchOrder: true, fetchOpenOrders: true, fetchOrders: true, fetchClosedOrders: true, fetchMyTrades: true, fetchTradingFee: 'emulated',
            fetchMarketCalendar: true,
            fetchMarkets: false, fetchTickers: false, createConditionalOrder: false,
        });
    });

    it('지원하지 않는 메서드는 NotSupported 다', async () => {
        await expect(exchange.fetchTickers()).rejects.toThrow(NotSupported);
    });

    it('api 트리 — 모든 잎이 private.post 이고 주문 TR 만 order:true 다', () => {
        const leaves = (exchange.api as { private: { post: Record<string, { cost: number; order?: boolean }> } }).private.post;
        for (const [path, config] of Object.entries(leaves)) {
            expect(path).toBe(path.toLowerCase()); // 경로는 소문자다(`/api/v1/ssqm0004`)
            expect(config.order === true, `${path} 의 order 표시`).toBe(KBSEC_ORDER_TR_CODES.has(path.toUpperCase()));
        }
        // 주문 TR 은 하나도 빠지지 않고 표에 있다
        for (const code of ['SSAM1801', 'SSAM1802', 'SSAM1805', 'SSAM1806', 'SSAM5762', 'SSAM5763', 'SKAM2101', 'SKAM2102']) {
            expect(leaves[code.toLowerCase()]?.order, code).toBe(true);
        }
    });

    it('암묵 메서드가 만들어진다 — privatePostSsqm0004 식이다', () => {
        for (const method of ['privatePostSsqm0004', 'privatePostSsam1802', 'privatePostSzqm0771', 'privatePostSpqm2226'] as const) {
            expect(typeof exchange[method], method).toBe('function');
        }
    });

    it('timeframes 표의 모든 키를 통합차트 파라미터로 옮길 수 있다', () => {
        for (const timeframe of Object.keys(KBSEC_TIMEFRAMES)) {
            expect(() => kbsecChartParams(timeframe), timeframe).not.toThrow();
        }
    });

    it('timeframe 은 알 수 없는 값을 일봉으로 바꾸지 않는다 — 월봉 `1M` 도 분봉으로 오독하지 않는다', () => {
        expect(kbsecChartParams('1M')).toEqual({ chrt_clsf: 'M', minute: '' });
        expect(kbsecChartParams('1m')).toEqual({ chrt_clsf: 'B', minute: '1' });
        expect(() => kbsecChartParams('7x')).toThrow(NotSupported);
    });
});

describe('market() — 심볼 모양으로 종목을 만든다', () => {
    const exchange = newExchange();

    it('국내 — 005930/KRW 와 005930 모두 같은 종목이다', () => {
        for (const symbol of ['005930/KRW', '005930']) {
            const market = exchange.market(symbol);
            expect(market).toMatchObject({
                id: '005930', symbol: '005930/KRW', base: '005930', quote: 'KRW', type: 'spot', spot: true,
                margin: false, swap: false, future: false, option: false, contract: false, active: true,
            });
            expect(market.info).toEqual({ country: 'KR' });
        }
    });

    it('미국 — AAPL/USD', () => {
        expect(exchange.market('AAPL/USD')).toMatchObject({ id: 'AAPL', symbol: 'AAPL/USD', quote: 'USD' });
        expect(exchange.market('aapl').symbol).toBe('AAPL/USD');
        expect(exchange.market('BRK.B/USD').id).toBe('BRK.B');
        // 클래스 주식의 슬래시 표기도 같은 종목이다. 첫 슬래시에서 잘라 BRK 로 만들지 않는다.
        expect(exchange.market('BRK/B')).toMatchObject({ id: 'BRK.B', symbol: 'BRK.B/USD' });
        expect(exchange.market('BRK/B/USD').id).toBe('BRK.B');
    });

    it('심볼이 없으면 ArgumentsRequired, 읽을 수 없으면 BadSymbol 이다', () => {
        expect(() => exchange.market(undefined)).toThrow(/symbol/);
        expect(() => exchange.market('/USD')).toThrow(/does not have market symbol/);
    });

    it('종목을 내려받지 않는다 — loadMarkets 는 아무 요청도 보내지 않는다', async () => {
        await exchange.loadMarkets();
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('요청 규격 — 봉투·경로·헤더', () => {
    it('POST /api/v1/{trcode}, appKey 헤더, 소문자 bearer, dataHeader 에 호스트 주소', async () => {
        routeTr(mockFetch, { SSQM0004: { ordr_psbl_csh: '100' } });

        await newExchange().privatePostSsqm0004({});

        const call = mockFetch.mock.calls.find(c => String(c[0]).includes('/api/v1/'))!;
        expect(String(call[0])).toBe('https://developer.kbsec.com:32484/api/v1/ssqm0004');
        expect((call[1] as { method: string }).method).toBe('POST');
        const headers = trHeaders(mockFetch, 'SSQM0004');
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers.appKey).toBe(CREDS.apiKey);
        // 소문자 `bearer` — 대문자로 보내면 거부되는 사례가 보고돼 공식 예제를 그대로 따른다.
        expect(headers.Authorization).toBe('bearer kb-token-1');
        const { dataHeader } = trBody(mockFetch, 'SSQM0004');
        expect(dataHeader.ipAddr).toBeTruthy(); // 빈 값이면 KB 가 TR 을 거부한다
        expect(dataHeader.macAddr).toBeTruthy();
    });

    it('부분 본문은 거부되므로 스펙의 입력 필드를 전부 채워 보낸다', async () => {
        routeTr(mockFetch, { SSQM1801: {} });

        await newExchange().privatePostSsqm1801({ inq_clsf: '1' });

        expect(Object.keys(trBody(mockFetch, 'SSQM1801').dataBody)).toEqual(
            ['inq_clsf', 'is_no', 'mkt_tm_ccd', 'spclz_ordr_ccd', 'act_cd', 'nxt_key'],
        );
    });

    it('토큰은 한 번 받아 재사용한다', async () => {
        routeTr(mockFetch, {});
        const exchange = newExchange();

        await exchange.privatePostSsqm0004({});
        await exchange.privatePostSsqm0004({});

        expect(mockFetch.mock.calls.filter(c => String(c[0]).includes('/oauth2/token'))).toHaveLength(1);
    });

    it('자격증명이 없으면 요청을 보내지 않고 AuthenticationError 다', async () => {
        await expect(new kbsec({ rateLimit: 0 }).privatePostSsqm0004({})).rejects.toThrow(AuthenticationError);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('handleErrors — HTTP 200 함정', () => {
    const call = (): Promise<unknown> => newExchange().privatePostSsqm0004({});

    it('HTTP 200 인데 processFlag B 면 던진다 — resultCode 가 200/성공이어도', async () => {
        routeTr(mockFetch, { SSQM0004: '주문가능금액이 부족합니다' });

        const error = await call().then(() => null, (e: unknown) => e);

        expect(error).toBeInstanceOf(ExchangeError);
        // 메시지는 TR 코드·문구·processCode 를 모두 싣는다(호출하는 쪽이 진단할 수 있어야 한다)
        expect((error as Error).message).toBe('KB증권 업무 오류 (SSQM0004): 주문가능금액이 부족합니다 [processCode=9999]');
    });

    it('빈 결과(1861·2149)는 오류가 아니다 — 플래그가 B 로 와도 정상 응답이다', async () => {
        for (const code of ['1861', '2149']) {
            mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/token')
                ? tokenOk()
                : envelope({ processFlag: 'B', processCode: code, processMessage: '조회할 자료가 없습니다.' }, {})));
            await expect(call()).resolves.toMatchObject({ dataBody: {} });
        }
    });

    it('표에 없는 코드는 추측하지 않는다 — 클래스 ExchangeError 이고 detail 이 비어 있다. 원래 코드는 brokerCode 에 있다', async () => {
        routeTr(mockFetch, { SSQM0004: '알 수 없는 거절' });

        const error = await call().then(() => null, (e: unknown) => e) as ExchangeError;

        expect(Object.getPrototypeOf(error)).toBe(ExchangeError.prototype);
        expect(error.detail).toBeUndefined();
        expect(error.brokerCode).toBe('9999');
    });

    it('봉투 없는 HTTP 401 은 토큰 실패(detail TOKEN_INVALID)이고, 증권사 코드가 없으니 brokerCode 도 없다', () => {
        let error: unknown;
        try {
            newExchange().handleErrors(401, 'Unauthorized', 'https://openapi.kbsec.com/api/v1/ssqm0004', 'POST', {}, '', undefined);
        } catch (e) {
            error = e;
        }

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).detail).toBe(KBSEC_ERROR_DETAIL.TOKEN_INVALID);
        expect((error as AuthenticationError).brokerCode).toBeUndefined();
    });

    it('플래그가 없으면 판정할 수 없으므로 오류로 보지 않는다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/token')
            ? tokenOk()
            : envelope({}, { o_msg: 'ok' })));
        await expect(call()).resolves.toMatchObject({ dataBody: { o_msg: 'ok' } });
    });

    it('HTTP 500 이어도 봉투가 있으면 봉투가 정본이다 — 업무 오류 클래스로 올라온다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/token')
            ? tokenOk()
            : envelope({ processFlag: 'B', processCode: 'I446', processMessage: 'API 사용 권한이 없습니다.' }, {}, 500)));

        await expect(call()).rejects.toThrow(PermissionDenied);
    });

    it('봉투가 없는 비-2xx 는 HTTP 상태 표가 받는다 — 응답 원문이 메시지에 실린다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/token')
            ? tokenOk()
            : { ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '<html>bad gateway</html>' }));

        const error = await call().then(() => null, (e: unknown) => e);

        expect(error).toBeInstanceOf(ExchangeNotAvailable);
        expect((error as Error).message).toContain('bad gateway');
    });

    it('2xx 인데 JSON 이 아니면 BadResponse 다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/token')
            ? tokenOk()
            : { ok: true, status: 200, text: async () => '<html>점검 중</html>' }));

        await expect(call()).rejects.toThrow(BadResponse);
    });
});

describe('processCode 표 — 코드가 오류 클래스와 detail 로 옮겨지고, 원래 코드는 brokerCode 에 남는다', () => {
    const cases: Array<[string, new (m: string) => Error, string | undefined]> = [
        ['I446', PermissionDenied, undefined],
        ['E021', AuthenticationError, undefined],
        ['1951', InsufficientFunds, KBSEC_ERROR_DETAIL.INSUFFICIENT_POSITION],
        ['1896', InvalidOrder, KBSEC_ERROR_DETAIL.PRICE_INVALID],
        ['2329', InvalidOrder, KBSEC_ERROR_DETAIL.QUANTITY_INVALID],
        ['G474', InvalidOrder, KBSEC_ERROR_DETAIL.ORDER_TYPE_NOT_ALLOWED],
        ['3576', BadRequest, undefined],
        ['8654', BadRequest, undefined],
        ['H049', AccountNotEnabled, undefined],
        ['L545', ExchangeError, KBSEC_ERROR_DETAIL.NXT_INELIGIBLE],
        ['2854', ExchangeError, KBSEC_ERROR_DETAIL.FUTURE_QUERY_DATE],
    ];

    it.each(cases)('%s', async (code, ErrorClass, detail) => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/token')
            ? tokenOk()
            : bizError('실측 문구', code)));

        const error = await newExchange().privatePostSsam1802({}).then(() => null, (e: unknown) => e) as ExchangeError;

        expect(error).toBeInstanceOf(ErrorClass);
        expect(error.detail).toBe(detail);
        expect(error.brokerCode).toBe(code);
    });

    it('표의 코드는 빈 결과 코드(1861·2149)를 담지 않는다 — 던져지지 않는 항목은 죽은 항목이다', () => {
        expect(Object.keys(KBSEC_PROCESS_CODES)).not.toContain('1861');
        expect(Object.keys(KBSEC_PROCESS_CODES)).not.toContain('2149');
    });
});

describe('TR 상수', () => {
    it('이 클래스가 부르는 TR 은 전부 api 트리에 있다', () => {
        const leaves = Object.keys((newExchange().api as { private: { post: Record<string, unknown> } }).private.post);
        for (const code of [KBSEC_TR.DEPOSIT, KBSEC_TR.HOLDINGS, KBSEC_TR.ASSET_EVAL, KBSEC_TR.HOLDINGS_US, KBSEC_TR.TRADES_KR, KBSEC_TR.ORDERS_US,
            KBSEC_TR.MARKET_STATUS, KBSEC_TR.SETTLEMENT_KR, KBSEC_TR.SETTLEMENT_US]) {
            expect(leaves, code).toContain(code.toLowerCase());
        }
    });

    it('jsonOk 헬퍼 자체 — 성공 응답의 모양', async () => {
        expect(JSON.parse(await jsonOk({ a: 1 }).text())).toEqual({
            dataHeader: { processFlag: 'A', processCode: '0011', processMessage: '정상적으로 조회되었습니다.' },
            dataBody: { a: 1 },
        });
    });
});
