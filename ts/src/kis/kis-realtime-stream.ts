/**
 * @fileoverview KIS 실시간(웹소켓) 범용 구독.
 *
 * 기존 `KisPriceWs`는 체결, 호가 세 TR 만 가격으로 해석하고 나머지 프레임을 버린다. 이 클래스는 어떤 TR 이든 구독과 해지를 하고,
 * 수신한 값을 `KIS_REALTIME_COLUMNS`의 필드 이름으로 묶어 원문 문자열 그대로 넘긴다. 체결통보(맨 앞이 `1`)는 구독 응답이 준
 * key 와 iv 로 AES-CBC 복호한 뒤 같은 방식으로 읽는다(공식 예제 `kis_auth.py`의 `aes_cbc_base64_dec`와 같다).
 */
import { logger } from '../logger';
import { KIS_WS_DOMAINS, KIS_WS_PATH } from './kis-types';
import { isPingPong } from './kis-realtime-parser';
import { resolveWsCtor, type KisWsSub, type WsLike } from './kis-price-ws';
import { kisRealtimeColumns } from './kis-realtime-columns';

const WS_OPEN = 1;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** KIS 연결당 등록 한계(`KisPriceWs`와 같다). 넘으면 경고만 남기고 등록한다. */
const MAX_REGISTRATIONS = 40;

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
    /** 구독 응답이 실패(`rt_cd`가 `0`이 아님)면 부른다 */
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
    private ws: WsLike | null = null;
    private readonly subs = new Map<string, KisWsSub>();
    private readonly cipherKeys = new Map<string, { key: string; iv: string }>();
    private approvalKey = '';
    private running = false;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** `connect()`를 시작할 때마다 늘린다. 기다리는 사이에 이 값이 바뀌면(`stop()`, 다음 `connect()`) 그 호출은 소켓을 만들지 않는다 */
    private connectSeq = 0;

    constructor(private readonly opts: KisRealtimeStreamOptions) {}

    /** 구독을 등록한다. 처음 부르면 접속하고, 접속 뒤에는 바로 등록 프레임(`tr_type` `1`)을 보낸다. 같은 구독은 한 번만 보낸다. */
    subscribe(trId: string, trKey: string): void {
        const id = `${trId}|${trKey}`;
        if (this.subs.has(id)) return;
        if (this.subs.size >= MAX_REGISTRATIONS) logger.warn({ trId, trKey, subs: this.subs.size }, '[KisRealtimeStream] 연결당 등록 한계를 넘는다');
        this.subs.set(id, { trId, trKey });
        if (!this.running) {
            this.running = true;
            this.startConnect();
            return;
        }
        this.send(trId, trKey, '1');
    }

    /** 구독을 해지한다(`tr_type` `2`). */
    unsubscribe(trId: string, trKey: string): void {
        if (!this.subs.delete(`${trId}|${trKey}`)) return;
        this.send(trId, trKey, '2');
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

    /** 지금 소켓을 떼어 내고 닫는다. 떼어 낸 소켓의 이벤트는 처리기가 무시한다. */
    private dropSocket(): void {
        const ws = this.ws;
        this.ws = null;
        try { ws?.close(); } catch { /* 이미 닫혔다 */ }
    }

    private startConnect(): void {
        this.connect().catch((err: unknown) => logger.error({ err }, '[KisRealtimeStream] 연결 실패'));
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
            logger.error({}, '[KisRealtimeStream] 전역 WebSocket 도 `ws` 패키지도 없음 — 구독하지 않는다');
            return;
        }
        let approvalKey: string;
        try {
            approvalKey = await this.opts.getApprovalKey();
        } catch (err) {
            if (!current()) return;
            logger.error({ err }, '[KisRealtimeStream] approval_key 발급 실패 — 재연결 예약');
            this.scheduleReconnect();
            return;
        }
        if (!current()) return;
        this.approvalKey = approvalKey;
        const url = this.opts.url ?? (this.opts.isVirtual ? KIS_WS_DOMAINS.VIRTUAL : KIS_WS_DOMAINS.REAL) + KIS_WS_PATH;
        let ws: WsLike;
        try {
            ws = new Ctor(url);
        } catch (err) {
            logger.error({ err }, '[KisRealtimeStream] WS 생성 실패 — 재연결 예약');
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        // 처리기는 첫 줄에서 자기 소켓이 지금 소켓인지 본다. 떼어 낸 옛 소켓의 늦은 이벤트로 구독이나 재연결을 하지 않는다.
        ws.addEventListener('open', () => {
            if (ws !== this.ws) return;
            this.reconnectAttempts = 0;
            for (const sub of this.subs.values()) this.send(sub.trId, sub.trKey, '1');
        });
        ws.addEventListener('message', (ev) => {
            if (ws !== this.ws) return;
            this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data ?? ''));
        });
        ws.addEventListener('close', (ev) => {
            if (ws !== this.ws || !this.running) return;
            logger.warn({ code: ev.code, reason: ev.reason }, '[KisRealtimeStream] 연결 종료 — 재연결 예약');
            this.scheduleReconnect();
        });
        ws.addEventListener('error', (ev) => {
            if (ws !== this.ws) return;
            logger.warn({ message: ev.message }, '[KisRealtimeStream] 연결 오류 — 재연결 예약');
            this.scheduleReconnect();
        });
    }

    private send(trId: string, trKey: string, trType: '1' | '2'): void {
        if (!this.ws || this.ws.readyState !== WS_OPEN) return;
        const frame = JSON.stringify({
            header: { approval_key: this.approvalKey, custtype: 'P', tr_type: trType, 'content-type': 'utf-8' },
            body: { input: { tr_id: trId, tr_key: trKey } },
        });
        try { this.ws.send(frame); } catch (err) { logger.warn({ err, trId, trKey }, '[KisRealtimeStream] 구독 전송 실패'); }
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
        this.onData(raw).catch((err: unknown) => logger.error({ err }, '[KisRealtimeStream] 실시간 프레임 처리 실패'));
    }

    /** 구독 응답. 실패면 그 구독을 지우고 알린다. 성공이면 체결통보의 복호 key 와 iv 를 TR 별로 기억한다. */
    private onSystemMessage(raw: string): void {
        let message: { header?: Record<string, unknown>; body?: { rt_cd?: unknown; msg1?: unknown; output?: Record<string, unknown> } };
        try { message = JSON.parse(raw); } catch { return; }
        const trId = String(message.header?.tr_id ?? '');
        const body = message.body ?? {};
        if (body.rt_cd !== undefined && String(body.rt_cd) !== '0') {
            const trKey = String(message.header?.tr_key ?? '');
            // 거부된 구독을 남겨 두면 같은 구독을 다시 불러도 등록 프레임을 보내지 않는다.
            this.subs.delete(`${trId}|${trKey}`);
            try {
                this.opts.onSubscribeError?.(trId, trKey, String(body.msg1 ?? ''));
            } catch (err) {
                logger.warn({ err, trId, trKey }, '[KisRealtimeStream] onSubscribeError 처리 실패');
            }
            return;
        }
        const key = body.output?.key;
        const iv = body.output?.iv;
        if (typeof key === 'string' && typeof iv === 'string' && key !== '' && iv !== '') this.cipherKeys.set(trId, { key, iv });
    }

    private async onData(raw: string): Promise<void> {
        const parts = raw.split('|');
        if (parts.length < 4) return;
        const [flag, trId, countText] = parts;
        let payload = parts.slice(3).join('|');
        // KIS 실시간 연결은 평문이다. 체결통보는 늘 암호화되어 오므로, 평문 체결통보는 경로 위에서 끼워 넣은 프레임으로 보고 버린다.
        if (flag !== '1' && ENCRYPTED_NOTICE_TRS.has(trId)) {
            logger.warn({ trId }, '[KisRealtimeStream] 암호화되지 않은 체결통보 프레임 — 버린다');
            return;
        }
        if (flag === '1') {
            const cipher = this.cipherKeys.get(trId);
            if (cipher === undefined) {
                logger.warn({ trId }, '[KisRealtimeStream] 복호 key 를 받기 전에 암호화 프레임이 왔다 — 버린다');
                return;
            }
            try {
                payload = await decryptKisPayload(payload, cipher.key, cipher.iv);
            } catch (err) {
                logger.warn({ err, trId }, '[KisRealtimeStream] 복호 실패 — 버린다');
                return;
            }
        }
        for (const record of splitKisRealtimeRecords(trId, Number(countText), payload)) {
            // 한 건의 콜백이 던져도 나머지 건과 연결은 계속 처리한다.
            try {
                this.opts.onRecord(record);
            } catch (err) {
                logger.warn({ err, trId }, '[KisRealtimeStream] onRecord 처리 실패');
            }
        }
    }

    private scheduleReconnect(): void {
        if (!this.running || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.startConnect(); }, delay);
    }
}
