/**
 * @fileoverview KB증권 TR 별 **입력 필드 정본** — 부분 바디로 호출하면 거부당한다.
 *
 * ## 왜 이 파일이 있는가
 *
 * KB 는 TR 마다 정해진 **입력 레이아웃 전체**를 검증한다. 값이 필요 없는 필드라도
 * 키 자체가 없으면 업무 오류(`processFlag 'B'`)로 거부한다. 예:
 *
 * SSQM1801(보유주식)에 `{inq_clsf, nxt_key}` 만 보냄(`mkt_tm_ccd` 누락)
 * → `KB증권 업무 오류 (SSQM1801): 시장 구분값을 확인하세요 [processCode=3576]`
 *
 * 즉 **"필수값"이라고 표시돼 있지 않아도 키가 있어야 한다**. 판정을 호출부에 맡기지 않고,
 * 클라이언트가 이 표를 보고 **누락 필드를 빈 문자열로 채워** 보낸다 (`fillTrInputs`).
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
 * `KBSEC_TR` 에 등재된 TR 전부를 담는다 — 아직 미배선인 TR 도 포함해, 나중에
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
    /** 주식시간대별추이 */
    IVU10080: ['excg_clsf', 'is_cd', 'ovtm_mkt_clsf', 'inq_cnt'],
    /** 종목관리(마스터) */
    SIAM4983: [],
    /** 장운영상태 조회 */
    SZQM0771: [],
    /** 공휴일관리 */
    SPAM2508: ['hndl_clsf', 'iso_cd', 'dr_dt', 'end_dt', 'nxt_bsnss_dy', 'nxt_stlmt_dt', 'hldy_ccd', 'frgn_stk_ordr_psbl_f'],
    /** 종목기본정보 */
    SIQM4900: ['stnd_is_cd'],
    /** 종목별투자자 */
    IVU10430: ['excg_clsf', 'is_cd', 'strt_dt', 'end_dt', 'amt_q_clsf', 'trd_clsf', 'acml_clsf'],
    /** 등락률상위 */
    IVU10240: ['excg_clsf', 'mkt_clsf', 'inq_cnt', 'srt_clsf'],
    /** 거래량상위 */
    IVU10280: ['excg_clsf', 'mkt_clsf'],
    /** 프로그램매매상위 */
    IVS10920: ['inq_cnt'],
    /** 거래대금상위 */
    IVU10210: ['excg_clsf', 'mkt_clsf', 'thdy_bdy_clsf', 'inq_cnt', 'srt_clsf'],
    /** 시가대비등락률상위 */
    IVS10910: ['mkt_clsf', 'inq_cnt', 'srt_clsf'],
    /** 환율종합 — 입력 필드 없음 */
    IVA60190: [],
    /** 세계지수 */
    IVA60140: ['lnd_clsf'],
    /** 종목기업개요 */
    IVM10050: ['is_cd'],
    /** 신고/신저 */
    IVU10550: ['excg_clsf', 'mkt_clsf', 'inq_cnt', 'nw_stk_lw_ccd', 'std_clsf', 'prd_clsf', 'excd_clsf'],
    /** 외국인기관매매상위 */
    IVU10020: ['excg_clsf', 'mkt_clsf', 'invstr_ccd', 'prd_clsf', 'rnk_clsf'],
    /** 증시주변자금동향 — 입력 필드 없음 */
    IVA10370: [],
    /** 기간외등락률순위 */
    IVS11190: ['mkt_clsf', 'srt_clsf', 'thdy_bdy_clsf', 'inq_cnt'],
    /** 급등/급락 상위 */
    IVU10270: ['excg_clsf', 'mkt_clsf', 'inq_cnt', 'up_dwn_ccd', 'minute_dy_ccd', 'minute_dy_unt'],
    /** 당일주요외국계거래원 */
    IVU10420: ['excg_clsf', 'is_cd'],
    /** 종목별프로그램매매추이 */
    IVU10450: ['excg_clsf', 'is_cd', 'amt_q_clsf', 'prd_clsf', 'inq_cnt'],
    /** 시장종합 — 입력이 없다 */
    IVSA0070: [],
    /** 테마그룹조회 */
    IVS11430: ['thm_cd'],
    /** 업종랭킹 */
    IVM30010: ['mkt_clsf'],

    // ── 투자정보 (해외)
    /** 해외 현재가 */
    GSS10030: ['krx_cd', 'is_cd'],
    /** 해외 호가 */
    GSS10040: ['krx_cd', 'is_cd'],
    /** 해외 차트 */
    GSC10060: ['krx_cd', 'is_cd', 'chrt_clsf', 'bndl', 'mdfy_stk_prc_use_f', 'rcrd_c', 'srch_strt_dy', 'clsf'],
    /** 해외 시간대별체결 */
    GSA10020: ['krx_cd', 'is_cd', 'rcrd_c'],

    // ── 고객계좌
    /** 예수금내역 */
    SSQM0004: ['is_no'],
    /** 보유주식 조회 */
    SSQM1801: ['inq_clsf', 'is_no', 'mkt_tm_ccd', 'spclz_ordr_ccd', 'act_cd', 'nxt_key'],
    /** 계좌자산평가 — 입력이 하나뿐이다(A:통합시세 K:KRX N:NXT). 2026-09-05 라이브 확인. */
    SSQM2952: ['excg_mktpr_ccd'],
    /** 주식자산평가조회(실시간) */
    SSQN2952: ['is_cd', 'sum_clsf', 'spclz_ordr_ccd', 'nxt2_dy_tfnd_xcl_f', 'excg_mktpr_ccd'],
    /** 종합계좌 잔고현황 조회 */
    SSQM2932: ['inq_clsf', 'scrts_ccd', 'bnd_val_wy_cd', 'excg_mktpr_ccd'],
    /** 총 잔고 조회 */
    SSQM0005: ['inq_clsf', 'tl_val_amt', 'tl_tfnd_amt', 'tl_o_amt_psbl_amt', 'nxt_key', 'gds_grp_cd', 'ccls_stmt_clsf'],
    /** 평가손익 조회 */
    SSQM0006: ['inq_clsf', 'spclz_ordr_ccd', 'trd_clsf', 'act_cd', 'nxt_key', 'is_cd'],
    /** 국내주식 소수점 매매 보유잔고내역 조회 — `hd_pin_no`(현대PIN번호)는 옛 현대증권 시절 필드로 보인다(선택 입력, 비워 보낸다) */
    SSQM5472: ['jb_ccd', 'is_cd', 'std_dt', 'hd_pin_no', 'nxt_key'],
    /** 계좌원장 거래내역 조회(위탁·금융상품·저축) */
    SWQA2301: [
        'inq_clsf', 'inq_clsf1', 'inq_clsf2', 'inq_clsf3', 'inq_clsf4', 'inq_clsf5', 'inq_clsf6', 'strt_dt', 'end_dt', 'is_no',
        'strt_no', 'nxt_key', 'srt_clsf', 'dl_clsf', 'dl_md_ccd', 'md_isnc_tno', 'crdt_crd_isnc_info', 'onl_prt_ccd', 'isng_bl_at_trsns_xcl_f',
    ],
    /** 계좌원장 거래내역 조회(CMA) — 위탁 원장과 달리 `dl_clsf`가 없고 `csh_asts_itst_i_amt_xcl_f`가 있다 */
    SWQB2301: [
        'inq_clsf', 'inq_clsf1', 'inq_clsf2', 'inq_clsf3', 'inq_clsf4', 'inq_clsf5', 'inq_clsf6', 'strt_dt', 'end_dt', 'is_no',
        'nxt_key', 'strt_no', 'dl_md_ccd', 'md_isnc_tno', 'crdt_crd_isnc_info', 'onl_prt_ccd', 'srt_clsf', 'isng_bl_at_trsns_xcl_f',
        'csh_asts_itst_i_amt_xcl_f',
    ],
    /** 익일·익익일 출금가능금액 조회 */
    SWQN2302: ['ccd'],
    /** 개인별쿠폰 조회 */
    SZQM6019: ['rprst_cs_no', 'st_clsf'],
    /** 거래내역상세 조회 */
    SWQM2412: ['inq_dt', 'dl_sq', 'nxt_key'],
    /** 예수금조회 — 입력이 없다 */
    SWQM2302: [],
    /** 글로벌원마켓 증거금사용현황 — 입력이 없다 */
    SPQN3390: [],
    /** 매매정산현황상세(원마켓플러스) — 입력이 없다 */
    SKQO3390: [],

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
    /** 소수점 매매 내역 조회 */
    SSQM5765: ['ordr_clsf', 'trd_clsf', 'trd_strt_dt', 'trd_end_dt', 'is_cd', 'nxt_key'],
    /** 온주/소수점 주문체결내역 조회 */
    SSQM5475: ['inq_strt_dt', 'inq_end_dt', 'trd_clsf', 'is_cd', 'ordr_st', 'dl_clsf', 'nxt_key'],
    /** 예약주문접수(현금신용통합) */
    SSAM0831: ['ordr_jb_clsf', 'is_cd', 'ordr_uprc', 'ordr_q', 'ordr_ccd', 'crdt_typ_cd', 'ln_dt', 'cncl_ordr_no', 'tv_rv_ccd',
        'strt_dt', 'end_dt', 'mkt_tm_ccd'],
    /** 예약주문처리 조회 */
    SSQM0831: ['ordr_dt', 'nxt_key', 'trd_clsf', 'hndl_clsf', 'tv_rv_ccd', 'end_dt', 'is_cd'],
    /** 예약주문접수 조회 */
    SSQM0834: ['hndl_clsf', 'nxt_key', 'chc_clsf', 'inq_clsf', 'strt_dt', 'end_dt', 'is_cd'],
    /** 계좌권리발생내역 */
    SRQM3051: ['strt_dt', 'rgt_clsf', 'is_cd', 'nxt_key'],

    // ── 트레이딩 (해외)
    /** 해외 매도/매수주문 */
    SKAM2101: ['frgn_krx_ccd', 'trd_dl_ccd', 'is_cd', 'frgn_ordr_typ_cd', 'frgn_ordr_q', 'frgn_ordr_prc_p4',
        'spclz_ordr_ccd', 'set_ordr_no', 'bskt_ordr_no', 'cutn_mtr_cnfr_f', 'aplc_exch_r', 'start_tm',
        'end_tm', 'frgn_stp_prc_p4', 'frgn_brkr_ccd', 'ordr_mntnc_tm_ccd', 'cpn_cd', 'crdt_typ_cd', 'ln_dt'],
    /** 해외 정정/취소주문 — 취소 구분 필드는 `crct_cncl_clsf` 다(`crct_clsf` 아님). */
    SKAM2102: ['frgn_krx_ccd', 'crct_cncl_clsf', 'is_cd', 'orgn_ordr_no', 'frgn_ordr_prc_p4', 'set_ordr_no',
        'bskt_ordr_no', 'cutn_mtr_cnfr_f', 'aplc_exch_r', 'start_tm', 'end_tm', 'frgn_ordr_typ_cd',
        'spclz_ordr_ccd', 'frgn_stp_prc_p4'],
    /** 소수점매도/매수주문 */
    SKAM2201: ['frgn_krx_ccd', 'trd_dl_ccd', 'is_cd', 'amt_q_clsf', 'tv_s_est_f', 'frgn_ordr_typ_cd', 'crncy_ccd',
        'ordr_amt', 'dcml_ordr_q_p6', 'frgn_ordr_prc_p4', 'spclz_ordr_ccd', 'cpn_cd', 'cutn_mtr_cnfr_f'],
    /** 해외 소수점 주문가능금액 — 필드 뜻은 짝 주문 TR `SKAM2201` 명세를 따른다 */
    SPQN5472: ['is_cd', 'frgn_krx_ccd', 'ordr_amt', 'dcml_ordr_q_p6', 'amt_q_clsf', 'crncy_ccd', 'frgn_ordr_typ_cd', 'frgn_ordr_prc_p4'],
    /** 해외 소수점 보유잔고내역 */
    SPQM5472: ['is_cd', 'frgn_krx_ccd', 'std_dt', 'krw_fcrncy_ccd', 'nxt_key'],
    /** 해외 소수점 주문접수내역(주문용) */
    SPQN5473: ['trd_clsf', 'is_cd', 'frgn_krx_ccd', 'ordr_st', 'nxt_key', 'spclz_ordr_ccd'],
    /** 해외 소수점 주문접수내역조회 */
    SPQM5473: ['dprt_clsf', 'brn_no', 'inq_clsf', 'sum_clsf', 'ordr_st', 'trd_strt_dt', 'trd_end_dt', 'trd_clsf', 'krw_fcrncy_ccd', 'is_cd',
        'frgn_krx_ccd', 'mngr_eno', 'nxt_key'],
    /** 주식예약주문(미국) */
    SPAO2104: ['is_cd', 'trd_dl_ccd', 'ordr_typ_cd', 'ordr_q', 'frgn_ordr_prc_p4', 'strt_tm', 'end_tm', 'ovtm_ordr_ccd', 'bskt_ordr_no',
        'frgn_stp_prc_p4'],
    /** 예약주문취소(미국) */
    SPAO2106: ['is_cd', 'trd_clsf', 'ordr_typ', 'ordr_q', 'frgn_ordr_prc_p4', 'cncl_ordr_no'],
    /** 해외 주문번호별주문내역 */
    SPQM1818: ['strt_ordr_dt', 'end_ordr_dt', 'ccls_clsf', 'frgn_krx_ccd', 'trd_clsf', 'stnd_is_cd', 'iso_cd', 'krw_unty_mgn_rqst_f',
        'start_tm', 'end_tm', 'dl_clsf', 'nxt_key'],
    /** 해외 주문체결조회 */
    SPQM2103: ['ccls_clsf', 'clsf', 'ordr_dt', 'is_cd', 'krw_unty_mgn_rqst_f', 'dl_clsf', 'nxt_key'],
    /** 원마켓플러스 주문가능금액 (종목·가격 지정) */
    SKQM2106: ['crncy_cd', 'stnd_is_cd', 'iso_cd', 'frgn_ordr_prc_p4', 'ordr_prc'],
    /** 원마켓플러스 주문가능금액 현황 */
    SKQM3350: [],
    /** 해외 주문가능금액(원마켓이 아닌 계좌) */
    SPQM2106: ['crncy_cd', 'stnd_is_cd', 'iso_cd', 'frgn_ordr_prc_p4', 'aplc_exch_r', 'ordr_prc'],
    /** 해외 체결현황 */
    SPQM2204: ['strt_ordr_dt', 'end_ordr_dt', 'ccls_clsf', 'frgn_krx_ccd', 'trd_clsf', 'stnd_is_cd', 'iso_cd', 'krw_unty_mgn_rqst_f',
        'dl_clsf', 'drid_f', 'nxt_key'],
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
