/**
 * @fileoverview 해외 정산 행(`SPQM2205`) ↔ 호출하는 쪽의 거래 기록 매칭·안분 — **순수 함수**.
 *
 * 국내 짝은 `kbsec-settlement-match.ts` 다. 안분 규칙은 같지만 **기준 축이 다르다** —
 * 여기는 전부 USD 고, 그룹 키에 **미국 현지 주문일자**가 들어간다. 금액 필드에 단위를 명시하는
 * 이유는 통화·단위 축을 섞어 금액이 1,400배 어긋난 사고를 겪었기 때문이다.
 *
 * ## 매칭 키 — `(미국 주문일자 × 종목 × 매매구분)`
 *
 * 실측으로 확정했다. 한 조회 구간의 TR 행 안에서 이 조합이 **유일**했고, 같은 구간의
 * 체결 기록을 같은 축으로 묶으면 **TR 과 정확히 일대일로 겹쳤다**(한쪽에만 있는 조합 없음).
 * 단가·수량까지 볼 필요가 없다.
 *
 * **일자는 KST 가 아니다.** 미국 정규장은 KST 22:30~05:00 이라 자정을 넘긴 체결이 하루
 * 뒤로 밀린다. 같은 대조를 KST 일자로 하면 조합의 대부분이 한쪽에만 남는다
 * — 즉 **거의 전부 안 맞는다.** 그런데 결과는 "정산 없음" 이라 로그가 조용하다. 그래서
 * {@link matchKbsecOverseasSettlements} 는 **우리 거래에 못 붙은 정산 묶음을 따로 세어**
 * 돌려준다(`unmatched`) — 축이 어긋나면 그 숫자가 곧바로 커진다.
 *
 * ## 왜 결제단가를 조인 키로 안 쓰나
 *
 * TR 의 `frgn_stmt_prc_p6` 는 **가중평균**이다. 실측에서 우리 체결 2건이 TR 1행(수량 합계 ×
 * 가중평균 단가)으로 합쳐진 사례가 있다. 단가로 조인하면 이 건이 조용히 0건이 되고
 * "정산이 없다" 와 구분되지 않는다.
 *
 * 거래 기록의 `amount` 도 못 쓴다 — 매도행에서 그 값은 **진입 명목**일 수 있다(청산 금액을
 * 모르면 진입 금액이 들어간다). KB 가 알 수 있는 값이 아니다.
 *
 * ⇒ 그룹 합계로 맞추고 **명목 비중으로 안분**한다. 비용이 명목에 정률이라(실측 건별
 * 0.2493%~0.2548%) 안분 오차는 소수점 절사분뿐이다.
 *
 * ## 결과를 네 갈래로 나눈다 — "못 덮었다" 를 하나로 묶지 않는다
 *
 * | 결과 | 뜻 | 그래서 |
 * |---|---|---|
 * | `matched` | 그룹이 맞았고 안분도 됐다 | 실청구액으로 덮는다 |
 * | `no-settlement` | 그 그룹의 정산 행이 없다 | 추정치 유지. 미정산 구간일 수 있다 |
 * | `unallocatable` | 행은 있는데 안분 근거(수량)가 없다 | 추정치 유지 + WARN |
 * | `notional-mismatch` | 우리 명목 합과 `frgn_agr_amt_p4` 합이 어긋난다 | 덮지 않는다 + WARN |
 *
 * `notional-mismatch` 가 이 모듈의 안전장치다. 우리 장부에 없는 매매(수동 주문·다른 경로)가
 * 같은 그룹에 섞이면 KB 합계가 우리 것보다 커진다. 그대로 안분하면 남의 비용을 우리 거래에
 * 붙이게 된다 — 그래서 어긋나면 **아무것도 안 덮는다.**
 */

import type { KbsecOverseasSettlementRow } from './kbsec-overseas-settlement-row';
import { kbsecOverseasSettlementCostUsd } from './kbsec-overseas-settlement-row';

/** 매칭 대상 거래 — 호출하는 쪽의 거래 기록에서 필요한 것만 추린 모양. */
export interface KbsecOverseasSettlementTrade {
    id: string;
    /** 단축종목코드(티커). 거래 심볼에서 기준 코드만 뗀 값. */
    symbol: string;
    side: 'BUY' | 'SELL';
    /** **미국 현지 주문일자** `YYYYMMDD`. `kbsecDateUsEastern(trade.timestamp)`. */
    orderDateUs: string;
    /** 체결가 — 해외 거래는 이미 USD 축이다. */
    priceUsd: number;
    /**
     * 체결 수량(주). 모르면 null — 그룹에 거래가 둘 이상이면 안분을 포기하는 근거가 된다.
     *
     * 청산 leg 의 수량은 오래 비어 있었다(실측: 해외 매도 체결에서 `quantity` 가 채워진
     * 건이 없었다). 호출하는 쪽이 전량청산에 한해 채우게 된 뒤의 거래부터 들어온다.
     */
    quantity: number | null;
}

export type KbsecOverseasSettlementMatch =
    | {
        kind: 'matched';
        tradeId: string;
        /** 이 거래 몫의 실청구 비용(USD) — 수수료 + 세금. */
        costUsd: number;
        /** 실효 비용률 — `costUsd / 명목(USD)`. 거래의 수수료율로 그대로 기록할 수 있다. */
        rate: number;
        /** 안분에 쓴 이 거래의 USD 명목. */
        notionalUsd: number;
        /** 그룹에 우리 거래가 몇 건이었나 — 1 이면 안분 없이 통째로 받았다. */
        groupTrades: number;
    }
    | { kind: 'no-settlement'; tradeId: string }
    | { kind: 'unallocatable'; tradeId: string; groupTrades: number }
    | { kind: 'notional-mismatch'; tradeId: string; ourUsd: number; theirUsd: number };

/** 우리 거래에 못 붙은 정산 묶음 — 축이 어긋났는지 확인하는 용도다. */
export interface KbsecOverseasUnmatchedGroup {
    /** `주문일자|종목|방향`. */
    key: string;
    /** 그 묶음의 행 수. */
    rows: number;
    /** 그 묶음의 비용(USD) — 얼마 규모를 못 붙였는지. */
    costUsd: number;
}

export interface KbsecOverseasSettlementMatchResult {
    /** 거래 하나당 결과 하나. **입력 순서를 유지한다.** */
    matches: KbsecOverseasSettlementMatch[];
    /** 어느 거래에도 안 붙은 정산 묶음. 비면 정상이다. */
    unmatched: KbsecOverseasUnmatchedGroup[];
}

/**
 * 우리 명목 합과 KB `frgn_agr_amt_p4` 합의 허용 상대오차.
 *
 * 해외는 환율을 되짚지 않아(양쪽 다 USD) 잡음이 국내보다 작다 — 남는 건 체결가의
 * 소수 절사분뿐이다. 그래도 국내 정산 매칭과 같은 값으로 둔다: 이 크기면 잡음을 덮고도
 * **한 주 어긋남**(가장 작은 실질 불일치)은 잡는다
 * (`kbsec-settlement-match.ts` 의 `SETTLEMENT_NOTIONAL_REL_TOLERANCE`).
 */
export const OVERSEAS_SETTLEMENT_NOTIONAL_REL_TOLERANCE = 0.001;

/** 그룹 키 — 해외는 조회가 구간 단위라 **일자가 키에 들어간다**(국내는 호출 단위로 고정). */
function groupKey(orderDateUs: string, symbol: string, side: 'BUY' | 'SELL'): string {
    return `${orderDateUs}|${symbol}|${side}`;
}

/** 정산 행의 방향을 `'BUY' | 'SELL'` 로 바꾼다. 모르면 null(그 행은 버린다). */
function toTradeSide(side: KbsecOverseasSettlementRow['side']): 'BUY' | 'SELL' | null {
    if (side === 'buy') return 'BUY';
    if (side === 'sell') return 'SELL';
    return null;
}

/**
 * 이 거래의 **USD 명목** — 안분 가중치. 수량을 모르면 null.
 *
 * 거래 기록의 `amount` 를 대신 쓰지 않는다 — 매도행에서 그 값은 진입 명목이라 청산 명목과 다르다
 * (파일 헤더).
 */
function notionalUsdOf(trade: KbsecOverseasSettlementTrade): number | null {
    if (!(trade.quantity && trade.quantity > 0)) return null;
    if (!(trade.priceUsd > 0)) return null;
    return trade.priceUsd * trade.quantity;
}

/**
 * 조회 구간의 정산 행을 같은 구간의 거래에 배분한다.
 *
 * @param trades 조회 구간(미국 일자)의 해외 KB증권 거래
 * @param rows 같은 구간 `SPQM2205` 행 (`trd_clsf=99` 로 양방향 다 받은 것)
 */
export function matchKbsecOverseasSettlements(
    trades: readonly KbsecOverseasSettlementTrade[],
    rows: readonly KbsecOverseasSettlementRow[],
    notionalTolerance = OVERSEAS_SETTLEMENT_NOTIONAL_REL_TOLERANCE,
): KbsecOverseasSettlementMatchResult {
    // ── 정산 행을 (일자 × 종목 × 방향) 으로 합산 ───────────────────────────
    const settled = new Map<string, { costUsd: number; notionalUsd: number; rows: number }>();
    for (const row of rows) {
        const side = toTradeSide(row.side);
        // 방향·종목·일자 중 하나라도 못 읽은 행은 버린다. 어디에 붙일지 모르는 비용을
        // 아무 데나 붙이면 조용히 틀린다.
        if (!side || !row.symbol || !row.orderDateUs) continue;
        const key = groupKey(row.orderDateUs, row.symbol, side);
        const acc = settled.get(key) ?? { costUsd: 0, notionalUsd: 0, rows: 0 };
        acc.costUsd += kbsecOverseasSettlementCostUsd(row);
        acc.notionalUsd += row.notionalUsd;
        acc.rows += 1;
        settled.set(key, acc);
    }

    // ── 우리 거래를 같은 축으로 묶는다 ─────────────────────────────────────
    const ourGroups = new Map<string, KbsecOverseasSettlementTrade[]>();
    for (const t of trades) {
        const key = groupKey(t.orderDateUs, t.symbol, t.side);
        const list = ourGroups.get(key) ?? [];
        list.push(t);
        ourGroups.set(key, list);
    }

    const result = new Map<string, KbsecOverseasSettlementMatch>();
    for (const [key, group] of ourGroups) {
        const kb = settled.get(key);
        if (!kb || !(kb.costUsd > 0)) {
            for (const t of group) result.set(t.id, { kind: 'no-settlement', tradeId: t.id });
            continue;
        }

        const weights = group.map(notionalUsdOf);
        // 명목 대조는 **전부 알 때만** 성립한다. 하나라도 모르는 채로 합을 내면 그 합은
        // 우리 명목이 아니라 '아는 것만의 합' 이라, 항상 KB 보다 작아 어긋난 것처럼 보인다.
        // 그러면 진짜 진단(안분 근거 없음)이 잘못된 진단(명목 불일치)에 가려진다.
        const allKnown = weights.every(w => w !== null);
        const ourUsd = allKnown ? weights.reduce<number>((s, w) => s + (w as number), 0) : 0;

        if (allKnown && ourUsd > 0 && kb.notionalUsd > 0
            && Math.abs(ourUsd - kb.notionalUsd) / kb.notionalUsd > notionalTolerance) {
            for (const t of group) {
                result.set(t.id, {
                    kind: 'notional-mismatch', tradeId: t.id,
                    ourUsd, theirUsd: kb.notionalUsd,
                });
            }
            continue;
        }

        // 거래가 하나뿐이면 안분이 없다 — 그룹 비용을 통째로 받는다. 명목은 우리 값이
        // 있으면 그걸, 없으면 KB 의 약정금액을 쓴다(요율 계산에만 쓰이는 분모다).
        if (group.length === 1) {
            const only = group[0];
            const notional = weights[0] ?? kb.notionalUsd;
            result.set(only.id, {
                kind: 'matched', tradeId: only.id,
                costUsd: kb.costUsd,
                rate: notional > 0 ? kb.costUsd / notional : 0,
                notionalUsd: notional,
                groupTrades: 1,
            });
            continue;
        }

        // 다중 그룹 — 하나라도 명목을 모르면 안분 근거가 없다. 추측해서 나누지 않는다.
        if (!allKnown || !(ourUsd > 0)) {
            for (const t of group) {
                result.set(t.id, { kind: 'unallocatable', tradeId: t.id, groupTrades: group.length });
            }
            continue;
        }

        for (let i = 0; i < group.length; i++) {
            const notional = weights[i] as number;
            const share = kb.costUsd * (notional / ourUsd);
            result.set(group[i].id, {
                kind: 'matched', tradeId: group[i].id,
                costUsd: share,
                rate: share / notional,
                notionalUsd: notional,
                groupTrades: group.length,
            });
        }
    }

    // 우리 거래에 못 붙은 KB 묶음 — 날짜 축이 어긋나면 여기가 통째로 찬다. 매칭 결과만
    // 보면 전부 `no-settlement` 이라 "매매가 없었나 보다" 로 읽히기 쉽다.
    const unmatched: KbsecOverseasUnmatchedGroup[] = [];
    for (const [key, kb] of settled) {
        if (ourGroups.has(key)) continue;
        unmatched.push({ key, rows: kb.rows, costUsd: kb.costUsd });
    }

    return {
        // 입력 순서 유지 — 호출부가 거래와 결과를 인덱스로 맞출 수 있게.
        matches: trades.map(t => result.get(t.id) ?? { kind: 'no-settlement', tradeId: t.id }),
        unmatched,
    };
}
