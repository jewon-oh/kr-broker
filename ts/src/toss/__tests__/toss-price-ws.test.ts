/**
 * @fileoverview `TossPriceWs` — 연결·구독 선언·keepalive·재연결.
 *
 * `__setWsCtorForTests` 로 생성자를 직접 주입한다(동적 `import('ws')` 를 거치지 않는다). `vi.mock('ws', ...)`
 * 로 모듈을 가로채는 방식은 fake timer(`vi.useFakeTimers`)와 동적 import 의 프라미스 해석 순서가 맞물려
 * `advanceTimersByTimeAsync` 로 안정적으로 플러시되지 않았다(실측) — 이 훅이 그 경합을 피한다. 실제 소켓은 없다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TossPriceWs, __setWsCtorForTests, type WsLike } from '../toss-price-ws';

type FakeListener = (ev: Record<string, unknown>) => void;

class FakeWs implements WsLike {
    static readonly OPEN = 1;
    static instances: FakeWs[] = [];
    readyState = 1;
    sent: string[] = [];
    closeCallCount = 0;
    private readonly listeners = new Map<string, FakeListener[]>();

    constructor(public readonly url: string, public readonly options?: { headers?: Record<string, string> }) {
        FakeWs.instances.push(this);
    }

    addEventListener(type: string, cb: FakeListener): void {
        const arr = this.listeners.get(type) ?? [];
        arr.push(cb);
        this.listeners.set(type, arr);
    }

    send(data: string): void { this.sent.push(data); }
    close(): void { this.closeCallCount++; }

    emit(type: string, ev: Record<string, unknown> = {}): void {
        for (const cb of this.listeners.get(type) ?? []) cb(ev);
    }
}

beforeEach(() => {
    FakeWs.instances = [];
    __setWsCtorForTests(FakeWs);
    vi.useFakeTimers();
});
afterEach(() => {
    __setWsCtorForTests(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const lastFrame = (ws: FakeWs): unknown[] => JSON.parse(ws.sent[ws.sent.length - 1]);

describe('TossPriceWs — 연결과 구독 선언', () => {
    it('연결하면 Authorization 헤더를 싣고, open 되면 구독을 채널·시장별로 묶어 선언한다', async () => {
        const getAccessToken = vi.fn().mockResolvedValue('tok-1');
        const ws1 = new TossPriceWs({ getAccessToken });
        ws1.start([
            { channel: 'trade', market: 'us', symbol: 'AAPL' },
            { channel: 'trade', market: 'us', symbol: 'TSLA' },
            { channel: 'orderbook', market: 'kr', symbol: '005930' },
        ]);
        await vi.advanceTimersByTimeAsync(0);

        const ws = FakeWs.instances[0];
        expect(ws.options?.headers).toEqual({ Authorization: 'Bearer tok-1' });
        ws.emit('open');

        expect(lastFrame(ws)).toEqual([
            { type: 'trade:us', codes: ['AAPL', 'TSLA'] },
            { type: 'orderbook:kr', codes: ['005930'] },
        ]);
        ws1.stop();
    });

    it('updateSubs 는 전체를 다시 선언한다(선언형 full-replace)', async () => {
        const ws1 = new TossPriceWs({ getAccessToken: vi.fn().mockResolvedValue('tok-1') });
        ws1.start([{ channel: 'trade', market: 'kr', symbol: '005930' }]);
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWs.instances[0];
        ws.emit('open');

        ws1.updateSubs([{ channel: 'trade', market: 'kr', symbol: '000660' }]);

        expect(lastFrame(ws)).toEqual([{ type: 'trade:kr', codes: ['000660'] }]);
        ws1.stop();
    });

    it('메시지 프레임을 onTrade·onOrderbook 콜백으로 넘긴다', async () => {
        const onTrade = vi.fn();
        const onOrderbook = vi.fn();
        const ws1 = new TossPriceWs({ getAccessToken: vi.fn().mockResolvedValue('tok-1'), onTrade, onOrderbook });
        ws1.start([]);
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWs.instances[0];
        ws.emit('open');

        ws.emit('message', { data: JSON.stringify({ type: 'message', topic: 'trade:us:AAPL', data: { price: '185.5', volume: '10', timestamp: '2026-09-24T12:23:00.000Z' } }) });
        ws.emit('message', {
            data: JSON.stringify({ type: 'message', topic: 'orderbook:kr:005930', data: { asks: [{ price: '71500', volume: '5' }], bids: [] } }),
        });

        expect(onTrade).toHaveBeenCalledWith('us', 'AAPL', 185.5, 10, Date.parse('2026-09-24T12:23:00.000Z'));
        expect(onOrderbook).toHaveBeenCalledWith('kr', '005930', [], [[71500, 5]], undefined);
        ws1.stop();
    });

    it('본인 주문 구독은 계좌 accountSeq 로 선언되고, 다른 채널과 같은 배열에 묶인다', async () => {
        const ws1 = new TossPriceWs({ getAccessToken: vi.fn().mockResolvedValue('tok-1') });
        ws1.start([
            { channel: 'trade', market: 'kr', symbol: '005930' },
            { channel: 'order', accountSeq: '3' },
        ]);
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWs.instances[0];
        ws.emit('open');

        expect(lastFrame(ws)).toEqual([
            { type: 'trade:kr', codes: ['005930'] },
            { type: 'personal:order', codes: ['3'] },
        ]);
        ws1.stop();
    });

    it('본인 주문 이벤트 프레임을 onOrder 콜백으로 넘긴다', async () => {
        const onOrder = vi.fn();
        const ws1 = new TossPriceWs({ getAccessToken: vi.fn().mockResolvedValue('tok-1'), onOrder });
        ws1.start([{ channel: 'order', accountSeq: '3' }]);
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWs.instances[0];
        ws.emit('open');

        const order = { orderId: 'O1', symbol: 'AAPL', status: 'FILLED' };
        ws.emit('message', { data: JSON.stringify({ type: 'message', topic: 'personal:order:3', data: { event: 'FILL', accountSeq: '3', order } }) });

        expect(onOrder).toHaveBeenCalledWith('3', 'FILL', order);
        ws1.stop();
    });
});

describe('TossPriceWs — keepalive', () => {
    it('open 뒤 60초마다 순수 텍스트 PING 을 보낸다', async () => {
        const ws1 = new TossPriceWs({ getAccessToken: vi.fn().mockResolvedValue('tok-1') });
        ws1.start([]);
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWs.instances[0];
        ws.emit('open');
        ws.sent = [];

        await vi.advanceTimersByTimeAsync(60_000);

        expect(ws.sent).toEqual(['PING']);
        ws1.stop();
    });

    it('핑 타이머는 unref 해 프로세스 종료를 막지 않는다', async () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const ws1 = new TossPriceWs({ getAccessToken: vi.fn().mockResolvedValue('tok-1') });
        ws1.start([]);
        await vi.advanceTimersByTimeAsync(0);
        FakeWs.instances[0].emit('open');

        const timer = setIntervalSpy.mock.results[0].value as NodeJS.Timeout;
        expect(timer.hasRef()).toBe(false);
        ws1.stop();
    });
});

describe('TossPriceWs — 재연결', () => {
    it('close 이벤트를 받으면 지수 백오프로 재연결하고 구독을 다시 선언한다', async () => {
        const getAccessToken = vi.fn().mockResolvedValue('tok-1');
        const ws1 = new TossPriceWs({ getAccessToken });
        ws1.start([{ channel: 'trade', market: 'kr', symbol: '005930' }]);
        await vi.advanceTimersByTimeAsync(0);
        expect(getAccessToken).toHaveBeenCalledTimes(1);

        FakeWs.instances[0].emit('close', { code: 1006, reason: 'abnormal', wasClean: false });
        await vi.advanceTimersByTimeAsync(1_000); // RECONNECT_BASE_MS

        expect(getAccessToken).toHaveBeenCalledTimes(2);
        expect(FakeWs.instances).toHaveLength(2);
        FakeWs.instances[1].emit('open');
        expect(lastFrame(FakeWs.instances[1])).toEqual([{ type: 'trade:kr', codes: ['005930'] }]);
        ws1.stop();
    });

    it('재연결 전에 이전 연결을 닫는다', async () => {
        const ws1 = new TossPriceWs({ getAccessToken: vi.fn().mockResolvedValue('tok-1') });
        ws1.start([]);
        await vi.advanceTimersByTimeAsync(0);
        const first = FakeWs.instances[0];

        first.emit('close', { code: 1006 });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(first.closeCallCount).toBe(1);
        ws1.stop();
    });

    it('rate-limit-exceeded 에러를 받으면 1초 뒤 다시 선언한다', async () => {
        const ws1 = new TossPriceWs({ getAccessToken: vi.fn().mockResolvedValue('tok-1') });
        ws1.start([{ channel: 'trade', market: 'kr', symbol: '005930' }]);
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWs.instances[0];
        ws.emit('open');
        ws.sent = [];

        ws.emit('message', { data: JSON.stringify({ type: 'error', error: { code: 'rate-limit-exceeded', message: 'declare rate limit exceeded' } }) });
        expect(ws.sent).toHaveLength(0); // 아직은 대기 중
        await vi.advanceTimersByTimeAsync(1_000);

        expect(lastFrame(ws)).toEqual([{ type: 'trade:kr', codes: ['005930'] }]);
        ws1.stop();
    });

    it('stop() 은 재연결 타이머를 지우고 소켓을 닫는다', async () => {
        const getAccessToken = vi.fn().mockResolvedValue('tok-1');
        const ws1 = new TossPriceWs({ getAccessToken });
        ws1.start([]);
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWs.instances[0];

        ws1.stop();
        ws.emit('close', { code: 1000 });
        await vi.advanceTimersByTimeAsync(30_000);

        expect(getAccessToken).toHaveBeenCalledTimes(1); // 재연결 안 됨
        expect(ws.closeCallCount).toBe(1);
    });
});

describe('TossPriceWs — 연결 준비 중 stop, 옛 소켓', () => {
    it('ws 모듈을 불러오는 사이에 stop() 하면 토큰도 받지 않고 소켓도 만들지 않는다', async () => {
        const getAccessToken = vi.fn().mockResolvedValue('tok-1');
        const ws1 = new TossPriceWs({ getAccessToken });
        ws1.start([]);
        ws1.stop();
        await vi.advanceTimersByTimeAsync(0);

        expect(getAccessToken).not.toHaveBeenCalled();
        expect(FakeWs.instances).toHaveLength(0);
    });

    it('토큰을 받는 사이에 stop() 하면 소켓을 만들지 않는다', async () => {
        let issue: (token: string) => void = () => undefined;
        const ws1 = new TossPriceWs({ getAccessToken: () => new Promise<string>((resolve) => { issue = resolve; }) });
        ws1.start([{ channel: 'trade', market: 'kr', symbol: '005930' }]);
        await vi.advanceTimersByTimeAsync(0);

        ws1.stop();
        issue('tok-1');
        await vi.advanceTimersByTimeAsync(60_000);

        expect(FakeWs.instances).toHaveLength(0);
    });

    it('재연결 뒤 늦게 온 옛 소켓의 close 는 재연결을 다시 걸지 않고, 새 소켓의 핑을 멈추지 않는다', async () => {
        const getAccessToken = vi.fn().mockResolvedValue('tok-1');
        const ws1 = new TossPriceWs({ getAccessToken });
        ws1.start([]);
        await vi.advanceTimersByTimeAsync(0);
        const first = FakeWs.instances[0];
        first.emit('error', { message: 'reset' });
        await vi.advanceTimersByTimeAsync(1_000);
        const second = FakeWs.instances[1];
        second.emit('open');
        second.sent = [];

        first.emit('close', { code: 1006 });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(FakeWs.instances).toHaveLength(2);
        expect(getAccessToken).toHaveBeenCalledTimes(2);
        expect(second.sent).toEqual(['PING']);
        ws1.stop();
    });

    it('재연결 토큰을 기다리는 사이에 온 옛 소켓의 close 도 재연결을 다시 걸지 않는다', async () => {
        const issues: ((token: string) => void)[] = [];
        const getAccessToken = vi.fn(() => new Promise<string>((resolve) => { issues.push(resolve); }));
        const ws1 = new TossPriceWs({ getAccessToken });
        ws1.start([]);
        await vi.advanceTimersByTimeAsync(0);
        issues[0]('tok-1');
        await vi.advanceTimersByTimeAsync(0);
        const first = FakeWs.instances[0];
        first.emit('error', { message: 'reset' });
        await vi.advanceTimersByTimeAsync(1_000);

        first.emit('close', { code: 1006 });
        issues[1]('tok-2');
        await vi.advanceTimersByTimeAsync(60_000);

        expect(FakeWs.instances).toHaveLength(2);
        expect(getAccessToken).toHaveBeenCalledTimes(2);
        ws1.stop();
    });

    it('옛 소켓의 메시지는 콜백으로 넘기지 않는다', async () => {
        const onTrade = vi.fn();
        const ws1 = new TossPriceWs({ getAccessToken: vi.fn().mockResolvedValue('tok-1'), onTrade });
        ws1.start([]);
        await vi.advanceTimersByTimeAsync(0);
        const first = FakeWs.instances[0];
        first.emit('close', { code: 1006 });
        await vi.advanceTimersByTimeAsync(1_000);

        first.emit('message', { data: JSON.stringify({ type: 'message', topic: 'trade:us:AAPL', data: { price: '185.5', volume: '10' } }) });

        expect(onTrade).not.toHaveBeenCalled();
        ws1.stop();
    });
});
