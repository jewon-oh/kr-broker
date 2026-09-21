/**
 * @fileoverview KB증권 **국내 정산 행** 파서 — `SSQM2121`(계좌별매매가정산현황)의 필드명 정본.
 *
 * ## 이 TR 이 왜 필요한가 — 체결 TR 은 비용을 안 준다
 *
 * 국내 체결 TR(`SSQM2341`)에도 해외 체결 TR(`SPQM2103`)에도 **수수료 필드가 없다**
 * (`kbsec-fill-row.ts` 헤더의 정본 표). 그래서 `Trade.fee` 에는 공시 요율에서 뽑은
 * **추정치**가 들어가 왔고(`kbsec-fee.ts`), 그 값이 실현손익·승률·손실한도 킬스위치까지
 * 그대로 전달됐다. KB 가 실제로 청구한 금액을 주는 곳은 정산 TR 뿐이다.
 *
 * 라이브 실측 원시 행(국내 종목 매도):
 *
 * ```
 * dl_amt = 2,093,800 거래금액
 * fee = 200 수수료
 * dl_tx = 1,046 거래세
 * ffs_tx = 3,140 농특세
 * ec_amt = 2,089,414 정산금액
 * ```
 *
 * `dl_amt − fee − dl_tx − ffs_tx = ec_amt` 가 정확히 맞는다.
 *
 * ## `ec_amt` 를 쓰면 비용을 또 빼지 마라
 *
 * `ec_amt`(정산금액)는 **이미 비용이 반영된 금액**이다. 여기서 `fee`·`dl_tx` 를 한 번 더
 * 빼면 이중 차감이다. 그래서 이 모듈은 `Trade.fee` 에 넣을
 * 값으로 **`ec_amt` 가 아니라 {@link kbsecSettlementCostKrw}(= 수수료 + 세금)** 를 준다.
 * `ec_amt` 는 {@link kbsecSettlementSelfConsistent} 의 검산에만 쓴다.
 *
 * ## 정본 — KB 공식 스펙 (kbsecurities/kb-openapi `samples.generated.json`, 2026-09-10 대조)
 *
 * **입력 8필드** (순서까지 스펙 그대로. `kbsec-tr-inputs.ts` 가 채운다)
 *
 * | 필드 | 뜻 | 값 |
 * |---|---|---|
 * | `trd_dt` | 매매일자 | `YYYYMMDD` (KST) |
 * | `clsf` | 구분 | **`1` 단가별 · `2` 종목별** |
 * | `trd_clsf` | 매매구분 | **`9` 전체 · `1` 매도 · `2` 매수** |
 * | `stmt_dt` | 결제일자 | KB 공식 예제가 `trd_dt` 와 같은 값을 넣는다 |
 * | `ac_nm`·`s_ec_sum`·`b_ec_sum`·`nxt_key` | 계좌명·매도/매수정산합계·다음키 | 빈 값 |
 *
 * `trd_clsf` 를 `1` 로 보내면 **매도만** 온다. 라이브 프로브가 `1` 로 돌아서
 * 관측한 국내 행이 전부 매도였고 매수는 한 건도 관측되지 않았다 — 그 표본으로 역산한 위탁
 * 수수료 실효율도 매도 쪽 값이다. 비용을 양쪽 다 덮으려면 `9` 여야 한다.
 * 0건과 "필터로 걸러진 0건" 이 응답에서 똑같아 보이는 경우라, 값을 상수로 고정해 둔다
 * ({@link KBSEC_SETTLE_TRD_CLSF}).
 *
 * **출력 30필드 중 이 파서가 읽는 것** — 나머지(융자·상환·주민세 등)는 현물 현금매매에서
 * 항상 0 이라 읽지 않되, 세금 합계에는 넣는다(신용·배당 계좌로 확장돼도 비용이 누락되지 않게).
 *
 * | 뜻 | 필드 | 비고 |
 * |---|---|---|
 * | 종목번호 | `is_no` | `A005930`·ISIN 표기 — `kbsecNormalizeCode` 로 6자리화 |
 * | 매매구분 | `trd_clsf` | 출력은 `char(8)` 이라 **코드가 아니라 이름**('매도')일 수 있다 |
 * | 거래구분 | `dl_clsf` | 방향 폴백('현금매도' 계열) |
 * | 체결수량 | `ccls_q` (폴백 `tl_ccls_q`) | |
 * | 체결단가 | `ccls_uprc` | 원화 |
 * | 거래금액 | `dl_amt` | 명목. 없으면 수량×단가 |
 * | 수수료 | `fee` | 위탁수수료 |
 * | 세금 | `dl_tx`+`ffs_tx`+`incm_tx`+`rsdnt_tx` | 거래세·농특세·소득세·주민세 |
 * | 정산금액 | `ec_amt` | 검산 전용 |
 *
 * `nxt_key`(다음키)가 응답에도 있다 — 한 페이지를 넘기는 날은 이어서 받아야 한다.
 * `SSQM1801` 이 연속조회를 따라가지 않아 2페이지 이후 보유가 통째로 "청산" 으로 읽힌 전례가
 * 있다. 페이지 처리는 어댑터
 * (`kbsec.fetchDomesticSettlements`)가 한다.
 *
 * `krx_ccls_amt`·`nxtd_ccls_amt` 는 KRX/넥스트레이드 체결금액 분리다. `clsf=1`(단가별)
 * 한 행이 두 거래소에 걸칠 수 있다는 뜻이지만, 비용은 `fee`·`dl_tx` 로 합쳐 오므로
 * 매칭 축에는 쓰지 않는다.
 */

import { kbsecNormalizeCode } from './kbsec-types';
import { kbsecNumber as num } from './kbsec-number';

/** 정산 행의 매매 방향. **모르면 null** — 소비처가 그 행을 버린다(추측 금지). */
export type KbsecSettlementSide = 'buy' | 'sell' | null;

/** `SSQM2121` 한 행을 정규화한 값. 통화는 전부 **원화**다. */
export interface KbsecSettlementRow {
    /** 도메인 종목코드(6자리). 못 읽으면 ''. */
    symbol: string;
    /** 매매 방향. 못 읽으면 null. */
    side: KbsecSettlementSide;
    /** 체결수량 (`ccls_q`, 폴백 `tl_ccls_q`). */
    quantity: number;
    /** 체결단가 (`ccls_uprc`, 원화). 0 이면 모른다는 뜻. */
    priceKrw: number;
    /** 거래금액 (`dl_amt`). 없으면 수량×단가, 단가도 0 이면 0. */
    notionalKrw: number;
    /** 위탁수수료 (`fee`). */
    feeKrw: number;
    /** 세금 합계 — 거래세·농특세·소득세·주민세. */
    taxKrw: number;
    /** 정산금액 (`ec_amt`). 비용이 이미 반영된 금액 — 검산에만 쓴다. */
    settledKrw: number;
    /**
     * **단가별 연속 행**인가 — 종목·방향 식별자가 비어 있다.
     *
     * `clsf=1`(단가별)로 부르면 한 종목의 두 번째 단가부터 `is_no`·`is_nm`·`trd_clsf` 가
     * 전부 공백인 행으로 온다. 이 행의 주인은 **바로 앞 헤더 행**이고, 귀속은 행 순서를
     * 아는 {@link kbsecResolveSettlementRows} 가 한다 — 행 하나만 보고는 알 수 없다.
     *
     * `kbsec-fill-row.ts` 의 `continuation` 은 `ordr_no` 가 **전부 0** 인 것을 신호로 쓰고
     * 빈 문자열은 제외한다("모르는 행을 남의 주문에 붙이지 않는다"). 여기서는 반대로
     * **빈 값이 신호다** — TR 이 다르고, 라이브 실측(`SSQM2121`)이 그렇게 준다.
     * 두 파일의 규칙이 어긋난 게 아니라 각 TR 이 쓰는 표기가 다른 것이다.
     */
    continuation: boolean;
}

/** `clsf`(구분) 입력 코드 — `1` 단가별 · `2` 종목별. */
export const KBSEC_SETTLE_CLSF = {
    /** 단가별 — 같은 종목·방향이라도 체결단가마다 행이 나뉜다. */
    BY_PRICE: '1',
    /** 종목별 — 하루치를 종목·방향 단위로 묶는다. */
    BY_SYMBOL: '2',
} as const;

/** `trd_clsf`(매매구분) 입력 코드 — `9` 전체 · `1` 매도 · `2` 매수. */
export const KBSEC_SETTLE_TRD_CLSF = {
    ALL: '9',
    SELL: '1',
    BUY: '2',
} as const;

/** 출력 `trd_clsf`/`dl_clsf` 가 코드로 올 때의 값 — 입력 코드와 같은 어휘로 본다. */
const SIDE_CODE_SELL = KBSEC_SETTLE_TRD_CLSF.SELL;
const SIDE_CODE_BUY = KBSEC_SETTLE_TRD_CLSF.BUY;

/**
 * 정산 행의 매매 방향.
 *
 * 출력 `trd_clsf` 는 스펙상 `char(8)` 이다 — 입력의 `char(1)` 코드와 길이가 달라 **이름
 * 문자열**('매도'·'현금매수' 계열)로 올 가능성이 크다. 어느 쪽이 오는지 라이브에서
 * 확정되지 않았으므로 **둘 다 받는다**. 체결 행의 `trd_dl_ccd_nm` 과 같은 판정 규칙이다
 * (`kbsecFillSideOf`) — 같은 이름을 두 규칙이 서로 다르게 해석하지 않도록 규칙도 같은 모양으로 둔다.
 *
 * 어느 쪽으로도 못 읽으면 **null** 이다. 방향을 모르는 비용을 매수·매도 중 한쪽에 붙이면
 * 매도세를 매수에 더하는 식으로 조용히 틀린다.
 */
export function kbsecSettlementSideOf(raw: Record<string, unknown>): KbsecSettlementSide {
    for (const key of ['trd_clsf', 'dl_clsf']) {
        const v = String(raw[key] ?? '').trim();
        if (v === '') continue;
        if (v === SIDE_CODE_SELL) return 'sell';
        if (v === SIDE_CODE_BUY) return 'buy';
        if (v.includes('매도')) return 'sell';
        if (v.includes('매수')) return 'buy';
    }
    return null;
}

/** `SSQM2121` 그리드 1행 → 정규화. 순수 함수(로그·I/O 없음). */
export function parseKbsecDomesticSettlementRow(raw: Record<string, unknown>): KbsecSettlementRow {
    const quantity = num(raw, 'ccls_q', 'tl_ccls_q');
    const priceKrw = num(raw, 'ccls_uprc');
    const notional = num(raw, 'dl_amt');
    const symbol = kbsecNormalizeCode(String(raw.is_no ?? '').trim());
    return {
        symbol,
        side: kbsecSettlementSideOf(raw),
        continuation: symbol === '',
        quantity,
        priceKrw,
        notionalKrw: notional > 0 ? notional : quantity * priceKrw,
        feeKrw: num(raw, 'fee'),
        // 현물 현금매매에서 소득세·주민세는 0 이지만, 신용·배당 계좌로 넓어져도 비용이 누락되지
        // 않게 합계에 넣는다. 없는 필드는 0 이라 지금 값이 달라지지 않는다.
        taxKrw: num(raw, 'dl_tx') + num(raw, 'ffs_tx') + num(raw, 'incm_tx') + num(raw, 'rsdnt_tx'),
        settledKrw: num(raw, 'ec_amt'),
    };
}

/**
 * 이 행의 **총 매매비용**(원화) — `Trade.fee` 에 들어갈 값.
 *
 * `ec_amt` 가 아니다. `ec_amt` 는 비용이 이미 빠진 정산금액이라 그걸 비용으로 쓰면
 * 부호도 축도 어긋난다. 비용은 수수료 + 세금이다.
 */
export function kbsecSettlementCostKrw(row: KbsecSettlementRow): number {
    return row.feeKrw + row.taxKrw;
}

/** 검산 여유(원). 비용 항목 넷이 각각 원 단위로 끊기므로 그만큼은 열어 둔다. */
export const SETTLEMENT_CONSISTENCY_TOLERANCE_KRW = 4;

/**
 * 연속 행을 앞 헤더 행에 귀속시키고, **종목 묶음 단위로 검산**한다.
 *
 * ## 왜 행 단위로 검산하면 안 되나 (라이브 실측)
 *
 * `clsf=1` 로 부르면 한 종목이 여러 행으로 쪼개지고, **`fee`·`ec_amt` 는 묶음의 마지막
 * 행에만** 실린다.
 *
 * ```
 * 매수 종목A q=97 tl=0 dl_amt=1,843,000 fee=0 ec_amt=0
 * (공백) q=14 tl=111 dl_amt= 266,140 fee=200 ec_amt=2,109,340
 * ```
 *
 * 행 하나만 놓고 `|거래금액 − 정산금액| ≈ 비용` 을 보면 둘 다 틀린 답이 나온다. 첫 행은
 * 정산금액이 0 이라 잴 수 없고, 둘째 행은 `|266,140 − 2,109,340|` 이 비용 200 과 한참
 * 어긋난다 — 멀쩡한 행이 "필드 오독" 으로 버려지고, 그 버려진 행이 **비용이 실린
 * 행**이다. 남는 건 `fee=0` 인 헤더뿐이라 그 종목은 비용 0 으로 읽힌다.
 *
 * 묶음으로 보면 맞는다 — `|(1,843,000+266,140) − 2,109,340| = 200` 이 비용과 같다.
 *
 * ## 무엇을 돌려주나
 *
 * 식별자를 채운 행들. 검산에 실패한 묶음은 **통째로** 버린다(일부만 남기면 그룹 합계가
 * 모자란 채로 안분에 들어간다). 주인 없는 연속 행(페이지 경계 등)도 버린다 — 귀속할 곳을
 * 모르는 비용을 남의 종목에 붙이지 않는다.
 */
export function kbsecResolveSettlementRows(
    rows: readonly KbsecSettlementRow[],
    toleranceKrw = SETTLEMENT_CONSISTENCY_TOLERANCE_KRW,
): { rows: KbsecSettlementRow[]; inconsistent: number; orphaned: number } {
    const resolved: KbsecSettlementRow[] = [];
    let header: KbsecSettlementRow | null = null;
    let orphaned = 0;

    for (const row of rows) {
        if (!row.continuation) {
            header = row;
            resolved.push(row);
            continue;
        }
        if (!header) { orphaned++; continue; }
        resolved.push({ ...row, symbol: header.symbol, side: header.side, continuation: false });
    }

    // ── 묶음 단위 검산 ────────────────────────────────────────────────────
    const groups = new Map<string, KbsecSettlementRow[]>();
    for (const r of resolved) {
        const key = `${r.symbol}|${r.side ?? '?'}`;
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
    }

    const out: KbsecSettlementRow[] = [];
    let inconsistent = 0;
    for (const group of groups.values()) {
        const notional = group.reduce((sum, r) => sum + r.notionalKrw, 0);
        const cost = group.reduce((sum, r) => sum + kbsecSettlementCostKrw(r), 0);
        // 정산금액은 묶음의 마지막 행에만 실린다 — 0 이 아닌 값을 집는다.
        const settled = group.reduce((max, r) => Math.max(max, r.settledKrw), 0);
        // 잴 근거가 없으면(정산금액 0) 통과시킨다. 검산 불가와 검산 실패는 다르다.
        if (notional > 0 && settled > 0
            && Math.abs(Math.abs(notional - settled) - cost) > toleranceKrw) {
            inconsistent += group.length;
            continue;
        }
        out.push(...group);
    }
    return { rows: out, inconsistent, orphaned };
}
