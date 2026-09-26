/**
 * @fileoverview 토스증권 OpenAPI 클래스(`class toss extends Exchange`). 국내와 미국 주식 현물의 시세·잔고·주문·조회를 ccxt 와 같은 모양으로 다룬다.
 *
 * ```ts
 * const exchange = new toss({ apiKey: clientId, secret: clientSecret, uid: accountSeq });
 * const ticker = await exchange.fetchTicker('005930/KRW');
 * const order = await exchange.createOrder('005930/KRW', 'limit', 'buy', 1, 70000);
 * ```
 *
 * ## 자격증명
 *
 * `apiKey` 는 클라이언트 ID, `secret` 은 클라이언트 시크릿, `uid` 는 계좌 순번(`accountSeq`)이다. `uid` 를 비워 두면 처음 계좌 API 를 부를 때
 * `GET /accounts` 로 첫 계좌를 찾아 채운다. 토스에는 모의투자 환경이 없어 `setSandboxMode(true)` 는 `NotSupported` 다.
 *
 * ## 심볼
 *
 * 국내는 `005930/KRW`, 미국은 `AAPL/USD` 다. 종목을 아직 불러오지 않았어도(`loadMarkets` 없이) 코드의 모양으로 시장을 판별해 바로 조회하고 주문할 수 있다.
 * 현금 코드와 같은 티커(`USD`)는 `commonStockCodes` 의 통합 코드로 심볼을 만든다(`ProShares Ultra Semiconductors/USD`). 입력은 `USD/USD` 도 받는다.
 * `loadMarkets()` 를 부르면 토스가 거래할 수 있는 종목 전체(`GET /stocks/all`)가 `markets` 에 들어가고, 종목 유형(`ETF` 등)이 `market.options` 에 실린다.
 *
 * ## 주문
 *
 * `createOrder(symbol, type, side, amount, price, params)` 의 `params` 는 다음을 읽는다.
 *
 * | 키 | 뜻 |
 * |---|---|
 * | `clientOrderId` | 멱등키(36자 이하, 10분 유효). 같은 값으로 다시 보내면 이전 결과를 돌려준다 |
 * | `cost` | 달러 금액(미국 시장가 매수 전용). 수량 대신 금액으로 주문한다. `createMarketBuyOrderWithCost` 가 이 값을 채운다 |
 * | `timeInForce` | `DAY`(기본), `CLS`(미국 지정가 장마감), `OPG`(국내 시가단일가) |
 * | `triggerPrice` | 있으면 조건주문(서버가 가격을 감시하다 조건이 맞으면 낸다)이다. 기본은 `SINGLE`, `price` 는 트리거 뒤에 낼 지정가다 |
 * | `conditionalType` | `SINGLE`(기본)·`OCO`·`OTO` |
 * | `second` | `OCO`·`OTO` 의 둘째 조건 `{ side, triggerPrice, price }`. `OCO` 는 양쪽 모두 매도이고, 하나가 체결되면 반대편이 취소된다 |
 * | `expireDate` | 조건주문 만료일(`YYYY-MM-DD`, 한국 시각). 조건주문에는 필요하다 |
 * | `confirmExecution` | `false` 면 접수 뒤 체결 조회를 하지 않는다(기본은 체결이 확정될 때까지 짧게 조회한다) |
 *
 * 일반 주문은 위 키를 뺀 나머지를 요청 본문 끝에 합친다(ccxt 와 같다). 라이브러리가 인자로 채우는 필드(`symbol`·`side`·`orderType`·`quantity`·
 * `orderAmount`·`price`·`confirmHighValueOrder`)를 `params` 로 주면 요청 없이 `BadRequest` 다. ccxt 조건 인자(`stopPrice` 등)는 요청 없이 `NotSupported` 다.
 * `editOrder` 의 일반 정정도 같은 규칙이다.
 *
 * 접수 응답에는 체결 정보가 없다. 그래서 `createOrder` 는 접수 뒤 주문 상세를 짧게 조회해 체결 수량·평균가·수수료를 확정하고, 확정하지 못하면
 * `filled` 를 비워 둔다(요청값으로 추정해 채우지 않는다). 확정한 값은 `order.info.execution` 에도 있다.
 *
 * ## 옵션
 *
 * 전역 설정은 없고 인스턴스가 `options` 로 받는다. `tokenStore`(토큰 저장소), `nxtRouting`(국내 확장세션 주문), `usExtendedLimit`(미국 확장세션 시장가를 지정가로),
 * `blockAuctionBuys`(정규장 종가 동시호가의 신규 매수를 막는다),
 * `krwIntegratedMargin`(켜면 `fetchBalance({ currency: 'USD' })` 의 USD 에 원화 매수 여력의 달러 환산액을 늘 더한다. 환율은 토스 조회, 실패하면 `usdKrwRate`),
 * `confirmBudget`(체결 확정 조회 예산), `confirmExecution`(접수 뒤 체결 확정 조회. 일반 주문 취소 뒤의 확정 조회도 따른다)이다.
 * `nxtRouting`·`usExtendedLimit`·`blockAuctionBuys`·`krwIntegratedMargin` 은 불리언이거나 불리언을 돌려주는 함수이고 기본은 꺼짐이다. `confirmExecution` 은 기본이 켜짐이고
 * `false` 일 때만 꺼지므로 함수를 넘기면 늘 켜진다.
 *
 * ## 오류
 *
 * 토스의 오류 코드는 ccxt 오류 계층으로 옮겨 던지고, 원래 코드는 `error.detail` 과 `error.brokerCode` 에 둔다. 장 시간 밖은 `MarketClosed`, 주문 요청이 시간 초과로 끝나 접수 여부를
 * 모르면 `OrderOutcomeUnknown`(다시 보내면 중복 주문이 되므로 재시도하지 않는다), 이미 체결·취소된 주문의 취소는 `OrderNotFound` 다.
 */

import {
    Exchange,
    AccountNotEnabled,
    ArgumentsRequired,
    AuthenticationError,
    BadRequest,
    BadResponse,
    BadSymbol,
    BaseError,
    DuplicateOrderId,
    ExchangeError,
    ExchangeClosedByUser,
    ExchangeNotAvailable,
    InsufficientFunds,
    InvalidOrder,
    ManualInteractionNeeded,
    MarketClosed,
    NotSupported,
    NullResponse,
    OnMaintenance,
    OperationRejected,
    OrderNotFound,
    OrderOutcomeUnknown,
    PermissionDenied,
    Precise,
    RateLimitExceeded,
    DECIMAL_PLACES,
    NO_PADDING,
    ROUND,
    TICK_SIZE,
    TRUNCATE,
    decimalToPrecision,
    numberToString,
    type ApiName,
    type Balances,
    type Dict,
    type Dictionary,
    type ErrorClass,
    type Int,
    type Market,
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
    type Tickers,
    type Strings,
    type Trade,
    type TradingFeeInterface,
} from './base';
import { TOSS_API_TREE, type TossImplicitApi } from './abstract/toss';
import { confirmExecution, type ExecutionSnapshot } from './execution-confirm';
import { buildExtendedSessionLimit } from './extended-session-limit';
import { symbolBaseCode, type StockMarketGroup } from './broker-market-group';
import { KST_OFFSET_MS, candlePeriodUtcMs, isDailyOrLongerTimeframe } from './broker-time';
import { logger } from './logger';
import type { UsdKrwRateOption } from './options';
import { applyMarketCalendar, type CalendarDay } from './market-calendar';
import { krxAuctionBuyBlockReason } from './krx-trading-hours';
import { usAuctionBuyBlockReason } from './us-market-hours';
import { getKrxTickSize, KRX_TICK_INVALID_DETAIL, krxTickViolation } from './krx-tick-size';
import { assertWholeRemainingEdit, editOrderTotal, type EditOrderOriginal } from './edit-order-amount';
import { TossAuth, type TossIssuedToken } from './toss/toss-auth';
import { OrderNotSent, TossRateLimited, TossTokenRejected } from './toss/toss-errors';
import { TossPriceWs, type TossPriceWsOptions, type TossWsSub } from './toss/toss-price-ws';
import { WatchHub } from './base/watch-hub';
import { pickCommissionRate } from './toss/toss-fee';
import {
    FRACTIONAL_ORDER_CUTOFF_MS,
    findKrSession,
    findUsRegularCloseMs,
    findUsSession,
    isTossOrderable,
    krSessionOrderRestriction,
    tossKrCalendarDays,
    tossUsCalendarDays,
    usSessionOrderRestriction,
} from './toss/toss-trading-hours';
import {
    TOSS_BROKERAGE_FEE,
    TOSS_US_BROKERAGE_FEE,
    TOSS_HIGH_VALUE_THRESHOLD_KRW,
    TOSS_HIGH_VALUE_THRESHOLD_USD,
    getTossEffectiveFeeRate,
    tossMarketCountry,
    type TossBuyingPower,
    type TossCommission,
    type TossPriceLimit,
    type TossConditionalLegRequest,
    type TossConditionalOrder,
    type TossConditionalOrderCreateRequest,
    type TossConditionalOrderCreateResponse,
    type TossConditionalOrderFields,
    type TossConditionalOrderLeg,
    type TossConditionalOrderModifyRequest,
    type TossConditionalOrderType,
    type TossHoldingsOverview,
    type TossInvestorTradingRecord,
    type TossStockInvestorTradingResponse,
    type TossProgramTradesResponse,
    type TossShortSellingResponse,
    type TossCreditTradesResponse,
    type TossSecuritiesLendingResponse,
    type TossMarketIndicatorSymbol,
    type TossPrice,
    type TossCandlesResult,
    type TossKrMarketCalendar,
    type TossKrSession,
    type TossOrder,
    type TossOrderCreateResponse,
    type TossOrderStatus,
    type TossPaginatedConditionalOrders,
    type TossPaginatedOrders,
    type TossRankingItem,
    type TossRankingType,
    type TossStockInfo,
    type TossStockWarning,
    type TossUsMarketCalendar,
    type TossUsSession,
} from './toss/toss-types';

/** 조건주문의 조건 하나(요청 전 모양). */
interface TossConditionalLeg {
    side: OrderSide;
    triggerPrice: number;
    orderPrice: Num;
}

/** `planConditionalOrder` 가 검사하고 정리한 조건주문. */
interface TossConditionalPlan {
    conditionalType: TossConditionalOrderType;
    orderType: 'LIMIT' | 'MARKET';
    expireDate: string;
    first: TossConditionalLeg;
    second: TossConditionalLeg | undefined;
    clientOrderId: Str;
}

// ============ 상수 ============

/** 계정 전체에 거는 호출 간격 상한. 그룹별 한도 위에 얹는 집계 상한이며 초당 10건이다. */
const GLOBAL_RATE_LIMIT_MS = 100;

/**
 * 조회 요청의 시간 상한(ms). 브로커가 소켓만 열어 둔 채 응답하지 않으면 호출이 끝나지 않으므로 상한이 필요하다.
 * 너무 짧게 잡으면 정상 응답을 자르고, 잘린 만큼 재호출이 늘어난다.
 */
const READ_TIMEOUT_MS = 20_000;

/**
 * 주문 요청의 시간 상한(ms). 호출하는 쪽이 바깥에 두는 타임아웃(대개 30초)보다 짧아야 한다. 그래야 "결과를 안 보고 떠난" 상태가 아니라
 * "요청을 끊었고 접수 여부는 미확정임을 아는" 상태가 된다.
 */
const ORDER_TIMEOUT_MS = 25_000;

/** 토큰 발급 요청의 시간 상한(ms). 여기서 멈추면 그 뒤의 모든 요청이 함께 멈춘다. */
const AUTH_TIMEOUT_MS = 10_000;

/** 장 운영 캘린더 캐시 유효 시간. 전일·당일·익일 세 영업일을 한 번에 주고 하루 중에는 바뀌지 않는다. */
const CALENDAR_TTL_MS = 30 * 60 * 1000;

/** 수수료율 캐시 유효 시간. */
const COMMISSIONS_TTL_MS = 24 * 60 * 60 * 1000;

/** 참고 환율 캐시 유효 시간. 환율은 1분마다 갱신되지만 금액 환산에는 이 정도면 충분하다. */
const FX_RATE_TTL_MS = 5 * 60 * 1000;

/** 체결 완료 주문 조회의 페이지 크기. 토스가 받는 최대값이며 넘기면 요청이 통째로 거절된다. */
const CLOSED_ORDER_PAGE_LIMIT = 100;

/** 체결 완료 주문 조회의 페이지 수 상한. 넘으면 로그를 남기고 자른다. */
const MAX_CLOSED_ORDER_PAGES = 10;

/** 미체결 조건주문 조회의 페이지 크기. 공식 기본은 20건이고 최대는 100건이다. */
const CONDITIONAL_ORDER_PAGE_LIMIT = 100;

/** 미체결 조건주문 조회의 페이지 수 상한. 넘으면 로그를 남기고 자른다. */
const MAX_CONDITIONAL_ORDER_PAGES = 10;

/** 캔들의 페이지당 봉 수 상한과 페이지 수 상한. */
const CANDLE_PAGE_LIMIT = 200;
const MAX_CANDLE_PAGES = 10;

/** 캔들 조회에서 `limit` 를 주지 않았을 때의 봉 수. */
const DEFAULT_CANDLE_LIMIT = 100;

/** 조건주문 목록에 조건(leg)이 통째로 없을 때 상세 조회로 채우는 건수의 상한. 조회 한도를 다 쓰지 않으려는 선이다. */
const MAX_CONDITIONAL_DETAIL_FETCH = 20;

/** 전 종목 조회가 필요한 마켓 목록. `loadMarkets` 가 이 마켓의 종목을 모두 불러온다. */
const LISTED_MARKETS: readonly string[] = ['KOSPI', 'KOSDAQ', 'KR_ETC', 'NYSE', 'NASDAQ', 'AMEX', 'US_ETC'];

/** 국내에 상장한 마켓. */
const KR_LISTED_MARKETS: ReadonlySet<string> = new Set(['KOSPI', 'KOSDAQ', 'KR_ETC']);

/** 증권거래세가 붙지 않는 종목 유형(국내 상장 ETF·ETN). */
const TAX_EXEMPT_SECURITY_TYPES: ReadonlySet<string> = new Set(['ETF', 'ETN']);

/** 더 이상 체결이 늘지 않는 주문 상태. `REPLACED` 는 체결 정보가 대체 주문으로 옮겨 가므로 기다릴 이유가 없다. */
const TERMINAL_ORDER_STATUSES: ReadonlySet<TossOrderStatus> = new Set<TossOrderStatus>([
    'FILLED', 'CANCELED', 'REJECTED', 'CANCEL_REJECTED', 'REPLACE_REJECTED', 'REPLACED',
]);

/** 취소를 접수한 원주문이 끝났다고 확정하는 상태. 나머지 종료 상태(`REPLACED` 등)는 원주문의 끝을 알려 주지 않는다. */
const CANCEL_SETTLED_STATUSES: ReadonlySet<TossOrderStatus> = new Set<TossOrderStatus>(['CANCELED', 'FILLED', 'REJECTED']);

/** ccxt 조건 인자. 조건주문은 `triggerPrice` 로만 내므로, 이 키를 버리고 일반 주문을 내지 않게 요청 전에 막는다. */
const UNSUPPORTED_CONDITIONAL_PARAMS = ['stopPrice', 'stopLossPrice', 'takeProfitPrice', 'stopLoss', 'takeProfit'] as const;

/** 일반 주문 경로가 `params` 에서 읽는 키. 본문에 합치지 않는다. */
const ORDER_HANDLED_PARAMS = ['triggerPrice', 'cost', 'clientOrderId', 'timeInForce', 'confirmExecution'];

/** 라이브러리가 인자로 채우는 주문 본문 필드. `params` 로 덮으면 돌려주는 주문과 실제 요청이 어긋나므로 받지 않는다. */
const ORDER_COMPUTED_FIELDS = ['symbol', 'side', 'orderType', 'quantity', 'orderAmount', 'price', 'confirmHighValueOrder'] as const;

/** 일반 정정 경로가 `params` 에서 읽는 키. 본문에 합치지 않는다. */
const EDIT_HANDLED_PARAMS = ['trigger', 'stop', 'partial'];

/** 라이브러리가 인자로 채우는 정정 본문 필드(`orderId` 는 경로에 실린다). */
const EDIT_COMPUTED_FIELDS = ['orderId', 'orderType', 'quantity', 'price', 'confirmHighValueOrder'] as const;

/** 미국 소수점 수량의 최대 자릿수. */
const US_FRACTION_DIGITS = 6;
const US_FRACTION_SCALE = 10 ** US_FRACTION_DIGITS;

/** 미국 주문 금액이 이 값(달러) 미만이면 환율이 아무리 높아도 고액주문 기준에 못 미친다. 환율 조회를 건너뛰는 선이다. */
const HIGH_VALUE_USD_LOOKUP_FLOOR = 30_000;

/** 고액주문 기준을 환율로 계산할 때 두는 여유. 서버가 쓰는 환율은 알 수 없으므로 기준을 조금 낮춰 잡는다. */
const HIGH_VALUE_MARGIN = 0.95;

/** 개장 직후(09:00~09:10 KST)에는 주문 정보 그룹의 한도가 절반으로 줄어든다. 그 시간에 비용을 이 배수로 센다. */
const PEAK_WINDOW_START_MIN = 9 * 60;
const PEAK_WINDOW_END_MIN = 9 * 60 + 10;
const PEAK_COST_FACTOR = 2;

/** 429 뒤에 그룹을 쉬게 하는 시간의 기본값과 상한(ms). */
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const ORDER_TIME_IN_FORCE = ['DAY', 'CLS', 'OPG'] as const;

// ============ 보조 함수 ============

/** epoch ms 의 한국 시각 날짜(`YYYY-MM-DD`). */
function kstDate(ms: number): string {
    return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 커서로 받은 쪽에서 아직 담지 않은 행만 고른다. 서버가 커서를 무시하고 같은 쪽을 다시 주면 같은 주문이 두 번 담긴다.
 * 식별자가 없는 행은 가를 수 없으므로 담는다.
 */
function unseenRows<T>(rows: T[], idOf: (row: T) => string | undefined, seen: Set<string>): T[] {
    return rows.filter((row) => {
        const id = idOf(row);
        if (id === undefined || id === null) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

/** 지금이 개장 직후 09:00~09:10(한국 시각)인가. */
function isOrderInfoPeakWindow(now: Date): boolean {
    const kstMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + KST_OFFSET_MS / 60_000) % (24 * 60);
    return kstMinutes >= PEAK_WINDOW_START_MIN && kstMinutes < PEAK_WINDOW_END_MIN;
}

/** `execution` 을 체결 확정 폴링이 쓰는 스냅샷으로 옮긴다. 체결이 0 이면 `null`(기록할 사실이 없다). */
function toExecutionSnapshot(order: TossOrder | null | undefined, country: StockMarketGroup): ExecutionSnapshot | null {
    const filled = Number(order?.execution?.filledQuantity) || 0;
    if (!(filled > 0)) return null;

    const positive = (value: string | null | undefined): number | undefined => {
        if (value == null) return undefined;
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const amount = positive(order?.execution?.filledAmount);
    // 평균 체결가가 비어 있어도 체결 금액이 있으면 단가를 거꾸로 구할 수 있다.
    const average = positive(order?.execution?.averageFilledPrice) ?? (amount !== undefined ? amount / filled : undefined);

    // 수수료와 세금은 한쪽만 오는 경우가 있어(미국은 세금이 없다) 있는 것만 더한다.
    const commission = positive(order?.execution?.commission);
    const tax = positive(order?.execution?.tax);
    const fee = commission !== undefined || tax !== undefined ? (commission ?? 0) + (tax ?? 0) : undefined;

    return { filled, average, amount, fee, feeCurrency: country === 'US' ? 'USD' : 'KRW' };
}

/** `BUY`·`SELL` 값을 leg 안에서 찾는다. 문서의 키(`orderSide`)를 먼저 보고, 없으면 값으로 찾는다. */
function sideFromLeg(leg: TossConditionalOrderLeg | undefined): 'buy' | 'sell' | null {
    if (leg == null) return null;
    const normalize = (value: unknown): 'buy' | 'sell' | null => {
        if (typeof value !== 'string') return null;
        const upper = value.trim().toUpperCase();
        return upper === 'SELL' ? 'sell' : upper === 'BUY' ? 'buy' : null;
    };
    const documented = normalize(leg.orderSide);
    if (documented !== null) return documented;
    for (const value of Object.values(leg as Record<string, unknown>)) {
        const hit = normalize(value);
        if (hit !== null) return hit;
    }
    return null;
}

/**
 * 조건주문의 대표 방향. 토스는 조건주문 조회 응답의 leg 에 주문 방향을 주지 않는다(`orderSide` 는 등록 요청에만 있다).
 * 응답에 방향이 실려 오면 그 값을 쓰고, 없으면 조건주문 종류로 유추한다. OCO 는 익절·손절 브래킷이라 양쪽이 매도이고, OTO 의 대표 leg 은 매수 진입이다.
 * SINGLE 은 유추할 근거가 없어 `buy` 로 남는다. 정확한 방향은 그 조건주문을 낸 쪽이 안다.
 */
function conditionalSide(c: TossConditionalOrder): 'buy' | 'sell' {
    const fromLeg = sideFromLeg(c.first);
    if (fromLeg !== null) return fromLeg;
    if (c.type === 'OCO') return 'sell';
    return 'buy';
}

// 암묵 API 메서드(`privateMarketGetPrices` 등)의 선언이다. `abstract/toss.ts` 가 엔드포인트 표(`spec/toss.json`)에서 만든다.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface toss extends TossImplicitApi {}

export class toss extends Exchange {
    // 실행 중에 쌓이는 상태. 이름이 `describe()` 의 키와 겹치면 안 된다(생성자가 얹은 값을 덮어쓴다).
    private accessToken: string | undefined;
    private tokenAuth: TossAuth | undefined;
    private tokenAuthClientId: string | undefined;
    private accountSeqLoading: Promise<void> | undefined;
    private readonly calendars: { KR?: { value: TossKrMarketCalendar; fetchedAt: number }; US?: { value: TossUsMarketCalendar; fetchedAt: number } } = {};
    private readonly commissionRates = new Map<StockMarketGroup, number>();
    private commissionsFetchedAt = 0;
    private fxRate: { rate: number; fetchedAt: number } | undefined;
    private readonly blockedUntil = new Map<string, number>();

    override describe(): Dict {
        return this.deepExtend(super.describe(), {
            id: 'toss',
            name: 'Toss Securities',
            countries: ['KR'],
            version: 'v1',
            hostname: 'openapi.tossinvest.com',
            rateLimit: GLOBAL_RATE_LIMIT_MS,
            timeout: READ_TIMEOUT_MS,
            orderTimeout: ORDER_TIMEOUT_MS,
            has: {
                ws: true,
                watchTicker: true,
                watchTrades: true,
                watchOrderBook: true,
                watchOrders: true,
                CORS: undefined,
                spot: true,
                margin: false,
                swap: false,
                future: false,
                option: false,
                sandbox: false,
                fetchMarkets: true,
                fetchCurrencies: false,
                fetchTicker: true,
                fetchTickers: true,
                fetchOrderBook: true,
                fetchOHLCV: true,
                fetchBalance: true,
                fetchTradingFee: true,
                fetchTradingFees: false,
                createOrder: true,
                createMarketBuyOrderWithCost: true,
                createTriggerOrder: true,
                cancelOrder: true,
                cancelAllOrders: 'emulated',
                editOrder: true,
                fetchOrder: true,
                fetchOrders: false,
                fetchOpenOrders: true,
                fetchClosedOrders: true,
                fetchCanceledOrders: true,
                fetchMyTrades: 'emulated',
                fetchTrades: true,
                fetchMarketCalendar: true,
                fetchStockWarnings: true,
            },
            urls: {
                logo: undefined,
                api: {
                    public: 'https://{hostname}',
                    private: 'https://{hostname}/api/{version}',
                },
                www: 'https://tossinvest.com',
                doc: [
                    'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
                    'https://openapi.tossinvest.com/openapi-docs/overview.md',
                ],
            },
            // 엔드포인트 표(`spec/toss.json`)에서 만든 트리다. 엔드포인트는 표에 더한다.
            // `market` 은 토큰만 있으면 되는 시세·종목 API, `account` 는 여기에 계좌 헤더(`X-Tossinvest-Account`)가 더 필요한 API 다.
            // 비용은 전부 1이고 그룹의 한도는 `rateLimitBuckets` 에 있다. `peak` 는 개장 직후에 한도가 줄어드는 그룹이다.
            api: TOSS_API_TREE,
            // 값은 그룹별 공식 한도(초당 호출 수)에서 여유를 두고 정했다. 조회 그룹(자산)은 문서값(5)보다 낮은 1건으로 둔다.
            rateLimitBuckets: {
                auth: { rateLimit: 334 },
                account: { rateLimit: 1100 },
                asset: { rateLimit: 1100 },
                stock: { rateLimit: 250 },
                stock_all: { rateLimit: 1100 },
                market_info: { rateLimit: 500 },
                market_data: { rateLimit: 100 },
                market_data_chart: { rateLimit: 100 },
                ranking: { rateLimit: 250 },
                market_indicator: { rateLimit: 125 },
                market_indicator_chart: { rateLimit: 250 },
                stock_trading_trend: { rateLimit: 125 },
                order: { rateLimit: 125 },
                order_history: { rateLimit: 250 },
                order_info: { rateLimit: 250 },
                conditional_order: { rateLimit: 250 },
                conditional_order_history: { rateLimit: 125 },
            },
            requiredCredentials: {
                apiKey: true,
                secret: true,
                uid: false,
            },
            timeframes: {
                '1m': '1m',
                '1d': '1d',
            },
            fees: {
                trading: {
                    tierBased: false,
                    percentage: true,
                    taker: TOSS_BROKERAGE_FEE,
                    maker: TOSS_BROKERAGE_FEE,
                },
            },
            // ccxt 기본 표는 400·403·404·409 를 전부 `ExchangeNotAvailable` 로 옮긴다. 토스에서 이 상태는 요청이 거절됐다는 뜻이라 재시도해도 소용없는 오류로 옮긴다.
            httpExceptions: {
                400: BadRequest,
                401: AuthenticationError,
                403: PermissionDenied,
                404: ExchangeError,
                409: ExchangeError,
                414: BadRequest,
                415: BadRequest,
                422: ExchangeError,
                429: RateLimitExceeded,
            },
            exceptions: {
                exact: {
                    // 400
                    'invalid-request': BadRequest,
                    'confirm-high-value-required': InvalidOrder,
                    'account-header-required': BadRequest,
                    'unsupported-ranking-duration': BadRequest,
                    'unsupported-symbol': BadSymbol,
                    'unsupported-market': BadSymbol,
                    // 401, 403
                    'invalid-token': AuthenticationError,
                    'expired-token': AuthenticationError,
                    'token-revoked': AuthenticationError,
                    'login-user-not-found': AuthenticationError,
                    'forbidden': PermissionDenied,
                    // 404
                    'stock-not-found': BadSymbol,
                    'exchange-rate-not-found': ExchangeError,
                    'account-not-found': AuthenticationError,
                    'order-not-found': OrderNotFound,
                    'conditional-order-not-found': OrderNotFound,
                    // 409: 취소·정정하려는 주문이 이미 끝났다
                    'already-filled': OrderNotFound,
                    'already-canceled': OrderNotFound,
                    'already-modified': OrderNotFound,
                    'already-rejected': OrderNotFound,
                    'already-processing': OperationRejected,
                    'opposite-pending-order-exists': InvalidOrder,
                    // 같은 멱등키의 주문이 처리 중이라 첫 요청의 결과를 아직 모른다
                    'request-in-progress': OrderOutcomeUnknown,
                    // 422
                    'insufficient-buying-power': InsufficientFunds,
                    'insufficient-sellable-quantity': InsufficientFunds,
                    'order-hours-closed': MarketClosed,
                    'amount-order-outside-regular-hours': MarketClosed,
                    'fractional-quantity-outside-regular-hours': MarketClosed,
                    'stock-restricted': InvalidOrder,
                    'price-out-of-range': InvalidOrder,
                    'order-type-not-allowed': InvalidOrder,
                    'max-order-amount-exceeded': InvalidOrder,
                    'order-limit-exceeded': InvalidOrder,
                    'duplicate-conditional-order': InvalidOrder,
                    'condition-already-met': InvalidOrder,
                    'idempotency-key-conflict': DuplicateOrderId,
                    'market-not-supported-for-stock': BadSymbol,
                    'modify-restricted': OperationRejected,
                    'cancel-restricted': OperationRejected,
                    'account-restricted': AccountNotEnabled,
                    'prerequisite-required': ManualInteractionNeeded,
                    'investor-exchange-not-integrated': ManualInteractionNeeded,
                    // 429, 500
                    'rate-limit-exceeded': RateLimitExceeded,
                    'edge-rate-limit-exceeded': RateLimitExceeded,
                    'internal-error': ExchangeNotAvailable,
                    'maintenance': OnMaintenance,
                },
                broad: {},
            },
            precisionMode: TICK_SIZE,
            options: {
                // 아래 네 옵션은 불리언이거나 불리언을 돌려주는 함수(값이 바뀔 수 있을 때)다. 기본은 꺼짐이다.
                /** `fetchBalance({ currency: 'USD' })` 의 USD 에 원화 매수 여력의 달러 환산액을 늘 더한다. 환율은 토스 조회, 실패하면 `usdKrwRate` 다. */
                krwIntegratedMargin: undefined,
                /** 국내 확장세션(프리·애프터) 주문을 연다. */
                nxtRouting: undefined,
                /** 미국 확장세션에서 시장가를 지정가로 바꿔 낸다. */
                usExtendedLimit: undefined,
                /** 정규장 종가 동시호가(국내 15:20~15:30, 미국 15:50~16:00 ET)의 신규 매수를 막는다. 시장이 받는 주문이라 기본은 꺼짐이다. */
                blockAuctionBuys: undefined,
                /** 토큰과 발급 락을 여러 프로세스가 나눠 쓰는 저장소(`BrokerTokenStore`). 없으면 프로세스 메모리 캐시만 쓴다. */
                tokenStore: undefined,
                /** 토스의 환율 조회가 실패했을 때 쓰는 환율 조회 함수. 1달러당 원화를 돌려주는 `() => Promise<number>` 다. */
                usdKrwRate: undefined,
                /** 접수 뒤 체결 확정 조회와 취소 뒤 확정 조회의 예산 `{ attempts, intervalMs }`. 객체이거나 객체를 돌려주는 함수다. */
                confirmBudget: undefined,
                /** 접수 뒤 체결이, 취소 뒤 원주문의 끝이 확정될 때까지 주문 상세를 짧게 조회한다. 기본은 켜짐이고 `false` 일 때만 끈다(함수를 넘기면 켜진 것으로 본다). */
                confirmExecution: true,
                authTimeout: AUTH_TIMEOUT_MS,
                calendarTtl: CALENDAR_TTL_MS,
                commissionsTtl: COMMISSIONS_TTL_MS,
                fxRateTtl: FX_RATE_TTL_MS,
                closedOrdersMaxPages: MAX_CLOSED_ORDER_PAGES,
                conditionalOrdersMaxPages: MAX_CONDITIONAL_ORDER_PAGES,
                listedMarkets: LISTED_MARKETS,
            },
        });
    }

    // ============ 인증과 요청 ============

    /** 이 요청이 계좌 헤더를 필요로 하는 API 인가. */
    private needsAccount(api: ApiName): boolean {
        return Array.isArray(api) && api.includes('account');
    }

    /** 토큰 캐시 관리자. 클라이언트 ID 가 바뀌면 새로 만든다. */
    private tokenAuthFor(): TossAuth {
        const clientId = this.apiKey as string;
        if (this.tokenAuth === undefined || this.tokenAuthClientId !== clientId) {
            this.tokenAuth = new TossAuth(clientId, () => this.issueAccessToken(), () => this.getTokenStore());
            this.tokenAuthClientId = clientId;
        }
        return this.tokenAuth;
    }

    /** 토큰 발급 API 를 불러 액세스 토큰을 받는다. */
    private async issueAccessToken(): Promise<TossIssuedToken> {
        const response = await this.publicPostOauth2Token({});
        return {
            accessToken: this.safeString(response, 'access_token') ?? '',
            expiresInSeconds: this.safeInteger(response, 'expires_in'),
            tokenType: this.safeString(response, 'token_type'),
        };
    }

    /**
     * 요청 앞에서 액세스 토큰을 준비하고, 계좌 API 에는 계좌 순번을 채운다. `sign` 이 동기 함수라서 비동기 준비는 여기서 마친다.
     * 토큰은 메모리와 토큰 저장소를 거쳐 받으므로 요청마다 발급하지 않는다.
     */
    override async authenticate(
        _path: string,
        api: ApiName,
        _method: string,
        _params: Dict,
        _headers: Dictionary<string> | undefined,
        _body: string | undefined,
    ): Promise<void> {
        this.accessToken = await this.tokenAuthFor().getAccessToken();
        if (this.needsAccount(api) && this.uid === undefined) await this.loadAccountSeq();
    }

    /** `uid` 가 없을 때 `GET /accounts` 의 첫 계좌 순번을 찾아 `uid` 에 넣는다. 동시에 여러 번 불러도 요청은 한 번만 나간다. */
    private async loadAccountSeq(): Promise<void> {
        this.accountSeqLoading ??= (async () => {
            try {
                const accounts = this.unwrap<Dict[]>(await this.privateMarketGetAccounts({}));
                const first = Array.isArray(accounts) ? accounts[0] : undefined;
                const seq = this.safeString(first, 'accountSeq');
                if (seq === undefined) throw new NullResponse(`${this.id} 계좌 조회 실패: 응답에 accountSeq 가 없다`);
                this.uid = seq;
            } finally {
                this.accountSeqLoading = undefined;
            }
        })();
        await this.accountSeqLoading;
    }

    override sign(
        path: string,
        api: ApiName = 'public',
        method = 'GET',
        params: Dict = {},
        headers: Dictionary<string> | undefined = undefined,
        body: string | undefined = undefined,
    ): SignedRequest {
        const group = Array.isArray(api) ? api[0] : api;
        const base = this.implodeParams(group === undefined ? undefined : this.urls.api[group], { hostname: this.hostname, version: this.version });
        const pathParams = this.extractParams(path);
        const encoded: Dict = {};
        for (const key of pathParams) encoded[key] = encodeURIComponent(String(params[key]));
        let url = `${base}/${this.implodeParams(path, encoded)}`;
        const query = this.omit(params, pathParams);

        if (group === 'public') {
            // 토큰 발급은 폼 인코딩 본문에 자격증명을 싣는다.
            const form = new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.apiKey ?? '',
                client_secret: this.secret ?? '',
            });
            return { url, method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() };
        }

        if (this.accessToken === undefined) throw new AuthenticationError(`${this.id} 액세스 토큰이 준비되지 않았다`);
        const requestHeaders: Dictionary<string> = this.extend({ Authorization: `Bearer ${this.accessToken}` }, headers);
        if (this.needsAccount(api)) {
            if (this.uid === undefined) throw new AuthenticationError(`${this.id} 계좌 순번(uid)이 없다`);
            requestHeaders['X-Tossinvest-Account'] = this.uid;
        }
        if (method === 'GET' || method === 'DELETE') {
            if (Object.keys(query).length > 0) url += '?' + this.urlencode(query);
        } else {
            body = JSON.stringify(query);
            requestHeaders['Content-Type'] = 'application/json';
        }
        return { url, method, headers: requestHeaders, body };
    }

    /**
     * 토큰 발급은 조회보다 짧은 상한을 쓴다. 그 밖의 요청은 기본 상한(조회 `timeout`, 주문 `orderTimeout`)을 따른다.
     */
    override async fetch(
        url: string,
        method = 'GET',
        headers: Dictionary<string> | undefined = undefined,
        body: string | undefined = undefined,
        timeoutMs: number = this.timeout,
    ): Promise<any> {
        const limit = url.endsWith('/oauth2/token') ? this.safeInteger(this.options, 'authTimeout', timeoutMs) as number : timeoutMs;
        return super.fetch(url, method, headers, body, limit);
    }

    /**
     * 요청 한 건을 처리하되, 토큰이 거절되면(401) 그 토큰만 무효로 만들고 한 번 다시 보낸다. 401 은 요청이 처리되기 전에 거절된 것이라 주문도 다시 보내도 안전하다.
     * 429 를 받으면 그 그룹을 잠시 쉬게 한다.
     */
    override async fetch2(
        path: string,
        api: ApiName = 'public',
        method = 'GET',
        params: Dict = {},
        headers: Dictionary<string> | undefined = undefined,
        body: string | undefined = undefined,
        config: Dict = {},
    ): Promise<any> {
        try {
            return await this.fetchOnce(path, api, method, params, headers, body, config);
        } catch (error) {
            if (!(error instanceof TossTokenRejected)) throw error;
            logger.warn({ path }, '[toss] 401 을 받아 토큰을 무효화하고 한 번 다시 시도한다');
            await this.tokenAuthFor().invalidate(error.failedToken);
            return this.fetchOnce(path, api, method, params, headers, body, config);
        }
    }

    private async fetchOnce(
        path: string,
        api: ApiName,
        method: string,
        params: Dict,
        headers: Dictionary<string> | undefined,
        body: string | undefined,
        config: Dict,
    ): Promise<any> {
        try {
            return await super.fetch2(path, api, method, params, headers, body, config);
        } catch (error) {
            if (error instanceof TossRateLimited) {
                const wait = Math.min(error.retryAfterMs ?? DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS);
                this.blockedUntil.set(this.safeString(config, 'bucket') ?? '', this.milliseconds() + wait);
            }
            throw error;
        }
    }

    override calculateRateLimiterCost(_api: ApiName, _method: string, _path: string, _params: Dict, config: Dict = {}): number {
        const cost = this.safeNumber(config, 'cost', 1) as number;
        return config.peak === true && isOrderInfoPeakWindow(new Date(this.milliseconds())) ? cost * PEAK_COST_FACTOR : cost;
    }

    /** 그룹 한도에 더해 계정 전체 상한(`rateLimit`)도 지키고, 429 뒤에 쉬라고 한 시간이 남았으면 기다린다. */
    override async throttle(cost: Num = undefined, bucket: Str = undefined): Promise<void> {
        const blockedFor = (this.blockedUntil.get(bucket ?? '') ?? 0) - this.milliseconds();
        if (blockedFor > 0) await this.sleep(blockedFor);
        await super.throttle(cost, bucket);
        if (bucket !== undefined) await super.throttle(1, undefined);
    }

    /**
     * 응답의 오류를 오류 클래스로 던진다. 토스는 실패를 HTTP 상태와 본문의 오류 코드(`error.code` 또는 `error`) 두 층으로 준다.
     * 401·403·429 는 상태가 먼저이고, 그 밖에는 코드 표(`exceptions.exact`)를 본 다음 상태 표(`httpExceptions`)를 본다.
     * 코드는 `error.detail` 과 `error.brokerCode` 에 담는다.
     */
    override handleErrors(
        statusCode: number,
        _statusText: string,
        url: string,
        _method: string,
        responseHeaders: Dictionary<string>,
        responseBody: string,
        response: unknown,
        requestHeaders: Dictionary<string> | undefined,
        _requestBody: string | undefined,
    ): boolean | undefined {
        const errorValue = this.safeValue(response, 'error');
        if (statusCode < 400 && errorValue === undefined) return undefined;

        const code = (typeof errorValue === 'string' ? errorValue : this.safeString(errorValue, 'code')) ?? this.safeString(response, 'code');
        const description = typeof errorValue === 'string'
            ? this.safeString(response, 'error_description')
            : this.safeString(errorValue, 'message');
        const options = { detail: code, brokerCode: code };
        const isTokenRequest = url.endsWith('/oauth2/token');
        const feedback = isTokenRequest
            ? `토스 토큰 발급 실패: ${statusCode} ${responseBody}`
            : statusCode >= 400
                ? `토스 API 오류: ${statusCode} ${responseBody}`
                : `토스 API 비즈니스 오류 [${code}]: ${description ?? ''}`;

        if (statusCode === 401) {
            if (isTokenRequest) throw new AuthenticationError(feedback, options);
            const authorization = this.safeString(requestHeaders, 'Authorization');
            const failedToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
            throw new TossTokenRejected(feedback, options, failedToken);
        }
        if (statusCode === 403) throw new PermissionDenied(feedback, options);
        if (statusCode === 429) {
            const retryAfter = this.safeNumber(responseHeaders, 'Retry-After');
            throw new TossRateLimited(feedback, options, retryAfter !== undefined ? retryAfter * 1000 : undefined);
        }

        // 호가 단위를 어긴 주문은 `invalid-request` 에 올바른 호가 단위가 `data.tickSize` 로 실려 온다.
        if (code === 'invalid-request' && this.safeValue(this.safeDict(errorValue, 'data'), 'tickSize') !== undefined) {
            throw new InvalidOrder(feedback, { detail: 'price-tick-invalid', brokerCode: code });
        }
        const exact = this.exceptions?.exact as Dictionary<ErrorClass> | undefined;
        this.throwExactlyMatchedException(exact, code, feedback, options);
        // 코드 표에 없는 응답은 상태로만 분류한다. 주문 요청의 5xx 는 접수 미상이 된다(`isOutcomeUnknown`).
        const byStatus = this.httpExceptions[String(statusCode)] ?? (statusCode >= 500 ? ExchangeNotAvailable : undefined);
        if (byStatus !== undefined) throw this.httpStatusError(statusCode, byStatus, feedback, options);
        throw new ExchangeError(feedback, options);
    }

    /** 응답의 `result` 봉투를 벗긴다. 봉투가 없으면(일부 경로) 원본을, 본문이 비어 있으면(취소 등) `undefined` 를 돌려준다. */
    private unwrap<T = any>(response: unknown): T {
        if (this.isObject(response) && !Array.isArray(response) && 'result' in response) return response.result as T;
        return (response === '' ? undefined : response) as T;
    }

    // ============ 종목 ============

    /**
     * 심볼(`005930`, `005930/KRW`, `AAPL`)에서 종목을 만든다. 종목을 불러오지 않았을 때 코드의 모양으로 시장을 판별한다.
     * 클래스 주식의 `BRK/B` 는 통합 표기 `BRK.B` 로 바꾼다. `commonStockCodes` 의 통합 코드는 티커로 돌려 id 로 쓴다.
     */
    private marketFromSymbol(symbol: string): MarketInterface {
        const code = this.stockTicker(symbolBaseCode(symbol));
        const country = tossMarketCountry(code);
        const quote = country === 'KR' ? 'KRW' : 'USD';
        const base = this.commonStockCode(code);
        return this.safeMarketStructure({
            id: code,
            symbol: `${base}/${quote}`,
            base,
            quote,
            baseId: code,
            quoteId: quote,
            type: 'spot',
            spot: true,
            margin: false,
            active: undefined,
            precision: { amount: country === 'KR' ? 1 : 1 / US_FRACTION_SCALE, price: undefined },
            info: undefined,
            options: { country },
        });
    }

    /**
     * 통합 심볼(또는 종목 id)로 종목을 찾는다. `loadMarkets` 로 불러온 종목이 있으면 그것을 쓰고, 없으면 심볼의 모양으로 만든다.
     * 토스에 없는 종목이라도 여기서는 막지 않는다. 주문을 보내면 토스가 `stock-not-found`(`BadSymbol`)로 알려 준다.
     * 옛 심볼(`USD/USD`)처럼 모양으로 만든 심볼이 불러온 종목에 있으면 그 종목을 쓴다.
     */
    override market(symbol: Str): MarketInterface {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} market() requires a symbol argument`);
        const loaded = this.markets?.[symbol] ?? this.markets_by_id?.[symbol]?.[0];
        if (loaded !== undefined) return loaded;
        const shaped = this.marketFromSymbol(symbol);
        return this.markets?.[shaped.symbol] ?? shaped;
    }

    override safeMarket(marketId: Str = undefined, market: Market = undefined, _delimiter: Str = undefined, _marketType: Str = undefined): MarketInterface {
        if (marketId !== undefined) {
            const loaded = this.markets_by_id?.[marketId]?.[0];
            if (loaded !== undefined) return loaded;
            if (market !== undefined && market.id === marketId) return market;
            return this.marketFromSymbol(marketId);
        }
        return market ?? this.safeMarketStructure({ symbol: undefined });
    }

    /** 토스가 거래할 수 있는 종목 전체를 마켓별로 받아 온다(`GET /stocks/all`, 마켓당 한 번). `params.markets` 로 마켓을 좁힐 수 있다. */
    override async fetchMarkets(params: Dict = {}): Promise<MarketInterface[]> {
        const markets = this.safeList(params, 'markets') ?? this.safeList(this.options, 'listedMarkets', [...LISTED_MARKETS]) as string[];
        const query = this.omit(params, 'markets');
        const result: MarketInterface[] = [];
        for (const market of markets) {
            const response = await this.privateMarketGetStocksAll(this.extend({ market }, query));
            for (const row of this.toArray(this.unwrap(response))) result.push(this.parseMarket(this.extend(row, { market })));
        }
        return result;
    }

    /** `GET /stocks/all` 의 한 행(여기에 요청한 `market` 을 더한 것)을 종목으로 옮긴다. */
    override parseMarket(market: Dict): MarketInterface {
        const id = this.safeString(market, 'symbol');
        if (id === undefined) throw new ExchangeError(`${this.id} parseMarket() missing symbol`);
        const listedMarket = this.safeString(market, 'market');
        const country: StockMarketGroup = listedMarket !== undefined && KR_LISTED_MARKETS.has(listedMarket) ? 'KR' : 'US';
        const quote = country === 'KR' ? 'KRW' : 'USD';
        const brokerage = country === 'KR' ? TOSS_BROKERAGE_FEE : TOSS_US_BROKERAGE_FEE;
        const base = this.commonStockCode(id);
        return this.safeMarketStructure({
            id,
            symbol: `${base}/${quote}`,
            base,
            quote,
            baseId: id,
            quoteId: quote,
            type: 'spot',
            spot: true,
            margin: false,
            active: true,
            // 시장별 기본 위탁수수료율이다. 실제 요율은 `fetchTradingFee`(`GET /commissions`)가 정한다. 미국에 국내 요율(0.015%)을 넣으면 미국 요율(0.1%)보다 훨씬 낮게 어림한다.
            taker: brokerage,
            maker: brokerage,
            precision: { amount: country === 'KR' ? 1 : 1 / US_FRACTION_SCALE, price: undefined },
            info: market,
            options: {
                country,
                market: listedMarket,
                name: this.safeString(market, 'name'),
                securityType: this.safeString(market, 'securityType'),
                isCommonShare: this.safeBool(market, 'isCommonShare'),
                isinCode: this.safeString(market, 'isinCode'),
            },
        });
    }

    /** 종목의 시장. */
    private countryOf(market: MarketInterface): StockMarketGroup {
        return market.quote === 'KRW' ? 'KR' : 'US';
    }

    /**
     * 가격을 호가 단위에 맞춘 문자열. 국내는 가격대별 호가 단위 표(`krx-tick-size`)로 반올림한다. 불러온 종목의 유형(`market.options.securityType`)이
     * 주식(`STOCK`)이 아니면 표가 달라서 그대로 돌려준다. 미국은 기반 구현(`precision.price`)을 따른다. 주문 경로는 이 메서드로 가격을 바꾸지 않는다.
     */
    override priceToPrecision(symbol: Str, price: number | string | undefined): Str {
        if (price === undefined) return undefined;
        const market = this.market(symbol);
        if (this.countryOf(market) !== 'KR') return super.priceToPrecision(symbol, price);
        const securityType = this.safeString(market.options, 'securityType');
        if (securityType !== undefined && securityType !== 'STOCK') return numberToString(price);
        return decimalToPrecision(price, ROUND, getKrxTickSize(Number(price)), TICK_SIZE, NO_PADDING);
    }

    /**
     * 국내 지정가가 호가 단위 표에 맞지 않으면 요청 전에 `InvalidOrder` 다. 불러온 종목이 주식(`STOCK`)일 때만 검사하고, 종목 유형을 모르거나
     * (`loadMarkets` 전) ETF·ETN 이면 서버에 맡긴다. 서버도 같은 경우를 `price-tick-invalid` 로 거절한다.
     */
    private assertKrxTickAligned(market: MarketInterface, price: number, method: string): void {
        if (this.countryOf(market) !== 'KR' || this.safeString(market.options, 'securityType') !== 'STOCK') return;
        const violation = krxTickViolation(price);
        if (violation !== null) throw new InvalidOrder(`${this.id} ${method}() ${violation} (${market.symbol})`, { detail: KRX_TICK_INVALID_DETAIL });
    }

    /** 요청 본문의 지정가. 국내는 호가에 맞추지 않고 그대로 보낸다(맞지 않는 가격은 `assertKrxTickAligned` 가 막거나 서버가 거절한다). */
    private orderPriceString(market: MarketInterface, price: Num): string | undefined {
        if (price === undefined) return undefined;
        return this.countryOf(market) === 'KR' ? numberToString(price) : this.priceToPrecision(market.symbol, price);
    }

    /** 종목 상세(종목명·상장 상태·국내 거래정지 여부)를 받아 온다(`GET /stocks`, 한 번에 200종목까지). */
    async fetchStocks(symbols: string[], params: Dict = {}): Promise<TossStockInfo[]> {
        const ids = symbols.map((symbol) => this.market(symbol).id as string);
        const response = await this.privateMarketGetStocks(this.extend({ symbols: ids.join(',') }, params));
        return this.toArray(this.unwrap(response)) as TossStockInfo[];
    }

    /**
     * 종목 유의사항(정리매매·투자경고·투자위험·단기과열·VI·신주인수권)을 받아 온다(`GET /stocks/{symbol}/warnings`).
     * 영업일 단위로 갱신되고 VI 만 수 초 단위라서, 자주 부르는 쪽은 캐시하는 것이 좋다.
     */
    async fetchStockWarnings(symbol: string, params: Dict = {}): Promise<TossStockWarning[]> {
        const response = await this.privateMarketGetStocksSymbolWarnings(this.extend({ symbol: this.market(symbol).id }, params));
        return this.toArray(this.unwrap(response)) as TossStockWarning[];
    }

    /**
     * 투자자별 매매대금(개인·외국인·기관·기타법인의 매수·매도 대금). 종목이 아니라 시장(`KOSPI`·`KOSDAQ`) 단위다. 종목 단위는 `fetchStockInvestorTrading` 이다.
     */
    async fetchMarketInvestorTrading(
        market: 'KOSPI' | 'KOSDAQ',
        interval: '1d' | '1w' | '1mo' | '1y' = '1d',
        limit = 5,
        params: Dict = {},
    ): Promise<TossInvestorTradingRecord[]> {
        const response = await this.privateMarketGetMarketIndicatorsSymbolInvestorTrading(this.extend({ symbol: market, interval, count: limit }, params));
        return this.safeList(this.unwrap(response), 'records', []) as TossInvestorTradingRecord[];
    }

    /**
     * @deprecated `fetchMarketInvestorTrading` 의 옛 이름이다. `fetchInvestorTrading` 은 종목 단위 공통 조회(한국투자증권, KB증권)의 이름이라
     * 토스증권의 `has.fetchInvestorTrading` 은 비어 있다. 다음 판에서 지운다.
     */
    async fetchInvestorTrading(
        market: 'KOSPI' | 'KOSDAQ',
        interval: '1d' | '1w' | '1mo' | '1y' = '1d',
        limit = 5,
        params: Dict = {},
    ): Promise<TossInvestorTradingRecord[]> {
        this.warnDeprecated('toss.fetchInvestorTrading()', 'fetchMarketInvestorTrading()');
        return this.fetchMarketInvestorTrading(market, interval, limit, params);
    }

    /** 시장 지표(국내 지수·국채) 현재가(`GET /market-indicators/prices`, 최대 200개). 심볼은 카탈로그 8종만 받고, 그 밖은 서버가 400으로 거절한다. */
    async fetchMarketIndicators(symbols: TossMarketIndicatorSymbol[], params: Dict = {}): Promise<TossPrice[]> {
        const response = this.unwrap<TossPrice[]>(await this.privateMarketGetMarketIndicatorsPrices(this.extend({ symbols: symbols.join(',') }, params)));
        return this.toArray(response) as TossPrice[];
    }

    /**
     * 시장 지표 캔들(`GET /market-indicators/{symbol}/candles`, 최대 200봉). 분봉(`1m`)은 지수(`KOSPI`·`KOSDAQ`)만, 국채는 일봉(`1d`)만 지원한다.
     * 개별 종목의 `fetchOHLCV`와는 다른 엔드포인트다 — `fetchOHLCV('KOSPI')`는 심볼 판정이 미국이라 일반 `/candles`를 부른다.
     * `params.before`에 응답의 `nextBefore`를 넣으면 다음 페이지를 받는다.
     */
    async fetchMarketIndicatorOHLCV(symbol: TossMarketIndicatorSymbol, timeframe: '1m' | '1d' = '1d', count = 100, params: Dict = {}): Promise<OHLCV[]> {
        const response = this.unwrap<TossCandlesResult>(await this.privateMarketGetMarketIndicatorsSymbolCandles(this.extend({ symbol, interval: timeframe, count }, params)));
        const candles = this.safeList(response, 'candles', []) as Dict[];
        return candles.map((candle) => this.parseOHLCV(candle));
    }

    /**
     * 종목 단위 투자자별 매매동향(`GET /stocks/{symbol}/investor-trading`, 국내 전용). 시장 단위인 `fetchMarketInvestorTrading`과 다르다.
     * 당일 기록은 장중 잠정치라 `individual`·`institution.breakdown`·`otherCorporation`·`foreignerHolding`·`cfd`가 `null`일 수 있다.
     * `params.until`에 응답의 `nextUntil`을 넣으면 다음 페이지를 받는다.
     */
    async fetchStockInvestorTrading(symbol: string, count = 5, params: Dict = {}): Promise<TossStockInvestorTradingResponse> {
        const market = this.market(symbol);
        const response = this.unwrap<TossStockInvestorTradingResponse>(await this.privateMarketGetStocksSymbolInvestorTrading(this.extend({ symbol: market.id, count }, params)));
        return { nextUntil: response.nextUntil ?? null, records: response.records ?? [] };
    }

    /**
     * 종목 단위 프로그램매매 동향(`GET /stocks/{symbol}/program-trades`, 국내 전용). 차익거래·비차익거래 각각의 매수·매도·순매수 거래량이다.
     * KRX 거래만 집계하고 NXT 거래는 포함하지 않는다. `params.until`에 응답의 `nextUntil`을 넣으면 다음 페이지를 받는다.
     */
    async fetchProgramTrades(symbol: string, count = 5, params: Dict = {}): Promise<TossProgramTradesResponse> {
        const market = this.market(symbol);
        const response = this.unwrap<TossProgramTradesResponse>(await this.privateMarketGetStocksSymbolProgramTrades(this.extend({ symbol: market.id, count }, params)));
        return { nextUntil: response.nextUntil ?? null, records: response.records ?? [] };
    }

    /**
     * 종목 단위 공매도 동향(`GET /stocks/{symbol}/short-selling`, 국내 전용). 공매도 거래량·거래대금과 해당 일자 전체 대비 비중을 일별로 준다.
     * 비중의 분모(정규장 외 세션 포함 누적 거래량·거래대금)가 없는 날짜는 비중이 `null`이다. `params.until`에 응답의 `nextUntil`을 넣으면 다음 페이지를 받는다.
     */
    async fetchShortSelling(symbol: string, count = 5, params: Dict = {}): Promise<TossShortSellingResponse> {
        const market = this.market(symbol);
        const response = this.unwrap<TossShortSellingResponse>(await this.privateMarketGetStocksSymbolShortSelling(this.extend({ symbol: market.id, count }, params)));
        return { nextUntil: response.nextUntil ?? null, records: response.records ?? [] };
    }

    /**
     * 종목 단위 신용거래 동향(`GET /stocks/{symbol}/credit-trades`, 국내 전용). 신용융자(`marginLoan`)와 신용대주(`stockLoan`) 각각의
     * 신규·상환·잔고 수량과 잔고 비율·공여율을 일별로 준다. 해당 일자에 한쪽 데이터만 있으면 없는 쪽은 `null`이다.
     * `params.until`에 응답의 `nextUntil`을 넣으면 다음 페이지를 받는다.
     */
    async fetchCreditTrades(symbol: string, count = 5, params: Dict = {}): Promise<TossCreditTradesResponse> {
        const market = this.market(symbol);
        const response = this.unwrap<TossCreditTradesResponse>(await this.privateMarketGetStocksSymbolCreditTrades(this.extend({ symbol: market.id, count }, params)));
        return { nextUntil: response.nextUntil ?? null, records: response.records ?? [] };
    }

    /**
     * 종목 단위 대차거래 동향(`GET /stocks/{symbol}/securities-lending`, 국내 전용). 기관 투자자 간 주식 대여·차입 거래이며,
     * 개인 신용거래인 신용대주(`fetchCreditTrades`의 `stockLoan`)와는 다른 데이터다. `params.until`에 응답의 `nextUntil`을 넣으면 다음 페이지를 받는다.
     */
    async fetchSecuritiesLending(symbol: string, count = 5, params: Dict = {}): Promise<TossSecuritiesLendingResponse> {
        const market = this.market(symbol);
        const response = this.unwrap<TossSecuritiesLendingResponse>(await this.privateMarketGetStocksSymbolSecuritiesLending(this.extend({ symbol: market.id, count }, params)));
        return { nextUntil: response.nextUntil ?? null, records: response.records ?? [] };
    }

    /**
     * 랭킹 상위 100위. `TOSS_SECURITIES_*` 는 토스증권 사용자의 체결 집중도이고 나머지는 시장 전체 기준이다.
     * `TOP_GAINERS`·`TOP_LOSERS` 는 `duration: 'realtime'` 을 지원하지 않는다.
     */
    async fetchRankings(
        type: TossRankingType,
        marketCountry: StockMarketGroup = 'KR',
        duration = '1d',
        count = 100,
        params: Dict = {},
    ): Promise<TossRankingItem[]> {
        const response = await this.privateMarketGetRankings(this.extend({ type, marketCountry, duration, count }, params));
        return this.safeList(this.unwrap(response), 'rankings', []) as TossRankingItem[];
    }

    // ============ 장 운영 캘린더와 세션 ============

    /**
     * 장 운영 캘린더(전일·당일·익일 영업일의 세션 시각)를 받아 온다. 30분 안에 받은 것은 다시 부르지 않는다(`params.refresh` 로 강제).
     * 받은 날짜별 개장 여부는 공용 휴장일 캘린더에도 넣는다. `market` 은 `'KR'`·`'US'` 이고 대소문자를 가리지 않는다. 그 밖의 값은 요청 없이 `BadRequest` 다.
     * 날짜별 개장 여부만 필요하면 세 증권사 공통인 `fetchMarketCalendar` 를 쓴다.
     */
    async fetchMarketSessions(market: StockMarketGroup | Lowercase<StockMarketGroup>, params: Dict = {}): Promise<TossKrMarketCalendar | TossUsMarketCalendar> {
        const country = String(market).toUpperCase();
        if (country !== 'KR' && country !== 'US') throw new BadRequest(`${this.id} fetchMarketSessions() market must be 'KR' or 'US'`);
        const cached = this.calendars[country];
        const ttl = this.safeInteger(this.options, 'calendarTtl', CALENDAR_TTL_MS) as number;
        if (cached !== undefined && this.safeBool(params, 'refresh', false) !== true && this.milliseconds() - cached.fetchedAt < ttl) return cached.value;
        if (country === 'KR') {
            const value = this.unwrap<TossKrMarketCalendar>(await this.privateMarketGetMarketCalendarKR({}));
            this.calendars.KR = { value, fetchedAt: this.milliseconds() };
            applyMarketCalendar('KR', tossKrCalendarDays(value));
            return value;
        }
        const value = this.unwrap<TossUsMarketCalendar>(await this.privateMarketGetMarketCalendarUS({}));
        this.calendars.US = { value, fetchedAt: this.milliseconds() };
        applyMarketCalendar('US', tossUsCalendarDays(value));
        return value;
    }

    /**
     * @deprecated 시장 문자열을 받던 옛 호출이다. 세션 시각 원본은 `fetchMarketSessions(market)` 로, 날짜별 개장 여부는
     * `fetchMarketCalendar({ market })` 로 받는다. 다음 판에서 지운다.
     */
    fetchMarketCalendar(market: StockMarketGroup | Lowercase<StockMarketGroup>, params?: Dict): Promise<TossKrMarketCalendar | TossUsMarketCalendar>;
    /**
     * 날짜별 개장 여부. 세 증권사 공통 모양이다. `params.market` 은 `'KR'`(기본)·`'US'` 이고 대소문자를 가리지 않는다. 그 밖의 값은 요청 없이 `BadRequest` 다.
     * 장 운영 캘린더(`fetchMarketSessions`)의 전일·당일·익일 영업일과 그 사이의 평일(닫힌 날)이다. 받은 날짜는 공용 휴장일 캘린더에도 넣는다.
     * 첫 인자로 시장 문자열을 넘기던 옛 호출은 한 판 동안 경고를 남기고 `fetchMarketSessions` 의 결과를 돌려준다.
     */
    fetchMarketCalendar(params?: Dict): Promise<CalendarDay[]>;
    async fetchMarketCalendar(marketOrParams: string | Dict = {}, params: Dict = {}): Promise<CalendarDay[] | TossKrMarketCalendar | TossUsMarketCalendar> {
        if (typeof marketOrParams === 'string') {
            this.warnDeprecated('toss.fetchMarketCalendar(market)', 'fetchMarketCalendar({ market }) 나 fetchMarketSessions(market)');
            return this.fetchMarketSessions(marketOrParams as StockMarketGroup, params);
        }
        const market = this.calendarMarket(marketOrParams);
        const value = await this.fetchMarketSessions(market, this.omit(marketOrParams, 'market'));
        return market === 'KR' ? tossKrCalendarDays(value as TossKrMarketCalendar) : tossUsCalendarDays(value as TossUsMarketCalendar);
    }

    /**
     * 국내 캘린더로 본 지금의 세션. `'closed'` 는 캘린더상 열린 세션이 없다는 뜻이고, `null` 은 캘린더를 받지 못했다는 뜻이다(호출하는 쪽이 정적 시간표로 판정한다).
     */
    async currentKrSession(now: Date = new Date(this.milliseconds())): Promise<TossKrSession | 'closed' | null> {
        try {
            const calendar = await this.fetchMarketSessions('KR') as TossKrMarketCalendar;
            return findKrSession(calendar, now) ?? 'closed';
        } catch (err) {
            logger.warn({ err }, '[toss] 국내 장 운영 캘린더를 받지 못했다. 정적 시간표로 판정한다');
            return null;
        }
    }

    /** 미국 캘린더로 본 지금의 세션. `'closed'` 와 `null` 의 뜻은 `currentKrSession` 과 같다. */
    async currentUsSession(now: Date = new Date(this.milliseconds())): Promise<TossUsSession | 'closed' | null> {
        try {
            const calendar = await this.fetchMarketSessions('US') as TossUsMarketCalendar;
            return findUsSession(calendar, now) ?? 'closed';
        } catch (err) {
            logger.warn({ err }, '[toss] 미국 장 운영 캘린더를 받지 못했다. 정규장 기준으로 판정한다');
            return null;
        }
    }

    /**
     * 지금 이 종목을 소수점 수량으로 살 수 있는가(금액 주문이 접수되는 시간인가). 미국 정규장이 열려 있고 종료 1시간 전 이전이어야 한다.
     * 국내 종목, 정규장 밖, 캘린더를 받지 못한 경우는 `false` 다.
     */
    async supportsFractionalBuy(symbol: string): Promise<boolean> {
        if (this.countryOf(this.market(symbol)) !== 'US') return false;
        const now = new Date(this.milliseconds());
        if ((await this.currentUsSession(now)) !== 'regularMarket') return false;
        const close = findUsRegularCloseMs(this.calendars.US?.value, now);
        return close === null || now.getTime() < close - FRACTIONAL_ORDER_CUTOFF_MS;
    }

    // ============ 시세 ============

    override parseTicker(ticker: Dict, market: Market = undefined): Ticker {
        const marketId = this.safeString(ticker, 'symbol');
        market = this.safeMarket(marketId, market);
        const timestamp = this.parse8601(this.safeString(ticker, 'timestamp'));
        const last = this.safeString(ticker, 'lastPrice');
        // 토스의 현재가 응답에는 최종가만 있다. 호가·거래량은 없으므로 비워 둔다.
        return this.safeTicker({
            symbol: market.symbol,
            timestamp,
            datetime: this.iso8601(timestamp),
            close: last,
            last,
            info: ticker,
        }, market);
    }

    override async fetchTicker(symbol: string, params: Dict = {}): Promise<Ticker> {
        const market = this.market(symbol);
        const rows = this.toArray(this.unwrap(await this.privateMarketGetPrices(this.extend({ symbols: market.id }, params))));
        const row = rows.find((candidate) => this.safeString(candidate, 'symbol') === market.id) ?? rows[0];
        if (row === undefined) throw new NullResponse(`${this.id} fetchTicker() 응답에 ${market.id} 가 없다`);
        return this.parseTicker(row, market);
    }

    /** 여러 종목의 현재가. 토스는 한 번에 200종목까지 받는다. 종목을 주지 않으면 `ArgumentsRequired`(전 종목 시세는 없다). */
    override async fetchTickers(symbols: Strings = undefined, params: Dict = {}): Promise<Tickers> {
        if (symbols === undefined || symbols.length === 0) throw new ArgumentsRequired(`${this.id} fetchTickers() requires a list of symbols`);
        const unified = this.marketSymbols(symbols) as string[];
        const ids = unified.map((symbol) => this.market(symbol).id as string);
        const rows: Dict[] = [];
        const BATCH = 200;
        for (let i = 0; i < ids.length; i += BATCH) {
            const response = await this.privateMarketGetPrices(this.extend({ symbols: ids.slice(i, i + BATCH).join(',') }, params));
            rows.push(...this.toArray(this.unwrap(response)));
        }
        return this.parseTickers(rows, unified);
    }

    override async fetchOrderBook(symbol: string, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        const market = this.market(symbol);
        const response = this.unwrap<Dict>(await this.privateMarketGetOrderbook(this.extend({ symbol: market.id }, params)));
        const timestamp = this.parse8601(this.safeString(response, 'timestamp'));
        const orderbook = this.parseOrderBook(response, market.symbol, timestamp, 'bids', 'asks', 'price', 'volume');
        const valid = (level: [Num, Num]): boolean => level[0] !== undefined && Number.isFinite(level[0]) && level[0] > 0;
        orderbook.bids = orderbook.bids.filter(valid);
        orderbook.asks = orderbook.asks.filter(valid);
        if (limit !== undefined) {
            orderbook.bids = orderbook.bids.slice(0, limit);
            orderbook.asks = orderbook.asks.slice(0, limit);
        }
        return orderbook;
    }

    /**
     * 봉을 받아 온다. 토스는 `1m` 과 `1d` 만 제공한다. 다른 주기는 가까운 주기로 바꾸지 않고 던진다.
     * 필요한 주기는 호출하는 쪽이 1분봉을 모아 만든다.
     *
     * 봉의 `timestamp` 는 봉의 시작 시각이다(토스의 1분봉은 종료 시각으로 오므로 1분을 뺀다). `params.until`(ms)은 이 시각 이전의 봉만 받는다.
     * `since` 가 있으면 `since` 부터 `limit` 개이고, 없으면 가장 최근 `limit` 개다. 최신 봉부터 200봉씩 10쪽까지 거슬러 받으므로,
     * 그 안에 `since` 까지 닿지 못하면 경고 로그를 남기고 받은 가장 오래된 봉부터 돌려준다.
     */
    override async fetchOHLCV(symbol: string, timeframe = '1m', since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<OHLCV[]> {
        const interval = this.safeString(this.timeframes, timeframe);
        if (interval === undefined) {
            throw new NotSupported(`${this.id} 미지원 타임프레임 '${timeframe}'. 지원: 1m, 1d`);
        }
        const market = this.market(symbol);
        const target = Math.max(1, limit ?? DEFAULT_CANDLE_LIMIT);
        const until = this.safeInteger(params, 'until');
        const query = this.omit(params, 'until');
        const barStartShift = timeframe === '1m' ? this.parseTimeframe('1m') * 1000 : 0;
        // 일봉은 거래일의 00:00 UTC 로 옮긴다(`candlePeriodUtcMs`). 토스는 현지 자정(국내 00:00 KST, 미국 00:00 ET)으로 준다.
        const dailyMarket = isDailyOrLongerTimeframe(timeframe) ? this.countryOf(market) : undefined;
        let before: string | undefined = until !== undefined ? this.iso8601(until) : undefined;
        const rows: OHLCV[] = [];
        let reachedSince = false;
        let exhausted = false;

        for (let page = 0; page < MAX_CANDLE_PAGES; page++) {
            // `since` 가 있으면 `since` 까지 거슬러 가야 하므로 쪽마다 최대로 받는다.
            const count = since === undefined ? Math.min(CANDLE_PAGE_LIMIT, target - rows.length) : CANDLE_PAGE_LIMIT;
            const response = this.unwrap<Dict>(await this.privateMarketGetCandles(this.extend({ symbol: market.id, interval, count, before, adjusted: 'true' }, query)));
            const candles = this.safeList(response, 'candles', []) as Dict[];
            if (candles.length === 0) {
                exhausted = true;
                break;
            }
            for (const candle of candles) {
                const row = this.parseOHLCV(candle, market);
                const start = row[0];
                if (start === undefined) continue;
                const shifted = dailyMarket !== undefined ? candlePeriodUtcMs(start, timeframe, dailyMarket) : start - barStartShift;
                if (since !== undefined && shifted <= since) reachedSince = true;
                if (since !== undefined && shifted < since) continue;
                rows.push([shifted, row[1], row[2], row[3], row[4], row[5]]);
            }
            const nextBefore = this.safeString(response, 'nextBefore');
            if (nextBefore === undefined) {
                exhausted = true;
                break;
            }
            if (since === undefined ? rows.length >= target : reachedSince) break;
            before = nextBefore;
        }
        if (since !== undefined && !reachedSince && !exhausted) {
            logger.warn({ symbol: market.symbol, timeframe, since, pages: MAX_CANDLE_PAGES },
                '[toss] 캔들 페이지 상한에 닿아 since 까지 받지 못했다. 받은 가장 오래된 봉부터 돌려준다');
        }

        const seen = new Set<number>();
        const sorted = rows
            .filter((row) => (row[0] as number) > 0 && Number.isFinite(row[4]) && (row[4] as number) > 0)
            .filter((row) => { if (seen.has(row[0] as number)) return false; seen.add(row[0] as number); return true; })
            .sort((a, b) => (a[0] as number) - (b[0] as number));
        return since === undefined ? sorted.slice(-target) : sorted.slice(0, target);
    }

    override parseOHLCV(ohlcv: unknown, _market: Market = undefined): OHLCV {
        return [
            this.parse8601(this.safeString(ohlcv as Dict, 'timestamp')),
            this.safeNumber(ohlcv as Dict, 'openPrice'),
            this.safeNumber(ohlcv as Dict, 'highPrice'),
            this.safeNumber(ohlcv as Dict, 'lowPrice'),
            this.safeNumber(ohlcv as Dict, 'closePrice'),
            this.safeNumber(ohlcv as Dict, 'volume'),
        ];
    }

    /**
     * 당일 최근 체결 내역(`GET /trades`, 최대 50건, 기본 50건). 체결가·체결수량·체결시각만 오고 방향(매수·매도)과 체결ID는 없다
     * — `parseTrade`(자기 주문의 체결, `fetchMyTrades`)가 쓰는 행과 모양이 달라 여기서는 별도로 옮긴다.
     */
    async fetchTrades(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        const market = this.market(symbol);
        const count = limit !== undefined ? Math.min(Math.max(1, limit), 50) : undefined;
        const response = this.unwrap<Dict[]>(await this.privateMarketGetTrades(this.extend({ symbol: market.id, count }, params)));
        const trades = this.toArray(response).map((row) => this.parsePublicTrade(row, market));
        return since !== undefined ? trades.filter((trade) => (trade.timestamp ?? 0) >= since) : trades;
    }

    private parsePublicTrade(trade: Dict, market: MarketInterface): Trade {
        const timestamp = this.parse8601(this.safeString(trade, 'timestamp'));
        return this.safeTrade({
            info: trade,
            id: undefined,
            order: undefined,
            timestamp,
            datetime: this.iso8601(timestamp),
            symbol: market.symbol,
            type: undefined,
            side: undefined,
            takerOrMaker: undefined,
            price: this.safeString(trade, 'price'),
            amount: this.safeString(trade, 'volume'),
            cost: undefined,
            fee: undefined,
        }, market);
    }

    // ============ 잔고 ============

    /**
     * 잔고. 현금은 통화 키(`KRW`·`USD`)이고 값은 현금 매수 가능 금액이며, 보유 종목은 `market.base` 키(`005930`, `AAPL`)이고 `total` 이 보유 수량이다.
     * 종목의 평균단가·평가금액·종목명은 `balances[code].info` 에 있다. 조회에 실패하면 던진다. 미국 티커 `USD` 처럼 현금 코드와 같은 티커는
     * `commonStockCodes` 의 통합 코드(`ProShares Ultra Semiconductors`)가 키다. 표에 없는 티커가 현금 키와 겹치면 한쪽을 덮어쓰지 않고
     * `NotSupported` 를 던진다. 아래 `symbol` 과 `currency` 로 나눠 받거나 `commonStockCodes` 에 그 티커를 더한다.
     *
     * `free` 는 지금 주문에 쓸 수 있는 양이다(ccxt 정의). 현금은 매수 가능 금액만 있고 예수금을 주는 API 가 없어 `total` 과 `used` 가 비어 있다.
     * 보유 종목의 `free` 는 `symbol` 로 한 종목만 받을 때 매도 가능 수량으로 채우고, 전체 잔고에서는 비어 있다(종목마다 요청을 더하지 않는다).
     *
     * `params` 로 범위를 좁힐 수 있다.
     * - `symbol`: 그 종목의 보유만 받는다(`currency` 가 없으면 현금은 받지 않는다). 보유가 있으면 매도 가능 수량(`fetchSellableQuantity`)을 받아 `free` 로 쓴다.
     * - `currency`: `'KRW'` 또는 `'USD'` 현금만 받는다(`symbol` 이 없으면 보유 종목은 받지 않는다).
     * - 둘 다 주면 그 종목의 보유와 그 통화의 현금을 함께 받는다.
     *
     * `currency: 'USD'` 로 달러만 받을 때, 통합증거금 옵션(`options.krwIntegratedMargin`)이 켜져 있으면 원화 예수금을 참고 환율로 환산해 달러 금액에 더한다.
     * 원화만 가진 계좌도 미국 주식을 살 수 있기 때문이다. 전체 잔고에는 원화와 달러가 이미 각각 실려 있으므로 합산하지 않는다(이중 계상이 된다).
     */
    override async fetchBalance(params: Dict = {}): Promise<Balances> {
        const symbol = this.safeString(params, 'symbol');
        const currency = this.safeStringUpper(params, 'currency');
        if (currency !== undefined && currency !== 'KRW' && currency !== 'USD') {
            throw new ArgumentsRequired(`${this.id} fetchBalance() currency must be 'KRW' or 'USD'`);
        }
        let holdings: TossHoldingsOverview | undefined;
        let sellable: Dictionary<number> | undefined;
        if (currency === undefined || symbol !== undefined) {
            const id = symbol !== undefined ? this.market(symbol).id as string : undefined;
            holdings = this.unwrap<TossHoldingsOverview>(await this.privateAccountGetHoldings(id !== undefined ? { symbol: id } : {}));
            // 보유 목록이 없으면 "보유 없음"이 아니라 모르는 것이다.
            if (!Array.isArray(holdings?.items)) {
                throw new BadResponse(`${this.id} 보유 조회 응답에 items 목록이 없다: ${String(JSON.stringify(holdings)).slice(0, 200)}`);
            }
            if (id !== undefined && holdings.items.some((item) => item.symbol === id && (this.safeNumber(item, 'quantity') ?? 0) > 0)) {
                sellable = { [id]: await this.fetchSellableQuantity(id) };
            }
        }
        const buyingPower: Dictionary<TossBuyingPower> = {};
        if (symbol === undefined || currency !== undefined) {
            for (const code of currency !== undefined ? [currency] : ['KRW', 'USD']) {
                buyingPower[code] = this.unwrap<TossBuyingPower>(await this.privateAccountGetBuyingPower({ currency: code }));
            }
        }
        let integrated: { krw: number; usdKrw: number; krwAsUsd: number } | undefined;
        if (currency === 'USD' && await this.isOptionEnabled('krwIntegratedMargin')) {
            integrated = await this.krwAsUsd();
        }
        return this.parseBalance({ holdings, sellable, buyingPower, integrated });
    }

    /** 원화 매수 여력을 참고 환율로 달러로 환산한다. 원화가 없거나 환율을 모르면 `undefined`. */
    private async krwAsUsd(): Promise<{ krw: number; usdKrw: number; krwAsUsd: number } | undefined> {
        const krw = this.parseCash(this.unwrap<TossBuyingPower>(await this.privateAccountGetBuyingPower({ currency: 'KRW' })));
        if (!(krw > 0)) return undefined;
        const usdKrw = await this.usdKrwRate();
        if (!(usdKrw > 0)) return undefined;
        return { krw, usdKrw, krwAsUsd: krw / usdKrw };
    }

    /** 매수 가능 금액. 필드가 없거나 숫자가 아니면 0 이 아니라 모르는 것이므로 던진다. 음수(미수)는 0 으로 둔다(원값은 `info`). */
    private parseCash(buyingPower: TossBuyingPower | undefined): number {
        const raw = buyingPower?.cashBuyingPower;
        const cash = raw === undefined || raw === null || String(raw).trim() === '' ? NaN : Number(raw);
        if (!Number.isFinite(cash)) throw new BadResponse(`${this.id} 매수 가능 금액 응답에 cashBuyingPower 가 없거나 숫자가 아니다: ${JSON.stringify(buyingPower)}`);
        return cash > 0 ? cash : 0;
    }

    /**
     * `fetchBalance` 가 모은 응답(`{ holdings, sellable, buyingPower, integrated }`)을 `Balances` 로 옮긴다. `sellable` 은 종목 id 별 매도 가능 수량이다.
     * 보유 종목의 `free` 는 그 값이고 없으면 비운다. `used` 는 `safeBalance` 가 `total − free` 로 채운다.
     */
    override parseBalance(response: unknown): Balances {
        const { holdings, sellable, buyingPower, integrated } = response as {
            holdings?: TossHoldingsOverview;
            sellable?: Dictionary<number>;
            buyingPower?: Dictionary<TossBuyingPower>;
            integrated?: { krw: number; usdKrw: number; krwAsUsd: number };
        };
        const result: Dict = { info: response, timestamp: undefined, datetime: undefined };
        const held: Dict = {};
        for (const item of holdings?.items ?? []) {
            const quantity = this.safeNumber(item, 'quantity');
            if (quantity === undefined || !(quantity > 0)) continue;
            // 키는 `parseMarket` 의 `base` 다(`USD` → `ProShares Ultra Semiconductors`).
            held[this.commonStockCode(String(item.symbol))] = { free: sellable?.[item.symbol], used: undefined, total: quantity, info: item };
        }
        for (const [code, power] of Object.entries(buyingPower ?? {})) {
            let cash = this.parseCash(power);
            const info: Dict = { ...power };
            if (code === 'USD' && integrated !== undefined) {
                logger.info({ usdCash: cash, ...integrated }, '[toss] 통합증거금: 원화 매수 여력을 달러로 환산해 합산한다');
                cash += integrated.krwAsUsd;
                info.integratedMargin = integrated;
            }
            // 매수 가능 금액은 정산 뒤 계좌 현금이 아니다. `total` 과 `used` 는 모른다.
            result[code] = { free: cash, used: undefined, total: undefined, info };
        }
        for (const [code, holding] of Object.entries(held)) {
            // 겹친 키에 대입하면 보유나 현금 한쪽이 알림 없이 사라진다.
            if (result[code] !== undefined) {
                throw new NotSupported(`${this.id} fetchBalance() 보유 종목 ${code} 가 현금 ${code} 와 키가 같아 한 잔고에 담을 수 없다. `
                    + 'params.symbol 로 그 종목의 보유를, params.currency 로 현금을 따로 받거나 commonStockCodes 에 그 티커의 통합 코드를 더한다');
            }
            result[code] = holding;
        }
        return this.safeBalance(result);
    }

    // ============ 수수료 ============

    /** 수수료율 조회(`GET /commissions`) 원본. */
    async fetchCommissions(params: Dict = {}): Promise<TossCommission[]> {
        return this.toArray(this.unwrap(await this.privateAccountGetCommissions(params))) as TossCommission[];
    }

    /** 당일 상·하한가 조회(`GET /price-limits`) 원본. 해외는 가격 제한이 없어 두 값 모두 `null`이다. */
    async fetchPriceLimit(symbol: string, params: Dict = {}): Promise<TossPriceLimit> {
        const market = this.market(symbol);
        return this.unwrap<TossPriceLimit>(await this.privateMarketGetPriceLimits(this.extend({ symbol: market.id }, params)));
    }

    /**
     * 매도 주문에 즉시 쓸 수 있는 수량(`GET /sellable-quantity`). 미체결 매도 주문에 잡힌 수량, 결제 전(T+1/T+2) 미결제분 등은 보유량에는 있어도
     * 지금 팔 수 없어 빠진다. `fetchBalance({ symbol })` 는 이 값을 그 종목의 `free` 로 쓴다. 값이 없거나 숫자가 아니면 0 이 아니라 모르는 것이므로 던진다.
     */
    async fetchSellableQuantity(symbol: string, params: Dict = {}): Promise<number> {
        const market = this.market(symbol);
        const response = this.unwrap<{ sellableQuantity: string }>(
            await this.privateAccountGetSellableQuantity(this.extend({ symbol: market.id }, params)),
        );
        const quantity = this.safeNumber(response, 'sellableQuantity');
        if (quantity === undefined) {
            throw new BadResponse(`${this.id} 매도 가능 수량 응답에 sellableQuantity 가 없거나 숫자가 아니다: ${JSON.stringify(response)}`);
        }
        return quantity;
    }

    /**
     * 시장별 위탁수수료율을 받아 캐시한다(24시간). 캐시가 신선하면 부르지 않는다. 실패하면 던지고, 그동안 `effectiveFeeRate` 는 기본 요율을 쓴다.
     */
    async refreshCommissions(): Promise<void> {
        const ttl = this.safeInteger(this.options, 'commissionsTtl', COMMISSIONS_TTL_MS) as number;
        if (this.commissionRates.size > 0 && this.milliseconds() - this.commissionsFetchedAt < ttl) return;
        const rows = await this.fetchCommissions();
        const today = kstDate(this.milliseconds());
        for (const country of ['KR', 'US'] as const) {
            const rate = pickCommissionRate(rows, country, today);
            if (rate !== null) this.commissionRates.set(country, rate);
        }
        this.commissionsFetchedAt = this.milliseconds();
        logger.info({ rates: Object.fromEntries(this.commissionRates) }, '[toss] 수수료율을 갱신했다');
    }

    /**
     * 위탁수수료율. `maker` 와 `taker` 는 같다. 국내 매도에 붙는 증권거래세는 별도이며 `effectiveFeeRate` 에 더해진다.
     */
    override async fetchTradingFee(symbol: string, _params: Dict = {}): Promise<TradingFeeInterface> {
        await this.refreshCommissions();
        const market = this.market(symbol);
        const brokerage = this.commissionRates.get(this.countryOf(market)) ?? this.defaultBrokerage(this.countryOf(market));
        return { info: Object.fromEntries(this.commissionRates), symbol: market.symbol, maker: brokerage, taker: brokerage, percentage: true, tierBased: false };
    }

    private defaultBrokerage(country: StockMarketGroup): number {
        return getTossEffectiveFeeRate(country, 'buy');
    }

    /**
     * 실효 매매비용률: 위탁수수료에 (국내 매도라면) 증권거래세를 더한 값이다. 캐시한 요율이 없으면 기본 요율을 쓴다.
     * 국내 상장 ETF·ETN 은 매도에도 증권거래세가 붙지 않는다. `loadMarkets` 로 종목 유형을 불러온 경우에만 알 수 있어, 그렇지 않으면 세금을 더한 값이다.
     * 체결 뒤에는 주문 응답의 `execution.commission`·`execution.tax` 가 확정값이므로 이 값은 사전 추정과 폴백에 쓴다.
     */
    effectiveFeeRate(symbol: string, side: 'buy' | 'sell', at: Date = new Date(this.milliseconds())): number {
        const market = this.market(symbol);
        const country = this.countryOf(market);
        const securityType = this.safeString(market.options, 'securityType');
        const taxExempt = country === 'KR' && securityType !== undefined && TAX_EXEMPT_SECURITY_TYPES.has(securityType);
        return getTossEffectiveFeeRate(country, side, at, this.commissionRates.get(country), taxExempt);
    }

    // ============ 환율과 고액주문 ============

    /** 참고 환율(1달러당 원화). 토스의 환율 조회(`GET /exchange-rate`)를 먼저 쓰고, 실패하면 `options.usdKrwRate` 로 폴백한다. 5분 캐시. 알 수 없으면 0. */
    private async usdKrwRate(): Promise<number> {
        const ttl = this.safeInteger(this.options, 'fxRateTtl', FX_RATE_TTL_MS) as number;
        if (this.fxRate !== undefined && this.milliseconds() - this.fxRate.fetchedAt < ttl) return this.fxRate.rate;
        let rate = 0;
        try {
            const response = this.unwrap<Dict>(await this.privateMarketGetExchangeRate({ baseCurrency: 'USD', quoteCurrency: 'KRW' }));
            const parsed = this.safeNumber(response, 'rate');
            if (parsed !== undefined && parsed > 0) rate = parsed;
        } catch (err) {
            logger.debug({ err }, '[toss] 환율 조회에 실패해 환율 소스로 폴백한다');
        }
        const fallback = this.options.usdKrwRate as UsdKrwRateOption | undefined;
        if (rate <= 0 && fallback !== undefined) {
            try { rate = await fallback(); } catch { rate = 0; }
        }
        if (Number.isFinite(rate) && rate > 0) {
            this.fxRate = { rate, fetchedAt: this.milliseconds() };
            return rate;
        }
        return 0;
    }

    /**
     * 고액주문 확인 기준을 넘는가. 국내는 1억원, 미국은 1억원을 환율로 나눈 달러 금액이다.
     * 환율을 알 수 없으면 고정 기준(7만 달러)을 쓴다. 환율이 높을수록 기준이 낮아지므로 고정 기준만 쓰면 1억원을 넘는 주문이 확인 없이 나가 거절된다.
     */
    private async isHighValue(notional: number, country: StockMarketGroup): Promise<boolean> {
        if (!(notional > 0)) return false;
        if (country === 'KR') return notional >= TOSS_HIGH_VALUE_THRESHOLD_KRW;
        if (notional >= TOSS_HIGH_VALUE_THRESHOLD_USD) return true;
        if (notional < HIGH_VALUE_USD_LOOKUP_FLOOR) return false;
        const rate = await this.usdKrwRate();
        return rate > 0 && notional >= (TOSS_HIGH_VALUE_THRESHOLD_KRW / rate) * HIGH_VALUE_MARGIN;
    }

    // ============ 주문 ============

    /**
     * 주문 수량을 토스의 규칙에 맞춘다.
     * - 국내: 정수 주. 소수점은 내린다.
     * - 미국 시장가 매도: 소수점 허용(6자리에서 버린다). 소수점 수량이 허용되는 유일한 조합이다.
     * - 그 밖의 미국 주문(지정가, 시장가 매수): 정수 주. 내린 뒤 0 이면 던진다. 소수점으로 사려면 금액 주문(`params.cost`)을 쓴다.
     *
     * 수량이 유한하지 않거나 0 이하이면 `ArgumentsRequired` 다.
     */
    normalizeQuantity(symbol: string, type: OrderType, side: OrderSide, amount: number): number {
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new ArgumentsRequired(`${this.id} 주문 수량 비정상: ${amount} (${symbol} ${side})`);
        }
        const country = this.countryOf(this.market(symbol));
        const fractionalAllowed = country === 'US' && type === 'market' && side === 'sell';
        // 십진 문자열로 자른다. `Math.floor(8.2 * 1e6)` 은 `8199999` 라 0.000001주가 덜 나간다.
        if (fractionalAllowed) return Number(decimalToPrecision(amount, TRUNCATE, US_FRACTION_DIGITS, DECIMAL_PLACES));
        const floored = Math.floor(amount);
        if (floored <= 0) {
            const hint = country === 'US' && side === 'buy' ? ' — US 소수점 매수는 금액(cost) 주문을 사용할 것' : '';
            throw new InvalidOrder(`${this.id} 주문 수량 floor 후 0: ${amount} → ${floored} (${symbol} ${side})${hint}`);
        }
        if (floored !== amount) {
            logger.warn({ requested: amount, floored, symbol, side, country, type },
                country === 'KR' ? '[toss] 분수 주문을 정수로 내린다(국내 단주)' : '[toss] 분수 주문을 정수로 내린다(미국 소수점은 시장가 매도 전용)');
        }
        return floored;
    }

    /**
     * 주문을 낸다. 조건주문(`params.triggerPrice`)은 서버가 가격을 감시하다 조건이 맞으면 내는 주문이다.
     * 인자와 `params` 의 뜻은 파일 머리의 표를 본다.
     *
     * 접수된 주문은 상세를 짧게 조회해 체결을 확정한다. 확장세션(프리·애프터, 미국 주간거래)에서 시장가 주문은 매수와 매도 모두 지정가로 바꿔 낸다
     * (확장세션은 지정가만 받는다. 기능 옵션 `nxtRouting`·`usExtendedLimit` 가 켜져 있을 때만). 이때 지정가가 아직 체결되지 않았으면
     * 체결됐다고 하지 않고 미체결 주문(`status: 'open'`, `order.info.extendedSession` 에 세션 이름)을 돌려준다.
     */
    override async createOrder(
        symbol: string,
        type: OrderType,
        side: OrderSide,
        amount: number,
        price: Num = undefined,
        params: Dict = {},
    ): Promise<Order> {
        if (side !== 'buy' && side !== 'sell') throw new InvalidOrder(`${this.id} createOrder() side must be 'buy' or 'sell'`);
        if (type !== 'limit' && type !== 'market') throw new InvalidOrder(`${this.id} createOrder() type must be 'limit' or 'market'`);
        this.assertNoConditionalParams('createOrder', params);
        const market = this.market(symbol);
        const country = this.countryOf(market);

        if (this.safeValue(params, 'triggerPrice') !== undefined) {
            return this.createConditionalOrder(market, type, side, amount, price, params);
        }
        this.assertNoComputedParams('createOrder', params, ORDER_COMPUTED_FIELDS);

        const isMarket = type === 'market';
        const cost = this.safeNumber(params, 'cost');
        // 미국 시장가 매수에 금액이 있으면 금액 기준 주문이다(소수점으로 체결된다). 그 밖에는 수량 기준이고 금액은 쓰지 않는다.
        const useAmountBased = isMarket && side === 'buy' && country === 'US' && cost !== undefined && cost > 0;
        if (!useAmountBased && type === 'limit' && price === undefined) {
            throw new ArgumentsRequired(`${this.id} createOrder() requires a price argument for a limit order`);
        }
        if (type === 'limit' && price !== undefined) this.assertKrxTickAligned(market, price, 'createOrder');
        const quantity = useAmountBased ? 0 : this.normalizeQuantity(symbol, type, side, amount);
        const clientOrderId = this.safeString(params, 'clientOrderId');
        const timeInForce = this.parseTimeInForce(params);

        // 확장세션 시장가는 지정가로 바꿔 낸다. 바꾸지 않으면 세션 게이트를 열어도 주문 형태 검사에서 막힌다.
        let effectiveType: OrderType = type;
        let effectivePrice = price;
        let extendedSession: string | undefined;
        if (isMarket && !useAmountBased) {
            const conversion = country === 'US'
                ? await this.usExtendedSessionConversion(symbol, side, quantity)
                : await this.krExtendedSessionConversion(symbol, side);
            if (conversion !== null) {
                if (conversion.error !== undefined) {
                    logger.warn({ symbol, side, session: conversion.session, reason: conversion.error }, '[toss] 확장세션 지정가 전환을 보류한다');
                    throw new OrderNotSent(conversion.error, { detail: 'extended-session-limit-unavailable' });
                }
                effectiveType = 'limit';
                effectivePrice = conversion.price;
                extendedSession = conversion.session;
                logger.info({ symbol, side, session: conversion.session, price: effectivePrice }, '[toss] 확장세션이라 시장가를 지정가로 바꿔 낸다');
            }
        }

        // 거래시간 검사: 국내는 캘린더의 세션, 미국은 캘린더의 네 세션으로 판정한다. 실주문 직전의 마지막 방어선이다.
        const gate = await this.checkOrderableSession(symbol, country, { isMarket: effectiveType === 'market', useAmountBased, quantity }, side);
        if (gate !== null) {
            logger.info({ symbol, side, reason: gate }, '[toss] 거래시간 밖이라 주문을 보내지 않는다');
            throw new MarketClosed(gate);
        }

        const body: Dict = {
            symbol: market.id,
            side: side === 'sell' ? 'SELL' : 'BUY',
            orderType: effectiveType === 'market' ? 'MARKET' : 'LIMIT',
        };
        if (clientOrderId !== undefined) body.clientOrderId = clientOrderId;
        if (timeInForce !== undefined) body.timeInForce = timeInForce;
        if (useAmountBased) {
            body.orderAmount = this.numberToString(cost as number);
        } else {
            body.quantity = this.numberToString(quantity);
        }
        if (effectiveType === 'limit') body.price = this.orderPriceString(market, effectivePrice);

        // 고액주문 확인 표시. 명목가를 알 수 있는 경우에만 붙인다(수량 기준 시장가는 서버의 400 이 마지막 방어선이다).
        const notional = useAmountBased ? (cost as number) : (effectivePrice !== undefined ? quantity * effectivePrice : 0);
        if (await this.isHighValue(notional, country)) {
            body.confirmHighValueOrder = true;
            logger.warn({ symbol, notional, country }, '[toss] 고액주문이라 confirmHighValueOrder 를 켠다');
        }

        const response = this.unwrap<TossOrderCreateResponse>(await this.privateAccountPostOrders(this.extend(body, this.omit(params, ORDER_HANDLED_PARAMS))));
        const orderId = this.safeString(response, 'orderId');
        if (orderId === undefined) {
            throw new OrderOutcomeUnknown(`${this.id} 주문 접수 응답에 orderId 가 없다. 접수 여부를 주문 조회로 확인해야 한다`);
        }

        const draft = { market, type: effectiveType, side, price: effectivePrice, quantity, useAmountBased, cost, orderId, clientOrderId, timeInForce, response, extendedSession };

        // 확장세션 지정가는 즉시 체결이 보장되지 않으므로 체결을 가정하지 않는다. 접수 직후 미체결 장부에 남아 있으면 미체결 주문으로 돌려준다.
        if (extendedSession !== undefined) {
            const stillOpen = await this.fetchOpenOrders(symbol).then((list) => list.some((o) => o.id === orderId)).catch(() => true);
            if (stillOpen) {
                logger.info({ orderId, symbol, price: effectivePrice }, '[toss] 확장세션 지정가가 접수됐고 아직 체결되지 않았다');
                return this.buildCreatedOrder({ ...draft, status: 'open', stillOpen: true });
            }
        }

        logger.info({ orderId, symbol, side, type: effectiveType }, '[toss] 주문이 접수됐다');
        if (this.safeBool(params, 'confirmExecution', this.options.confirmExecution !== false) === false) {
            return this.buildCreatedOrder({ ...draft, status: 'open' });
        }
        const { snapshot, last } = await this.confirmOrderExecution(orderId, country);
        // 마지막 조회의 `result` 가 `null` 이면 조회하지 못한 것과 같다. 주문은 이미 접수됐으므로 던지지 않고 미체결로 돌려준다.
        return this.buildCreatedOrder({ ...draft, snapshot, raw: last ?? undefined, status: last != null ? this.parseOrderStatus(last.status) : 'open' });
    }

    /**
     * 주문을 정정한다. 잔량 전부를 새 가격으로 옮긴다. 국내는 정정 본문의 수량(`quantity`)에 주문 상세(`GET /orders/{orderId}`)로 읽은 잔량을
     * 싣고, 미국은 가격만 보낸다. `amount` 는 ccxt 와 같이 정정 뒤 주문의 총수량(체결분 포함)이고, 주면 주문 상세로 대조해 총수량과 다르면
     * 정정 요청 없이 `NotSupported` 다(수량을 바꾸는 정정은 한 요청으로 낼 수 없다). 명세의 `quantity` 가 정정 뒤 총수량인지 새 가격으로 옮길
     * 수량인지 정해지지 않아, 국내는 두 뜻이 같은 값이 되는 체결 없는 주문만 정정하고 일부 체결된 주문은 `NotSupported` 다. 일부정정
     * (`params.partial`)은 받지 않는다. 주문 상세 조회가 실패하면 던진다. 미국에서 `amount` 를 주지 않으면 조회는 고액주문 확인에만 쓰므로
     * 실패해도 정정한다. 정정하면 새 `orderId` 가 발급된다 — 반환한 `Order.id` 를 써야 한다.
     *
     * 장 시간 밖이면 원주문 조회와 정정 요청 없이 `MarketClosed` 다. 판정은 `createOrder` 와 같다. 국내 프리·애프터마켓은 `nxtRouting` 이 켜져
     * 있을 때만 열고, 국내와 미국 확장세션에서는 지정가 정정만 보낸다. 정정은 신규 진입이 아니라서 `blockAuctionBuys` 의 동시호가 매수 차단은 걸지 않는다.
     *
     * `params.trigger: true` 는 조건주문 정정이다(`modifyConditionalOrder` 로 넘긴다). 조건주문은 등록과 같은 인자
     * (`triggerPrice`·`expireDate` 등 `params`)로 조건 전체를 다시 선언한다 — 부분 필드만 바꿀 수 없다. 등록처럼 장 시간 게이트는 거치지 않는다.
     */
    override async editOrder(
        id: string, symbol: string, type: OrderType, side: OrderSide, amount: Num = undefined, price: Num = undefined, params: Dict = {},
    ): Promise<Order> {
        if (this.safeBool2(params, 'trigger', 'stop', false) === true) {
            if (amount === undefined) throw new ArgumentsRequired(`${this.id} editOrder() 는 조건주문 정정에 amount 인자가 필요하다`);
            return this.modifyConditionalOrder(id, this.market(symbol), type, side, amount, price, params);
        }
        if (type !== 'limit' && type !== 'market') throw new InvalidOrder(`${this.id} editOrder() type must be 'limit' or 'market'`);
        this.assertNoConditionalParams('editOrder', params);
        this.assertNoComputedParams('editOrder', params, EDIT_COMPUTED_FIELDS);
        const market = this.market(symbol);
        const country = this.countryOf(market);
        if (type === 'limit' && price === undefined) throw new ArgumentsRequired(`${this.id} editOrder() requires a price argument for a limit order`);
        if (this.safeBool(params, 'partial', false) === true) {
            throw new NotSupported(`${this.id} editOrder() 의 일부정정(params.partial)은 지원하지 않는다. 토스 정정은 잔량 전부를 새 가격으로 옮긴다`);
        }
        if (type === 'limit' && price !== undefined) this.assertKrxTickAligned(market, price, 'editOrder');

        // 원주문 조회보다 먼저 판정한다. 정정 본문의 수량은 국내 잔량(정수)이거나 없어서(미국) 소수점 제한에 걸리지 않는 0 을 넘긴다.
        const gate = await this.checkOrderableSession(symbol, country, { isMarket: type === 'market', useAmountBased: false, quantity: 0 }, undefined);
        if (gate !== null) {
            logger.info({ orderId: id, symbol, reason: gate }, '[toss] 거래시간 밖이라 정정 요청을 보내지 않는다');
            throw new MarketClosed(gate);
        }

        // 국내는 정정 수량을 싣기 위해, `amount` 를 주면 대조하기 위해 원주문을 조회한다. 이때 조회가 실패하면 던진다.
        const original = country === 'KR' || amount !== undefined ? await this.editOriginal(id) : undefined;
        if (country === 'KR' && (original?.filled ?? 0) > 0) {
            throw new NotSupported(`${this.id} editOrder() 는 일부 체결된 국내 주문(${id}, 체결 ${original?.filled})을 정정하지 않는다. `
                + '정정 수량(quantity)이 정정 뒤 총수량인지 옮길 수량인지 확인하지 못했다. 취소한 뒤 다시 주문한다');
        }
        if (amount !== undefined) assertWholeRemainingEdit(this.id, id, amount, original ?? {});

        const body: Dict = { orderId: id, orderType: type === 'market' ? 'MARKET' : 'LIMIT' };
        if (country === 'KR') body.quantity = this.numberToString(original?.remaining as number);
        if (type === 'limit') body.price = this.orderPriceString(market, price);

        // 명목가는 잔량 × 가격이다. 미국에서 원주문을 조회하지 않았으면 고액주문 확인용으로만 읽는다.
        const notional = original !== undefined ? (original.remaining ?? 0) * (price ?? 0) : await this.usEditNotional(id, price);
        if (await this.isHighValue(notional, country)) body.confirmHighValueOrder = true;

        const response = this.unwrap<TossOrderCreateResponse>(await this.privateAccountPostOrdersOrderIdModify(this.extend(body, this.omit(params, EDIT_HANDLED_PARAMS))));
        const newOrderId = this.safeString(response, 'orderId');
        if (newOrderId === undefined) {
            throw new OrderOutcomeUnknown(`${this.id} 정정 응답에 orderId 가 없다. 정정 여부를 주문 조회로 확인해야 한다`);
        }
        logger.info({ orderId: id, newOrderId, symbol, price, amount }, '[toss] 정정주문 — 주문번호가 바뀌었다');
        const timestamp = this.milliseconds();
        return this.safeOrder({
            info: response,
            id: newOrderId,
            timestamp,
            datetime: this.iso8601(timestamp),
            symbol: market.symbol,
            type,
            side,
            price,
            // 정정 뒤 총수량. 국내는 조회한 잔량을 실었으므로 알고, 미국에서 `amount` 를 주지 않았으면 확인하지 않았으므로 비운다.
            amount: amount ?? (country === 'KR' && original !== undefined ? editOrderTotal(original) : undefined),
            status: 'open',
            trades: [],
        }, market);
    }

    /** 정정할 원주문의 체결 수량과 잔량(주문 상세). 조회가 실패하면 던지고, 없거나 잔량이 없으면 `OrderNotFound` 다. */
    private async editOriginal(orderId: string): Promise<EditOrderOriginal> {
        const order = this.unwrap<TossOrder | null>(await this.privateAccountGetOrdersOrderId({ orderId }));
        const quantity = this.safeNumber(order, 'quantity');
        const filled = this.safeNumber(this.safeDict(order, 'execution'), 'filledQuantity', 0) as number;
        const remaining = quantity !== undefined ? Number(Precise.stringSub(this.numberToString(quantity), this.numberToString(filled))) : undefined;
        if (remaining === undefined || !(remaining > 0)) throw new OrderNotFound(`${this.id} editOrder() 정정할 잔량이 있는 주문을 찾지 못했다: ${orderId}`);
        return { filled, remaining };
    }

    /**
     * 미국 정정의 명목가. 주문 상세(`GET /orders/{orderId}`)의 남은 수량(주문 수량 − 체결 수량)에 새 가격을 곱한다.
     * 가격이 없거나 조회가 실패하면 0 이라 표시 없이 정정한다. 표시가 필요한 주문이면 서버가 `confirm-high-value-required` 로 거절한다.
     */
    private async usEditNotional(orderId: string, price: Num): Promise<number> {
        if (price === undefined) return 0;
        try {
            const order = this.unwrap<TossOrder | null>(await this.privateAccountGetOrdersOrderId({ orderId }));
            const quantity = this.safeNumber(order, 'quantity');
            const filled = this.safeNumber(this.safeDict(order, 'execution'), 'filledQuantity', 0) as number;
            const remaining = quantity !== undefined ? quantity - filled : 0;
            return remaining > 0 ? remaining * price : 0;
        } catch (err) {
            logger.warn({ err, orderId }, '[toss] 정정 전 주문 조회에 실패해 고액주문 표시 없이 정정한다');
            return 0;
        }
    }

    /**
     * 조건주문을 낸다(ccxt 의 통합 메서드 이름). `createOrder(..., { triggerPrice })` 와 같은 경로로 등록하고 `params` 는 그대로 넘긴다.
     * `triggerPrice` 가 없으면 요청 없이 `ArgumentsRequired` 다. 조건 없이 일반 주문으로 나가지 않는다.
     */
    override async createTriggerOrder(
        symbol: string,
        type: OrderType,
        side: OrderSide,
        amount: number,
        price: Num = undefined,
        triggerPrice: Num = undefined,
        params: Dict = {},
    ): Promise<Order> {
        if (triggerPrice === undefined) {
            throw new ArgumentsRequired(`${this.id} createTriggerOrder() requires a triggerPrice argument`);
        }
        return this.createOrder(symbol, type, side, amount, price, this.extend(params, { triggerPrice }));
    }

    /** 미국 주식 시장가 매수를 금액으로 낸다(`createOrder` 의 `params.cost`). 국내는 금액 주문 API 가 없어 요청 없이 `NotSupported` 다. */
    async createMarketBuyOrderWithCost(symbol: string, cost: number, params: Dict = {}): Promise<Order> {
        if (this.countryOf(this.market(symbol)) !== 'US') {
            throw new NotSupported(`${this.id} createMarketBuyOrderWithCost() 는 미국 종목만 지원한다: ${symbol}`);
        }
        return this.createOrder(symbol, 'market', 'buy', 0, undefined, this.extend(params, { cost }));
    }

    /** ccxt 조건 인자가 있으면 요청 전에 `NotSupported` 다. 본문에 합치거나 버리면 조건 없는 주문이 나간다. */
    private assertNoConditionalParams(method: string, params: Dict): void {
        for (const key of UNSUPPORTED_CONDITIONAL_PARAMS) {
            if (this.safeValue(params, key) !== undefined) {
                throw new NotSupported(`${this.id} ${method}() 는 조건 인자 ${key} 를 받지 않는다. 조건주문은 params.triggerPrice 나 createTriggerOrder() 로 낸다`);
            }
        }
    }

    /** 라이브러리가 인자로 채우는 본문 필드가 `params` 에 있으면 요청 전에 `BadRequest` 다. 나머지 키는 본문에 합친다. */
    private assertNoComputedParams(method: string, params: Dict, fields: readonly string[]): void {
        for (const key of fields) {
            if (key in params) {
                throw new BadRequest(`${this.id} ${method}() 의 params.${key} 는 받지 않는다. 인자로 정하는 필드다`);
            }
        }
    }

    /** `params.timeInForce` 를 토스의 값(`DAY`·`CLS`·`OPG`)으로 확인한다. 없으면 `undefined`(서버 기본 `DAY`). */
    private parseTimeInForce(params: Dict): Str {
        const value = this.safeStringUpper(params, 'timeInForce');
        if (value === undefined) return undefined;
        if (!(ORDER_TIME_IN_FORCE as readonly string[]).includes(value)) {
            throw new InvalidOrder(`${this.id} createOrder() timeInForce must be one of ${ORDER_TIME_IN_FORCE.join(', ')}`);
        }
        return value;
    }

    /**
     * 주문 접수 가능 시간과 형태를 검사한다.
     *
     * 미국은 네 세션을 캘린더로 판정하고, 정규장 밖에서는 정규장 전용인 주문 형태(금액 주문·소수점 수량·시장가)를 막는다. 정규장 안에서도 종료 1시간 전 이후에는
     * 금액 주문과 소수점 수량 주문이 접수되지 않는다. 캘린더를 받지 못하면 정적 시간표(`isTossOrderable`)로 판정한다. 그 폴백에서 국내 휴장일은
     * 공용 캘린더가 알 때만 막고(모르면 연다), 미국 확장세션은 막는다(좁히는 쪽). 정규장의 종가 동시호가 신규 매수는 `options.blockAuctionBuys` 가
     * 켜졌을 때만 막는다(세 증권사 공용 판정 `krxAuctionBuyBlockReason`·`usAuctionBuyBlockReason`). 정정은 `side` 를 비워 이 차단을 걸지 않는다.
     *
     * @returns 막는 사유(한국어). 접수할 수 있으면 `null`.
     */
    private async checkOrderableSession(
        symbol: string,
        country: StockMarketGroup,
        form: { isMarket: boolean; useAmountBased: boolean; quantity: number },
        side: OrderSide | undefined,
    ): Promise<string | null> {
        const now = new Date(this.milliseconds());
        const auction = async (): Promise<string | null> => {
            if (side === undefined || !(await this.isOptionEnabled('blockAuctionBuys'))) return null;
            return country === 'KR' ? krxAuctionBuyBlockReason(now, side) : usAuctionBuyBlockReason(now, side);
        };
        if (country === 'KR') {
            const session = await this.currentKrSession(now);
            if (session === null) return isTossOrderable(symbol, now) ? auction() : 'KRX 거래시간 외 (09:00-15:30 KST 평일, 캘린더 조회 실패)';
            if (session === 'closed') return 'KRX 휴장·정규장 외';
            if (session !== 'regularMarket') {
                // 확장세션(프리 08:00~08:50, 애프터 15:30~20:00)은 기능 옵션 `nxtRouting` 이 켜져 있을 때만 연다.
                if (!(await this.isOptionEnabled('nxtRouting'))) {
                    return `KRX ${session} 세션 — 확장세션 주문은 nxtRouting 옵션이 켜져 있어야 한다`;
                }
                return krSessionOrderRestriction(session, form);
            }
            return auction();
        }
        const session = await this.currentUsSession(now);
        if (session === null) return isTossOrderable(symbol, now) ? auction() : '미국 정규장 외 (장 운영 캘린더 조회 실패)';
        if (session === 'closed') return '미국장 휴장·세션 외';
        const regularCloseMs = findUsRegularCloseMs(this.calendars.US?.value, now);
        const restriction = usSessionOrderRestriction(
            session, form, regularCloseMs !== null ? { nowMs: now.getTime(), regularCloseMs } : undefined,
        ) ?? (session === 'regularMarket' ? await auction() : null);
        if (restriction !== null) return restriction;
        logger.info({ symbol, session }, '[toss] 미국 세션을 확인했다. 주문을 접수할 수 있다');
        return null;
    }

    /**
     * 확장세션 시장가를 지정가로 바꿀 때 쓸 지정가를 구한다. 불변식이 둘이다.
     * 1. 같은 종목·같은 방향의 미체결이 있으면 다시 내지 않는다(호가가 쌓이지 않게). 조회에 실패해도 내지 않는다(중복이 미발주보다 나쁘다).
     * 2. 기준가(최종가)를 구하지 못하면 내지 않는다(지정가를 지어내지 않는다). 최종가는 실제로 체결된 가격이라 호가 단위가 항상 맞다.
     */
    private async extendedSessionLimit(symbol: string, side: OrderSide): Promise<{ price?: number; error?: string }> {
        return buildExtendedSessionLimit(
            this,
            { symbol, side },
            '[toss]',
            (err, message) => logger.warn({ err, symbol }, message),
        );
    }

    /** 국내 확장세션(프리·애프터) 전환 판정. 전환 대상이 아니면 `null`(정규장·휴장·옵션 꺼짐). */
    private async krExtendedSessionConversion(symbol: string, side: OrderSide): Promise<{ session: string; price?: number; error?: string } | null> {
        if (!(await this.isOptionEnabled('nxtRouting'))) return null;
        const session = await this.currentKrSession();
        if (session !== 'preMarket' && session !== 'afterMarket') return null;
        return { session, ...(await this.extendedSessionLimit(symbol, side)) };
    }

    /**
     * 미국 확장세션(주간거래·프리·애프터) 전환 판정. 정수 수량만 전환한다. 소수점 수량은 정규장 밖에서 주문 형태와 상관없이 접수되지 않으므로
     * 지정가로 바꿔도 소용없어 전환하지 않고 세션 검사가 막게 둔다.
     */
    private async usExtendedSessionConversion(symbol: string, side: OrderSide, quantity: number): Promise<{ session: string; price?: number; error?: string } | null> {
        if (!(await this.isOptionEnabled('usExtendedLimit'))) return null;
        const session = await this.currentUsSession();
        if (session !== 'dayMarket' && session !== 'preMarket' && session !== 'afterMarket') return null;
        if (!Number.isInteger(quantity)) {
            logger.warn({ symbol, side, session, quantity }, '[toss] 미국 확장세션의 소수점 수량은 정규장 전용이라 지정가로 바꿀 수 없다');
            return null;
        }
        return { session, ...(await this.extendedSessionLimit(symbol, side)) };
    }

    /** 접수한 주문의 체결을 확정한다. 주문 상세를 예산 안에서 조회하고, 마지막으로 본 주문 원본도 함께 돌려준다. */
    private async confirmOrderExecution(orderId: string, country: StockMarketGroup): Promise<{ snapshot: ExecutionSnapshot | null; last: TossOrder | null | undefined }> {
        let last: TossOrder | null | undefined;
        const snapshot = await confirmExecution({
            label: '[toss]',
            orderId,
            exchange: 'toss',
            budget: this.getConfirmBudget(),
            probe: async () => {
                const raw = this.unwrap<TossOrder | null>(await this.privateAccountGetOrdersOrderId({ orderId }));
                last = raw;
                return {
                    snapshot: toExecutionSnapshot(raw, country),
                    terminal: raw?.status !== undefined && TERMINAL_ORDER_STATUSES.has(raw.status),
                };
            },
        });
        return { snapshot, last };
    }

    /** 접수 결과로 `Order` 를 만든다. 체결을 확정하지 못했으면 `filled` 를 비운다. */
    private buildCreatedOrder(args: {
        market: MarketInterface;
        type: OrderType;
        side: OrderSide;
        price: Num;
        quantity: number;
        useAmountBased: boolean;
        cost: Num;
        orderId: string;
        clientOrderId: Str;
        timeInForce: Str;
        response: TossOrderCreateResponse;
        extendedSession: Str;
        status: string;
        /** 접수 직후 미체결 장부에 그대로 남아 있다(확장세션 지정가). */
        stillOpen?: boolean | undefined;
        snapshot?: ExecutionSnapshot | null | undefined;
        raw?: TossOrder | undefined;
    }): Order {
        const { snapshot, raw } = args;
        const timestamp = this.parse8601(raw?.orderedAt) ?? this.milliseconds();
        const fee = snapshot?.fee !== undefined ? { currency: snapshot.feeCurrency, cost: snapshot.fee } : undefined;
        return this.safeOrder({
            info: {
                ...args.response,
                execution: snapshot ?? undefined,
                order: raw,
                extendedSession: args.extendedSession,
                stillOpen: args.stillOpen,
            },
            id: args.orderId,
            clientOrderId: args.clientOrderId,
            timestamp,
            datetime: this.iso8601(timestamp),
            lastTradeTimestamp: this.parse8601(raw?.execution?.filledAt),
            symbol: args.market.symbol,
            type: args.type,
            timeInForce: args.timeInForce,
            side: args.side,
            price: args.type === 'limit' ? args.price : undefined,
            amount: args.useAmountBased ? undefined : args.quantity,
            filled: snapshot?.filled,
            average: snapshot?.average,
            cost: snapshot?.amount,
            status: args.status,
            fee,
            trades: [],
        }, args.market);
    }

    // ============ 조건주문 ============

    /**
     * 조건주문 인자를 검사하고 등록할 모양으로 정리한다. 요청은 보내지 않는다. 브로커가 거절할 조합은 여기서 `OrderNotSent` 로 막는다.
     */
    private planConditionalOrder(
        type: OrderType,
        side: OrderSide,
        price: Num,
        params: Dict,
    ): TossConditionalPlan {
        const conditionalType = (this.safeStringUpper(params, 'conditionalType') ?? 'SINGLE') as TossConditionalOrderType;
        if (conditionalType !== 'SINGLE' && conditionalType !== 'OCO' && conditionalType !== 'OTO') {
            throw new InvalidOrder(`${this.id} createOrder() conditionalType must be SINGLE, OCO or OTO`);
        }
        const orderType = type === 'market' ? 'MARKET' : 'LIMIT';
        const expireDate = this.safeString(params, 'expireDate');
        if (expireDate === undefined) throw new ArgumentsRequired(`${this.id} 조건주문에는 expireDate(YYYY-MM-DD)가 필요하다`);

        const first: TossConditionalLeg = { side, triggerPrice: this.conditionalTriggerPrice(params, 'triggerPrice'), orderPrice: price };
        const secondParams = this.safeDict(params, 'second');
        const second: TossConditionalLeg | undefined = secondParams === undefined ? undefined : {
            side: (this.safeStringLower(secondParams, 'side') ?? (conditionalType === 'OTO' ? (side === 'buy' ? 'sell' : 'buy') : side)) as OrderSide,
            triggerPrice: this.conditionalTriggerPrice(secondParams, 'second.triggerPrice'),
            orderPrice: this.safeNumber(secondParams, 'price'),
        };

        if ((conditionalType === 'OCO' || conditionalType === 'OTO') && second === undefined) {
            throw new OrderNotSent(`${this.id} ${conditionalType} 조건주문은 second leg 필수`);
        }
        if (conditionalType === 'OCO' && (first.side !== 'sell' || second?.side !== 'sell')) {
            throw new OrderNotSent(`${this.id} OCO 는 양쪽 SELL(익절/손절 브래킷)만 지원`);
        }
        if (orderType === 'MARKET' && conditionalType !== 'SINGLE') {
            throw new OrderNotSent(`${this.id} MARKET 조건주문은 SINGLE 만 지원(브래킷은 LIMIT)`);
        }
        if (orderType === 'LIMIT' && (first.orderPrice === undefined || (second !== undefined && second.orderPrice === undefined))) {
            throw new OrderNotSent(`${this.id} LIMIT 조건주문은 각 leg 의 orderPrice 필수`);
        }
        return { conditionalType, orderType, expireDate, first, second, clientOrderId: this.safeString(params, 'clientOrderId') };
    }

    /** 조건의 트리거 가격. 없거나 숫자가 아니면 `ArgumentsRequired`, 0 이하면 `InvalidOrder` 다. 빠진 채로 보내면 트리거 없는 조건이 나간다. */
    private conditionalTriggerPrice(source: Dict, label: string): number {
        const value = this.safeNumber(source, 'triggerPrice');
        if (value === undefined) {
            throw new ArgumentsRequired(`${this.id} 조건주문의 ${label} 가 없거나 숫자가 아니다: ${this.safeString(source, 'triggerPrice')}`);
        }
        if (!(value > 0) || !Number.isFinite(value)) throw new InvalidOrder(`${this.id} 조건주문의 ${label} 는 0 보다 커야 한다: ${value}`);
        return value;
    }

    /** 조건주문 등록과 정정이 같이 보내는 필드(수량, 호가유형, 만료일, 감시조건, 고액주문 확인). */
    private async conditionalOrderFields(
        market: MarketInterface, amount: number, plan: TossConditionalPlan,
    ): Promise<TossConditionalOrderFields> {
        const { conditionalType, orderType, expireDate, first, second } = plan;
        const toLeg = (leg: TossConditionalLeg): TossConditionalLegRequest => ({
            orderSide: leg.side === 'sell' ? 'SELL' : 'BUY',
            triggerPrice: this.numberToString(leg.triggerPrice),
            ...(orderType === 'LIMIT' && leg.orderPrice !== undefined ? { orderPrice: this.numberToString(leg.orderPrice) } : {}),
        });
        const fields: TossConditionalOrderFields = {
            type: conditionalType,
            quantity: this.numberToString(amount),
            orderType,
            expireDate,
            first: toLeg(first),
            ...(second !== undefined ? { second: toLeg(second) } : {}),
        };
        // 고액주문 확인은 첫 조건의 명목가로 본다(지정가는 주문가, 시장가는 트리거 가격 기준).
        if (await this.isHighValue(amount * (first.orderPrice ?? first.triggerPrice), this.countryOf(market))) fields.confirmHighValueOrder = true;
        return fields;
    }

    /** 조건주문 인자만 검사한다(요청은 보내지 않는다). 모의 주문처럼 등록 없이 인자가 맞는지 확인할 때 쓴다. 맞지 않으면 던진다. */
    validateConditionalOrder(type: OrderType, side: OrderSide, price: Num, params: Dict): void {
        this.planConditionalOrder(type, side, price, params);
    }

    /**
     * 조건주문을 등록한다(`createOrder` 가 `params.triggerPrice` 를 보고 부른다).
     *
     * - `SINGLE`: `triggerPrice` 하나. `type: 'limit'` 이면 `price` 가 트리거 뒤에 낼 지정가이고, `'market'` 이면 시장가다(서버측 손절은 체결이 보장되는 시장가가 알맞다).
     * - `OCO`: 두 조건을 함께 감시하고 하나가 체결되면 반대편이 취소된다. 익절·손절 브래킷이라 양쪽 모두 매도이고 지정가만 된다.
     * - `OTO`: 첫 조건이 체결된 뒤 둘째 조건을 감시한다(진입과 청산의 연결). 지정가만 된다.
     */
    private async createConditionalOrder(
        market: MarketInterface,
        type: OrderType,
        side: OrderSide,
        amount: number,
        price: Num,
        params: Dict,
    ): Promise<Order> {
        const plan = this.planConditionalOrder(type, side, price, params);
        const { conditionalType, orderType, first, clientOrderId } = plan;
        const body: TossConditionalOrderCreateRequest = {
            symbol: market.id as string,
            ...(await this.conditionalOrderFields(market, amount, plan)),
            ...(clientOrderId !== undefined ? { clientOrderId } : {}),
        };

        const response = this.unwrap<TossConditionalOrderCreateResponse>(await this.privateAccountPostConditionalOrders(body as unknown as Dict));
        const conditionalOrderId = this.safeString(response, 'conditionalOrderId');
        if (conditionalOrderId === undefined) {
            throw new OrderOutcomeUnknown(`${this.id} 조건주문 접수 응답에 conditionalOrderId 가 없다. 등록 여부를 조회로 확인해야 한다`);
        }
        logger.info({ conditionalOrderId, symbol: market.symbol, type: conditionalType }, '[toss] 조건주문을 등록했다');
        const timestamp = this.milliseconds();
        return this.safeOrder({
            info: { ...response, type: conditionalType },
            id: conditionalOrderId,
            clientOrderId,
            timestamp,
            datetime: this.iso8601(timestamp),
            symbol: market.symbol,
            type,
            side,
            price: orderType === 'LIMIT' ? first.orderPrice : undefined,
            amount,
            filled: 0,
            triggerPrice: first.triggerPrice,
            status: 'open',
            trades: [],
        }, market);
    }

    /**
     * 조건주문을 정정한다(`editOrder` 가 `params.trigger: true` 로 부른다). 수정은 재설정이라 `createConditionalOrder`
     * 와 같은 필드(타입·수량·호가유형·만료일·감시조건 전체)를 다시 보낸다 — 부분 필드만 바꾸는 API가 아니다.
     * 정정하면 새 `conditionalOrderId` 가 발급되고 옛 ID는 무효화된다.
     */
    private async modifyConditionalOrder(
        id: string,
        market: MarketInterface,
        type: OrderType,
        side: OrderSide,
        amount: number,
        price: Num,
        params: Dict,
    ): Promise<Order> {
        const plan = this.planConditionalOrder(type, side, price, params);
        const { conditionalType, orderType, first } = plan;
        const body: TossConditionalOrderModifyRequest = { conditionalOrderId: id, ...(await this.conditionalOrderFields(market, amount, plan)) };

        const response = this.unwrap<TossConditionalOrderCreateResponse>(await this.privateAccountPostConditionalOrdersConditionalOrderIdModify(body as unknown as Dict));
        const newConditionalOrderId = this.safeString(response, 'conditionalOrderId');
        if (newConditionalOrderId === undefined) {
            throw new OrderOutcomeUnknown(`${this.id} 조건주문 정정 응답에 conditionalOrderId 가 없다. 정정 여부를 조회로 확인해야 한다`);
        }
        logger.info({ conditionalOrderId: id, newConditionalOrderId, symbol: market.symbol, type: conditionalType },
            '[toss] 조건주문을 정정했다 — 새 conditionalOrderId 가 발급됐다');
        const timestamp = this.milliseconds();
        return this.safeOrder({
            info: { ...response, type: conditionalType },
            id: newConditionalOrderId,
            timestamp,
            datetime: this.iso8601(timestamp),
            symbol: market.symbol,
            type,
            side,
            price: orderType === 'LIMIT' ? first.orderPrice : undefined,
            amount,
            triggerPrice: first.triggerPrice,
            status: 'open',
            trades: [],
        }, market);
    }

    /** 조건주문의 조건(leg)이 통째로 없는 응답만 상세로 채운다. 조건이 오는데 방향 키만 없는 응답까지 상세를 부르면 조회할 때마다 한도를 쓴다. */
    private async hydrateConditionalLegs(rows: TossConditionalOrder[]): Promise<TossConditionalOrder[]> {
        const needsDetail = rows.filter((row) => row.first == null);
        if (needsDetail.length === 0) return rows;
        // 보강은 부가 정보다. 여기서 던지면 조건주문 자체가 목록에서 사라지는데, 스톱이 안 보이는 것이 방향이 틀리게 보이는 것보다 위험하다.
        try {
            const targets = needsDetail.slice(0, MAX_CONDITIONAL_DETAIL_FETCH);
            if (needsDetail.length > targets.length) {
                logger.warn({ total: needsDetail.length, fetched: targets.length }, '[toss] 조건주문 상세 조회 상한을 넘어 나머지는 목록 값을 쓴다');
            }
            const detailed = new Map<string, TossConditionalOrder>();
            await Promise.all(targets.map(async (row) => {
                try {
                    const detail = this.unwrap<TossConditionalOrder>(
                        await this.privateAccountGetConditionalOrdersConditionalOrderId({ conditionalOrderId: row.conditionalOrderId }),
                    );
                    if (detail?.first != null) detailed.set(row.conditionalOrderId, detail);
                } catch (err) {
                    logger.debug({ err, conditionalOrderId: row.conditionalOrderId }, '[toss] 조건주문 상세 조회에 실패해 목록 값을 유지한다');
                }
            }));
            if (detailed.size < targets.length) {
                const sample = targets.find((row) => !detailed.has(row.conditionalOrderId));
                logger.warn({ missing: targets.length - detailed.size, sampleKeys: sample !== undefined ? Object.keys(sample) : [] },
                    '[toss] 조건주문의 조건을 확인하지 못했다. 방향과 트리거 가격 표시가 부정확할 수 있다');
            }
            return rows.map((row) => detailed.get(row.conditionalOrderId) ?? row);
        } catch (err) {
            logger.warn({ err }, '[toss] 조건주문 상세 보강에 실패해 목록 값으로 진행한다');
            return rows;
        }
    }

    /** 조건주문의 상태를 통합 상태로 옮긴다. 감시·대기 중은 `open`, 발동해 끝났으면 `closed`, 만료는 `expired` 다. */
    private parseConditionalStatus(status: Str): string {
        if (status === 'COMPLETED') return 'closed';
        if (status === 'EXPIRED') return 'expired';
        return 'open';
    }

    /**
     * 조건주문 조회 응답을 `Order` 로 옮긴다. 첫 조건(leg)이 대표이고 `triggerPrice` 에 트리거 가격이 실린다.
     * 조회 응답에는 방향이 없으므로 응답에 실려 오면 그 값을, 없으면 종류로 유추한 값을 쓴다(`conditionalSide`). 원본은 `order.info` 이고 종류는 `order.info.type` 이다.
     */
    private parseConditionalOrder(conditional: TossConditionalOrder, market: Market = undefined): Order {
        market = this.safeMarket(conditional.symbol, market);
        const leg = conditional.first ?? {};
        const timestamp = this.parse8601(conditional.createdAt) ?? this.milliseconds();
        const quantity = this.safeNumber(conditional, 'quantity');
        const orderType = this.safeStringLower(conditional, 'orderType') ?? 'limit';
        return this.safeOrder({
            info: conditional,
            id: conditional.conditionalOrderId,
            timestamp,
            datetime: this.iso8601(timestamp),
            symbol: market.symbol,
            type: orderType,
            side: conditionalSide(conditional),
            price: this.safeNumber(leg, 'orderPrice'),
            amount: quantity,
            filled: 0,
            remaining: quantity,
            cost: 0,
            triggerPrice: this.safeNumber(leg, 'triggerPrice'),
            status: this.parseConditionalStatus(conditional.status),
            trades: [],
        }, market);
    }

    // ============ 주문 조회와 취소 ============

    /** 주문의 세부 상태를 통합 상태로 옮긴다. 모르는 값은 원문 그대로 둔다. */
    parseOrderStatus(status: Str): string {
        const statuses: Dictionary<string> = {
            PENDING: 'open',
            PENDING_CANCEL: 'open',
            PENDING_REPLACE: 'open',
            PARTIAL_FILLED: 'open',
            FILLED: 'closed',
            CANCELED: 'canceled',
            REPLACED: 'canceled',
            REJECTED: 'rejected',
            // 명세: 거절된 취소·정정 요청을 기록한 별도 레코드의 상태다. 원주문은 이전 상태로 돌아가 제 상태로 따로 조회된다.
            CANCEL_REJECTED: 'rejected',
            REPLACE_REJECTED: 'rejected',
        };
        return this.safeString(statuses, status, status) as string;
    }

    /** `GET /orders` 의 주문 하나를 `Order` 로 옮긴다. 체결 결과(`execution`)와 수수료·세금도 싣는다. */
    override parseOrder(order: Dict, market: Market = undefined): Order {
        market = this.safeMarket(this.safeString(order, 'symbol'), market);
        const execution = this.safeDict(order, 'execution', {}) as Dict;
        const timestamp = this.parse8601(this.safeString(order, 'orderedAt'));
        const commission = this.safeString(execution, 'commission');
        const tax = this.safeString(execution, 'tax');
        const feeCost = commission !== undefined || tax !== undefined ? Precise.stringAdd(commission ?? '0', tax ?? '0') : undefined;
        const filled = this.safeString(execution, 'filledQuantity');
        const orderType = this.safeStringLower(order, 'orderType');
        return this.safeOrder({
            info: order,
            id: this.safeString(order, 'orderId'),
            timestamp,
            datetime: this.iso8601(timestamp),
            lastTradeTimestamp: this.parse8601(this.safeString(execution, 'filledAt')),
            symbol: market.symbol,
            type: orderType,
            timeInForce: this.safeString(order, 'timeInForce'),
            side: this.safeStringLower(order, 'side'),
            price: this.safeString(order, 'price'),
            amount: this.safeString(order, 'quantity'),
            filled: filled ?? '0',
            average: this.safeString(execution, 'averageFilledPrice'),
            cost: this.safeString(execution, 'filledAmount'),
            status: this.parseOrderStatus(this.safeString(order, 'status')),
            fee: feeCost !== undefined ? { currency: this.safeString(order, 'currency', market.quote), cost: this.parseNumber(feeCost) } : undefined,
            trades: [],
        }, market);
    }

    override async fetchOrder(id: string, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        const trigger = this.safeBool2(params, 'trigger', 'stop', false) === true;
        const market = symbol !== undefined ? this.market(symbol) : undefined;
        if (trigger) {
            const detail = this.unwrap<TossConditionalOrder>(
                await this.privateAccountGetConditionalOrdersConditionalOrderId({ conditionalOrderId: id }),
            );
            return this.parseConditionalOrder(detail, market);
        }
        const response = await this.privateAccountGetOrdersOrderId({ orderId: id });
        return this.parseOrder(this.unwrap<Dict>(response), market);
    }

    /**
     * 미체결 주문. `symbol` 을 주면 그 종목만 받는다(서버 조회에도 넣는다).
     *
     * 조건주문은 별도 장부다. `params.trigger: true` 는 조건주문만, `params.includeTrigger: true` 는 일반 주문에 조건주문을 합쳐 돌려준다.
     * 조건주문은 100건씩 커서로 이어 받는다(최대 10쪽). 일반 미체결은 서버가 전량을 주므로 한 번에 받는다.
     * 조회에 실패하면 던진다. "스톱이 없다"로 읽히는 빈 목록으로 바꾸지 않는다.
     */
    override async fetchOpenOrders(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        const triggerOnly = this.safeBool2(params, 'trigger', 'stop', false) === true;
        const includeTrigger = this.safeBool(params, 'includeTrigger', false) === true;
        const query = this.omit(params, ['trigger', 'stop', 'includeTrigger']);
        const market = symbol !== undefined ? this.market(symbol) : undefined;
        let orders: Order[] = [];
        if (!triggerOnly) {
            const request: Dict = { status: 'OPEN' };
            if (market !== undefined) request.symbol = market.id;
            const response = this.unwrap<TossPaginatedOrders>(await this.privateAccountGetOrders(this.extend(request, query)));
            orders = this.parseOrders(response?.orders, market);
        }
        if (triggerOnly || includeTrigger) {
            let rows = await this.fetchOpenConditionalRows(market);
            if (market !== undefined) rows = rows.filter((row) => row.symbol === market.id);
            rows = await this.hydrateConditionalLegs(rows);
            orders = orders.concat(rows.map((row) => this.parseConditionalOrder(row, market)));
        }
        return this.filterBySymbolSinceLimit(this.sortBy(orders, 'timestamp'), market?.symbol, since, limit) as Order[];
    }

    /**
     * 미체결 조건주문 원본을 커서로 끝까지 이어 받는다. 조건주문 목록은 공식 기본이 20건이라 `limit` 과 `cursor` 없이 부르면 그 이상이 잘린다
     * (일반 미체결은 서버가 전량을 주므로 이렇게 하지 않는다). 쪽 수 상한을 넘기면 로그를 남기고 거기서 자른다.
     * 어느 쪽이든 조회가 실패하면 던진다. 앞쪽만 돌려주면 뒤쪽의 스톱이 없는 것으로 읽힌다.
     */
    private async fetchOpenConditionalRows(market: Market): Promise<TossConditionalOrder[]> {
        const request: Dict = { status: 'OPEN', limit: CONDITIONAL_ORDER_PAGE_LIMIT };
        if (market !== undefined) request.symbol = market.id;
        const maxPages = this.safeInteger(this.options, 'conditionalOrdersMaxPages', MAX_CONDITIONAL_ORDER_PAGES) as number;
        const collected: TossConditionalOrder[] = [];
        const seen = new Set<string>();
        const requested = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < maxPages; page++) {
            const response = this.unwrap<TossPaginatedConditionalOrders>(await this.privateAccountGetConditionalOrders(this.extend(request, { cursor })));
            collected.push(...unseenRows(response?.conditionalOrders ?? [], (row) => row.conditionalOrderId, seen));
            if (!response?.hasNext || !response?.nextCursor) return collected;
            if (requested.has(response.nextCursor)) {
                logger.warn({ collected: collected.length, cursor: response.nextCursor }, '[toss] 미체결 조건주문의 다음 커서가 이미 요청한 커서다. 같은 쪽을 되풀이하지 않고 멈춘다');
                return collected;
            }
            cursor = response.nextCursor;
            requested.add(cursor);
        }
        logger.warn({ collected: collected.length, maxPages }, '[toss] 미체결 조건주문이 페이지 상한을 넘어 나머지는 자른다');
        return collected;
    }

    /**
     * 전량 체결된 주문(`status: 'closed'`). 토스의 종료된 주문(`CLOSED`)에는 취소, 거부, 정정으로 대체된 주문도 섞여 있어 전량 체결만 거른다.
     * 취소된 주문은 `fetchCanceledOrders` 로 받는다. 종목·시작 시각·개수로 서버 조회를 좁히고, `params.until`(ms)은 그 시각까지의 주문만 받는다.
     * 페이지는 100건씩 최대 10쪽(1,000건)까지 받고, 넘으면 로그를 남기고 자른다. 범위를 좁히려면 `since` 와 `until` 을 준다.
     */
    override async fetchClosedOrders(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        return this.fetchEndedOrders('closed', symbol, since, limit, params);
    }

    /** 취소된 주문(정정으로 대체된 원주문 포함). `fetchClosedOrders` 와 같은 조회에서 `status: 'canceled'` 만 거른다. */
    override async fetchCanceledOrders(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        return this.fetchEndedOrders('canceled', symbol, since, limit, params);
    }

    private async fetchEndedOrders(status: 'closed' | 'canceled', symbol: Str, since: Int, limit: Int, params: Dict): Promise<Order[]> {
        const market = symbol !== undefined ? this.market(symbol) : undefined;
        const until = this.safeInteger(params, 'until');
        // 서버는 `until` 을 한국 날짜로만 받으므로, 같은 날 `until` 뒤에 낸 주문은 여기서 뺀다.
        const keep = (row: TossOrder): boolean => {
            if (this.parseOrderStatus(row.status) !== status) return false;
            const orderedAt = this.parse8601(row.orderedAt);
            return until === undefined || (orderedAt !== undefined && orderedAt <= until);
        };
        const rows = await this.fetchClosedOrderRows(market, since, limit, params, keep);
        return this.parseOrders(rows, market, since, limit);
    }

    /** 종료된 주문 원본을 커서로 이어 받고 `keep` 에 맞는 행만 남긴다. 개수만 정한 조회는 남긴 행이 `limit` 에 이르면 멈춘다. */
    private async fetchClosedOrderRows(market: Market, since: Int, limit: Int, params: Dict, keep: (row: TossOrder) => boolean): Promise<TossOrder[]> {
        const request: Dict = { status: 'CLOSED', limit: CLOSED_ORDER_PAGE_LIMIT };
        if (market !== undefined) request.symbol = market.id;
        // 날짜 조건은 주문한 날짜 기준이다. 미국 정규장처럼 자정을 넘겨 체결되는 주문이 빠지지 않게 하루를 더 앞에서 받고, 정확한 시각은 아래 필터가 맞춘다.
        if (since !== undefined) request.from = kstDate(since - DAY_MS);
        const until = this.safeInteger(params, 'until');
        if (until !== undefined) request.to = kstDate(until);
        const query = this.omit(params, 'until');
        const maxPages = this.safeInteger(this.options, 'closedOrdersMaxPages', MAX_CLOSED_ORDER_PAGES) as number;
        const collected: TossOrder[] = [];
        const seen = new Set<string>();
        const requested = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < maxPages; page++) {
            const response = this.unwrap<TossPaginatedOrders>(await this.privateAccountGetOrders(this.extend(request, { cursor }, query)));
            collected.push(...unseenRows(response?.orders ?? [], (row) => row.orderId, seen).filter(keep));
            if (!response?.hasNext || !response?.nextCursor) return collected;
            // 시각 조건이 없고 개수만 정했다면(가장 최근 `limit` 건) 그만큼 모았을 때 멈춘다.
            if (since === undefined && limit !== undefined && collected.length >= limit) return collected;
            if (requested.has(response.nextCursor)) {
                logger.warn({ collected: collected.length, cursor: response.nextCursor }, '[toss] 종료된 주문의 다음 커서가 이미 요청한 커서다. 같은 쪽을 되풀이하지 않고 멈춘다');
                return collected;
            }
            cursor = response.nextCursor;
            requested.add(cursor);
        }
        logger.warn({ collected: collected.length }, '[toss] 체결 완료 주문이 페이지 상한을 넘어 오래된 주문은 자른다');
        return collected;
    }

    /**
     * 체결 내역. 토스에는 체결 단위 조회가 없어서 체결이 있는 주문(`execution.filledQuantity > 0`) 하나를 거래 하나로 본다.
     * 종료된 주문과 함께 일부 체결된 채 걸려 있는 미체결 주문도 넣는다. 거래 id 는 주문번호이고 수량은 그 주문의 누적 체결 수량이라,
     * 체결이 늘면 같은 id 의 거래가 더 큰 수량으로 다시 나온다. 거래를 쌓는 쪽은 id 로 덮어써야 한다.
     * 가격은 평균 체결가, 수수료는 브로커가 확정한 `execution.commission` 과 `execution.tax` 의 합이다. 종목을 주지 않으면 전 종목이다.
     */
    override async fetchMyTrades(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        const market = symbol !== undefined ? this.market(symbol) : undefined;
        const filled = (row: TossOrder): boolean => Number(row.execution?.filledQuantity) > 0 && (market === undefined || row.symbol === market.id);
        const ended = await this.fetchClosedOrderRows(market, since, undefined, params, filled);
        const openRequest: Dict = { status: 'OPEN' };
        if (market !== undefined) openRequest.symbol = market.id;
        const open = (this.unwrap<TossPaginatedOrders>(await this.privateAccountGetOrders(openRequest))?.orders ?? []).filter(filled);
        const until = this.safeInteger(params, 'until');
        const trades = this.parseTrades([...ended, ...open], market, since);
        return this.filterBySinceLimit(until === undefined ? trades : trades.filter((trade) => (trade.timestamp as number) <= until), since, limit) as Trade[];
    }

    /** 체결된 주문 하나를 거래 하나로 옮긴다. 체결 시각은 최종 체결 시각(없으면 주문 시각)이다. */
    override parseTrade(trade: Dict, market: Market = undefined): Trade {
        market = this.safeMarket(this.safeString(trade, 'symbol'), market);
        const execution = this.safeDict(trade, 'execution', {}) as Dict;
        const timestamp = this.parse8601(this.safeString(execution, 'filledAt')) ?? this.parse8601(this.safeString(trade, 'orderedAt')) ?? this.milliseconds();
        const commission = this.safeString(execution, 'commission');
        const tax = this.safeString(execution, 'tax');
        const feeCost = commission !== undefined || tax !== undefined ? Precise.stringAdd(commission ?? '0', tax ?? '0') : undefined;
        const orderId = this.safeString(trade, 'orderId');
        return this.safeTrade({
            info: trade,
            id: orderId,
            order: orderId,
            timestamp,
            datetime: this.iso8601(timestamp),
            symbol: market.symbol,
            type: this.safeStringLower(trade, 'orderType'),
            side: this.safeStringLower(trade, 'side'),
            takerOrMaker: undefined,
            price: this.safeString2(execution, 'averageFilledPrice', 'price') ?? this.safeString(trade, 'price'),
            amount: this.safeString(execution, 'filledQuantity'),
            cost: this.safeString(execution, 'filledAmount'),
            fee: feeCost !== undefined ? { currency: this.safeString(trade, 'currency', market.quote), cost: feeCost } : undefined,
        }, market);
    }

    /**
     * 주문을 취소한다. `params.trigger: true` 는 조건주문 취소다. 이미 체결·취소된 주문이면 `OrderNotFound` 를 던진다.
     * 토스의 취소는 새 주문번호를 발급하며, 응답 원본은 `order.info` 에 있다. 취소 응답 본문이 비어 있어도 성공이다.
     *
     * 일반 주문은 취소를 접수한 뒤 원주문의 상세를 `createOrder` 의 체결 확인과 같은 옵션(`confirmExecution`·`confirmBudget`)으로 조회한다.
     * 원주문이 `CANCELED`·`FILLED`·`REJECTED` 로 끝나면 그 상태(`canceled`·`closed`·`rejected`)를 돌려주고, 확정하지 못하면 `status` 를 비운다.
     * 취소가 거절되면 원주문이 이전 상태로 돌아가 아직 반영되지 않은 것과 구별할 수 없으므로 이때도 비운다. 조회한 원본은 `info.order` 에 있다.
     * 조건주문은 명세상 취소 응답(204)이 곧 취소 완료라 조회하지 않고 `canceled` 다.
     */
    override async cancelOrder(id: string, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        const trigger = this.safeBool2(params, 'trigger', 'stop', false) === true;
        const market = symbol !== undefined ? this.market(symbol) : undefined;
        if (trigger) {
            const response = await this.privateAccountDeleteConditionalOrdersConditionalOrderId({ conditionalOrderId: id });
            logger.info({ id, symbol }, '[toss] 조건주문을 취소했다');
            return this.safeOrder({ info: this.unwrap(response) ?? {}, id, symbol: market?.symbol, status: 'canceled', trades: [] }, market);
        }
        const response = this.unwrap<Dict | undefined>(await this.privateAccountPostOrdersOrderIdCancel({ orderId: id })) ?? {};
        logger.info({ id, symbol, cancelOrderId: response.orderId }, '[toss] 주문 취소를 접수했다');
        const confirm = this.safeBool(params, 'confirmExecution', this.options.confirmExecution !== false) !== false;
        const order = confirm ? await this.confirmCancel(id) : undefined;
        const status = order?.status !== undefined && CANCEL_SETTLED_STATUSES.has(order.status) ? this.parseOrderStatus(order.status) : undefined;
        if (confirm && status === undefined) logger.warn({ id, status: order?.status }, '[toss] 취소가 확정되지 않아 status 를 비운다');
        return this.safeOrder({
            info: { ...response, order },
            id,
            symbol: market?.symbol,
            status,
            trades: [],
        }, market);
    }

    /** 취소를 접수한 원주문을 예산 안에서 조회해 마지막으로 읽은 원본을 돌려준다. 종료 상태면 멈추고, 조회가 실패하면 다음 시도로 넘어간다. */
    private async confirmCancel(orderId: string): Promise<TossOrder | undefined> {
        const { attempts, intervalMs } = this.getConfirmBudget();
        let last: TossOrder | undefined;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            if (attempt > 1 && intervalMs > 0) await this.sleep(intervalMs);
            try {
                last = this.unwrap<TossOrder | null>(await this.privateAccountGetOrdersOrderId({ orderId })) ?? undefined;
            } catch (err) {
                logger.warn({ err, orderId, attempt, attempts }, '[toss] 취소 확인 조회에 실패해 다시 조회한다');
                continue;
            }
            if (last?.status !== undefined && TERMINAL_ORDER_STATUSES.has(last.status)) break;
        }
        return last;
    }

    /**
     * 미체결 주문을 모두 취소한다(토스에는 전체 취소가 없어 조회한 주문을 하나씩 취소한다). `symbol` 을 주면 그 종목만 취소한다.
     * 일반 주문만 대상이며, `params.includeTrigger: true` 면 조건주문도 취소한다.
     *
     * 돌려주는 목록은 대상이 된 주문 전부이고, 항목은 미체결 조회로 받은 주문이다. 취소를 접수한 것은 `cancelOrder` 가 돌려준 상태이고(확정하지 못하면 비어 있다)
     * 그 `info`(취소 응답 원문과 조회한 원주문 `order`)가 `info.cancelResponse` 에 있다. 확정 조회를 주문마다 하므로 미확정 주문이 많으면 조회가 는다.
     * 취소하지 못한 것은 원래 상태(`open`)에 `info.cancelError`(메시지)와 `info.cancelErrorDetail`(오류의 `detail`)이 실린다. 일부가 실패해도 던지지 않는다.
     * 취소하려는 사이에 끝난 주문은 브로커 원인 코드(`info.cancelErrorDetail`)대로 옮긴다. `already-filled` 는 `closed`, `already-canceled` 는 `canceled`,
     * `already-rejected` 는 `rejected` 다. 정정으로 대체된 주문(`already-modified`)과 원인을 모르는 경우는 새 주문이 살아 있을 수 있어 원래 상태로 둔다.
     */
    override async cancelAllOrders(symbol: Str = undefined, params: Dict = {}): Promise<Order[]> {
        const includeTrigger = this.safeBool(params, 'includeTrigger', false) === true;
        const orders = await this.fetchOpenOrders(symbol, undefined, undefined, includeTrigger ? { includeTrigger: true } : {});
        const settled = await Promise.allSettled(orders.map(async (order) => {
            const trigger = this.safeString(order.info, 'conditionalOrderId') !== undefined;
            return this.cancelOrder(order.id as string, order.symbol, { trigger });
        }));
        const results = settled.map((outcome, index): Order => {
            const order = orders[index]!;
            if (outcome.status === 'fulfilled') return { ...order, status: outcome.value.status, info: { ...order.info, cancelResponse: outcome.value.info } };
            const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
            if (!(outcome.reason instanceof OrderNotFound)) {
                const detail = outcome.reason instanceof BaseError ? outcome.reason.detail : undefined;
                return { ...order, info: { ...order.info, cancelError: message, cancelErrorDetail: detail } };
            }
            const detail = outcome.reason.detail;
            const info = { ...order.info, alreadyGone: true, cancelError: message, cancelErrorDetail: detail };
            if (detail === 'already-filled') return { ...order, status: 'closed', filled: order.amount, remaining: 0, cost: undefined, average: undefined, info };
            if (detail === 'already-canceled') return { ...order, status: 'canceled', info };
            if (detail === 'already-rejected') return { ...order, status: 'rejected', info };
            return { ...order, info };
        });
        logger.info({ total: orders.length, canceled: results.filter((order) => order.status === 'canceled').length }, '[toss] 미체결 주문을 취소했다');
        return results;
    }

    /**
     * 실시간 시세·주문 스트림을 만든다. 이 인스턴스의 액세스 토큰을 쓴다(REST와 같은 토큰). 구독은 반환값의
     * `start(subs)`로 시작한다. 시세 구독(`{channel: 'trade'|'orderbook', market, symbol}`)의 `symbol`은 ccxt 통합
     * 심볼이 아니라 토스 원본 코드다(미국은 대문자 티커, 국내는 6자리 숫자). 본인 주문 구독(`{channel: 'order', accountSeq}`)은
     * 종목이 아니라 계좌 `accountSeq`를 넣는다 — 인증된 호출을 한 번 한 뒤의 `this.uid`나 `GET /accounts` 응답에서 얻는다.
     * `onOrder`가 주는 `order`는 REST 주문 조회와 같은 원본이라, ccxt `Order`가 필요하면 `this.parseOrder(order)`를 부른다.
     */
    createPriceStream(handlers: Pick<TossPriceWsOptions, 'onTrade' | 'onOrderbook' | 'onOrder'> = {}): TossPriceWs {
        return new TossPriceWs({
            getAccessToken: () => this.tokenAuthFor().getAccessToken(),
            ...handlers,
        });
    }

    // ============ 실시간(ccxt pro) ============
    //
    // `createPriceStream` 위에 ccxt pro 의 `watch*` 를 둔다. 호출마다 다음 갱신을 돌려주고, 처음 부를 때 구독한다. 토스 구독은 선언형이라 구독
    // 목록 전체를 다시 보낸다. 체결 프레임은 가격과 수량만 주므로 `watchTicker` 의 시세도 현재가뿐이다.

    private watchSocket: TossPriceWs | undefined;
    private readonly watchHub = new WatchHub();
    /** 구독 키(`trade:kr:005930`, `order:<계좌>`) → 구독 */
    private readonly watchSubs = new Map<string, TossWsSub>();

    /** 구독을 더한다. 처음이면 연결하고, 아니면 전체 구독을 다시 선언한다. */
    private watchSubscribe(key: string, sub: TossWsSub): void {
        if (this.watchSubs.has(key)) return;
        this.watchSubs.set(key, sub);
        if (this.watchSocket === undefined) {
            this.watchSocket = this.createPriceStream({
                onTrade: (market, code, price, volume, timestamp) => {
                    const symbol = this.watchSymbolOf(market, code);
                    const stamp = this.msStamp(timestamp ?? this.milliseconds());
                    this.watchHub.resolve(`ticker:${symbol}`, this.safeTicker({ symbol, ...stamp, last: price, info: { market, symbol: code, price, volume } }));
                    this.watchHub.push(`trades:${symbol}`, this.safeTrade({ symbol, ...stamp, price, amount: volume, info: { market, symbol: code, price, volume } }));
                },
                onOrderbook: (market, code, bids, asks, timestamp) => {
                    const symbol = this.watchSymbolOf(market, code);
                    const stamp = this.msStamp(timestamp ?? this.milliseconds());
                    this.watchHub.resolve(`orderbook:${symbol}`, this.safeOrderBook({ symbol, timestamp: stamp.timestamp, datetime: stamp.datetime, bids, asks }));
                },
                onOrder: (_accountSeq, _event, order) => {
                    const parsed = this.parseOrder(order);
                    this.watchHub.push('orders', parsed);
                    if (parsed.symbol !== undefined) this.watchHub.push(`orders:${parsed.symbol}`, parsed);
                },
            });
            this.watchSocket.start([...this.watchSubs.values()]);
        } else {
            this.watchSocket.updateSubs([...this.watchSubs.values()]);
        }
    }

    /** 토스 원본 코드 → 통합 심볼. 종목 목록에 없으면 `commonStockCodes` 를 거친 코드에 시장의 통화를 붙인다. */
    private watchSymbolOf(market: 'us' | 'kr', code: string): string {
        const known = this.markets_by_id?.[code]?.[0]?.symbol;
        return known ?? `${this.commonStockCode(code)}/${market === 'us' ? 'USD' : 'KRW'}`;
    }

    private watchMarketSub(channel: 'trade' | 'orderbook', symbol: string): string {
        const market = this.market(symbol);
        const country = this.countryOf(market) === 'US' ? 'us' : 'kr';
        const code = market.id as string;
        this.watchSubscribe(`${channel}:${country}:${code}`, { channel, market: country, symbol: code });
        return market.symbol;
    }

    /** 다음 시세. 체결 프레임으로 만들어 현재가만 채운다. */
    async watchTicker(symbol: string, params: Dict = {}): Promise<Ticker> {
        return await this.watchHub.next<Ticker>(`ticker:${this.watchMarketSub('trade', symbol)}`, params.signal);
    }

    /** 새 체결. 지난 호출 뒤로 받은 체결을 한꺼번에 돌려준다. */
    async watchTrades(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        const trades = await this.watchHub.nextBatch<Trade>(`trades:${this.watchMarketSub('trade', symbol)}`, params.signal);
        return this.filterBySinceLimit(trades as unknown as Dict[], since, limit, 'timestamp', true) as unknown as Trade[];
    }

    /** 다음 호가. 토스는 구독 직후 스냅샷을 보내지 않는다. 첫 값은 다음 호가 변경 때 온다. */
    async watchOrderBook(symbol: string, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        const book = await this.watchHub.next<OrderBook>(`orderbook:${this.watchMarketSub('orderbook', symbol)}`, params.signal);
        return limit === undefined ? book : { ...book, bids: book.bids.slice(0, limit), asks: book.asks.slice(0, limit) };
    }

    /** 본인 주문 변화. 계좌 순번(`accountSeq`)이 없으면 계좌 조회로 먼저 얻는다. 주문은 REST 주문 조회와 같은 원본을 `parseOrder` 로 옮긴다. */
    async watchOrders(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        if (this.uid === undefined) await this.loadAccountSeq();
        const accountSeq = String(this.uid);
        this.watchSubscribe(`order:${accountSeq}`, { channel: 'order', accountSeq });
        const orders = await this.watchHub.nextBatch<Order>(symbol === undefined ? 'orders' : `orders:${this.market(symbol).symbol}`, params.signal);
        return this.filterBySinceLimit(orders as unknown as Dict[], since, limit, 'timestamp', true) as unknown as Order[];
    }

    /** 실시간 연결을 닫고 기다리던 `watch*` 를 거절한다. */
    override async close(): Promise<void> {
        this.watchSocket?.stop();
        this.watchSocket = undefined;
        this.watchSubs.clear();
        this.watchHub.reject(new ExchangeClosedByUser(`${this.id} 실시간 연결을 닫았다`));
    }
}
