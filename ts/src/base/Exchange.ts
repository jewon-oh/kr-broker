/**
 * @fileoverview 증권사 클래스의 부모 클래스. ccxt 의 `Exchange` 구조를 따른다.
 *
 * 증권사 클래스(`class kis extends Exchange`)는 다음을 채운다.
 *
 * - `describe()`: 이름·URL·`api` 트리·`has`·`exceptions`·`requiredCredentials` 같은 선언. 부모의 값 위에 `deepExtend` 로 얹는다.
 * - `sign()`: 요청 하나를 `{ url, method, headers, body }` 로 만든다(동기).
 * - `authenticate()`: 토큰 발급처럼 비동기 준비가 필요한 인증. `sign` 은 동기라서 이 훅이 먼저 준비해 둔다.
 * - `handleErrors()`: 증권사 응답의 오류 봉투를 오류 클래스로 던진다. 못 잡은 것은 HTTP 상태 표(`httpExceptions`)가 받는다.
 * - `fetchMarkets()`·`parse*()`·`fetchBalance()`·`createOrder()` 같은 통합 메서드.
 *
 * ## 요청이 지나가는 길
 *
 * `api` 트리의 엔드포인트마다 암묵 메서드(`privateGetUapiDomesticStockV1TradingOrderCash`)가 생기고, 호출하면
 * `request` → `fetch2`(비공개면 자격증명 확인·`authenticate`, 그다음 `throttle` → `sign` → `fetch` → `handleRestResponse` → `handleErrors`) 순으로 간다.
 *
 * ## 서브클래스가 지킬 것
 *
 * 생성자가 `describe()` 를 부른 뒤 그 값을 인스턴스에 얹는다. 서브클래스에 **필드 선언(초기값이 있든 없든)** 을 두면 그 뒤에 초기화되어
 * 얹어 둔 값을 덮어쓴다. 타입만 알리려면 `declare id: string;` 처럼 `declare` 를 붙인다.
 *
 * ## 주문 요청
 *
 * `api` 엔드포인트를 `{ cost, order: true }` 로 적으면 주문 요청으로 다룬다. 주문 요청은 재시도하지 않고, 시간 초과나 연결 끊김, 증권사 오류 코드가
 * 없는 5xx, 해석할 수 없는 응답이면 접수 여부를 모르므로 `OrderOutcomeUnknown` 으로 바꿔 던진다. 조회는 `OperationFailed` 계열만
 * `maxRetriesOnFailure` 번까지 다시 보낸다.
 */

import { logger } from '../logger';
import { resolveFlag, resolveTokenStore, type BrokerTokenStore } from '../options';
import { resolveConfirmBudget, type ConfirmBudget } from '../execution-confirm';
import {
    ArgumentsRequired,
    AuthenticationError,
    BadRequest,
    BadResponse,
    BadSymbol,
    DDoSProtection,
    ExchangeError,
    ExchangeNotAvailable,
    InvalidOrder,
    NetworkError,
    NotSupported,
    NullResponse,
    OperationFailed,
    OrderOutcomeUnknown,
    RateLimitExceeded,
    RequestTimeout,
    type BaseErrorOptions,
    type ErrorClass,
} from './errors';
import {
    clone, deepExtend, extend, filterBy, flatten, groupBy, indexBy, inArray, isEmpty, keysort, omit, sortBy, sortBy2, sum, toArray, unique,
    extractParams, implodeParams, urlencode,
} from './functions/generic';
import {
    DECIMAL_PLACES, NO_PADDING, Precise, ROUND, TICK_SIZE, TRUNCATE, decimalToPrecision, numberToString, omitZero, parseNumber, precisionFromString,
} from './functions/number';
import { Throttler } from './functions/throttle';
import { iso8601, milliseconds, now, parse8601, parseTimeframe, seconds, sleep } from './functions/time';
import {
    asFloat, asInteger, hasProps, isArray, isDict, isInteger, isNumber, isObject, isString,
    safeBool, safeBool2, safeDict, safeDict2, safeFloat, safeFloat2, safeFloatN, safeInteger, safeInteger2, safeIntegerN,
    safeIntegerProduct, safeIntegerProduct2, safeIntegerProductN, safeList, safeList2, safeNumber, safeNumber2, safeNumberN,
    safeString, safeString2, safeStringLower, safeStringLower2, safeStringLowerN, safeStringN, safeStringUpper, safeStringUpper2,
    safeStringUpperN, safeTimestamp, safeTimestamp2, safeTimestampN, safeValue, safeValue2, safeValueN,
} from './functions/type';
import type {
    Balances, ConstructorArgs, Currencies, Currency, CurrencyInterface, Dict, Dictionary, IndexType, Int, KrTimestamped, List, Market,
    FetchSignal, MarketInterface, Num, OHLCV, Order, OrderBook, OrderSide, OrderType, Status, Str, Strings, Ticker, Tickers, Trade, TradingFeeInterface,
} from './types';

/** HTTP 상태만 보고 만든 오류와 그 상태 코드. 증권사 오류 코드로 분류하지 못한 5xx 인지 가리는 데 쓴다. */
const httpStatusErrors = new WeakMap<object, number>();

// ============ 인스턴스에 얹는 함수 ============

/** 생성자가 인스턴스에 얹는 순수 함수들. `this.safeString(...)` 처럼 부른다. */
const boundFunctions = {
    // 타입 판별
    isNumber, isInteger, isArray, isObject, isString, isDictionary: isDict, hasProps, asFloat, asInteger,
    // safe*
    safeFloat, safeFloat2, safeFloatN, safeInteger, safeInteger2, safeIntegerN, safeIntegerProduct, safeIntegerProduct2, safeIntegerProductN,
    safeTimestamp, safeTimestamp2, safeTimestampN, safeValue, safeValue2, safeValueN, safeString, safeString2, safeStringN,
    safeStringLower, safeStringLower2, safeStringLowerN, safeStringUpper, safeStringUpper2, safeStringUpperN,
    safeNumber, safeNumber2, safeNumberN, safeBool, safeBool2, safeDict, safeDict2, safeList, safeList2,
    // 숫자·시각
    parseNumber, numberToString, omitZero, precisionFromString, decimalToPrecision, iso8601, parse8601, parseTimeframe, now, milliseconds, seconds, sleep,
    // 사전·배열
    extend, clone, omit, keysort, deepExtend, indexBy, groupBy, filterBy, sortBy, sortBy2, unique, flatten, sum, toArray, isEmpty, inArray,
    // 경로·쿼리
    implodeParams, extractParams, urlencode,
};

type BoundFunctions = typeof boundFunctions;

// 클래스와 합쳐지는 선언이다. `boundFunctions` 의 타입(오버로드 포함)을 그대로 인스턴스 메서드로 노출한다.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Exchange extends BoundFunctions {}

// ============ 보조 타입 ============

/** 엔드포인트가 속한 `api` 이름. `api` 트리가 두 단계 이상이면 이름 배열이다(`['trader', 'private']`). */
export type ApiName = string | string[];

/** `sign` 이 만드는 요청. */
export interface SignedRequest {
    url: string;
    method: string;
    headers?: Dictionary<string>;
    body?: string;
}

/** `fetch` 가 `handleRestResponse` 에 넘기는 응답. `Response` 의 필요한 부분만 갖는다. */
export interface HttpResponseLike {
    status: number;
    statusText: string;
    headers: unknown;
    text(): Promise<string>;
}

/** 증권사 오류 코드·메시지를 오류 클래스로 잇는 표. `exact` 는 완전 일치, `broad` 는 부분 일치(선언 순서대로 처음 맞는 것)다. */
export interface ExceptionTable {
    exact?: Dictionary<ErrorClass>;
    broad?: Dictionary<ErrorClass>;
}

/** 엔드포인트 하나의 설정. `api` 트리의 잎이다. */
export interface EndpointConfig {
    /** 요청 비용. 요청 뒤 `rateLimit × cost` 밀리초가 지나야 다음 요청이 나간다. */
    cost?: number;
    /** 주문 요청이다(재시도하지 않고, 시간 초과는 `OrderOutcomeUnknown`). */
    order?: boolean;
    /** `rateLimitBuckets` 에 적은 이름. 없으면 기본 버킷을 쓴다. */
    bucket?: string;
}

const HTTP_METHOD_KEY = /^(?:get|post|put|delete|head|patch)$/i;
const CAPITALIZE = (s: string): string => (s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_MS = 50;
const DEFAULT_CURRENCY_TICK = '1e-8';
const DEFAULT_CURRENCY_DECIMALS = 8;
const RATIO_TO_PERCENT = '100';
/** 이보다 큰 `limit` 은 쓰일 일이 없다. 이런 값은 옛 위치 인자 `until`(ms)이 `limit` 자리로 들어온 것이다. */
const LIMIT_LOOKS_LIKE_MS = 1_000_000_000;
/** 한국 표준시(UTC+9). */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export class Exchange {
    // 암묵 API 메서드(`privateGetFoo`)가 실행 중에 만들어지므로 이름을 미리 알 수 없다. 증권사 클래스가 `declare` 로 좁힌다.
    [key: string]: any;

    // ---- 신원 ----
    id = 'Exchange';
    name: Str = undefined;
    countries: string[] = [];
    version: Str = undefined;
    hostname: Str = undefined;

    // ---- 요청 ----
    enableRateLimit = true;
    /** 요청 뒤 다음 요청까지 기다리는 밀리초(비용 1 기준). 0 이면 조절하지 않는다. */
    rateLimit = DEFAULT_RATE_LIMIT_MS;
    /** 조회 요청의 시간 상한(밀리초). */
    timeout = DEFAULT_TIMEOUT_MS;
    /** 주문 요청의 시간 상한. 없으면 `timeout` 을 쓴다. */
    orderTimeout: Num = undefined;
    verbose = false;
    userAgent: Str = undefined;
    headers: Dictionary<string> = {};

    // ---- 선언 ----
    has: Dict = {};
    urls: Dict = {};
    api: Dict | undefined = undefined;
    requiredCredentials: Dictionary<boolean> = {};
    options: Dict = {};
    exceptions: ExceptionTable | Dictionary<ErrorClass> | undefined = undefined;
    httpExceptions: Dictionary<ErrorClass> = {};
    commonCurrencies: Dictionary<string> = {};
    timeframes: Dictionary<string> | undefined = undefined;
    status: Dict = {};
    /** 요청 버킷 이름 → `{ rateLimit }`. 엔드포인트의 `bucket` 이 가리킨다. */
    rateLimitBuckets: Dictionary<{ rateLimit: number }> = {};

    // ---- 정밀도·수수료 ----
    precisionMode: number = TICK_SIZE;
    paddingMode: number = NO_PADDING;
    /** 종목이 자기 값을 갖지 않을 때 쓰는 기본 정밀도. */
    precision: Dict = {};
    limits: Dict = {};
    fees: Dict = { trading: {}, funding: { withdraw: {}, deposit: {} } };
    /** 수수료를 통화별로 합친다. */
    reduceFees = true;

    // ---- 자격증명 ----
    apiKey: Str = undefined;
    secret: Str = undefined;
    uid: Str = undefined;
    login: Str = undefined;
    password: Str = undefined;
    twofa: Str = undefined;
    token: Str = undefined;
    accountId: Str = undefined;
    privateKey: Str = undefined;
    walletAddress: Str = undefined;

    // ---- 종목·통화 ----
    markets: Dictionary<MarketInterface> | undefined = undefined;
    markets_by_id: Dictionary<MarketInterface[]> | undefined = undefined;
    symbols: string[] = [];
    ids: string[] = [];
    currencies: Dictionary<CurrencyInterface> = {};
    currencies_by_id: Dictionary<CurrencyInterface> | undefined = undefined;
    codes: string[] = [];
    marketsLoading: Promise<Dictionary<MarketInterface>> | undefined = undefined;
    reloadingMarkets = false;

    // ---- 상태 ----
    isSandboxModeEnabled = false;
    lastRestRequestTimestamp = 0;
    last_http_response: Str = undefined;
    last_json_response: unknown = undefined;
    last_response_headers: Dictionary<string> | undefined = undefined;
    last_request_url: Str = undefined;
    last_request_method: Str = undefined;
    last_request_headers: Dictionary<string> | undefined = undefined;
    last_request_body: Str = undefined;

    private throttler: Throttler | undefined = undefined;
    private bucketThrottlers: Dictionary<Throttler | undefined> = {};

    constructor(userConfig: ConstructorArgs = {}) {
        Object.assign(this, boundFunctions);
        this.options = this.getDefaultOptions();
        // 부모 기본값 → 증권사 선언 → 사용자 설정 순으로 얹는다. 일반 객체는 깊게 합치고 나머지는 덮어쓴다.
        const configEntries = Object.entries(this.describe()).concat(Object.entries(userConfig));
        for (const [property, value] of configEntries) {
            if (value !== undefined && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
                this[property] = deepExtend(this[property], value);
            } else {
                this[property] = value;
            }
        }
        if (this.api !== undefined) this.defineRestApi(this.api, 'request');
        this.afterConstruct();
        if (safeBool(userConfig, 'sandbox') === true) this.setSandboxMode(true);
    }

    // ============ 선언 ============

    /** 부모의 기본 선언. 증권사 클래스는 `deepExtend(super.describe(), {...})` 로 자기 값을 얹는다. */
    describe(): Dict {
        return {
            id: this.id,
            name: this.name,
            countries: this.countries,
            enableRateLimit: this.enableRateLimit,
            rateLimit: this.rateLimit,
            timeout: this.timeout,
            // 능력표는 이 클래스가 실제로 하는 것만 적는다. 나머지는 증권사 클래스가 `true`·`false` 로 밝힌다(`undefined` 는 아직 모른다는 뜻이다).
            has: {
                publicAPI: true,
                privateAPI: true,
                createLimitOrder: 'emulated',
                createMarketOrder: 'emulated',
                fetchMarkets: 'emulated',
                fetchCurrencies: 'emulated',
            },
            urls: {},
            requiredCredentials: {
                apiKey: true,
                secret: true,
                uid: false,
                accountId: false,
                login: false,
                password: false,
                twofa: false,
                privateKey: false,
                walletAddress: false,
                token: false,
            },
            markets: undefined,
            currencies: {},
            timeframes: undefined,
            fees: {
                trading: {},
                funding: { withdraw: {}, deposit: {} },
            },
            status: { status: 'ok' },
            httpExceptions: {
                422: ExchangeError,
                418: DDoSProtection,
                429: RateLimitExceeded,
                404: ExchangeNotAvailable,
                409: ExchangeNotAvailable,
                410: ExchangeNotAvailable,
                451: ExchangeNotAvailable,
                500: ExchangeNotAvailable,
                501: ExchangeNotAvailable,
                502: ExchangeNotAvailable,
                520: ExchangeNotAvailable,
                521: ExchangeNotAvailable,
                522: ExchangeNotAvailable,
                525: ExchangeNotAvailable,
                526: ExchangeNotAvailable,
                400: ExchangeNotAvailable,
                403: ExchangeNotAvailable,
                405: ExchangeNotAvailable,
                503: ExchangeNotAvailable,
                530: ExchangeNotAvailable,
                408: RequestTimeout,
                504: RequestTimeout,
                401: AuthenticationError,
                407: AuthenticationError,
                511: AuthenticationError,
            },
            commonCurrencies: {},
            precisionMode: TICK_SIZE,
            paddingMode: NO_PADDING,
            limits: {
                leverage: { min: undefined, max: undefined },
                amount: { min: undefined, max: undefined },
                price: { min: undefined, max: undefined },
                cost: { min: undefined, max: undefined },
            },
        };
    }

    /** 증권사별 기본 `options`. `describe().options` 가 이 값 위에 얹힌다. */
    getDefaultOptions(): Dict {
        return {};
    }

    afterConstruct(): void {
        if (this.markets !== undefined) this.setMarkets(this.markets);
        this.initRestRateLimiter();
        if (safeBool2(this.options, 'sandbox', 'testnet', false) === true) this.setSandboxMode(true);
    }

    // ============ 암묵 API ============

    /** `api` 트리를 돌며 엔드포인트마다 메서드를 만든다. 이름은 `이름들 + 대문자 시작 HTTP 메서드 + 경로 조각(대문자 시작)` 이다. */
    defineRestApi(api: Dict, methodName: string, paths: string[] = []): void {
        for (const key of Object.keys(api)) {
            const value = api[key];
            const lowercaseMethod = key.toLowerCase();
            const uppercaseMethod = key.toUpperCase();
            const camelcaseMethod = CAPITALIZE(lowercaseMethod);
            if (Array.isArray(value)) {
                for (const item of value) {
                    this.defineRestApiEndpoint(methodName, uppercaseMethod, camelcaseMethod, String(item).trim(), paths);
                }
            } else if (HTTP_METHOD_KEY.test(key)) {
                for (const endpoint of Object.keys(value)) {
                    const config = value[endpoint];
                    if (typeof config === 'object' && config !== null) {
                        this.defineRestApiEndpoint(methodName, uppercaseMethod, camelcaseMethod, endpoint.trim(), paths, config);
                    } else if (typeof config === 'number') {
                        this.defineRestApiEndpoint(methodName, uppercaseMethod, camelcaseMethod, endpoint.trim(), paths, { cost: config });
                    } else {
                        throw new NotSupported(`${this.id} defineRestApi() API leaf must be an object or a number`);
                    }
                }
            } else {
                this.defineRestApi(value, methodName, paths.concat([key]));
            }
        }
    }

    defineRestApiEndpoint(
        methodName: string,
        uppercaseMethod: string,
        camelcaseMethod: string,
        path: string,
        paths: string[],
        config: EndpointConfig = {},
    ): void {
        const suffix = path.split(/[^a-zA-Z0-9]/).map(CAPITALIZE).join('');
        const prefix = [paths[0]].concat(paths.slice(1).map(CAPITALIZE)).join('');
        const apiName: ApiName = paths.length > 1 ? paths : paths[0];
        this[prefix + camelcaseMethod + CAPITALIZE(suffix)] = async (params: Dict = {}) =>
            this[methodName](path, apiName, uppercaseMethod, params, undefined, undefined, config);
    }

    // ============ 요청 ============

    async request(
        path: string,
        api: ApiName = 'public',
        method = 'GET',
        params: Dict = {},
        headers: Dictionary<string> | undefined = undefined,
        body: string | undefined = undefined,
        config: EndpointConfig = {},
    ): Promise<any> {
        return this.fetch2(path, api, method, params, headers, body, config);
    }

    /** 이 `api` 이름이 비공개(자격증명이 필요한) 호출인가. 이름 배열이면 그 안에 `private` 이 있는지 본다. */
    isPrivateApi(api: ApiName): boolean {
        return Array.isArray(api) ? api.includes('private') : api === 'private';
    }

    /**
     * 요청 하나를 처리한다: (비공개면) 자격증명 확인 → `authenticate` → `throttle` → 재시도 루프 { `sign` → `fetch` }.
     *
     * 주문 요청(`config.order`)은 재시도하지 않고, 접수 여부를 모르는 실패를 `OrderOutcomeUnknown` 으로 바꿔 던진다.
     * 조회는 `OperationFailed` 계열이면서 `retryable !== false` 인 오류만 `maxRetriesOnFailure`(옵션 또는 `params`, 기본 0)번까지 다시 보낸다.
     */
    async fetch2(
        path: string,
        api: ApiName = 'public',
        method = 'GET',
        params: Dict = {},
        headers: Dictionary<string> | undefined = undefined,
        body: string | undefined = undefined,
        config: EndpointConfig = {},
    ): Promise<any> {
        const isOrder = safeBool(config, 'order', false);
        if (this.isPrivateApi(api)) {
            this.checkRequiredCredentials();
            await this.authenticate(path, api, method, params, headers, body);
        }
        if (this.enableRateLimit) {
            await this.throttle(this.calculateRateLimiterCost(api, method, path, params, config), safeString(config, 'bucket'));
        }
        let retries = 0;
        [retries, params] = this.handleOptionAndParams(params, path, 'maxRetriesOnFailure', retries);
        let retryDelay = 0;
        [retryDelay, params] = this.handleOptionAndParams(params, path, 'maxRetriesOnFailureDelay', retryDelay);
        if (isOrder) retries = 0;
        const timeout = isOrder && this.orderTimeout !== undefined ? this.orderTimeout : this.timeout;
        for (let attempt = 0; ; attempt++) {
            try {
                this.lastRestRequestTimestamp = now();
                const request = this.sign(path, api, method, params, headers, body);
                this.last_request_url = request.url;
                this.last_request_method = request.method;
                this.last_request_headers = request.headers;
                this.last_request_body = request.body;
                const response = await this.fetch(request.url, request.method, request.headers, request.body, timeout);
                if (isOrder && typeof response === 'string' && response.trim() !== '') {
                    throw new BadResponse(`${this.id} ${method} ${path} 주문 응답이 JSON 이 아니다: ${response.slice(0, 200)}`);
                }
                return response;
            } catch (e) {
                const error = isOrder && !(e instanceof OrderOutcomeUnknown) && this.isOutcomeUnknown(e)
                    ? new OrderOutcomeUnknown(`${this.id} ${method} ${path} 주문 요청이 접수됐는지 알 수 없다: ${errorMessage(e)}`, { cause: e })
                    : e;
                const retryable = error instanceof OperationFailed && error.retryable !== false;
                if (!retryable || attempt >= retries) throw error;
                this.log(`요청 실패, 다시 시도한다(${attempt + 1}/${retries}): ${errorMessage(error)}`);
                if (retryDelay > 0) await sleep(retryDelay);
            }
        }
    }

    /**
     * 주문 요청이 이 오류로 끝났을 때 접수 여부를 알 수 없는가. 시간 초과(`RequestTimeout` 계열), 응답을 받기 전에 연결이 끊긴 전송 오류
     * (`NetworkError` 그 자체), 증권사 오류 코드 없이 HTTP 상태만으로 만든 5xx 오류(`httpStatusError`), 해석할 수 없는 응답(`BadResponse`)이 해당한다.
     * 증권사 오류 코드로 분류한 오류(`RateLimitExceeded`·`MarketClosed` 등)는 거절이 확정된 것이므로 아니다.
     */
    isOutcomeUnknown(error: unknown): boolean {
        return error instanceof RequestTimeout
            || (error instanceof NetworkError && Object.getPrototypeOf(error) === NetworkError.prototype)
            || error instanceof BadResponse
            || (isObject(error) && (httpStatusErrors.get(error) ?? 0) >= 500);
    }

    /** HTTP 상태만 보고 오류를 만든다. 증권사 오류 코드로 분류하지 못한 응답에 쓰고, 주문 요청의 5xx 는 `isOutcomeUnknown` 이 접수 미상으로 본다. */
    httpStatusError(code: number, ErrorClassForStatus: ErrorClass, message: string, options?: BaseErrorOptions): Error {
        const error = new ErrorClassForStatus(message, options);
        httpStatusErrors.set(error, code);
        return error;
    }

    /**
     * 비공개 호출 앞에서 부르는 훅. 토큰 발급·갱신처럼 비동기 준비를 여기서 마친다(`sign` 이 동기라서 거기서는 못 한다).
     * 준비한 값(토큰 등)은 인스턴스나 `options` 에 두고 `sign` 이 읽는다. 기본 구현은 아무것도 하지 않는다.
     */
    async authenticate(
        _path: string,
        _api: ApiName,
        _method: string,
        _params: Dict,
        _headers: Dictionary<string> | undefined,
        _body: string | undefined,
    ): Promise<void> {
        // 증권사 클래스가 override 한다.
    }

    /**
     * 요청을 만든다. 기본 구현은 서명 없이 `urls.api`(문자열 또는 `api` 이름별 사전)에 경로를 붙이고, `GET`·`DELETE`·`HEAD` 는 쿼리로,
     * 그 밖의 메서드는 JSON 본문으로 보낸다. `api` 이름이 배열이면 첫 요소로 `urls.api` 를 찾는다. 증권사 클래스가 서명과 헤더를 더해 override 한다.
     */
    sign(
        path: string,
        api: ApiName = 'public',
        method = 'GET',
        params: Dict = {},
        headers: Dictionary<string> | undefined = undefined,
        body: string | undefined = undefined,
    ): SignedRequest {
        const key = Array.isArray(api) ? api[0] : api;
        const base = isDict(this.urls.api) ? this.urls.api[key] : this.urls.api;
        if (typeof base !== 'string') throw new ExchangeError(`${this.id} sign() 에 쓸 urls.api 가 없다: ${key}`);
        let url = implodeParams(base, { hostname: this.hostname }).replace(/\/+$/, '') + '/' + implodeParams(path, params);
        const query = omit(params, extractParams(path));
        if (method === 'GET' || method === 'DELETE' || method === 'HEAD') {
            if (Object.keys(query).length > 0) url += '?' + urlencode(query);
        } else if (body === undefined) {
            body = JSON.stringify(query);
            headers = extend({ 'Content-Type': 'application/json' }, headers);
        }
        return { url, method, headers, body };
    }

    /**
     * HTTP 요청을 보낸다. 호출할 때마다 `globalThis.fetch` 를 읽는다. `timeoutMs` 안에 응답 본문까지 읽지 못하면 `RequestTimeout`,
     * 연결이 끊기면 `NetworkError` 이다. 응답은 `handleRestResponse` 가 해석한다.
     */
    async fetch(
        url: string,
        method = 'GET',
        headers: Dictionary<string> | undefined = undefined,
        body: string | undefined = undefined,
        timeoutMs: number = this.timeout,
    ): Promise<any> {
        let requestHeaders: Dictionary<string> = extend(this.headers, headers);
        if (this.userAgent !== undefined) requestHeaders = extend({ 'User-Agent': this.userAgent }, requestHeaders);
        const fetchImplementation = globalThis.fetch;
        if (typeof fetchImplementation !== 'function') throw new NotSupported(`${this.id} 이 실행 환경에는 fetch 가 없다`);
        if (this.verbose) this.log(`${this.id} ${method} ${url}`, { headers: requestHeaders, body });

        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new RequestTimeout(`${this.id} ${method} ${url} 요청이 ${timeoutMs}ms 안에 끝나지 않았다`));
            }, timeoutMs);
        });
        let response: HttpResponseLike;
        try {
            const exchange = (async (): Promise<HttpResponseLike> => {
                // 리다이렉트를 따르지 않는다. 따르면 앱키와 시크릿 헤더, 토큰 발급 본문을 다른 호스트로 다시 보낸다. 3xx 는 오류로 던진다.
                const res = await fetchImplementation(url, { method, headers: requestHeaders, body, redirect: 'manual', signal: controller.signal as FetchSignal });
                // 본문까지 읽어야 시간 상한이 끝난다. 이미 읽은 본문으로 다시 응답을 만들어 넘긴다.
                const text = await res.text();
                return { status: res.status, statusText: res.statusText, headers: res.headers, text: async () => text };
            })();
            response = await Promise.race([exchange, timedOut]);
        } catch (e) {
            if (e instanceof RequestTimeout) throw e;
            const name = isObject(e) ? e.name : undefined;
            if (name === 'AbortError' || name === 'TimeoutError') {
                throw new RequestTimeout(`${this.id} ${method} ${url} 요청이 ${timeoutMs}ms 안에 끝나지 않았다`, { cause: e });
            }
            throw new NetworkError(`${this.id} ${method} ${url} 연결에 실패했다: ${errorMessage(e)}`, { cause: e });
        } finally {
            clearTimeout(timer);
        }
        return this.handleRestResponse(response, url, method, requestHeaders, body);
    }

    /** 응답 본문을 JSON 으로 읽고 `handleErrors` → `handleHttpStatusCode` 순으로 오류를 가린다. 오류가 없으면 파싱한 본문(JSON 이 아니면 원문)을 돌려준다. */
    async handleRestResponse(
        response: HttpResponseLike,
        url: string,
        method = 'GET',
        requestHeaders: Dictionary<string> | undefined = undefined,
        requestBody: string | undefined = undefined,
    ): Promise<any> {
        const responseHeaders = this.getResponseHeaders(response.headers);
        const responseBody = await response.text();
        const parsedBody = this.parseJson(responseBody);
        this.last_response_headers = responseHeaders;
        this.last_http_response = responseBody;
        this.last_json_response = parsedBody;
        if (this.verbose) this.log(`${this.id} ${method} ${url} -> ${response.status}`, { headers: responseHeaders, body: responseBody });
        const handled = this.handleErrors(
            response.status, response.statusText, url, method, responseHeaders, responseBody, parsedBody, requestHeaders, requestBody,
        );
        if (handled === undefined) this.handleHttpStatusCode(response.status, response.statusText, url, method, responseBody);
        return parsedBody !== undefined ? parsedBody : responseBody;
    }

    /**
     * 증권사 응답의 오류 봉투를 오류 클래스로 던진다. 던지지 않고 `undefined` 를 돌려주면 HTTP 상태 표(`httpExceptions`)가 이어서 본다.
     * 상태 표를 건너뛰려면 `true` 를 돌려준다. 기본 구현은 아무것도 하지 않는다.
     */
    handleErrors(
        _statusCode: number,
        _statusText: string,
        _url: string,
        _method: string,
        _responseHeaders: Dictionary<string>,
        _responseBody: string,
        _response: unknown,
        _requestHeaders: Dictionary<string> | undefined,
        _requestBody: string | undefined,
    ): boolean | undefined {
        return undefined;
    }

    /** 상태 표(`httpExceptions`)의 오류를 던진다. 표에 없는 3xx(따르지 않은 리다이렉트)와 5xx 는 `ExchangeNotAvailable` 이다. */
    handleHttpStatusCode(code: number, reason: string, url: string, method: string, body: string): void {
        const ErrorClassForStatus = this.httpExceptions[String(code)] ?? (code >= 500 || (code >= 300 && code < 400) ? ExchangeNotAvailable : undefined);
        if (ErrorClassForStatus !== undefined) {
            throw this.httpStatusError(code, ErrorClassForStatus, `${this.id} ${method} ${url} ${code} ${reason} ${body}`);
        }
    }

    parseJson(text: string): unknown {
        const trimmed = text.trim();
        if (trimmed.length < 2 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
        try {
            return JSON.parse(trimmed);
        } catch {
            return undefined;
        }
    }

    getResponseHeaders(headers: unknown): Dictionary<string> {
        const result: Dictionary<string> = {};
        const capitalizeWords = (key: string): string => key.split('-').map(CAPITALIZE).join('-');
        if (headers !== null && typeof headers === 'object' && typeof (headers as Headers).forEach === 'function') {
            (headers as Headers).forEach((value, key) => { result[capitalizeWords(key)] = value; });
        } else if (isObject(headers)) {
            for (const key of Object.keys(headers)) {
                const value = headers[key];
                result[capitalizeWords(key)] = Array.isArray(value) ? value.join(', ') : String(value);
            }
        }
        return result;
    }

    // ---- 오류 매핑 ----

    /** `exact` 표에 이 문자열이 키로 있으면 그 오류를 던진다. */
    throwExactlyMatchedException(exact: Dictionary<ErrorClass> | undefined, text: Str, message: string, options?: BaseErrorOptions): void {
        if (exact === undefined || text === undefined) return;
        if (Object.prototype.hasOwnProperty.call(exact, text)) throw new exact[text](message, options);
    }

    /** `broad` 표의 키 중 이 문자열에 들어 있는 첫 번째(선언 순서)의 오류를 던진다. */
    throwBroadlyMatchedException(broad: Dictionary<ErrorClass> | undefined, text: Str, message: string, options?: BaseErrorOptions): void {
        if (broad === undefined) return;
        const broadKey = this.findBroadlyMatchedKey(broad, text);
        if (broadKey !== undefined) throw new broad[broadKey](message, options);
    }

    findBroadlyMatchedKey(broad: Dictionary<ErrorClass>, text: Str): Str {
        if (text === undefined) return undefined;
        return Object.keys(broad).find((key) => text.indexOf(key) >= 0);
    }

    // ---- 속도 제한 ----

    calculateRateLimiterCost(_api: ApiName, _method: string, _path: string, _params: Dict, config: Dict = {}): number {
        return safeNumber(config, 'cost', 1) as number;
    }

    initRestRateLimiter(): void {
        if (this.rateLimit === undefined || this.rateLimit < 0) {
            throw new ExchangeError(`${this.id}.rateLimit 이 설정되지 않았다`);
        }
        this.throttler = this.newThrottler(this.rateLimit);
        this.bucketThrottlers = {};
        for (const [bucket, { rateLimit }] of Object.entries(this.rateLimitBuckets)) {
            this.bucketThrottlers[bucket] = this.newThrottler(rateLimit);
        }
    }

    /** `rateLimit` 이 0 이면 기다릴 이유가 없으므로 조절기를 만들지 않는다. */
    private newThrottler(rateLimit: number): Throttler | undefined {
        return rateLimit > 0 ? new Throttler({ refillRate: 1 / rateLimit, capacity: 1, cost: 1 }) : undefined;
    }

    /** 요청 하나가 들어가기 전에 자기 차례와 간격을 기다린다. `bucket` 이 있으면 그 버킷의 한도를 쓴다. */
    async throttle(cost: Num = undefined, bucket: Str = undefined): Promise<void> {
        if (bucket !== undefined && !(bucket in this.bucketThrottlers)) {
            throw new ExchangeError(`${this.id} 에 없는 rateLimitBuckets 이름이다: ${bucket}`);
        }
        const throttler = bucket === undefined ? this.throttler : this.bucketThrottlers[bucket];
        await throttler?.throttle(cost);
    }

    // ============ 설정 ============

    /** 필수 자격증명이 비어 있으면 `AuthenticationError`(또는 `error = false` 면 `false`). */
    checkRequiredCredentials(error = true): boolean {
        for (const key of Object.keys(this.requiredCredentials)) {
            const credentialValue = this[key];
            const missing = credentialValue === undefined || credentialValue === null || credentialValue === false || credentialValue === '';
            if (this.requiredCredentials[key] === true && missing) {
                if (error) throw new AuthenticationError(`${this.id} requires "${key}" credential`);
                return false;
            }
        }
        return true;
    }

    /** 모의 환경으로 바꾼다. `urls.test` 가 없는 증권사는 `NotSupported`. 끄면 원래 URL 로 되돌린다. */
    setSandboxMode(enabled: boolean): void {
        if (enabled) {
            if (this.urls.test === undefined) throw new NotSupported(`${this.id} 에는 모의 환경 URL 이 없다`);
            this.urls.apiBackup = cloneUrls(this.urls.api);
            this.urls.api = cloneUrls(this.urls.test);
            this.isSandboxModeEnabled = true;
        } else if (this.urls.apiBackup !== undefined) {
            this.urls.api = cloneUrls(this.urls.apiBackup);
            this.urls = omit(this.urls, 'apiBackup');
            this.isSandboxModeEnabled = false;
        }
    }

    /**
     * 옵션 하나를 `params` → `options[methodName]` → `options` → 기본값 순으로 찾는다(`defaultXxx` 이름도 함께 본다).
     * `params` 에서 찾았으면 그 키를 뺀 `params` 를 돌려주므로 요청에 새어 들어가지 않는다.
     */
    handleOptionAndParams<T = any>(params: Dict, methodName: Str, optionName: string, defaultValue?: T): [T, Dict] {
        const defaultOptionName = 'default' + CAPITALIZE(optionName);
        let value = safeValue2(params, optionName, defaultOptionName);
        if (value !== undefined) {
            params = omit(params, [optionName, defaultOptionName]);
        } else {
            const methodOptions = safeValue(this.options, methodName);
            if (methodOptions !== undefined) value = safeValue2(methodOptions, optionName, defaultOptionName);
            if (value === undefined) value = safeValue2(this.options, optionName, defaultOptionName);
            if (value === undefined) value = defaultValue;
        }
        return [value as T, params];
    }

    /** `verbose` 일 때만 쓰는 디버그 로그. */
    log(message: string, context?: Dict): void {
        if (this.verbose) logger.debug(message, context);
    }

    // ============ 인스턴스 옵션 ============

    /** `options.tokenStore` 가 가리키는 토큰 저장소. 없으면 `null` 이고, 값이 함수면 부를 때마다 호출한다. */
    getTokenStore(): BrokerTokenStore | null {
        return resolveTokenStore(this.options.tokenStore);
    }

    /** 켜고 끄는 옵션(`nxtRouting` 등)이 켜져 있는가. 불리언이거나 불리언을 돌려주는 함수를 받는다. 값이 없으면 꺼진 것이다. */
    async isOptionEnabled(name: string): Promise<boolean> {
        return resolveFlag(this.options[name]);
    }

    /**
     * 접수 뒤 체결을 확정할 때 쓰는 조회 예산. `options.confirmBudget`(객체이거나 객체를 돌려주는 함수)이 증권사가 정한 기본값 `defaults` 를
     * 이긴다. 범위를 벗어난 값은 무시하고 아래 층의 값을 쓴다.
     */
    getConfirmBudget(defaults?: Partial<ConfirmBudget>): ConfirmBudget {
        // 주문을 보낸 뒤에 부르므로 던지지 않는다. 던지면 접수된 주문이 실패처럼 보인다.
        let overrides: unknown;
        try {
            const option = this.options.confirmBudget;
            overrides = typeof option === 'function' ? option() : option;
        } catch (e) {
            logger.warn({ error: errorMessage(e) }, `[${this.id}] options.confirmBudget 이 던져 기본 예산을 쓴다`);
        }
        if (overrides instanceof Promise) overrides.catch(() => undefined);
        return resolveConfirmBudget(defaults, isDict(overrides) ? overrides as Partial<ConfirmBudget> : undefined);
    }

    // ============ 종목 ============

    async loadMarkets(reload = false, params: Dict = {}): Promise<Dictionary<MarketInterface>> {
        if ((reload && !this.reloadingMarkets) || this.marketsLoading === undefined) {
            this.reloadingMarkets = true;
            this.marketsLoading = this.loadMarketsHelper(reload, params).then(
                (resolved) => {
                    this.reloadingMarkets = false;
                    return resolved;
                },
                (error) => {
                    this.reloadingMarkets = false;
                    this.marketsLoading = undefined;
                    throw error;
                },
            );
        }
        return this.marketsLoading;
    }

    async loadMarketsHelper(reload = false, params: Dict = {}): Promise<Dictionary<MarketInterface>> {
        if (!reload && this.markets !== undefined) {
            if (this.markets_by_id === undefined) return this.setMarkets(this.markets);
            return this.markets;
        }
        // `has.fetchCurrencies` 가 `true` 인 증권사만 통화 목록을 따로 받는다(`'emulated'` 는 받지 않는다).
        const currencies = this.has.fetchCurrencies === true ? await this.fetchCurrencies() : undefined;
        const markets = await this.fetchMarkets(params);
        return this.setMarkets(markets, currencies);
    }

    /** 증권사 클래스가 override 해 종목 목록을 받아 `parseMarkets` 로 돌려준다. 기본은 이미 넣어 둔 종목을 돌려준다. */
    async fetchMarkets(_params: Dict = {}): Promise<MarketInterface[]> {
        return Object.values(this.markets ?? {});
    }

    async fetchCurrencies(_params: Dict = {}): Promise<Currencies> {
        return this.currencies;
    }

    parseMarket(_market: Dict): MarketInterface {
        throw new NotSupported(`${this.id} parseMarket() is not supported yet`);
    }

    parseMarkets(markets: Dict[] | Dict | undefined): MarketInterface[] {
        return toArray(markets).map((market) => this.parseMarket(market));
    }

    /** 종목 목록을 넣고 색인(`markets`·`markets_by_id`·`symbols`·`ids`)과 통화 목록을 다시 만든다. */
    setMarkets(markets: MarketInterface[] | Dictionary<MarketInterface>, currencies: Currencies | undefined = undefined): Dictionary<MarketInterface> {
        const marketsById: Dictionary<MarketInterface[]> = {};
        const values: MarketInterface[] = [];
        // 같은 id 가 여러 종목에 걸리면 spot 이 앞에 오도록 먼저 정렬한다.
        for (const value of sortBy(toArray(markets), 'spot', true, true) as MarketInterface[]) {
            if (value.id === undefined) throw new ExchangeError(`${this.id} setMarkets() 종목에 id 가 없다: ${value.symbol}`);
            // 값이 `undefined` 인 키는 기본 수수료를 덮어쓰지 않도록 뺀다.
            const defined: Dict = {};
            for (const key of Object.keys(value)) {
                if ((value as Dict)[key] !== undefined) defined[key] = (value as Dict)[key];
            }
            const market: MarketInterface = deepExtend(
                this.safeMarketStructure(), { precision: this.precision, limits: this.limits }, this.fees.trading, defined,
            );
            (marketsById[value.id] ??= []).push(market);
            values.push(market);
        }
        this.markets_by_id = marketsById;
        this.markets = indexBy(values, 'symbol');
        this.symbols = Object.keys(keysort(this.markets));
        this.ids = Object.keys(keysort(marketsById));
        this.currencies = deepExtend(
            currencies !== undefined && Object.keys(currencies).length > 0 ? currencies : this.currenciesFromMarkets(values),
            this.currencies,
        );
        this.currencies_by_id = indexBy(this.currencies, 'id') as Dictionary<CurrencyInterface>;
        this.codes = Object.keys(keysort(this.currencies));
        return this.markets;
    }

    /** 종목의 `base`·`quote` 에서 통화 목록을 만든다. 같은 코드가 여러 번 나오면 정밀도가 가장 촘촘한 것을 남긴다. */
    private currenciesFromMarkets(markets: MarketInterface[]): Dictionary<CurrencyInterface> {
        const defaultPrecision = this.precisionMode === DECIMAL_PLACES ? DEFAULT_CURRENCY_DECIMALS : (parseNumber(DEFAULT_CURRENCY_TICK) as number);
        const finer = (a: number, b: number): boolean => (this.precisionMode === TICK_SIZE ? a < b : a > b);
        const result: Dictionary<CurrencyInterface> = {};
        const add = (code: string, id: Str, precision: Num): void => {
            const currency: CurrencyInterface = { id: id ?? code, code, precision: precision ?? defaultPrecision, info: undefined };
            const existing = result[code];
            if (existing === undefined || finer(currency.precision as number, existing.precision as number)) result[code] = currency;
        };
        for (const market of markets) {
            add(market.base, market.baseId, market.precision.base ?? market.precision.amount);
            add(market.quote, market.quoteId, market.precision.quote ?? market.precision.price);
        }
        return keysort(result) as Dictionary<CurrencyInterface>;
    }

    /** 빈 종목 골격. 모르는 값은 `undefined` 이고, 현물이면 파생 관련 플래그를 `false` 로 채운다. */
    safeMarketStructure(market: Dict | undefined = undefined): MarketInterface {
        const clean: Dict = {
            id: undefined, lowercaseId: undefined, symbol: undefined, base: undefined, quote: undefined, settle: undefined,
            baseId: undefined, quoteId: undefined, settleId: undefined, type: undefined,
            spot: undefined, margin: undefined, swap: undefined, future: undefined, option: undefined, index: undefined,
            active: undefined, contract: undefined, linear: undefined, inverse: undefined, subType: undefined,
            taker: undefined, maker: undefined, contractSize: undefined, expiry: undefined, expiryDatetime: undefined,
            strike: undefined, optionType: undefined,
            precision: { amount: undefined, price: undefined, cost: undefined, base: undefined, quote: undefined },
            limits: {
                leverage: { min: undefined, max: undefined },
                amount: { min: undefined, max: undefined },
                price: { min: undefined, max: undefined },
                cost: { min: undefined, max: undefined },
            },
            created: undefined,
            info: undefined,
        };
        const result = extend(clean, market);
        if (result.spot === true) {
            for (const key of ['contract', 'swap', 'future', 'option', 'index']) {
                if (result[key] === undefined) result[key] = false;
            }
        }
        return result as MarketInterface;
    }

    /** 통합 심볼(없으면 id 도)로 종목을 찾는다. 종목이 로드되지 않았으면 `ExchangeError`, 못 찾으면 `BadSymbol`. */
    market(symbol: Str): MarketInterface {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} market() requires a symbol argument`);
        if (this.markets === undefined) throw new ExchangeError(`${this.id} markets not loaded`);
        const bySymbol = this.markets[symbol];
        if (bySymbol !== undefined) return bySymbol;
        const byId = this.markets_by_id?.[symbol];
        if (byId !== undefined) {
            const defaultType = safeString2(this.options, 'defaultType', 'defaultSubType', 'spot') as string;
            return byId.find((candidate) => (candidate as Dict)[defaultType] === true) ?? byId[0];
        }
        throw new BadSymbol(`${this.id} does not have market symbol ${symbol}`);
    }

    /** 통합 심볼 → 증권사 종목 id. */
    marketId(symbol: Str): Str {
        return this.market(symbol).id;
    }

    /** 통합 심볼(또는 id) → 통합 심볼. */
    symbol(symbol: Str): string {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} symbol() requires a symbol argument`);
        return safeString(this.market(symbol), 'symbol', symbol);
    }

    marketIds(symbols: Strings = undefined): Strings {
        return symbols === undefined ? undefined : symbols.map((symbol) => this.marketId(symbol) as string);
    }

    /** 심볼 배열을 검증해 통합 심볼로 돌려준다. `undefined` 는 `allowEmpty` 면 그대로 돌려준다. */
    marketSymbols(symbols: Strings = undefined, allowEmpty = true): Strings {
        if (symbols === undefined) {
            if (!allowEmpty) throw new ArgumentsRequired(`${this.id} empty list of symbols is not supported`);
            return symbols;
        }
        if (symbols.length === 0) {
            if (!allowEmpty) throw new ArgumentsRequired(`${this.id} empty list of symbols is not supported`);
            return symbols;
        }
        return symbols.map((symbol) => this.symbol(symbol));
    }

    /**
     * 응답의 종목 id 를 종목으로 바꾼다. 로드한 종목에 있으면 그것을, 없으면 `delimiter` 로 쪼개 임시 종목을 만들고,
     * 그것도 안 되면 `market` 인자를(없으면 빈 골격을) 돌려준다. 같은 id 의 종목이 둘 이상이면 `marketType` 으로 고른다.
     */
    safeMarket(marketId: Str = undefined, market: Market = undefined, delimiter: Str = undefined, marketType: Str = undefined): MarketInterface {
        if (marketId !== undefined) {
            const candidates = this.markets_by_id?.[marketId];
            if (candidates !== undefined) {
                if (candidates.length === 1) return candidates[0];
                const type = marketType ?? market?.type;
                if (type === undefined) {
                    throw new ArgumentsRequired(`${this.id} safeMarket() requires a fourth argument for ${marketId} to disambiguate between different markets with the same market id`);
                }
                const match = candidates.find((candidate) => (candidate as Dict)[type] === true);
                if (match !== undefined) return match;
            } else if (delimiter !== undefined && delimiter !== '') {
                const parts = marketId.split(delimiter);
                const result = this.safeMarketStructure({ symbol: marketId, marketId });
                if (parts.length === 2) {
                    const baseId = parts[0];
                    const quoteId = parts[1];
                    const base = this.safeCurrencyCode(baseId);
                    const quote = this.safeCurrencyCode(quoteId);
                    result.baseId = baseId;
                    result.quoteId = quoteId;
                    if (base !== undefined) result.base = base;
                    if (quote !== undefined) result.quote = quote;
                    if (base !== undefined && quote !== undefined) result.symbol = base + '/' + quote;
                }
                return result;
            }
        }
        if (market !== undefined) return market;
        return this.safeMarketStructure({ symbol: marketId, marketId });
    }

    safeSymbol(marketId: Str = undefined, market: Market = undefined, delimiter: Str = undefined, marketType: Str = undefined): string {
        return this.safeMarket(marketId, market, delimiter, marketType).symbol;
    }

    // ---- 통화 ----

    commonCurrencyCode(code: string): string {
        return safeString(this.commonCurrencies, code, code);
    }

    safeCurrency(currencyId: Str, currency: Currency = undefined): CurrencyInterface {
        if (currencyId === undefined && currency !== undefined) return currency;
        const known = currencyId === undefined ? undefined : this.currencies_by_id?.[currencyId];
        if (known !== undefined) return known;
        const code = currencyId === undefined ? undefined : this.commonCurrencyCode(currencyId.toUpperCase());
        return { id: currencyId as string, code: code as string, precision: undefined, info: undefined };
    }

    safeCurrencyCode(currencyId: Str, currency: Currency = undefined): Str {
        return this.safeCurrency(currencyId, currency).code;
    }

    // ============ 정밀도 ============

    isTickPrecision(): boolean {
        return this.precisionMode === TICK_SIZE;
    }

    /**
     * 가격을 종목의 정밀도로 반올림한 문자열. 종목에 가격 정밀도가 없으면(가격대별 호가 단위처럼 하나의 값으로 못 적는 경우) 손대지 않고 돌려준다.
     * 그런 증권사 클래스는 호가 단위 표를 써서 override 한다. 결과가 0 이면 `InvalidOrder`.
     */
    priceToPrecision(symbol: Str, price: number | string | undefined): Str {
        if (price === undefined) return undefined;
        const market = this.market(symbol);
        const tick = market.precision.price;
        if (tick === undefined) return numberToString(price);
        const result = decimalToPrecision(price, ROUND, tick, this.precisionMode, this.paddingMode);
        if (result === '0') {
            throw new InvalidOrder(`${this.id} price of ${market.symbol} must be greater than minimum price precision of ${numberToString(tick)}`);
        }
        return result;
    }

    /** 수량을 종목의 정밀도로 버림한 문자열. 정밀도가 없으면 손대지 않고, 결과가 0 이면 `InvalidOrder`. */
    amountToPrecision(symbol: Str, amount: number | string | undefined): Str {
        if (amount === undefined) return undefined;
        const market = this.market(symbol);
        const step = market.precision.amount;
        if (step === undefined) return numberToString(amount);
        const result = decimalToPrecision(amount, TRUNCATE, step, this.precisionMode, this.paddingMode);
        if (result === '0') {
            throw new InvalidOrder(`${this.id} amount of ${market.symbol} must be greater than minimum amount precision of ${numberToString(step)}`);
        }
        return result;
    }

    /** 금액을 버림한 문자열. 종목의 `precision.cost`, 없으면 `precision.price` 를 쓴다. 정밀도가 없으면 손대지 않는다. */
    costToPrecision(symbol: Str, cost: number | string | undefined): Str {
        if (cost === undefined) return undefined;
        const market = this.market(symbol);
        const step = market.precision.cost ?? market.precision.price;
        if (step === undefined) return numberToString(cost);
        return decimalToPrecision(cost, TRUNCATE, step, this.precisionMode, this.paddingMode);
    }

    // ============ 응답 정리(safe*·parse*) ============

    /**
     * 시세 응답을 통합 구조로 정리한다. 값은 문자열로 넘기면 되고, `open`·`close`·`change`·`percentage`·`average`·`vwap` 중
     * 빠진 것은 있는 값으로 계산해 채운다. 시각과 심볼은 채우지 않으므로 `parseTicker` 가 넣는다.
     */
    safeTicker(ticker: Dict, market: Market = undefined): Ticker {
        let open = omitZero(safeString(ticker, 'open'));
        let close = omitZero(safeString2(ticker, 'close', 'last'));
        let change = safeString(ticker, 'change'); // 보합이면 0 이 정상 값이라 0 을 비우지 않는다
        let percentage = omitZero(safeString(ticker, 'percentage'));
        let average = omitZero(safeString(ticker, 'average'));
        let vwap = safeString(ticker, 'vwap');
        const baseVolume = safeString(ticker, 'baseVolume');
        const quoteVolume = safeString(ticker, 'quoteVolume');
        if (vwap === undefined) vwap = Precise.stringDiv(omitZero(quoteVolume), baseVolume);
        if (change !== undefined) {
            if (close === undefined && average !== undefined) close = Precise.stringAdd(average, Precise.stringDiv(change, '2'));
            if (open === undefined && close !== undefined) open = Precise.stringSub(close, change);
        } else if (percentage !== undefined) {
            const ratio = Precise.stringAdd('1', Precise.stringDiv(percentage, RATIO_TO_PERCENT));
            if (close === undefined && average !== undefined) {
                const openAddClose = Precise.stringMul(average, '2');
                const denominator = Precise.stringAdd('2', Precise.stringDiv(percentage, RATIO_TO_PERCENT));
                const calcOpen = open !== undefined ? open : Precise.stringDiv(openAddClose, denominator);
                close = Precise.stringMul(calcOpen, ratio);
            }
            if (open === undefined && close !== undefined) open = Precise.stringDiv(close, ratio);
        }
        if (change === undefined) {
            if (close !== undefined && open !== undefined) {
                change = Precise.stringSub(close, open);
            } else if (close !== undefined && percentage !== undefined) {
                change = Precise.stringMul(Precise.stringDiv(percentage, RATIO_TO_PERCENT), Precise.stringDiv(close, RATIO_TO_PERCENT));
            } else if (open !== undefined && percentage !== undefined) {
                change = Precise.stringMul(open, Precise.stringDiv(percentage, RATIO_TO_PERCENT));
            }
        }
        if (open !== undefined) {
            if (percentage === undefined && change !== undefined) percentage = Precise.stringMul(Precise.stringDiv(change, open), RATIO_TO_PERCENT);
            if (close === undefined && change !== undefined) close = Precise.stringAdd(open, change);
            if (close === undefined && average !== undefined) close = Precise.stringSub(Precise.stringMul(average, '2'), open);
            if (average === undefined && close !== undefined) {
                let digits = 18;
                if (market !== undefined && this.isTickPrecision()) {
                    const priceTick = safeString(market.precision, 'price');
                    if (priceTick !== undefined) digits = precisionFromString(priceTick);
                }
                average = Precise.stringDiv(Precise.stringAdd(open, close), '2', digits);
            }
        }
        const closeParsed = parseNumber(omitZero(close));
        return extend(ticker, {
            bid: parseNumber(omitZero(safeString(ticker, 'bid'))),
            bidVolume: safeNumber(ticker, 'bidVolume'),
            ask: parseNumber(omitZero(safeString(ticker, 'ask'))),
            askVolume: safeNumber(ticker, 'askVolume'),
            high: parseNumber(omitZero(safeString(ticker, 'high'))),
            low: parseNumber(omitZero(safeString(ticker, 'low'))),
            open: parseNumber(omitZero(open)),
            close: closeParsed,
            last: closeParsed,
            change: parseNumber(change),
            percentage: parseNumber(percentage),
            average: parseNumber(average),
            vwap: parseNumber(vwap),
            baseVolume: parseNumber(baseVolume),
            quoteVolume: parseNumber(quoteVolume),
            previousClose: safeNumber(ticker, 'previousClose'),
            indexPrice: safeNumber(ticker, 'indexPrice'),
            markPrice: safeNumber(ticker, 'markPrice'),
        }) as Ticker;
    }

    /**
     * 체결 응답을 정리한다: 금액이 없으면 가격 × 수량으로 계산하고, 수수료를 `fee`·`fees` 로 맞추고, 수치를 `number` 로 바꾼다.
     * 입력 객체를 바꿔 돌려준다.
     */
    safeTrade(trade: Dict, market: Market = undefined): Trade {
        const amount = safeString(trade, 'amount');
        const price = safeString(trade, 'price');
        let cost = safeString(trade, 'cost');
        if (cost === undefined) {
            const contractSize = safeString(market, 'contractSize');
            let multiplyPrice = price;
            if (contractSize !== undefined) {
                if (safeBool(market, 'inverse', false) === true) multiplyPrice = Precise.stringDiv('1', price);
                multiplyPrice = Precise.stringMul(multiplyPrice, contractSize);
            }
            cost = Precise.stringMul(multiplyPrice, amount);
        }
        const [fee, fees] = this.parsedFeeAndFees(trade);
        trade.fee = fee;
        trade.fees = fees;
        trade.amount = parseNumber(amount);
        trade.price = parseNumber(price);
        trade.cost = parseNumber(cost);
        return trade as Trade;
    }

    /**
     * 주문 응답을 정리한다. 있는 값에서 빠진 값을 계산해 채운다(`amount = filled + remaining`, `filled = amount − remaining`,
     * `remaining = amount − filled`, 체결 목록이 있으면 `filled`·`cost`·수수료 합산, `average = cost / filled`, `cost = filled × (average ?? price)`,
     * 시장가에서 `price` 가 비면 `average`, 시장가의 `timeInForce` 기본값 `IOC`). 수치는 `number` 로 바꾼다. 입력의 나머지 키(`info` 등)는 그대로 둔다.
     * 체결 목록은 파싱 전 원본(`trades`)을 넘긴다.
     */
    safeOrder(order: Dict, market: Market = undefined): Order {
        let amount = omitZero(safeString(order, 'amount'));
        let remaining = safeString(order, 'remaining');
        let filled = safeString(order, 'filled');
        let cost = safeString(order, 'cost');
        let average = omitZero(safeString(order, 'average'));
        let price = omitZero(safeString(order, 'price'));
        let lastTradeTimestamp = safeInteger(order, 'lastTradeTimestamp');
        let symbol = safeString(order, 'symbol');
        let side = safeString(order, 'side');
        const status = safeString(order, 'status');
        const parseFilled = filled === undefined;
        const parseCost = cost === undefined;
        const parseLastTradeTimestamp = lastTradeTimestamp === undefined;
        const fee = safeValue(order, 'fee');
        const parseFee = fee === undefined;
        const parseFees = safeValue(order, 'fees') === undefined;
        const parseSymbol = symbol === undefined;
        const parseSide = side === undefined;
        const shouldParseFees = parseFee || parseFees;
        const fees: Dict[] = safeList(order, 'fees', []);
        let trades: Dict[] = [];
        const isTriggerOrder = safeString(order, 'triggerPrice') !== undefined || safeString(order, 'stopLossPrice') !== undefined
            || safeString(order, 'takeProfitPrice') !== undefined;
        if (parseFilled || parseCost || shouldParseFees) {
            const rawTrades = safeValue(order, 'trades', []);
            const firstTrade = safeValue(rawTrades, 0);
            // 이미 통합 구조로 파싱된 체결이면 그대로 쓴다.
            const tradesAreParsed = firstTrade !== undefined && 'info' in firstTrade && 'id' in firstTrade;
            trades = tradesAreParsed ? rawTrades : this.parseTrades(rawTrades, market);
            if (Array.isArray(trades) && trades.length > 0) {
                // 체결에 있는 값을 주문으로 끌어올린다.
                if (order.symbol === undefined) order.symbol = trades[0].symbol;
                if (order.side === undefined) order.side = trades[0].side;
                if (order.type === undefined) order.type = trades[0].type;
                if (order.id === undefined) order.id = trades[0].order;
                if (parseFilled) filled = '0';
                if (parseCost) cost = '0';
                for (const trade of trades) {
                    const tradeAmount = safeString(trade, 'amount');
                    if (parseFilled && tradeAmount !== undefined) filled = Precise.stringAdd(filled, tradeAmount);
                    const tradeCost = safeString(trade, 'cost');
                    if (parseCost && tradeCost !== undefined) cost = Precise.stringAdd(cost, tradeCost);
                    if (parseSymbol) symbol = safeString(trade, 'symbol');
                    if (parseSide) side = safeString(trade, 'side');
                    const tradeTimestamp = safeValue(trade, 'timestamp');
                    if (parseLastTradeTimestamp && tradeTimestamp !== undefined) {
                        lastTradeTimestamp = lastTradeTimestamp === undefined ? tradeTimestamp : Math.max(lastTradeTimestamp, tradeTimestamp);
                    }
                    if (shouldParseFees) {
                        const tradeFees = safeValue(trade, 'fees');
                        if (tradeFees !== undefined) {
                            for (const tradeFee of tradeFees) fees.push(extend({}, tradeFee));
                        } else {
                            const tradeFee = safeValue(trade, 'fee');
                            if (tradeFee !== undefined) fees.push(extend({}, tradeFee));
                        }
                    }
                }
            }
        }
        if (shouldParseFees) {
            const reducedFees = this.reduceFees ? this.reduceFeesByCurrency(fees) : fees;
            for (const reduced of reducedFees) {
                reduced.cost = safeNumber(reduced, 'cost');
                if ('rate' in reduced) reduced.rate = safeNumber(reduced, 'rate');
            }
            if (!parseFee && reducedFees.length === 0) {
                const feeCopy = deepExtend(fee);
                feeCopy.cost = safeNumber(feeCopy, 'cost');
                if ('rate' in feeCopy) feeCopy.rate = safeNumber(feeCopy, 'rate');
                reducedFees.push(feeCopy);
            }
            order.fees = reducedFees;
            if (parseFee && reducedFees.length === 1) order.fee = reducedFees[0];
        }
        if (amount === undefined) {
            if (filled !== undefined && remaining !== undefined) amount = Precise.stringAdd(filled, remaining);
            else if (status === 'closed') amount = filled;
        }
        if (filled === undefined) {
            if (amount !== undefined && remaining !== undefined) filled = Precise.stringSub(amount, remaining);
            else if (status === 'closed' && amount !== undefined) filled = amount;
        }
        if (remaining === undefined) {
            if (amount !== undefined && filled !== undefined) remaining = Precise.stringSub(amount, filled);
            else if (status === 'closed') remaining = '0';
        }
        // 평균가와 금액. 선물이면 계약 승수(`contractSize`)를 곱한다.
        const inverse = safeBool(market, 'inverse', false);
        const contractSize = numberToString(safeValue(market, 'contractSize', 1));
        if (average === undefined && filled !== undefined && cost !== undefined && Precise.stringGt(filled, '0')) {
            const filledTimesContractSize = Precise.stringMul(filled, contractSize);
            average = inverse === true ? Precise.stringDiv(filledTimesContractSize, cost) : Precise.stringDiv(cost, filledTimesContractSize);
        }
        if (parseCost && filled !== undefined && (average !== undefined || price !== undefined)) {
            const multiplyPrice = average === undefined ? price : average;
            const filledTimesContractSize = Precise.stringMul(filled, contractSize);
            cost = inverse === true ? Precise.stringDiv(filledTimesContractSize, multiplyPrice) : Precise.stringMul(filledTimesContractSize, multiplyPrice);
        }
        const orderType = safeValue(order, 'type');
        const emptyPrice = price === undefined || Precise.stringEquals(price, '0');
        if (emptyPrice && orderType === 'market') price = average;
        // 이 시점의 체결은 문자열 값이므로 숫자로 바꾼다.
        for (const entry of trades) {
            entry.amount = safeNumber(entry, 'amount');
            entry.price = safeNumber(entry, 'price');
            entry.cost = safeNumber(entry, 'cost');
            const tradeFee = safeDict(entry, 'fee', {});
            tradeFee.cost = safeNumber(tradeFee, 'cost');
            if ('rate' in tradeFee) tradeFee.rate = safeNumber(tradeFee, 'rate');
            const entryFees = safeList(entry, 'fees', []);
            for (const entryFee of entryFees) entryFee.cost = safeNumber(entryFee, 'cost');
            entry.fees = entryFees;
            entry.fee = tradeFee;
        }
        let timeInForce = safeString(order, 'timeInForce');
        let postOnly = safeValue(order, 'postOnly');
        if (timeInForce === undefined) {
            if (!isTriggerOrder && safeString(order, 'type') === 'market') timeInForce = 'IOC';
            if (postOnly === true) timeInForce = 'PO';
        } else if (postOnly === undefined) {
            postOnly = timeInForce === 'PO';
        }
        const timestamp = safeInteger(order, 'timestamp');
        const triggerPrice = parseNumber(safeString2(order, 'triggerPrice', 'stopPrice'));
        return extend(order, {
            id: safeString(order, 'id'),
            clientOrderId: safeString(order, 'clientOrderId'),
            timestamp,
            datetime: safeString(order, 'datetime') ?? iso8601(timestamp),
            symbol,
            type: safeString(order, 'type'),
            side,
            lastTradeTimestamp,
            lastUpdateTimestamp: safeInteger(order, 'lastUpdateTimestamp'),
            price: parseNumber(price),
            amount: parseNumber(amount),
            cost: parseNumber(cost),
            average: parseNumber(average),
            filled: parseNumber(filled),
            remaining: parseNumber(remaining),
            timeInForce,
            postOnly,
            trades,
            reduceOnly: safeValue(order, 'reduceOnly'),
            stopPrice: triggerPrice,
            triggerPrice,
            takeProfitPrice: parseNumber(safeString(order, 'takeProfitPrice')),
            stopLossPrice: parseNumber(safeString(order, 'stopLossPrice')),
            status,
            fee: safeValue(order, 'fee'),
        }) as Order;
    }

    /**
     * 통화·종목 코드별 `{ free, used, total }` 에서 빠진 값을 채우고(`total = free + used`, `free = total − used`, `used = total − free`),
     * 수치를 `number` 로 바꾸고, 같은 값을 `free`·`used`·`total`(·`debt`) 사전으로도 담는다. 입력 객체를 바꿔 돌려준다.
     */
    safeBalance(balance: Dict): Balances {
        const codes = Object.keys(omit(balance, ['info', 'timestamp', 'datetime', 'free', 'used', 'total', 'debt']));
        balance.free = {};
        balance.used = {};
        balance.total = {};
        const debtBalance: Dict = {};
        for (const code of codes) {
            let total = safeString(balance[code], 'total');
            let free = safeString(balance[code], 'free');
            let used = safeString(balance[code], 'used');
            const debt = safeString(balance[code], 'debt');
            if (total === undefined && free !== undefined && used !== undefined) total = Precise.stringAdd(free, used);
            if (free === undefined && total !== undefined && used !== undefined) free = Precise.stringSub(total, used);
            if (used === undefined && total !== undefined && free !== undefined) used = Precise.stringSub(total, free);
            balance[code].free = parseNumber(free);
            balance[code].used = parseNumber(used);
            balance[code].total = parseNumber(total);
            balance.free[code] = balance[code].free;
            balance.used[code] = balance[code].used;
            balance.total[code] = balance[code].total;
            if (debt !== undefined) {
                balance[code].debt = parseNumber(debt);
                debtBalance[code] = balance[code].debt;
            }
        }
        if (Object.keys(debtBalance).length > 0) balance.debt = debtBalance;
        return balance as Balances;
    }

    /** 호가 응답을 정리한다: 매수는 가격 내림차순, 매도는 오름차순으로 정렬하고 `datetime` 을 채운다. */
    safeOrderBook(orderbook: Dict): OrderBook {
        const timestamp = safeInteger(orderbook, 'timestamp');
        return {
            symbol: safeString(orderbook, 'symbol'),
            bids: sortBy(safeList(orderbook, 'bids', []), 0, true),
            asks: sortBy(safeList(orderbook, 'asks', []), 0),
            timestamp,
            datetime: safeString(orderbook, 'datetime') ?? iso8601(timestamp),
            nonce: safeInteger(orderbook, 'nonce'),
        };
    }

    parseOrderBook(
        orderbook: Dict | undefined,
        symbol: Str,
        timestamp: Int = undefined,
        bidsKey = 'bids',
        asksKey = 'asks',
        priceKey: IndexType = 0,
        amountKey: IndexType = 1,
    ): OrderBook {
        return this.safeOrderBook({
            symbol,
            timestamp,
            bids: this.parseOrderBookBidsAsks(safeValue(orderbook, bidsKey, []), priceKey, amountKey),
            asks: this.parseOrderBookBidsAsks(safeValue(orderbook, asksKey, []), priceKey, amountKey),
        });
    }

    parseOrderBookBidsAsks(bidasks: Dict | List, priceKey: IndexType = 0, amountKey: IndexType = 1): Array<[Num, Num]> {
        return toArray(bidasks).map((bidask) => [safeFloat(bidask, priceKey), safeFloat(bidask, amountKey)] as [Num, Num]);
    }

    /** 수수료 목록을 통화(와 요율)별로 합친다. */
    reduceFeesByCurrency(fees: Dict[]): Dict[] {
        const reduced: Dictionary<Dict> = {};
        for (const fee of fees) {
            const currency = safeString(fee, 'currency');
            if (currency === undefined) continue;
            const rate = safeString(fee, 'rate');
            const cost = safeString(fee, 'cost');
            const key = rate === undefined ? currency : `${currency}:${rate}`;
            const entry = (reduced[key] ??= rate === undefined ? { currency, cost: '0' } : { currency, cost: '0', rate });
            if (cost !== undefined) entry.cost = Precise.stringAdd(entry.cost, cost);
        }
        return Object.values(reduced);
    }

    parsedFeeAndFees(container: Dict): [Dict, Dict[]] {
        let fee = safeDict(container, 'fee');
        let fees = safeList(container, 'fees');
        if (fee !== undefined || fees !== undefined) {
            if (fee !== undefined) fee = this.parseFeeNumeric(fee);
            if (fees === undefined) fees = [fee];
            const reduced = (this.reduceFees ? this.reduceFeesByCurrency(fees) : fees).map((item) => this.parseFeeNumeric(item));
            fees = reduced;
            if (reduced.length === 1) fee = reduced[0];
            else if (reduced.length === 0) fee = undefined;
        }
        return [fee ?? { cost: undefined, currency: undefined }, fees ?? []];
    }

    parseFeeNumeric(fee: Dict): Dict {
        fee.cost = safeNumber(fee, 'cost');
        if ('rate' in fee) fee.rate = safeNumber(fee, 'rate');
        return fee;
    }

    /** 빈 잔고 항목. */
    account(): { free: Num; used: Num; total: Num } {
        return { free: undefined, used: undefined, total: undefined };
    }

    parseTicker(_ticker: Dict, _market: Market = undefined): Ticker {
        throw new NotSupported(`${this.id} parseTicker() is not supported yet`);
    }

    parseTickers(tickers: Dict[] | Dict | undefined, symbols: Strings = undefined): Tickers {
        const results: Ticker[] = [];
        for (const ticker of toArray(tickers)) results.push(this.parseTicker(ticker));
        return this.filterByArrayTickers(results, 'symbol', symbols);
    }

    parseTrade(_trade: Dict, _market: Market = undefined): Trade {
        throw new NotSupported(`${this.id} parseTrade() is not supported yet`);
    }

    /** 체결 목록을 파싱해 시각·id 순으로 정렬하고 `since`·`limit` 으로 자른다. `params` 는 각 체결에 덧씌운다. */
    parseTrades(trades: Dict[] | Dict | undefined, market: Market = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Trade[] {
        const parsed = toArray(trades).map((trade) => extend(this.parseTrade(trade, market), params));
        return this.filterBySymbolSinceLimit(sortBy2(parsed, 'timestamp', 'id'), market?.symbol, since, limit) as Trade[];
    }

    parseOrder(_order: Dict, _market: Market = undefined): Order {
        throw new NotSupported(`${this.id} parseOrder() is not supported yet`);
    }

    /** 주문 목록(배열 또는 `id → 주문` 사전)을 파싱한다. `params` 는 각 주문에 덧씌운다. */
    parseOrders(orders: Dict[] | Dict | undefined, market: Market = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Order[] {
        const results: Order[] = [];
        if (Array.isArray(orders)) {
            for (const order of orders) results.push(extend(this.parseOrder(order, market), params) as Order);
        } else if (orders !== undefined) {
            for (const id of Object.keys(orders)) {
                results.push(extend(this.parseOrder(extend({ id }, orders[id]), market), params) as Order);
            }
        }
        const sorted = sortBy(results, 'timestamp');
        return this.filterBySymbolSinceLimit(sorted, market?.symbol, since, limit) as Order[];
    }

    parseOHLCV(_ohlcv: unknown, _market: Market = undefined): OHLCV {
        throw new NotSupported(`${this.id} parseOHLCV() is not supported yet`);
    }

    /** 봉 목록을 파싱해 시각 오름차순으로 정렬하고 `since`·`limit` 으로 자른다. */
    parseOHLCVs(ohlcvs: unknown[] | undefined, market: Market = undefined, _timeframe = '1m', since: Int = undefined, limit: Int = undefined, tail = false): OHLCV[] {
        if (ohlcvs === undefined) return [];
        const sorted = sortBy(ohlcvs.map((ohlcv) => this.parseOHLCV(ohlcv, market)), 0);
        return this.filterBySinceLimit(sorted, since, limit, 0, tail) as OHLCV[];
    }

    parseBalance(_response: unknown): Balances {
        throw new NotSupported(`${this.id} parseBalance() is not supported yet`);
    }

    // ---- 자르기·거르기 ----

    /**
     * ccxt 규칙대로 기간 끝(`params.until`, ms)을 꺼내고, 요청에 실리지 않게 `params` 에서 뺀다. 고유 메서드의 위치 인자 `until` 이던 자리가
     * `limit` 이 되었으므로, ms 처럼 큰 수가 `limit` 으로 오면 옛 호출로 보고 `BadRequest` 를 던진다.
     */
    handleUntilParam(method: string, limit: Int, params: Dict): [Int, Dict] {
        if (limit !== undefined && limit > LIMIT_LOOKS_LIKE_MS) {
            throw new BadRequest(`${this.id} ${method}() 의 기간 끝은 params.until(ms)로 준다. 이 자리는 limit 이다: ${limit}`);
        }
        return [safeInteger(params, 'until'), omit(params, 'until')];
    }

    /** ccxt 의미대로 `limit` 개로 자른다. `since` 가 있으면 가장 이른 것부터, 없으면 가장 최근 것부터다. `key` 는 순서를 가를 필드다. */
    limitRows<T>(rows: T[], since: Int, limit: Int, key = 'timestamp'): T[] {
        return this.filterByLimit(rows as Dict[], limit, key, since !== undefined) as T[];
    }

    /** 이미 있는 ms 값으로 ccxt 의 `timestamp`, `datetime` 을 만든다. */
    msStamp(timestamp: Int): KrTimestamped {
        return { timestamp, datetime: timestamp === undefined ? undefined : iso8601(timestamp) };
    }

    /** 한국 날짜(`YYYYMMDD`)와 시각(`HHMMSS`)으로 ccxt 의 `timestamp`, `datetime` 을 만든다. 시각이 없으면 그날 0시이고, 날짜를 못 읽으면 둘 다 비운다. */
    kstStamp(ymd: Str, hms: Str = undefined): KrTimestamped {
        const date = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd ?? '');
        if (date === null) return { timestamp: undefined, datetime: undefined };
        const time = /^(\d{2})(\d{2})(\d{2})$/.exec(hms !== undefined && hms !== '' ? hms.padStart(6, '0') : '000000') ?? [];
        const timestamp = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(time[1] ?? 0), Number(time[2] ?? 0), Number(time[3] ?? 0)) - KST_OFFSET_MS;
        return { timestamp, datetime: iso8601(timestamp) };
    }

    filterByLimit(array: Dict[], limit: Int = undefined, key: IndexType = 'timestamp', fromStart = false): any[] {
        if (limit === undefined || array.length === 0) return array;
        let ascending = true;
        if (key in array[0]) {
            const first = array[0][key];
            const last = array[array.length - 1][key];
            if (first !== undefined && last !== undefined) ascending = first <= last;
        }
        // 시각 오름차순이면 앞에서 자를 때 처음 `limit` 개, 뒤에서 자를 때 마지막 `limit` 개다. 내림차순이면 반대다.
        const takeHead = fromStart === ascending;
        return takeHead ? array.slice(0, limit) : array.slice(-limit);
    }

    filterBySinceLimit(array: Dict[] | undefined, since: Int = undefined, limit: Int = undefined, key: IndexType = 'timestamp', tail = false): any[] {
        if (array === undefined) return [];
        const sinceIsDefined = since !== undefined && since !== null;
        let result = toArray(array);
        if (sinceIsDefined) {
            result = result.filter((entry) => {
                const value = safeValue(entry, key);
                return value !== undefined && value !== 0 && value >= since;
            });
        }
        if (tail && limit !== undefined) return result.slice(-limit);
        return this.filterByLimit(result, limit, key, !tail && sinceIsDefined);
    }

    filterByValueSinceLimit(
        array: Dict[],
        field: IndexType,
        value: unknown = undefined,
        since: Int = undefined,
        limit: Int = undefined,
        key: IndexType = 'timestamp',
        tail = false,
    ): any[] {
        const valueIsDefined = value !== undefined && value !== null;
        const sinceIsDefined = since !== undefined && since !== null;
        let result = toArray(array);
        if (valueIsDefined || sinceIsDefined) {
            result = result.filter((entry) => {
                const fieldMatches = valueIsDefined ? safeValue(entry, field) === value : true;
                const stamp = safeValue(entry, key);
                const sinceMatches = sinceIsDefined ? stamp !== undefined && stamp !== 0 && stamp >= (since as number) : true;
                return fieldMatches && sinceMatches;
            });
        }
        if (tail && limit !== undefined) return result.slice(-limit);
        return this.filterByLimit(result, limit, key, sinceIsDefined);
    }

    filterBySymbolSinceLimit(array: Dict[], symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, tail = false): any[] {
        return this.filterByValueSinceLimit(array, 'symbol', symbol, since, limit, 'timestamp', tail);
    }

    /** `key` 필드가 `values` 에 든 항목만 남긴다. `values` 가 없으면 그대로 돌려준다. */
    filterByArrayTickers(objects: Ticker[], key: IndexType, values: Strings = undefined): Tickers {
        const result: Tickers = {};
        for (const object of objects) {
            const objectKey = safeString(object, key);
            if (objectKey === undefined) continue;
            if (values === undefined || values.includes(objectKey)) result[objectKey] = object;
        }
        return result;
    }

    // ============ 주문 인자 검사 ============

    /**
     * 주문 인자의 기본 검사. 주문 종류·방향이 올바르고, 지정가는 가격이 있고, 수량이 0 보다 큰지 본다.
     * 증권사 클래스의 `createOrder` 가 요청을 만들기 전에 부른다.
     */
    checkOrderArguments(_market: Market, type: OrderType, side: OrderSide, amount: number | undefined, price: Num, _params: Dict = {}): void {
        if (side !== 'buy' && side !== 'sell') throw new InvalidOrder(`${this.id} createOrder() side must be 'buy' or 'sell'`);
        if (type !== 'limit' && type !== 'market') throw new InvalidOrder(`${this.id} createOrder() type must be 'limit' or 'market'`);
        if (type === 'limit' && price === undefined) throw new ArgumentsRequired(`${this.id} createOrder() requires a price argument for a limit order`);
        if (amount === undefined || !(amount > 0)) throw new ArgumentsRequired(`${this.id} createOrder() amount should be above 0`);
    }

    // ============ 통합 메서드(기본 구현) ============
    //
    // 증권사가 지원하는 것만 override 한다. 나머지는 `NotSupported` 를 던진다.

    async fetchTime(_params: Dict = {}): Promise<Int> {
        throw new NotSupported(`${this.id} fetchTime() is not supported yet`);
    }

    async fetchStatus(_params: Dict = {}): Promise<Status> {
        throw new NotSupported(`${this.id} fetchStatus() is not supported yet`);
    }

    /** `has.fetchTickers` 가 있으면 `fetchTickers` 로 하나를 골라 주고, 없으면 `NotSupported`. */
    async fetchTicker(symbol: string, params: Dict = {}): Promise<Ticker> {
        if (this.has.fetchTickers !== undefined && this.has.fetchTickers !== false) {
            await this.loadMarkets();
            const market = this.market(symbol);
            const tickers = await this.fetchTickers([market.symbol], params);
            const ticker = safeDict(tickers, market.symbol);
            if (ticker === undefined) throw new NullResponse(`${this.id} fetchTickers() could not find a ticker for ${market.symbol}`);
            return ticker as Ticker;
        }
        throw new NotSupported(`${this.id} fetchTicker() is not supported yet`);
    }

    async fetchTickers(_symbols: Strings = undefined, _params: Dict = {}): Promise<Tickers> {
        throw new NotSupported(`${this.id} fetchTickers() is not supported yet`);
    }

    async fetchOrderBook(_symbol: string, _limit: Int = undefined, _params: Dict = {}): Promise<OrderBook> {
        throw new NotSupported(`${this.id} fetchOrderBook() is not supported yet`);
    }

    async fetchOHLCV(_symbol: string, _timeframe = '1m', _since: Int = undefined, _limit: Int = undefined, _params: Dict = {}): Promise<OHLCV[]> {
        throw new NotSupported(`${this.id} fetchOHLCV() is not supported yet`);
    }

    /**
     * 잔고. 현금은 통화 키(`KRW`·`USD`), 보유 종목은 종목 코드 키이며 `total` 이 수량이다. 조회에 실패하면 던진다(빈 잔고와 구분한다).
     */
    async fetchBalance(_params: Dict = {}): Promise<Balances> {
        throw new NotSupported(`${this.id} fetchBalance() is not supported yet`);
    }

    async createOrder(_symbol: string, _type: OrderType, _side: OrderSide, _amount: number, _price: Num = undefined, _params: Dict = {}): Promise<Order> {
        throw new NotSupported(`${this.id} createOrder() is not supported yet`);
    }

    /**
     * 조건(트리거) 주문. ccxt 의 통합 메서드와 같은 자리다. 지원하는 증권사만 override 한다.
     * ccxt 의 기본 구현은 `createOrder(..., { triggerPrice })` 로 대신해 주지만, 여기서는 증권사가 조건 주문을 어떻게 받는지 알아야 하므로
     * `NotSupported` 를 던진다. `createOrder` 의 `params` 로만 되는 증권사가 이 이름을 켜려면 이 메서드를 직접 구현한다.
     */
    async createTriggerOrder(_symbol: string, _type: OrderType, _side: OrderSide, _amount: number, _price: Num = undefined, _triggerPrice: Num = undefined, _params: Dict = {}): Promise<Order> {
        throw new NotSupported(`${this.id} createTriggerOrder() is not supported yet`);
    }

    /**
     * 주문 정정. ccxt 의 기본 구현은 취소한 뒤 다시 접수하지만, 그 둘은 원자적이 아니라서 취소만 되고 재접수가 실패하면 주문이 사라진다.
     * 그래서 여기서는 `NotSupported` 를 던지고, 증권사가 정정 API 를 가진 경우에만 override 한다(`has.editOrder`).
     */
    async editOrder(_id: string, _symbol: string, _type: OrderType, _side: OrderSide, _amount: Num = undefined, _price: Num = undefined, _params: Dict = {}): Promise<Order> {
        throw new NotSupported(`${this.id} editOrder() is not supported yet`);
    }

    async createLimitOrder(symbol: string, side: OrderSide, amount: number, price: number, params: Dict = {}): Promise<Order> {
        return this.createOrder(symbol, 'limit', side, amount, price, params);
    }

    async createMarketOrder(symbol: string, side: OrderSide, amount: number, price: Num = undefined, params: Dict = {}): Promise<Order> {
        return this.createOrder(symbol, 'market', side, amount, price, params);
    }

    async createLimitBuyOrder(symbol: string, amount: number, price: number, params: Dict = {}): Promise<Order> {
        return this.createOrder(symbol, 'limit', 'buy', amount, price, params);
    }

    async createLimitSellOrder(symbol: string, amount: number, price: number, params: Dict = {}): Promise<Order> {
        return this.createOrder(symbol, 'limit', 'sell', amount, price, params);
    }

    async createMarketBuyOrder(symbol: string, amount: number, params: Dict = {}): Promise<Order> {
        return this.createOrder(symbol, 'market', 'buy', amount, undefined, params);
    }

    async createMarketSellOrder(symbol: string, amount: number, params: Dict = {}): Promise<Order> {
        return this.createOrder(symbol, 'market', 'sell', amount, undefined, params);
    }

    async cancelOrder(_id: string, _symbol: Str = undefined, _params: Dict = {}): Promise<Order> {
        throw new NotSupported(`${this.id} cancelOrder() is not supported yet`);
    }

    async cancelAllOrders(_symbol: Str = undefined, _params: Dict = {}): Promise<Order[]> {
        throw new NotSupported(`${this.id} cancelAllOrders() is not supported yet`);
    }

    async fetchOrder(_id: string, _symbol: Str = undefined, _params: Dict = {}): Promise<Order> {
        throw new NotSupported(`${this.id} fetchOrder() is not supported yet`);
    }

    async fetchOrders(_symbol: Str = undefined, _since: Int = undefined, _limit: Int = undefined, _params: Dict = {}): Promise<Order[]> {
        throw new NotSupported(`${this.id} fetchOrders() is not supported yet`);
    }

    /** `has.fetchOrders` 가 있으면 그 결과에서 미체결만 거르고, 없으면 `NotSupported`. */
    async fetchOpenOrders(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        if (this.has.fetchOrders !== undefined && this.has.fetchOrders !== false) {
            return filterBy(await this.fetchOrders(symbol, since, limit, params), 'status', 'open') as Order[];
        }
        throw new NotSupported(`${this.id} fetchOpenOrders() is not supported yet`);
    }

    /** `has.fetchOrders` 가 있으면 그 결과에서 체결 완료만 거르고, 없으면 `NotSupported`. */
    async fetchClosedOrders(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        if (this.has.fetchOrders !== undefined && this.has.fetchOrders !== false) {
            return filterBy(await this.fetchOrders(symbol, since, limit, params), 'status', 'closed') as Order[];
        }
        throw new NotSupported(`${this.id} fetchClosedOrders() is not supported yet`);
    }

    async fetchCanceledOrders(_symbol: Str = undefined, _since: Int = undefined, _limit: Int = undefined, _params: Dict = {}): Promise<Order[]> {
        throw new NotSupported(`${this.id} fetchCanceledOrders() is not supported yet`);
    }

    async fetchMyTrades(_symbol: Str = undefined, _since: Int = undefined, _limit: Int = undefined, _params: Dict = {}): Promise<Trade[]> {
        throw new NotSupported(`${this.id} fetchMyTrades() is not supported yet`);
    }

    async fetchTradingFee(_symbol: string, _params: Dict = {}): Promise<TradingFeeInterface> {
        throw new NotSupported(`${this.id} fetchTradingFee() is not supported yet`);
    }
}

/** `urls.api` 는 문자열 하나이거나 이름별 사전이다. 사전만 복사한다. */
function cloneUrls<T>(urls: T): T {
    return typeof urls === 'string' ? urls : clone(urls);
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
