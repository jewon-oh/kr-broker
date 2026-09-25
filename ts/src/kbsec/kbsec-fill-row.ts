/**
 * @fileoverview KB증권 **체결 행** 파서 — 국내 SSQM2341(계좌별주문체결조회)·해외 SPQM2103
 * (해외 주문체결조회)의 필드명 정본.
 *
 * ## 왜 따로 두는가
 *
 * 체결 행의 필드 이름은 이 파일만 안다. 소비처(체결 확정·결제대기 매도 차감·미체결 조회·해외 체결)는
 * 이 파서의 결과만 본다. `ccls_q`·`trd_clsf` 는 **다른 TR**(SSQM0006/SSQM2121)의 이름이라 이 TR 에서는 폴백으로만 읽는다.
 *
 * ## 정본 — KB 공식 스펙(kbsecurities/kb-openapi `samples.generated.json`, outputSpec)
 *
 * | 뜻 | 국내 SSQM2341 | 해외 SPQM2103 | 폴백 |
 * |---|---|---|---|
 * | 체결수량 | `tl_ccls_q` (총체결수량) | `ccls_q_p6` | `ccls_q` |
 * | 미체결수량 | `nccls_q` | — | — |
 * | 체결단가 | `ccls_uprc` | `frgn_ccls_prc_p6` | `ccls_uprc`/`ccls_prc` |
 * | 주문번호 | `ordr_no` | `ordr_no` | (같음) |
 * | 종목 | `stnd_is_no` (표준종목번호) | `is_cd` | `is_cd` |
 * | 매매 방향 | `trd_dl_ccd_nm` (매매거래구분명) | `dl_clsf_nm` (거래구분명) | `trd_clsf` |
 * | 체결시각 | `ccls_ntc_tm` (폴백 `ordr_tm`) | `ccls_ttm` (폴백 `ordr_ttm`) | — |
 *
 * 폴백 이름은 스펙 이름이 없을 때만 읽는다.
 *
 * `_p6` 접미 값은 이 어댑터의 다른 실측 경로(`frgn_hld_q_p6`·`now_prc_p4`, 보유·현재가)와
 * 같이 **그대로 숫자로 읽는다** — 그 경로가 실서버에서 맞는 값을 내고 있다.
 *
 * ## 체결수량은 **건별**이다 — 그리고 분할체결은 식별자가 빈 행으로 이어진다
 *
 * 이름은 "총체결수량" 이지만 **누적이 아니다.** 실응답(`SSQM2341`, 종목코드와 주문번호는 공개를 위해 가공한 값):
 *
 * ```
 * {"ordr_no":"0000033333","stnd_is_no":"A051910","trd_dl_ccd_nm":"매도",
 * "ordr_q":4,"tl_ccls_q":1,"nccls_q":0,"ccls_uprc":152300}
 * {"ordr_no":"0000000000","stnd_is_no":" ","trd_dl_ccd_nm":" ",
 * "ordr_q":0,"tl_ccls_q":3,"nccls_q":0,"ccls_uprc":152200}
 * ```
 *
 * 누적이면 2행이 4여야 한다. **실제 값은 3이다.** 그리고 응답 헤더가 그 해석을 확증한다 —
 * `s_ccls_q=4`, `s_ccls_amt=608900` = `1×152,300 + 3×152,200`.
 *
 * ⇒ **한 행 = 한 체결.** 총량은 **합**이다(차분이 아니다).
 *
 * 그리고 두 번째 행을 보라 — `ordr_no` 가 `0000000000`, 종목·방향은 공백, `ordr_q` 는 0 이다.
 * KB 는 분할체결을 **헤더 1행 + 식별자를 지운 연속 행 N개**로 준다. 그 연속 행을 독립된
 * 체결로 읽으면 낸 주문에 매칭되지 않아 **첫 행의 수량만** 체결로 확정된다.
 * {@link kbsecResolveFills} 가 연속 행을 **직전 헤더 행에 귀속**시킨다.
 *
 * 검산은 {@link kbsecFillTotalsInconsistent} — 주문 단위로 `Σ체결 + 잔여미체결 = 주문수량`.
 * 위 행에서 `1+3+0 = 4` 로 성립한다. 이 모델이 또 틀리면 그 등식이 먼저 깨진다.
 *
 * 연속 행이 **헤더 없이** 오는 경우(페이지 경계 등)는 귀속할 곳이 없다 — 식별자를 비운 채
 * 내보내고 소비처가 버린다. 덜 빼는 쪽이라 유령청산(팔지 않은 종목을 판 것으로 처리하는 오류)으로 이어지지 않는다.
 *
 * ## 방향 이름의 값
 *
 * 스펙은 이름(문자열)이라고만 말하고, 실응답은 위 행처럼 `'매도'` 로 온다. `'매도'` 를 포함하면 매도, `'매수'` 를 포함하면
 * 매수로 읽는다(KB 화면 표기 `현금매수`·`현금매도`·`신용매도` 계열을 모두 덮는 부분일치).
 * 실응답 값이 이 규칙을 벗어나면 {@link kbsecFillSideOf} 한 곳만 고치면 된다.
 *
 * `ordr_typ_cd`(주문유형코드, 14자)는 **방향 축으로 쓰지 않는다** — KB 어휘에서
 * `*_ordr_typ_cd` 는 시장가/지정가 계열(해외 `frgn_ordr_typ_cd`)이고, 방향은 주문 TR 의
 * 헤더 `jbClsf`(1 매도·2 매수)에 있다. 잘못 매도로 읽으면 결제대기 차감이 보유를 깎아
 * **유령청산 → 재매수** 로 이어진다.
 */

import { kbsecNumber as numOf, kbsecString as strOf } from './kbsec-number';
import { KBSEC_TRD_SELL, kbsecNormalizeCode } from './kbsec-types';

export type KbsecFillSide = 'buy' | 'sell' | null;

export interface KbsecFillRow {
    /** 주문번호 (`ordr_no`) — 체결 확정은 이 값으로 낸 주문을 찾는다. */
    orderId: string;
    /** 도메인 종목코드 — 국내는 6자리(ISIN·`A` 접두 정규화), 해외는 티커. 없으면 ''. */
    symbol: string;
    /** 매매 방향. **모르면 null** — 소비처가 안전한 쪽으로 처리한다(추측 금지). */
    side: KbsecFillSide;
    /** 체결수량 — **이 한 건**의 수량(국내 `tl_ccls_q`, 해외 `ccls_q_p6`, 폴백 `ccls_q`). */
    filledQty: number;
    /** 미체결수량 (`nccls_q`, 해외엔 없음) */
    unfilledQty: number;
    /** 주문수량 (`ordr_q` / `frgn_ordr_q_p6`) */
    orderQty: number;
    /** 체결단가 (`ccls_uprc` / `frgn_ccls_prc_p6`, 폴백 `ccls_prc`). 0 이면 체결가를 모른다는 뜻. */
    price: number;
    /**
     * 체결금액 — 행에 `ccls_amt` 가 있으면 그 값, 없으면 수량×단가.
     * 단가가 0 이면 0 — 모르는 값을 지어내지 않는다.
     */
    cost: number;
    /** 체결시각 원문(`HHMMSS[ss]`, 없으면 주문시각). 둘 다 없으면 ''. 이 값으로 행을 정렬하지 않는다(연속 행 귀속이 응답 순서에 기댄다). */
    seq: string;
    /**
     * 정정·취소가 걸린 행인가 (`crct_cncl_ccd` 가 0/빈값이 아님).
     *
     * 이런 행이 낀 주문은 **수량 검산에서 뺀다** — 부분취소로 미체결수량만 줄고 주문수량은
     * 원래대로면 `Σ체결 + 미체결 = 주문` 이 멀쩡한데도 깨진다(오탐). 모르면 false.
     */
    amended: boolean;
    /**
     * **분할체결 연속 행**인가 — 자기 주문번호가 없다(`ordr_no` 가 전부 `0`).
     *
     * KB 는 한 주문의 두 번째 체결부터 식별자를 지운 행으로 준다(실측: 종목·방향은 공백,
     * `ordr_q` 는 0). 이 행의 주인은 **바로 앞 헤더 행**이고, 귀속은 행 순서를 아는
     * {@link kbsecResolveFills} 가 한다 — 행 하나만 보고는 알 수 없다.
     *
     * `ordr_no` 가 **빈 문자열**인 경우는 여기 해당하지 않는다. 전부 0 은 KB 어휘에서
     * "없음" 이라는 **명시**지만(원주문번호 `orgn_ordr_no` 도 같은 표기), 빈 값은 그냥
     * 모르는 것이다. 모르는 행을 남의 주문에 붙이지 않는다.
     */
    continuation: boolean;
}

/** @deprecated 이름만 남긴 별칭 — 국내·해외가 같은 모양이라 {@link KbsecFillRow} 를 쓴다. */
export type KbsecDomesticFillRow = KbsecFillRow;

/**
 * 식별자가 붙은 **체결 한 건** — 소비처는 이것을 더한다.
 *
 * 연속 행에는 헤더 행의 `orderId`·`symbol`·`side` 가 들어 있다. 붙일 헤더가 없었으면
 * 셋 다 비어 있고(`''`/`null`), 소비처가 그 행을 버린다.
 */
export interface KbsecFill {
    orderId: string;
    symbol: string;
    side: KbsecFillSide;
    /** 이 체결의 수량(> 0) */
    qty: number;
    /** 이 체결의 단가 */
    price: number;
    /** `qty × price` (단가 0 이면 0) */
    cost: number;
}

/**
 * 매매 방향 — 구분**명**(국내 `trd_dl_ccd_nm` · 해외 `dl_clsf_nm`) → `trd_clsf`(종전 이름,
 * 폴백) → null.
 *
 * 문자열 부분일치 순서는 **매도 먼저** — `공매도`·`신용매도` 처럼 `매도` 를 포함하는 이름을
 * 매수로 오독하지 않게 한다. 두 축 어느 것도 없으면 null 이다.
 */
export function kbsecFillSideOf(row: Record<string, unknown>): KbsecFillSide {
    const name = strOf(row, 'trd_dl_ccd_nm', 'dl_clsf_nm');
    if (name) {
        if (name.includes('매도')) return 'sell';
        if (name.includes('매수')) return 'buy';
    }
    const legacy = strOf(row, 'trd_clsf');
    if (legacy) return legacy === KBSEC_TRD_SELL ? 'sell' : 'buy';
    return null;
}

/**
 * 정정·취소 표시 — `crct_cncl_ccd`(정정취소구분코드)가 있고 `0`/빈값이 아니면 참.
 * 값 어휘가 확정되지 않았으므로 **"0 이 아니면 뭔가 걸린 것"** 으로만 읽는다(보수적).
 */
function isAmended(row: Record<string, unknown>): boolean {
    const v = strOf(row, 'crct_cncl_ccd');
    return v !== '' && Number(v) !== 0;
}

function costOf(row: Record<string, unknown>, filledQty: number, price: number): number {
    const explicit = numOf(row, 'ccls_amt');
    if (explicit > 0) return explicit;
    return price > 0 ? filledQty * price : 0;
}

/**
 * 주문번호 — **전부 `0` 이면 "없음"** 이다(KB 어휘). 그런 행은 분할체결 연속 행이므로
 * 식별자를 비워 돌려주고 `continuation` 을 true 로 한다. 판단은 {@link kbsecResolveFills} 가 한다.
 */
function orderNoOf(row: Record<string, unknown>): { orderId: string; continuation: boolean } {
    const raw = strOf(row, 'ordr_no', 'odno');
    if (raw !== '' && /^0+$/.test(raw)) return { orderId: '', continuation: true };
    return { orderId: raw, continuation: false };
}

/** 국내 SSQM2341 그리드 1행 → 정규화. 순수 함수(로그·I/O 없음). */
export function parseKbsecDomesticFillRow(row: Record<string, unknown>): KbsecFillRow {
    const filledQty = numOf(row, 'tl_ccls_q', 'ccls_q');
    const price = numOf(row, 'ccls_uprc', 'ccls_prc');
    const { orderId, continuation } = orderNoOf(row);
    return {
        orderId,
        symbol: kbsecNormalizeCode(strOf(row, 'stnd_is_no', 'is_cd', 'shrt_cd')),
        side: kbsecFillSideOf(row),
        filledQty,
        unfilledQty: numOf(row, 'nccls_q'),
        orderQty: numOf(row, 'ordr_q'),
        price,
        cost: costOf(row, filledQty, price),
        seq: strOf(row, 'ccls_ntc_tm', 'ordr_tm'),
        amended: isAmended(row),
        continuation,
    };
}

/**
 * 해외 SPQM2103 그리드 1행 → 정규화. 스펙 이름(`ccls_q_p6`·`frgn_ccls_prc_p6`)이 1순위,
 * 국내 이름은 폴백(종전엔 국내 이름만 읽어 해외 체결이 전부 0 이었다).
 */
export function parseKbsecOverseasFillRow(row: Record<string, unknown>): KbsecFillRow {
    const filledQty = numOf(row, 'ccls_q_p6', 'tl_ccls_q', 'ccls_q');
    const price = numOf(row, 'frgn_ccls_prc_p6', 'ccls_uprc', 'ccls_prc');
    // 연속 행 표기는 해외에서 **미실측**이다. 같은 `ordr_no` 필드를 쓰므로 같은 규칙을
    // 적용하되, 전부 0 이 아닌 주문번호는 어차피 영향을 받지 않는다.
    const { orderId, continuation } = orderNoOf(row);
    return {
        orderId,
        symbol: kbsecNormalizeCode(strOf(row, 'is_cd', 'stnd_is_no')),
        side: kbsecFillSideOf(row),
        filledQty,
        unfilledQty: 0,
        orderQty: numOf(row, 'frgn_ordr_q_p6', 'ordr_q'),
        price,
        cost: costOf(row, filledQty, price),
        seq: strOf(row, 'ccls_ttm', 'ordr_ttm'),
        amended: isAmended(row),
        continuation,
    };
}

/**
 * 수량 모델의 **자가진단** — 주문 단위로 `Σ체결 + 잔여미체결 = 주문수량`.
 *
 * 한 행 = 한 체결이므로, 한 주문의 모든 체결을 더하고 남은 미체결을 보태면 주문수량이
 * 나와야 한다. 실측 예(가공한 종목·주문번호, 주문 `0000033333`): `1 + 3 + 0 = 4` ✓.
 *
 * 이 등식이 깨지는 경우는 둘이다 — 연속 행을 놓쳤거나(귀속 실패), 수량 모델이 또 바뀌었거나.
 * 어느 쪽이든 **분할체결이 실제보다 적게 확정된다**: 남은 수량이 호출하는 쪽의 기록에 열린 포지션으로 남고,
 * 다음 주기에 없는 수량을 팔려다 브로커에 거부된다(실제로 이런 사고가 있었다).
 *
 * 잔여미체결은 그 주문 행들의 `nccls_q` **최솟값**을 쓴다 — 체결이 진행될수록 줄어들므로
 * 마지막 체결 시점의 값이 최솟값이고, 행 순서를 몰라도 맞는다.
 *
 * 정정·취소가 낀 주문은 통째로 뺀다(부분취소면 등식이 멀쩡해도 깨진다 — 오탐).
 * 주문수량·체결수량이 없는 주문은 판정하지 않는다. 국내 주식은 정수주라 오차를 두지 않는다.
 */
export function kbsecFillTotalsInconsistent(rows: KbsecFillRow[]): boolean {
    let header: KbsecFillRow | null = null;
    let filled = 0;
    let minUnfilled = Number.POSITIVE_INFINITY;
    let amended = false;
    let broken = false;

    const settle = (): void => {
        if (!header || amended) return;
        if (!(header.orderQty > 0) || !(filled > 0)) return;
        const remaining = Number.isFinite(minUnfilled) ? minUnfilled : 0;
        if (filled + remaining !== header.orderQty) broken = true;
    };

    for (const r of rows) {
        if (!r.continuation) {
            settle();
            header = r; filled = 0; minUnfilled = Number.POSITIVE_INFINITY; amended = false;
        }
        if (r.amended) amended = true;
        filled += r.filledQty;
        minUnfilled = Math.min(minUnfilled, r.unfilledQty);
    }
    settle();
    return broken;
}

/** 이 검산으로 실제 판정된 **주문 수** — 0 이면 "통과" 가 아니라 "아무것도 못 봤다" 다. */
export function kbsecFillTotalsCheckedOrders(rows: KbsecFillRow[]): number {
    return rows.filter(r => !r.continuation && !r.amended && r.orderQty > 0 && r.filledQty > 0).length;
}

/**
 * 체결 행 → **식별자가 붙은 체결 건** 목록. 소비처는 `qty` 를 그대로 더한다.
 *
 * 연속 행(`continuation`)은 **바로 앞 헤더 행**의 `orderId`·`symbol`·`side` 를 물려받는다.
 * 그것이 이 함수의 전부다 — 수량은 건별이라 차분도 중복 제거도 하지 않는다.
 *
 * 헤더 없이 시작하는 연속 행은 귀속할 곳이 없다. 식별자를 **비운 채** 내보내고 소비처가
 * 버린다(결제대기 차감은 `orderId`·`side` 로, 체결 확정은 주문번호 매칭으로 거른다).
 * 덜 세는 쪽이라 보유 과다보고로 끝나고, 유령청산 → 재매수로 이어지지 않는다.
 * 페이지를 넘겨 받는 순간(`nxt_key`) 실제로 생길 수 있는 모양이다.
 *
 * 수량 0 이하는 내지 않는다. 단가 0 인 체결은 그대로 낸다 — 버릴지는 소비처가 정한다
 * (확정에는 못 쓰고, 결제대기 차감에는 수량만 필요하다).
 */
export function kbsecResolveFills(rows: KbsecFillRow[]): KbsecFill[] {
    const out: KbsecFill[] = [];
    let header: KbsecFillRow | null = null;

    for (const r of rows) {
        if (!r.continuation) header = r;
        const owner = r.continuation ? header : r;
        if (!(r.filledQty > 0)) continue;
        out.push({
            orderId: owner?.orderId ?? '',
            symbol: owner?.symbol ?? '',
            side: owner?.side ?? null,
            qty: r.filledQty,
            price: r.price,
            cost: r.price > 0 ? r.filledQty * r.price : 0,
        });
    }
    return out;
}
