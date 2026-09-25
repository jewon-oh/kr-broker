/**
 * @fileoverview KIS 실시간 시세 WebSocket 클라이언트
 *
 * 단일 WS 연결로 체결가(H0STCNT0/HDFSCNT0)·호가(H0STASP0) 를 구독해 콜백으로 emit.
 * KIS 는 표준 WebSocket 라이브러리가 없어 자체 WS 프로토콜로 구현한다.
 *
 * - 인증: approval_key (KISAuth.getApprovalKey).
 * - 재연결: 지수 백오프 + approval_key 재발급 + 구독 재등록.
 * - PINGPONG: 수신 프레임 그대로 echo.
 * - 프레임 파싱은 순수 함수(kis-realtime-parser)로 분리 — 테스트로 고정.
 *
 * DOM lib 타입 의존을 피하려 최소 shim({@link WsLike}) 사용.
 *
 * ## 전역 `WebSocket` 은 Node 21+ 에서만 있다
 *
 * 운영 환경이 Node 20 이라 **WS 가 한 번도 붙은 적이 없었다.** 그동안 국내주식 시세는
 * 5초 REST 폴링만으로 돌았고, 종전 코드는 그 사실을 조용히 넘겼다(`connect` 가 즉시
 * 반환 → 영구 비연결). 호출부의 성공 로그는 선행 수정으로 정확해졌지만, **못 붙는 것 자체는
 * 그대로**였다.
 *
 * ⇒ 이제 전역이 없으면 **`ws` 패키지로 폴백**한다. `ws@^8` 은 이 패키지의 런타임 의존성이고
 * 브라우저 호환 이벤트 API(`addEventListener` + `ev.data`)를 제공하므로
 * {@link WsLike} 를 그대로 만족한다 — 런타임을 올리지 않고 코드만으로 해결된다.
 *
 * 로딩은 **동적 import** 다. `ws` 가 없는 환경(브라우저 번들·경량 이미지)에서도 이 모듈이
 * 깨지지 않아야 하고, 전역이 있는 런타임에서는 아예 불러올 필요가 없다.
 */

import { logger } from '../logger';
import { KIS_WS_DOMAINS, KIS_WS_PATH } from './kis-types';
import { parseKisRealtimeFrame, isPingPong, toStreamSymbol } from './kis-realtime-parser';

/**
 * 이벤트 인자 shim — open/message/close/error 모두 이 형태로 온다(브라우저 호환 이벤트 API).
 *
 * 필드는 이벤트 타입에 따라 실려 오는 부분집합만 채워진다: `message` 는 `data`, `close` 는
 * `code`/`reason`/`wasClean`, `error` 는 `error`/`message` (WHATWG `ErrorEvent`/`CloseEvent`
 * 규격 — 전역 `WebSocket`(Node 21+)과 `ws` 패키지의 `addEventListener` 경로 둘 다 이 규격을
 * 따른다. `ws@8` 소스(`lib/event-target.js`)로 확인: `error` 는 `new ErrorEvent('error',
 * { error, message: error.message })`, `close` 는 `new CloseEvent('close', { code, reason,
 * wasClean })`).
 */
export interface WsEventLike {
    data?: unknown;
    error?: unknown;
    message?: string;
    code?: number;
    reason?: string;
    wasClean?: boolean;
}

/** 글로벌 WebSocket 최소 타입 (DOM lib 미의존). */
export interface WsLike {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: string, cb: (ev: WsEventLike) => void): void;
}
export type WsCtor = new (url: string) => WsLike;
const WS_OPEN = 1;

/** 전역 `WebSocket`(Node 21+). 없으면 `ws` 패키지로 폴백한다. */
function globalWsCtor(): WsCtor | undefined {
    const g = (globalThis as { WebSocket?: WsCtor }).WebSocket;
    return typeof g === 'function' ? g : undefined;
}

/**
 * WS 생성자 해석 — 전역 우선, 없으면 `ws` 패키지.
 *
 * 동적 import 인 이유: `ws` 가 없는 환경에서도 이 모듈이 깨지면 안 되고, 전역이 있는
 * 런타임에서는 불러올 필요가 없다. 결과는 캐시해 재연결마다 재해석하지 않는다.
 */
let wsCtorCache: WsCtor | null | undefined;
export async function resolveWsCtor(): Promise<WsCtor | null> {
    const g = globalWsCtor();
    if (g) return g;
    if (wsCtorCache !== undefined) return wsCtorCache;
    try {
        const mod = await import('ws');
        // `ws` 는 named export 와 default 를 모두 노출한다(번들러/조건부 export 차이).
        const Ctor = ((mod as { WebSocket?: unknown }).WebSocket
            ?? (mod as { default?: unknown }).default) as WsCtor | undefined;
        wsCtorCache = typeof Ctor === 'function' ? Ctor : null;
    } catch (err) {
        logger.error({ err }, '[KisPriceWs] `ws` 패키지 로드 실패 — WS 비활성');
        wsCtorCache = null;
    }
    return wsCtorCache;
}

/**
 * 이 런타임에서 KIS WS 구독이 가능한가.
 *
 * `ws` 폴백이 생긴 뒤로는 **거의 항상 true** 다 — 전역이 없어도 붙을 수 있기 때문이다.
 * false 는 `ws` 조차 못 불러오는 환경뿐이다. `connect` 의 판정과 같은 조건을 유지한다.
 *
 * 호출부가 이걸 먼저 물어야 "WS 시작했다" 는 거짓 로그를 피할 수 있다.
 */
export async function isKisWsSupported(): Promise<boolean> {
    return (await resolveWsCtor()) !== null;
}

/** 전역 WebSocket 을 쓰는가 — 폴백(`ws`)과 구별해 로그에 사실대로 남기기 위함. */
export function isUsingGlobalWebSocket(): boolean {
    return globalWsCtor() !== undefined;
}

export interface KisWsSub {
    /** KIS_WS_TR 값 (H0STCNT0 / H0STASP0 / HDFSCNT0) */
    trId: string;
    /** 구독 키 — 국내: 종목코드(005930), 해외: D+거래소+심볼(DNASAAPL) */
    trKey: string;
}

export interface KisPriceWsOptions {
    getApprovalKey: () => Promise<string>;
    isVirtual: boolean;
    /** 접속 주소. 없으면 `isVirtual` 에 따라 KIS 기본 주소다. */
    url?: string;
    onTrade?: (streamSymbol: string, last: number, changePct: number) => void;
    onOrderbook?: (streamSymbol: string, bids: [number, number][], asks: [number, number][]) => void;
}

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** KIS 연결당 등록 한계 (~41). 초과분은 누락 → 폴링 폴백 필요. */
const MAX_REGISTRATIONS = 40;

export class KisPriceWs {
    private ws: WsLike | null = null;
    private subs: KisWsSub[] = [];
    private approvalKey = '';
    private running = false;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;

    constructor(private readonly opts: KisPriceWsOptions) {}

    start(subs: KisWsSub[]): void {
        this.subs = subs;
        if (subs.length > MAX_REGISTRATIONS) {
            logger.warn({ count: subs.length, limit: MAX_REGISTRATIONS },
                '[KisPriceWs] 구독 수가 연결당 한계 초과 — 초과분 누락 가능(폴링 폴백 의존)');
        }
        this.running = true;
        void this.connect();
    }

    stop(): void {
        this.running = false;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        try { this.ws?.close(); } catch { /* ignore */ }
        this.ws = null;
    }

    /** 런타임 구독 갱신 — 연결 상태면 신규 sub 만 추가 등록. */
    updateSubs(subs: KisWsSub[]): void {
        const existing = new Set(this.subs.map((s) => `${s.trId}:${s.trKey}`));
        this.subs = subs;
        if (this.ws && this.ws.readyState === WS_OPEN) {
            for (const s of subs) {
                if (!existing.has(`${s.trId}:${s.trKey}`)) this.register(s);
            }
        }
    }

    isConnected(): boolean {
        return this.ws?.readyState === WS_OPEN;
    }

    private async connect(): Promise<void> {
        if (!this.running) return;
        const Ctor = await resolveWsCtor();
        if (!Ctor) {
            // 여기까지 오면 전역도 `ws` 도 없다 — 재연결해도 달라지지 않으므로 예약하지 않는다.
            logger.error({ nodeVersion: process.version },
                '[KisPriceWs] 전역 WebSocket 도 `ws` 패키지도 없음 — WS 비활성');
            return;
        }
        try {
            this.approvalKey = await this.opts.getApprovalKey();
        } catch (err) {
            logger.error({ err }, '[KisPriceWs] approval_key 발급 실패 — 재연결 예약');
            this.scheduleReconnect();
            return;
        }
        const url = this.opts.url ?? (this.opts.isVirtual ? KIS_WS_DOMAINS.VIRTUAL : KIS_WS_DOMAINS.REAL) + KIS_WS_PATH;
        try {
            const ws = new Ctor(url);
            this.ws = ws;
            ws.addEventListener('open', () => {
                this.reconnectAttempts = 0;
                logger.info({ subs: this.subs.length }, '[KisPriceWs] WS 연결 완료 — 구독 등록');
                for (const s of this.subs) this.register(s);
            });
            ws.addEventListener('message', (ev) => {
                this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data ?? ''));
            });
            ws.addEventListener('close', (ev) => {
                if (this.running) {
                    // code/reason/wasClean 없이 "WS 종료" 만 찍으면 정상 종료(서버가
                    // 1000 으로 닫음)와 비정상 종료(네트워크 끊김·서버 거부)를 구별할 수 없다.
                    logger.warn({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean },
                        '[KisPriceWs] WS 종료 — 재연결 예약');
                    this.scheduleReconnect();
                }
            });
            ws.addEventListener('error', (ev) => {
                // 콜백이 ev 를 안 받아 빈 객체만 찍던 결함. ev.error/ev.message 없이는
                // KIS 서버 거부·네트워크 조기종료·구독 프레임 문제 중 무엇인지 절대 구분할 수 없다.
                logger.warn({ err: ev.error, message: ev.message }, '[KisPriceWs] WS 오류');
                // (실측) Node 네이티브 WebSocket(undici, Node
                // 21+)은 핸드셰이크가 "non-101 status code" 로 실패하면 `error` 만 내고
                // `close` 를 영영 안 낸다 — 실제 KIS 서버에 직접 연결해
                // 재현했다(`readyState` 가 CONNECTING 에 40초 넘게 고정). `close` 전용으로
                // 배선된 재연결은 이 경로에서 영영 걸리지 않는다 — 실서버에서 관측된 "오류 로그는
                // 쌓이는데 재연결 로그는 0건" 이 바로 이거다.
                //
                // `error` 에서도 건다. `scheduleReconnect()` 는 `reconnectTimer` 존재 시
                // no-op 이라 재진입 가드가 있다 — 나중에 `close` 가 뒤따라도 중복 예약되지
                // 않는다.
                //
                // 여기서 `ws.close()` 를 부르지 않는다. 같은 실측에서 이 실패 상태의
                // 소켓에 `close()` 를 부르면 "Connection was closed before it was
                // established." `error` 이벤트가 **동기적으로 무한 재귀** 발생했다(초당
                // 수천 건). 안 닫는 지금 쪽이 안전하다 — 다음 `connect()` 가 새 소켓을 만들고
                // 이 참조는 버려진다.
                if (this.running) this.scheduleReconnect();
            });
        } catch (err) {
            logger.error({ err }, '[KisPriceWs] WS 생성 실패 — 재연결 예약');
            this.scheduleReconnect();
        }
    }

    private register(sub: KisWsSub): void {
        if (!this.ws || this.ws.readyState !== WS_OPEN) return;
        const frame = JSON.stringify({
            header: { approval_key: this.approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
            body: { input: { tr_id: sub.trId, tr_key: sub.trKey } },
        });
        try { this.ws.send(frame); } catch (err) { logger.warn({ err, sub }, '[KisPriceWs] 구독 전송 실패'); }
    }

    private onMessage(raw: string): void {
        if (isPingPong(raw)) {
            try { this.ws?.send(raw); } catch { /* ignore */ }
            return;
        }
        if (raw[0] === '{') return; // 구독 응답(JSON) — 무시
        for (const rec of parseKisRealtimeFrame(raw)) {
            const streamSymbol = toStreamSymbol(rec.symbol);
            if (rec.kind === 'trade') this.opts.onTrade?.(streamSymbol, rec.last, rec.changePct);
            else this.opts.onOrderbook?.(streamSymbol, rec.bids, rec.asks);
        }
    }

    private scheduleReconnect(): void {
        if (!this.running || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
    }
}
