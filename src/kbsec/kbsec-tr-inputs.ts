/**
 * @fileoverview KB증권 TR 별 **입력 필드 정본** — 부분 바디로 호출하면 거부당한다.
 *
 * ## 왜 이 파일이 있는가 (2026-08-11 라이브 실측)
 *
 * KB 는 TR 마다 정해진 **입력 레이아웃 전체**를 검증한다. 값이 필요 없는 필드라도
 * 키 자체가 없으면 업무 오류(`processFlag 'B'`)로 거부한다. 실측 사례:
 *
 * SSQM1801(보유주식)에 `{inq_clsf, nxt_key}` 만 보냄
 * → `KB증권 업무 오류 (SSQM1801): 시장 구분값을 확인하세요 [processCode=3576]`
 *
 * 빠진 것은 `mkt_tm_ccd`(시장시간구분코드) 였다. 즉 **"필수값"이라고 표시돼 있지 않아도
 * 키가 있어야 한다**. 공식 예제 콘솔이 모든 필드를 빈 문자열로라도 실어 보내는 이유다.
 *
 * 이 결함은 호출부마다 반복된다 — 어댑터가 처음 배선될 때 각 호출부가 "필요해 보이는
 * 필드만" 담았고, 그 중 읽기 TR 하나가 라이브에서 오류가 나고서야 드러났다. 주문 TR 은
 * 17개 필드 중 9개만 보내고 있었는데 **KB 는 모의투자 서버가 없어 실주문 전까지
 * 발견될 수 없는 상태**였다. 그래서 판정을 호출부에 맡기지 않고, 클라이언트가 이 표를
 * 보고 **누락 필드를 빈 문자열로 채워** 보낸다 (`fillTrInputs`).
 *
 * ## 출처
 *
 * KB 공식 예제 저장소의 테스트 콘솔 스펙에서 옮겼다 —
 * <https://github.com/kbsecurities/kb-openapi> `frontend/src/app/openapi-test/
 * samples.generated.json` 의 `inputSpec[].name` (2026-08-11 기준).
 * **필드 순서까지 스펙 그대로**다. 새 TR 을 배선하면 이 표에도 한 줄 추가한다
 * (미등재 TR 은 채우기 없이 그대로 나가므로 조용히 부분 바디가 된다 — 테스트가 이를 막는다).
 */

import { logger } from '../logger';

/**
 * TR 코드 → 입력 필드 이름 목록 (공식 스펙 순서).
 *
 * `KBSEC_TR` 에 등재된 30개 TR 전부를 담는다 — 아직 미배선인 TR 도 포함해, 나중에
 * 배선할 때 이 표를 다시 찾아야 하는 일이 없게 한다.
 */
export const KBSEC_TR_INPUTS: Readonly<Record<string, readonly string[]>> = {
    // ── 투자정보 (국내)
    /** 주식현재가 */
    IVU10140: ['excg_clsf', 'shrt_cd'],
    /** 주식호가 */
    IVU10070: ['is_cd', 'ovtm_mkt_clsf'],
    /** 통합차트 */
    IVS11560: ['info_ccd', 'mkt_clsf', 'chrt_clsf', 'minute_tck_indx', 'is_cd', 'inq_clsf', 'strt_dy', 'inq_cnt'],
    /** 종목관리(마스터) */
    SIAM4983: [],
    /** 장운영상태 조회 */
    SZQM0771: [],

    // ── 투자정보 (해외)
    /** 해외 현재가 */
    GSS10030: ['krx_cd', 'is_cd'],
    /** 해외 호가 */
    GSS10040: ['krx_cd', 'is_cd'],
    /** 해외 차트 */
    GSC10060: ['krx_cd', 'is_cd', 'chrt_clsf', 'bndl', 'mdfy_stk_prc_use_f', 'rcrd_c', 'srch_strt_dy', 'clsf'],

    // ── 고객계좌
    /** 예수금내역 */
    SSQM0004: ['is_no'],
    /** 보유주식 조회 */
    SSQM1801: ['inq_clsf', 'is_no', 'mkt_tm_ccd', 'spclz_ordr_ccd', 'act_cd', 'nxt_key'],
    /** 계좌자산평가 — 입력이 하나뿐이다(A:통합시세 K:KRX N:NXT). 2026-09-05 라이브 확인. */
    SSQM2952: ['excg_mktpr_ccd'],

    // ── 트레이딩 (국내)
    /** 매수주문가능금액 조회 */
    SSQM1802: ['is_no', 'bnd_mktio_ccd'],
    /** 현금매수주문 */
    SSAM1802: ['mkt_tm_clsf', 'ordr_jb_clsf', 's_clsf', 'is_cd', 'ordr_q', 'ordr_uprc', 'ordr_ccd',
        'crdt_typ_cd', 'ln_dt', 'crct_clsf', 'orgn_ordr_no', 'gtc_ccd', 'ordr_mng_no', 'spclz_ordr_ccd',
        'acct_cd', 'sor_ordr_ccd', 'stpd_prc'],
    /** 현금매도주문 */
    SSAM1801: ['mkt_tm_clsf', 'ordr_jb_clsf', 's_clsf', 'is_cd', 'ordr_q', 'ordr_uprc', 'ordr_ccd',
        'crdt_typ_cd', 'ln_dt', 'crct_clsf', 'orgn_ordr_no', 'gtc_ccd', 'ordr_mng_no', 'spclz_ordr_ccd',
        'acct_cd', 'sor_ordr_ccd', 'stpd_prc'],
    /** 정정주문 */
    SSAM1805: ['mkt_tm_clsf', 'ordr_jb_clsf', 's_clsf', 'is_cd', 'ordr_q', 'ordr_uprc', 'ordr_ccd',
        'crdt_typ_cd', 'ln_dt', 'crct_clsf', 'orgn_ordr_no', 'gtc_ccd', 'ordr_mng_no', 'spclz_ordr_ccd',
        'acct_cd', 'sor_ordr_ccd', 'stpd_prc'],
    /** 취소주문 */
    SSAM1806: ['mkt_tm_clsf', 'ordr_jb_clsf', 's_clsf', 'is_cd', 'ordr_q', 'ordr_uprc', 'ordr_ccd',
        'crdt_typ_cd', 'ln_dt', 'crct_clsf', 'orgn_ordr_no', 'gtc_ccd', 'ordr_mng_no', 'spclz_ordr_ccd',
        'acct_cd', 'sor_ordr_ccd', 'stpd_prc'],
    /** 주문체결현황 */
    SSQM0832: ['ccd', 'inq_ccd', 'cn_clsf', 'is_typ_ccd', 'ordr_no', 'ordr_dt', 's_ccls_amt', 'b_ccls_amt',
        'ccls_uprc', 'stnd_is_no', 'nxt_key', 'trd_clsf'],
    /**
     * 계좌별매매가정산현황. `clsf` 는 `1` 단가별·`2` 종목별, `trd_clsf` 는
     * `9` 전체·`1` 매도·`2` 매수 — 값 뜻은 `kbsec-settlement-row.ts` 헤더가 정본이다.
     */
    SSQM2121: ['trd_dt', 'clsf', 'trd_clsf', 'ac_nm', 's_ec_sum', 'b_ec_sum', 'stmt_dt', 'nxt_key'],
    /** 계좌별주문체결조회 */
    SSQM2341: ['inq_clsf', 'ccls_clsf', 'ordr_dt', 'is_cd', 'ordr_no', 'mthr_ordr_no', 'orgn_ordr_no',
        's_ccls_amt', 'b_ccls_amt', 's_ccls_q', 'b_ccls_q', 'ac_nm', 'is_nm', 'cn_clsf', 'nxt_key'],
    /** 일자별실현손익상세 */
    SSQM2442: ['is_cd', 'inq_strt_dt', 'inq_end_dt', 'md_clsf', 'nxt_key'],
    /** 종목별기간실현손익 */
    SSQM2443: ['inq_strt_dt', 'inq_end_dt', 'md_clsf', 'nxt_key'],
    /** 기간매매손익현황 */
    SSQM2392: ['is_no', 'ordr_dt_from', 'ordr_dt_to', 'trd_svrl_cst', 'trd_pl', 'trd_nt_pl', 'inq_clsf', 'nxt_key'],
    /** 소수점 매수 */
    SSAM5763: ['is_cd', 'ordr_q_p6', 'ordr_amt', 'spclz_ordr_ccd', 'dcml_ordr_std_ccd', 'rsv_typ_ordr_f',
        'rsv_typ_ordr_acpt_dt', 'rsv_typ_ordr_sq', 'rsv_typ_ordr_sqc', 'rsv_amt', 'acpt_sq', 'cpn_cd',
        'tv_s_est_f', 'dmstc_stk_dcml_trd_jb_ccd', 'ordr_sqc', 'dmstc_stk_dcml_evnt_ccd'],
    /** 소수점 매도 */
    SSAM5762: ['is_cd', 'ordr_q_p6', 'ordr_amt', 'spclz_ordr_ccd', 'dcml_ordr_std_ccd', 'rsv_typ_ordr_f',
        'rsv_typ_ordr_acpt_dt', 'rsv_typ_ordr_sq', 'rsv_typ_ordr_sqc', 'rsv_amt', 'acpt_sq', 'cpn_cd',
        'tv_s_est_f', 'dmstc_stk_dcml_trd_jb_ccd', 'ordr_sqc', 'dmstc_stk_dcml_evnt_ccd'],
    /** 소수점 주문 취소 */
    SSAM5764: ['is_cd', 'ordr_q_p6', 'ordr_amt', 'spclz_ordr_ccd', 'dcml_ordr_std_ccd', 'rsv_typ_ordr_f',
        'rsv_typ_ordr_acpt_dt', 'rsv_typ_ordr_sq', 'rsv_typ_ordr_sqc', 'rsv_amt', 'acpt_sq', 'cpn_cd',
        'tv_s_est_f', 'dmstc_stk_dcml_trd_jb_ccd', 'ordr_sqc', 'dmstc_stk_dcml_evnt_ccd', 'ordr_dt',
        'bnf_is_cd', 'trd_dl_ccd', 'dmstc_stk_dcml_ordr_sq'],
    /** 소수점 매매 주문가능금액 확인 */
    SSQN5472: ['is_cd', 'ordr_amt'],

    // ── 트레이딩 (해외)
    /** 해외 매도/매수주문 */
    SKAM2101: ['frgn_krx_ccd', 'trd_dl_ccd', 'is_cd', 'frgn_ordr_typ_cd', 'frgn_ordr_q', 'frgn_ordr_prc_p4',
        'spclz_ordr_ccd', 'set_ordr_no', 'bskt_ordr_no', 'cutn_mtr_cnfr_f', 'aplc_exch_r', 'start_tm',
        'end_tm', 'frgn_stp_prc_p4', 'frgn_brkr_ccd', 'ordr_mntnc_tm_ccd', 'cpn_cd', 'crdt_typ_cd', 'ln_dt'],
    /** 해외 정정/취소주문 — 취소 구분 필드는 `crct_cncl_clsf` 다(`crct_clsf` 아님). */
    SKAM2102: ['frgn_krx_ccd', 'crct_cncl_clsf', 'is_cd', 'orgn_ordr_no', 'frgn_ordr_prc_p4', 'set_ordr_no',
        'bskt_ordr_no', 'cutn_mtr_cnfr_f', 'aplc_exch_r', 'start_tm', 'end_tm', 'frgn_ordr_typ_cd',
        'spclz_ordr_ccd', 'frgn_stp_prc_p4'],
    /** 해외 주문체결조회 */
    SPQM2103: ['ccls_clsf', 'clsf', 'ordr_dt', 'is_cd', 'krw_unty_mgn_rqst_f', 'dl_clsf', 'nxt_key'],
    /** 원마켓플러스 주문가능금액 (종목·가격 지정) */
    SKQM2106: ['crncy_cd', 'stnd_is_cd', 'iso_cd', 'frgn_ordr_prc_p4', 'ordr_prc'],
    /** 원마켓플러스 주문가능금액 현황 */
    SKQM3350: [],
    /** 원마켓 계좌증거금조회 */
    SPQM3390: [],
    /** 해외 잔고평가조회 — 종목별 보유(`is_cd`·`frgn_hld_q_p6`·`now_prc_p4`) + 통화별 예수금 */
    SPQM2226: ['std_crncy_f', 'exch_r_aplc_f', 'fee_clsf', 'srt_clsf', 'rsrv_ordr_f',
        'tl_asts_exch_val_amt', 'tl_tfnd_exch_val_amt', 'tl_scrts_exch_val_amt',
        'tl_krw_val_amt', 'tl_krw_val_pl_amt', 'cn_f', 'nxt_key'],
    /**
     * 매매가정산현황(해외). `trd_clsf` 는 **두 자리**다 — `99` 전체·`01` 매도·
     * `02` 매수. 국내 `SSQM2121` 의 한 자리 값을 보내면 0건이 돌아온다. 값 뜻은
     * `kbsec-overseas-settlement-row.ts` 헤더가 정본이다.
     */
    SPQM2205: ['strt_ordr_dt', 'end_ordr_dt', 'frgn_krx_ccd', 'trd_clsf', 'stnd_is_cd', 'iso_cd',
        's_stmt_amt_sum_p4', 'b_stmt_amt_sum_p4', 'tl_s_ccls_q_p6', 'tl_b_ccls_q_p6',
        'fcrncy_fee_p4', 'krw_unty_mgn_rqst_f', 'dl_clsf', 'nxt_key'],
} as const;

/**
 * 스펙에 정의된 모든 입력 필드를 갖춘 dataBody 를 만든다.
 *
 * - 호출부가 준 값은 그대로 두고, **빠진 필드만 빈 문자열로 채운다**.
 * - 필드 순서는 스펙 순서를 따른다(KB 콘솔 요청과 같은 모양으로 보내기 위함).
 * - 스펙에 없는 키를 호출부가 넘기면 **경고 후 그대로 실어 보낸다** — 오타(예: 해외
 *   취소의 `crct_clsf` ↔ 정본 `crct_cncl_clsf`)를 조용히 삼키지 않되, 스펙이 낡았을
 *   가능성도 있어 호출 자체를 막지는 않는다.
 * - 미등재 TR 은 입력을 그대로 통과시킨다(채우기 없음).
 */
export function fillTrInputs(
    trCode: string,
    values: Record<string, unknown>,
): Record<string, unknown> {
    const spec = KBSEC_TR_INPUTS[trCode.toUpperCase()];
    if (!spec) return values;

    const known = new Set<string>(spec);
    const unknown = Object.keys(values).filter(k => !known.has(k));
    if (unknown.length > 0) {
        logger.warn({ trCode, unknown, spec },
            '[KBSecTrInputs] 스펙에 없는 입력 필드 — 필드명 오타 가능성(그대로 전송)');
    }

    const out: Record<string, unknown> = {};
    for (const field of spec) {
        out[field] = values[field] ?? '';
    }
    for (const k of unknown) out[k] = values[k];
    return out;
}
