/**
 * @fileoverview 토스 실시간 시세 WebSocket 클라이언트
 *
 * 단일 WS 연결로 체결(`trade:us`·`trade:kr`), 호가(`orderbook:us`·`orderbook:kr`), 본인 주문 이벤트(`personal:order`)를
 * 구독해 콜백으로 emit한다.
 * 공식 AsyncAPI 스펙(`openapi.tossinvest.com/openapi-docs/latest/asyncapi.json`)을 그대로 따른다.
 *
 * - 인증: 연결(handshake) 요청의 `Authorization: Bearer {access_token}` 헤더. REST와 같은 토큰을 쓴다.
 * - 구독: **선언형 full-replace**다. 연결마다, 그리고 구독을 바꿀 때마다 "현재 구독 전체"를 배열 하나로
 *   다시 보낸다(KIS처럼 개별 종목을 추가 등록하는 방식이 아니다). 빈 배열은 전체 해제다.
 * - keepalive: 순수 텍스트 `PING`(60초 권장, JSON 아님)을 보내면 서버가 `{"type":"pong"}`으로 답한다.
 * - 재연결: 지수 백오프. 재연결 전에 이전 소켓을 닫는다(공식 문서 권고 — 안 닫으면 새 연결마다 이전
 *   연결이 밀려나 끊김이 반복될 수 있다).
 * - `rate-limit-exceeded` 에러 프레임을 받으면 1초 뒤 구독을 다시 선언한다(공식 문서 권고 값).
 *
 * ## `ws` 패키지가 필수다 — KIS와 다르다
 *
 * 표준(WHATWG) `WebSocket` 생성자는 커스텀 헤더를 실을 방법이 없다(브라우저·Node 21+ 네이티브 구현
 * 공통 제약 — subprotocol만 가능하다). 토스 인증은 handshake HTTP 헤더로 하므로, 헤더를 세 번째 인자
 * (`{ headers }`)로 받는 `ws` 패키지가 없으면 이 클라이언트는 연결할 수 없다. KIS(`kis-price-ws.ts`)처럼
 * 전역 `WebSocket`을 우선하고 `ws`로 폴백하는 방식이 아니라 `ws` 하나로 고정한다.
 */

import { logger } from '../logger';
import { parseTossWsFrame } from './toss-realtime-parser';

interface WsEventLike {
    data?: unknown;
    error?: unknown;
    message?: string;
    code?: number;
    reason?: string;
    wasClean?: boolean;
}

export interface WsLike {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: string, cb: (ev: WsEventLike) => void): void;
}
export type WsCtor = new (url: string, options?: { headers?: Record<string, string> }) => WsLike;
const WS_OPEN = 1;

let wsCtorCache: WsCtor | null | undefined;
async function resolveWsCtor(): Promise<WsCtor | null> {
    if (wsCtorCache !== undefined) return wsCtorCache;
    try {
        const mod = await import('ws');
        const Ctor = ((mod as { WebSocket?: unknown }).WebSocket ?? (mod as { default?: unknown }).default) as WsCtor | undefined;
        wsCtorCache = typeof Ctor === 'function' ? Ctor : null;
    } catch (err) {
        logger.error({ err }, '[TossPriceWs] `ws` 패키지 로드 실패 — WS 비활성');
        wsCtorCache = null;
    }
    return wsCtorCache;
}

/** 이 런타임에서 토스 WS 구독이 가능한가(`ws` 패키지를 불러올 수 있는가). */
export async function isTossWsSupported(): Promise<boolean> {
    return (await resolveWsCtor()) !== null;
}

/**
 * 테스트 전용 — 동적 `import('ws')` 를 거치지 않고 생성자를 직접 주입한다. `null` 로 리셋한다.
 *
 * `vi.mock('ws', ...)` 로 모듈을 가로채도 fake timer(`vi.useFakeTimers`)와 동적 import 의 프라미스
 * 해석 순서가 맞물려 `advanceTimersByTimeAsync` 로는 안정적으로 플러시되지 않는다. 이 훅으로
 * 캐시를 직접 채워 그 경합을 피한다.
 */
export function __setWsCtorForTests(ctor: WsCtor | null): void {
    wsCtorCache = ctor;
}

const WSS_URL = 'wss://openapi-ws.tossinvest.com/ws/v1';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 60_000;
/** 연결당 구독 한계(공식 문서, `codes` 합산). 초과분은 서버가 `too-many-topics`로 거부한다. */
const MAX_SUBSCRIPTIONS = 100;
/** `rate-limit-exceeded` 뒤 재선언까지 대기(공식 문서 권고값). */
const RATE_LIMIT_RETRY_MS = 1_000;

export interface TossWsMarketSub {
    channel: 'trade' | 'orderbook';
    market: 'us' | 'kr';
    /** 토스 종목 코드 원본 그대로(미국은 대문자 티커, 국내는 6자리 숫자) — ccxt 통합 심볼이 아니다. */
    symbol: string;
}

/** 본인 주문 이벤트 구독. `codes`에 종목이 아니라 계좌 `accountSeq`(`GET /accounts` 응답 값을 문자열로)를 넣는다. */
export interface TossWsOrderSub {
    channel: 'order';
    accountSeq: string;
}

export type TossWsSub = TossWsMarketSub | TossWsOrderSub;

export interface TossPriceWsOptions {
    getAccessToken: () => Promise<string>;
    /** `timestamp` 는 체결 시각(ms)이다. 프레임에 없으면 `undefined` 다 */
    onTrade?: (market: 'us' | 'kr', symbol: string, price: number, volume: number, timestamp: number | undefined) => void;
    onOrderbook?: (market: 'us' | 'kr', symbol: string, bids: [number, number][], asks: [number, number][], timestamp: number | undefined) => void;
    /** `order`는 `GET /orders/{orderId}` 응답과 같은 모양(원본). ccxt `Order`로 바꾸려면 `exchange.parseOrder(order)`를 호출부에서 부른다. */
    onOrder?: (accountSeq: string, event: string, order: Record<string, unknown>) => void;
}

export class TossPriceWs {
    private ws: WsLike | null = null;
    private subs: TossWsSub[] = [];
    private running = false;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;

    constructor(private readonly opts: TossPriceWsOptions) {}

    start(subs: TossWsSub[]): void {
        this.subs = subs;
        if (subs.length > MAX_SUBSCRIPTIONS) {
            logger.warn({ count: subs.length, limit: MAX_SUBSCRIPTIONS },
                '[TossPriceWs] 구독 수가 연결당 한계 초과 — 초과분 누락 가능');
        }
        this.running = true;
        void this.connect();
    }

    stop(): void {
        this.running = false;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.stopPing();
        try { this.ws?.close(); } catch { /* ignore */ }
        this.ws = null;
    }

    /** 구독을 통째로 바꾼다(선언형 full-replace라 KIS처럼 신규분만 추가하지 않는다). */
    updateSubs(subs: TossWsSub[]): void {
        this.subs = subs;
        if (this.ws && this.ws.readyState === WS_OPEN) this.declare();
    }

    isConnected(): boolean {
        return this.ws?.readyState === WS_OPEN;
    }

    private async connect(): Promise<void> {
        if (!this.running) return;
        const Ctor = await resolveWsCtor();
        if (!Ctor) {
            logger.error({ nodeVersion: process.version }, '[TossPriceWs] `ws` 패키지 없음 — WS 비활성');
            return;
        }
        let accessToken: string;
        try {
            accessToken = await this.opts.getAccessToken();
        } catch (err) {
            logger.error({ err }, '[TossPriceWs] 액세스 토큰 발급 실패 — 재연결 예약');
            this.scheduleReconnect();
            return;
        }
        // 재연결 전에 이전 연결을 닫는다(공식 문서 권고 — 안 닫으면 새 연결마다 이전 연결이 밀려난다).
        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }
        try {
            const ws = new Ctor(WSS_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
            this.ws = ws;
            ws.addEventListener('open', () => {
                this.reconnectAttempts = 0;
                logger.info({ subs: this.subs.length }, '[TossPriceWs] WS 연결 완료 — 구독 선언');
                this.declare();
                this.startPing();
            });
            ws.addEventListener('message', (ev) => {
                this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data ?? ''));
            });
            ws.addEventListener('close', (ev) => {
                this.stopPing();
                if (this.running) {
                    logger.warn({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean }, '[TossPriceWs] WS 종료 — 재연결 예약');
                    this.scheduleReconnect();
                }
            });
            ws.addEventListener('error', (ev) => {
                logger.warn({ err: ev.error, message: ev.message }, '[TossPriceWs] WS 오류');
                if (this.running) this.scheduleReconnect();
            });
        } catch (err) {
            logger.error({ err }, '[TossPriceWs] WS 생성 실패 — 재연결 예약');
            this.scheduleReconnect();
        }
    }

    /** 현재 구독 전체를 채널(·시장 또는 계좌)별로 묶어 한 번에 선언한다(선언형 full-replace). */
    private declare(): void {
        if (!this.ws || this.ws.readyState !== WS_OPEN) return;
        const grouped = new Map<string, string[]>();
        for (const sub of this.subs) {
            const [key, code] = sub.channel === 'order' ? ['personal:order', sub.accountSeq] : [`${sub.channel}:${sub.market}`, sub.symbol];
            const codes = grouped.get(key) ?? [];
            codes.push(code);
            grouped.set(key, codes);
        }
        const frame = Array.from(grouped.entries(), ([type, codes]) => ({ type, codes }));
        try { this.ws.send(JSON.stringify(frame)); } catch (err) { logger.warn({ err }, '[TossPriceWs] 구독 선언 전송 실패'); }
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            try { this.ws?.send('PING'); } catch { /* ignore */ }
        }, PING_INTERVAL_MS);
    }

    private stopPing(): void {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    }

    private onMessage(raw: string): void {
        const event = parseTossWsFrame(raw);
        switch (event.kind) {
            case 'trade':
                this.opts.onTrade?.(event.data.market, event.data.symbol, event.data.price, event.data.volume, event.data.timestamp);
                break;
            case 'orderbook':
                this.opts.onOrderbook?.(event.data.market, event.data.symbol, event.data.bids, event.data.asks, event.data.timestamp);
                break;
            case 'order':
                this.opts.onOrder?.(event.data.accountSeq, event.data.event, event.data.order);
                break;
            case 'subscriptions':
                if (event.rejected.length > 0) logger.warn({ rejected: event.rejected }, '[TossPriceWs] 일부 구독이 거부됐다');
                break;
            case 'error':
                logger.warn({ code: event.code, message: event.message }, '[TossPriceWs] 에러 프레임');
                if (event.code === 'rate-limit-exceeded') setTimeout(() => this.declare(), RATE_LIMIT_RETRY_MS);
                break;
            case 'pong':
            case 'unknown':
                break;
        }
    }

    private scheduleReconnect(): void {
        if (!this.running || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
    }
}
