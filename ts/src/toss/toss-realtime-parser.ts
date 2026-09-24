/**
 * @fileoverview 토스 실시간 시세 WS 프레임 파서 — 순수 함수로 분리해 테스트로 고정한다.
 *
 * 토스 WS는 KIS와 달리 프레임이 전부 JSON이다(파이프 구분 텍스트·암호화가 없다). `type`으로 프레임 종류를
 * 가르고, 시세(`message`)는 `topic`(`trade:{시장}:{심볼}`·`orderbook:{시장}:{심볼}`·`personal:order:{accountSeq}`)으로
 * 채널·시장(또는 계좌)을 가른다.
 */

export interface TossTradeUpdate {
    market: 'us' | 'kr';
    symbol: string;
    price: number;
    volume: number;
    /** 체결 시각(ms). 프레임의 `timestamp`(ISO 8601)를 읽는다. 없거나 못 읽으면 `undefined` 다 */
    timestamp: number | undefined;
}

export interface TossOrderbookUpdate {
    market: 'us' | 'kr';
    symbol: string;
    /** 매수호가(높은 가격순), `[가격, 잔량]`. */
    bids: [number, number][];
    /** 매도호가(낮은 가격순), `[가격, 잔량]`. */
    asks: [number, number][];
    /** 호가 시각(ms). 프레임의 `timestamp`(ISO 8601)를 읽는다 */
    timestamp: number | undefined;
}

export interface TossWsRejection {
    target: string;
    code: string;
    message: string;
}

/**
 * 본인 주문 이벤트. `order`는 `GET /orders/{orderId}` 응답과 같은 모양이되 `execution.filledAt`은 없다 —
 * 원본 그대로 넘긴다(ccxt `Order`로 바꾸는 일은 이 파일의 책임이 아니다. 호출부가 `parseOrder`로 바꾼다).
 */
export interface TossOrderEventUpdate {
    accountSeq: string;
    /** `PENDING`·`PARTIAL_FILL`·`FILL`·`CANCELING`·`CANCELED`·`REPLACING`·`REPLACED`·`REJECTED`·`CANCEL_REJECTED`·`REPLACE_REJECTED`. 미지 값도 온다(스펙 명시). */
    event: string;
    order: Record<string, unknown>;
}

export type TossWsEvent =
    | { kind: 'trade'; data: TossTradeUpdate }
    | { kind: 'orderbook'; data: TossOrderbookUpdate }
    | { kind: 'order'; data: TossOrderEventUpdate }
    | { kind: 'subscriptions'; rejected: TossWsRejection[] }
    | { kind: 'error'; code: string; message: string }
    | { kind: 'pong' }
    | { kind: 'unknown' };

const UNKNOWN: TossWsEvent = { kind: 'unknown' };

function toPriceLevels(value: unknown): [number, number][] {
    if (!Array.isArray(value)) return [];
    const levels: [number, number][] = [];
    for (const row of value) {
        if (typeof row !== 'object' || row === null) continue;
        const price = Number((row as Record<string, unknown>).price);
        const volume = Number((row as Record<string, unknown>).volume);
        if (Number.isFinite(price) && Number.isFinite(volume)) levels.push([price, volume]);
    }
    return levels;
}

const PERSONAL_ORDER_PREFIX = 'personal:order:';

/** 프레임의 ISO 8601 시각 → ms. 없거나 못 읽으면 `undefined` 다. */
function frameTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string') return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}

/** 시세(`message`) 프레임 하나를 옮긴다. `topic`이 `trade:`·`orderbook:`·`personal:order:` 접두가 아니면 `unknown`이다. */
function parseMessageFrame(topic: string, data: Record<string, unknown>): TossWsEvent {
    if (topic.startsWith(PERSONAL_ORDER_PREFIX)) {
        const accountSeq = topic.slice(PERSONAL_ORDER_PREFIX.length);
        const event = typeof data.event === 'string' ? data.event : undefined;
        const order = typeof data.order === 'object' && data.order !== null ? (data.order as Record<string, unknown>) : undefined;
        if (accountSeq === '' || event === undefined || order === undefined) return UNKNOWN;
        return { kind: 'order', data: { accountSeq, event, order } };
    }
    const [channel, market, ...rest] = topic.split(':');
    const symbol = rest.join(':');
    if (symbol === '' || (market !== 'us' && market !== 'kr')) return UNKNOWN;
    if (channel === 'trade') {
        const price = Number(data.price);
        const volume = Number(data.volume);
        if (!Number.isFinite(price) || !Number.isFinite(volume)) return UNKNOWN;
        return { kind: 'trade', data: { market, symbol, price, volume, timestamp: frameTimestamp(data.timestamp) } };
    }
    if (channel === 'orderbook') {
        return { kind: 'orderbook', data: { market, symbol, bids: toPriceLevels(data.bids), asks: toPriceLevels(data.asks), timestamp: frameTimestamp(data.timestamp) } };
    }
    return UNKNOWN;
}

/** 텍스트 프레임 하나를 옮긴다. JSON이 아니거나 알 수 없는 `type`이면 `unknown`이다. */
export function parseTossWsFrame(raw: string): TossWsEvent {
    let payload: unknown;
    try {
        payload = JSON.parse(raw);
    } catch {
        return UNKNOWN;
    }
    if (typeof payload !== 'object' || payload === null) return UNKNOWN;
    const obj = payload as Record<string, unknown>;
    switch (obj.type) {
        case 'pong':
            return { kind: 'pong' };
        case 'subscriptions': {
            const rejected = Array.isArray(obj.rejected) ? (obj.rejected as TossWsRejection[]) : [];
            return { kind: 'subscriptions', rejected };
        }
        case 'error': {
            const error = (obj.error ?? {}) as { code?: string; message?: string };
            return { kind: 'error', code: error.code ?? '', message: error.message ?? '' };
        }
        case 'message': {
            if (typeof obj.topic !== 'string') return UNKNOWN;
            return parseMessageFrame(obj.topic, (obj.data ?? {}) as Record<string, unknown>);
        }
        default:
            return UNKNOWN;
    }
}
