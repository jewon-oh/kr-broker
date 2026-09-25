/**
 * @fileoverview 국내 정산 행(`SSQM2121`) ↔ 거래 매칭·안분 — **순수 함수**.
 *
 * 입력 계약은 {@link KbsecSettlementTrade} 의 필드뿐이다.
 *
 * ## 왜 체결단가를 조인 키로 안 쓰나
 *
 * 정산 행에 **주문번호가 없다**(출력 30필드 전수 확인). 그래서 남는 축은
 * (일자 × 종목 × 매매구분 × 체결단가 × 수량)인데, 단가를 키에 넣으면 두 군데서 깨진다.
 *
 * ① **분할체결.** 한 주문의 체결가는 여러 체결의 **가중평균**인데
 * 정산은 `clsf=1`(단가별)로 단가마다 행을 쪼갠다 — 어느 행과도 같지 않다.
 * ② **축이 다르다.** 입력 단가 `priceUsd` 는 USD 라, 원화 단가(`priceUsd × usdToKrwRate`)로 되짚으면
 * 환율 곱의 꼬리가 남아 정산 단가와 같은 값이 되지 않는다.
 *
 * 단가로 조인하면 이 두 경우에 **조용히 0건**이 된다. "정산이 없다" 와 구분이 안 된다.
 *
 * ## 그래서 그룹 합계로 맞춘다
 *
 * `(KST 일자 × 종목 × 매매구분)` 으로 양쪽을 묶고, 그룹의 **비용 합계**를 기록된 거래들에
 * 명목 비중으로 안분한다.
 *
 * 비용은 명목에 비례하므로, 그룹 안 단가가 같으면 명목 안분은 근사가 아니라 **정확**하다.
 * 단가가 서로 다른 그룹에서도 위탁수수료·세금이 모두 정률이라 오차는 원 단위 절사분뿐이다.
 *
 * ## 결과를 네 갈래로 구분한다 — "못 덮었다" 를 한 가지로 합치지 않는다
 *
 * 실패를 빈 배열로 삼키면 "결과 없음" 과 구분되지 않는다.
 * 조회 실패는 애초에 여기까지 오지 않고(어댑터가 구분한다), 여기서는 남은 셋을 구분한다.
 *
 * | 결과 | 뜻 | 그래서 |
 * |---|---|---|
 * | `matched` | 그룹이 맞았고 안분도 됐다 | 실청구액으로 덮는다 |
 * | `no-settlement` | 그 그룹의 정산 행이 없다 | 추정치 유지. 미정산 구간일 수 있다 |
 * | `unallocatable` | 행은 있는데 안분 근거(수량)가 없다 | 추정치 유지 + WARN |
 * | `notional-mismatch` | 기록된 명목 합과 `dl_amt` 합이 어긋난다 | 덮지 않는다 + WARN |
 *
 * `notional-mismatch` 가 이 모듈의 안전장치다. 거래 기록에 없는 매매(수동 주문·다른
 * 경로)가 같은 그룹에 섞이면 KB 합계가 기록된 합계보다 커진다. 그걸 그대로 안분하면 남의
 * 비용을 기록된 거래에 더하게 된다 — 그래서 어긋나면 **아무것도 안 덮는다.**
 */

import type { KbsecSettlementRow } from './kbsec-settlement-row';
import { kbsecSettlementCostKrw } from './kbsec-settlement-row';

/** 매칭 대상 거래 — 호출하는 쪽의 거래 기록에서 필요한 것만 추린 모양. */
export interface KbsecSettlementTrade {
    id: string;
    /** 도메인 종목코드(6자리). */
    symbol: string;
    side: 'BUY' | 'SELL';
    /** 체결 단가 — **USD** 다. */
    priceUsd: number;
    /** 원/달러 환율. `priceUsd × usdToKrwRate` 가 원화 단가다. 없으면 원화 명목을 구하지 못한다. */
    usdToKrwRate: number | null;
    /**
     * 체결 수량(주). 모르면 null — 그룹에 거래가 둘 이상이면 안분을 포기하는 근거가 된다.
     */
    quantity: number | null;
}

export type KbsecSettlementMatch =
    | {
        kind: 'matched';
        tradeId: string;
        /** 이 거래 몫의 실청구 비용(원화). */
        costKrw: number;
        /** 실효 비용률 — `costKrw / 명목(원화)`. */
        rate: number;
        /** 안분에 쓴 이 거래의 원화 명목. */
        notionalKrw: number;
        /** 그룹에 기록된 거래가 몇 건이었나 — 1 이면 안분 없이 통째로 받았다. */
        groupTrades: number;
    }
    | { kind: 'no-settlement'; tradeId: string }
    | { kind: 'unallocatable'; tradeId: string; groupTrades: number }
    | { kind: 'notional-mismatch'; tradeId: string; ourKrw: number; theirKrw: number };

/**
 * 기록된 명목 합과 KB `dl_amt` 합의 허용 상대오차.
 *
 * 0.1% 다. 원화 단가를 `priceUsd × usdToKrwRate` 로 되짚어 생기는 부동소수 꼬리는 덮고,
 * **한 주 어긋남**(가장 작은 실질 불일치)은 잡는다.
 */
export const SETTLEMENT_NOTIONAL_REL_TOLERANCE = 0.001;

/** 그룹 키 — 일자는 호출 단위로 고정이라 종목·방향만 쓴다. */
function groupKey(symbol: string, side: 'BUY' | 'SELL'): string {
    return `${symbol}|${side}`;
}

/** 정산 행의 방향을 `'BUY' | 'SELL'` 어휘로. 모르면 null(그 행은 버린다). */
function toTradeSide(side: KbsecSettlementRow['side']): 'BUY' | 'SELL' | null {
    if (side === 'buy') return 'BUY';
    if (side === 'sell') return 'SELL';
    return null;
}

/**
 * 이 거래의 **원화 명목** — 안분 가중치.
 *
 * 단가·수량·환율을 모두 알아야 구할 수 있다. 하나라도 없으면 null 이다.
 */
function notionalKrwOf(trade: KbsecSettlementTrade): number | null {
    const fx = trade.usdToKrwRate;
    if (!(fx && fx > 0)) return null;
    if (!(trade.quantity && trade.quantity > 0)) return null;
    if (!(trade.priceUsd > 0)) return null;
    return trade.priceUsd * fx * trade.quantity;
}

/**
 * 하루치 정산 행을 그날의 거래에 배분한다.
 *
 * @param trades 그날(KST) 국내 KB증권 거래
 * @param rows 같은 날 `fetchDomesticSettlements` 결과의 `rows`(매도·매수를 따로 받아 합친 것)
 * @returns 거래 하나당 결과 하나. 입력 순서를 유지한다.
 */
export function matchKbsecSettlements(
    trades: readonly KbsecSettlementTrade[],
    rows: readonly KbsecSettlementRow[],
    notionalTolerance = SETTLEMENT_NOTIONAL_REL_TOLERANCE,
): KbsecSettlementMatch[] {
    // ── 정산 행을 (종목 × 방향) 으로 합산 ──────────────────────────────────
    const settled = new Map<string, { costKrw: number; notionalKrw: number }>();
    for (const row of rows) {
        const side = toTradeSide(row.side);
        // 방향이나 종목을 못 읽은 행은 버린다. 어느 쪽에 붙일지 모르는 비용을 한쪽에
        // 더하면 매도세가 매수로 넘어가는 식으로 조용히 틀린다.
        if (!side || !row.symbol) continue;
        const key = groupKey(row.symbol, side);
        const acc = settled.get(key) ?? { costKrw: 0, notionalKrw: 0 };
        acc.costKrw += kbsecSettlementCostKrw(row);
        acc.notionalKrw += row.notionalKrw;
        settled.set(key, acc);
    }

    // ── 기록된 거래를 같은 축으로 묶는다 ────────────────────────────────────
    const ourGroups = new Map<string, KbsecSettlementTrade[]>();
    for (const t of trades) {
        const key = groupKey(t.symbol, t.side);
        const list = ourGroups.get(key) ?? [];
        list.push(t);
        ourGroups.set(key, list);
    }

    const result = new Map<string, KbsecSettlementMatch>();
    for (const [key, group] of ourGroups) {
        const kb = settled.get(key);
        if (!kb || !(kb.costKrw > 0)) {
            for (const t of group) result.set(t.id, { kind: 'no-settlement', tradeId: t.id });
            continue;
        }

        const weights = group.map(notionalKrwOf);
        // 명목 대조는 **전부 알 때만** 성립한다. 하나라도 모르는 채로 합을 내면 그 합은
        // 기록된 명목이 아니라 '아는 것만의 합' 이라, 항상 KB 보다 작아 어긋난 것처럼 보인다.
        // 그러면 진짜 진단(안분 근거 없음)이 잘못된 진단(명목 불일치)에 가려진다.
        const allKnown = weights.every(w => w !== null);
        const ourKrw = allKnown ? weights.reduce<number>((s, w) => s + (w as number), 0) : 0;

        if (allKnown && ourKrw > 0 && kb.notionalKrw > 0
            && Math.abs(ourKrw - kb.notionalKrw) / kb.notionalKrw > notionalTolerance) {
            for (const t of group) {
                result.set(t.id, {
                    kind: 'notional-mismatch', tradeId: t.id,
                    ourKrw, theirKrw: kb.notionalKrw,
                });
            }
            continue;
        }

        // 거래가 하나뿐이면 안분이 없다 — 그룹 비용을 통째로 받는다. 명목은 기록된 값이
        // 있으면 그걸, 없으면 KB 의 `dl_amt` 를 쓴다(요율 계산에만 쓰이는 분모다).
        if (group.length === 1) {
            const only = group[0];
            const notional = weights[0] ?? kb.notionalKrw;
            result.set(only.id, {
                kind: 'matched', tradeId: only.id,
                costKrw: kb.costKrw,
                rate: notional > 0 ? kb.costKrw / notional : 0,
                notionalKrw: notional,
                groupTrades: 1,
            });
            continue;
        }

        // 다중 그룹 — 하나라도 명목을 모르면 안분 근거가 없다. 추측해서 나누지 않는다.
        if (!allKnown || !(ourKrw > 0)) {
            for (const t of group) {
                result.set(t.id, { kind: 'unallocatable', tradeId: t.id, groupTrades: group.length });
            }
            continue;
        }

        for (let i = 0; i < group.length; i++) {
            const notional = weights[i] as number;
            const share = kb.costKrw * (notional / ourKrw);
            result.set(group[i].id, {
                kind: 'matched', tradeId: group[i].id,
                costKrw: share,
                rate: share / notional,
                notionalKrw: notional,
                groupTrades: group.length,
            });
        }
    }

    // 입력 순서 유지 — 호출부가 거래와 결과를 인덱스로 맞출 수 있게.
    return trades.map(t => result.get(t.id) ?? { kind: 'no-settlement', tradeId: t.id });
}
