/**
 * @fileoverview KB증권 Open API 전용 타입·상수
 * @description REST-only. 국내·해외 주식 현물 (오픈베타 2026-07-20 개시).
 *
 * 인증: OAuth2 Client Credentials (appKey/appSecret → access_token).
 * Base URL: https://developer.kbsec.com:32484 ← **비표준 포트**. egress 443 만 열린
 * 환경(일부 k8s NetworkPolicy·사내망)에서는 그대로 막히니 배선 전 개방 확인이 필요하다.
 *
 * 전문(電文) 계열 규격이라 토스/KIS 와 방식이 다르다:
 * - 엔드포인트가 기능이 아니라 **TR 코드**다: `POST /api/v1/{trcode}` (조회도 전부 POST).
 * - 요청/응답이 `{ dataHeader, dataBody }` 봉투로 감싸인다.
 * - 필드가 전부 `char` 이고 길이가 고정 — 금액·수량·가격 모두 문자열이다.
 * - **업무 오류도 HTTP 200** 으로 내려온다. 상태코드만 보면 실패한 주문을 성공으로 기록한다.
 *
 * 스펙 출처: KB증권 API 포털 문서와 공식 예제 저장소(2026-08-08 대조).
 *
 * **라이브 미검증**: KB 는 모의투자/샌드박스 서버를 제공하지 않아(운영 단일 환경),
 * 이 어댑터는 명세 기준으로만 작성됐다. 실계좌 키 등록 후 응답 대조가 필요하며,
 * 특히 주문 계열은 최소 수량·체결 불가 지정가로 스모크한 뒤 사용할 것.
 */

import { isKrxDomesticCode } from '../broker-krx-code';

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

/**
 * 원마켓(통합증거금) 사용 기능 플래그.
 *
 * KB 원마켓/원마켓플러스는 **원화로 미국 주식을 산다** — USD 사전 환전이 필요 없다.
 * 켜면 US 매수여력을 `krw_exch_unty_ordr_psbl_amt`(원화환산 통합 주문가능금액) 기준으로
 * 읽어, 달러 예수금이 0 이어도 원화로 주문할 수 있다.
 * 끄면 외화 예수금(`fcrncy_ordr_psbl_amt`)만 본다 — 통합증거금 미신청 계좌 기준.
 *
 * 토스의 `toss-krw-integrated-margin` 과 같은 개념이며 기본값도 동일하게 off 로 둔다
 * (계좌가 통합증거금에 가입돼 있어야 의미가 있어, 켜는 건 계좌 확인 후 결정).
 */
export const KBSEC_KRW_INTEGRATED_MARGIN_FLAG = 'kbsec-krw-integrated-margin';

// ============ 자격증명 ============

export interface KBSecCredentials {
    /** 포털에서 발급한 appKey. TR 호출 시 헤더로도 보낸다. */
    appKey: string;
    /** 포털에서 발급한 appSecret. 토큰 발급에만 쓴다. */
    appSecret: string;
    /**
     * 계좌 식별자 — **KB 는 TR 본문에 계좌번호를 받지 않는다**(93개 TR 전수 확인).
     * 계좌가 appKey 에 바인딩되는 구조로 보이며, 이 필드는 로깅·다계좌 구분용 메모다.
     * 멀티 계좌 운용은 appKey 를 계좌 수만큼 발급해야 할 가능성이 크다(신청 시 확인 필요).
     */
    accountNo?: string;
}

// ============ 봉투(envelope) ============

/** 요청 dataHeader — 서버사이드 호출은 빈 문자열로 보내도 처리된다(공식 예제 동일). */
export interface KBSecDataHeader {
    ipAddr: string;
    macAddr: string;
}

/** 모든 TR 요청 공통 봉투. */
export interface KBSecRequestEnvelope<T = Record<string, unknown>> {
    dataHeader: KBSecDataHeader;
    dataBody: T;
}

/**
 * 응답 봉투. `dataBody` 앞머리에 공통 출력 필드가 붙는다:
 * o_lngth(출길이) · o_clsf(출구분) · o_msg(출메시지)
 * 업무 오류가 HTTP 200 으로 오므로 이 필드들이 성패 판정의 유일한 근거다.
 */
export interface KBSecResponseEnvelope<T = Record<string, unknown>> {
    /** 업무 성패가 여기 담긴다 — processFlag 'A'=성공/'B'=실패 (실측 2026-08-09). */
    dataHeader?: Record<string, unknown>;
    dataBody?: T & KBSecCommonOutput;
}

export interface KBSecCommonOutput {
    /** 출길이 */
    o_lngth?: string;
    /** 출구분 — 정상/오류 구분값. 값 체계가 명세에 없어 o_msg 와 함께 판정한다. */
    o_clsf?: string;
    /** 출메시지 — 오류 시 사유가 담긴다. */
    o_msg?: string;
}

/** 토큰 발급 응답 dataBody. */
export interface KBSecTokenResponse {
    access_token?: string;
    accessToken?: string;
    token_type?: string;
    expires_in?: number;
}

export interface KBSecCachedToken {
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
    /** 종목관리(마스터) — 조회조건 없이 호출하면 전 종목 */
    MASTER_KR: 'SIAM4983',
    /** 장운영상태 */
    MARKET_STATUS: 'SZQM0771',

    // ── 투자정보 (해외)
    /** 해외 현재가 */
    QUOTE_US: 'GSS10030',
    /** 해외 호가 */
    ORDERBOOK_US: 'GSS10040',
    /** 해외 차트 */
    CHART_US: 'GSC10060',

    // ── 고객계좌
    /** 예수금내역 */
    DEPOSIT: 'SSQM0004',
    /** 보유주식 조회 */
    HOLDINGS: 'SSQM1801',
    /**
     * 계좌자산평가 — 국내·해외 보유를 **한 번에** 준다 (2026-09-05 라이브 프로브로 확정).
     *
     * `SSQM1801` 이 못 주던 것을 전부 준다: `byng_avr_prc`(매입평균가) · `now_prc`(현재가) ·
     * `val_amt`(평가금액) · `is_nm`(종목명), 그리고 결정적으로 **`ec_q`(실보유수량)** 와
     * `nstmt_s_q`/`nstmt_b_q`(미결제 매도·매수)를 **분리해서** 준다.
     *
     * 그래서 `max(gnrl_q, ordr_psbl_q)` 추정과 체결내역 3영업일 스캔이 필요 없다.
     * 실측한 행 전부에서 `val_amt = ec_q × now_prc` 가 성립했고, 매도 후 결제대기 종목은
     * `ec_q=0` · `val_amt=0` · `byng_avr_prc=0` 으로 **추정 없이** 걸러진다.
     */
    ASSET_EVAL: 'SSQM2952',

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
     * [미배선·권한없음] 주문체결현황 — 이 계정 appKey 에 **API 사용 권한이 없다**
     * (실측 2026-08-11: HTTP 500 · `"API 사용 권한이 없습니다." processCode=I446`).
     * 미체결 조회는 권한이 있는 `TRADES_KR`(SSQM2341, `ccls_clsf=2`)로 대신한다.
     * KB 포털에서 이 TR 권한을 받기 전까지 다시 배선하지 말 것 — 호출은 전량 실패하고,
     * 실패 반복은 KB 가 경고하는 계정 제한 사유가 된다.
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
    /** [미배선] 일자별실현손익상세 */
    PNL_DAILY: 'SSQM2442',
    /** [미배선] 종목별기간실현손익 — 종목 단위 기간 합계라 개별 매매로 못 쪼갠다. */
    PNL_BY_SYMBOL: 'SSQM2443',
    /** [미배선] 기간매매손익현황 */
    PNL_PERIOD: 'SSQM2392',
    /** 소수점 매수 / 매도 / 취소 */
    FRAC_BUY_KR: 'SSAM5763',
    FRAC_SELL_KR: 'SSAM5762',
    /** [미배선] 소수점 주문 취소 */
    FRAC_CANCEL_KR: 'SSAM5764',
    /** [미배선] 소수점 주문가능금액 */
    FRAC_BUYABLE_KR: 'SSQN5472',

    // ── 트레이딩 (해외)
    /** 해외 매도/매수주문 */
    ORDER_US: 'SKAM2101',
    /** 해외 정정/취소주문 */
    AMEND_CANCEL_US: 'SKAM2102',
    /**
     * 해외 주문체결조회 — 해외 **체결 확정**의 조달처.
     *
     * 종전엔 `[미배선]` 이었고, 그 탓에 `fetchMyTrades` 가 심볼과 무관하게 국내 TR 만 불렀다.
     * 해외 주문의 체결 확정이 **국내 체결내역에서 US 티커를 찾는** 꼴이라 구조적으로 항상
     * 실패했고, 매번 발주값이 진입가로 기록됐다. 상수는 있는데 연결이 없던 부분이다.
     */
    ORDERS_US: 'SPQM2103',
    /** 원마켓플러스 주문가능금액 (종목·가격 지정) — 원화환산 주문가능액을 준다 */
    ONEMARKET_BUYABLE: 'SKQM2106',
    /** [미배선] 원마켓플러스 주문가능금액 현황(통화별 총괄) — 종목별(SKQM2106)로 충분해 보류. */
    ONEMARKET_BUYABLE_ALL: 'SKQM3350',
    /** 원마켓 계좌증거금 — 원화·원화환산 외화 예수금 */
    ONEMARKET_MARGIN: 'SPQM3390',
    /**
     * 해외 잔고평가조회 — **해외 보유 종목의 정본**.
     *
     * 포털 문서의 "고객계좌 해외 5종" 표에는 없다. 그 표엔 매매손익·정산·
     * 증거금뿐이라 "KB 는 해외 보유잔고 TR 을 안 준다"고 읽혔는데, 실제로는 **트레이딩 분류**에
     * 있었다(KB 공식 스펙 `samples.generated.json`, 2026-06-24 판). 그 오독 때문에 어댑터가
     * 국내 TR 만 불렀고, 해외 실보유가 잔고에 나타나지 않았다.
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
     * `processCode 1861`("조회할 자료가 없습니다")로 답하고, 클라이언트가 그 코드를 정상
     * 빈 결과로 흡수해 **거부가 "거래 없음" 과 똑같아 보인다.** 이것이 처음 관측된 증상이다.
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
]);

/** 이 TR 이 주문을 바꾸는가 — 대소문자 무관(경로는 소문자로 붙는다). */
export function isKBSecOrderTr(trCode: string): boolean {
    return KBSEC_ORDER_TR_CODES.has(trCode.trim().toUpperCase());
}

// ============ 코드 매핑 ============

/**
 * 국내 주문구분코드 (`ordr_ccd`).
 * FOK/IOC 계열(`F0`·`F3`·`F5` 등)도 명세에 있으나 이 어댑터는 지정가·시장가만 노출한다 —
 * 호출하는 쪽이 요구하는 TIF 가 그 둘뿐이고, 나머지는 라이브 검증이 없다.
 */
export const KBSEC_ORDER_TYPE_KR = {
    LIMIT: '00',
    MARKET: '03',
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
 * 미확인 — 그래서 잔고 조회는 `1` 을 먼저 쓰고 0건일 때만 이 값으로 재시도하며,
 * 무엇이 통했는지 로그로 남긴다(`fetchHoldingRows`). 확정되면 한쪽으로 고정할 것.
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
 *
 * 종전엔 이 규칙이 어댑터 세 곳에 `=== '1'` 리터럴로 복제돼 있었다.
 * 복제된 규칙은 브로커가 값을 바꿀 때 한 곳만 고쳐지고 나머지가 조용히 어긋난다.
 */
export const KBSEC_TRD_SELL = '1';

/** 연속구분 (`cn_clsf`) — `0` 기본(첫 페이지) · `1` 연속. */
export const KBSEC_CONT_FIRST = '0';

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
 * 23:30~06:00)이라 **자정을 넘긴 체결이 하루 뒤로 밀린다.** 한 달가량의 해외 체결과
 * 정산 TR 행을 실측 대조했을 때 두 축의 결과가 서로 어긋났다:
 *
 * ET 일자 기준 → 체결 묶음과 정산 행이 전부 겹친다
 * KST 일자 기준 → 양쪽에 짝이 없는 조합이 다수 남는다. 거의 전부 어긋난다
 *
 * 그런데 어긋난 결과는 "그 날 정산이 없다" 로 보여서 로그가 조용하다. 그래서
 * `matchKbsecOverseasSettlements` 가 안 붙은 정산 묶음을 따로 세어 경고한다.
 *
 * UTC 날짜로도 실측 표본이 전부 맞지만 ET 를 쓴다. 정규장·시간외(~20:00 ET)는 두 축이
 * 같지만, 겨울(EST)의 19:00~20:00 ET 는 이미 UTC 로 다음 날이라 그 구간에서만 어긋난다.
 * "우연히 겹친 축" 이 아니라 **뜻이 맞는 축**을 쓴다.
 */
export function kbsecDateUsEastern(at: Date): string {
    return US_EASTERN_DATE_FORMATTER.format(at).replace(/-/g, '');
}

/** KST 오프셋을 더한 Date — `getUTC*` 가 곧 한국 시각/요일이 된다. */
function kstNow(): Date {
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    return new Date(Date.now() + KST_OFFSET_MS);
}

/**
 * 조회 기준일(`ordr_dt`) — **KB 의 `현재일자` 는 영업일**이라 주말·휴장일엔 직전 영업일에 머문다.
 *
 * 캘린더 날짜를 그대로 보내면 그날 조회가 **전량 거부**된다:
 * `주문일자가 현재일자보다 큽니다 [processCode=2854]`.
 * 라이브 실측(토요일): 토요일 00시를 넘긴 직후부터 미체결 조회가 매 사이클 실패했고
 * (30시간 동안 1,200여 건), 평일 같은 시각엔 한 건도 없었다. 즉 시각이 아니라 **요일** 문제다.
 *
 * 로그 소음에 그치지 않는다 — 같은 TR 을 쓰는 **체결 조회**도 함께 실패해서, 금요일 장 마감
 * 근처 체결을 주말에 재확인하면 "체결 미확인 → 요청 호가로 기록" 경로로 빠진다.
 *
 * 공휴일은 여기서 모델링하지 않는다(주말만 되감는다) — 호출부가 `2854` 를 만나면 한 칸씩 더
 * 되감아 재시도하고, 그때 WARN 을 남겨 **모르는 휴장일을 사후에 알 수 있게** 한다.
 *
 * @param stepsBack 0 = 오늘 기준 가장 최근 영업일, 1 = 그 직전 영업일, …
 */
export function kbsecBusinessDateKst(stepsBack = 0): string {
    const d = kstNow();
    let remaining = stepsBack;
    for (;;) {
        const dow = d.getUTCDay();            // KST 오프셋을 더했으므로 한국 요일
        const isWeekend = dow === 0 || dow === 6;
        if (!isWeekend) {
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
 * 해외 주문유형코드 (`frgn_ordr_typ_cd`).
 * VWAP/TWAP/MOO/MOC 도 명세에 있으나(개인용 API 로는 드문 표면) 라이브 검증 전까지
 * 시장가·지정가만 노출한다.
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

/** 시장 구분 — 국내 종목코드 모양이면 KR, 아니면 US. */
export type KBSecMarketCountry = 'KR' | 'US';

/** 도메인 심볼('005930/KRW' · 'AAPL/USD') → 시장 구분. */
export function kbsecMarketOf(symbol: string): KBSecMarketCountry {
    return isKrxDomesticCode(kbsecBaseSymbol(symbol)) ? 'KR' : 'US';
}

/** 도메인 심볼 → API 종목코드 (base 만). */
export function kbsecBaseSymbol(symbol: string): string {
    return symbol.split('/')[0].trim();
}

/**
 * KB 응답의 종목코드 → 도메인 코드(6자리).
 *
 * KB 는 국내 단축코드를 **`A` 접두**로 준다(`A005930`, KRX 표준 표기). 실측 2026-08-11:
 * 미체결 조회 응답의 `is_cd` 가 `A005930` 이었다. 그대로 넘기면 6자리 숫자가 아니라
 * `kbsecMarketOf` 가 **해외 종목으로 오판**한다 — `cancelAllOrders` 가 국내 주문을
 * 해외 취소 TR(SKAM2102)로 보내 전량 실패하고, 심볼 필터도 영영 매칭되지 않는다.
 *
 * 표준종목번호(ISIN, `KR7005930003`)로 오는 필드도 같은 곳에서 흡수한다.
 */
export function kbsecNormalizeCode(raw: string): string {
    const s = (raw ?? '').trim();
    if (/^A\d{6}$/.test(s)) return s.slice(1);
    if (/^KR7\d{9}$/.test(s)) return s.slice(3, 9);
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
