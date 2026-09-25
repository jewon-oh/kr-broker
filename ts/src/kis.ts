/**
 * @fileoverview 한국투자증권(KIS) Open API 어댑터. ccxt 의 `Exchange` 구조를 따른다.
 *
 * ```ts
 * const broker = new kis({ apiKey: '앱키', secret: '앱시크릿', uid: '12345678-01' });
 * broker.setSandboxMode(true);                       // 모의투자 도메인과 모의 TR ID, 초당 2건 유량으로 바뀐다
 * const ticker = await broker.fetchTicker('005930/KRW');
 * const order = await broker.createOrder('AAPL/USD', 'limit', 'buy', 1, 150);
 * ```
 *
 * ## 심볼
 *
 * 국내 `005930/KRW`, 미국 `AAPL/USD` 를 쓴다. 슬래시가 든 티커(`BRK/B`)는 `BRK.B/USD` 로 통합하고 `market.id` 에 KIS 표기를 둔다.
 * 접미사를 뺀 `005930`, `AAPL` 도 받는다. 국내 종목은 마스터 데이터 없이 종목코드 모양(6자리)만으로 가르고, 해외 종목의 거래소는
 * 종목 마스터(`options.masterData`)에서 찾는다. `loadMarkets()` 는 마스터 데이터로 종목 목록을 만들 뿐이고 주문·시세 호출에는 필요 없다.
 *
 * ## 자격증명
 *
 * `apiKey`=앱키, `secret`=앱시크릿, `uid`=계좌번호(`8자리-2자리`, 뒤 2자리를 생략하면 `01`).
 *
 * ## 요청 흐름
 *
 * KIS 는 모든 REST 호출에 접근 토큰이 필요하다. `fetch2` 가 비공개 호출 앞에서 `authenticate()` 를 불러 토큰을 준비하고, `sign()` 이 요청
 * 헤더(`authorization`·`appkey`·`appsecret`·`tr_id`)를 만든다. `tr_id` 는 호출마다 다르므로 `params.tr_id` 로 넘기면 `sign()` 이 헤더로 옮긴다.
 *
 * ## 옵션
 *
 * 전역 설정은 없고 인스턴스가 `options` 로 받는다. `tokenStore`(여러 프로세스가 나눠 쓰는 토큰 저장소), `nxtRouting`(정규장 밖 주문·시세, 불리언 또는
 * 불리언을 돌려주는 함수), `masterData`(종목 마스터), `stockDirectory`(코스피·코스닥 구분),
 * `htsId`(관심종목·조건검색 조회와 `watchOrders` 에 쓰는 HTS 사용자 ID)다. `confirmBudget` 은 선언만 있고 읽지 않는다.
 *
 * ## 유량
 *
 * 실전은 초당 20건, 모의는 초당 2건이 상한이다. 같은 프로세스에서 같은 앱키를 쓰는 인스턴스는 하나의 스케줄을 공유한다(`throttle`).
 * 조회가 `EGW00201`·`EGW00215`(초당 거래건수 초과)로 실패하면 `RateLimitExceeded` 를 던지고, 조회에 한해 몇 번 다시 보낸다.
 * 주문은 절대 재시도하지 않고, 시간 초과나 연결 끊김이면 접수 여부를 모르므로 `OrderOutcomeUnknown` 을 던진다.
 *
 * ## 한계
 *
 * 잔고·미체결·주문체결 조회는 연속조회로 끝까지 받는다. 10쪽을 넘으면 일부만 돌려주지 않고 `BadResponse` 를 던진다.
 * 통합 `fetchOrderBook`은 미국 종목 호가를 조회하지 않고, 통합 `fetchOHLCV`는 미국 분봉을 야후 파이낸스로 받는다. KIS 원본 1호가와 분봉은
 * 확장 메서드(`fetchOverseasOrderBook`, `fetchOverseasMinuteOHLCV`)가 준다.
 */

import {
    Exchange,
    ArgumentsRequired,
    AuthenticationError,
    BadRequest,
    BadResponse,
    BadSymbol,
    ExchangeError,
    ExchangeClosedByUser,
    InvalidOrder,
    MarketClosed,
    NotSupported,
    NullResponse,
    OrderNotFound,
    Precise,
    RequestTimeout,
    ROUND,
    TICK_SIZE,
    NO_PADDING,
    decimalToPrecision,
    numberToString,
    type Balances,
    type Dict,
    type Dictionary,
    type Int,
    type KrTimestamped,
    type MarketInterface,
    type Num,
    type OHLCV,
    type Order,
    type OrderBook,
    type OrderSide,
    type OrderType,
    type SignedRequest,
    type Str,
    type Strings,
    type Ticker,
    type Tickers,
    type Trade,
    type TradingFeeInterface,
    type ApiName,
    type Market,
} from './base';
import { kstTimestampOf } from './base/Exchange';
import { logger } from './logger';
import { buildExtendedSessionLimit } from './extended-session-limit';
import { refreshMarketCalendar as refreshSharedMarketCalendar } from './market-calendar';
import { krxSellTaxRate } from './krx-sell-tax';
import { KISAuth } from './kis/kis-auth';
import { KIS_EXCEPTIONS_EXACT } from './kis/kis-error-codes';
import { acquireKisSlot } from './kis/kis-rate-limiter';
import { checkKRXTradingHours, getKrxMarketPhase, getNxtSession, isNxtExtendedTradable } from './kis/kis-trading-hours';
import { getUsMarketPhase, formatEtWallClock } from './kis/us-market-hours';
import { etWallClockToUtcMs, etYmd } from './us-market-hours';
import {
    KIS_API_DOMAINS,
    KIS_BROKERAGE_FEE,
    KIS_CUSTOMER_TYPE,
    KIS_DEFAULT_ACCOUNT_SUFFIX,
    KIS_ORDER_TYPE,
    KIS_OVERSEAS_DEFAULT_FEE_RATE,
    KIS_OVERSEAS_ORD_DVSN,
    KIS_PRESENT_BALANCE_PARAMS,
    KIS_WS_DOMAINS,
    KIS_WS_PATH,
    getTickSize,
    isKrxDomesticCode,
} from './kis/kis-types';
import {
    getOverseasMarketForCode,
    getOverseasStockByCode,
    searchOverseasStocks,
    toOrderMarketCode,
    type OverseasMarket,
    type OverseasOrderMarket,
} from './kis/kis-overseas-master';
import { getKRXStockByCode, getStockMasterCount, searchKRXStocks } from './kis/kis-stock-master';
import { KISCandleService } from './kis/kis-candle-service';
import { fetchYahooCandles } from './kis/yahoo-finance-candles';
import { resolveKrMarket } from './kis/kr-market';
import { masterDataOf, type KisMasterData } from './kis/kis-master-data';
import { KisPriceWs, type KisPriceWsOptions } from './kis/kis-price-ws';
import { KisRealtimeStream, type KisRealtimeRecord } from './kis/kis-realtime-stream';
import { WatchHub } from './base/watch-hub';

// ============ 상수 ============

/** 실전 호출 간격(ms). 하드 한도 초당 20건(50ms)에 여유를 둔 초당 15건이다. */
const REAL_RATE_LIMIT_MS = 67;
/** 모의투자 호출 간격(ms). 모의는 초당 2건이 상한이다. */
const SANDBOX_RATE_LIMIT_MS = 500;
/** 조회 요청의 시간 상한. 조회는 다른 상한이 없으므로 여기가 유일한 상한이다. */
const READ_TIMEOUT_MS = 20_000;
/**
 * 주문 요청의 시간 상한. 호출하는 쪽이 주문 실행에 두는 바깥 시간 상한보다 짧아야 한다. 그래야 응답을 기다리다 버리는 것이 아니라
 * 요청을 끊고 접수 여부가 미확정임을 알 수 있다.
 */
const ORDER_TIMEOUT_MS = 25_000;
/** 토큰 발급 요청의 시간 상한. 여기서 멈추면 뒤의 모든 호출이 같이 멈춘다. */
const AUTH_TIMEOUT_MS = 10_000;
/** 종목의 NXT 거래 가능 여부를 캐시하는 시간. NXT 거래 대상은 자주 바뀌지 않는다. */
const NXT_ELIGIBILITY_TTL_MS = 6 * 60 * 60 * 1000;
/** 종목정보 조회의 상품유형: 주식·ETF·ETN·ELW. */
const STOCK_INFO_PRODUCT_TYPE = '300';
/** VI 발동 현황 조회의 고정 화면 분류 코드. 공식 예제가 이 값 하나만 쓴다. */
const VI_STATUS_SCREEN_CODE = '20139';
/** 관심종목(멀티종목) 시세조회 한 번에 담을 수 있는 최대 종목 수. */
const MULTI_TICKER_LIMIT = 30;
/** 조회를 다시 보내는 횟수와 간격. 초당 거래건수 초과는 1초 안팎이면 풀린다. */
const READ_RETRIES = 3;
const READ_RETRY_DELAY_MS = 500;
/** 연속조회로 받는 최대 쪽 수. 공식 예제의 재귀 상한(10)과 같다. */
const MAX_CONTINUATION_PAGES = 10;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 지난 영업일을 알기 위해 되돌아 조회하는 기간. */
const HOLIDAY_LOOKBACK_MS = 30 * DAY_MS;
/** 휴장일 캘린더를 신선하게 보는 시간. KIS 는 하루 한 번 호출을 권하므로 하루에 두 번까지만 부른다. */
const CALENDAR_TTL_MS = 12 * 60 * 60 * 1000;

/** 매도매수구분코드: 체결·미체결 조회 응답에서 `01` 이 매도, `02` 가 매수다. */
const SIDE_CODE_SELL = '01';
const SIDE_CODE_BUY = '02';

/** 국내 주문 TR ID. 실전과 모의가 접두사만 다르다. 확장세션(NXT)은 거래소 구분(`EXCG_ID_DVSN_CD`)을 받는 신형을 쓴다. */
const DOMESTIC_ORDER_TR = {
    regular: { buy: ['TTTC0802U', 'VTTC0802U'], sell: ['TTTC0801U', 'VTTC0801U'] },
    extended: { buy: ['TTTC0012U', 'VTTC0012U'], sell: ['TTTC0011U', 'VTTC0011U'] },
} as const;

/** 해외 주문 TR ID(실전 접두사 `T`, 모의는 `V` 로 바꾼다). 거래소마다 다르다. */
const OVERSEAS_ORDER_TR: Readonly<Record<OverseasOrderMarket, { buy: string; sell: string }>> = {
    NASD: { buy: 'TTT1002U', sell: 'TTT1006U' },
    NYSE: { buy: 'TTT1002U', sell: 'TTT1006U' },
    AMEX: { buy: 'TTT1002U', sell: 'TTT1006U' },
    SEHK: { buy: 'TTS1002U', sell: 'TTS1001U' },
    SHAA: { buy: 'TTS0202U', sell: 'TTS1005U' },
    SZAA: { buy: 'TTS0305U', sell: 'TTS0304U' },
    TKSE: { buy: 'TTS0308U', sell: 'TTS0307U' },
    HASE: { buy: 'TTS0311U', sell: 'TTS0310U' },
    VNSE: { buy: 'TTS0311U', sell: 'TTS0310U' },
};

/** 미국 거래소. 이 거래소의 주문에는 미국장 세션 게이트를 건다. */
const US_ORDER_EXCHANGES: ReadonlySet<string> = new Set(['NASD', 'NYSE', 'AMEX']);

/** 시세 조회가 쓰는 상품구분: 정규장은 `J`(KRX), 확장세션(NXT 라우팅 켬)은 `UN`(KRX+NXT 통합)이다. */
type QuoteMarketDivision = 'J' | 'UN';

/** 종목 식별 결과. 국내는 종목코드 모양으로, 해외는 종목 마스터로 정한다. */
interface KisInstrument {
    /** 통합 심볼(`005930/KRW`, `AAPL/USD`, `BRK.B/USD`) */
    symbol: string;
    /** KIS 가 쓰는 종목 식별자(국내 종목코드, 해외 티커 — 슬래시 표기 그대로) */
    code: string;
    overseas: boolean;
    quote: 'KRW' | 'USD';
    /** 시세 조회용 거래소 코드(`NAS`). 해외 마스터에 없으면 `undefined` */
    quoteExchange: OverseasMarket | undefined;
    /** 주문·잔고용 거래소 코드(`NASD`). 해외 마스터에 없으면 `undefined` */
    orderExchange: OverseasOrderMarket | undefined;
}

/** 휴장일 캘린더의 하루. `chk-holiday` 응답에서 개장·영업·거래·결제 여부를 모두 싣는다. */
export interface KisCalendarDay extends KrTimestamped {
    /** `YYYYMMDD` (KST) */
    date: string;
    /** 개장일 여부(`opnd_yn`). 주문 가능 여부는 이 값으로 본다. */
    open: boolean;
    /** 영업일 여부(`bzdy_yn`) */
    business: boolean;
    /** 거래일 여부(`tr_day_yn`) */
    trading: boolean;
    /** 결제일 여부(`sttl_day_yn`). 결제 지연 계산은 개장일이 아니라 이 값이 정본이다. */
    settlement: boolean;
    info: Dict;
}

/**
 * 국내 종목 상세(`search-stock-info`, TR `CTPF1002R`)의 정리한 값. 원문 필드는 `info`에 그대로 남는다.
 * KOSPI 와 KOSDAQ 는 상장일과 상장폐지일이 따로 있다. 둘 다 없으면 그 시장에 상장한 적이 없다는 뜻이다.
 */
export interface KisStockInfo {
    /** 종목코드(`pdno`) */
    symbol: string;
    /** 상품명(`prdt_name`) */
    name: string;
    /** 상품약어명(`prdt_abrv_name`) */
    abbreviatedName: string;
    /** 거래소구분코드(`excg_dvsn_cd`). KIS 원문 코드 그대로다 */
    exchangeCode: string;
    /** 유가증권시장(코스피) 상장일자 `YYYYMMDD`(`scts_mket_lstg_dt`) */
    kospiListedAt: string | undefined;
    /** 유가증권시장(코스피) 상장폐지일자 `YYYYMMDD`(`scts_mket_lstg_abol_dt`) */
    kospiDelistedAt: string | undefined;
    /** 코스닥시장 상장일자 `YYYYMMDD`(`kosdaq_mket_lstg_dt`) */
    kosdaqListedAt: string | undefined;
    /** 코스닥시장 상장폐지일자 `YYYYMMDD`(`kosdaq_mket_lstg_abol_dt`) */
    kosdaqDelistedAt: string | undefined;
    /** 상장폐지일자 `YYYYMMDD`(`lstg_abol_dt`). 시장 구분 없는 일반 상장폐지 필드다 */
    delistedAt: string | undefined;
    /** 거래정지여부(`tr_stop_yn`) */
    tradingHalted: boolean;
    /** 관리종목여부(`admn_item_yn`) */
    administrativeIssue: boolean;
    /** NXT 거래종목여부(`cptt_trad_tr_psbl_yn`) */
    nxtTradable: boolean;
    /** NXT 거래정지여부(`nxt_tr_stop_yn`) */
    nxtTradingHalted: boolean;
    info: Dict;
}

/**
 * 변동성완화장치(VI) 발동 기록 하나(`inquire-vi-status`, TR `FHPST01390000`). 조회한 날(오늘)에 이 종목의 VI 가
 * 발동한 적이 있으면 그 기록이다(발동한 적 없으면 이 배열 자체가 비어 있다).
 *
 * 토스가 함께 주는 유의사항 여섯 종류(정리매매·투자경고·투자위험·단기과열·VI·신주인수권) 중 발동 기록을 주는 KIS API 는 VI 뿐이다.
 * 정리매매와 단기과열 여부, 시장경고 구분(코드와 이름)은 `fetchStockStatus`(`inquire-price-2`)가 현재 상태로만 준다. 그 응답에 신주인수권 항목은 없다.
 */
export interface KisStockWarning extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`bsop_date`) */
    businessDate: string;
    /** VI발동상태코드(`vi_cls_code`). KIS 원문 코드 그대로다(뜻은 공식 문서에 없어 확인 못 했다) */
    statusCode: string;
    /** VI종류코드(`vi_kind_code`). KIS 원문 코드 그대로다(뜻은 공식 문서에 없어 확인 못 했다) */
    kindCode: string;
    /** VI발동시각 `HHMMSS`(`cntg_vi_hour`) */
    triggeredAt: string | undefined;
    /** VI해제시각 `HHMMSS`(`vi_cncl_hour`). 아직 해제되지 않았으면 없다 */
    canceledAt: string | undefined;
    /** VI발동가격(`vi_prc`) */
    price: number | undefined;
    /** 그 영업일의 VI발동횟수(`vi_count`) */
    count: number | undefined;
    info: Dict;
}

/** 투자자 유형 하나의 매수·매도량과 대금. 수량은 주, 대금은 원이다. */
export interface KisInvestorAmounts {
    /** 순매수량(`_ntby_qty`) */
    netBuyVolume: number | undefined;
    /** 순매수대금(`_ntby_tr_pbmn`) */
    netBuyAmount: number | undefined;
    /** 매수량(`_shnu_vol`) */
    buyVolume: number | undefined;
    /** 매수대금(`_shnu_tr_pbmn`) */
    buyAmount: number | undefined;
    /** 매도량(`_seln_vol`) */
    sellVolume: number | undefined;
    /** 매도대금(`_seln_tr_pbmn`) */
    sellAmount: number | undefined;
}

/**
 * 종목의 투자자별(개인·외국인·기관계) 매매동향 하루치(`inquire-investor`, TR `FHKST01010900`). 종목 단위다 — 토스의
 * 같은 이름 메서드는 시장(KOSPI·KOSDAQ) 단위라서 범위가 다르다(2026-09-22 조사).
 */
export interface KisInvestorTradingRecord extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    businessDate: string;
    /** 주식 종가(`stck_clpr`) */
    close: number | undefined;
    /** 전일대비(`prdy_vrss`) */
    change: number | undefined;
    /** 전일대비부호(`prdy_vrss_sign`). KIS 원문 코드 그대로다(뜻은 공식 문서에 없어 확인 못 했다) */
    changeSign: string | undefined;
    individual: KisInvestorAmounts;
    foreign: KisInvestorAmounts;
    institution: KisInvestorAmounts;
    info: Dict;
}

/**
 * 체결 하나의 매매손익과 청구된 수수료·거래세(`inquire-period-trade-profit`, TR `TTTC8715R`). 국내만 지원한다
 * (해외 실현손익은 `fetchOverseasRealizedPnl`).
 */
export interface KisTradeProfitRecord extends KrTimestamped {
    /** 매매일자 `YYYYMMDD`(`trad_dt`) */
    tradeDate: string;
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 상품명(`prdt_name`) */
    productName: string | undefined;
    /** 매도금액(`sll_amt`) */
    sellAmount: number | undefined;
    /** 매수금액(`buy_amt`) */
    buyAmount: number | undefined;
    /** 실현손익(`rlzt_pfls`) */
    realizedPnl: number | undefined;
    /** 손익률(`pfls_rt`) */
    pnlRate: number | undefined;
    /** 수수료(`fee`) */
    fee: number | undefined;
    /** 제세금(`tl_tax`) */
    tax: number | undefined;
    info: Dict;
}

/**
 * 체결 한 건. KIS 체결 조회는 체결 시각(`stck_cntg_hour`)만 주고 날짜를 주지 않아서, 어느 영업일의 체결인지 응답만으로는 알 수 없다.
 * 그래서 통합 `Trade`로 옮기지 않고 시각 문자열을 그대로 둔다. 조회한 날짜를 붙이면 휴장일에 부를 때 틀린 날짜가 된다.
 */
export interface KisTradeTick {
    /** 체결 시각 `HHMMSS`(`stck_cntg_hour`, 한국 시각) */
    time: string;
    /** 체결가 */
    price: number | undefined;
    /** 전일대비(`prdy_vrss`) */
    change: number | undefined;
    /** 전일대비율(`prdy_ctrt`) */
    percentage: number | undefined;
    /** 체결량 */
    volume: number | undefined;
    /** 누적거래량(`acml_vol`). 최근 체결(`fetchTradeTicks`)에는 없다 */
    cumulativeVolume: number | undefined;
    /** 당일 체결강도(`tday_rltv`). 시간외 체결에는 없다 */
    strength: number | undefined;
    /** 매도호가(`askp`). 최근 체결에는 없다 */
    ask: number | undefined;
    /** 매수호가(`bidp`). 최근 체결에는 없다 */
    bid: number | undefined;
    info: Dict;
}

/** 시간외 단일가 일자별 시세 하루치(`inquire-daily-overtimeprice`, TR `FHPST02320000`). */
export interface KisOvertimeDailyPrice extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    businessDate: string;
    /** 시간외 단일가 현재가(`ovtm_untp_prpr`) */
    overtimePrice: number | undefined;
    /** 시간외 단일가 전일대비(`ovtm_untp_prdy_vrss`) */
    overtimeChange: number | undefined;
    /** 시간외 단일가 전일대비율(`ovtm_untp_prdy_ctrt`) */
    overtimeChangeRate: number | undefined;
    /** 시간외 단일가 거래량(`ovtm_untp_vol`) */
    overtimeVolume: number | undefined;
    /** 시간외 단일가 거래대금(`ovtm_untp_tr_pbmn`) */
    overtimeAmount: number | undefined;
    /** 정규장 종가(`stck_clpr`) */
    close: number | undefined;
    /** 정규장 전일대비(`prdy_vrss`) */
    change: number | undefined;
    /** 정규장 전일대비율(`prdy_ctrt`) */
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    info: Dict;
}

/** 회원사(증권사) 한 곳의 매도 또는 매수. */
export interface KisMemberTradingEntry {
    /** 회원사 번호(`seln_mbcr_noN`, `shnu_mbcr_noN`) */
    memberCode: string;
    /** 회원사 이름(`seln_mbcr_nameN`, `shnu_mbcr_nameN`) */
    memberName: string | undefined;
    /** 총 수량(`total_seln_qtyN`, `total_shnu_qtyN`) */
    volume: number | undefined;
    /** 비중(`seln_mbcr_rlimN`, `shnu_mbcr_rlimN`) */
    share: number | undefined;
    /** 수량 증감(`seln_qty_icdcN`, `shnu_qty_icdcN`) */
    volumeChange: number | undefined;
    /** 외국계 증권사 여부(`seln_mbcr_glob_yn_N`, `shnu_mbcr_glob_yn_N`). `Y`, `N` 밖의 값이면 비운다 */
    foreignBroker: boolean | undefined;
}

/** 종목의 매도·매수 상위 회원사와 외국계 증권사 합계(`inquire-member`, TR `FHKST01010600`). `foreignBroker*`는 외국인 투자자가 아니라 외국계 증권사(`glob_*`) 값이다. */
export interface KisMemberTrading {
    /** 매도 상위 회원사. 응답 순서(1~5)를 그대로 따르고, 번호가 빈 자리는 뺀다 */
    sells: KisMemberTradingEntry[];
    /** 매수 상위 회원사. 응답 순서(1~5)를 그대로 따르고, 번호가 빈 자리는 뺀다 */
    buys: KisMemberTradingEntry[];
    /** 외국계 총 매도 수량(`glob_total_seln_qty`) */
    foreignBrokerSellVolume: number | undefined;
    /** 외국계 총 매수 수량(`glob_total_shnu_qty`) */
    foreignBrokerBuyVolume: number | undefined;
    /** 외국계 순매수 수량(`glob_ntby_qty`) */
    foreignBrokerNetBuyVolume: number | undefined;
    /** 외국계 매도 비중(`glob_seln_rlim`) */
    foreignBrokerSellShare: number | undefined;
    /** 외국계 매수 비중(`glob_shnu_rlim`) */
    foreignBrokerBuyShare: number | undefined;
    info: Dict;
}

/** 회원사 실시간 매매동향 한 건(`frgnmem-trade-trend`의 `output2`). */
export interface KisMemberTradeTick {
    /** 영업시간 `HHMMSS`(`bsop_hour`, 한국 시각). 날짜는 응답에 없다 */
    time: string;
    /** 회원사명(`mbcr_name`) */
    memberName: string | undefined;
    /** 주식현재가(`stck_prpr`) */
    price: number | undefined;
    /** 전일대비(`prdy_vrss`) */
    change: number | undefined;
    /** 체결거래량(`cntg_vol`) */
    volume: number | undefined;
    /** 누적순매수수량(`acml_ntby_qty`) */
    cumulativeNetBuyVolume: number | undefined;
    /** 외국계 증권사 순매수수량(`glob_ntby_qty`) */
    foreignBrokerNetBuyVolume: number | undefined;
    /** 외국인 순매수수량 증감(`frgn_ntby_qty_icdc`) */
    foreignNetBuyChange: number | undefined;
    info: Dict;
}

/** 회원사 실시간 매매동향(`frgnmem-trade-trend`, TR `FHPST04320000`). */
export interface KisMemberTradeTicks {
    /** 총매도수량(`output1`의 `total_seln_qty`) */
    totalSellVolume: number | undefined;
    /** 총매수수량(`output1`의 `total_shnu_qty`) */
    totalBuyVolume: number | undefined;
    ticks: KisMemberTradeTick[];
}

/** 주식현재가 일자별 하루치(`inquire-daily-price`, TR `FHKST01010400`). 기간 구분이 주나 월이면 그 기간 하나다. */
export interface KisDailyPrice extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    businessDate: string;
    /** 시가(`stck_oprc`) */
    open: number | undefined;
    /** 고가(`stck_hgpr`) */
    high: number | undefined;
    /** 저가(`stck_lwpr`) */
    low: number | undefined;
    /** 종가(`stck_clpr`) */
    close: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    /** 전일대비(`prdy_vrss`) */
    change: number | undefined;
    /** 전일대비율(`prdy_ctrt`) */
    percentage: number | undefined;
    /** 전일대비 거래량 비율(`prdy_vrss_vol_rate`) */
    volumeChangeRate: number | undefined;
    /** HTS 외국인 소진율(`hts_frgn_ehrt`) */
    foreignHoldingRate: number | undefined;
    /** 외국인 순매수 수량(`frgn_ntby_qty`) */
    foreignNetBuyVolume: number | undefined;
    /** 락 구분 코드(`flng_cls_code`). KIS 원문 코드 그대로다(뜻은 공식 문서에 없어 확인 못 했다) */
    lockCode: string | undefined;
    info: Dict;
}

/**
 * 종목의 거래 상태와 가격 제한(`inquire-price-2`, TR `FHPST01010000`). 여부 필드는 `Y`면 `true`, `N`이면 `false`, 그 밖의 값이면 비운다.
 * 코드 필드는 KIS 원문 그대로다. 시장경고는 이름 필드(`mrkt_warn_cls_name`)도 함께 준다.
 */
export interface KisStockStatus {
    symbol: string;
    /** 대표 시장 한글명(`rprs_mrkt_kor_name`) */
    marketName: string | undefined;
    /** 업종 한글 종목명(`bstp_kor_isnm`) */
    sectorName: string | undefined;
    /** 상한가(`stck_mxpr`) */
    upperLimitPrice: number | undefined;
    /** 하한가(`stck_llam`) */
    lowerLimitPrice: number | undefined;
    /** 기준가(`stck_sdpr`) */
    basePrice: number | undefined;
    /** 거래정지 여부(`trht_yn`) */
    tradingHalted: boolean | undefined;
    /** 정리매매 여부(`sltr_yn`) */
    liquidationTrading: boolean | undefined;
    /** 관리종목 여부(`mang_issu_yn`) */
    administrativeIssue: boolean | undefined;
    /** 단기과열 여부(`short_over_yn`) */
    shortTermOverheated: boolean | undefined;
    /** 투자유의 여부(`invt_caful_yn`) */
    investmentCaution: boolean | undefined;
    /** 이상급등 여부(`stange_runup_yn`) */
    abnormalSurge: boolean | undefined;
    /** 공매도과열 여부(`ssts_hot_yn`) */
    shortSellingOverheated: boolean | undefined;
    /** 저유동성 여부(`low_current_yn`) */
    lowLiquidity: boolean | undefined;
    /** 불성실 공시 여부(`insn_pbnt_yn`) */
    unfaithfulDisclosure: boolean | undefined;
    /** 신용 가능 여부(`crdt_able_yn`) */
    creditAvailable: boolean | undefined;
    /** 시장 경고 구분 코드(`mrkt_warn_cls_code`) */
    marketWarningCode: string | undefined;
    /** 시장 경고 구분명(`mrkt_warn_cls_name`) */
    marketWarningName: string | undefined;
    /** VI 적용 구분 코드(`vi_cls_code`) */
    viCode: string | undefined;
    /** 단기과열 구분 코드(`short_over_cls_code`) */
    shortTermOverheatedCode: string | undefined;
    /** 증거금 비율(`marg_rate`) */
    marginRate: number | undefined;
    /** 신용 비율(`crdt_rate`) */
    creditRate: number | undefined;
    info: Dict;
}

/** 신용 융자나 대주 하루치(`whol_loan_*`, `whol_stln_*`). 주수는 주, 금액은 원이다. */
export interface KisCreditFlow {
    /** 신규 주수 */
    newShares: number | undefined;
    /** 상환 주수 */
    repaidShares: number | undefined;
    /** 잔고 주수 */
    balanceShares: number | undefined;
    /** 신규 금액 */
    newAmount: number | undefined;
    /** 상환 금액 */
    repaidAmount: number | undefined;
    /** 잔고 금액 */
    balanceAmount: number | undefined;
    /** 잔고 비율 */
    balanceRate: number | undefined;
    /** 공여율 */
    grantRate: number | undefined;
}

/** 신용잔고 일별 추이 하루치(`daily-credit-balance`, TR `FHPST04760000`). */
export interface KisCreditBalanceRecord extends KrTimestamped {
    /** 매매일자 `YYYYMMDD`(`deal_date`) */
    tradeDate: string;
    /** 결제일자 `YYYYMMDD`(`stlm_date`) */
    settlementDate: string | undefined;
    /** 주식 현재가(`stck_prpr`). 그날의 가격이다 */
    price: number | undefined;
    /** 전일대비(`prdy_vrss`) */
    change: number | undefined;
    /** 전일대비율(`prdy_ctrt`) */
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    /** 전체 융자(`whol_loan_*`) */
    loan: KisCreditFlow;
    /** 전체 대주(`whol_stln_*`) */
    stockLoan: KisCreditFlow;
    info: Dict;
}

/** 종목별 대차거래 하루치(`daily-loan-trans`, TR `HHPST074500C0`). */
export interface KisStockLendingRecord extends KrTimestamped {
    /** 일자 `YYYYMMDD`(`bsop_date`) */
    businessDate: string;
    /** 주식 종가(`stck_prpr`) */
    close: number | undefined;
    /** 전일대비(`prdy_vrss`) */
    change: number | undefined;
    /** 전일대비율(`prdy_ctrt`) */
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    /** 당일 증가 주수, 체결(`new_stcn`) */
    newShares: number | undefined;
    /** 당일 감소 주수, 상환(`rdmp_stcn`) */
    repaidShares: number | undefined;
    /** 대차거래 증감(`prdy_rmnd_vrss`) */
    balanceChange: number | undefined;
    /** 당일 잔고 주수(`rmnd_stcn`) */
    balanceShares: number | undefined;
    /** 당일 잔고 금액(`rmnd_amt`) */
    balanceAmount: number | undefined;
    info: Dict;
}

/** 공매도 일별 추이 하루치(`daily-short-sale`, TR `FHPST04830000`). */
export interface KisShortSaleRecord extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    businessDate: string;
    /** 종가(`stck_clpr`) */
    close: number | undefined;
    /** 전일대비(`prdy_vrss`) */
    change: number | undefined;
    /** 전일대비율(`prdy_ctrt`) */
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    /** 누적거래대금(`acml_tr_pbmn`) */
    amount: number | undefined;
    /** 공매도 체결 수량(`ssts_cntg_qty`) */
    shortVolume: number | undefined;
    /** 공매도 거래량 비중(`ssts_vol_rlim`) */
    shortVolumeShare: number | undefined;
    /** 누적 공매도 체결 수량(`acml_ssts_cntg_qty`) */
    cumulativeShortVolume: number | undefined;
    /** 누적 공매도 체결 수량 비중(`acml_ssts_cntg_qty_rlim`) */
    cumulativeShortVolumeShare: number | undefined;
    /** 공매도 거래대금(`ssts_tr_pbmn`) */
    shortAmount: number | undefined;
    /** 공매도 거래대금 비중(`ssts_tr_pbmn_rlim`) */
    shortAmountShare: number | undefined;
    /** 누적 공매도 거래대금(`acml_ssts_tr_pbmn`) */
    cumulativeShortAmount: number | undefined;
    /** 누적 공매도 거래대금 비중(`acml_ssts_tr_pbmn_rlim`) */
    cumulativeShortAmountShare: number | undefined;
    /** 평균가격(`avrg_prc`) */
    averagePrice: number | undefined;
    info: Dict;
}

/** 종목별 일별 매수·매도 체결량(`inquire-daily-trade-volume`, TR `FHKST03010800`). */
export interface KisBuySellVolume {
    /** 매수 체결량 합계(`output1`의 `shnu_cnqn_smtn`) */
    totalBuyVolume: number | undefined;
    /** 매도 체결량 합계(`output1`의 `seln_cnqn_smtn`) */
    totalSellVolume: number | undefined;
    days: Array<KrTimestamped & {
        /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
        businessDate: string;
        /** 총 매수 수량(`total_shnu_qty`) */
        buyVolume: number | undefined;
        /** 총 매도 수량(`total_seln_qty`) */
        sellVolume: number | undefined;
        info: Dict;
    }>;
}

/**
 * 종목별 투자자 일별 동향의 투자자 유형. 외국인(`foreign`)은 등록(`foreignRegistered`)과 비등록(`foreignUnregistered`)의 합이고,
 * 기관계(`institution`)는 증권부터 기금까지의 합이다(KIS 응답의 계 필드를 그대로 옮긴다).
 */
export type KisInvestorType =
    | 'foreign' | 'foreignRegistered' | 'foreignUnregistered' | 'individual' | 'institution' | 'securities' | 'investmentTrust'
    | 'privateFund' | 'bank' | 'insurance' | 'merchantBank' | 'pensionFund' | 'other' | 'otherCorporation' | 'otherOrganization';

/** 종목별 투자자 일별 동향 하루치(`investor-trade-by-stock-daily`, TR `FHPTJ04160001`). */
export interface KisInvestorTradingDay extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    businessDate: string;
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    /** 종가(`stck_clpr`) */
    close: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    /** 누적거래대금(`acml_tr_pbmn`) */
    amount: number | undefined;
    /** 투자자 유형별 매수·매도. 수량 필드 이름이 `_qty`와 `_vol`로 섞여 있어 유형마다 필드를 표로 정한다 */
    investors: Record<KisInvestorType, KisInvestorAmounts>;
    info: Dict;
}

/** 종목별 외국인·기관 추정 가집계 한 구간(`investor-trend-estimate`, TR `HHPTJ04160200`). */
export interface KisInvestorEstimate {
    /** 입력구분(`bsop_hour_gb`). KIS 원문 코드 그대로다(뜻은 공식 문서에 없어 확인 못 했다) */
    timeSlot: string | undefined;
    /** 외국인 수량, 가집계(`frgn_fake_ntby_qty`) */
    foreignNetBuyVolume: number | undefined;
    /** 기관 수량, 가집계(`orgn_fake_ntby_qty`) */
    institutionNetBuyVolume: number | undefined;
    /** 합산 수량, 가집계(`sum_fake_ntby_qty`) */
    totalNetBuyVolume: number | undefined;
    info: Dict;
}

/** 종목별 외국계 순매수 추이 한 건(`frgnmem-pchs-trend`, TR `FHKST644400C0`). */
export interface KisForeignTradeTick {
    /** 영업시간 `HHMMSS`(`bsop_hour`). 날짜는 응답에 없다 */
    time: string;
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    cumulativeVolume: number | undefined;
    /** 외국인 매도 거래량(`frgn_seln_vol`) */
    foreignSellVolume: number | undefined;
    /** 외국인 매수 거래량(`frgn_shnu_vol`) */
    foreignBuyVolume: number | undefined;
    /** 외국계 증권사 순매수 수량(`glob_ntby_qty`) */
    foreignBrokerNetBuyVolume: number | undefined;
    /** 외국인 순매수 수량 증감(`frgn_ntby_qty_icdc`) */
    foreignNetBuyChange: number | undefined;
    info: Dict;
}

/** 회원사 한 곳의 종목 매매 하루치(`inquire-member-daily`, TR `FHPST04540000`). */
export interface KisMemberDailyRecord extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    businessDate: string;
    /** 총 매도 수량(`total_seln_qty`) */
    sellVolume: number | undefined;
    /** 총 매수 수량(`total_shnu_qty`) */
    buyVolume: number | undefined;
    /** 순매수 수량(`ntby_qty`) */
    netBuyVolume: number | undefined;
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    info: Dict;
}

/** 종목 프로그램 매매 합계(`whol_smtn_*`). 수량은 주, 대금은 원이다. */
export interface KisProgramTradingFlow {
    sellVolume: number | undefined;
    buyVolume: number | undefined;
    netBuyVolume: number | undefined;
    sellAmount: number | undefined;
    buyAmount: number | undefined;
    netBuyAmount: number | undefined;
    /** 순매수 거래량 증감(`whol_ntby_vol_icdc`) */
    netBuyVolumeChange: number | undefined;
    /** 순매수 거래대금 증감(체결 `whol_ntby_tr_pbmn_icdc`, 일별 `whol_ntby_tr_pbmn_icdc2`) */
    netBuyAmountChange: number | undefined;
}

/** 종목별 프로그램 매매 추이의 체결 한 건(`program-trade-by-stock`, TR `FHPPG04650101`). */
export interface KisProgramTradingTick extends KisProgramTradingFlow {
    /** 영업시간 `HHMMSS`(`bsop_hour`). 날짜는 응답에 없다 */
    time: string;
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    cumulativeVolume: number | undefined;
    info: Dict;
}

/** 종목별 프로그램 매매 추이 하루치(`program-trade-by-stock-daily`, TR `FHPPG04650201`). */
export interface KisProgramTradingDay extends KisProgramTradingFlow, KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    businessDate: string;
    /** 종가(`stck_clpr`) */
    close: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    /** 누적거래대금(`acml_tr_pbmn`) */
    amount: number | undefined;
    info: Dict;
}

/** 시장 단위 조회의 시장. */
export type KisMarket = 'KOSPI' | 'KOSDAQ';

/** 투자자 유형 하나의 당일 프로그램 매매(`investor-program-trade-today`, TR `HHPPG046600C1`). */
export interface KisProgramTradingByInvestor {
    /** 투자자코드(`invr_cls_code`) */
    investorCode: string;
    /** 투자자 구분명(`invr_cls_name`) */
    investorName: string | undefined;
    /** 전체(`all_*`) */
    total: KisInvestorAmounts;
    /** 차익(`arbt_*`) */
    arbitrage: KisInvestorAmounts;
    /** 비차익(`nabt_*`) */
    nonArbitrage: KisInvestorAmounts;
    info: Dict;
}

/** 시장별 투자자 매매동향 하루치(`inquire-investor-daily-by-market`, TR `FHPTJ04040000`). */
export interface KisMarketInvestorTradingDay extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    businessDate: string;
    /** 업종 지수 현재가(`bstp_nmix_prpr`) */
    indexPrice: number | undefined;
    /** 업종 지수 전일대비(`bstp_nmix_prdy_vrss`) */
    indexChange: number | undefined;
    /** 업종 지수 전일대비율(`bstp_nmix_prdy_ctrt`) */
    indexChangeRate: number | undefined;
    indexOpen: number | undefined;
    indexHigh: number | undefined;
    indexLow: number | undefined;
    /** 투자자 유형별 순매수. 이 API는 순매수 수량과 대금만 주므로 매수·매도 칸은 비어 있다 */
    investors: Record<KisInvestorType, KisInvestorAmounts>;
    info: Dict;
}

/** 국내 증시자금 종합 하루치(`mktfunds`, TR `FHKST649100C0`). 금액 단위는 공식 문서에 없어 원문 값 그대로다. */
export interface KisMarketFundsRecord extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`bsop_date`) */
    businessDate: string;
    /** 업종지수 현재가(`bstp_nmix_prpr`) */
    indexPrice: number | undefined;
    /** 업종지수 전일대비(`bstp_nmix_prdy_vrss`) */
    indexChange: number | undefined;
    /** 전일대비율(`prdy_ctrt`) */
    indexChangeRate: number | undefined;
    /** HTS 시가총액(`hts_avls`) */
    marketCap: number | undefined;
    /** 고객예탁금(`cust_dpmn_amt`) */
    customerDeposit: number | undefined;
    /** 고객예탁금 전일대비(`cust_dpmn_amt_prdy_vrss`) */
    customerDepositChange: number | undefined;
    /** 금액회전율(`amt_tnrt`) */
    turnoverRate: number | undefined;
    /** 미수금액(`uncl_amt`) */
    unsettledAmount: number | undefined;
    /** 신용융자잔고(`crdt_loan_rmnd`) */
    creditLoanBalance: number | undefined;
    /** 선물예수금(`futs_tfam_amt`) */
    futuresDeposit: number | undefined;
    /** 주식형 펀드(`sttp_amt`) */
    equityFunds: number | undefined;
    /** 혼합형 펀드(`mxtp_amt`) */
    mixedFunds: number | undefined;
    /** 채권형 펀드(`bntp_amt`) */
    bondFunds: number | undefined;
    /** MMF(`mmf_amt`) */
    moneyMarketFunds: number | undefined;
    /** 담보대출잔고(`secu_lend_amt`) */
    collateralLoanBalance: number | undefined;
    info: Dict;
}

/** 예상체결가 추이(`exp-price-trend`, TR `FHPST01810000`). */
export interface KisExpectedPriceTrend {
    /** 예상 체결가(`antc_cnpr`) */
    expectedPrice: number | undefined;
    /** 예상 체결 대비(`antc_cntg_vrss`) */
    expectedChange: number | undefined;
    /** 예상 체결 전일대비율(`antc_cntg_prdy_ctrt`) */
    expectedChangeRate: number | undefined;
    /** 예상 거래량(`antc_vol`) */
    expectedVolume: number | undefined;
    /** 예상 거래대금(`antc_tr_pbmn`) */
    expectedAmount: number | undefined;
    /** 시각별 추이(`output2`). 시각은 영업일자와 체결시간(KST)을 합친 값이다 */
    points: Array<{
        timestamp: Int;
        price: number | undefined;
        change: number | undefined;
        percentage: number | undefined;
        /** 누적거래량(`acml_vol`) */
        volume: number | undefined;
        info: Dict;
    }>;
    info: Dict;
}

/** 매물대와 거래비중(`pbar-tratio`, TR `FHPST01130000`). */
export interface KisVolumeProfile {
    /** 가중평균 주식가격(`wghn_avrg_stck_prc`) */
    weightedAveragePrice: number | undefined;
    /** 상장주수(`lstn_stcn`) */
    listedShares: number | undefined;
    /** 가격대별 거래(`output2`) */
    levels: Array<{
        /** 데이터순위(`data_rank`) */
        rank: number | undefined;
        /** 가격대(`stck_prpr`) */
        price: number | undefined;
        /** 체결거래량(`cntg_vol`) */
        volume: number | undefined;
        /** 누적거래량 비중(`acml_vol_rlim`) */
        share: number | undefined;
        info: Dict;
    }>;
    info: Dict;
}

/** 체결금액별 매매비중 한 구간(`tradprt-byamt`, TR `FHKST111900C0`). */
export interface KisTradeShareByAmount {
    /** 가격명(`prpr_name`). 구간 이름이다 */
    bucket: string;
    /** 합계 평균가격(`smtn_avrg_prpr`) */
    averagePrice: number | undefined;
    /** 합계 거래량(`acml_vol`) */
    volume: number | undefined;
    /** 합계 순매수비율(`whol_ntby_qty_rate`) */
    netBuyRate: number | undefined;
    /** 합계 순매수건수(`ntby_cntg_csnu`) */
    netBuyCount: number | undefined;
    /** 매도 거래량(`seln_cnqn_smtn`) */
    sellVolume: number | undefined;
    /** 매도 거래량비율(`whol_seln_vol_rate`) */
    sellVolumeRate: number | undefined;
    /** 매도 건수(`seln_cntg_csnu`) */
    sellCount: number | undefined;
    /** 매수 거래량(`shnu_cnqn_smtn`) */
    buyVolume: number | undefined;
    /** 매수 거래량비율(`whol_shun_vol_rate`) */
    buyVolumeRate: number | undefined;
    /** 매수 건수(`shnu_cntg_csnu`) */
    buyCount: number | undefined;
    info: Dict;
}

/** 재무 조회 종류. `fetchFinancials`가 받는다. */
export type KisFinancialStatement =
    | 'BALANCE_SHEET'
    | 'INCOME_STATEMENT'
    | 'FINANCIAL_RATIO'
    | 'PROFITABILITY_RATIO'
    | 'OTHER_KEY_RATIO'
    | 'STABILITY_RATIO'
    | 'GROWTH_RATIO';

/** 재무 조회의 결산 한 기간. `values`의 키는 종류마다 다르고 `KIS_FINANCIAL_SPECS` 표가 정한다. 금액 단위는 문서에 없어 원문 값 그대로다. */
export interface KisFinancialRecord {
    /** 결산 연월 `YYYYMM`(`stac_yymm`) */
    settlementMonth: string;
    values: Record<string, number | undefined>;
    info: Dict;
}

/** 예탁원 일정 종류. `fetchCorporateSchedules`가 받는다. */
export type KisCorporateScheduleType =
    | 'RIGHTS_ISSUE'
    | 'BONUS_ISSUE'
    | 'DIVIDEND'
    | 'APPRAISAL_RIGHTS'
    | 'MERGER_SPLIT'
    | 'PAR_VALUE_CHANGE'
    | 'CAPITAL_REDUCTION'
    | 'LISTING'
    | 'PUBLIC_OFFERING'
    | 'FORFEITED_SHARES'
    | 'MANDATORY_DEPOSIT'
    | 'SHAREHOLDER_MEETING';

/** 예탁원 일정 한 건(`ksdinfo/*`). 종류마다 필드가 달라 공통 필드만 옮기고 나머지는 `info`에 원문으로 둔다. */
export interface KisCorporateSchedule extends KrTimestamped {
    /** 통합 심볼(`sht_cd` + `/KRW`). 종목코드가 비어 있으면 빈 문자열이다 */
    symbol: string;
    /** 종목명(`isin_name`). 합병·분할 일정에는 없다 */
    name: string | undefined;
    /** 기준일 `YYYYMMDD`(`record_date`). 상장정보와 의무예치 일정에는 없다 */
    recordDate: string | undefined;
    info: Dict;
}

/** 당사 신용가능 종목 하나(`credit-by-company`, TR `FHPST04770000`). */
export interface KisCreditStock {
    symbol: string;
    /** HTS 한글 종목명(`hts_kor_isnm`) */
    name: string | undefined;
    /** 신용 비율(`crdt_rate`) */
    creditRate: number | undefined;
    info: Dict;
}

/** 투자의견 한 건. 종목투자의견(`invest-opinion`)과 증권사별 투자의견(`invest-opbysec`)이 같은 모양을 쓴다. 없는 필드는 비어 있다. */
export interface KisInvestmentOpinion extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    date: string;
    /** 통합 심볼. 증권사별 투자의견에만 종목코드(`stck_shrn_iscd`)가 있다 */
    symbol: string | undefined;
    /** HTS 한글 종목명(`hts_kor_isnm`). 증권사별 투자의견에만 있다 */
    name: string | undefined;
    /** 회원사명(`mbcr_name`) */
    memberName: string | undefined;
    /** 투자의견(`invt_opnn`) */
    opinion: string | undefined;
    /** 투자의견 구분코드(`invt_opnn_cls_code`). KIS 원문 코드 그대로다 */
    opinionCode: string | undefined;
    /** 직전 투자의견(`rgbf_invt_opnn`) */
    previousOpinion: string | undefined;
    /** 직전 투자의견 구분코드(`rgbf_invt_opnn_cls_code`) */
    previousOpinionCode: string | undefined;
    /** HTS 목표가격(`hts_goal_prc`) */
    targetPrice: number | undefined;
    /** 전일 종가(`stck_prdy_clpr`) */
    previousClose: number | undefined;
    /** 괴리율(`dprt`) */
    divergenceRate: number | undefined;
    /** 주식선물 괴리도(`stft_esdg`) */
    futuresSpread: number | undefined;
    info: Dict;
}

/** 종합 시황·공시 제목 하나(`news-title`, TR `FHKST01011800`). */
export interface KisNewsTitle extends KrTimestamped {
    /** 내용 조회용 일련번호(`cntt_usiq_srno`) */
    id: string;
    /** 작성 시각. 작성일자(`data_dt`)와 작성시간(`data_tm`, KST)을 합친 값이다 */
    timestamp: Int;
    /** HTS 공시 제목(`hts_pbnt_titl_cntt`) */
    title: string | undefined;
    /** 자료원(`dorg`) */
    source: string | undefined;
    /** 뉴스 제공 업체 코드(`news_ofer_entp_code`) */
    providerCode: string | undefined;
    /** 뉴스 대구분(`news_lrdv_code`) */
    categoryCode: string | undefined;
    /** 관련 종목코드(`iscd1`~`iscd5`). 빈 칸은 뺀다 */
    codes: string[];
    info: Dict;
}

/** 상품기본조회 결과(`search-info`, TR `CTPF1604R`). 필드는 공식 예제의 필드 목록에 있는 것만 옮긴다. */
export interface KisProductInfo {
    symbol: string;
    /** 표준상품번호(`std_pdno`) */
    standardCode: string | undefined;
    /** 단축상품번호(`shtn_pdno`) */
    shortCode: string | undefined;
    /** 상품판매상태코드(`prdt_sale_stat_cd`) */
    saleStatusCode: string | undefined;
    /** 상품위험등급코드(`prdt_risk_grad_cd`) */
    riskGradeCode: string | undefined;
    /** 상품분류코드(`prdt_clsf_cd`) */
    classificationCode: string | undefined;
    /** 판매시작일자(`sale_strt_dt`) */
    saleStartDate: string | undefined;
    /** 판매종료일자(`sale_end_dt`) */
    saleEndDate: string | undefined;
    /** 최초등록일자(`frst_erlm_dt`) */
    firstRegisteredDate: string | undefined;
    info: Dict;
}

/** 당사 대주가능 종목 하나(`lendable-by-company`, TR `CTSC2702R`). */
export interface KisLendableStock extends KrTimestamped {
    symbol: string;
    /** 상품명(`prdt_name`) */
    name: string | undefined;
    /** 액면가(`papr`) */
    parValue: number | undefined;
    /** 전일종가(`bfdy_clpr`) */
    previousClose: number | undefined;
    /** 대용가(`sbst_prvs`) */
    collateralPrice: number | undefined;
    /** 가능여부(`psbl_yn`). `Y`, `N` 밖의 값이면 비운다 */
    available: boolean | undefined;
    /** 한도수량1(`lmt_qty1`) */
    limitQuantity: number | undefined;
    /** 사용수량1(`use_qty1`) */
    usedQuantity: number | undefined;
    /** 매매가능수량2(`trad_psbl_qty2`) */
    tradableQuantity: number | undefined;
    /** 기준일자(`bass_dt`) */
    baseDate: string | undefined;
    info: Dict;
}

/** 업종 지수 현재가(`inquire-index-price`, TR `FHPUP02100000`). 종목 수는 그 업종에 속한 종목의 등락 분포다. */
export interface KisIndexQuote {
    /** 업종코드 네 자리 */
    index: string;
    /** 업종 지수 현재가(`bstp_nmix_prpr`) */
    price: number | undefined;
    /** 전일대비(`bstp_nmix_prdy_vrss`) */
    change: number | undefined;
    /** 전일대비율(`bstp_nmix_prdy_ctrt`) */
    percentage: number | undefined;
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    /** 누적거래대금(`acml_tr_pbmn`) */
    amount: number | undefined;
    /** 상승 종목 수(`ascn_issu_cnt`) */
    advancers: number | undefined;
    /** 상한 종목 수(`uplm_issu_cnt`) */
    upperLimitCount: number | undefined;
    /** 보합 종목 수(`stnr_issu_cnt`) */
    unchanged: number | undefined;
    /** 하락 종목 수(`down_issu_cnt`) */
    decliners: number | undefined;
    /** 하한 종목 수(`lslm_issu_cnt`) */
    lowerLimitCount: number | undefined;
    info: Dict;
}

/** 업종 지수 일자별 한 봉(`inquire-index-daily-price`의 `output2`). */
export interface KisIndexDay extends KrTimestamped {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    date: string;
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    volume: number | undefined;
    amount: number | undefined;
    /** 누적거래량 비중(`acml_vol_rlim`) */
    volumeShare: number | undefined;
    /** 투자 신 심리도(`invt_new_psdg`) */
    investorSentiment: number | undefined;
    /** 20일 이격도(`d20_dsrt`) */
    disparity20: number | undefined;
    info: Dict;
}

/** 업종 지수의 시각별 값 하나. 시간별 지수(분, 초)와 예상체결지수 추이가 쓴다. 날짜는 응답에 없어 시각 문자열만 둔다. */
export interface KisIndexTick {
    /** 시각 `HHMMSS`(`bsop_hour` 또는 `stck_cntg_hour`) */
    time: string;
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    cumulativeVolume: number | undefined;
    /** 누적거래대금(`acml_tr_pbmn`) */
    cumulativeAmount: number | undefined;
    /** 체결거래량(`cntg_vol`). 예상체결지수 추이에는 없다 */
    volume: number | undefined;
    info: Dict;
}

/** 업종 하나의 시세(구분별 전체시세, 예상체결 전체지수의 `output2`). 없는 필드는 비어 있다. */
export interface KisIndexCategory {
    /** 업종 구분 코드(`bstp_cls_code`) */
    sectorCode: string;
    /** 업종명(`hts_kor_isnm`) */
    name: string | undefined;
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    volume: number | undefined;
    /** 누적거래대금(`acml_tr_pbmn`). 예상체결 전체지수에는 없다 */
    amount: number | undefined;
    /** 누적거래량 비중(`acml_vol_rlim`). 구분별 전체시세에만 있다 */
    volumeShare: number | undefined;
    /** 누적거래대금 비중(`acml_tr_pbmn_rlim`). 구분별 전체시세에만 있다 */
    amountShare: number | undefined;
    /** 지수 기준가(`nmix_sdpr`). 예상체결 전체지수에만 있다 */
    basePrice: number | undefined;
    info: Dict;
}

/** 금리 하나(`comp-interest`, TR `FHPST07020000`). 응답의 두 목록(`output1`, `output2`)이 무엇을 가르는지 문서에 없어 `outputKey`로 원문 키를 남긴다. */
export interface KisInterestRate extends KrTimestamped {
    /** 자료코드(`bcdt_code`) */
    code: string;
    /** 이름(`hts_kor_isnm`) */
    name: string | undefined;
    /** 채권금리 현재가(`bond_mnrt_prpr`) */
    rate: number | undefined;
    /** 채권금리 전일대비(`bond_mnrt_prdy_vrss`) */
    change: number | undefined;
    /** 전일대비율(`output1`은 `prdy_ctrt`, `output2`는 `bstp_nmix_prdy_ctrt`) */
    percentage: number | undefined;
    /** 영업일자(`stck_bsop_date`) */
    date: string | undefined;
    outputKey: 'output1' | 'output2';
    info: Dict;
}

/** 국내선물 영업일과 장 시각(`market-time`, TR `HHMCM000002C0`). */
export interface KisMarketTime {
    /** 영업일 다섯 개(`date1`~`date5`). 빈 칸은 뺀다 */
    businessDays: string[];
    /** 오늘일자(`today`) */
    today: string | undefined;
    /** 현재시간(`time`) */
    time: string | undefined;
    /** 장시작시간(`s_time`) */
    openTime: string | undefined;
    /** 장마감시간(`e_time`) */
    closeTime: string | undefined;
    info: Dict;
}

/** 예상체결 조회의 구분(`FID_MKOP_CLS_CODE`): 장 시작 전(`1`)과 장 마감(`2`). 전체 값이 없어 호출하는 쪽이 고른다. */
export type KisAuctionSession = 'preopen' | 'closing';

/** 해외주식 현재가 상세(`price-detail`, TR `HHDFS76200200`). 가격 단위는 종목의 거래 통화다(`currency`). */
export interface KisOverseasStockDetail {
    symbol: string;
    last: number | undefined;
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    /** 전일종가(`base`) */
    previousClose: number | undefined;
    /** 거래량(`tvol`) */
    volume: number | undefined;
    /** 거래대금(`tamt`) */
    amount: number | undefined;
    /** 전일거래량(`pvol`) */
    previousVolume: number | undefined;
    /** 시가총액(`tomv`) */
    marketCap: number | undefined;
    /** 상한가(`uplp`) */
    upperLimitPrice: number | undefined;
    /** 하한가(`dnlp`) */
    lowerLimitPrice: number | undefined;
    /** 52주 최고가(`h52p`)와 그 일자(`h52d`) */
    high52Week: number | undefined;
    high52WeekDate: string | undefined;
    /** 52주 최저가(`l52p`)와 그 일자(`l52d`) */
    low52Week: number | undefined;
    low52WeekDate: string | undefined;
    per: number | undefined;
    pbr: number | undefined;
    eps: number | undefined;
    bps: number | undefined;
    /** 상장주수(`shar`) */
    listedShares: number | undefined;
    /** 통화(`curr`) */
    currency: string | undefined;
    /** 매매단위(`vnit`) */
    lotSize: number | undefined;
    /** 호가단위(`e_hogau`) */
    tickSize: number | undefined;
    /** 업종, 섹터(`e_icod`) */
    sector: string | undefined;
    /** 거래가능여부(`e_ordyn`). 원문 그대로다 */
    tradable: string | undefined;
    /** 원환산 당일가격(`t_xprc`) */
    krwPrice: number | undefined;
    /** 당일환율(`t_rate`) */
    exchangeRate: number | undefined;
    info: Dict;
}

/** 해외주식 체결 한 건(`inquire-ccnl`, TR `HHDFS76200300`). 시각은 한국 기준 시각 문자열(`khms`)이다. */
export interface KisOverseasTradeTick {
    /** 한국기준시간 `HHMMSS`(`khms`) */
    time: string;
    /** 체결가(`last`) */
    price: number | undefined;
    /** 대비(`diff`) */
    change: number | undefined;
    /** 등락율(`rate`) */
    percentage: number | undefined;
    /** 체결량(`evol`) */
    volume: number | undefined;
    /** 거래량(`tvol`) */
    cumulativeVolume: number | undefined;
    /** 매수호가(`pbid`) */
    bid: number | undefined;
    /** 매도호가(`pask`) */
    ask: number | undefined;
    /** 체결강도(`vpow`) */
    strength: number | undefined;
    /** 시장구분(`mtyp`). 원문 코드 그대로다 */
    marketType: string | undefined;
    info: Dict;
}

/** 해외 종목·지수·환율 기간별 시세의 종류(`FID_COND_MRKT_DIV_CODE`): 해외지수 `N`, 환율 `X`, 국채 `I`, 금선물 `S`. */
export type KisGlobalDailyKind = 'INDEX' | 'FX' | 'BOND' | 'GOLD_FUTURES';

/** 해외지수 분봉의 종류(`FID_COND_MRKT_DIV_CODE`): 해외지수 `N`, 환율 `X`, 원화환율 `KX`. */
export type KisGlobalMinuteKind = 'INDEX' | 'FX' | 'KRW_FX';

/** 해외지수 분봉 하나(`inquire-time-indexchartprice`의 `output2`). 날짜와 시각의 시간대가 문서에 없어 문자열로 둔다. */
export interface KisGlobalMinuteBar {
    /** 영업일자 `YYYYMMDD`(`stck_bsop_date`) */
    date: string;
    /** 체결시간 `HHMMSS`(`stck_cntg_hour`) */
    time: string;
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    /** 현재가(`optn_prpr`) */
    close: number | undefined;
    /** 체결거래량(`cntg_vol`) */
    volume: number | undefined;
    info: Dict;
}

/** 해외 거래소의 업종 하나(`industry-price`, TR `HHDFS76370100`). */
export interface KisOverseasIndustry {
    /** 업종코드(`icod`). `fetchOverseasIndustryStocks`에 넘긴다 */
    code: string;
    /** 업종명(`name`) */
    name: string | undefined;
    info: Dict;
}

/** 해외 결제일 하나(`countries-holiday`, TR `CTOS5011R`). */
export interface KisSettlementDate {
    /** 거래국가코드(`tr_natn_cd`) */
    countryCode: string | undefined;
    /** 거래국가명(`tr_natn_name`) */
    countryName: string | undefined;
    /** 거래시장코드(`tr_mket_cd`) */
    marketCode: string | undefined;
    /** 거래시장명(`tr_mket_name`) */
    marketName: string | undefined;
    /** 현지결제일자(`acpl_sttl_dt`) */
    localSettlementDate: string | undefined;
    /** 국내결제일자(`dmst_sttl_dt`) */
    domesticSettlementDate: string | undefined;
    info: Dict;
}

/** 해외뉴스 종합 제목 하나(`news-title`, TR `HHPSTH60100C1`). 조회일자와 시간의 시간대가 문서에 없어 문자열로 둔다. */
export interface KisOverseasNewsTitle {
    /** 뉴스키(`news_key`) */
    id: string;
    /** 조회일자(`data_dt`) */
    date: string | undefined;
    /** 조회시간(`data_tm`) */
    time: string | undefined;
    /** 제목(`title`) */
    title: string | undefined;
    /** 자료원(`source`) */
    source: string | undefined;
    /** 뉴스구분(`info_gb`) */
    newsType: string | undefined;
    /** 중분류 코드(`class_cd`)와 이름(`class_name`) */
    categoryCode: string | undefined;
    categoryName: string | undefined;
    /** 국가코드(`nation_cd`) */
    countryCode: string | undefined;
    /** 거래소코드(`exchange_cd`) */
    exchangeCode: string | undefined;
    /** 종목코드(`symb`)와 종목명(`symb_name`) */
    code: string | undefined;
    name: string | undefined;
    info: Dict;
}

/** 해외 조건검색의 조건 하나: [하한, 상한]. 가격은 각국 통화, 시가총액과 주식수와 거래대금은 천 단위, 거래량은 주, 등락률은 %다(설명). */
export type KisRange = readonly [number, number];

/** 해외 조건검색(`inquire-search`)의 조건. 준 조건만 켠다(`CO_YN_*`를 `1`로). */
export interface KisOverseasScreenerConditions {
    price?: KisRange;
    percentage?: KisRange;
    marketCap?: KisRange;
    shares?: KisRange;
    volume?: KisRange;
    amount?: KisRange;
    eps?: KisRange;
    per?: KisRange;
}

/** 해외 조건검색 결과 종목 하나(`inquire-search`, TR `HHDFS76410000`의 `output2`). */
export interface KisOverseasScreenerItem {
    /** 통합 심볼. 거래소의 거래 통화를 붙인다 */
    symbol: string;
    name: string | undefined;
    rank: number | undefined;
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    /** 거래량(`tvol`) */
    volume: number | undefined;
    /** 거래대금(`avol`) */
    amount: number | undefined;
    /** 시가총액(`valx`) */
    marketCap: number | undefined;
    /** 발행주식(`shar`) */
    shares: number | undefined;
    eps: number | undefined;
    per: number | undefined;
    info: Dict;
}

/** 당사 해외주식 담보대출 가능 종목 하나(`colable-by-company`, TR `CTLN4050R`). */
export interface KisOverseasLoanableStock {
    /** 상품번호(`pdno`) */
    code: string;
    /** 해외종목명(`ovrs_item_name`) */
    name: string | undefined;
    /** 대출비율(`loan_rt`) */
    loanRate: number | undefined;
    /** 담보유지비율(`mgge_mntn_rt`) */
    maintenanceRate: number | undefined;
    /** 담보확보비율(`mgge_ensu_rt`) */
    collateralRate: number | undefined;
    /** 대출실행가능여부(`loan_exec_psbl_yn`). `Y`, `N` 밖의 값이면 비운다 */
    loanAvailable: boolean | undefined;
    /** 통화코드(`crcy_cd`) */
    currency: string | undefined;
    /** 거래시장명(`tr_mket_name`) */
    marketName: string | undefined;
    info: Dict;
}

/** 해외주식 기간별 권리 하나(`period-rights`, TR `CTRGT011R`). */
export interface KisOverseasCorporateAction extends KrTimestamped {
    /** 기준일자(`bass_dt`) */
    date: string;
    /** 권리유형코드(`rght_type_cd`). 01 유상, 02 무상, 03 배당 등(설명) */
    rightTypeCode: string | undefined;
    /** 상품번호(`pdno`)와 상품명(`prdt_name`) */
    code: string | undefined;
    name: string | undefined;
    /** 현지기준일자(`acpl_bass_dt`) */
    localRecordDate: string | undefined;
    /** 청약 시작·종료일자(`sbsc_strt_dt`, `sbsc_end_dt`) */
    subscriptionStartDate: string | undefined;
    subscriptionEndDate: string | undefined;
    /** 현금배정비율(`cash_alct_rt`) */
    cashAllocationRate: number | undefined;
    /** 주식배정비율(`stck_alct_rt`) */
    stockAllocationRate: number | undefined;
    /** 통화코드(`crcy_cd`) */
    currency: string | undefined;
    /** 확정여부(`dfnt_yn`). `Y`, `N` 밖의 값이면 비운다 */
    confirmed: boolean | undefined;
    info: Dict;
}

/** 해외주식 권리종합 한 건(`rights-by-ice`, TR `HHDFS78330900`). ICE 공시 기준이다. 날짜는 원문 문자열이다. */
export interface KisOverseasRightsEvent {
    /** 권리유형(`ca_title`) */
    title: string | undefined;
    /** ICE 공시일(`anno_dt`) */
    announcedDate: string | undefined;
    /** 기준일(`record_dt`) */
    recordDate: string | undefined;
    /** 배당락일(`div_lock_dt`) */
    exDividendDate: string | undefined;
    /** 권리락일(`lock_dt`) */
    exRightsDate: string | undefined;
    /** 지급일(`pay_dt`) */
    paymentDate: string | undefined;
    /** 효력일자(`validity_dt`) */
    effectiveDate: string | undefined;
    /** 상장폐지일(`delist_dt`) */
    delistDate: string | undefined;
    info: Dict;
}

/** 해외주식 상품기본정보(`search-info`, TR `CTPF1702R`). 필드가 많아 주요 필드만 옮기고 나머지는 `info`에 원문으로 둔다. */
export interface KisOverseasProductInfo {
    symbol: string;
    /** 표준상품번호(`std_pdno`) */
    standardCode: string | undefined;
    /** 상품명(`prdt_name`)과 영문명(`prdt_eng_name`) */
    name: string | undefined;
    englishName: string | undefined;
    /** 국가명(`natn_name`), 거래시장명(`tr_mket_name`), 해외거래소명(`ovrs_excg_name`) */
    countryName: string | undefined;
    marketName: string | undefined;
    exchangeName: string | undefined;
    /** 거래통화코드(`tr_crcy_cd`) */
    currency: string | undefined;
    /** 해외액면가(`ovrs_papr`) */
    parValue: number | undefined;
    /** 상품분류명(`prdt_clsf_name`) */
    classificationName: string | undefined;
    /** 매수·매도 단위수량(`buy_unit_qty`, `sll_unit_qty`) */
    buyUnit: number | undefined;
    sellUnit: number | undefined;
    /** 상장주식수(`lstg_stck_num`)와 상장일자(`lstg_dt`) */
    listedShares: number | undefined;
    listedDate: string | undefined;
    /** 상장폐지종목여부(`lstg_abol_item_yn`). `Y`, `N` 밖의 값이면 비운다 */
    delisted: boolean | undefined;
    info: Dict;
}

/** 투자계좌 자산현황(`inquire-account-balance`, TR `CTRP6548R`). 금액은 원이다. */
export interface KisAccountAssets {
    /** 총자산금액(`tot_asst_amt`) */
    totalAssets: number | undefined;
    /** 순자산총금액(`nass_tot_amt`) */
    netAssets: number | undefined;
    /** 매입금액합계(`pchs_amt_smtl`) */
    purchaseAmount: number | undefined;
    /** 평가금액합계(`evlu_amt_smtl`) */
    evaluationAmount: number | undefined;
    /** 평가손익금액합계(`evlu_pfls_amt_smtl`) */
    unrealizedPnl: number | undefined;
    /** 대출금액합계(`loan_amt_smtl`) */
    loanAmount: number | undefined;
    /** 예수금액(`dncl_amt`)과 총예수금액(`tot_dncl_amt`) */
    deposit: number | undefined;
    totalDeposit: number | undefined;
    /** CMA평가금액(`cma_evlu_amt`) */
    cmaEvaluation: number | undefined;
    /** 외화평가총액(`frcr_evlu_tota`) */
    foreignCurrencyEvaluation: number | undefined;
    /** 해외주식평가금액(`ovrs_stck_evlu_amt1`) */
    overseasStockEvaluation: number | undefined;
    /** 당일미수금액(`thdt_rcvb_amt`) */
    receivable: number | undefined;
    /**
     * 자산 구분별 행(`output1`). 응답에 구분 이름이 없어 원문 순서 그대로 둔다. 매입금액, 평가금액, 평가손익, 신용대출, 실제순자산, 전체비중이다.
     */
    categories: Array<{
        purchaseAmount: number | undefined;
        evaluationAmount: number | undefined;
        unrealizedPnl: number | undefined;
        creditLoanAmount: number | undefined;
        realNetAssets: number | undefined;
        weight: number | undefined;
        info: Dict;
    }>;
    info: Dict;
}

/** 주식잔고조회_실현손익(`inquire-balance-rlz-pl`, TR `TTTC8494R`). 보유 종목과 실현손익을 함께 준다. */
export interface KisRealizedPnlBalance {
    positions: Array<{
        symbol: string;
        name: string | undefined;
        /** 보유수량(`hldg_qty`)과 주문가능수량(`ord_psbl_qty`) */
        quantity: number | undefined;
        orderableQuantity: number | undefined;
        /** 매입평균가격(`pchs_avg_pric`) */
        averagePrice: number | undefined;
        purchaseAmount: number | undefined;
        /** 현재가(`prpr`) */
        price: number | undefined;
        evaluationAmount: number | undefined;
        unrealizedPnl: number | undefined;
        /** 평가손익율(`evlu_pfls_rt`) */
        unrealizedPnlRate: number | undefined;
        info: Dict;
    }>;
    /** 실현손익(`rlzt_pfls`)과 실현수익율(`rlzt_erng_rt`) */
    realizedPnl: number | undefined;
    realizedPnlRate: number | undefined;
    /** 총평가금액(`tot_evlu_amt`), 순자산금액(`nass_amt`), 예수금총금액(`dnca_tot_amt`) */
    totalEvaluation: number | undefined;
    netAssets: number | undefined;
    deposit: number | undefined;
    /** 매입금액, 평가금액, 평가손익 합계(`pchs_amt_smtl_amt`, `evlu_amt_smtl_amt`, `evlu_pfls_smtl_amt`) */
    purchaseAmount: number | undefined;
    evaluationAmount: number | undefined;
    unrealizedPnl: number | undefined;
    info: Dict;
}

/** 신용매수가능조회(`inquire-credit-psamount`, TR `TTTC8909R`). */
export interface KisCreditBuyable {
    /** 주문가능현금(`ord_psbl_cash`)과 주문가능대용(`ord_psbl_sbst`) */
    orderableCash: number | undefined;
    orderableSubstitute: number | undefined;
    /** 재사용가능금액(`ruse_psbl_amt`) */
    reusableAmount: number | undefined;
    /** 최대매수금액(`max_buy_amt`)과 최대매수수량(`max_buy_qty`) */
    maxBuyAmount: number | undefined;
    maxBuyQuantity: number | undefined;
    /** 미수없는 매수금액(`nrcvb_buy_amt`)과 수량(`nrcvb_buy_qty`) */
    noReceivableBuyAmount: number | undefined;
    noReceivableBuyQuantity: number | undefined;
    /** 가능수량계산단가(`psbl_qty_calc_unpr`) */
    calculationPrice: number | undefined;
    info: Dict;
}

/** 기간별 손익 일별합산 하루치(`inquire-period-profit`, TR `TTTC8708R`의 `output1`). */
export interface KisDailyPnlRecord extends KrTimestamped {
    /** 매매일자(`trad_dt`) */
    tradeDate: string;
    buyAmount: number | undefined;
    sellAmount: number | undefined;
    /** 실현손익(`rlzt_pfls`)과 손익률(`pfls_rt`) */
    realizedPnl: number | undefined;
    pnlRate: number | undefined;
    fee: number | undefined;
    /** 제세금(`tl_tax`) */
    tax: number | undefined;
    /** 대출이자(`loan_int`) */
    loanInterest: number | undefined;
    info: Dict;
}

/** 매도가능수량조회(`inquire-psbl-sell`, TR `TTTC8408R`). */
export interface KisSellableQuantity {
    symbol: string;
    /** 주문가능수량(`ord_psbl_qty`) */
    orderableQuantity: number | undefined;
    /** 잔고수량(`cblc_qty`) */
    balanceQuantity: number | undefined;
    buyQuantity: number | undefined;
    sellQuantity: number | undefined;
    averagePrice: number | undefined;
    purchaseAmount: number | undefined;
    /** 현재가(`now_pric`) */
    price: number | undefined;
    evaluationAmount: number | undefined;
    unrealizedPnl: number | undefined;
    unrealizedPnlRate: number | undefined;
    info: Dict;
}

/** 주식통합증거금 현황(`intgr-margin`, TR `TTTC0869R`). 필드가 100개가 넘어 주문가능금액 위주로 옮기고 나머지는 `info`에 둔다. */
export interface KisIntegratedMargin {
    /** 계좌증거금율(`acmga_rt`) */
    marginRate: number | undefined;
    /** 주식 현금, 대용, 평가 주문가능금액(`stck_cash_ord_psbl_amt`, `stck_sbst_ord_psbl_amt`, `stck_evlu_ord_psbl_amt`) */
    cashOrderable: number | undefined;
    substituteOrderable: number | undefined;
    evaluationOrderable: number | undefined;
    /** 미수금액(`rcvb_amt`) */
    receivable: number | undefined;
    /** 통화별 주문가능금액(`usd_ord_psbl_amt`, `hkd_ord_psbl_amt`, `jpy_ord_psbl_amt`, `cny_ord_psbl_amt`) */
    usdOrderable: number | undefined;
    hkdOrderable: number | undefined;
    jpyOrderable: number | undefined;
    cnyOrderable: number | undefined;
    info: Dict;
}

/** 국내 주식 예약주문 하나(`order-resv-ccnl`, TR `CTSC0004R`). */
export interface KisDomesticReservedOrder extends KrTimestamped {
    /** 예약주문 순번(`rsvn_ord_seq`) */
    sequence: string;
    /** 예약주문 주문일자(`rsvn_ord_ord_dt`)와 접수일자(`rsvn_ord_rcit_dt`), 예약종료일자(`rsvn_end_dt`) */
    orderDate: string | undefined;
    receivedDate: string | undefined;
    endDate: string | undefined;
    symbol: string;
    /** 한글종목단축명(`kor_item_shtn_name`) */
    name: string | undefined;
    /** 매도매수구분(`sll_buy_dvsn_cd`, 01 매도, 02 매수). 그 밖의 값은 `unknown`이다 */
    side: 'buy' | 'sell' | 'unknown';
    /** 주문구분 코드(`ord_dvsn_cd`)와 이름(`ord_dvsn_name`) */
    orderTypeCode: string | undefined;
    orderTypeName: string | undefined;
    /** 주문예약수량(`ord_rsvn_qty`)과 단가(`ord_rsvn_unpr`) */
    quantity: number | undefined;
    price: number | undefined;
    /** 총체결수량(`tot_ccld_qty`)과 금액(`tot_ccld_amt`) */
    filledQuantity: number | undefined;
    filledAmount: number | undefined;
    /** 주문번호(`odno`). 아직 주문으로 나가지 않았으면 비어 있다 */
    orderId: string | undefined;
    /** 처리결과(`prcs_rslt`) */
    result: string | undefined;
    info: Dict;
}

/** 기간별 계좌 권리 하나(`period-rights`, TR `CTRGA011R`). */
export interface KisAccountRight extends KrTimestamped {
    /** 기준일자(`bass_dt`) */
    date: string;
    /** 권리유형코드(`rght_type_cd`) */
    rightTypeCode: string | undefined;
    /** 상품번호(`pdno`), 단축상품번호(`shtn_pdno`), 상품명(`prdt_name`) */
    code: string | undefined;
    shortCode: string | undefined;
    name: string | undefined;
    /** 잔고수량(`cblc_qty`)과 총배정수량(`tot_alct_qty`) */
    balanceQuantity: number | undefined;
    allocatedQuantity: number | undefined;
    /** 최종배정금액(`last_alct_amt`)과 최종단수주대금(`last_ftsk_chgs`) */
    allocatedAmount: number | undefined;
    fractionalShareAmount: number | undefined;
    /** 현금지급일자(`cash_dfrm_dt`), 상장일자(`lstg_dt`), 청약종료일자(`sbsc_end_dt`), 청약단가(`sbsc_unpr`) */
    cashPaymentDate: string | undefined;
    listingDate: string | undefined;
    subscriptionEndDate: string | undefined;
    subscriptionPrice: number | undefined;
    /** 세금금액(`tax_amt`) */
    taxAmount: number | undefined;
    info: Dict;
}

/** 퇴직연금 잔고조회(`pension/inquire-balance`, TR `TTTC2208R`). */
export interface KisPensionBalance {
    positions: Array<{
        symbol: string;
        name: string | undefined;
        /** 잔고구분명(`cblc_dvsn_name`)과 종목구분명(`item_dvsn_name`) */
        balanceTypeName: string | undefined;
        itemTypeName: string | undefined;
        /** 보유수량(`hldg_qty`)과 주문가능수량(`ord_psbl_qty`) */
        quantity: number | undefined;
        orderableQuantity: number | undefined;
        /** 금일매수수량(`thdt_buyqty`)과 금일매도수량(`thdt_sll_qty`) */
        todayBuyQuantity: number | undefined;
        todaySellQuantity: number | undefined;
        /** 매입평균가격(`pchs_avg_pric`) */
        averagePrice: number | undefined;
        purchaseAmount: number | undefined;
        /** 현재가(`prpr`) */
        price: number | undefined;
        evaluationAmount: number | undefined;
        unrealizedPnl: number | undefined;
        /** 평가수익율(`evlu_erng_rt`) */
        unrealizedPnlRate: number | undefined;
        info: Dict;
    }>;
    /** 예수금총금액(`dnca_tot_amt`), 익일정산금액(`nxdy_excc_amt`), 가수도정산금액(`prvs_rcdl_excc_amt`) */
    deposit: number | undefined;
    nextDaySettlement: number | undefined;
    provisionalSettlement: number | undefined;
    /** 금일매수금액(`thdt_buy_amt`), 금일매도금액(`thdt_sll_amt`), 금일제비용금액(`thdt_tlex_amt`) */
    todayBuyAmount: number | undefined;
    todaySellAmount: number | undefined;
    todayCost: number | undefined;
    /** 유가평가금액(`scts_evlu_amt`)과 총평가금액(`tot_evlu_amt`) */
    securitiesEvaluation: number | undefined;
    totalEvaluation: number | undefined;
    info: Dict;
}

/** 퇴직연금 주문 하나(`pension/inquire-daily-ccld`, TR `TTTC2201R`). */
export interface KisPensionOrder {
    /** 주문번호(`odno`), 원주문번호(`orgn_odno`), 주문채번지점번호(`ord_gno_brno`) */
    orderId: string;
    originalOrderId: string | undefined;
    branchNo: string | undefined;
    symbol: string;
    name: string | undefined;
    /** 매도매수구분코드(`sll_buy_dvsn_cd`)를 옮긴 방향. `01` 매도, `02` 매수, 그 밖은 `unknown` */
    side: 'buy' | 'sell' | 'unknown';
    /** 매매구분명(`trad_dvsn_name`) */
    tradeTypeName: string | undefined;
    /** 주문구분코드(`ord_dvsn_cd`)와 주문구분명(`ord_dvsn_name`) */
    orderTypeCode: string | undefined;
    orderTypeName: string | undefined;
    /** 주문단가(`ord_unpr`), 주문수량(`ord_qty`), 총체결수량(`tot_ccld_qty`), 미체결수량(`nccs_qty`) */
    price: number | undefined;
    quantity: number | undefined;
    filledQuantity: number | undefined;
    remainingQuantity: number | undefined;
    /** 매입평균가격(`pchs_avg_pric`) */
    averagePrice: number | undefined;
    /** 주문시각(`ord_tmd`). 응답에 날짜가 없어 문자열로 둔다 */
    orderTime: string | undefined;
    /** 대상고객구분명(`objt_cust_dvsn_name`) */
    customerTypeName: string | undefined;
    info: Dict;
}

/** 퇴직연금 예수금조회(`pension/inquire-deposit`, TR `TTTC0506R`). */
export interface KisPensionDeposit {
    /** 예수금총액(`dnca_tota`) */
    deposit: number | undefined;
    /** 익일정산액(`nxdy_excc_amt`), 익일결제금액(`nxdy_sttl_amt`), 2익일결제금액(`nx2_day_sttl_amt`) */
    nextDaySettlement: number | undefined;
    nextDayPayment: number | undefined;
    secondDayPayment: number | undefined;
    info: Dict;
}

/** 퇴직연금 체결기준잔고(`pension/inquire-present-balance`, TR `TTTC2202R`). */
export interface KisPensionExecutionBalance {
    positions: Array<{
        symbol: string;
        name: string | undefined;
        /** 잔고구분(`cblc_dvsn`)과 잔고구분명(`cblc_dvsn_name`) */
        balanceType: string | undefined;
        balanceTypeName: string | undefined;
        /** 보유수량(`hldg_qty`)과 매도가능수량(`slpsb_qty`) */
        quantity: number | undefined;
        sellableQuantity: number | undefined;
        /** 매입평균가격(`pchs_avg_pric`) */
        averagePrice: number | undefined;
        purchaseAmount: number | undefined;
        /** 현재가(`prpr`) */
        price: number | undefined;
        evaluationAmount: number | undefined;
        unrealizedPnl: number | undefined;
        /** 평가손익율(`evlu_pfls_rt`) */
        unrealizedPnlRate: number | undefined;
        /** 잔고비중(`cblc_weit`) */
        weight: number | undefined;
        info: Dict;
    }>;
    /** 매입금액, 평가금액, 평가손익 합계(`pchs_amt_smtl_amt`, `evlu_amt_smtl_amt`, `evlu_pfls_smtl_amt`) */
    purchaseAmount: number | undefined;
    evaluationAmount: number | undefined;
    unrealizedPnl: number | undefined;
    /** 매매손익합계(`trad_pfls_smtl`), 당일총손익금액(`thdt_tot_pfls_amt`), 수익률(`pftrt`) */
    tradingPnl: number | undefined;
    todayPnl: number | undefined;
    returnRate: number | undefined;
    info: Dict;
}

/** 퇴직연금 매수가능조회(`pension/inquire-psbl-order`, TR `TTTC0503R`). */
export interface KisPensionBuyable {
    /** 주문가능현금(`ord_psbl_cash`)과 재사용가능금액(`ruse_psbl_amt`) */
    orderableCash: number | undefined;
    reusableAmount: number | undefined;
    /** 최대매수금액(`max_buy_amt`)과 최대매수수량(`max_buy_qty`) */
    maxBuyAmount: number | undefined;
    maxBuyQuantity: number | undefined;
    /** 가능수량계산단가(`psbl_qty_calc_unpr`) */
    calculationPrice: number | undefined;
    info: Dict;
}

/** 해외주식 지정가주문 하나(`algo-ordno`, TR `TTTS6058R`). */
export interface KisOverseasAlgoOrder {
    /** 주문번호(`odno`)와 주문채번지점번호(`ord_gno_brno`) */
    orderId: string;
    branchNo: string | undefined;
    /** 상품번호(`pdno`)와 종목명(`item_name`) */
    code: string;
    name: string | undefined;
    /** 매매구분명(`trad_dvsn_name`)과 분할매수속성명(`splt_buy_attr_name`) */
    tradeTypeName: string | undefined;
    splitBuyTypeName: string | undefined;
    /** FT주문수량(`ft_ord_qty`), FT주문단가(`ft_ord_unpr3`), FT체결수량(`ft_ccld_qty`) */
    quantity: number | undefined;
    price: number | undefined;
    filledQuantity: number | undefined;
    info: Dict;
}

/** 해외증거금 통화별 행 하나(`foreign-margin`, TR `TTTC2101R`). */
export interface KisOverseasCurrencyMargin {
    /** 국가명(`natn_name`)과 통화코드(`crcy_cd`) */
    countryName: string | undefined;
    currency: string | undefined;
    /** 외화예수금액(`frcr_dncl_amt1`) */
    deposit: number | undefined;
    /** 미결제매수금액(`ustl_buy_amt`)과 미결제매도금액(`ustl_sll_amt`) */
    unsettledBuyAmount: number | undefined;
    unsettledSellAmount: number | undefined;
    /** 외화미수금액(`frcr_rcvb_amt`)과 외화증거금액(`frcr_mgn_amt`) */
    receivable: number | undefined;
    margin: number | undefined;
    /** 외화일반주문가능금액(`frcr_gnrl_ord_psbl_amt`), 외화주문가능금액(`frcr_ord_psbl_amt1`), 통합주문가능금액(`itgr_ord_psbl_amt`) */
    generalOrderable: number | undefined;
    orderable: number | undefined;
    integratedOrderable: number | undefined;
    /** 기준환율(`bass_exrt`) */
    exchangeRate: number | undefined;
    info: Dict;
}

/** 해외주식 결제기준잔고(`inquire-paymt-stdr-balance`, TR `CTRP6010R`). */
export interface KisOverseasSettlementBalance {
    positions: Array<{
        /** 상품번호(`pdno`)와 상품명(`prdt_name`) */
        code: string;
        name: string | undefined;
        /** 해외거래소코드(`ovrs_excg_cd`), 거래시장명(`tr_mket_name`), 국가한글명(`natn_kor_name`), 매수통화코드(`buy_crcy_cd`) */
        exchangeCode: string | undefined;
        marketName: string | undefined;
        countryName: string | undefined;
        currency: string | undefined;
        /** 잔고수량(`cblc_qty13`)과 주문가능수량(`ord_psbl_qty1`) */
        quantity: number | undefined;
        orderableQuantity: number | undefined;
        /** 평균단가(`avg_unpr3`)와 해외현재가격(`ovrs_now_pric1`) */
        averagePrice: number | undefined;
        price: number | undefined;
        /** 외화매입금액(`frcr_pchs_amt`), 평가손익금액(`evlu_pfls_amt2`), 평가손익율(`evlu_pfls_rt1`) */
        purchaseAmount: number | undefined;
        unrealizedPnl: number | undefined;
        unrealizedPnlRate: number | undefined;
        /** 기준환율(`bass_exrt`) */
        exchangeRate: number | undefined;
        info: Dict;
    }>;
    currencies: Array<{
        /** 통화코드(`crcy_cd`)와 통화코드명(`crcy_cd_name`) */
        currency: string | undefined;
        currencyName: string | undefined;
        /** 외화예수금액(`frcr_dncl_amt_2`)과 외화평가금액(`frcr_evlu_amt2`) */
        deposit: number | undefined;
        evaluationAmount: number | undefined;
        /** 최초고시환율(`frst_bltn_exrt`) */
        exchangeRate: number | undefined;
        info: Dict;
    }>;
    /** 매입금액합계(`pchs_amt_smtl_amt`), 총평가손익금액(`tot_evlu_pfls_amt`), 평가수익율(`evlu_erng_rt1`) */
    purchaseAmount: number | undefined;
    unrealizedPnl: number | undefined;
    unrealizedPnlRate: number | undefined;
    /** 총예수금액(`tot_dncl_amt`), 원화평가금액합계(`wcrc_evlu_amt_smtl`), 총자산금액(`tot_asst_amt2`), 총대출금액(`tot_loan_amt`) */
    totalDeposit: number | undefined;
    evaluationAmount: number | undefined;
    totalAssets: number | undefined;
    loanAmount: number | undefined;
    info: Dict;
}

/** 해외주식 기간손익(`inquire-period-profit`, TR `TTTS3039R`). */
export interface KisOverseasRealizedPnl {
    trades: Array<{
        /** 매매일(`trad_day`) */
        tradeDate: string;
        /** 해외상품번호(`ovrs_pdno`), 종목명(`ovrs_item_name`), 해외거래소코드(`ovrs_excg_cd`) */
        code: string;
        name: string | undefined;
        exchangeCode: string | undefined;
        /** 매도청산수량(`slcl_qty`) */
        quantity: number | undefined;
        /** 매입평균가격(`pchs_avg_pric`)과 외화매입금액(`frcr_pchs_amt1`) */
        averagePurchasePrice: number | undefined;
        purchaseAmount: number | undefined;
        /** 평균매도단가(`avg_sll_unpr`), 외화매도금액합계(`frcr_sll_amt_smtl1`), 주식매도제비용(`stck_sll_tlex`) */
        averageSellPrice: number | undefined;
        sellAmount: number | undefined;
        sellCost: number | undefined;
        /** 해외실현손익금액(`ovrs_rlzt_pfls_amt`)과 수익률(`pftrt`) */
        realizedPnl: number | undefined;
        returnRate: number | undefined;
        /** 환율(`exrt`) */
        exchangeRate: number | undefined;
        info: Dict;
    }>;
    /** 주식매도금액합계(`stck_sll_amt_smtl`), 주식매수금액합계(`stck_buy_amt_smtl`), 합계수수료(`smtl_fee1`), 정산지급금액(`excc_dfrm_amt`) */
    sellAmount: number | undefined;
    buyAmount: number | undefined;
    fee: number | undefined;
    settlementAmount: number | undefined;
    /** 해외실현손익총금액(`ovrs_rlzt_pfls_tot_amt`)과 총수익률(`tot_pftrt`) */
    realizedPnl: number | undefined;
    returnRate: number | undefined;
    info: Dict;
}

/** 해외주식 일별거래내역 하나(`inquire-period-trans`, TR `CTOS4001R`). */
export interface KisOverseasTransaction {
    /** 매매일자(`trad_dt`)와 결제일자(`sttl_dt`) */
    tradeDate: string;
    settlementDate: string | undefined;
    /** 매도매수구분코드(`sll_buy_dvsn_cd`)를 옮긴 방향. `01` 매도, `02` 매수, 그 밖은 `unknown` */
    side: 'buy' | 'sell' | 'unknown';
    /** 상품번호(`pdno`)와 종목명(`ovrs_item_name`) */
    code: string;
    name: string | undefined;
    /** 체결수량(`ccld_qty`)과 해외주식체결단가(`ovrs_stck_ccld_unpr`) */
    quantity: number | undefined;
    price: number | undefined;
    /** 거래외화금액(`tr_frcr_amt2`), 외화정산금액(`frcr_excc_amt_1`), 원화정산금액(`wcrc_excc_amt`) */
    foreignAmount: number | undefined;
    foreignSettlementAmount: number | undefined;
    krwSettlementAmount: number | undefined;
    /** 외화수수료(`frcr_fee1`)와 국내외화수수료(`dmst_frcr_fee1`) */
    foreignFee: number | undefined;
    domesticForeignFee: number | undefined;
    /** 통화코드(`crcy_cd`)와 등록환율(`erlm_exrt`) */
    currency: string | undefined;
    exchangeRate: number | undefined;
    info: Dict;
}

/** 해외주식 매수가능금액조회(`inquire-psamount`, TR `TTTS3007R`). */
export interface KisOverseasBuyable {
    /** 거래통화코드(`tr_crcy_cd`)와 환율(`exrt`) */
    currency: string | undefined;
    exchangeRate: number | undefined;
    /** 주문가능외화금액(`ord_psbl_frcr_amt`), 해외주문가능금액(`ovrs_ord_psbl_amt`), 매도재사용가능금액(`sll_ruse_psbl_amt`) */
    orderableForeignAmount: number | undefined;
    overseasOrderableAmount: number | undefined;
    sellReusableAmount: number | undefined;
    /** 주문가능수량(`ord_psbl_qty`), 최대주문가능수량(`max_ord_psbl_qty`), 해외최대주문가능수량(`ovrs_max_ord_psbl_qty`) */
    orderableQuantity: number | undefined;
    maxOrderableQuantity: number | undefined;
    overseasMaxOrderableQuantity: number | undefined;
    /** 환전이후주문가능금액(`echm_af_ord_psbl_amt`)과 수량(`echm_af_ord_psbl_qty`) */
    afterExchangeOrderableAmount: number | undefined;
    afterExchangeOrderableQuantity: number | undefined;
    info: Dict;
}

/** 해외주식 예약주문 하나(`order-resv-list`, TR `TTTT3039R` 미국, `TTTS3014R` 아시아). */
export interface KisOverseasReservedOrder {
    /** 해외예약주문번호(`ovrs_rsvn_odno`), 주문번호(`odno`), 주문채번지점번호(`ord_gno_brno`) */
    reservationId: string;
    orderId: string | undefined;
    branchNo: string | undefined;
    /** 예약주문접수일자(`rsvn_ord_rcit_dt`)와 주문일자(`ord_dt`) */
    receivedDate: string | undefined;
    orderDate: string | undefined;
    /** 취소여부(`cncl_yn`). `Y`, `N` 밖의 값이면 비운다 */
    cancelled: boolean | undefined;
    /** 매도매수구분코드(`sll_buy_dvsn_cd`)를 옮긴 방향. `01` 매도, `02` 매수, 그 밖은 `unknown` */
    side: 'buy' | 'sell' | 'unknown';
    /** 해외예약주문상태코드(`ovrs_rsvn_ord_stat_cd`)와 상태명(`ovrs_rsvn_ord_stat_cd_name`) */
    statusCode: string | undefined;
    statusName: string | undefined;
    /** 상품번호(`pdno`), 상품명(`prdt_name`), 상품유형코드(`prdt_type_cd`), 해외거래소코드(`ovrs_excg_cd`) */
    code: string;
    name: string | undefined;
    productTypeCode: string | undefined;
    exchangeCode: string | undefined;
    /** FT주문수량(`ft_ord_qty`), FT주문단가(`ft_ord_unpr3`), FT체결수량(`ft_ccld_qty`) */
    quantity: number | undefined;
    price: number | undefined;
    filledQuantity: number | undefined;
    /** 주문접수시각(`ord_rcit_tmd`)과 주문전송시각(`ord_fwdg_tmd`). 시간대가 문서에 없어 문자열로 둔다 */
    receivedTime: string | undefined;
    sentTime: string | undefined;
    /** 미처리사유내용(`nprc_rson_text`) */
    rejectReason: string | undefined;
    info: Dict;
}

/** ETF/ETN 현재가(`etfetn/inquire-price`, TR `FHPST02400000`). 필드가 59개라 주요 값만 옮기고 나머지는 `info`에 둔다. */
export interface KisEtfPrice {
    symbol: string;
    /** 현재가(`stck_prpr`), 전일 대비(`prdy_vrss`), 전일 대비율(`prdy_ctrt`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 시가(`stck_oprc`), 고가(`stck_hgpr`), 저가(`stck_lwpr`), 전일 종가(`stck_prdy_clpr`) */
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    previousClose: number | undefined;
    /** 누적 거래량(`acml_vol`)과 전일 거래량(`prdy_vol`) */
    volume: number | undefined;
    previousVolume: number | undefined;
    /** 상한가(`stck_mxpr`)와 하한가(`stck_llam`) */
    upperLimit: number | undefined;
    lowerLimit: number | undefined;
    /** NAV(`nav`), NAV 전일 대비(`nav_prdy_vrss`), NAV 전일 대비율(`nav_prdy_ctrt`), 전일 최종 NAV(`prdy_last_nav`) */
    nav: number | undefined;
    navChange: number | undefined;
    navChangeRate: number | undefined;
    previousNav: number | undefined;
    /** 괴리율(`dprt`)과 추적 오차율(`trc_errt`) */
    premiumRate: number | undefined;
    trackingErrorRate: number | undefined;
    /** ETF 순자산 총액(`etf_ntas_ttam`), ETF 유통 주수(`etf_crcl_stcn`), 상장 주수(`lstn_stcn`) */
    netAssets: number | undefined;
    circulatingShares: number | undefined;
    listedShares: number | undefined;
    /** ETF CU 단위 증권 수(`etf_cu_unit_scrt_cnt`)와 ETF 구성 종목 수(`etf_cnfg_issu_cnt`) */
    creationUnitShares: number | undefined;
    constituentCount: number | undefined;
    /** ETF 분류 명(`etf_div_name`), ETF 배당 주기(`etf_dvdn_cycl`), 통화 코드(`crcd`), 만기 일자(`mtrt_date`, ETN) */
    categoryName: string | undefined;
    dividendCycle: string | undefined;
    currency: string | undefined;
    maturityDate: string | undefined;
    info: Dict;
}

/** ETF 구성종목시세(`inquire-component-stock-price`, TR `FHKST121600C0`). */
export interface KisEtfConstituents {
    /** ETF 요약(`output1`) */
    etf: {
        /** 현재가(`stck_prpr`), 전일 대비(`prdy_vrss`), 전일 대비율(`prdy_ctrt`) */
        price: number | undefined;
        change: number | undefined;
        percentage: number | undefined;
        /** NAV(`nav`), NAV 전일 대비(`nav_prdy_vrss`), NAV 전일 대비율(`nav_prdy_ctrt`), NAV 전일종가(`prdy_clpr_nav`) */
        nav: number | undefined;
        navChange: number | undefined;
        navChangeRate: number | undefined;
        previousNav: number | undefined;
        /** NAV 시가(`oprc_nav`), 고가(`hprc_nav`), 저가(`lprc_nav`) */
        navOpen: number | undefined;
        navHigh: number | undefined;
        navLow: number | undefined;
        /** ETF 순자산 총액(`etf_ntas_ttam`)과 ETF 구성종목 시가총액(`etf_cnfg_issu_avls`) */
        netAssets: number | undefined;
        constituentsMarketCap: number | undefined;
        /** ETF CU 단위 증권 수(`etf_cu_unit_scrt_cnt`)와 ETF 구성 종목 수(`etf_cnfg_issu_cnt`) */
        creationUnitShares: number | undefined;
        constituentCount: number | undefined;
        info: Dict;
    };
    /** 구성종목 행(`output2`) */
    constituents: Array<{
        /** 단축 종목코드(`stck_shrn_iscd`)와 종목명(`hts_kor_isnm`) */
        symbol: string;
        name: string | undefined;
        /** 현재가(`stck_prpr`), 전일 대비(`prdy_vrss`), 전일 대비율(`prdy_ctrt`) */
        price: number | undefined;
        change: number | undefined;
        percentage: number | undefined;
        /** 누적 거래량(`acml_vol`)과 누적 거래 대금(`acml_tr_pbmn`) */
        volume: number | undefined;
        tradingValue: number | undefined;
        /** HTS 시가총액(`hts_avls`) */
        marketCap: number | undefined;
        /** CU 안의 증권 수(`etf_cu_unit_scrt_cnt`), 구성종목 비중(`etf_cnfg_issu_rlim`), 구성종목 내 평가금액(`etf_vltn_amt`) */
        creationUnitShares: number | undefined;
        weight: number | undefined;
        valuationAmount: number | undefined;
        info: Dict;
    }>;
}

/** NAV 비교추이(종목)(`nav-comparison-trend`, TR `FHPST02440000`). */
export interface KisEtfNavComparison {
    /** 가격 쪽(`output1`) */
    market: {
        price: number | undefined;
        change: number | undefined;
        percentage: number | undefined;
        /** 시가(`stck_oprc`), 고가(`stck_hgpr`), 저가(`stck_lwpr`), 전일 종가(`stck_prdy_clpr`) */
        open: number | undefined;
        high: number | undefined;
        low: number | undefined;
        previousClose: number | undefined;
        /** 누적 거래량(`acml_vol`)과 누적 거래 대금(`acml_tr_pbmn`) */
        volume: number | undefined;
        tradingValue: number | undefined;
        /** 상한가(`stck_mxpr`)와 하한가(`stck_llam`) */
        upperLimit: number | undefined;
        lowerLimit: number | undefined;
        info: Dict;
    };
    /** NAV 쪽(`output2`) */
    nav: {
        nav: number | undefined;
        navChange: number | undefined;
        navChangeRate: number | undefined;
        /** NAV전일종가(`prdy_clpr_nav`), NAV시가(`oprc_nav`), NAV고가(`hprc_nav`), NAV저가(`lprc_nav`) */
        previousNav: number | undefined;
        open: number | undefined;
        high: number | undefined;
        low: number | undefined;
        info: Dict;
    };
}

/** NAV 비교추이의 일별, 분별 행 하나(`nav-comparison-daily-trend`, `nav-comparison-time-trend`). */
export interface KisEtfNavTrendRow extends KrTimestamped {
    /** 영업 일자(`stck_bsop_date`, 일별) 또는 영업 시간(`bsop_hour`, 분별). 분별 행에는 날짜가 없어 문자열로 둔다 */
    date: string | undefined;
    time: string | undefined;
    /** 일별은 종가(`stck_clpr`), 분별은 현재가(`stck_prpr`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 누적 거래량(`acml_vol`)과 체결 거래량(`cntg_vol`) */
    volume: number | undefined;
    tradeVolume: number | undefined;
    /** NAV(`nav`), NAV 전일 대비(`nav_prdy_vrss`), NAV 전일 대비율(`nav_prdy_ctrt`) */
    nav: number | undefined;
    navChange: number | undefined;
    navChangeRate: number | undefined;
    /** NAV 대비 현재가(`nav_vrss_prpr`)와 괴리율(`dprt`) */
    navPriceGap: number | undefined;
    premiumRate: number | undefined;
    info: Dict;
}

/** ELW 현재가 시세(`inquire-elw-price`, TR `FHKEW15010000`). 피벗 값 등 나머지는 `info`에 둔다. */
export interface KisElwPrice {
    /** ELW 단축 종목코드(`elw_shrn_iscd`)와 종목명(`hts_kor_isnm`) */
    code: string;
    name: string | undefined;
    /** 현재가(`elw_prpr`), 전일 대비(`prdy_vrss`), 전일 대비율(`prdy_ctrt`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 시가(`elw_oprc`), 고가(`elw_hgpr`), 저가(`elw_lwpr`), 기준가(`elw_sdpr`) */
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    basePrice: number | undefined;
    /** 누적 거래량(`acml_vol`)과 누적 거래 대금(`acml_tr_pbmn`) */
    volume: number | undefined;
    tradingValue: number | undefined;
    /** 매수호가(`bidp`)와 매도호가(`askp`) */
    bid: number | undefined;
    ask: number | undefined;
    /** 기초자산 코드(`unas_shrn_iscd`), 이름(`unas_isnm`), 현재가(`unas_prpr`), 전일 대비(`unas_prdy_vrss`), 전일 대비율(`unas_prdy_ctrt`) */
    underlyingCode: string | undefined;
    underlyingName: string | undefined;
    underlyingPrice: number | undefined;
    underlyingChange: number | undefined;
    underlyingChangeRate: number | undefined;
    /** 행사가(`acpr`), HTS 이론가(`hts_thpr`), 괴리율(`dprt`), HTS 내재 변동성(`hts_ints_vltl`) */
    strikePrice: number | undefined;
    theoreticalPrice: number | undefined;
    premiumRate: number | undefined;
    impliedVolatility: number | undefined;
    /** ATM구분명(`atm_cls_name`)과 접근도(`apprch_rate`) */
    moneynessName: string | undefined;
    approachRate: number | undefined;
    info: Dict;
}

/** ELW 종목 하나(비교대상종목, 신규상장, 만기). 예제 필드 목록에 있는 값만 채운다. */
export interface KisElwItem {
    /** ELW 단축 종목코드(`elw_shrn_iscd`)와 종목명(`elw_kor_isnm`) */
    code: string;
    name: string | undefined;
    /** 기초자산 코드(`unas_shrn_iscd`), 이름(`unas_isnm`), 현재가(`unas_prpr`) */
    underlyingCode: string | undefined;
    underlyingName: string | undefined;
    underlyingPrice: number | undefined;
    /** ELW 현재가(`elw_prpr`), 행사가(`acpr`), 주식전환비율(`stck_cnvr_rate`), 상장주수(`lstn_stcn`) */
    price: number | undefined;
    strikePrice: number | undefined;
    conversionRatio: number | undefined;
    listedShares: number | undefined;
    /** 상장일자(`stck_lstn_date`)와 최종거래일자(`stck_last_tr_date`) */
    listingDate: string | undefined;
    lastTradeDate: string | undefined;
    /** 조기종료발생기준가격(`elw_ko_barrier`) */
    knockOutBarrier: number | undefined;
    info: Dict;
}

/** ELW 기초자산 하나(`udrl-asset-list`, TR `FHKEW154100C0`). */
export interface KisElwUnderlying {
    /** 기초자산 단축 종목코드(`unas_shrn_iscd`)와 종목명(`unas_isnm`) */
    code: string;
    name: string | undefined;
    /** 기초자산 현재가(`unas_prpr`), 전일 대비(`unas_prdy_vrss`), 전일 대비율(`unas_prdy_ctrt`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    info: Dict;
}

/** 기초자산별 ELW 하나(`udrl-asset-price`, TR `FHKEW154101C0`). */
export interface KisElwByUnderlyingItem {
    /** ELW 단축 종목코드(`elw_shrn_iscd`)와 종목명(`hts_kor_isnm`) */
    code: string;
    name: string | undefined;
    /** 현재가(`elw_prpr`), 전일 대비(`prdy_vrss`), 전일 대비율(`prdy_ctrt`), 누적 거래량(`acml_vol`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    volume: number | undefined;
    /** 행사가(`acpr`), 주식전환비율(`stck_cnvr_rate`), HTS 잔존일수(`hts_rmnn_dynu`) */
    strikePrice: number | undefined;
    conversionRatio: number | undefined;
    remainingDays: number | undefined;
    /** 손익분기주가(`prls_qryr_stpr_prc`), 손익분기비율(`prls_qryr_rate`), 자본지지점(`cfp`), 패리티(`prit`) */
    breakEvenPrice: number | undefined;
    breakEvenRate: number | undefined;
    capitalFulcrumPoint: number | undefined;
    parity: number | undefined;
    /** 레버리지(`lvrg_val`), 기어링(`gear`), 내재가치(`invl_val`), 시간가치(`tmvl_val`), HTS 이론가(`hts_thpr`) */
    leverage: number | undefined;
    gearing: number | undefined;
    intrinsicValue: number | undefined;
    timeValue: number | undefined;
    theoreticalPrice: number | undefined;
    /** HTS 내재 변동성(`hts_ints_vltl`), 델타(`delta_val`), 감마(`gama`), 베가(`vega`), 세타(`theta`) */
    impliedVolatility: number | undefined;
    delta: number | undefined;
    gamma: number | undefined;
    vega: number | undefined;
    theta: number | undefined;
    /** LP 보유량(`lp_hvol`)과 LP 비중(`lp_rlim`) */
    lpHolding: number | undefined;
    lpWeight: number | undefined;
    info: Dict;
}

/** ELW 투자지표추이 행 하나(체결, 일별, 분별). 분별과 체결 행의 시각(`stck_cntg_hour`)은 날짜가 따로 없거나 시간대가 없어 문자열로 둔다. */
export interface KisElwIndicatorRow extends KrTimestamped {
    /** 영업 일자(`stck_bsop_date`)와 체결 시간(`stck_cntg_hour`) */
    date: string | undefined;
    time: string | undefined;
    /** 현재가(`elw_prpr`), 전일 대비(`prdy_vrss`), 전일 대비율(`prdy_ctrt`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 시가(`elw_oprc`), 고가(`elw_hgpr`), 저가(`elw_lwpr`) */
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    /** 누적 거래량(`acml_vol`)과 체결 거래량(`cntg_vol`) */
    volume: number | undefined;
    tradeVolume: number | undefined;
    /** 레버리지(`lvrg_val`), 기어링(`gear`), 시간가치(`tmvl_val`), 내재가치(`invl_val`), 프리미엄(`prmm_val`), 패리티(`prit`), 접근도(`apprch_rate`) */
    leverage: number | undefined;
    gearing: number | undefined;
    timeValue: number | undefined;
    intrinsicValue: number | undefined;
    premium: number | undefined;
    parity: number | undefined;
    approachRate: number | undefined;
    info: Dict;
}

/** ELW 민감도 추이 행 하나(체결, 일별). */
export interface KisElwSensitivityRow extends KrTimestamped {
    /** 영업 일자(`stck_bsop_date`)와 체결 시간(`stck_cntg_hour`) */
    date: string | undefined;
    time: string | undefined;
    /** 현재가(`elw_prpr`), 전일 대비(`prdy_vrss`), 전일 대비율(`prdy_ctrt`), HTS 이론가(`hts_thpr`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    theoreticalPrice: number | undefined;
    /** 델타(`delta_val`), 감마(`gama`), 세타(`theta`), 베가(`vega`), 로우(`rho`) */
    delta: number | undefined;
    gamma: number | undefined;
    theta: number | undefined;
    vega: number | undefined;
    rho: number | undefined;
    info: Dict;
}

/** 응답 블록 하나의 원문(객체이거나 행 배열). */
export type KisResponseBlock = Dict | Dict[] | undefined;

/**
 * 여러 블록으로 오는 응답의 원문(`output1`, `output2`, `output3`). 예제 필드 목록이 블록을 가르지 않고 대조할 출처도 없어,
 * 필드를 정리하지 않고 블록을 그대로 돌려준다.
 */
export interface KisResponseBlocks {
    output1: KisResponseBlock;
    output2: KisResponseBlock;
    output3?: KisResponseBlock;
    output4?: KisResponseBlock;
    /** 블록 이름이 출처마다 달라 `output`도 함께 담는 조회만 채운다 */
    output?: KisResponseBlock;
}

/** 국내옵션전광판_선물 행 하나(`display-board-futures`, TR `FHPIF05030200`). */
export interface KisFuturesBoardItem {
    /** 선물 단축 종목코드(`futs_shrn_iscd`)와 종목명(`hts_kor_isnm`) */
    code: string;
    name: string | undefined;
    /** 현재가(`futs_prpr`), 전일 대비(`futs_prdy_vrss`), 전일 대비율(`futs_prdy_ctrt`), 고가(`futs_hgpr`), 저가(`futs_lwpr`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    high: number | undefined;
    low: number | undefined;
    /** 누적 거래량(`acml_vol`)과 미결제 약정 수량(`hts_otst_stpl_qty`) */
    volume: number | undefined;
    openInterest: number | undefined;
    /** 매수호가(`futs_bidp`), 매도호가(`futs_askp`), 총 매수호가 잔량(`total_bidp_rsqn`), 총 매도호가 잔량(`total_askp_rsqn`) */
    bid: number | undefined;
    ask: number | undefined;
    totalBidSize: number | undefined;
    totalAskSize: number | undefined;
    /** HTS 이론가(`hts_thpr`)와 잔존 일수(`hts_rmnn_dynu`) */
    theoreticalPrice: number | undefined;
    remainingDays: number | undefined;
    /** 예상체결가(`futs_antc_cnpr`), 예상체결대비(`futs_antc_cntg_vrss`), 예상 체결 전일 대비율(`antc_cntg_prdy_ctrt`) */
    expectedPrice: number | undefined;
    expectedChange: number | undefined;
    expectedChangeRate: number | undefined;
    info: Dict;
}

/** 국내옵션 월물 하나(`display-board-option-list`, TR `FHPIO056104C0`). */
export interface KisOptionExpiry {
    /** 만기 년월 코드(`mtrt_yymm_code`)와 만기 년월(`mtrt_yymm`) */
    code: string;
    yearMonth: string | undefined;
    info: Dict;
}

/** 해외선물 또는 해외옵션 현재가(`inquire-price` TR `HHDFC55010000`, `opt-price` TR `HHDFO55010000`). 두 응답의 필드는 전일종가 하나만 다르다. */
export interface KisOverseasDerivativeQuote {
    /** 거래소코드(`exch_cd`)와 거래통화(`crc_cd`) */
    exchangeCode: string | undefined;
    currency: string | undefined;
    /** 현재가(`last_price`), 시가(`open_price`), 고가(`high_price`), 저가(`low_price`), 전일종가(`prev_price`, 선물만), 정산가(`sttl_price`) */
    price: number | undefined;
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    previousClose: number | undefined;
    settlementPrice: number | undefined;
    /** 전일대비가격(`prev_diff_price`), 전일대비율(`prev_diff_rate`), 전일대비구분(`prev_diff_flag`) */
    change: number | undefined;
    percentage: number | undefined;
    changeFlag: string | undefined;
    /** 누적거래수량(`vol`)과 체결량(`last_qntt`) */
    volume: number | undefined;
    lastQuantity: number | undefined;
    /** 매수1호가(`bid_price`)와 수량(`bid_qntt`), 매도1호가(`ask_price`)와 수량(`ask_qntt`), 총매수잔량(`tot_bid_qntt`), 총매도잔량(`tot_ask_qntt`) */
    bid: number | undefined;
    bidSize: number | undefined;
    ask: number | undefined;
    askSize: number | undefined;
    totalBidSize: number | undefined;
    totalAskSize: number | undefined;
    /** 증거금(`trst_mgn`)과 틱사이즈(`tick_size`) */
    margin: number | undefined;
    tickSize: number | undefined;
    /** 상장일(`trd_fr_date`), 만기일(`expr_date`), 최종거래일(`trd_to_date`), 잔존일수(`remn_cnt`), 영업일자(`sbsnsdate`) */
    listingDate: string | undefined;
    expiryDate: string | undefined;
    lastTradeDate: string | undefined;
    remainingDays: number | undefined;
    businessDate: string | undefined;
    info: Dict;
}

/**
 * 해외선물 또는 해외옵션 계약 정보(`stock-detail`, `opt-detail`, `search-contract-detail`, `search-opt-detail`). 응답에 종목코드가 없어 넣지 않는다.
 * 장 시각은 시간대가 문서에 없어 문자열로 둔다.
 */
export interface KisOverseasDerivativeContract {
    /** 거래소코드(`exch_cd`), 품목종류(`clas_cd`), 거래통화(`crc_cd`) */
    exchangeCode: string | undefined;
    classCode: string | undefined;
    currency: string | undefined;
    /** 정산가(`sttl_price`), 정산일(`sttl_date`), 전일종가(`prev_price`, 선물 종목상세만) */
    settlementPrice: number | undefined;
    settlementDate: string | undefined;
    previousClose: number | undefined;
    /** 증거금(`trst_mgn`), 틱사이즈(`tick_sz`), 틱가치(`tick_val`), 계약크기(`ctrt_size`), 가격표시진법(`disp_digit`) */
    margin: number | undefined;
    tickSize: number | undefined;
    tickValue: number | undefined;
    contractSize: number | undefined;
    priceDisplayDigit: string | undefined;
    /** 장개시일자(`mrkt_open_date`)와 시각(`mrkt_open_time`), 장마감일자(`mrkt_close_date`)와 시각(`mrkt_close_time`) */
    marketOpenDate: string | undefined;
    marketOpenTime: string | undefined;
    marketCloseDate: string | undefined;
    marketCloseTime: string | undefined;
    /** 상장일(`trd_fr_date`), 만기일(`expr_date`), 최종거래일(`trd_to_date`), 최초식별일(`frst_noti_date`), 잔존일수(`remn_cnt`) */
    listingDate: string | undefined;
    expiryDate: string | undefined;
    lastTradeDate: string | undefined;
    firstNoticeDate: string | undefined;
    remainingDays: number | undefined;
    /** 매매여부(`stat_tp`)와 최종결제구분(`stl_tp`) */
    tradeStatus: string | undefined;
    settlementType: string | undefined;
    info: Dict;
}

/** 해외선물옵션 장운영시간 행 하나(`market-time`, TR `OTFM2229R`). 시각은 시간대가 문서에 없어 문자열로 둔다. */
export interface KisOverseasDerivativeMarketHours {
    /** FM상품군(`fm_pdgr_cd`, `fm_pdgr_name`), FM거래소(`fm_excg_cd`, `fm_excg_name`), FM클래스(`fm_clas_cd`, `fm_clas_name`), 선물옵션구분명(`fuop_dvsn_name`) */
    productGroupCode: string | undefined;
    productGroupName: string | undefined;
    exchangeCode: string | undefined;
    exchangeName: string | undefined;
    classCode: string | undefined;
    className: string | undefined;
    typeName: string | undefined;
    /** 오전장(`am_mkmn_strt_tmd`~`am_mkmn_end_tmd`), 오후장(`pm_mkmn_*`), 익일(`mkmn_nxdy_*`), 기본시장(`base_mket_*`) 운영 시각 */
    amStart: string | undefined;
    amEnd: string | undefined;
    pmStart: string | undefined;
    pmEnd: string | undefined;
    nextDayStart: string | undefined;
    nextDayEnd: string | undefined;
    baseStart: string | undefined;
    baseEnd: string | undefined;
    info: Dict;
}

/** 장내채권 현재가(`domestic-bond/inquire-price`, TR `FHKBJ773400C0`). */
export interface KisBondPrice {
    /** 표준종목코드(`stnd_iscd`)와 종목명(`hts_kor_isnm`) */
    code: string;
    name: string | undefined;
    /** 현재가(`bond_prpr`), 전일대비(`bond_prdy_vrss`), 전일대비율(`prdy_ctrt`), 전일종가(`bond_prdy_clpr`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    previousClose: number | undefined;
    /** 시가(`bond_oprc`), 고가(`bond_hgpr`), 저가(`bond_lwpr`), 상한가(`bond_mxpr`), 하한가(`bond_llam`), 누적거래량(`acml_vol`) */
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    upperLimit: number | undefined;
    lowerLimit: number | undefined;
    volume: number | undefined;
    /** 수익비율(`ernn_rate`), 시가 수익률(`oprc_ert`), 최고가 수익률(`hgpr_ert`), 최저가 수익률(`lwpr_ert`) */
    yieldRate: number | undefined;
    openYield: number | undefined;
    highYield: number | undefined;
    lowYield: number | undefined;
    info: Dict;
}

/** 장내채권 호가 한 단계. 가격(`bond_askp1` 등), 잔량(`askp_rsqn1` 등), 수익 비율(`seln_ernn_rate1` 등)이다. */
export interface KisBondOrderBookLevel {
    price: number | undefined;
    size: number | undefined;
    yieldRate: number | undefined;
}

/** 장내채권 호가(`domestic-bond/inquire-asking-price`, TR `FHKBJ773401C0`). 매도, 매수 다섯 단계다. */
export interface KisBondOrderBook {
    /** 호가 접수 시간(`aspr_acpt_hour`). 날짜가 없어 문자열로 둔다 */
    time: string | undefined;
    asks: KisBondOrderBookLevel[];
    bids: KisBondOrderBookLevel[];
    /** 총 매도호가 잔량(`total_askp_rsqn`), 총 매수호가 잔량(`total_bidp_rsqn`), 순매수 호가 잔량(`ntby_aspr_rsqn`) */
    totalAskSize: number | undefined;
    totalBidSize: number | undefined;
    netBidSize: number | undefined;
    info: Dict;
}

/** 장내채권 체결 행 하나(`domestic-bond/inquire-ccnl`, TR `FHKBJ773403C0`). */
export interface KisBondTrade {
    /** 체결 시간(`stck_cntg_hour`). 날짜가 없어 문자열로 둔다 */
    time: string | undefined;
    /** 현재가(`bond_prpr`), 전일 대비(`bond_prdy_vrss`), 전일 대비율(`prdy_ctrt`), 체결 거래량(`cntg_vol`), 누적 거래량(`acml_vol`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    volume: number | undefined;
    cumulativeVolume: number | undefined;
    info: Dict;
}

/** 장내채권 일별 행 하나(`inquire-daily-price` TR `FHKBJ773404C0`, `inquire-daily-itemchartprice` TR `FHKBJ773701C0`). */
export interface KisBondDailyRow extends KrTimestamped {
    /** 영업일자(`stck_bsop_date`) */
    date: string;
    /** 시가(`bond_oprc`), 고가(`bond_hgpr`), 저가(`bond_lwpr`), 현재가(`bond_prpr`) */
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    close: number | undefined;
    /** 전일대비(`bond_prdy_vrss`)와 전일대비율(`prdy_ctrt`). 기간별시세 응답에는 없다 */
    change: number | undefined;
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    info: Dict;
}

/** 장내채권 발행정보(`issue-info`, TR `CTPF1101R`). 필드가 90개가 넘어 주요 값만 옮긴다. */
export interface KisBondIssueInfo {
    /** 상품번호(`pdno`), 상품명(`prdt_name`), 상품영문명(`prdt_eng_name`), 채권분류한글명(`bond_clsf_kor_name`), 발행기관명(`issu_istt_name`) */
    code: string;
    name: string | undefined;
    englishName: string | undefined;
    classificationName: string | undefined;
    issuerName: string | undefined;
    /** 액면가(`papr`), 발행금액(`issu_amt`), 상장잔액(`lstg_rmnd`) */
    faceValue: number | undefined;
    issueAmount: number | undefined;
    listedBalance: number | undefined;
    /** 표면이율(`srfc_inrt`), 만기상환율(`expd_rdpt_rt`), 만기보장수익율(`expd_asrc_erng_rt`), 이자지급개월수(`int_dfrm_mcnt`) */
    couponRate: number | undefined;
    maturityRedemptionRate: number | undefined;
    guaranteedYield: number | undefined;
    interestIntervalMonths: number | undefined;
    /** 발행일자(`issu_dt`), 상장일자(`lstg_dt`), 만기일자(`expd_dt`), 상환일자(`rdpt_dt`), 직전(`rgbf_int_dfrm_dt`)과 차기(`nxtm_int_dfrm_dt`) 이자지급일자 */
    issueDate: string | undefined;
    listingDate: string | undefined;
    maturityDate: string | undefined;
    redemptionDate: string | undefined;
    previousInterestDate: string | undefined;
    nextInterestDate: string | undefined;
    /** 네 평가사의 신용등급내용(`kis_crdt_grad_text`, `kbp_crdt_grad_text`, `nice_crdt_grad_text`, `fnp_crdt_grad_text`) */
    creditRatings: { kis: string | undefined; kbp: string | undefined; nice: string | undefined; fnp: string | undefined };
    /** 투자유의상품여부(`ivst_heed_prdt_yn`). `Y`, `N` 밖의 값이면 비운다 */
    investmentCaution: boolean | undefined;
    info: Dict;
}

/** 장내채권 기본조회(`search-bond-info`, TR `CTPF1114R`). 필드가 90개가 넘어 주요 값만 옮긴다. */
export interface KisBondInfo {
    /** 상품번호(`pdno`), 예탁결제원 채권종목명(`ksd_bond_item_name`)과 영문명(`ksd_bond_item_eng_name`), 채권분류한글명(`bond_clsf_kor_name`) */
    code: string;
    name: string | undefined;
    englishName: string | undefined;
    classificationName: string | undefined;
    /** 통화코드(`iso_crcy_cd`)와 예탁결제원 총발행금액(`ksd_tot_issu_amt`) */
    currency: string | undefined;
    totalIssueAmount: number | undefined;
    /** 표면이율(`ksd_rcvg_bond_srfc_inrt`), 할인율(`ksd_rcvg_bond_dsct_rt`), 채권만기상환율(`bond_expd_rdpt_rt`), 채권만기보장수익율(`bond_expd_asrc_erng_rt`) */
    couponRate: number | undefined;
    discountRate: number | undefined;
    maturityRedemptionRate: number | undefined;
    guaranteedYield: number | undefined;
    /** 발행일자(`issu_dt`), 상환일자(`rdpt_dt`), 상장일자(`lstg_dt`), 상장폐지일자(`lstg_abol_dt`), 직전과 차기 이자지급일자 */
    issueDate: string | undefined;
    redemptionDate: string | undefined;
    listingDate: string | undefined;
    delistingDate: string | undefined;
    previousInterestDate: string | undefined;
    nextInterestDate: string | undefined;
    /** 부도발생여부(`dshn_occr_yn`). `Y`, `N` 밖의 값이면 비운다 */
    defaulted: boolean | undefined;
    info: Dict;
}

/**
 * 확장 주문 API 의 접수 결과. 체결은 알 수 없다(접수만 확인한다). 주문번호 필드는 API 마다 다르다(주문번호 `ODNO`, 예약주문 순번
 * `RSVN_ORD_SEQ`, 해외예약주문번호 `OVRS_RSVN_ODNO`). 나머지는 `info`에 원문으로 둔다.
 */
export interface KisOrderAck extends KrTimestamped {
    orderId: string | undefined;
    /** 주문일자(`ORD_DT`, 해외선물옵션)나 예약주문접수일자(`RSVN_ORD_RCIT_DT`, 해외 예약주문) */
    orderDate: string | undefined;
    /** 주문시각(`ORD_TMD`). 날짜가 없어 문자열로 둔다 */
    orderTime: string | undefined;
    info: Dict;
}

/** 선물옵션 총자산현황(`inquire-deposit`, TR `CTRP6550R`). 필드가 30여 개라 주요 금액만 옮긴다. */
export interface KisDerivativeDeposit {
    /** 예수금총액(`dnca_tota`), 주문가능현금(`ord_psbl_cash`), 주문가능총액(`ord_psbl_tota`), 인출가능총금액(`wdrw_psbl_tot_amt`) */
    deposit: number | undefined;
    orderableCash: number | undefined;
    orderableTotal: number | undefined;
    withdrawable: number | undefined;
    /** 위탁증거금현금(`brkg_mgna_cash`), 위탁증거금대용(`brkg_mgna_sbst`), 추가증거금총액(`add_mgna_tota`), 유지비율(`mtnc_rt`) */
    marginCash: number | undefined;
    marginSubstitute: number | undefined;
    additionalMargin: number | undefined;
    maintenanceRate: number | undefined;
    /** 매매손익합계(`trad_pfls_smtl`), 평가손익합계(`evlu_pfls_smtl`), 위탁수수료(`brkg_fee`), 미수금(`rcva`) */
    tradingPnl: number | undefined;
    evaluationPnl: number | undefined;
    fee: number | undefined;
    receivable: number | undefined;
    /** 익일예수금(`nxdy_dnca`)과 추정예탁자산금액(`prsm_dpast_amt`) */
    nextDayDeposit: number | undefined;
    estimatedAssets: number | undefined;
    info: Dict;
}

/** 선물옵션 주문가능(`inquire-psbl-order` TR `TTTO5105R`, 야간 `inquire-psbl-ngt-order` TR `STTN5105R`). */
export interface KisDerivativeOrderable {
    /** 주문가능수량(`ord_psbl_qty`), 총가능수량(`tot_psbl_qty`), 청산가능수량(주간 `lqd_psbl_qty1`, 야간 `lqd_psbl_qty`) */
    orderableQuantity: number | undefined;
    totalQuantity: number | undefined;
    liquidatableQuantity: number | undefined;
    /** 최대주문가능수량(`max_ord_psbl_qty`, 야간만) */
    maxQuantity: number | undefined;
    /** 기준지수(`bass_idx`) */
    baseIndex: number | undefined;
    info: Dict;
}

/** 장내채권 잔고 행 하나(`domestic-bond/inquire-balance`, TR `CTSC8407R`). */
export interface KisBondHolding {
    /** 상품번호(`pdno`), 매수일자(`buy_dt`), 매수일련번호(`buy_sqno`), 만기일(`exdt`) */
    code: string;
    buyDate: string | undefined;
    buySequence: string | undefined;
    maturityDate: string | undefined;
    /** 잔고수량(`cblc_qty`), 주문가능수량(`ord_psbl_qty`), 종합과세수량(`agrx_qty`), 분리과세수량(`sprx_qty`) */
    quantity: number | undefined;
    orderableQuantity: number | undefined;
    generalTaxQuantity: number | undefined;
    separateTaxQuantity: number | undefined;
    /** 매수단가(`buy_unpr`), 매수금액(`buy_amt`), 매수수익율(`buy_erng_rt`) */
    buyPrice: number | undefined;
    buyAmount: number | undefined;
    buyYield: number | undefined;
    info: Dict;
}

/** 장내채권 매수가능조회(`domestic-bond/inquire-psbl-order`, TR `TTTC8910R`). */
export interface KisBondBuyable {
    /** 주문가능현금(`ord_psbl_cash`), 주문가능대용(`ord_psbl_sbst`), 재사용가능금액(`ruse_psbl_amt`), CMA평가금액(`cma_evlu_amt`) */
    orderableCash: number | undefined;
    orderableSubstitute: number | undefined;
    reusableAmount: number | undefined;
    cmaEvaluation: number | undefined;
    /** 채권주문단가2(`bond_ord_unpr2`), 매수가능금액(`buy_psbl_amt`), 매수가능수량(`buy_psbl_qty`) */
    price: number | undefined;
    buyableAmount: number | undefined;
    buyableQuantity: number | undefined;
    info: Dict;
}

/** 채권 정정취소가능주문 행 하나(`inquire-psbl-rvsecncl`, TR `CTSC8035R`). */
export interface KisBondModifiableOrder {
    /** 주문번호(`odno`), 원주문번호(`orgn_odno`), 상품번호(`pdno`) */
    orderId: string;
    originalOrderId: string | undefined;
    code: string | undefined;
    /** 매도매수구분코드(`sll_buy_dvsn_cd`)를 옮긴 방향. `01` 매도, `02` 매수, 그 밖은 `unknown` */
    side: 'buy' | 'sell' | 'unknown';
    /** 주문구분코드(`ord_dvsn_cd`)와 정정취소구분명(`rvse_cncl_dvsn_name`) */
    orderTypeCode: string | undefined;
    modifyTypeName: string | undefined;
    /** 주문수량(`ord_qty`), 채권주문단가(`bond_ord_unpr`), 총체결수량(`tot_ccld_qty`), 총체결금액(`tot_ccld_amt`), 주문가능수량(`ord_psbl_qty`) */
    quantity: number | undefined;
    price: number | undefined;
    filledQuantity: number | undefined;
    filledAmount: number | undefined;
    modifiableQuantity: number | undefined;
    /** 주문시각(`ord_tmd`) */
    orderTime: string | undefined;
    info: Dict;
}

/** 해외선물옵션 주문 행 하나(당일 `inquire-ccld` TR `OTFM3116R`, 일별 `inquire-daily-order` TR `OTFM3120R`). 일시는 시간대가 문서에 없어 문자열로 둔다. */
export interface KisOverseasDerivativeOrder {
    /** 주문일자(`ord_dt`), 주문번호(`odno`), 원주문일자(`orgn_ord_dt`), 원주문번호(`orgn_odno`) */
    orderDate: string | undefined;
    orderId: string;
    originalOrderDate: string | undefined;
    originalOrderId: string | undefined;
    /** 해외선물FX상품번호(`ovrs_futr_fx_pdno`) */
    code: string | undefined;
    /** 매도매수구분코드(`sll_buy_dvsn_cd`)를 옮긴 방향 */
    side: 'buy' | 'sell' | 'unknown';
    /** FM주문수량(`fm_ord_qty`), FM주문가격(`fm_ord_pric`), FMSTOP주문가격(`fm_stop_ord_pric`) */
    quantity: number | undefined;
    price: number | undefined;
    stopPrice: number | undefined;
    /** FM체결수량(`fm_ccld_qty`), FM체결가격(`fm_ccld_pric`), FM주문잔여수량(`fm_ord_rmn_qty`) */
    filledQuantity: number | undefined;
    filledPrice: number | undefined;
    remainingQuantity: number | undefined;
    /** 체결조건코드(`ccld_cndt_cd`)와 체결상세일시(`ccld_dtl_dtime`) */
    fillConditionCode: string | undefined;
    filledAt: string | undefined;
    info: Dict;
}

/** 해외선물옵션 예수금현황(`inquire-deposit`, TR `OTFM1411R`). */
export interface KisOverseasDerivativeDeposit {
    /** 통화코드(`crcy_cd`) */
    currency: string | undefined;
    /** FM예수금잔액(`fm_dnca_rmnd`), FM익일예수금액(`fm_nxdy_dncl_amt`), FM총자산평가금액(`fm_tot_asst_evlu_amt`) */
    deposit: number | undefined;
    nextDayDeposit: number | undefined;
    totalAssets: number | undefined;
    /** FM청산손익금액(`fm_lqd_pfls_amt`), FM선물옵션평가손익금액(`fm_fuop_evlu_pfls_amt`), FM수수료(`fm_fee`), FM미수금액(`fm_rcvb_amt`) */
    realizedPnl: number | undefined;
    evaluationPnl: number | undefined;
    fee: number | undefined;
    receivable: number | undefined;
    /** FM위탁증거금액(`fm_brkg_mgn_amt`), FM유지증거금액(`fm_mntn_mgn_amt`), FM추가증거금액(`fm_add_mgn_amt`), FM위험율(`fm_risk_rt`) */
    margin: number | undefined;
    maintenanceMargin: number | undefined;
    additionalMargin: number | undefined;
    riskRate: number | undefined;
    /** FM주문가능금액(`fm_ord_psbl_amt`)과 FM출금가능금액(`fm_drwg_psbl_amt`) */
    orderable: number | undefined;
    withdrawable: number | undefined;
    info: Dict;
}

/** 해외선물옵션 기간계좌거래내역 행 하나(`inquire-period-trans`, TR `OTFM3114R`). */
export interface KisOverseasDerivativeTransaction {
    /** 기준일자(`bass_dt`), 통화코드(`crcy_cd`), FM원장출납순번(`fm_ldgr_inog_seq`) */
    date: string | undefined;
    currency: string | undefined;
    sequence: string | undefined;
    /** FM입출금액(`fm_iofw_amt`), FM수수료(`fm_fee`), FM세금금액(`fm_tax_amt`), FM결제금액(`fm_sttl_amt`) */
    amount: number | undefined;
    fee: number | undefined;
    tax: number | undefined;
    settlementAmount: number | undefined;
    /** FM이전예수금액(`fm_bf_dncl_amt`)과 FM예수금액(`fm_dncl_amt`) */
    depositBefore: number | undefined;
    depositAfter: number | undefined;
    /** 비고내용(`rmks_text`) */
    remarks: string | undefined;
    info: Dict;
}

/** 해외선물옵션 주문가능조회(`inquire-psamount`, TR `OTFM3304R`). */
export interface KisOverseasDerivativeOrderable {
    /** 통화코드(`crcy_cd`) */
    currency: string | undefined;
    /** FM미결제수량(`fm_ustl_qty`), FM청산가능수량(`fm_lqd_psbl_qty`), FM신규주문가능수량(`fm_new_ord_psbl_qty`) */
    openQuantity: number | undefined;
    liquidatableQuantity: number | undefined;
    newOrderableQuantity: number | undefined;
    /** FM총주문가능수량(`fm_tot_ord_psbl_qty`)과 FM시장가총주문가능수량(`fm_mkpr_tot_ord_psbl_qty`) */
    totalOrderableQuantity: number | undefined;
    marketTotalOrderableQuantity: number | undefined;
    info: Dict;
}

/** 해외선물옵션 미결제내역 행 하나(`inquire-unpd`, TR `OTFM1412R`). */
export interface KisOverseasDerivativePosition {
    /** 해외선물FX상품번호(`ovrs_futr_fx_pdno`), 상품유형코드(`prdt_type_cd`), 통화코드(`crcy_cd`), 선물옵션구분(`fuop_dvsn`) */
    code: string | undefined;
    productTypeCode: string | undefined;
    currency: string | undefined;
    typeCode: string | undefined;
    /** 매도매수구분코드(`sll_buy_dvsn_cd`)를 옮긴 방향 */
    side: 'buy' | 'sell' | 'unknown';
    /** FM미결제수량(`fm_ustl_qty`), FM청산가능수량(`fm_lqd_psbl_qty`) */
    quantity: number | undefined;
    liquidatableQuantity: number | undefined;
    /** FM체결평균가격(`fm_ccld_avg_pric`), FM현재가격(`fm_now_pric`), FM평가손익금액(`fm_evlu_pfls_amt`) */
    averagePrice: number | undefined;
    price: number | undefined;
    unrealizedPnl: number | undefined;
    /** FM옵션평가금액(`fm_opt_evlu_amt`)과 FM옵션평가손익금액(`fm_otp_evlu_pfls_amt`) */
    optionValue: number | undefined;
    optionPnl: number | undefined;
    info: Dict;
}

/** 해외선물옵션 증거금상세(`margin-detail`, TR `OTFM3115R`). 필드가 60여 개라 주요 금액만 옮긴다. */
export interface KisOverseasDerivativeMargin {
    /** 통화코드(`crcy_cd`) */
    currency: string | undefined;
    /** FM주문가능금액(`fm_ord_psbl_amt`), FM위탁증거금액(`fm_brkg_mgn_amt`), FM유지증거금액(`fm_mntn_mgn_amt`), FM추가증거금액(`fm_add_mgn_amt`) */
    orderable: number | undefined;
    margin: number | undefined;
    maintenanceMargin: number | undefined;
    additionalMargin: number | undefined;
    /** FM미결제증거금액(`fm_ustl_mgn_amt`)과 FM주문증거금액(`fm_ord_mgn_amt`) */
    openPositionMargin: number | undefined;
    orderMargin: number | undefined;
    info: Dict;
}

/** ELW 변동성추이 행 하나(체결, 일별, 분별). */
export interface KisElwVolatilityRow extends KrTimestamped {
    /** 영업 일자(`stck_bsop_date`)와 체결 시간(`stck_cntg_hour`) */
    date: string | undefined;
    time: string | undefined;
    /** 현재가(체결과 일별은 `elw_prpr`, 분별은 `stck_prpr`), 전일 대비(`prdy_vrss`), 전일 대비율(`prdy_ctrt`) */
    price: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    /** 시가(`elw_oprc`), 고가(`elw_hgpr`), 저가(`elw_lwpr`), 누적 거래량(`acml_vol`) */
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    volume: number | undefined;
    /** 매수호가(`bidp`)와 매도호가(`askp`). 체결 행에만 있다 */
    bid: number | undefined;
    ask: number | undefined;
    /** HTS 내재 변동성(`hts_ints_vltl`)과 역사적 변동성(`hist_vltl`, 분별) */
    impliedVolatility: number | undefined;
    historicalVolatility: number | undefined;
    /** 10, 20, 30, 60, 90일 역사적 변동성(`d10_hist_vltl` 등, 일별) */
    historicalVolatility10d: number | undefined;
    historicalVolatility20d: number | undefined;
    historicalVolatility30d: number | undefined;
    historicalVolatility60d: number | undefined;
    historicalVolatility90d: number | undefined;
    info: Dict;
}

/** HTS 관심종목 그룹 하나(`intstock-grouplist`, TR `HHKCM113004C7`). */
export interface KisWatchlistGroup extends KrTimestamped {
    /** 관심 그룹 코드(`inter_grp_code`). `fetchWatchlist`에 넘긴다 */
    groupCode: string;
    /** 관심 그룹명(`inter_grp_name`) */
    groupName: string | undefined;
    /** 요청 개수(`ask_cnt`) */
    count: number | undefined;
    /** 데이터 순위(`data_rank`) */
    rank: number | undefined;
    /** 일자(`date`) */
    date: string | undefined;
    /** 전송 시간(`trnm_hour`) */
    time: string | undefined;
    info: Dict;
}

/**
 * HTS 관심종목 그룹의 종목 하나(`intstock-stocklist-by-group`, TR `HHKCM113004C6`). 관심종목에는 해외 종목도 들어갈 수 있고 시장 구분 코드의 뜻을
 * 확인하지 못해 통합 심볼을 만들지 않는다. 종목코드와 시장·거래소 코드를 원문 그대로 둔다.
 */
export interface KisWatchlistItem {
    /** 종목코드(`jong_code`) */
    code: string;
    /** HTS 한글 종목명(`hts_kor_isnm`) */
    name: string | undefined;
    /** 시장 구분 코드(`fid_mrkt_cls_code`) */
    marketCode: string | undefined;
    /** 거래소코드(`exch_code`) */
    exchangeCode: string | undefined;
    /** 메모(`memo`) */
    memo: string | undefined;
    /** 색상 코드(`color_code`) */
    colorCode: string | undefined;
    /** 기준일 순매수 수량(`fxdt_ntby_qty`) */
    baseNetBuyVolume: number | undefined;
    /** 체결단가(`cntg_unpr`) */
    tradePrice: number | undefined;
    /** 체결 구분 코드(`cntg_cls_code`) */
    tradeTypeCode: string | undefined;
    /** 데이터 순위(`data_rank`) */
    rank: number | undefined;
    info: Dict;
}

/** HTS 조건검색 조건 하나(`psearch-title`, TR `HHKST03900300`). */
export interface KisScreener {
    /** 조건키값(`seq`). `fetchScreenerResult`에 넘긴다 */
    seq: string;
    /** 조건명(`condition_nm`) */
    name: string | undefined;
    /** 그룹명(`grp_nm`) */
    groupName: string | undefined;
    info: Dict;
}

/** HTS 조건검색 결과 종목 하나(`psearch-result`, TR `HHKST03900400`). 국내주식 조건검색이라 통합 심볼(`005930/KRW`)을 만든다. */
export interface KisScreenerItem {
    symbol: string;
    /** 종목명(`name`) */
    name: string | undefined;
    /** 현재가(`price`) */
    price: number | undefined;
    /** 전일대비(`change`) */
    change: number | undefined;
    /** 등락율(`chgrate`) */
    percentage: number | undefined;
    /** 거래량(`acml_vol`) */
    volume: number | undefined;
    /** 거래대금(`trade_amt`) */
    amount: number | undefined;
    /** 체결강도(`cttr`) */
    strength: number | undefined;
    open: number | undefined;
    high: number | undefined;
    low: number | undefined;
    /** 52주 최고가(`high52`) */
    high52Week: number | undefined;
    /** 52주 최저가(`low52`) */
    low52Week: number | undefined;
    /** 예상체결가(`expprice`) */
    expectedPrice: number | undefined;
    /** 기준가(`recprice`) */
    basePrice: number | undefined;
    /** 상한가(`uplmtprice`) */
    upperLimitPrice: number | undefined;
    /** 하한가(`dnlmtprice`) */
    lowerLimitPrice: number | undefined;
    /** 시가총액(`stotprice`) */
    marketCap: number | undefined;
    info: Dict;
}

/**
 * KIS 가 공식으로 제공하는 순위 분석 API는 32종이 넘는다(등락률·거래량·시가총액·신용잔고 등 각각 별도 엔드포인트). 여기 없는 종류는
 * `fetchRankings`가 `NotSupported`를 던진다.
 */
export type KisRankingType =
    | 'FLUCTUATION'
    | 'VOLUME'
    | 'AFTER_HOUR_BALANCE'
    | 'BULK_TRANS'
    | 'DISPARITY'
    | 'EXPECTED_CHANGE'
    | 'MARKET_CAP'
    | 'NEAR_NEW_HIGH'
    | 'NEAR_NEW_LOW'
    | 'PREFERRED_DISPARITY'
    | 'QUOTE_BALANCE'
    | 'TOP_INTEREST'
    | 'TRADED_BY_COMPANY'
    | 'VOLUME_POWER'
    | 'CREDIT_BALANCE'
    | 'DIVIDEND_RATE'
    | 'FINANCE_RATIO'
    | 'HTS_TOP_VIEW'
    | 'MARKET_VALUE'
    | 'OVERTIME_EXPECTED_CHANGE'
    | 'OVERTIME_CHANGE'
    | 'OVERTIME_VOLUME'
    | 'PROFIT_ASSET'
    | 'SHORT_SALE'
    | 'CLOSING_EXPECTED'
    | 'FOREIGN_INSTITUTION_ESTIMATE'
    | 'FOREIGN_BROKER_ESTIMATE'
    | 'PRICE_LIMIT'
    | 'OVERSEAS_MARKET_CAP'
    | 'OVERSEAS_NEW_HIGH'
    | 'OVERSEAS_NEW_LOW'
    | 'OVERSEAS_PRICE_SURGE'
    | 'OVERSEAS_PRICE_PLUNGE'
    | 'OVERSEAS_GAINERS'
    | 'OVERSEAS_LOSERS'
    | 'OVERSEAS_VOLUME'
    | 'OVERSEAS_TRADE_AMOUNT'
    | 'OVERSEAS_TRADE_GROWTH'
    | 'OVERSEAS_TURNOVER'
    | 'OVERSEAS_VOLUME_POWER'
    | 'OVERSEAS_VOLUME_SURGE'
    | 'ELW_UPDOWN_RATE'
    | 'ELW_VOLUME'
    | 'ELW_INDICATOR'
    | 'ELW_SENSITIVITY'
    | 'ELW_QUICK_CHANGE';

/**
 * 표로 정의하는 순위 한 종류. `path`는 API 트리에 등록한 경로이고 암묵 메서드 이름이 여기서 나온다.
 * `params`는 공식 예제(`examples_llm/domestic_stock/<이름>`)의 요청 키를 그대로 쓴다.
 * 설명에 전체 값이 있으면 전체를, 화면 코드(Unique key)는 예제값을, 설명이 없는 선택 입력(가격·거래량 범위 등)은 빈 값을 넣는다.
 * 조회 방식을 고르는 필수 입력(정렬 등)은 예제값이 기본이고 `params`로 바꿀 수 있다.
 */
interface KisRankingSpec {
    path: string;
    trId: string;
    /** 종목코드 필드. 순위마다 `stck_shrn_iscd`나 `mksc_shrn_iscd` 중 하나를 쓴다 */
    symbolKey: string;
    /** 기본 입력. 오늘 날짜나 직전 회계연도가 필요한 종류가 있어 지금 시각을 받는다 */
    params: (now: number) => Dict;
    /** 행을 읽을 출력 키. 기본은 `output`이다. 머리 정보를 `output1`에 따로 주는 종류는 `output2`다 */
    rowsKey?: string;
    /** 공통 필드를 채울 출력 필드. 기본은 `data_rank`, `hts_kor_isnm`, `stck_prpr`, `prdy_vrss`, `prdy_ctrt`, `acml_vol`이다 */
    fields?: Partial<Record<'rank' | 'name' | 'price' | 'change' | 'rate' | 'volume', string>>;
    /** 호출 전에 `params`를 검사하고 바꾼다. 호출하는 쪽이 반드시 골라야 하는 필터 입력(배당 종류)을 여기서 확인한다 */
    prepare?: (params: Dict) => Dict;
    /** 해외 순위. 심볼의 통화를 거래소(`EXCD`)로 정한다 */
    overseas?: boolean;
}

/** 직전 회계연도(한국 날짜 기준 올해 - 1). 재무 순위의 회계연도 입력 기본값이다. 예제의 `2023`을 그대로 쓰면 기본 조회가 몇 해 전 자료가 된다. */
function kisPreviousFiscalYear(now: number): string {
    return String(Number(kstYmd(now).slice(0, 4)) - 1);
}

/** 재무 순위 세 종류의 공통 입력. 결산(`3`)과 직전 회계연도가 기본이다. 분기 코드의 뜻(0 1/4분기, 1 반기, 2 3/4분기, 3 결산)은 `finance_ratio` 예제 설명을 따른다. */
function kisFinanceRankingParams(now: number, screen: string, sort: string): Dict {
    return {
        fid_trgt_cls_code: '0', fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: screen, fid_input_iscd: '0000', fid_div_cls_code: '0',
        fid_input_price_1: '', fid_input_price_2: '', fid_vol_cnt: '', fid_input_option_1: kisPreviousFiscalYear(now), fid_input_option_2: '3',
        fid_rank_sort_cls_code: sort, fid_blng_cls_code: '0', fid_trgt_exls_cls_code: '0',
    };
}

/** 시간외 순위는 공통 필드를 시간외 단일가 값으로 채운다. */
const KIS_OVERTIME_FIELDS = { price: 'ovtm_untp_prpr', change: 'ovtm_untp_prdy_vrss', rate: 'ovtm_untp_prdy_ctrt', volume: 'ovtm_untp_vol' } as const;

/** 배당 종류(`stock` 주식배당, `cash` 현금배당)를 `GB3`로 옮긴다. 전체 값이 없는 필터라 기본값을 두지 않는다. */
function kisDividendParams(params: Dict): Dict {
    const { dividendType, ...rest } = params;
    const gb3 = rest.GB3 ?? (dividendType === 'stock' ? '1' : dividendType === 'cash' ? '2' : undefined);
    if (gb3 !== '1' && gb3 !== '2') {
        throw new ArgumentsRequired("kis fetchRankings('DIVIDEND_RATE') 는 params.dividendType('stock' 주식배당, 'cash' 현금배당)이 필요하다");
    }
    return { ...rest, GB3: gb3 };
}

/** 해외 순위의 거래소 코드(`EXCD`)와 그 거래소의 거래 통화. 설명에 적힌 아홉 곳이다. */
const KIS_OVERSEAS_RANKING_EXCHANGES: Readonly<Record<string, string>> = {
    NYS: 'USD', NAS: 'USD', AMS: 'USD', HKS: 'HKD', SHS: 'CNY', SZS: 'CNY', HSX: 'VND', HNX: 'VND', TSE: 'JPY',
};

/** 신용매수가능조회의 신용유형(`CRDT_TYPE`) 코드. 설명에 적힌 여덟 가지다(21 자기융자신규, 22 유통대주신규, 23 유통융자신규, 24 자기대주신규, 25 자기융자상환, 26 유통대주상환, 27 유통융자상환, 28 자기대주상환). */
const KIS_CREDIT_TYPES: ReadonlySet<string> = new Set(['21', '22', '23', '24', '25', '26', '27', '28']);

/** 신용주문의 방향별 신용유형(`order-credit` 설명). 매수 21 자기융자신규, 23 유통융자신규, 26 유통대주상환, 28 자기대주상환이다. */
const KIS_CREDIT_BUY_TYPES: ReadonlySet<string> = new Set(['21', '23', '26', '28']);

/** 신용주문 매도의 신용유형. 22 유통대주신규, 24 자기대주신규, 25 자기융자상환, 27 유통융자상환이다. */
const KIS_CREDIT_SELL_TYPES: ReadonlySet<string> = new Set(['22', '24', '25', '27']);

/** 하루(밀리초). 야간 선물옵션 주문체결내역의 종료일자를 다음날로 넘길 때 쓴다. */
const KIS_DAY_MS = 24 * 60 * 60 * 1000;

/** 해외 예약주문조회에서 미국 TR(`TTTT3039R`)을 쓰는 주문 거래소. 그 밖은 아시아 TR(`TTTS3014R`)이다. */
const KIS_US_ORDER_MARKETS: ReadonlySet<OverseasOrderMarket> = new Set<OverseasOrderMarket>(['NASD', 'NYSE', 'AMEX']);

/** 해외 조건검색 조건 이름과 요청 키 뒷부분(`CO_YN_<키>`, `CO_ST_<키>`, `CO_EN_<키>`). */
const KIS_OVERSEAS_SCREENER_KEYS: Readonly<Record<keyof KisOverseasScreenerConditions, string>> = {
    price: 'PRICECUR', percentage: 'RATE', marketCap: 'VALX', shares: 'SHAR', volume: 'VOLUME', amount: 'AMT', eps: 'EPS', per: 'PER',
};

/** 거래소별 해외주식 상품기본정보의 상품유형코드(`search-info` 설명). */
const KIS_OVERSEAS_PRODUCT_TYPES: Readonly<Record<string, string>> = {
    NAS: '512', NYS: '513', AMS: '529', TSE: '515', HKS: '501', HNX: '507', HSX: '508', SHS: '551', SZS: '552',
};

/** 거래소별 두 글자 국가코드(`rights-by-ice` 설명의 CN, HK, US, JP, VN). */
const KIS_OVERSEAS_COUNTRY_CODES: Readonly<Record<string, string>> = {
    NAS: 'US', NYS: 'US', AMS: 'US', HKS: 'HK', SHS: 'CN', SZS: 'CN', TSE: 'JP', HSX: 'VN', HNX: 'VN',
};

/** 거래소별 숫자 국가코드(`colable-by-company` 설명의 840 미국, 344 홍콩, 156 중국). 설명에 없는 나라는 없다. */
const KIS_OVERSEAS_NUMERIC_COUNTRY_CODES: Readonly<Record<string, string>> = {
    NAS: '840', NYS: '840', AMS: '840', HKS: '344', SHS: '156', SZS: '156',
};

/** 해외 순위의 거래소(`params.exchange`, 예: `NAS`)를 `EXCD`로 옮긴다. 전체 값이 없는 필터라 기본값을 두지 않는다. */
function kisOverseasRankingParams(params: Dict): Dict {
    const { exchange, ...rest } = params;
    const code = rest.EXCD ?? exchange;
    if (code === undefined || code === '') {
        throw new ArgumentsRequired('kis 해외 순위는 params.exchange(NYS, NAS, AMS, HKS, SHS, SZS, HSX, HNX, TSE)가 필요하다');
    }
    if (KIS_OVERSEAS_RANKING_EXCHANGES[code] === undefined) throw new BadRequest(`kis 해외 순위의 exchange 는 설명에 있는 거래소 코드여야 한다: ${code}`);
    return { ...rest, EXCD: code };
}

/** 해외 신고가·신저가의 기간(`params.period`) → `NDAY`. 값은 cluefin 설명(0 5일부터 7 1년까지)이다. */
const KIS_NEW_HIGH_LOW_PERIODS: Readonly<Record<string, string>> = { '5d': '0', '10d': '1', '20d': '2', '30d': '3', '60d': '4', '120d': '5', '52w': '6', '1y': '7' };

/**
 * 해외 신고가·신저가의 기간(`NDAY`). 예제에는 없지만 실계좌(2026-09-24)에서 빠지면 거부됐다. 무엇을 신고가로 볼지 정하는 값이고 전체 값이 없어
 * 기본값 없이 호출하는 쪽이 고른다.
 */
function kisNewHighLowParams(params: Dict): Dict {
    const { period, ...rest } = params;
    const code = rest.NDAY ?? (typeof period === 'string' ? KIS_NEW_HIGH_LOW_PERIODS[period] : undefined);
    if (code === undefined) {
        throw new ArgumentsRequired(`kis 해외 신고가·신저가 순위는 params.period(${Object.keys(KIS_NEW_HIGH_LOW_PERIODS).join(', ')})가 필요하다`);
    }
    return kisOverseasRankingParams({ ...rest, NDAY: code });
}

/** 해외 순위의 공통 입력. 거래량 조건은 전체(`0`), 연속조회 키와 권한 정보는 빈 값이다. 거래소는 `prepare`가 채운다. */
const KIS_OVERSEAS_RANKING_COMMON: Dict = { EXCD: '', VOL_RANG: '0', KEYB: '', AUTH: '' };

/** 해외 순위 표 항목. 행은 `output2`, 종목코드는 `symb`다. 종목명 필드는 순위마다 `name`이나 `knam`이다. */
function kisOverseasRanking(path: string, trId: string, params: Dict, name = 'name'): KisRankingSpec {
    return {
        path: `uapi/overseas-stock/v1/ranking/${path}`, trId, symbolKey: 'symb', rowsKey: 'output2', overseas: true,
        fields: { rank: 'rank', name, price: 'last', change: 'diff', rate: 'rate', volume: 'tvol' },
        params: () => ({ ...KIS_OVERSEAS_RANKING_COMMON, ...params }),
        prepare: kisOverseasRankingParams,
    };
}

/** 상하한가 구분(`upper` 상한가, `lower` 하한가)을 `FID_PRC_CLS_CODE`로 옮긴다. 전체 값이 없는 필터라 기본값을 두지 않는다. */
function kisPriceLimitParams(params: Dict): Dict {
    const { priceLimit, ...rest } = params;
    const code = rest.FID_PRC_CLS_CODE ?? (priceLimit === 'upper' ? '0' : priceLimit === 'lower' ? '1' : undefined);
    if (code !== '0' && code !== '1') {
        throw new ArgumentsRequired("kis fetchRankings('PRICE_LIMIT') 는 params.priceLimit('upper' 상한가, 'lower' 하한가)이 필요하다");
    }
    return { ...rest, FID_PRC_CLS_CODE: code };
}

/** 순위 표의 공통 입력: 시장 KRX(`J`), 대상과 제외 대상과 분류는 전체, 가격과 거래량 범위는 비움. 예제 키가 이 여덟 개를 모두 가진 종류만 펼쳐 쓴다. */
const KIS_RANKING_COMMON: Dict = {
    fid_cond_mrkt_div_code: 'J', fid_input_iscd: '0000', fid_div_cls_code: '0', fid_trgt_cls_code: '0', fid_trgt_exls_cls_code: '0',
    fid_input_price_1: '', fid_input_price_2: '', fid_vol_cnt: '',
};

/**
 * ELW 순위 한 종류. 다섯 순위가 공유하는 입력(시장 `W`, 기초자산 전체 `000000`, 발행사 전체 `00000`, 가격과 거래량 범위 비움, 결재방법 `0`)에
 * 종류별 입력을 더한다. 예제 필드 목록에 순위 필드가 없어서 `data_rank`가 오지 않으면 `rank`가 비고, 그때는 행 순서가 순위다.
 * 종목코드는 ELW 단축코드(`elw_shrn_iscd`)다.
 */
function kisElwRanking(path: string, trId: string, nameKey: string, extra: Dict): KisRankingSpec {
    return {
        path: `uapi/elw/v1/ranking/${path}`,
        trId,
        symbolKey: 'elw_shrn_iscd',
        params: () => ({
            FID_COND_MRKT_DIV_CODE: 'W', FID_UNAS_INPUT_ISCD: '000000', FID_INPUT_ISCD: '00000',
            FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '', FID_INPUT_VOL_1: '', FID_INPUT_VOL_2: '', FID_BLNG_CLS_CODE: '0', ...extra,
        }),
        fields: { name: nameKey, price: 'elw_prpr' },
    };
}

const KIS_RANKING_SPECS: Readonly<Record<Exclude<KisRankingType, 'FLUCTUATION' | 'VOLUME'>, KisRankingSpec>> = {
    /** 시간외잔량 순위. 정렬 기본은 예제의 장전 시간외(`1`). 2 장후 시간외, 3 매도잔량, 4 매수잔량 */
    AFTER_HOUR_BALANCE: {
        path: 'uapi/domestic-stock/v1/ranking/after-hour-balance', trId: 'FHPST01760000', symbolKey: 'stck_shrn_iscd',
        params: () => ({ ...KIS_RANKING_COMMON, fid_cond_scr_div_code: '20176', fid_rank_sort_cls_code: '1' }),
    },
    /** 대량체결건수 상위. 정렬 기본은 예제의 매수상위(`0`). 설명 없는 건별금액·가격·거래량 범위는 비운다 */
    BULK_TRANS: {
        path: 'uapi/domestic-stock/v1/ranking/bulk-trans-num', trId: 'FHKST190900C0', symbolKey: 'mksc_shrn_iscd',
        params: () => ({
            fid_aply_rang_prc_2: '', fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '11909', fid_input_iscd: '0000', fid_rank_sort_cls_code: '0',
            fid_div_cls_code: '0', fid_input_price_1: '', fid_aply_rang_prc_1: '', fid_input_iscd_2: '', fid_trgt_exls_cls_code: '0',
            fid_trgt_cls_code: '0', fid_vol_cnt: '',
        }),
    },
    /** 이격도 순위. 정렬 기본은 이격도상위(`0`), 이격도 기간은 예제의 5일(`5`). 10, 20, 60, 120 도 된다 */
    DISPARITY: {
        path: 'uapi/domestic-stock/v1/ranking/disparity', trId: 'FHPST01780000', symbolKey: 'mksc_shrn_iscd',
        params: () => ({ ...KIS_RANKING_COMMON, fid_cond_scr_div_code: '20178', fid_rank_sort_cls_code: '0', fid_hour_cls_code: '5' }),
    },
    /** 예상체결 상승·하락 상위. 정렬 기본은 상승률(`0`), 장운영 기본은 예제의 장전예상(`0`). 1 은 장마감예상 */
    EXPECTED_CHANGE: {
        // 누적거래량이 없고 예상 체결량(`cntg_vol`)이 온다(실계좌 확인).
        path: 'uapi/domestic-stock/v1/ranking/exp-trans-updown', trId: 'FHPST01820000', symbolKey: 'stck_shrn_iscd', fields: { volume: 'cntg_vol' },
        params: () => ({
            fid_rank_sort_cls_code: '0', fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20182', fid_input_iscd: '0000', fid_div_cls_code: '0',
            fid_aply_rang_prc_1: '', fid_vol_cnt: '', fid_pbmn: '', fid_blng_cls_code: '0', fid_mkop_cls_code: '0',
        }),
    },
    /** 시가총액 상위 */
    MARKET_CAP: {
        path: 'uapi/domestic-stock/v1/ranking/market-cap', trId: 'FHPST01740000', symbolKey: 'mksc_shrn_iscd',
        params: () => ({ ...KIS_RANKING_COMMON, fid_cond_scr_div_code: '20174' }),
    },
    /** 신고가 근접 상위(`fid_prc_cls_code=0`). 설명 없는 괴리율 범위와 가격 범위는 비운다 */
    NEAR_NEW_HIGH: {
        path: 'uapi/domestic-stock/v1/ranking/near-new-highlow', trId: 'FHPST01870000', symbolKey: 'mksc_shrn_iscd',
        params: () => ({
            fid_aply_rang_vol: '0', fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20187', fid_div_cls_code: '0', fid_input_cnt_1: '',
            fid_input_cnt_2: '', fid_prc_cls_code: '0', fid_input_iscd: '0000', fid_trgt_cls_code: '0', fid_trgt_exls_cls_code: '0',
            fid_aply_rang_prc_1: '', fid_aply_rang_prc_2: '',
        }),
    },
    /** 신저가 근접 상위(`fid_prc_cls_code=1`). 나머지 입력은 신고가 근접과 같다 */
    NEAR_NEW_LOW: {
        path: 'uapi/domestic-stock/v1/ranking/near-new-highlow', trId: 'FHPST01870000', symbolKey: 'mksc_shrn_iscd',
        params: () => ({
            fid_aply_rang_vol: '0', fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20187', fid_div_cls_code: '0', fid_input_cnt_1: '',
            fid_input_cnt_2: '', fid_prc_cls_code: '1', fid_input_iscd: '0000', fid_trgt_cls_code: '0', fid_trgt_exls_cls_code: '0',
            fid_aply_rang_prc_1: '', fid_aply_rang_prc_2: '',
        }),
    },
    /** 우선주 괴리율 상위. 우선주 쪽 필드(`prst_*`)와 괴리율(`dprt`)은 `info`에 있다 */
    PREFERRED_DISPARITY: {
        path: 'uapi/domestic-stock/v1/ranking/prefer-disparate-ratio', trId: 'FHPST01770000', symbolKey: 'mksc_shrn_iscd',
        params: () => ({ ...KIS_RANKING_COMMON, fid_cond_scr_div_code: '20177' }),
    },
    /** 호가잔량 순위. 정렬 기본은 순매수잔량순(`0`). 1 순매도잔량순, 2 매수비율순, 3 매도비율순 */
    QUOTE_BALANCE: {
        path: 'uapi/domestic-stock/v1/ranking/quote-balance', trId: 'FHPST01720000', symbolKey: 'mksc_shrn_iscd',
        params: () => ({ ...KIS_RANKING_COMMON, fid_cond_scr_div_code: '20172', fid_rank_sort_cls_code: '0' }),
    },
    /** 관심종목등록 상위. `fid_input_iscd_2`는 설명이 "필수입력값"인 고정값(`000000`), 순위 시작은 1위부터(`1`) */
    TOP_INTEREST: {
        path: 'uapi/domestic-stock/v1/ranking/top-interest-stock', trId: 'FHPST01800000', symbolKey: 'mksc_shrn_iscd',
        params: () => ({ ...KIS_RANKING_COMMON, fid_cond_scr_div_code: '20180', fid_input_iscd_2: '000000', fid_input_cnt_1: '1' }),
    },
    /** 당사매매종목 상위. 정렬 기본은 매도상위(`0`), 기간은 오늘 하루(한국 날짜). `fid_input_date_1`·`fid_input_date_2`로 바꾼다 */
    TRADED_BY_COMPANY: {
        path: 'uapi/domestic-stock/v1/ranking/traded-by-company', trId: 'FHPST01860000', symbolKey: 'mksc_shrn_iscd',
        params: (now) => ({
            fid_trgt_exls_cls_code: '0', fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20186', fid_div_cls_code: '0', fid_rank_sort_cls_code: '0',
            fid_input_date_1: kstYmd(now), fid_input_date_2: kstYmd(now), fid_input_iscd: '0000', fid_trgt_cls_code: '0', fid_aply_rang_vol: '0',
            fid_aply_rang_prc_2: '', fid_aply_rang_prc_1: '',
        }),
    },
    /** 체결강도 상위 */
    VOLUME_POWER: {
        path: 'uapi/domestic-stock/v1/ranking/volume-power', trId: 'FHPST01680000', symbolKey: 'stck_shrn_iscd',
        params: () => ({ ...KIS_RANKING_COMMON, fid_cond_scr_div_code: '20168' }),
    },
    /** 신용잔고 상위. 행은 `output2`에 있고 `output1`은 업종과 기준일자다. 정렬 기본은 융자 잔고비율 상위(`0`), `FID_OPTION`은 예제값(`2`) */
    CREDIT_BALANCE: {
        path: 'uapi/domestic-stock/v1/ranking/credit-balance', trId: 'FHKST17010000', symbolKey: 'mksc_shrn_iscd', rowsKey: 'output2',
        params: () => ({ FID_COND_SCR_DIV_CODE: '11701', FID_INPUT_ISCD: '0000', FID_OPTION: '2', FID_COND_MRKT_DIV_CODE: 'J', FID_RANK_SORT_CLS_CODE: '0' }),
    },
    /**
     * 배당률 상위. 배당 종류(`GB3`)는 전체 값이 없는 필터라 `params.dividendType`으로 반드시 고른다. 시장은 예제 조합인 코스피 종합
     * (`GB1=1`, `UPJONG=0001`)이 기본이고, 코스닥은 `GB1=3`, `UPJONG=1001`로 바꾼다. 기준일 범위는 최근 1년이다.
     */
    DIVIDEND_RATE: {
        path: 'uapi/domestic-stock/v1/ranking/dividend-rate', trId: 'HHKDB13470100', symbolKey: 'sht_cd', fields: { rank: 'rank', name: 'isin_name' },
        params: (now) => ({
            CTS_AREA: ' ', GB1: '1', UPJONG: '0001', GB2: '0', GB3: '', F_DT: kstYmd(now - 365 * DAY_MS), T_DT: kstYmd(now), GB4: '0',
        }),
        prepare: kisDividendParams,
    },
    /** 재무비율 순위. 정렬 기본은 예제의 수익성 분석(`7`). 11 안정성, 15 성장성, 20 활동성 */
    FINANCE_RATIO: {
        path: 'uapi/domestic-stock/v1/ranking/finance-ratio', trId: 'FHPST01750000', symbolKey: 'mksc_shrn_iscd',
        params: (now) => kisFinanceRankingParams(now, '20175', '7'),
    },
    /** HTS 조회상위 20종목. 입력이 없고, 행은 `output1`에 시장구분과 종목코드만 있다 */
    HTS_TOP_VIEW: {
        path: 'uapi/domestic-stock/v1/ranking/hts-top-view', trId: 'HHMCM000100C0', symbolKey: 'mksc_shrn_iscd', rowsKey: 'output1',
        params: () => ({}),
    },
    /** 시장가치 순위. 정렬 기본은 예제의 PER(`23`). 24 PBR, 25 PCR, 26 PSR, 27 EPS 등 */
    MARKET_VALUE: {
        path: 'uapi/domestic-stock/v1/ranking/market-value', trId: 'FHPST01790000', symbolKey: 'mksc_shrn_iscd',
        params: (now) => kisFinanceRankingParams(now, '20179', '23'),
    },
    /** 시간외 예상체결 등락률. 공통 필드는 시간외 단일가 예상 체결가, 대비, 대비율, 체결량이다. 정렬 기본은 상승률(`0`) */
    OVERTIME_EXPECTED_CHANGE: {
        path: 'uapi/domestic-stock/v1/ranking/overtime-exp-trans-fluct', trId: 'FHKST11860000', symbolKey: 'stck_shrn_iscd',
        fields: { price: 'ovtm_untp_antc_cnpr', change: 'ovtm_untp_antc_cntg_vrss', rate: 'ovtm_untp_antc_cntg_ctrt', volume: 'ovtm_untp_antc_cnqn' },
        params: () => ({
            FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '11186', FID_INPUT_ISCD: '0000', FID_RANK_SORT_CLS_CODE: '0', FID_DIV_CLS_CODE: '0',
            FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '', FID_INPUT_VOL_1: '',
        }),
    },
    /** 시간외 등락률 순위. 행은 `output2`, 공통 필드는 시간외 단일가 값이다. 분류 기본은 예제의 상한가(`1`). 2 상승률, 3 보합, 4 하한가, 5 하락률 */
    OVERTIME_CHANGE: {
        path: 'uapi/domestic-stock/v1/ranking/overtime-fluctuation', trId: 'FHPST02340000', symbolKey: 'mksc_shrn_iscd', rowsKey: 'output2',
        fields: KIS_OVERTIME_FIELDS,
        params: () => ({
            FID_COND_MRKT_DIV_CODE: 'J', FID_MRKT_CLS_CODE: '', FID_COND_SCR_DIV_CODE: '20234', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '1',
            FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '', FID_VOL_CNT: '', FID_TRGT_CLS_CODE: '', FID_TRGT_EXLS_CLS_CODE: '',
        }),
    },
    /** 시간외 거래량 순위. 행은 `output2`, 공통 필드는 시간외 단일가 값이다. 정렬 기본은 매수잔량(`0`). 1 매도잔량, 2 거래량 */
    OVERTIME_VOLUME: {
        path: 'uapi/domestic-stock/v1/ranking/overtime-volume', trId: 'FHPST02350000', symbolKey: 'stck_shrn_iscd', rowsKey: 'output2',
        fields: KIS_OVERTIME_FIELDS,
        params: () => ({
            FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20235', FID_INPUT_ISCD: '0000', FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_PRICE_1: '',
            FID_INPUT_PRICE_2: '', FID_VOL_CNT: '', FID_TRGT_CLS_CODE: '', FID_TRGT_EXLS_CLS_CODE: '',
        }),
    },
    /** 수익자산지표 순위. 예제 설명이 비어 있어 회계연도와 분기 코드는 `finance_ratio` 설명을 따른다(직전 회계연도, 결산). 정렬 기본은 예제값(`0`) */
    PROFIT_ASSET: {
        path: 'uapi/domestic-stock/v1/ranking/profit-asset-index', trId: 'FHPST01730000', symbolKey: 'mksc_shrn_iscd',
        params: (now) => kisFinanceRankingParams(now, '20173', '0'),
    },
    /** 공매도 상위. 기간 기본은 예제의 일(`D`), 1일(`0`)이다. 설명 없는 거래량과 가격 범위는 비운다. 순위 필드가 없어 `rank`는 비운다 */
    SHORT_SALE: {
        path: 'uapi/domestic-stock/v1/ranking/short-sale', trId: 'FHPST04820000', symbolKey: 'mksc_shrn_iscd',
        params: () => ({
            FID_APLY_RANG_VOL: '', FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20482', FID_INPUT_ISCD: '0000', FID_PERIOD_DIV_CODE: 'D',
            FID_INPUT_CNT_1: '0', FID_TRGT_EXLS_CLS_CODE: '', FID_TRGT_CLS_CODE: '', FID_APLY_RANG_PRC_1: '', FID_APLY_RANG_PRC_2: '',
        }),
    },
    /**
     * 장마감 예상체결가(`quotations/exp-closing-price`). 순위 필드가 없어 `rank`는 비우고, 거래량 자리에는 체결거래량(`cntg_vol`)을 넣는다.
     * 시장, 정렬, 소속은 모두 전체(`0000`, `0`, `0`)가 기본이다. 정렬은 1 상한가마감예상, 2 하한가마감예상, 3 직전대비상승률상위, 4 직전대비하락률상위
     */
    CLOSING_EXPECTED: {
        path: 'uapi/domestic-stock/v1/quotations/exp-closing-price', trId: 'FHKST117300C0', symbolKey: 'stck_shrn_iscd', fields: { volume: 'cntg_vol' },
        params: () => ({
            FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '0000', FID_RANK_SORT_CLS_CODE: '0', FID_COND_SCR_DIV_CODE: '11173', FID_BLNG_CLS_CODE: '0',
        }),
    },
    /**
     * 국내기관·외국인 매매종목 가집계(`quotations/foreign-institution-total`). 순위 필드가 없어 `rank`는 비운다. 시장구분(`V`)과 화면 코드는 예제값이다.
     * 업종과 투자자는 전체(`0000`, `0`)가 기본이다. 정렬 기본은 예제의 수량정렬(`0`), 순매수상위(`0`)이고 금액정렬(`1`), 순매도상위(`1`)로 바꾼다
     */
    FOREIGN_INSTITUTION_ESTIMATE: {
        path: 'uapi/domestic-stock/v1/quotations/foreign-institution-total', trId: 'FHPTJ04400000', symbolKey: 'mksc_shrn_iscd',
        params: () => ({
            FID_COND_MRKT_DIV_CODE: 'V', FID_COND_SCR_DIV_CODE: '16449', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '0', FID_RANK_SORT_CLS_CODE: '0',
            FID_ETC_CLS_CODE: '0',
        }),
    },
    /** 외국계 매매종목 가집계(`quotations/frgnmem-trade-estimate`). 순위 필드가 없어 `rank`는 비운다. 시장은 전체(`0000`), 정렬은 예제의 금액순(`0`), 매수순(`0`)이 기본이다 */
    FOREIGN_BROKER_ESTIMATE: {
        path: 'uapi/domestic-stock/v1/quotations/frgnmem-trade-estimate', trId: 'FHKST644100C0', symbolKey: 'stck_shrn_iscd',
        params: () => ({
            FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '16441', FID_INPUT_ISCD: '0000', FID_RANK_SORT_CLS_CODE: '0', FID_RANK_SORT_CLS_CODE_2: '0',
        }),
    },
    /**
     * 상하한가 포착(`quotations/capture-uplowprice`). 상하한가 구분은 전체 값이 없는 필터라 `params.priceLimit`으로 반드시 고른다. 순위 필드가 없어
     * `rank`는 비운다. 분류는 예제의 상하한가 종목(`0`)이 기본이고 근접 종목(6 8%, 5 10%, 1 15%, 2 20%, 3 25%)으로 바꾼다. 시장은 전체(`0000`)다
     */
    PRICE_LIMIT: {
        path: 'uapi/domestic-stock/v1/quotations/capture-uplowprice', trId: 'FHKST130000C0', symbolKey: 'mksc_shrn_iscd',
        params: () => ({
            FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '11300', FID_PRC_CLS_CODE: '', FID_DIV_CLS_CODE: '0', FID_INPUT_ISCD: '0000',
            FID_TRGT_CLS_CODE: '', FID_TRGT_EXLS_CLS_CODE: '', FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '', FID_VOL_CNT: '',
        }),
        prepare: kisPriceLimitParams,
    },
    // 해외 순위. 거래소(`params.exchange`)는 반드시 받는다. 기간(`NDAY`, 0 당일)과 분(`MINX`, 0 1분전)은 조회 방식이라 예제값이 기본이다.
    // 순위 필드는 시가총액, 상승률/하락률, 거래량, 거래대금, 거래증가율, 회전율에만 있고 나머지는 `rank`를 비운다.
    /**
     * 해외 시가총액 순위. 통화구분(`CURR_GB`)은 예제에 없지만 실계좌(2026-09-24)에서 빠지면 거부됐다. cluefin 의 기본값 `0`을 보낸다(값 목록은
     * 두 출처 모두에 없다).
     */
    OVERSEAS_MARKET_CAP: kisOverseasRanking('market-cap', 'HHDFS76350100', { CURR_GB: '0' }),
    /** 해외 신고가. 돌파 구분(`GUBN2`)은 예제의 돌파유지(`1`)가 기본이다. 기간은 `params.period`로 고른다(`kisNewHighLowParams`) */
    OVERSEAS_NEW_HIGH: { ...kisOverseasRanking('new-highlow', 'HHDFS76300000', { MINX: '0', GUBN: '1', GUBN2: '1' }), prepare: kisNewHighLowParams },
    /** 해외 신저가 */
    OVERSEAS_NEW_LOW: { ...kisOverseasRanking('new-highlow', 'HHDFS76300000', { MINX: '0', GUBN: '0', GUBN2: '1' }), prepare: kisNewHighLowParams },
    /** 해외 가격 급등 */
    OVERSEAS_PRICE_SURGE: kisOverseasRanking('price-fluct', 'HHDFS76260000', { GUBN: '1', MINX: '0' }, 'knam'),
    /** 해외 가격 급락 */
    OVERSEAS_PRICE_PLUNGE: kisOverseasRanking('price-fluct', 'HHDFS76260000', { GUBN: '0', MINX: '0' }, 'knam'),
    /** 해외 상승률 */
    OVERSEAS_GAINERS: kisOverseasRanking('updown-rate', 'HHDFS76290000', { NDAY: '0', GUBN: '1' }),
    /** 해외 하락률 */
    OVERSEAS_LOSERS: kisOverseasRanking('updown-rate', 'HHDFS76290000', { NDAY: '0', GUBN: '0' }),
    /** 해외 거래량 순위. 설명 없는 가격 범위(`PRC1`, `PRC2`)는 비운다 */
    OVERSEAS_VOLUME: kisOverseasRanking('trade-vol', 'HHDFS76310010', { NDAY: '0', PRC1: '', PRC2: '' }),
    /** 해외 거래대금 순위 */
    OVERSEAS_TRADE_AMOUNT: kisOverseasRanking('trade-pbmn', 'HHDFS76320010', { NDAY: '0', PRC1: '', PRC2: '' }),
    /** 해외 거래증가율 순위 */
    OVERSEAS_TRADE_GROWTH: kisOverseasRanking('trade-growth', 'HHDFS76330000', { NDAY: '0' }),
    /** 해외 거래회전율 순위 */
    OVERSEAS_TURNOVER: kisOverseasRanking('trade-turnover', 'HHDFS76340000', { NDAY: '0' }),
    /** 해외 매수체결강도 상위 */
    OVERSEAS_VOLUME_POWER: kisOverseasRanking('volume-power', 'HHDFS76280000', { NDAY: '0' }),
    /** 해외 거래량 급증 */
    OVERSEAS_VOLUME_SURGE: kisOverseasRanking('volume-surge', 'HHDFS76270000', { MINX: '0' }, 'knam'),
    /** ELW 상승률 순위. 입력은 예제값이고 설명에 적힌 전체 값(기초자산 `000000`, 발행사 `00000`, 잔존일수 `0`, 콜풋 `0`)이다. 정렬 `0`은 상승율이다 */
    ELW_UPDOWN_RATE: kisElwRanking('updown-rate', 'FHPEW02770000', 'hts_kor_isnm', {
        FID_COND_SCR_DIV_CODE: '20277', FID_INPUT_RMNN_DYNU_1: '0', FID_DIV_CLS_CODE: '0', FID_INPUT_DATE_1: '', FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_DATE_2: '',
    }),
    /**
     * ELW 거래량 순위. 예제는 조회기준일에 `20250101`을, 가격과 거래량 범위에 값을 넣지만, 같은 입력을 비워 보내는 상승률과 민감도 순위 예제에 맞춰 비운다.
     * LP발행사(`0000`)는 예제값이다
     */
    ELW_VOLUME: kisElwRanking('volume-rank', 'FHPEW02780000', 'elw_kor_isnm', {
        FID_COND_SCR_DIV_CODE: '20278', FID_INPUT_RMNN_DYNU_1: '', FID_DIV_CLS_CODE: '0', FID_INPUT_DATE_1: '', FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_ISCD_2: '0000', FID_INPUT_DATE_2: '',
    }),
    /** ELW 지표 순위(레버리지, 행사가, 시간가치 등). 입력은 예제값이다 */
    ELW_INDICATOR: kisElwRanking('indicator', 'FHPEW02790000', 'elw_kor_isnm', { FID_COND_SCR_DIV_CODE: '20279', FID_DIV_CLS_CODE: '0', FID_RANK_SORT_CLS_CODE: '0' }),
    /** ELW 민감도 순위(델타, 감마, 세타, 베가 등). 입력은 예제값이다 */
    ELW_SENSITIVITY: kisElwRanking('sensitivity', 'FHPEW02850000', 'elw_kor_isnm', {
        FID_COND_SCR_DIV_CODE: '20285', FID_DIV_CLS_CODE: '0', FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_RMNN_DYNU_1: '', FID_INPUT_DATE_1: '',
    }),
    /** ELW 당일 급변 종목. 시장구분(`A`), 시간구분(`1`), 정렬(`1`)은 예제값이다 */
    ELW_QUICK_CHANGE: kisElwRanking('quick-change', 'FHPEW02870000', 'elw_kor_isnm', {
        FID_COND_SCR_DIV_CODE: '20287', FID_MRKT_CLS_CODE: 'A', FID_HOUR_CLS_CODE: '1', FID_INPUT_HOUR_1: '', FID_INPUT_HOUR_2: '', FID_RANK_SORT_CLS_CODE: '1',
    }),
};

/**
 * 재무 조회 한 종류. 요청 키의 대소문자는 공식 예제를 그대로 따른다(예제마다 `FID_DIV_CLS_CODE`와 `fid_div_cls_code`가 섞여 있다).
 * 응답 필드는 예제에 목록이 없어 포털 명세를 옮긴 `kgcrom/cluefin` 타입으로 확인했다.
 */
interface KisFinancialSpec {
    path: string;
    trId: string;
    divKey: 'FID_DIV_CLS_CODE' | 'fid_div_cls_code';
    fields: Readonly<Record<string, string>>;
}

const KIS_FINANCIAL_SPECS: Readonly<Record<KisFinancialStatement, KisFinancialSpec>> = {
    /** 대차대조표 */
    BALANCE_SHEET: {
        path: 'uapi/domestic-stock/v1/finance/balance-sheet', trId: 'FHKST66430100', divKey: 'FID_DIV_CLS_CODE',
        fields: {
            currentAssets: 'cras', fixedAssets: 'fxas', totalAssets: 'total_aset', currentLiabilities: 'flow_lblt', fixedLiabilities: 'fix_lblt',
            totalLiabilities: 'total_lblt', capitalStock: 'cpfn', capitalSurplus: 'cfp_surp', retainedEarnings: 'prfi_surp', totalEquity: 'total_cptl',
        },
    },
    /** 손익계산서 */
    INCOME_STATEMENT: {
        path: 'uapi/domestic-stock/v1/finance/income-statement', trId: 'FHKST66430200', divKey: 'FID_DIV_CLS_CODE',
        fields: {
            revenue: 'sale_account', costOfSales: 'sale_cost', grossProfit: 'sale_totl_prfi', depreciation: 'depr_cost', sellingAndAdminExpenses: 'sell_mang',
            operatingIncome: 'bsop_prti', nonOperatingIncome: 'bsop_non_ernn', nonOperatingExpenses: 'bsop_non_expn', ordinaryIncome: 'op_prfi',
            extraordinaryGain: 'spec_prfi', extraordinaryLoss: 'spec_loss', netIncome: 'thtr_ntin',
        },
    },
    /** 재무비율 */
    FINANCIAL_RATIO: {
        path: 'uapi/domestic-stock/v1/finance/financial-ratio', trId: 'FHKST66430300', divKey: 'FID_DIV_CLS_CODE',
        fields: {
            revenueGrowth: 'grs', operatingIncomeGrowth: 'bsop_prfi_inrt', netIncomeGrowth: 'ntin_inrt', roe: 'roe_val', eps: 'eps',
            salesPerShare: 'sps', bps: 'bps', reserveRatio: 'rsrv_rate', debtRatio: 'lblt_rate',
        },
    },
    /** 수익성비율 */
    PROFITABILITY_RATIO: {
        path: 'uapi/domestic-stock/v1/finance/profit-ratio', trId: 'FHKST66430400', divKey: 'FID_DIV_CLS_CODE',
        fields: { returnOnTotalCapital: 'cptl_ntin_rate', returnOnEquity: 'self_cptl_ntin_inrt', netProfitMargin: 'sale_ntin_rate', grossProfitMargin: 'sale_totl_rate' },
    },
    /** 기타주요비율 */
    OTHER_KEY_RATIO: {
        path: 'uapi/domestic-stock/v1/finance/other-major-ratios', trId: 'FHKST66430500', divKey: 'fid_div_cls_code',
        fields: { payoutRatio: 'payout_rate', eva: 'eva', ebitda: 'ebitda', evToEbitda: 'ev_ebitda' },
    },
    /** 안정성비율 */
    STABILITY_RATIO: {
        path: 'uapi/domestic-stock/v1/finance/stability-ratio', trId: 'FHKST66430600', divKey: 'fid_div_cls_code',
        fields: { debtRatio: 'lblt_rate', borrowingDependence: 'bram_depn', currentRatio: 'crnt_rate', quickRatio: 'quck_rate' },
    },
    /** 성장성비율 */
    GROWTH_RATIO: {
        path: 'uapi/domestic-stock/v1/finance/growth-ratio', trId: 'FHKST66430800', divKey: 'fid_div_cls_code',
        fields: { revenueGrowth: 'grs', operatingIncomeGrowth: 'bsop_prfi_inrt', equityGrowth: 'equt_inrt', totalAssetGrowth: 'totl_aset_inrt' },
    },
};

/**
 * 예탁원 일정 한 종류(`ksdinfo/*`). 모든 종류가 기간(`F_DT`, `T_DT`), 종목코드(`SHT_CD`, 비우면 전체), 연속조회 키(`CTS`)를 받는다.
 * `params`는 종류마다 더 보내는 입력이다. 배당(`GB1`)과 액면교체(`MARKET_GB`)는 설명의 전체 값을, 유상증자(`GB1`)는 조회 기준을 고르는
 * 입력이라 예제값(청약일별 `1`)을 보낸다. 응답 필드는 예제에 목록이 없어 포털 명세를 옮긴 `kgcrom/cluefin` 타입으로 확인했다.
 */
const KIS_CORPORATE_SCHEDULE_SPECS: Readonly<Record<KisCorporateScheduleType, { path: string; trId: string; params: Dict; nameKey?: string; dateKey?: string }>> = {
    RIGHTS_ISSUE: { path: 'uapi/domestic-stock/v1/ksdinfo/paidin-capin', trId: 'HHKDB669100C0', params: { GB1: '1' } },
    BONUS_ISSUE: { path: 'uapi/domestic-stock/v1/ksdinfo/bonus-issue', trId: 'HHKDB669101C0', params: {} },
    DIVIDEND: { path: 'uapi/domestic-stock/v1/ksdinfo/dividend', trId: 'HHKDB669102C0', params: { GB1: '0', HIGH_GB: '' } },
    APPRAISAL_RIGHTS: { path: 'uapi/domestic-stock/v1/ksdinfo/purreq', trId: 'HHKDB669103C0', params: {} },
    // 합병·분할은 종목명이 회사명(`cust_nm`)이다(실계좌 확인).
    MERGER_SPLIT: { path: 'uapi/domestic-stock/v1/ksdinfo/merger-split', trId: 'HHKDB669104C0', params: {}, nameKey: 'cust_nm' },
    PAR_VALUE_CHANGE: { path: 'uapi/domestic-stock/v1/ksdinfo/rev-split', trId: 'HHKDB669105C0', params: { MARKET_GB: '0' } },
    CAPITAL_REDUCTION: { path: 'uapi/domestic-stock/v1/ksdinfo/cap-dcrs', trId: 'HHKDB669106C0', params: {} },
    // 상장과 의무예탁은 기준일 필드가 없어 상장일(`list_dt`)과 예탁일(`depo_date`)을 기준일로 옮긴다(실계좌 확인).
    LISTING: { path: 'uapi/domestic-stock/v1/ksdinfo/list-info', trId: 'HHKDB669107C0', params: {}, dateKey: 'list_dt' },
    PUBLIC_OFFERING: { path: 'uapi/domestic-stock/v1/ksdinfo/pub-offer', trId: 'HHKDB669108C0', params: {} },
    FORFEITED_SHARES: { path: 'uapi/domestic-stock/v1/ksdinfo/forfeit', trId: 'HHKDB669109C0', params: {} },
    MANDATORY_DEPOSIT: { path: 'uapi/domestic-stock/v1/ksdinfo/mand-deposit', trId: 'HHKDB669110C0', params: {}, dateKey: 'depo_date' },
    SHAREHOLDER_MEETING: { path: 'uapi/domestic-stock/v1/ksdinfo/sharehld-meet', trId: 'HHKDB669111C0', params: {} },
};

/** API 트리 경로 → 암묵 메서드 이름(`uapi/domestic-stock/v1/ranking/fluctuation` → `privateGetUapiDomesticStockV1RankingFluctuation`). */
function kisImplicitGet(path: string): string {
    return `privateGet${path.split(/[/-]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')}`;
}

/**
 * 순위 행 하나. 순위 API 들이 공통으로 주는 필드만 정리했다. 종류별 지표와 나머지 원문은 `info`에 있다.
 * 시간외 순위(`OVERTIME_*`)의 가격, 대비, 대비율, 거래량은 시간외 단일가 값이다(예상체결 순위는 예상 체결가와 예상 체결량).
 * 해외 순위(`OVERSEAS_*`)는 `symb`, `name`(또는 `knam`), `last`, `diff`, `rate`, `tvol`, `rank`를 같은 자리에 옮긴다.
 */
export interface KisRankingItem {
    /** 순위(`data_rank`) */
    rank: number | undefined;
    /** 통합 심볼(`005930/KRW`). 해외 순위는 거래소의 거래 통화를 붙인다(`AAPL/USD`, `00700/HKD`) */
    symbol: string;
    /** HTS 한글 종목명(`hts_kor_isnm`) */
    name: string | undefined;
    /** 주식 현재가(`stck_prpr`) */
    last: number | undefined;
    /** 전일대비(`prdy_vrss`) */
    change: number | undefined;
    /** 전일대비율(`prdy_ctrt`) */
    percentage: number | undefined;
    /** 누적거래량(`acml_vol`) */
    volume: number | undefined;
    info: Dict;
}

/** 지금 시각의 KST 달력 날짜 `YYYYMMDD`. */
function kstYmd(ms: number): string {
    return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 한국 시각 `HHMMSS`. */
function kstHms(ms: number): string {
    return new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 19).replace(/:/g, '');
}

/** `YYYYMMDD` + `HHMMSS`(KST) → 밀리초. 읽는 규칙은 `kstStamp` 와 같다(`kstTimestampOf`). */
function kstTimestamp(ymd: Str, hms: Str): Int {
    return kstTimestampOf(ymd, hms);
}

/** `YYYYMMDD` + `HHMMSS`(미국 동부 시각, 서머타임 반영) → 밀리초. 읽는 규칙은 `kstTimestamp` 와 같다. */
function etTimestamp(ymd: Str, hms: Str): Int {
    const kst = kstTimestamp(ymd, hms);
    if (kst === undefined) return undefined;
    // 한국 시각으로 읽은 값에 9시간을 더하면 같은 벽시계 시각을 UTC 로 읽은 값이 된다.
    const wall = new Date(kst + KST_OFFSET_MS);
    return etWallClockToUtcMs(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes())
        + wall.getUTCSeconds() * 1000;
}

/** 업종 기간별 시세의 기간 구분(`FID_PERIOD_DIV_CODE`)과, `since`가 없을 때 조회 구간을 잡는 데 쓰는 봉 하나의 일수. */
const KIS_INDEX_PERIODS: Readonly<Record<string, { code: string; days: number }>> = {
    '1d': { code: 'D', days: 1 }, '1w': { code: 'W', days: 7 }, '1M': { code: 'M', days: 31 }, '1y': { code: 'Y', days: 366 },
};

/** 업종 분봉의 봉 길이(`FID_INPUT_HOUR_1`, 초). 문서 예시에 있는 값만 받는다. */
const KIS_INDEX_MINUTE_SECONDS: Readonly<Record<string, string>> = { '30s': '30', '1m': '60', '10m': '600', '1h': '3600' };

/** `since`가 없을 때 봉 개수로 잡는 조회 구간에 곱하는 휴장일 여유. */
const KIS_INDEX_RANGE_MARGIN = 1.5;

/** 일 단위 봉의 시각. `KISCandleService`의 국내 일봉과 같게 장 시작(09:00 KST)으로 둔다. */
const KIS_DAILY_CANDLE_HMS = '090000';

/** 회원사 실시간 매매동향의 회원사코드 전체 값(문서: `99999(전체)`). */
const KIS_ALL_MEMBERS = '99999';

/** 주식현재가 일자별의 기간 구분(`FID_PERIOD_DIV_CODE`). */
const KIS_DAILY_PRICE_PERIODS: Readonly<Record<string, string>> = { '1d': 'D', '1w': 'W', '1M': 'M' };

/** NAV 비교추이(분)의 시간구분(`FID_HOUR_CLS_CODE`, 초). 문서 예시(`60:1분,180:3분,...,7200:120분`)에 적힌 값만 둔다. */
const KIS_ETF_NAV_MINUTE_SECONDS: Readonly<Record<string, string>> = { '1m': '60', '3m': '180', '2h': '7200' };

/**
 * ELW 투자지표추이, 변동성추이(분별)의 시간구분(`FID_HOUR_CLS_CODE`, 초). 두 예제 설명이 함께 적은 값(60, 180, 300, 600, 1800, 3600)만 둔다.
 * 투자지표추이 설명의 `7200(60분)`은 초와 분이 맞지 않아 넣지 않는다.
 */
const KIS_ELW_MINUTE_SECONDS: Readonly<Record<string, string>> = { '1m': '60', '3m': '180', '5m': '300', '10m': '600', '30m': '1800', '1h': '3600' };

/** ELW 추이 조회의 경로 이름과 TR. 체결(`tick`), 일별(`1d`), 분별 순이다. 민감도 추이는 분별 API가 없다. */
const KIS_ELW_TRENDS: Readonly<Record<'indicator' | 'sensitivity' | 'volatility', { tick: string; daily: string; minute?: string }>> = {
    indicator: { tick: 'FHPEW02740100', daily: 'FHPEW02740200', minute: 'FHPEW02740300' },
    sensitivity: { tick: 'FHPEW02830100', daily: 'FHPEW02830200' },
    volatility: { tick: 'FHPEW02840100', daily: 'FHPEW02840200', minute: 'FHPEW02840300' },
};

/** 선물옵션기간별시세의 기간분류코드(`FID_PERIOD_DIV_CODE`). 설명의 예는 `D`, `W`이고, 월과 년(`M`, `Y`)은 API 이름("일/주/월/년")을 따른다. */
const KIS_DERIVATIVE_PERIODS: Readonly<Record<string, string>> = { '1d': 'D', '1w': 'W', '1M': 'M', '1y': 'Y' };

/** 선물옵션 분봉의 시간구분(`FID_HOUR_CLS_CODE`, 초). 설명에 적힌 값(30초, 1분)만 둔다. */
const KIS_DERIVATIVE_MINUTE_SECONDS: Readonly<Record<string, string>> = { '30s': '30', '1m': '60' };

/** 해외선물옵션 체결추이의 경로와 TR. 틱, 일간, 주간, 월간 순이다. 해외옵션 분봉은 예제가 일간과 같은 TR 을 적어 넣지 않았다. */
const KIS_OVERSEAS_DERIVATIVE_TRENDS: Readonly<Record<'futures' | 'option', Readonly<Record<string, readonly [string, string]>>>> = {
    futures: { tick: ['tick-ccnl', 'HHDFC55020200'], '1d': ['daily-ccnl', 'HHDFC55020100'], '1w': ['weekly-ccnl', 'HHDFC55020000'], '1M': ['monthly-ccnl', 'HHDFC55020300'] },
    option: { tick: ['opt-tick-ccnl', 'HHDFO55020200'], '1d': ['opt-daily-ccnl', 'HHDFO55020100'], '1w': ['opt-weekly-ccnl', 'HHDFO55020000'], '1M': ['opt-monthly-ccnl', 'HHDFO55020300'] },
};

/** 해외선물 미결제추이의 상품코드(`PROD_ISCD`). 설명이 나열한 금리, 금속, 농산물, 에너지, 지수, 축산물, 통화 상품이다. */
const KIS_OVERSEAS_OPEN_INTEREST_PRODUCTS: ReadonlySet<string> = new Set([
    'GE', 'ZB', 'ZF', 'ZN', 'ZT', 'GC', 'PA', 'PL', 'SI', 'HG', 'CC', 'CT', 'KC', 'OJ', 'SB', 'ZC', 'ZL', 'ZM', 'ZO', 'ZR', 'ZS', 'ZW',
    'CL', 'HO', 'NG', 'WBS', 'ES', 'NQ', 'TF', 'YM', 'VX', 'GF', 'HE', 'LE', '6A', '6B', '6C', '6E', '6J', '6N', '6S', 'DX',
]);

/** 해외선물, 해외옵션 상품기본정보에 한 번에 넣을 수 있는 종목 수(`SRS_CD_01`~). 예제 설명대로 선물 32개, 옵션 30개다. */
const KIS_OVERSEAS_CONTRACT_LIMITS: Readonly<Record<'futures' | 'option', number>> = { futures: 32, option: 30 };

/** 투자자 유형의 필드 여섯 개: 순매수 수량, 순매수 대금, 매도 수량, 매수 수량, 매도 대금, 매수 대금. */
type KisInvestorFieldSet = readonly [string, string, string, string, string, string];

/** 이름 규칙이 고른 유형(`<접두>_ntby_qty`, `<접두>_ntby_tr_pbmn`, `<접두>_seln_vol` 등)의 필드. */
const kisInvestorFields = (prefix: string, netVolume = `${prefix}_ntby_qty`): KisInvestorFieldSet => [
    netVolume, `${prefix}_ntby_tr_pbmn`, `${prefix}_seln_vol`, `${prefix}_shnu_vol`, `${prefix}_seln_tr_pbmn`, `${prefix}_shnu_tr_pbmn`,
];

/** 외국인 등록과 비등록은 매도·매수 필드를 호가 이름(`askp`, `bidp`)으로 준다. */
const kisForeignSubFields = (prefix: string): KisInvestorFieldSet => [
    `${prefix}_ntby_qty`, `${prefix}_ntby_pbmn`, `${prefix}_askp_qty`, `${prefix}_bidp_qty`, `${prefix}_askp_pbmn`, `${prefix}_bidp_pbmn`,
];

/**
 * 종목별 투자자 일별 동향(`investor-trade-by-stock-daily`)의 투자자 유형별 필드. 사모펀드와 기타 법인, 기타 단체는 순매수 수량이 `_vol`로
 * 끝나고, 외국인 등록과 비등록은 대금과 매도·매수 필드 이름이 다르다. 필드 이름은 포털 명세를 옮긴 `kgcrom/cluefin` 타입과 공식 예제의 필드 목록으로 확인했다.
 */
const KIS_INVESTOR_FIELDS: Readonly<Record<KisInvestorType, KisInvestorFieldSet>> = {
    foreign: kisInvestorFields('frgn'),
    foreignRegistered: kisForeignSubFields('frgn_reg'),
    foreignUnregistered: kisForeignSubFields('frgn_nreg'),
    individual: kisInvestorFields('prsn'),
    institution: kisInvestorFields('orgn'),
    securities: kisInvestorFields('scrt'),
    investmentTrust: kisInvestorFields('ivtr'),
    privateFund: kisInvestorFields('pe_fund', 'pe_fund_ntby_vol'),
    bank: kisInvestorFields('bank'),
    insurance: kisInvestorFields('insu'),
    merchantBank: kisInvestorFields('mrbn'),
    pensionFund: kisInvestorFields('fund'),
    other: kisInvestorFields('etc'),
    otherCorporation: kisInvestorFields('etc_corp', 'etc_corp_ntby_vol'),
    otherOrganization: kisInvestorFields('etc_orgt', 'etc_orgt_ntby_vol'),
};

/** 종목별 외국계 순매수 추이의 둘째 종목코드(`FID_INPUT_ISCD_2`). 설명 없이 예제값만 있어 그대로 보낸다. */
const KIS_FOREIGN_TREND_SECOND_CODE = '99999';

/** 응답의 첫 행. 배열이면 첫 원소, 객체면 그대로, 없으면 빈 객체다. */
function firstRow(value: unknown): Dict {
    if (Array.isArray(value)) return (value[0] ?? {}) as Dict;
    return value !== null && typeof value === 'object' ? (value as Dict) : {};
}

/** 응답의 행 목록. 배열이 아니면 빈 목록이다. */
function rowsOf(value: unknown): Dict[] {
    return Array.isArray(value) ? (value as Dict[]) : [];
}

/** 응답의 행 목록. 배열이면 그대로, 객체면 키가 있을 때만 한 행으로 감싼다(KIS 가 행이 하나면 객체로, 없으면 빈 객체로 준다). */
function multiRowsOf(value: unknown): Dict[] {
    if (Array.isArray(value)) return value as Dict[];
    if (value !== null && typeof value === 'object' && Object.keys(value as Dict).length > 0) return [value as Dict];
    return [];
}

const toNumber = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

/** 금액 문자열이 음수면 `'0'` 이다. */
const nonNegative = (value: Str): string => (value === undefined || Precise.stringLt(value, '0') ? '0' : value);

/**
 * 전일대비에 부호를 붙인다. 부호는 등락률의 부호를 쓰고, 등락률이 반올림으로 0 이면 전일대비부호(1 상한, 2 상승, 3 보합, 4 하한,
 * 5 하락)로 정한다. 등락률만 보면 호가단위가 작은 고가 종목의 작은 변동이 0 이 된다.
 */
const signedChange = (change: Str, percentage: Str, sign: Str): string => {
    const magnitude = Precise.stringAbs(change ?? '0') ?? '0';
    let direction = Math.sign(toNumber(percentage));
    if (direction === 0) direction = sign === '4' || sign === '5' ? -1 : sign === '1' || sign === '2' ? 1 : 0;
    return direction === 0 ? '0' : direction < 0 ? (Precise.stringNeg(magnitude) ?? '0') : magnitude;
};

export class kis extends Exchange {
    /** 접근 토큰·실시간 접속키 캐시. 앱키가 바뀌면 다시 만든다. */
    private authState: { appKey: string; auth: KISAuth } | undefined;
    private candleService: KISCandleService | undefined;
    /** 종목별 NXT 거래 가능 여부. `blockedReason` 이 없으면 거래할 수 있다. */
    private readonly nxtEligibility = new Map<string, { blockedReason: string | undefined; at: number }>();
    /** 응답 객체별 응답 헤더 `tr_cont`. `last_response_headers` 는 동시 요청에 덮이므로 응답 객체에 묶는다. */
    private readonly trContOf = new WeakMap<object, string>();

    override describe(): Dict {
        return this.deepExtend(super.describe(), {
            id: 'kis',
            name: 'Korea Investment & Securities',
            countries: ['KR'],
            version: 'v1',
            rateLimit: REAL_RATE_LIMIT_MS,
            timeout: READ_TIMEOUT_MS,
            orderTimeout: ORDER_TIMEOUT_MS,
            has: {
                ws: true,
                watchTicker: true,
                watchTrades: true,
                watchOrderBook: true,
                watchOrders: true,
                spot: true,
                margin: false,
                swap: false,
                future: false,
                option: false,
                sandbox: true,
                createOrder: true,
                createLimitOrder: true,
                createMarketOrder: true,
                cancelOrder: true,
                cancelAllOrders: 'emulated',
                editOrder: true,
                createTriggerOrder: true,
                fetchBalance: true,
                fetchMarkets: true,
                fetchCurrencies: false,
                fetchTicker: true,
                fetchTickers: true,
                fetchOrderBook: true,
                fetchOHLCV: true,
                fetchOrder: true,
                fetchOrders: true,
                fetchOpenOrders: true,
                // 부모 클래스가 `fetchOrders` 결과에서 체결 완료만 거른다.
                fetchClosedOrders: 'emulated',
                fetchCanceledOrders: false,
                fetchMyTrades: true,
                fetchTradingFee: true,
                fetchStatus: false,
                fetchTime: false,
                fetchMarketCalendar: true,
                fetchStockWarnings: true,
                fetchInvestorTrading: true,
                fetchRankings: true,
            },
            // 야후 파이낸스로 받는 봉 주기. 국내 캔들은 KIS 가 당일 분봉과 100행 일봉만 줘서 야후를 쓴다.
            timeframes: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w', '1M': '1M' },
            urls: {
                api: { public: KIS_API_DOMAINS.REAL, private: KIS_API_DOMAINS.REAL },
                test: { public: KIS_API_DOMAINS.VIRTUAL, private: KIS_API_DOMAINS.VIRTUAL },
                ws: { public: KIS_WS_DOMAINS.REAL },
                wsTest: { public: KIS_WS_DOMAINS.VIRTUAL },
                www: 'https://securities.koreainvestment.com',
                doc: [
                    'https://apiportal.koreainvestment.com/apiservice',
                    'https://github.com/koreainvestment/open-trading-api',
                ],
                fees: 'https://securities.koreainvestment.com/main/customer/guide/_static/TF04ae010000.jsp',
            },
            requiredCredentials: { apiKey: true, secret: true, uid: true },
            api: {
                public: {
                    post: {
                        'oauth2/tokenP': { cost: 1 },
                        'oauth2/Approval': { cost: 1 },
                    },
                },
                private: {
                    get: {
                        // 국내 시세
                        'uapi/domestic-stock/v1/quotations/inquire-price': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/intstock-multprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-investor': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/search-stock-info': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-vi-status': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/volume-rank': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/fluctuation': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/after-hour-balance': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/bulk-trans-num': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/disparity': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/exp-trans-updown': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/market-cap': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/near-new-highlow': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/prefer-disparate-ratio': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/quote-balance': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/top-interest-stock': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/traded-by-company': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/volume-power': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/credit-balance': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/dividend-rate': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/finance-ratio': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/hts-top-view': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/market-value': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/overtime-exp-trans-fluct': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/overtime-fluctuation': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/overtime-volume': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/profit-asset-index': { cost: 1 },
                        'uapi/domestic-stock/v1/ranking/short-sale': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/exp-closing-price': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-ccnl': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-time-overtimeconclusion': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-overtime-price': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-overtime-asking-price': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-daily-overtimeprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-member': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/frgnmem-trade-trend': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-daily-price': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-price-2': { cost: 1 },
                        'uapi/etfetn/v1/quotations/inquire-price': { cost: 1 },
                        'uapi/etfetn/v1/quotations/inquire-component-stock-price': { cost: 1 },
                        'uapi/etfetn/v1/quotations/nav-comparison-trend': { cost: 1 },
                        'uapi/etfetn/v1/quotations/nav-comparison-daily-trend': { cost: 1 },
                        'uapi/etfetn/v1/quotations/nav-comparison-time-trend': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-elw-price': { cost: 1 },
                        'uapi/elw/v1/ranking/updown-rate': { cost: 1 },
                        'uapi/elw/v1/ranking/volume-rank': { cost: 1 },
                        'uapi/elw/v1/ranking/indicator': { cost: 1 },
                        'uapi/elw/v1/ranking/sensitivity': { cost: 1 },
                        'uapi/elw/v1/ranking/quick-change': { cost: 1 },
                        'uapi/elw/v1/quotations/compare-stocks': { cost: 1 },
                        'uapi/elw/v1/quotations/expiration-stocks': { cost: 1 },
                        'uapi/elw/v1/quotations/newly-listed': { cost: 1 },
                        'uapi/elw/v1/quotations/udrl-asset-list': { cost: 1 },
                        'uapi/elw/v1/quotations/udrl-asset-price': { cost: 1 },
                        'uapi/elw/v1/quotations/indicator-trend-ccnl': { cost: 1 },
                        'uapi/elw/v1/quotations/indicator-trend-daily': { cost: 1 },
                        'uapi/elw/v1/quotations/indicator-trend-minute': { cost: 1 },
                        'uapi/elw/v1/quotations/sensitivity-trend-ccnl': { cost: 1 },
                        'uapi/elw/v1/quotations/sensitivity-trend-daily': { cost: 1 },
                        'uapi/elw/v1/quotations/volatility-trend-ccnl': { cost: 1 },
                        'uapi/elw/v1/quotations/volatility-trend-daily': { cost: 1 },
                        'uapi/elw/v1/quotations/volatility-trend-minute': { cost: 1 },
                        'uapi/elw/v1/quotations/cond-search': { cost: 1 },
                        'uapi/elw/v1/quotations/lp-trade-trend': { cost: 1 },
                        'uapi/elw/v1/quotations/volatility-trend-tick': { cost: 1 },
                        'uapi/domestic-futureoption/v1/quotations/display-board-callput': { cost: 1 },
                        'uapi/domestic-futureoption/v1/quotations/display-board-futures': { cost: 1 },
                        'uapi/domestic-futureoption/v1/quotations/display-board-option-list': { cost: 1 },
                        'uapi/domestic-futureoption/v1/quotations/display-board-top': { cost: 1 },
                        'uapi/domestic-futureoption/v1/quotations/exp-price-trend': { cost: 1 },
                        'uapi/domestic-futureoption/v1/quotations/inquire-asking-price': { cost: 1 },
                        'uapi/domestic-futureoption/v1/quotations/inquire-price': { cost: 1 },
                        'uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice': { cost: 1 },
                        'uapi/domestic-futureoption/v1/quotations/inquire-time-fuopchartprice': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/inquire-price': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/opt-price': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/stock-detail': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/opt-detail': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/search-contract-detail': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/search-opt-detail': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/inquire-asking-price': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/opt-asking-price': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/market-time': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/investor-unpd-trend': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/tick-ccnl': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/daily-ccnl': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/weekly-ccnl': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/monthly-ccnl': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/inquire-time-futurechartprice': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/opt-tick-ccnl': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/opt-daily-ccnl': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/opt-weekly-ccnl': { cost: 1 },
                        'uapi/overseas-futureoption/v1/quotations/opt-monthly-ccnl': { cost: 1 },
                        'uapi/domestic-bond/v1/quotations/inquire-price': { cost: 1 },
                        'uapi/domestic-bond/v1/quotations/inquire-asking-price': { cost: 1 },
                        'uapi/domestic-bond/v1/quotations/inquire-ccnl': { cost: 1 },
                        'uapi/domestic-bond/v1/quotations/inquire-daily-price': { cost: 1 },
                        'uapi/domestic-bond/v1/quotations/inquire-daily-itemchartprice': { cost: 1 },
                        'uapi/domestic-bond/v1/quotations/issue-info': { cost: 1 },
                        'uapi/domestic-bond/v1/quotations/search-bond-info': { cost: 1 },
                        'uapi/domestic-bond/v1/quotations/avg-unit': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/comp-program-trade-daily': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/comp-program-trade-today': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/estimate-perform': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-algo-ccnl': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-balance': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-balance-settlement-pl': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-balance-valuation-pl': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-ccnl': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-ccnl-bstime': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-daily-amount-fee': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-deposit': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-ngt-balance': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-ngt-ccnl': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-psbl-ngt-order': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/inquire-psbl-order': { cost: 1 },
                        'uapi/domestic-futureoption/v1/trading/ngt-margin-detail': { cost: 1 },
                        'uapi/domestic-bond/v1/trading/inquire-balance': { cost: 1 },
                        'uapi/domestic-bond/v1/trading/inquire-daily-ccld': { cost: 1 },
                        'uapi/domestic-bond/v1/trading/inquire-psbl-order': { cost: 1 },
                        'uapi/domestic-bond/v1/trading/inquire-psbl-rvsecncl': { cost: 1 },
                        'uapi/overseas-futureoption/v1/trading/inquire-ccld': { cost: 1 },
                        'uapi/overseas-futureoption/v1/trading/inquire-daily-ccld': { cost: 1 },
                        'uapi/overseas-futureoption/v1/trading/inquire-daily-order': { cost: 1 },
                        'uapi/overseas-futureoption/v1/trading/inquire-deposit': { cost: 1 },
                        'uapi/overseas-futureoption/v1/trading/inquire-period-ccld': { cost: 1 },
                        'uapi/overseas-futureoption/v1/trading/inquire-period-trans': { cost: 1 },
                        'uapi/overseas-futureoption/v1/trading/inquire-psamount': { cost: 1 },
                        'uapi/overseas-futureoption/v1/trading/inquire-unpd': { cost: 1 },
                        'uapi/overseas-futureoption/v1/trading/margin-detail': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/daily-credit-balance': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/daily-loan-trans': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/daily-short-sale': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-daily-trade-volume': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/investor-trend-estimate': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/frgnmem-pchs-trend': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-member-daily': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/program-trade-by-stock': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/foreign-institution-total': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/frgnmem-trade-estimate': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/capture-uplowprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/investor-program-trade-today': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/mktfunds': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/exp-price-trend': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/pbar-tratio': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/tradprt-byamt': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/intstock-grouplist': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/intstock-stocklist-by-group': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/psearch-title': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/psearch-result': { cost: 1 },
                        'uapi/domestic-stock/v1/finance/balance-sheet': { cost: 1 },
                        'uapi/domestic-stock/v1/finance/income-statement': { cost: 1 },
                        'uapi/domestic-stock/v1/finance/financial-ratio': { cost: 1 },
                        'uapi/domestic-stock/v1/finance/profit-ratio': { cost: 1 },
                        'uapi/domestic-stock/v1/finance/other-major-ratios': { cost: 1 },
                        'uapi/domestic-stock/v1/finance/stability-ratio': { cost: 1 },
                        'uapi/domestic-stock/v1/finance/growth-ratio': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/paidin-capin': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/bonus-issue': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/dividend': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/purreq': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/merger-split': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/rev-split': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/cap-dcrs': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/list-info': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/pub-offer': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/forfeit': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/mand-deposit': { cost: 1 },
                        'uapi/domestic-stock/v1/ksdinfo/sharehld-meet': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/credit-by-company': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/invest-opbysec': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/invest-opinion': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/news-title': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/search-info': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/lendable-by-company': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-index-price': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-index-daily-price': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-index-timeprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-index-tickprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-index-category-price': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/exp-index-trend': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/exp-total-index': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/comp-interest': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/market-time': { cost: 1 },
                        // 해외 순위
                        'uapi/overseas-stock/v1/ranking/market-cap': { cost: 1 },
                        'uapi/overseas-stock/v1/ranking/new-highlow': { cost: 1 },
                        'uapi/overseas-stock/v1/ranking/price-fluct': { cost: 1 },
                        'uapi/overseas-stock/v1/ranking/updown-rate': { cost: 1 },
                        'uapi/overseas-stock/v1/ranking/trade-vol': { cost: 1 },
                        'uapi/overseas-stock/v1/ranking/trade-pbmn': { cost: 1 },
                        'uapi/overseas-stock/v1/ranking/trade-growth': { cost: 1 },
                        'uapi/overseas-stock/v1/ranking/trade-turnover': { cost: 1 },
                        'uapi/overseas-stock/v1/ranking/volume-power': { cost: 1 },
                        'uapi/overseas-stock/v1/ranking/volume-surge': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/inquire-asking-price': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/price-detail': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/inquire-ccnl': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/inquire-daily-chartprice': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/inquire-time-indexchartprice': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/inquire-time-itemchartprice': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/industry-price': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/industry-theme': { cost: 1 },
                        'uapi/overseas-stock/v1/quotations/countries-holiday': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/brknews-title': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/news-title': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/inquire-search': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/colable-by-company': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/period-rights': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/rights-by-ice': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/search-info': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/chk-holiday': { cost: 1 },
                        // 국내 계좌
                        'uapi/domestic-stock/v1/trading/inquire-balance': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-psbl-order': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-daily-ccld': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-period-trade-profit': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-account-balance': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-balance-rlz-pl': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-credit-psamount': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-period-profit': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-psbl-sell': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/intgr-margin': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/order-resv-ccnl': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/period-rights': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/pension/inquire-balance': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/pension/inquire-daily-ccld': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/pension/inquire-deposit': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/pension/inquire-present-balance': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/pension/inquire-psbl-order': { cost: 1 },
                        // 해외 시세
                        'uapi/overseas-price/v1/quotations/price': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/dailyprice': { cost: 1 },
                        // 해외 계좌
                        'uapi/overseas-stock/v1/trading/inquire-balance': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-present-balance': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-ccnl': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-nccs': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/algo-ordno': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/foreign-margin': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-paymt-stdr-balance': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-period-profit': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-period-trans': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-psamount': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/order-resv-list': { cost: 1 },
                    },
                    post: {
                        'uapi/domestic-stock/v1/trading/order-cash': { cost: 1, order: true },
                        'uapi/domestic-stock/v1/trading/order-rvsecncl': { cost: 1, order: true },
                        'uapi/overseas-stock/v1/trading/order': { cost: 1, order: true },
                        'uapi/overseas-stock/v1/trading/order-rvsecncl': { cost: 1, order: true },
                        'uapi/domestic-stock/v1/trading/order-credit': { cost: 1, order: true },
                        'uapi/domestic-stock/v1/trading/order-resv': { cost: 1, order: true },
                        'uapi/domestic-stock/v1/trading/order-resv-rvsecncl': { cost: 1, order: true },
                        'uapi/overseas-stock/v1/trading/daytime-order': { cost: 1, order: true },
                        'uapi/overseas-stock/v1/trading/daytime-order-rvsecncl': { cost: 1, order: true },
                        'uapi/overseas-stock/v1/trading/order-resv': { cost: 1, order: true },
                        'uapi/overseas-stock/v1/trading/order-resv-ccnl': { cost: 1, order: true },
                        'uapi/domestic-futureoption/v1/trading/order': { cost: 1, order: true },
                        'uapi/domestic-futureoption/v1/trading/order-rvsecncl': { cost: 1, order: true },
                        'uapi/overseas-futureoption/v1/trading/order': { cost: 1, order: true },
                        'uapi/overseas-futureoption/v1/trading/order-rvsecncl': { cost: 1, order: true },
                        'uapi/domestic-bond/v1/trading/buy': { cost: 1, order: true },
                        'uapi/domestic-bond/v1/trading/sell': { cost: 1, order: true },
                        'uapi/domestic-bond/v1/trading/order-rvsecncl': { cost: 1, order: true },
                    },
                },
            },
            fees: {
                trading: {
                    tierBased: false,
                    percentage: true,
                    maker: KIS_BROKERAGE_FEE,
                    taker: KIS_BROKERAGE_FEE,
                },
            },
            precisionMode: TICK_SIZE,
            exceptions: { exact: { ...KIS_EXCEPTIONS_EXACT }, broad: {} },
            options: {
                // 조회 재시도. 시간 초과는 `fetch` 가 재시도 대상에서 뺀다.
                maxRetriesOnFailure: READ_RETRIES,
                maxRetriesOnFailureDelay: READ_RETRY_DELAY_MS,
                // 주문가능금액(`inquire-psbl-order`)은 종목을 지정해야 조회된다. 현금 주문가능액은 종목과 무관하므로 어느 상장 종목이든 좋다.
                orderableProbeCode: '005930',
                /** 토큰과 발급 락을 여러 프로세스가 나눠 쓰는 저장소(`BrokerTokenStore`). 없으면 프로세스 메모리 캐시만 쓴다. */
                tokenStore: undefined,
                /** 정규장 밖(NXT 프리·애프터) 주문과 시세를 연다. 불리언이거나 불리언을 돌려주는 함수다. 기본은 꺼짐. */
                nxtRouting: undefined,
                /** 종목 검색과 해외 거래소 판별에 쓰는 KIS 마스터 데이터(`KisMasterData`). 없으면 빈 데이터다. */
                masterData: undefined,
                /** 국내 종목의 KOSPI·KOSDAQ 구분을 알려 주는 곳(`BrokerStockDirectory`). 없으면 마스터 데이터로 판별한다. */
                stockDirectory: undefined,
                /** 체결 확정 조회의 예산. 한국투자증권은 이 옵션을 읽지 않는다. */
                confirmBudget: undefined,
            },
        });
    }

    // ============ 모의투자 ============

    /** 모의투자로 바꾼다. 도메인, TR ID, 호출 간격(초당 2건)이 모두 바뀌고 캐시한 토큰은 버린다. */
    override setSandboxMode(enabled: boolean): void {
        super.setSandboxMode(enabled);
        this.rateLimit = enabled ? SANDBOX_RATE_LIMIT_MS : REAL_RATE_LIMIT_MS;
        this.initRestRateLimiter();
        this.token = undefined;
        this.authState = undefined;
    }

    /**
     * 실전 TR ID 와 모의 TR ID 중 지금 모드의 것. 모의 ID 를 생략하면 실전 ID 의 첫 글자를 `V` 로 바꾼 것이다(`TTTC8434R` → `VTTC8434R`).
     * 모의투자를 지원하지 않는 TR 은 `null` 을 주면 `NotSupported` 를 던진다.
     */
    private tr(real: string, demo?: string | null): string {
        if (!this.isSandboxModeEnabled) return real;
        if (demo === null) throw new NotSupported(`${this.id} ${real} 는 모의투자를 지원하지 않는다`);
        return demo ?? 'V' + real.slice(1);
    }

    // ============ 요청 ============

    /** 앱키 단위 예약 스케줄러로 기다린다. 같은 프로세스의 같은 앱키는 인스턴스가 달라도 하나의 스케줄을 쓴다. */
    override async throttle(cost: Num = undefined, _bucket: Str = undefined): Promise<void> {
        await acquireKisSlot(this.apiKey ?? '', Math.ceil(this.rateLimit * (cost ?? 1)));
    }

    /**
     * 시간 초과는 조회에서도 다시 보내지 않는다. 응답이 20초 동안 없던 요청을 되풀이하면 최악의 대기가 몇 배로 늘고, 그동안 호출하는 쪽의
     * 다른 일이 모두 멈춘다.
     */
    override async fetch(
        url: string,
        method = 'GET',
        headers: Dictionary<string> | undefined = undefined,
        body: string | undefined = undefined,
        timeoutMs: number = this.timeout,
    ): Promise<any> {
        try {
            return await super.fetch(url, method, headers, body, timeoutMs);
        } catch (e) {
            if (e instanceof RequestTimeout && e.retryable === undefined) e.retryable = false;
            throw e;
        }
    }

    /**
     * 요청을 만든다. 비공개 호출은 `params.tr_id` 와 `params.tr_cont`(연속조회 다음 쪽)를 헤더로 옮기고 나머지는 GET 이면 쿼리로,
     * POST 이면 JSON 본문으로 보낸다. `tr_cont` 가 없으면 그 헤더를 싣지 않는다. 대문자 키(`CANO` 등)는 KIS 규격 그대로 둔다.
     */
    override sign(
        path: string,
        api: ApiName = 'public',
        method = 'GET',
        params: Dict = {},
        headers: Dictionary<string> | undefined = undefined,
        _body: string | undefined = undefined,
    ): SignedRequest {
        const apiName = Array.isArray(api) ? api[0] : api;
        const base = this.safeString(this.urls.api, apiName);
        if (base === undefined) throw new ExchangeError(`${this.id} sign() 에 쓸 urls.api 가 없다: ${apiName}`);
        let url = `${base}/${path}`;
        let query = params;
        const requestHeaders: Dictionary<string> = { 'Content-Type': 'application/json; charset=UTF-8' };
        if (this.isPrivateApi(api)) {
            const trId = this.safeString(params, 'tr_id');
            if (trId === undefined) throw new ArgumentsRequired(`${this.id} ${path} 호출에는 params.tr_id 가 필요하다`);
            const trCont = this.safeString(params, 'tr_cont');
            query = this.omit(params, ['tr_id', 'tr_cont']);
            Object.assign(requestHeaders, {
                authorization: `Bearer ${this.token}`,
                appkey: this.apiKey as string,
                appsecret: this.secret as string,
                tr_id: trId,
                custtype: KIS_CUSTOMER_TYPE,
            });
            if (trCont !== undefined) requestHeaders.tr_cont = trCont;
        }
        let body: string | undefined;
        if (method === 'GET') {
            const encoded = this.urlencode(query);
            if (encoded.length > 0) url += `?${encoded}`;
        } else {
            body = JSON.stringify(query);
        }
        return { url, method, headers: this.extend(requestHeaders, headers), body };
    }

    // ============ 인증 ============

    private authManager(): KISAuth {
        const appKey = this.apiKey as string;
        if (this.authState === undefined || this.authState.appKey !== appKey) {
            this.authState = {
                appKey,
                auth: new KISAuth(appKey, {
                    requestToken: () => this.requestAccessToken(),
                    requestApprovalKey: () => this.requestApprovalKey(),
                }, () => this.getTokenStore()),
            };
        }
        return this.authState.auth;
    }

    /** 비공개 호출 앞에서 접근 토큰을 준비한다. 캐시(프로세스 → 토큰 저장소)에 있으면 발급하지 않는다. */
    override async authenticate(): Promise<void> {
        this.token = await this.authManager().getAccessToken();
    }

    private async requestAccessToken(): Promise<{ accessToken: string; expiresInSec?: number }> {
        const request = this.sign('oauth2/tokenP', 'public', 'POST', {
            grant_type: 'client_credentials',
            appkey: this.apiKey,
            appsecret: this.secret,
        });
        const response = await this.fetch(request.url, request.method, request.headers, request.body, AUTH_TIMEOUT_MS);
        const accessToken = this.safeString(response, 'access_token');
        if (accessToken === undefined) throw new AuthenticationError(`${this.id} 토큰 발급 응답에 access_token 이 없다`);
        return { accessToken, expiresInSec: this.safeNumber(response, 'expires_in') };
    }

    /** 접속키 발급 본문은 `appsecret` 이 아니라 `secretkey` 를 쓴다. */
    private async requestApprovalKey(): Promise<string> {
        const request = this.sign('oauth2/Approval', 'public', 'POST', {
            grant_type: 'client_credentials',
            appkey: this.apiKey,
            secretkey: this.secret,
        });
        const response = await this.fetch(request.url, request.method, request.headers, request.body, AUTH_TIMEOUT_MS);
        const approvalKey = this.safeString(response, 'approval_key');
        if (approvalKey === undefined) throw new AuthenticationError(`${this.id} approval_key 응답에 approval_key 가 없다`);
        return approvalKey;
    }

    /** 토큰 캐시를 프로세스와 토큰 저장소에서 모두 지운다(재인증 강제). */
    async invalidateToken(): Promise<void> {
        this.token = undefined;
        await this.authState?.auth.invalidate();
    }

    /**
     * 실시간 시세 WebSocket 에 접속할 때 쓰는 접속키. 접근 토큰과 별개로 발급되는 세션 키다.
     * 접속 주소와 모의 여부는 `urls.ws`·`isSandboxModeEnabled` 로 알 수 있다.
     */
    async getApprovalKey(): Promise<string> {
        this.checkRequiredCredentials();
        return this.authManager().getApprovalKey();
    }

    /** 실시간 시세 스트림을 만든다. 이 인스턴스의 접속키와 모의 여부를 쓴다. 구독은 반환값의 `start(subs)` 로 시작한다. */
    createPriceStream(handlers: Pick<KisPriceWsOptions, 'onTrade' | 'onOrderbook' | 'onSubscribeError'> = {}): KisPriceWs {
        return new KisPriceWs({
            getApprovalKey: () => this.getApprovalKey(),
            isVirtual: this.isSandboxModeEnabled,
            url: this.realtimeUrl(),
            ...handlers,
        });
    }

    /**
     * 범용 실시간 구독. 어떤 실시간 TR 이든 `subscribe(trId, trKey)`로 구독하고 `unsubscribe`로 해지한다. 수신 값은 공식 예제의 필드 순서로
     * 이름을 붙여 원문 문자열 그대로 `onRecord`에 넘긴다. 체결통보 TR 의 구독 키는 HTS ID 이고, 모의투자 체결통보는 `H0STCNI9`, `H0GSCNI9`다.
     * 기존 `createPriceStream`(체결, 호가를 가격으로 해석)은 그대로 둔다.
     */
    createRealtimeStream(
        onRecord: (record: KisRealtimeRecord) => void, onSubscribeError: ((trId: string, trKey: string, message: string) => void) | undefined = undefined,
    ): KisRealtimeStream {
        return new KisRealtimeStream({
            getApprovalKey: () => this.getApprovalKey(), isVirtual: this.isSandboxModeEnabled, url: this.realtimeUrl(), onRecord, onSubscribeError,
        });
    }

    /** 실시간 접속 주소. `urls.ws`(모의는 `urls.wsTest`)의 `public` 에 경로를 붙인다. 사용하는 쪽이 `urls` 로 바꿀 수 있다. */
    private realtimeUrl(): string | undefined {
        const base = this.safeString(this.isSandboxModeEnabled ? this.urls.wsTest : this.urls.ws, 'public');
        return base === undefined ? undefined : base + KIS_WS_PATH;
    }

    // ============ 실시간(ccxt pro) ============
    //
    // `createRealtimeStream` 위에 ccxt pro 의 `watch*` 를 둔다. 호출마다 다음 갱신을 돌려주고, 처음 부를 때 구독한다. 체결은 기다리는 쪽이
    // 없을 때 쌓아 두었다가 다음 호출에 한꺼번에 돌려준다. 같은 앱키와 접속키로 다른 프로그램이 이미 연결돼 있으면 KIS 가 이 연결을 곧바로
    // 끊는다.

    private watchStream: KisRealtimeStream | undefined;
    private readonly watchHub = new WatchHub();
    /** 구독 키(`005930`, `DNASAAPL`) → 통합 심볼 */
    private readonly watchKeys = new Map<string, string>();
    /** 체결통보로 쌓은 주문 상태(주문번호 → 주문). 통보는 한 건씩 오므로 누적 체결 수량을 여기서 더한다 */
    private readonly watchOrderState = new Map<string, Order>();
    /** 원주문에 반영한 정정·취소 통보의 주문번호. 같은 번호로 통보가 다시 와도 한 번만 반영한다 */
    private readonly watchRevisionIds = new Set<string>();
    /** `watchOrders`가 기다리는 해시(`orders`, `orders:<심볼>`). 체결통보 구독이 거부되면 모두 거절한다 */
    private readonly watchOrderHashes = new Set<string>(['orders']);

    private ensureWatchStream(): KisRealtimeStream {
        this.watchStream ??= this.createRealtimeStream(
            (record) => this.onWatchRecord(record),
            (trId, trKey, message) => {
                const symbol = this.watchKeys.get(trKey);
                const hashes = symbol === undefined ? [...this.watchOrderHashes] : [`ticker:${symbol}`, `trades:${symbol}`, `orderbook:${symbol}`];
                this.watchHub.reject(new ExchangeError(`${this.id} 실시간 구독이 거부됐다 ${trId} ${trKey}: ${message}`), hashes);
            },
        );
        return this.watchStream;
    }

    /** 종목의 체결(`trade`)이나 호가(`book`) TR 을 구독하고 통합 심볼을 돌려준다. 국내는 NXT 통합 시세를 쓸 때 통합 TR 이다. */
    private async watchSubscribe(symbol: string, kind: 'trade' | 'book'): Promise<string> {
        const instrument = this.instrumentOf(symbol);
        let trId: string;
        let key: string;
        if (instrument.overseas) {
            if (instrument.quoteExchange === undefined) throw new BadSymbol(`${this.id} 실시간 구독에 쓸 해외 거래소를 모른다: ${symbol}`);
            trId = kind === 'trade' ? 'HDFSCNT0' : 'HDFSASP0';
            key = `D${instrument.quoteExchange}${instrument.code}`;
        } else {
            const integrated = (await this.quoteMarketDivision()) === 'UN';
            trId = kind === 'trade' ? (integrated ? 'H0UNCNT0' : 'H0STCNT0') : (integrated ? 'H0UNASP0' : 'H0STASP0');
            key = instrument.code;
        }
        this.watchKeys.set(key, instrument.symbol);
        this.ensureWatchStream().subscribe(trId, key);
        return instrument.symbol;
    }

    /** 다음 시세. 국내는 체결 TR 이 시가, 고가, 저가, 누적거래량까지 준다. 해외는 지연체결가(`HDFSCNT0`)다. */
    async watchTicker(symbol: string, params: Dict = {}): Promise<Ticker> {
        return await this.watchHub.next<Ticker>(`ticker:${await this.watchSubscribe(symbol, 'trade')}`, params.signal);
    }

    /** 새 체결. 지난 호출 뒤로 받은 체결을 한꺼번에 돌려준다. */
    async watchTrades(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        const trades = await this.watchHub.nextBatch<Trade>(`trades:${await this.watchSubscribe(symbol, 'trade')}`, params.signal);
        return this.filterBySinceLimit(trades as unknown as Dict[], since, limit, 'timestamp', true) as unknown as Trade[];
    }

    /** 다음 호가. 국내는 10단계, 해외 지연호가는 1단계다. */
    async watchOrderBook(symbol: string, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        const book = await this.watchHub.next<OrderBook>(`orderbook:${await this.watchSubscribe(symbol, 'book')}`, params.signal);
        return limit === undefined ? book : { ...book, bids: book.bids.slice(0, limit), asks: book.asks.slice(0, limit) };
    }

    /**
     * 주문 변화(체결통보). 국내(`H0STCNI0`)와 해외(`H0GSCNI0`) 체결통보를 구독한다. 모의투자는 `H0STCNI9`, `H0GSCNI9`다. 구독 키가 HTS ID 라
     * `options.htsId` 가 필요하다. 통보 필드 해석은 공식 예제의 설명을 따랐고 실계좌로는 확인하지 못했다.
     */
    async watchOrders(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        const htsId = this.htsId('watchOrders');
        const stream = this.ensureWatchStream();
        stream.subscribe(this.isSandboxModeEnabled ? 'H0STCNI9' : 'H0STCNI0', htsId);
        stream.subscribe(this.isSandboxModeEnabled ? 'H0GSCNI9' : 'H0GSCNI0', htsId);
        const hash = symbol === undefined ? 'orders' : `orders:${this.instrumentOf(symbol).symbol}`;
        this.watchOrderHashes.add(hash);
        const orders = await this.watchHub.nextBatch<Order>(hash, params.signal);
        return this.filterBySinceLimit(orders as unknown as Dict[], since, limit, 'timestamp', true) as unknown as Order[];
    }

    /** 실시간 연결을 닫고 기다리던 `watch*` 를 거절한다. */
    override async close(): Promise<void> {
        this.watchStream?.stop();
        this.watchStream = undefined;
        this.watchKeys.clear();
        this.watchOrderState.clear();
        this.watchRevisionIds.clear();
        this.watchHub.reject(new ExchangeClosedByUser(`${this.id} 실시간 연결을 닫았다`));
    }

    private onWatchRecord(record: KisRealtimeRecord): void {
        const f = record.fields;
        if (f === undefined) return;
        const num = (key: string): number | undefined => this.safeNumber(f, key);
        switch (record.trId) {
            case 'H0STCNT0':
            case 'H0UNCNT0': {
                const symbol = this.watchKeys.get(f.mksc_shrn_iscd) ?? `${f.mksc_shrn_iscd}/KRW`;
                const stamp = this.kstStamp(f.bsop_date, f.stck_cntg_hour);
                // 체결구분은 1 매수, 5 매도다(KRX 는 `ccld_dvsn`, 통합은 `cntg_cls_code`).
                const sideCode = f.ccld_dvsn ?? f.cntg_cls_code;
                this.watchHub.resolve(`ticker:${symbol}`, this.safeTicker({
                    symbol, ...stamp, last: num('stck_prpr'), open: num('stck_oprc'), high: num('stck_hgpr'), low: num('stck_lwpr'),
                    bid: num('bidp1'), ask: num('askp1'), bidVolume: num('bidp_rsqn1'), askVolume: num('askp_rsqn1'), change: num('prdy_vrss'),
                    percentage: num('prdy_ctrt'), vwap: num('wghn_avrg_stck_prc'), baseVolume: num('acml_vol'), quoteVolume: num('acml_tr_pbmn'), info: f,
                }));
                this.watchHub.push(`trades:${symbol}`, this.safeTrade({
                    symbol, ...stamp, price: num('stck_prpr'), amount: num('cntg_vol'), side: sideCode === '1' ? 'buy' : sideCode === '5' ? 'sell' : undefined, info: f,
                }));
                return;
            }
            case 'H0STASP0':
            case 'H0UNASP0': {
                const symbol = this.watchKeys.get(f.mksc_shrn_iscd) ?? `${f.mksc_shrn_iscd}/KRW`;
                const levels = (price: string, size: string): Array<[number, number]> => Array.from({ length: 10 }, (_, i): [number, number] => [
                    num(`${price}${i + 1}`) ?? 0, num(`${size}${i + 1}`) ?? 0,
                ]).filter(([p]) => p > 0);
                // 호가 프레임에는 일자가 없다. 방금 받은 호가라 오늘(한국 날짜)이다.
                const stamp = this.kstStamp(kstYmd(this.milliseconds()), f.bsop_hour);
                this.watchHub.resolve(`orderbook:${symbol}`, this.safeOrderBook({
                    symbol, timestamp: stamp.timestamp, datetime: stamp.datetime, bids: levels('bidp', 'bidp_rsqn'), asks: levels('askp', 'askp_rsqn'),
                }));
                return;
            }
            case 'HDFSCNT0': {
                const symbol = this.watchKeys.get(f.rsym) ?? `${f.symb}/USD`;
                // 해외 체결에는 현지 일시(`xymd`, `xhms`)와 한국 일시(`kymd`, `khms`)가 함께 온다.
                const stamp = this.kstStamp(f.kymd, f.khms);
                this.watchHub.resolve(`ticker:${symbol}`, this.safeTicker({
                    symbol, ...stamp, last: num('last'), open: num('open'), high: num('high'), low: num('low'), bid: num('pbid'), ask: num('pask'),
                    bidVolume: num('vbid'), askVolume: num('vask'), change: num('diff'), percentage: num('rate'), baseVolume: num('tvol'), quoteVolume: num('tamt'),
                    info: f,
                }));
                this.watchHub.push(`trades:${symbol}`, this.safeTrade({ symbol, ...stamp, price: num('last'), amount: num('evol'), info: f }));
                return;
            }
            case 'HDFSASP0': {
                const symbol = this.watchKeys.get(f.rsym) ?? `${f.symb}/USD`;
                const stamp = this.kstStamp(f.kymd, f.khms);
                const bid = num('pbid1');
                const ask = num('pask1');
                this.watchHub.resolve(`orderbook:${symbol}`, this.safeOrderBook({
                    symbol, timestamp: stamp.timestamp, datetime: stamp.datetime,
                    bids: bid !== undefined && bid > 0 ? [[bid, num('vbid1') ?? 0]] : [], asks: ask !== undefined && ask > 0 ? [[ask, num('vask1') ?? 0]] : [],
                }));
                return;
            }
            case 'H0STCNI0':
            case 'H0STCNI9':
            case 'H0GSCNI0':
            case 'H0GSCNI9':
                this.onOrderNotice(record.trId, f);
                return;
            default:
                return;
        }
    }

    /**
     * 체결통보 한 건을 주문으로 쌓는다. 체결여부(`cntg_yn`) 2 가 체결 통보이고 1 은 접수·정정·취소·거부 통보다. 매도매수구분은 01 매도, 02 매수,
     * 정정구분(`rctf_cls`)은 1 정정, 2 취소이고 거부여부(`rfus_yn`)는 1 이 거부다. 체결수량(`cntg_qty`)과 체결단가(`cntg_unpr`) 자리에는 체결 통보면
     * 체결 값이, 접수 통보면 주문(정정, 취소) 수량과 단가가 온다(공식 예제의 필드 설명).
     */
    private onOrderNotice(trId: string, f: Record<string, string>): void {
        const id = f.oder_no;
        if (!id) return;
        const overseas = trId.startsWith('H0GS');
        const code = f.stck_shrn_iscd ?? '';
        const symbol = overseas ? this.instrumentOf(code).symbol : `${code}/KRW`;
        const stamp = this.kstStamp(kstYmd(this.milliseconds()), f.stck_cntg_hour);
        const positive = (key: string): number | undefined => {
            const value = this.safeNumber(f, key);
            return value !== undefined && value > 0 ? value : undefined;
        };
        const executed = f.cntg_yn === '2';
        const rejected = f.rfus_yn === '1';
        const quantity = positive('cntg_qty');
        // 해외 체결단가는 소수점 없이 오면 미국 종목 기준 소수 넷째 자리까지다(공식 예제: 001480100 은 148.01).
        const unitPrice = f.cntg_unpr === undefined || f.cntg_unpr === '' ? undefined
            : overseas && !f.cntg_unpr.includes('.') ? Precise.stringDiv(f.cntg_unpr, '10000') : f.cntg_unpr;
        // 정정·취소 통보의 `ooder_no` 는 원주문번호로 본다(필드 이름과 공식 예제 설명에 기댄 추정이다).
        const original = !executed && !rejected && (f.rctf_cls === '1' || f.rctf_cls === '2') && f.ooder_no ? f.ooder_no : undefined;
        if (original !== undefined) {
            if (!this.watchRevisionIds.has(id)) {
                this.watchRevisionIds.add(id);
                this.reduceWatchOrder(original, quantity ?? positive('oder_qty'), symbol, stamp, f);
            }
            // 취소 통보의 주문번호는 취소 요청의 번호라 주문으로 쌓지 않는다. 정정 통보의 주문번호는 새 주문이다.
            if (f.rctf_cls === '2') return;
        }
        const previous = this.watchOrderState.get(id);
        const fill = executed ? quantity ?? 0 : 0;
        const amount = positive('oder_qty') ?? (executed ? undefined : quantity) ?? previous?.amount;
        const previousFilled = previous?.filled ?? 0;
        const filled = previousFilled + fill;
        const before = previous?.remaining ?? (amount === undefined ? undefined : amount - previousFilled);
        const remaining = before === undefined ? undefined : Math.max(before - fill, 0);
        // 체결 금액은 체결 통보의 체결단가로 쌓는다. 앞선 체결의 금액을 모르면 쌓지 않는다.
        const previousCost = previousFilled === 0 ? '0' : previous?.cost === undefined ? undefined : numberToString(previous.cost);
        const cost = fill === 0 ? previousCost
            : previousCost === undefined || unitPrice === undefined ? undefined : Precise.stringAdd(previousCost, Precise.stringMul(numberToString(fill), unitPrice));
        const status = rejected ? 'rejected'
            : f.rctf_cls === '2' ? 'canceled'
                : remaining !== undefined && remaining <= 0 ? 'closed' : 'open';
        const order = this.safeOrder({
            id, symbol, ...stamp, side: f.seln_byov_cls === '01' ? 'sell' : f.seln_byov_cls === '02' ? 'buy' : undefined, amount, filled, remaining, cost,
            price: this.safeNumber(f, 'oder_prc') ?? (executed ? undefined : this.parseNumber(unitPrice)) ?? previous?.price, status,
            lastTradeTimestamp: fill > 0 ? stamp.timestamp : previous?.lastTradeTimestamp, trades: [], info: f,
        });
        this.watchOrderState.set(id, order);
        this.watchHub.push('orders', order);
        this.watchHub.push(`orders:${symbol}`, order);
    }

    /**
     * 정정·취소 통보를 원주문에 반영한다. 정정·취소 수량만큼 잔량을 줄이고, 잔량이 남지 않으면 `canceled` 다(정정한 수량은 새 주문번호로 옮겨 간다).
     * 줄일 수량이나 원주문의 잔량을 모르면 잔량을 모두 줄인 것으로 본다.
     */
    private reduceWatchOrder(id: string, quantity: number | undefined, symbol: string, stamp: KrTimestamped, f: Record<string, string>): void {
        const previous = this.watchOrderState.get(id);
        const before = previous?.remaining ?? (previous?.amount === undefined ? undefined : previous.amount - (previous.filled ?? 0));
        const remaining = before === undefined || quantity === undefined ? 0 : Math.max(before - quantity, 0);
        const order = this.safeOrder({
            id, symbol: previous?.symbol ?? symbol, ...stamp,
            side: previous?.side ?? (f.seln_byov_cls === '01' ? 'sell' : f.seln_byov_cls === '02' ? 'buy' : undefined),
            amount: previous?.amount, filled: previous?.filled, remaining, cost: previous?.cost, price: previous?.price,
            status: remaining > 0 ? 'open' : 'canceled', lastTradeTimestamp: previous?.lastTradeTimestamp, trades: [], info: f,
        });
        this.watchOrderState.set(id, order);
        this.watchHub.push('orders', order);
        this.watchHub.push(`orders:${order.symbol}`, order);
    }

    // ============ 오류 ============

    /**
     * 응답의 오류 봉투를 오류 클래스로 던진다. KIS 는 업무 오류를 HTTP 200 과 `rt_cd !== '0'` 로 주고, 초당 거래건수 초과는 HTTP 500 에 실어 온다.
     * 상태 코드보다 봉투를 먼저 읽는다. 비-2xx 로 오는 업무 코드를 버리면 재발급·재시도 판단을 코드로 할 수 없다.
     */
    override handleErrors(
        statusCode: number,
        _statusText: string,
        url: string,
        _method: string,
        responseHeaders: Dictionary<string>,
        responseBody: string,
        response: unknown,
        _requestHeaders: Dictionary<string> | undefined,
        _requestBody: string | undefined,
    ): boolean | undefined {
        const isAuthRequest = url.includes('/oauth2/');
        const trCont = Object.entries(responseHeaders).find(([key]) => key.toLowerCase() === 'tr_cont')?.[1];
        if (trCont !== undefined && response !== null && typeof response === 'object') this.trContOf.set(response, trCont);
        const msgCd = this.safeString2(response, 'msg_cd', 'error_code');
        // 인증 실패가 확실할 때만 토큰 캐시를 버린다. 아무 500 에나 붙이면 발급이 남발되고, 토큰 발급은 분당 1회 제한이다.
        if (!isAuthRequest && (statusCode === 401 || statusCode === 403 || msgCd === 'EGW00123')) this.dropToken(statusCode, msgCd);
        if (response === null || typeof response !== 'object' || Array.isArray(response)) return undefined;
        const rtCd = this.safeString(response, 'rt_cd');
        const msg = this.safeString2(response, 'msg1', 'error_description');
        const businessFailure = rtCd !== undefined && rtCd !== '0';
        const httpFailure = statusCode >= 400 && msgCd !== undefined;
        if (!businessFailure && !httpFailure) return undefined;
        let feedback: string;
        if (isAuthRequest) feedback = `KIS 토큰 발급 실패: ${statusCode} ${responseBody}`;
        else if (statusCode >= 400) feedback = `KIS API 오류: ${statusCode} [${msgCd}] ${msg}`;
        else feedback = `KIS API 비즈니스 오류 [${msgCd}]: ${msg}`;
        const exceptions = this.exceptions as { exact?: Dictionary<any>; broad?: Dictionary<any> };
        // 증권사 오류 코드는 어떤 오류 클래스로 던지든 `detail` 에 남긴다. 표에 없는 코드도 호출하는 쪽이 코드를 그대로 볼 수 있어야 한다.
        const options = { detail: msgCd?.trim() };
        this.throwExactlyMatchedException(exceptions.exact, msgCd?.trim(), feedback, options);
        this.throwBroadlyMatchedException(exceptions.broad, msg, feedback, options);
        throw new ExchangeError(feedback, options);
    }

    private dropToken(statusCode: number, msgCd: Str): void {
        logger.warn({ statusCode, msgCd }, '[kis] 인증 실패 — 토큰 캐시를 무효화한다. 다음 호출에서 재발급한다');
        this.invalidateToken().catch((err: unknown) => logger.warn({ err }, '[kis] 토큰 캐시 무효화 실패'));
    }

    // ============ 종목 ============

    /**
     * 종목 마스터 데이터(`options.masterData`)로 종목 목록을 만든다. 국내(KOSPI·KOSDAQ)와 미국(나스닥·뉴욕·아멕스)이 들어 있다.
     * `params.market` 으로 `'domestic'` 이나 `'overseas'` 만 받을 수 있다.
     */
    override async fetchMarkets(params: Dict = {}): Promise<MarketInterface[]> {
        const which = this.safeString(params, 'market', 'all');
        const rows: Dict[] = [];
        if (which !== 'overseas') rows.push(...searchKRXStocks(this.master(), undefined, Math.max(getStockMasterCount(this.master()), 1)));
        if (which !== 'domestic') rows.push(...searchOverseasStocks(this.master(), undefined, Number.MAX_SAFE_INTEGER));
        return this.parseMarkets(rows);
    }

    /** 마스터 행 하나를 종목으로 옮긴다. 해외 마스터 행은 `currency` 를 갖고 국내 행은 갖지 않는다. */
    override parseMarket(market: Dict): MarketInterface {
        const id = this.safeString(market, 'code');
        if (id === undefined) throw new ExchangeError(`${this.id} parseMarket() missing code`);
        const overseas = this.safeString(market, 'currency') !== undefined || !isKrxDomesticCode(id);
        const quote = overseas ? 'USD' : 'KRW';
        const base = id.replace('/', '.');
        const exchangeCode = this.safeString(market, 'market');
        return this.safeMarketStructure({
            id,
            symbol: `${base}/${quote}`,
            base,
            quote,
            baseId: id,
            quoteId: quote,
            settle: undefined,
            settleId: undefined,
            type: 'spot',
            spot: true,
            margin: false,
            swap: false,
            future: false,
            option: false,
            active: true,
            contract: false,
            linear: undefined,
            inverse: undefined,
            taker: overseas ? KIS_OVERSEAS_DEFAULT_FEE_RATE : KIS_BROKERAGE_FEE,
            maker: overseas ? KIS_OVERSEAS_DEFAULT_FEE_RATE : KIS_BROKERAGE_FEE,
            contractSize: undefined,
            expiry: undefined,
            expiryDatetime: undefined,
            strike: undefined,
            optionType: undefined,
            // 국내 호가 단위는 가격대별이라 하나의 값으로 적을 수 없다. `priceToPrecision` 이 표를 쓴다. 미국은 0.01 달러다.
            precision: { amount: 1, price: overseas ? 0.01 : undefined },
            limits: {
                leverage: { min: undefined, max: undefined },
                amount: { min: 1, max: undefined },
                price: { min: undefined, max: undefined },
                cost: { min: undefined, max: undefined },
            },
            created: undefined,
            info: market,
            options: { exchange: exchangeCode, orderExchange: overseas ? this.orderExchangeOfQuote(exchangeCode) : undefined },
        });
    }

    private orderExchangeOfQuote(quoteExchange: Str): OverseasOrderMarket | undefined {
        return quoteExchange === undefined ? undefined : toOrderMarketCode(quoteExchange as OverseasMarket);
    }

    /**
     * 가격을 호가 단위에 맞춘 문자열. 국내 일반 주식은 가격대별 호가 단위 표(2천원 미만 1원 … 50만원 이상 1천원)로 반올림한다.
     * ETF·ETN 은 표가 달라서 손대지 않고 그대로 돌려준다. 미국은 0.01 달러 단위다.
     */
    override priceToPrecision(symbol: Str, price: number | string | undefined): Str {
        if (price === undefined) return undefined;
        const instrument = this.instrumentOf(symbol as string);
        if (instrument.overseas) return decimalToPrecision(price, ROUND, 0.01, TICK_SIZE, NO_PADDING);
        const securityType = getKRXStockByCode(this.master(), instrument.code)?.securityType;
        if (securityType !== undefined && securityType !== 'STOCK') return numberToString(price);
        return decimalToPrecision(price, ROUND, getTickSize(Number(price)), TICK_SIZE, NO_PADDING);
    }

    /** 심볼(또는 종목코드)을 종목 식별 결과로 바꾼다. 국내는 마스터 없이도 되고, 해외는 마스터에서 거래소를 찾는다. */
    private instrumentOf(symbol: string): KisInstrument {
        const suffixed = /^(.+)\/(KRW|USD)$/.exec(symbol);
        const base = (suffixed ? suffixed[1] : symbol).trim();
        if (isKrxDomesticCode(base)) {
            return { symbol: `${base}/KRW`, code: base, overseas: false, quote: 'KRW', quoteExchange: undefined, orderExchange: undefined };
        }
        // 통합 심볼의 점(`BRK.B`)을 KIS 표기의 슬래시(`BRK/B`)로 돌린다. 마스터가 그 표기를 가질 때만 바꾼다.
        const upper = base.toUpperCase();
        const slashed = upper.replace('.', '/');
        const master = this.master();
        const code = getOverseasStockByCode(master, upper) === undefined && getOverseasStockByCode(master, slashed) !== undefined ? slashed : upper;
        const quoteExchange = getOverseasMarketForCode(master, code);
        return {
            symbol: `${code.replace('/', '.')}/USD`,
            code,
            overseas: true,
            quote: 'USD',
            quoteExchange,
            orderExchange: quoteExchange === undefined ? undefined : toOrderMarketCode(quoteExchange),
        };
    }

    /** `loadMarkets()` 로 받은 종목이 있으면 그것을, 없으면 마스터 행(또는 모양)으로 종목을 만든다. */
    /**
     * 종목. `loadMarkets` 로 받은 종목에 있으면 그것을, 없으면 심볼 모양으로 만든 종목을 돌려준다. 시세와 주문 메서드와 같은 판별이라
     * 마스터 데이터 없이도 `amountToPrecision` 같은 도우미가 동작한다. 해외 종목은 마스터 데이터가 없으면 상장 거래소를 모르는 종목이 된다.
     */
    override market(symbol: Str): MarketInterface {
        if (symbol !== undefined && this.markets !== undefined && (this.markets[symbol] !== undefined || this.markets_by_id?.[symbol] !== undefined)) {
            return super.market(symbol);
        }
        if (symbol === undefined) return super.market(symbol);
        return this.marketOf(this.instrumentOf(symbol));
    }

    private marketOf(instrument: KisInstrument): MarketInterface {
        const known = this.markets?.[instrument.symbol];
        if (known !== undefined) return known;
        const row: Dict = instrument.overseas
            ? (getOverseasStockByCode(this.master(), instrument.code) ?? { code: instrument.code, currency: 'USD' })
            : (getKRXStockByCode(this.master(), instrument.code) ?? { code: instrument.code });
        return this.parseMarket(row);
    }

    private accountParams(): { CANO: string; ACNT_PRDT_CD: string } {
        const [prefix, suffix] = (this.uid ?? '').split('-');
        return { CANO: prefix ?? '', ACNT_PRDT_CD: suffix || KIS_DEFAULT_ACCOUNT_SUFFIX };
    }

    /**
     * 연속조회로 모든 쪽의 응답을 받는다. 응답 헤더 `tr_cont` 가 `F`·`M` 이면 요청 헤더 `tr_cont: N` 과 응답의 연속조회 키(`keys` 의 소문자 필드)로
     * 다음 쪽을 부른다(공식 예제 `examples_llm` 의 규칙이고 실전과 모의가 같다). `maxPages` 쪽을 넘으면 일부만 돌려주지 않고 `BadResponse` 를 던진다.
     */
    private async fetchAllPages(
        method: (params: Dict) => Promise<any>,
        request: Dict,
        keys: readonly string[],
        maxPages: number = MAX_CONTINUATION_PAGES,
    ): Promise<Dict[]> {
        const pages: Dict[] = [];
        let params = request;
        for (;;) {
            const response = await method(params);
            pages.push(response);
            const trCont = this.trContOf.get(response);
            if (trCont !== 'F' && trCont !== 'M') return pages;
            if (pages.length >= maxPages) throw new BadResponse(`${this.id} 연속조회가 ${maxPages}쪽을 넘는다`);
            params = { ...request, tr_cont: 'N' };
            for (const key of keys) params[key] = this.safeString(response, key.toLowerCase(), '');
        }
    }

    /** 이 인스턴스의 종목 마스터 데이터(`options.masterData`). 넘기지 않았으면 빈 데이터다. */
    private master(): KisMasterData {
        return masterDataOf(this.options);
    }

    /** 국내 시세 조회의 상품구분. `nxtRouting` 옵션이 켜져 있고 NXT 확장세션이면 통합(`UN`)으로 애프터마켓 시세를 받는다. */
    private async quoteMarketDivision(): Promise<QuoteMarketDivision> {
        return isNxtExtendedTradable() && await this.isOptionEnabled('nxtRouting') ? 'UN' : 'J';
    }

    // ============ 시세 ============

    /**
     * 현재가. 호가는 채우지 않는다(`bid`·`ask` 는 `undefined`). 현재가 응답에 호가가 없고, 호가를 함께 받으려면 호출이 한 번 더 든다.
     * 실제 호가는 `fetchOrderBook` 이 준다. 현재가가 0 이거나 비어 있으면 `NullResponse` 를 던진다. 장 마감·지연시세·휴장에 빈 값이 오는데
     * 0 을 현재가로 넘기면 호출하는 쪽의 손익이 -100% 로 표시된다.
     */
    override async fetchTicker(symbol: string, params: Dict = {}): Promise<Ticker> {
        const instrument = this.instrumentOf(symbol);
        const market = this.marketOf(instrument);
        let response: Dict;
        if (instrument.overseas) {
            if (instrument.quoteExchange === undefined) throw new BadSymbol(`해외 마스터에 없는 ticker: ${symbol}`);
            response = await this.privateGetUapiOverseasPriceV1QuotationsPrice(this.extend({
                AUTH: '',
                EXCD: instrument.quoteExchange,
                SYMB: instrument.code,
                tr_id: 'HHDFS00000300',
            }, params));
        } else {
            response = await this.privateGetUapiDomesticStockV1QuotationsInquirePrice(this.extend({
                FID_COND_MRKT_DIV_CODE: await this.quoteMarketDivision(),
                FID_INPUT_ISCD: instrument.code,
                tr_id: 'FHKST01010100',
            }, params));
        }
        const output = this.safeDict(response, 'output', {}) as Dict;
        const last = Number(this.safeString(output, instrument.overseas ? 'last' : 'stck_prpr'));
        if (!Number.isFinite(last) || last <= 0) {
            throw new NullResponse(`${this.id} ${symbol} 현재가가 0 이거나 비어 있다`);
        }
        return this.parseTicker(output, market);
    }

    override parseTicker(ticker: Dict, market: Market = undefined): Ticker {
        const timestamp = this.milliseconds();
        if (market?.quote === 'USD') {
            const last = this.safeString(ticker, 'last');
            const previousClose = Precise.stringGt(this.safeString(ticker, 'base'), '0') ? this.safeString(ticker, 'base') : undefined;
            return this.safeTicker({
                symbol: market.symbol,
                timestamp,
                datetime: this.iso8601(timestamp),
                high: this.safeString(ticker, 'high'),
                low: this.safeString(ticker, 'low'),
                open: this.safeString(ticker, 'open'),
                close: last,
                last,
                previousClose,
                // 절대 변동은 전일 종가가 있으면 그것으로 구한다. 응답에는 부호가 따로 있어 `diff` 를 그대로 쓰지 않는다.
                change: previousClose !== undefined ? Precise.stringSub(last, previousClose) : undefined,
                percentage: this.safeString(ticker, 'rate'),
                baseVolume: this.safeString(ticker, 'tvol'),
                quoteVolume: this.safeString(ticker, 'tamt'),
                info: ticker,
            }, market);
        }
        const last = this.safeString(ticker, 'stck_prpr');
        const percentage = this.safeString(ticker, 'prdy_ctrt');
        // 전일대비(`prdy_vrss`)는 부호가 없을 수 있어 등락률의 부호로 정한다. 보합(등락률 0)이면 변동도 0이다.
        const change = signedChange(this.safeString(ticker, 'prdy_vrss'), percentage, this.safeString(ticker, 'prdy_vrss_sign'));
        return this.safeTicker({
            symbol: market?.symbol,
            timestamp,
            datetime: this.iso8601(timestamp),
            high: this.safeString(ticker, 'stck_hgpr'),
            low: this.safeString(ticker, 'stck_lwpr'),
            open: this.safeString(ticker, 'stck_oprc'),
            close: last,
            last,
            previousClose: this.safeString(ticker, 'stck_sdpr'),
            change,
            percentage,
            baseVolume: this.safeString(ticker, 'acml_vol'),
            quoteVolume: this.safeString(ticker, 'acml_tr_pbmn'),
            info: ticker,
        }, market);
    }

    /**
     * 여러 종목의 현재가를 한 번에 받는다(`intstock-multprice`, TR `FHKST11300006`). 한 번에 최대 30종목까지다(공식 문서 상한).
     * 국내만 지원한다(공식 API 목록에 해외 멀티 시세가 없다). 이 API는 시장구분에 NXT 통합(`UN`)을 문서에 적어 두지 않아서,
     * `fetchTicker` 와 달리 NXT 확장세션 시세를 섞지 않고 항상 KRX(`J`)로 묻는다.
     */
    override async fetchTickers(symbols: Strings = undefined, params: Dict = {}): Promise<Tickers> {
        if (symbols === undefined || symbols.length === 0) throw new ArgumentsRequired(`${this.id} fetchTickers() 는 symbols 인자가 필요하다`);
        if (symbols.length > MULTI_TICKER_LIMIT) throw new BadRequest(`${this.id} fetchTickers() 는 한 번에 최대 ${MULTI_TICKER_LIMIT}종목까지 지원한다: ${symbols.length}종목`);
        const instruments = symbols.map((symbol) => {
            const instrument = this.instrumentOf(symbol);
            if (instrument.overseas) throw new BadSymbol(`${this.id} fetchTickers() 은 국내 종목만 지원한다: ${symbol}`);
            return instrument;
        });
        const byCode = new Map(instruments.map((instrument) => [instrument.code, instrument]));
        const request: Dict = { tr_id: 'FHKST11300006' };
        instruments.forEach((instrument, i) => {
            request[`FID_COND_MRKT_DIV_CODE_${i + 1}`] = 'J';
            request[`FID_INPUT_ISCD_${i + 1}`] = instrument.code;
        });
        const response = await this.privateGetUapiDomesticStockV1QuotationsIntstockMultprice(this.extend(request, params));
        const result: Tickers = {};
        for (const row of rowsOf(this.safeValue(response, 'output'))) {
            const instrument = byCode.get(this.safeString(row, 'inter_shrn_iscd', ''));
            if (instrument === undefined) continue;
            const market = this.marketOf(instrument);
            const ticker = this.parseTicker({
                stck_prpr: row['inter2_prpr'],
                stck_hgpr: row['inter2_hgpr'],
                stck_lwpr: row['inter2_lwpr'],
                stck_oprc: row['inter2_oprc'],
                stck_sdpr: row['inter2_sdpr'],
                prdy_vrss: row['inter2_prdy_vrss'],
                prdy_ctrt: row['prdy_ctrt'],
                acml_vol: row['acml_vol'],
                acml_tr_pbmn: row['acml_tr_pbmn'],
            }, market);
            result[market.symbol] = ticker;
        }
        return result;
    }

    /**
     * 국내 호가 10단계(잔량 포함). 매수는 높은 가격부터, 매도는 낮은 가격부터 정렬한다. 미국 종목은 지원하지 않는다.
     * 호가가 하나도 없으면 `NullResponse` 를 던진다.
     */
    override async fetchOrderBook(symbol: string, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        const instrument = this.instrumentOf(symbol);
        if (instrument.overseas) throw new NotSupported(`${this.id} fetchOrderBook() 은 국내 종목만 지원한다: ${symbol}`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireAskingPriceExpCcn(this.extend({
            FID_COND_MRKT_DIV_CODE: await this.quoteMarketDivision(),
            FID_INPUT_ISCD: instrument.code,
            tr_id: 'FHKST01010200',
        }, params));
        const output = this.safeDict(response, 'output1', {}) as Dict;
        const bids: Array<[Num, Num]> = [];
        const asks: Array<[Num, Num]> = [];
        for (let level = 1; level <= 10; level++) {
            const askPrice = Number(output[`askp${level}`]);
            if (Number.isFinite(askPrice) && askPrice > 0) asks.push([askPrice, toNumber(output[`askp_rsqn${level}`])]);
            const bidPrice = Number(output[`bidp${level}`]);
            if (Number.isFinite(bidPrice) && bidPrice > 0) bids.push([bidPrice, toNumber(output[`bidp_rsqn${level}`])]);
        }
        if (bids.length === 0 && asks.length === 0) throw new NullResponse(`${this.id} ${symbol} 호가가 비어 있다`);
        const book = this.safeOrderBook({ symbol: instrument.symbol, timestamp: this.milliseconds(), bids, asks });
        if (limit !== undefined) {
            book.bids = book.bids.slice(0, limit);
            book.asks = book.asks.slice(0, limit);
        }
        return book;
    }

    /**
     * 캔들. 국내는 항상 야후 파이낸스로 받는다(KIS 는 분봉이 당일뿐이고 일봉도 100행이라 과거 이력이 모자란다). 미국 일봉·주봉·월봉은 야후를
     * 먼저 부르고, 야후가 비거나 실패하면 KIS 로 다시 받는다. 둘 다 실패하면 던진다.
     *
     * `since <= 시각 <= params.until` 인 봉을 ccxt 규칙대로 `limit` 개 준다(`since` 가 있으면 가장 이른 것부터, 없으면 가장 최근 것부터).
     * `since` 가 없으면 야후의 타임프레임별 기본 기간(일봉 5년, 1분봉 1일 등) 안에서 고른다. 야후 분봉과 시간봉은 조회 폭 상한(1분봉 6일,
     * 5분봉~30분봉 59일, 시간봉 729일)보다 오래된 `since` 를 상한까지 줄여 받고 경고를 남긴다.
     */
    override async fetchOHLCV(symbol: string, timeframe = '1d', since: Int = undefined, limit: Int = 100, params: Dict = {}): Promise<OHLCV[]> {
        const instrument = this.instrumentOf(symbol);
        const until = this.safeInteger(params, 'until');
        // KOSPI/KOSDAQ 구분으로 야후 티커의 접미사(.KS/.KQ)를 정확히 붙인다.
        const krMarket = await resolveKrMarket(symbol, { stockDirectory: this.options.stockDirectory, masterData: this.master() });
        const dailyLike = ['1d', '1w', '1W', '1M'].includes(timeframe);
        // 폴백할 거래소. 자격증명이 없으면 KIS 로 폴백할 수 없다.
        const fallbackExchange = instrument.overseas && dailyLike && this.checkRequiredCredentials(false) ? instrument.quoteExchange : undefined;
        let yahoo: OHLCV[] = [];
        let yahooError: unknown;
        try {
            yahoo = await fetchYahooCandles(instrument.symbol, timeframe, limit, since, until, krMarket) as OHLCV[];
        } catch (e) {
            if (fallbackExchange === undefined) throw e;
            yahooError = e;
        }
        if (yahoo.length > 0 || fallbackExchange === undefined) return yahoo;
        logger.info({ symbol, timeframe, yahooError: yahooError === undefined ? undefined : String(yahooError) }, '[kis] 야후가 비거나 실패해 KIS 해외 일봉으로 폴백한다');
        const native = await this.candles().fetchOverseasDailyOHLCV(instrument.code, fallbackExchange, timeframe, limit ?? 100, since, until);
        if (native.length === 0 && yahooError !== undefined) throw yahooError;
        return native as OHLCV[];
    }

    /** KIS 가 직접 주는 캔들(일봉·당일 분봉·해외 일봉)과 심층 이력 페이지네이션. `fetchOHLCV` 는 미국 일봉 폴백에만 이 경로를 쓴다. */
    candles(): KISCandleService {
        this.candleService ??= new KISCandleService(this);
        return this.candleService;
    }

    // ============ 잔고 ============

    /**
     * 잔고. 현금은 통화 키(`KRW`, `USD`), 보유 종목은 종목코드(국내 `005930`, 미국 `AAPL`) 키이며 종목의 `total` 이 보유 수량이다.
     * 평가금액·평균단가 같은 KIS 고유 값은 각 항목의 `info` 에 원본 그대로 있다. 조회가 하나라도 실패하면 던진다(빈 잔고와 구분한다).
     *
     * `params.scope` 로 읽을 범위를 좁힌다. 기본은 전부(`'all'`)이고 배열로 골라도 된다.
     * - `'kr'`: 국내 잔고(`inquire-balance`). `KRW` 와 국내 보유 종목
     * - `'us'`: 미국 보유 종목(`inquire-balance`). 실전은 `NASD` 한 번이 미국 전체이고, 모의는 거래소마다 따로 부른다
     * - `'usd'`: 달러 예수금과 평가금액(`inquire-present-balance`). `USD`
     *
     * `params.orderable` 이 `false` 가 아니면 국내 주문가능현금(`inquire-psbl-order`)을 한 번 더 조회해 `KRW.free` 로 쓴다.
     * 끄면 `KRW.free` 는 비어 있다. 원본 응답은 `balances.info` 에 `{ domestic, overseas, usd }` 로 담는다.
     */
    override async fetchBalance(params: Dict = {}): Promise<Balances> {
        const scope = this.safeValue(params, 'scope', 'all');
        // 모르는 범위를 조용히 건너뛰면 요청 없이 빈 잔고가 나온다.
        const scopes = Array.isArray(scope) ? scope : [scope];
        if (scopes.length === 0 || scopes.some((name) => !['all', 'kr', 'us', 'usd'].includes(name))) {
            throw new BadRequest(`${this.id} fetchBalance() params.scope 는 'all', 'kr', 'us', 'usd' 또는 그 배열이다: ${JSON.stringify(scope)}`);
        }
        const wants = (name: string): boolean => scopes.includes('all') || scopes.includes(name);
        const orderable = this.safeBool(params, 'orderable', true);
        const raw: Dict = {};
        if (wants('kr')) raw.domestic = await this.fetchDomesticBalanceRaw(orderable);
        if (wants('us')) raw.overseas = await this.fetchOverseasHoldingsRaw();
        if (wants('usd')) raw.usd = await this.fetchPresentBalanceRaw();
        return this.parseBalance(raw);
    }

    private async fetchDomesticBalanceRaw(orderable: boolean): Promise<Dict> {
        const pages = await this.fetchAllPages(this.privateGetUapiDomesticStockV1TradingInquireBalance, {
            ...this.accountParams(),
            AFHR_FLPR_YN: 'N',
            OFL_YN: '',
            INQR_DVSN: '02',
            UNPR_DVSN: '01',
            FUND_STTL_ICLD_YN: 'N',
            FNCG_AMT_AUTO_RDPT_YN: 'N',
            PRCS_DVSN: '01',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            tr_id: this.tr('TTTC8434R'),
        }, ['CTX_AREA_FK100', 'CTX_AREA_NK100']);
        // 합계(`output2`)는 계좌 전체 값이라 첫 쪽 것을 쓴다. 쪽마다 같은 값이 온다는 것은 추정이다.
        const raw: Dict = { holdings: pages.flatMap((page) => rowsOf(page.output1)), summary: firstRow(pages[0].output2) };
        if (orderable) {
            // 주문가능금액은 잔고 응답의 `ord_psbl_amt` 가 아니라 매수가능조회의 `ord_psbl_cash` 를 쓴다(공식 응답 필드에 `ord_psbl_amt` 가 없다).
            // 시장가(`01`)로 물으면 종목 증거금율이 반영된다.
            const psbl = await this.privateGetUapiDomesticStockV1TradingInquirePsblOrder({
                ...this.accountParams(),
                PDNO: this.safeString(this.options, 'orderableProbeCode', '005930'),
                ORD_UNPR: '0',
                ORD_DVSN: KIS_ORDER_TYPE.MARKET,
                CMA_EVLU_AMT_ICLD_YN: 'N',
                OVRS_ICLD_YN: 'N',
                tr_id: this.tr('TTTC8908R'),
            });
            raw.orderable = firstRow(psbl.output);
        }
        return raw;
    }

    /**
     * 미국 보유 종목. 실전은 `NASD` 가 미국 전체이므로 한 번만 부른다. 모의는 `NASD`·`NYSE`·`AMEX` 를 차례로 부른다.
     * 거래소마다 연속조회를 끝낸 뒤 다음 거래소로 간다(Python 판과 요청 순서가 같다).
     */
    private async fetchOverseasHoldingsRaw(): Promise<Dict> {
        const exchanges: OverseasOrderMarket[] = this.isSandboxModeEnabled ? ['NASD', 'NYSE', 'AMEX'] : ['NASD'];
        const holdings: Dict[] = [];
        for (const exchange of exchanges) {
            const pages = await this.fetchAllPages(this.privateGetUapiOverseasStockV1TradingInquireBalance, {
                ...this.accountParams(),
                OVRS_EXCG_CD: exchange,
                TR_CRCY_CD: 'USD',
                CTX_AREA_FK200: '',
                CTX_AREA_NK200: '',
                tr_id: this.tr('TTTS3012R'),
            }, ['CTX_AREA_FK200', 'CTX_AREA_NK200']);
            holdings.push(...pages.flatMap((page) => rowsOf(page.output1)));
        }
        return { holdings };
    }

    private async fetchPresentBalanceRaw(): Promise<Dict> {
        const response = await this.privateGetUapiOverseasStockV1TradingInquirePresentBalance({
            ...this.accountParams(),
            WCRC_FRCR_DVSN_CD: KIS_PRESENT_BALANCE_PARAMS.WCRC_FRCR_DVSN_FOREIGN,
            NATN_CD: KIS_PRESENT_BALANCE_PARAMS.NATN_US,
            TR_MKET_CD: KIS_PRESENT_BALANCE_PARAMS.TR_MKET_ALL,
            INQR_DVSN_CD: KIS_PRESENT_BALANCE_PARAMS.INQR_DVSN_ALL,
            tr_id: this.tr('CTRP6504R'),
        });
        return { stocks: rowsOf(response.output1), currencies: rowsOf(response.output2) };
    }

    /**
     * `fetchBalance` 가 모은 원본(`{ domestic?, overseas?, usd? }`)을 통합 잔고로 옮긴다.
     *
     * - `KRW`: `total`=예수금총액(`dnca_tot_amt`), `free`=주문가능현금(`ord_psbl_cash`), `used`=둘의 차이(0 밑으로 내려가지 않는다)
     * - `USD`: `total`=예수금, `free`=예수금에서 미결제 매수증거금을 뺀 값. 종목 평가금액 합계는 `info.stockValue` 에 있다.
     * - 종목: `total`=보유수량, `free`=주문가능수량(없으면 보유수량). 같은 종목이 매매구분이나 대출일자별로 여러 행이면 수량을 더한다.
     *   `info` 는 첫 행이고, `info.rows` 에 원문 행 전부가 있다.
     */
    override parseBalance(response: Dict): Balances {
        const result: Dict = { info: response, timestamp: undefined, datetime: undefined };
        const domestic = this.safeDict(response, 'domestic');
        if (domestic !== undefined) {
            const summary = this.safeDict(domestic, 'summary', {}) as Dict;
            const orderable = this.safeDict(domestic, 'orderable');
            const total = this.safeString(summary, 'dnca_tot_amt');
            const free = orderable === undefined ? undefined : this.safeString(orderable, 'ord_psbl_cash');
            result.KRW = {
                free,
                used: free !== undefined && total !== undefined ? nonNegative(Precise.stringSub(total, free)) : undefined,
                total,
                info: { summary, orderable },
            };
            for (const item of rowsOf(domestic.holdings)) this.addHolding(result, item, 'pdno', 'hldg_qty');
        }
        const overseas = this.safeDict(response, 'overseas');
        if (overseas !== undefined) {
            for (const item of rowsOf(overseas.holdings)) this.addHolding(result, item, 'ovrs_pdno', 'ovrs_cblc_qty');
        }
        const usd = this.safeDict(response, 'usd');
        if (usd !== undefined) {
            const cash = rowsOf(usd.currencies).find((row) => (this.safeString(row, 'crcy_cd') ?? '').toUpperCase() === 'USD') ?? {};
            // 금액은 문자열로 더하고 뺀다. `Number` 로 빼면 `1000.1 - 200.2` 가 `799.9000000000001` 이 된다.
            const deposit = this.safeString(cash, 'frcr_dncl_amt_2') ?? '0';
            const buyMargin = this.safeString(cash, 'frcr_buy_mgn_amt') ?? '0';
            const stockValue = rowsOf(usd.stocks)
                .filter((row) => (this.safeString(row, 'buy_crcy_cd') ?? 'USD').toUpperCase() === 'USD')
                .reduce((sum, row) => Precise.stringAdd(sum, this.safeString(row, 'frcr_evlu_amt2') ?? '0') ?? sum, '0');
            const free = nonNegative(Precise.stringSub(deposit, buyMargin));
            result.USD = {
                free,
                used: nonNegative(Precise.stringSub(deposit, free)),
                total: deposit,
                info: { deposit: toNumber(deposit), buyMargin: toNumber(buyMargin), stockValue: toNumber(stockValue), currencies: usd.currencies, stocks: usd.stocks },
            };
        }
        return this.safeBalance(result);
    }

    /** 보유 행 하나를 더한다. 같은 종목의 행(매매구분, 대출일자별)은 수량을 합치고 원문 행은 `info.rows` 에 모은다. */
    private addHolding(result: Dict, item: Dict, codeKey: string, quantityKey: string): void {
        const code = this.safeString(item, codeKey);
        const quantity = this.safeString(item, quantityKey);
        if (code === undefined || quantity === undefined || !(Number(quantity) > 0)) return;
        const free = this.safeString(item, 'ord_psbl_qty', quantity) as string;
        const current = result[code] as { free: string; total: string; info: Dict & { rows: Dict[] } } | undefined;
        result[code] = current === undefined
            ? { free, used: undefined, total: quantity, info: { ...item, rows: [item] } }
            : {
                free: Precise.stringAdd(current.free, free),
                used: undefined,
                total: Precise.stringAdd(current.total, quantity),
                info: { ...current.info, rows: [...current.info.rows, item] },
            } as Dict;
    }

    // ============ 주문 ============

    /**
     * 주문. 수량은 정수 주로 내린다(소수점 매수는 지원하지 않는다). 거래시간 밖은 주문을 보내지 않고 `MarketClosed` 를 던진다.
     *
     * `params`:
     * - `session`: `'regular'` 이나 `'nxt'`. 다른 값은 `BadRequest` 다. 생략하면 `options.nxtRouting` 과 NXT 확장세션 시각으로 자동 판정한다(국내).
     *   `'nxt'` 는 NXT 프리마켓(08:00~08:50), 메인마켓(09:00~15:20), 애프터마켓(15:30~20:00)에만 낸다. 그 밖의 시각과 휴장일은 `MarketClosed` 다.
     *   확장세션이면 종목이 NXT 에서 거래되는지 먼저 확인하고, 아니면 `MarketClosed` 를 던진다(실전만).
     * - 그 밖의 키는 요청 본문에 그대로 합친다.
     *
     * 국내 시장가는 `ORD_DVSN=01`, 지정가는 `00` 이다. 미국은 지정가만 낼 수 있고, 실전에서 `market` 을 주면 장마감지정가(LOC)로 낸다.
     * 두 경우 모두 미국은 `price` 가 필요하다. 응답은 접수 결과이므로 체결은 알 수 없다(`filled` 가 비어 있다). 체결은 `fetchOrder`·`fetchMyTrades` 로 확인한다.
     */
    override async createOrder(symbol: string, type: OrderType, side: OrderSide, amount: number, price: Num = undefined, params: Dict = {}): Promise<Order> {
        const instrument = this.instrumentOf(symbol);
        const quantity = this.normalizeQuantity(instrument, side, amount);
        if (instrument.overseas) {
            // 지정가·LOC 모두 단가가 필요하다. 시장가를 의도했다면 호출하는 쪽이 현재가 기반 지정가를 넣어야 한다.
            if (price === undefined || !(price > 0)) {
                throw new ArgumentsRequired('해외 지정가/LOC 주문은 price 필수 (시장가 의도면 현재가 기반 지정가 필요)');
            }
            this.checkOrderArguments(undefined, type, side, quantity, price, params);
            return this.createOverseasOrder(instrument, type, side, quantity, price, params);
        }
        this.checkOrderArguments(undefined, type, side, quantity, price, params);
        return this.createDomesticOrder(instrument, type, side, quantity, price, params);
    }

    /**
     * 주문 수량을 정수 주로 맞춘다. 0 이하·비정상은 던지고, 소수는 내림한다(내림하면 0 이 되는 경우도 던진다). 소수점 주문이 조용히 잘리면
     * 호출하는 쪽의 수량 계산이 5~10% 어긋나므로 내림한 사실을 경고로 남긴다.
     */
    private normalizeQuantity(instrument: KisInstrument, side: OrderSide, requested: number): number {
        if (!Number.isFinite(requested) || requested <= 0) {
            throw new InvalidOrder(`${this.id} 주문 수량 비정상: ${requested} (${instrument.symbol} ${side})`);
        }
        const floored = Math.floor(requested);
        if (floored <= 0) {
            throw new InvalidOrder(`${this.id} 주문 수량 floor 후 0: ${requested} → ${floored} (${instrument.symbol} ${side})`);
        }
        if (floored !== requested) {
            logger.warn({ requested, floored, lost: requested - floored, symbol: instrument.symbol, side }, '[kis] 분수 주문을 내림한다 (단주 거래)');
        }
        return floored;
    }

    private async createDomesticOrder(instrument: KisInstrument, type: OrderType, side: OrderSide, quantity: number, price: Num, params: Dict): Promise<Order> {
        const session = this.safeString(params, 'session');
        if (session !== undefined && session !== 'regular' && session !== 'nxt') {
            throw new BadRequest(`${this.id} createOrder() 의 params.session 은 'regular' 이나 'nxt' 여야 한다: ${session}`);
        }
        params = this.omit(params, 'session');
        // 확장세션(NXT 프리 08:00~08:50, 애프터 15:30~20:00)은 정규장 게이트 대신 NXT 게이트를 거쳐 SOR 로 낸다. `nxtRouting` 옵션이 꺼져 있으면 정규장 규칙이다.
        const extended = session === 'nxt'
            || (session === undefined && (await this.isOptionEnabled('nxtRouting')) && isNxtExtendedTradable());
        if (extended) {
            await this.assertNxtSessionOpen();
            await this.assertNxtTradable(instrument);
        }
        let limitPrice = type === 'limit' ? price : undefined;
        if (!extended) {
            await this.assertDomesticSessionOpen(side);
        } else if (limitPrice === undefined) {
            limitPrice = await this.extendedSessionLimitPrice(instrument.symbol, side);
        }
        const buy = side === 'buy';
        const trIds = extended ? DOMESTIC_ORDER_TR.extended : DOMESTIC_ORDER_TR.regular;
        const [realTr, demoTr] = buy ? trIds.buy : trIds.sell;
        const request: Dict = {
            ...this.accountParams(),
            PDNO: instrument.code,
            ORD_DVSN: limitPrice !== undefined ? KIS_ORDER_TYPE.LIMIT : KIS_ORDER_TYPE.MARKET,
            ORD_QTY: String(quantity),
            ORD_UNPR: limitPrice !== undefined ? String(limitPrice) : '0',
            tr_id: this.tr(realTr, demoTr),
        };
        if (extended) {
            request.EXCG_ID_DVSN_CD = 'SOR'; // KIS 최선집행 라우팅. NXT 에서 체결될 수 있다.
            request.SLL_TYPE = buy ? '' : '01'; // 매도유형: 01 일반매도(매수는 공란)
            request.CNDT_PRIC = ''; // 조건가격(스톱지정가)은 쓰지 않는다
        }
        const response = await this.privatePostUapiDomesticStockV1TradingOrderCash(this.extend(request, params));
        return this.acceptedOrder(response, this.marketOf(instrument), limitPrice !== undefined ? 'limit' : 'market', side, quantity, limitPrice);
    }

    /**
     * 스탑지정가(국내만). 같은 주문 엔드포인트(`order-cash`)에 조건가격(`CNDT_PRIC`)을 실어 보낸다 — 이 필드가 있으면 KIS 가
     * 이 주문을 스탑지정가로 처리한다(공식 예제 `order_cash.py`의 인자 설명 "조건가격 (스탑지정가호가 주문 시 사용)"으로 확인했다).
     * 지정가만 지원한다. 정규장 시간에만 낼 수 있다(확장세션은 조사하지 않았다). 해외는 대응하는 API를 찾지 못해 `NotSupported`를 던진다.
     */
    override async createTriggerOrder(
        symbol: string, type: OrderType, side: OrderSide, amount: number, price: Num = undefined, triggerPrice: Num = undefined, params: Dict = {},
    ): Promise<Order> {
        if (triggerPrice === undefined) throw new ArgumentsRequired(`${this.id} createTriggerOrder() 는 triggerPrice 인자가 필요하다`);
        if (price === undefined) throw new ArgumentsRequired(`${this.id} createTriggerOrder() 는 price 인자가 필요하다(스탑지정가는 지정가만 지원한다)`);
        const instrument = this.instrumentOf(symbol);
        if (instrument.overseas) throw new NotSupported(`${this.id} createTriggerOrder() 은 국내 종목만 지원한다: ${symbol}`);
        const quantity = this.normalizeQuantity(instrument, side, amount);
        this.checkOrderArguments(undefined, type, side, quantity, price, params);
        await this.assertDomesticSessionOpen(side);
        const buy = side === 'buy';
        const [realTr, demoTr] = buy ? DOMESTIC_ORDER_TR.extended.buy : DOMESTIC_ORDER_TR.extended.sell;
        const request: Dict = {
            ...this.accountParams(),
            PDNO: instrument.code,
            ORD_DVSN: KIS_ORDER_TYPE.LIMIT,
            ORD_QTY: String(quantity),
            ORD_UNPR: String(price),
            EXCG_ID_DVSN_CD: 'KRX',
            SLL_TYPE: buy ? '' : '01',
            CNDT_PRIC: String(triggerPrice),
            tr_id: this.tr(realTr, demoTr),
        };
        const response = await this.privatePostUapiDomesticStockV1TradingOrderCash(this.extend(request, params));
        return this.acceptedOrder(response, this.marketOf(instrument), 'limit', side, quantity, price);
    }

    /**
     * 국내 종목 상세(`search-stock-info`). 지금은 `assertNxtTradable`이 NXT 거래 여부 두 필드만 내부에서 읽는데, 여기서는
     * 같은 응답을 전부 정리해 공개한다. 국내만 지원한다(공식 API 목록에 해외 종목 상세가 없다). 종목마다 요청을 하나씩 보낸다
     * (KIS API에 여러 종목을 한 번에 묻는 방법이 없다). 하나라도 실패하면 나머지도 보류하고 그 오류를 던진다.
     */
    async fetchStocks(symbols: string[], params: Dict = {}): Promise<KisStockInfo[]> {
        return Promise.all(symbols.map((symbol) => this.fetchStockInfo(symbol, params)));
    }

    private async fetchStockInfo(symbol: string, params: Dict): Promise<KisStockInfo> {
        const instrument = this.instrumentOf(symbol);
        if (instrument.overseas) throw new BadSymbol(`${this.id} fetchStocks() 은 국내 종목만 지원한다: ${symbol}`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsSearchStockInfo(this.extend({
            PRDT_TYPE_CD: STOCK_INFO_PRODUCT_TYPE,
            PDNO: instrument.code,
            tr_id: 'CTPF1002R',
        }, params));
        const output = this.safeDict(response, 'output', {}) as Dict;
        return {
            symbol: instrument.symbol,
            name: this.safeString(output, 'prdt_name', ''),
            abbreviatedName: this.safeString(output, 'prdt_abrv_name', ''),
            exchangeCode: this.safeString(output, 'excg_dvsn_cd', ''),
            kospiListedAt: this.safeString(output, 'scts_mket_lstg_dt') || undefined,
            kospiDelistedAt: this.safeString(output, 'scts_mket_lstg_abol_dt') || undefined,
            kosdaqListedAt: this.safeString(output, 'kosdaq_mket_lstg_dt') || undefined,
            kosdaqDelistedAt: this.safeString(output, 'kosdaq_mket_lstg_abol_dt') || undefined,
            delistedAt: this.safeString(output, 'lstg_abol_dt') || undefined,
            tradingHalted: this.safeString(output, 'tr_stop_yn') === 'Y',
            administrativeIssue: this.safeString(output, 'admn_item_yn') === 'Y',
            nxtTradable: this.safeString(output, 'cptt_trad_tr_psbl_yn') === 'Y',
            nxtTradingHalted: this.safeString(output, 'nxt_tr_stop_yn') === 'Y',
            info: response,
        };
    }

    /**
     * 변동성완화장치(VI) 발동 현황(`inquire-vi-status`). 오늘(한국 날짜) 이 종목의 VI 가 발동한 기록을 돌려준다. 조회일은 늘 오늘이고 `params.until`은 읽지 않는다.
     * 발동한 적이 없으면 빈 배열이다. 국내만 지원한다(공식 API 목록에 해외 종목 VI 조회가 없다).
     *
     * 토스가 함께 주는 유의사항 여섯 종류 중 발동 기록은 VI 만 준다. 정리매매, 단기과열, 시장경고의 현재 상태는 `fetchStockStatus`에 있다.
     */
    async fetchStockWarnings(symbol: string, params: Dict = {}): Promise<KisStockWarning[]> {
        const instrument = this.instrumentOf(symbol);
        if (instrument.overseas) throw new BadSymbol(`${this.id} fetchStockWarnings() 은 국내 종목만 지원한다: ${symbol}`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireViStatus(this.extend({
            FID_DIV_CLS_CODE: '0',
            FID_COND_SCR_DIV_CODE: VI_STATUS_SCREEN_CODE,
            FID_MRKT_CLS_CODE: '0',
            FID_INPUT_ISCD: instrument.code,
            FID_RANK_SORT_CLS_CODE: '0',
            FID_INPUT_DATE_1: kstYmd(this.milliseconds()),
            FID_TRGT_CLS_CODE: '',
            FID_TRGT_EXLS_CLS_CODE: '',
            tr_id: 'FHPST01390000',
        }, params));
        return multiRowsOf(this.safeValue(response, 'output')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'bsop_date')),
            businessDate: this.safeString(row, 'bsop_date', ''),
            statusCode: this.safeString(row, 'vi_cls_code', ''),
            kindCode: this.safeString(row, 'vi_kind_code', ''),
            triggeredAt: this.safeString(row, 'cntg_vi_hour') || undefined,
            canceledAt: this.safeString(row, 'vi_cncl_hour') || undefined,
            price: this.safeNumber(row, 'vi_prc'),
            count: this.safeNumber(row, 'vi_count'),
            info: row,
        }));
    }

    /**
     * 종목의 투자자별(개인·외국인·기관계) 매매동향(`inquire-investor`)을 최근 영업일 순으로 돌려준다. 국내만 지원한다
     * (공식 API 목록에 해외 종목 투자자 매매동향이 없다). 당일 값은 장 종료 후에 채워진다(공식 문서 유의사항).
     *
     * 토스의 같은 이름 메서드는 시장(KOSPI·KOSDAQ) 단위인데, 이 메서드는 종목 단위다 — 범위가 다르다.
     */
    async fetchInvestorTrading(symbol: string, params: Dict = {}): Promise<KisInvestorTradingRecord[]> {
        const instrument = this.instrumentOf(symbol);
        if (instrument.overseas) throw new BadSymbol(`${this.id} fetchInvestorTrading() 은 국내 종목만 지원한다: ${symbol}`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireInvestor(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: instrument.code,
            tr_id: 'FHKST01010900',
        }, params));
        const amounts = (row: Dict, prefix: string): KisInvestorAmounts => ({
            netBuyVolume: this.safeNumber(row, `${prefix}_ntby_qty`),
            netBuyAmount: this.safeNumber(row, `${prefix}_ntby_tr_pbmn`),
            buyVolume: this.safeNumber(row, `${prefix}_shnu_vol`),
            buyAmount: this.safeNumber(row, `${prefix}_shnu_tr_pbmn`),
            sellVolume: this.safeNumber(row, `${prefix}_seln_vol`),
            sellAmount: this.safeNumber(row, `${prefix}_seln_tr_pbmn`),
        });
        return multiRowsOf(this.safeValue(response, 'output')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            businessDate: this.safeString(row, 'stck_bsop_date', ''),
            close: this.safeNumber(row, 'stck_clpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            changeSign: this.safeString(row, 'prdy_vrss_sign') || undefined,
            individual: amounts(row, 'prsn'),
            foreign: amounts(row, 'frgn'),
            institution: amounts(row, 'orgn'),
            info: row,
        }));
    }

    /** 국내 종목만 받는 조회의 종목. 해외 심볼이면 `BadSymbol`이다. */
    private domesticInstrument(symbol: string, method: string): KisInstrument {
        const instrument = this.instrumentOf(symbol);
        if (instrument.overseas) throw new BadSymbol(`${this.id} ${method}() 은 국내 종목만 지원한다: ${symbol}`);
        return instrument;
    }

    private tradeTick(row: Dict, priceKey: string, volumeKey: string): KisTradeTick {
        return {
            time: this.safeString(row, 'stck_cntg_hour', ''),
            price: this.safeNumber(row, priceKey),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, volumeKey),
            cumulativeVolume: this.safeNumber(row, 'acml_vol'),
            strength: this.safeNumber(row, 'tday_rltv'),
            ask: this.safeNumber(row, 'askp'),
            bid: this.safeNumber(row, 'bidp'),
            info: row,
        };
    }

    /** 최근 체결(`inquire-ccnl`, TR `FHKST01010300`). 국내만 지원한다. 시장구분은 `fetchTicker`와 같다(`nxtRouting` 옵션과 NXT 확장세션이면 통합). */
    async fetchTradeTicks(symbol: string, params: Dict = {}): Promise<KisTradeTick[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchTradeTicks');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireCcnl(this.extend({
            FID_COND_MRKT_DIV_CODE: await this.quoteMarketDivision(),
            FID_INPUT_ISCD: code,
            tr_id: 'FHKST01010300',
        }, params));
        return multiRowsOf(this.safeValue(response, 'output')).map((row) => this.tradeTick(row, 'stck_prpr', 'cntg_vol'));
    }

    /**
     * 기준 시각(`params.until`, 없으면 지금) 이전의 체결(`inquire-time-itemconclusion`, TR `FHPST01060000`). 국내만 지원한다. 행은 `output2`다.
     *
     * 체결가는 응답의 `stck_prpr`를 읽고, 없으면 공식 문서가 적은 `stck_pbpr`를 읽는다.
     */
    async fetchTradeTicksBefore(symbol: string, params: Dict = {}): Promise<KisTradeTick[]> {
        const [until, query] = this.handleUntilParam('fetchTradeTicksBefore', undefined, params);
        const { code } = this.domesticInstrument(symbol, 'fetchTradeTicksBefore');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireTimeItemconclusion(this.extend({
            FID_COND_MRKT_DIV_CODE: await this.quoteMarketDivision(),
            FID_INPUT_ISCD: code,
            FID_INPUT_HOUR_1: kstHms(until ?? this.milliseconds()),
            tr_id: 'FHPST01060000',
        }, query));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => this.tradeTick(row, 'stck_prpr' in row ? 'stck_prpr' : 'stck_pbpr', 'cnqn'));
    }

    /** 시간외 단일가 체결(`inquire-time-overtimeconclusion`, TR `FHPST02310000`). 국내만 지원한다. 시간구분은 설명에 있는 유일한 값 `1`(시간외)이다. */
    async fetchOvertimeTradeTicks(symbol: string, params: Dict = {}): Promise<KisTradeTick[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchOvertimeTradeTicks');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireTimeOvertimeconclusion(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_HOUR_CLS_CODE: '1',
            tr_id: 'FHPST02310000',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => this.tradeTick(row, 'stck_prpr', 'cntg_vol'));
    }

    /**
     * 시간외 단일가 현재가(`inquire-overtime-price`, TR `FHPST02300000`)를 통합 `Ticker`로 돌려준다. 국내만 지원한다.
     * 가격, 대비, 거래량은 모두 시간외 단일가 값이다. 대비가 무엇에 대한 것인지 문서가 "전일 대비"라고만 적어서 `previousClose`는 채우지 않는다.
     * 0 이하 가격은 체결가나 호가가 아니므로 비운다.
     */
    async fetchOvertimeTicker(symbol: string, params: Dict = {}): Promise<Ticker> {
        const instrument = this.domesticInstrument(symbol, 'fetchOvertimeTicker');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireOvertimePrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: instrument.code,
            tr_id: 'FHPST02300000',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const price = (key: string): Str => (toNumber(output[key]) > 0 ? this.safeString(output, key) : undefined);
        const percentage = this.safeString(output, 'ovtm_untp_prdy_ctrt');
        const timestamp = this.milliseconds();
        return this.safeTicker({
            symbol: instrument.symbol,
            timestamp,
            datetime: this.iso8601(timestamp),
            high: price('ovtm_untp_hgpr'),
            low: price('ovtm_untp_lwpr'),
            open: price('ovtm_untp_oprc'),
            close: price('ovtm_untp_prpr'),
            last: price('ovtm_untp_prpr'),
            bid: price('bidp'),
            ask: price('askp'),
            // 대비(`ovtm_untp_prdy_vrss`)는 부호가 없을 수 있어 `fetchTicker`처럼 부호를 따로 정한다.
            change: signedChange(this.safeString(output, 'ovtm_untp_prdy_vrss'), percentage, this.safeString(output, 'ovtm_untp_prdy_vrss_sign')),
            percentage,
            baseVolume: this.safeString(output, 'ovtm_untp_vol'),
            quoteVolume: this.safeString(output, 'ovtm_untp_tr_pbmn'),
            info: output,
        }, this.marketOf(instrument));
    }

    /**
     * 시간외 단일가 호가 10단계(`inquire-overtime-asking-price`, TR `FHPST02300400`). 국내만 지원한다. 매수는 높은 가격부터, 매도는 낮은
     * 가격부터 정렬한다. `fetchOrderBook`과 달리 호가가 없어도 던지지 않고 빈 호가를 돌려준다. 시간외 단일가 시간 밖에는 호가가 없는 것이 정상이다.
     */
    async fetchOvertimeOrderBook(symbol: string, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        const instrument = this.domesticInstrument(symbol, 'fetchOvertimeOrderBook');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireOvertimeAskingPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: instrument.code,
            tr_id: 'FHPST02300400',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const bids: Array<[Num, Num]> = [];
        const asks: Array<[Num, Num]> = [];
        for (let level = 1; level <= 10; level++) {
            const askPrice = Number(output[`ovtm_untp_askp${level}`]);
            if (Number.isFinite(askPrice) && askPrice > 0) asks.push([askPrice, toNumber(output[`ovtm_untp_askp_rsqn${level}`])]);
            const bidPrice = Number(output[`ovtm_untp_bidp${level}`]);
            if (Number.isFinite(bidPrice) && bidPrice > 0) bids.push([bidPrice, toNumber(output[`ovtm_untp_bidp_rsqn${level}`])]);
        }
        const book = this.safeOrderBook({ symbol: instrument.symbol, timestamp: this.milliseconds(), bids, asks });
        if (limit !== undefined) {
            book.bids = book.bids.slice(0, limit);
            book.asks = book.asks.slice(0, limit);
        }
        return book;
    }

    /** 시간외 단일가 일자별 시세(`inquire-daily-overtimeprice`, TR `FHPST02320000`). 국내만 지원한다. 행은 `output2`다. */
    async fetchOvertimeDailyPrices(symbol: string, params: Dict = {}): Promise<KisOvertimeDailyPrice[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchOvertimeDailyPrices');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireDailyOvertimeprice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            tr_id: 'FHPST02320000',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            businessDate: this.safeString(row, 'stck_bsop_date', ''),
            overtimePrice: this.safeNumber(row, 'ovtm_untp_prpr'),
            overtimeChange: this.safeNumber(row, 'ovtm_untp_prdy_vrss'),
            overtimeChangeRate: this.safeNumber(row, 'ovtm_untp_prdy_ctrt'),
            overtimeVolume: this.safeNumber(row, 'ovtm_untp_vol'),
            overtimeAmount: this.safeNumber(row, 'ovtm_untp_tr_pbmn'),
            close: this.safeNumber(row, 'stck_clpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            info: row,
        }));
    }

    /**
     * 종목의 매도·매수 상위 회원사 5곳과 외국계 증권사 합계(`inquire-member`, TR `FHKST01010600`). 국내만 지원한다.
     * 시장구분은 KRX(`J`)다. 이 API는 설명에 통합(`UN`)이 없고 KRX와 NXT만 있다.
     */
    async fetchMemberTrading(symbol: string, params: Dict = {}): Promise<KisMemberTrading> {
        const { code } = this.domesticInstrument(symbol, 'fetchMemberTrading');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireMember(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            tr_id: 'FHKST01010600',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const yesNo = (value: Str): boolean | undefined => (value === 'Y' ? true : value === 'N' ? false : undefined);
        const entries = (side: 'seln' | 'shnu'): KisMemberTradingEntry[] => {
            const result: KisMemberTradingEntry[] = [];
            for (let n = 1; n <= 5; n++) {
                const memberCode = this.safeString(output, `${side}_mbcr_no${n}`, '');
                if (memberCode === '') continue;
                result.push({
                    memberCode,
                    memberName: this.safeString(output, `${side}_mbcr_name${n}`) || undefined,
                    volume: this.safeNumber(output, `total_${side}_qty${n}`),
                    share: this.safeNumber(output, `${side}_mbcr_rlim${n}`),
                    volumeChange: this.safeNumber(output, `${side}_qty_icdc${n}`),
                    foreignBroker: yesNo(this.safeString(output, `${side}_mbcr_glob_yn_${n}`)),
                });
            }
            return result;
        };
        return {
            sells: entries('seln'),
            buys: entries('shnu'),
            foreignBrokerSellVolume: this.safeNumber(output, 'glob_total_seln_qty'),
            foreignBrokerBuyVolume: this.safeNumber(output, 'glob_total_shnu_qty'),
            foreignBrokerNetBuyVolume: this.safeNumber(output, 'glob_ntby_qty'),
            foreignBrokerSellShare: this.safeNumber(output, 'glob_seln_rlim'),
            foreignBrokerBuyShare: this.safeNumber(output, 'glob_shnu_rlim'),
            info: output,
        };
    }

    /**
     * 회원사 실시간 매매동향(`frgnmem-trade-trend`, TR `FHPST04320000`). 국내만 지원한다. `memberCode`의 기본값은 문서의 전체 값(`99999`)이다.
     *
     * 문서는 종목코드와 시장구분(`FID_MRKT_CLS_CODE`) 중 하나만 넣으라고 적었지만 예제는 둘 다 넣는다. 시장구분에는 전체 값(`A`)이 있어서
     * 예제대로 전체를 함께 보낸다. 설명 없는 거래량 하한(`FID_VOL_CNT`)은 비운다. 연속조회는 따라가지 않고 첫 페이지만 돌려준다.
     */
    async fetchMemberTradeTicks(symbol: string, memberCode: string = KIS_ALL_MEMBERS, params: Dict = {}): Promise<KisMemberTradeTicks> {
        const { code } = this.domesticInstrument(symbol, 'fetchMemberTradeTicks');
        const response = await this.privateGetUapiDomesticStockV1QuotationsFrgnmemTradeTrend(this.extend({
            FID_COND_SCR_DIV_CODE: '20432',
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_INPUT_ISCD_2: memberCode,
            FID_MRKT_CLS_CODE: 'A',
            FID_VOL_CNT: '',
            tr_id: 'FHPST04320000',
        }, params));
        const summary = firstRow(this.safeValue(response, 'output1'));
        return {
            totalSellVolume: this.safeNumber(summary, 'total_seln_qty'),
            totalBuyVolume: this.safeNumber(summary, 'total_shnu_qty'),
            ticks: rowsOf(this.safeValue(response, 'output2')).map((row) => ({
                time: this.safeString(row, 'bsop_hour', ''),
                memberName: this.safeString(row, 'mbcr_name') || undefined,
                price: this.safeNumber(row, 'stck_prpr'),
                change: this.safeNumber(row, 'prdy_vrss'),
                volume: this.safeNumber(row, 'cntg_vol'),
                cumulativeNetBuyVolume: this.safeNumber(row, 'acml_ntby_qty'),
                foreignBrokerNetBuyVolume: this.safeNumber(row, 'glob_ntby_qty'),
                foreignNetBuyChange: this.safeNumber(row, 'frgn_ntby_qty_icdc'),
                info: row,
            })),
        };
    }

    /**
     * 업종 지수 봉. `index`는 업종코드 네 자리다(예: `0001` 종합, `1001` 코스닥). 국내만 지원한다.
     *
     * - 일, 주, 월, 년(`1d`, `1w`, `1M`, `1y`): 업종 기간별 시세(`inquire-daily-indexchartprice`, TR `FHKUP03500100`). `since`가 없으면
     *   `limit`개 봉에 휴장일 여유를 더한 구간을 묻고, 끝은 `params.until`(없으면 지금)이다. 거래량은 누적거래량(`acml_vol`)이다.
     * - 30초, 1분, 10분, 1시간(`30s`, `1m`, `10m`, `1h`): 업종 분봉(`inquire-time-indexchartprice`, TR `FHKUP03500200`). 봉 길이는
     *   문서 예시에 있는 값만 받는다. 날짜 입력이 없어 `since`는 받은 뒤에 거른다. 거래량은 체결거래량(`cntg_vol`)이다.
     *
     * 두 API 모두 연속조회(`tr_cont`)를 쓰지만 첫 페이지만 돌려준다.
     */
    async fetchIndexOHLCV(index: string, timeframe = '1d', since: Int = undefined, limit: Int = 100, params: Dict = {}): Promise<OHLCV[]> {
        if (!/^\d{4}$/.test(index)) throw new BadRequest(`${this.id} fetchIndexOHLCV() 의 index 는 업종코드 네 자리여야 한다: ${index}`);
        const period = KIS_INDEX_PERIODS[timeframe];
        const seconds = KIS_INDEX_MINUTE_SECONDS[timeframe];
        if (period === undefined && seconds === undefined) {
            const supported = [...Object.keys(KIS_INDEX_PERIODS), ...Object.keys(KIS_INDEX_MINUTE_SECONDS)].join(', ');
            throw new NotSupported(`${this.id} fetchIndexOHLCV() 는 ${supported} 만 지원한다: ${timeframe}`);
        }
        const candle = (row: Dict, timestamp: Int, volumeKey: string): OHLCV => [
            timestamp,
            this.safeNumber(row, 'bstp_nmix_oprc'),
            this.safeNumber(row, 'bstp_nmix_hgpr'),
            this.safeNumber(row, 'bstp_nmix_lwpr'),
            this.safeNumber(row, 'bstp_nmix_prpr'),
            this.safeNumber(row, volumeKey),
        ];
        let candles: OHLCV[];
        if (period !== undefined) {
            const until = this.safeInteger(params, 'until') ?? this.milliseconds();
            const start = since ?? until - (limit ?? 100) * period.days * KIS_INDEX_RANGE_MARGIN * DAY_MS;
            const response = await this.privateGetUapiDomesticStockV1QuotationsInquireDailyIndexchartprice(this.extend({
                FID_COND_MRKT_DIV_CODE: 'U',
                FID_INPUT_ISCD: index,
                FID_INPUT_DATE_1: kstYmd(start),
                FID_INPUT_DATE_2: kstYmd(until),
                FID_PERIOD_DIV_CODE: period.code,
                tr_id: 'FHKUP03500100',
            }, this.omit(params, 'until')));
            candles = rowsOf(this.safeValue(response, 'output2'))
                .map((row) => candle(row, kstTimestamp(this.safeString(row, 'stck_bsop_date'), KIS_DAILY_CANDLE_HMS), 'acml_vol'));
        } else {
            const response = await this.privateGetUapiDomesticStockV1QuotationsInquireTimeIndexchartprice(this.extend({
                FID_COND_MRKT_DIV_CODE: 'U',
                FID_ETC_CLS_CODE: '0',
                FID_INPUT_ISCD: index,
                FID_INPUT_HOUR_1: seconds,
                FID_PW_DATA_INCU_YN: 'Y',
                tr_id: 'FHKUP03500200',
            }, params));
            candles = rowsOf(this.safeValue(response, 'output2'))
                .map((row) => candle(row, kstTimestamp(this.safeString(row, 'stck_bsop_date'), this.safeString(row, 'stck_cntg_hour')), 'cntg_vol'));
        }
        const sorted = candles
            .filter((c) => c[0] !== undefined && (since === undefined || (c[0] as number) >= since))
            .sort((a, b) => (a[0] as number) - (b[0] as number));
        return limit !== undefined ? sorted.slice(-limit) : sorted;
    }

    /**
     * 기준 시각(`params.until`, 없으면 지금)의 한국 날짜와 시각 이전 1분봉(`inquire-time-dailychartprice`, TR `FHKST03010230`).
     * 국내만 지원한다. 필수 입력인 날짜와 시각은 기준 시각으로 채운다. 과거 데이터 포함 여부와 허봉 포함 여부는 문서의 기본값(`N`, 빈 값)을 보낸다.
     */
    async fetchMinuteOHLCVAt(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<OHLCV[]> {
        const [until, query] = this.handleUntilParam('fetchMinuteOHLCVAt', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchMinuteOHLCVAt');
        const at = until ?? this.milliseconds();
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireTimeDailychartprice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_INPUT_HOUR_1: kstHms(at),
            FID_INPUT_DATE_1: kstYmd(at),
            FID_PW_DATA_INCU_YN: 'N',
            FID_FAKE_TICK_INCU_YN: '',
            tr_id: 'FHKST03010230',
        }, query));
        const candles = rowsOf(this.safeValue(response, 'output2'))
            .map((row): OHLCV => [
                kstTimestamp(this.safeString(row, 'stck_bsop_date'), this.safeString(row, 'stck_cntg_hour')),
                this.safeNumber(row, 'stck_oprc'),
                this.safeNumber(row, 'stck_hgpr'),
                this.safeNumber(row, 'stck_lwpr'),
                this.safeNumber(row, 'stck_prpr'),
                this.safeNumber(row, 'cntg_vol'),
            ])
            .filter((c) => c[0] !== undefined)
            .sort((a, b) => (a[0] as number) - (b[0] as number));
        return this.filterBySinceLimit(candles as unknown as Dict[], since, limit, 0) as unknown as OHLCV[];
    }

    /**
     * 주식현재가 일자별(`inquire-daily-price`, TR `FHKST01010400`). 문서 설명대로 일은 최근 30거래일, 주는 최근 30주, 월은 최근 30개월이다.
     * 국내만 지원한다. `timeframe`은 `1d`, `1w`, `1M`이다. 수정주가 반영 여부(`FID_ORG_ADJ_PRC`)는 예제값 `1`(반영)이 기본이다.
     */
    async fetchDailyPrices(symbol: string, timeframe = '1d', params: Dict = {}): Promise<KisDailyPrice[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchDailyPrices');
        const period = KIS_DAILY_PRICE_PERIODS[timeframe];
        if (period === undefined) {
            throw new NotSupported(`${this.id} fetchDailyPrices() 는 ${Object.keys(KIS_DAILY_PRICE_PERIODS).join(', ')} 만 지원한다: ${timeframe}`);
        }
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireDailyPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_PERIOD_DIV_CODE: period,
            FID_ORG_ADJ_PRC: '1',
            tr_id: 'FHKST01010400',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            businessDate: this.safeString(row, 'stck_bsop_date', ''),
            open: this.safeNumber(row, 'stck_oprc'),
            high: this.safeNumber(row, 'stck_hgpr'),
            low: this.safeNumber(row, 'stck_lwpr'),
            close: this.safeNumber(row, 'stck_clpr'),
            volume: this.safeNumber(row, 'acml_vol'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volumeChangeRate: this.safeNumber(row, 'prdy_vrss_vol_rate'),
            foreignHoldingRate: this.safeNumber(row, 'hts_frgn_ehrt'),
            foreignNetBuyVolume: this.safeNumber(row, 'frgn_ntby_qty'),
            lockCode: this.safeString(row, 'flng_cls_code') || undefined,
            info: row,
        }));
    }

    /**
     * ETF/ETN 현재가(`etfetn/inquire-price`, TR `FHPST02400000`). 국내만 지원한다. 시장구분은 KRX, NXT, 통합 중에서 고르는 입력이라
     * 예제의 KRX(`J`)가 기본이다. NAV, 괴리율, 추적 오차율, 순자산 같은 주요 값을 옮기고 나머지(LP, 연중 최고가 등)는 `info`에 둔다.
     */
    async fetchEtfPrice(symbol: string, params: Dict = {}): Promise<KisEtfPrice> {
        const instrument = this.domesticInstrument(symbol, 'fetchEtfPrice');
        const response = await this.privateGetUapiEtfetnV1QuotationsInquirePrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: instrument.code,
            tr_id: 'FHPST02400000',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        return {
            symbol: instrument.symbol,
            price: num('stck_prpr'),
            change: num('prdy_vrss'),
            percentage: num('prdy_ctrt'),
            open: num('stck_oprc'),
            high: num('stck_hgpr'),
            low: num('stck_lwpr'),
            previousClose: num('stck_prdy_clpr'),
            volume: num('acml_vol'),
            previousVolume: num('prdy_vol'),
            upperLimit: num('stck_mxpr'),
            lowerLimit: num('stck_llam'),
            nav: num('nav'),
            navChange: num('nav_prdy_vrss'),
            navChangeRate: num('nav_prdy_ctrt'),
            previousNav: num('prdy_last_nav'),
            premiumRate: num('dprt'),
            trackingErrorRate: num('trc_errt'),
            netAssets: num('etf_ntas_ttam'),
            circulatingShares: num('etf_crcl_stcn'),
            listedShares: num('lstn_stcn'),
            creationUnitShares: num('etf_cu_unit_scrt_cnt'),
            constituentCount: num('etf_cnfg_issu_cnt'),
            categoryName: text('etf_div_name'),
            dividendCycle: text('etf_dvdn_cycl'),
            currency: text('crcd'),
            maturityDate: text('mtrt_date'),
            info: output,
        };
    }

    /**
     * ETF 구성종목시세(`inquire-component-stock-price`, TR `FHKST121600C0`). 국내만 지원한다. 시장구분(`J`)과 화면분류코드(`11216`)는 예제값이다.
     * 예제와 cluefin 모두 ETF 요약(`output1`) 필드의 한국어 이름이 다른 API 것으로 밀려 있다(`nav`가 "누적 거래량" 등). 필드 이름은 두 출처가 같아서,
     * 같은 이름을 NAV 비교추이와 ETF 현재가가 설명한 뜻(NAV, NAV시가, ETF 순자산 총액 등)으로 옮긴다.
     */
    async fetchEtfConstituents(symbol: string, params: Dict = {}): Promise<KisEtfConstituents> {
        const { code } = this.domesticInstrument(symbol, 'fetchEtfConstituents');
        const response = await this.privateGetUapiEtfetnV1QuotationsInquireComponentStockPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_COND_SCR_DIV_CODE: '11216',
            tr_id: 'FHKST121600C0',
        }, params));
        const summary = firstRow(this.safeValue(response, 'output1'));
        const num = (key: string): number | undefined => this.safeNumber(summary, key);
        return {
            etf: {
                price: num('stck_prpr'),
                change: num('prdy_vrss'),
                percentage: num('prdy_ctrt'),
                nav: num('nav'),
                navChange: num('nav_prdy_vrss'),
                navChangeRate: num('nav_prdy_ctrt'),
                previousNav: num('prdy_clpr_nav'),
                navOpen: num('oprc_nav'),
                navHigh: num('hprc_nav'),
                navLow: num('lprc_nav'),
                netAssets: num('etf_ntas_ttam'),
                constituentsMarketCap: num('etf_cnfg_issu_avls'),
                creationUnitShares: num('etf_cu_unit_scrt_cnt'),
                constituentCount: num('etf_cnfg_issu_cnt'),
                info: summary,
            },
            constituents: rowsOf(this.safeValue(response, 'output2')).map((row) => ({
                symbol: `${this.safeString(row, 'stck_shrn_iscd', '')}/KRW`,
                name: this.safeString(row, 'hts_kor_isnm') || undefined,
                price: this.safeNumber(row, 'stck_prpr'),
                change: this.safeNumber(row, 'prdy_vrss'),
                percentage: this.safeNumber(row, 'prdy_ctrt'),
                volume: this.safeNumber(row, 'acml_vol'),
                tradingValue: this.safeNumber(row, 'acml_tr_pbmn'),
                marketCap: this.safeNumber(row, 'hts_avls'),
                creationUnitShares: this.safeNumber(row, 'etf_cu_unit_scrt_cnt'),
                weight: this.safeNumber(row, 'etf_cnfg_issu_rlim'),
                valuationAmount: this.safeNumber(row, 'etf_vltn_amt'),
                info: row,
            })),
        };
    }

    /** NAV 비교추이(종목)(`nav-comparison-trend`, TR `FHPST02440000`). 국내만 지원한다. 시장구분은 예제값(`J`)이다. 가격 쪽과 NAV 쪽을 나눠 돌려준다. */
    async fetchEtfNavComparison(symbol: string, params: Dict = {}): Promise<KisEtfNavComparison> {
        const { code } = this.domesticInstrument(symbol, 'fetchEtfNavComparison');
        const response = await this.privateGetUapiEtfetnV1QuotationsNavComparisonTrend(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            tr_id: 'FHPST02440000',
        }, params));
        const market = firstRow(this.safeValue(response, 'output1'));
        const nav = firstRow(this.safeValue(response, 'output2'));
        return {
            market: {
                price: this.safeNumber(market, 'stck_prpr'),
                change: this.safeNumber(market, 'prdy_vrss'),
                percentage: this.safeNumber(market, 'prdy_ctrt'),
                open: this.safeNumber(market, 'stck_oprc'),
                high: this.safeNumber(market, 'stck_hgpr'),
                low: this.safeNumber(market, 'stck_lwpr'),
                previousClose: this.safeNumber(market, 'stck_prdy_clpr'),
                volume: this.safeNumber(market, 'acml_vol'),
                tradingValue: this.safeNumber(market, 'acml_tr_pbmn'),
                upperLimit: this.safeNumber(market, 'stck_mxpr'),
                lowerLimit: this.safeNumber(market, 'stck_llam'),
                info: market,
            },
            nav: {
                nav: this.safeNumber(nav, 'nav'),
                navChange: this.safeNumber(nav, 'nav_prdy_vrss'),
                navChangeRate: this.safeNumber(nav, 'nav_prdy_ctrt'),
                previousNav: this.safeNumber(nav, 'prdy_clpr_nav'),
                open: this.safeNumber(nav, 'oprc_nav'),
                high: this.safeNumber(nav, 'hprc_nav'),
                low: this.safeNumber(nav, 'lprc_nav'),
                info: nav,
            },
        };
    }

    /**
     * NAV 비교추이(일)(`nav-comparison-daily-trend`, TR `FHPST02440200`). 국내만 지원한다. 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다.
     * 시장구분은 예제값(`J`)이다. 연속조회는 따라가지 않는다.
     */
    async fetchEtfNavDailyTrend(symbol: string, since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisEtfNavTrendRow[]> {
        const [until, query] = this.handleUntilParam('fetchEtfNavDailyTrend', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchEtfNavDailyTrend');
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchEtfNavDailyTrend() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiEtfetnV1QuotationsNavComparisonDailyTrend(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: kstYmd(since),
            FID_INPUT_DATE_2: kstYmd(until ?? this.milliseconds()),
            tr_id: 'FHPST02440200',
        }, query));
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => this.etfNavTrendRow(row, 'stck_clpr')), since, limit);
    }

    /**
     * NAV 비교추이(분)(`nav-comparison-time-trend`, TR `FHPST02440100`). 국내만 지원한다. `timeframe`은 문서 예시에 있는 `1m`, `3m`, `2h`만 받고,
     * 다른 간격은 `params.FID_HOUR_CLS_CODE`(초)로 준다. 시장구분은 예제와 cluefin 코드가 보내는 `E`를 따른다(cluefin 설명에는 `J: 주식`으로 적혀 있다).
     */
    async fetchEtfNavMinuteTrend(symbol: string, timeframe = '1m', params: Dict = {}): Promise<KisEtfNavTrendRow[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchEtfNavMinuteTrend');
        const seconds = KIS_ETF_NAV_MINUTE_SECONDS[timeframe];
        if (seconds === undefined) {
            throw new NotSupported(`${this.id} fetchEtfNavMinuteTrend() 는 ${Object.keys(KIS_ETF_NAV_MINUTE_SECONDS).join(', ')} 만 지원한다: ${timeframe}`);
        }
        const response = await this.privateGetUapiEtfetnV1QuotationsNavComparisonTimeTrend(this.extend({
            FID_HOUR_CLS_CODE: seconds,
            FID_INPUT_ISCD: code,
            FID_COND_MRKT_DIV_CODE: 'E',
            tr_id: 'FHPST02440100',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => this.etfNavTrendRow(row, 'stck_prpr'));
    }

    /** NAV 비교추이 일별, 분별 행. 가격 필드는 일별이 종가(`stck_clpr`), 분별이 현재가(`stck_prpr`)다. */
    private etfNavTrendRow(row: Dict, priceKey: string): KisEtfNavTrendRow {
        const date = this.safeString(row, 'stck_bsop_date') || undefined;
        const time = this.safeString(row, 'bsop_hour') || undefined;
        return {
            ...this.kstStamp(date, time),
            date,
            time,
            price: this.safeNumber(row, priceKey),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            tradeVolume: this.safeNumber(row, 'cntg_vol'),
            nav: this.safeNumber(row, 'nav'),
            navChange: this.safeNumber(row, 'nav_prdy_vrss'),
            navChangeRate: this.safeNumber(row, 'nav_prdy_ctrt'),
            navPriceGap: this.safeNumber(row, 'nav_vrss_prpr'),
            premiumRate: this.safeNumber(row, 'dprt'),
            info: row,
        };
    }

    /**
     * ELW 단축코드 인자(영숫자 여섯 자리, 예: `58J297`). 국내 종목 판정은 영숫자 코드를 목록에 있는 것만 받으므로 ELW 는 통합 심볼 대신 코드를 직접 받는다.
     * 끝의 `/KRW`는 떼어 낸다. 그 밖의 모양이면 요청 전에 `BadRequest`다.
     */
    private elwCode(code: string, method: string): string {
        const base = code.replace(/\/KRW$/, '').trim().toUpperCase();
        if (!/^[0-9A-Z]{6}$/.test(base)) throw new BadRequest(`${this.id} ${method}() 의 code 는 ELW 단축코드(영숫자 여섯 자리)여야 한다: ${code}`);
        return base;
    }

    /** ELW 기초자산 인자. 종목코드 여섯 자리(`005930`)나 지수 코드 네 자리(`2001` 코스피200)다. 끝의 `/KRW`는 떼어 낸다. */
    private elwUnderlying(underlying: string, method: string): string {
        const base = underlying.replace(/\/KRW$/, '').trim();
        if (!/^(\d{4}|\d{6})$/.test(base)) throw new BadRequest(`${this.id} ${method}() 의 underlying 은 종목코드 여섯 자리나 지수 코드 네 자리여야 한다: ${underlying}`);
        return base;
    }

    /** ELW 종목 행(비교대상종목, 신규상장, 만기). 종목명 필드는 조회마다 다르다. */
    private elwItem(row: Dict, nameKey = 'elw_kor_isnm'): KisElwItem {
        const text = (key: string): string | undefined => this.safeString(row, key) || undefined;
        return {
            code: this.safeString(row, 'elw_shrn_iscd', ''),
            name: text(nameKey),
            underlyingCode: text('unas_shrn_iscd'),
            underlyingName: text('unas_isnm'),
            underlyingPrice: this.safeNumber(row, 'unas_prpr'),
            price: this.safeNumber(row, 'elw_prpr'),
            strikePrice: this.safeNumber(row, 'acpr'),
            conversionRatio: this.safeNumber(row, 'stck_cnvr_rate'),
            listedShares: this.safeNumber(row, 'lstn_stcn'),
            listingDate: text('stck_lstn_date'),
            lastTradeDate: text('stck_last_tr_date'),
            knockOutBarrier: this.safeNumber(row, 'elw_ko_barrier'),
            info: row,
        };
    }

    /**
     * ELW 현재가 시세(`inquire-elw-price`, TR `FHKEW15010000`). `code`는 ELW 단축코드다. 시장구분은 ELW(`W`)다. 예제는 모의투자에도 같은 TR 을 쓴다.
     * 피벗 값, 틱환산가, 투자 유의 내용 등은 `info`에 둔다.
     */
    async fetchElwPrice(code: string, params: Dict = {}): Promise<KisElwPrice> {
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireElwPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'W',
            FID_INPUT_ISCD: this.elwCode(code, 'fetchElwPrice'),
            tr_id: 'FHKEW15010000',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        return {
            code: this.safeString(output, 'elw_shrn_iscd', ''),
            name: text('hts_kor_isnm'),
            price: num('elw_prpr'),
            change: num('prdy_vrss'),
            percentage: num('prdy_ctrt'),
            open: num('elw_oprc'),
            high: num('elw_hgpr'),
            low: num('elw_lwpr'),
            basePrice: num('elw_sdpr'),
            volume: num('acml_vol'),
            tradingValue: num('acml_tr_pbmn'),
            bid: num('bidp'),
            ask: num('askp'),
            underlyingCode: text('unas_shrn_iscd'),
            underlyingName: text('unas_isnm'),
            underlyingPrice: num('unas_prpr'),
            underlyingChange: num('unas_prdy_vrss'),
            underlyingChangeRate: num('unas_prdy_ctrt'),
            strikePrice: num('acpr'),
            theoreticalPrice: num('hts_thpr'),
            premiumRate: num('dprt'),
            impliedVolatility: num('hts_ints_vltl'),
            moneynessName: text('atm_cls_name'),
            approachRate: num('apprch_rate'),
            info: output,
        };
    }

    /** ELW 비교대상종목조회(`compare-stocks`, TR `FHKEW151701C0`). 기초자산(`underlying`)의 ELW 목록이다. 화면분류코드(`11517`)는 예제값이다. */
    async fetchElwComparables(underlying: string, params: Dict = {}): Promise<KisElwItem[]> {
        const response = await this.privateGetUapiElwV1QuotationsCompareStocks(this.extend({
            FID_COND_SCR_DIV_CODE: '11517',
            FID_INPUT_ISCD: this.elwUnderlying(underlying, 'fetchElwComparables'),
            tr_id: 'FHKEW151701C0',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => this.elwItem(row));
    }

    /**
     * ELW 만기예정/만기종목(`expiration-stocks`, TR `FHKEW154700C0`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다.
     * 콜풋(`2`), 기초자산(`000000`), 발행사(`00000`), 조기종료 구분(`0`)은 설명의 전체 값이고, 설명에 "공백 입력"으로 적힌 입력은 비운다.
     * 상환금액, 만기평가금액, 결제일자 등은 `info`에 둔다.
     */
    async fetchElwExpirations(since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisElwItem[]> {
        const [until, query] = this.handleUntilParam('fetchElwExpirations', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchElwExpirations() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiElwV1QuotationsExpirationStocks(this.extend({
            FID_COND_MRKT_DIV_CODE: 'W',
            FID_COND_SCR_DIV_CODE: '11547',
            FID_INPUT_DATE_1: kstYmd(since),
            FID_INPUT_DATE_2: kstYmd(until ?? this.milliseconds()),
            FID_DIV_CLS_CODE: '2',
            FID_ETC_CLS_CODE: '',
            FID_UNAS_INPUT_ISCD: '000000',
            FID_INPUT_ISCD_2: '00000',
            FID_BLNG_CLS_CODE: '0',
            FID_INPUT_OPTION_1: '',
            tr_id: 'FHKEW154700C0',
        }, query));
        // 종목 목록이라 대표 시각이 없다. 최종거래일(`YYYYMMDD`) 순서로 자른다.
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => this.elwItem(row)), since, limit, 'lastTradeDate');
    }

    /**
     * ELW 신규상장종목(`newly-listed`, TR `FHKEW154800C0`). 발행사(`issuer`, 예: `00003` 한국투자증권)는 설명에 전체 값이 없는 필수 입력이라
     * 호출하는 쪽이 고른다. 날짜(`params.until`의 한국 날짜)는 필수 입력이라 기본값을 오늘(한국 날짜)로 둔다. 콜풋(`02`), 기초자산(`000000`),
     * 조기종료 구분(`0`)은 설명의 전체 값이다.
     */
    async fetchElwListings(issuer: string, params: Dict = {}): Promise<KisElwItem[]> {
        const [until, query] = this.handleUntilParam('fetchElwListings', undefined, params);
        if (issuer === undefined) throw new ArgumentsRequired(`${this.id} fetchElwListings() 는 issuer(발행사 코드 다섯 자리) 인자가 필요하다`);
        if (!/^\d{5}$/.test(issuer)) throw new BadRequest(`${this.id} fetchElwListings() 의 issuer 는 발행사 코드 다섯 자리여야 한다: ${issuer}`);
        const response = await this.privateGetUapiElwV1QuotationsNewlyListed(this.extend({
            FID_COND_MRKT_DIV_CODE: 'W',
            FID_COND_SCR_DIV_CODE: '11548',
            FID_DIV_CLS_CODE: '02',
            FID_UNAS_INPUT_ISCD: '000000',
            FID_INPUT_ISCD_2: issuer,
            FID_INPUT_DATE_1: kstYmd(until ?? this.milliseconds()),
            FID_BLNG_CLS_CODE: '0',
            tr_id: 'FHKEW154800C0',
        }, query));
        return rowsOf(this.safeValue(response, 'output')).map((row) => this.elwItem(row));
    }

    /** ELW 기초자산 목록조회(`udrl-asset-list`, TR `FHKEW154100C0`). 발행사는 전체(`00000`)이고, 정렬(`0`)과 화면분류코드(`11541`)는 예제값이다. */
    async fetchElwUnderlyings(params: Dict = {}): Promise<KisElwUnderlying[]> {
        const response = await this.privateGetUapiElwV1QuotationsUdrlAssetList(this.extend({
            FID_COND_SCR_DIV_CODE: '11541',
            FID_RANK_SORT_CLS_CODE: '0',
            FID_INPUT_ISCD: '00000',
            tr_id: 'FHKEW154100C0',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            code: this.safeString(row, 'unas_shrn_iscd', ''),
            name: this.safeString(row, 'unas_isnm') || undefined,
            price: this.safeNumber(row, 'unas_prpr'),
            change: this.safeNumber(row, 'unas_prdy_vrss'),
            percentage: this.safeNumber(row, 'unas_prdy_ctrt'),
            info: row,
        }));
    }

    /**
     * ELW 기초자산별 종목시세(`udrl-asset-price`, TR `FHKEW154101C0`). 기초자산(`underlying`)의 ELW 시세다. 콜풋(`A`)과 발행사(`00000`)는 설명의
     * 전체 값, 거래불가종목 제외(`0` 미체크)와 옵션상태(`0` 없음)는 설명의 기본 상태다. 예제는 가격, 거래량, 잔존일 범위에 값을 넣지만
     * 설명에 전체 값이 없는 거름 조건이라 비우고, 필요하면 `params`로 준다.
     */
    async fetchElwsByUnderlying(underlying: string, params: Dict = {}): Promise<KisElwByUnderlyingItem[]> {
        const response = await this.privateGetUapiElwV1QuotationsUdrlAssetPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'W',
            FID_COND_SCR_DIV_CODE: '11541',
            FID_MRKT_CLS_CODE: 'A',
            FID_INPUT_ISCD: '00000',
            FID_UNAS_INPUT_ISCD: this.elwUnderlying(underlying, 'fetchElwsByUnderlying'),
            FID_VOL_CNT: '',
            FID_TRGT_EXLS_CLS_CODE: '0',
            FID_INPUT_PRICE_1: '',
            FID_INPUT_PRICE_2: '',
            FID_INPUT_VOL_1: '',
            FID_INPUT_VOL_2: '',
            FID_INPUT_RMNN_DYNU_1: '',
            FID_INPUT_RMNN_DYNU_2: '',
            FID_OPTION: '0',
            FID_INPUT_OPTION_1: '',
            FID_INPUT_OPTION_2: '',
            tr_id: 'FHKEW154101C0',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            code: this.safeString(row, 'elw_shrn_iscd', ''),
            name: this.safeString(row, 'hts_kor_isnm') || undefined,
            price: this.safeNumber(row, 'elw_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            strikePrice: this.safeNumber(row, 'acpr'),
            conversionRatio: this.safeNumber(row, 'stck_cnvr_rate'),
            remainingDays: this.safeNumber(row, 'hts_rmnn_dynu'),
            breakEvenPrice: this.safeNumber(row, 'prls_qryr_stpr_prc'),
            breakEvenRate: this.safeNumber(row, 'prls_qryr_rate'),
            capitalFulcrumPoint: this.safeNumber(row, 'cfp'),
            parity: this.safeNumber(row, 'prit'),
            leverage: this.safeNumber(row, 'lvrg_val'),
            gearing: this.safeNumber(row, 'gear'),
            intrinsicValue: this.safeNumber(row, 'invl_val'),
            timeValue: this.safeNumber(row, 'tmvl_val'),
            theoreticalPrice: this.safeNumber(row, 'hts_thpr'),
            impliedVolatility: this.safeNumber(row, 'hts_ints_vltl'),
            delta: this.safeNumber(row, 'delta_val'),
            gamma: this.safeNumber(row, 'gama'),
            vega: this.safeNumber(row, 'vega'),
            theta: this.safeNumber(row, 'theta'),
            lpHolding: this.safeNumber(row, 'lp_hvol'),
            lpWeight: this.safeNumber(row, 'lp_rlim'),
            info: row,
        }));
    }

    /**
     * ELW 추이 조회의 공통 부분. `timeframe`이 `tick`이면 체결(`*-trend-ccnl`), `1d`면 일별(`*-trend-daily`), 분 단위면 분별(`*-trend-minute`)을 부른다.
     * 분별의 과거데이터 포함 여부는 예제값(`N`)이다. 연속조회는 따라가지 않는다.
     */
    private async elwTrendRows(family: 'indicator' | 'sensitivity' | 'volatility', code: string, timeframe: string, method: string, params: Dict): Promise<{ rows: Dict[]; minute: boolean }> {
        const trs = KIS_ELW_TRENDS[family];
        const request: Dict = { FID_COND_MRKT_DIV_CODE: 'W', FID_INPUT_ISCD: this.elwCode(code, method) };
        const seconds = trs.minute === undefined ? undefined : KIS_ELW_MINUTE_SECONDS[timeframe];
        let kind: string;
        let trId: string;
        if (timeframe === 'tick') {
            kind = 'ccnl';
            trId = trs.tick;
        } else if (timeframe === '1d') {
            kind = 'daily';
            trId = trs.daily;
        } else if (seconds !== undefined && trs.minute !== undefined) {
            kind = 'minute';
            trId = trs.minute;
            request.FID_HOUR_CLS_CODE = seconds;
            request.FID_PW_DATA_INCU_YN = 'N';
        } else {
            const supported = ['tick', '1d', ...(trs.minute === undefined ? [] : Object.keys(KIS_ELW_MINUTE_SECONDS))].join(', ');
            throw new NotSupported(`${this.id} ${method}() 는 ${supported} 만 지원한다: ${timeframe}`);
        }
        const call = this[kisImplicitGet(`uapi/elw/v1/quotations/${family}-trend-${kind}`)] as (request: Dict) => Promise<unknown>;
        const response = await call.call(this, this.extend({ ...request, tr_id: trId }, params));
        return { rows: rowsOf(this.safeValue(response, 'output')), minute: kind === 'minute' };
    }

    /** ELW 투자지표추이(체결 `tick`, 일별 `1d`, 분별 `1m`~`1h`). TR 은 차례로 `FHPEW02740100`, `FHPEW02740200`, `FHPEW02740300`이다. */
    async fetchElwIndicatorTrend(code: string, timeframe = 'tick', params: Dict = {}): Promise<KisElwIndicatorRow[]> {
        const { rows } = await this.elwTrendRows('indicator', code, timeframe, 'fetchElwIndicatorTrend', params);
        return rows.map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date'), this.safeString(row, 'stck_cntg_hour')),
            date: this.safeString(row, 'stck_bsop_date') || undefined,
            time: this.safeString(row, 'stck_cntg_hour') || undefined,
            price: this.safeNumber(row, 'elw_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            open: this.safeNumber(row, 'elw_oprc'),
            high: this.safeNumber(row, 'elw_hgpr'),
            low: this.safeNumber(row, 'elw_lwpr'),
            volume: this.safeNumber(row, 'acml_vol'),
            tradeVolume: this.safeNumber(row, 'cntg_vol'),
            leverage: this.safeNumber(row, 'lvrg_val'),
            gearing: this.safeNumber(row, 'gear'),
            timeValue: this.safeNumber(row, 'tmvl_val'),
            intrinsicValue: this.safeNumber(row, 'invl_val'),
            premium: this.safeNumber(row, 'prmm_val'),
            parity: this.safeNumber(row, 'prit'),
            approachRate: this.safeNumber(row, 'apprch_rate'),
            info: row,
        }));
    }

    /** ELW 민감도 추이(체결 `tick`, 일별 `1d`). TR 은 차례로 `FHPEW02830100`, `FHPEW02830200`이다. 분별 API 는 없다. */
    async fetchElwSensitivityTrend(code: string, timeframe = 'tick', params: Dict = {}): Promise<KisElwSensitivityRow[]> {
        const { rows } = await this.elwTrendRows('sensitivity', code, timeframe, 'fetchElwSensitivityTrend', params);
        return rows.map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date'), this.safeString(row, 'stck_cntg_hour')),
            date: this.safeString(row, 'stck_bsop_date') || undefined,
            time: this.safeString(row, 'stck_cntg_hour') || undefined,
            price: this.safeNumber(row, 'elw_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            theoreticalPrice: this.safeNumber(row, 'hts_thpr'),
            delta: this.safeNumber(row, 'delta_val'),
            gamma: this.safeNumber(row, 'gama'),
            theta: this.safeNumber(row, 'theta'),
            vega: this.safeNumber(row, 'vega'),
            rho: this.safeNumber(row, 'rho'),
            info: row,
        }));
    }

    /**
     * ELW 변동성추이(체결 `tick`, 일별 `1d`, 분별 `1m`~`1h`). TR 은 차례로 `FHPEW02840100`, `FHPEW02840200`, `FHPEW02840300`이다.
     * 분별 행의 가격 필드는 예제 목록대로 `stck_prpr`이다. 변동성추이(틱, `FHPEW02840400`)는 `fetchElwVolatilityTicks`가 행 원문으로 돌려준다.
     */
    async fetchElwVolatilityTrend(code: string, timeframe = 'tick', params: Dict = {}): Promise<KisElwVolatilityRow[]> {
        const { rows, minute } = await this.elwTrendRows('volatility', code, timeframe, 'fetchElwVolatilityTrend', params);
        return rows.map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date'), this.safeString(row, 'stck_cntg_hour')),
            date: this.safeString(row, 'stck_bsop_date') || undefined,
            time: this.safeString(row, 'stck_cntg_hour') || undefined,
            price: this.safeNumber(row, minute ? 'stck_prpr' : 'elw_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            open: this.safeNumber(row, 'elw_oprc'),
            high: this.safeNumber(row, 'elw_hgpr'),
            low: this.safeNumber(row, 'elw_lwpr'),
            volume: this.safeNumber(row, 'acml_vol'),
            bid: this.safeNumber(row, 'bidp'),
            ask: this.safeNumber(row, 'askp'),
            impliedVolatility: this.safeNumber(row, 'hts_ints_vltl'),
            historicalVolatility: this.safeNumber(row, 'hist_vltl'),
            historicalVolatility10d: this.safeNumber(row, 'd10_hist_vltl'),
            historicalVolatility20d: this.safeNumber(row, 'd20_hist_vltl'),
            historicalVolatility30d: this.safeNumber(row, 'd30_hist_vltl'),
            historicalVolatility60d: this.safeNumber(row, 'd60_hist_vltl'),
            historicalVolatility90d: this.safeNumber(row, 'd90_hist_vltl'),
            info: row,
        }));
    }

    /** 여러 블록으로 오는 응답의 블록 원문. */
    private responseBlocks(response: unknown, withThird = false): KisResponseBlocks {
        const block = (key: string): KisResponseBlock => this.safeValue(response as Dict, key) as KisResponseBlock;
        const blocks: KisResponseBlocks = { output1: block('output1'), output2: block('output2') };
        if (withThird) blocks.output3 = block('output3');
        return blocks;
    }

    /** `Y`, `N`을 참과 거짓으로. 그 밖의 값이면 비운다. */
    private yesNo(row: Dict, key: string): boolean | undefined {
        const value = this.safeString(row, key);
        return value === 'Y' ? true : value === 'N' ? false : undefined;
    }

    /** 국내 선물옵션 단축코드 인자(예: `101W09`). 영숫자 5~12자가 아니면 요청 전에 `BadRequest`다. */
    private derivativeCode(code: string, method: string): string {
        const base = (code ?? '').trim().toUpperCase();
        if (!/^[0-9A-Z]{5,12}$/.test(base)) throw new BadRequest(`${this.id} ${method}() 의 code 는 선물옵션 단축코드여야 한다: ${code}`);
        return base;
    }

    /** 해외선물옵션 종목코드 인자(예: `6AM24`, 옵션은 `OESU24 C5500`). 영숫자, 점, 공백 30자 안이 아니면 요청 전에 `BadRequest`다. */
    private overseasDerivativeCode(code: string, method: string): string {
        const base = (code ?? '').trim().toUpperCase();
        if (!/^[0-9A-Z][0-9A-Z. ]{0,29}$/.test(base)) throw new BadRequest(`${this.id} ${method}() 의 code 는 해외선물옵션 종목코드여야 한다: ${code}`);
        return base;
    }

    /** 해외선물옵션 거래소코드 인자(예: `CME`). 전체 값이 없는 필수 입력이라 없으면 `ArgumentsRequired`, 영문 2~10자가 아니면 `BadRequest`다. */
    private overseasDerivativeExchange(exchange: string, method: string): string {
        if (exchange === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 exchange(거래소코드, 예: CME) 인자가 필요하다`);
        const base = exchange.trim().toUpperCase();
        if (!/^[A-Z]{2,10}$/.test(base)) throw new BadRequest(`${this.id} ${method}() 의 exchange 는 거래소코드(예: CME)여야 한다: ${exchange}`);
        return base;
    }

    /** 장내채권 종목코드 인자(표준코드 12자리, 예: `KR2033022D33`). 모양이 틀리면 요청 전에 `BadRequest`다. */
    private bondCode(code: string, method: string): string {
        const base = (code ?? '').trim().toUpperCase();
        if (!/^[A-Z]{2}[0-9A-Z]{10}$/.test(base)) throw new BadRequest(`${this.id} ${method}() 의 code 는 채권 표준코드 12자리여야 한다: ${code}`);
        return base;
    }

    /**
     * 국내옵션전광판_콜풋(`display-board-callput`, TR `FHPIF05030100`). 만기(`expiry`, `YYYYMM`)는 전체 값이 없는 필수 입력이라 호출하는 쪽이 고른다
     * (`fetchOptionExpiries`가 목록을 준다). 시장(`O`), 화면(`20503`), 콜(`CO`)과 풋(`PO`) 시장 구분은 예제값이다. 응답은 블록 원문이다.
     */
    async fetchOptionBoard(expiry: string, params: Dict = {}): Promise<KisResponseBlocks> {
        if (expiry === undefined) throw new ArgumentsRequired(`${this.id} fetchOptionBoard() 는 expiry(만기 년월 YYYYMM) 인자가 필요하다`);
        if (!/^\d{6}$/.test(expiry)) throw new BadRequest(`${this.id} fetchOptionBoard() 의 expiry 는 YYYYMM 여섯 자리여야 한다: ${expiry}`);
        const response = await this.privateGetUapiDomesticFutureoptionV1QuotationsDisplayBoardCallput(this.extend({
            FID_COND_MRKT_DIV_CODE: 'O',
            FID_COND_SCR_DIV_CODE: '20503',
            FID_MRKT_CLS_CODE: 'CO',
            FID_MTRT_CNT: expiry,
            FID_MRKT_CLS_CODE1: 'PO',
            FID_COND_MRKT_CLS_CODE: '',
            tr_id: 'FHPIF05030100',
        }, params));
        return this.responseBlocks(response);
    }

    /** 국내옵션전광판_선물(`display-board-futures`, TR `FHPIF05030200`). 시장(`F`), 화면(`20503`), 시장 구분(`MKI`)은 예제값이다. */
    async fetchFuturesBoard(params: Dict = {}): Promise<KisFuturesBoardItem[]> {
        const response = await this.privateGetUapiDomesticFutureoptionV1QuotationsDisplayBoardFutures(this.extend({
            FID_COND_MRKT_DIV_CODE: 'F',
            FID_COND_SCR_DIV_CODE: '20503',
            FID_COND_MRKT_CLS_CODE: 'MKI',
            tr_id: 'FHPIF05030200',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            code: this.safeString(row, 'futs_shrn_iscd', ''),
            name: this.safeString(row, 'hts_kor_isnm') || undefined,
            price: this.safeNumber(row, 'futs_prpr'),
            change: this.safeNumber(row, 'futs_prdy_vrss'),
            percentage: this.safeNumber(row, 'futs_prdy_ctrt'),
            high: this.safeNumber(row, 'futs_hgpr'),
            low: this.safeNumber(row, 'futs_lwpr'),
            volume: this.safeNumber(row, 'acml_vol'),
            openInterest: this.safeNumber(row, 'hts_otst_stpl_qty'),
            bid: this.safeNumber(row, 'futs_bidp'),
            ask: this.safeNumber(row, 'futs_askp'),
            totalBidSize: this.safeNumber(row, 'total_bidp_rsqn'),
            totalAskSize: this.safeNumber(row, 'total_askp_rsqn'),
            theoreticalPrice: this.safeNumber(row, 'hts_thpr'),
            remainingDays: this.safeNumber(row, 'hts_rmnn_dynu'),
            expectedPrice: this.safeNumber(row, 'futs_antc_cnpr'),
            expectedChange: this.safeNumber(row, 'futs_antc_cntg_vrss'),
            expectedChangeRate: this.safeNumber(row, 'antc_cntg_prdy_ctrt'),
            info: row,
        }));
    }

    /** 국내옵션전광판_옵션월물리스트(`display-board-option-list`, TR `FHPIO056104C0`). 화면(`509`)은 예제값이고, 설명 없는 선택 입력은 비운다. */
    async fetchOptionExpiries(params: Dict = {}): Promise<KisOptionExpiry[]> {
        const response = await this.privateGetUapiDomesticFutureoptionV1QuotationsDisplayBoardOptionList(this.extend({
            FID_COND_SCR_DIV_CODE: '509',
            FID_COND_MRKT_DIV_CODE: '',
            FID_COND_MRKT_CLS_CODE: '',
            tr_id: 'FHPIO056104C0',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            code: this.safeString(row, 'mtrt_yymm_code', ''),
            yearMonth: this.safeString(row, 'mtrt_yymm') || undefined,
            info: row,
        }));
    }

    /** 국내선물 기초자산 시세(`display-board-top`, TR `FHPIF05030000`). 시장(`F`)은 예제값이고 설명 없는 선택 입력은 비운다. 응답은 블록 원문이다. */
    async fetchFuturesUnderlyingBoard(code: string, params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiDomesticFutureoptionV1QuotationsDisplayBoardTop(this.extend({
            FID_COND_MRKT_DIV_CODE: 'F',
            FID_INPUT_ISCD: this.derivativeCode(code, 'fetchFuturesUnderlyingBoard'),
            FID_COND_MRKT_DIV_CODE1: '',
            FID_COND_SCR_DIV_CODE: '',
            FID_MTRT_CNT: '',
            FID_COND_MRKT_CLS_CODE: '',
            tr_id: 'FHPIF05030000',
        }, params));
        return this.responseBlocks(response);
    }

    /**
     * 선물옵션 일중예상체결추이(`exp-price-trend`, TR `FHPIF05110100`). 시장(`F`)은 예제값이다. 응답은 블록 원문이다(예제 필드 목록의 한국어 이름도
     * 필드와 어긋나 있다).
     */
    async fetchFuturesExpectedTrend(code: string, params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiDomesticFutureoptionV1QuotationsExpPriceTrend(this.extend({
            FID_INPUT_ISCD: this.derivativeCode(code, 'fetchFuturesExpectedTrend'),
            FID_COND_MRKT_DIV_CODE: 'F',
            tr_id: 'FHPIF05110100',
        }, params));
        return this.responseBlocks(response);
    }

    /**
     * 선물옵션 시세호가(`inquire-asking-price`, TR `FHMIF10010000`, 모의도 같다). 시장구분은 지수선물(`F`)이 예제값이고, 주식선물(`JF`) 등은 `params`로 바꾼다.
     * 응답은 블록 원문이다.
     */
    async fetchDerivativeOrderBook(code: string, params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiDomesticFutureoptionV1QuotationsInquireAskingPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'F',
            FID_INPUT_ISCD: this.derivativeCode(code, 'fetchDerivativeOrderBook'),
            tr_id: 'FHMIF10010000',
        }, params));
        return this.responseBlocks(response);
    }

    /** 선물옵션 시세(`inquire-price`, TR `FHMIF10000000`, 모의도 같다). 시장구분은 지수선물(`F`)이 예제값이다. 응답은 세 블록의 원문이다. */
    async fetchDerivativePrice(code: string, params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiDomesticFutureoptionV1QuotationsInquirePrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'F',
            FID_INPUT_ISCD: this.derivativeCode(code, 'fetchDerivativePrice'),
            tr_id: 'FHMIF10000000',
        }, params));
        return this.responseBlocks(response, true);
    }

    /**
     * 선물옵션기간별시세(`inquire-daily-fuopchartprice`, TR `FHKIF03020100`, 모의도 같다). `timeframe`은 `1d`, `1w`, `1M`, `1y`다. 기간 시작(`since`)은
     * 필수이고 끝은 `params.until`(없으면 오늘)이다. 시장구분은 지수선물(`F`)이 예제값이다. 응답은 블록 원문이다.
     */
    async fetchDerivativeCandles(code: string, timeframe = '1d', since: Int = undefined, params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchDerivativeCandles', undefined, params);
        const iscd = this.derivativeCode(code, 'fetchDerivativeCandles');
        const period = KIS_DERIVATIVE_PERIODS[timeframe];
        if (period === undefined) throw new NotSupported(`${this.id} fetchDerivativeCandles() 는 ${Object.keys(KIS_DERIVATIVE_PERIODS).join(', ')} 만 지원한다: ${timeframe}`);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchDerivativeCandles() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticFutureoptionV1QuotationsInquireDailyFuopchartprice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'F',
            FID_INPUT_ISCD: iscd,
            FID_INPUT_DATE_1: kstYmd(since),
            FID_INPUT_DATE_2: kstYmd(until ?? this.milliseconds()),
            FID_PERIOD_DIV_CODE: period,
            tr_id: 'FHKIF03020100',
        }, query));
        return this.responseBlocks(response);
    }

    /**
     * 선물옵션 분봉조회(`inquire-time-fuopchartprice`, TR `FHKIF03020200`). `timeframe`은 설명에 적힌 `30s`, `1m`이다. 입력 날짜1과 입력 시간1에는
     * `at`(없으면 지금)의 한국 날짜와 시각을 넣는다. 과거 데이터 포함(`Y`)과 허봉 포함(`N`)은 예제값이다. 응답은 블록 원문이다.
     */
    async fetchDerivativeMinuteCandles(code: string, timeframe = '1m', at: Int = undefined, params: Dict = {}): Promise<KisResponseBlocks> {
        const iscd = this.derivativeCode(code, 'fetchDerivativeMinuteCandles');
        const seconds = KIS_DERIVATIVE_MINUTE_SECONDS[timeframe];
        if (seconds === undefined) throw new NotSupported(`${this.id} fetchDerivativeMinuteCandles() 는 ${Object.keys(KIS_DERIVATIVE_MINUTE_SECONDS).join(', ')} 만 지원한다: ${timeframe}`);
        const when = at ?? this.milliseconds();
        const response = await this.privateGetUapiDomesticFutureoptionV1QuotationsInquireTimeFuopchartprice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'F',
            FID_INPUT_ISCD: iscd,
            FID_HOUR_CLS_CODE: seconds,
            FID_PW_DATA_INCU_YN: 'Y',
            FID_FAKE_TICK_INCU_YN: 'N',
            FID_INPUT_DATE_1: kstYmd(when),
            FID_INPUT_HOUR_1: kstHms(when),
            tr_id: 'FHKIF03020200',
        }, params));
        return this.responseBlocks(response);
    }

    /** 해외선물옵션 현재가 한 건을 정리한다. 선물과 옵션 응답이 같은 필드를 쓴다. */
    private overseasDerivativeQuote(output: Dict): KisOverseasDerivativeQuote {
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        return {
            exchangeCode: text('exch_cd'),
            currency: text('crc_cd'),
            price: num('last_price'),
            open: num('open_price'),
            high: num('high_price'),
            low: num('low_price'),
            previousClose: num('prev_price'),
            settlementPrice: num('sttl_price'),
            change: num('prev_diff_price'),
            percentage: num('prev_diff_rate'),
            changeFlag: text('prev_diff_flag'),
            volume: num('vol'),
            lastQuantity: num('last_qntt'),
            bid: num('bid_price'),
            bidSize: num('bid_qntt'),
            ask: num('ask_price'),
            askSize: num('ask_qntt'),
            totalBidSize: num('tot_bid_qntt'),
            totalAskSize: num('tot_ask_qntt'),
            margin: num('trst_mgn'),
            tickSize: num('tick_size'),
            listingDate: text('trd_fr_date'),
            expiryDate: text('expr_date'),
            lastTradeDate: text('trd_to_date'),
            remainingDays: num('remn_cnt'),
            businessDate: text('sbsnsdate'),
            info: output,
        };
    }

    /** 해외선물옵션 계약 정보 한 건을 정리한다. 종목상세와 상품기본정보가 같은 필드를 쓴다. */
    private overseasDerivativeContract(row: Dict): KisOverseasDerivativeContract {
        const num = (key: string): number | undefined => this.safeNumber(row, key);
        const text = (key: string): string | undefined => this.safeString(row, key) || undefined;
        return {
            exchangeCode: text('exch_cd'),
            classCode: text('clas_cd'),
            currency: text('crc_cd'),
            settlementPrice: num('sttl_price'),
            settlementDate: text('sttl_date'),
            previousClose: num('prev_price'),
            margin: num('trst_mgn'),
            tickSize: num('tick_sz'),
            tickValue: num('tick_val'),
            contractSize: num('ctrt_size'),
            priceDisplayDigit: text('disp_digit'),
            marketOpenDate: text('mrkt_open_date'),
            marketOpenTime: text('mrkt_open_time'),
            marketCloseDate: text('mrkt_close_date'),
            marketCloseTime: text('mrkt_close_time'),
            listingDate: text('trd_fr_date'),
            expiryDate: text('expr_date'),
            lastTradeDate: text('trd_to_date'),
            firstNoticeDate: text('frst_noti_date'),
            remainingDays: num('remn_cnt'),
            tradeStatus: text('stat_tp'),
            settlementType: text('stl_tp'),
            info: row,
        };
    }

    /** 해외선물종목현재가(`overseas-futureoption/inquire-price`, TR `HHDFC55010000`). */
    async fetchOverseasFuturesQuote(code: string, params: Dict = {}): Promise<KisOverseasDerivativeQuote> {
        const response = await this.privateGetUapiOverseasFutureoptionV1QuotationsInquirePrice(this.extend({
            SRS_CD: this.overseasDerivativeCode(code, 'fetchOverseasFuturesQuote'),
            tr_id: 'HHDFC55010000',
        }, params));
        return this.overseasDerivativeQuote(firstRow(this.safeValue(response, 'output1')));
    }

    /** 해외옵션종목현재가(`opt-price`, TR `HHDFO55010000`). 응답에 전일종가가 없어 `previousClose`는 빈다. */
    async fetchOverseasOptionQuote(code: string, params: Dict = {}): Promise<KisOverseasDerivativeQuote> {
        const response = await this.privateGetUapiOverseasFutureoptionV1QuotationsOptPrice(this.extend({
            SRS_CD: this.overseasDerivativeCode(code, 'fetchOverseasOptionQuote'),
            tr_id: 'HHDFO55010000',
        }, params));
        return this.overseasDerivativeQuote(firstRow(this.safeValue(response, 'output1')));
    }

    /** 해외선물종목상세(`stock-detail`, TR `HHDFC55010100`). 스프레드 종목 등은 `info`에 둔다. */
    async fetchOverseasFuturesDetail(code: string, params: Dict = {}): Promise<KisOverseasDerivativeContract> {
        const response = await this.privateGetUapiOverseasFutureoptionV1QuotationsStockDetail(this.extend({
            SRS_CD: this.overseasDerivativeCode(code, 'fetchOverseasFuturesDetail'),
            tr_id: 'HHDFC55010100',
        }, params));
        return this.overseasDerivativeContract(firstRow(this.safeValue(response, 'output1')));
    }

    /** 해외옵션종목상세(`opt-detail`, TR `HHDFO55010100`). */
    async fetchOverseasOptionDetail(code: string, params: Dict = {}): Promise<KisOverseasDerivativeContract> {
        const response = await this.privateGetUapiOverseasFutureoptionV1QuotationsOptDetail(this.extend({
            SRS_CD: this.overseasDerivativeCode(code, 'fetchOverseasOptionDetail'),
            tr_id: 'HHDFO55010100',
        }, params));
        return this.overseasDerivativeContract(firstRow(this.safeValue(response, 'output1')));
    }

    /** 해외선물옵션 상품기본정보의 공통 부분. 요청개수(`QRY_CNT`)와 종목코드(`SRS_CD_01`~)를 채운다. */
    private async overseasDerivativeContracts(kind: 'futures' | 'option', codes: string[], method: string, params: Dict): Promise<KisOverseasDerivativeContract[]> {
        const limit = KIS_OVERSEAS_CONTRACT_LIMITS[kind];
        if (!Array.isArray(codes) || codes.length === 0) throw new ArgumentsRequired(`${this.id} ${method}() 는 codes(종목코드 1~${limit}개) 인자가 필요하다`);
        if (codes.length > limit) throw new BadRequest(`${this.id} ${method}() 는 한 번에 종목 ${limit}개까지다: ${codes.length}`);
        const request: Dict = { QRY_CNT: String(codes.length) };
        codes.forEach((code, i) => {
            request[`SRS_CD_${String(i + 1).padStart(2, '0')}`] = this.overseasDerivativeCode(code, method);
        });
        const call = this[kisImplicitGet(`uapi/overseas-futureoption/v1/quotations/${kind === 'futures' ? 'search-contract-detail' : 'search-opt-detail'}`)] as (request: Dict) => Promise<unknown>;
        const response = await call.call(this, this.extend({ ...request, tr_id: kind === 'futures' ? 'HHDFC55200000' : 'HHDFO55200000' }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => this.overseasDerivativeContract(row));
    }

    /** 해외선물 상품기본정보(`search-contract-detail`, TR `HHDFC55200000`). 한 번에 종목 32개까지다. 응답 행에 종목코드가 없다. */
    async fetchOverseasFuturesContracts(codes: string[], params: Dict = {}): Promise<KisOverseasDerivativeContract[]> {
        return await this.overseasDerivativeContracts('futures', codes, 'fetchOverseasFuturesContracts', params);
    }

    /** 해외옵션 상품기본정보(`search-opt-detail`, TR `HHDFO55200000`). 한 번에 종목 30개까지다. 응답 행에 종목코드가 없다. */
    async fetchOverseasOptionContracts(codes: string[], params: Dict = {}): Promise<KisOverseasDerivativeContract[]> {
        return await this.overseasDerivativeContracts('option', codes, 'fetchOverseasOptionContracts', params);
    }

    /** 해외선물 호가(`overseas-futureoption/inquire-asking-price`, TR `HHDFC86000000`). 응답은 블록 원문이다. */
    async fetchOverseasFuturesOrderBook(code: string, params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiOverseasFutureoptionV1QuotationsInquireAskingPrice(this.extend({
            SRS_CD: this.overseasDerivativeCode(code, 'fetchOverseasFuturesOrderBook'),
            tr_id: 'HHDFC86000000',
        }, params));
        return this.responseBlocks(response);
    }

    /** 해외옵션 호가(`opt-asking-price`, TR `HHDFO86000000`). 응답은 블록 원문이다. */
    async fetchOverseasOptionOrderBook(code: string, params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiOverseasFutureoptionV1QuotationsOptAskingPrice(this.extend({
            SRS_CD: this.overseasDerivativeCode(code, 'fetchOverseasOptionOrderBook'),
            tr_id: 'HHDFO86000000',
        }, params));
        return this.responseBlocks(response);
    }

    /**
     * 해외선물옵션 장운영시간(`market-time`, TR `OTFM2229R`). 옵션여부는 예제값(`N`)이다. 상품군, 클래스, 거래소 코드는 설명 없는 선택 입력이라 비운다
     * (예제는 거래소에 `CME`를 넣는다). 연속조회는 따라가지 않는다.
     */
    async fetchOverseasDerivativeMarketHours(params: Dict = {}): Promise<KisOverseasDerivativeMarketHours[]> {
        const response = await this.privateGetUapiOverseasFutureoptionV1QuotationsMarketTime(this.extend({
            FM_PDGR_CD: '',
            FM_CLAS_CD: '',
            FM_EXCG_CD: '',
            OPT_YN: 'N',
            CTX_AREA_NK200: '',
            CTX_AREA_FK200: '',
            tr_id: 'OTFM2229R',
        }, params));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            productGroupCode: text(row, 'fm_pdgr_cd'),
            productGroupName: text(row, 'fm_pdgr_name'),
            exchangeCode: text(row, 'fm_excg_cd'),
            exchangeName: text(row, 'fm_excg_name'),
            classCode: text(row, 'fm_clas_cd'),
            className: text(row, 'fm_clas_name'),
            typeName: text(row, 'fuop_dvsn_name'),
            amStart: text(row, 'am_mkmn_strt_tmd'),
            amEnd: text(row, 'am_mkmn_end_tmd'),
            pmStart: text(row, 'pm_mkmn_strt_tmd'),
            pmEnd: text(row, 'pm_mkmn_end_tmd'),
            nextDayStart: text(row, 'mkmn_nxdy_strt_tmd'),
            nextDayEnd: text(row, 'mkmn_nxdy_end_tmd'),
            baseStart: text(row, 'base_mket_strt_tmd'),
            baseEnd: text(row, 'base_mket_end_tmd'),
            info: row,
        }));
    }

    /**
     * 해외선물 미결제추이(`investor-unpd-trend`, TR `HHDDB95030000`). 상품(`product`)은 설명이 나열한 코드(GE, ES, CL, 6E 등) 중 하나다. 기준일(`params.until`의 한국 날짜,
     * `YYYYMMDD`)은 필수 입력이라 기본값을 오늘(한국 날짜)로 둔다. 업무구분은 예제의 수량(`0`)이다. 응답은 블록 원문이다.
     */
    async fetchOverseasFuturesOpenInterest(product: string, params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchOverseasFuturesOpenInterest', undefined, params);
        if (product === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasFuturesOpenInterest() 는 product(상품코드, 예: ES) 인자가 필요하다`);
        if (!KIS_OVERSEAS_OPEN_INTEREST_PRODUCTS.has(product)) throw new BadRequest(`${this.id} fetchOverseasFuturesOpenInterest() 의 product 는 설명에 나열된 상품코드여야 한다: ${product}`);
        const response = await this.privateGetUapiOverseasFutureoptionV1QuotationsInvestorUnpdTrend(this.extend({
            PROD_ISCD: product,
            BSOP_DATE: kstYmd(until ?? this.milliseconds()),
            UPMU_GUBUN: '0',
            CTS_KEY: '',
            tr_id: 'HHDDB95030000',
        }, query));
        return this.responseBlocks(response);
    }

    /**
     * 해외선물 체결추이와 분봉. `interval`이 `tick`, `1d`, `1w`, `1M`이면 체결추이(틱, 일간, 주간, 월간)를, `5m`처럼 분이면 분봉(`inquire-time-futurechartprice`,
     * TR `HHDFC55020400`)을 부르고 분 수를 묶음개수(`QRY_GAP`)로 보낸다. 거래소(`exchange`)는 필수다. 조회종료일시는 `params.until`(없으면 오늘)의 한국 날짜이고,
     * 조회구분은 설명의 최초조회(`Q`), 요청개수는 예제값(체결추이 30, 분봉 120)이다. 다음 페이지(`INDEX_KEY`)는 따라가지 않는다. 응답은 블록 원문이다.
     */
    async fetchOverseasFuturesTrend(code: string, exchange: string, interval = '1d', params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchOverseasFuturesTrend', undefined, params);
        const srs = this.overseasDerivativeCode(code, 'fetchOverseasFuturesTrend');
        const exch = this.overseasDerivativeExchange(exchange, 'fetchOverseasFuturesTrend');
        const minutes = /^(\d+)m$/.exec(interval);
        const spec = KIS_OVERSEAS_DERIVATIVE_TRENDS.futures[interval];
        if (spec === undefined && minutes === null) throw new NotSupported(`${this.id} fetchOverseasFuturesTrend() 는 tick, 1d, 1w, 1M, 분(예: 5m)만 지원한다: ${interval}`);
        const [path, trId] = spec ?? ['inquire-time-futurechartprice', 'HHDFC55020400'];
        const call = this[kisImplicitGet(`uapi/overseas-futureoption/v1/quotations/${path}`)] as (request: Dict) => Promise<unknown>;
        const response = await call.call(this, this.extend({
            SRS_CD: srs,
            EXCH_CD: exch,
            START_DATE_TIME: '',
            CLOSE_DATE_TIME: kstYmd(until ?? this.milliseconds()),
            QRY_TP: 'Q',
            QRY_CNT: minutes ? '120' : '30',
            QRY_GAP: minutes ? minutes[1] : '',
            INDEX_KEY: '',
            tr_id: trId,
        }, query));
        return this.responseBlocks(response);
    }

    /**
     * 해외옵션 체결추이(`interval`: `tick`, `1d`, `1w`, `1M`). 거래소(`exchange`)는 필수다. 요청개수(30)는 예제값이고, 예제가 비워 보내는 조회구분,
     * 조회일시, 묶음개수도 비운다. `params.until`을 주면 조회종료일시에 그 한국 날짜를 넣는다. 해외옵션 분봉은 예제가 일간과 같은 TR 을 적어 넣지 않았다.
     * 응답은 블록 원문이다.
     */
    async fetchOverseasOptionTrend(code: string, exchange: string, interval = '1d', params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchOverseasOptionTrend', undefined, params);
        const srs = this.overseasDerivativeCode(code, 'fetchOverseasOptionTrend');
        const exch = this.overseasDerivativeExchange(exchange, 'fetchOverseasOptionTrend');
        const spec = KIS_OVERSEAS_DERIVATIVE_TRENDS.option[interval];
        if (spec === undefined) throw new NotSupported(`${this.id} fetchOverseasOptionTrend() 는 tick, 1d, 1w, 1M 만 지원한다: ${interval}`);
        const call = this[kisImplicitGet(`uapi/overseas-futureoption/v1/quotations/${spec[0]}`)] as (request: Dict) => Promise<unknown>;
        const response = await call.call(this, this.extend({
            SRS_CD: srs,
            EXCH_CD: exch,
            QRY_CNT: '30',
            START_DATE_TIME: '',
            CLOSE_DATE_TIME: until === undefined ? '' : kstYmd(until),
            QRY_GAP: '',
            QRY_TP: '',
            INDEX_KEY: '',
            tr_id: spec[1],
        }, query));
        return this.responseBlocks(response);
    }

    /** 장내채권현재가(시세)(`domestic-bond/inquire-price`, TR `FHKBJ773400C0`). 시장구분은 설명의 `B`다. */
    async fetchBondPrice(code: string, params: Dict = {}): Promise<KisBondPrice> {
        const response = await this.privateGetUapiDomesticBondV1QuotationsInquirePrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'B',
            FID_INPUT_ISCD: this.bondCode(code, 'fetchBondPrice'),
            tr_id: 'FHKBJ773400C0',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        return {
            code: this.safeString(output, 'stnd_iscd', ''),
            name: this.safeString(output, 'hts_kor_isnm') || undefined,
            price: num('bond_prpr'),
            change: num('bond_prdy_vrss'),
            percentage: num('prdy_ctrt'),
            previousClose: num('bond_prdy_clpr'),
            open: num('bond_oprc'),
            high: num('bond_hgpr'),
            low: num('bond_lwpr'),
            upperLimit: num('bond_mxpr'),
            lowerLimit: num('bond_llam'),
            volume: num('acml_vol'),
            yieldRate: num('ernn_rate'),
            openYield: num('oprc_ert'),
            highYield: num('hgpr_ert'),
            lowYield: num('lwpr_ert'),
            info: output,
        };
    }

    /** 장내채권현재가(호가)(`domestic-bond/inquire-asking-price`, TR `FHKBJ773401C0`). 매도, 매수 다섯 단계의 가격, 잔량, 수익 비율이다. */
    async fetchBondOrderBook(code: string, params: Dict = {}): Promise<KisBondOrderBook> {
        const response = await this.privateGetUapiDomesticBondV1QuotationsInquireAskingPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'B',
            FID_INPUT_ISCD: this.bondCode(code, 'fetchBondOrderBook'),
            tr_id: 'FHKBJ773401C0',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const levels = (side: 'ask' | 'bid'): KisBondOrderBookLevel[] => [1, 2, 3, 4, 5].map((i) => ({
            price: this.safeNumber(output, side === 'ask' ? `bond_askp${i}` : `bond_bidp${i}`),
            size: this.safeNumber(output, side === 'ask' ? `askp_rsqn${i}` : `bidp_rsqn${i}`),
            yieldRate: this.safeNumber(output, side === 'ask' ? `seln_ernn_rate${i}` : `shnu_ernn_rate${i}`),
        }));
        return {
            time: this.safeString(output, 'aspr_acpt_hour') || undefined,
            asks: levels('ask'),
            bids: levels('bid'),
            totalAskSize: this.safeNumber(output, 'total_askp_rsqn'),
            totalBidSize: this.safeNumber(output, 'total_bidp_rsqn'),
            netBidSize: this.safeNumber(output, 'ntby_aspr_rsqn'),
            info: output,
        };
    }

    /** 장내채권현재가(체결)(`domestic-bond/inquire-ccnl`, TR `FHKBJ773403C0`). */
    async fetchBondTrades(code: string, params: Dict = {}): Promise<KisBondTrade[]> {
        const response = await this.privateGetUapiDomesticBondV1QuotationsInquireCcnl(this.extend({
            FID_COND_MRKT_DIV_CODE: 'B',
            FID_INPUT_ISCD: this.bondCode(code, 'fetchBondTrades'),
            tr_id: 'FHKBJ773403C0',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            time: this.safeString(row, 'stck_cntg_hour') || undefined,
            price: this.safeNumber(row, 'bond_prpr'),
            change: this.safeNumber(row, 'bond_prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'cntg_vol'),
            cumulativeVolume: this.safeNumber(row, 'acml_vol'),
            info: row,
        }));
    }

    /** 장내채권 일별 행을 정리한다. */
    private bondDailyRow(row: Dict): KisBondDailyRow {
        return {
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            date: this.safeString(row, 'stck_bsop_date', ''),
            open: this.safeNumber(row, 'bond_oprc'),
            high: this.safeNumber(row, 'bond_hgpr'),
            low: this.safeNumber(row, 'bond_lwpr'),
            close: this.safeNumber(row, 'bond_prpr'),
            change: this.safeNumber(row, 'bond_prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            info: row,
        };
    }

    /** 장내채권현재가(일별)(`domestic-bond/inquire-daily-price`, TR `FHKBJ773404C0`). */
    async fetchBondDailyPrices(code: string, params: Dict = {}): Promise<KisBondDailyRow[]> {
        const response = await this.privateGetUapiDomesticBondV1QuotationsInquireDailyPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'B',
            FID_INPUT_ISCD: this.bondCode(code, 'fetchBondDailyPrices'),
            tr_id: 'FHKBJ773404C0',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => this.bondDailyRow(row));
    }

    /** 장내채권 기간별시세(일)(`inquire-daily-itemchartprice`, TR `FHKBJ773701C0`). 입력은 시장과 종목뿐이고 기간 입력이 없다. */
    async fetchBondDailyChart(code: string, params: Dict = {}): Promise<KisBondDailyRow[]> {
        const response = await this.privateGetUapiDomesticBondV1QuotationsInquireDailyItemchartprice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'B',
            FID_INPUT_ISCD: this.bondCode(code, 'fetchBondDailyChart'),
            tr_id: 'FHKBJ773701C0',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => this.bondDailyRow(row));
    }

    /** 장내채권 발행정보(`issue-info`, TR `CTPF1101R`). 상품유형코드(`302`)는 예제값이다. */
    async fetchBondIssueInfo(code: string, params: Dict = {}): Promise<KisBondIssueInfo> {
        const response = await this.privateGetUapiDomesticBondV1QuotationsIssueInfo(this.extend({
            PDNO: this.bondCode(code, 'fetchBondIssueInfo'),
            PRDT_TYPE_CD: '302',
            tr_id: 'CTPF1101R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        return {
            code: this.safeString(output, 'pdno', ''),
            name: text('prdt_name'),
            englishName: text('prdt_eng_name'),
            classificationName: text('bond_clsf_kor_name'),
            issuerName: text('issu_istt_name'),
            faceValue: num('papr'),
            issueAmount: num('issu_amt'),
            listedBalance: num('lstg_rmnd'),
            couponRate: num('srfc_inrt'),
            maturityRedemptionRate: num('expd_rdpt_rt'),
            guaranteedYield: num('expd_asrc_erng_rt'),
            interestIntervalMonths: num('int_dfrm_mcnt'),
            issueDate: text('issu_dt'),
            listingDate: text('lstg_dt'),
            maturityDate: text('expd_dt'),
            redemptionDate: text('rdpt_dt'),
            previousInterestDate: text('rgbf_int_dfrm_dt'),
            nextInterestDate: text('nxtm_int_dfrm_dt'),
            creditRatings: { kis: text('kis_crdt_grad_text'), kbp: text('kbp_crdt_grad_text'), nice: text('nice_crdt_grad_text'), fnp: text('fnp_crdt_grad_text') },
            investmentCaution: this.yesNo(output, 'ivst_heed_prdt_yn'),
            info: output,
        };
    }

    /** 장내채권 기본조회(`search-bond-info`, TR `CTPF1114R`). 상품번호는 설명에 필수로 적혀 있어 반드시 받는다(예제는 비운다). 상품유형코드(`302`)는 예제값이다. */
    async fetchBondInfo(code: string, params: Dict = {}): Promise<KisBondInfo> {
        const response = await this.privateGetUapiDomesticBondV1QuotationsSearchBondInfo(this.extend({
            PDNO: this.bondCode(code, 'fetchBondInfo'),
            PRDT_TYPE_CD: '302',
            tr_id: 'CTPF1114R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        return {
            code: this.safeString(output, 'pdno', ''),
            name: text('ksd_bond_item_name'),
            englishName: text('ksd_bond_item_eng_name'),
            classificationName: text('bond_clsf_kor_name'),
            currency: text('iso_crcy_cd'),
            totalIssueAmount: num('ksd_tot_issu_amt'),
            couponRate: num('ksd_rcvg_bond_srfc_inrt'),
            discountRate: num('ksd_rcvg_bond_dsct_rt'),
            maturityRedemptionRate: num('bond_expd_rdpt_rt'),
            guaranteedYield: num('bond_expd_asrc_erng_rt'),
            issueDate: text('issu_dt'),
            redemptionDate: text('rdpt_dt'),
            listingDate: text('lstg_dt'),
            delistingDate: text('lstg_abol_dt'),
            previousInterestDate: text('rgbf_int_dfrm_dt'),
            nextInterestDate: text('nxtm_int_dfrm_dt'),
            defaulted: this.yesNo(output, 'dshn_occr_yn'),
            info: output,
        };
    }

    /**
     * 장내채권 평균단가조회(`avg-unit`, TR `CTPF2005R`). 평가사별 단가와 수익률이다. 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다.
     * 종목(`code`)을 주지 않으면 설명의 전체(공란)를 보낸다. 상품유형코드(`302`)와 검증종류코드(`00`)는 예제값이다. 연속조회는 따라가지 않는다.
     * 응답은 세 블록의 원문이다.
     */
    async fetchBondEvaluations(code: Str = undefined, since: Int = undefined, params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchBondEvaluations', undefined, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchBondEvaluations() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticBondV1QuotationsAvgUnit(this.extend({
            INQR_STRT_DT: kstYmd(since),
            INQR_END_DT: kstYmd(until ?? this.milliseconds()),
            PDNO: code === undefined ? '' : this.bondCode(code, 'fetchBondEvaluations'),
            PRDT_TYPE_CD: '302',
            VRFC_KIND_CD: '00',
            CTX_AREA_NK30: '',
            CTX_AREA_FK100: '',
            tr_id: 'CTPF2005R',
        }, query));
        return this.responseBlocks(response, true);
    }

    /**
     * ELW 종목검색(`cond-search`, TR `FHKEW15100000`). 시장(`W`), 화면(`11510`), 정렬(`0` 정렬안함)은 설명의 값이고, 정렬1기준은 설명의 상위(`1`)다
     * (예제는 `100`을 넣는다). 나머지 선택 입력 53개는 예제처럼 비우고 `params`로 받는다. 예제 필드 목록의 종목코드 필드가 `bond_shrn_iscd`로만 적혀 있어
     * 행을 정리하지 않고 원문으로 돌려준다.
     */
    async fetchElwSearch(params: Dict = {}): Promise<Dict[]> {
        const empty = [
            'FID_RANK_SORT_CLS_CODE_2', 'FID_INPUT_CNT_2', 'FID_RANK_SORT_CLS_CODE_3', 'FID_INPUT_CNT_3', 'FID_TRGT_CLS_CODE', 'FID_INPUT_ISCD', 'FID_UNAS_INPUT_ISCD',
            'FID_MRKT_CLS_CODE', 'FID_INPUT_DATE_1', 'FID_INPUT_DATE_2', 'FID_INPUT_ISCD_2', 'FID_ETC_CLS_CODE', 'FID_INPUT_RMNN_DYNU_1', 'FID_INPUT_RMNN_DYNU_2',
            'FID_PRPR_CNT1', 'FID_PRPR_CNT2', 'FID_RSFL_RATE1', 'FID_RSFL_RATE2', 'FID_VOL1', 'FID_VOL2', 'FID_APLY_RANG_PRC_1', 'FID_APLY_RANG_PRC_2',
            'FID_LVRG_VAL1', 'FID_LVRG_VAL2', 'FID_VOL3', 'FID_VOL4', 'FID_INTS_VLTL1', 'FID_INTS_VLTL2', 'FID_PRMM_VAL1', 'FID_PRMM_VAL2', 'FID_GEAR1', 'FID_GEAR2',
            'FID_PRLS_QRYR_RATE1', 'FID_PRLS_QRYR_RATE2', 'FID_DELTA1', 'FID_DELTA2', 'FID_ACPR1', 'FID_ACPR2', 'FID_STCK_CNVR_RATE1', 'FID_STCK_CNVR_RATE2',
            'FID_DIV_CLS_CODE', 'FID_PRIT1', 'FID_PRIT2', 'FID_CFP1', 'FID_CFP2', 'FID_INPUT_NMIX_PRICE_1', 'FID_INPUT_NMIX_PRICE_2', 'FID_EGEA_VAL1', 'FID_EGEA_VAL2',
            'FID_INPUT_DVDN_ERT', 'FID_INPUT_HIST_VLTL', 'FID_THETA1', 'FID_THETA2',
        ];
        const response = await this.privateGetUapiElwV1QuotationsCondSearch(this.extend({
            FID_COND_MRKT_DIV_CODE: 'W',
            FID_COND_SCR_DIV_CODE: '11510',
            FID_RANK_SORT_CLS_CODE: '0',
            FID_INPUT_CNT_1: '1',
            ...Object.fromEntries(empty.map((key) => [key, ''])),
            tr_id: 'FHKEW15100000',
        }, params));
        return rowsOf(this.safeValue(response, 'output'));
    }

    /** ELW LP매매추이(`lp-trade-trend`, TR `FHPEW03760000`). 시장구분은 `W`다. 응답은 블록 원문이다. */
    async fetchElwLpTrades(code: string, params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiElwV1QuotationsLpTradeTrend(this.extend({
            FID_COND_MRKT_DIV_CODE: 'W',
            FID_INPUT_ISCD: this.elwCode(code, 'fetchElwLpTrades'),
            tr_id: 'FHPEW03760000',
        }, params));
        return this.responseBlocks(response);
    }

    /** ELW 변동성추이(틱)(`volatility-trend-tick`, TR `FHPEW02840400`). 예제 필드 목록의 한국어 이름이 필드와 어긋나 있어 행을 원문으로 돌려준다. */
    async fetchElwVolatilityTicks(code: string, params: Dict = {}): Promise<Dict[]> {
        const response = await this.privateGetUapiElwV1QuotationsVolatilityTrendTick(this.extend({
            FID_COND_MRKT_DIV_CODE: 'W',
            FID_INPUT_ISCD: this.elwCode(code, 'fetchElwVolatilityTicks'),
            tr_id: 'FHPEW02840400',
        }, params));
        return rowsOf(this.safeValue(response, 'output'));
    }

    /**
     * 프로그램매매 종합현황(일간)(`comp-program-trade-daily`, TR `FHPPG04600001`). 시장(`market`, 코스피 `K`, 코스닥 `Q`)은 전체 값이 없는 필수 입력이다.
     * 조건시장은 KRX(`J`)가 예제값이고, 검색 기간은 선택 입력이라 `since`, `params.until`을 주지 않으면 비운다. 응답 필드 100여 개 가운데 합계 필드 이름이 출처마다
     * 달라(cluefin `arbt_smtn_ntby_qty`, 예제 `arbt_smtm_ntby_qty`) 행을 정리하지 않고 원문으로 돌려준다.
     */
    async fetchProgramTradingDaily(market: KisMarket, since: Int = undefined, params: Dict = {}): Promise<Dict[]> {
        const [until, query] = this.handleUntilParam('fetchProgramTradingDaily', undefined, params);
        const response = await this.privateGetUapiDomesticStockV1QuotationsCompProgramTradeDaily(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_MRKT_CLS_CODE: this.marketCode(market, { KOSPI: 'K', KOSDAQ: 'Q' }, 'fetchProgramTradingDaily'),
            FID_INPUT_DATE_1: since === undefined ? '' : kstYmd(since),
            FID_INPUT_DATE_2: until === undefined ? '' : kstYmd(until),
            tr_id: 'FHPPG04600001',
        }, query));
        return rowsOf(this.safeValue(response, 'output'));
    }

    /**
     * 프로그램매매 종합현황(시간)(`comp-program-trade-today`, TR `FHPPG04600101`). 시장(`market`)은 필수이고, 설명 없는 선택 입력(구간, 종목, 시장분류,
     * 시간)은 비운다. 두 출처의 필드 목록이 크게 달라(예제 15개, cluefin 11개 중 겹치는 것 2개) 행을 원문으로 돌려준다.
     */
    async fetchProgramTradingToday(market: KisMarket, params: Dict = {}): Promise<Dict[]> {
        const response = await this.privateGetUapiDomesticStockV1QuotationsCompProgramTradeToday(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_MRKT_CLS_CODE: this.marketCode(market, { KOSPI: 'K', KOSDAQ: 'Q' }, 'fetchProgramTradingToday'),
            FID_SCTN_CLS_CODE: '',
            FID_INPUT_ISCD: '',
            FID_COND_MRKT_DIV_CODE1: '',
            FID_INPUT_HOUR_1: '',
            tr_id: 'FHPPG04600101',
        }, params));
        return rowsOf(this.safeValue(response, 'output'));
    }

    /**
     * 국내주식 종목추정실적(`estimate-perform`, TR `HHKST668300C0`). 국내만 지원한다. 응답이 네 블록이고 실적 값이 `data1`~`data5` 같은 일반 이름이라
     * 블록 원문을 돌려준다.
     */
    async fetchEstimatedPerformance(symbol: string, params: Dict = {}): Promise<KisResponseBlocks> {
        const { code } = this.domesticInstrument(symbol, 'fetchEstimatedPerformance');
        const response = await this.privateGetUapiDomesticStockV1QuotationsEstimatePerform(this.extend({
            SHT_CD: code,
            tr_id: 'HHKST668300C0',
        }, params));
        return { ...this.responseBlocks(response, true), output4: this.safeValue(response, 'output4') as KisResponseBlock };
    }

    /**
     * 해외주식 지정가체결내역조회(`inquire-algo-ccnl`, TR `TTTS6059R`). 주문번호(`orderId`)는 선택 입력이고, 설명 없는 선택 입력(주문일자, 지점번호,
     * 집계포함여부)은 비운다. 응답 블록 이름이 출처마다 달라(예제 `output`, `output3`, cluefin `output1`, `output2`) 네 이름을 모두 원문으로 담는다.
     * 예제에 모의 TR 이 없어 실전 TR 을 그대로 보낸다.
     */
    async fetchOverseasAlgoFills(orderId: Str = undefined, params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiOverseasStockV1TradingInquireAlgoCcnl(this.extend({
            ...this.accountParams(),
            ORD_DT: '',
            ORD_GNO_BRNO: '',
            ODNO: orderId ?? '',
            TTLZ_ICLD_YN: '',
            CTX_AREA_NK200: '',
            CTX_AREA_FK200: '',
            tr_id: 'TTTS6059R',
        }, params));
        return { ...this.responseBlocks(response, true), output: this.safeValue(response, 'output') as KisResponseBlock };
    }

    /** 매도매수구분코드(`sll_buy_dvsn_cd`)를 방향으로. `01` 매도, `02` 매수, 그 밖은 `unknown`이다. */
    private sideOfRow(row: Dict): 'buy' | 'sell' | 'unknown' {
        const code = this.safeString(row, 'sll_buy_dvsn_cd');
        return code === SIDE_CODE_SELL ? 'sell' : code === SIDE_CODE_BUY ? 'buy' : 'unknown';
    }

    /** 주문 방향 인자를 매도매수구분코드(`01` 매도, `02` 매수)로. */
    private sideCode(side: OrderSide, method: string): string {
        if (side === 'buy') return SIDE_CODE_BUY;
        if (side === 'sell') return SIDE_CODE_SELL;
        throw new BadRequest(`${this.id} ${method}() 의 side 는 buy 나 sell 이어야 한다: ${side}`);
    }

    /** 주문 수량 인자. 양의 정수가 아니면 요청 전에 `InvalidOrder`다(소수 수량을 조용히 내리지 않는다). */
    private integerQuantity(amount: Num, method: string): string {
        if (amount === undefined || amount === null || !Number.isInteger(amount) || amount <= 0) {
            throw new InvalidOrder(`${this.id} ${method}() 의 amount 는 양의 정수여야 한다: ${amount}`);
        }
        return String(amount);
    }

    /** 주문 가격 인자. 없으면 `ArgumentsRequired`, 양수가 아니면 `InvalidOrder`다. */
    private positivePrice(price: Num, method: string): string {
        if (price === undefined || price === null) throw new ArgumentsRequired(`${this.id} ${method}() 는 price 인자가 필요하다`);
        if (!Number.isFinite(price) || price <= 0) throw new InvalidOrder(`${this.id} ${method}() 의 price 는 양수여야 한다: ${price}`);
        return numberToString(price);
    }

    /**
     * 확장 주문 API 의 접수 결과. KIS 주문 응답은 필드 이름을 대문자로 준다(기존 주문 경로가 `ODNO`를 읽는다). 예제 필드 목록은 소문자라 두 표기를
     * 모두 읽는다.
     */
    private orderAck(response: unknown, method: string, idKey: string, dateKey: string | undefined = undefined): KisOrderAck {
        const output = firstRow(this.safeValue(response as Dict, 'output'));
        const read = (key: string | undefined): string | undefined => (key === undefined ? undefined : this.safeString2(output, key.toUpperCase(), key) || undefined);
        const orderDate = read(dateKey);
        const orderTime = read('ord_tmd');
        // 방금 접수한 주문이라 응답에 일자가 없으면 오늘(한국 날짜)이다.
        const ack = { ...this.kstStamp(orderDate ?? kstYmd(this.milliseconds()), orderTime), orderId: read(idKey), orderDate, orderTime, info: output };
        logger.info({ method, orderId: ack.orderId }, '[kis] 확장 주문 접수');
        return ack;
    }

    /** 선물옵션 잔고현황(`inquire-balance`, TR `CTFO6118R`, 모의 `VTFO6118R`). 증거금 구분(`01`)과 정산상태(`1`)는 예제값이다. 응답은 블록 원문이다. */
    async fetchDerivativeBalance(params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquireBalance(this.extend({
            ...this.accountParams(), MGNA_DVSN: '01', EXCC_STAT_CD: '1', CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: this.tr('CTFO6118R', 'VTFO6118R'),
        }, params));
        return this.responseBlocks(response);
    }

    /** 선물옵션 잔고정산손익내역(`inquire-balance-settlement-pl`, TR `CTFO6117R`). 조회일자(`params.until`의 한국 날짜)는 필수라 기본값을 오늘(한국 날짜)로 둔다. 응답은 블록 원문이다. */
    async fetchDerivativeSettlementPnl(params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchDerivativeSettlementPnl', undefined, params);
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquireBalanceSettlementPl(this.extend({
            ...this.accountParams(), INQR_DT: kstYmd(until ?? this.milliseconds()), CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'CTFO6117R',
        }, query));
        return this.responseBlocks(response);
    }

    /** 선물옵션 잔고평가손익내역(`inquire-balance-valuation-pl`, TR `CTFO6159R`). 증거금 구분(`01`)과 정산상태(`1`)는 예제값이다. 응답은 블록 원문이다. */
    async fetchDerivativeValuationPnl(params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquireBalanceValuationPl(this.extend({
            ...this.accountParams(), MGNA_DVSN: '01', EXCC_STAT_CD: '1', CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'CTFO6159R',
        }, params));
        return this.responseBlocks(response);
    }

    /**
     * 선물옵션 주문체결내역(`inquire-ccnl`, TR `TTTO5201R`, 모의 `VTTO5201R`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다. 매도매수와
     * 체결미체결은 설명의 전체(`00`)이고, 정렬은 예제의 역순(`DS`)이다. 응답은 블록 원문이다.
     */
    async fetchDerivativeOrders(since: Int, params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchDerivativeOrders', undefined, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchDerivativeOrders() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquireCcnl(this.extend({
            ...this.accountParams(), STRT_ORD_DT: kstYmd(since), END_ORD_DT: kstYmd(until ?? this.milliseconds()), SLL_BUY_DVSN_CD: '00', CCLD_NCCS_DVSN: '00', SORT_SQN: 'DS',
            PDNO: '', STRT_ODNO: '', MKET_ID_CD: '', CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: this.tr('TTTO5201R', 'VTTO5201R'),
        }, query));
        return this.responseBlocks(response);
    }

    /**
     * 선물옵션 기준일체결내역(`inquire-ccnl-bstime`, TR `CTFO5139R`). 주문일자(`params.until`의 한국 날짜)는 필수라 기본값을 오늘(한국 날짜)로 둔다. 거래시작과 종료 시각은
     * 예제의 하루 전체(`000000`~`240000`)다. 응답은 블록 원문이다.
     */
    async fetchDerivativeFillsByDate(params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchDerivativeFillsByDate', undefined, params);
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquireCcnlBstime(this.extend({
            ...this.accountParams(), ORD_DT: kstYmd(until ?? this.milliseconds()), FUOP_TR_STRT_TMD: '000000', FUOP_TR_END_TMD: '240000',
            CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'CTFO5139R',
        }, query));
        return this.responseBlocks(response);
    }

    /** 선물옵션 기간약정수수료 일별(`inquire-daily-amount-fee`, TR `CTFO6119R`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다. 응답은 블록 원문이다. */
    async fetchDerivativeDailyFees(since: Int, params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchDerivativeDailyFees', undefined, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchDerivativeDailyFees() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquireDailyAmountFee(this.extend({
            ...this.accountParams(), INQR_STRT_DAY: kstYmd(since), INQR_END_DAY: kstYmd(until ?? this.milliseconds()), CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'CTFO6119R',
        }, query));
        return this.responseBlocks(response);
    }

    /** 선물옵션 총자산현황(`inquire-deposit`, TR `CTRP6550R`). 입력은 계좌뿐이다. */
    async fetchDerivativeDeposit(params: Dict = {}): Promise<KisDerivativeDeposit> {
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquireDeposit(this.extend({ ...this.accountParams(), tr_id: 'CTRP6550R' }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        return {
            deposit: num('dnca_tota'), orderableCash: num('ord_psbl_cash'), orderableTotal: num('ord_psbl_tota'), withdrawable: num('wdrw_psbl_tot_amt'),
            marginCash: num('brkg_mgna_cash'), marginSubstitute: num('brkg_mgna_sbst'), additionalMargin: num('add_mgna_tota'), maintenanceRate: num('mtnc_rt'),
            tradingPnl: num('trad_pfls_smtl'), evaluationPnl: num('evlu_pfls_smtl'), fee: num('brkg_fee'), receivable: num('rcva'),
            nextDayDeposit: num('nxdy_dnca'), estimatedAssets: num('prsm_dpast_amt'), info: output,
        };
    }

    /** (야간)선물옵션 잔고현황(`inquire-ngt-balance`, TR `CTFN6118R`). 증거금 구분(`01`)과 정산상태(`1`)는 예제값이고, 계좌비밀번호는 보내지 않는다. 응답은 블록 원문이다. */
    async fetchNightDerivativeBalance(params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquireNgtBalance(this.extend({
            ...this.accountParams(), MGNA_DVSN: '01', EXCC_STAT_CD: '1', ACNT_PWD: '', CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'CTFN6118R',
        }, params));
        return this.responseBlocks(response);
    }

    /**
     * (야간)선물옵션 주문체결내역(`inquire-ngt-ccnl`, TR `STTN5201R`). 기간 시작(`since`)은 필수다. 설명대로 종료주문일자에는 조회할 마지막 날의 다음날을
     * 넣으므로, `params.until`(없으면 오늘)의 한국 날짜에 하루를 더해 보낸다. 매도매수와 체결미체결은 전체(`00`), 화면구분은 설명의 기본값(`02`)이다. 응답은 블록 원문이다.
     */
    async fetchNightDerivativeOrders(since: Int, params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchNightDerivativeOrders', undefined, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchNightDerivativeOrders() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquireNgtCcnl(this.extend({
            ...this.accountParams(), STRT_ORD_DT: kstYmd(since), END_ORD_DT: kstYmd((until ?? this.milliseconds()) + KIS_DAY_MS), SLL_BUY_DVSN_CD: '00', CCLD_NCCS_DVSN: '00',
            SORT_SQN: '', STRT_ODNO: '', PDNO: '', MKET_ID_CD: '', FUOP_DVSN_CD: '', SCRN_DVSN: '02', CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'STTN5201R',
        }, query));
        return this.responseBlocks(response);
    }

    /** 선물옵션 주문가능 조회 한 건을 정리한다. 청산가능수량 필드 이름이 주간과 야간에서 다르다. */
    private derivativeOrderable(output: Dict, liquidatableKey: string): KisDerivativeOrderable {
        return {
            orderableQuantity: this.safeNumber(output, 'ord_psbl_qty'),
            totalQuantity: this.safeNumber(output, 'tot_psbl_qty'),
            liquidatableQuantity: this.safeNumber(output, liquidatableKey),
            maxQuantity: this.safeNumber(output, 'max_ord_psbl_qty'),
            baseIndex: this.safeNumber(output, 'bass_idx'),
            info: output,
        };
    }

    /**
     * 선물옵션 주문가능(`inquire-psbl-order`, TR `TTTO5105R`, 모의 `VTTO5105R`). `price`를 주면 지정가(`01`)로, 주지 않으면 시장가(`02`)와 가격 `0`으로 묻는다.
     */
    async fetchDerivativeOrderable(code: string, side: OrderSide, price: Num = undefined, params: Dict = {}): Promise<KisDerivativeOrderable> {
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquirePsblOrder(this.extend({
            ...this.accountParams(), PDNO: this.derivativeCode(code, 'fetchDerivativeOrderable'), SLL_BUY_DVSN_CD: this.sideCode(side, 'fetchDerivativeOrderable'),
            UNIT_PRICE: price === undefined ? '0' : numberToString(price), ORD_DVSN_CD: price === undefined ? '02' : '01', tr_id: this.tr('TTTO5105R', 'VTTO5105R'),
        }, params));
        return this.derivativeOrderable(firstRow(this.safeValue(response, 'output')), 'lqd_psbl_qty1');
    }

    /** (야간)선물옵션 주문가능(`inquire-psbl-ngt-order`, TR `STTN5105R`). 상품유형코드는 설명의 선물옵션(`301`)이다. 가격 처리는 주간과 같다. */
    async fetchNightDerivativeOrderable(code: string, side: OrderSide, price: Num = undefined, params: Dict = {}): Promise<KisDerivativeOrderable> {
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingInquirePsblNgtOrder(this.extend({
            ...this.accountParams(), PDNO: this.derivativeCode(code, 'fetchNightDerivativeOrderable'), PRDT_TYPE_CD: '301',
            SLL_BUY_DVSN_CD: this.sideCode(side, 'fetchNightDerivativeOrderable'), UNIT_PRICE: price === undefined ? '0' : numberToString(price),
            ORD_DVSN_CD: price === undefined ? '02' : '01', tr_id: 'STTN5105R',
        }, params));
        return this.derivativeOrderable(firstRow(this.safeValue(response, 'output')), 'lqd_psbl_qty');
    }

    /** (야간)선물옵션 증거금 상세(`ngt-margin-detail`, TR `CTFN7107R`). 증거금 구분은 예제의 위탁(`01`)이다. 응답은 세 블록의 원문이다. */
    async fetchNightDerivativeMargin(params: Dict = {}): Promise<KisResponseBlocks> {
        const response = await this.privateGetUapiDomesticFutureoptionV1TradingNgtMarginDetail(this.extend({ ...this.accountParams(), MGNA_DVSN_CD: '01', tr_id: 'CTFN7107R' }, params));
        return this.responseBlocks(response, true);
    }

    /** 장내채권 잔고조회(`domestic-bond/inquire-balance`, TR `CTSC8407R`). 조회조건은 설명의 전체(`00`)다. 연속조회는 따라가지 않는다. */
    async fetchBondHoldings(params: Dict = {}): Promise<KisBondHolding[]> {
        const response = await this.privateGetUapiDomesticBondV1TradingInquireBalance(this.extend({
            ...this.accountParams(), INQR_CNDT: '00', PDNO: '', BUY_DT: '', CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'CTSC8407R',
        }, params));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            code: this.safeString(row, 'pdno', ''), buyDate: text(row, 'buy_dt'), buySequence: text(row, 'buy_sqno'), maturityDate: text(row, 'exdt'),
            quantity: this.safeNumber(row, 'cblc_qty'), orderableQuantity: this.safeNumber(row, 'ord_psbl_qty'), generalTaxQuantity: this.safeNumber(row, 'agrx_qty'),
            separateTaxQuantity: this.safeNumber(row, 'sprx_qty'), buyPrice: this.safeNumber(row, 'buy_unpr'), buyAmount: this.safeNumber(row, 'buy_amt'),
            buyYield: this.safeNumber(row, 'buy_erng_rt'), info: row,
        }));
    }

    /**
     * 장내채권 일별체결조회(`inquire-daily-ccld`, TR `CTSC8013R`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다(설명: 1주일 이내).
     * 매도매수(`%`)와 미체결여부(`N`)는 설명의 전체이고 정렬은 예제의 주문순서(`01`)다. 응답은 블록 원문이다.
     */
    async fetchBondOrders(since: Int, params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchBondOrders', undefined, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchBondOrders() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticBondV1TradingInquireDailyCcld(this.extend({
            ...this.accountParams(), INQR_STRT_DT: kstYmd(since), INQR_END_DT: kstYmd(until ?? this.milliseconds()), SLL_BUY_DVSN_CD: '%', SORT_SQN_DVSN: '01', PDNO: '',
            NCCS_YN: 'N', CTX_AREA_NK200: '', CTX_AREA_FK200: '', tr_id: 'CTSC8013R',
        }, query));
        return this.responseBlocks(response);
    }

    /** 장내채권 매수가능조회(`domestic-bond/inquire-psbl-order`, TR `TTTC8910R`). 채권주문단가(`price`)는 필수다. */
    async fetchBondBuyableAmount(code: string, price: Num, params: Dict = {}): Promise<KisBondBuyable> {
        const pdno = this.bondCode(code, 'fetchBondBuyableAmount');
        const response = await this.privateGetUapiDomesticBondV1TradingInquirePsblOrder(this.extend({
            ...this.accountParams(), PDNO: pdno, BOND_ORD_UNPR: this.positivePrice(price, 'fetchBondBuyableAmount'), tr_id: 'TTTC8910R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        return {
            orderableCash: num('ord_psbl_cash'), orderableSubstitute: num('ord_psbl_sbst'), reusableAmount: num('ruse_psbl_amt'), cmaEvaluation: num('cma_evlu_amt'),
            price: num('bond_ord_unpr2'), buyableAmount: num('buy_psbl_amt'), buyableQuantity: num('buy_psbl_qty'), info: output,
        };
    }

    /** 채권정정취소가능주문조회(`inquire-psbl-rvsecncl`, TR `CTSC8035R`). 주문일자(`params.until`의 한국 날짜)와 주문번호(`orderId`)는 선택 입력이라 주지 않으면 비운다. */
    async fetchBondModifiableOrders(orderId: Str = undefined, params: Dict = {}): Promise<KisBondModifiableOrder[]> {
        const [until, query] = this.handleUntilParam('fetchBondModifiableOrders', undefined, params);
        const response = await this.privateGetUapiDomesticBondV1TradingInquirePsblRvsecncl(this.extend({
            ...this.accountParams(), ORD_DT: until === undefined ? '' : kstYmd(until), ODNO: orderId ?? '',
            CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'CTSC8035R',
        }, query));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            orderId: this.safeString(row, 'odno', ''), originalOrderId: text(row, 'orgn_odno'), code: text(row, 'pdno'), side: this.sideOfRow(row),
            orderTypeCode: text(row, 'ord_dvsn_cd'), modifyTypeName: text(row, 'rvse_cncl_dvsn_name'), quantity: this.safeNumber(row, 'ord_qty'),
            price: this.safeNumber(row, 'bond_ord_unpr'), filledQuantity: this.safeNumber(row, 'tot_ccld_qty'), filledAmount: this.safeNumber(row, 'tot_ccld_amt'),
            modifiableQuantity: this.safeNumber(row, 'ord_psbl_qty'), orderTime: text(row, 'ord_tmd'), info: row,
        }));
    }

    /** 해외선물옵션 주문 행을 정리한다. 당일 주문내역과 일별 주문내역이 같은 필드를 쓴다. */
    private overseasDerivativeOrder(row: Dict): KisOverseasDerivativeOrder {
        const text = (key: string): string | undefined => this.safeString(row, key) || undefined;
        return {
            orderDate: text('ord_dt'), orderId: this.safeString(row, 'odno', ''), originalOrderDate: text('orgn_ord_dt'), originalOrderId: text('orgn_odno'),
            code: text('ovrs_futr_fx_pdno'), side: this.sideOfRow(row), quantity: this.safeNumber(row, 'fm_ord_qty'), price: this.safeNumber(row, 'fm_ord_pric'),
            stopPrice: this.safeNumber(row, 'fm_stop_ord_pric'), filledQuantity: this.safeNumber(row, 'fm_ccld_qty'), filledPrice: this.safeNumber(row, 'fm_ccld_pric'),
            remainingQuantity: this.safeNumber(row, 'fm_ord_rmn_qty'), fillConditionCode: text('ccld_cndt_cd'), filledAt: text('ccld_dtl_dtime'), info: row,
        };
    }

    /** 해외선물옵션 당일주문내역(`inquire-ccld`, TR `OTFM3116R`). 체결미체결(`01`), 매도매수(`%%`), 선물옵션(`00`)은 설명의 전체다. 연속조회는 따라가지 않는다. */
    async fetchOverseasDerivativeOrdersToday(params: Dict = {}): Promise<KisOverseasDerivativeOrder[]> {
        const response = await this.privateGetUapiOverseasFutureoptionV1TradingInquireCcld(this.extend({
            ...this.accountParams(), CCLD_NCCS_DVSN: '01', SLL_BUY_DVSN_CD: '%%', FUOP_DVSN: '00', CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'OTFM3116R',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => this.overseasDerivativeOrder(row));
    }

    /**
     * 해외선물옵션 일별체결내역(`inquire-daily-ccld`, TR `OTFM3122R`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다. 선물옵션(`00`),
     * 통화(`%%%`), 매도매수(`%%`)는 설명의 전체이고, 상품군은 공란, 품목고정여부는 설명의 기본값(`N`)이다. 응답은 블록 원문이다.
     */
    async fetchOverseasDerivativeFills(since: Int, params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchOverseasDerivativeFills', undefined, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasDerivativeFills() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasFutureoptionV1TradingInquireDailyCcld(this.extend({
            ...this.accountParams(), STRT_DT: kstYmd(since), END_DT: kstYmd(until ?? this.milliseconds()), FUOP_DVSN_CD: '00', FM_PDGR_CD: '', CRCY_CD: '%%%',
            FM_ITEM_FTNG_YN: 'N', SLL_BUY_DVSN_CD: '%%', CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'OTFM3122R',
        }, query));
        return this.responseBlocks(response);
    }

    /** 해외선물옵션 일별 주문내역(`inquire-daily-order`, TR `OTFM3120R`). 기간 시작(`since`)은 필수다. 체결미체결, 매도매수, 선물옵션은 설명의 전체다. */
    async fetchOverseasDerivativeOrders(since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisOverseasDerivativeOrder[]> {
        const [until, query] = this.handleUntilParam('fetchOverseasDerivativeOrders', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasDerivativeOrders() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasFutureoptionV1TradingInquireDailyOrder(this.extend({
            ...this.accountParams(), STRT_DT: kstYmd(since), END_DT: kstYmd(until ?? this.milliseconds()), FM_PDGR_CD: '', CCLD_NCCS_DVSN: '01', SLL_BUY_DVSN_CD: '%%',
            FUOP_DVSN: '00', CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'OTFM3120R',
        }, query));
        // 해외 행의 날짜는 한국 날짜인지 현지 날짜인지 명세로 가를 수 없어 `timestamp` 를 두지 않는다. 주문일자(`YYYYMMDD`) 순서로 자른다.
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => this.overseasDerivativeOrder(row)), since, limit, 'orderDate');
    }

    /** 해외선물옵션 통화코드 인자(`TUS`, `TKR`, `KRW`, `USD` 등). 전체 값이 없는 필수 입력이라 없으면 `ArgumentsRequired`다. */
    private derivativeCurrency(currency: string, method: string): string {
        if (currency === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 currency(통화코드, 예: TUS) 인자가 필요하다`);
        const base = currency.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(base)) throw new BadRequest(`${this.id} ${method}() 의 currency 는 세 글자 통화코드여야 한다: ${currency}`);
        return base;
    }

    /** 해외선물옵션 예수금현황(`inquire-deposit`, TR `OTFM1411R`). 통화(`currency`)는 필수이고, 조회일자(`params.until`의 한국 날짜)는 기본값을 오늘(한국 날짜)로 둔다. */
    async fetchOverseasDerivativeDeposit(currency: string, params: Dict = {}): Promise<KisOverseasDerivativeDeposit> {
        const [until, query] = this.handleUntilParam('fetchOverseasDerivativeDeposit', undefined, params);
        const crcy = this.derivativeCurrency(currency, 'fetchOverseasDerivativeDeposit');
        const response = await this.privateGetUapiOverseasFutureoptionV1TradingInquireDeposit(this.extend({
            ...this.accountParams(), CRCY_CD: crcy, INQR_DT: kstYmd(until ?? this.milliseconds()), tr_id: 'OTFM1411R',
        }, query));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        return {
            currency: this.safeString(output, 'crcy_cd') || undefined, deposit: num('fm_dnca_rmnd'), nextDayDeposit: num('fm_nxdy_dncl_amt'),
            totalAssets: num('fm_tot_asst_evlu_amt'), realizedPnl: num('fm_lqd_pfls_amt'), evaluationPnl: num('fm_fuop_evlu_pfls_amt'), fee: num('fm_fee'),
            receivable: num('fm_rcvb_amt'), margin: num('fm_brkg_mgn_amt'), maintenanceMargin: num('fm_mntn_mgn_amt'), additionalMargin: num('fm_add_mgn_amt'),
            riskRate: num('fm_risk_rt'), orderable: num('fm_ord_psbl_amt'), withdrawable: num('fm_drwg_psbl_amt'), info: output,
        };
    }

    /**
     * 해외선물옵션 기간계좌손익 일별(`inquire-period-ccld`, TR `OTFM3118R`). 기간 시작(`since`)은 필수다. 통화(`%%%`)와 선물옵션(`00`)은 설명의 전체이고,
     * 전체환산여부는 예제값(`N`)이다. 응답은 블록 원문이다.
     */
    async fetchOverseasDerivativePeriodPnl(since: Int, params: Dict = {}): Promise<KisResponseBlocks> {
        const [until, query] = this.handleUntilParam('fetchOverseasDerivativePeriodPnl', undefined, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasDerivativePeriodPnl() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasFutureoptionV1TradingInquirePeriodCcld(this.extend({
            INQR_TERM_FROM_DT: kstYmd(since), INQR_TERM_TO_DT: kstYmd(until ?? this.milliseconds()), ...this.accountParams(), CRCY_CD: '%%%', WHOL_TRSL_YN: 'N', FUOP_DVSN: '00',
            CTX_AREA_FK200: '', CTX_AREA_NK200: '', tr_id: 'OTFM3118R',
        }, query));
        return this.responseBlocks(response);
    }

    /** 해외선물옵션 기간계좌거래내역(`inquire-period-trans`, TR `OTFM3114R`). 기간 시작(`since`)은 필수다. 거래유형(`1`)과 통화(`%%%`)는 설명의 전체다. */
    async fetchOverseasDerivativeTransactions(since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisOverseasDerivativeTransaction[]> {
        const [until, query] = this.handleUntilParam('fetchOverseasDerivativeTransactions', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasDerivativeTransactions() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasFutureoptionV1TradingInquirePeriodTrans(this.extend({
            INQR_TERM_FROM_DT: kstYmd(since), INQR_TERM_TO_DT: kstYmd(until ?? this.milliseconds()), ...this.accountParams(), ACNT_TR_TYPE_CD: '1', CRCY_CD: '%%%',
            CTX_AREA_FK100: '', CTX_AREA_NK100: '', PWD_CHK_YN: '', tr_id: 'OTFM3114R',
        }, query));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => ({
            date: text(row, 'bass_dt'), currency: text(row, 'crcy_cd'), sequence: text(row, 'fm_ldgr_inog_seq'), amount: this.safeNumber(row, 'fm_iofw_amt'),
            fee: this.safeNumber(row, 'fm_fee'), tax: this.safeNumber(row, 'fm_tax_amt'), settlementAmount: this.safeNumber(row, 'fm_sttl_amt'),
            depositBefore: this.safeNumber(row, 'fm_bf_dncl_amt'), depositAfter: this.safeNumber(row, 'fm_dncl_amt'), remarks: text(row, 'rmks_text'), info: row,
        })), since, limit, 'date');
    }

    /** 해외선물옵션 주문가능조회(`inquire-psamount`, TR `OTFM3304R`). 주문가격(`price`)은 예제처럼 주지 않으면 비우고, 행사예약주문여부도 비운다. */
    async fetchOverseasDerivativeOrderable(code: string, side: OrderSide, price: Num = undefined, params: Dict = {}): Promise<KisOverseasDerivativeOrderable> {
        const response = await this.privateGetUapiOverseasFutureoptionV1TradingInquirePsamount(this.extend({
            ...this.accountParams(), OVRS_FUTR_FX_PDNO: this.overseasDerivativeCode(code, 'fetchOverseasDerivativeOrderable'),
            SLL_BUY_DVSN_CD: this.sideCode(side, 'fetchOverseasDerivativeOrderable'), FM_ORD_PRIC: price === undefined ? '' : numberToString(price), ECIS_RSVN_ORD_YN: '',
            tr_id: 'OTFM3304R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        return {
            currency: this.safeString(output, 'crcy_cd') || undefined, openQuantity: num('fm_ustl_qty'), liquidatableQuantity: num('fm_lqd_psbl_qty'),
            newOrderableQuantity: num('fm_new_ord_psbl_qty'), totalOrderableQuantity: num('fm_tot_ord_psbl_qty'), marketTotalOrderableQuantity: num('fm_mkpr_tot_ord_psbl_qty'),
            info: output,
        };
    }

    /** 해외선물옵션 미결제내역(잔고)(`inquire-unpd`, TR `OTFM1412R`). 선물옵션 구분은 설명의 전체(`00`)다. 연속조회는 따라가지 않는다. */
    async fetchOverseasDerivativePositions(params: Dict = {}): Promise<KisOverseasDerivativePosition[]> {
        const response = await this.privateGetUapiOverseasFutureoptionV1TradingInquireUnpd(this.extend({
            ...this.accountParams(), FUOP_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '', tr_id: 'OTFM1412R',
        }, params));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            code: text(row, 'ovrs_futr_fx_pdno'), productTypeCode: text(row, 'prdt_type_cd'), currency: text(row, 'crcy_cd'), typeCode: text(row, 'fuop_dvsn'),
            side: this.sideOfRow(row), quantity: this.safeNumber(row, 'fm_ustl_qty'), liquidatableQuantity: this.safeNumber(row, 'fm_lqd_psbl_qty'),
            averagePrice: this.safeNumber(row, 'fm_ccld_avg_pric'), price: this.safeNumber(row, 'fm_now_pric'), unrealizedPnl: this.safeNumber(row, 'fm_evlu_pfls_amt'),
            optionValue: this.safeNumber(row, 'fm_opt_evlu_amt'), optionPnl: this.safeNumber(row, 'fm_otp_evlu_pfls_amt'), info: row,
        }));
    }

    /** 해외선물옵션 증거금상세(`margin-detail`, TR `OTFM3115R`). 통화(`currency`)는 필수이고, 조회일자(`params.until`의 한국 날짜)는 기본값을 오늘(한국 날짜)로 둔다. */
    async fetchOverseasDerivativeMargin(currency: string, params: Dict = {}): Promise<KisOverseasDerivativeMargin> {
        const [until, query] = this.handleUntilParam('fetchOverseasDerivativeMargin', undefined, params);
        const crcy = this.derivativeCurrency(currency, 'fetchOverseasDerivativeMargin');
        const response = await this.privateGetUapiOverseasFutureoptionV1TradingMarginDetail(this.extend({
            ...this.accountParams(), CRCY_CD: crcy, INQR_DT: kstYmd(until ?? this.milliseconds()), tr_id: 'OTFM3115R',
        }, query));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        return {
            currency: this.safeString(output, 'crcy_cd') || undefined, orderable: num('fm_ord_psbl_amt'), margin: num('fm_brkg_mgn_amt'),
            maintenanceMargin: num('fm_mntn_mgn_amt'), additionalMargin: num('fm_add_mgn_amt'), openPositionMargin: num('fm_ustl_mgn_amt'), orderMargin: num('fm_ord_mgn_amt'),
            info: output,
        };
    }

    // ============ 확장 주문 ============
    // 아래 주문 경로는 API 트리에 `order: true`로 표시해 재시도하지 않고, 접수 여부를 모르는 실패를 `OrderOutcomeUnknown`으로 바꾼다.
    // 예제에 모의 TR 이 없는 주문은 실전 TR 을 그대로 보낸다(모의투자 도메인에서는 서버가 거절한다).

    /**
     * 장내채권 매수, 매도 주문(`domestic-bond/buy` TR `TTTC0952U`, `sell` TR `TTTC0958U`). 수량과 단가는 필수다. 소액시장참여, 채권소매시장, 분리과세,
     * 매도대행사반대매도는 예제값(`N`), 주문서버구분은 예제값(`0`), 매도의 주문구분은 예제값(`01`)이다. 나머지 선택 입력은 비운다.
     */
    async createBondOrder(code: string, side: OrderSide, amount: number, price: number, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'createBondOrder';
        const pdno = this.bondCode(code, method);
        const quantity = this.integerQuantity(amount, method);
        const unitPrice = this.positivePrice(price, method);
        const common = { ...this.accountParams(), PDNO: pdno, ORD_QTY2: quantity, BOND_ORD_UNPR: unitPrice, SAMT_MKET_PTCI_YN: 'N', BOND_RTL_MKET_YN: 'N' };
        if (this.sideCode(side, method) === SIDE_CODE_BUY) {
            const response = await this.privatePostUapiDomesticBondV1TradingBuy(this.extend({
                ...common, IDCR_STFNO: '', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0', CTAC_TLNO: '', tr_id: 'TTTC0952U',
            }, params));
            return this.orderAck(response, method, 'odno');
        }
        const response = await this.privatePostUapiDomesticBondV1TradingSell(this.extend({
            ...common, ORD_DVSN: '01', SPRX_YN: 'N', BUY_DT: '', BUY_SEQ: '', SLL_AGCO_OPPS_SLL_YN: 'N', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0', CTAC_TLNO: '', tr_id: 'TTTC0958U',
        }, params));
        return this.orderAck(response, method, 'odno');
    }

    /** 장내채권 정정취소 요청의 공통 부분(`order-rvsecncl`, TR `TTTC0953U`). 수량을 주지 않으면 잔량 전부(`Y`, 수량 `0`)로 보낸다. */
    private async bondRevision(method: string, cancel: boolean, orderId: string, code: string, amount: Num, price: string, params: Dict): Promise<KisOrderAck> {
        if (orderId === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 orderId 인자가 필요하다`);
        const response = await this.privatePostUapiDomesticBondV1TradingOrderRvsecncl(this.extend({
            ...this.accountParams(), PDNO: this.bondCode(code, method), ORGN_ODNO: orderId, ORD_QTY2: amount === undefined ? '0' : this.integerQuantity(amount, method),
            BOND_ORD_UNPR: price, QTY_ALL_ORD_YN: amount === undefined ? 'Y' : 'N', RVSE_CNCL_DVSN_CD: cancel ? '02' : '01', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0',
            CTAC_TLNO: '', tr_id: 'TTTC0953U',
        }, params));
        return this.orderAck(response, method, 'odno');
    }

    /** 장내채권 정정(`order-rvsecncl`, TR `TTTC0953U`, 정정 `01`). 단가는 필수이고, 수량을 주면 그 수량만 정정한다. */
    async editBondOrder(orderId: string, code: string, price: number, amount: Num = undefined, params: Dict = {}): Promise<KisOrderAck> {
        return await this.bondRevision('editBondOrder', false, orderId, code, amount, this.positivePrice(price, 'editBondOrder'), params);
    }

    /** 장내채권 취소(`order-rvsecncl`, TR `TTTC0953U`, 취소 `02`). 수량을 주지 않으면 잔량 전부를 취소한다. 단가는 기존 국내 취소처럼 `0`이다. */
    async cancelBondOrder(orderId: string, code: string, amount: Num = undefined, params: Dict = {}): Promise<KisOrderAck> {
        return await this.bondRevision('cancelBondOrder', true, orderId, code, amount, '0', params);
    }

    /**
     * 선물옵션 주문(`domestic-futureoption/order`, 주간 TR `TTTO1101U`, 모의 `VTTO1101U`, 야간 `STTN1101U`). 지정가는 호가유형과 주문구분 `01`에 가격을,
     * 시장가는 `02`에 가격 `0`을 보낸다. 호가조건은 없음(`0`), 주문처리구분은 설명의 주문전송(`02`)이다. 야간은 `params.session`에 `'night'`를 준다
     * (야간은 모의 TR 이 없어 모의투자에서 `NotSupported`다).
     */
    async createDerivativeOrder(code: string, type: OrderType, side: OrderSide, amount: number, price: Num = undefined, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'createDerivativeOrder';
        const night = this.safeString(params, 'session') === 'night';
        const limit = type === 'limit';
        if (!limit && type !== 'market') throw new BadRequest(`${this.id} ${method}() 의 type 은 limit 이나 market 이어야 한다: ${type}`);
        const response = await this.privatePostUapiDomesticFutureoptionV1TradingOrder(this.extend({
            ORD_PRCS_DVSN_CD: '02', ...this.accountParams(), SLL_BUY_DVSN_CD: this.sideCode(side, method), SHTN_PDNO: this.derivativeCode(code, method),
            ORD_QTY: this.integerQuantity(amount, method), UNIT_PRICE: limit ? this.positivePrice(price, method) : '0', NMPR_TYPE_CD: limit ? '01' : '02',
            KRX_NMPR_CNDT_CD: '0', ORD_DVSN_CD: limit ? '01' : '02', CTAC_TLNO: '', FUOP_ITEM_DVSN_CD: '',
            tr_id: night ? this.tr('STTN1101U', null) : this.tr('TTTO1101U', 'VTTO1101U'),
        }, this.omit(params, 'session')));
        return this.orderAck(response, method, 'odno');
    }

    /** 선물옵션 정정취소 요청의 공통 부분(`order-rvsecncl`, 주간 TR `TTTO1103U`, 모의 `VTTO1103U`, 야간 `TTTN1103U`). */
    private async derivativeRevision(method: string, request: Dict, params: Dict): Promise<KisOrderAck> {
        const night = this.safeString(params, 'session') === 'night';
        const response = await this.privatePostUapiDomesticFutureoptionV1TradingOrderRvsecncl(this.extend({
            ORD_PRCS_DVSN_CD: '02', ...this.accountParams(), ...request, FUOP_ITEM_DVSN_CD: '',
            tr_id: night ? this.tr('TTTN1103U', null) : this.tr('TTTO1103U', 'VTTO1103U'),
        }, this.omit(params, 'session')));
        return this.orderAck(response, method, 'odno');
    }

    /** 선물옵션 정정(정정 `01`). 지정가로 정정하며 가격은 필수다. 수량을 주면 그 수량만(`N`), 주지 않으면 잔량 전부(`Y`, 수량 `0`)를 정정한다. */
    async editDerivativeOrder(orderId: string, price: number, amount: Num = undefined, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'editDerivativeOrder';
        if (orderId === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 orderId 인자가 필요하다`);
        return await this.derivativeRevision(method, {
            RVSE_CNCL_DVSN_CD: '01', ORGN_ODNO: orderId, ORD_QTY: amount === undefined ? '0' : this.integerQuantity(amount, method), UNIT_PRICE: this.positivePrice(price, method),
            NMPR_TYPE_CD: '01', KRX_NMPR_CNDT_CD: '0', RMN_QTY_YN: amount === undefined ? 'Y' : 'N', ORD_DVSN_CD: '01',
        }, params);
    }

    /** 선물옵션 취소(취소 `02`). 수량을 주지 않으면 잔량 전부를 취소한다. 호가유형(`02`), 호가조건(`0`), 주문구분(`01`)은 예제의 취소 요청값이다. */
    async cancelDerivativeOrder(orderId: string, amount: Num = undefined, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'cancelDerivativeOrder';
        if (orderId === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 orderId 인자가 필요하다`);
        return await this.derivativeRevision(method, {
            RVSE_CNCL_DVSN_CD: '02', ORGN_ODNO: orderId, ORD_QTY: amount === undefined ? '0' : this.integerQuantity(amount, method), UNIT_PRICE: '0',
            NMPR_TYPE_CD: '02', KRX_NMPR_CNDT_CD: '0', RMN_QTY_YN: amount === undefined ? 'Y' : 'N', ORD_DVSN_CD: '01',
        }, params);
    }

    /**
     * 주식 신용주문(`order-credit`, 매수 TR `TTTC0052U`, 매도 `TTTC0051U`). 신용유형(`creditType`)은 방향별로 설명에 적힌 코드만 받는다(매수 21, 23, 26, 28,
     * 매도 22, 24, 25, 27). 대출일자는 신용매수면 오늘(한국 날짜)이 기본이고, 신용매도는 매도할 종목의 대출일자(`loanDate`, `YYYYMMDD`)가 필수다.
     * 지정가는 주문구분 `00`에 가격을, 시장가는 `01`에 가격 `0`을 보낸다. 설명 없는 선택 입력은 예제처럼 보내지 않는다.
     * `createOrder` 와 같은 정규장 게이트를 거친다(장 시간 밖과 종가 동시호가의 신규 매수는 `MarketClosed`).
     */
    async createCreditOrder(
        symbol: string, type: OrderType, side: OrderSide, amount: number, price: Num, creditType: string, loanDate: Str = undefined, params: Dict = {},
    ): Promise<KisOrderAck> {
        const method = 'createCreditOrder';
        const { code } = this.domesticInstrument(symbol, method);
        const buy = this.sideCode(side, method) === SIDE_CODE_BUY;
        const allowed = buy ? KIS_CREDIT_BUY_TYPES : KIS_CREDIT_SELL_TYPES;
        if (!allowed.has(creditType)) throw new BadRequest(`${this.id} ${method}() 의 creditType 은 ${side} 에 쓰는 ${[...allowed].join(', ')} 중 하나여야 한다: ${creditType}`);
        if (!buy && loanDate === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 의 신용매도에는 loanDate(대출일자 YYYYMMDD)가 필요하다`);
        const limit = type === 'limit';
        if (!limit && type !== 'market') throw new BadRequest(`${this.id} ${method}() 의 type 은 limit 이나 market 이어야 한다: ${type}`);
        const quantity = this.integerQuantity(amount, method);
        const unitPrice = limit ? this.positivePrice(price, method) : '0';
        await this.assertDomesticSessionOpen(side);
        const response = await this.privatePostUapiDomesticStockV1TradingOrderCredit(this.extend({
            ...this.accountParams(), PDNO: code, CRDT_TYPE: creditType, LOAN_DT: this.ymdOrToday(loanDate, method),
            ORD_DVSN: limit ? KIS_ORDER_TYPE.LIMIT : KIS_ORDER_TYPE.MARKET, ORD_QTY: quantity, ORD_UNPR: unitPrice,
            tr_id: buy ? 'TTTC0052U' : 'TTTC0051U',
        }, params));
        return this.orderAck(response, method, 'odno');
    }

    /**
     * 주식 예약주문(`order-resv`, TR `CTSC0008U`). 지정가는 주문구분 `00`에 가격을, 시장가는 `01`에 가격 `0`을 보낸다. 주문대상잔고는 예제의 현금(`10`)이다.
     * 예약주문종료일자 등 선택 입력은 예제처럼 값이 있을 때만(`params`) 보낸다. 접수 결과의 주문번호는 예약주문 순번(`RSVN_ORD_SEQ`)이다.
     */
    async createReservedOrder(symbol: string, type: OrderType, side: OrderSide, amount: number, price: Num = undefined, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'createReservedOrder';
        const { code } = this.domesticInstrument(symbol, method);
        const limit = type === 'limit';
        if (!limit && type !== 'market') throw new BadRequest(`${this.id} ${method}() 의 type 은 limit 이나 market 이어야 한다: ${type}`);
        const response = await this.privatePostUapiDomesticStockV1TradingOrderResv(this.extend({
            ...this.accountParams(), PDNO: code, ORD_QTY: this.integerQuantity(amount, method), ORD_UNPR: limit ? this.positivePrice(price, method) : '0',
            SLL_BUY_DVSN_CD: this.sideCode(side, method), ORD_DVSN_CD: limit ? KIS_ORDER_TYPE.LIMIT : KIS_ORDER_TYPE.MARKET, ORD_OBJT_CBLC_DVSN_CD: '10', tr_id: 'CTSC0008U',
        }, params));
        return this.orderAck(response, method, 'rsvn_ord_seq');
    }

    /**
     * 주식 예약주문 취소(`order-resv-rvsecncl`, TR `CTSC0009U`). 예약주문 순번(`sequence`), 예약주문조직번호(`orgNo`), 예약주문주문일자(`orderDate`)는 필수다.
     * 접수 결과의 `info.nrml_prcs_yn`(정상처리여부)을 확인한다.
     */
    async cancelReservedOrder(sequence: string, orgNo: string, orderDate: string, params: Dict = {}): Promise<KisOrderAck> {
        return await this.reservedRevision('cancelReservedOrder', 'CTSC0009U', sequence, orgNo, orderDate, {}, params);
    }

    /**
     * 주식 예약주문 정정(`order-resv-rvsecncl`, TR `CTSC0013U`). 순번, 조직번호, 주문일자에 더해 정정할 종목, 방향, 수량, 가격을 받는다. 지정가만 받고,
     * 주문대상잔고는 현금(`10`)이다.
     */
    async editReservedOrder(
        sequence: string, orgNo: string, orderDate: string, symbol: string, side: OrderSide, amount: number, price: number, params: Dict = {},
    ): Promise<KisOrderAck> {
        const method = 'editReservedOrder';
        const { code } = this.domesticInstrument(symbol, method);
        return await this.reservedRevision(method, 'CTSC0013U', sequence, orgNo, orderDate, {
            PDNO: code, ORD_QTY: this.integerQuantity(amount, method), ORD_UNPR: this.positivePrice(price, method), SLL_BUY_DVSN_CD: this.sideCode(side, method),
            ORD_DVSN_CD: KIS_ORDER_TYPE.LIMIT, ORD_OBJT_CBLC_DVSN_CD: '10',
        }, params);
    }

    private async reservedRevision(method: string, trId: string, sequence: string, orgNo: string, orderDate: string, extra: Dict, params: Dict): Promise<KisOrderAck> {
        if (sequence === undefined || orgNo === undefined || orderDate === undefined) {
            throw new ArgumentsRequired(`${this.id} ${method}() 는 sequence, orgNo, orderDate 인자가 필요하다`);
        }
        if (!/^\d{8}$/.test(orderDate)) throw new BadRequest(`${this.id} ${method}() 의 orderDate 는 YYYYMMDD 여덟 자리여야 한다: ${orderDate}`);
        const response = await this.privatePostUapiDomesticStockV1TradingOrderResvRvsecncl(this.extend({
            ...this.accountParams(), RSVN_ORD_SEQ: sequence, RSVN_ORD_ORGNO: orgNo, RSVN_ORD_ORD_DT: orderDate, ...extra, tr_id: trId,
        }, params));
        return this.orderAck(response, method, 'rsvn_ord_seq');
    }

    /**
     * 해외선물옵션 주문(`overseas-futureoption/order`, TR `OTFM3001U`). 지정가는 가격구분 `1`, 체결조건 `6`(설명: 일반적으로 6), 시장가는 `2`와 `2`다.
     * 헤지청산 입력은 설명대로 비우고, 복합주문구분(`0`), 행사예약(`N`), 헤지주문화면(`N`)은 설명값이다. STOP 주문은 `params`로 준다.
     */
    async createOverseasDerivativeOrder(code: string, type: OrderType, side: OrderSide, amount: number, price: Num = undefined, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'createOverseasDerivativeOrder';
        const limit = type === 'limit';
        if (!limit && type !== 'market') throw new BadRequest(`${this.id} ${method}() 의 type 은 limit 이나 market 이어야 한다: ${type}`);
        const response = await this.privatePostUapiOverseasFutureoptionV1TradingOrder(this.extend({
            ...this.accountParams(), OVRS_FUTR_FX_PDNO: this.overseasDerivativeCode(code, method), SLL_BUY_DVSN_CD: this.sideCode(side, method),
            FM_LQD_USTL_CCLD_DT: '', FM_LQD_USTL_CCNO: '', PRIC_DVSN_CD: limit ? '1' : '2', FM_LIMIT_ORD_PRIC: limit ? this.positivePrice(price, method) : '',
            FM_STOP_ORD_PRIC: '', FM_ORD_QTY: this.integerQuantity(amount, method), FM_LQD_LMT_ORD_PRIC: '', FM_LQD_STOP_ORD_PRIC: '', CCLD_CNDT_CD: limit ? '6' : '2',
            CPLX_ORD_DVSN_CD: '0', ECIS_RSVN_ORD_YN: 'N', FM_HDGE_ORD_SCRN_YN: 'N', tr_id: 'OTFM3001U',
        }, params));
        return this.orderAck(response, method, 'odno', 'ord_dt');
    }

    /** 해외선물옵션 정정(`order-rvsecncl`, TR `OTFM3002U`). 원주문일자(`orderDate`, 현지거래일)와 원주문번호(`orderId`)는 필수다. 지정가를 바꾼다. */
    async editOverseasDerivativeOrder(orderId: string, orderDate: string, price: number, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'editOverseasDerivativeOrder';
        return await this.overseasDerivativeRevision(method, 'OTFM3002U', orderId, orderDate, {
            FM_LIMIT_ORD_PRIC: this.positivePrice(price, method), FM_STOP_ORD_PRIC: '', FM_LQD_LMT_ORD_PRIC: '', FM_LQD_STOP_ORD_PRIC: '', FM_HDGE_ORD_SCRN_YN: 'N', FM_MKPR_CVSN_YN: '',
        }, params);
    }

    /**
     * 해외선물옵션 취소(`order-rvsecncl`, TR `OTFM3003U`). 시장가전환여부(`FM_MKPR_CVSN_YN`)는 `N`으로 보낸다. 설명대로 `Y`로 보내면 취소가 확인된 뒤
     * 원장이 시장가 주문을 하나 더 내므로, 필요하면 호출하는 쪽이 `params`로 명시해야 한다.
     */
    async cancelOverseasDerivativeOrder(orderId: string, orderDate: string, params: Dict = {}): Promise<KisOrderAck> {
        return await this.overseasDerivativeRevision('cancelOverseasDerivativeOrder', 'OTFM3003U', orderId, orderDate, {
            FM_LIMIT_ORD_PRIC: '', FM_STOP_ORD_PRIC: '', FM_LQD_LMT_ORD_PRIC: '', FM_LQD_STOP_ORD_PRIC: '', FM_HDGE_ORD_SCRN_YN: 'N', FM_MKPR_CVSN_YN: 'N',
        }, params);
    }

    private async overseasDerivativeRevision(method: string, trId: string, orderId: string, orderDate: string, extra: Dict, params: Dict): Promise<KisOrderAck> {
        if (orderId === undefined || orderDate === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 orderId 와 orderDate 인자가 필요하다`);
        if (!/^\d{8}$/.test(orderDate)) throw new BadRequest(`${this.id} ${method}() 의 orderDate 는 YYYYMMDD 여덟 자리여야 한다: ${orderDate}`);
        const response = await this.privatePostUapiOverseasFutureoptionV1TradingOrderRvsecncl(this.extend({
            ...this.accountParams(), ORGN_ORD_DT: orderDate, ORGN_ODNO: orderId, ...extra, tr_id: trId,
        }, params));
        return this.orderAck(response, method, 'odno', 'ord_dt');
    }

    /** 미국 주간거래 종목. 미국 거래소(NASD, NYSE, AMEX)가 아니면 요청 전에 `BadSymbol`이다. */
    private usDaytimeInstrument(symbol: string, method: string): { code: string; market: OverseasOrderMarket } {
        const instrument = this.overseasInstrument(symbol, method);
        const market = toOrderMarketCode(instrument.quoteExchange);
        if (!KIS_US_ORDER_MARKETS.has(market)) throw new BadSymbol(`${this.id} ${method}() 은 미국 종목만 지원한다: ${symbol}`);
        return { code: instrument.code, market };
    }

    /**
     * 해외주식 미국주간주문(`daytime-order`, 매수 TR `TTTS6036U`, 매도 `TTTS6037U`). 설명대로 주간거래는 지정가(`00`)만 가능해서 가격이 필수다.
     * 연락전화번호와 운용사지정주문번호는 비우고, 주문서버구분은 설명의 `0`이다.
     */
    async createDaytimeOrder(symbol: string, side: OrderSide, amount: number, price: number, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'createDaytimeOrder';
        const { code, market } = this.usDaytimeInstrument(symbol, method);
        const buy = this.sideCode(side, method) === SIDE_CODE_BUY;
        const response = await this.privatePostUapiOverseasStockV1TradingDaytimeOrder(this.extend({
            ...this.accountParams(), OVRS_EXCG_CD: market, PDNO: code, ORD_QTY: this.integerQuantity(amount, method), OVRS_ORD_UNPR: this.positivePrice(price, method),
            CTAC_TLNO: '', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0', ORD_DVSN: '00', tr_id: buy ? 'TTTS6036U' : 'TTTS6037U',
        }, params));
        return this.orderAck(response, method, 'odno');
    }

    /** 해외주식 미국주간 정정(`daytime-order-rvsecncl`, TR `TTTS6038U`, 정정 `01`). 수량과 가격이 필수다. */
    async editDaytimeOrder(orderId: string, symbol: string, amount: number, price: number, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'editDaytimeOrder';
        return await this.daytimeRevision(method, '01', orderId, symbol, this.integerQuantity(amount, method), this.positivePrice(price, method), params);
    }

    /** 해외주식 미국주간 취소(`daytime-order-rvsecncl`, TR `TTTS6038U`, 취소 `02`). 취소 수량은 필수이고, 가격은 기존 해외 취소처럼 `0`이다. */
    async cancelDaytimeOrder(orderId: string, symbol: string, amount: number, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'cancelDaytimeOrder';
        return await this.daytimeRevision(method, '02', orderId, symbol, this.integerQuantity(amount, method), '0', params);
    }

    private async daytimeRevision(method: string, kind: string, orderId: string, symbol: string, quantity: string, price: string, params: Dict): Promise<KisOrderAck> {
        if (orderId === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 orderId 인자가 필요하다`);
        const { code, market } = this.usDaytimeInstrument(symbol, method);
        const response = await this.privatePostUapiOverseasStockV1TradingDaytimeOrderRvsecncl(this.extend({
            ...this.accountParams(), OVRS_EXCG_CD: market, PDNO: code, ORGN_ODNO: orderId, RVSE_CNCL_DVSN_CD: kind, ORD_QTY: quantity, OVRS_ORD_UNPR: price,
            CTAC_TLNO: '', MGCO_APTM_ODNO: '', ORD_SVR_DVSN_CD: '0', tr_id: 'TTTS6038U',
        }, params));
        return this.orderAck(response, method, 'odno');
    }

    /**
     * 해외주식 예약주문접수(`order-resv`). 미국 매수는 TR `TTTT3014U`, 미국 매도는 `TTTT3016U`, 아시아는 `TTTS3013U`이다(모의는 `V`로 시작하는 TR).
     * 가격은 필수다. 아시아는 설명대로 매도매수구분, 정정취소구분(`00`), 상품유형코드(거래소별 코드)를 함께 보낸다. 접수 결과의 주문번호는 해외예약주문번호
     * (`OVRS_RSVN_ODNO`)이고, 취소에 쓰는 예약주문접수일자는 `orderDate`에 담는다.
     */
    async createOverseasReservedOrder(symbol: string, side: OrderSide, amount: number, price: number, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'createOverseasReservedOrder';
        const instrument = this.overseasInstrument(symbol, method);
        const market = toOrderMarketCode(instrument.quoteExchange);
        const sideCode = this.sideCode(side, method);
        const us = KIS_US_ORDER_MARKETS.has(market);
        const asia: Dict = us ? {} : { SLL_BUY_DVSN_CD: sideCode, RVSE_CNCL_DVSN_CD: '00', PRDT_TYPE_CD: KIS_OVERSEAS_PRODUCT_TYPES[instrument.quoteExchange] };
        const trId = us
            ? (sideCode === SIDE_CODE_BUY ? this.tr('TTTT3014U', 'VTTT3014U') : this.tr('TTTT3016U', 'VTTT3016U'))
            : this.tr('TTTS3013U', 'VTTS3013U');
        const response = await this.privatePostUapiOverseasStockV1TradingOrderResv(this.extend({
            ...this.accountParams(), PDNO: instrument.code, OVRS_EXCG_CD: market, FT_ORD_QTY: this.integerQuantity(amount, method),
            FT_ORD_UNPR3: this.positivePrice(price, method), ...asia, tr_id: trId,
        }, params));
        return this.orderAck(response, method, 'ovrs_rsvn_odno', 'rsvn_ord_rcit_dt');
    }

    /**
     * 해외주식 예약주문접수취소(`order-resv-ccnl`, TR `TTTT3017U`, 모의 `VTTT3017U`). 예제는 미국만 다룬다. 해외예약주문번호(`reservationId`)와
     * 예약주문접수일자(`receivedDate`, `YYYYMMDD`)는 필수다.
     */
    async cancelOverseasReservedOrder(reservationId: string, receivedDate: string, params: Dict = {}): Promise<KisOrderAck> {
        const method = 'cancelOverseasReservedOrder';
        if (reservationId === undefined || receivedDate === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 reservationId 와 receivedDate 인자가 필요하다`);
        if (!/^\d{8}$/.test(receivedDate)) throw new BadRequest(`${this.id} ${method}() 의 receivedDate 는 YYYYMMDD 여덟 자리여야 한다: ${receivedDate}`);
        const response = await this.privatePostUapiOverseasStockV1TradingOrderResvCcnl(this.extend({
            ...this.accountParams(), RSVN_ORD_RCIT_DT: receivedDate, OVRS_RSVN_ODNO: reservationId, tr_id: this.tr('TTTT3017U', 'VTTT3017U'),
        }, params));
        return this.orderAck(response, method, 'ovrs_rsvn_odno');
    }

    /**
     * 종목의 거래 상태와 가격 제한(`inquire-price-2`, TR `FHPST01010000`). 국내만 지원한다. 시장구분은 KRX(`J`)다.
     * 거래정지, 정리매매, 관리종목, 단기과열, 투자유의, 공매도과열 같은 여부와 시장경고 코드, 상한가와 하한가를 정리한다.
     */
    async fetchStockStatus(symbol: string, params: Dict = {}): Promise<KisStockStatus> {
        const instrument = this.domesticInstrument(symbol, 'fetchStockStatus');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquirePrice2(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: instrument.code,
            tr_id: 'FHPST01010000',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const flag = (key: string): boolean | undefined => {
            const value = this.safeString(output, key);
            return value === 'Y' ? true : value === 'N' ? false : undefined;
        };
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        return {
            symbol: instrument.symbol,
            marketName: text('rprs_mrkt_kor_name'),
            sectorName: text('bstp_kor_isnm'),
            upperLimitPrice: this.safeNumber(output, 'stck_mxpr'),
            lowerLimitPrice: this.safeNumber(output, 'stck_llam'),
            basePrice: this.safeNumber(output, 'stck_sdpr'),
            tradingHalted: flag('trht_yn'),
            liquidationTrading: flag('sltr_yn'),
            administrativeIssue: flag('mang_issu_yn'),
            shortTermOverheated: flag('short_over_yn'),
            investmentCaution: flag('invt_caful_yn'),
            abnormalSurge: flag('stange_runup_yn'),
            shortSellingOverheated: flag('ssts_hot_yn'),
            lowLiquidity: flag('low_current_yn'),
            unfaithfulDisclosure: flag('insn_pbnt_yn'),
            creditAvailable: flag('crdt_able_yn'),
            marketWarningCode: text('mrkt_warn_cls_code'),
            marketWarningName: text('mrkt_warn_cls_name'),
            viCode: text('vi_cls_code'),
            shortTermOverheatedCode: text('short_over_cls_code'),
            marginRate: this.safeNumber(output, 'marg_rate'),
            creditRate: this.safeNumber(output, 'crdt_rate'),
            info: output,
        };
    }

    /** 날짜 인자(`YYYYMMDD`). 없으면 오늘(한국 날짜)이다. */
    private ymdOrToday(date: Str, method: string): string {
        if (date === undefined) return kstYmd(this.milliseconds());
        if (!/^\d{8}$/.test(date)) throw new BadRequest(`${this.id} ${method}() 의 date 는 YYYYMMDD 여덟 자리여야 한다: ${date}`);
        return date;
    }

    /**
     * 신용잔고 일별 추이(`daily-credit-balance`, TR `FHPST04760000`). 국내만 지원한다. 결제일자(`params.until`의 한국 날짜)는 필수 입력이라
     * 기본값을 오늘(한국 날짜)로 둔다. 연속조회(`tr_cont`)는 따라가지 않고 첫 페이지만 돌려준다.
     */
    async fetchCreditBalanceHistory(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisCreditBalanceRecord[]> {
        const [until, query] = this.handleUntilParam('fetchCreditBalanceHistory', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchCreditBalanceHistory');
        const response = await this.privateGetUapiDomesticStockV1QuotationsDailyCreditBalance(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_COND_SCR_DIV_CODE: '20476',
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: kstYmd(until ?? this.milliseconds()),
            tr_id: 'FHPST04760000',
        }, query));
        const flow = (row: Dict, prefix: string): KisCreditFlow => ({
            newShares: this.safeNumber(row, `${prefix}_new_stcn`),
            repaidShares: this.safeNumber(row, `${prefix}_rdmp_stcn`),
            balanceShares: this.safeNumber(row, `${prefix}_rmnd_stcn`),
            newAmount: this.safeNumber(row, `${prefix}_new_amt`),
            repaidAmount: this.safeNumber(row, `${prefix}_rdmp_amt`),
            balanceAmount: this.safeNumber(row, `${prefix}_rmnd_amt`),
            balanceRate: this.safeNumber(row, `${prefix}_rmnd_rate`),
            grantRate: this.safeNumber(row, `${prefix}_gvrt`),
        });
        // API 는 기준일 하나만 받고 그날까지의 이력을 준다. `since` 와 `limit` 은 받은 행에 적용한다.
        return this.filterBySinceLimit(rowsOf(this.safeValue(response, 'output')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'deal_date')),
            tradeDate: this.safeString(row, 'deal_date', ''),
            settlementDate: this.safeString(row, 'stlm_date') || undefined,
            price: this.safeNumber(row, 'stck_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            loan: flow(row, 'whol_loan'),
            stockLoan: flow(row, 'whol_stln'),
            info: row,
        })), since, limit) as KisCreditBalanceRecord[];
    }

    /**
     * 종목별 일별 대차거래 추이(`daily-loan-trans`, TR `HHPST074500C0`). 국내만 지원한다. 기간(`since`, `params.until`)은 선택 입력이라 주지 않으면 비워 보낸다.
     * 조회구분(`MRKT_DIV_CLS_CODE`)은 설명의 `3`(종목)을 보낸다. 예제는 종목코드를 넣고도 `1`(코스피)을 보내는데, 이 메서드는 종목 단위라 설명을 따랐다.
     */
    async fetchStockLendingHistory(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisStockLendingRecord[]> {
        const [until, query] = this.handleUntilParam('fetchStockLendingHistory', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchStockLendingHistory');
        const response = await this.privateGetUapiDomesticStockV1QuotationsDailyLoanTrans(this.extend({
            MRKT_DIV_CLS_CODE: '3',
            MKSC_SHRN_ISCD: code,
            START_DATE: since !== undefined ? kstYmd(since) : '',
            END_DATE: until !== undefined ? kstYmd(until) : '',
            CTS: '',
            tr_id: 'HHPST074500C0',
        }, query));
        return this.limitRows(rowsOf(this.safeValue(response, 'output1')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'bsop_date')),
            businessDate: this.safeString(row, 'bsop_date', ''),
            close: this.safeNumber(row, 'stck_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            newShares: this.safeNumber(row, 'new_stcn'),
            repaidShares: this.safeNumber(row, 'rdmp_stcn'),
            balanceChange: this.safeNumber(row, 'prdy_rmnd_vrss'),
            balanceShares: this.safeNumber(row, 'rmnd_stcn'),
            balanceAmount: this.safeNumber(row, 'rmnd_amt'),
            info: row,
        })), since, limit);
    }

    /** 공매도 일별 추이(`daily-short-sale`, TR `FHPST04830000`). 국내만 지원한다. 기간은 선택 입력이라 주지 않으면 비워 보낸다. 행은 `output2`다. */
    async fetchShortSaleHistory(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisShortSaleRecord[]> {
        const [until, query] = this.handleUntilParam('fetchShortSaleHistory', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchShortSaleHistory');
        const response = await this.privateGetUapiDomesticStockV1QuotationsDailyShortSale(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: since !== undefined ? kstYmd(since) : '',
            FID_INPUT_DATE_2: until !== undefined ? kstYmd(until) : '',
            tr_id: 'FHPST04830000',
        }, query));
        return this.limitRows(rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            businessDate: this.safeString(row, 'stck_bsop_date', ''),
            close: this.safeNumber(row, 'stck_clpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            amount: this.safeNumber(row, 'acml_tr_pbmn'),
            shortVolume: this.safeNumber(row, 'ssts_cntg_qty'),
            shortVolumeShare: this.safeNumber(row, 'ssts_vol_rlim'),
            cumulativeShortVolume: this.safeNumber(row, 'acml_ssts_cntg_qty'),
            cumulativeShortVolumeShare: this.safeNumber(row, 'acml_ssts_cntg_qty_rlim'),
            shortAmount: this.safeNumber(row, 'ssts_tr_pbmn'),
            shortAmountShare: this.safeNumber(row, 'ssts_tr_pbmn_rlim'),
            cumulativeShortAmount: this.safeNumber(row, 'acml_ssts_tr_pbmn'),
            cumulativeShortAmountShare: this.safeNumber(row, 'acml_ssts_tr_pbmn_rlim'),
            averagePrice: this.safeNumber(row, 'avrg_prc'),
            info: row,
        })), since, limit);
    }

    /**
     * 종목별 일별 매수·매도 체결량(`inquire-daily-trade-volume`, TR `FHKST03010800`). 국내만 지원한다. 기간 구분은 설명에 있는 유일한 값 `D`다.
     * 기간(`since`, `params.until`)은 선택 입력이라 주지 않으면 비워 보낸다.
     */
    async fetchBuySellVolumeHistory(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisBuySellVolume> {
        const [until, query] = this.handleUntilParam('fetchBuySellVolumeHistory', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchBuySellVolumeHistory');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireDailyTradeVolume(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_PERIOD_DIV_CODE: 'D',
            FID_INPUT_DATE_1: since !== undefined ? kstYmd(since) : '',
            FID_INPUT_DATE_2: until !== undefined ? kstYmd(until) : '',
            tr_id: 'FHKST03010800',
        }, query));
        const summary = firstRow(this.safeValue(response, 'output1'));
        return {
            totalBuyVolume: this.safeNumber(summary, 'shnu_cnqn_smtn'),
            totalSellVolume: this.safeNumber(summary, 'seln_cnqn_smtn'),
            days: this.limitRows(rowsOf(this.safeValue(response, 'output2')).map((row) => ({
                ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
                businessDate: this.safeString(row, 'stck_bsop_date', ''),
                buyVolume: this.safeNumber(row, 'total_shnu_qty'),
                sellVolume: this.safeNumber(row, 'total_seln_qty'),
                info: row,
            })), since, limit),
        };
    }

    /**
     * 종목별 투자자 일별 동향(`investor-trade-by-stock-daily`, TR `FHPTJ04160001`). 국내만 지원한다. 투자자 유형 15종의 매수·매도를 정리한다.
     * 입력 날짜(`params.until`의 한국 날짜)는 필수라 기본값을 오늘(한국 날짜)로 둔다. 수정주가와 기타 구분은 설명대로 공란이다. 연속조회는 따라가지 않는다.
     * `fetchInvestorTrading`(`inquire-investor`)은 개인, 외국인, 기관계 세 유형만 준다.
     */
    async fetchInvestorTradingHistory(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisInvestorTradingDay[]> {
        const [until, query] = this.handleUntilParam('fetchInvestorTradingHistory', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchInvestorTradingHistory');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInvestorTradeByStockDaily(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: kstYmd(until ?? this.milliseconds()),
            FID_ORG_ADJ_PRC: '',
            FID_ETC_CLS_CODE: '',
            tr_id: 'FHPTJ04160001',
        }, query));
        return this.filterBySinceLimit(rowsOf(this.safeValue(response, 'output2')).map((row) => {
            return {
                ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
                businessDate: this.safeString(row, 'stck_bsop_date', ''),
                open: this.safeNumber(row, 'stck_oprc'),
                high: this.safeNumber(row, 'stck_hgpr'),
                low: this.safeNumber(row, 'stck_lwpr'),
                close: this.safeNumber(row, 'stck_clpr'),
                change: this.safeNumber(row, 'prdy_vrss'),
                percentage: this.safeNumber(row, 'prdy_ctrt'),
                volume: this.safeNumber(row, 'acml_vol'),
                amount: this.safeNumber(row, 'acml_tr_pbmn'),
                investors: this.investorAmounts(row),
                info: row,
            };
        }), since, limit) as KisInvestorTradingDay[];
    }

    /** 투자자 유형 15종의 매수·매도(`KIS_INVESTOR_FIELDS`). 응답에 없는 필드는 비어 있다. */
    private investorAmounts(row: Dict): Record<KisInvestorType, KisInvestorAmounts> {
        const investors = {} as Record<KisInvestorType, KisInvestorAmounts>;
        for (const [type, [netVolume, netAmount, sellVolume, buyVolume, sellAmount, buyAmount]] of Object.entries(KIS_INVESTOR_FIELDS)) {
            investors[type as KisInvestorType] = {
                netBuyVolume: this.safeNumber(row, netVolume),
                netBuyAmount: this.safeNumber(row, netAmount),
                buyVolume: this.safeNumber(row, buyVolume),
                buyAmount: this.safeNumber(row, buyAmount),
                sellVolume: this.safeNumber(row, sellVolume),
                sellAmount: this.safeNumber(row, sellAmount),
            };
        }
        return investors;
    }

    /** 종목별 외국인·기관 추정 가집계(`investor-trend-estimate`, TR `HHPTJ04160200`). 국내만 지원한다. 행은 `output2`다. */
    async fetchInvestorEstimates(symbol: string, params: Dict = {}): Promise<KisInvestorEstimate[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchInvestorEstimates');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInvestorTrendEstimate(this.extend({
            MKSC_SHRN_ISCD: code,
            tr_id: 'HHPTJ04160200',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            timeSlot: this.safeString(row, 'bsop_hour_gb') || undefined,
            foreignNetBuyVolume: this.safeNumber(row, 'frgn_fake_ntby_qty'),
            institutionNetBuyVolume: this.safeNumber(row, 'orgn_fake_ntby_qty'),
            totalNetBuyVolume: this.safeNumber(row, 'sum_fake_ntby_qty'),
            info: row,
        }));
    }

    /**
     * 종목별 외국계 순매수 추이(`frgnmem-pchs-trend`, TR `FHKST644400C0`). 국내만 지원한다.
     * 둘째 종목코드(`FID_INPUT_ISCD_2`)는 설명 없이 예제값(`99999`)만 있어 그대로 보낸다.
     */
    async fetchForeignTradeTicks(symbol: string, params: Dict = {}): Promise<KisForeignTradeTick[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchForeignTradeTicks');
        const response = await this.privateGetUapiDomesticStockV1QuotationsFrgnmemPchsTrend(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_INPUT_ISCD_2: KIS_FOREIGN_TREND_SECOND_CODE,
            tr_id: 'FHKST644400C0',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            time: this.safeString(row, 'bsop_hour', ''),
            price: this.safeNumber(row, 'stck_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            cumulativeVolume: this.safeNumber(row, 'acml_vol'),
            foreignSellVolume: this.safeNumber(row, 'frgn_seln_vol'),
            foreignBuyVolume: this.safeNumber(row, 'frgn_shnu_vol'),
            foreignBrokerNetBuyVolume: this.safeNumber(row, 'glob_ntby_qty'),
            foreignNetBuyChange: this.safeNumber(row, 'frgn_ntby_qty_icdc'),
            info: row,
        }));
    }

    /**
     * 회원사 한 곳의 종목 매매 일별 동향(`inquire-member-daily`, TR `FHPST04540000`). 국내만 지원한다.
     * 회원사코드(`memberCode`)는 전체 값이 없는 필수 입력이라 호출하는 쪽이 반드시 준다. 기간 시작(`since`)도 필수이고, 끝은 `params.until`(없으면 오늘)이다.
     */
    async fetchMemberDailyTrading(symbol: string, memberCode: string, since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisMemberDailyRecord[]> {
        const [until, query] = this.handleUntilParam('fetchMemberDailyTrading', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchMemberDailyTrading');
        if (!memberCode) throw new ArgumentsRequired(`${this.id} fetchMemberDailyTrading() 는 memberCode(회원사코드) 인자가 필요하다`);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchMemberDailyTrading() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireMemberDaily(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_INPUT_ISCD_2: memberCode,
            FID_INPUT_DATE_1: kstYmd(since),
            FID_INPUT_DATE_2: kstYmd(until ?? this.milliseconds()),
            FID_SCTN_CLS_CODE: '',
            tr_id: 'FHPST04540000',
        }, query));
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            businessDate: this.safeString(row, 'stck_bsop_date', ''),
            sellVolume: this.safeNumber(row, 'total_seln_qty'),
            buyVolume: this.safeNumber(row, 'total_shnu_qty'),
            netBuyVolume: this.safeNumber(row, 'ntby_qty'),
            price: this.safeNumber(row, 'stck_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            info: row,
        })), since, limit);
    }

    private programTradingFlow(row: Dict, amountChangeKey: string): KisProgramTradingFlow {
        return {
            sellVolume: this.safeNumber(row, 'whol_smtn_seln_vol'),
            buyVolume: this.safeNumber(row, 'whol_smtn_shnu_vol'),
            netBuyVolume: this.safeNumber(row, 'whol_smtn_ntby_qty'),
            sellAmount: this.safeNumber(row, 'whol_smtn_seln_tr_pbmn'),
            buyAmount: this.safeNumber(row, 'whol_smtn_shnu_tr_pbmn'),
            netBuyAmount: this.safeNumber(row, 'whol_smtn_ntby_tr_pbmn'),
            netBuyVolumeChange: this.safeNumber(row, 'whol_ntby_vol_icdc'),
            netBuyAmountChange: this.safeNumber(row, amountChangeKey),
        };
    }

    /** 종목별 프로그램 매매 추이, 체결(`program-trade-by-stock`, TR `FHPPG04650101`). 국내만 지원한다. 시장구분은 KRX(`J`)다. */
    async fetchProgramTradingTicks(symbol: string, params: Dict = {}): Promise<KisProgramTradingTick[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchProgramTradingTicks');
        const response = await this.privateGetUapiDomesticStockV1QuotationsProgramTradeByStock(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            tr_id: 'FHPPG04650101',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            time: this.safeString(row, 'bsop_hour', ''),
            price: this.safeNumber(row, 'stck_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            cumulativeVolume: this.safeNumber(row, 'acml_vol'),
            ...this.programTradingFlow(row, 'whol_ntby_tr_pbmn_icdc'),
            info: row,
        }));
    }

    /**
     * 종목별 프로그램 매매 추이, 일별(`program-trade-by-stock-daily`, TR `FHPPG04650201`). 국내만 지원한다.
     * 입력 날짜(`params.until`의 한국 날짜)는 설명의 초기값이 공란이라 주지 않으면 비워 보낸다.
     */
    async fetchProgramTradingHistory(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisProgramTradingDay[]> {
        const [until, query] = this.handleUntilParam('fetchProgramTradingHistory', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchProgramTradingHistory');
        const response = await this.privateGetUapiDomesticStockV1QuotationsProgramTradeByStockDaily(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: until === undefined ? '' : kstYmd(until),
            tr_id: 'FHPPG04650201',
        }, query));
        return this.filterBySinceLimit(rowsOf(this.safeValue(response, 'output')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            businessDate: this.safeString(row, 'stck_bsop_date', ''),
            close: this.safeNumber(row, 'stck_clpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            amount: this.safeNumber(row, 'acml_tr_pbmn'),
            ...this.programTradingFlow(row, 'whol_ntby_tr_pbmn_icdc2'),
            info: row,
        })), since, limit) as KisProgramTradingDay[];
    }

    /** 시장 인자를 API 코드로 옮긴다. 타입 밖의 값이면 요청 전에 `BadRequest`다. */
    private marketCode(market: KisMarket, codes: Readonly<Record<KisMarket, string>>, method: string): string {
        const code = codes[market];
        if (code === undefined) throw new BadRequest(`${this.id} ${method}() 의 market 은 KOSPI 나 KOSDAQ 이어야 한다: ${market}`);
        return code;
    }

    /**
     * 투자자 유형별 당일 프로그램 매매(`investor-program-trade-today`, TR `HHPPG046600C1`). 시장(`market`)은 전체 값이 없는 필수 입력이라
     * 호출하는 쪽이 반드시 고른다(코스피 `1`, 코스닥 `4`). 전체, 차익, 비차익의 매도·매수·순매수 수량과 대금을 정리한다.
     */
    async fetchProgramTradingByInvestor(market: KisMarket, params: Dict = {}): Promise<KisProgramTradingByInvestor[]> {
        // 거래소구분(`EXCH_DIV_CLS_CODE`)은 예제에 없지만 실계좌(2026-09-24)에서 빠지면 거부됐다. 값은 cluefin 설명(J KRX, NX NXT,
        // UN 통합)이 다른 국내 시세 입력과 같아서 `quoteMarketDivision`을 쓴다.
        const response = await this.privateGetUapiDomesticStockV1QuotationsInvestorProgramTradeToday(this.extend({
            EXCH_DIV_CLS_CODE: await this.quoteMarketDivision(),
            MRKT_DIV_CLS_CODE: this.marketCode(market, { KOSPI: '1', KOSDAQ: '4' }, 'fetchProgramTradingByInvestor'),
            tr_id: 'HHPPG046600C1',
        }, params));
        const amounts = (row: Dict, prefix: string): KisInvestorAmounts => ({
            netBuyVolume: this.safeNumber(row, `${prefix}_ntby_qty`),
            netBuyAmount: this.safeNumber(row, `${prefix}_ntby_amt`),
            buyVolume: this.safeNumber(row, `${prefix}_shnu_qty`),
            buyAmount: this.safeNumber(row, `${prefix}_shnu_amt`),
            sellVolume: this.safeNumber(row, `${prefix}_seln_qty`),
            sellAmount: this.safeNumber(row, `${prefix}_seln_amt`),
        });
        return rowsOf(this.safeValue(response, 'output1')).map((row) => ({
            investorCode: this.safeString(row, 'invr_cls_code', ''),
            investorName: this.safeString(row, 'invr_cls_name') || undefined,
            total: amounts(row, 'all'),
            arbitrage: amounts(row, 'arbt'),
            nonArbitrage: amounts(row, 'nabt'),
            info: row,
        }));
    }

    /**
     * 시장별 투자자 매매동향, 일별(`inquire-investor-daily-by-market`, TR `FHPTJ04040000`). 시장(`KSP`, `KSQ`)과 업종코드(`sector`, 네 자리)는
     * 전체 값이 없는 필수 입력이라 호출하는 쪽이 반드시 준다. 예제는 두 업종 입력(`FID_INPUT_ISCD`, `FID_INPUT_ISCD_2`)에 같은 코드(`0001`)를 넣고
     * 설명도 둘 다 업종코드라 같은 값을 보낸다. 날짜(`params.until`의 한국 날짜)는 필수라 기본값을 오늘로 두고, 둘째 날짜는 설명대로 같은 날짜를 보낸다.
     */
    async fetchMarketInvestorTrading(market: KisMarket, sector: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisMarketInvestorTradingDay[]> {
        const [until, query] = this.handleUntilParam('fetchMarketInvestorTrading', limit, params);
        const marketCode = this.marketCode(market, { KOSPI: 'KSP', KOSDAQ: 'KSQ' }, 'fetchMarketInvestorTrading');
        if (!/^\d{4}$/.test(sector)) throw new BadRequest(`${this.id} fetchMarketInvestorTrading() 의 sector 는 업종코드 네 자리여야 한다: ${sector}`);
        const day = kstYmd(until ?? this.milliseconds());
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireInvestorDailyByMarket(this.extend({
            FID_COND_MRKT_DIV_CODE: 'U',
            FID_INPUT_ISCD: sector,
            FID_INPUT_DATE_1: day,
            FID_INPUT_ISCD_1: marketCode,
            FID_INPUT_DATE_2: day,
            FID_INPUT_ISCD_2: sector,
            tr_id: 'FHPTJ04040000',
        }, query));
        return this.filterBySinceLimit(rowsOf(this.safeValue(response, 'output')).map((row) => {
            return {
                ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
                businessDate: this.safeString(row, 'stck_bsop_date', ''),
                indexPrice: this.safeNumber(row, 'bstp_nmix_prpr'),
                indexChange: this.safeNumber(row, 'bstp_nmix_prdy_vrss'),
                indexChangeRate: this.safeNumber(row, 'bstp_nmix_prdy_ctrt'),
                indexOpen: this.safeNumber(row, 'bstp_nmix_oprc'),
                indexHigh: this.safeNumber(row, 'bstp_nmix_hgpr'),
                indexLow: this.safeNumber(row, 'bstp_nmix_lwpr'),
                investors: this.investorAmounts(row),
                info: row,
            };
        }), since, limit) as KisMarketInvestorTradingDay[];
    }

    /** 국내 증시자금 종합(`mktfunds`, TR `FHKST649100C0`). 입력 날짜(`params.until`의 한국 날짜)는 예제가 비워 보내므로 주지 않으면 비운다. */
    async fetchMarketFunds(since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisMarketFundsRecord[]> {
        const [until, query] = this.handleUntilParam('fetchMarketFunds', limit, params);
        const response = await this.privateGetUapiDomesticStockV1QuotationsMktfunds(this.extend({
            FID_INPUT_DATE_1: until === undefined ? '' : kstYmd(until),
            tr_id: 'FHKST649100C0',
        }, query));
        return this.filterBySinceLimit(rowsOf(this.safeValue(response, 'output')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'bsop_date')),
            businessDate: this.safeString(row, 'bsop_date', ''),
            indexPrice: this.safeNumber(row, 'bstp_nmix_prpr'),
            indexChange: this.safeNumber(row, 'bstp_nmix_prdy_vrss'),
            indexChangeRate: this.safeNumber(row, 'prdy_ctrt'),
            marketCap: this.safeNumber(row, 'hts_avls'),
            customerDeposit: this.safeNumber(row, 'cust_dpmn_amt'),
            customerDepositChange: this.safeNumber(row, 'cust_dpmn_amt_prdy_vrss'),
            turnoverRate: this.safeNumber(row, 'amt_tnrt'),
            unsettledAmount: this.safeNumber(row, 'uncl_amt'),
            creditLoanBalance: this.safeNumber(row, 'crdt_loan_rmnd'),
            futuresDeposit: this.safeNumber(row, 'futs_tfam_amt'),
            equityFunds: this.safeNumber(row, 'sttp_amt'),
            mixedFunds: this.safeNumber(row, 'mxtp_amt'),
            bondFunds: this.safeNumber(row, 'bntp_amt'),
            moneyMarketFunds: this.safeNumber(row, 'mmf_amt'),
            collateralLoanBalance: this.safeNumber(row, 'secu_lend_amt'),
            info: row,
        })), since, limit) as KisMarketFundsRecord[];
    }

    /** 예상체결가 추이(`exp-price-trend`, TR `FHPST01810000`). 국내만 지원한다. 구분(`FID_MKOP_CLS_CODE`)은 전체(`0`)다. 4를 주면 체결량 0을 뺀다. */
    async fetchExpectedPriceTrend(symbol: string, params: Dict = {}): Promise<KisExpectedPriceTrend> {
        const { code } = this.domesticInstrument(symbol, 'fetchExpectedPriceTrend');
        const response = await this.privateGetUapiDomesticStockV1QuotationsExpPriceTrend(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_MKOP_CLS_CODE: '0',
            tr_id: 'FHPST01810000',
        }, params));
        const summary = firstRow(this.safeValue(response, 'output1'));
        return {
            expectedPrice: this.safeNumber(summary, 'antc_cnpr'),
            expectedChange: this.safeNumber(summary, 'antc_cntg_vrss'),
            expectedChangeRate: this.safeNumber(summary, 'antc_cntg_prdy_ctrt'),
            expectedVolume: this.safeNumber(summary, 'antc_vol'),
            expectedAmount: this.safeNumber(summary, 'antc_tr_pbmn'),
            points: rowsOf(this.safeValue(response, 'output2')).map((row) => ({
                timestamp: kstTimestamp(this.safeString(row, 'stck_bsop_date'), this.safeString(row, 'stck_cntg_hour')),
                price: this.safeNumber(row, 'stck_prpr'),
                change: this.safeNumber(row, 'prdy_vrss'),
                percentage: this.safeNumber(row, 'prdy_ctrt'),
                volume: this.safeNumber(row, 'acml_vol'),
                info: row,
            })),
            info: summary,
        };
    }

    /** 매물대와 거래비중(`pbar-tratio`, TR `FHPST01130000`). 국내만 지원한다. 입력시간(`FID_INPUT_HOUR_1`)은 설명의 기본값(빈 값)을 보낸다. */
    async fetchVolumeProfile(symbol: string, params: Dict = {}): Promise<KisVolumeProfile> {
        const { code } = this.domesticInstrument(symbol, 'fetchVolumeProfile');
        const response = await this.privateGetUapiDomesticStockV1QuotationsPbarTratio(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_COND_SCR_DIV_CODE: '20113',
            FID_INPUT_HOUR_1: '',
            tr_id: 'FHPST01130000',
        }, params));
        const summary = firstRow(this.safeValue(response, 'output1'));
        return {
            weightedAveragePrice: this.safeNumber(summary, 'wghn_avrg_stck_prc'),
            listedShares: this.safeNumber(summary, 'lstn_stcn'),
            levels: rowsOf(this.safeValue(response, 'output2')).map((row) => ({
                rank: this.safeNumber(row, 'data_rank'),
                price: this.safeNumber(row, 'stck_prpr'),
                volume: this.safeNumber(row, 'cntg_vol'),
                share: this.safeNumber(row, 'acml_vol_rlim'),
                info: row,
            })),
            info: summary,
        };
    }

    /** 체결금액별 매매비중(`tradprt-byamt`, TR `FHKST111900C0`). 국내만 지원한다. 시장구분은 KRX(`J`)다. */
    async fetchTradeShareByAmount(symbol: string, params: Dict = {}): Promise<KisTradeShareByAmount[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchTradeShareByAmount');
        const response = await this.privateGetUapiDomesticStockV1QuotationsTradprtByamt(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_COND_SCR_DIV_CODE: '11119',
            FID_INPUT_ISCD: code,
            tr_id: 'FHKST111900C0',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            bucket: this.safeString(row, 'prpr_name', ''),
            averagePrice: this.safeNumber(row, 'smtn_avrg_prpr'),
            volume: this.safeNumber(row, 'acml_vol'),
            netBuyRate: this.safeNumber(row, 'whol_ntby_qty_rate'),
            netBuyCount: this.safeNumber(row, 'ntby_cntg_csnu'),
            sellVolume: this.safeNumber(row, 'seln_cnqn_smtn'),
            sellVolumeRate: this.safeNumber(row, 'whol_seln_vol_rate'),
            sellCount: this.safeNumber(row, 'seln_cntg_csnu'),
            buyVolume: this.safeNumber(row, 'shnu_cnqn_smtn'),
            buyVolumeRate: this.safeNumber(row, 'whol_shun_vol_rate'),
            buyCount: this.safeNumber(row, 'shnu_cntg_csnu'),
            info: row,
        }));
    }

    /** HTS 사용자 ID(`options.htsId`). 관심종목과 조건검색 조회의 필수 입력이라 없으면 요청 전에 `ArgumentsRequired`다. */
    private htsId(method: string): string {
        const id = this.safeString(this.options, 'htsId');
        if (!id) throw new ArgumentsRequired(`${this.id} ${method}() 는 options.htsId(HTS 사용자 ID)가 필요하다`);
        return id;
    }

    /**
     * HTS 관심종목 그룹 목록(`intstock-grouplist`, TR `HHKCM113004C7`). `options.htsId`가 필요하다.
     * 관심종목구분(`TYPE`)과 기타 구분(`FID_ETC_CLS_CODE`)은 설명 없이 예제값(`1`, `00`)만 있어 그대로 보낸다.
     */
    async fetchWatchlistGroups(params: Dict = {}): Promise<KisWatchlistGroup[]> {
        const response = await this.privateGetUapiDomesticStockV1QuotationsIntstockGrouplist(this.extend({
            TYPE: '1',
            FID_ETC_CLS_CODE: '00',
            USER_ID: this.htsId('fetchWatchlistGroups'),
            tr_id: 'HHKCM113004C7',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            groupCode: this.safeString(row, 'inter_grp_code', ''),
            groupName: this.safeString(row, 'inter_grp_name') || undefined,
            count: this.safeNumber(row, 'ask_cnt'),
            rank: this.safeNumber(row, 'data_rank'),
            ...this.kstStamp(this.safeString(row, 'date'), this.safeString(row, 'trnm_hour')),
            date: this.safeString(row, 'date') || undefined,
            time: this.safeString(row, 'trnm_hour') || undefined,
            info: row,
        }));
    }

    /**
     * HTS 관심종목 그룹의 종목(`intstock-stocklist-by-group`, TR `HHKCM113004C6`). `options.htsId`가 필요하다. 그룹 코드(`groupCode`)는
     * `fetchWatchlistGroups`가 준 값을 넘긴다. 관심종목구분과 기타 구분은 예제값(`1`, `4`)이고, 설명 없는 선택 입력은 비운다. 행은 `output2`다.
     */
    async fetchWatchlist(groupCode: string, params: Dict = {}): Promise<KisWatchlistItem[]> {
        if (!groupCode) throw new ArgumentsRequired(`${this.id} fetchWatchlist() 는 groupCode(관심 그룹 코드) 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsIntstockStocklistByGroup(this.extend({
            TYPE: '1',
            USER_ID: this.htsId('fetchWatchlist'),
            INTER_GRP_CODE: groupCode,
            FID_ETC_CLS_CODE: '4',
            DATA_RANK: '',
            INTER_GRP_NAME: '',
            HTS_KOR_ISNM: '',
            CNTG_CLS_CODE: '',
            tr_id: 'HHKCM113004C6',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            code: this.safeString(row, 'jong_code', ''),
            name: this.safeString(row, 'hts_kor_isnm') || undefined,
            marketCode: this.safeString(row, 'fid_mrkt_cls_code') || undefined,
            exchangeCode: this.safeString(row, 'exch_code') || undefined,
            memo: this.safeString(row, 'memo') || undefined,
            colorCode: this.safeString(row, 'color_code') || undefined,
            baseNetBuyVolume: this.safeNumber(row, 'fxdt_ntby_qty'),
            tradePrice: this.safeNumber(row, 'cntg_unpr'),
            tradeTypeCode: this.safeString(row, 'cntg_cls_code') || undefined,
            rank: this.safeNumber(row, 'data_rank'),
            info: row,
        }));
    }

    /** HTS 조건검색 조건 목록(`psearch-title`, TR `HHKST03900300`). `options.htsId`가 필요하다. 요청 키는 예제대로 소문자(`user_id`)다. */
    async fetchScreeners(params: Dict = {}): Promise<KisScreener[]> {
        const response = await this.privateGetUapiDomesticStockV1QuotationsPsearchTitle(this.extend({
            user_id: this.htsId('fetchScreeners'),
            tr_id: 'HHKST03900300',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            seq: this.safeString(row, 'seq', ''),
            name: this.safeString(row, 'condition_nm') || undefined,
            groupName: this.safeString(row, 'grp_nm') || undefined,
            info: row,
        }));
    }

    /**
     * HTS 조건검색 결과(`psearch-result`, TR `HHKST03900400`). `options.htsId`가 필요하다. 조건키값(`seq`)은 `fetchScreeners`가 준 값을 넘긴다.
     * 요청 키는 예제대로 소문자(`user_id`, `seq`)다.
     */
    async fetchScreenerResult(seq: string, params: Dict = {}): Promise<KisScreenerItem[]> {
        if (seq === undefined || seq === '') throw new ArgumentsRequired(`${this.id} fetchScreenerResult() 는 seq(조건키값) 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsPsearchResult(this.extend({
            user_id: this.htsId('fetchScreenerResult'),
            seq,
            tr_id: 'HHKST03900400',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            symbol: `${this.safeString(row, 'code', '')}/KRW`,
            name: this.safeString(row, 'name') || undefined,
            price: this.safeNumber(row, 'price'),
            change: this.safeNumber(row, 'change'),
            percentage: this.safeNumber(row, 'chgrate'),
            volume: this.safeNumber(row, 'acml_vol'),
            amount: this.safeNumber(row, 'trade_amt'),
            strength: this.safeNumber(row, 'cttr'),
            open: this.safeNumber(row, 'open'),
            high: this.safeNumber(row, 'high'),
            low: this.safeNumber(row, 'low'),
            high52Week: this.safeNumber(row, 'high52'),
            low52Week: this.safeNumber(row, 'low52'),
            expectedPrice: this.safeNumber(row, 'expprice'),
            basePrice: this.safeNumber(row, 'recprice'),
            upperLimitPrice: this.safeNumber(row, 'uplmtprice'),
            lowerLimitPrice: this.safeNumber(row, 'dnlmtprice'),
            marketCap: this.safeNumber(row, 'stotprice'),
            info: row,
        }));
    }

    /**
     * 재무 조회(`finance/*`). 국내만 지원한다. 종류(`statement`)는 대차대조표, 손익계산서, 재무비율, 수익성비율, 기타주요비율, 안정성비율, 성장성비율이다.
     * 연·분기 구분(`period`)은 전체 값이 없는 필수 입력이라 호출하는 쪽이 고른다(`annual` 년 `0`, `quarter` 분기 `1`). 결산 연월마다 `values`에
     * 종류별 항목을 숫자로 옮긴다(키는 `KIS_FINANCIAL_SPECS` 표). 연속조회(`tr_cont`)는 따라가지 않고 첫 페이지만 돌려준다.
     */
    async fetchFinancials(symbol: string, statement: KisFinancialStatement, period: 'annual' | 'quarter', params: Dict = {}): Promise<KisFinancialRecord[]> {
        const { code } = this.domesticInstrument(symbol, 'fetchFinancials');
        const spec = KIS_FINANCIAL_SPECS[statement];
        if (spec === undefined) throw new NotSupported(`${this.id} fetchFinancials() 가 지원하지 않는 종류다: ${statement}`);
        const div = period === 'annual' ? '0' : period === 'quarter' ? '1' : undefined;
        if (div === undefined) throw new BadRequest(`${this.id} fetchFinancials() 의 period 는 annual 이나 quarter 여야 한다: ${period}`);
        const call = this[kisImplicitGet(spec.path)] as (request: Dict) => Promise<unknown>;
        const response = await call.call(this, this.extend({
            [spec.divKey]: div,
            fid_cond_mrkt_div_code: 'J',
            fid_input_iscd: code,
            tr_id: spec.trId,
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => {
            const values: Record<string, number | undefined> = {};
            for (const [name, field] of Object.entries(spec.fields)) values[name] = this.safeNumber(row, field);
            return { settlementMonth: this.safeString(row, 'stac_yymm', ''), values, info: row };
        });
    }

    /**
     * 예탁원 일정(`ksdinfo/*`): 유상증자, 무상증자, 배당, 주식매수청구, 합병·분할, 액면교체, 자본감소, 상장정보, 공모주청약, 실권주, 의무예치,
     * 주주총회. 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다. `symbol`을 주면 그 종목만, 주지 않으면 전체를 묻는다.
     * 연속조회(`CTS`)는 따라가지 않고 첫 페이지만 돌려준다.
     */
    async fetchCorporateSchedules(
        type: KisCorporateScheduleType, symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {},
    ): Promise<KisCorporateSchedule[]> {
        const [until, query] = this.handleUntilParam('fetchCorporateSchedules', limit, params);
        const spec = KIS_CORPORATE_SCHEDULE_SPECS[type];
        if (spec === undefined) throw new NotSupported(`${this.id} fetchCorporateSchedules() 가 지원하지 않는 종류다: ${type}`);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchCorporateSchedules() 는 since 인자가 필요하다`);
        const code = symbol !== undefined ? this.domesticInstrument(symbol, 'fetchCorporateSchedules').code : '';
        const call = this[kisImplicitGet(spec.path)] as (request: Dict) => Promise<unknown>;
        const response = await call.call(this, this.extend({
            ...spec.params,
            CTS: '',
            F_DT: kstYmd(since),
            T_DT: kstYmd(until ?? this.milliseconds()),
            SHT_CD: code,
            tr_id: spec.trId,
        }, query));
        return this.limitRows(rowsOf(this.safeValue(response, 'output1')).map((row) => {
            const shortCode = this.safeString(row, 'sht_cd', '');
            const recordDate = this.safeString(row, spec.dateKey ?? 'record_date') || undefined;
            return {
                ...this.kstStamp(recordDate),
                symbol: shortCode !== '' ? `${shortCode}/KRW` : '',
                name: this.safeString(row, spec.nameKey ?? 'isin_name') || undefined,
                recordDate,
                info: row,
            };
        }), since, limit);
    }

    /**
     * 당사 신용가능 종목(`credit-by-company`, TR `FHPST04770000`). 신용주문 가능과 불가(`fid_slct_yn`)는 전체 값이 없는 필터라 `orderable`로
     * 반드시 고른다(가능 `0`, 불가 `1`). 시장은 전체(`0000`), 정렬은 예제의 이름순(`1`)이 기본이다. 연속조회는 따라가지 않는다.
     */
    async fetchCreditStocks(orderable: boolean, params: Dict = {}): Promise<KisCreditStock[]> {
        if (typeof orderable !== 'boolean') throw new ArgumentsRequired(`${this.id} fetchCreditStocks() 는 orderable(신용주문 가능 여부) 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsCreditByCompany(this.extend({
            fid_rank_sort_cls_code: '1',
            fid_slct_yn: orderable ? '0' : '1',
            fid_input_iscd: '0000',
            fid_cond_scr_div_code: '20477',
            fid_cond_mrkt_div_code: 'J',
            tr_id: 'FHPST04770000',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            symbol: `${this.safeString(row, 'stck_shrn_iscd', '')}/KRW`,
            name: this.safeString(row, 'hts_kor_isnm') || undefined,
            creditRate: this.safeNumber(row, 'crdt_rate'),
            info: row,
        }));
    }

    private investmentOpinion(row: Dict): KisInvestmentOpinion {
        const code = this.safeString(row, 'stck_shrn_iscd');
        return {
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            date: this.safeString(row, 'stck_bsop_date', ''),
            symbol: code ? `${code}/KRW` : undefined,
            name: this.safeString(row, 'hts_kor_isnm') || undefined,
            memberName: this.safeString(row, 'mbcr_name') || undefined,
            opinion: this.safeString(row, 'invt_opnn') || undefined,
            opinionCode: this.safeString(row, 'invt_opnn_cls_code') || undefined,
            previousOpinion: this.safeString(row, 'rgbf_invt_opnn') || undefined,
            previousOpinionCode: this.safeString(row, 'rgbf_invt_opnn_cls_code') || undefined,
            targetPrice: this.safeNumber(row, 'hts_goal_prc'),
            previousClose: this.safeNumber(row, 'stck_prdy_clpr'),
            divergenceRate: this.safeNumber(row, 'dprt'),
            futuresSpread: this.safeNumber(row, 'stft_esdg'),
            info: row,
        };
    }

    /**
     * 종목 투자의견(`invest-opinion`, TR `FHKST663300C0`). 국내만 지원한다. 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다.
     * 화면 코드(`16633`)는 예제값이다. 연속조회는 따라가지 않는다.
     */
    async fetchInvestmentOpinions(symbol: string, since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisInvestmentOpinion[]> {
        const [until, query] = this.handleUntilParam('fetchInvestmentOpinions', limit, params);
        const { code } = this.domesticInstrument(symbol, 'fetchInvestmentOpinions');
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchInvestmentOpinions() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsInvestOpinion(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_COND_SCR_DIV_CODE: '16633',
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: kstYmd(since),
            FID_INPUT_DATE_2: kstYmd(until ?? this.milliseconds()),
            tr_id: 'FHKST663300C0',
        }, query));
        // 종목별 조회라 응답 행에 종목코드가 없다(실계좌 확인). 부른 종목으로 채운다.
        const symbolOf = `${code}/KRW`;
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => ({ ...this.investmentOpinion(row), symbol: symbolOf })), since, limit);
    }

    /**
     * 증권사별 투자의견(`invest-opbysec`, TR `FHKST663400C0`). 회원사코드(`memberCode`)는 전체 값이 없는 필수 입력이라 호출하는 쪽이 준다.
     * 의견 구분은 전체(`0`)다. 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다. 화면 코드(`16634`)는 예제값이다.
     */
    async fetchBrokerOpinions(memberCode: string, since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisInvestmentOpinion[]> {
        const [until, query] = this.handleUntilParam('fetchBrokerOpinions', limit, params);
        if (!memberCode) throw new ArgumentsRequired(`${this.id} fetchBrokerOpinions() 는 memberCode(회원사코드) 인자가 필요하다`);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchBrokerOpinions() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsInvestOpbysec(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_COND_SCR_DIV_CODE: '16634',
            FID_INPUT_ISCD: memberCode,
            FID_DIV_CLS_CODE: '0',
            FID_INPUT_DATE_1: kstYmd(since),
            FID_INPUT_DATE_2: kstYmd(until ?? this.milliseconds()),
            tr_id: 'FHKST663400C0',
        }, query));
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => this.investmentOpinion(row)), since, limit);
    }

    /**
     * 종합 시황·공시 제목(`news-title`, TR `FHKST01011800`). 입력은 모두 설명 없는 선택 입력이라 비워 보내고, `symbol`을 주면 그 종목만 묻는다.
     * 연속조회는 따라가지 않는다.
     */
    async fetchNewsTitles(symbol: Str = undefined, params: Dict = {}): Promise<KisNewsTitle[]> {
        const code = symbol !== undefined ? this.domesticInstrument(symbol, 'fetchNewsTitles').code : '';
        const response = await this.privateGetUapiDomesticStockV1QuotationsNewsTitle(this.extend({
            FID_NEWS_OFER_ENTP_CODE: '',
            FID_COND_MRKT_CLS_CODE: '',
            FID_INPUT_ISCD: code,
            FID_TITL_CNTT: '',
            FID_INPUT_DATE_1: '',
            FID_INPUT_HOUR_1: '',
            FID_RANK_SORT_CLS_CODE: '',
            FID_INPUT_SRNO: '',
            tr_id: 'FHKST01011800',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            id: this.safeString(row, 'cntt_usiq_srno', ''),
            ...this.kstStamp(this.safeString(row, 'data_dt'), this.safeString(row, 'data_tm')),
            title: this.safeString(row, 'hts_pbnt_titl_cntt') || undefined,
            source: this.safeString(row, 'dorg') || undefined,
            providerCode: this.safeString(row, 'news_ofer_entp_code') || undefined,
            categoryCode: this.safeString(row, 'news_lrdv_code') || undefined,
            codes: ['iscd1', 'iscd2', 'iscd3', 'iscd4', 'iscd5'].map((key) => this.safeString(row, key, '').trim()).filter((c) => c !== ''),
            info: row,
        }));
    }

    /**
     * 상품기본조회(`search-info`, TR `CTPF1604R`). 국내만 지원한다. 상품유형코드는 `fetchStocks`와 같은 국내주식(`300`)이다.
     * 필드는 공식 예제의 필드 목록에 있는 것만 옮기고 나머지는 `info`에 원문으로 둔다.
     */
    async fetchProductInfo(symbol: string, params: Dict = {}): Promise<KisProductInfo> {
        const instrument = this.domesticInstrument(symbol, 'fetchProductInfo');
        const response = await this.privateGetUapiDomesticStockV1QuotationsSearchInfo(this.extend({
            PDNO: instrument.code,
            PRDT_TYPE_CD: STOCK_INFO_PRODUCT_TYPE,
            tr_id: 'CTPF1604R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        return {
            symbol: instrument.symbol,
            standardCode: text('std_pdno'),
            shortCode: text('shtn_pdno'),
            saleStatusCode: text('prdt_sale_stat_cd'),
            riskGradeCode: text('prdt_risk_grad_cd'),
            classificationCode: text('prdt_clsf_cd'),
            saleStartDate: text('sale_strt_dt'),
            saleEndDate: text('sale_end_dt'),
            firstRegisteredDate: text('frst_erlm_dt'),
            info: output,
        };
    }

    /**
     * 당사 대주가능 종목(`lendable-by-company`, TR `CTSC2702R`). 국내만 지원한다. 거래소와 조회구분은 전체(`00`, `0`)를, 당사 대주가능
     * 여부(`THCO_STLN_PSBL_YN`)는 설명 없이 예제값(`Y`)만 있어 그대로 보낸다. `symbol`을 주면 그 종목만 묻는다. 행은 `output1`이다.
     * 연속조회 키는 설명대로 비워 보내므로 다음 페이지는 받지 않는다.
     */
    async fetchLendableStocks(symbol: Str = undefined, params: Dict = {}): Promise<KisLendableStock[]> {
        const code = symbol !== undefined ? this.domesticInstrument(symbol, 'fetchLendableStocks').code : '';
        const response = await this.privateGetUapiDomesticStockV1QuotationsLendableByCompany(this.extend({
            EXCG_DVSN_CD: '00',
            PDNO: code,
            THCO_STLN_PSBL_YN: 'Y',
            INQR_DVSN_1: '0',
            CTX_AREA_FK200: '',
            CTX_AREA_NK100: '',
            tr_id: 'CTSC2702R',
        }, params));
        return rowsOf(this.safeValue(response, 'output1')).map((row) => {
            const yn = this.safeString(row, 'psbl_yn');
            return {
                symbol: `${this.safeString(row, 'pdno', '')}/KRW`,
                name: this.safeString(row, 'prdt_name') || undefined,
                parValue: this.safeNumber(row, 'papr'),
                previousClose: this.safeNumber(row, 'bfdy_clpr'),
                collateralPrice: this.safeNumber(row, 'sbst_prvs'),
                available: yn === 'Y' ? true : yn === 'N' ? false : undefined,
                limitQuantity: this.safeNumber(row, 'lmt_qty1'),
                usedQuantity: this.safeNumber(row, 'use_qty1'),
                tradableQuantity: this.safeNumber(row, 'trad_psbl_qty2'),
                ...this.kstStamp(this.safeString(row, 'bass_dt')),
                baseDate: this.safeString(row, 'bass_dt') || undefined,
                info: row,
            };
        });
    }

    /** 업종코드(네 자리). 형식이 틀리면 요청 전에 `BadRequest`다. */
    private indexCode(index: string, method: string): string {
        if (!/^\d{4}$/.test(index)) throw new BadRequest(`${this.id} ${method}() 의 index 는 업종코드 네 자리여야 한다: ${index}`);
        return index;
    }

    /** 예상체결 구분을 코드로 옮긴다(장 시작 전 `1`, 장 마감 `2`). 그 밖의 값이면 요청 전에 `ArgumentsRequired`다. */
    private auctionSessionCode(session: KisAuctionSession, method: string): string {
        const code = session === 'preopen' ? '1' : session === 'closing' ? '2' : undefined;
        if (code === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 session('preopen' 장 시작 전, 'closing' 장 마감) 인자가 필요하다`);
        return code;
    }

    private indexTick(row: Dict, timeKey: string, rateKey: string): KisIndexTick {
        return {
            time: this.safeString(row, timeKey, ''),
            price: this.safeNumber(row, 'bstp_nmix_prpr'),
            change: this.safeNumber(row, 'bstp_nmix_prdy_vrss'),
            percentage: this.safeNumber(row, rateKey),
            cumulativeVolume: this.safeNumber(row, 'acml_vol'),
            cumulativeAmount: this.safeNumber(row, 'acml_tr_pbmn'),
            volume: this.safeNumber(row, 'cntg_vol'),
            info: row,
        };
    }

    private indexCategory(row: Dict): KisIndexCategory {
        return {
            sectorCode: this.safeString(row, 'bstp_cls_code', ''),
            name: this.safeString(row, 'hts_kor_isnm') || undefined,
            price: this.safeNumber(row, 'bstp_nmix_prpr'),
            change: this.safeNumber(row, 'bstp_nmix_prdy_vrss'),
            percentage: this.safeNumber(row, 'bstp_nmix_prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            amount: this.safeNumber(row, 'acml_tr_pbmn'),
            volumeShare: this.safeNumber(row, 'acml_vol_rlim'),
            amountShare: this.safeNumber(row, 'acml_tr_pbmn_rlim'),
            basePrice: this.safeNumber(row, 'nmix_sdpr'),
            info: row,
        };
    }

    /** 업종 지수 현재가(`inquire-index-price`, TR `FHPUP02100000`). `index`는 업종코드 네 자리다(예: `0001` 코스피, `1001` 코스닥). */
    async fetchIndexQuote(index: string, params: Dict = {}): Promise<KisIndexQuote> {
        const code = this.indexCode(index, 'fetchIndexQuote');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireIndexPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'U',
            FID_INPUT_ISCD: code,
            tr_id: 'FHPUP02100000',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        return {
            index: code,
            price: this.safeNumber(output, 'bstp_nmix_prpr'),
            change: this.safeNumber(output, 'bstp_nmix_prdy_vrss'),
            percentage: this.safeNumber(output, 'bstp_nmix_prdy_ctrt'),
            open: this.safeNumber(output, 'bstp_nmix_oprc'),
            high: this.safeNumber(output, 'bstp_nmix_hgpr'),
            low: this.safeNumber(output, 'bstp_nmix_lwpr'),
            volume: this.safeNumber(output, 'acml_vol'),
            amount: this.safeNumber(output, 'acml_tr_pbmn'),
            advancers: this.safeNumber(output, 'ascn_issu_cnt'),
            upperLimitCount: this.safeNumber(output, 'uplm_issu_cnt'),
            unchanged: this.safeNumber(output, 'stnr_issu_cnt'),
            decliners: this.safeNumber(output, 'down_issu_cnt'),
            lowerLimitCount: this.safeNumber(output, 'lslm_issu_cnt'),
            info: output,
        };
    }

    /**
     * 업종 지수 일자별(`inquire-index-daily-price`, TR `FHPUP02120000`). `timeframe`은 `1d`, `1w`, `1M`이다. 입력 날짜(`params.until`의 한국 날짜)는 필수라
     * 기본값을 오늘(한국 날짜)로 둔다. 행은 `output2`다. 투자 신 심리도와 20일 이격도처럼 `fetchIndexOHLCV`에 없는 값도 준다.
     */
    async fetchIndexDailyPrices(index: string, timeframe = '1d', since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisIndexDay[]> {
        const [until, query] = this.handleUntilParam('fetchIndexDailyPrices', limit, params);
        const code = this.indexCode(index, 'fetchIndexDailyPrices');
        const period = KIS_DAILY_PRICE_PERIODS[timeframe];
        if (period === undefined) {
            throw new NotSupported(`${this.id} fetchIndexDailyPrices() 는 ${Object.keys(KIS_DAILY_PRICE_PERIODS).join(', ')} 만 지원한다: ${timeframe}`);
        }
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireIndexDailyPrice(this.extend({
            FID_PERIOD_DIV_CODE: period,
            FID_COND_MRKT_DIV_CODE: 'U',
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: kstYmd(until ?? this.milliseconds()),
            tr_id: 'FHPUP02120000',
        }, query));
        return this.filterBySinceLimit(rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            date: this.safeString(row, 'stck_bsop_date', ''),
            price: this.safeNumber(row, 'bstp_nmix_prpr'),
            change: this.safeNumber(row, 'bstp_nmix_prdy_vrss'),
            percentage: this.safeNumber(row, 'bstp_nmix_prdy_ctrt'),
            open: this.safeNumber(row, 'bstp_nmix_oprc'),
            high: this.safeNumber(row, 'bstp_nmix_hgpr'),
            low: this.safeNumber(row, 'bstp_nmix_lwpr'),
            volume: this.safeNumber(row, 'acml_vol'),
            amount: this.safeNumber(row, 'acml_tr_pbmn'),
            volumeShare: this.safeNumber(row, 'acml_vol_rlim'),
            investorSentiment: this.safeNumber(row, 'invt_new_psdg'),
            disparity20: this.safeNumber(row, 'd20_dsrt'),
            info: row,
        })), since, limit) as KisIndexDay[];
    }

    /** 업종 지수 시간별(분)(`inquire-index-timeprice`, TR `FHPUP02110200`). `interval`은 설명에 있는 `1m`, `5m`, `10m`(60, 300, 600초)이다. */
    async fetchIndexTimePrices(index: string, interval = '1m', params: Dict = {}): Promise<KisIndexTick[]> {
        const code = this.indexCode(index, 'fetchIndexTimePrices');
        const seconds = ({ '1m': '60', '5m': '300', '10m': '600' } as Readonly<Record<string, string>>)[interval];
        if (seconds === undefined) throw new NotSupported(`${this.id} fetchIndexTimePrices() 는 1m, 5m, 10m 만 지원한다: ${interval}`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireIndexTimeprice(this.extend({
            FID_INPUT_HOUR_1: seconds,
            FID_INPUT_ISCD: code,
            FID_COND_MRKT_DIV_CODE: 'U',
            tr_id: 'FHPUP02110200',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => this.indexTick(row, 'bsop_hour', 'bstp_nmix_prdy_ctrt'));
    }

    /** 업종 지수 시간별(초)(`inquire-index-tickprice`, TR `FHPUP02110100`). */
    async fetchIndexTicks(index: string, params: Dict = {}): Promise<KisIndexTick[]> {
        const code = this.indexCode(index, 'fetchIndexTicks');
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireIndexTickprice(this.extend({
            FID_INPUT_ISCD: code,
            FID_COND_MRKT_DIV_CODE: 'U',
            tr_id: 'FHPUP02110100',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => this.indexTick(row, 'stck_cntg_hour', 'bstp_nmix_prdy_ctrt'));
    }

    /**
     * 업종 구분별 전체시세(`inquire-index-category-price`, TR `FHPUP02140000`). 시장(`KOSPI`, `KOSDAQ`, `KOSPI200`)은 전체 값이 없는 필수 입력이라
     * 호출하는 쪽이 고른다. 설명에 적힌 짝대로 업종코드(`0001`, `1001`, `2001`)와 시장구분(`K`, `Q`, `K2`)을 함께 보낸다. 소속은 전업종(`0`)이다.
     */
    async fetchIndexCategoryPrices(market: KisMarket | 'KOSPI200', params: Dict = {}): Promise<KisIndexCategory[]> {
        const pair = ({ KOSPI: ['0001', 'K'], KOSDAQ: ['1001', 'Q'], KOSPI200: ['2001', 'K2'] } as Readonly<Record<string, readonly [string, string]>>)[market];
        if (pair === undefined) throw new BadRequest(`${this.id} fetchIndexCategoryPrices() 의 market 은 KOSPI, KOSDAQ, KOSPI200 중 하나여야 한다: ${market}`);
        const response = await this.privateGetUapiDomesticStockV1QuotationsInquireIndexCategoryPrice(this.extend({
            FID_COND_MRKT_DIV_CODE: 'U',
            FID_INPUT_ISCD: pair[0],
            FID_COND_SCR_DIV_CODE: '20214',
            FID_MRKT_CLS_CODE: pair[1],
            FID_BLNG_CLS_CODE: '0',
            tr_id: 'FHPUP02140000',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => this.indexCategory(row));
    }

    /**
     * 예상체결지수 추이(`exp-index-trend`, TR `FHPST01840000`). 구분(`session`)은 전체 값이 없는 필수 입력이라 호출하는 쪽이 고른다.
     * 봉 간격(`FID_INPUT_HOUR_1`)은 선택 입력이라 비운다. 두 출처(예제 필드 목록, cluefin) 모두 필드 설명이 한 칸씩 밀려 있어(`stck_cntg_hour`에
     * "주식 단축 종목코드") 설명 대신 다른 지수 API와 같은 필드 이름 규칙으로 옮긴다. 전일대비율은 `prdy_ctrt`다.
     */
    async fetchExpectedIndexTrend(index: string, session: KisAuctionSession, params: Dict = {}): Promise<KisIndexTick[]> {
        const code = this.indexCode(index, 'fetchExpectedIndexTrend');
        const response = await this.privateGetUapiDomesticStockV1QuotationsExpIndexTrend(this.extend({
            FID_MKOP_CLS_CODE: this.auctionSessionCode(session, 'fetchExpectedIndexTrend'),
            FID_INPUT_HOUR_1: '',
            FID_INPUT_ISCD: code,
            FID_COND_MRKT_DIV_CODE: 'U',
            tr_id: 'FHPST01840000',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => this.indexTick(row, 'stck_cntg_hour', 'prdy_ctrt'));
    }

    /**
     * 예상체결 전체지수(`exp-total-index`, TR `FHKUP11750000`). 구분(`session`)은 전체 값이 없는 필수 입력이라 호출하는 쪽이 고른다.
     * 시장과 업종은 설명의 전체 값(`0`, `0000`)을 보낸다. 요청 키는 예제대로 소문자다. 업종별 행(`output2`)을 돌려준다.
     */
    async fetchExpectedIndices(session: KisAuctionSession, params: Dict = {}): Promise<KisIndexCategory[]> {
        const response = await this.privateGetUapiDomesticStockV1QuotationsExpTotalIndex(this.extend({
            fid_mrkt_cls_code: '0',
            fid_cond_mrkt_div_code: 'U',
            fid_cond_scr_div_code: '11175',
            fid_input_iscd: '0000',
            fid_mkop_cls_code: this.auctionSessionCode(session, 'fetchExpectedIndices'),
            tr_id: 'FHKUP11750000',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => this.indexCategory(row));
    }

    /**
     * 금리 종합(`comp-interest`, TR `FHPST07020000`). 시장구분(`I`), 화면 코드(`20702`), 분류 구분(`1`)은 설명 없이 예제값만 있어 그대로 보내고,
     * 둘째 분류 구분은 설명대로 공백이다. 응답의 두 목록을 한 배열로 합치고, 행마다 원래 키를 `outputKey`에 남긴다.
     */
    async fetchInterestRates(params: Dict = {}): Promise<KisInterestRate[]> {
        const response = await this.privateGetUapiDomesticStockV1QuotationsCompInterest(this.extend({
            FID_COND_MRKT_DIV_CODE: 'I',
            FID_COND_SCR_DIV_CODE: '20702',
            FID_DIV_CLS_CODE: '1',
            FID_DIV_CLS_CODE1: '',
            tr_id: 'FHPST07020000',
        }, params));
        const rows = (key: 'output1' | 'output2', rateKey: string): KisInterestRate[] => rowsOf(this.safeValue(response, key)).map((row) => ({
            code: this.safeString(row, 'bcdt_code', ''),
            name: this.safeString(row, 'hts_kor_isnm') || undefined,
            rate: this.safeNumber(row, 'bond_mnrt_prpr'),
            change: this.safeNumber(row, 'bond_mnrt_prdy_vrss'),
            percentage: this.safeNumber(row, rateKey),
            ...this.kstStamp(this.safeString(row, 'stck_bsop_date')),
            date: this.safeString(row, 'stck_bsop_date') || undefined,
            outputKey: key,
            info: row,
        }));
        return [...rows('output1', 'prdy_ctrt'), ...rows('output2', 'bstp_nmix_prdy_ctrt')];
    }

    /** 국내선물 영업일과 장 시각(`market-time`, TR `HHMCM000002C0`). 입력이 없다. */
    async fetchMarketTime(params: Dict = {}): Promise<KisMarketTime> {
        const response = await this.privateGetUapiDomesticStockV1QuotationsMarketTime(this.extend({ tr_id: 'HHMCM000002C0' }, params));
        const output = firstRow(this.safeValue(response, 'output1'));
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        return {
            businessDays: ['date1', 'date2', 'date3', 'date4', 'date5'].map((key) => this.safeString(output, key, '')).filter((d) => d !== ''),
            today: text('today'),
            time: text('time'),
            openTime: text('s_time'),
            closeTime: text('e_time'),
            info: output,
        };
    }

    /** 해외 종목과 그 시세 거래소 코드(`NAS` 등). 국내 종목이거나 해외 마스터에 없으면 요청 전에 `BadSymbol`이다. */
    private overseasInstrument(symbol: string, method: string): KisInstrument & { quoteExchange: OverseasMarket } {
        const instrument = this.instrumentOf(symbol);
        if (!instrument.overseas) throw new BadSymbol(`${this.id} ${method}() 은 해외 종목만 지원한다: ${symbol}`);
        if (instrument.quoteExchange === undefined) throw new BadSymbol(`해외 마스터에 없는 ticker: ${symbol}`);
        return instrument as KisInstrument & { quoteExchange: OverseasMarket };
    }

    /** 해외 거래소 인자(`NAS` 등 설명의 아홉 곳). 그 밖의 값이면 요청 전에 `BadRequest`다. */
    private overseasExchange(exchange: string, method: string): string {
        if (KIS_OVERSEAS_RANKING_EXCHANGES[exchange] === undefined) {
            throw new BadRequest(`${this.id} ${method}() 의 exchange 는 NYS, NAS, AMS, HKS, SHS, SZS, HSX, HNX, TSE 중 하나여야 한다: ${exchange}`);
        }
        return exchange;
    }

    /**
     * 해외주식 현재가 1호가(`inquire-asking-price`, TR `HHDFS76200100`). 해외 종목만 지원한다. 매수·매도 1호가만 오므로 한 단계 호가를 돌려준다.
     * 통합 `fetchOrderBook`은 해외 종목에 `NotSupported`를 던지는 기존 동작을 유지하고, 이 메서드를 따로 둔다. 원문(시가율, VCM 등)은 `info`에 있다.
     */
    async fetchOverseasOrderBook(symbol: string, params: Dict = {}): Promise<OrderBook & { info: Dict }> {
        const instrument = this.overseasInstrument(symbol, 'fetchOverseasOrderBook');
        const response = await this.privateGetUapiOverseasPriceV1QuotationsInquireAskingPrice(this.extend({
            AUTH: '',
            EXCD: instrument.quoteExchange,
            SYMB: instrument.code,
            tr_id: 'HHDFS76200100',
        }, params));
        const level = firstRow(this.safeValue(response, 'output2'));
        const bids: Array<[Num, Num]> = [];
        const asks: Array<[Num, Num]> = [];
        const bid = Number(level.pbid1);
        if (Number.isFinite(bid) && bid > 0) bids.push([bid, toNumber(level.vbid1)]);
        const ask = Number(level.pask1);
        if (Number.isFinite(ask) && ask > 0) asks.push([ask, toNumber(level.vask1)]);
        const book = this.safeOrderBook({ symbol: instrument.symbol, timestamp: this.milliseconds(), bids, asks });
        return { ...book, info: response as Dict };
    }

    /** 해외주식 현재가 상세(`price-detail`, TR `HHDFS76200200`). 해외 종목만 지원한다. 가격 단위는 종목의 거래 통화다. */
    async fetchOverseasStockDetail(symbol: string, params: Dict = {}): Promise<KisOverseasStockDetail> {
        const instrument = this.overseasInstrument(symbol, 'fetchOverseasStockDetail');
        const response = await this.privateGetUapiOverseasPriceV1QuotationsPriceDetail(this.extend({
            AUTH: '',
            EXCD: instrument.quoteExchange,
            SYMB: instrument.code,
            tr_id: 'HHDFS76200200',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        return {
            symbol: instrument.symbol,
            last: num('last'),
            open: num('open'),
            high: num('high'),
            low: num('low'),
            previousClose: num('base'),
            volume: num('tvol'),
            amount: num('tamt'),
            previousVolume: num('pvol'),
            marketCap: num('tomv'),
            upperLimitPrice: num('uplp'),
            lowerLimitPrice: num('dnlp'),
            high52Week: num('h52p'),
            high52WeekDate: text('h52d'),
            low52Week: num('l52p'),
            low52WeekDate: text('l52d'),
            per: num('perx'),
            pbr: num('pbrx'),
            eps: num('epsx'),
            bps: num('bpsx'),
            listedShares: num('shar'),
            currency: text('curr'),
            lotSize: num('vnit'),
            tickSize: num('e_hogau'),
            sector: text('e_icod'),
            tradable: text('e_ordyn'),
            krwPrice: num('t_xprc'),
            exchangeRate: num('t_rate'),
            info: output,
        };
    }

    /**
     * 해외주식 체결추이(`inquire-ccnl`, TR `HHDFS76200300`). 해외 종목만 지원한다. 당일·전일 구분(`TDAY`)은 전체 값이 없는 필터라 `day`로 반드시
     * 고른다(`today` 당일 `1`, `previous` 전일 `0`). 예제 코드는 행을 `output1`에서 읽고 포털 명세를 옮긴 `cluefin`은 `output2`에서 읽는다.
     * 다른 해외 조회처럼 머리 정보는 객체, 행은 배열로 오므로 배열인 쪽을 행으로 읽는다. 연속조회(`KEYB`)는 따라가지 않는다.
     */
    async fetchOverseasTradeTicks(symbol: string, day: 'today' | 'previous', params: Dict = {}): Promise<KisOverseasTradeTick[]> {
        const instrument = this.overseasInstrument(symbol, 'fetchOverseasTradeTicks');
        const tday = day === 'today' ? '1' : day === 'previous' ? '0' : undefined;
        if (tday === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasTradeTicks() 는 day('today' 당일, 'previous' 전일) 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasPriceV1QuotationsInquireCcnl(this.extend({
            EXCD: instrument.quoteExchange,
            TDAY: tday,
            SYMB: instrument.code,
            AUTH: '',
            KEYB: '',
            tr_id: 'HHDFS76200300',
        }, params));
        const second = rowsOf(this.safeValue(response, 'output2'));
        const rows = second.length > 0 ? second : rowsOf(this.safeValue(response, 'output1'));
        return rows.map((row) => ({
            time: this.safeString(row, 'khms', ''),
            price: this.safeNumber(row, 'last'),
            change: this.safeNumber(row, 'diff'),
            percentage: this.safeNumber(row, 'rate'),
            volume: this.safeNumber(row, 'evol'),
            cumulativeVolume: this.safeNumber(row, 'tvol'),
            bid: this.safeNumber(row, 'pbid'),
            ask: this.safeNumber(row, 'pask'),
            strength: this.safeNumber(row, 'vpow'),
            marketType: this.safeString(row, 'mtyp') || undefined,
            info: row,
        }));
    }

    /**
     * 해외 종목·지수·환율 기간별 시세(`inquire-daily-chartprice`, TR `FHKST03030100`). 종류(`kind`: 해외지수, 환율, 국채, 금선물)는 전체 값이 없는
     * 필수 입력이다. `code`는 KIS 해외 마스터의 코드다(예: `.DJI`). 설명대로 미국 주식은 다우30, 나스닥100, S&P500 종목만 이 API로 조회된다.
     * `timeframe`은 `1d`, `1w`, `1M`, `1y`이다. `since`가 없으면 `limit`개 봉에 휴장일 여유를 더한 구간을 묻는다. 봉 시각은 그 날짜의 UTC 0시다.
     */
    async fetchGlobalOHLCV(
        kind: KisGlobalDailyKind, code: string, timeframe = '1d', since: Int = undefined, limit: Int = 100, params: Dict = {},
    ): Promise<OHLCV[]> {
        const market = ({ INDEX: 'N', FX: 'X', BOND: 'I', GOLD_FUTURES: 'S' } as Readonly<Record<string, string>>)[kind];
        if (market === undefined) throw new ArgumentsRequired(`${this.id} fetchGlobalOHLCV() 는 kind(INDEX, FX, BOND, GOLD_FUTURES) 인자가 필요하다`);
        if (!code) throw new ArgumentsRequired(`${this.id} fetchGlobalOHLCV() 는 code 인자가 필요하다`);
        const period = KIS_INDEX_PERIODS[timeframe];
        if (period === undefined) throw new NotSupported(`${this.id} fetchGlobalOHLCV() 는 ${Object.keys(KIS_INDEX_PERIODS).join(', ')} 만 지원한다: ${timeframe}`);
        const until = this.safeInteger(params, 'until') ?? this.milliseconds();
        const start = since ?? until - (limit ?? 100) * period.days * KIS_INDEX_RANGE_MARGIN * DAY_MS;
        const response = await this.privateGetUapiOverseasPriceV1QuotationsInquireDailyChartprice(this.extend({
            FID_COND_MRKT_DIV_CODE: market,
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: kstYmd(start),
            FID_INPUT_DATE_2: kstYmd(until),
            FID_PERIOD_DIV_CODE: period.code,
            tr_id: 'FHKST03030100',
        }, this.omit(params, 'until')));
        const candles = rowsOf(this.safeValue(response, 'output2')).map((row): OHLCV => {
            const ymd = this.safeString(row, 'stck_bsop_date', '');
            const timestamp = /^\d{8}$/.test(ymd) ? Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) : undefined;
            return [
                timestamp,
                this.safeNumber(row, 'ovrs_nmix_oprc'),
                this.safeNumber(row, 'ovrs_nmix_hgpr'),
                this.safeNumber(row, 'ovrs_nmix_lwpr'),
                this.safeNumber(row, 'ovrs_nmix_prpr'),
                this.safeNumber(row, 'acml_vol'),
            ];
        });
        const sorted = candles.filter((c) => c[0] !== undefined).sort((a, b) => (a[0] as number) - (b[0] as number));
        return limit !== undefined ? sorted.slice(-limit) : sorted;
    }

    /**
     * 해외지수 분봉(`inquire-time-indexchartprice`, TR `FHKST03030200`). 종류(`kind`: 해외지수, 환율, 원화환율)는 전체 값이 없는 필수 입력이다.
     * 장 구분은 예제의 정규장(`0`), 과거 데이터 포함은 예제의 `Y`가 기본이다. 날짜와 시각의 시간대가 문서에 없어 봉 시각을 만들지 않고 문자열로 둔다.
     */
    async fetchGlobalMinuteBars(kind: KisGlobalMinuteKind, code: string, params: Dict = {}): Promise<KisGlobalMinuteBar[]> {
        const market = ({ INDEX: 'N', FX: 'X', KRW_FX: 'KX' } as Readonly<Record<string, string>>)[kind];
        if (market === undefined) throw new ArgumentsRequired(`${this.id} fetchGlobalMinuteBars() 는 kind(INDEX, FX, KRW_FX) 인자가 필요하다`);
        if (!code) throw new ArgumentsRequired(`${this.id} fetchGlobalMinuteBars() 는 code 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasPriceV1QuotationsInquireTimeIndexchartprice(this.extend({
            FID_COND_MRKT_DIV_CODE: market,
            FID_INPUT_ISCD: code,
            FID_HOUR_CLS_CODE: '0',
            FID_PW_DATA_INCU_YN: 'Y',
            tr_id: 'FHKST03030200',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            date: this.safeString(row, 'stck_bsop_date', ''),
            time: this.safeString(row, 'stck_cntg_hour', ''),
            open: this.safeNumber(row, 'optn_oprc'),
            high: this.safeNumber(row, 'optn_hgpr'),
            low: this.safeNumber(row, 'optn_lwpr'),
            close: this.safeNumber(row, 'optn_prpr'),
            volume: this.safeNumber(row, 'cntg_vol'),
            info: row,
        }));
    }

    /**
     * 해외주식 분봉(`inquire-time-itemchartprice`, TR `HHDFS76950200`). 해외 종목만 지원한다. 봉 길이(`minutes`, 분)는 기본 1분이다.
     * 전일 포함 여부는 예제의 `1`(전일포함), 요청 개수는 최대 120개다. 다음 조회 입력(`NEXT`, `KEYB`)은 설명대로 처음 조회의 빈 값을 보낸다.
     * 봉 시각은 한국 기준 일자와 시각(`kymd`, `khms`)으로 만들고 오름차순으로 정렬한다.
     */
    async fetchOverseasMinuteOHLCV(symbol: string, minutes = 1, params: Dict = {}): Promise<OHLCV[]> {
        const instrument = this.overseasInstrument(symbol, 'fetchOverseasMinuteOHLCV');
        if (!Number.isInteger(minutes) || minutes < 1) throw new BadRequest(`${this.id} fetchOverseasMinuteOHLCV() 의 minutes 는 1 이상의 정수여야 한다: ${minutes}`);
        const response = await this.privateGetUapiOverseasPriceV1QuotationsInquireTimeItemchartprice(this.extend({
            AUTH: '',
            EXCD: instrument.quoteExchange,
            SYMB: instrument.code,
            NMIN: String(minutes),
            PINC: '1',
            NEXT: '',
            NREC: '120',
            FILL: '',
            KEYB: '',
            tr_id: 'HHDFS76950200',
        }, params));
        return rowsOf(this.safeValue(response, 'output2'))
            .map((row): OHLCV => [
                kstTimestamp(this.safeString(row, 'kymd'), this.safeString(row, 'khms')),
                this.safeNumber(row, 'open'),
                this.safeNumber(row, 'high'),
                this.safeNumber(row, 'low'),
                this.safeNumber(row, 'last'),
                this.safeNumber(row, 'evol'),
            ])
            .filter((c) => c[0] !== undefined)
            .sort((a, b) => (a[0] as number) - (b[0] as number));
    }

    /** 해외 거래소의 업종 코드 목록(`industry-price`, TR `HHDFS76370100`). 거래소(`exchange`)는 전체 값이 없는 필수 입력이다. 행은 `output2`다. */
    async fetchOverseasIndustries(exchange: OverseasMarket, params: Dict = {}): Promise<KisOverseasIndustry[]> {
        const response = await this.privateGetUapiOverseasPriceV1QuotationsIndustryPrice(this.extend({
            EXCD: this.overseasExchange(exchange, 'fetchOverseasIndustries'),
            AUTH: '',
            tr_id: 'HHDFS76370100',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            code: this.safeString(row, 'icod', ''),
            name: this.safeString(row, 'name') || undefined,
            info: row,
        }));
    }

    /**
     * 해외 업종별 시세(`industry-theme`, TR `HHDFS76370000`). 거래소와 업종코드(`industryCode`, `fetchOverseasIndustries`의 `code`)는 필수다.
     * 거래량 조건은 전체(`0`)다. 행을 순위 행 모양으로 정리하고(`seqn`을 순위로), 심볼에는 거래소의 거래 통화를 붙인다.
     */
    async fetchOverseasIndustryStocks(exchange: OverseasMarket, industryCode: string, params: Dict = {}): Promise<KisRankingItem[]> {
        const code = this.overseasExchange(exchange, 'fetchOverseasIndustryStocks');
        if (!industryCode) throw new ArgumentsRequired(`${this.id} fetchOverseasIndustryStocks() 는 industryCode(업종코드) 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasPriceV1QuotationsIndustryTheme(this.extend({
            EXCD: code,
            ICOD: industryCode,
            VOL_RANG: '0',
            AUTH: '',
            KEYB: '',
            tr_id: 'HHDFS76370000',
        }, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            rank: this.safeNumber(row, 'seqn'),
            symbol: `${this.safeString(row, 'symb', '')}/${KIS_OVERSEAS_RANKING_EXCHANGES[code]}`,
            name: this.safeString(row, 'name') || undefined,
            last: this.safeNumber(row, 'last'),
            change: this.safeNumber(row, 'diff'),
            percentage: this.safeNumber(row, 'rate'),
            volume: this.safeNumber(row, 'tvol'),
            info: row,
        }));
    }

    /** 해외 결제일(`countries-holiday`, TR `CTOS5011R`). 기준일자(`params.until`의 한국 날짜)는 필수라 기본값을 오늘(한국 날짜)로 둔다. 연속조회 키는 설명대로 공백이다. */
    async fetchSettlementDates(params: Dict = {}): Promise<KisSettlementDate[]> {
        const [until, query] = this.handleUntilParam('fetchSettlementDates', undefined, params);
        const response = await this.privateGetUapiOverseasStockV1QuotationsCountriesHoliday(this.extend({
            TRAD_DT: kstYmd(until ?? this.milliseconds()),
            CTX_AREA_NK: '',
            CTX_AREA_FK: '',
            tr_id: 'CTOS5011R',
        }, query));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            countryCode: this.safeString(row, 'tr_natn_cd') || undefined,
            countryName: this.safeString(row, 'tr_natn_name') || undefined,
            marketCode: this.safeString(row, 'tr_mket_cd') || undefined,
            marketName: this.safeString(row, 'tr_mket_name') || undefined,
            localSettlementDate: this.safeString(row, 'acpl_sttl_dt') || undefined,
            domesticSettlementDate: this.safeString(row, 'dmst_sttl_dt') || undefined,
            info: row,
        }));
    }

    /**
     * 해외속보 제목(`brknews-title`, TR `FHKST01011801`). 뉴스 제공업체는 설명의 전체 값(`0`)을 보내고, 화면 코드(`11801`)는 예제값이다.
     * 나머지 입력은 설명 없는 선택 입력이라 비운다. 국내 시황 제목과 같은 필드라 `KisNewsTitle` 모양으로 정리하고, 관련 종목코드는 10칸이다.
     */
    async fetchBreakingNewsTitles(params: Dict = {}): Promise<KisNewsTitle[]> {
        const response = await this.privateGetUapiOverseasPriceV1QuotationsBrknewsTitle(this.extend({
            FID_NEWS_OFER_ENTP_CODE: '0',
            FID_COND_SCR_DIV_CODE: '11801',
            FID_COND_MRKT_CLS_CODE: '',
            FID_INPUT_ISCD: '',
            FID_TITL_CNTT: '',
            FID_INPUT_DATE_1: '',
            FID_INPUT_HOUR_1: '',
            FID_RANK_SORT_CLS_CODE: '',
            FID_INPUT_SRNO: '',
            tr_id: 'FHKST01011801',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            id: this.safeString(row, 'cntt_usiq_srno', ''),
            ...this.kstStamp(this.safeString(row, 'data_dt'), this.safeString(row, 'data_tm')),
            title: this.safeString(row, 'hts_pbnt_titl_cntt') || undefined,
            source: this.safeString(row, 'dorg') || undefined,
            providerCode: this.safeString(row, 'news_ofer_entp_code') || undefined,
            categoryCode: this.safeString(row, 'news_lrdv_code') || undefined,
            codes: Array.from({ length: 10 }, (_, i) => this.safeString(row, `iscd${i + 1}`, '').trim()).filter((c) => c !== ''),
            info: row,
        }));
    }

    /**
     * 해외뉴스 종합 제목(`news-title`, TR `HHPSTH60100C1`). 입력은 모두 설명이 없거나 공백이 전체인 입력이라 비워 보낸다. 행은 `outblock1`이다.
     * 조회일자와 시간의 시간대가 문서에 없어 문자열로 둔다. 연속조회(`CTS`)는 따라가지 않는다.
     */
    async fetchOverseasNewsTitles(params: Dict = {}): Promise<KisOverseasNewsTitle[]> {
        const response = await this.privateGetUapiOverseasPriceV1QuotationsNewsTitle(this.extend({
            INFO_GB: '',
            CLASS_CD: '',
            NATION_CD: '',
            EXCHANGE_CD: '',
            SYMB: '',
            DATA_DT: '',
            DATA_TM: '',
            CTS: '',
            tr_id: 'HHPSTH60100C1',
        }, params));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return rowsOf(this.safeValue(response, 'outblock1')).map((row) => ({
            id: this.safeString(row, 'news_key', ''),
            date: text(row, 'data_dt'),
            time: text(row, 'data_tm'),
            title: text(row, 'title'),
            source: text(row, 'source'),
            newsType: text(row, 'info_gb'),
            categoryCode: text(row, 'class_cd'),
            categoryName: text(row, 'class_name'),
            countryCode: text(row, 'nation_cd'),
            exchangeCode: text(row, 'exchange_cd'),
            code: text(row, 'symb'),
            name: text(row, 'symb_name'),
            info: row,
        }));
    }

    /**
     * 해외주식 조건검색(`inquire-search`, TR `HHDFS76410000`). 거래소(`exchange`)는 전체 값이 없는 필수 입력이다. 조건 입력은 모두 선택이라
     * 기본은 비우고(예제는 가격 160~161을 넣는다), `conditions`로 범위를 준 조건만 켠다. 행은 `output2`이고 심볼에는 거래소의 거래 통화를 붙인다.
     */
    async fetchOverseasScreener(exchange: OverseasMarket, conditions: KisOverseasScreenerConditions = {}, params: Dict = {}): Promise<KisOverseasScreenerItem[]> {
        const code = this.overseasExchange(exchange, 'fetchOverseasScreener');
        const request: Dict = { AUTH: '', EXCD: code, KEYB: '', tr_id: 'HHDFS76410000' };
        for (const [name, key] of Object.entries(KIS_OVERSEAS_SCREENER_KEYS)) {
            const range = conditions[name as keyof KisOverseasScreenerConditions];
            request[`CO_YN_${key}`] = range !== undefined ? '1' : '';
            request[`CO_ST_${key}`] = range !== undefined ? String(range[0]) : '';
            request[`CO_EN_${key}`] = range !== undefined ? String(range[1]) : '';
        }
        const response = await this.privateGetUapiOverseasPriceV1QuotationsInquireSearch(this.extend(request, params));
        return rowsOf(this.safeValue(response, 'output2')).map((row) => ({
            symbol: `${this.safeString(row, 'symb', '')}/${KIS_OVERSEAS_RANKING_EXCHANGES[code]}`,
            name: this.safeString(row, 'name') || undefined,
            rank: this.safeNumber(row, 'rank'),
            price: this.safeNumber(row, 'last'),
            change: this.safeNumber(row, 'diff'),
            percentage: this.safeNumber(row, 'rate'),
            open: this.safeNumber(row, 'popen'),
            high: this.safeNumber(row, 'phigh'),
            low: this.safeNumber(row, 'plow'),
            volume: this.safeNumber(row, 'tvol'),
            amount: this.safeNumber(row, 'avol'),
            marketCap: this.safeNumber(row, 'valx'),
            shares: this.safeNumber(row, 'shar'),
            eps: this.safeNumber(row, 'eps'),
            per: this.safeNumber(row, 'per'),
            info: row,
        }));
    }

    /**
     * 당사 해외주식 담보대출 가능 종목(`colable-by-company`, TR `CTLN4050R`). 해외 종목만 지원한다. 국가코드는 종목의 거래소로 고르고, 설명에 있는
     * 미국(840), 홍콩(344), 중국(156) 밖의 거래소면 `NotSupported`다. 조회순서는 예제의 이름순(`01`)이고, 설명 없는 선택 입력은 비운다. 행은 `output1`이다.
     */
    async fetchOverseasLoanableStocks(symbol: string, params: Dict = {}): Promise<KisOverseasLoanableStock[]> {
        const instrument = this.overseasInstrument(symbol, 'fetchOverseasLoanableStocks');
        const country = KIS_OVERSEAS_NUMERIC_COUNTRY_CODES[instrument.quoteExchange];
        if (country === undefined) throw new NotSupported(`${this.id} fetchOverseasLoanableStocks() 는 미국, 홍콩, 중국 종목만 지원한다: ${symbol}`);
        const response = await this.privateGetUapiOverseasPriceV1QuotationsColableByCompany(this.extend({
            PDNO: instrument.code,
            NATN_CD: country,
            INQR_SQN_DVSN: '01',
            PRDT_TYPE_CD: '',
            INQR_STRT_DT: '',
            INQR_END_DT: '',
            INQR_DVSN: '',
            RT_DVSN_CD: '',
            RT: '',
            LOAN_PSBL_YN: '',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            tr_id: 'CTLN4050R',
        }, params));
        return rowsOf(this.safeValue(response, 'output1')).map((row) => {
            const yn = this.safeString(row, 'loan_exec_psbl_yn');
            return {
                code: this.safeString(row, 'pdno', ''),
                name: this.safeString(row, 'ovrs_item_name') || undefined,
                loanRate: this.safeNumber(row, 'loan_rt'),
                maintenanceRate: this.safeNumber(row, 'mgge_mntn_rt'),
                collateralRate: this.safeNumber(row, 'mgge_ensu_rt'),
                loanAvailable: yn === 'Y' ? true : yn === 'N' ? false : undefined,
                currency: this.safeString(row, 'crcy_cd') || undefined,
                marketName: this.safeString(row, 'tr_mket_name') || undefined,
                info: row,
            };
        });
    }

    /**
     * 해외주식 기간별 권리(`period-rights`, TR `CTRGT011R`). 권리유형은 설명의 전체 값(`%%`)이다. 조회 기준일 구분은 조회 방식이라 예제의
     * 현지기준일(`02`)이 기본이다. 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다. `symbol`을 주면 그 종목만 묻는다.
     */
    async fetchOverseasCorporateActions(
        symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {},
    ): Promise<KisOverseasCorporateAction[]> {
        const [until, query] = this.handleUntilParam('fetchOverseasCorporateActions', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasCorporateActions() 는 since 인자가 필요하다`);
        const code = symbol !== undefined ? this.overseasInstrument(symbol, 'fetchOverseasCorporateActions').code : '';
        const response = await this.privateGetUapiOverseasPriceV1QuotationsPeriodRights(this.extend({
            RGHT_TYPE_CD: '%%',
            INQR_DVSN_CD: '02',
            INQR_STRT_DT: kstYmd(since),
            INQR_END_DT: kstYmd(until ?? this.milliseconds()),
            PDNO: code,
            PRDT_TYPE_CD: '',
            CTX_AREA_NK50: '',
            CTX_AREA_FK50: '',
            tr_id: 'CTRGT011R',
        }, query));
        // 행에 국내 기준일(`bass_dt`)과 현지 기준일(`acpl_bass_dt`)이 따로 있다. 대표 시각은 국내 기준일이다.
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => {
            const yn = this.safeString(row, 'dfnt_yn');
            return {
                ...this.kstStamp(this.safeString(row, 'bass_dt')),
                date: this.safeString(row, 'bass_dt', ''),
                rightTypeCode: this.safeString(row, 'rght_type_cd') || undefined,
                code: this.safeString(row, 'pdno') || undefined,
                name: this.safeString(row, 'prdt_name') || undefined,
                localRecordDate: this.safeString(row, 'acpl_bass_dt') || undefined,
                subscriptionStartDate: this.safeString(row, 'sbsc_strt_dt') || undefined,
                subscriptionEndDate: this.safeString(row, 'sbsc_end_dt') || undefined,
                cashAllocationRate: this.safeNumber(row, 'cash_alct_rt'),
                stockAllocationRate: this.safeNumber(row, 'stck_alct_rt'),
                currency: this.safeString(row, 'crcy_cd') || undefined,
                confirmed: yn === 'Y' ? true : yn === 'N' ? false : undefined,
                info: row,
            };
        }), since, limit);
    }

    /**
     * 해외주식 권리종합(`rights-by-ice`, TR `HHDFS78330900`). 해외 종목만 지원한다. 국가코드(US, HK, CN, JP, VN)는 종목의 거래소로 고른다.
     * 기간은 선택 입력이라 주지 않으면 비운다(설명: 비우면 3개월 전부터 3개월 후까지). 행은 `output1`이다.
     */
    async fetchOverseasRights(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KisOverseasRightsEvent[]> {
        const [until, query] = this.handleUntilParam('fetchOverseasRights', limit, params);
        const instrument = this.overseasInstrument(symbol, 'fetchOverseasRights');
        const response = await this.privateGetUapiOverseasPriceV1QuotationsRightsByIce(this.extend({
            NCOD: KIS_OVERSEAS_COUNTRY_CODES[instrument.quoteExchange],
            SYMB: instrument.code,
            ST_YMD: since !== undefined ? kstYmd(since) : '',
            ED_YMD: until !== undefined ? kstYmd(until) : '',
            tr_id: 'HHDFS78330900',
        }, query));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        // 공시일, 기준일, 지급일 가운데 대표 시각을 명세로 가를 수 없어 `timestamp` 를 두지 않는다. 공시일(`YYYYMMDD`) 순서로 자른다.
        return this.limitRows(rowsOf(this.safeValue(response, 'output1')).map((row) => ({
            title: text(row, 'ca_title'),
            announcedDate: text(row, 'anno_dt'),
            recordDate: text(row, 'record_dt'),
            exDividendDate: text(row, 'div_lock_dt'),
            exRightsDate: text(row, 'lock_dt'),
            paymentDate: text(row, 'pay_dt'),
            effectiveDate: text(row, 'validity_dt'),
            delistDate: text(row, 'delist_dt'),
            info: row,
        })), since, limit, 'announcedDate');
    }

    /** 해외주식 상품기본정보(`search-info`, TR `CTPF1702R`). 해외 종목만 지원한다. 상품유형코드는 설명의 거래소별 코드(나스닥 `512` 등)로 고른다. */
    async fetchOverseasProductInfo(symbol: string, params: Dict = {}): Promise<KisOverseasProductInfo> {
        const instrument = this.overseasInstrument(symbol, 'fetchOverseasProductInfo');
        const response = await this.privateGetUapiOverseasPriceV1QuotationsSearchInfo(this.extend({
            PRDT_TYPE_CD: KIS_OVERSEAS_PRODUCT_TYPES[instrument.quoteExchange],
            PDNO: instrument.code,
            tr_id: 'CTPF1702R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const text = (key: string): string | undefined => this.safeString(output, key) || undefined;
        const delisted = this.safeString(output, 'lstg_abol_item_yn');
        return {
            symbol: instrument.symbol,
            standardCode: text('std_pdno'),
            name: text('prdt_name'),
            englishName: text('prdt_eng_name'),
            countryName: text('natn_name'),
            marketName: text('tr_mket_name'),
            exchangeName: text('ovrs_excg_name'),
            currency: text('tr_crcy_cd'),
            parValue: this.safeNumber(output, 'ovrs_papr'),
            classificationName: text('prdt_clsf_name'),
            buyUnit: this.safeNumber(output, 'buy_unit_qty'),
            sellUnit: this.safeNumber(output, 'sll_unit_qty'),
            listedShares: this.safeNumber(output, 'lstg_stck_num'),
            listedDate: text('lstg_dt'),
            delisted: delisted === 'Y' ? true : delisted === 'N' ? false : undefined,
            info: output,
        };
    }

    /**
     * 투자계좌 자산현황(`inquire-account-balance`, TR `CTRP6548R`). 설명 없는 선택 입력(조회구분1, 기준가이전일자적용여부)은 비운다.
     * 요약(`output2`)의 주요 금액과 자산 구분별 행(`output1`)을 정리한다. 예제에 모의 TR 이 없어 실전 TR 을 그대로 보낸다.
     */
    async fetchAccountAssets(params: Dict = {}): Promise<KisAccountAssets> {
        const response = await this.privateGetUapiDomesticStockV1TradingInquireAccountBalance(this.extend({
            ...this.accountParams(),
            INQR_DVSN_1: '',
            BSPR_BF_DT_APLY_YN: '',
            tr_id: 'CTRP6548R',
        }, params));
        const summary = firstRow(this.safeValue(response, 'output2'));
        const num = (key: string): number | undefined => this.safeNumber(summary, key);
        return {
            totalAssets: num('tot_asst_amt'),
            netAssets: num('nass_tot_amt'),
            purchaseAmount: num('pchs_amt_smtl'),
            evaluationAmount: num('evlu_amt_smtl'),
            unrealizedPnl: num('evlu_pfls_amt_smtl'),
            loanAmount: num('loan_amt_smtl'),
            deposit: num('dncl_amt'),
            totalDeposit: num('tot_dncl_amt'),
            cmaEvaluation: num('cma_evlu_amt'),
            foreignCurrencyEvaluation: num('frcr_evlu_tota'),
            overseasStockEvaluation: num('ovrs_stck_evlu_amt1'),
            receivable: num('thdt_rcvb_amt'),
            categories: rowsOf(this.safeValue(response, 'output1')).map((row) => ({
                purchaseAmount: this.safeNumber(row, 'pchs_amt'),
                evaluationAmount: this.safeNumber(row, 'evlu_amt'),
                unrealizedPnl: this.safeNumber(row, 'evlu_pfls_amt'),
                creditLoanAmount: this.safeNumber(row, 'crdt_lnd_amt'),
                realNetAssets: this.safeNumber(row, 'real_nass_amt'),
                weight: this.safeNumber(row, 'whol_weit_rt'),
                info: row,
            })),
            info: summary,
        };
    }

    /**
     * 주식잔고조회_실현손익(`inquire-balance-rlz-pl`, TR `TTTC8494R`). 조회구분은 설명의 전체(`00`)를 보낸다. 시간외단일가여부, 단가구분,
     * 융자금액자동상환여부는 설명의 기본값(`N`, `01`, `N`)이고, 펀드결제포함, 처리구분, 비용포함은 예제값(`N`, `01` 전일매매미포함, `N`)이다.
     * 연속조회는 따라가지 않는다. 예제에 모의 TR 이 없어 실전 TR 을 그대로 보낸다.
     */
    async fetchRealizedPnlBalance(params: Dict = {}): Promise<KisRealizedPnlBalance> {
        const response = await this.privateGetUapiDomesticStockV1TradingInquireBalanceRlzPl(this.extend({
            ...this.accountParams(),
            AFHR_FLPR_YN: 'N',
            OFL_YN: '',
            INQR_DVSN: '00',
            UNPR_DVSN: '01',
            FUND_STTL_ICLD_YN: 'N',
            FNCG_AMT_AUTO_RDPT_YN: 'N',
            PRCS_DVSN: '01',
            COST_ICLD_YN: 'N',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            tr_id: 'TTTC8494R',
        }, params));
        const summary = firstRow(this.safeValue(response, 'output2'));
        const num = (key: string): number | undefined => this.safeNumber(summary, key);
        return {
            positions: rowsOf(this.safeValue(response, 'output1')).map((row) => ({
                symbol: `${this.safeString(row, 'pdno', '')}/KRW`,
                name: this.safeString(row, 'prdt_name') || undefined,
                quantity: this.safeNumber(row, 'hldg_qty'),
                orderableQuantity: this.safeNumber(row, 'ord_psbl_qty'),
                averagePrice: this.safeNumber(row, 'pchs_avg_pric'),
                purchaseAmount: this.safeNumber(row, 'pchs_amt'),
                price: this.safeNumber(row, 'prpr'),
                evaluationAmount: this.safeNumber(row, 'evlu_amt'),
                unrealizedPnl: this.safeNumber(row, 'evlu_pfls_amt'),
                unrealizedPnlRate: this.safeNumber(row, 'evlu_pfls_rt'),
                info: row,
            })),
            realizedPnl: num('rlzt_pfls'),
            realizedPnlRate: num('rlzt_erng_rt'),
            totalEvaluation: num('tot_evlu_amt'),
            netAssets: num('nass_amt'),
            deposit: num('dnca_tot_amt'),
            purchaseAmount: num('pchs_amt_smtl_amt'),
            evaluationAmount: num('evlu_amt_smtl_amt'),
            unrealizedPnl: num('evlu_pfls_smtl_amt'),
            info: summary,
        };
    }

    /**
     * 신용매수가능조회(`inquire-credit-psamount`, TR `TTTC8909R`). 국내만 지원한다. 신용유형(`creditType`, 21 자기융자신규 등 여덟 가지)은
     * 전체 값이 없는 필수 입력이라 호출하는 쪽이 고른다. 주문구분은 예제의 지정가(`00`), CMA 평가금액과 해외 포함은 예제값(`N`)이다.
     * 주문단가(`price`)는 선택 입력이라 주지 않으면 비운다.
     */
    async fetchCreditBuyableAmount(symbol: string, creditType: string, price: Num = undefined, params: Dict = {}): Promise<KisCreditBuyable> {
        const { code } = this.domesticInstrument(symbol, 'fetchCreditBuyableAmount');
        if (!KIS_CREDIT_TYPES.has(creditType)) {
            throw new ArgumentsRequired(`${this.id} fetchCreditBuyableAmount() 는 creditType(21~28 신용유형 코드) 인자가 필요하다: ${creditType}`);
        }
        const response = await this.privateGetUapiDomesticStockV1TradingInquireCreditPsamount(this.extend({
            ...this.accountParams(),
            PDNO: code,
            ORD_DVSN: '00',
            CRDT_TYPE: creditType,
            CMA_EVLU_AMT_ICLD_YN: 'N',
            OVRS_ICLD_YN: 'N',
            ORD_UNPR: price !== undefined ? String(price) : '',
            tr_id: 'TTTC8909R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        return {
            orderableCash: this.safeNumber(output, 'ord_psbl_cash'),
            orderableSubstitute: this.safeNumber(output, 'ord_psbl_sbst'),
            reusableAmount: this.safeNumber(output, 'ruse_psbl_amt'),
            maxBuyAmount: this.safeNumber(output, 'max_buy_amt'),
            maxBuyQuantity: this.safeNumber(output, 'max_buy_qty'),
            noReceivableBuyAmount: this.safeNumber(output, 'nrcvb_buy_amt'),
            noReceivableBuyQuantity: this.safeNumber(output, 'nrcvb_buy_qty'),
            calculationPrice: this.safeNumber(output, 'psbl_qty_calc_unpr'),
            info: output,
        };
    }

    /**
     * 기간별 손익 일별합산(`inquire-period-profit`, TR `TTTC8708R`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다. 정렬과 조회구분은
     * 예제값(`00`), 잔고구분은 설명의 전체(`00`)다. 일별 행(`output1`)과 합계(`output2`)를 돌려준다. 연속조회는 따라가지 않는다.
     */
    async fetchDailyRealizedPnl(since: Int, limit: Int = undefined, params: Dict = {}): Promise<{ days: KisDailyPnlRecord[]; totalRealizedPnl: number | undefined; totalFee: number | undefined; totalTax: number | undefined; info: Dict }> {
        const [until, query] = this.handleUntilParam('fetchDailyRealizedPnl', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchDailyRealizedPnl() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1TradingInquirePeriodProfit(this.extend({
            ...this.accountParams(),
            INQR_STRT_DT: kstYmd(since),
            INQR_END_DT: kstYmd(until ?? this.milliseconds()),
            SORT_DVSN: '00',
            INQR_DVSN: '00',
            CBLC_DVSN: '00',
            PDNO: '',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            tr_id: 'TTTC8708R',
        }, query));
        const summary = firstRow(this.safeValue(response, 'output2'));
        return {
            days: this.limitRows(rowsOf(this.safeValue(response, 'output1')).map((row) => ({
                ...this.kstStamp(this.safeString(row, 'trad_dt')),
                tradeDate: this.safeString(row, 'trad_dt', ''),
                buyAmount: this.safeNumber(row, 'buy_amt'),
                sellAmount: this.safeNumber(row, 'sll_amt'),
                realizedPnl: this.safeNumber(row, 'rlzt_pfls'),
                pnlRate: this.safeNumber(row, 'pfls_rt'),
                fee: this.safeNumber(row, 'fee'),
                tax: this.safeNumber(row, 'tl_tax'),
                loanInterest: this.safeNumber(row, 'loan_int'),
                info: row,
            })), since, limit),
            totalRealizedPnl: this.safeNumber(summary, 'tot_rlzt_pfls'),
            totalFee: this.safeNumber(summary, 'tot_fee'),
            totalTax: this.safeNumber(summary, 'tot_tltx'),
            info: summary,
        };
    }

    /** 매도가능수량조회(`inquire-psbl-sell`, TR `TTTC8408R`). 국내만 지원한다. 예제에 모의 TR 이 없어 실전 TR 을 그대로 보낸다. */
    async fetchSellableQuantity(symbol: string, params: Dict = {}): Promise<KisSellableQuantity> {
        const instrument = this.domesticInstrument(symbol, 'fetchSellableQuantity');
        const response = await this.privateGetUapiDomesticStockV1TradingInquirePsblSell(this.extend({
            ...this.accountParams(),
            PDNO: instrument.code,
            tr_id: 'TTTC8408R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        return {
            symbol: instrument.symbol,
            orderableQuantity: num('ord_psbl_qty'),
            balanceQuantity: num('cblc_qty'),
            buyQuantity: num('buy_qty'),
            sellQuantity: num('sll_qty'),
            averagePrice: num('pchs_avg_pric'),
            purchaseAmount: num('pchs_amt'),
            price: num('now_pric'),
            evaluationAmount: num('evlu_amt'),
            unrealizedPnl: num('evlu_pfls_amt'),
            unrealizedPnlRate: num('evlu_pfls_rt'),
            info: output,
        };
    }

    /**
     * 주식통합증거금 현황(`intgr-margin`, TR `TTTC0869R`). CMA 평가금액 포함은 예제값(`N`), 원화·외화 구분과 선도환 구분은 조회 기준을 고르는
     * 입력이라 예제값(`01` 외화기준)이 기본이다. 주문가능금액 위주로 옮기고 나머지 100여 필드는 `info`에 원문으로 둔다.
     */
    async fetchIntegratedMargin(params: Dict = {}): Promise<KisIntegratedMargin> {
        const response = await this.privateGetUapiDomesticStockV1TradingIntgrMargin(this.extend({
            ...this.accountParams(),
            CMA_EVLU_AMT_ICLD_YN: 'N',
            WCRC_FRCR_DVSN_CD: '01',
            FWEX_CTRT_FRCR_DVSN_CD: '01',
            tr_id: 'TTTC0869R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        return {
            marginRate: num('acmga_rt'),
            cashOrderable: num('stck_cash_ord_psbl_amt'),
            substituteOrderable: num('stck_sbst_ord_psbl_amt'),
            evaluationOrderable: num('stck_evlu_ord_psbl_amt'),
            receivable: num('rcvb_amt'),
            usdOrderable: num('usd_ord_psbl_amt'),
            hkdOrderable: num('hkd_ord_psbl_amt'),
            jpyOrderable: num('jpy_ord_psbl_amt'),
            cnyOrderable: num('cny_ord_psbl_amt'),
            info: output,
        };
    }

    /**
     * 국내 주식 예약주문 조회(`order-resv-ccnl`, TR `CTSC0004R`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다.
     * 단말매체종류(`00`), 처리구분(`0`), 취소여부(`Y`)는 예제값이고, 설명 없는 선택 입력(순번, 종목, 매도매수구분)은 비운다. 연속조회는 따라가지 않는다.
     */
    async fetchReservedOrders(since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisDomesticReservedOrder[]> {
        const [until, query] = this.handleUntilParam('fetchReservedOrders', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchReservedOrders() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1TradingOrderResvCcnl(this.extend({
            RSVN_ORD_ORD_DT: kstYmd(since),
            RSVN_ORD_END_DT: kstYmd(until ?? this.milliseconds()),
            TMNL_MDIA_KIND_CD: '00',
            ...this.accountParams(),
            PRCS_DVSN_CD: '0',
            CNCL_YN: 'Y',
            RSVN_ORD_SEQ: '',
            PDNO: '',
            SLL_BUY_DVSN_CD: '',
            CTX_AREA_FK200: '',
            CTX_AREA_NK200: '',
            tr_id: 'CTSC0004R',
        }, query));
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => {
            const sideCode = this.safeString(row, 'sll_buy_dvsn_cd');
            return {
                ...this.kstStamp(this.safeString(row, 'rsvn_ord_ord_dt')),
                sequence: this.safeString(row, 'rsvn_ord_seq', ''),
                orderDate: this.safeString(row, 'rsvn_ord_ord_dt') || undefined,
                receivedDate: this.safeString(row, 'rsvn_ord_rcit_dt') || undefined,
                endDate: this.safeString(row, 'rsvn_end_dt') || undefined,
                symbol: `${this.safeString(row, 'pdno', '')}/KRW`,
                name: this.safeString(row, 'kor_item_shtn_name') || undefined,
                side: sideCode === SIDE_CODE_SELL ? 'sell' : sideCode === SIDE_CODE_BUY ? 'buy' : 'unknown',
                orderTypeCode: this.safeString(row, 'ord_dvsn_cd') || undefined,
                orderTypeName: this.safeString(row, 'ord_dvsn_name') || undefined,
                quantity: this.safeNumber(row, 'ord_rsvn_qty'),
                price: this.safeNumber(row, 'ord_rsvn_unpr'),
                filledQuantity: this.safeNumber(row, 'tot_ccld_qty'),
                filledAmount: this.safeNumber(row, 'tot_ccld_amt'),
                orderId: this.safeString(row, 'odno') || undefined,
                result: this.safeString(row, 'prcs_rslt') || undefined,
                info: row,
            };
        }), since, limit);
    }

    /**
     * 기간별 계좌 권리현황(`period-rights`, TR `CTRGA011R`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다. 조회구분은 설명 없이
     * 예제값(`03`)만 있어 그대로 보내고, 설명 없는 선택 입력(실명확인번호, 홈넷ID, 권리유형, 종목, 상품유형)은 비운다. 연속조회는 따라가지 않는다.
     */
    async fetchAccountRights(since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisAccountRight[]> {
        const [until, query] = this.handleUntilParam('fetchAccountRights', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchAccountRights() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1TradingPeriodRights(this.extend({
            INQR_DVSN: '03',
            ...this.accountParams(),
            INQR_STRT_DT: kstYmd(since),
            INQR_END_DT: kstYmd(until ?? this.milliseconds()),
            CUST_RNCNO25: '',
            HMID: '',
            RGHT_TYPE_CD: '',
            PDNO: '',
            PRDT_TYPE_CD: '',
            CTX_AREA_NK100: '',
            CTX_AREA_FK100: '',
            tr_id: 'CTRGA011R',
        }, query));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'bass_dt')),
            date: this.safeString(row, 'bass_dt', ''),
            rightTypeCode: text(row, 'rght_type_cd'),
            code: text(row, 'pdno'),
            shortCode: text(row, 'shtn_pdno'),
            name: text(row, 'prdt_name'),
            balanceQuantity: this.safeNumber(row, 'cblc_qty'),
            allocatedQuantity: this.safeNumber(row, 'tot_alct_qty'),
            allocatedAmount: this.safeNumber(row, 'last_alct_amt'),
            fractionalShareAmount: this.safeNumber(row, 'last_ftsk_chgs'),
            cashPaymentDate: text(row, 'cash_dfrm_dt'),
            listingDate: text(row, 'lstg_dt'),
            subscriptionEndDate: text(row, 'sbsc_end_dt'),
            subscriptionPrice: this.safeNumber(row, 'sbsc_unpr'),
            taxAmount: this.safeNumber(row, 'tax_amt'),
            info: row,
        })), since, limit);
    }

    /**
     * 퇴직연금 잔고조회(`pension/inquire-balance`, TR `TTTC2208R`). 적립금구분코드와 조회구분은 설명 없이 예제값(`00`)만 있어 그대로 보낸다.
     * 계좌상품코드는 `uid`의 뒷자리(예제는 `29`)다. 연속조회는 따라가지 않는다. 예제에 모의 TR 이 없어 실전 TR 을 그대로 보낸다.
     */
    async fetchPensionBalance(params: Dict = {}): Promise<KisPensionBalance> {
        const response = await this.privateGetUapiDomesticStockV1TradingPensionInquireBalance(this.extend({
            ...this.accountParams(),
            ACCA_DVSN_CD: '00',
            INQR_DVSN: '00',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            tr_id: 'TTTC2208R',
        }, params));
        const summary = firstRow(this.safeValue(response, 'output2'));
        const num = (key: string): number | undefined => this.safeNumber(summary, key);
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return {
            positions: rowsOf(this.safeValue(response, 'output1')).map((row) => ({
                symbol: `${this.safeString(row, 'pdno', '')}/KRW`,
                name: text(row, 'prdt_name'),
                balanceTypeName: text(row, 'cblc_dvsn_name'),
                itemTypeName: text(row, 'item_dvsn_name'),
                quantity: this.safeNumber(row, 'hldg_qty'),
                orderableQuantity: this.safeNumber(row, 'ord_psbl_qty'),
                todayBuyQuantity: this.safeNumber(row, 'thdt_buyqty'),
                todaySellQuantity: this.safeNumber(row, 'thdt_sll_qty'),
                averagePrice: this.safeNumber(row, 'pchs_avg_pric'),
                purchaseAmount: this.safeNumber(row, 'pchs_amt'),
                price: this.safeNumber(row, 'prpr'),
                evaluationAmount: this.safeNumber(row, 'evlu_amt'),
                unrealizedPnl: this.safeNumber(row, 'evlu_pfls_amt'),
                unrealizedPnlRate: this.safeNumber(row, 'evlu_erng_rt'),
                info: row,
            })),
            deposit: num('dnca_tot_amt'),
            nextDaySettlement: num('nxdy_excc_amt'),
            provisionalSettlement: num('prvs_rcdl_excc_amt'),
            todayBuyAmount: num('thdt_buy_amt'),
            todaySellAmount: num('thdt_sll_amt'),
            todayCost: num('thdt_tlex_amt'),
            securitiesEvaluation: num('scts_evlu_amt'),
            totalEvaluation: num('tot_evlu_amt'),
            info: summary,
        };
    }

    /**
     * 퇴직연금 미체결내역(`pension/inquire-daily-ccld`, TR `TTTC2201R`). 매도매수구분, 체결미체결구분, 조회구분3은 설명의 전체(`00`, `%%`, `00`)를
     * 보내므로 체결된 주문도 함께 온다. 사용자구분코드는 설명 없이 예제값(`%%`)만 있어 그대로 보낸다. 연속조회는 따라가지 않는다.
     */
    async fetchPensionOrders(params: Dict = {}): Promise<KisPensionOrder[]> {
        const response = await this.privateGetUapiDomesticStockV1TradingPensionInquireDailyCcld(this.extend({
            ...this.accountParams(),
            USER_DVSN_CD: '%%',
            SLL_BUY_DVSN_CD: '00',
            CCLD_NCCS_DVSN: '%%',
            INQR_DVSN_3: '00',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            tr_id: 'TTTC2201R',
        }, params));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return rowsOf(this.safeValue(response, 'output')).map((row) => {
            const sideCode = this.safeString(row, 'sll_buy_dvsn_cd');
            return {
                orderId: this.safeString(row, 'odno', ''),
                originalOrderId: text(row, 'orgn_odno'),
                branchNo: text(row, 'ord_gno_brno'),
                symbol: `${this.safeString(row, 'pdno', '')}/KRW`,
                name: text(row, 'prdt_name'),
                side: sideCode === SIDE_CODE_SELL ? 'sell' : sideCode === SIDE_CODE_BUY ? 'buy' : 'unknown',
                tradeTypeName: text(row, 'trad_dvsn_name'),
                orderTypeCode: text(row, 'ord_dvsn_cd'),
                orderTypeName: text(row, 'ord_dvsn_name'),
                price: this.safeNumber(row, 'ord_unpr'),
                quantity: this.safeNumber(row, 'ord_qty'),
                filledQuantity: this.safeNumber(row, 'tot_ccld_qty'),
                remainingQuantity: this.safeNumber(row, 'nccs_qty'),
                averagePrice: this.safeNumber(row, 'pchs_avg_pric'),
                orderTime: text(row, 'ord_tmd'),
                customerTypeName: text(row, 'objt_cust_dvsn_name'),
                info: row,
            };
        });
    }

    /** 퇴직연금 예수금조회(`pension/inquire-deposit`, TR `TTTC0506R`). 적립금구분코드는 설명 없이 예제값(`00`)만 있어 그대로 보낸다. */
    async fetchPensionDeposit(params: Dict = {}): Promise<KisPensionDeposit> {
        const response = await this.privateGetUapiDomesticStockV1TradingPensionInquireDeposit(this.extend({
            ...this.accountParams(),
            ACCA_DVSN_CD: '00',
            tr_id: 'TTTC0506R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        return {
            deposit: this.safeNumber(output, 'dnca_tota'),
            nextDaySettlement: this.safeNumber(output, 'nxdy_excc_amt'),
            nextDayPayment: this.safeNumber(output, 'nxdy_sttl_amt'),
            secondDayPayment: this.safeNumber(output, 'nx2_day_sttl_amt'),
            info: output,
        };
    }

    /**
     * 퇴직연금 체결기준잔고(`pension/inquire-present-balance`, TR `TTTC2202R`). 사용자구분코드는 설명 없이 예제값(`00`)만 있어 그대로 보낸다.
     * 연속조회는 따라가지 않는다.
     */
    async fetchPensionExecutionBalance(params: Dict = {}): Promise<KisPensionExecutionBalance> {
        const response = await this.privateGetUapiDomesticStockV1TradingPensionInquirePresentBalance(this.extend({
            ...this.accountParams(),
            USER_DVSN_CD: '00',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            tr_id: 'TTTC2202R',
        }, params));
        const summary = firstRow(this.safeValue(response, 'output2'));
        const num = (key: string): number | undefined => this.safeNumber(summary, key);
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return {
            positions: rowsOf(this.safeValue(response, 'output1')).map((row) => ({
                symbol: `${this.safeString(row, 'pdno', '')}/KRW`,
                name: text(row, 'prdt_name'),
                balanceType: text(row, 'cblc_dvsn'),
                balanceTypeName: text(row, 'cblc_dvsn_name'),
                quantity: this.safeNumber(row, 'hldg_qty'),
                sellableQuantity: this.safeNumber(row, 'slpsb_qty'),
                averagePrice: this.safeNumber(row, 'pchs_avg_pric'),
                purchaseAmount: this.safeNumber(row, 'pchs_amt'),
                price: this.safeNumber(row, 'prpr'),
                evaluationAmount: this.safeNumber(row, 'evlu_amt'),
                unrealizedPnl: this.safeNumber(row, 'evlu_pfls_amt'),
                unrealizedPnlRate: this.safeNumber(row, 'evlu_pfls_rt'),
                weight: this.safeNumber(row, 'cblc_weit'),
                info: row,
            })),
            purchaseAmount: num('pchs_amt_smtl_amt'),
            evaluationAmount: num('evlu_amt_smtl_amt'),
            unrealizedPnl: num('evlu_pfls_smtl_amt'),
            tradingPnl: num('trad_pfls_smtl'),
            todayPnl: num('thdt_tot_pfls_amt'),
            returnRate: num('pftrt'),
            info: summary,
        };
    }

    /**
     * 퇴직연금 매수가능조회(`pension/inquire-psbl-order`, TR `TTTC0503R`). 국내만 지원한다. 적립금구분코드(`00`)와 CMA 평가금액 포함(`Y`)은 예제값이다.
     * 주문단가(`price`)를 주면 지정가(`00`)로, 주지 않으면 `fetchBalance`의 매수가능조회처럼 시장가(`01`)와 단가 `0`으로 묻는다.
     */
    async fetchPensionBuyableAmount(symbol: string, price: Num = undefined, params: Dict = {}): Promise<KisPensionBuyable> {
        const { code } = this.domesticInstrument(symbol, 'fetchPensionBuyableAmount');
        const response = await this.privateGetUapiDomesticStockV1TradingPensionInquirePsblOrder(this.extend({
            ...this.accountParams(),
            PDNO: code,
            ACCA_DVSN_CD: '00',
            CMA_EVLU_AMT_ICLD_YN: 'Y',
            ORD_UNPR: price !== undefined ? String(price) : '0',
            ORD_DVSN: price !== undefined ? KIS_ORDER_TYPE.LIMIT : KIS_ORDER_TYPE.MARKET,
            tr_id: 'TTTC0503R',
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        return {
            orderableCash: this.safeNumber(output, 'ord_psbl_cash'),
            reusableAmount: this.safeNumber(output, 'ruse_psbl_amt'),
            maxBuyAmount: this.safeNumber(output, 'max_buy_amt'),
            maxBuyQuantity: this.safeNumber(output, 'max_buy_qty'),
            calculationPrice: this.safeNumber(output, 'psbl_qty_calc_unpr'),
            info: output,
        };
    }

    /**
     * 해외주식 지정가주문번호조회(`algo-ordno`, TR `TTTS6058R`). 거래일자(`params.until`의 한국 날짜)는 필수 입력이라 기본값을 오늘(한국 날짜)로 둔다.
     * 연속조회는 따라가지 않는다. 예제에 모의 TR 이 없어 실전 TR 을 그대로 보낸다.
     */
    async fetchOverseasAlgoOrders(params: Dict = {}): Promise<KisOverseasAlgoOrder[]> {
        const [until, query] = this.handleUntilParam('fetchOverseasAlgoOrders', undefined, params);
        const response = await this.privateGetUapiOverseasStockV1TradingAlgoOrdno(this.extend({
            ...this.accountParams(),
            TRAD_DT: kstYmd(until ?? this.milliseconds()),
            CTX_AREA_FK200: '',
            CTX_AREA_NK200: '',
            tr_id: 'TTTS6058R',
        }, query));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            orderId: this.safeString(row, 'odno', ''),
            branchNo: text(row, 'ord_gno_brno'),
            code: this.safeString(row, 'pdno', ''),
            name: text(row, 'item_name'),
            tradeTypeName: text(row, 'trad_dvsn_name'),
            splitBuyTypeName: text(row, 'splt_buy_attr_name'),
            quantity: this.safeNumber(row, 'ft_ord_qty'),
            price: this.safeNumber(row, 'ft_ord_unpr3'),
            filledQuantity: this.safeNumber(row, 'ft_ccld_qty'),
            info: row,
        }));
    }

    /** 해외증거금 통화별조회(`foreign-margin`, TR `TTTC2101R`). 입력은 계좌뿐이다. 예제에 모의 TR 이 없어 실전 TR 을 그대로 보낸다. */
    async fetchOverseasMarginByCurrency(params: Dict = {}): Promise<KisOverseasCurrencyMargin[]> {
        const response = await this.privateGetUapiOverseasStockV1TradingForeignMargin(this.extend({
            ...this.accountParams(),
            tr_id: 'TTTC2101R',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            countryName: this.safeString(row, 'natn_name') || undefined,
            currency: this.safeString(row, 'crcy_cd') || undefined,
            deposit: this.safeNumber(row, 'frcr_dncl_amt1'),
            unsettledBuyAmount: this.safeNumber(row, 'ustl_buy_amt'),
            unsettledSellAmount: this.safeNumber(row, 'ustl_sll_amt'),
            receivable: this.safeNumber(row, 'frcr_rcvb_amt'),
            margin: this.safeNumber(row, 'frcr_mgn_amt'),
            generalOrderable: this.safeNumber(row, 'frcr_gnrl_ord_psbl_amt'),
            orderable: this.safeNumber(row, 'frcr_ord_psbl_amt1'),
            integratedOrderable: this.safeNumber(row, 'itgr_ord_psbl_amt'),
            exchangeRate: this.safeNumber(row, 'bass_exrt'),
            info: row,
        }));
    }

    /**
     * 해외주식 결제기준잔고(`inquire-paymt-stdr-balance`, TR `CTRP6010R`). 기준일자(`params.until`의 한국 날짜)는 필수 입력이라 기본값을 오늘(한국 날짜)로 둔다.
     * 원화외화구분은 조회 기준을 고르는 입력이라 예제의 원화기준(`01`)이 기본이고, 조회구분은 설명의 전체(`00`)를 보낸다.
     * 종목별 행(`output1`), 통화별 행(`output2`), 합계(`output3`)를 돌려준다. 예제에 모의 TR 이 없어 실전 TR 을 그대로 보낸다.
     */
    async fetchOverseasSettlementBalance(params: Dict = {}): Promise<KisOverseasSettlementBalance> {
        const [until, query] = this.handleUntilParam('fetchOverseasSettlementBalance', undefined, params);
        const response = await this.privateGetUapiOverseasStockV1TradingInquirePaymtStdrBalance(this.extend({
            ...this.accountParams(),
            BASS_DT: kstYmd(until ?? this.milliseconds()),
            WCRC_FRCR_DVSN_CD: '01',
            INQR_DVSN_CD: '00',
            tr_id: 'CTRP6010R',
        }, query));
        const summary = firstRow(this.safeValue(response, 'output3'));
        const num = (key: string): number | undefined => this.safeNumber(summary, key);
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return {
            positions: rowsOf(this.safeValue(response, 'output1')).map((row) => ({
                code: this.safeString(row, 'pdno', ''),
                name: text(row, 'prdt_name'),
                exchangeCode: text(row, 'ovrs_excg_cd'),
                marketName: text(row, 'tr_mket_name'),
                countryName: text(row, 'natn_kor_name'),
                currency: text(row, 'buy_crcy_cd'),
                quantity: this.safeNumber(row, 'cblc_qty13'),
                orderableQuantity: this.safeNumber(row, 'ord_psbl_qty1'),
                averagePrice: this.safeNumber(row, 'avg_unpr3'),
                price: this.safeNumber(row, 'ovrs_now_pric1'),
                purchaseAmount: this.safeNumber(row, 'frcr_pchs_amt'),
                unrealizedPnl: this.safeNumber(row, 'evlu_pfls_amt2'),
                unrealizedPnlRate: this.safeNumber(row, 'evlu_pfls_rt1'),
                exchangeRate: this.safeNumber(row, 'bass_exrt'),
                info: row,
            })),
            currencies: rowsOf(this.safeValue(response, 'output2')).map((row) => ({
                currency: text(row, 'crcy_cd'),
                currencyName: text(row, 'crcy_cd_name'),
                deposit: this.safeNumber(row, 'frcr_dncl_amt_2'),
                evaluationAmount: this.safeNumber(row, 'frcr_evlu_amt2'),
                exchangeRate: this.safeNumber(row, 'frst_bltn_exrt'),
                info: row,
            })),
            purchaseAmount: num('pchs_amt_smtl_amt'),
            unrealizedPnl: num('tot_evlu_pfls_amt'),
            unrealizedPnlRate: num('evlu_erng_rt1'),
            totalDeposit: num('tot_dncl_amt'),
            evaluationAmount: num('wcrc_evlu_amt_smtl'),
            totalAssets: num('tot_asst_amt2'),
            loanAmount: num('tot_loan_amt'),
            info: summary,
        };
    }

    /**
     * 해외주식 기간손익(`inquire-period-profit`, TR `TTTS3039R`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다.
     * 해외거래소코드와 통화코드는 설명의 전체(공란)를 보내고, 원화외화구분은 예제의 외화(`01`)가 기본이다. 연속조회는 따라가지 않는다.
     */
    async fetchOverseasRealizedPnl(since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisOverseasRealizedPnl> {
        const [until, query] = this.handleUntilParam('fetchOverseasRealizedPnl', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasRealizedPnl() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasStockV1TradingInquirePeriodProfit(this.extend({
            ...this.accountParams(),
            OVRS_EXCG_CD: '',
            NATN_CD: '',
            CRCY_CD: '',
            PDNO: '',
            INQR_STRT_DT: kstYmd(since),
            INQR_END_DT: kstYmd(until ?? this.milliseconds()),
            WCRC_FRCR_DVSN_CD: '01',
            CTX_AREA_FK200: '',
            CTX_AREA_NK200: '',
            tr_id: 'TTTS3039R',
        }, query));
        const summary = firstRow(this.safeValue(response, 'output2'));
        const num = (key: string): number | undefined => this.safeNumber(summary, key);
        return {
            trades: this.limitRows(rowsOf(this.safeValue(response, 'output1')).map((row) => ({
                tradeDate: this.safeString(row, 'trad_day', ''),
                code: this.safeString(row, 'ovrs_pdno', ''),
                name: this.safeString(row, 'ovrs_item_name') || undefined,
                exchangeCode: this.safeString(row, 'ovrs_excg_cd') || undefined,
                quantity: this.safeNumber(row, 'slcl_qty'),
                averagePurchasePrice: this.safeNumber(row, 'pchs_avg_pric'),
                purchaseAmount: this.safeNumber(row, 'frcr_pchs_amt1'),
                averageSellPrice: this.safeNumber(row, 'avg_sll_unpr'),
                sellAmount: this.safeNumber(row, 'frcr_sll_amt_smtl1'),
                sellCost: this.safeNumber(row, 'stck_sll_tlex'),
                realizedPnl: this.safeNumber(row, 'ovrs_rlzt_pfls_amt'),
                returnRate: this.safeNumber(row, 'pftrt'),
                exchangeRate: this.safeNumber(row, 'exrt'),
                info: row,
            })), since, limit, 'tradeDate'),
            sellAmount: num('stck_sll_amt_smtl'),
            buyAmount: num('stck_buy_amt_smtl'),
            fee: num('smtl_fee1'),
            settlementAmount: num('excc_dfrm_amt'),
            realizedPnl: num('ovrs_rlzt_pfls_tot_amt'),
            returnRate: num('tot_pftrt'),
            info: summary,
        };
    }

    /**
     * 해외주식 일별거래내역(`inquire-period-trans`, TR `CTOS4001R`). 기간 시작(`since`)은 필수이고 끝은 `params.until`(없으면 오늘)이다.
     * 해외거래소코드는 예제가 `NAS`와 `NASD`를 섞어 쓰고 cluefin 이 "공백: 전체"로 적어서 전체(공란)를 보낸다. 매도매수구분은 설명의 전체(`00`)다.
     * 거래 행(`output1`)과 외화 매수·매도 합계, 수수료 합계(`output2`)를 돌려준다. 연속조회는 따라가지 않는다.
     */
    async fetchOverseasTransactions(since: Int, limit: Int = undefined, params: Dict = {}): Promise<{ transactions: KisOverseasTransaction[]; foreignBuyAmount: number | undefined; foreignSellAmount: number | undefined; domesticFee: number | undefined; overseasFee: number | undefined; info: Dict }> {
        const [until, query] = this.handleUntilParam('fetchOverseasTransactions', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasTransactions() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasStockV1TradingInquirePeriodTrans(this.extend({
            ...this.accountParams(),
            ERLM_STRT_DT: kstYmd(since),
            ERLM_END_DT: kstYmd(until ?? this.milliseconds()),
            OVRS_EXCG_CD: '',
            PDNO: '',
            SLL_BUY_DVSN_CD: '00',
            LOAN_DVSN_CD: '',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            tr_id: 'CTOS4001R',
        }, query));
        const summary = firstRow(this.safeValue(response, 'output2'));
        return {
            transactions: this.limitRows(rowsOf(this.safeValue(response, 'output1')).map((row) => {
                const sideCode = this.safeString(row, 'sll_buy_dvsn_cd');
                return {
                    tradeDate: this.safeString(row, 'trad_dt', ''),
                    settlementDate: this.safeString(row, 'sttl_dt') || undefined,
                    side: sideCode === SIDE_CODE_SELL ? 'sell' : sideCode === SIDE_CODE_BUY ? 'buy' : 'unknown',
                    code: this.safeString(row, 'pdno', ''),
                    name: this.safeString(row, 'ovrs_item_name') || undefined,
                    quantity: this.safeNumber(row, 'ccld_qty'),
                    price: this.safeNumber(row, 'ovrs_stck_ccld_unpr'),
                    foreignAmount: this.safeNumber(row, 'tr_frcr_amt2'),
                    foreignSettlementAmount: this.safeNumber(row, 'frcr_excc_amt_1'),
                    krwSettlementAmount: this.safeNumber(row, 'wcrc_excc_amt'),
                    foreignFee: this.safeNumber(row, 'frcr_fee1'),
                    domesticForeignFee: this.safeNumber(row, 'dmst_frcr_fee1'),
                    currency: this.safeString(row, 'crcy_cd') || undefined,
                    exchangeRate: this.safeNumber(row, 'erlm_exrt'),
                    info: row,
                };
            }), since, limit, 'tradeDate'),
            foreignBuyAmount: this.safeNumber(summary, 'frcr_buy_amt_smtl'),
            foreignSellAmount: this.safeNumber(summary, 'frcr_sll_amt_smtl'),
            domesticFee: this.safeNumber(summary, 'dmst_fee_smtl'),
            overseasFee: this.safeNumber(summary, 'ovrs_fee_smtl'),
            info: summary,
        };
    }

    /**
     * 해외주식 매수가능금액조회(`inquire-psamount`, TR `TTTS3007R`, 모의 `VTTS3007R`). 해외 종목만 지원한다. 해외주문단가(`price`)는
     * 필수 입력이라 반드시 받는다. 해외거래소코드는 종목 마스터의 시세 거래소를 주문 거래소 코드(`NASD` 등)로 바꿔 보낸다.
     */
    async fetchOverseasBuyableAmount(symbol: string, price: Num, params: Dict = {}): Promise<KisOverseasBuyable> {
        const instrument = this.overseasInstrument(symbol, 'fetchOverseasBuyableAmount');
        if (price === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasBuyableAmount() 는 price 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasStockV1TradingInquirePsamount(this.extend({
            ...this.accountParams(),
            OVRS_EXCG_CD: toOrderMarketCode(instrument.quoteExchange),
            OVRS_ORD_UNPR: String(price),
            ITEM_CD: instrument.code,
            tr_id: this.tr('TTTS3007R', 'VTTS3007R'),
        }, params));
        const output = firstRow(this.safeValue(response, 'output'));
        const num = (key: string): number | undefined => this.safeNumber(output, key);
        return {
            currency: this.safeString(output, 'tr_crcy_cd') || undefined,
            exchangeRate: num('exrt'),
            orderableForeignAmount: num('ord_psbl_frcr_amt'),
            overseasOrderableAmount: num('ovrs_ord_psbl_amt'),
            sellReusableAmount: num('sll_ruse_psbl_amt'),
            orderableQuantity: num('ord_psbl_qty'),
            maxOrderableQuantity: num('max_ord_psbl_qty'),
            overseasMaxOrderableQuantity: num('ovrs_max_ord_psbl_qty'),
            afterExchangeOrderableAmount: num('echm_af_ord_psbl_amt'),
            afterExchangeOrderableQuantity: num('echm_af_ord_psbl_qty'),
            info: output,
        };
    }

    /**
     * 해외주식 예약주문조회(`order-resv-list`). 해외거래소(`exchange`, `NAS` 등 시세 거래소 코드)는 전체 값이 없는 필수 입력이라 호출하는 쪽이 고른다.
     * 주문 거래소 코드(`NASD` 등)로 바꿔 보내고, 미국이면 TR `TTTT3039R`, 아시아면 `TTTS3014R`을 쓴다. 기간 시작(`since`)은 필수이고
     * 끝은 `params.until`(없으면 오늘)이다. 조회구분은 설명의 전체(`00`)를 보내고, 설명 없는 선택 입력(상품유형코드)은 비운다. 연속조회는 따라가지 않는다.
     */
    async fetchOverseasReservedOrders(exchange: string, since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisOverseasReservedOrder[]> {
        const [until, query] = this.handleUntilParam('fetchOverseasReservedOrders', limit, params);
        const market = toOrderMarketCode(this.overseasExchange(exchange, 'fetchOverseasReservedOrders') as OverseasMarket);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasReservedOrders() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiOverseasStockV1TradingOrderResvList(this.extend({
            ...this.accountParams(),
            INQR_STRT_DT: kstYmd(since),
            INQR_END_DT: kstYmd(until ?? this.milliseconds()),
            INQR_DVSN_CD: '00',
            OVRS_EXCG_CD: market,
            PRDT_TYPE_CD: '',
            CTX_AREA_FK200: '',
            CTX_AREA_NK200: '',
            tr_id: KIS_US_ORDER_MARKETS.has(market) ? 'TTTT3039R' : 'TTTS3014R',
        }, query));
        const text = (row: Dict, key: string): string | undefined => this.safeString(row, key) || undefined;
        return this.limitRows(rowsOf(this.safeValue(response, 'output')).map((row) => {
            const sideCode = this.safeString(row, 'sll_buy_dvsn_cd');
            const cancelled = this.safeString(row, 'cncl_yn');
            return {
                reservationId: this.safeString(row, 'ovrs_rsvn_odno', ''),
                orderId: text(row, 'odno'),
                branchNo: text(row, 'ord_gno_brno'),
                receivedDate: text(row, 'rsvn_ord_rcit_dt'),
                orderDate: text(row, 'ord_dt'),
                cancelled: cancelled === 'Y' ? true : cancelled === 'N' ? false : undefined,
                side: sideCode === SIDE_CODE_SELL ? 'sell' : sideCode === SIDE_CODE_BUY ? 'buy' : 'unknown',
                statusCode: text(row, 'ovrs_rsvn_ord_stat_cd'),
                statusName: text(row, 'ovrs_rsvn_ord_stat_cd_name'),
                code: this.safeString(row, 'pdno', ''),
                name: text(row, 'prdt_name'),
                productTypeCode: text(row, 'prdt_type_cd'),
                exchangeCode: text(row, 'ovrs_excg_cd'),
                quantity: this.safeNumber(row, 'ft_ord_qty'),
                price: this.safeNumber(row, 'ft_ord_unpr3'),
                filledQuantity: this.safeNumber(row, 'ft_ccld_qty'),
                receivedTime: text(row, 'ord_rcit_tmd'),
                sentTime: text(row, 'ord_fwdg_tmd'),
                rejectReason: text(row, 'nprc_rson_text'),
                info: row,
            };
        }), since, limit, 'receivedDate');
    }

    /**
     * 체결별 매매손익과 청구된 수수료·거래세(`inquire-period-trade-profit`)를 기간으로 조회한다. 국내만 지원한다.
     * 연속조회(`tr_cont`)로 다음 페이지를 이어 받지 않고 첫 페이지만 돌려준다.
     */
    async fetchDomesticSettlements(since: Int, limit: Int = undefined, params: Dict = {}): Promise<KisTradeProfitRecord[]> {
        const [until, query] = this.handleUntilParam('fetchDomesticSettlements', limit, params);
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchDomesticSettlements() 는 since 인자가 필요하다`);
        const response = await this.privateGetUapiDomesticStockV1TradingInquirePeriodTradeProfit(this.extend({
            ...this.accountParams(),
            SORT_DVSN: '02',
            INQR_STRT_DT: kstYmd(since),
            INQR_END_DT: kstYmd(until ?? this.milliseconds()),
            CBLC_DVSN: '00',
            PDNO: '',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            tr_id: 'TTTC8715R',
        }, query));
        return this.limitRows(rowsOf(this.safeValue(response, 'output1')).map((row) => ({
            ...this.kstStamp(this.safeString(row, 'trad_dt')),
            tradeDate: this.safeString(row, 'trad_dt', ''),
            symbol: `${this.safeString(row, 'pdno', '')}/KRW`,
            productName: this.safeString(row, 'prdt_name') || undefined,
            sellAmount: this.safeNumber(row, 'sll_amt'),
            buyAmount: this.safeNumber(row, 'buy_amt'),
            realizedPnl: this.safeNumber(row, 'rlzt_pfls'),
            pnlRate: this.safeNumber(row, 'pfls_rt'),
            fee: this.safeNumber(row, 'fee'),
            tax: this.safeNumber(row, 'tl_tax'),
            info: row,
        })), since, limit);
    }

    /**
     * 종목 순위. 국내 순위, 해외 순위(`OVERSEAS_*`, `params.exchange`로 거래소를 반드시 고른다), ELW 순위(`ELW_*`)를 지원한다. 종류마다 공통 필드(순위, 심볼,
     * 이름, 현재가, 전일대비, 등락률, 누적거래량)로 정리하고, 종류별 지표(이격도, 잔량, 괴리율 등)는 `info`에 원문으로 둔다.
     * 응답에 순위 필드가 없는 종류는 `rank`를 비운다.
     *
     * 등락률과 거래량 밖의 종류는 `KIS_RANKING_SPECS` 표가 경로, TR, 기본 입력을 정한다. 정렬 같은 조회 방식은 `params`로 바꾼다.
     * KIS 는 순위에도 연속조회(`tr_cont`)를 쓰지만 다른 KIS 조회처럼 첫 페이지만 돌려준다.
     */
    async fetchRankings(type: KisRankingType, params: Dict = {}): Promise<KisRankingItem[]> {
        switch (type) {
            case 'FLUCTUATION': return this.fetchFluctuationRanking(params);
            case 'VOLUME': return this.fetchVolumeRanking(params);
            default: {
                const spec = (KIS_RANKING_SPECS as Record<string, KisRankingSpec | undefined>)[type];
                if (spec === undefined) throw new NotSupported(`${this.id} fetchRankings() 는 ${String(type)} 랭킹을 지원하지 않는다`);
                return this.fetchSpecRanking(spec, params);
            }
        }
    }

    /** 표(`KIS_RANKING_SPECS`)로 정의한 순위 하나를 부른다. */
    private async fetchSpecRanking(spec: KisRankingSpec, params: Dict): Promise<KisRankingItem[]> {
        const prepared = spec.prepare ? spec.prepare(params) : params;
        const call = this[kisImplicitGet(spec.path)] as (request: Dict) => Promise<unknown>;
        const response = await call.call(this, this.extend({ ...spec.params(this.milliseconds()), tr_id: spec.trId }, prepared));
        const f = spec.fields ?? {};
        return rowsOf(this.safeValue(response, spec.rowsKey ?? 'output')).map((row) => ({
            rank: this.safeNumber(row, f.rank ?? 'data_rank'),
            // 해외 슬래시 티커(`BRK/B`)는 다른 메서드처럼 점 심볼(`BRK.B/USD`)로 옮긴다.
            symbol: spec.overseas
                ? `${this.safeString(row, spec.symbolKey, '').replace('/', '.')}/${KIS_OVERSEAS_RANKING_EXCHANGES[prepared.EXCD as string]}`
                : `${this.safeString(row, spec.symbolKey, '')}/KRW`,
            name: this.safeString(row, f.name ?? 'hts_kor_isnm') || undefined,
            last: this.safeNumber(row, f.price ?? 'stck_prpr'),
            change: this.safeNumber(row, f.change ?? 'prdy_vrss'),
            percentage: this.safeNumber(row, f.rate ?? 'prdy_ctrt'),
            volume: this.safeNumber(row, f.volume ?? 'acml_vol'),
            info: row,
        }));
    }

    /**
     * 등락률 순위(`ranking/fluctuation`). 정렬 방향(상승률순/하락률순)을 가르는 `fid_rank_sort_cls_code` 값은 공식 문서에
     * 뚜렷하게 나와 있지 않아 예제가 실제로 쓴 값(`'0'`)만 기본으로 쓴다. 다른 정렬이 필요하면 `params`로 덮어써야 한다.
     */
    private async fetchFluctuationRanking(params: Dict): Promise<KisRankingItem[]> {
        const response = await this.privateGetUapiDomesticStockV1RankingFluctuation(this.extend({
            fid_rsfl_rate2: '',
            fid_cond_mrkt_div_code: 'J',
            fid_cond_scr_div_code: '20170',
            fid_input_iscd: '0000',
            fid_rank_sort_cls_code: '0',
            fid_input_cnt_1: '0',
            fid_prc_cls_code: '0',
            fid_input_price_1: '',
            fid_input_price_2: '',
            fid_vol_cnt: '',
            fid_trgt_cls_code: '0',
            fid_trgt_exls_cls_code: '0',
            fid_div_cls_code: '0',
            fid_rsfl_rate1: '',
            tr_id: 'FHPST01700000',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            rank: this.safeNumber(row, 'data_rank'),
            symbol: `${this.safeString(row, 'stck_shrn_iscd', '')}/KRW`,
            name: this.safeString(row, 'hts_kor_isnm') || undefined,
            last: this.safeNumber(row, 'stck_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            info: row,
        }));
    }

    /** 거래량 순위(`quotations/volume-rank`). */
    private async fetchVolumeRanking(params: Dict): Promise<KisRankingItem[]> {
        const response = await this.privateGetUapiDomesticStockV1QuotationsVolumeRank(this.extend({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_COND_SCR_DIV_CODE: '20171',
            FID_INPUT_ISCD: '0000',
            FID_DIV_CLS_CODE: '0',
            FID_BLNG_CLS_CODE: '0',
            FID_TRGT_CLS_CODE: '111111111',
            FID_TRGT_EXLS_CLS_CODE: '0000000000',
            FID_INPUT_PRICE_1: '0',
            FID_INPUT_PRICE_2: '0',
            FID_VOL_CNT: '0',
            FID_INPUT_DATE_1: '0',
            tr_id: 'FHPST01710000',
        }, params));
        return rowsOf(this.safeValue(response, 'output')).map((row) => ({
            rank: this.safeNumber(row, 'data_rank'),
            symbol: `${this.safeString(row, 'mksc_shrn_iscd', '')}/KRW`,
            name: this.safeString(row, 'hts_kor_isnm') || undefined,
            last: this.safeNumber(row, 'stck_prpr'),
            change: this.safeNumber(row, 'prdy_vrss'),
            percentage: this.safeNumber(row, 'prdy_ctrt'),
            volume: this.safeNumber(row, 'acml_vol'),
            info: row,
        }));
    }

    /**
     * 확장세션(NXT) 주문 전에 이 종목이 NXT 에서 거래되는지 종목정보(`search-stock-info`)로 확인한다. NXT 거래 대상이 아니거나 NXT 에서
     * 거래정지인 종목은 KIS 가 주문을 거절하므로 요청을 보내지 않고 `MarketClosed` 를 던진다. 이때 KRX 정규장도 닫혀 있어 이 종목은 지금 거래할 수 없다.
     * 조회에 실패하거나 응답에 두 필드가 모두 없으면 막지 않는다(주문 응답이 최종 판단이다). 종목정보 조회는 모의투자를 지원하지 않아 모의에서는 확인하지 않는다.
     * 결과는 종목별로 캐시한다. 조회에 실패한 경우는 캐시하지 않는다.
     */
    private async assertNxtTradable(instrument: KisInstrument): Promise<void> {
        if (this.isSandboxModeEnabled) return;
        const now = this.milliseconds();
        let entry = this.nxtEligibility.get(instrument.code);
        if (entry === undefined || now - entry.at >= NXT_ELIGIBILITY_TTL_MS) {
            let output: Dict;
            try {
                const response = await this.privateGetUapiDomesticStockV1QuotationsSearchStockInfo({
                    PRDT_TYPE_CD: STOCK_INFO_PRODUCT_TYPE,
                    PDNO: instrument.code,
                    tr_id: 'CTPF1002R',
                });
                output = this.safeDict(response, 'output', {}) as Dict;
            } catch (err) {
                logger.warn({ err, symbol: instrument.symbol }, '[kis] NXT 거래 가능 여부를 확인하지 못했다. 주문은 그대로 보낸다');
                return;
            }
            const eligible = this.safeString(output, 'cptt_trad_tr_psbl_yn');
            const stopped = this.safeString(output, 'nxt_tr_stop_yn');
            if (eligible === undefined && stopped === undefined) {
                logger.warn({ symbol: instrument.symbol }, '[kis] 종목정보에 NXT 거래 여부 필드가 없다. 주문은 그대로 보낸다');
                return;
            }
            let blockedReason: string | undefined;
            if (eligible === 'N') blockedReason = 'NXT 거래 대상 종목이 아니다';
            else if (stopped === 'Y') blockedReason = 'NXT 거래정지 종목이다';
            entry = { blockedReason, at: now };
            this.nxtEligibility.set(instrument.code, entry);
        }
        if (entry.blockedReason !== undefined) {
            throw new MarketClosed(`NXT 확장시간 주문 불가: ${entry.blockedReason} (${instrument.symbol})`);
        }
    }

    /**
     * NXT 확장세션 게이트. 프리마켓, 메인마켓, 애프터마켓에만 낸다. 휴장일과 새벽, NXT 가 멈추는 시간(08:50~09:00, KRX 종가 동시호가 15:20~15:30)은 막는다.
     * 휴장일은 KIS 캘린더로 알아야 하므로 먼저 받는다.
     */
    private async assertNxtSessionOpen(): Promise<void> {
        await this.refreshMarketCalendar();
        const phase = getNxtSession();
        if (phase !== 'pre-market' && phase !== 'main' && phase !== 'after-market') {
            throw new MarketClosed(`NXT 거래시간 외 (session=${phase})`);
        }
    }

    /**
     * 국내 정정 게이트. KRX 정규장과 NXT 확장세션이 모두 닫혀 있으면 막는다. 정정은 신규 진입이 아니라서 동시호가의 매수 제한은 걸지 않는다.
     * 원주문이 어느 시장에 걸려 있는지는 정정 요청에 없으므로 둘 중 하나라도 열려 있으면 보낸다.
     */
    private async assertDomesticEditOpen(): Promise<void> {
        await this.refreshMarketCalendar();
        const { tradable, reason } = checkKRXTradingHours();
        if (tradable) return;
        const phase = getNxtSession();
        if (phase === 'pre-market' || phase === 'main' || phase === 'after-market') return;
        throw new MarketClosed(`거래시간 외: ${reason} (NXT session=${phase})`);
    }

    /** 미국 정정 게이트. 주문과 같이 완전 마감(`closed`)만 막는다. 홍콩·일본·베트남은 대상이 아니다. */
    private assertUsEditOpen(exchange: string): void {
        if (US_ORDER_EXCHANGES.has(exchange) && getUsMarketPhase() === 'closed') {
            throw new MarketClosed(`미국장 정규장 외 (${formatEtWallClock()}, phase=closed)`);
        }
    }

    /** 국내 정규장 게이트. 휴장일은 KIS 캘린더로 알아야 하므로 먼저 받는다. 종가 동시호가(15:20~15:30)의 신규 매수는 막는다. */
    private async assertDomesticSessionOpen(side: OrderSide): Promise<void> {
        await this.refreshMarketCalendar();
        const { tradable, reason } = checkKRXTradingHours();
        if (!tradable) throw new MarketClosed(`거래시간 외: ${reason}`);
        // 동시호가는 호가 처리 방식이 달라 시장가 체결가가 예상과 크게 다를 수 있다. 청산(매도)은 진입보다 우선이라 막지 않는다.
        if (getKrxMarketPhase() === 'closing-auction' && side === 'buy') {
            throw new MarketClosed('종가 동시호가 (15:20-15:30) — 신규 매수 진입 금지');
        }
    }

    /**
     * 확장세션 시장가를 지정가로 바꾸는 가격. 확장세션은 지정가만 받는다. 같은 방향 미체결이 있거나 기준가를 못 구하면 던진다.
     * 지정가를 지어내거나 호가를 중복해 쌓지 않기 위해서다.
     */
    private async extendedSessionLimitPrice(symbol: string, side: OrderSide): Promise<number> {
        const conversion = await buildExtendedSessionLimit(
            this,
            { symbol, side },
            '[kis]',
            (err, message) => logger.warn({ err, symbol }, message),
        );
        if (conversion.error !== undefined || conversion.price === undefined) {
            throw new InvalidOrder(conversion.error ?? 'NXT 확장시간: 지정가 산출 실패');
        }
        logger.info({ symbol, side, price: conversion.price }, '[kis] NXT 확장시간 — 시장가를 지정가로 전환');
        return conversion.price;
    }

    private async createOverseasOrder(instrument: KisInstrument, type: OrderType, side: OrderSide, quantity: number, price: number, params: Dict): Promise<Order> {
        const exchange = instrument.orderExchange;
        if (exchange === undefined) throw new BadSymbol(`해외 마스터에 없는 ticker: ${instrument.symbol}`);
        const slot = OVERSEAS_ORDER_TR[exchange];
        if (slot === undefined) throw new NotSupported(`미지원 거래소: ${exchange}`);
        // 미국장 세션 게이트. 완전 마감(`closed`)은 양방향 모두 막는다(닫힌 시장에 낸 매도도 체결될 수 없다). 종가 동시호가의 신규 매수도 막는다.
        // 홍콩·일본·베트남 같은 다른 해외 시장은 이 게이트의 대상이 아니다.
        if (US_ORDER_EXCHANGES.has(exchange)) {
            const phase = getUsMarketPhase();
            if (phase === 'closed') throw new MarketClosed(`미국장 정규장 외 (${formatEtWallClock()}, phase=closed)`);
            if (phase === 'closing-auction' && side === 'buy') {
                throw new MarketClosed(`종가 동시호가 (15:50-16:00 ET, ${formatEtWallClock()}) — 신규 매수 진입 금지`);
            }
        }
        // 모의투자는 지정가만 받는다. 실전은 시장가 의도를 장마감지정가(LOC)로 낸다.
        const ordDvsn = type === 'market' && !this.isSandboxModeEnabled ? KIS_OVERSEAS_ORD_DVSN.LOC : KIS_OVERSEAS_ORD_DVSN.LIMIT;
        const buy = side === 'buy';
        const request: Dict = {
            ...this.accountParams(),
            OVRS_EXCG_CD: exchange,
            PDNO: instrument.code,
            ORD_QTY: String(quantity),
            OVRS_ORD_UNPR: String(price),
            CTAC_TLNO: '',
            MGCO_APTM_ODNO: '',
            SLL_TYPE: buy ? '' : '00',
            ORD_SVR_DVSN_CD: '0',
            ORD_DVSN: ordDvsn,
            tr_id: this.tr('T' + (buy ? slot.buy : slot.sell)),
        };
        const response = await this.privatePostUapiOverseasStockV1TradingOrder(this.extend(request, params));
        return this.acceptedOrder(response, this.marketOf(instrument), ordDvsn === KIS_OVERSEAS_ORD_DVSN.LIMIT ? 'limit' : 'market', side, quantity, price);
    }

    /** 주문 접수 응답을 주문으로 옮긴다. 접수 응답에는 체결 정보가 없으므로 요청값을 싣되 `filled` 는 비워 둔다. */
    private acceptedOrder(response: Dict, market: MarketInterface, type: string, side: OrderSide, amount: number, price: Num): Order {
        const output = this.safeDict(response, 'output', {}) as Dict;
        if (this.safeString(output, 'ODNO') === undefined) {
            logger.warn({ response }, '[kis] 주문은 접수됐으나 응답에 주문번호(ODNO)가 없다');
        }
        const parsed = this.parseOrder(output, market);
        return this.safeOrder(this.extend(parsed, {
            symbol: market.symbol,
            type,
            side,
            price,
            amount,
            status: 'open',
            info: response,
        }), market);
    }

    /**
     * 주문 취소. 국내는 남은 수량 전체를 취소한다. 미국 주문은 취소 수량이 필요하므로 미체결 조회에서 찾고, 모의투자처럼 조회할 수 없으면
     * `params.amount` 로 넘긴다. 이미 체결되거나 취소된 주문은 KIS 가 오류로 거절한다.
     */
    override async cancelOrder(id: string, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        const instrument = symbol === undefined ? undefined : this.instrumentOf(symbol);
        if (instrument?.overseas) return this.cancelOverseasOrder(id, instrument, params);
        const response = await this.privatePostUapiDomesticStockV1TradingOrderRvsecncl(this.extend({
            ...this.accountParams(),
            KRX_FWDG_ORD_ORGNO: this.safeString(params, 'orderOrgNo', ''),
            ORGN_ODNO: id,
            ORD_DVSN: KIS_ORDER_TYPE.LIMIT,
            RVSE_CNCL_DVSN_CD: '02', // 취소
            ORD_QTY: '0', // 전량
            ORD_UNPR: '0',
            QTY_ALL_ORD_YN: 'Y',
            tr_id: this.tr('TTTC0803U'),
        }, this.omit(params, 'orderOrgNo')));
        logger.info({ orderId: id, symbol }, '[kis] 주문 취소 성공');
        return this.safeOrder({ id, symbol: instrument?.symbol, status: 'canceled', info: response }, instrument === undefined ? undefined : this.marketOf(instrument));
    }

    private async cancelOverseasOrder(id: string, instrument: KisInstrument, params: Dict): Promise<Order> {
        const exchange = instrument.orderExchange;
        if (exchange === undefined) throw new BadSymbol(`해외 마스터에 없는 ticker: ${instrument.symbol}`);
        let remaining = this.safeString(params, 'amount');
        if (remaining === undefined) {
            if (this.isSandboxModeEnabled) throw new ArgumentsRequired(`${this.id} 모의투자의 해외 주문 취소에는 params.amount(취소 수량)가 필요하다`);
            const open = (await this.fetchOpenOrders(instrument.symbol)).find((order) => order.id === id);
            if (open === undefined) throw new OrderNotFound(`${this.id} 미체결 해외 주문을 찾지 못했다: ${id}`);
            remaining = numberToString(open.remaining ?? open.amount ?? 0);
        }
        const response = await this.privatePostUapiOverseasStockV1TradingOrderRvsecncl(this.extend({
            ...this.accountParams(),
            OVRS_EXCG_CD: exchange,
            PDNO: instrument.code,
            ORGN_ODNO: id,
            RVSE_CNCL_DVSN_CD: '02', // 취소
            ORD_QTY: remaining,
            OVRS_ORD_UNPR: '0',
            MGCO_APTM_ODNO: '',
            ORD_SVR_DVSN_CD: '0',
            tr_id: this.tr('TTTT1004U'),
        }, this.omit(params, 'amount')));
        logger.info({ orderId: id, symbol: instrument.symbol }, '[kis] 해외 주문 취소 성공');
        return this.safeOrder({ id, symbol: instrument.symbol, status: 'canceled', info: response }, this.marketOf(instrument));
    }

    /**
     * 정정. 취소와 같은 엔드포인트(`order-rvsecncl`)를 `RVSE_CNCL_DVSN_CD`로 나눈다(공식 예제: `01`=정정, `02`=취소).
     * `price`가 필수다(정정은 단가를 바꾸는 주문이라 빼면 KB증권과 같은 이유로 위험하다). `amount`를 주면 그 수량으로
     * 일부정정(`QTY_ALL_ORD_YN: 'N'`)하고, 안 주면 국내는 전량(`'Y'`)을 그대로 정정한다. 공식 예제는 정정 가능 수량이
     * 원주문 수량을 넘지 못한다고 적었다. 국내는 KRX 정규장과 NXT 확장세션이 모두 닫혀 있으면, 미국은 완전 마감이면 `MarketClosed` 다.
     */
    override async editOrder(
        id: string, symbol: string, _type: OrderType, _side: OrderSide, amount: Num = undefined, price: Num = undefined, params: Dict = {},
    ): Promise<Order> {
        if (price === undefined || price === null) {
            throw new ArgumentsRequired(`${this.id} editOrder() requires a price argument`);
        }
        const instrument = this.instrumentOf(symbol);
        if (instrument.overseas) return this.editOverseasOrder(id, instrument, price, amount, params);
        await this.assertDomesticEditOpen();
        const response = await this.privatePostUapiDomesticStockV1TradingOrderRvsecncl(this.extend({
            ...this.accountParams(),
            KRX_FWDG_ORD_ORGNO: this.safeString(params, 'orderOrgNo', ''),
            ORGN_ODNO: id,
            ORD_DVSN: KIS_ORDER_TYPE.LIMIT,
            RVSE_CNCL_DVSN_CD: '01', // 정정
            ORD_QTY: amount === undefined ? '0' : String(amount),
            ORD_UNPR: String(price),
            QTY_ALL_ORD_YN: amount === undefined ? 'Y' : 'N',
            tr_id: this.tr('TTTC0803U'),
        }, this.omit(params, 'orderOrgNo')));
        const newId = this.safeString(this.safeDict(response, 'output', {}) as Dict, 'ODNO', id);
        logger.info({ orderId: id, newOrderId: newId, symbol, price, amount }, '[kis] 주문 정정 성공');
        return this.safeOrder({
            id: newId, symbol: instrument.symbol, type: 'limit', price, amount, status: 'open', info: response,
        }, this.marketOf(instrument));
    }

    /**
     * 해외 정정. `amount`나 `params.amount`가 없으면 미체결 조회에서 잔량을 찾는다(취소와 같은 정책). 모의투자는 미체결 조회가
     * 없어 반드시 넘겨야 한다. 공식 예제는 정정 요청에 실제 수량과 실제 단가를 그대로 싣는다(취소처럼 `'0'`을 넣지 않는다).
     */
    private async editOverseasOrder(id: string, instrument: KisInstrument, price: number, amount: Num, params: Dict): Promise<Order> {
        const exchange = instrument.orderExchange;
        if (exchange === undefined) throw new BadSymbol(`해외 마스터에 없는 ticker: ${instrument.symbol}`);
        let quantity = this.safeString(params, 'amount') ?? (amount === undefined ? undefined : numberToString(amount));
        if (quantity === undefined && this.isSandboxModeEnabled) {
            throw new ArgumentsRequired(`${this.id} 모의투자의 해외 주문 정정에는 amount나 params.amount(정정 수량)가 필요하다`);
        }
        this.assertUsEditOpen(exchange);
        if (quantity === undefined) {
            const open = (await this.fetchOpenOrders(instrument.symbol)).find((order) => order.id === id);
            if (open === undefined) throw new OrderNotFound(`${this.id} 미체결 해외 주문을 찾지 못했다: ${id}`);
            quantity = numberToString(open.remaining ?? open.amount ?? 0);
        }
        const response = await this.privatePostUapiOverseasStockV1TradingOrderRvsecncl(this.extend({
            ...this.accountParams(),
            OVRS_EXCG_CD: exchange,
            PDNO: instrument.code,
            ORGN_ODNO: id,
            RVSE_CNCL_DVSN_CD: '01', // 정정
            ORD_QTY: quantity,
            OVRS_ORD_UNPR: String(price),
            MGCO_APTM_ODNO: '',
            ORD_SVR_DVSN_CD: '0',
            tr_id: this.tr('TTTT1004U'),
        }, this.omit(params, 'amount')));
        const newId = this.safeString(this.safeDict(response, 'output', {}) as Dict, 'ODNO', id);
        logger.info({ orderId: id, newOrderId: newId, symbol: instrument.symbol, price, quantity }, '[kis] 해외 주문 정정 성공');
        return this.safeOrder({
            id: newId, symbol: instrument.symbol, type: 'limit', price, amount: Number(quantity), status: 'open', info: response,
        }, this.marketOf(instrument));
    }

    /**
     * 미체결 주문을 모두 취소한다. 종목을 주면 그 종목만이다. 하나라도 취소하지 못하면 나머지를 다 시도한 뒤 첫 실패를 던진다.
     * 살아 있을 수 있는 주문을 성공으로 돌려주지 않기 위해서다. 국내 취소에는 공식 예제처럼 미체결 행의 주문채번지점번호(`ord_gno_brno`)를
     * 원주문 조직번호로 싣는다.
     */
    override async cancelAllOrders(symbol: Str = undefined, params: Dict = {}): Promise<Order[]> {
        const open = await this.fetchOpenOrders(symbol, undefined, undefined, params);
        const results = await Promise.allSettled(open.map((order) => this.cancelOrder(order.id as string, order.symbol, this.cancelParamsOf(order))));
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed !== undefined) throw failed.reason;
        return results.map((r) => (r as PromiseFulfilledResult<Order>).value);
    }

    /** `cancelAllOrders` 가 미체결 주문 하나를 취소할 때의 `params`. 해외 취소 요청에는 조직번호가 없어 아무것도 싣지 않는다. */
    private cancelParamsOf(order: Order): Dict {
        const orgNo = this.safeString(order.info, 'ord_gno_brno');
        const overseas = order.symbol !== undefined && this.instrumentOf(order.symbol).overseas;
        return orgNo === undefined || overseas ? {} : { orderOrgNo: orgNo };
    }

    // ============ 주문·체결 조회 ============

    /**
     * 미체결 주문. 국내는 정정취소가능 주문 조회(`inquire-psbl-rvsecncl`), 미국은 미체결 내역(`inquire-nccs`)이다. 종목을 주면 그 종목만 조회하고,
     * 주지 않으면 국내와 미국을 모두 본다(`params.market` 이 `'domestic'` 이면 국내만). 모의투자는 미국 미체결 조회가 없어 국내만 본다.
     */
    override async fetchOpenOrders(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        const instrument = symbol === undefined ? undefined : this.instrumentOf(symbol);
        const which = this.safeString(params, 'market', 'all');
        const wantDomestic = instrument === undefined ? which !== 'overseas' : !instrument.overseas;
        // 모의투자에는 미국 미체결 조회(TR)가 없다.
        const wantOverseas = instrument === undefined ? which !== 'domestic' && !this.isSandboxModeEnabled : instrument.overseas;
        const orders: Order[] = [];
        if (wantDomestic) {
            const pages = await this.fetchAllPages(this.privateGetUapiDomesticStockV1TradingInquirePsblRvsecncl, {
                ...this.accountParams(),
                CTX_AREA_FK100: '',
                CTX_AREA_NK100: '',
                INQR_DVSN_1: '0',
                INQR_DVSN_2: '0',
                // 실전만 신형 TR 이 있다. 모의는 종전 TR 을 그대로 쓴다.
                tr_id: this.tr('TTTC0084R', 'VTTC8036R'),
            }, ['CTX_AREA_FK100', 'CTX_AREA_NK100']);
            const market = instrument === undefined ? undefined : this.marketOf(instrument);
            orders.push(...this.parseOrders(pages.flatMap((page) => rowsOf(page.output)), market).map((order) => this.markOpen(order)));
        }
        if (wantOverseas) {
            const pages = await this.fetchAllPages(this.privateGetUapiOverseasStockV1TradingInquireNccs, {
                ...this.accountParams(),
                OVRS_EXCG_CD: 'NASD',
                SORT_SQN: 'DS',
                CTX_AREA_FK200: '',
                CTX_AREA_NK200: '',
                tr_id: this.tr('TTTS3018R', null),
            }, ['CTX_AREA_FK200', 'CTX_AREA_NK200']);
            orders.push(...this.parseOrders(pages.flatMap((page) => rowsOf(page.output))).map((order) => this.markOpen(order)));
        }
        const filtered = instrument === undefined ? orders : orders.filter((order) => order.symbol === instrument.symbol);
        return this.filterBySinceLimit(filtered, since, limit) as Order[];
    }

    /** 미체결 조회의 행은 모두 살아 있는 주문이다. 응답에 취소 여부가 없어 `parseOrder` 가 상태를 정하지 못하면 `open` 으로 둔다. */
    private markOpen(order: Order): Order {
        return order.status === undefined ? { ...order, status: 'open' } : order;
    }

    /**
     * 당일(또는 `since` 일부터)의 주문 전체(체결·미체결·취소). 국내는 일별주문체결조회(`inquire-daily-ccld`), 미국은 주문체결내역(`inquire-ccnl`)이다.
     * 종목을 주면 그 시장만, 주지 않으면 국내와 미국 모두 조회한다(`params.market` 으로 좁힌다).
     */
    override async fetchOrders(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        const instrument = symbol === undefined ? undefined : this.instrumentOf(symbol);
        const which = this.safeString(params, 'market', 'all');
        const orders: Order[] = [];
        if (instrument === undefined ? which !== 'overseas' : !instrument.overseas) {
            orders.push(...this.parseOrders(await this.fetchDomesticCcldRows(instrument?.code, since, '00', this.safeString(params, 'orderId'))));
        }
        if (instrument === undefined ? which !== 'domestic' : instrument.overseas) {
            orders.push(...this.parseOrders(await this.fetchOverseasCcldRows(since, '00')));
        }
        const filtered = instrument === undefined ? orders : orders.filter((order) => order.symbol === instrument.symbol);
        return this.filterBySinceLimit(filtered, since, limit) as Order[];
    }

    /** 주문 하나. 오늘(또는 `params.since` 일부터)의 주문 목록에서 찾고 없으면 `OrderNotFound`. 국내는 주문번호로 좁혀 조회한다. */
    override async fetchOrder(id: string, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        const orders = await this.fetchOrders(symbol, this.safeInteger(params, 'since'), undefined, this.extend(params, { orderId: id }));
        const order = orders.find((candidate) => candidate.id === id);
        if (order === undefined) throw new OrderNotFound(`${this.id} 주문을 찾지 못했다: ${id}`);
        return order;
    }

    /**
     * 내 체결 내역. 종목을 주면 그 시장만, 주지 않으면 국내와 미국 모두 조회한다(`params.market` 으로 좁힌다). 체결별 수수료는 응답에 없어 비어 있다.
     *
     * 일별주문체결 조회라 주문 하나가 거래 하나다. 수량과 가격은 그 주문의 누적 체결 수량과 평균가이고, 시각은 주문 시각이다(응답에 체결 시각이 없다).
     * 체결이 늘면 같은 id 의 거래가 더 큰 수량으로 다시 나오므로 거래를 쌓는 쪽은 id 로 덮어써야 한다. `since` 는 조회 시작일로만 쓰고 시각으로 거르지
     * 않는다. 주문 시각으로 거르면 `since` 앞에 낸 주문이 그 뒤에 체결된 것이 빠진다. 일자는 국내가 KST, 미국이 현지(ET) 기준이다. `since` 가 없으면 오늘이다.
     */
    override async fetchMyTrades(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        const instrument = symbol === undefined ? undefined : this.instrumentOf(symbol);
        const which = this.safeString(params, 'market', 'all');
        const trades: Trade[] = [];
        if (instrument === undefined ? which !== 'overseas' : !instrument.overseas) {
            trades.push(...this.parseTrades(await this.fetchDomesticCcldRows(instrument?.code, since, '01')));
        }
        if (instrument === undefined ? which !== 'domestic' : instrument.overseas) {
            trades.push(...this.parseTrades(await this.fetchOverseasCcldRows(since, '01')));
        }
        const filtered = instrument === undefined ? trades : trades.filter((trade) => trade.symbol === instrument.symbol);
        return this.filterBySinceLimit(filtered, undefined, limit) as Trade[];
    }

    /**
     * 국내 일별주문체결 행. `ccld`: `'00'` 전체, `'01'` 체결, `'02'` 미체결. 조회일은 KST 달력 날짜다. UTC 로 잡으면 KST 0~9시(NXT 프리마켓 포함)에
     * 전날을 조회한다. 거래소 구분은 `ALL` 로 KRX·NXT·SOR 체결을 모두 본다.
     */
    private async fetchDomesticCcldRows(code: Str, since: Int, ccld: '00' | '01' | '02', orderId: Str = undefined): Promise<Dict[]> {
        const now = this.milliseconds();
        const pages = await this.fetchAllPages(this.privateGetUapiDomesticStockV1TradingInquireDailyCcld, {
            ...this.accountParams(),
            INQR_STRT_DT: kstYmd(since ?? now),
            INQR_END_DT: kstYmd(now),
            SLL_BUY_DVSN_CD: '00',
            INQR_DVSN: '00',
            PDNO: code ?? '',
            CCLD_DVSN: ccld,
            ORD_GNO_BRNO: '',
            ODNO: orderId ?? '',
            INQR_DVSN_3: '00',
            INQR_DVSN_1: '',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
            EXCG_ID_DVSN_CD: 'ALL',
            tr_id: this.tr('TTTC0081R'),
        }, ['CTX_AREA_FK100', 'CTX_AREA_NK100']);
        const rows = pages.flatMap((page) => rowsOf(page.output1));
        return ccld === '01' ? rows.filter((row) => toNumber(row.tot_ccld_qty ?? row.cntg_qty) > 0) : rows;
    }

    /**
     * 미국 주문체결내역 행. 체결내역 TR 은 `TTTS3035R`(모의 `VTTS3035R`)다. 실전은 `NASD` 한 번이 미국 전체를 돌려준다.
     * 모의투자는 종목·구분·거래소를 비워 전체 조회만 되므로 체결 여부는 응답의 체결수량으로 거른다. 일자는 현지(ET) 기준이다.
     * 주문번호로는 검색할 수 없어 호출하는 쪽이 거른다.
     */
    private async fetchOverseasCcldRows(since: Int, ccld: '00' | '01'): Promise<Dict[]> {
        const now = this.milliseconds();
        const sandbox = this.isSandboxModeEnabled;
        const pages = await this.fetchAllPages(this.privateGetUapiOverseasStockV1TradingInquireCcnl, {
            ...this.accountParams(),
            PDNO: sandbox ? '' : '%',
            ORD_STRT_DT: etYmd(since ?? now),
            ORD_END_DT: etYmd(now),
            SLL_BUY_DVSN: '00',
            CCLD_NCCS_DVSN: sandbox ? '00' : ccld,
            OVRS_EXCG_CD: sandbox ? '' : 'NASD',
            SORT_SQN: 'DS',
            ORD_DT: '',
            ORD_GNO_BRNO: '',
            ODNO: '',
            CTX_AREA_NK200: '',
            CTX_AREA_FK200: '',
            tr_id: this.tr('TTTS3035R'),
        }, ['CTX_AREA_NK200', 'CTX_AREA_FK200']);
        const rows = pages.flatMap((page) => rowsOf(page.output));
        return ccld === '01' ? rows.filter((row) => toNumber(row.ft_ccld_qty) > 0) : rows;
    }

    /**
     * 주문 행(접수 응답, 정정취소가능·일별체결·해외 체결·미체결 조회)을 주문으로 옮긴다.
     * 접수 응답은 대문자 키(`ODNO`)이고 조회 행은 소문자 키(`odno`)다. 해외 행은 `ft_` 접두 필드를 쓴다.
     */
    override parseOrder(order: Dict, market: Market = undefined): Order {
        const id = this.safeString2(order, 'ODNO', 'odno');
        const overseas = order.ft_ord_qty !== undefined || market?.quote === 'USD';
        const code = this.safeString2(order, 'pdno', 'ovrs_pdno');
        if (code !== undefined && (market === undefined || market.id !== code)) {
            market = this.marketOf(this.instrumentOf(code));
        }
        const sideCode = this.safeString(order, 'sll_buy_dvsn_cd');
        const dvsn = this.safeString(order, 'ord_dvsn_cd');
        let amount: Str;
        let filled: Str;
        let remaining: Str;
        let price: Str;
        let average: Str;
        let cost: Str;
        let timestamp: Int;
        let status: Str;
        if (order.ODNO !== undefined) {
            // 접수 응답: 주문번호와 접수 시각(KST)만 있다. 나머지는 호출한 쪽이 요청값으로 채운다.
            timestamp = kstTimestamp(kstYmd(this.milliseconds()), this.safeString(order, 'ORD_TMD'));
            status = 'open';
        } else if (overseas) {
            amount = this.safeString(order, 'ft_ord_qty');
            filled = this.safeString(order, 'ft_ccld_qty');
            remaining = this.safeString(order, 'nccs_qty');
            price = this.safeString(order, 'ft_ord_unpr3');
            average = this.safeString(order, 'ft_ccld_unpr3');
            cost = this.safeString(order, 'ft_ccld_amt3');
            // 국내 주문일시(`dmst_ord_dt`, `thco_ord_tmd`)는 한국 시각, 현지 주문일시(`ord_dt`, `ord_tmd`)는 미국 동부 시각이다.
            timestamp = kstTimestamp(this.safeString(order, 'dmst_ord_dt'), this.safeString(order, 'thco_ord_tmd'))
                ?? etTimestamp(this.safeString(order, 'ord_dt'), this.safeString(order, 'ord_tmd'));
            status = this.orderStatusOf(filled, remaining, undefined);
        } else {
            amount = this.safeString(order, 'ord_qty');
            filled = this.safeString(order, 'tot_ccld_qty');
            // 일별체결 조회는 잔여수량(`rmn_qty`), 정정취소가능 조회는 가능수량(`psbl_qty`)을 준다.
            remaining = this.safeString2(order, 'rmn_qty', 'psbl_qty');
            price = this.safeString(order, 'ord_unpr');
            average = this.safeString(order, 'avg_prvs');
            cost = this.safeString(order, 'tot_ccld_amt');
            timestamp = kstTimestamp(this.safeString(order, 'ord_dt') ?? kstYmd(this.milliseconds()), this.safeString(order, 'ord_tmd'));
            status = this.orderStatusOf(filled, remaining, this.safeString(order, 'cncl_yn'));
        }
        return this.safeOrder({
            info: order,
            id,
            clientOrderId: undefined,
            timestamp,
            datetime: this.iso8601(timestamp),
            symbol: market?.symbol,
            type: dvsn === undefined ? undefined : dvsn === KIS_ORDER_TYPE.MARKET ? 'market' : 'limit',
            side: sideCode === SIDE_CODE_SELL ? 'sell' : sideCode === SIDE_CODE_BUY ? 'buy' : undefined,
            price,
            average,
            amount,
            filled,
            remaining,
            cost,
            status,
            fee: undefined,
            trades: [],
        }, market);
    }

    /** 체결·잔여 수량과 취소 여부로 주문 상태를 정한다. 판단할 근거가 없으면 `undefined` 다. */
    private orderStatusOf(filled: Str, remaining: Str, cancelFlag: Str): Str {
        if (cancelFlag === 'Y') return 'canceled';
        if (remaining !== undefined && Number(remaining) > 0) return 'open';
        if (filled !== undefined && Number(filled) > 0) return 'closed';
        return undefined;
    }

    /** 체결 행 하나를 체결로 옮긴다. 체결 id 는 주문일자·주문번호·종목(·해외 거래소)의 조합이라 다시 조회해도 같다. */
    override parseTrade(trade: Dict, market: Market = undefined): Trade {
        const overseas = trade.ft_ccld_qty !== undefined || market?.quote === 'USD';
        const code = this.safeString2(trade, 'pdno', 'ovrs_pdno');
        if (code !== undefined && (market === undefined || market.id !== code)) {
            market = this.marketOf(this.instrumentOf(code));
        }
        const orderId = this.safeString(trade, 'odno');
        const orderDate = overseas
            ? (this.safeString2(trade, 'ord_dt', 'dmst_ord_dt') ?? '')
            : (this.safeString(trade, 'ord_dt') ?? '');
        const timestamp = overseas
            ? (kstTimestamp(this.safeString(trade, 'dmst_ord_dt'), this.safeString(trade, 'thco_ord_tmd')) ?? etTimestamp(orderDate, this.safeString(trade, 'ord_tmd')))
            : kstTimestamp(orderDate, this.safeString(trade, 'ord_tmd'));
        const sideCode = this.safeString(trade, 'sll_buy_dvsn_cd');
        const suffix = overseas ? `:${this.safeString(trade, 'ovrs_excg_cd', '')}` : '';
        return this.safeTrade({
            info: trade,
            id: `${orderDate}:${orderId}:${code}${suffix}`,
            order: orderId,
            timestamp,
            datetime: this.iso8601(timestamp),
            symbol: market?.symbol,
            type: undefined,
            side: sideCode === SIDE_CODE_SELL ? 'sell' : sideCode === SIDE_CODE_BUY ? 'buy' : undefined,
            takerOrMaker: undefined,
            price: overseas ? this.safeString(trade, 'ft_ccld_unpr3') : this.safeString2(trade, 'avg_prvs', 'cntg_unpr'),
            amount: overseas ? this.safeString(trade, 'ft_ccld_qty') : this.safeString2(trade, 'tot_ccld_qty', 'cntg_qty'),
            cost: overseas ? this.safeString(trade, 'ft_ccld_amt3') : this.safeString(trade, 'tot_ccld_amt'),
            fee: undefined,
        }, market);
    }

    // ============ 수수료 ============

    /**
     * 수수료율. 국내 위탁수수료 0.015%(계좌 유형과 할인에 따라 다르다), 미국 0.25%다. 요율을 알려 주는 API 는 없어 표를 쓴다.
     * 국내 매도에는 증권거래세가 더해진다. 세율은 시행일 표(`krx-sell-tax.ts`)를 따르며 `info.sellTaxRate` 에 있다.
     */
    override async fetchTradingFee(symbol: string, _params: Dict = {}): Promise<TradingFeeInterface> {
        const instrument = this.instrumentOf(symbol);
        const rate = instrument.overseas ? KIS_OVERSEAS_DEFAULT_FEE_RATE : KIS_BROKERAGE_FEE;
        return {
            info: { brokerageRate: rate, sellTaxRate: instrument.overseas ? 0 : krxSellTaxRate() },
            symbol: instrument.symbol,
            maker: rate,
            taker: rate,
            percentage: true,
            tierBased: false,
        };
    }

    // ============ 휴장일 ============

    /**
     * 국내 휴장일 캘린더(`chk-holiday`). 기준일자부터 이후 날짜의 개장·영업·거래·결제 여부를 준다. 실전 계좌에서만 쓸 수 있다.
     * 지난 영업일을 세는 코드(결제 지연 등)가 지난 연휴를 알도록 30일 전 기준일과 오늘 기준일을 함께 조회한다.
     * KIS 는 원장 연동 서비스라 하루 한 번 호출을 권한다. 주기 호출은 `refreshMarketCalendar` 가 맡는다.
     */
    async fetchMarketCalendar(params: Dict = {}): Promise<KisCalendarDay[]> {
        if (this.isSandboxModeEnabled) throw new NotSupported(`${this.id} 휴장일 조회(chk-holiday)는 실전 계좌에서만 쓸 수 있다`);
        const now = this.milliseconds();
        const days = new Map<string, KisCalendarDay>();
        for (const base of [kstYmd(now - HOLIDAY_LOOKBACK_MS), kstYmd(now)]) {
            const response = await this.privateGetUapiDomesticStockV1QuotationsChkHoliday(this.extend({
                BASS_DT: base,
                CTX_AREA_FK: '',
                CTX_AREA_NK: '',
                tr_id: 'CTCA0903R',
            }, params));
            const rows: unknown = response.output;
            for (const row of Array.isArray(rows) ? rows : [rows]) {
                const date = this.safeString(row, 'bass_dt');
                const open = this.safeString(row, 'opnd_yn');
                if (date === undefined || open === undefined) continue;
                days.set(date, {
                    ...this.kstStamp(date),
                    date,
                    open: open === 'Y',
                    business: this.safeString(row, 'bzdy_yn') === 'Y',
                    trading: this.safeString(row, 'tr_day_yn') === 'Y',
                    settlement: this.safeString(row, 'sttl_day_yn') === 'Y',
                    info: row as Dict,
                });
            }
        }
        return [...days.values()];
    }

    /**
     * 휴장일 캘린더를 공용 캘린더(`market-calendar.ts`)에 넣는다. 장 시간 판정이 이 값을 읽는다. 12시간 안에 성공한 호출은 다시 하지 않는다.
     * 국내 실주문 직전에 자동으로 부른다. 장 시간 판정을 주문 밖에서 쓰는 호출하는 쪽은 시작할 때 한 번 직접 부른다.
     *
     * @returns 한 번이라도 받은 캘린더가 있으면 `true` 다(이번 호출이 실패했으면 낡았을 수 있다). 자격증명이 없거나 모의투자면 부르지 않고
     * `false` 다. 호출에 실패해도 던지지 않는다.
     */
    async refreshMarketCalendar(): Promise<boolean> {
        if (this.isSandboxModeEnabled || !this.checkRequiredCredentials(false)) return false;
        return refreshSharedMarketCalendar(
            'KR',
            async () => (await this.fetchMarketCalendar()).map(({ date, open }) => ({ date, open })),
            { ttlMs: CALENDAR_TTL_MS },
        );
    }
}
