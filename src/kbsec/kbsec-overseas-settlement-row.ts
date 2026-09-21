/**
 * @fileoverview KB증권 **해외 정산 행** 파서 — `SPQM2205`(매매가정산현황)의 필드명 정본.
 *
 * 국내 짝은 `kbsec-settlement-row.ts`(`SSQM2121`)다. **두 파일을 하나로 합치지 마라** —
 * 아래 항목이 실측으로 다르고, 한쪽 규칙을 다른 쪽에 옮기면 조용히 0건이 되거나 비용이
 * 어긋난다.
 *
 * | | 국내 `SSQM2121` | 해외 `SPQM2205` |
 * |---|---|---|
 * | 매매구분 도메인 | `char(1)` — `9` 전체 · `1` 매도 · `2` 매수 | **`char(2)`** — `99` 전체 · `01` 매도 · `02` 매수 |
 * | 전체 조회 | 잘린 부분집합이라 **매도·매수를 따로** 불러야 한다 | `99` 가 정상 완결한다(47행 5페이지 실측) |
 * | 단가별 연속 행 | 있다 — 식별자가 공백인 행을 앞 헤더에 귀속 | **없다**(입력에 `clsf` 축이 없다) |
 * | 정산 항등식 | `정산 = 약정 − 수수료 − 세금` | **`정산 = 약정 ± 수수료`** (세금은 안 들어간다) |
 * | 통화 축 | 원화 하나 | `krw_unty_mgn_rqst_f` 로 구분된다 |
 *
 * ## 통화 축 — 이 파서는 **외화(USD) 축만** 받는다
 *
 * `krw_unty_mgn_rqst_f` 를 `'1'` 로 주면 같은 행이 원화로 오고 건별 적용환율이 채워진다.
 * 이 파서가 그 축을 쓰지 않는 이유는 둘이다.
 *
 * 1. 호출하는 쪽의 거래 수수료 필드가 **USD 축**이다. 외화 축이면 변환이 아예 없다 — 원화로 받아
 * 되돌리면 환율 변환이 한 번 더 끼고, 그 지점에서 1,400배 어긋난 사고가 실제로 있었다.
 * 2. **원화 축은 세금을 안 준다.** 47행 전부 `frgn_dl_tx_p4` 가 0 이다(반올림이 아니라
 * 그 축에서 필드를 안 채운다). 외화 축은 매도 22행에 SEC fee 를 실어 준다.
 *
 * 그래서 행마다 `crncy_cd` 를 확인하고 USD 가 아니면 버린다
 * ({@link kbsecResolveOverseasSettlementRows}). 계좌 설정이 바뀌거나 미국 밖 거래소가
 * 섞이면 **금액의 축이 통째로 달라지므로**, 모르는 통화를 USD 필드에 넣지 않는다.
 *
 * ## `frgn_stmt_amt_p4`(정산금액)를 비용으로 쓰지 마라
 *
 * 비용이 **이미 반영된** 금액이다. 47행에서 항등식이 정확히 성립한다.
 *
 * ```
 * 매수 25행: frgn_stmt_amt_p4 = frgn_agr_amt_p4 + frgn_trd_fee_p4
 * 매도 22행: frgn_stmt_amt_p4 = frgn_agr_amt_p4 − frgn_trd_fee_p4
 * ```
 *
 * 거래 수수료로 기록할 값은 {@link kbsecOverseasSettlementCostUsd}(= 수수료 + 세금)이고,
 * 정산금액은 {@link kbsecResolveOverseasSettlementRows} 의 검산에만 쓴다. 국내 `ec_amt` 를
 * 호출하는 쪽에서 두 번 뺀 전례가 있다.
 *
 * 국내와 **부호가 서로 다르다**. 매수는 더하고 매도는 뺀다. 그리고 **세금은 항등식 밖**이다 —
 * 매도 22행이 전부 `약정 − 수수료` 로 맞고 세금을 더 빼면 그만큼 어긋난다. 국내
 * (`|약정 − 정산| = 수수료 + 세금`)의 검산식을 그대로 옮기면 멀쩡한 행이 버려진다.
 *
 * ## 정본 — KB 공식 스펙 (kbsecurities/kb-openapi `samples.generated.json`, `Tkb_SPQM2205_B2C`)
 *
 * **입력 14필드** (순서까지 스펙 그대로. `kbsec-tr-inputs.ts` 가 채운다)
 *
 * | 필드 | 뜻 | 값 |
 * |---|---|---|
 * | `strt_ordr_dt`·`end_ordr_dt` | 시작·종료 주문일자 | `YYYYMMDD` — **미국 현지 일자**다 |
 * | `trd_clsf` | 매매구분 | **`99` 전체 · `01` 매도 · `02` 매수** (필수) |
 * | `dl_clsf` | 거래구분 | `0` 전체 · `1` 일반 · `2` 소수점 |
 * | `krw_unty_mgn_rqst_f` | 원화통합증거금 | 빈값 = 외화 기준 · `1` = 원화 기준 |
 * | `frgn_krx_ccd`·`stnd_is_cd`·`iso_cd` | 거래소·종목·ISO | 빈 값(전체) |
 * | `s_stmt_amt_sum_p4`·`b_stmt_amt_sum_p4`·`tl_s_ccls_q_p6`·`tl_b_ccls_q_p6`·`fcrncy_fee_p4` | 합계 입력칸 | 빈 값 |
 * | `nxt_key` | 다음키 | 연속조회 |
 *
 * **출력 36필드 중 이 파서가 읽는 것** (라이브 실측 47행)
 *
 * | 뜻 | 필드 | 비고 |
 * |---|---|---|
 * | 단축종목코드 | `shrt_is_cd` | 미국은 티커(`KO`) 그대로 |
 * | 주문일자 | `ordr_dt` | **미국 현지 일자**. KST 가 아니다 — {@link KbsecOverseasSettlementRow.orderDateUs} |
 * | 매매구분명 | `trd_clsf_nm` | '매수'·'매도'. 출력에 코드 `trd_clsf` 는 없다 |
 * | 기타매매구분코드 | `etc_trd_ccd` | 방향 폴백 — 실측 `01`↔매도 · `02`↔매수 (47행 전수 일치) |
 * | 결제수량 | `stmt_q_p6` | |
 * | 결제단가 | `frgn_stmt_prc_p6` | **가중평균**이다. 체결 2건이 1행으로 합쳐진 사례가 있다 |
 * | 약정금액 | `frgn_agr_amt_p4` | 명목. 없으면 수량×단가 |
 * | 매매수수료 | `frgn_trd_fee_p4` | 실효 매수 0.2499% · 매도 0.2527% (실측) |
 * | 거래세 | `frgn_dl_tx_p4` + `ptp_tx_amt` | SEC fee · PTP 원천징수. 항등식 밖이다 |
 * | 정산금액 | `frgn_stmt_amt_p4` (폴백 `stmt_amt_p4`) | 검산 전용 |
 * | 통화코드 | `crncy_cd` | 축 확인용 — USD 가 아니면 버린다 |
 * | 결제일자 | `stmt_dt` | 결제 완료 판정의 **유일한** 근거 |
 *
 * `stmt_f`(결제여부)는 못 쓴다 — 47행 전부 공백이다. 결제 전 행은 `stmt_dt` 가 미래로
 * 온다(실측: 최근 주문일 3행의 `stmt_dt` 가 주문일 이틀 뒤였다). KB 앱의 매매제비용은
 * 결제가 끝난 것만 세지만 **이 파서는 결제 여부로 거르지 않는다** — 미결제 행도 항등식이
 * 그대로 성립해 KB 가 이미 정산액을 확정했다는 뜻이고, 호출하는 쪽의 동기화가 멱등이라 값이 바뀌면 다음
 * 사이클이 덮는다. 결제를 기다리면 손실 한도 판정이 이틀 동안 추정치를 보게 된다.
 */

import { kbsecNumber as num } from './kbsec-number';

/** 정산 행의 매매 방향. **모르면 null** — 소비처가 그 행을 버린다(추측 금지). */
export type KbsecOverseasSettlementSide = 'buy' | 'sell' | null;

/** `SPQM2205` 한 행을 정규화한 값. 금액은 전부 **외화(USD) 축**이다. */
export interface KbsecOverseasSettlementRow {
    /** 단축종목코드(미국은 티커). 못 읽으면 ''. */
    symbol: string;
    /** 매매 방향. 못 읽으면 null. */
    side: KbsecOverseasSettlementSide;
    /**
     * 주문일자 `YYYYMMDD` — **미국 현지 일자**다.
     *
     * 체결 시각(UTC)을 KST 로 바꾼 날짜와 다르다. 미국 정규장은 KST 로 22:30~05:00 이라
     * 자정을 넘긴 체결이 하루 뒤로 밀린다. 실제 체결을 두 축으로 대조하면 ET 일자는
     * 전부 맞고 KST 일자는 절반가량이 어긋난다. 축은 `kbsecDateUsEastern` 이 만든다.
     */
    orderDateUs: string;
    /** 결제일자 `YYYYMMDD`. 미래면 아직 결제 전이다. 빈 문자열이면 모른다. */
    settlementDateUs: string;
    /** 결제수량 (`stmt_q_p6`). */
    quantity: number;
    /** 결제단가 (`frgn_stmt_prc_p6`, USD). 여러 체결이 뭉친 **가중평균**일 수 있다. */
    priceUsd: number;
    /** 약정금액 (`frgn_agr_amt_p4`, USD). 없으면 수량×단가, 단가도 0 이면 0. */
    notionalUsd: number;
    /** 매매수수료 (`frgn_trd_fee_p4`, USD). */
    feeUsd: number;
    /** 세금 (`frgn_dl_tx_p4` + `ptp_tx_amt`, USD). 정산금액 항등식 밖이다. */
    taxUsd: number;
    /** 정산금액 (`frgn_stmt_amt_p4`, USD). 비용이 이미 반영된 금액 — 검산에만 쓴다. */
    settledUsd: number;
    /** 통화코드 (`crncy_cd`). 축 확인용 — USD 가 아닌 행은 버린다. */
    currency: string;
}

/** `trd_clsf`(매매구분) 입력 코드 — 국내와 달리 **두 자리**다. */
export const KBSEC_OVERSEAS_SETTLE_TRD_CLSF = {
    /** 전체. 국내 `SSQM2121` 의 `9` 와 달리 정상 완결한다(47행 5페이지, 중복 0). */
    ALL: '99',
    SELL: '01',
    BUY: '02',
} as const;

/** `dl_clsf`(거래구분) 입력 코드 — `0` 전체 · `1` 일반거래 · `2` 소수점거래. */
export const KBSEC_OVERSEAS_SETTLE_DL_CLSF = { ALL: '0', NORMAL: '1', FRACTIONAL: '2' } as const;

/**
 * `krw_unty_mgn_rqst_f`(원화통합증거금) 입력 — **통화 축**이다.
 *
 * 스펙은 `0: 외화기준` 이라고 적지만 **빈 값으로 실측했다**. 스펙 도메인만 보고 값을 고른
 * 국내 배선이 실응답에 깨진 전례가 있어, 관측된 값을 그대로 보낸다. 어느 쪽이 와도
 * `crncy_cd` 검사가 축을 다시 확인한다.
 */
export const KBSEC_OVERSEAS_SETTLE_FX_AXIS = { FOREIGN: '', KRW: '1' } as const;

/** 이 파서가 받아들이는 통화 — 외화 축의 미국 주식. */
export const KBSEC_OVERSEAS_SETTLE_CURRENCY = 'USD';

/** 출력 `etc_trd_ccd` 의 방향 코드 — 입력 `trd_clsf` 와 같은 두 자리 어휘다. */
const SIDE_CODE_SELL = KBSEC_OVERSEAS_SETTLE_TRD_CLSF.SELL;
const SIDE_CODE_BUY = KBSEC_OVERSEAS_SETTLE_TRD_CLSF.BUY;

/**
 * 정산 행의 매매 방향.
 *
 * 출력에는 코드 `trd_clsf` 가 **없다**(36필드 전수 확인). 이름 `trd_clsf_nm`('매수'·'매도')이
 * 정본이고, `etc_trd_ccd`(기타매매구분코드)를 폴백으로 둔다 — 실측 47행에서 `02`↔매수 25건,
 * `01`↔매도 22건으로 전수 일치했다.
 *
 * 어느 쪽으로도 못 읽으면 **null** 이다. 방향을 모르는 비용을 한쪽에 붙이면 매도 세금이
 * 매수로 넘어가는 식으로 조용히 틀린다.
 */
export function kbsecOverseasSettlementSideOf(
    raw: Record<string, unknown>,
): KbsecOverseasSettlementSide {
    const name = String(raw.trd_clsf_nm ?? '').trim();
    if (name.includes('매도')) return 'sell';
    if (name.includes('매수')) return 'buy';
    const code = String(raw.etc_trd_ccd ?? '').trim();
    if (code === SIDE_CODE_SELL) return 'sell';
    if (code === SIDE_CODE_BUY) return 'buy';
    return null;
}

/** `SPQM2205` 그리드 1행 → 정규화. 순수 함수(로그·I/O 없음). */
export function parseKbsecOverseasSettlementRow(
    raw: Record<string, unknown>,
): KbsecOverseasSettlementRow {
    const quantity = num(raw, 'stmt_q_p6');
    const priceUsd = num(raw, 'frgn_stmt_prc_p6');
    const notional = num(raw, 'frgn_agr_amt_p4');
    return {
        symbol: String(raw.shrt_is_cd ?? '').trim(),
        side: kbsecOverseasSettlementSideOf(raw),
        orderDateUs: String(raw.ordr_dt ?? '').trim(),
        settlementDateUs: String(raw.stmt_dt ?? '').trim(),
        quantity,
        priceUsd,
        notionalUsd: notional > 0 ? notional : quantity * priceUsd,
        feeUsd: num(raw, 'frgn_trd_fee_p4'),
        // SEC fee 는 `frgn_dl_tx_p4`, PTP 원천징수는 `ptp_tx_amt` 로 따로 온다. 실측 구간에
        // PTP 는 전부 0 이지만 합계에 넣어 둔다 — MLP·파트너십 종목으로 넓어져도 비용이
        // 누락되지 않게. 없는 필드는 0 이라 지금 값이 달라지지 않는다.
        taxUsd: num(raw, 'frgn_dl_tx_p4') + num(raw, 'ptp_tx_amt'),
        settledUsd: num(raw, 'frgn_stmt_amt_p4', 'stmt_amt_p4'),
        currency: String(raw.crncy_cd ?? '').trim().toUpperCase(),
    };
}

/**
 * 이 행의 **총 매매비용**(USD) — 거래 수수료로 기록할 값.
 *
 * `frgn_stmt_amt_p4` 가 아니다. 정산금액은 비용이 이미 빠진(또는 더해진) 값이라 그걸
 * 비용으로 쓰면 부호도 자릿수도 어긋난다. 비용은 수수료 + 세금이다.
 */
export function kbsecOverseasSettlementCostUsd(row: KbsecOverseasSettlementRow): number {
    return row.feeUsd + row.taxUsd;
}

/**
 * 검산 여유(USD).
 *
 * 항등식에 드는 금액 셋(`약정`·`수수료`·`정산`)이 각각 소수 4자리에서 끊기고 한 묶음에 여러
 * 행이 담길 수 있다. 센트 단위면 그 잡음을 덮고도 진짜 불일치는 잡는다 — 실측 수수료가
 * 행당 $2 대라 필드를 잘못 읽으면 이보다 훨씬 크게 벌어진다.
 */
export const OVERSEAS_SETTLEMENT_CONSISTENCY_TOLERANCE_USD = 0.01;

/** 해외 정산 묶음 키 — 매칭 축과 같은 (주문일자 × 종목 × 매매구분). */
function groupKeyOf(row: KbsecOverseasSettlementRow): string {
    return `${row.orderDateUs}|${row.symbol}|${row.side ?? '?'}`;
}

/**
 * 통화 축을 확인하고 **묶음 단위로 검산**한다.
 *
 * ## 왜 묶음 단위인가
 *
 * 실측 47행은 `(주문일자 × 종목 × 매매구분)` 이 전부 유일해서 묶음이 곧 한 행이다. 그래도
 * 행 단위로 두지 않는 이유는 국내에서 이미 겪은 문제라서다 — `SSQM2121` 은 한 종목을 단가마다
 * 쪼개고 비용을 마지막 행에만 담아서, 행 단위 검산이 **비용이 담긴 행을 버렸다**. 해외에
 * 그런 방식은 없지만(입력에 `clsf` 축이 없다) KB 가 행을 쪼개기 시작해도 검산이 같이
 * 깨지지는 않게 묶음으로 둔다.
 *
 * ## 검산식 — 세금은 넣지 않는다
 *
 * ```
 * |약정 합계 − 정산 합계| ≈ 수수료 합계
 * ```
 *
 * 국내는 `|거래금액 − 정산금액| = 수수료 + 세금` 인데 **해외는 세금이 정산금액에 안 들어간다**
 * (매도 22행 전수 확인). 국내 식을 옮기면 세금이 붙은 매도 묶음이 통째로 버려진다.
 *
 * ## 무엇을 버리나
 *
 * - **통화가 USD 가 아닌 행** — 원화 축 응답이거나 미국 밖 거래소다. 축이 다른 금액을
 * USD 필드에 넣지 않는다.
 * - **검산에 실패한 묶음** — 통째로 버린다(일부만 남기면 그룹 합계가 모자란 채 안분에 들어간다).
 *
 * 정산금액이 0 인 묶음은 **잴 근거가 없는 것**이라 통과시킨다 — 검산 불가와 검산 실패는 다르다.
 */
export function kbsecResolveOverseasSettlementRows(
    rows: readonly KbsecOverseasSettlementRow[],
    toleranceUsd = OVERSEAS_SETTLEMENT_CONSISTENCY_TOLERANCE_USD,
): { rows: KbsecOverseasSettlementRow[]; inconsistent: number; foreignCurrency: number } {
    const groups = new Map<string, KbsecOverseasSettlementRow[]>();
    let foreignCurrency = 0;
    for (const row of rows) {
        if (row.currency !== KBSEC_OVERSEAS_SETTLE_CURRENCY) { foreignCurrency++; continue; }
        const key = groupKeyOf(row);
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
    }

    const out: KbsecOverseasSettlementRow[] = [];
    let inconsistent = 0;
    for (const group of groups.values()) {
        const notional = group.reduce((sum, r) => sum + r.notionalUsd, 0);
        const fee = group.reduce((sum, r) => sum + r.feeUsd, 0);
        const settled = group.reduce((sum, r) => sum + r.settledUsd, 0);
        if (notional > 0 && settled > 0
            && Math.abs(Math.abs(notional - settled) - fee) > toleranceUsd) {
            inconsistent += group.length;
            continue;
        }
        out.push(...group);
    }
    return { rows: out, inconsistent, foreignCurrency };
}
