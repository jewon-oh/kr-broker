/**
 * 실체결 확정 공용 폴러 — 브로커 무관 계약 고정.
 *
 * 어댑터는 `probe` 매핑만 제공하므로, 여기서 고정하는 동작(예산·종료판정·부분체결·조회실패
 * 내성)이 곧 **모든 거래소의 진입가 기록 계약**이다.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    confirmExecution,
    resolveConfirmBudget,
    fillDeviationBps,
    tradeListProbe,
    type ExecutionProbe,
} from '../execution-confirm';
import { logger } from '../logger';

/** 테스트는 대기 없이 — 예산 소진 경로도 즉시 끝난다. */
const FAST = { intervalMs: 0 };

/** probe 스텁 — 호출 순서대로 결과를 돌려주고, 마지막 값을 이후에도 반복한다. */
function probeSeq(seq: Array<ExecutionProbe | Error>) {
    let i = 0;
    const calls = { count: 0 };
    const probe = async (): Promise<ExecutionProbe> => {
        calls.count++;
        const v = seq[Math.min(i++, seq.length - 1)];
        if (v instanceof Error) throw v;
        return v;
    };
    return { probe, calls };
}

const pending: ExecutionProbe = { snapshot: null, terminal: false };
const filled = (qty: number, avg: number): ExecutionProbe => ({
    snapshot: { filled: qty, average: avg }, terminal: true,
});

describe('confirmExecution', () => {
    it('접수 직후 미체결이어도 체결이 잡힐 때까지 폴링', async () => {
        const { probe, calls } = probeSeq([pending, pending, filled(4, 114100)]);
        const r = await confirmExecution({ label: '[T]', orderId: 'o1', exchange: 'toss', probe, budget: FAST });
        expect(r).toEqual({ filled: 4, average: 114100 });
        expect(calls.count).toBe(3);
    });

    it('종료 상태면 남은 예산을 쓰지 않고 즉시 반환', async () => {
        const { probe, calls } = probeSeq([filled(4, 114100)]);
        await confirmExecution({ label: '[T]', orderId: 'o2', exchange: 'toss', probe, budget: FAST });
        expect(calls.count).toBe(1);
    });

    it('체결 없이 종료(취소·거부)면 null — 호출하는 쪽이 요청값으로 폴백', async () => {
        const { probe, calls } = probeSeq([{ snapshot: null, terminal: true }]);
        const r = await confirmExecution({ label: '[T]', orderId: 'o3', exchange: 'toss', probe, budget: FAST });
        expect(r).toBeNull();
        expect(calls.count).toBe(1);
    });

    it('부분체결에서 멈추지 않고 최종 체결분을 취한다', async () => {
        const { probe } = probeSeq([
            { snapshot: { filled: 1, average: 114000 }, terminal: false },
            { snapshot: { filled: 3, average: 114050 }, terminal: false },
            filled(4, 114100),
        ]);
        const r = await confirmExecution({ label: '[T]', orderId: 'o4', exchange: 'toss', probe, budget: FAST });
        expect(r?.filled).toBe(4);
    });

    it('예산 소진 시 그때까지 가장 많이 채워진 스냅샷을 반환', async () => {
        const { probe, calls } = probeSeq([
            { snapshot: { filled: 2, average: 114000 }, terminal: false },
        ]);
        const r = await confirmExecution({ label: '[T]', orderId: 'o5', exchange: 'toss', probe, budget: { attempts: 3, intervalMs: 0 } });
        expect(calls.count).toBe(3);
        expect(r?.filled).toBe(2);
    });

    it('조회가 throw 해도 폴링을 계속한다 (주문은 이미 접수 성공)', async () => {
        const { probe, calls } = probeSeq([new Error('network'), new Error('429'), filled(4, 114100)]);
        const r = await confirmExecution({ label: '[T]', orderId: 'o6', exchange: 'toss', probe, budget: FAST });
        expect(r?.filled).toBe(4);
        expect(calls.count).toBe(3);
    });

    it('끝까지 미체결이면 null — 절대 throw 하지 않는다', async () => {
        const { probe } = probeSeq([new Error('down')]);
        await expect(
            confirmExecution({ label: '[T]', orderId: 'o7', exchange: 'toss', probe, budget: { attempts: 2, intervalMs: 0 } }),
        ).resolves.toBeNull();
    });
});

describe('resolveConfirmBudget', () => {
    it('기본값', () => {
        expect(resolveConfirmBudget()).toEqual({ attempts: 6, intervalMs: 350 });
    });

    it('사용자 옵션이 증권사 기본값을 이기고, 증권사 기본값이 공용 기본값을 이긴다', () => {
        expect(resolveConfirmBudget({ attempts: 5, intervalMs: 1000 })).toEqual({ attempts: 5, intervalMs: 1000 });
        expect(resolveConfirmBudget({ attempts: 5, intervalMs: 1000 }, { intervalMs: 50 })).toEqual({ attempts: 5, intervalMs: 50 });
    });

    it('부분 지정 — 빠진 축은 아래 층의 값', () => {
        expect(resolveConfirmBudget({ attempts: 5 })).toEqual({ attempts: 5, intervalMs: 350 });
        expect(resolveConfirmBudget(undefined, { attempts: 2 })).toEqual({ attempts: 2, intervalMs: 350 });
    });

    it('범위 위반은 무시하고 아래 층의 값을 쓴다 (fail-open)', () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
        try {
            expect(resolveConfirmBudget({ attempts: 5, intervalMs: 1000 }, { attempts: 0, intervalMs: 20_000 }))
                .toEqual({ attempts: 5, intervalMs: 1000 });
            expect(resolveConfirmBudget(undefined, { attempts: 1.5 })).toEqual({ attempts: 6, intervalMs: 350 });
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('confirmExecution 이 defaults 의 시도 횟수를 쓰고 budget 이 그것을 이긴다', async () => {
        const first = probeSeq([{ snapshot: null, terminal: false }]);
        const r = await confirmExecution({
            label: '[t]', orderId: 'o', exchange: 'kbsec', probe: first.probe, defaults: { attempts: 2, intervalMs: 0 },
        });
        expect(r).toBeNull();
        expect(first.calls.count).toBe(2);

        const second = probeSeq([{ snapshot: null, terminal: false }]);
        await confirmExecution({
            label: '[t]', orderId: 'o', exchange: 'kbsec', probe: second.probe, defaults: { attempts: 2, intervalMs: 0 }, budget: { attempts: 4 },
        });
        expect(second.calls.count).toBe(4);
    });
});

describe('tradeListProbe — 체결내역만 주는 증권사(KIS·KB증권)', () => {
    it('주문 id 로 걸러 수량·금액을 합산하고 가중 단가를 낸다 (분할체결)', async () => {
        const probe = tradeListProbe({
            fetchTrades: async () => [
                { order: 'X', amount: 1, price: 100, cost: 100 },
                { order: 'X', amount: 3, price: 200, cost: 600 },
                { order: 'OTHER', amount: 99, price: 1, cost: 99 }, // 다른 주문 — 섞이면 안 됨
            ],
            orderId: 'X',
            requestedQty: 4,
        });
        const r = await probe();
        expect(r.snapshot).toMatchObject({ filled: 4, amount: 700, average: 175 });
        expect(r.terminal).toBe(true);
    });

    it('요청 수량 미달이면 terminal=false — 남은 예산 동안 더 지켜본다', async () => {
        const probe = tradeListProbe({
            fetchTrades: async () => [{ order: 'X', amount: 1, price: 100, cost: 100 }],
            orderId: 'X',
            requestedQty: 4,
        });
        expect((await probe()).terminal).toBe(false);
    });

    it('체결 행이 없으면 snapshot=null (아직 미체결)', async () => {
        const probe = tradeListProbe({
            fetchTrades: async () => [{ order: 'OTHER', amount: 5, price: 10, cost: 50 }],
            orderId: 'X',
            requestedQty: 4,
        });
        expect(await probe()).toEqual({ snapshot: null, terminal: false });
    });

    it('cost 가 없으면 수량×단가로 역산', async () => {
        const probe = tradeListProbe({
            fetchTrades: async () => [{ order: 'X', amount: 2, price: 50 }],
            orderId: 'X',
            requestedQty: 2,
        });
        expect((await probe()).snapshot).toMatchObject({ amount: 100, average: 50 });
    });

    it('수수료는 있는 행만 합산 — 전부 없으면 undefined(추정 금지)', async () => {
        const withFee = tradeListProbe({
            fetchTrades: async () => [
                { order: 'X', amount: 1, price: 100, cost: 100, fee: { cost: 0.5 } },
                { order: 'X', amount: 1, price: 100, cost: 100, fee: { cost: 0.3 } },
            ],
            orderId: 'X', requestedQty: 2, feeCurrency: 'KRW',
        });
        expect((await withFee()).snapshot).toMatchObject({ fee: 0.8, feeCurrency: 'KRW' });

        const noFee = tradeListProbe({
            fetchTrades: async () => [{ order: 'X', amount: 1, price: 100, cost: 100 }],
            orderId: 'X', requestedQty: 1,
        });
        expect((await noFee()).snapshot?.fee).toBeUndefined();
    });
});

describe('tradeListProbe — 행은 있는데 수량이 0 이면 무음이 아니다', () => {
    it('우리 주문의 행이 있는데 수량이 0 으로 읽히면 키 목록을 WARN 으로 남긴다(probe 당 1회)', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
        try {
            const probe = tradeListProbe({
                // KB증권 응답에서 필드 이름을 잘못 읽어 amount 가 0 으로 남던 사고를 재현한다. 원본 응답은 `info` 에 있다.
                fetchTrades: async () => [{ order: 'o1', amount: 0, price: 0, cost: 0, info: { ccls_q: '3', ord_no: 'o1' } }],
                orderId: 'o1', requestedQty: 3,
            });
            expect(await probe()).toEqual({ snapshot: null, terminal: false });
            expect(await probe()).toEqual({ snapshot: null, terminal: false });

            expect(warn).toHaveBeenCalledTimes(1);
            const [ctx, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
            expect(ctx.orderId).toBe('o1');
            expect(ctx.rowKeys).toEqual(expect.arrayContaining(['ccls_q', 'ord_no']));
            expect(String(msg)).toMatch(/필드명/);
        } finally {
            warn.mockRestore();
        }
    });

    it('행 자체가 없으면(아직 미체결) 경고하지 않는다', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
        try {
            const probe = tradeListProbe({ fetchTrades: async () => [], orderId: 'o1', requestedQty: 3 });
            expect(await probe()).toEqual({ snapshot: null, terminal: false });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe('fillDeviationBps', () => {
    it('호가 대비 체결 괴리를 bps 로', () => {
        expect(fillDeviationBps(114200, 114100)).toBe(-9); // 유리하게 체결
        expect(fillDeviationBps(100, 101)).toBe(100);
    });

    it('한쪽이라도 없거나 0 이하면 null', () => {
        expect(fillDeviationBps(undefined, 100)).toBeNull();
        expect(fillDeviationBps(100, undefined)).toBeNull();
        expect(fillDeviationBps(0, 100)).toBeNull();
    });
});
