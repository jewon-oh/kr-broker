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
 * 불리언을 돌려주는 함수), `masterData`(종목 마스터), `stockDirectory`(코스피·코스닥 구분), `confirmBudget`(체결 확정 조회 예산)이다.
 *
 * ## 유량
 *
 * 실전은 초당 20건, 모의는 초당 2건이 상한이다. 같은 프로세스에서 같은 앱키를 쓰는 인스턴스는 하나의 스케줄을 공유한다(`throttle`).
 * 조회가 `EGW00201`·`EGW00215`(초당 거래건수 초과)로 실패하면 `RateLimitExceeded` 를 던지고, 조회에 한해 몇 번 다시 보낸다.
 * 주문은 절대 재시도하지 않고, 시간 초과나 연결 끊김이면 접수 여부를 모르므로 `OrderOutcomeUnknown` 을 던진다.
 *
 * ## 한계
 *
 * 잔고·체결 조회는 연속 조회(페이지네이션)를 하지 않는다. 실전 기준 잔고 종목 50건, 체결 100건을 넘으면 뒤가 잘린다.
 * 미국 종목의 호가 조회와 분봉 조회는 하지 않는다(분봉은 야후 파이낸스로 받는다).
 */

import {
    Exchange,
    ArgumentsRequired,
    AuthenticationError,
    BadSymbol,
    ExchangeError,
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
    type MarketInterface,
    type Num,
    type OHLCV,
    type Order,
    type OrderBook,
    type OrderSide,
    type OrderType,
    type SignedRequest,
    type Str,
    type Ticker,
    type Trade,
    type TradingFeeInterface,
    type ApiName,
    type Market,
} from './base';
import { logger } from './logger';
import { buildExtendedSessionLimit } from './extended-session-limit';
import { refreshMarketCalendar as refreshSharedMarketCalendar } from './market-calendar';
import { krxSellTaxRate } from './krx-sell-tax';
import { KISAuth } from './kis/kis-auth';
import { KIS_EXCEPTIONS_EXACT } from './kis/kis-error-codes';
import { acquireKisSlot } from './kis/kis-rate-limiter';
import { checkKRXTradingHours, getKrxMarketPhase, isNxtExtendedTradable } from './kis/kis-trading-hours';
import { getUsMarketPhase, formatEtWallClock } from './kis/us-market-hours';
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
/** 조회를 다시 보내는 횟수와 간격. 초당 거래건수 초과는 1초 안팎이면 풀린다. */
const READ_RETRIES = 3;
const READ_RETRY_DELAY_MS = 500;

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
export interface KisCalendarDay {
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

/** 지금 시각의 KST 달력 날짜 `YYYYMMDD`. */
function kstYmd(ms: number): string {
    return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 미국 동부(ET) 달력 날짜 `YYYYMMDD`. 해외 체결 조회의 일자는 현지 시각 기준이다. */
function etYmd(ms: number): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(ms))
        .replace(/-/g, '');
}

/** `YYYYMMDD` + `HHMMSS`(KST) → 밀리초. 날짜를 못 읽으면 `undefined`, 시각을 못 읽으면 그날 0시다. */
function kstTimestamp(ymd: Str, hms: Str): Int {
    if (ymd === undefined || !/^\d{8}$/.test(ymd)) return undefined;
    const time = hms !== undefined && /^\d{6}$/.test(hms) ? hms : '000000';
    const parsed = Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`);
    return Number.isNaN(parsed) ? undefined : parsed;
}

/** 응답의 첫 행. 배열이면 첫 원소, 객체면 그대로, 없으면 빈 객체다. */
function firstRow(value: unknown): Dict {
    if (Array.isArray(value)) return (value[0] ?? {}) as Dict;
    return value !== null && typeof value === 'object' ? (value as Dict) : {};
}

/** 응답의 행 목록. 배열이 아니면 빈 목록이다. */
function rowsOf(value: unknown): Dict[] {
    return Array.isArray(value) ? (value as Dict[]) : [];
}

const toNumber = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

export class kis extends Exchange {
    /** 접근 토큰·실시간 접속키 캐시. 앱키가 바뀌면 다시 만든다. */
    private authState: { appKey: string; auth: KISAuth } | undefined;
    private candleService: KISCandleService | undefined;
    /** 종목별 NXT 거래 가능 여부. `blockedReason` 이 없으면 거래할 수 있다. */
    private readonly nxtEligibility = new Map<string, { blockedReason: string | undefined; at: number }>();

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
                fetchBalance: true,
                fetchMarkets: true,
                fetchCurrencies: false,
                fetchTicker: true,
                fetchTickers: false,
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
                        'uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/inquire-investor': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/search-stock-info': { cost: 1 },
                        'uapi/domestic-stock/v1/quotations/chk-holiday': { cost: 1 },
                        // 국내 계좌
                        'uapi/domestic-stock/v1/trading/inquire-balance': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-psbl-order': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl': { cost: 1 },
                        'uapi/domestic-stock/v1/trading/inquire-daily-ccld': { cost: 1 },
                        // 해외 시세
                        'uapi/overseas-price/v1/quotations/price': { cost: 1 },
                        'uapi/overseas-price/v1/quotations/dailyprice': { cost: 1 },
                        // 해외 계좌
                        'uapi/overseas-stock/v1/trading/inquire-balance': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-present-balance': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-ccnl': { cost: 1 },
                        'uapi/overseas-stock/v1/trading/inquire-nccs': { cost: 1 },
                    },
                    post: {
                        'uapi/domestic-stock/v1/trading/order-cash': { cost: 1, order: true },
                        'uapi/domestic-stock/v1/trading/order-rvsecncl': { cost: 1, order: true },
                        'uapi/overseas-stock/v1/trading/order': { cost: 1, order: true },
                        'uapi/overseas-stock/v1/trading/order-rvsecncl': { cost: 1, order: true },
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
                /** 접수 뒤 체결 확정 조회의 예산 `{ attempts, intervalMs }`. 객체이거나 객체를 돌려주는 함수다. */
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
     * 요청을 만든다. 비공개 호출은 `params.tr_id` 를 헤더로 옮기고 나머지는 GET 이면 쿼리로, POST 이면 JSON 본문으로 보낸다.
     * 대문자 키(`CANO` 등)는 KIS 규격 그대로 둔다.
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
            query = this.omit(params, 'tr_id');
            Object.assign(requestHeaders, {
                authorization: `Bearer ${this.token}`,
                appkey: this.apiKey as string,
                appsecret: this.secret as string,
                tr_id: trId,
                custtype: KIS_CUSTOMER_TYPE,
            });
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
    createPriceStream(handlers: Pick<KisPriceWsOptions, 'onTrade' | 'onOrderbook'> = {}): KisPriceWs {
        return new KisPriceWs({
            getApprovalKey: () => this.getApprovalKey(),
            isVirtual: this.isSandboxModeEnabled,
            ...handlers,
        });
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
        _responseHeaders: Dictionary<string>,
        responseBody: string,
        response: unknown,
        _requestHeaders: Dictionary<string> | undefined,
        _requestBody: string | undefined,
    ): boolean | undefined {
        const isAuthRequest = url.includes('/oauth2/');
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
        const change = numberToString(Math.abs(toNumber(this.safeString(ticker, 'prdy_vrss'))) * Math.sign(toNumber(percentage)));
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
     * 먼저 부르고, 야후가 비면 KIS 로 다시 받는다. `params.until` 로 끝 시각을 정한다.
     */
    override async fetchOHLCV(symbol: string, timeframe = '1d', since: Int = undefined, limit: Int = 100, params: Dict = {}): Promise<OHLCV[]> {
        const instrument = this.instrumentOf(symbol);
        const until = this.safeInteger(params, 'until');
        // KOSPI/KOSDAQ 구분으로 야후 티커의 접미사(.KS/.KQ)를 정확히 붙인다.
        const krMarket = await resolveKrMarket(symbol, { stockDirectory: this.options.stockDirectory, masterData: this.master() });
        const yahoo = await fetchYahooCandles(symbol, timeframe, limit, since, until, krMarket);
        const dailyLike = ['1d', '1w', '1W', '1M'].includes(timeframe);
        if (yahoo.length > 0 || !instrument.overseas || !dailyLike) return yahoo as OHLCV[];
        // 자격증명이 없으면 KIS 로 폴백할 수 없다(야후 결과를 그대로 돌려준다).
        if (instrument.quoteExchange === undefined || !this.checkRequiredCredentials(false)) return yahoo as OHLCV[];
        logger.info({ symbol, timeframe }, '[kis] 야후가 비어 KIS 해외 일봉으로 폴백한다');
        const native = await this.candles().fetchOverseasDailyOHLCV(instrument.code, instrument.quoteExchange, timeframe, limit ?? 100);
        return (native.length > 0 ? native : yahoo) as OHLCV[];
    }

    /** KIS 가 직접 주는 캔들(일봉·당일 분봉·해외 일봉)과 심층 이력 페이지네이션. `fetchOHLCV` 가 쓰지 않는 원본 경로다. */
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
        const wants = (name: string): boolean => scope === 'all' || scope === name || (Array.isArray(scope) && scope.includes(name));
        const orderable = this.safeBool(params, 'orderable', true);
        const raw: Dict = {};
        if (wants('kr')) raw.domestic = await this.fetchDomesticBalanceRaw(orderable);
        if (wants('us')) raw.overseas = await this.fetchOverseasHoldingsRaw();
        if (wants('usd')) raw.usd = await this.fetchPresentBalanceRaw();
        return this.parseBalance(raw);
    }

    private async fetchDomesticBalanceRaw(orderable: boolean): Promise<Dict> {
        const response = await this.privateGetUapiDomesticStockV1TradingInquireBalance({
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
        });
        const raw: Dict = { holdings: rowsOf(response.output1), summary: firstRow(response.output2) };
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

    /** 미국 보유 종목. 실전은 `NASD` 가 미국 전체이므로 한 번만 부른다. 모의는 `NASD`·`NYSE`·`AMEX` 를 따로 부른다. */
    private async fetchOverseasHoldingsRaw(): Promise<Dict> {
        const exchanges: OverseasOrderMarket[] = this.isSandboxModeEnabled ? ['NASD', 'NYSE', 'AMEX'] : ['NASD'];
        const responses = await Promise.all(exchanges.map((exchange) => this.privateGetUapiOverseasStockV1TradingInquireBalance({
            ...this.accountParams(),
            OVRS_EXCG_CD: exchange,
            TR_CRCY_CD: 'USD',
            CTX_AREA_FK200: '',
            CTX_AREA_NK200: '',
            tr_id: this.tr('TTTS3012R'),
        })));
        return { holdings: responses.flatMap((response: Dict) => rowsOf(response.output1)) };
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
     * - 종목: `total`=보유수량, `free`=주문가능수량(없으면 보유수량)
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
                used: free !== undefined && total !== undefined ? numberToString(Math.max(0, Number(total) - Number(free))) : undefined,
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
            const deposit = toNumber(this.safeString(cash, 'frcr_dncl_amt_2'));
            const buyMargin = toNumber(this.safeString(cash, 'frcr_buy_mgn_amt'));
            const stockValue = rowsOf(usd.stocks)
                .filter((row) => (this.safeString(row, 'buy_crcy_cd') ?? 'USD').toUpperCase() === 'USD')
                .reduce((sum, row) => sum + toNumber(this.safeString(row, 'frcr_evlu_amt2')), 0);
            const free = Math.max(0, deposit - buyMargin);
            result.USD = {
                free: numberToString(free),
                used: numberToString(Math.max(0, deposit - free)),
                total: numberToString(deposit),
                info: { deposit, buyMargin, stockValue, currencies: usd.currencies, stocks: usd.stocks },
            };
        }
        return this.safeBalance(result);
    }

    private addHolding(result: Dict, item: Dict, codeKey: string, quantityKey: string): void {
        const code = this.safeString(item, codeKey);
        const quantity = this.safeString(item, quantityKey);
        if (code === undefined || quantity === undefined || !(Number(quantity) > 0)) return;
        result[code] = { free: this.safeString(item, 'ord_psbl_qty', quantity), used: undefined, total: quantity, info: item };
    }

    // ============ 주문 ============

    /**
     * 주문. 수량은 정수 주로 내린다(소수점 매수는 지원하지 않는다). 거래시간 밖은 주문을 보내지 않고 `MarketClosed` 를 던진다.
     *
     * `params`:
     * - `session`: `'regular'` 이나 `'nxt'`. 생략하면 NXT 라우팅 기능 플래그와 NXT 확장세션 시각으로 자동 판정한다(국내).
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
        params = this.omit(params, 'session');
        // 확장세션(NXT 프리 08:00~08:50, 애프터 15:30~20:00)은 정규장 게이트를 우회하고 SOR 로 낸다. 기능 플래그가 꺼져 있으면 정규장 규칙이다.
        const extended = session === 'nxt'
            || (session === undefined && (await this.isOptionEnabled('nxtRouting')) && isNxtExtendedTradable());
        if (extended) await this.assertNxtTradable(instrument);
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
     * 미체결 주문을 모두 취소한다. 종목을 주면 그 종목만이다. 하나라도 취소하지 못하면 나머지를 다 시도한 뒤 첫 실패를 던진다.
     * 살아 있을 수 있는 주문을 성공으로 돌려주지 않기 위해서다.
     */
    override async cancelAllOrders(symbol: Str = undefined, params: Dict = {}): Promise<Order[]> {
        const open = await this.fetchOpenOrders(symbol, undefined, undefined, params);
        const results = await Promise.allSettled(open.map((order) => this.cancelOrder(order.id as string, order.symbol, {})));
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed !== undefined) throw failed.reason;
        return results.map((r) => (r as PromiseFulfilledResult<Order>).value);
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
            const response = await this.privateGetUapiDomesticStockV1TradingInquirePsblRvsecncl({
                ...this.accountParams(),
                CTX_AREA_FK100: '',
                CTX_AREA_NK100: '',
                INQR_DVSN_1: '0',
                INQR_DVSN_2: '0',
                // 실전만 신형 TR 이 있다. 모의는 종전 TR 을 그대로 쓴다.
                tr_id: this.tr('TTTC0084R', 'VTTC8036R'),
            });
            const market = instrument === undefined ? undefined : this.marketOf(instrument);
            orders.push(...this.parseOrders(rowsOf(response.output), market).map((order) => this.markOpen(order)));
        }
        if (wantOverseas) {
            const response = await this.privateGetUapiOverseasStockV1TradingInquireNccs({
                ...this.accountParams(),
                OVRS_EXCG_CD: 'NASD',
                SORT_SQN: 'DS',
                CTX_AREA_FK200: '',
                CTX_AREA_NK200: '',
                tr_id: this.tr('TTTS3018R', null),
            });
            orders.push(...this.parseOrders(rowsOf(response.output)).map((order) => this.markOpen(order)));
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
     * 일자는 국내가 KST, 미국이 현지(ET) 기준이다. `since` 를 주지 않으면 오늘이다.
     */
    override async fetchMyTrades(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        const instrument = symbol === undefined ? undefined : this.instrumentOf(symbol);
        const which = this.safeString(params, 'market', 'all');
        const trades: Trade[] = [];
        if (instrument === undefined ? which !== 'overseas' : !instrument.overseas) {
            trades.push(...this.parseTrades(await this.fetchDomesticCcldRows(instrument?.code, since, '01'), undefined, since, limit));
        }
        if (instrument === undefined ? which !== 'domestic' : instrument.overseas) {
            trades.push(...this.parseTrades(await this.fetchOverseasCcldRows(since, '01'), undefined, since, limit));
        }
        const filtered = instrument === undefined ? trades : trades.filter((trade) => trade.symbol === instrument.symbol);
        return this.filterBySinceLimit(filtered, since, limit) as Trade[];
    }

    /**
     * 국내 일별주문체결 행. `ccld`: `'00'` 전체, `'01'` 체결, `'02'` 미체결. 조회일은 KST 달력 날짜다. UTC 로 잡으면 KST 0~9시(NXT 프리마켓 포함)에
     * 전날을 조회한다. 거래소 구분은 `ALL` 로 KRX·NXT·SOR 체결을 모두 본다.
     */
    private async fetchDomesticCcldRows(code: Str, since: Int, ccld: '00' | '01' | '02', orderId: Str = undefined): Promise<Dict[]> {
        const now = this.milliseconds();
        const response = await this.privateGetUapiDomesticStockV1TradingInquireDailyCcld({
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
        });
        const rows = rowsOf(response.output1);
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
        const response = await this.privateGetUapiOverseasStockV1TradingInquireCcnl({
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
        });
        const rows = rowsOf(response.output);
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
            timestamp = kstTimestamp(this.safeString(order, 'dmst_ord_dt'), this.safeString(order, 'thco_ord_tmd'))
                ?? kstTimestamp(this.safeString(order, 'ord_dt'), this.safeString(order, 'ord_tmd'));
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
            ? (kstTimestamp(this.safeString(trade, 'dmst_ord_dt'), this.safeString(trade, 'thco_ord_tmd')) ?? kstTimestamp(orderDate, this.safeString(trade, 'ord_tmd')))
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
     * 수수료율. 국내 위탁수수료 0.015%(뱅키스 기준, 계좌 유형·이벤트에 따라 다르다), 미국 0.25%다. 요율을 알려 주는 API 는 없어 표를 쓴다.
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
    async fetchMarketCalendar(_params: Dict = {}): Promise<KisCalendarDay[]> {
        if (this.isSandboxModeEnabled) throw new NotSupported(`${this.id} 휴장일 조회(chk-holiday)는 실전 계좌에서만 쓸 수 있다`);
        const now = this.milliseconds();
        const days = new Map<string, KisCalendarDay>();
        for (const base of [kstYmd(now - HOLIDAY_LOOKBACK_MS), kstYmd(now)]) {
            const response = await this.privateGetUapiDomesticStockV1QuotationsChkHoliday({
                BASS_DT: base,
                CTX_AREA_FK: '',
                CTX_AREA_NK: '',
                tr_id: 'CTCA0903R',
            });
            const rows: unknown = response.output;
            for (const row of Array.isArray(rows) ? rows : [rows]) {
                const date = this.safeString(row, 'bass_dt');
                const open = this.safeString(row, 'opnd_yn');
                if (date === undefined || open === undefined) continue;
                days.set(date, {
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
     * @returns 신선한 캘린더가 있으면 `true`. 자격증명이 없거나 모의투자면 부르지 않고 `false`, 호출에 실패해도 던지지 않고 `false` 다.
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
