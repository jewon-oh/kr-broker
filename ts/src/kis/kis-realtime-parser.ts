/**
 * @fileoverview KIS 실시간 WebSocket 프레임 파서 (순수 함수)
 *
 * 프레임 형식: `<encrypt>|<tr_id>|<count>|<body(^ 구분)>`.
 * - JSON(`{`로 시작: 구독 응답/PINGPONG)·빈 프레임 → [].
 * - 체결(H0STCNT0/HDFSCNT0) / 호가(H0STASP0) record 배열 반환(raw 종목코드).
 *
 * 필드 인덱스는 kis-types 의 KIS_WS_FIELD 상수 참조 — 실연결 검증 시 그 상수만 수정하면 된다.
 * 순수 함수라 단위 테스트로 레이아웃을 고정한다(kis-realtime-parser.test).
 */

import { COMMON_STOCK_CODES, commonStockCode } from '../broker-market-group';
import { KIS_WS_TR, KIS_WS_FIELD, isOverseasSymbol } from './kis-types';

export interface KisTradeRecord {
    kind: 'trade';
    /** raw 종목코드 (국내: 005930, 해외: AAPL) */
    symbol: string;
    last: number;
    changePct: number;
}

export interface KisOrderbookRecord {
    kind: 'orderbook';
    symbol: string;
    /** best-first [price, qty] */
    bids: [number, number][];
    asks: [number, number][];
}

export type KisRealtimeRecord = KisTradeRecord | KisOrderbookRecord;

/**
 * 실시간 raw 종목코드 → 체결가·호가 콜백의 심볼.
 * 국내(6자리) → `<code>/KRW`, 해외(ticker) → `<TICKER>/USD`. 현금 코드와 같은 티커는 표(`codes`)의 통합 코드를 쓴다(`USD` → `ProShares Ultra Semiconductors/USD`).
 */
export function toStreamSymbol(rawSymbol: string, codes: Readonly<Record<string, string>> = COMMON_STOCK_CODES): string {
    const code = rawSymbol.toUpperCase();
    return isOverseasSymbol(code) ? `${commonStockCode(code, codes)}/${OVERSEAS_STREAM_QUOTE}` : `${code}/KRW`;
}

/**
 * 해외 주식 스트림 quote — **`USD` 이지 `USDT` 가 아니다**. 통합 심볼(`AAPL/USD`)과 같게 두어,
 * 주식을 토큰화한 스테이블코인 페어(`AMD/USDT`)와 겹치지 않는다.
 */
export const OVERSEAS_STREAM_QUOTE = 'USD';

/**
 * KIS 실시간 프레임 1개를 record 배열로 파싱 (제어/빈/미지원 프레임 → []).
 *
 * @deprecated 라이브러리 안에서 쓰지 않는다. 연결은 복호한 본문을 `parseKisRealtimePayload` 로 읽는다. 다음 판에서 지운다.
 */
export function parseKisRealtimeFrame(raw: string): KisRealtimeRecord[] {
    if (!raw || raw[0] === '{') return [];
    const parts = raw.split('|');
    if (parts.length < 4) return [];
    return parseKisRealtimePayload(parts[1] ?? '', parts[2] ?? '', parts.slice(3).join('|'));
}

/** 프레임의 TR, 건수, 본문(`^` 구분)을 record 배열로 파싱한다. `KisPriceWs`는 연결이 복호까지 마친 본문을 넘긴다. */
export function parseKisRealtimePayload(trId: string, countText: string, payload: string): KisRealtimeRecord[] {
    const count = Math.max(1, Number(countText) || 1);
    const fields = payload.split('^');
    const out: KisRealtimeRecord[] = [];

    if (trId === KIS_WS_TR.DOMESTIC_TRADE || trId === KIS_WS_TR.OVERSEAS_TRADE) {
        const recordSize = Math.max(1, Math.floor(fields.length / count));
        const isOverseas = trId === KIS_WS_TR.OVERSEAS_TRADE;
        const symIdx = isOverseas ? KIS_WS_FIELD.OVERSEAS_TRADE_SYMBOL : 0;
        const lastIdx = isOverseas ? KIS_WS_FIELD.OVERSEAS_TRADE_LAST : KIS_WS_FIELD.DOMESTIC_TRADE_LAST;
        const pctIdx = isOverseas ? KIS_WS_FIELD.OVERSEAS_TRADE_CHANGE_PCT : KIS_WS_FIELD.DOMESTIC_TRADE_CHANGE_PCT;
        for (let r = 0; r < count; r++) {
            const base = r * recordSize;
            const symbol = (fields[base + symIdx] ?? '').trim();
            const last = Number(fields[base + lastIdx]);
            const pct = Number(fields[base + pctIdx]);
            if (symbol && Number.isFinite(last) && last > 0) {
                out.push({ kind: 'trade', symbol, last, changePct: Number.isFinite(pct) ? pct : 0 });
            }
        }
        return out;
    }

    if (trId === KIS_WS_TR.DOMESTIC_ASKING) {
        const symbol = (fields[0] ?? '').trim();
        const bids: [number, number][] = [];
        const asks: [number, number][] = [];
        for (let i = 0; i < 10; i++) {
            const ap = Number(fields[KIS_WS_FIELD.DOMESTIC_ASKP_BASE + i]);
            const aq = Number(fields[KIS_WS_FIELD.DOMESTIC_ASKP_RSQN_BASE + i]);
            if (Number.isFinite(ap) && ap > 0) asks.push([ap, Number.isFinite(aq) ? aq : 0]);
            const bp = Number(fields[KIS_WS_FIELD.DOMESTIC_BIDP_BASE + i]);
            const bq = Number(fields[KIS_WS_FIELD.DOMESTIC_BIDP_RSQN_BASE + i]);
            if (Number.isFinite(bp) && bp > 0) bids.push([bp, Number.isFinite(bq) ? bq : 0]);
        }
        if (symbol && (bids.length > 0 || asks.length > 0)) {
            out.push({ kind: 'orderbook', symbol, bids, asks });
        }
        return out;
    }

    // 해외 호가(HDFSASP0) 등 다른 TR 은 파싱하지 않는다.
    return out;
}

/** 프레임이 PINGPONG 제어 메시지인지 (그대로 echo 해야 함). */
export function isPingPong(raw: string): boolean {
    if (!raw || raw[0] !== '{') return false;
    try {
        const msg = JSON.parse(raw) as { header?: { tr_id?: string } };
        return msg.header?.tr_id === KIS_WS_TR.PINGPONG;
    } catch {
        return false;
    }
}
