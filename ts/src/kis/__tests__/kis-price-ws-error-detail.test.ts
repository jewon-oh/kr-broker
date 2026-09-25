/**
 * @fileoverview WS `error`/`close` 이벤트가 실제로 원인 필드를 싣고, 재연결이
 * 실제로 예약되는지 검증한다.
 *
 * ## 원래 결함
 *
 * `ws.addEventListener('error', => { logger.warn({},...) })` — 콜백이 `ev` 를 안 받아
 * 빈 객체만 찍혔다. 라이브에서 "WS 오류" 로그가 전부 원인 없이 남았다.
 * `close` 도 `code`/`reason`/`wasClean` 없이 "WS 종료" 만 찍었다.
 *
 * ## 재실측 — close 가 영영 안 온다
 *
 * 배포 직후 새 파드에서: WS 오류 로그 1줄이 뜨고 그걸로 끝, 10분 넘게
 * 재연결 로그가 없었다. 클러스터 파드 안(`kubectl exec`)에서 실제 KIS WS 서버에 Node
 * 네이티브 `WebSocket`(undici. Node 22 에서는 `ws` 패키지가 아니라 이 구현을 쓴다)으로
 * 직접 연결해 재현했다: 핸드셰이크가 "Received network error or non-101 status code" 로
 * 실패하면 **`error` 만 나고 `close` 는 40초를 기다려도 안 온다**(`readyState` 가
 * CONNECTING 에 고정). `close` 전용으로 배선된 `scheduleReconnect` 는 이 경로에서
 * 절대 호출되지 않는다 — 이것이 실측으로 확인한 원인이다.
 *
 * 같은 실측에서 확인한 함정: 이 상태의 소켓에 `close` 를 불러 "정리" 하려 하면
 * "Connection was closed before it was established." `error` 가 **동기적으로 무한
 * 재귀**한다(초당 수천 건). 그래서 `error` 핸들러는 `ws.close` 를 부르지 않는다 —
 * 이 테스트가 그 금지도 함께 검증한다.
 *
 * ## 이 테스트가 검증하는 것
 *
 * 1. `error` 이벤트가 오면 `ev.error`/`ev.message` 가 `logger.warn` 의 payload 에 실린다.
 * 2. `error` 만 오고 `close` 는 영영 안 와도, `error` 핸들러가 **직접** 재연결을 예약한다
 *    (close 핸들러가 붙어 있는지, `scheduleReconnect` 가 정말 호출되는지는 라이브 조사만으로는
 *    확인할 수 없었으므로 테스트로 고정한다).
 * 3. `error` 처리기는 `ws.close` 를 부르지 않는다(무한 재귀 함정 회피). 다음 `connect()` 가 옛 소켓을 떼어 낸 뒤 한 번 닫고,
 *    그 `close()` 가 동기적으로 내는 `error` 는 떼어 낸 소켓의 이벤트라 무시한다.
 * 4. `close` 이벤트가 오는 경로(핸드셰이크 이후 실패 등)도 여전히 `code`/`reason`/
 *    `wasClean` 을 싣고 재연결을 예약한다 — 둘 다 동작해야 한다.
 *
 * 네트워크를 쓰지 않는다. `kis-ws-supported.test.ts` 와 같은 방식으로 `globalThis.WebSocket`
 * 에 가짜 생성자를 대입해 `KisPriceWs.connect` 의 실제 리스너 등록 경로를 그대로 실행한다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


import { logger } from '../../logger';
import { KisPriceWs } from '../kis-price-ws';

type FakeListener = (ev: Record<string, unknown>) => void;

/** `ws` 패키지의 `addEventListener` 인터페이스만 흉내 낸다 — 실제 소켓 없음. */
class FakeWs {
    static readonly OPEN = 1;
    static instances: FakeWs[] = [];
    readyState = 1;
    private readonly listeners = new Map<string, FakeListener[]>();

    closeCallCount = 0;
    /** undici 처럼 `close()` 가 `error` 를 동기적으로 내게 한다 */
    errorOnClose = false;

    constructor(public readonly url: string) {
        FakeWs.instances.push(this);
    }

    addEventListener(type: string, cb: FakeListener): void {
        const arr = this.listeners.get(type) ?? [];
        arr.push(cb);
        this.listeners.set(type, arr);
    }

    send(): void { /* no-op */ }
    close(): void {
        this.closeCallCount++;
        if (this.errorOnClose) this.emit('error', { message: 'Connection was closed before it was established.' });
    }

    /** 테스트 전용 — 등록된 리스너에 이벤트를 전달한다. */
    emit(type: string, ev: Record<string, unknown> = {}): void {
        for (const cb of this.listeners.get(type) ?? []) cb(ev);
    }
}

type GlobalWithWs = { WebSocket?: unknown };
const g = globalThis as GlobalWithWs;
const originalWebSocket = g.WebSocket;

beforeEach(() => {
    FakeWs.instances = [];
    g.WebSocket = FakeWs as unknown as typeof WebSocket;
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
});

afterEach(() => {
    if (originalWebSocket === undefined) delete g.WebSocket;
    else g.WebSocket = originalWebSocket;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('KisPriceWs — error/close 이벤트 필드', () => {
    it('error 이벤트의 ev.error/ev.message 가 빈 객체 없이 로그에 실린다', async () => {
        const kws = new KisPriceWs({ getApprovalKey: vi.fn().mockResolvedValue('approval-key'), isVirtual: true });
        kws.start([]);
        await vi.advanceTimersByTimeAsync(0);

        const ws = FakeWs.instances[0];
        expect(ws, 'connect() 가 WebSocket 인스턴스를 만들지 않았다').toBeTruthy();

        const boom = new Error('ECONNRESET');
        ws.emit('error', { error: boom, message: boom.message });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: boom, message: 'ECONNRESET' }),
            '[KisPriceWs] WS 오류',
        );

        kws.stop();
    });

    it('close 가 영영 안 와도 error 만으로 재연결이 걸린다 — error 처리기는 close() 를 안 부른다', async () => {
        const getApprovalKey = vi.fn().mockResolvedValue('approval-key');
        const kws = new KisPriceWs({ getApprovalKey, isVirtual: true });
        kws.start([]);
        await vi.advanceTimersByTimeAsync(0);

        expect(getApprovalKey).toHaveBeenCalledTimes(1);
        const ws = FakeWs.instances[0];
        ws.errorOnClose = true;

        // close 는 이 테스트 끝까지 한 번도 전달하지 않는다 — 실측이 재현한 그 상태 그대로.
        ws.emit('error', {
            error: new Error('non-101 status code'),
            message: 'Received network error or non-101 status code.',
        });

        // 무한 재귀 함정: 이 상태의 소켓에 close() 를 부르면 동기 재귀로 error 가 급증했다
        // (실측). error 처리기가 재연결을 예약할 때 ws.close() 를 부르지 않아야 한다.
        expect(ws.closeCallCount, 'error 처리기가 ws.close() 를 불렀다 — 무한 재귀 위험').toBe(0);

        // RECONNECT_BASE_MS = 2_000 — error 핸들러가 직접 scheduleReconnect() 를 부르지
        // 않으면(close 전용 배선이면) 이 시점에도 getApprovalKey 가 그대로 1회다.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(getApprovalKey, 'error 만으로는 재연결이 걸리지 않았다 — close 전용 배선으로 되돌아갔다')
            .toHaveBeenCalledTimes(2);

        // 재연결은 옛 소켓을 한 번 닫는다. 그때 오는 error 는 떼어 낸 소켓의 것이라 되풀이되거나 재연결을 더 걸지 않는다.
        expect(ws.closeCallCount).toBe(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getApprovalKey).toHaveBeenCalledTimes(2);

        kws.stop();
    });

    it('close 이벤트의 code/reason/wasClean 이 로그에 실리고 재연결이 실제로 예약된다', async () => {
        const getApprovalKey = vi.fn().mockResolvedValue('approval-key');
        const kws = new KisPriceWs({ getApprovalKey, isVirtual: true });
        kws.start([]);
        await vi.advanceTimersByTimeAsync(0);

        expect(getApprovalKey).toHaveBeenCalledTimes(1);
        const ws = FakeWs.instances[0];

        ws.emit('close', { code: 1006, reason: 'abnormal closure', wasClean: false });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ code: 1006, reason: 'abnormal closure', wasClean: false }),
            '[KisPriceWs] WS 종료 — 재연결 예약',
        );

        // RECONNECT_BASE_MS = 2_000 — close 핸들러가 scheduleReconnect() 를 실제로 불렀다면
        // 이 시점에 두 번째 connect() 가 돌아 approval_key 를 다시 받는다.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(getApprovalKey, 'close 후 재연결이 예약되지 않았다').toHaveBeenCalledTimes(2);

        kws.stop();
    });
});
