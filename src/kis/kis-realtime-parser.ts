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
 * 실시간 raw 종목코드 → priceStream/오더북 스트림 키.
 * 국내(6자리) → `<code>/KRW`, 해외(ticker) → `<TICKER>/USD`.
 */
export function toStreamSymbol(rawSymbol: string): string {
    const code = rawSymbol.toUpperCase();
    return isOverseasSymbol(code) ? `${code}/${OVERSEAS_STREAM_QUOTE}` : `${code}/KRW`;
}

/**
 * 해외 주식 스트림 quote — **`USD` 이지 `USDT` 가 아니다**.
 *
 * ## 왜 바꿨나 — bare 심볼 충돌
 *
 * 가격 스트림을 소비하는 쪽은 캐시와 리스너 콜백에서 **거래소 접두 없는 bare
 * 심볼**을 키로 쓸 수 있다.
 * 그래서 해외 주식을 `AAPL/USDT` 로 발행하면 **같은 프로세스에서 도는 다른 거래소의 피드와 키가
 * 겹칠 수 있다** — 주식을 토큰화해 `AMD/USDT` 로 거래하는 거래소가 실제로 그 모양이다.
 * 겹치면 다른 자산 가격으로 손절·익절을 평가하게 되고, 오류도 로그도 남지 않는다.
 *
 * `USD` 는 스테이블코인 페어에 쓰이지 않는 quote 라 그 자체로 네임스페이스 역할을 한다.
 * 접두를 새로 도입하는 것보다 **소비처 변경이 없고** 되돌리기도 쉽다.
 *
 * ## 부수 효과 — 저장 형태와 일치한다
 *
 * 해외 주식 포지션은 소비하는 쪽에서 이미 `AAPL/USD` 로 저장하고 있었고, 발행 키가 그와 달라
 * 불일치를 메우는 복원 후보를 따로 넣어야 했다. 이제 발행 키와 저장
 * 형태가 같으므로 그 간극 자체가 사라진다.
 *
 * 기존 데이터 이관 불필요 — 해외 주식은 애초에 피드에 한 건도 없었다(실측: 피드의
 * 주식 항목은 `kis:NNNNNN/KRW:spot` 국내뿐).
 */
export const OVERSEAS_STREAM_QUOTE = 'USD';

/** KIS 실시간 프레임 1개를 record 배열로 파싱 (제어/빈/미지원 프레임 → []). */
export function parseKisRealtimeFrame(raw: string): KisRealtimeRecord[] {
    if (!raw || raw[0] === '{') return [];
    const parts = raw.split('|');
    if (parts.length < 4) return [];
    const trId = parts[1];
    const count = Math.max(1, Number(parts[2]) || 1);
    const fields = parts.slice(3).join('|').split('^');
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

    // OVERSEAS_ASKING(HDFSASP0) 등은 후속.
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
