/**
 * @fileoverview KB증권 Open API 클래스 — `class kbsec extends Exchange`. 국내·해외(미국) 주식 현물, REST 전용이다.
 *
 * ```ts
 * const exchange = new kbsec({ apiKey: '앱키', secret: '앱시크릿' });
 * const ticker = await exchange.fetchTicker('005930/KRW');
 * const balance = await exchange.fetchBalance();
 * const order = await exchange.createOrder('AAPL/USD', 'limit', 'buy', 1, 230);
 * ```
 *
 * ## KB 규격
 *
 * - 엔드포인트가 기능이 아니라 **TR 코드**다. `POST /api/v1/{trcode}` 이고 조회도 POST 다. `describe().api` 가 TR 코드 트리이고,
 *   `sign` 이 `{ dataHeader, dataBody }` 봉투 요청을 만든다.
 * - 필드가 전부 `char` 이고 길이가 고정이다. 금액·수량·가격이 모두 문자열로 온다.
 * - **업무 오류가 HTTP 200 으로 온다.** `handleErrors` 가 `dataHeader.processFlag` 로 성패를 가르고 `processCode` 를 오류 클래스로 옮긴다.
 * - **계좌번호를 받지 않는다.** 93개 TR 어디에도 계좌번호 입력이 없고, 계좌가 앱키에 묶이는 구조로 보인다. `uid` 는 사람이 구분하려는 메모다.
 * - **모의투자 서버가 없다.** `setSandboxMode(true)` 는 `NotSupported` 다.
 *
 * ## 심볼
 *
 * `005930/KRW`(국내), `AAPL/USD`(미국). KB 는 TR 마다 종목코드를 직접 받아서 종목 목록을 내려받지 않는다. `market(symbol)` 이 심볼 모양으로
 * 종목을 그때그때 만든다(`market.info.country` 가 `KR` 또는 `US`).
 *
 * ## 옵션
 *
 * 전역 설정은 없고 인스턴스가 `options` 로 받는다. `tokenStore`(토큰 저장소), `nxtRouting`(정규장 밖 국내 주문을 SOR 로), `krwIntegratedMargin`(원마켓 계좌의
 * 미국 주식 매수여력을 원화 환산분으로 보강, 환율은 `usdKrwRate`), `masterData`(해외 종목의 상장 거래소 판별), `confirmBudget`(체결 확정 조회 예산)이다.
 * 켜고 끄는 옵션은 불리언이거나 불리언을 돌려주는 함수다.
 *
 * ## 안전 계약
 *
 * - 주문 요청은 재시도하지 않고, 시간 초과나 연결 끊김이면 `OrderOutcomeUnknown` 이다. 접수 여부는 `fetchOrder`·`fetchMyTrades` 로 확인한다.
 * - 조회가 실패하면 던진다. 빈 결과(보유 없음, 체결 없음)와 조회 실패를 같은 값으로 돌려주지 않는다.
 * - 잔고를 일부만 읽었으면 `balances.info.readStatus` 가 `PARTIAL` 이고 못 읽은 시장이 `unreadMarkets` 에 있다. 이때 목록에 없는 종목은
 *   미보유가 아니라 미확인이다.
 * - 주문 응답을 요청값으로 추정하지 않는다. 접수 뒤 체결 조회로 확정하고, 확정하지 못하면 `order.info.fillConfirmed` 가 `false` 다.
 * - KB 는 "잘못된 조회의 과도한 반복"을 계정 제한 사유로 든다. 영구 실패(권한 없음 등)한 조회는 이 인스턴스에서 다시 부르지 않는다.
 */

import { logger } from './logger';
import type { UsdKrwRateOption } from './options';
import { masterDataOf } from './kis/kis-master-data';
import {
    ArgumentsRequired,
    AuthenticationError,
    BadResponse,
    BadSymbol,
    BaseError,
    Exchange,
    ExchangeError,
    InvalidOrder,
    MarketClosed,
    NotSupported,
    NullResponse,
    OrderNotFound,
    RequestTimeout,
    omit,
    safeDict,
    safeString,
} from './base';
import type {
    Balances, Dict, Dictionary, Int, MarketInterface, Num, OHLCV, Order, OrderBook, OrderSide, OrderType, Str, Ticker, Trade,
    TradingFeeInterface,
} from './base';
import { confirmExecution, fillDeviationBps, tradeListProbe } from './execution-confirm';
import { expandBusinessDays, refreshMarketCalendar as refreshSharedMarketCalendar, type CalendarDay } from './market-calendar';
import { marketSessionBlockReason } from './trading-hours';
import { KBSecAuth } from './kbsec/kbsec-auth';
import { kbsecCandleTimestamp, kbsecChartParams, KBSEC_TIMEFRAMES } from './kbsec/kbsec-chart';
import {
    isKBSecBusinessError, isKBSecTokenFailure, kbsecHostAddr, type KBSecResponseHeader,
} from './kbsec/kbsec-envelope';
import { KBSEC_ERROR_DETAIL, kbsecErrorDetail, kbsecExactExceptions } from './kbsec/kbsec-error-codes';
import { kbsecEstimatedFeeRate } from './kbsec/kbsec-fee';
import {
    kbsecResolveFills, parseKbsecDomesticFillRow, parseKbsecOverseasFillRow, type KbsecFill,
} from './kbsec/kbsec-fill-row';
import {
    warnFillWithoutPrice, warnIfFillSideUnreadable, warnIfFillTotalsInconsistent,
} from './kbsec/kbsec-fill-warnings';
import { buildKrOrderBody } from './kbsec/kbsec-order-body';
import {
    kbsecHoldingQuantity, OVERSEAS_QTY_CANDIDATES, pickArray, pickCashGrid, pickHoldingGrid, pickNum,
    pickOverseasSettlementGrid, pickPositiveNum, pickSettlementGrid, pickStr,
} from './kbsec/kbsec-pick';
import {
    KBSEC_SETTLE_CLSF, KBSEC_SETTLE_TRD_CLSF, kbsecResolveSettlementRows, parseKbsecDomesticSettlementRow,
    type KbsecSettlementRow,
} from './kbsec/kbsec-settlement-row';
import {
    KBSEC_OVERSEAS_SETTLE_DL_CLSF, KBSEC_OVERSEAS_SETTLE_FX_AXIS, KBSEC_OVERSEAS_SETTLE_TRD_CLSF,
    kbsecResolveOverseasSettlementRows, parseKbsecOverseasSettlementRow, type KbsecOverseasSettlementRow,
} from './kbsec/kbsec-overseas-settlement-row';
import { fillTrInputs } from './kbsec/kbsec-tr-inputs';
import { recordKbsecCallOk, recordTokenFailure, throwIfTokenBreakerOpen } from './kbsec/kbsec-token-breaker';
import {
    KBSEC_API_BASE,
    KBSEC_CCLS_FILLED,
    KBSEC_CCLS_PENDING,
    KBSEC_CONT_FIRST,
    KBSEC_EXCH_RATE_MARKET,
    KBSEC_FEE_EXCLUDED,
    KBSEC_INQ_ALL,
    KBSEC_INQ_STOCK,
    KBSEC_ORDER_SIDE_KR,
    KBSEC_ORDER_SIDE_US,
    KBSEC_ORDER_TYPE_KR,
    KBSEC_ORDER_TYPE_US,
    KBSEC_ORDER_TR_CODES,
    KBSEC_SESSION_REGULAR,
    KBSEC_SOR,
    KBSEC_STD_CURRENCY_FOREIGN,
    KBSEC_TR,
    KBSEC_TR_PATH_PREFIX,
    KBSEC_US_EXCHANGES,
    kbsecBaseSymbol,
    kbsecBusinessDateKst,
    kbsecDateKst,
    kbsecMarketOf,
    kbsecNormalizeCode,
    kbsecNum,
    kbsecTodayKst,
} from './kbsec/kbsec-types';

// ============ 시간·재시도 상수 ============

/**
 * 조회 요청 상한(ms). 조회에는 바깥쪽 상한이 따로 없어 여기가 유일한 상한이다. 너무 짧게 잡으면 안 된다. KB 는 토큰 발급이 분당 1회로 제한되고
 * "잘못된 조회의 과도한 반복"을 계정 제한 사유로 명시하므로, 정상 응답을 자르면 그만큼 재호출이 늘어 그 제한을 건드린다.
 */
const READ_TIMEOUT_MS = 20_000;

/**
 * 주문 요청 상한(ms). 호출하는 쪽이 주문 실행에 두는 바깥 시간 상한(보통 30초)보다 **짧아야** 한다. 그래야 요청을 방치한 채 실패로 읽는 게
 * 아니라 요청을 끊고 "접수 여부를 모른다"(`OrderOutcomeUnknown`)로 다룬다.
 */
const ORDER_TIMEOUT_MS = 25_000;

/**
 * 요청 사이 간격(ms, 비용 1 기준). KB 는 호출 제한 수치를 공개하지 않는다. 초당 2~3회로 낮게 시작하고 실측으로 조정한다.
 * 과거에는 이 증권사에 전용 값이 없어 다른 거래소의 기본값(초당 10회)이 적용됐다.
 */
const RATE_LIMIT_MS = 400;

/** 휴장일 캘린더를 다시 받기까지의 시간. 장운영상태 TR 은 전·기준·익영업일만 줘서 자주 받아야 한다. */
const CALENDAR_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * `describe().api` 의 잎 목록이다. 이 클래스가 부르는 TR 이며, 주문을 바꾸는 TR 은 `order: true` 다.
 * 주문 TR 목록(`KBSEC_ORDER_TR_CODES`)에서 가져오므로 주문 TR 을 추가하고 이 표에서 빠뜨리는 일이 없다.
 */
function kbsecApiEndpoints(): Record<string, { cost: number; order?: boolean }> {
    const wired = [
        KBSEC_TR.QUOTE_KR, KBSEC_TR.ORDERBOOK_KR, KBSEC_TR.CHART_KR, KBSEC_TR.MARKET_STATUS,
        KBSEC_TR.QUOTE_US, KBSEC_TR.ORDERBOOK_US,
        KBSEC_TR.DEPOSIT, KBSEC_TR.HOLDINGS, KBSEC_TR.ASSET_EVAL,
        KBSEC_TR.BUYABLE_KR, KBSEC_TR.BUY_KR, KBSEC_TR.SELL_KR, KBSEC_TR.AMEND_KR, KBSEC_TR.CANCEL_KR,
        KBSEC_TR.TRADES_KR, KBSEC_TR.SETTLEMENT_KR, KBSEC_TR.FRAC_BUY_KR, KBSEC_TR.FRAC_SELL_KR,
        KBSEC_TR.ORDER_US, KBSEC_TR.AMEND_CANCEL_US, KBSEC_TR.ORDERS_US,
        KBSEC_TR.ONEMARKET_BUYABLE, KBSEC_TR.ONEMARKET_MARGIN, KBSEC_TR.HOLDINGS_US, KBSEC_TR.SETTLEMENT_US,
    ];
    const endpoints: Record<string, { cost: number; order?: boolean }> = {};
    for (const code of wired) {
        endpoints[code.toLowerCase()] = KBSEC_ORDER_TR_CODES.has(code) ? { cost: 1, order: true } : { cost: 1 };
    }
    return endpoints;
}

// ============ 결과 타입 ============

/**
 * 국내 정산 조회 결과. **실패와 0건을 타입으로 가른다.** 빈 배열 하나로 둘을 표현하면 호출하는 쪽이 구분할 방법이 없다.
 */
export type KbsecSettlementFetch =
    /** 조회 성공. `rows` 가 비면 그날 정산 행이 없다는 뜻이다(미정산 구간 포함). */
    | { ok: true; rows: KbsecSettlementRow[]; truncated: boolean }
    /** 조회 자체가 실패했다. 그날 매매가 없었다는 뜻이 아니다. */
    | { ok: false; error: string };

/**
 * 해외 정산 조회 결과. 국내와 같은 이유로 실패와 0건을 가른다. 행 타입만 다르다(USD 축). 두 유니온을 합치지 않는 이유는 그 축이 섞이면 원화
 * 금액이 USD 필드로 들어갈 수 있어서다.
 */
export type KbsecOverseasSettlementFetch =
    | { ok: true; rows: KbsecOverseasSettlementRow[]; truncated: boolean }
    | { ok: false; error: string };

/** 잔고를 얼마나 읽었는가. `FAILED` 는 던지므로 결과에는 두 값만 나온다. */
export type KbsecReadStatus = 'COMPLETE' | 'PARTIAL';

/** `fetchOverseasBuyableAmount` 결과. `quoteCurrency` 로 어느 통화 기준인지 함께 알린다. */
export interface KbsecOverseasBuyable {
    amount: number;
    quoteCurrency: 'KRW' | 'USD';
    maxQuantity: number;
}

/** `fetchOneMarketMargin` 결과. */
export interface KbsecOneMarketMargin {
    krwDeposit: number;
    krwEquivalentForeign: number;
    orderMarginSum: number;
    totalDeposit: number;
    withdrawable: number;
}

/** 해외 보유 조회 결과. `read` 는 이번 조회가 성공했고 종목 그리드를 본 적이 있는가다. */
interface OverseasHoldings {
    rows: HoldingRow[];
    usdCash: Dict | undefined;
    read: boolean;
}

/** 잔고 항목으로 옮기기 전의 보유 종목 한 줄. */
interface HoldingRow {
    code: string;
    quantity: number;
    quoteCurrency: 'KRW' | 'USD';
    averagePrice?: number;
    marketValue: number;
    name?: string;
}

const NO_ORDER_ID = '';

/** 조건(스톱) 주문을 뜻하는 `createOrder` 인자. KB 클래스는 조건 주문을 보내지 않으므로 하나라도 있으면 거절한다. */
const UNSUPPORTED_CONDITIONAL_PARAMS = ['triggerPrice', 'stopPrice', 'stopLossPrice', 'takeProfitPrice'] as const;

export class kbsec extends Exchange {
    /** 발급한 토큰을 들고 있는 인증 객체. 앱키·시크릿이 바뀌면 다시 만든다. */
    private authInstance: KBSecAuth | undefined = undefined;
    private authIdentity = '';

    /** 해외 종목의 KB 거래소코드(`krx_cd`). 심볼당 한 번 탐색해 캐시한다. NYSE 종목이 섞여 있어 `NAS` 로 고정하면 안 된다. */
    private readonly usExchangeCache = new Map<string, string>();
    /** 평가금액 산출용 현재가 캐시(code → 가격·조회 시각). */
    private readonly holdingPriceCache = new Map<string, { price: number; at: number }>();
    /** NXT 미상장이 실측으로 확인된 종목(인스턴스 수명). 거부 응답으로 역산하며 영속화하지 않는다. 재시작이 캐시 만료다. */
    private readonly nxtIneligible = new Set<string>();
    /** 조회일자 되감기 캐시(KST 날짜별). 연휴에 사이클마다 같은 실패를 반복하지 않게 한다. */
    private businessDateBackoff: { day: string; steps: number } = { day: '', steps: 0 };
    private holdingFieldsLogged = false;

    /** 해외 잔고 TR 이 **영구 실패**했는가(권한 없음 등 업무 오류). 반복 호출은 계정 제한 사유라 다시 부르지 않는다. */
    private overseasHoldingsUnavailable = false;
    /** 일시 오류 뒤 해외 잔고를 다시 부르기 전까지 기다리는 시각(epoch ms). 0 이면 대기 없음. */
    private overseasHoldingsRetryAt = 0;
    /**
     * 해외 보유 종목 **그리드를 실제로 본 적이 있는가.** 종목 그리드를 못 알아보면 빈 배열이 돌아오므로 "해외 보유 없음"과 "보유를 못 읽음"이
     * 같은 모습이 된다. 이 값이 그 둘을 가른다. 한 번 참이 되면 내려가지 않는 이력이다.
     */
    private overseasGridSeen = false;
    /** 해외 체결조회(SPQM2103) 영구 실패. */
    private overseasFillsUnavailable = false;
    /** 원마켓 증거금(SPQM3390) 영구 실패. 미신청 계좌는 다시 물어도 답이 같다. */
    private oneMarketUnavailable = false;
    private oneMarketNoticeLogged = false;

    // ============ 선언 ============

    override describe(): Dict {
        return this.deepExtend(super.describe(), {
            id: 'kbsec',
            name: 'KB증권',
            countries: ['KR'],
            version: 'v1',
            rateLimit: RATE_LIMIT_MS,
            timeout: READ_TIMEOUT_MS,
            orderTimeout: ORDER_TIMEOUT_MS,
            has: {
                spot: true,
                margin: false,
                swap: false,
                future: false,
                option: false,
                sandbox: false,
                fetchMarkets: false,
                fetchCurrencies: false,
                fetchTicker: true,
                fetchTickers: false,
                fetchOrderBook: true,
                // 국내만 지원한다. 해외 차트는 봉 시각의 기준(한국 시각인지 현지 시각인지)이 명세에 없어 `NotSupported` 다.
                fetchOHLCV: true,
                fetchBalance: true,
                createOrder: true,
                createLimitOrder: true,
                createMarketOrder: true,
                editOrder: true,
                cancelOrder: true,
                cancelAllOrders: 'emulated',
                fetchOrder: true,
                fetchOrders: false,
                fetchOpenOrders: true,
                // KB 에는 체결 완료 주문만 따로 주는 조회가 없다. 체결은 `fetchMyTrades` 로 본다.
                fetchClosedOrders: false,
                fetchCanceledOrders: false,
                fetchMyTrades: true,
                // KB 에 수수료 조회 TR 이 없어 공시 요율로 추정한다.
                fetchTradingFee: 'emulated',
                fetchStatus: false,
                fetchTime: false,
                // 주식 고유. 장운영상태 TR 로 전·기준·익영업일을 받아 휴장일 캘린더를 채운다.
                fetchMarketCalendar: true,
                createConditionalOrder: false,
            },
            urls: {
                api: { private: KBSEC_API_BASE },
                www: 'https://openapi.kbsec.com',
                doc: ['https://openapi.kbsec.com', 'https://github.com/kbsecurities/kb-openapi'],
            },
            api: {
                private: {
                    post: kbsecApiEndpoints(),
                },
            },
            requiredCredentials: {
                apiKey: true,
                secret: true,
                uid: false,
            },
            timeframes: { ...KBSEC_TIMEFRAMES },
            // 위탁수수료율의 공시 근사다. 실청구액은 정산 TR(`fetchDomesticSettlements`·`fetchOverseasSettlements`)이 준다.
            fees: {
                trading: { tierBased: false, percentage: true },
            },
            precisionMode: 4, // TICK_SIZE. 국내 호가단위는 가격대별이라 종목 정밀도로 적지 않는다.
            exceptions: {
                exact: kbsecExactExceptions(),
            },
            options: {
                defaultType: 'spot',
                /** 해외 시장가 매수를 대체하는 지정가에 더하는 버퍼. 상한일 뿐 비용이 아니다(체결은 호가에서 일어난다). */
                marketableLimitBuffer: 0.005,
                /** 잔고 평가에 쓰는 현재가 캐시 시간(ms). */
                holdingPriceTtl: 60_000,
                /** 보유주식 연속조회 페이지 상한. 호출 급증을 막는 값이지 정상 한도가 아니다. */
                holdingsMaxPages: 20,
                /** 정산 연속조회 페이지 상한. */
                settlementMaxPages: 20,
                /** 조회일자 되감기 상한. 연휴를 덮되 날짜와 무관한 실패를 무한 재시도하지 않는다. */
                businessDateMaxBackoff: 5,
                /** 결제대기 매도 보정용 체결내역 조회 창(영업일 수). KRX 는 T+2 결제라 T·T+1·T+2 세 영업일이다. */
                settlementLookbackDays: 3,
                /** 일시 오류 뒤 같은 TR 을 다시 부르기까지의 대기(ms). 영구 오류는 래치라 이 값과 무관하다. */
                transientRetryCooldown: 5 * 60 * 1000,
                /**
                 * 국내 체결 확정 폴링 예산. 5회 × 1초다. KRX 는 현재가 지정가라도 체결이 몇 초 뒤에 잡히는 일이 흔하고, KB 는 반복 조회를 계정
                 * 제한 사유로 들므로 짧은 간격으로 자주 부르는 것보다 1초 간격이 안전하다. 해외는 공용 기본값을 쓴다.
                 */
                domesticConfirmBudget: { attempts: 5, intervalMs: 1000 },
                // 켜고 끄는 옵션은 불리언이거나 불리언을 돌려주는 함수(값이 바뀔 수 있을 때)다. 기본은 꺼짐이다.
                /** 정규장 밖 국내 주문을 SOR(KRX·NXT 중 유리한 쪽)로 낸다. */
                nxtRouting: undefined,
                /** 원마켓(통합증거금) 계좌의 미국 주식 매수여력을 원화 환산분으로 보강한다. */
                krwIntegratedMargin: undefined,
                /** 토큰을 여러 프로세스가 나눠 쓰는 저장소(`BrokerTokenStore`). 없으면 프로세스 메모리 캐시만 쓴다. */
                tokenStore: undefined,
                /** 원마켓 환산에 쓰는 환율 조회 함수. 1달러당 원화를 돌려주는 `() => Promise<number>` 다. 없으면 환산을 하지 못한다. */
                usdKrwRate: undefined,
                /** 해외 종목의 상장 거래소를 찾는 KIS 마스터 데이터(`KisMasterData`). 없으면 빈 데이터라 해외 주문은 거래소 미상으로 막힌다. */
                masterData: undefined,
                /** 접수 뒤 체결 확정 조회의 예산 `{ attempts, intervalMs }`. 객체이거나 객체를 돌려주는 함수다. */
                confirmBudget: undefined,
            },
        });
    }

    // ============ 요청 ============

    /** 앱키·시크릿에 묶인 인증 객체. 토큰 캐시와 발급 락이 여기 있다. */
    private getAuth(): KBSecAuth {
        const identity = `${this.apiKey}\u0000${this.secret}`;
        if (this.authInstance === undefined || identity !== this.authIdentity) {
            const api = this.urls.api;
            const baseUrl = typeof api === 'string' ? api : (api?.private ?? KBSEC_API_BASE);
            this.authInstance = new KBSecAuth({ appKey: this.apiKey as string, appSecret: this.secret as string, accountNo: this.uid }, baseUrl, () => this.getTokenStore());
            this.authIdentity = identity;
        }
        return this.authInstance;
    }

    /** 비공개 호출 앞에서 토큰을 준비해 요청 헤더에 싣는다. 소문자 `bearer` 다(공식 예제 기준이며 대문자는 거부된 사례가 있다). */
    override async authenticate(
        _path: string, _api: string | string[], _method: string, _params: Dict, headers: Dictionary<string> | undefined,
    ): Promise<void> {
        let token: string;
        try {
            token = await this.getAuth().getAccessToken();
        } catch (e) {
            if (e instanceof BaseError) throw e;
            throw new AuthenticationError(`${this.id} 토큰을 받지 못했다: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
        }
        if (headers !== undefined) headers['Authorization'] = `bearer ${token}`;
    }

    /** TR 요청을 만든다. 본문은 스펙의 입력 필드를 전부 채운 `{ dataHeader, dataBody }` 봉투다(부분 본문은 거부된다). */
    override sign(
        path: string, _api: string | string[] = 'private', _method = 'POST', params: Dict = {},
        headers: Dictionary<string> | undefined = undefined, _body: string | undefined = undefined,
    ) {
        const api = this.urls.api;
        const baseUrl = typeof api === 'string' ? api : (api?.private ?? KBSEC_API_BASE);
        return {
            url: `${baseUrl}${KBSEC_TR_PATH_PREFIX}${path.toLowerCase()}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                appKey: this.apiKey as string,
                ...headers,
            },
            body: JSON.stringify({
                // 빈 값이면 KB 가 TR 을 거부한다. `kbsecHostAddr` 주석을 본다.
                dataHeader: kbsecHostAddr(),
                dataBody: fillTrInputs(path, params),
            }),
        };
    }

    /**
     * 토큰이 무효인 응답을 만나면 토큰을 회전하고 **한 번** 다시 보낸다. 그 뒤에도 토큰 실패면 차단기에 센다.
     * 401(표준)과 500 + `I445`(KB 실제) 모두 `AuthenticationError`(`detail: TOKEN_INVALID`)로 온다.
     */
    override async fetch2(
        path: string, api: string | string[] = 'private', method = 'POST', params: Dict = {},
        headers: Dictionary<string> | undefined = undefined, body: string | undefined = undefined, config: Dict = {},
    ): Promise<any> {
        return this.fetchWithTokenRecovery(path, api, method, params, headers, body, config, true);
    }

    private async fetchWithTokenRecovery(
        path: string, api: string | string[], method: string, params: Dict,
        headers: Dictionary<string> | undefined, body: string | undefined, config: Dict, allowRetry: boolean,
    ): Promise<any> {
        const trCode = path.toUpperCase();
        // 차단기가 열려 있으면 KB 를 부르지 않는다. 근거는 `kbsec-token-breaker.ts`.
        throwIfTokenBreakerOpen(trCode);
        // 요청마다 새 헤더 객체를 쓴다. `authenticate` 가 여기에 토큰을 싣고, 실패했을 때 어느 토큰이었는지 여기서 읽는다.
        const requestHeaders: Dictionary<string> = { ...headers };
        try {
            const response = await super.fetch2(path, api, method, params, requestHeaders, body, config);
            recordKbsecCallOk();
            return response;
        } catch (error) {
            const tokenFailed = error instanceof AuthenticationError && error.detail === KBSEC_ERROR_DETAIL.TOKEN_INVALID;
            if (!tokenFailed) {
                // 응답을 읽고 던진 오류(업무 거절)는 토큰이 통했다는 뜻이므로 차단기를 푼다. 전송 실패는 아무것도 알려 주지 않는다.
                if (error instanceof ExchangeError) recordKbsecCallOk();
                throw error;
            }
            const failedToken = String(requestHeaders['Authorization'] ?? '').replace(/^bearer /i, '');
            if (allowRetry) {
                logger.warn({ trCode }, '[kbsec] 토큰 실패 — 재발급 후 1회 재시도');
                // 무효화만으로는 부족한 경우가 있다. KB 가 재발급에 같은 토큰을 돌려주면 폐기·회전까지 해야 한다.
                // 무효화가 끝나기 전에 재시도가 캐시를 읽으면 방금 무효로 판정한 토큰을 다시 쓰므로 반드시 기다린다.
                await this.getAuth().rotateAfterTokenFailure(failedToken);
                return this.fetchWithTokenRecovery(path, api, method, params, headers, body, config, false);
            }
            // 폐기·회전까지 하고도 토큰 실패면 우리 쪽에서 쓸 수단이 다 떨어진 상태다.
            recordTokenFailure(trCode, KBSEC_ERROR_DETAIL.TOKEN_INVALID);
            throw error;
        }
    }

    /**
     * 응답 봉투를 오류로 옮긴다. 상태 코드와 무관하게 봉투가 정본이다. 200 이어도 업무 실패일 수 있고 500 이어도 구조화된 업무 오류일 수 있다.
     * 봉투가 없는 비-2xx 는 `httpExceptions` 표가 받는다.
     */
    override handleErrors(
        statusCode: number, _statusText: string, url: string, method: string, _responseHeaders: Dictionary<string>,
        responseBody: string, response: unknown,
    ): boolean | undefined {
        const header = safeDict(response, 'dataHeader') as KBSecResponseHeader | undefined;
        const trCode = (url.split('/').pop() ?? '').toUpperCase();
        if (isKBSecBusinessError(header)) {
            const processCode = String(header?.processCode ?? '').trim();
            const processMessage = String(header?.processMessage ?? '').trim();
            const feedback = `KB증권 업무 오류 (${trCode}): ${processMessage} [processCode=${processCode}]`;
            const detail = kbsecErrorDetail(processCode);
            this.throwExactlyMatchedException((this.exceptions as Dict).exact, processCode, feedback, { detail });
            throw new ExchangeError(feedback);
        }
        if (isKBSecTokenFailure(statusCode, header)) {
            throw new AuthenticationError(`${this.id} ${method} ${url} ${statusCode} 토큰이 무효다`, { detail: KBSEC_ERROR_DETAIL.TOKEN_INVALID });
        }
        if (statusCode >= 200 && statusCode < 300 && response === undefined) {
            throw new BadResponse(`KB증권 응답이 JSON 이 아님 (${trCode}): ${responseBody.slice(0, 200)}`);
        }
        return undefined;
    }

    /** TR 을 호출하고 봉투에서 `dataBody` 를 꺼낸다. 오류는 `handleErrors` 가 던진다. */
    private async callTr(trCode: string, dataBody: Dict = {}): Promise<Dict> {
        const methodName = `privatePost${trCode.charAt(0).toUpperCase()}${trCode.slice(1).toLowerCase()}`;
        const implicitMethod = this[methodName] as ((params: Dict) => Promise<unknown>) | undefined;
        if (typeof implicitMethod !== 'function') throw new NotSupported(`${this.id} 에 없는 TR 이다: ${trCode}`);
        const response = await implicitMethod(dataBody);
        return safeDict(response, 'dataBody', {}) ?? {};
    }

    // ============ 종목 ============

    /**
     * KB 는 종목 목록 TR 을 쓰지 않는다. 심볼 모양으로 종목을 만든다. `005930/KRW`·`005930` 은 국내, 그 밖은 미국이다.
     * 이미 `markets` 를 넣어 두었으면 그것을 먼저 찾는다.
     */
    override market(symbol: Str): MarketInterface {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} market() requires a symbol argument`);
        const known = this.markets?.[symbol];
        if (known !== undefined) return known;
        const base = kbsecBaseSymbol(symbol).toUpperCase();
        if (base === '') throw new BadSymbol(`${this.id} does not have market symbol ${symbol}`);
        const country = kbsecMarketOf(base);
        const quote = country === 'KR' ? 'KRW' : 'USD';
        return this.safeMarketStructure({
            id: base,
            symbol: `${base}/${quote}`,
            base,
            quote,
            baseId: base,
            quoteId: quote,
            type: 'spot',
            spot: true,
            margin: false,
            swap: false,
            future: false,
            option: false,
            active: true,
            contract: false,
            // 주식은 주 단위다. 국내 호가단위는 가격대별이라 가격 정밀도는 적지 않는다.
            precision: { amount: 1, price: undefined },
            info: { country },
            options: { country },
        });
    }

    private isUs(market: MarketInterface): boolean {
        return market.options?.country === 'US';
    }

    // ============ 시세 ============

    /** 해외 종목의 현재가 응답. 거래소코드를 후보 순서대로 시도해 실데이터가 나온 응답을 돌려준다. 못 찾으면 `undefined`. */
    private async callUsQuote(base: string): Promise<Dict | undefined> {
        const cached = this.usExchangeCache.get(base);
        const candidates = cached !== undefined ? [cached] : KBSEC_US_EXCHANGES;
        for (const krxCode of candidates) {
            const row = await this.callTr(KBSEC_TR.QUOTE_US, { krx_cd: krxCode, is_cd: base });
            if (pickNum(row, 'now_prc_p4') > 0) {
                this.usExchangeCache.set(base, krxCode);
                return row;
            }
        }
        return undefined;
    }

    override async fetchTicker(symbol: string, _params: Dict = {}): Promise<Ticker> {
        const market = this.market(symbol);
        let row: Dict | undefined;
        if (this.isUs(market)) {
            row = await this.callUsQuote(market.id as string);
            if (row === undefined) {
                throw new NullResponse(`${this.id} fetchTicker() ${symbol} 해외 현재가 없음 — 거래소코드 전 계열 미매칭`);
            }
        } else {
            // 국내 현재가 입력은 `excg_clsf`(0 통합, 1 KRX, 2 NXT)와 `shrt_cd`(단축코드)다. `is_cd` 를 보내면 "해당자료가 없습니다"가 온다.
            row = await this.callTr(KBSEC_TR.QUOTE_KR, { excg_clsf: '1', shrt_cd: market.id });
        }
        const ticker = this.parseTicker(row, market);
        if (ticker.last === undefined) {
            throw new NullResponse(`${this.id} fetchTicker() ${symbol} 현재가를 읽지 못했다 — 응답 필드 대조 필요`);
        }
        return ticker;
    }

    override parseTicker(ticker: Dict, market: MarketInterface | undefined = undefined): Ticker {
        const isUs = market !== undefined && this.isUs(market);
        // 해외는 출력 필드가 국내와 완전히 다르다(`_p4` 계열). 국내 이름으로 읽으면 전부 파싱에 실패한다.
        // 국내 실측 필드는 `now_prc`(현재가)와 `bdy_cls_prc`·`krx_bdy_clpr`(전일·당일 종가)다. 장 밖에서는 `now_prc` 가 '000000000' 으로 오므로
        // **양수인 첫 후보**를 골라야 종가 폴백에 닿는다.
        const result = isUs
            ? this.safeTicker({
                symbol: market?.symbol,
                timestamp: undefined,
                datetime: undefined,
                last: pickPositiveNum(ticker, 'now_prc_p4'),
                bid: pickNum(ticker, 'b_askprc_p4'),
                ask: pickNum(ticker, 's_askprc_p4'),
                high: pickNum(ticker, 'hgh_prc_p4'),
                low: pickNum(ticker, 'lw_prc_p4'),
                open: pickNum(ticker, 'opn_prc_p4'),
                percentage: pickNum(ticker, 'up_dwn_r_p2'),
                baseVolume: pickNum(ticker, 'vlm', 'bdy_vlm'),
                info: ticker,
            }, market)
            : this.safeTicker({
                symbol: market?.symbol,
                timestamp: undefined,
                datetime: undefined,
                last: pickPositiveNum(ticker, 'now_prc', 'bdy_cls_prc', 'krx_bdy_clpr', 'expct_ccls_prc'),
                bid: pickNum(ticker, 'b_sq1_askprc'),
                ask: pickNum(ticker, 's_sq1_askprc'),
                high: pickNum(ticker, 'hgh_prc'),
                low: pickNum(ticker, 'lw_prc'),
                open: pickNum(ticker, 'opn_prc'),
                percentage: pickNum(ticker, 'up_dwn_r_p2'),
                baseVolume: pickNum(ticker, 'acml_vlm', 'bdy_vlm'),
                info: ticker,
            }, market);
        // 등락률은 `up_dwn_r_p2` 다(국내의 `bdy_vlm_cmpr_p2` 는 전일 거래량 대비라 등락률이 아니다). 보합이면 0 이 정상 값인데 `safeTicker` 는
        // 0 을 비우고 시가와 종가로 다시 계산하므로, KB 가 준 값이 있으면 그것을 정본으로 되돌린다.
        if ('up_dwn_r_p2' in ticker) result.percentage = pickNum(ticker, 'up_dwn_r_p2');
        return result;
    }

    /** 호가. 국내·해외 모두 REST 호가를 제공한다. 매수는 가격 내림차순, 매도는 오름차순이다. 호가가 하나도 없으면 `NullResponse` 다. */
    override async fetchOrderBook(symbol: string, limit: Int = undefined, _params: Dict = {}): Promise<OrderBook> {
        const market = this.market(symbol);
        const isUs = this.isUs(market);
        const row = isUs
            ? await this.callTr(KBSEC_TR.ORDERBOOK_US, {
                krx_cd: this.usExchangeCache.get(market.id as string) ?? KBSEC_US_EXCHANGES[0],
                is_cd: market.id,
            })
            : await this.callTr(KBSEC_TR.ORDERBOOK_KR, { is_cd: market.id, ovtm_mkt_clsf: '1' });
        // 국내 실측: 가격 `b{N}_aprc`/`s{N}_aprc`, 잔량 `b_pstn_b{N}_aprc_q`/`s_pstn_s{N}_aprc_q`.
        // 해외는 필드 계열이 다르다: 가격 `b_askprc{N}_p4`/`s_askprc{N}_p4`, 잔량 `b_askprc_q{N}`/`s_askprc_q{N}`.
        const bids: Array<[number, number]> = [];
        const asks: Array<[number, number]> = [];
        for (let i = 1; i <= 10; i++) {
            const bidPrice = isUs ? pickNum(row, `b_askprc${i}_p4`) : pickNum(row, `b${i}_aprc`);
            const bidSize = isUs ? pickNum(row, `b_askprc_q${i}`) : pickNum(row, `b_pstn_b${i}_aprc_q`);
            if (bidPrice > 0) bids.push([bidPrice, bidSize]);
            const askPrice = isUs ? pickNum(row, `s_askprc${i}_p4`) : pickNum(row, `s${i}_aprc`);
            const askSize = isUs ? pickNum(row, `s_askprc_q${i}`) : pickNum(row, `s_pstn_s${i}_aprc_q`);
            if (askPrice > 0) asks.push([askPrice, askSize]);
        }
        if (bids.length === 0 && asks.length === 0) {
            throw new NullResponse(`${this.id} fetchOrderBook() ${symbol} 호가가 하나도 없다`);
        }
        const book = this.parseOrderBook({ bids, asks }, market.symbol, undefined);
        if (limit !== undefined) {
            book.bids = book.bids.slice(0, limit);
            book.asks = book.asks.slice(0, limit);
        }
        return book;
    }

    /**
     * 봉. **국내만 지원한다.** 명세(`IVS11560`)의 필드 이름으로 읽으며, 실계좌로 검증한 적은 없다.
     * 해외 차트(`GSC10060`)는 봉 시각이 한국 시각인지 현지 시각인지 명세에 없어 지원하지 않는다.
     * 시장구분(`mkt_clsf`)은 코스피(`0`)로 보낸다. 코스닥 종목에서 빈 응답이 오면 `params.mkt_clsf` 에 `'1'` 을 넘긴다.
     */
    override async fetchOHLCV(
        symbol: string, timeframe = '1d', since: Int = undefined, limit: Int = undefined, params: Dict = {},
    ): Promise<OHLCV[]> {
        const market = this.market(symbol);
        if (this.isUs(market)) {
            throw new NotSupported(`${this.id} fetchOHLCV() 는 국내 종목만 지원한다: 해외 차트의 봉 시각 기준이 명세에 없다`);
        }
        const { chrt_clsf, minute } = kbsecChartParams(timeframe);
        const count = Math.min(limit ?? 100, 9999);
        const body = await this.callTr(KBSEC_TR.CHART_KR, {
            info_ccd: '1', // 원주가
            mkt_clsf: '0', // KOSPI. KOSDAQ 종목도 KB 가 종목코드로 해석하는지는 실측이 필요하다.
            chrt_clsf,
            minute_tck_indx: minute,
            is_cd: market.id,
            inq_clsf: '2', // 데이터 수로 조회
            inq_cnt: kbsecNum(count),
            ...params,
        });
        const rows = pickArray(body).filter(row => kbsecCandleTimestamp(pickStr(row, 'dt'), pickStr(row, 'tm')) !== undefined);
        return this.parseOHLCVs(rows, market, timeframe, since, limit);
    }

    override parseOHLCV(ohlcv: Dict): OHLCV {
        return [
            kbsecCandleTimestamp(pickStr(ohlcv, 'dt'), pickStr(ohlcv, 'tm')),
            pickNum(ohlcv, 'opn_prc_p2'),
            pickNum(ohlcv, 'hgh_prc_p2'),
            pickNum(ohlcv, 'lw_prc_p2'),
            pickNum(ohlcv, 'cls_prc_p2'),
            pickNum(ohlcv, 'vlm'),
        ];
    }

    // ============ 잔고 ============

    /**
     * 통화와 보유 종목의 잔고. 현금은 통화 키(`KRW`, `USD`), 보유 종목은 종목 코드 키이며 `total` 이 **수량**이다. 평균 단가·평가금액·종목명은
     * 각 항목의 `info` 에 있다(`averagePrice`, `marketValue`, `name`, `quoteCurrency`).
     *
     * 국내를 읽지 못하면 던진다(예수금 실패 포함). 해외만 못 읽었으면 던지지 않고 `info.readStatus` 가 `PARTIAL`, 못 읽은 시장이
     * `info.unreadMarkets` 다. **이때 목록에 없는 해외 종목은 미보유가 아니라 미확인이다.** 해외를 읽었다는 것은 이번 조회가 성공했고 해외 그리드를
     * 한 번이라도 본 적이 있다는 뜻이다. 그리드를 본 적이 없으면 빈 응답이 "보유 없음"인지 "그리드를 못 알아봄"인지 가를 수 없다.
     *
     * `USD` 항목은 해외 잔고평가(`SPQM2226`)의 통화별 예수금 그리드에서 온다(예수금·주문가능금액). 그 그리드를 못 읽었으면 `USD` 항목이 없다.
     * **없다는 것은 0 이 아니라 모른다는 뜻이다.** 원마켓 기능 플래그가 켜져 있고 원화환산 외화예수금이 있으면 그것을 환율로 환산한 USD 가 우선한다.
     */
    override async fetchBalance(_params: Dict = {}): Promise<Balances> {
        const deposit = await this.callTr(KBSEC_TR.DEPOSIT, {});
        // 실측 필드: ordr_psbl_csh(주문가능현금) · ordr_std_dpstn_csh(주문기준예수금)
        const krw = pickNum(deposit, 'ordr_psbl_csh', 'ordr_std_dpstn_csh', 'do_psbl_csh');

        // 원마켓(통합증거금) 계좌는 달러 예수금이 0 이어도 원화로 미국 주식을 산다. 플래그가 켜져 있으면 원화환산 외화 예수금을 **USD 로 환산해**
        // 라벨과 값의 축을 맞춘다. 원화 값을 USD 라벨에 그대로 담으면 사이징이 ~1,450배로 읽는다.
        let oneMarketUsd: Dict | undefined;
        if (await this.isOptionEnabled('krwIntegratedMargin')) {
            const margin = await this.fetchOneMarketMargin();
            if (margin !== undefined && margin.krwEquivalentForeign > 0) {
                const usdKrw = await this.usdKrwRate();
                const usdEquivalent = usdKrw > 0 ? margin.krwEquivalentForeign / usdKrw : 0;
                if (usdEquivalent > 0) {
                    logger.info({ krwEquivalentForeign: margin.krwEquivalentForeign, usdKrw, usdEquivalent: Number(usdEquivalent.toFixed(2)) },
                        '[kbsec] 원마켓 — 원화환산 외화예수금을 USD 로 환산해 합산');
                    // 이 값은 별도 달러 자금이 아니라 원화 예수금의 증거금 환산치다. `sourceCurrency` 로 자금 풀을 밝혀서 호출하는 쪽이
                    // KRW 항목과 이 항목을 같은 풀로 두 번 더하지 않게 한다.
                    oneMarketUsd = { amount: usdEquivalent, sourceCurrency: 'KRW', krwEquivalent: margin.krwEquivalentForeign };
                }
            } else if (!this.oneMarketNoticeLogged) {
                // 플래그를 켰는데 USD 항목이 안 생기는 경우가 있다. 안 남기면 "켰는데 왜 그대로냐"를 로그로 확인할 방법이 없다.
                // `margin` 이 없으면 계좌가 원마켓 미신청(H049)이다. 코드로 만들 수 있는 매수여력이 아니라 사람이 할 일이다.
                this.oneMarketNoticeLogged = true;
                logger.warn({ marginSeen: margin !== undefined, krwEquivalentForeign: margin?.krwEquivalentForeign ?? null },
                    '[kbsec] 원마켓 플래그는 켜졌는데 USD 매수여력이 안 생겼다 — marginSeen=false 면 계좌가 원마켓 미신청(H049)이다. 인스턴스당 1회만 남긴다');
            }
        }

        // 1순위는 계좌자산평가(`SSQM2952`)다. 실보유수량·매입평균가·평가금액을 명시적으로 주므로 추정이 없다. 실패하면 보유주식 경로로 내려간다.
        // 잔고가 조용히 0 이 되는 것이 이 클래스에서 가장 피해가 큰 실패 모드라, 검증 안 된 경로로 통째로 갈아타지 않는다.
        let holdings = await this.fetchDomesticHoldingsFromAssetEval();
        if (holdings === undefined) holdings = await this.fetchDomesticHoldingsFromHoldingRows();
        const overseas = await this.fetchOverseasHoldings();

        return this.parseBalance({ krw, deposit, holdings: [...holdings, ...overseas.rows], overseas, oneMarketUsd });
    }

    override parseBalance(response: Dict): Balances {
        const overseas = response.overseas as OverseasHoldings;
        const result: Dict = {
            info: {
                readStatus: (overseas.read ? 'COMPLETE' : 'PARTIAL') as KbsecReadStatus,
                unreadMarkets: overseas.read ? [] : ['US'],
                deposit: response.deposit,
            },
            timestamp: undefined,
            datetime: undefined,
        };
        result['KRW'] = { free: response.krw, used: 0, total: response.krw };
        const usdCash = overseas.usdCash;
        const oneMarketUsd = response.oneMarketUsd as Dict | undefined;
        if (oneMarketUsd !== undefined) {
            result['USD'] = { free: oneMarketUsd.amount, used: 0, total: oneMarketUsd.amount, info: oneMarketUsd };
        } else if (usdCash !== undefined) {
            // 첫 그리드: `tfnd`(예수금), `ordr_psbl_amt_p2`(주문가능금액). 예수금에서 주문가능금액을 뺀 만큼을 묶인 금액으로 본다.
            const total = pickNum(usdCash, 'tfnd');
            const free = pickNum(usdCash, 'ordr_psbl_amt_p2');
            result['USD'] = { free, used: Math.max(0, total - free), total, info: usdCash };
        }
        for (const holding of response.holdings as HoldingRow[]) {
            result[holding.code] = {
                free: holding.quantity,
                used: 0,
                total: holding.quantity,
                info: {
                    quoteCurrency: holding.quoteCurrency,
                    averagePrice: holding.averagePrice,
                    marketValue: holding.marketValue,
                    name: holding.name,
                },
            };
        }
        return this.safeBalance(result);
    }

    /**
     * 국내 보유 — 계좌자산평가(`SSQM2952`). 실보유수량은 `ec_q` 다. `hld_q`(결제완료)는 판 주식을 T+2 동안 들고 있고 `ordr_psbl_q`(주문가능)는
     * 미체결 매도주문에 물리면 줄어서, 둘 다 단독으로는 보유량이 아니다. 매도 후 결제대기 종목은 `ec_q=0` 으로 와서 추정 없이 걸러진다.
     *
     * 실패하거나 국내 행을 못 찾으면 `undefined` 를 돌려주고 호출부가 보유주식(`SSQM1801`) 경로로 떨어진다.
     */
    private async fetchDomesticHoldingsFromAssetEval(): Promise<HoldingRow[] | undefined> {
        let rows: Dict[];
        try {
            // A=통합시세. KRX 만 보면 NXT 체결분 현재가가 빈다.
            rows = pickArray(await this.callTr(KBSEC_TR.ASSET_EVAL, { excg_mktpr_ccd: 'A' }));
        } catch (err) {
            logger.warn({ err }, '[kbsec] 계좌자산평가 조회 실패 — 보유주식 경로로 폴백');
            return undefined;
        }
        if (rows.length === 0) return undefined;

        const out: HoldingRow[] = [];
        let domesticRows = 0;
        for (const row of rows) {
            const code = kbsecNormalizeCode(pickStr(row, 'is_cd', 'shrt_cd', 'is_no', 'stnd_is_cd'));
            if (code === '') continue;
            // 해외는 이 경로의 범위가 아니다. `SPQM2226` 이 담당하므로 여기서 읽으면 중복 계상된다.
            if (kbsecMarketOf(code) !== 'KR') continue;
            domesticRows++;
            const quantity = pickNum(row, 'ec_q');
            if (quantity <= 0) continue; // 매도 후 결제대기 등 — 실보유 0
            out.push({
                code,
                quantity,
                quoteCurrency: 'KRW',
                averagePrice: pickPositiveNum(row, 'byng_avr_prc') || undefined,
                // 평가금액은 KB 가 준 것을 그대로 쓴다. 종목마다 현재가를 다시 묻지 않는다.
                marketValue: pickPositiveNum(row, 'val_amt') || quantity * pickPositiveNum(row, 'now_prc'),
                name: pickStr(row, 'is_nm') || undefined,
            });
        }
        if (domesticRows === 0) {
            logger.warn({ rows: rows.length, rowKeys: Object.keys(rows[0] ?? {}).slice(0, 40) },
                '[kbsec] 계좌자산평가에 국내 행이 없다 — 보유주식 경로로 폴백');
            return undefined;
        }
        return out;
    }

    /** 국내 보유 — 보유주식(`SSQM1801`) 경로. 계좌자산평가가 실패했을 때만 쓴다. */
    private async fetchDomesticHoldingsFromHoldingRows(): Promise<HoldingRow[]> {
        const holdingRows = await this.fetchHoldingRows();
        // 결제대기 매도 보정은 `gnrl_q > ordr_psbl_q` 인 행이 하나라도 있을 때만 조회한다. 그 부등호가 성립할 때에만 `max()` 가 `gnrl_q` 를
        // 채택하고, 그 값에만 아직 결제되지 않은 매도분이 섞일 수 있다.
        const needsSettlementAdjust = holdingRows.some(r => pickNum(r, 'gnrl_q') > pickNum(r, 'ordr_psbl_q'));
        const soldPending = needsSettlementAdjust ? await this.fetchPendingSoldQty() : undefined;

        const out: HoldingRow[] = [];
        for (const row of holdingRows) {
            // `A` 접두를 벗기지 않으면 해외 종목으로 오판해 원화 평가액이 달러로 읽힌다. 조회계 TR 은 종목코드를 `shrt_cd` 로 주는 전례가 있어
            // 1순위로 둔다.
            const code = kbsecNormalizeCode(pickStr(row, 'shrt_cd', 'is_cd', 'is_no', 'stnd_is_cd'));
            const quantity = this.adjustForPendingSale(code, row, soldPending);
            if (code === '' || quantity <= 0) {
                // 행이 조용히 사라지면 호출하는 쪽에서 "외부에서 팔렸다"와 구분되지 않는다(목록에 없음 = 보유 0). 버릴 때는 흔적을 남긴다.
                logger.warn({ code: code || null, keys: Object.keys(row).slice(0, 12) }, '[kbsec] 보유 행을 버렸다 — 종목코드 없음 또는 수량 0');
                continue;
            }
            const averagePrice = pickNum(row, 'pchs_avg_prc', 'avg_prc') || undefined;
            out.push({
                code,
                quantity,
                quoteCurrency: kbsecMarketOf(code) === 'KR' ? 'KRW' : 'USD',
                averagePrice,
                // 수량을 평가금액 자리에 넣으면 보유가 통째로 사라진다. 평가금액은 수량 × 현재가다.
                marketValue: await this.evaluateHolding(code, quantity, averagePrice),
                // KB 가 종목명을 직접 준다(`is_nm`). 표시하는 쪽이 마스터를 역조회할 필요가 없다.
                name: pickStr(row, 'is_nm') || undefined,
            });
        }
        this.logHoldingFieldsOnce(holdingRows[0]);
        // 행은 왔는데 전부 걸러진 경우 — 필드명 불일치가 원인일 가능성이 높다. 값이 아니라 키만 남긴다.
        if (holdingRows.length > 0 && out.length === 0) {
            logger.warn({ rows: holdingRows.length, rowKeys: Object.keys(holdingRows[0] ?? {}).slice(0, 40) },
                '[kbsec] 보유주식 행은 있으나 전부 걸러짐 — 종목코드/수량 필드명 불일치');
        }
        return out;
    }

    /**
     * 해외 보유 종목과 USD 예수금 — `SPQM2226`(잔고평가조회).
     *
     * 이 TR 은 배열이 둘이다. 통화별 예수금이 앞에 오고 종목별 보유가 뒤에 오므로 첫 배열을 집으면 보유가 0 건이 된다. 종목코드가 있는 배열을
     * 명시적으로 고른다. 수량(`frgn_hld_q_p6`)과 현재가(`now_prc_p4`)가 한 행에 있어 수량 × 현재가가 외화 평가금액이다(`krw_val_amt` 는
     * 원화 환산이라 `quoteCurrency: 'USD'` 와 단위가 어긋나서 쓰지 않는다).
     *
     * 권한이 없거나 업무 오류면 그 뒤로 부르지 않는다. 국내 잔고는 그대로 반환하므로 이 실패가 잔고 조회 전체를 실패시키지 않는다.
     */
    private async fetchOverseasHoldings(): Promise<OverseasHoldings> {
        if (this.overseasHoldingsUnavailable) return { rows: [], usdCash: undefined, read: false };
        // 일시 오류 직후에는 호출 빈도를 제한한다. 이 구간의 빈 결과는 "보유 없음"이 아니라 "안 물어봤다"이며, `read: false` 가 그 사실을 전한다.
        if (Date.now() < this.overseasHoldingsRetryAt) return { rows: [], usdCash: undefined, read: false };
        try {
            const body = await this.callTr(KBSEC_TR.HOLDINGS_US, {
                std_crncy_f: KBSEC_STD_CURRENCY_FOREIGN,
                exch_r_aplc_f: KBSEC_EXCH_RATE_MARKET,
                fee_clsf: KBSEC_FEE_EXCLUDED,
                srt_clsf: '1',
                cn_f: '',
                nxt_key: '',
            });
            const { rows, seen } = pickHoldingGrid(body);
            const usdCash = pickCashGrid(body).find(row => pickStr(row, 'crncy_clsf_nm').toUpperCase() === 'USD');
            if (rows.length === 0) {
                logger.warn({ trCode: KBSEC_TR.HOLDINGS_US, arrays: seen },
                    seen.length === 0
                        ? '[kbsec] 해외 잔고 응답에 배열이 없다 — 권한/파라미터 확인'
                        : '[kbsec] 해외 잔고에 종목 그리드가 없다 — 보유 0건이거나 필드명 불일치(arrays 로 확인)');
            }
            const out: HoldingRow[] = [];
            // 버린 이유를 세어서 남긴다. "종목코드가 비었다"와 "수량이 0 이다"는 원인도 조치도 다르다.
            let droppedNoCode = 0;
            let droppedZeroQty = 0;
            // 수량 후보 중 실제로 0 이 아니었던 필드 이름만 모은다. 알아야 하는 것은 보유 수량이 아니라 어느 필드가 보유수량인가다.
            const nonZeroQtyFields = new Set<string>();
            for (const row of rows) {
                const code = kbsecNormalizeCode(pickStr(row, 'is_cd'));
                const quantity = pickNum(row, 'frgn_hld_q_p6');
                if (code === '' || quantity <= 0) {
                    if (code !== '') droppedZeroQty++; else droppedNoCode++;
                    for (const k of OVERSEAS_QTY_CANDIDATES) {
                        if (pickNum(row, k) > 0) nonZeroQtyFields.add(k);
                    }
                    continue;
                }
                const price = pickNum(row, 'now_prc_p4');
                out.push({
                    code,
                    quantity,
                    quoteCurrency: 'USD',
                    averagePrice: pickNum(row, 'byng_avr_prc_p4') || undefined,
                    marketValue: price > 0 ? quantity * price : 0,
                    name: pickStr(row, 'is_nm') || undefined,
                });
            }
            if (rows.length > 0 && out.length === 0) {
                logger.warn({
                    rows: rows.length, droppedNoCode, droppedZeroQty, nonZeroQtyFields: [...nonZeroQtyFields], arrays: seen,
                    rowKeys: Object.keys(rows[0] ?? {}).slice(0, 40),
                }, '[kbsec] 해외 보유 행이 전부 수량 0 이거나 종목코드가 없다 — droppedNoCode/droppedZeroQty 로 갈린다');
            } else if (out.length > 0) {
                // 그리드를 실제로 봤다. 이제부터 "해외 목록에 없음"은 진짜 미보유다.
                this.overseasGridSeen = true;
                logger.info({ trCode: KBSEC_TR.HOLDINGS_US, holdings: out.length }, '[kbsec] 해외 보유 조회 완료');
            }
            // 호출이 예외 없이 끝났다. 직전의 실패 상태를 푼다(자가 치유).
            this.overseasHoldingsRetryAt = 0;
            return { rows: out, usdCash, read: this.overseasGridSeen };
        } catch (err) {
            // 영구 실패만 래치한다. 긍정형 판정이다. KB 가 영구 오류를 알리는 통로는 응답을 읽고 던지는 `ExchangeError`(권한 없음 I446 등)뿐이고,
            // 연결 타임아웃·5xx 같은 일시 오류는 냉각 뒤 다시 시도한다.
            const permanent = err instanceof ExchangeError;
            if (permanent) {
                this.overseasHoldingsUnavailable = true;
            } else {
                this.overseasHoldingsRetryAt = Date.now() + (this.options.transientRetryCooldown as number);
            }
            logger.warn({ err, trCode: KBSEC_TR.HOLDINGS_US, latched: permanent },
                permanent
                    ? '[kbsec] 해외 잔고 조회 실패(업무 오류) — 이 인스턴스에서 재시도하지 않는다(반복 실패는 계정 제한 사유)'
                    : '[kbsec] 해외 잔고 조회 실패(일시 오류) — 냉각 후 재시도한다');
            return { rows: [], usdCash: undefined, read: false };
        }
    }

    /** 보유주식 응답의 키 목록을 인스턴스당 한 번 남긴다. 값이 아니라 키만 찍는 것은 보유 종목·수량이 민감 정보이기 때문이다. */
    private logHoldingFieldsOnce(row: Dict | undefined): void {
        if (this.holdingFieldsLogged || row === undefined) return;
        this.holdingFieldsLogged = true;
        logger.info({ trCode: KBSEC_TR.HOLDINGS, rowKeys: Object.keys(row).slice(0, 40) }, '[kbsec] 보유주식 응답 필드 목록 — 평가금액 필드 확정용 프로브');
    }

    /**
     * 보유 종목의 평가금액(수량 × 현재가, `quoteCurrency` 단위). 현재가를 못 얻으면 매입평균가로 대체하고(과거 원가 기준임을 로그로 남긴다),
     * 그것도 없으면 0 이다. 수량을 금액 자리에 넣는 것은 틀린 값이라 값이 없다고 말하는 편이 낫다.
     */
    private async evaluateHolding(code: string, quantity: number, averagePrice?: number): Promise<number> {
        const price = await this.holdingPrice(code);
        if (price > 0) return quantity * price;
        if (averagePrice !== undefined && averagePrice > 0) {
            logger.debug({ code }, '[kbsec] 현재가 미확보 — 평가금액을 매입원가로 대체');
            return quantity * averagePrice;
        }
        logger.warn({ code }, '[kbsec] 평가금액 산출 불가 — 현재가·매입평균가 모두 없음');
        return 0;
    }

    /** 평가용 현재가. 잔고 조회가 사이클마다 여러 번 불려 TR 왕복이 곱해지는 것을 TTL 캐시로 막는다. */
    private async holdingPrice(code: string): Promise<number> {
        const cached = this.holdingPriceCache.get(code);
        if (cached !== undefined && Date.now() - cached.at < (this.options.holdingPriceTtl as number)) return cached.price;
        let price = 0;
        try {
            price = (await this.fetchTicker(code)).last ?? 0;
        } catch (err) {
            logger.debug({ err, code }, '[kbsec] 평가용 현재가 조회 실패');
        }
        if (price > 0) this.holdingPriceCache.set(code, { price, at: Date.now() });
        return price;
    }

    /**
     * 보유주식(`SSQM1801`) 행을 연속조회로 끝까지 읽는다. 0건이면 근거를 남긴다.
     *
     * 이 TR 이 0건인 원인은 확정하지 못했다. 후보는 `inq_clsf` 값(`1=주식` 은 체결조회 TR 기준이고 이 TR 의 뜻은 미확인)과 `mkt_tm_ccd` 다.
     * 그래서 후보 조합을 순서대로 시도하고 무엇이 통했는지 로그로 남긴다.
     *
     * 연속조회(`nxt_key`)를 끝까지 따라간다. 첫 페이지만 보면 2페이지 이후 보유가 목록에서 사라지고, 목록에서 빠진 종목은 "보유 0"이라
     * 호출하는 쪽이 외부 청산으로 읽는다.
     */
    private async fetchHoldingRows(): Promise<Dict[]> {
        const attempts = [
            { inq_clsf: KBSEC_INQ_STOCK, mkt_tm_ccd: KBSEC_SESSION_REGULAR },
            { inq_clsf: KBSEC_INQ_ALL, mkt_tm_ccd: KBSEC_SESSION_REGULAR },
        ];
        const maxPages = this.options.holdingsMaxPages as number;
        let lastRaw: Dict = {};
        for (const [i, params] of attempts.entries()) {
            const rows: Dict[] = [];
            let nextKey = '';
            for (let page = 0; page < maxPages; page++) {
                const raw = await this.callTr(KBSEC_TR.HOLDINGS, { ...params, nxt_key: nextKey });
                lastRaw = raw;
                rows.push(...pickArray(raw));
                // KB 는 마지막 페이지에서 공백 문자열을 준다. trim 해야 "끝"으로 읽힌다.
                const next = String(raw.nxt_key ?? '').trim();
                if (next === '' || next === nextKey) { nextKey = ''; break; }
                nextKey = next;
            }
            if (nextKey !== '') {
                // 상한에 걸려 중단했다. 조용히 자르면 그 종목들이 청산으로 읽힌다.
                logger.error({ pages: maxPages, rows: rows.length }, '[kbsec] 보유주식 연속조회 상한 도달 — 목록이 잘렸다(청산 오판 위험)');
            }
            if (rows.length > 0) {
                if (i > 0) {
                    logger.warn({ attempt: i, params, rows: rows.length }, '[kbsec] 보유주식 — 기본 조합은 0건, 대체 조합에서 조회됨 (조합 고정 필요)');
                }
                return rows;
            }
        }
        logger.warn({ attempts: attempts.length, topLevelKeys: Object.keys(lastRaw).slice(0, 20) },
            '[kbsec] 보유주식 0건 — 응답에 배열이 없거나 비어 있다(파라미터/필드명 확인 필요)');
        return [];
    }

    /**
     * 보유수량에서 **결제대기 매도분**을 뺀 값.
     *
     * ```
     * qty = max( ordr_psbl_q , max(gnrl_q, ordr_psbl_q) - 결제대기매도 )
     * ```
     *
     * `ordr_psbl_q`(매도가능)를 **하한**으로 두는 것이 이 식의 안전성 전부다. 브로커가 지금 팔 수 있다고 말한 수량보다 적게 보고하는 일은
     * 없다. 조회 창이 실제 결제 지연보다 넓어 이미 결제된 매도를 한 번 더 빼더라도 수량이 음수가 되지 않는다.
     *
     * | 상황 | gnrl_q | ordr_psbl_q | 결제대기매도 | 결과 |
     * |---|---|---|---|---|
     * | 미결제 매수 | 0 | 21 | 0 | 21 |
     * | 전량 매도 후 결제대기 | 5 | 0 | 5 | 0 |
     * | 일부 매도(8 중 3) | 8 | 5 | 3 | 5 |
     * | 대용담보/미체결 매도주문 | 10 | 0 | 0 | 10 |
     *
     * 마지막 행이 `max()` 를 유지해야 하는 이유다. 매도 체결이 없으면 아무것도 빼지 않는다.
     */
    private adjustForPendingSale(code: string, row: Dict, soldPending: Map<string, number> | undefined): number {
        const raw = kbsecHoldingQuantity(row);
        const sold = code !== '' ? (soldPending?.get(code) ?? 0) : 0;
        if (!(sold > 0)) return raw;
        const sellable = pickNum(row, 'ordr_psbl_q');
        const adjusted = Math.max(sellable, raw - sold);
        if (adjusted !== raw) {
            logger.warn({
                code, name: pickStr(row, 'is_nm') || null, gnrlQ: pickNum(row, 'gnrl_q'), ordrPsblQ: sellable,
                pendingSold: sold, before: raw, after: adjusted,
            }, '[kbsec] 결제대기 매도분 차감 — 보유수량 보정(T+2)');
        }
        return adjusted;
    }

    /**
     * **결제대기 매도 수량**(종목코드별 합계). 보유수량에서 빼기 위한 제3의 축이다.
     *
     * 보유주식 TR 의 두 필드로는 뜻이 다른 두 상태가 같은 모양으로 온다. `gnrl_q>0 · ordr_psbl_q=0` 은 (1) 대용담보·미체결 매도주문이면
     * 보유가 있고 (2) 매도 체결 뒤 결제대기면 보유가 0 이다. 구분할 축이 이 TR 안에 없어 체결내역(`SSQM2341`)에서 가져온다.
     *
     * 조회 실패는 `undefined` 다. 호출부가 보정을 포기하고 종전 값을 쓴다. 과다보고(판 것을 있다고 함)는 표시 오류로 끝나지만 과소보고
     * (있는 것을 없다고 함)는 외부 청산 오판과 재매수라는 실손실을 낸다. 실패는 언제나 안전한 쪽으로 처리한다.
     */
    private async fetchPendingSoldQty(): Promise<Map<string, number> | undefined> {
        try {
            const out = new Map<string, number>();
            for (let steps = 0; steps < (this.options.settlementLookbackDays as number); steps++) {
                const ordrDt = kbsecBusinessDateKst(steps);
                let body: Dict;
                try {
                    body = await this.callTr(KBSEC_TR.TRADES_KR, {
                        inq_clsf: KBSEC_INQ_STOCK, // 주식
                        ccls_clsf: KBSEC_CCLS_FILLED, // 체결만. 비우면 거부된다(8654)
                        ordr_dt: ordrDt,
                        cn_clsf: KBSEC_CONT_FIRST,
                        nxt_key: '',
                    });
                } catch (err) {
                    // `kbsecBusinessDateKst` 는 주말만 되감고 공휴일은 모르므로 연휴에는 조회일자가 KB 영업일보다 앞서 거부된다. 그 날짜 하나만
                    // 건너뛰고 나머지 영업일은 계속 본다. 통째로 포기하면 공휴일마다 보정이 조용히 꺼진다.
                    if (err instanceof ExchangeError && err.detail === KBSEC_ERROR_DETAIL.FUTURE_QUERY_DATE) {
                        logger.debug({ ordrDt }, '[kbsec] 결제대기 매도 조회 — 휴장일 건너뜀');
                        continue;
                    }
                    throw err;
                }
                const rows = pickArray(body);
                const parsed = rows.map(parseKbsecDomesticFillRow);
                // 한 행 = 한 체결이라 그대로 더한다. 분할체결 연속 행은 식별자가 비어 오므로 먼저 헤더 행에 귀속시킨다.
                warnIfFillTotalsInconsistent(parsed, rows, '결제대기 매도 조회');
                const fills = kbsecResolveFills(parsed);
                for (const fill of fills) {
                    // 귀속에 실패한 행(헤더 없이 온 연속 행)은 남의 주문에 붙이느니 빼지 않는다.
                    if (fill.orderId === '') continue;
                    // 방향이 확실히 매도인 것만 뺀다. 빼는 쪽으로 틀리면 과소보고다.
                    if (fill.side !== 'sell') continue;
                    if (fill.symbol === '' || !(fill.qty > 0)) continue;
                    out.set(fill.symbol, (out.get(fill.symbol) ?? 0) + fill.qty);
                }
                // 방향 판독 여부는 귀속 뒤로 센다. 연속 행은 원래 방향이 비어 오므로 원본 행으로 세면 정상 응답에도 경고가 뜬다.
                warnIfFillSideUnreadable(rows, fills.filter(f => f.side !== null).length, '결제대기 매도 조회');
            }
            return out;
        } catch (err) {
            logger.warn({ err }, '[kbsec] 결제대기 매도 조회 실패 — 보유수량 보정 생략(종전값 사용)');
            return undefined;
        }
    }

    /** 1달러당 원화. `options.usdKrwRate` 가 없으면 환율을 알 수 없어 던진다. 조회가 실패해도 던진다. */
    private usdKrwRate(): Promise<number> {
        const source = this.options.usdKrwRate as UsdKrwRateOption | undefined;
        if (source === undefined) return Promise.reject(new ArgumentsRequired(`${this.id} 원마켓 환산에는 options.usdKrwRate 가 필요하다`));
        return source();
    }

    /**
     * 원마켓 계좌증거금 — 원화·원화환산 외화 예수금과 주문증거금 현황. 통합증거금 계좌의 실제 여력을 보려면 예수금 TR 만으로는 부족하다.
     *
     * 이 조회는 잔고 조회를 돕는 보조 조회라 **실패해도 던지지 않고 `undefined` 를 돌려준다.** 영구 실패(미신청 계좌 등)는 이 인스턴스에서 다시
     * 부르지 않는다. 잔고 조회가 종목마다 불릴 수 있어 래치가 없으면 실패가 종목 수만큼 곱해지고, 미신청 계좌는 다시 물어도 답이 같다.
     */
    async fetchOneMarketMargin(): Promise<KbsecOneMarketMargin | undefined> {
        if (this.oneMarketUnavailable) return undefined;
        try {
            const body = await this.callTr(KBSEC_TR.ONEMARKET_MARGIN, {});
            return {
                krwDeposit: pickNum(body, 'krw_tfnd'),
                krwEquivalentForeign: pickNum(body, 'krw_exch_fcrncy_tfnd'),
                orderMarginSum: pickNum(body, 'ordr_mgn_sum'),
                totalDeposit: pickNum(body, 'tfnd_tl_amt'),
                withdrawable: pickNum(body, 'do_psbl_amt'),
            };
        } catch (err) {
            // 시간 초과는 래치하지 않는다. 일시적 무응답이다.
            if (!(err instanceof RequestTimeout)) this.oneMarketUnavailable = true;
            logger.warn({ err, latched: !(err instanceof RequestTimeout) },
                '[kbsec] 원마켓 증거금 조회 실패 — 영구 실패면 이 인스턴스에서 재시도하지 않는다(반복 실패는 계정 제한 사유)');
            return undefined;
        }
    }

    /**
     * 국내 매수주문가능금액(원). 예수금만 보면 미수·증거금 규칙이 빠져 주문가능액을 과대평가하므로 KB 가 계산한 값을 그대로 쓴다.
     * 값이 없거나 0 이하면 `undefined` 다.
     */
    async fetchBuyableAmount(symbol: Str = undefined, _params: Dict = {}): Promise<number | undefined> {
        const body = await this.callTr(KBSEC_TR.BUYABLE_KR, {
            is_no: symbol !== undefined ? kbsecBaseSymbol(symbol) : '',
            bnd_mktio_ccd: '1',
        });
        const amount = pickNum(body, 'ordr_psbl_csh');
        return amount > 0 ? amount : undefined;
    }

    /**
     * 해외 매수여력 — **원마켓(통합증거금)** 지원.
     *
     * KB 원마켓플러스는 원화로 미국 주식을 산다(USD 사전 환전 불필요). 그래서 매수여력이 두 갈래로 온다.
     * `fcrncy_ordr_psbl_amt`(외화 주문가능금액)와 `krw_exch_unty_ordr_psbl_amt`(원화환산 통합 주문가능금액)다.
     * 플래그가 켜져 있으면 통합 기준을 쓰고, 꺼져 있으면 순수 외화만 본다. `fcrncy_unty_ordr_psbl_amt_p2` 의 `unty` 는 **통합**이라
     * 원화를 환산해 더한 값이므로 플래그를 꺼도 통합 금액이 USD 로 둔갑하지 않게 이 값은 순수 외화로 쓰지 않는다.
     *
     * `quoteCurrency` 로 어느 통화 기준인지 함께 돌려준다. 통화를 모른 채 숫자만 받으면 원화 금액을 달러로 오해해 수량이 ~1,400배가 된다.
     * 여력이 없으면 `undefined` 다.
     */
    async fetchOverseasBuyableAmount(symbol: string, price?: number): Promise<KbsecOverseasBuyable | undefined> {
        const body = await this.callTr(KBSEC_TR.ONEMARKET_BUYABLE, {
            crncy_cd: '',
            iso_cd: '',
            stnd_is_cd: kbsecBaseSymbol(symbol),
            frgn_ordr_prc_p4: price !== undefined ? kbsecNum(price, 4) : '',
            ordr_prc: price !== undefined ? kbsecNum(price, 4) : '',
        });
        const useKrw = await this.isOptionEnabled('krwIntegratedMargin');
        const krw = pickNum(body, 'krw_exch_unty_ordr_psbl_amt', 'krw_exch_fcrncy_ordr_psbl_amt');
        const usdCash = pickNum(body, 'fcrncy_ordr_psbl_amt');
        const usdUnified = pickNum(body, 'fcrncy_unty_ordr_psbl_amt_p2');
        const amount = useKrw ? (krw > 0 ? krw : usdUnified) : usdCash;
        if (amount <= 0) return undefined;
        return {
            amount,
            quoteCurrency: useKrw && krw > 0 ? 'KRW' : 'USD',
            maxQuantity: pickNum(body, 'ordr_psbl_q', 'ordr_psbl_q1', 'ordr_psbl_q2'),
        };
    }

    // ============ 주문 ============

    /**
     * 해외 시장가 매수를 대체하는 **체결 가능 지정가**. 매도호가(없으면 현재가)에 버퍼를 더해 센트 단위로 올린다.
     * 미국 주식 호가단위는 $1 이상 구간에서 $0.01 이라 4자리로 보내면 단위 위반이고, 올림이라 항상 호가 이상이 보장된다(내림하면 크로스가 안 돼
     * 미체결로 남는다). 호가를 못 구하면 던진다. 가격 없는 주문은 거부되고 KB 는 잘못된 호출 반복을 계정 제한 사유로 명시하므로 보내지 않는다.
     */
    async fetchMarketableBuyPrice(symbol: string): Promise<number> {
        const ticker = await this.fetchTicker(symbol).catch((err: unknown) => {
            logger.warn({ err, symbol }, '[kbsec] 해외 시장가 매수 대체용 호가 조회 실패');
            return undefined;
        });
        const reference = ticker?.ask || ticker?.last;
        if (reference === undefined || !Number.isFinite(reference) || reference <= 0) {
            throw new ExchangeError('KB 해외 시장가 매수는 지정가 대체가 필요한데 호가를 조회하지 못했습니다');
        }
        const price = Math.ceil(reference * (1 + (this.options.marketableLimitBuffer as number)) * 100) / 100;
        logger.info({ symbol, ask: ticker?.ask, last: ticker?.last, limitPrice: price }, '[kbsec] 해외 시장가 매수 → 체결 가능 지정가 대체');
        return price;
    }

    /**
     * 주문을 낸다. `type` 은 `limit`·`market`, `side` 는 `buy`·`sell` 이다.
     *
     * - **장 시간 밖이면 요청을 보내지 않고 `MarketClosed` 를 던진다.** 예정된 조건이라 실패로 기록하지 않아야 한다.
     * - 국내는 주 단위다. 수량은 **내림**하고(`8.87` 은 `8`), 1주 미만이면 `InvalidOrder` 다.
     * - KB 해외는 **시장가 매수를 받지 않는다.** 매도호가에 버퍼를 더한 지정가(체결 가능 지정가)로 바꿔 보낸다.
     *   지정가가 호가보다 높으면 체결은 호가에서 일어나므로 버퍼는 상한일 뿐 비용이 아니다. 호가를 못 구하면 보내지 않는다.
     * - 접수 뒤에는 체결 조회로 체결가·수량을 확정한다. 확정하지 못하면 `order.info.fillConfirmed` 가 `false` 이고 `filled` 는 비어 있다.
     * - `params.fractional` 이 참이면 국내 소수점 주문이다(수량을 소수 6자리로 보내고 체결 확정을 하지 않는다).
     * - `params.sor` 는 국내 라우팅(`K` KRX · `N` NXT · `S` SOR)이다. 생략하면 넥스트레이드 라우팅 기능 플래그를 따른다.
     * - **조건(스톱) 주문은 받지 않는다.** `params` 에 `triggerPrice`·`stopPrice`·`stopLossPrice`·`takeProfitPrice` 가 있으면 요청 없이 `NotSupported` 다.
     *   버리고 일반 주문으로 내면 조건 주문을 의도한 호출이 곧바로 체결된다.
     *
     * 시간 초과나 연결 끊김은 `OrderOutcomeUnknown` 이다. 다시 보내지 말고 `fetchMyTrades` 로 접수 여부를 확인한다.
     */
    override async createOrder(
        symbol: string, type: OrderType, side: OrderSide, amount: number, price: Num = undefined, params: Dict = {},
    ): Promise<Order> {
        const market = this.market(symbol);
        // 조건 주문 인자는 어떤 요청보다 먼저 거른다(세션 게이트의 휴장일 조회도 요청이다).
        for (const key of UNSUPPORTED_CONDITIONAL_PARAMS) {
            if (this.safeValue(params, key) !== undefined) {
                throw new NotSupported(`${this.id} createOrder() does not support ${key} (conditional orders): 조건 주문은 지원하지 않는다`);
            }
        }
        this.checkOrderArguments(market, type, side, amount, price, params);
        const isKr = !this.isUs(market);
        const base = market.id as string;
        const fractional = params.fractional === true;
        const sorOverride = safeString(params, 'sor');
        const extra = omit(params, ['fractional', 'sor', 'timeInForce', 'postOnly', 'reduceOnly', 'clientOrderId', 'cost']);

        // 세션 게이트. 장 마감 뒤에 사이클이 돌 때마다 주문이 실제로 KB 로 나가고, 거부된 뒤에야 실패로 기록되는 것을 막는다.
        // KRX 판정은 시장이 아는 사실이라 이 클래스가 자기 시간표를 갖지 않고 공용 술어에 맡긴다.
        if (isKr) await this.refreshMarketCalendar();
        const closed = marketSessionBlockReason('kbsec', symbol, undefined, masterDataOf(this.options));
        if (closed !== null) {
            logger.info({ symbol, side, reason: closed }, '[kbsec] 거래시간 외 주문 차단');
            throw new MarketClosed(closed);
        }

        if (fractional) return this.createFractionalOrder(market, side as 'buy' | 'sell', amount);

        let effectivePrice: Num = price;
        let isMarket = type === 'market';
        // 해외 시장가 매수는 KB 가 받지 않는다(`시장가주문은 매도만 가능합니다`, G474). 매도는 시장가가 되므로 청산 경로는 영향이 없다.
        // 패시브 지정가(최우선 매수호가)로 걸지 않는다. 미체결로 남으면 매수 시점이 지나가 "주문은 나갔는데 안 산" 상태가 된다.
        if (!isKr && side === 'buy' && isMarket) {
            effectivePrice = await this.fetchMarketableBuyPrice(symbol);
            isMarket = false;
        }
        const isLimit = !isMarket;

        // 브로커에 실제로 나가는 수량은 내림값이다. 이 값이 본문·체결조회·반환값의 정본이다.
        const submittedQty = Math.floor(amount);

        // 국내 주식은 주 단위다. 1주 미만이면 수량이 0 으로 나가 거부된다(`주문수량을 확인하십시오`, 2329). 거부될 주문은 보내지 않는다.
        if (isKr && amount < 1) {
            throw new InvalidOrder(`국내 주식 1주 미만 주문 불가 (수량 ${amount})`, { detail: KBSEC_ERROR_DETAIL.QUANTITY_INVALID });
        }

        let response: Dict;
        if (isKr) {
            const trCode = side === 'buy' ? KBSEC_TR.BUY_KR : KBSEC_TR.SELL_KR;
            const send = (sor: string): Promise<Dict> => this.callTr(trCode, buildKrOrderBody({
                base,
                amount: submittedQty,
                price: effectivePrice,
                isLimit,
                jbClsf: side === 'buy' ? KBSEC_ORDER_SIDE_KR.BUY : KBSEC_ORDER_SIDE_KR.SELL,
                sor,
            }, extra));
            // 넥스트레이드 라우팅 플래그가 켜져 있으면 SOR 에 맡긴다(KRX/NXT 중 유리한 쪽). 꺼져 있으면 KRX 고정이다.
            // 단 NXT 미상장 종목이 이미 확인됐으면 왕복을 건너뛴다.
            const wantSor = sorOverride === undefined && await this.isOptionEnabled('nxtRouting') && !this.nxtIneligible.has(base);
            try {
                response = await send(sorOverride ?? (wantSor ? KBSEC_SOR.SOR : KBSEC_SOR.KRX));
            } catch (err) {
                // NXT 미상장 종목(우선주 등)은 SOR 로 나가면 통째로 거부된다. 브로커가 사유와 조치를 그대로 알려 준다(`KRX로 주문해주세요`).
                // 업무 거부라 주문은 접수되지 않았고, 재전송이 중복 주문이 되지 않는다.
                if (!wantSor || !(err instanceof ExchangeError) || err.detail !== KBSEC_ERROR_DETAIL.NXT_INELIGIBLE) throw err;
                // 한 번 확인한 종목은 인스턴스 수명 동안 기억해 매 사이클 거부를 한 번씩 더 받지 않게 한다.
                this.nxtIneligible.add(base);
                logger.warn({ symbol, side, submittedQty }, '[kbsec] NXT 미상장 — KRX 로 재주문 (이후 이 종목은 KRX 직행)');
                response = await send(KBSEC_SOR.KRX);
            }
        } else {
            response = await this.callTr(KBSEC_TR.ORDER_US, {
                trd_dl_ccd: side === 'buy' ? KBSEC_ORDER_SIDE_US.BUY : KBSEC_ORDER_SIDE_US.SELL,
                is_cd: base,
                frgn_ordr_typ_cd: isLimit ? KBSEC_ORDER_TYPE_US.LIMIT : KBSEC_ORDER_TYPE_US.MARKET,
                // 국내와 같은 이유로 내림이다. `kbsecNum` 은 반올림이라 배정 자본을 초과 매수한다.
                frgn_ordr_q: kbsecNum(submittedQty),
                frgn_ordr_prc_p4: isLimit ? kbsecNum(effectivePrice ?? 0, 4) : '0',
                ...extra,
            });
        }
        const orderId = pickStr(response, 'ordr_no', 'odno');
        logger.info({ symbol, side, amount, submittedQty, orderId }, `[kbsec] ✅ ${isKr ? '국내' : '해외'} 주문 접수`);
        return this.confirmedOrder(orderId, market, side as 'buy' | 'sell', isLimit ? 'limit' : 'market', submittedQty, effectivePrice, response);
    }

    /**
     * 접수된 주문의 실체결을 확정해 `Order` 로 만든다.
     *
     * 접수 응답에는 체결 정보가 없다. 체결가를 호출하는 쪽이 현재가로 짐작하면 진입가가 틀리므로 계좌 체결내역에서 주문번호로 찾아 확정한다.
     * 확정하지 못하면 `filled`·`average` 를 **비워 둔다**(주문 자체는 접수 성공이다). 값을 지어내지 않고 `info.fillConfirmed: false` 로 알린다.
     */
    private async confirmedOrder(
        orderId: string, market: MarketInterface, side: 'buy' | 'sell', type: string, quantity: number, price: Num, response: Dict,
    ): Promise<Order> {
        const isKr = !this.isUs(market);
        const feeCurrency = isKr ? 'KRW' : 'USD';
        const draft: Dict = {
            id: orderId === NO_ORDER_ID ? undefined : orderId,
            timestamp: this.milliseconds(),
            symbol: market.symbol,
            type,
            side,
            price,
            amount: quantity,
            status: 'open',
            trades: [],
        };
        const unconfirmed = (): Order => this.safeOrder({ ...draft, info: { ...response, fillConfirmed: false } }, market);
        if (orderId === NO_ORDER_ID) return unconfirmed();

        const matched = await confirmExecution({
            label: '[kbsec]',
            orderId,
            exchange: 'kbsec',
            // 국내만 드물고 긴 예산을 쓴다. 해외는 공용 기본값이다. `options.confirmBudget` 이 있으면 둘 다 이긴다.
            budget: this.getConfirmBudget(isKr ? (this.options.domesticConfirmBudget as { attempts: number; intervalMs: number }) : undefined),
            probe: tradeListProbe({
                fetchTrades: () => this.fetchMyTrades(market.symbol),
                orderId,
                requestedQty: quantity,
                feeCurrency,
            }),
        });
        if (matched === null) return unconfirmed();

        // 체결수량은 주문수량을 넘을 수 없다. 물리적으로 불가능한 값은 받지 않는다. 넘는다면 체결 행 해석이 틀린 것이다(같은 체결을 두 번 셌거나
        // 연속 행을 엉뚱한 주문에 귀속시킨 경우). 상한이 없으면 실제보다 많은 수량으로 포지션이 열린다.
        const filled = Math.min(matched.filled, quantity);
        const clamped = filled !== matched.filled;
        if (clamped) {
            logger.warn({ orderId, symbol: market.symbol, reported: matched.filled, requested: quantity },
                '[kbsec] 체결수량이 주문수량을 초과해 상한으로 자름 — 체결 행 해석 대조 필요');
        }
        // 자른 경우 체결금액도 같이 자른다. 수량과 금액이 어긋나면 평단이 틀어진다.
        const cost = clamped ? filled * (matched.average ?? 0) : (matched.amount ?? matched.filled * (matched.average ?? 0));
        logger.info({
            orderId, symbol: market.symbol, side, requestedPrice: price, actualPrice: matched.average, actualQty: filled,
            deviationBps: fillDeviationBps(price, matched.average),
        }, '[kbsec] 📊 실체결 확정');
        return this.safeOrder({
            ...draft,
            status: filled >= quantity ? 'closed' : 'open',
            filled,
            remaining: Math.max(0, quantity - filled),
            average: matched.average ?? price,
            cost,
            fee: matched.fee !== undefined ? { cost: matched.fee, currency: matched.feeCurrency ?? feeCurrency } : undefined,
            info: { ...response, fillConfirmed: true },
        }, market);
    }

    /**
     * 국내 소수점 주문. 수량이 정수가 아니어도 된다. 체결 확정은 하지 않는다. 해외는 지원하지 않는다.
     * 필드 이름은 `ordr_q_p6` 다(`_p6` 접미사가 소수 6자리를 뜻한다). 정수 주문의 `ordr_q` 로 보내면 수량 없는 주문이 나간다.
     */
    private async createFractionalOrder(market: MarketInterface, side: 'buy' | 'sell', amount: number): Promise<Order> {
        if (this.isUs(market)) throw new NotSupported(`${this.id} 해외 소수점은 미배선이다`);
        const response = await this.callTr(side === 'buy' ? KBSEC_TR.FRAC_BUY_KR : KBSEC_TR.FRAC_SELL_KR, {
            is_cd: market.id,
            ordr_q_p6: kbsecNum(amount, 6),
        });
        const orderId = pickStr(response, 'ordr_no', 'odno');
        logger.info({ symbol: market.symbol, side, amount, orderId }, '[kbsec] ✅ 소수점 주문');
        return this.safeOrder({
            id: orderId === NO_ORDER_ID ? undefined : orderId,
            timestamp: this.milliseconds(),
            symbol: market.symbol,
            type: 'market',
            side,
            amount,
            status: 'open',
            trades: [],
            info: { ...response, fillConfirmed: false, fractional: true },
        }, market);
    }

    /**
     * 정정주문. 취소 후 재접수보다 체결 순위를 덜 잃는다(원주문 시각 일부 승계).
     *
     * - **정정하면 주문번호가 바뀐다.** 이후 취소는 반드시 새 번호(`order.id`)로 해야 한다. 옛 번호로 취소하면 주문이 살아남는다.
     * - 국내는 원주문과 **같은 라우팅**으로 보내야 한다(SOR 주문을 KRX 로 정정하면 거부된다).
     * - 국내 전부정정(`params.partial` 이 아님)은 수량을 0 으로 보낸다. 수량을 실으면 거부된다. 수량을 바꾸려면 `params.partial: true` 와 `amount` 다.
     * - 해외 정정은 가격만 바꾼다(`SKAM2102` 에 수량 필드가 없다). 수량을 바꾸려면 취소 후 재접수해야 한다.
     * - **`price` 가 필요하다.** 국내·해외 모두 정정은 단가를 바꾸는 주문이라, 빼면 요청 없이 `ArgumentsRequired` 다(빼고 보내면 단가 `0` 이 나간다).
     */
    override async editOrder(
        id: string, symbol: string, _type: OrderType, _side: OrderSide, amount: Num = undefined, price: Num = undefined, params: Dict = {},
    ): Promise<Order> {
        const market = this.market(symbol);
        const base = market.id as string;
        // 정정은 단가를 바꾸는 주문이다. 가격을 빼면 단가 '0' 이 나가므로 원주문 라우팅 조회를 포함해 어떤 요청보다 먼저 막는다.
        if (price === undefined || price === null) {
            throw new ArgumentsRequired(`${this.id} editOrder() requires a price argument`);
        }
        if (this.isUs(market)) {
            const response = await this.callTr(KBSEC_TR.AMEND_CANCEL_US, {
                is_cd: base,
                orgn_ordr_no: id,
                // 해외 TR(SKAM2102)의 구분 필드는 `crct_cncl_clsf` 다(국내의 `crct_clsf` 가 아니다). 스펙 밖 키는 구분이 빈 값으로 나간다.
                crct_cncl_clsf: '1',
                frgn_ordr_prc_p4: kbsecNum(price, 4),
            });
            if (amount !== undefined) {
                logger.warn({ orderId: id, symbol, amount }, '[kbsec] 해외 정정은 가격만 가능 — 수량 변경은 취소 후 재접수 필요');
            }
            return this.editedOrder(response, market, price, undefined);
        }
        const sor = await this.resolveOrderSor(id, symbol);
        const isPartial = params.partial === true && amount !== undefined;
        const response = await this.callTr(KBSEC_TR.AMEND_KR, buildKrOrderBody(
            { base, amount: isPartial ? amount : 0, price, sor, jbClsf: KBSEC_ORDER_SIDE_KR.AMEND },
            { crct_clsf: isPartial ? '1' : '2', orgn_ordr_no: id },
        ));
        const newId = pickStr(response, 'ordr_no', 'odno');
        logger.info({ orderId: id, newOrderId: newId, symbol, price, sor, isPartial }, '[kbsec] ✅ 정정주문 — 주문번호가 바뀌었다');
        return this.editedOrder(response, market, price, amount);
    }

    private editedOrder(response: Dict, market: MarketInterface, price: Num, amount: Num): Order {
        const id = pickStr(response, 'ordr_no', 'odno');
        return this.safeOrder({
            id: id === NO_ORDER_ID ? undefined : id,
            timestamp: this.milliseconds(),
            symbol: market.symbol,
            type: 'limit',
            price,
            amount,
            status: 'open',
            trades: [],
            info: response,
        }, market);
    }

    /**
     * 원주문이 어느 라우팅으로 나갔는지. 정정에 그대로 실어야 한다. 미체결 목록의 원본 행에 `sor_ordr_ccd` 가 있어 그것을 정본으로 본다.
     * 못 찾으면(이미 체결·조회 실패) 발주 때와 같은 정책으로 되짚는다. 같은 인스턴스 안에서는 플래그와 NXT 캐시가 그대로라 같은 값이 나온다.
     */
    private async resolveOrderSor(orderId: string, symbol: string): Promise<string> {
        try {
            const found = (await this.fetchOpenOrders(symbol)).find(order => order.id === orderId);
            const sor = pickStr((found?.info ?? {}) as Dict, 'sor_ordr_ccd');
            if (sor !== '') return sor;
        } catch (err) {
            logger.warn({ err, orderId, symbol }, '[kbsec] 원주문 라우팅 조회 실패 — 발주 정책으로 폴백');
        }
        return await this.isOptionEnabled('nxtRouting') && !this.nxtIneligible.has(kbsecBaseSymbol(symbol))
            ? KBSEC_SOR.SOR : KBSEC_SOR.KRX;
    }

    /**
     * 주문 취소(전부 취소). `symbol` 이 필요하다. 이미 체결되거나 취소된 주문은 KB 가 거부하므로 그 오류를 그대로 던진다. 호출하는 쪽이
     * 그것을 "이미 사라진 주문"으로 볼지 실패로 볼지 정한다.
     */
    override async cancelOrder(id: string, symbol: Str = undefined, _params: Dict = {}): Promise<Order> {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} cancelOrder() requires a symbol argument`);
        const market = this.market(symbol);
        let response: Dict;
        if (!this.isUs(market)) {
            response = await this.callTr(KBSEC_TR.CANCEL_KR, buildKrOrderBody(
                { base: market.id as string, jbClsf: KBSEC_ORDER_SIDE_KR.CANCEL },
                { crct_clsf: '2', orgn_ordr_no: id }, // 2=전부취소
            ));
        } else {
            response = await this.callTr(KBSEC_TR.AMEND_CANCEL_US, {
                is_cd: market.id,
                orgn_ordr_no: id,
                crct_cncl_clsf: '2',
            });
        }
        logger.info({ orderId: id, symbol }, '[kbsec] ✅ 주문 취소');
        return this.safeOrder({ id, symbol: market.symbol, status: 'canceled', trades: [], info: response }, market);
    }

    /**
     * 미체결 주문을 모두 취소한다(심볼을 주면 그 종목만). 취소를 시도한 주문마다 항목을 돌려준다. 취소된 항목은 `status: 'canceled'`,
     * 실패한 항목은 `status: 'open'` 이고 `info.cancelError` 에 사유가 있다.
     */
    override async cancelAllOrders(symbol: Str = undefined, params: Dict = {}): Promise<Order[]> {
        const open = await this.fetchOpenOrders(symbol, undefined, undefined, params);
        const results: Order[] = [];
        for (const order of open) {
            try {
                results.push(await this.cancelOrder(order.id as string, order.symbol));
            } catch (err) {
                logger.warn({ err, orderId: order.id }, '[kbsec] 주문 취소 실패');
                results.push({ ...order, info: { ...order.info, cancelError: err instanceof Error ? err.message : String(err) } });
            }
        }
        return results;
    }

    // ============ 주문·체결 조회 ============

    /**
     * 조회일자를 **KB 영업일**로 맞춰 호출한다. 주말·휴장일에는 조회 전체가 거부된다(`주문일자가 현재일자보다 큽니다`, 2854).
     * KB 의 현재일자는 영업일이라 주말·휴장일엔 직전 영업일에 머문다.
     *
     * 주말은 `kbsecBusinessDateKst` 가 되감으므로 여기까지 오지 않는다. 남는 것은 공휴일인데, 달력을 새로 들고 오는 대신 2854 를 만나면 한 칸씩 더
     * 되감아 재시도한다. 성공한 칸이 처음 칸이 아니면 이 코드가 모르는 휴장일이라는 뜻이므로 WARN 으로 남긴다. 되감은 칸 수는 그날 하루 캐시한다.
     * 2854 가 아닌 오류는 그대로 던진다. 날짜와 무관한 실패를 날짜 탓으로 삼키지 않는다.
     */
    private async callOnBusinessDate<T>(call: (ordrDt: string) => Promise<T>): Promise<T> {
        const today = kbsecTodayKst();
        if (this.businessDateBackoff.day !== today) this.businessDateBackoff = { day: today, steps: 0 };
        const startSteps = this.businessDateBackoff.steps;
        let lastErr: unknown;
        for (let steps = startSteps; steps <= (this.options.businessDateMaxBackoff as number); steps++) {
            const ordrDt = kbsecBusinessDateKst(steps);
            try {
                const result = await call(ordrDt);
                // 캐시가 적중한 경우는 조용히 지나간다. 새로 되감았을 때만 남기지 않으면 연휴 내내 사이클마다 같은 WARN 이 쌓인다.
                if (steps !== startSteps) {
                    logger.warn({ ordrDt, steps }, '[kbsec] 조회일자를 영업일보다 더 되감아 성공 — 미등록 휴장일로 보임');
                    this.businessDateBackoff = { day: today, steps };
                }
                return result;
            } catch (err) {
                if (!(err instanceof ExchangeError) || err.detail !== KBSEC_ERROR_DETAIL.FUTURE_QUERY_DATE) throw err;
                lastErr = err;
            }
        }
        throw lastErr;
    }

    /**
     * 국내 미체결 주문. 계좌별주문체결조회(`SSQM2341`)에서 체결구분 `미체결`로 뽑는다. 이 TR 은 미체결이 0건이면 플래그 `B` 와 1861 로 주는데,
     * 그것은 빈 결과로 흡수한다. 해외 미체결은 지원하지 않는다.
     *
     * **`since` 는 적용하지 않는다.** 미체결 행에는 주문 시각의 날짜가 없어 `Order.timestamp` 를 채울 수 없고, 기본 필터는 timestamp 가 없는 항목을
     * 전부 버려서 `since` 를 주면 미체결이 있는데도 빈 목록이 나왔다. 미체결은 빠지면 위험한 목록이라 시각을 모르는 항목을 거르지 않고 전부 돌려준다.
     * `symbol` 과 `limit` 은 그대로 적용한다.
     */
    override async fetchOpenOrders(symbol: Str = undefined, _since: Int = undefined, limit: Int = undefined, _params: Dict = {}): Promise<Order[]> {
        const market = symbol !== undefined ? this.market(symbol) : undefined;
        if (market !== undefined && this.isUs(market)) throw new NotSupported(`${this.id} fetchOpenOrders() 는 국내 종목만 지원한다`);
        const body = await this.callOnBusinessDate(ordr_dt => this.callTr(KBSEC_TR.TRADES_KR, {
            inq_clsf: KBSEC_INQ_STOCK, // 주식
            ccls_clsf: KBSEC_CCLS_PENDING, // 미체결만
            ordr_dt,
            cn_clsf: KBSEC_CONT_FIRST,
            nxt_key: '',
        }));
        return this.parseOrders(pickArray(body), market, undefined, limit);
    }

    override parseOrder(order: Dict, market: MarketInterface | undefined = undefined): Order {
        // 필드 이름은 `parseKbsecDomesticFillRow` 가 정본이다. 미체결 조회도 같은 TR(`SSQM2341`)의 행이다.
        const fill = parseKbsecDomesticFillRow(order);
        const quantity = fill.orderQty;
        const filled = fill.filledQty;
        // `A005930` 을 그대로 두면 심볼 필터가 맞지 않고 취소가 해외 TR 로 잘못 넘어간다. 종목코드를 정규화해 심볼로 옮긴다.
        const symbol = fill.symbol !== '' ? this.market(fill.symbol).symbol : market?.symbol;
        return this.safeOrder({
            info: order,
            id: fill.orderId === '' ? undefined : fill.orderId,
            symbol,
            type: pickStr(order, 'ordr_ccd') === KBSEC_ORDER_TYPE_KR.MARKET ? 'market' : 'limit',
            side: fill.side ?? undefined,
            status: filled >= quantity && quantity > 0 ? 'closed' : 'open',
            price: pickNum(order, 'ordr_uprc'),
            amount: quantity,
            filled,
            // 스펙은 미체결수량(`nccls_q`)을 직접 준다. 있으면 그 값이고 없으면 역산한다.
            remaining: fill.unfilledQty > 0 ? fill.unfilledQty : Math.max(0, quantity - filled),
            cost: fill.cost,
            trades: [],
        }, market);
    }

    /**
     * 주문 한 건을 조회한다. 체결내역과 미체결 목록에서 그 주문을 찾는다. 국내는 미체결 목록에 있으면 `open`(체결분이 있으면 반영), 체결내역에만
     * 있으면 `closed` 다. 어디에도 없으면 `OrderNotFound` 다.
     *
     * `params.date`(`YYYYMMDD`, 한국 날짜)를 주면 그날을 조회하고 실패를 던진다. 생략하면 가장 최근 영업일이다. 주문이 며칠 전 것이면 그 날짜를 줘야 한다.
     */
    override async fetchOrder(id: string, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} fetchOrder() requires a symbol argument`);
        const market = this.market(symbol);
        const trades = (await this.fetchMyTrades(symbol, undefined, undefined, params)).filter(trade => trade.order === id);
        const open = this.isUs(market)
            ? undefined
            : (await this.fetchOpenOrders(symbol)).find(order => order.id === id);
        if (open === undefined && trades.length === 0) {
            throw new OrderNotFound(`${this.id} fetchOrder() ${symbol} 주문 ${id} 을 체결내역과 미체결 목록에서 찾지 못했다`);
        }
        const filled = trades.reduce((sum, trade) => sum + (trade.amount ?? 0), 0);
        const cost = trades.reduce((sum, trade) => sum + (trade.cost ?? 0), 0);
        if (open === undefined) {
            return this.safeOrder({
                id, symbol: market.symbol, status: 'closed', side: trades[0].side, filled, cost,
                average: filled > 0 ? cost / filled : undefined, trades: [], info: { trades: trades.map(trade => trade.info) },
            }, market);
        }
        // 미체결 행의 체결수량은 그 행 한 건의 것이다. 이 주문의 체결내역 합계가 정본이다.
        const amount = open.amount as number;
        return this.safeOrder({
            ...open, filled, cost, remaining: Math.max(0, amount - filled), average: filled > 0 ? cost / filled : undefined,
            status: filled >= amount && amount > 0 ? 'closed' : 'open', trades: [],
        }, market);
    }

    /**
     * 체결내역. 계좌 체결내역을 종목 단위로 준다(`symbol` 이 필요하다). 국내는 `SSQM2341`, 해외는 `SPQM2103` 이다.
     *
     * 조회일자는 두 가지다. `since` 가 있으면 그 시각의 **한국 날짜**를 정확히 조회하고 실패를 던진다(주문 시각으로 그 주문의 체결 행을 찾을 때).
     * 없으면 가장 최근 영업일이다. `params.date`(`YYYYMMDD`)로 날짜를 직접 줄 수도 있다.
     *
     * 분할체결은 식별자를 지운 연속 행으로 온다. 이 함수가 그 행을 앞 헤더에 귀속시키므로 주문번호(`trade.order`)별로 `amount` 를 더하면 체결수량이다.
     * 단가가 0 인 체결은 체결가를 모르므로 버린다.
     */
    override async fetchMyTrades(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} fetchMyTrades() requires a symbol argument`);
        const market = this.market(symbol);
        const explicitDate = safeString(params, 'date') ?? (since !== undefined ? kbsecDateKst(new Date(since)) : undefined);
        if (this.isUs(market)) return this.fetchOverseasTrades(market, explicitDate, limit);
        // 구분 필드를 비우면 거부된다(`체결구분을 확인하십시오`, 8654). 그 탓에 체결 확인이 매번 실패해 진입가가 요청 호가로 기록된 적이 있다.
        const request = (ordr_dt: string): Promise<Dict> => this.callTr(KBSEC_TR.TRADES_KR, {
            inq_clsf: KBSEC_INQ_STOCK, // 주식
            ccls_clsf: KBSEC_CCLS_FILLED, // 체결만
            ordr_dt,
            is_cd: market.id,
            cn_clsf: KBSEC_CONT_FIRST,
            nxt_key: '',
        });
        const body = explicitDate !== undefined ? await request(explicitDate) : await this.callOnBusinessDate(request);
        return this.fillRowsToTrades(pickArray(body), market, limit);
    }

    /**
     * 해외 체결내역 — `SPQM2103`. 응답 필드는 공식 스펙 이름(`ccls_q_p6`·`frgn_ccls_prc_p6`·`dl_clsf_nm`)이 1순위이고 국내 이름은 폴백이다.
     * 체결구분은 비우면 거부되므로 명시한다.
     *
     * 영구 실패면 이 인스턴스에서는 다시 부르지 않는다(반복 실패는 계정 제한 사유). 시간 초과는 래치하지 않는다. 해외 체결 확정이 실패해도 주문
     * 자체는 접수된 상태다.
     */
    private async fetchOverseasTrades(market: MarketInterface, date: Str, limit: Int): Promise<Trade[]> {
        if (this.overseasFillsUnavailable) {
            throw new ExchangeError(`${this.id} 해외 체결 조회가 이 인스턴스에서 영구 실패해 다시 부르지 않는다`);
        }
        try {
            const request = (ordr_dt: string): Promise<Dict> => this.callTr(KBSEC_TR.ORDERS_US, {
                ccls_clsf: KBSEC_CCLS_FILLED, // 체결만. 비우면 거부된다
                ordr_dt,
                is_cd: market.id,
                nxt_key: '',
            });
            const body = date !== undefined ? await request(date) : await this.callOnBusinessDate(request);
            const rows = pickArray(body);
            const trades = this.fillRowsToTrades(rows, market, limit);
            if (rows.length > 0 && trades.length === 0) {
                logger.warn({ rows: rows.length, rowKeys: Object.keys(rows[0] ?? {}).slice(0, 40) }, '[kbsec] 해외 체결 행은 있으나 전부 걸러짐 — 응답 필드명 불일치');
            }
            return trades;
        } catch (err) {
            if (!(err instanceof RequestTimeout)) this.overseasFillsUnavailable = true;
            logger.warn({ err, symbol: market.symbol, trCode: KBSEC_TR.ORDERS_US, latched: !(err instanceof RequestTimeout) },
                '[kbsec] 해외 체결 조회 실패 — 영구 실패면 이 인스턴스에서 재시도하지 않는다(반복 실패는 계정 제한 사유)');
            throw err;
        }
    }

    /**
     * 체결 행을 체결 **건별** `Trade` 로 옮긴다. 필드 이름은 `kbsec-fill-row.ts` 가 정본이다.
     *
     * - 한 행이 한 체결이라 수량은 그대로 쓴다. 분할체결 연속 행은 식별자가 비어 오므로 `kbsecResolveFills` 로 헤더 행에 귀속시킨다.
     * - 종목 필터는 귀속 **뒤**에 건다. 앞에서 걸면 다른 종목의 헤더 행이 사라지고 식별자 없는 연속 행이 엉뚱한 헤더에 붙는다.
     *   요청이 이미 종목 단위라 코드가 비어 온 행은 걸러내지 않는다. 다른 종목이 분명한 행만 뺀다.
     * - 단가 0 인 체결은 버린다. 수량만 있고 단가가 없으면 확정된 것처럼 보이는 추측이 만들어진다.
     */
    private fillRowsToTrades(rows: Dict[], market: MarketInterface, limit: Int): Trade[] {
        const base = market.id as string;
        const parse = this.isUs(market) ? parseKbsecOverseasFillRow : parseKbsecDomesticFillRow;
        const parsed = rows.map(parse);
        warnIfFillTotalsInconsistent(parsed, rows, `체결내역 ${market.symbol}`);
        const fills = kbsecResolveFills(parsed).filter(fill => base === '' || fill.symbol === '' || fill.symbol === base);
        const trades: Trade[] = [];
        fills.forEach((fill, index) => {
            if (!(fill.price > 0)) {
                warnFillWithoutPrice(rows[0] ?? {}, market.symbol);
                return;
            }
            trades.push(this.parseTrade({ ...fill, index }, market));
        });
        warnIfFillSideUnreadable(rows, fills.filter(f => f.side !== null).length, `체결내역 ${market.symbol}`);
        // 행 순서가 체결 순서다. `parseTrades` 는 시각·id 로 다시 정렬하는데, 체결 시각을 모르는 채로 id 문자열 순서로 섞이게 둘 수 없다.
        return limit !== undefined ? trades.slice(-limit) : trades;
    }

    override parseTrade(trade: Dict, market: MarketInterface | undefined = undefined): Trade {
        const fill = trade as unknown as KbsecFill & { index: number };
        return this.safeTrade({
            id: `${fill.orderId}#${fill.index}`,
            info: trade,
            // 체결 시각은 응답에 있으나 형식이 확정되지 않아 읽지 않는다. 지어낸 시각을 넣지 않는다.
            timestamp: undefined,
            datetime: undefined,
            order: fill.orderId,
            symbol: market?.symbol,
            type: undefined,
            side: fill.side ?? undefined,
            takerOrMaker: undefined,
            price: fill.price,
            amount: fill.qty,
            cost: fill.cost,
            fee: undefined,
        }, market);
    }

    // ============ 수수료 ============

    /**
     * 위탁수수료율의 **추정**이다. KB 에 수수료 조회 TR 이 없어 공시 요율의 근사를 돌려준다(`info.estimated: true`). 국내 매도(`params.side: 'sell'`)는
     * 시행일별 증권거래세를 더한 실효율이다. 실제 청구액은 정산 TR(`fetchDomesticSettlements`·`fetchOverseasSettlements`)이 준다.
     */
    override async fetchTradingFee(symbol: string, params: Dict = {}): Promise<TradingFeeInterface> {
        const market = this.market(symbol);
        const side = params.side === 'sell' ? 'sell' : 'buy';
        const rate = kbsecEstimatedFeeRate(this.isUs(market) ? 'US' : 'KR', side);
        return { info: { estimated: true, side }, symbol: market.symbol, maker: rate, taker: rate, percentage: true, tierBased: false };
    }

    // ============ 휴장일 ============

    /**
     * 국내 휴장일을 날짜별 개장 여부로 돌려준다. 장운영상태(`SZQM0771`)가 주는 전영업일·기준영업일·익영업일을 열린 날로 보고, 그 사이의 평일을
     * 닫힌 날로 넓힌다. KB 는 이 세 날짜 밖은 알려 주지 않으므로 넓히는 범위가 앞뒤 며칠이다.
     */
    async fetchMarketCalendar(_params: Dict = {}): Promise<CalendarDay[]> {
        const body = await this.callTr(KBSEC_TR.MARKET_STATUS, {});
        const openDates = [pickStr(body, 'bfr_bsns_dt'), pickStr(body, 'std_bsnss_dt'), pickStr(body, 'next_biz_dt')].filter(date => date !== '');
        return expandBusinessDays(openDates);
    }

    /**
     * `fetchMarketCalendar` 의 결과를 공용 휴장일 캘린더(`market-calendar.ts`)에 넣는다. 국내 실주문 직전에 자동으로 부른다. 장 시간 판정을 주문 밖에서 쓰는
     * 쪽은 시작할 때 한 번 직접 부른다. 6시간 안에 성공한 호출은 다시 하지 않는다.
     *
     * @returns 신선한 캘린더가 있으면 `true`. 호출에 실패해도 던지지 않는다.
     */
    async refreshMarketCalendar(): Promise<boolean> {
        if (this.apiKey === undefined || this.secret === undefined) return false;
        return refreshSharedMarketCalendar('KR', () => this.fetchMarketCalendar(), { ttlMs: CALENDAR_TTL_MS });
    }

    // ============ 정산 ============

    /**
     * 국내 하루치 정산 행 — `SSQM2121`(계좌별매매가정산현황). KB 가 실제로 청구한 국내 매매비용(위탁수수료·거래세·농특세)의 정본이다.
     *
     * **조회 실패와 정산 없음을 같은 값으로 돌려주지 않는다.** 실패를 빈 배열로 삼키면 호출하는 쪽이 "그날 매매가 없었나 보다"로 읽고 추정치를
     * 그대로 남긴다. 그래서 판별 유니온이고 `ok: true, rows: []` 만 정상적인 0건이다.
     *
     * 매도(`1`)와 매수(`2`)를 **따로** 부른다. 스펙에는 `9: 전체` 가 있지만 실응답이 잘린 부분집합이고, 그 잘림이 연속조회처럼 보인다(그 키를 되보내면
     * 같은 행이 그대로 다시 온다). 매도·매수는 각각 완결된다.
     *
     * @param tradeDateKst 매매일자 `YYYYMMDD`(한국 날짜)
     */
    async fetchDomesticSettlements(tradeDateKst: string): Promise<KbsecSettlementFetch> {
        const raw: KbsecSettlementRow[] = [];
        let truncated = false;
        for (const side of [KBSEC_SETTLE_TRD_CLSF.SELL, KBSEC_SETTLE_TRD_CLSF.BUY]) {
            const page = await this.fetchSettlementSide(tradeDateKst, side);
            if (!page.ok) return page;
            raw.push(...page.rows);
            truncated = truncated || page.truncated;
        }
        // 연속 행 귀속과 묶음 단위 검산. `clsf=1` 은 한 종목을 단가마다 쪼개고 비용을 마지막 행에만 싣는다. 행 단위로 보면 비용을 든 행이 버려진다.
        const { rows, inconsistent, orphaned } = kbsecResolveSettlementRows(raw);
        if (inconsistent > 0) {
            logger.warn({ tradeDateKst, inconsistent, kept: rows.length }, '[kbsec] 정산 묶음 검산 실패 — 필드 대조 필요(그 묶음은 버렸다)');
        }
        if (orphaned > 0) {
            logger.warn({ tradeDateKst, orphaned }, '[kbsec] 주인 없는 정산 연속 행 — 귀속할 헤더가 없어 버렸다');
        }
        return { ok: true, rows, truncated };
    }

    /**
     * 한 매매구분의 하루치 정산 행. 연속조회를 따라가되 **같은 키가 또 오면 그 페이지를 버리고** 잘렸다고 표시한다. 담고 나서 멈추면 같은 행이
     * 두 번 들어가고 잘린 것을 완주로 보고한다.
     */
    private async fetchSettlementSide(tradeDateKst: string, trdClsf: string): Promise<KbsecSettlementFetch> {
        const rows: KbsecSettlementRow[] = [];
        let nextKey = '';
        let truncated = false;
        const maxPages = this.options.settlementMaxPages as number;
        try {
            for (let page = 0; page < maxPages; page++) {
                const body = await this.callTr(KBSEC_TR.SETTLEMENT_KR, {
                    trd_dt: tradeDateKst,
                    clsf: KBSEC_SETTLE_CLSF.BY_PRICE,
                    trd_clsf: trdClsf,
                    // KB 공식 예제가 결제일자에 매매일자와 같은 값을 넣는다. 실측상 필터가 아니다. 빈 값으로 보내도 같은 행 수가 온다.
                    stmt_dt: tradeDateKst,
                    nxt_key: nextKey,
                });
                const pageRows = pickSettlementGrid(body).map(parseKbsecDomesticSettlementRow);
                const prevKey = nextKey;
                nextKey = pickStr(body, 'nxt_key');
                if (nextKey !== '' && nextKey === prevKey) {
                    logger.warn({ tradeDateKst, trdClsf, rows: rows.length }, '[kbsec] 정산 연속조회 키가 그대로다 — 이 페이지를 버리고 잘렸다고 본다');
                    truncated = true;
                    break;
                }
                rows.push(...pageRows);
                if (nextKey === '') break;
                if (page === maxPages - 1) truncated = true;
            }
        } catch (err) {
            logger.warn({ err, tradeDateKst, trdClsf }, '[kbsec] 국내 정산 조회 실패 — 추정치를 유지한다(0건 아님)');
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (truncated) {
            logger.warn({ tradeDateKst, trdClsf, rows: rows.length }, '[kbsec] 정산이 잘렸다 — 그룹 합계가 모자랄 수 있다');
        }
        return { ok: true, rows, truncated };
    }

    /**
     * 해외 구간 정산 행 — `SPQM2205`(매매가정산현황). 국내와 **호출 모양이 다르다.**
     *
     * 1. **구간 조회다.** `strt_ordr_dt`~`end_ordr_dt` 라 하루씩 부를 이유가 없다. KB 호출 수도 적다.
     * 2. **전체(`99`)를 한 번에 부른다.** 국내 `9` 는 잘린 부분집합이라 매도·매수를 따로 불러야 했지만 해외 `99` 는 정상 완결한다.
     * 3. **매매구분이 두 자리다.** `99`/`01`/`02`. 국내의 `9` 를 보내면 1861("조회할 자료가 없습니다")이 돌아오고, 그 코드는 정상 빈 결과로 흡수돼
     *    거부가 "거래 없음"과 똑같아 보인다.
     *
     * 통화 축은 외화(USD)다. 원화 축은 같은 행을 환산해 주지만 세금 필드를 채우지 않는다.
     *
     * @param startDateUs 시작 주문일자 `YYYYMMDD` — **미국 현지 일자**(`kbsecDateUsEastern`)
     * @param endDateUs 종료 주문일자 `YYYYMMDD`
     */
    async fetchOverseasSettlements(startDateUs: string, endDateUs: string): Promise<KbsecOverseasSettlementFetch> {
        const raw: KbsecOverseasSettlementRow[] = [];
        let nextKey = '';
        let truncated = false;
        const maxPages = this.options.settlementMaxPages as number;
        try {
            for (let page = 0; page < maxPages; page++) {
                const body = await this.callTr(KBSEC_TR.SETTLEMENT_US, {
                    strt_ordr_dt: startDateUs,
                    end_ordr_dt: endDateUs,
                    // 거래소·종목·ISO 는 비워 전체를 받는다(스펙상 선택 필드).
                    frgn_krx_ccd: '',
                    trd_clsf: KBSEC_OVERSEAS_SETTLE_TRD_CLSF.ALL,
                    stnd_is_cd: '',
                    iso_cd: '',
                    // 합계 입력칸. 조회에는 빈 값으로 보낸다.
                    s_stmt_amt_sum_p4: '',
                    b_stmt_amt_sum_p4: '',
                    tl_s_ccls_q_p6: '',
                    tl_b_ccls_q_p6: '',
                    fcrncy_fee_p4: '',
                    krw_unty_mgn_rqst_f: KBSEC_OVERSEAS_SETTLE_FX_AXIS.FOREIGN,
                    dl_clsf: KBSEC_OVERSEAS_SETTLE_DL_CLSF.ALL,
                    nxt_key: nextKey,
                });
                const pageRows = pickOverseasSettlementGrid(body).map(parseKbsecOverseasSettlementRow);
                const prevKey = nextKey;
                nextKey = pickStr(body, 'nxt_key');
                // 같은 키가 또 오면 앞 페이지와 같은 내용이다. 담으면 비용이 몇 배로 부풀고 완주한 것처럼 보인다.
                if (nextKey !== '' && nextKey === prevKey) {
                    logger.warn({ startDateUs, endDateUs, rows: raw.length }, '[kbsec] 해외 정산 연속조회 키가 그대로다 — 이 페이지를 버리고 잘렸다고 본다');
                    truncated = true;
                    break;
                }
                raw.push(...pageRows);
                if (nextKey === '') break;
                if (page === maxPages - 1) truncated = true;
            }
        } catch (err) {
            logger.warn({ err, startDateUs, endDateUs }, '[kbsec] 해외 정산 조회 실패 — 추정치를 유지한다(0건 아님)');
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const { rows, inconsistent, foreignCurrency } = kbsecResolveOverseasSettlementRows(raw);
        if (inconsistent > 0) {
            logger.warn({ startDateUs, endDateUs, inconsistent, kept: rows.length }, '[kbsec] 해외 정산 묶음 검산 실패 — 필드 대조 필요(그 묶음은 버렸다)');
        }
        if (foreignCurrency > 0) {
            logger.warn({ startDateUs, endDateUs, foreignCurrency }, '[kbsec] 해외 정산에 USD 아닌 행이 있다 — 축이 다른 금액이라 버렸다');
        }
        if (truncated) {
            logger.warn({ startDateUs, endDateUs, rows: rows.length }, '[kbsec] 해외 정산이 잘렸다 — 그룹 합계가 모자랄 수 있다');
        }
        return { ok: true, rows, truncated };
    }
}
