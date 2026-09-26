/**
 * @fileoverview KB증권 요청 시간 상한 — **TR 코드로 조회와 주문의 계약이 갈린다.**
 *
 * KB 는 조회도 `POST /api/v1/{trcode}` 라 HTTP 메서드로 주문을 가를 수 없다. `describe().api` 의 `order` 표시(엔드포인트 표에서 오고, 주문 TR 목록과 같다)가 그 구분이다.
 *
 * - 조회가 응답 없이 멈추면 상한에서 요청을 끊고 `RequestTimeout` 이다. 다음 사이클이 다시 부르면 된다.
 * - 주문이 응답 없이 멈추면 요청을 끊되 `OrderOutcomeUnknown` 이다. 접수됐을 수 있고 다시 보내면 중복 주문이므로 실패로 넘기지 않는다.
 * - 토큰 발급도 상한을 받는다. 여기서 멈추면 그 뒤의 모든 TR 이 같이 멈춘다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { OrderOutcomeUnknown, RequestTimeout } from '../../base/errors';
import { __resetKbsecTokenBreaker } from '../../testing';

const READ_TIMEOUT_MS = 20_000;
const ORDER_TIMEOUT_MS = 25_000;

const tokenResponse = () => {
    const text = JSON.stringify({ dataHeader: { processFlag: 'A', processCode: '0000' }, dataBody: { access_token: 'TOKEN', token_type: 'Bearer', expires_in: 86400 } });
    return { ok: true, status: 200, text: async () => text };
};

/** 응답이 영영 안 오는 요청. 상한이 없던 시절 실제로 17분 동안 응답 없이 멈춘 프로브가 있었다. */
const hangingSignals: AbortSignal[] = [];
function hangForever(_url: unknown, init?: { signal?: AbortSignal }) {
    if (init?.signal) hangingSignals.push(init.signal);
    return new Promise<never>(() => { /* 응답이 오지 않는다 */ });
}

/** 토큰은 한 번 정상 응답하고, 그 뒤 요청은 전부 응답 없이 멈춘다. */
function arrangeHangAfterToken(): void {
    mockFetch.mockImplementationOnce(async () => tokenResponse());
    mockFetch.mockImplementation(hangForever);
}

/** 상한까지 시간을 밀고 결과를 받는다. */
async function advanceTo(ms: number, promise: Promise<unknown>): Promise<{ ok: boolean; value?: unknown; error?: unknown }> {
    const settled = promise.then(
        value => ({ ok: true as const, value }),
        error => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
}

const newExchange = () => new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    hangingSignals.length = 0;
    __resetKbsecTokenBreaker();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('KB증권 — TR 코드로 계약이 갈린다', () => {
    it('조회 TR 이 응답 없이 멈추면 상한에서 요청을 끊고 RequestTimeout 이다', async () => {
        arrangeHangAfterToken();

        const result = await advanceTo(READ_TIMEOUT_MS, newExchange().privatePostSsqm1801({}));

        expect(result.ok).toBe(false);
        expect(result.error).toBeInstanceOf(RequestTimeout);
        expect(result.error).not.toBeInstanceOf(OrderOutcomeUnknown);
        expect(hangingSignals.at(-1)?.aborted).toBe(true);
    });

    it('주문 TR 이 응답 없이 멈추면 OrderOutcomeUnknown 이다 — 실패로 넘기면 안 된다', async () => {
        arrangeHangAfterToken();

        const result = await advanceTo(ORDER_TIMEOUT_MS, newExchange().privatePostSsam1802({}));

        expect(result.ok).toBe(false);
        expect(result.error).toBeInstanceOf(OrderOutcomeUnknown);
        expect((result.error as OrderOutcomeUnknown).retryable).toBe(false);
        expect(hangingSignals.at(-1)?.aborted).toBe(true);
    });

    it('주문은 조회 상한(20초)에서는 끊지 않는다 — 주문 상한은 25초다', async () => {
        arrangeHangAfterToken();
        const pending = newExchange().privatePostSsam1802({});
        const settled = pending.then(() => 'done', () => 'failed');

        await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1000);
        const state = await Promise.race([settled, Promise.resolve('pending')]);
        expect(state).toBe('pending');

        await vi.advanceTimersByTimeAsync(ORDER_TIMEOUT_MS - READ_TIMEOUT_MS);
        expect(await settled).toBe('failed');
    });
});

describe('토큰 발급도 상한을 받는다', () => {
    it('토큰 발급이 응답 없이 멈춰도 그 뒤 호출 전체가 멈추지 않고 상한에서 끝난다', async () => {
        // 첫 요청부터 응답 없이 멈춘다. 토큰 발급 자체가 돌아오지 않는 경우다.
        mockFetch.mockImplementation(hangForever);

        // 토큰 상한(10초)이 조회 상한(20초)보다 짧다. 본문 형태를 둘 시도하므로 20초 안에 두 번 끊기고 호출이 실패로 끝난다.
        const result = await advanceTo(READ_TIMEOUT_MS, newExchange().privatePostSsqm1801({}));

        expect(result.ok).toBe(false);
        expect(hangingSignals[0]?.aborted).toBe(true);
    });
});
