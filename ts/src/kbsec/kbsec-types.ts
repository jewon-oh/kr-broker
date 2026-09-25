/**
 * @fileoverview KB증권 Open API 전용 타입·상수
 * @description REST-only. 국내·해외 주식 현물 (오픈베타 2026-07-20 개시).
 *
 * 인증: OAuth2 Client Credentials (appKey/appSecret → access_token).
 * Base URL: https://developer.kbsec.com:32484 ← **비표준 포트**다. 나가는 연결이 이 포트로 열려 있어야 한다.
 *
 * 전문(電文) 계열 규격이라 토스/KIS 와 방식이 다르다:
 * - 엔드포인트가 기능이 아니라 **TR 코드**다: `POST /api/v1/{trcode}` (조회도 전부 POST).
 * - 요청/응답이 `{ dataHeader, dataBody }` 봉투로 감싸인다.
 * - 필드가 전부 `char` 이고 길이가 고정 — 금액·수량·가격 모두 문자열이다.
 * - **업무 오류도 HTTP 200** 으로 내려온다. 상태코드만 보면 실패한 주문을 성공으로 기록한다.
 *
 * 스펙 출처: KB증권 API 포털 문서와 공식 예제 저장소(2026-08-08 대조).
 *
 * KB 는 모의투자 서버가 없어(운영 단일 환경) 검증은 실계좌로만 한다. TR 별 검증 수준은
 * `docs/coverage/kbsec.json` 의 `verified` 를 본다.
 */

import { ExchangeError } from '../base/errors';
import { isKrxDomesticCode } from '../broker-krx-code';
import { symbolBaseCode, type StockMarketGroup } from '../broker-market-group';
import { isKrxBusinessDayKst } from '../krx-trading-hours';

// ============ 접속 상수 ============

/** KB증권 Open API 운영 도메인. 모의투자 환경 없음 — 운영 단일 엔드포인트. */
export const KBSEC_API_BASE = 'https://developer.kbsec.com:32484';

/** OAuth2 토큰 발급 경로. */
export const KBSEC_TOKEN_PATH = '/oauth2/token';

/**
 * OAuth2 토큰 **폐기** 경로 (장애 대응용).
 *
 * 공식 문서에 없어 실측으로 확인했다: 잘못된 경로는 `E991 Not Found API` 를 주는데 이 경로는
 * `E021 앱키로 앱정보 추출 중 오류`(빈 본문) → `T022 유효하지 않은 클라이언트 정보`(appKey 만)
 * 로 **본문을 읽어 가며 단계적으로 다른 오류**를 준다. 즉 핸들러가 실재한다.
 */
export const KBSEC_REVOKE_PATH = '/oauth2/revoke';

/** TR 호출 경로 prefix — `${KBSEC_TR_PATH_PREFIX}${trcode.toLowerCase()}`. */
export const KBSEC_TR_PATH_PREFIX = '/api/v1/';

/** 토큰 만료 안전 마진(ms) — expires_in 에서 이만큼 앞당겨 재발급. */
export const KBSEC_TOKEN_SAFETY_MARGIN_MS = 60 * 1000;

/** expires_in 누락 시 기본 토큰 유효기간(ms) — 가이드 예시 86400s(24h). */
export const KBSEC_TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// ============ 자격증명 ============

export interface KbsecCredentials {
    /** 포털에서 발급한 appKey. TR 호출 시 헤더로도 보낸다. */
    appKey: string;
    /** 포털에서 발급한 appSecret. 토큰 발급에만 쓴다. */
    appSecret: string;
    /**
     * 사람이 계좌를 구분하려는 메모(`uid`)다. **KB 는 계좌번호를 받지 않아**(계좌가 appKey 에 묶인다)
     * 어떤 요청에도 보내지 않는다.
     */
    accountNo?: string | undefined;
}

// ============ 봉투(envelope) ============

/** 요청 dataHeader — 서버사이드 호출은 빈 문자열로 보내도 처리된다(공식 예제 동일). */
export interface KbsecDataHeader {
    ipAddr: string;
    macAddr: string;
}

/** 모든 TR 요청 공통 봉투. */
export interface KbsecRequestEnvelope<T = Record<string, unknown>> {
    dataHeader: KbsecDataHeader;
    dataBody: T;
}

/**
 * 응답 봉투. `dataBody` 앞머리에 공통 출력 필드가 붙는다:
 * o_lngth(출길이) · o_clsf(출구분) · o_msg(출메시지)
 * 성패는 이 필드가 아니라 `dataHeader.processFlag` 로 가른다(`kbsec-envelope.ts`).
 */
export interface KbsecResponseEnvelope<T = Record<string, unknown>> {
    /** 업무 성패가 여기 담긴다 — processFlag 'A'=성공/'B'=실패 (실측 2026-08-09). */
    dataHeader?: Record<string, unknown>;
    dataBody?: T & KbsecCommonOutput;
}

export interface KbsecCommonOutput {
    /** 출길이 */
    o_lngth?: string;
    /** 출구분. 값 체계가 명세에 없어 성패 판정에 쓰지 않는다. */
    o_clsf?: string;
    /** 출메시지 — 오류 시 사유가 담긴다. */
    o_msg?: string;
}

/** 토큰 발급 응답 dataBody. */
export interface KbsecTokenResponse {
    access_token?: string;
    accessToken?: string;
    token_type?: string;
    expires_in?: number;
}

export interface KbsecCachedToken {
    accessToken: string;
    expiresAt: number;
}

// ============ TR 코드 ============

/**
 * 이 어댑터가 쓰는 TR 코드. 전체 93종 목록은 KB증권 API 포털 문서를 참조한다.
 * 값은 소문자로 경로에 붙는다 (`SSAM1802` → `/api/v1/ssam1802`).
 *
 * **여기 있다고 다 동작하는 게 아니다.** 어댑터 메서드가 실제로 호출하는 것만 배선된
 * 것이며, 미배선 항목은 `[미배선]` 으로 표시했다. 상수만 보고 "지원한다"고 읽으면
 * 안 된다 — 배선 여부는 `kbsec.ts` 의 호출부가 정본이다.
 */
export const KBSEC_TR = {
    // ── 투자정보 (국내)
    /** 주식현재가 */
    QUOTE_KR: 'IVU10140',
    /** 주식호가 */
    ORDERBOOK_KR: 'IVU10070',
    /** 통합차트 — 일·주·월·년·분·틱 + 원주가/수정주가 */
    CHART_KR: 'IVS11560',
    /** 주식시간대별추이 — 시간대별 체결가·체결수량(국내) */
    TRADES_TIMELINE_KR: 'IVU10080',
    /** [미배선] 종목관리(마스터) — 명세에 입력이 없고, 실계좌(2026-09-24)에서 입력 없이 부르면 1861(자료 없음)과 빈 행만 온다 */
    MASTER_KR: 'SIAM4983',
    /** 장운영상태 */
    MARKET_STATUS: 'SZQM0771',
    /** 공휴일관리(미국) — 처리구분은 설명의 조회(`4`)를 보낸다 */
    HOLIDAYS_US: 'SPAM2508',
    /** 종목기본정보 — 종목명, 종목유형, 매매제한, 위험등급 */
    SECURITY_INFO: 'SIQM4900',
    /** 종목별투자자 — 개인·외국인·기관 등 13개 유형별 순매수·매수·매도 */
    INVESTOR_TRADING: 'IVU10430',
    /** 등락률상위 */
    RANK_FLUCTUATION: 'IVU10240',
    /** 거래량상위 */
    RANK_VOLUME: 'IVU10280',
    /** 프로그램매매상위 */
    RANK_PROGRAM_TRADING: 'IVS10920',
    /** 거래대금상위 */
    RANK_TRADING_VALUE: 'IVU10210',
    /** 시가대비등락률상위 */
    RANK_OPEN_CHANGE_RATE: 'IVS10910',
    /** 환율종합 */
    EXCHANGE_RATES: 'IVA60190',
    /** 세계지수 */
    WORLD_INDICES: 'IVA60140',
    /** 종목기업개요 */
    COMPANY_PROFILE: 'IVM10050',
    /** 신고/신저 */
    NEW_HIGH_LOW: 'IVU10550',
    /** 외국인기관매매상위 */
    INVESTOR_RANKING: 'IVU10020',
    /** 증시주변자금동향 */
    MARKET_FUND_FLOW: 'IVA10370',
    /** 기간외등락률순위 */
    RANK_EXTENDED_HOURS_CHANGE_RATE: 'IVS11190',
    /** 급등/급락 상위 */
    RANK_SURGE_PLUNGE: 'IVU10270',
    /** 당일주요외국계거래원 */
    FOREIGN_BROKERS: 'IVU10420',
    /** 종목별프로그램매매추이 */
    PROGRAM_TRADING_TREND: 'IVU10450',
    /** 시장종합 */
    MARKET_OVERVIEW: 'IVSA0070',
    /** 테마그룹조회 */
    THEME_GROUPS: 'IVS11430',
    /** 업종랭킹 — 필드가 같은 그리드 둘을 준다 */
    RANK_SECTOR: 'IVM30010',

    // ── 투자정보 (해외)
    /** 해외 현재가 */
    QUOTE_US: 'GSS10030',
    /** 해외 호가 */
    ORDERBOOK_US: 'GSS10040',
    /** 해외 차트 — 15분 지연 시세다. 봉 시각은 미국 동부 현지 시각이다 */
    CHART_US: 'GSC10060',
    /** 해외 시간대별체결 */
    TRADES_TIMELINE_US: 'GSA10020',

    // ── 고객계좌
    /** 예수금내역 */
    DEPOSIT: 'SSQM0004',
    /** 보유주식 조회 */
    HOLDINGS: 'SSQM1801',
    /**
     * 계좌자산평가 — 국내·해외 보유를 **한 번에** 준다. 국내 보유 조회의 1순위다.
     *
     * `SSQM1801` 에 없는 `byng_avr_prc`(매입평균가) · `now_prc`(현재가) · `val_amt`(평가금액) · `is_nm`(종목명)과
     * **`ec_q`(실보유수량)**, `nstmt_s_q`/`nstmt_b_q`(미결제 매도·매수)를 **분리해서** 준다. 매도 후 결제대기 종목은 `ec_q=0` 이다.
     *
     * 이 TR 이 실패하면 보유주식(`SSQM1801`) 경로로 내려가 `max(gnrl_q, ordr_psbl_q)` 추정과 체결내역 스캔으로 보정한다.
     */
    ASSET_EVAL: 'SSQM2952',
    /** 주식자산평가조회(실시간) */
    ASSET_EVAL_REALTIME: 'SSQN2952',
    /** 총 잔고 조회 — 계좌별 평가액, 예수금, 출금가능금액 */
    ACCOUNT_SUMMARY: 'SSQM0005',
    /** 종합계좌 잔고현황 조회(종합위탁계좌, 신연금저축계좌) — 2026-09-24 실계좌 확인 */
    INTEGRATED_BALANCE: 'SSQM2932',
    /** 평가손익 조회 */
    UNREALIZED_PNL: 'SSQM0006',
    /** 국내주식 소수점 매매 보유잔고내역 조회 */
    FRAC_HOLDINGS_KR: 'SSQM5472',
    /** 계좌원장 거래내역 조회(위탁·금융상품·저축) */
    LEDGER: 'SWQA2301',
    /** 계좌원장 거래내역 조회(CMA) */
    LEDGER_CMA: 'SWQB2301',
    /** 익일·익익일 출금가능금액 조회 */
    WITHDRAWABLE: 'SWQN2302',
    /** 개인별쿠폰 조회 */
    COUPONS: 'SZQM6019',
    /** 거래내역상세 조회 — 거래 한 건(일자와 거래일련번호)의 상세 */
    LEDGER_DETAIL: 'SWQM2412',
    /** 예수금조회 — 대용총액(`sbt_tl_amt`)이 한 레코드에 두 번 있다 */
    DEPOSIT_DETAIL: 'SWQM2302',
    /** 글로벌원마켓 증거금사용현황 */
    ONEMARKET_MARGIN_USAGE: 'SPQN3390',
    /** 매매정산현황상세(원마켓플러스) */
    ONEMARKET_SETTLEMENT_DETAIL: 'SKQO3390',

    // ── 트레이딩 (국내)
    /** 매수주문가능금액 조회 */
    BUYABLE_KR: 'SSQM1802',
    /** 현금매수주문 */
    BUY_KR: 'SSAM1802',
    /** 현금매도주문 */
    SELL_KR: 'SSAM1801',
    /** 정정주문 */
    AMEND_KR: 'SSAM1805',
    /** 취소주문 */
    CANCEL_KR: 'SSAM1806',
    /**
     * [미배선] 주문체결현황 — 권한이 없는 계정에서는 HTTP 500 과 `processCode=I446`("API 사용 권한이 없습니다.")을 준다.
     * 미체결 조회는 `TRADES_KR`(SSQM2341, `ccls_clsf=2`)로 한다.
     */
    ORDERS_KR: 'SSQM0832',
    /** 계좌별주문체결조회 */
    TRADES_KR: 'SSQM2341',
    /**
     * 계좌별매매가정산현황 — **KB 가 실제로 청구한 국내 매매비용의 정본**.
     *
     * 체결 TR(`SSQM2341`)에는 수수료 필드가 아예 없다. 건별 `fee`(위탁수수료)·`dl_tx`(거래세)·
     * `ffs_tx`(농특세)와 `ec_amt`(정산금액)를 주는 곳은 여기뿐이라, `Trade.fee` 를 추정치에서
     * 실청구액으로 바꾸는 경로가 이 TR 을 지난다. 행 파서는 `kbsec-settlement-row.ts` 가 정본.
     */
    SETTLEMENT_KR: 'SSQM2121',
    /** 일자별실현손익상세 — 매체구분(`md_clsf`)은 호출하는 쪽이 고른다 */
    PNL_DAILY: 'SSQM2442',
    /** 종목별기간실현손익 — 종목 단위 기간 합계라 개별 매매로 못 쪼갠다. */
    PNL_BY_SYMBOL: 'SSQM2443',
    /** 기간매매손익현황 */
    PNL_PERIOD: 'SSQM2392',
    /** 소수점 매수 / 매도 / 취소 */
    FRAC_BUY_KR: 'SSAM5763',
    FRAC_SELL_KR: 'SSAM5762',
    /** [미배선] 소수점 주문 취소 */
    FRAC_CANCEL_KR: 'SSAM5764',
    /** 소수점 주문가능금액 */
    FRAC_BUYABLE_KR: 'SSQN5472',
    /** 소수점 매매 내역 조회 */
    FRAC_TRADES_KR: 'SSQM5765',
    /** 온주/소수점 주문체결내역 조회 */
    FRAC_ORDERS_KR: 'SSQM5475',
    /** 예약주문접수(현금신용통합) */
    RESERVED_ORDER_KR: 'SSAM0831',
    /** 예약주문처리 조회 */
    RESERVED_RESULTS_KR: 'SSQM0831',
    /** 예약주문접수 조회 */
    RESERVED_ORDERS_KR: 'SSQM0834',
    /** 계좌권리발생내역 */
    CORPORATE_ACTIONS: 'SRQM3051',

    // ── 트레이딩 (해외)
    /** 해외 매도/매수주문 */
    ORDER_US: 'SKAM2101',
    /** 해외 정정/취소주문 */
    AMEND_CANCEL_US: 'SKAM2102',
    /**
     * 소수점매도/매수주문 — 금액(`amt_q_clsf='0'`) 또는 수량 기준으로 낸다. 미국만 지원한다.
     * 주문유형코드(`frgn_ordr_typ_cd`)가 `ORDER_US` 와 다른 코드표를 쓴다 — `2`(지정가)·`E`(유사시장가) 뿐이다.
     */
    FRAC_ORDER_US: 'SKAM2201',
    /** 해외 소수점 주문가능금액 조회 */
    FRAC_BUYABLE_US: 'SPQN5472',
    /** 해외 소수점 보유잔고내역 조회 */
    FRAC_HOLDINGS_US: 'SPQM5472',
    /** 해외 소수점 주문접수내역 조회(주문용) */
    FRAC_ORDERS_US: 'SPQN5473',
    /** 해외 소수점 주문접수내역조회 — 기간, 체결 결과와 요약 그리드를 준다 */
    FRAC_ORDER_HISTORY_US: 'SPQM5473',
    /** 주식예약주문(미국) */
    RESERVED_ORDER_US: 'SPAO2104',
    /** 예약주문취소(미국) */
    RESERVED_CANCEL_US: 'SPAO2106',
    /** 해외 주문번호별주문내역 */
    ORDER_HISTORY_US: 'SPQM1818',
    /** 해외 주문체결조회 — 해외 **체결 확정**의 조달처. 해외 체결은 국내 체결 TR 에 없다. */
    ORDERS_US: 'SPQM2103',
    /** 원마켓플러스 주문가능금액 (종목·가격 지정) — 원화환산 주문가능액을 준다 */
    ONEMARKET_BUYABLE: 'SKQM2106',
    /** 원마켓플러스 주문가능금액 현황(통화별 총괄) */
    ONEMARKET_BUYABLE_ALL: 'SKQM3350',
    /** 해외 주문가능금액 — 원마켓이 아닌 계좌용 */
    BUYABLE_US: 'SPQM2106',
    /** 해외 체결현황 — `ORDER_HISTORY_US`(SPQM1818)와 달리 단축종목코드를 준다 */
    ORDER_STATUS_US: 'SPQM2204',
    /** 원마켓 계좌증거금 — 원화·원화환산 외화 예수금 */
    ONEMARKET_MARGIN: 'SPQM3390',
    /**
     * 해외 잔고평가조회 — **해외 보유 종목의 정본**. 포털 문서의 "고객계좌 해외" 표가 아니라 **트레이딩 분류**에 있다.
     *
     * 응답에 **그리드가 둘**이다 — 통화별 예수금(`crncy_clsf_nm`·`tfnd`…)과 종목별
     * 보유(`is_cd`·`frgn_hld_q_p6`…). 첫 배열을 집으면 예수금 쪽을 집는다.
     */
    HOLDINGS_US: 'SPQM2226',
    /**
     * 매매가정산현황(해외) — **KB 가 실제로 청구한 해외 매매비용의 정본**.
     *
     * 해외 체결 TR(`SPQM2103`)에도 수수료·환율 필드가 없다. 건별 `frgn_trd_fee_p4`(매매수수료)·
     * `frgn_dl_tx_p4`(거래세=SEC fee)와 `frgn_stmt_amt_p4`(정산금액)를 주는 곳은 여기뿐이다.
     * 행 파서는 `kbsec-overseas-settlement-row.ts` 가 정본.
     *
     * 국내 `SETTLEMENT_KR` 과 **매매구분 도메인이 다르다** — 여기는 `char(2)` 의
     * `99`/`01`/`02` 고 국내는 `char(1)` 의 `9`/`1`/`2` 다. 국내 값을 그대로 보내면 KB 가
     * `processCode 1861`("조회할 자료가 없습니다")로 답해 **거부가 "거래 없음" 과 똑같아 보인다.**
     */
    SETTLEMENT_US: 'SPQM2205',
} as const;

/**
 * **주문을 바꾸는 TR** — 발주·정정·취소. 나머지는 전부 조회다.
 *
 * KB 는 조회도 `POST /api/v1/{trcode}` 라 메서드로는 못 가른다. 그래서 코드로 가른다.
 *
 * 이 목록이 요청 시간 상한의 계약을 정한다(`kbsec.ts` 가 이 목록으로 주문 요청을 가른다). 조회는 상한이
 * 걸리면 버리고 넘어가도 되지만, 주문은 **접수 여부가 미확정**(`OrderOutcomeUnknown`)이라 재시도가 곧 중복 주문이다.
 * 여기서 빠뜨린 주문 TR 은 조회로 취급돼 "버려도 되는 실패" 가 된다 — 그래서
 * 주문·취소·정정 계열 TR 을 추가할 때는 반드시 이 목록에도 넣는다.
 */
export const KBSEC_ORDER_TR_CODES: ReadonlySet<string> = new Set<string>([
    KBSEC_TR.BUY_KR,
    KBSEC_TR.SELL_KR,
    KBSEC_TR.AMEND_KR,
    KBSEC_TR.CANCEL_KR,
    KBSEC_TR.FRAC_BUY_KR,
    KBSEC_TR.FRAC_SELL_KR,
    KBSEC_TR.FRAC_CANCEL_KR,
    KBSEC_TR.ORDER_US,
    KBSEC_TR.AMEND_CANCEL_US,
    KBSEC_TR.FRAC_ORDER_US,
    KBSEC_TR.RESERVED_ORDER_KR,
    KBSEC_TR.RESERVED_ORDER_US,
    KBSEC_TR.RESERVED_CANCEL_US,
]);

/** 이 TR 이 주문을 바꾸는가 — 대소문자 무관(경로는 소문자로 붙는다). */
export function isKbsecOrderTr(trCode: string): boolean {
    return KBSEC_ORDER_TR_CODES.has(trCode.trim().toUpperCase());
}

// ============ 코드 매핑 ============

/**
 * 국내 주문구분코드 (`ordr_ccd`). 지정가·시장가와 스톱지정가(`createTriggerOrder`)만 쓴다.
 * FOK/IOC 계열(`F0`·`F3`·`F5` 등)도 명세에 있으나 쓰지 않는다.
 */
export const KBSEC_ORDER_TYPE_KR = {
    LIMIT: '00',
    MARKET: '03',
    /** 스톱지정가 — 조건가격(`stpd_prc`)에 닿으면 `ordr_uprc` 지정가 주문이 된다. */
    STOP_LIMIT: 'S0',
} as const;

/** 국내 주문업무구분 (`ordr_jb_clsf`). */
export const KBSEC_ORDER_SIDE_KR = {
    SELL: '1',
    BUY: '2',
    AMEND: '3',
    CANCEL: '4',
} as const;

/** 신용유형코드 (`crdt_typ_cd`) — 현금만 쓴다. */
export const KBSEC_CREDIT_CASH = '00';

/**
 * 시장시간구분 (`mkt_tm_clsf`) — 정규장만 쓴다.
 * 시간외(2~4)는 KB 명세엔 있으나 세션 판정·가격 규칙이 KIS/토스와 달라 라이브 검증 전까지 보류.
 */
export const KBSEC_SESSION_REGULAR = '1';

/**
 * 해외 거래소코드(`krx_cd`) 후보 — 미국 3개소. 호출하는 쪽이 심볼의 상장 거래소를 항상 아는 건
 * 아니라 순서대로 시도한다(적중분은 어댑터가 캐시).
 *
 * 전체 코드: NAS 나스닥 · NYS 뉴욕 · AMX 아멕스 · HKS 홍콩 · SHS 상하이 · SZS 심천 ·
 * TSE 일본 · HSX 호치민 · HNX 하노이. 현재 유니버스는 미국뿐이라 셋만 둔다.
 */
export const KBSEC_US_EXCHANGES: readonly string[] = ['NAS', 'NYS', 'AMX'];

/** 조회구분 (`inq_clsf`, SSQM2341) — `1` 주식 · `2` 장내채권 · `5` ELW · `6` 일반상품 · `9` 전체. */
export const KBSEC_INQ_STOCK = '1';
/**
 * 조회구분 '전체'.
 *
 * 위 값 표는 **SSQM2341(체결/미체결)** 기준이다. 보유주식(SSQM1801)에서 같은 의미인지는
 * 명세에 없어, 잔고 조회는 `1` 을 먼저 쓰고 0건일 때만 이 값으로 재시도하며
 * 무엇이 통했는지 로그로 남긴다(`fetchHoldingRows`).
 */
export const KBSEC_INQ_ALL = '9';

/**
 * 체결구분 (`ccls_clsf`, SSQM2341) — `0` 전체 · `1` 체결 · `2` 미체결.
 *
 * 빈 값으로 보내면 거부된다 — 실측 2026-08-11: `체결구분을 확인하십시오 [processCode=8654]`.
 */
export const KBSEC_CCLS_ALL = '0';
export const KBSEC_CCLS_FILLED = '1';
export const KBSEC_CCLS_PENDING = '2';

/**
 * 매매구분 (`trd_clsf`, SSQM2341/SPQM2103 체결 행) — `1` 매도 · 그 외 매수.
 * 이 규칙은 이 상수 한 곳에만 둔다.
 */
export const KBSEC_TRD_SELL = '1';

/** 연속구분 (`cn_clsf`) — `0` 기본(첫 페이지) · `1` 연속. */
export const KBSEC_CONT_FIRST = '0';
export const KBSEC_CONT_NEXT = '1';

/**
 * 조회일자(`ordr_dt`) 용 **한국 시각 기준** 오늘 — `YYYYMMDD`.
 *
 * UTC 날짜를 그대로 쓰면 15:00 UTC(=자정 KST) 이후로 하루가 어긋난다. KRX 정규장
 * 시간대(00:00~06:30 UTC)만 보면 우연히 맞지만, 호출하는 쪽은 장 밖에서도 조회한다.
 */
export function kbsecTodayKst(): string {
    return kbsecDateKst(new Date());
}

/**
 * 임의 시각의 **한국 날짜** — `YYYYMMDD`. 주문 시각(UTC 저장)으로 그 주문의 `ordr_dt` 를
 * 만들 때 쓴다. 02:32Z 에 낸 주문은 같은 날 11:32 KST 주문이지만, 15:00Z 이후의 주문은
 * UTC 날짜로 보내면 하루 전 체결내역을 뒤지게 된다.
 */
export function kbsecDateKst(at: Date): string {
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 미국 동부(ET) 날짜 포매터 — DST 는 IANA `America/New_York` 룰이 처리한다. */
const US_EASTERN_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * 임의 시각의 **미국 현지 날짜** — `YYYYMMDD`. 해외 주문의 `ordr_dt` 축이다.
 *
 * 해외에 {@link kbsecDateKst} 를 쓰면 안 된다. 미국 정규장은 KST 로 22:30~05:00(겨울
 * 23:30~06:00)이라 **자정을 넘긴 체결이 하루 뒤로 밀린다.** UTC 날짜도 겨울(EST)의
 * 19:00~20:00 ET 에서 다음 날이 되어 어긋난다.
 */
export function kbsecDateUsEastern(at: Date): string {
    return US_EASTERN_DATE_FORMATTER.format(at).replace(/-/g, '');
}

/** KST 오프셋을 더한 Date — `getUTC*` 가 곧 한국 시각/요일이 된다. */
/**
 * 조회 기준일(`ordr_dt`) — **KB 의 `현재일자` 는 영업일**이라 주말·휴장일엔 직전 영업일에 머문다.
 *
 * 캘린더 날짜를 그대로 보내면 그날 조회가 **전량 거부**된다:
 * `주문일자가 현재일자보다 큽니다 [processCode=2854]`. 같은 TR 을 쓰는 **체결 조회**도 함께 실패한다.
 *
 * 주말과 KRX 휴장일(`isKrxBusinessDayKst`)을 건너뛴다. 휴장일 표에 없는 휴장일은 호출부가 `2854` 를 만나면 한 칸씩 더
 * 되감아 재시도하고, 그때 WARN 을 남겨 **모르는 휴장일을 사후에 알 수 있게** 한다.
 *
 * @param stepsBack 0 = 오늘 기준 가장 최근 영업일, 1 = 그 직전 영업일, …
 * @param now 기준 시각. 증권사 인스턴스는 자기 시계(`milliseconds()`)를 넘긴다.
 */
export function kbsecBusinessDateKst(stepsBack = 0, now: Date = new Date()): string {
    const d = new Date(now.getTime() + 9 * 60 * 60 * 1000);   // 한국 날짜를 UTC 필드로 읽는다
    let remaining = stepsBack;
    // 휴장일 표가 잘못되어 모든 날이 휴장으로 보여도 멈추게 상한을 둔다. 1년이면 어떤 연휴도 넘는다.
    for (let days = 0; days < 366 + stepsBack * 7; days++) {
        const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
        if (isKrxBusinessDayKst(ymd)) {
            if (remaining === 0) return ymd;
            remaining -= 1;
        }
        d.setUTCDate(d.getUTCDate() - 1);
    }
    throw new ExchangeError(`KB 조회 기준일을 찾지 못했다: 최근 1년에 KRX 영업일이 없다(stepsBack=${stepsBack})`);
}

/** {@link kbsecBusinessDateKst} 의 미국 현지 날짜판 — 해외 조회의 `ordr_dt` 축이다. 주말만 되감는다. */
export function kbsecBusinessDateUsEastern(stepsBack = 0, now: Date = new Date()): string {
    const ymd = kbsecDateUsEastern(now);
    const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
    let remaining = stepsBack;
    for (;;) {
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) {
            if (remaining === 0) break;
            remaining -= 1;
        }
        d.setUTCDate(d.getUTCDate() - 1);
    }
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** `주문일자가 현재일자보다 큽니다` — 조회일자가 KB 영업일보다 앞설 때. */
export const KBSEC_CODE_FUTURE_QUERY_DATE = '2854';

// ── 해외 잔고평가(SPQM2226) 입력 코드
/** 기준통화여부 — `1` 외화기준. 보유 평가를 외화(USD)로 받아 `quoteCurrency:'USD'` 와 맞춘다. */
export const KBSEC_STD_CURRENCY_FOREIGN = '1';
/** 환율적용여부 — `2` 매매기준환율(원화). 원화 환산 필드에만 영향. */
export const KBSEC_EXCH_RATE_MARKET = '2';
/** 수수료구분 — `1` 미포함. 평가금액에 수수료를 섞지 않는다(계약은 순수 평가금액). */
export const KBSEC_FEE_EXCLUDED = '1';

/**
 * SOR 주문구분코드 (`sor_ordr_ccd`) — 대체거래소 라우팅.
 * KB 는 이걸 주문 필드로 직접 노출한다(KIS 대비 명시적).
 */
export const KBSEC_SOR = {
    KRX: 'K',
    NXT: 'N',
    SOR: 'S',
} as const;

/** 해외 매매거래구분코드 (`trd_dl_ccd`). */
export const KBSEC_ORDER_SIDE_US = {
    SELL: '01',
    BUY: '02',
} as const;

/**
 * 해외 주문유형코드 (`frgn_ordr_typ_cd`). 시장가·지정가와 스톱지정가(`C`, `createTriggerOrder`)만 쓴다.
 * VWAP/TWAP/MOO/MOC 도 명세에 있으나 쓰지 않는다.
 */
export const KBSEC_ORDER_TYPE_US = {
    MARKET: '1',
    LIMIT: '2',
    /**
     * 알고리즘 주문 — 개인용 API 로는 드문 기능이다. 브로커가 슬라이싱을 대신하므로
     * 호출하는 쪽의 자체 TWAP 구현을 대체할 수 있다.
     * VWAP/TWAP 는 `start_tm`/`end_tm`(HHMMSS) 구간 지정이 사실상 필수다.
     * 라이브 미검증 — 체결 품질·수수료 확인 전까지 기본값으로 쓰지 말 것.
     */
    VWAP_MARKET: '3',
    TWAP_MARKET: '4',
    MOO: '5',
    MOC: '6',
    VWAP_LIMIT: '7',
    TWAP_LIMIT: '8',
    /** 스톱시장가 — 명세엔 있으나 라이브 미검증. 지금은 `STOP_LIMIT`만 쓴다. */
    STOP_MARKET: 'B',
    /** 스톱지정가 — 조건가격(`frgn_stp_prc_p4`)에 닿으면 `frgn_ordr_prc_p4` 지정가 주문이 된다. */
    STOP_LIMIT: 'C',
} as const;

/** 해외 알고리즘 주문 유형 판별 — start_tm/end_tm 이 필요한 유형인가. */
export function kbsecIsAlgoOrderType(t: string): boolean {
    return ['3', '4', '7', '8'].includes(t);
}

/** 해외 거래소코드 (`krx_cd`) — 시세 TR 용. */
export const KBSEC_OVERSEAS_EXCHANGE = {
    NASDAQ: 'NAS',
    NYSE: 'NYS',
    AMEX: 'AMX',
    HONGKONG: 'HKS',
    SHANGHAI: 'SHS',
    SHENZHEN: 'SZS',
    TOKYO: 'TSE',
    HOCHIMINH: 'HSX',
    HANOI: 'HNX',
} as const;

/** 통합차트 차트구분 (`chrt_clsf`). */
export const KBSEC_CHART_KIND = {
    DAY: 'D',
    WEEK: 'W',
    MONTH: 'M',
    YEAR: 'Y',
    MINUTE: 'B',
    TICK: 'T',
} as const;

// ============ 심볼 헬퍼 ============

/** @deprecated `StockMarketGroup` 을 쓴다. 다음 판에서 지운다. */
export type KBSecMarketCountry = StockMarketGroup;

/** 도메인 심볼('005930/KRW' · 'AAPL/USD') → 시장 구분. 국내 종목코드 모양이면 KR, 아니면 US. */
export function kbsecMarketOf(symbol: string): StockMarketGroup {
    return isKrxDomesticCode(kbsecBaseSymbol(symbol)) ? 'KR' : 'US';
}

/** 도메인 심볼 → API 종목코드 (base 만). 클래스 주식의 `BRK/B` 는 통합 표기 `BRK.B` 로 바꾼다. */
export function kbsecBaseSymbol(symbol: string): string {
    return symbolBaseCode(symbol.trim()).trim();
}

/**
 * KB 응답의 종목코드 → 도메인 코드(6자리).
 *
 * KB 는 국내 단축코드를 **`A` 접두**로 준다(`A005930`, KRX 표준 표기). 그대로 넘기면 6자리 숫자가 아니라
 * `kbsecMarketOf` 가 **해외 종목으로 오판**하므로 여기서 벗긴다.
 *
 * 표준종목번호(ISIN, `KR7005930003`)로 오는 필드도 같은 곳에서 흡수한다.
 */
export function kbsecNormalizeCode(raw: string): string {
    const s = (raw ?? '').trim();
    // 신형 영숫자 코드(`A0193L0`)도 같은 접두를 단다. 벗긴 결과가 국내 코드 모양일 때만 벗긴다.
    const prefixed = /^A([0-9A-Za-z]{6})$/.exec(s)?.[1];
    if (prefixed !== undefined && isKrxDomesticCode(prefixed)) return prefixed;
    const isin = /^KR7([0-9A-Za-z]{6})[0-9A-Za-z]{3}$/.exec(s)?.[1];
    if (isin !== undefined && isKrxDomesticCode(isin)) return isin;
    return s;
}

/**
 * KB 는 수량·가격을 문자열로 받는다. 지수표기(1e-7)·부동소수 꼬리가 그대로 실려
 * 거부되는 것을 막으려 고정 소수점 문자열로 정규화한다.
 */
export function kbsecNum(value: number, decimals = 0): string {
    if (!Number.isFinite(value)) return '0';
    return value.toFixed(decimals);
}

/** @deprecated `KbsecCredentials` 를 쓴다. 다음 판에서 지운다. */
export type KBSecCredentials = KbsecCredentials;
/** @deprecated `KbsecDataHeader` 를 쓴다. 다음 판에서 지운다. */
export type KBSecDataHeader = KbsecDataHeader;
/** @deprecated `KbsecRequestEnvelope` 를 쓴다. 다음 판에서 지운다. */
export type KBSecRequestEnvelope<T = Record<string, unknown>> = KbsecRequestEnvelope<T>;
/** @deprecated `KbsecResponseEnvelope` 를 쓴다. 다음 판에서 지운다. */
export type KBSecResponseEnvelope<T = Record<string, unknown>> = KbsecResponseEnvelope<T>;
/** @deprecated `KbsecCommonOutput` 을 쓴다. 다음 판에서 지운다. */
export type KBSecCommonOutput = KbsecCommonOutput;
/** @deprecated `KbsecTokenResponse` 를 쓴다. 다음 판에서 지운다. */
export type KBSecTokenResponse = KbsecTokenResponse;
/** @deprecated `KbsecCachedToken` 을 쓴다. 다음 판에서 지운다. */
export type KBSecCachedToken = KbsecCachedToken;
/** @deprecated `isKbsecOrderTr` 를 쓴다. 다음 판에서 지운다. */
export const isKBSecOrderTr = isKbsecOrderTr;
