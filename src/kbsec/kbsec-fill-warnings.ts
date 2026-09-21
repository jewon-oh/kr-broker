/**
 * @fileoverview 체결 행 해석이 어긋났을 때 남기는 경고.
 *
 * 체결 행 파서(`kbsec-fill-row.ts`)는 필드 이름과 값 규칙을 실측으로 확정해 왔다. 규칙이 또 틀리면 조용히 잘못된 수량이 나오므로,
 * 어긋난 징후를 찾는 자리마다 경고를 남긴다. 매 사이클 같은 줄이 쌓이지 않도록 프로세스당 횟수를 제한한다.
 * 값이 아니라 **키**만 남긴다. 수량·종목은 민감 정보이고, 첫 실응답이 정확한 이름을 알려 준다.
 */

import { logger } from '../logger';
import { kbsecFillTotalsCheckedOrders, kbsecFillTotalsInconsistent, type KbsecFillRow } from './kbsec-fill-row';

/** 체결 행의 방향 축을 하나도 못 읽었을 때의 경고 — 프로세스당 한 번. */
let fillSideUnreadableWarned = false;

/**
 * 행은 왔는데 **방향을 한 행도 못 읽었다**면 필드 이름이 또 어긋난 것이다. `trd_dl_ccd_nm` 값 규칙은 실측으로 확정해 가는 중이라
 * 이 경고가 곧 "규칙을 고쳐야 한다"는 신호다.
 */
export function warnIfFillSideUnreadable(rows: Record<string, unknown>[], sideKnown: number, where: string): void {
    if (rows.length === 0 || sideKnown > 0 || fillSideUnreadableWarned) return;
    fillSideUnreadableWarned = true;
    logger.warn({ where, rows: rows.length, rowKeys: Object.keys(rows[0] ?? {}).slice(0, 60) },
        '[kbsec] 체결 행의 매매 방향을 한 행도 못 읽음 — trd_dl_ccd_nm 값 규칙 대조 필요'
        + ' (방향 미상 행은 결제대기 차감에서 제외된다)');
}

/**
 * 수량 검산 경고 횟수 — **한 번만 찍고 마는 플래그가 아니다.** 오탐(정정 행 등)이 먼저 뜨면 그 뒤의 진짜 불일치가 영영 안 보이기 때문에,
 * 프로세스당 이 횟수까지는 계속 남긴다.
 */
const FILL_TOTALS_WARN_LIMIT = 3;
let fillTotalsWarnCount = 0;

/**
 * 주문 단위 수량 검산(`Σ체결 + 잔여미체결 = 주문수량`)이 깨졌을 때의 경고.
 *
 * 깨졌다면 분할체결 연속 행을 놓쳤거나 수량 모델이 또 바뀐 것이다. 어느 쪽이든 분할체결이 실제보다 적게 확정된다.
 * 남은 수량이 장부에 열린 채로 남고 다음 사이클이 없는 수량을 팔려다 거부된다.
 */
export function warnIfFillTotalsInconsistent(parsed: KbsecFillRow[], rows: Record<string, unknown>[], where: string): void {
    if (fillTotalsWarnCount >= FILL_TOTALS_WARN_LIMIT || parsed.length === 0) return;

    // 검산 대상이 통째로 비면 검산은 "통과"가 아니라 아무것도 안 본 것이다. 정정 행은 오탐이라 제외하는데, KB 의 "정정 없음" 기본값이
    // `0` 이 아니면 모든 주문이 제외돼 검산이 영영 조용해진다. 그래서 판정한 주문 수를 함께 남긴다.
    const checked = kbsecFillTotalsCheckedOrders(parsed);
    if (checked === 0) {
        fillTotalsWarnCount++;
        logger.warn({
            where, rows: rows.length, amended: parsed.filter(r => r.amended).length,
            continuation: parsed.filter(r => r.continuation).length,
            seen: fillTotalsWarnCount, rowKeys: Object.keys(rows[0] ?? {}).slice(0, 60),
        },
            '[kbsec] 수량 검산 대상이 0건 — 검산이 통과한 게 아니라 아무것도 못 봤다'
            + ' (crct_cncl_ccd 기본값이 0 이 아닐 수 있다)');
        return;
    }

    if (!kbsecFillTotalsInconsistent(parsed)) return;
    fillTotalsWarnCount++;
    logger.warn({
        where, rows: rows.length, checked, seen: fillTotalsWarnCount,
        continuation: parsed.filter(r => r.continuation).length,
        rowKeys: Object.keys(rows[0] ?? {}).slice(0, 60),
    },
        '[kbsec] 주문 수량 검산 불일치 (Σ체결 + 미체결 ≠ 주문수량)'
        + ' — 분할체결 연속 행을 놓쳤거나 수량 모델이 바뀌었다(kbsec-fill-row.ts 대조 필요)');
}

let fillWithoutPriceWarned = false;

/** 체결수량은 있는데 단가가 0 이다. 확정에 쓰지 않고 버린다는 사실을 프로세스당 한 번 남긴다. */
export function warnFillWithoutPrice(row: Record<string, unknown>, symbol: string): void {
    if (fillWithoutPriceWarned) return;
    fillWithoutPriceWarned = true;
    logger.warn({ symbol, rowKeys: Object.keys(row).slice(0, 60) },
        '[kbsec] 체결 행에 수량은 있으나 단가(ccls_uprc)가 0 — 확정에 쓰지 않음(필드명 대조 필요)');
}

/** 테스트 전용. 경고 횟수 제한을 초기화한다. */
export function __resetFillSideWarn(): void {
    fillSideUnreadableWarned = false;
    fillWithoutPriceWarned = false;
    fillTotalsWarnCount = 0;
}
