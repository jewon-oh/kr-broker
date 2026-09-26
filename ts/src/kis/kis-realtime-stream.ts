/**
 * @fileoverview KIS 실시간(웹소켓) 연결과 범용 구독.
 *
 * 연결과 재접속, 구독 등록, PINGPONG 되돌림을 이 클래스가 맡는다. 체결가, 호가 스트림(`KisPriceWs`)도 이 연결을 쓰고 프레임 해석만 다르다.
 *
 * - 인증: approval_key. 접속할 때마다 `getApprovalKey()`를 부른다(캐시가 유효하면 같은 키).
 * - 재접속: 2초에서 30초까지 지수 백오프로 다시 잇고, 구독을 모두 다시 등록한다.
 * - PINGPONG: 받은 프레임을 그대로 되돌려 보낸다.
 *
 * 어떤 TR 이든 구독과 해지를 하고, 수신한 값을 `KIS_REALTIME_COLUMNS`의 필드 이름으로 묶어 원문 문자열 그대로 넘긴다. 체결통보(맨 앞이 `1`)는
 * 구독 응답이 준 key 와 iv 로 AES-CBC 복호한 뒤 같은 방식으로 읽는다(공식 예제 `kis_auth.py`의 `aes_cbc_base64_dec`와 같다).
 *
 * DOM lib 타입 의존을 피하려 최소 shim({@link WsLike}) 사용.
 *
 * 전역 `WebSocket` 이 없으면 **`ws` 패키지로 폴백**한다. `ws@^8` 은 이 패키지의 런타임 의존성이고
 * 브라우저 호환 이벤트 API(`addEventListener` + `ev.data`)를 제공하므로 {@link WsLike} 를 그대로 만족한다.
 * 로딩은 **동적 import** 다. `ws` 가 없는 환경에서도 이 모듈이 깨지지 않고, 전역이 있으면 불러오지 않는다.
 */
import { logger } from '../logger';
import { KIS_WS_DOMAINS, KIS_WS_PATH } from './kis-types';
import { isPingPong } from './kis-realtime-parser';
import { kisRealtimeColumns } from './kis-realtime-columns';

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
 *
 * @deprecated 라이브러리 안에서 쓰지 않는다. 다음 판에서 지운다.
 */
export async function isKisWsSupported(): Promise<boolean> {
    return (await resolveWsCtor()) !== null;
}

/**
 * 전역 WebSocket 을 쓰는가 — 폴백(`ws`)과 구별해 로그에 사실대로 남기기 위함.
 *
 * @deprecated 라이브러리 안에서 쓰지 않는다. 다음 판에서 지운다.
 */
export function isUsingGlobalWebSocket(): boolean {
    return globalWsCtor() !== undefined;
}

export interface KisWsSub {
    /** 실시간 TR (예: H0STCNT0, H0STASP0, HDFSCNT0) */
    trId: string;
    /** 구독 키 — 국내: 종목코드(005930), 해외: D+거래소+심볼(DNASAAPL), 체결통보: HTS ID */
    trKey: string;
}

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** KIS 연결당 등록 한계(~41). 넘는 구독은 등록되지 않는다. */
export const KIS_WS_MAX_REGISTRATIONS = 40;

const subId = (sub: KisWsSub): string => `${sub.trId}|${sub.trKey}`;

/** 실시간 수신 한 건. */
export interface KisRealtimeRecord {
    trId: string;
    /** 필드 순서대로의 원문 값 */
    values: string[];
    /** 필드 이름을 아는 TR 이면 이름으로 묶은 값. 모르는 TR 이면 `undefined`다 */
    fields: Record<string, string> | undefined;
}

/** 늘 암호화되어 오는 체결통보 TR(국내, 해외, 실전, 모의). */
const ENCRYPTED_NOTICE_TRS: ReadonlySet<string> = new Set(['H0STCNI0', 'H0STCNI9', 'H0GSCNI0', 'H0GSCNI9']);

export interface KisRealtimeStreamOptions {
    getApprovalKey: () => Promise<string>;
    isVirtual: boolean;
    /** 접속 주소. 없으면 `isVirtual` 에 따라 KIS 기본 주소다. */
    url?: string | undefined;
    onRecord: (record: KisRealtimeRecord) => void;
    /** 구독 응답이 실패(`rt_cd`가 `0`이 아님)면 부른다. 없으면 로그만 남긴다 */
    onSubscribeError?: ((trId: string, trKey: string, message: string) => void) | undefined;
}

/**
 * 수신 값을 건수만큼 나눈다. 값 수가 건수로 나눠떨어지면 그 몫으로 자른다. 나눠떨어지지 않으면 필드 이름을 아는 TR 은 필드 수로 자르고,
 * 값이 모자라거나 모르는 TR 이면 전체 값 수를 건수로 나눈 길이로 자른다. 필드 이름은 위치대로 붙인다.
 */
export function splitKisRealtimeRecords(trId: string, count: number, payload: string): KisRealtimeRecord[] {
    const values = payload.split('^');
    const columns = kisRealtimeColumns(trId);
    const n = Number.isInteger(count) && count > 0 ? count : 1;
    // KIS 가 필드를 뒤에 더해도 두 번째 건부터 어긋나지 않게 필드 수보다 값 수를 먼저 믿는다.
    const size = values.length % n === 0 ? values.length / n
        : columns !== undefined && columns.length * n <= values.length ? columns.length : Math.floor(values.length / n);
    if (size <= 0) return [];
    const records: KisRealtimeRecord[] = [];
    for (let i = 0; i < n; i++) {
        const chunk = values.slice(i * size, (i + 1) * size);
        const fields = columns === undefined
            ? undefined
            : Object.fromEntries(columns.flatMap((column, j) => (chunk[j] === undefined ? [] : [[column, chunk[j]]])));
        records.push({ trId, values: chunk, fields });
    }
    return records;
}

/** 체결통보 본문 복호. base64 암호문을 key, iv(구독 응답의 UTF-8 문자열)로 AES-CBC(PKCS7) 복호한다. */
export async function decryptKisPayload(cipherText: string, key: string, iv: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) throw new Error('WebCrypto(crypto.subtle)가 없어 체결통보를 복호할 수 없다');
    const encoder = new TextEncoder();
    const cryptoKey = await subtle.importKey('raw', encoder.encode(key), { name: 'AES-CBC' }, false, ['decrypt']);
    const data = Uint8Array.from(atob(cipherText), (c) => c.charCodeAt(0));
    const plain = await subtle.decrypt({ name: 'AES-CBC', iv: encoder.encode(iv) }, cryptoKey, data);
    return new TextDecoder().decode(plain);
}

export class KisRealtimeStream {
    /** 로그 머리. `KisPriceWs`는 자기 이름으로 바꾼다 */
    protected readonly label: string = '[KisRealtimeStream]';
    private ws: WsLike | null = null;
    /** 등록할 구독. 다시 접속하면 이 순서대로 모두 다시 등록한다 */
    private readonly subs = new Map<string, KisWsSub>();
    /** 구독 응답이 거부한 구독. 목록에는 남아 다시 접속하면 다시 등록하고, 다시 `subscribe`하면 등록 프레임을 또 보낸다 */
    private readonly rejected = new Set<string>();
    private readonly cipherKeys = new Map<string, { key: string; iv: string }>();
    private approvalKey = '';
    private running = false;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** `connect()`를 시작할 때마다 늘린다. 기다리는 사이에 이 값이 바뀌면(`stop()`, 다음 `connect()`) 그 호출은 소켓을 만들지 않는다 */
    private connectSeq = 0;

    constructor(private readonly opts: KisRealtimeStreamOptions) {}

    /** 구독을 등록한다. 처음 부르면 접속하고, 접속 뒤에는 바로 등록 프레임(`tr_type` `1`)을 보낸다. 같은 구독은 거부되지 않았으면 한 번만 보낸다. */
    subscribe(trId: string, trKey: string): void {
        const sub = { trId, trKey };
        const id = subId(sub);
        if (this.subs.has(id)) {
            if (!this.rejected.delete(id)) return;
        } else {
            if (this.subs.size >= KIS_WS_MAX_REGISTRATIONS) logger.warn({ trId, trKey, subs: this.subs.size }, `${this.label} 연결당 등록 한계를 넘는다`);
            this.subs.set(id, sub);
        }
        if (!this.running) {
            this.running = true;
            this.startConnect();
            return;
        }
        this.send(sub, '1');
    }

    /** 구독을 해지한다(`tr_type` `2`). */
    unsubscribe(trId: string, trKey: string): void {
        const sub = { trId, trKey };
        const id = subId(sub);
        this.rejected.delete(id);
        if (!this.subs.delete(id)) return;
        this.send(sub, '2');
    }

    stop(): void {
        this.running = false;
        this.connectSeq++;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.dropSocket();
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WS_OPEN;
    }

    /** 구독 목록을 `subs`로 바꾸고 새로 접속한다. 접속 중이면 끊고 다시 잇고, 기다리던 재접속은 거둔다. */
    protected restart(subs: readonly KisWsSub[]): void {
        this.subs.clear();
        this.rejected.clear();
        for (const sub of subs) this.subs.set(subId(sub), sub);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.running = true;
        this.startConnect();
    }

    /** 구독 목록을 `subs`로 바꾼다. 접속 중이면 빠진 구독은 해지하고 새 구독은 등록한다. 다시 접속하면 `subs` 순서대로 등록한다. */
    protected replaceSubs(subs: readonly KisWsSub[]): void {
        const previous = new Map(this.subs);
        this.subs.clear();
        for (const sub of subs) this.subs.set(subId(sub), sub);
        // 해지를 먼저 보내 연결당 등록 한계에 자리를 낸다.
        for (const [id, sub] of previous) {
            if (this.subs.has(id)) continue;
            this.rejected.delete(id);
            this.send(sub, '2');
        }
        for (const [id, sub] of this.subs) {
            if (!previous.has(id)) this.send(sub, '1');
        }
    }

    /** 복호를 마친 데이터 프레임 하나. 건수대로 나눠 `onRecord`에 넘긴다. */
    protected onFrame(trId: string, countText: string, payload: string): void {
        for (const record of splitKisRealtimeRecords(trId, Number(countText), payload)) {
            // 한 건의 콜백이 던져도 나머지 건과 연결은 계속 처리한다.
            try {
                this.opts.onRecord(record);
            } catch (err) {
                logger.warn({ err, trId }, `${this.label} onRecord 처리 실패`);
            }
        }
    }

    /** 지금 소켓을 떼어 내고 닫는다. 떼어 낸 소켓의 이벤트는 처리기가 무시한다. */
    private dropSocket(): void {
        const ws = this.ws;
        this.ws = null;
        try { ws?.close(); } catch { /* 이미 닫혔다 */ }
    }

    private startConnect(): void {
        this.connect().catch((err: unknown) => logger.error({ err }, `${this.label} 연결 실패`));
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
            logger.error({ nodeVersion: process.version }, `${this.label} 전역 WebSocket 도 \`ws\` 패키지도 없음 — WS 비활성`);
            return;
        }
        let approvalKey: string;
        try {
            approvalKey = await this.opts.getApprovalKey();
        } catch (err) {
            if (!current()) return;
            logger.error({ err }, `${this.label} approval_key 발급 실패 — 재연결 예약`);
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
                this.rejected.clear();
                logger.info({ subs: this.subs.size }, `${this.label} WS 연결 완료 — 구독 등록`);
                for (const sub of this.subs.values()) this.send(sub, '1');
            });
            ws.addEventListener('message', (ev) => {
                if (ws !== this.ws) return;
                this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data ?? ''));
            });
            ws.addEventListener('close', (ev) => {
                if (ws !== this.ws || !this.running) return;
                // code/reason/wasClean 없이 "WS 종료" 만 찍으면 정상 종료(서버가
                // 1000 으로 닫음)와 비정상 종료(네트워크 끊김·서버 거부)를 구별할 수 없다.
                logger.warn({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean }, `${this.label} WS 종료 — 재연결 예약`);
                this.scheduleReconnect();
            });
            ws.addEventListener('error', (ev) => {
                if (ws !== this.ws) return;
                logger.warn({ err: ev.error, message: ev.message }, `${this.label} WS 오류`);
                // Node 전역 WebSocket 은 핸드셰이크가 실패하면 `error` 만 내고 `close` 를 내지 않으므로 여기서도 재연결을 예약한다.
                // `scheduleReconnect()` 는 예약이 있으면 아무것도 하지 않아 뒤따르는 `close` 와 겹치지 않는다.
                // 실패한 소켓에 `close()` 를 부르면 `error` 가 동기적으로 다시 오므로 이 처리기에서는 닫지 않는다. 다음 `connect()` 가 떼어 낸 뒤 닫는다.
                this.scheduleReconnect();
            });
        } catch (err) {
            logger.error({ err }, `${this.label} WS 생성 실패 — 재연결 예약`);
            this.scheduleReconnect();
        }
    }

    /** 등록(`tr_type` `1`)이나 해지(`2`) 프레임을 보낸다. */
    private send(sub: KisWsSub, trType: '1' | '2'): void {
        if (!this.ws || this.ws.readyState !== WS_OPEN) return;
        const frame = JSON.stringify({
            header: { approval_key: this.approvalKey, custtype: 'P', tr_type: trType, 'content-type': 'utf-8' },
            body: { input: { tr_id: sub.trId, tr_key: sub.trKey } },
        });
        try { this.ws.send(frame); } catch (err) { logger.warn({ err, sub }, `${this.label} 구독 전송 실패`); }
    }

    private onMessage(raw: string): void {
        if (isPingPong(raw)) {
            try { this.ws?.send(raw); } catch { /* 연결이 닫혔다 */ }
            return;
        }
        if (raw[0] === '{') {
            this.onSystemMessage(raw);
            return;
        }
        this.onData(raw).catch((err: unknown) => logger.error({ err }, `${this.label} 실시간 프레임 처리 실패`));
    }

    /** 구독 응답. 실패면 로그를 남기고 알린다. 성공이면 체결통보의 복호 key 와 iv 를 TR 별로 기억한다. */
    private onSystemMessage(raw: string): void {
        let message: { header?: Record<string, unknown>; body?: { rt_cd?: unknown; msg1?: unknown; output?: Record<string, unknown> } };
        try { message = JSON.parse(raw); } catch { return; }
        const trId = String(message.header?.tr_id ?? '');
        const body = message.body ?? {};
        if (body.rt_cd !== undefined && String(body.rt_cd) !== '0') {
            const trKey = String(message.header?.tr_key ?? '');
            const text = String(body.msg1 ?? '');
            logger.warn({ trId, trKey, message: text }, `${this.label} 구독 거부`);
            const id = subId({ trId, trKey });
            if (this.subs.has(id)) this.rejected.add(id);
            try {
                this.opts.onSubscribeError?.(trId, trKey, text);
            } catch (err) {
                logger.warn({ err, trId, trKey }, `${this.label} onSubscribeError 처리 실패`);
            }
            return;
        }
        const key = body.output?.key;
        const iv = body.output?.iv;
        if (typeof key === 'string' && typeof iv === 'string' && key !== '' && iv !== '') this.cipherKeys.set(trId, { key, iv });
    }

    private async onData(raw: string): Promise<void> {
        const parts = raw.split('|');
        const [flag, trId, countText] = parts;
        if (parts.length < 4 || trId === undefined || countText === undefined) return;
        let payload = parts.slice(3).join('|');
        // KIS 실시간 연결은 평문이다. 체결통보는 늘 암호화되어 오므로, 평문 체결통보는 경로 위에서 끼워 넣은 프레임으로 보고 버린다.
        if (flag !== '1' && ENCRYPTED_NOTICE_TRS.has(trId)) {
            logger.warn({ trId }, `${this.label} 암호화되지 않은 체결통보 프레임 — 버린다`);
            return;
        }
        if (flag === '1') {
            const cipher = this.cipherKeys.get(trId);
            if (cipher === undefined) {
                logger.warn({ trId }, `${this.label} 복호 key 를 받기 전에 암호화 프레임이 왔다 — 버린다`);
                return;
            }
            try {
                payload = await decryptKisPayload(payload, cipher.key, cipher.iv);
            } catch (err) {
                logger.warn({ err, trId }, `${this.label} 복호 실패 — 버린다`);
                return;
            }
        }
        this.onFrame(trId, countText, payload);
    }

    private scheduleReconnect(): void {
        if (!this.running || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.startConnect(); }, delay);
    }
}
