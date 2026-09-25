/**
 * `KisPriceWs`: 구독 갱신의 해지 프레임, 구독 거부 알림, 콜백 예외, 연결 준비 중의 `stop()`과 옛 소켓 정리.
 * `globalThis.WebSocket` 에 가짜 생성자를 넣어 실제 리스너 등록 경로를 그대로 돌린다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger } from '../../logger';
import { KisPriceWs, type KisPriceWsOptions } from '../kis-price-ws';
import { newKis } from './support/kis-test-utils';

type FakeListener = (ev: Record<string, unknown>) => void;

class FakeWs {
    static instances: FakeWs[] = [];
    readyState = 1;
    readonly sent: string[] = [];
    closeCallCount = 0;
    private readonly listeners = new Map<string, FakeListener[]>();

    constructor(public readonly url: string) {
        FakeWs.instances.push(this);
    }

    addEventListener(type: string, cb: FakeListener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
    }

    send(data: string): void { this.sent.push(data); }
    close(): void { this.closeCallCount++; this.readyState = 3; }

    emit(type: string, ev: Record<string, unknown> = {}): void {
        for (const cb of this.listeners.get(type) ?? []) cb(ev);
    }

    frames(): Array<[string, string, string]> {
        return this.sent.map((s) => JSON.parse(s) as { header: { tr_type: string }; body: { input: { tr_id: string; tr_key: string } } })
            .map((f) => [f.header.tr_type, f.body.input.tr_id, f.body.input.tr_key]);
    }
}

type GlobalWithWs = { WebSocket?: unknown };
const g = globalThis as GlobalWithWs;
const originalWebSocket = g.WebSocket;

beforeEach(() => {
    FakeWs.instances = [];
    g.WebSocket = FakeWs as unknown as typeof WebSocket;
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
    if (originalWebSocket === undefined) delete g.WebSocket;
    else g.WebSocket = originalWebSocket;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const newWs = (overrides: Partial<KisPriceWsOptions> = {}) => new KisPriceWs({ getApprovalKey: async () => 'ak', isVirtual: true, ...overrides });

describe('KisPriceWs 구독', () => {
    it('updateSubs 는 빠진 구독을 해지(tr_type 2)하고 새 구독만 등록한다', async () => {
        const kws = newWs();
        kws.start([{ trId: 'H0STCNT0', trKey: '005930' }, { trId: 'H0STCNT0', trKey: '000660' }]);
        await flush();
        const ws = FakeWs.instances[0]!;
        ws.emit('open');

        kws.updateSubs([{ trId: 'H0STCNT0', trKey: '000660' }, { trId: 'H0STASP0', trKey: '000660' }]);

        expect(ws.frames()).toEqual([
            ['1', 'H0STCNT0', '005930'], ['1', 'H0STCNT0', '000660'],
            ['2', 'H0STCNT0', '005930'], ['1', 'H0STASP0', '000660'],
        ]);
        kws.stop();
    });

    it('구독 응답의 rt_cd 가 0 이 아니면 로그를 남기고 onSubscribeError 로 알린다', async () => {
        const onSubscribeError = vi.fn();
        const kws = newWs({ onSubscribeError });
        kws.start([{ trId: 'H0STCNT0', trKey: '005930' }]);
        await flush();
        const ws = FakeWs.instances[0]!;
        ws.emit('open');

        ws.emit('message', { data: JSON.stringify({ header: { tr_id: 'H0STCNT0', tr_key: '005930' }, body: { rt_cd: '0', msg1: 'SUBSCRIBE SUCCESS' } }) });
        ws.emit('message', { data: JSON.stringify({ header: { tr_id: 'H0STCNT0', tr_key: '000660' }, body: { rt_cd: '1', msg1: 'MAX SUBSCRIBE OVER' } }) });

        expect(onSubscribeError).toHaveBeenCalledTimes(1);
        expect(onSubscribeError).toHaveBeenCalledWith('H0STCNT0', '000660', 'MAX SUBSCRIBE OVER');
        expect(logger.warn).toHaveBeenCalledWith({ trId: 'H0STCNT0', trKey: '000660', message: 'MAX SUBSCRIBE OVER' }, '[KisPriceWs] 구독 거부');
        kws.stop();
    });

    it('콜백이 없어도 구독 거부를 로그로 남긴다', async () => {
        const kws = newWs();
        kws.start([]);
        await flush();
        FakeWs.instances[0]!.emit('message', { data: JSON.stringify({ header: { tr_id: 'H0STCNT0', tr_key: '000660' }, body: { rt_cd: '1', msg1: 'MAX SUBSCRIBE OVER' } }) });

        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ trKey: '000660' }), '[KisPriceWs] 구독 거부');
        kws.stop();
    });

    it('onTrade 가 던져도 같은 프레임의 나머지 건을 넘긴다', async () => {
        const seen: number[] = [];
        const kws = newWs({
            onTrade: (_symbol, last) => {
                seen.push(last);
                if (seen.length === 1) throw new Error('boom');
            },
        });
        kws.start([]);
        await flush();

        expect(() => FakeWs.instances[0]!.emit('message', { data: '0|H0STCNT0|002|005930^093000^79000^5^100^2.5^000660^093000^180000^5^100^1.5' }))
            .not.toThrow();
        expect(seen).toEqual([79000, 180000]);
        kws.stop();
    });

    it('kis.createPriceStream 은 onSubscribeError 를 넘긴다', async () => {
        const onSubscribeError = vi.fn();
        const kis = newKis({ sandbox: true });
        vi.spyOn(kis, 'getApprovalKey').mockResolvedValue('ak');
        const kws = kis.createPriceStream({ onSubscribeError });
        kws.start([]);
        await vi.waitFor(() => expect(FakeWs.instances).toHaveLength(1));

        FakeWs.instances[0]!.emit('message', { data: JSON.stringify({ header: { tr_id: 'H0STCNT0', tr_key: '000660' }, body: { rt_cd: '1', msg1: 'MAX SUBSCRIBE OVER' } }) });

        expect(onSubscribeError).toHaveBeenCalledWith('H0STCNT0', '000660', 'MAX SUBSCRIBE OVER');
        kws.stop();
    });
});

describe('KisPriceWs 연결 수명', () => {
    it('접속키를 기다리는 사이에 stop() 을 부르면 소켓을 만들지 않는다', async () => {
        let release: (key: string) => void = () => undefined;
        const kws = newWs({ getApprovalKey: () => new Promise<string>((resolve) => { release = resolve; }) });
        kws.start([{ trId: 'H0STCNT0', trKey: '005930' }]);
        await flush();

        kws.stop();
        release('ak');
        await flush();

        expect(FakeWs.instances).toHaveLength(0);
    });

    it('재연결은 옛 소켓을 닫고, 옛 소켓의 늦은 이벤트로 재연결이나 구독을 하지 않는다', async () => {
        vi.useFakeTimers();
        const getApprovalKey = vi.fn(async () => 'ak');
        const kws = newWs({ getApprovalKey });
        kws.start([{ trId: 'H0STCNT0', trKey: '005930' }]);
        await vi.advanceTimersByTimeAsync(0);
        const first = FakeWs.instances[0]!;
        first.emit('open');
        first.emit('close', { code: 1006 });
        await vi.advanceTimersByTimeAsync(2_000);
        const second = FakeWs.instances[1]!;

        expect(first.closeCallCount).toBe(1);
        first.emit('close', { code: 1006 });
        first.emit('error', { message: 'late' });
        first.emit('open');
        await vi.advanceTimersByTimeAsync(30_000);

        expect(FakeWs.instances).toHaveLength(2);
        expect(getApprovalKey).toHaveBeenCalledTimes(2);
        expect(first.sent).toHaveLength(1);
        expect(second.sent).toHaveLength(0);
        kws.stop();
    });
});
