/**
 * 확장세션 시장가 → 지정가 전환은 toss 와 KIS 어댑터가 같은 로직을 쓴다.
 *
 * 종전에는 같은 상황에서 두 어댑터가 반대 결론을 냈다:
 * toss → 지정가로 **전환** (막으면 확장세션에서 청산이 불가능하기 때문이다)
 * kis → **거부**
 *
 * 그 결과 KIS 계좌만 청산이 안 되는 것처럼 보였다. 로직을 공용으로 올리고 KIS 도 전환으로
 * 통일했다. toss 구현을 **그대로** 옮겼다. 실거래 경로라 동작이 바뀌지 않는 것이 추출의 조건이다.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildExtendedSessionLimit } from '../extended-session-limit';

const params = { symbol: 'AAPL/USD', side: 'buy' };

function svc(over: Partial<{
    open: Array<{ id: string; side?: string }>;
    openThrows: boolean;
    ticker: { last: number } | null | Error;
}> = {}) {
    return {
        fetchOpenOrders: over.openThrows
            ? vi.fn().mockRejectedValue(new Error('boom'))
            : vi.fn().mockResolvedValue(over.open ?? []),
        // 시세 조회 실패(던짐)와 시세 없음(`last` 가 비어 있음)은 같은 결과다.
        fetchTicker: over.ticker instanceof Error
            ? vi.fn().mockRejectedValue(over.ticker)
            : vi.fn().mockResolvedValue(over.ticker === undefined ? { last: 231.5 } : (over.ticker ?? { last: undefined })),
    };
}

describe('확장세션 지정가 산출', () => {
    it('미체결이 없고 시세가 있으면 last 를 지정가로 준다', async () => {
        const r = await buildExtendedSessionLimit(svc(), params, '[T]');
        expect(r.price).toBe(231.5);
        expect(r.error).toBeUndefined();
    });

    it('같은 방향 미체결이 있으면 재발주하지 않는다 — 호가가 쌓인다', async () => {
        const r = await buildExtendedSessionLimit(
            svc({ open: [{ id: 'O1', side: 'BUY' }] }), params, '[T]');
        expect(r.price).toBeUndefined();
        expect(r.error).toContain('중복 발주');
    });

    it('반대 방향 미체결은 막지 않는다', async () => {
        const r = await buildExtendedSessionLimit(
            svc({ open: [{ id: 'O1', side: 'sell' }] }), params, '[T]');
        expect(r.price).toBe(231.5);
    });

    it('미체결 조회가 실패하면 **발주하지 않는다** — 중복 누적이 미발주보다 나쁘다', async () => {
        const warn = vi.fn();
        const r = await buildExtendedSessionLimit(svc({ openThrows: true }), params, '[T]', warn);
        expect(r.price).toBeUndefined();
        expect(r.error).toContain('조회 실패');
        expect(warn).toHaveBeenCalled();
    });

    it('기준가를 못 구하면 지정가를 지어내지 않는다', async () => {
        const r = await buildExtendedSessionLimit(svc({ ticker: null }), params, '[T]');
        expect(r.price).toBeUndefined();
        expect(r.error).toContain('기준가');
    });

    it('시세 조회가 던져도 기준가가 없는 것과 같다 — 지정가를 지어내지 않는다', async () => {
        const r = await buildExtendedSessionLimit(svc({ ticker: new Error('boom') }), params, '[T]');
        expect(r.price).toBeUndefined();
        expect(r.error).toContain('기준가');
    });

    it('last 가 0 이하면 실패로 본다 — 0원 지정가는 전량 거부된다', async () => {
        const r = await buildExtendedSessionLimit(svc({ ticker: { last: 0 } }), params, '[T]');
        expect(r.price).toBeUndefined();
        expect(r.error).toContain('기준가');
    });
});

describe('onDuplicate — 낡은 미체결을 바꾸는 선택 동작', () => {
    it('같은 방향 미체결이 있으면 건너뛰는 대신 훅이 정한다 — 훅은 미체결 목록과 현재 기준가를 받는다', async () => {
        const hook = vi.fn().mockResolvedValue({ price: 231.5, replaced: { orderId: 'O1', action: 'canceled' } });
        const open = [{ id: 'O1', side: 'BUY', price: 230, amount: 3, remaining: 3 }, { id: 'O2', side: 'sell' }];

        const r = await buildExtendedSessionLimit(svc({ open }), params, '[T]', undefined, hook);

        expect(hook).toHaveBeenCalledWith({ open: [open[0]], price: 231.5 });
        expect(r).toEqual({ price: 231.5, replaced: { orderId: 'O1', action: 'canceled' } });
    });

    it('훅이 보류 사유를 돌려주면 그대로 전한다', async () => {
        const hook = vi.fn().mockResolvedValue({ error: '보류' });

        const r = await buildExtendedSessionLimit(svc({ open: [{ id: 'O1', side: 'buy' }] }), params, '[T]', undefined, hook);

        expect(r).toEqual({ error: '보류' });
    });

    it('같은 방향 미체결이 없으면 훅을 부르지 않고 종전처럼 기준가를 준다', async () => {
        const hook = vi.fn();

        const r = await buildExtendedSessionLimit(svc({ open: [{ id: 'O1', side: 'sell' }] }), params, '[T]', undefined, hook);

        expect(hook).not.toHaveBeenCalled();
        expect(r).toEqual({ price: 231.5 });
    });

    it('기준가를 못 구하면 훅을 부르지 않는다 — 바꿀 가격이 없다', async () => {
        const hook = vi.fn();

        const r = await buildExtendedSessionLimit(svc({ open: [{ id: 'O1', side: 'buy' }], ticker: null }), params, '[T]', undefined, hook);

        expect(hook).not.toHaveBeenCalled();
        expect(r.error).toContain('기준가');
    });

    it('미체결 조회가 실패하면 훅이 있어도 보류한다', async () => {
        const hook = vi.fn();

        const r = await buildExtendedSessionLimit(svc({ openThrows: true }), params, '[T]', vi.fn(), hook);

        expect(hook).not.toHaveBeenCalled();
        expect(r.error).toContain('조회 실패');
    });

    it('★훅을 주지 않으면 종전 동작이다 — 건너뛰고 시세도 조회하지 않는다', async () => {
        const source = svc({ open: [{ id: 'O1', side: 'buy' }] });

        const r = await buildExtendedSessionLimit(source, params, '[T]');

        expect(r.error).toContain('중복 발주 스킵');
        expect(source.fetchTicker).not.toHaveBeenCalled();
    });
});
