/**
 * @fileoverview KB 응답 행에서 값을 뽑는 함수들.
 *
 * KB 는 필드가 전부 `char` 라 숫자도 문자열로 오고, TR 마다 그리드(배열) 이름이 다르며, 배열이 둘인 TR 도 있다.
 * 이 함수들은 그 차이를 한곳에서 흡수한다.
 */

import { logger } from '../logger';
import { kbsecNumberOf, kbsecString } from './kbsec-number';

/**
 * 응답에서 숫자를 뽑는다. 후보 필드 이름을 순서대로 시도하고, **값이 있으면 0 이어도 그 키에서 멈춘다.** 공백만 있는 값은 빈 값이다.
 *
 * 이 방어형 리더는 필드 이름이 틀려도 예외 없이 0 을 돌려준다. 오타나 명세 변경이 "값이 0" 으로 조용히 넘어가지 않도록, 후보를 하나도
 * 못 찾았고 응답에 다른 키가 있으면 DEBUG 로 흔적을 남긴다(정상적으로 빈 응답도 흔해서 WARN 은 소음이 된다).
 * 실측으로 확정된 필드는 후보 목록을 줄이는 것이 원칙이다.
 */
export function pickNum(row: Record<string, unknown> | undefined, ...keys: string[]): number {
    if (!row) return 0;
    for (const k of keys) {
        const n = kbsecNumberOf(row[k]);
        if (n !== undefined) return n;
    }
    if (Object.keys(row).length > 0 && !keys.some(k => k in row)) {
        logger.debug({ tried: keys, available: Object.keys(row).slice(0, 12) },
            '[kbsec] 응답에 후보 필드가 하나도 없음 — 명세 대조 필요');
    }
    return 0;
}

/**
 * `pickNum` 과 같되 **양수인 첫 후보**를 고른다.
 *
 * KB 는 "값 없음"을 0 으로 준다. 그래서 `pickNum` 처럼 값이 있기만 하면 멈추는 규칙이 두 곳에서 문제가 된다.
 *
 * 1. **보유 행**: 매도 후 결제대기 행의 매입평균가·평가금액이 `'0000000000.00'` 으로 온다. 0 을 채택하면 뒤 후보에 닿지 못한다.
 * 2. **가격 폴백 사슬**: 국내 현재가 TR 은 장 밖에서 `now_prc` 를 `'000000000'` 으로 주므로 0 에서 멈추면 종가 폴백에 닿지 못한다.
 */
export function pickPositiveNum(row: Record<string, unknown> | undefined, ...keys: string[]): number {
    if (!row) return 0;
    for (const k of keys) {
        const n = kbsecNumberOf(row[k]);
        if (n !== undefined && n > 0) return n;
    }
    return 0;
}

/** 공백이 아닌 첫 후보 문자열. 없으면 `''`. */
export function pickStr(row: Record<string, unknown> | undefined, ...keys: string[]): string {
    return kbsecString(row, ...keys);
}

/**
 * 국내 보유주식(`SSQM1801`) 한 행의 보유수량 — 수량 축 둘 중 **큰 쪽**이다.
 *
 * | 필드 | 뜻 | 언제 0 이 되나 |
 * |---|---|---|
 * | `gnrl_q` | 일반(결제완료)수량 | 당일·전일 매수분. KRX 는 T+2 결제라 아직 0 이다 |
 * | `ordr_psbl_q` | 주문가능(=매도가능)수량 | 미체결 매도주문이 물고 있거나 대용담보로 묶인 분 |
 *
 * 어느 쪽도 상대를 포함하지 않으므로 합이 아니라 max 다. 다만 `gnrl_q > 0 · ordr_psbl_q = 0` 은 (1) 대용담보·미체결 매도주문과
 * (2) 매도 체결 뒤 결제대기가 겹치는 모양이라 이 TR 의 네 필드로는 구분할 수 없다. 이 함수는 원시 max 로 남기고, 결제대기 매도 차감은
 * 체결내역을 기준으로 하는 `adjustForPendingSale` 이 맡는다.
 *
 * `pickNum(r, 'gnrl_q', 'ordr_psbl_q')` 처럼 후보 목록에 맡기면 안 된다. 앞 필드가 있으면 0 이어도 채택하므로 미결제 매수분(`gnrl_q = 0`)이
 * 보유 0 으로 읽히고, 그 행이 사라지면 호출하는 쪽은 "외부에서 팔렸다"로 오판해 같은 종목을 다시 산다.
 */
export function kbsecHoldingQuantity(row: Record<string, unknown>): number {
    return Math.max(pickNum(row, 'gnrl_q'), pickNum(row, 'ordr_psbl_q'));
}

/**
 * 해외 보유 그리드에서 **수량일 수 있는** 필드 후보. 진단 전용이다.
 *
 * 집행에는 쓰지 않는다. 행이 전부 버려졌을 때 어느 필드가 0 이 아니었는지 이름만 남겨서 필드명을 추측하지 않게 하려는 것이다.
 * 보유 수량은 민감 정보라 값은 남기지 않는다.
 */
export const OVERSEAS_QTY_CANDIDATES = [
    'frgn_hld_q_p6', 'frgn_ordr_psbl_q_p6', 'frgn_ordr_psbl_q1_p6',
    'b_ccls_q_p6', 's_ccls_q_p6', 'b_ordr_q', 's_ordr_q',
] as const;

/** 응답에 들어 있던 배열들의 (길이, 첫 행 키). 그리드를 못 골랐을 때 원인을 보려고 남긴다. */
export interface GridSeen {
    len: number;
    keys: string[];
}

export interface GridPick {
    rows: Record<string, unknown>[];
    seen: GridSeen[];
}

/**
 * 응답 본문에서 배열 중 `isGrid` 를 만족하는 **첫 배열**을 고른다. 길이가 아니라 **필드 이름**으로 고른다.
 *
 * 배열이 둘인 TR 에서 첫 배열을 집으면 엉뚱한 그리드를 읽는다(해외 잔고평가 `SPQM2226` 은 예수금 그리드가 앞에 온다).
 * 행이 없을 때 빈 행 50개를 실어 보내는 TR 도 있어서 "가장 긴 배열"로 고르는 방식도 틀린다.
 */
export function pickGrid(
    body: Record<string, unknown> | undefined,
    isGrid: (firstRow: Record<string, unknown>) => boolean,
): GridPick {
    const seen: GridSeen[] = [];
    if (!body) return { rows: [], seen };
    for (const v of Object.values(body)) {
        if (!Array.isArray(v) || v.length === 0) continue;
        const first = v[0] as Record<string, unknown> | undefined;
        seen.push({ len: v.length, keys: Object.keys(first ?? {}).slice(0, 30) });
        if (first && isGrid(first)) return { rows: v as Record<string, unknown>[], seen };
    }
    return { rows: [], seen };
}

/** 해외 잔고평가(`SPQM2226`)의 **종목 그리드**. 종목코드나 보유수량 필드가 있는 배열이다. */
export function pickHoldingGrid(body: Record<string, unknown> | undefined): GridPick {
    return pickGrid(body, first => 'is_cd' in first || 'frgn_hld_q_p6' in first);
}

/**
 * 해외 잔고평가(`SPQM2226`)의 **통화별 예수금 그리드**. 종목 그리드와 달리 통화 이름(`crncy_clsf_nm`)이 있고 종목코드(`is_cd`)는 없다.
 * 못 찾으면 빈 배열이다.
 */
export function pickCashGrid(body: Record<string, unknown> | undefined): Record<string, unknown>[] {
    return pickGrid(body, first => 'crncy_clsf_nm' in first && !('is_cd' in first)).rows;
}

/** 응답 dataBody 에서 배열을 찾는다. TR 마다 배열 필드 이름이 달라 첫 배열을 집는다. 배열이 하나뿐인 TR 에만 쓴다. */
export function pickArray(body: Record<string, unknown> | undefined): Record<string, unknown>[] {
    if (!body) return [];
    for (const v of Object.values(body)) {
        if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
    return [];
}

/** 국내 정산(`SSQM2121`) 응답의 **종목 그리드**. 못 고르면 무엇을 봤는지 남긴다. */
export function pickSettlementGrid(body: Record<string, unknown> | undefined): Record<string, unknown>[] {
    const { rows, seen } = pickGrid(body, first => 'is_no' in first || 'ec_amt' in first);
    if (rows.length === 0 && seen.length > 0) {
        logger.warn({ seen }, '[kbsec] 정산 그리드를 못 골랐다 — 필드명 대조 필요');
    }
    return rows;
}

/** 해외 정산(`SPQM2205`) 응답의 **종목 그리드**. 못 고르면 무엇을 봤는지 남긴다. */
export function pickOverseasSettlementGrid(body: Record<string, unknown> | undefined): Record<string, unknown>[] {
    const { rows, seen } = pickGrid(body, first => 'shrt_is_cd' in first || 'frgn_stmt_amt_p4' in first);
    if (rows.length === 0 && seen.length > 0) {
        logger.warn({ seen }, '[kbsec] 해외 정산 그리드를 못 골랐다 — 필드명 대조 필요');
    }
    return rows;
}
