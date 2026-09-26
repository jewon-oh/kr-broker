/**
 * @fileoverview 증권사 공통 자료 구조. ccxt 의 통합 구조를 따른다.
 *
 * 값이 없을 수 있는 필드는 `undefined` 로 표현한다(`null` 을 쓰지 않는다). 가격·수량은 `number` 이며, 증권사 고유 값은 `info` 에 원본 그대로 둔다.
 * 종목은 `BASE/QUOTE` 심볼로 가리킨다(`005930/KRW`, `AAPL/USD`).
 */

export type Int = number | undefined;
export type Str = string | undefined;
export type Strings = string[] | undefined;
export type Num = number | undefined;
export type Bool = boolean | undefined;

export type IndexType = number | string;

/** 고유 결과 타입이 ccxt 통합 구조처럼 행의 대표 시각을 담는 필드. 날짜만 있는 행은 그 날짜의 0시다(시간대는 메서드마다 적는다). */
export interface KrTimestamped {
    /** 행이 가리키는 시각(ms) */
    timestamp: number | undefined;
    /** `timestamp` 의 ISO 8601 문자열 */
    datetime: string | undefined;
}
export type NullableIndexType = IndexType | undefined;

export type OrderSide = 'buy' | 'sell' | string | undefined;
export type OrderType = 'limit' | 'market' | string;
export type MarketType = 'spot' | 'margin' | 'swap' | 'future' | 'option' | 'index';

export interface Dictionary<T> {
    [key: string]: T;
}

/** 값의 모양을 정하지 않는 사전. 증권사 응답 원본이나 `params` 처럼 열려 있는 자리에 쓴다. */
export type Dict = Dictionary<any>;
export type NullableDict = Dict | undefined;
export type List = Array<any>;

export interface MinMax {
    min: Num;
    max: Num;
}

/** 수량·가격·금액의 최소 단위. 단위의 뜻은 `Exchange.precisionMode` 를 따른다(기본은 `TICK_SIZE`, 곧 호가 단위). */
export interface Precision {
    amount: Num;
    price: Num;
    cost?: Num;
    base?: Num;
    quote?: Num;
}

export interface Fee {
    currency: Str;
    cost: Num;
    rate?: Num;
}

/** 문자열 십진수 계산을 마치기 전의 수수료. */
export interface FeeString {
    currency: Str;
    cost: Str;
    rate?: Str;
}

// ---- 종목 ----

export interface MarketInterface {
    /** 증권사가 쓰는 종목 식별자(국내 종목코드, 미국 티커 등). */
    id: Str;
    lowercaseId?: Str;
    /** 통합 심볼. `005930/KRW`, `AAPL/USD`. */
    symbol: string;
    base: string;
    quote: string;
    baseId: Str;
    quoteId: Str;
    active: Bool;
    /** 주식 현물은 `spot` 이다. */
    type: MarketType;
    subType?: 'linear' | 'inverse';
    spot: Bool;
    margin: Bool;
    swap: Bool;
    future: Bool;
    option: Bool;
    index?: Bool;
    contract: Bool;
    settle: Str;
    settleId: Str;
    contractSize: Num;
    linear: Bool;
    inverse: Bool;
    expiry: Int;
    expiryDatetime: Str;
    strike: Num;
    optionType: Str;
    taker?: Num;
    maker?: Num;
    percentage?: Bool;
    tierBased?: Bool;
    feeSide?: Str;
    precision: Precision;
    limits: {
        amount?: MinMax;
        cost?: MinMax;
        leverage?: MinMax;
        price?: MinMax;
        market?: MinMax;
    };
    created: Int;
    /** 증권사가 준 종목 원본 행. 시장 구분(`KOSPI`·`NASD` 등)과 호가단위 같은 고유 값이 여기에 있다. */
    info: any;
    /** 종목별 옵션. 증권사 클래스가 시장 구분 같은 값을 실어 둔다. */
    options?: Dict;
}

export type Market = MarketInterface | undefined;

export interface CurrencyInterface {
    id: string;
    code: string;
    precision: Num;
    name?: Str;
    active?: Bool;
    info: any;
}

export type Currency = CurrencyInterface | undefined;
export type Currencies = Dictionary<CurrencyInterface>;

// ---- 시세 ----

export interface Ticker {
    symbol: Str;
    info: any;
    timestamp: Int;
    datetime: Str;
    high: Num;
    low: Num;
    bid: Num;
    bidVolume: Num;
    ask: Num;
    askVolume: Num;
    vwap: Num;
    open: Num;
    close: Num;
    last: Num;
    previousClose: Num;
    change: Num;
    percentage: Num;
    average: Num;
    quoteVolume: Num;
    baseVolume: Num;
    indexPrice: Num;
    markPrice: Num;
}

export type Tickers = Dictionary<Ticker>;

export interface OrderBook {
    /** `[가격, 수량]` 쌍. 매수는 가격 내림차순, 매도는 오름차순이다. */
    asks: [Num, Num][];
    bids: [Num, Num][];
    datetime: Str;
    timestamp: Int;
    nonce: Int;
    symbol: Str;
}

/** `[시각(ms), 시가, 고가, 저가, 종가, 거래량]` */
export type OHLCV = [Num, Num, Num, Num, Num, Num];

// ---- 주문·체결 ----

export interface Trade {
    info: any;
    amount: Num;
    datetime: Str;
    id: Str;
    order: Str;
    price: Num;
    timestamp: Int;
    type: Str;
    side: 'buy' | 'sell' | string | undefined;
    symbol: Str;
    takerOrMaker: 'taker' | 'maker' | Str;
    cost: Num;
    fee: Fee;
    fees?: Fee[];
}

export interface Order {
    id: Str;
    clientOrderId: Str;
    datetime: Str;
    timestamp: Int;
    lastTradeTimestamp: Int;
    lastUpdateTimestamp?: Int;
    /** `open`·`closed`·`canceled`·`expired`·`rejected`. 증권사가 준 값을 통합 값으로 옮긴 것이다. */
    status: 'open' | 'closed' | 'canceled' | 'expired' | 'rejected' | Str;
    symbol: Str;
    type: Str;
    timeInForce?: Str;
    side: 'buy' | 'sell' | Str;
    price: Num;
    average?: Num;
    amount: Num;
    filled: Num;
    remaining: Num;
    stopPrice?: Num;
    triggerPrice?: Num;
    takeProfitPrice?: Num;
    stopLossPrice?: Num;
    cost: Num;
    trades: Trade[];
    /** 수수료를 알 수 없으면 `undefined`. */
    fee: Fee | undefined;
    fees?: Fee[];
    reduceOnly: Bool;
    postOnly: Bool;
    /** 증권사가 준 주문 원본. */
    info: any;
}

// ---- 잔고 ----

/**
 * 통화(`KRW`, `USD`)나 보유 종목 코드(`005930`)별 잔고. 종목이면 `total` 이 보유 수량이다.
 * 평균 단가·평가 금액 같은 증권사 고유 값은 `info` 에 둔다.
 */
export interface Balance {
    free: Num;
    used: Num;
    total: Num;
    debt?: Num;
    info?: any;
}

/**
 * 통화·종목 코드로 색인한 잔고 사전이며, 같은 값을 `free`·`used`·`total` 사전으로도 담고 있다.
 * `info` 에는 응답 원본이 들어가고, 일부만 조회됐으면 어댑터가 읽은 범위를 `info.readStatus` 로 알린다.
 */
export interface Balances extends Dictionary<Balance> {
    info: any;
    timestamp?: any;
    datetime?: any;
    free?: any;
    used?: any;
    total?: any;
    debt?: any;
}

// ---- 그 밖의 조회 결과 ----

export interface TradingFeeInterface {
    info: any;
    symbol: Str;
    maker: Num;
    taker: Num;
    percentage: Bool;
    tierBased: Bool;
}

export interface Status {
    /** `ok`·`shutdown`·`error`·`maintenance` */
    status: Str;
    updated: Int;
    eta: Int;
    url: Str;
    info: any;
}

/**
 * 종목의 투자자별 매매동향 하루치(`fetchInvestorTrading`). `timestamp` 는 그 영업일의 00:00 KST 다.
 * 세 투자자 필드는 순매수 대금이다. 다른 투자자 유형과 매수·매도 값은 `info` 의 원문에 있다.
 */
export interface InvestorTradingRecord extends KrTimestamped {
    /** 영업일 `YYYYMMDD`(한국 날짜) */
    date: string;
    /** 종가 */
    close: Num;
    /** 전일 대비 */
    change: Num;
    /** 개인 순매수 대금. 단위는 증권사 응답 그대로다. 증권사마다 다를 수 있으므로 증권사를 섞어 더하지 않는다. */
    individual: Num;
    /** 외국인 순매수 대금. 단위는 증권사 응답 그대로다. 증권사마다 다를 수 있으므로 증권사를 섞어 더하지 않는다. */
    foreign: Num;
    /** 기관 순매수 대금. 단위는 증권사 응답 그대로다. 증권사마다 다를 수 있으므로 증권사를 섞어 더하지 않는다. */
    institution: Num;
    info: Dict;
}

// ---- 생성자 인자 ----

/** `new 증권사(config)` 가 받는 설정. 여기 없는 키도 그대로 인스턴스에 얹는다(`describe()` 를 덮어쓰는 값이다). */
export interface ConstructorArgs {
    /** 앱 키·클라이언트 ID */
    apiKey?: string | undefined;
    /** 앱 시크릿·클라이언트 시크릿 */
    secret?: string | undefined;
    /** 계좌번호 */
    uid?: string | undefined;
    login?: string | undefined;
    password?: string | undefined;
    twofa?: string | undefined;
    token?: string | undefined;
    accountId?: string | undefined;
    privateKey?: string | undefined;
    walletAddress?: string | undefined;
    verbose?: boolean | undefined;
    /** `true` 면 생성 직후 `setSandboxMode(true)` 를 부른다. */
    sandbox?: boolean | undefined;
    options?: Dict | undefined;
    enableRateLimit?: boolean | undefined;
    rateLimit?: number | undefined;
    timeout?: number | undefined;
    userAgent?: string | undefined;
    markets?: Dictionary<MarketInterface> | undefined;
    headers?: Dictionary<string> | undefined;
    urls?: Dict | undefined;
    [key: string]: any;
}

/** 암묵 API 메서드(`privateGetFoo`)의 모양. 생성 선언(`abstract/<id>.ts`)과, 표 없이 `api` 트리를 적은 서브클래스의 `declare` 가 쓴다. */
export type ImplicitApiMethod = (params?: Dict) => Promise<any>;

/**
 * 전역 `fetch` 의 `signal` 인자 타입.
 * `@types/node` 와 `undici-types` 가 `AbortSignal` 을 따로 선언해서, 병렬 빌드에서 어느 선언이 먼저 잡히느냐에 따라 `controller.signal` 이
 * `fetch` 의 인자와 맞지 않을 때가 있다. `fetch` 자신의 인자에서 뽑으면 어느 쪽이 잡혀도 같은 타입이 된다.
 */
export type FetchSignal = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['signal']>;
