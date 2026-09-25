/**
 * @fileoverview 한국투자증권(KIS) 상수와 종목코드 판정.
 * @description 도메인, 요금, 주문 구분 코드, 실시간 WebSocket 프레임 레이아웃, 국내·해외 종목 판별.
 */

// KRX 코드 판정은 `broker-krx-code.ts` 에 두고, 여기서는 가져와 쓰고 그대로 재수출한다.
// 기존 import 경로를 바꾸지 않아도 되도록 재수출한다.
import {
    KIS_KRX_CODE_DIGITS,
    KNOWN_ALNUM_KRX_CODES,
    isKrxDomesticCode,
} from '../broker-krx-code';
import { krxSellTaxRate } from '../krx-sell-tax';

// ============ 상수 ============

/** KIS API 도메인 */
export const KIS_API_DOMAINS = {
    /** 실전 투자 */
    REAL: 'https://openapi.koreainvestment.com:9443',
    /** 모의 투자 */
    VIRTUAL: 'https://openapivts.koreainvestment.com:29443',
} as const;

/** 초당 거래건수 초과 오류 코드. 조회는 다시 보내고 주문은 다시 보내지 않는다(이중 주문 위험). */
export const KIS_RATE_LIMIT_ERROR_CODE = 'EGW00201';
/**
 * 원장(ledger) 초당 거래건수 초과. `EGW00201` 과 같은 계열이고 HTTP 500 으로 온다.
 * 잔고·캔들 조회가 이 코드로 곧장 실패하면 호출하는 쪽이 잔액 부족으로 오해해 주문을 건너뛸 수 있으므로 조회 재시도 대상에 넣는다.
 */
export const KIS_LEDGER_RATE_LIMIT_ERROR_CODE = 'EGW00215';
/** 초당 거래건수 초과 오류 코드 전체. */
export const KIS_RATE_LIMIT_ERROR_CODES = [KIS_RATE_LIMIT_ERROR_CODE, KIS_LEDGER_RATE_LIMIT_ERROR_CODE] as const;

/** 토큰 유효 시간 (시) — KIS 사양: 24시간. **서버가 `expires_in` 을 안 줄 때만** 쓰는 폴백. */
const KIS_TOKEN_VALIDITY_HOURS = 24;
/** 토큰 갱신 안전 마진 (분) — 만료 전 갱신 */
const KIS_TOKEN_SAFETY_MARGIN_MINUTES = 30;

/** 토큰 갱신 안전 마진 (ms) — 서버 `expires_in` 에서 차감한다. */
export const KIS_TOKEN_SAFETY_MARGIN_MS = KIS_TOKEN_SAFETY_MARGIN_MINUTES * 60 * 1000;

/**
 * 접근 토큰 유효 기간 (ms) — **폴백값**.
 *
 * 정본은 발급 응답의 `expires_in` 이다. 이 상수는 사양을 베낀 값이라 서버가 수명을 줄이면 프로세스 캐시와
 * 토큰 저장소(`options.tokenStore`)가 무효 토큰을 계속 쓴다. 그래서 서버 값이 있으면 그쪽을 쓴다.
 */
export const KIS_TOKEN_EXPIRY_MS =
    (KIS_TOKEN_VALIDITY_HOURS * 60 - KIS_TOKEN_SAFETY_MARGIN_MINUTES) * 60 * 1000;

/** 서버 `expires_in` 을 적용할 때의 하한 — 마진을 빼서 음수가 되면 갱신 요청이 몰린다. */
export const KIS_TOKEN_MIN_LIFETIME_MS = 60_000;

/** 국내주식 위탁수수료율 (0.015%) — 매수/매도 양방향. 실제 요율은 계좌 유형과 할인에 따라 다르다. */
export const KIS_BROKERAGE_FEE = 0.00015;

/** KRX 매도 거래세 — 매도 시에만 적용. 세율은 `../krx-sell-tax` 한 곳에 두고 체결 시각으로 고른다. 코넥스는 다루지 않는다. */
export { krxSellTaxRate };

/**
 * `KIS_BROKERAGE_FEE` 의 옛 이름이다. 위탁수수료만 들어 있고 매도 거래세는 빠져 있다.
 *
 * @deprecated `getKisEffectiveFeeRate(side)` 또는 `KIS_BROKERAGE_FEE` 를 쓴다.
 */
export const KIS_DEFAULT_FEE_RATE = KIS_BROKERAGE_FEE;

/** KIS 의 effective 수수료율 — 매수는 위탁수수료, 매도는 위탁수수료에 `at` 시점의 거래세를 더한다. */
export function getKisEffectiveFeeRate(side: 'buy' | 'sell', at: Date = new Date()): number {
    return side === 'sell'
        ? KIS_BROKERAGE_FEE + krxSellTaxRate(at)
        : KIS_BROKERAGE_FEE;
}

/** 고객 유형 코드 — 개인 */
export const KIS_CUSTOMER_TYPE = 'P';

/** 계좌 상품코드 기본값 */
export const KIS_DEFAULT_ACCOUNT_SUFFIX = '01';

// ============ 인증 타입 ============

/** KIS 자격증명 */
export interface KISCredentials {
    /** App Key (KIS Developers 발급) */
    appKey: string;
    /** App Secret (KIS Developers 발급) */
    appSecret: string;
    /** 계좌번호 (8자리-2자리, 예: '12345678-01') */
    accountNo: string;
    /** 모의 투자 여부 */
    isVirtual?: boolean;
}

/** 캐시된 토큰 정보 */
export interface KISCachedToken {
    accessToken: string;
    expiresAt: number;
}

/** 일봉 데이터 (국내주식) */
export interface KISDailyCandle {
    /** 영업일 (YYYYMMDD) */
    stck_bsop_date: string;
    /** 시가 */
    stck_oprc: string;
    /** 최고가 */
    stck_hgpr: string;
    /** 최저가 */
    stck_lwpr: string;
    /** 종가 */
    stck_clpr: string;
    /** 거래량 */
    acml_vol: string;
}

// ============ 주문 타입 ============

/** 주문 구분 코드 */
export const KIS_ORDER_TYPE = {
    /** 지정가 */
    LIMIT: '00',
    /** 시장가 */
    MARKET: '01',
    /** 조건부 지정가 */
    CONDITIONAL: '02',
    /** 최유리 지정가 */
    BEST: '03',
    /** 최우선 지정가 */
    PRIORITY: '04',
} as const;

// ============ 호가 단위 ============

/** 가격대별 호가 단위 (KRX 규정) */
export function getTickSize(price: number): number {
    if (price < 2000) return 1;
    if (price < 5000) return 5;
    if (price < 20000) return 10;
    if (price < 50000) return 50;
    if (price < 200000) return 100;
    if (price < 500000) return 500;
    return 1000;
}

// ============ 해외주식 ============

/** KIS KRX 종목코드 자릿수 — 6자리다. 대다수는 숫자이고 일부 신형 코드는 영숫자다 (예: 035420 NAVER, 005930 삼성전자). */
export { KIS_KRX_CODE_DIGITS };

/**
 * 해외주식인지 식별 — KRX 코드 형식 (6자리 숫자) = 국내, 그 외 = 해외.
 * KRX 종목코드는 6자리이고 대다수가 숫자다 (예: 005930). 해외 ticker 는 영문 (AAPL, BRK/B 등 — KIS 는 슬래시 사용).
 *
 * 판정 전 마켓 페어 접미사(`/KRW`·`/USD` 등)를 떼고 base 로 검사한다. `005930/KRW` 와 `005930` 은 같은 결과다.
 */
export function isOverseasSymbol(symbol: string): boolean {
    const base = symbol.split('/')[0];
    return !isKrxDomesticCode(base);
}

/**
 * 정의는 `broker-krx-code.ts` 한 곳에서만 유지하고, 여기서는 재수출만 한다.
 * 기존 import 경로를 그대로 유지하기 위해서다.
 */
export { isKrxDomesticCode, KNOWN_ALNUM_KRX_CODES };

/**
 * 체결기준현재잔고(CTRP6504R) 요청 코드.
 * 달러 잔고는 미국 시장 USD 잔고만 필요하므로 미국/외화로 고정한다.
 */
export const KIS_PRESENT_BALANCE_PARAMS = {
    /** 원화외화구분코드 — 02: 외화 (01 은 원화 환산) */
    WCRC_FRCR_DVSN_FOREIGN: '02',
    /** 국가코드 — 840: 미국 */
    NATN_US: '840',
    /** 거래시장코드 — 00: 전체 */
    TR_MKET_ALL: '00',
    /** 조회구분코드 — 00: 전체 (01: 일반해외주식, 02: 미니스탁) */
    INQR_DVSN_ALL: '00',
} as const;

/** 해외주식 일봉 (HHDFS76240000 output2) */
export interface KISOverseasDailyCandle {
    /** 영업일 (YYYYMMDD) */
    xymd: string;
    /** 시가 */
    open: string;
    /** 고가 */
    high: string;
    /** 저가 */
    low: string;
    /** 종가 (현재가 컬럼) */
    clos: string;
    /** 거래량 */
    tvol: string;
    /** 거래대금 */
    tamt: string;
}

/** 해외주식 주문 구분 코드 (TTTT1002U / TTTT1006U) */
export const KIS_OVERSEAS_ORD_DVSN = {
    /** 지정가 (모의투자 가능) */
    LIMIT: '00',
    /** LOO — 장개시지정가 (실전만) */
    LOO: '32',
    /** LOC — 장마감지정가 (실전만) */
    LOC: '34',
    /** MOO — 장개시시장가 (매도 전용, 실전만) */
    MOO: '31',
    /** MOC — 장마감시장가 (매도 전용, 실전만) */
    MOC: '33',
} as const;

/** 해외주식 기본 수수료율 (KIS 미국 0.25%) */
export const KIS_OVERSEAS_DEFAULT_FEE_RATE = 0.0025;

// ============ 실시간 WebSocket ============

/** KIS 실시간 시세 WebSocket 도메인 (실전/모의). */
export const KIS_WS_DOMAINS = {
    REAL: 'ws://ops.koreainvestment.com:21000',
    VIRTUAL: 'ws://ops.koreainvestment.com:31000',
} as const;

/** WS 구독 path (KIS 공통 실시간 엔드포인트). */
export const KIS_WS_PATH = '/tryitout';

/**
 * WS 실시간 TR ID.
 * - 국내: 체결가 H0STCNT0 / 호가 H0STASP0
 * - 해외: 지연체결가 HDFSCNT0 / 지연호가 HDFSASP0
 * (실시간(유료) 해외는 R* 계열이나, 이 패키지는 지연체결(D 접두)을 쓴다)
 */
export const KIS_WS_TR = {
    DOMESTIC_TRADE: 'H0STCNT0',
    DOMESTIC_ASKING: 'H0STASP0',
    OVERSEAS_TRADE: 'HDFSCNT0',
    OVERSEAS_ASKING: 'HDFSASP0',
    PINGPONG: 'PINGPONG',
} as const;

/**
 * 실시간 체결/호가 프레임의 `^` 구분 body 필드 인덱스.
 *
 * KIS 공식 문서 기준 — 실제 연결로 검증 필요(런타임 로그). 인덱스가 다르면 이 상수만 수정한다.
 * 파서(kis-realtime-parser)는 이 상수를 참조하는 순수 함수라 테스트로 고정된다.
 */
export const KIS_WS_FIELD = {
    /** 국내 체결 H0STCNT0: [0]=종목코드, [2]=현재가(STCK_PRPR), [5]=전일대비율(PRDY_CTRT) */
    DOMESTIC_TRADE_LAST: 2,
    DOMESTIC_TRADE_CHANGE_PCT: 5,
    /** 해외 체결 HDFSCNT0: [1]=종목코드(SYMB), [11]=현재가(LAST), [14]=등락율(RATE) */
    OVERSEAS_TRADE_SYMBOL: 1,
    OVERSEAS_TRADE_LAST: 11,
    OVERSEAS_TRADE_CHANGE_PCT: 14,
    /**
     * 국내 호가 H0STASP0: [0]=종목코드, [1]=영업시간,
     * 매도호가 ASKP1..10 = [3+i], 매수호가 BIDP1..10 = [13+i],
     * 매도잔량 ASKP_RSQN1..10 = [23+i], 매수잔량 BIDP_RSQN1..10 = [33+i].
     */
    DOMESTIC_ASKP_BASE: 3,
    DOMESTIC_BIDP_BASE: 13,
    DOMESTIC_ASKP_RSQN_BASE: 23,
    DOMESTIC_BIDP_RSQN_BASE: 33,
} as const;

/** approval_key 발급 응답 (POST /oauth2/Approval). */
export interface KISApprovalResponse {
    approval_key: string;
}
