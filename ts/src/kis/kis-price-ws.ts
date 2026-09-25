/**
 * @fileoverview KIS 실시간 시세 WebSocket 클라이언트
 *
 * 단일 WS 연결로 체결가(H0STCNT0/HDFSCNT0)·호가(H0STASP0) 를 구독해 콜백으로 emit.
 * KIS 는 표준 WebSocket 라이브러리가 없어 자체 WS 프로토콜로 구현한다.
 *
 * - 인증: approval_key (KisAuth.getApprovalKey).
 * - 재연결: 지수 백오프 + `getApprovalKey()` 재호출(캐시가 유효하면 같은 키) + 구독 재등록.
 * - PINGPONG: 수신 프레임 그대로 echo.
 * - 프레임 파싱은 순수 함수(kis-realtime-parser)로 분리 — 테스트로 고정.
 *
 * DOM lib 타입 의존을 피하려 최소 shim({@link WsLike}) 사용.
 *
 * 전역 `WebSocket` 이 없으면 **`ws` 패키지로 폴백**한다. `ws@^8` 은 이 패키지의 런타임 의존성이고
 * 브라우저 호환 이벤트 API(`addEventListener` + `ev.data`)를 제공하므로 {@link WsLike} 를 그대로 만족한다.
 * 로딩은 **동적 import** 다. `ws` 가 없는 환경에서도 이 모듈이 깨지지 않고, 전역이 있으면 불러오지 않는다.
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
 * 전역이 없어도 `ws` 로 붙을 수 있어 **거의 항상 true** 다. false 는 `ws` 조차 못 불러오는 환경뿐이다.
 * `connect` 의 판정과 같은 조건을 유지한다.
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
    url?: string | undefined;
    onTrade?: ((streamSymbol: string, last: number, changePct: number) => void) | undefined;
    onOrderbook?: ((streamSymbol: string, bids: [number, number][], asks: [number, number][]) => void) | undefined;
    /** 구독 응답이 실패(`rt_cd`가 `0`이 아님)면 부른다. 없으면 로그만 남긴다 */
    onSubscribeError?: ((trId: string, trKey: string, message: string) => void) | undefined;
}

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** KIS 연결당 등록 한계 (~41). 초과분은 등록되지 않는다. */
const MAX_REGISTRATIONS = 40;

export class KisPriceWs {
    private ws: WsLike | null = null;
    private subs: KisWsSub[] = [];
    private approvalKey = '';
    private running = false;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    /** `connect()`를 시작할 때마다 늘린다. 기다리는 사이에 이 값이 바뀌면(`stop()`, 다음 `connect()`) 그 호출은 소켓을 만들지 않는다 */
    private connectSeq = 0;

    constructor(private readonly opts: KisPriceWsOptions) {}

    start(subs: KisWsSub[]): void {
        this.subs = subs;
        if (subs.length > MAX_REGISTRATIONS) {
            logger.warn({ count: subs.length, limit: MAX_REGISTRATIONS },
                '[KisPriceWs] 구독 수가 연결당 한계 초과 — 초과분 누락 가능(폴링 폴백 의존)');
        }
        this.running = true;
        this.startConnect();
    }

    stop(): void {
        this.running = false;
        this.connectSeq++;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.dropSocket();
    }

    /** 런타임 구독 갱신 — 연결 상태면 빠진 sub 는 해지(`tr_type` `2`)하고 신규 sub 는 등록한다. */
    updateSubs(subs: KisWsSub[]): void {
        const keyOf = (s: KisWsSub): string => `${s.trId}:${s.trKey}`;
        const previous = this.subs;
        const existing = new Set(previous.map(keyOf));
        const next = new Set(subs.map(keyOf));
        this.subs = subs;
        if (this.ws && this.ws.readyState === WS_OPEN) {
            // 해지를 먼저 보내 연결당 등록 한계에 자리를 낸다.
            for (const s of previous) {
                if (!next.has(keyOf(s))) this.sendSub(s, '2');
            }
            for (const s of subs) {
                if (!existing.has(keyOf(s))) this.sendSub(s, '1');
            }
        }
    }

    isConnected(): boolean {
        return this.ws?.readyState === WS_OPEN;
    }

    /** 지금 소켓을 떼어 내고 닫는다. 떼어 낸 소켓의 이벤트는 처리기가 무시한다. */
    private dropSocket(): void {
        const ws = this.ws;
        this.ws = null;
        try { ws?.close(); } catch { /* ignore */ }
    }

    private startConnect(): void {
        this.connect().catch((err: unknown) => logger.error({ err }, '[KisPriceWs] 연결 실패'));
    }

    private async connect(): Promise<void> {
        const seq = ++this.connectSeq;
        // `await` 뒤마다 확인한다. 그사이 `stop()`이나 다음 `connect()`가 왔으면 소켓을 만들지 않는다.
        const current = (): boolean => this.running && seq === this.connectSeq;
        if (!current()) return;
        this.dropSocket();
        const Ctor = await resolveWsCtor();
        if (!current()) return;
        if (!Ctor) {
            // 여기까지 오면 전역도 `ws` 도 없다 — 재연결해도 달라지지 않으므로 예약하지 않는다.
            logger.error({ nodeVersion: process.version },
                '[KisPriceWs] 전역 WebSocket 도 `ws` 패키지도 없음 — WS 비활성');
            return;
        }
        let approvalKey: string;
        try {
            approvalKey = await this.opts.getApprovalKey();
        } catch (err) {
            if (!current()) return;
            logger.error({ err }, '[KisPriceWs] approval_key 발급 실패 — 재연결 예약');
            this.scheduleReconnect();
            return;
        }
        if (!current()) return;
        this.approvalKey = approvalKey;
        const url = this.opts.url ?? (this.opts.isVirtual ? KIS_WS_DOMAINS.VIRTUAL : KIS_WS_DOMAINS.REAL) + KIS_WS_PATH;
        try {
            const ws = new Ctor(url);
            this.ws = ws;
            // 처리기는 첫 줄에서 자기 소켓이 지금 소켓인지 본다. 떼어 낸 옛 소켓의 늦은 이벤트로 구독이나 재연결을 하지 않는다.
            ws.addEventListener('open', () => {
                if (ws !== this.ws) return;
                this.reconnectAttempts = 0;
                logger.info({ subs: this.subs.length }, '[KisPriceWs] WS 연결 완료 — 구독 등록');
                for (const s of this.subs) this.sendSub(s, '1');
            });
            ws.addEventListener('message', (ev) => {
                if (ws !== this.ws) return;
                this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data ?? ''));
            });
            ws.addEventListener('close', (ev) => {
                if (ws !== this.ws) return;
                if (this.running) {
                    // code/reason/wasClean 없이 "WS 종료" 만 찍으면 정상 종료(서버가
                    // 1000 으로 닫음)와 비정상 종료(네트워크 끊김·서버 거부)를 구별할 수 없다.
                    logger.warn({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean },
                        '[KisPriceWs] WS 종료 — 재연결 예약');
                    this.scheduleReconnect();
                }
            });
            ws.addEventListener('error', (ev) => {
                if (ws !== this.ws) return;
                logger.warn({ err: ev.error, message: ev.message }, '[KisPriceWs] WS 오류');
                // Node 전역 WebSocket 은 핸드셰이크가 실패하면 `error` 만 내고 `close` 를 내지 않으므로 여기서도 재연결을 예약한다.
                // `scheduleReconnect()` 는 예약이 있으면 아무것도 하지 않아 뒤따르는 `close` 와 겹치지 않는다.
                // 실패한 소켓에 `close()` 를 부르면 `error` 가 동기적으로 다시 오므로 이 처리기에서는 닫지 않는다. 다음 `connect()` 가 떼어 낸 뒤 닫는다.
                if (this.running) this.scheduleReconnect();
            });
        } catch (err) {
            logger.error({ err }, '[KisPriceWs] WS 생성 실패 — 재연결 예약');
            this.scheduleReconnect();
        }
    }

    /** 등록(`tr_type` `1`)이나 해지(`2`) 프레임을 보낸다. */
    private sendSub(sub: KisWsSub, trType: '1' | '2'): void {
        if (!this.ws || this.ws.readyState !== WS_OPEN) return;
        const frame = JSON.stringify({
            header: { approval_key: this.approvalKey, custtype: 'P', tr_type: trType, 'content-type': 'utf-8' },
            body: { input: { tr_id: sub.trId, tr_key: sub.trKey } },
        });
        try { this.ws.send(frame); } catch (err) { logger.warn({ err, sub }, '[KisPriceWs] 구독 전송 실패'); }
    }

    private onMessage(raw: string): void {
        if (isPingPong(raw)) {
            try { this.ws?.send(raw); } catch { /* ignore */ }
            return;
        }
        if (raw[0] === '{') {
            this.onSystemMessage(raw);
            return;
        }
        for (const rec of parseKisRealtimeFrame(raw)) {
            const streamSymbol = toStreamSymbol(rec.symbol);
            // 한 건의 콜백이 던져도 나머지 건과 연결은 계속 처리한다.
            try {
                if (rec.kind === 'trade') this.opts.onTrade?.(streamSymbol, rec.last, rec.changePct);
                else this.opts.onOrderbook?.(streamSymbol, rec.bids, rec.asks);
            } catch (err) {
                logger.warn({ err, streamSymbol }, '[KisPriceWs] 콜백 처리 실패');
            }
        }
    }

    /** 구독 응답. 실패(`rt_cd`가 `0`이 아님)면 로그를 남기고 `onSubscribeError`로 알린다. */
    private onSystemMessage(raw: string): void {
        let message: { header?: Record<string, unknown>; body?: { rt_cd?: unknown; msg1?: unknown } };
        try { message = JSON.parse(raw); } catch { return; }
        const body = message.body ?? {};
        if (body.rt_cd === undefined || String(body.rt_cd) === '0') return;
        const trId = String(message.header?.tr_id ?? '');
        const trKey = String(message.header?.tr_key ?? '');
        const text = String(body.msg1 ?? '');
        logger.warn({ trId, trKey, message: text }, '[KisPriceWs] 구독 거부');
        try {
            this.opts.onSubscribeError?.(trId, trKey, text);
        } catch (err) {
            logger.warn({ err, trId, trKey }, '[KisPriceWs] onSubscribeError 처리 실패');
        }
    }

    private scheduleReconnect(): void {
        if (!this.running || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.startConnect(); }, delay);
    }
}
