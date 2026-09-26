/**
 * @fileoverview 세 증권사 클래스(`kis`·`toss`·`kbsec`)가 **같은 요청 시간 상한 계약**을 지키는지
 *
 * 이 스위트의 요점은 "시간 상한이 있다"가 아니라 **셋이 같은 계약을 쓴다**는 것이다. 같은 값을 세 곳에 두면 서로 어긋난다. 그래서 세 클래스에
 * 같은 방식으로 요청을 걸고, 조회는 `RequestTimeout` 으로, 주문은 `OrderOutcomeUnknown` 으로 끝나는지 같은 단언으로 확인한다.
 *
 * - 조회가 응답 없이 멈추면 상한(20초)에서 요청을 끊고 `RequestTimeout` 이다. 시간 초과는 다시 보내지 않는다.
 * - 주문이 응답 없이 멈추면 상한(25초)에서 요청을 끊되 `OrderOutcomeUnknown` 이다. 접수됐을 수 있고 다시 보내면 중복 주문이다.
 * - 토큰 발급도 상한을 받는다. 여기서 멈추면 그 뒤의 모든 요청이 같이 멈추기 때문이다.
 *
 * 증권사별 세부 계약(KB 는 TR 코드로 조회와 주문을 가르고 KIS 는 GET·POST 로 가른다)은 각 증권사의 시간 상한 테스트가 따로 본다.
 * 이 파일은 그 세부가 아니라 세 클래스가 공유하는 바깥 동작만 본다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../kbsec';
import { kis } from '../kis';
import { toss } from '../toss';
import { OrderOutcomeUnknown, RequestTimeout, type Exchange } from '../base';
import { __resetKbsecTokenBreaker } from '../testing';

// 메서드 문법이라 각 증권사 칸이 자기 클래스를 인자로 받아도 된다(암묵 메서드는 증권사 클래스에만 있다).
interface BrokerCase {
    name: string;
    make(): Exchange;
    /** 조회 요청 하나. */
    read(exchange: Exchange): Promise<unknown>;
    /** 주문 요청 하나. */
    order(exchange: Exchange): Promise<unknown>;
}

const CASES: BrokerCase[] = [
    {
        name: 'kis',
        make: () => new kis({ apiKey: 'kis-app-key-123456', secret: 'kis-secret', uid: '12345678-01', enableRateLimit: false }),
        read: (x: kis) => x.privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'FHKST01010100' }),
        order: (x: kis) => x.privatePostUapiDomesticStockV1TradingOrderCash({ tr_id: 'TTTC0802U' }),
    },
    {
        name: 'toss',
        make: () => new toss({ apiKey: 'toss-client-id-123456', secret: 'toss-secret', uid: 'ACC-001', enableRateLimit: false }),
        read: (x: toss) => x.privateMarketGetPrices({ symbols: '005930' }),
        order: (x: toss) => x.privateAccountPostOrders({ symbol: '005930' }),
    },
    {
        name: 'kbsec',
        make: () => new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', enableRateLimit: false }),
        read: (x: kbsec) => x.privatePostSsqm1801({}),
        order: (x: kbsec) => x.privatePostSsam1802({}),
    },
];

/** 토큰 응답. 증권사마다 본문을 읽는 방식이 달라 세 모양을 한 본문에 모두 담는다. */
function tokenResponse() {
    const token = { access_token: 'TOKEN', token_type: 'Bearer', expires_in: 86400 };
    const text = JSON.stringify({ ...token, dataHeader: { processFlag: 'A', processCode: '0000' }, dataBody: token });
    return { ok: true, status: 200, statusText: '', headers: new Headers(), text: async () => text, json: async () => JSON.parse(text) };
}

/** 응답이 영영 안 오는 요청. 끊기면 그 요청의 신호가 `aborted` 가 된다. */
const hangingSignals: AbortSignal[] = [];
function hangForever(_url: unknown, init?: { signal?: AbortSignal }) {
    if (init?.signal) hangingSignals.push(init.signal);
    return new Promise<never>(() => { /* 응답이 오지 않는다 */ });
}

/** 토큰 발급은 정상 응답하고, 그 밖의 요청은 전부 응답 없이 멈춘다. */
function arrangeHangAfterToken(): void {
    mockFetch.mockImplementation(async (url: string, init?: { signal?: AbortSignal }) => (
        String(url).includes('/oauth2/') ? tokenResponse() : hangForever(url, init)
    ));
}

/** 상한까지 시간을 밀고 그때까지의 결과를 받는다. 아직 끝나지 않았으면 `pending` 이다. */
async function advanceTo(ms: number, promise: Promise<unknown>): Promise<{ state: 'pending' | 'ok' | 'failed'; error?: unknown }> {
    const settled = promise.then(
        () => ({ state: 'ok' as const }),
        (error: unknown) => ({ state: 'failed' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return Promise.race([settled, Promise.resolve({ state: 'pending' as const })]);
}

beforeEach(() => {
    mockFetch.mockReset();
    hangingSignals.length = 0;
    __resetKbsecTokenBreaker();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('상한 값 — 세 클래스가 같은 값을 쓴다', () => {
    it('조회 상한과 주문 상한이 같고, 주문 상한이 조회 상한보다 길다', () => {
        const [reference, ...others] = CASES.map(({ make }) => make());

        for (const exchange of others) {
            expect(exchange.timeout, `${exchange.id}.timeout`).toBe(reference!.timeout);
            expect(exchange.orderTimeout, `${exchange.id}.orderTimeout`).toBe(reference!.orderTimeout);
        }
        expect(reference!.orderTimeout).toBeGreaterThan(reference!.timeout);
    });
});

describe.each(CASES)('$name', ({ make, read, order }) => {
    it('조회가 응답 없이 멈추면 조회 상한에서 요청을 끊고 RequestTimeout 이다. 다시 보내지 않는다', async () => {
        arrangeHangAfterToken();
        const exchange = make();

        const result = await advanceTo(exchange.timeout, read(exchange));

        expect(result.state).toBe('failed');
        expect(result.error).toBeInstanceOf(RequestTimeout);
        expect(result.error).not.toBeInstanceOf(OrderOutcomeUnknown);
        expect(hangingSignals).toHaveLength(1); // 시간 초과 뒤에 같은 요청을 되풀이하지 않았다
        expect(hangingSignals[0]!.aborted).toBe(true);
    });

    it('주문이 응답 없이 멈추면 주문 상한에서 요청을 끊고 OrderOutcomeUnknown 이다. 다시 보내지 않는다', async () => {
        arrangeHangAfterToken();
        const exchange = make();

        const result = await advanceTo(exchange.orderTimeout as number, order(exchange));

        expect(result.state).toBe('failed');
        expect(result.error).toBeInstanceOf(OrderOutcomeUnknown);
        expect((result.error as OrderOutcomeUnknown).retryable).toBe(false);
        expect(hangingSignals).toHaveLength(1);
        expect(hangingSignals[0]!.aborted).toBe(true);
    });

    it('주문은 조회 상한에서는 끊기지 않는다. 주문 상한이 더 길다', async () => {
        arrangeHangAfterToken();
        const exchange = make();
        const pending = order(exchange);
        const settled = pending.then(() => 'done', () => 'failed');

        await vi.advanceTimersByTimeAsync(exchange.timeout + 1000);
        expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending');

        await vi.advanceTimersByTimeAsync((exchange.orderTimeout as number) - exchange.timeout);
        expect(await settled).toBe('failed');
    });

    it('토큰 발급이 응답 없이 멈춰도 그 뒤 호출이 끝없이 멈추지 않고 조회 상한 안에 실패한다', async () => {
        // 첫 요청부터 응답 없이 멈춘다. 토큰 발급 자체가 돌아오지 않는 경우다.
        mockFetch.mockImplementation(hangForever);
        const exchange = make();

        const result = await advanceTo(exchange.timeout, read(exchange));

        expect(result.state).toBe('failed');
        expect(hangingSignals[0]?.aborted).toBe(true);
        // 토큰 요청만 나갔고 데이터 요청은 나가지 않았다.
        expect(mockFetch.mock.calls.every(([url]) => String(url).includes('/oauth2/'))).toBe(true);
    });
});
