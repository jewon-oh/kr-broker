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
 * 전역 설정은 없고 인스턴스가 `options` 로 받는다. `tokenStore`(토큰 저장소), `nxtRouting`(정규장 안의 국내 주문을 SOR 로. 정규장 밖 주문은
 * 받지 않는다), `krwIntegratedMargin`(원마켓 계좌의 미국 주식 매수여력을 원화 환산분으로 보강, 환율은 `usdKrwRate`), `masterData`(해외 종목의
 * 상장 거래소 판별), `confirmBudget`(체결 확정 조회 예산)이다.
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

import { candlePeriodUtcMs, isDailyOrLongerTimeframe } from './broker-time';
import { logger } from './logger';
import type { UsdKrwRateOption } from './options';
import { masterDataOf } from './kis/kis-master-data';
import {
    ArgumentsRequired,
    AuthenticationError,
    BadRequest,
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
    Precise,
    numberToString,
    omit,
    safeDict,
    safeString,
} from './base';
import type {
    Balances, Dict, Dictionary, Int, KrTimestamped, MarketInterface, Num, OHLCV, Order, OrderBook, OrderSide, OrderType, Str, Ticker, Trade,
    TradingFeeInterface,
} from './base';
import { assertSecureUrl, implicitMethodName } from './base/Exchange';
import { KBSEC_API_TREE, type KbsecImplicitApi } from './abstract/kbsec';
import { confirmExecution, fillDeviationBps, tradeListProbe } from './execution-confirm';
import { expandBusinessDays, refreshMarketCalendar as refreshSharedMarketCalendar, type CalendarDay } from './market-calendar';
import { marketSessionBlockReason } from './trading-hours';
import { KbsecAuth } from './kbsec/kbsec-auth';
import { kbsecBarMs, kbsecCandleTimestamp, kbsecChartParams, KBSEC_CHART_MAX, KBSEC_TIMEFRAMES, kbsecUsCandleTimestamp } from './kbsec/kbsec-chart';
import {
    isKbsecBusinessError, isKbsecTokenFailure, kbsecHostAddr, type KbsecResponseHeader,
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
    kbsecHoldingQuantity, OVERSEAS_QTY_CANDIDATES, pickArray, pickCashGrid, pickGrid, pickHoldingGrid, pickNum,
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
    KBSEC_CCLS_ALL,
    KBSEC_CCLS_FILLED,
    KBSEC_CCLS_PENDING,
    KBSEC_CONT_FIRST,
    KBSEC_CONT_NEXT,
    KBSEC_CREDIT_CASH,
    KBSEC_EXCH_RATE_MARKET,
    KBSEC_FEE_EXCLUDED,
    KBSEC_INQ_ALL,
    KBSEC_INQ_STOCK,
    KBSEC_ORDER_SIDE_KR,
    KBSEC_ORDER_SIDE_US,
    KBSEC_ORDER_TYPE_KR,
    KBSEC_ORDER_TYPE_US,
    KBSEC_SESSION_REGULAR,
    KBSEC_SOR,
    KBSEC_STD_CURRENCY_FOREIGN,
    KBSEC_TR,
    KBSEC_TR_PATH_PREFIX,
    KBSEC_US_EXCHANGES,
    kbsecBaseSymbol,
    kbsecBusinessDateKst,
    kbsecBusinessDateUsEastern,
    kbsecDateKst,
    kbsecDateUsEastern,
    kbsecMarketOf,
    kbsecNormalizeCode,
    kbsecNum,
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

/**
 * 평가손익 행 하나(`SSQM0006`). 국내만 지원한다.
 * `quantity`는 명세 라벨이 "정산수량"(`ec_q`)이다 — 계좌자산평가(`SSQM2952`, `fetchBalance`가 쓰는)의 "실보유수량"과
 * 필드명은 같지만 라벨이 달라, 결제 전 수량을 포함하는지는 확인 못 했다(라이브 검증 전까지 `spec-only`).
 */
export interface KbsecUnrealizedPnlRow {
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 정산수량(`ec_q`) */
    quantity: number;
    /** 평균단가(`avr_uprc`) */
    averagePrice: number;
    /** 현재가(`now_prc`) */
    last: number;
    /** 평가손익금액(`val_pl_amt`) */
    unrealizedPnl: number;
    info: Dict;
}

/**
 * `fetchUnrealizedPnl` 결과. 연속조회가 상한에 걸리거나 같은 다음키가 되풀이되면 `truncated`가 `true`다.
 * 그때 `rows`에 없는 종목은 평가손익이 0인 것이 아니라 **읽지 못한 것**이다.
 */
export interface KbsecUnrealizedPnlFetch {
    rows: KbsecUnrealizedPnlRow[];
    truncated: boolean;
}

/** 국내주식 소수점 보유 한 종목(`SSQM5472`). 수량은 소수점이 있을 수 있다. */
export interface KbsecFractionalHolding {
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 보유수량(`hld_q`) */
    quantity: number;
    /** 주문가능수량(`ordr_psbl_q`) */
    orderableQuantity: number;
    /** 평균단가(`avr_uprc`) */
    averagePrice: number;
    /** 매입금액(`byng_amt`) */
    cost: number;
    /** 평가금액(`val_amt`) */
    marketValue: number;
    /** 평가손익(`val_pl`) */
    unrealizedPnl: number;
    /** 평가손익율(`val_pl_r`) */
    unrealizedPnlRate: number;
    info: Dict;
}

/** 해외 소수점 보유 한 종목(`SPQM5472`). 외화 축으로 받으므로 금액은 `currency` 통화다. */
export interface KbsecOverseasFractionalHolding extends KbsecFractionalHolding {
    /** 통화코드(`crncy_cd`) */
    currency: string;
}

export interface KbsecOverseasFractionalHoldingsFetch {
    rows: KbsecOverseasFractionalHolding[];
    truncated: boolean;
}

/** `fetchFractionalBuyableAmount` 결과. 국내는 `SSQN5472`, 미국은 `SPQN5472`다. */
export interface KbsecFractionalBuyable {
    /** 주문가능금액. 국내는 최대주문가능금액(`mx_ordr_psbl_amt`), 미국은 외화통합주문가능금액(`fcrncy_unty_ordr_psbl_amt_p2`) */
    amount: number;
    /** `amount`와 `expectedFee`의 통화 */
    currency: 'KRW' | 'USD';
    /** 예상주식수량(`expct_stk_q_p6`). 주문금액을 넣었을 때 그 금액으로 살 수 있는 수량이다 */
    expectedQuantity: number;
    /** 예상수수료. 국내는 `expct_fee`, 미국은 외화수수료(`fcrncy_fee_p2`) */
    expectedFee: number;
    /** 수수료율(`fee_r_p10`) */
    feeRate: number;
    /** 평가기준가(`val_sprc_p8`) */
    referencePrice: number;
    info: Dict;
}

/** 소수점 조회의 매매 방향. 명세에 설명된 코드(`01` 매도, `02` 매수) 밖의 값은 `unknown`이다. */
export type KbsecTradeSide = 'buy' | 'sell' | 'unknown';

const KBSEC_TWO_DIGIT_SIDE: Readonly<Record<string, 'buy' | 'sell'>> = { '01': 'sell', '02': 'buy' };

function kbsecTwoDigitSide(code: string): KbsecTradeSide {
    return KBSEC_TWO_DIGIT_SIDE[code] ?? 'unknown';
}

/** 국내 소수점 매매내역 한 줄(`SSQM5765`). */
export interface KbsecFractionalTrade extends KrTimestamped {
    /** 매매일자(`trd_dt`, YYYYMMDD) */
    date: string;
    /** 접수번호(`acpt_no`) */
    acceptNo: string;
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 매매거래구분코드(`trd_dl_ccd`)에서 옮긴 방향 */
    side: KbsecTradeSide;
    /** 주문금액(`ordr_amt`) */
    orderAmount: number;
    /** 주문수량(`dmstc_stk_dcml_ordr_q_p6`) */
    orderQuantity: number;
    /** 주문가격(`ordr_prc`) */
    orderPrice: number;
    /** 체결수량(`dmstc_stk_dcml_ccls_q_p6`) */
    filledQuantity: number;
    /** 체결가격(`ccls_prc`) */
    filledPrice: number;
    /** 체결금액(`ccls_amt`) */
    filledAmount: number;
    /** 수수료(`fee`) */
    fee: number;
    /** 거래세(`dl_tx`) */
    tax: number;
    /** 정산금액(`ec_amt`) */
    settledAmount: number;
    /** 거부사유(`rfsl_rsn`) */
    rejectReason: string;
    info: Dict;
}

export interface KbsecFractionalTradesFetch {
    rows: KbsecFractionalTrade[];
    truncated: boolean;
}

/** 국내 온주/소수점 주문체결 한 줄(`SSQM5475`). 출력에 매매구분 코드가 없어 방향은 이름(`sideName`)으로만 준다. */
export interface KbsecFractionalOrder extends KrTimestamped {
    /** 주문일자(`ordr_dt`, YYYYMMDD) */
    date: string;
    /** 주문시간(`ordr_tm`) */
    time: string;
    /** 주문번호(`ordr_no`) */
    id: string;
    /** 원주문번호(`orgn_ordr_no`) */
    originalId: string;
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 한글단축명(`hngl_shrt_nm`) */
    name: string;
    /** 거래구분(`dl_clsf`) 원문 코드. 입력 설명은 `1` 온주, `2` 소수점이다 */
    dealType: string;
    /** 매매구분명(`trd_clsf_nm`) 원문 */
    sideName: string;
    /** 원화주문금액(`krw_ordr_amt`) */
    orderAmount: number;
    /** 주문수량(`ordr_q_p6`) */
    orderQuantity: number;
    /** 주문가격(`ordr_prc_p4`) */
    orderPrice: number;
    /** 체결수량(`dcml_ccls_q_p6`) */
    filledQuantity: number;
    /** 체결가격(`ccls_prc_p4`) */
    filledPrice: number;
    /** 체결금액(`ccls_amt`) */
    filledAmount: number;
    /** 수수료(`fee`) */
    fee: number;
    /** 미체결수량(`nccls_q`) */
    remainingQuantity: number;
    /** 처리결과(`hndl_rslt`) 원문 */
    result: string;
    /** 거부사유내용(`rfsl_rsn_cntnt`) */
    rejectReason: string;
    info: Dict;
}

export interface KbsecFractionalOrdersFetch {
    rows: KbsecFractionalOrder[];
    truncated: boolean;
}

/** 해외 소수점 주문접수 한 줄(`SPQN5473`). */
export interface KbsecOverseasFractionalOrder {
    /** 주문일자(`ordr_dt`, YYYYMMDD) */
    date: string;
    /** 접수시간(`acpt_tm`) */
    time: string;
    /** 접수번호(`acpt_no`) */
    acceptNo: string;
    /** 통합 심볼(`AAPL/USD`) */
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 매매구분(`trd_clsf`)에서 옮긴 방향 */
    side: KbsecTradeSide;
    /** 통화코드(`crncy_cd`) */
    currency: string;
    /** 외화주문금액(`fcrncy_ordr_amt`) */
    amount: number;
    /** 주문수량(`ordr_q`) */
    quantity: number;
    /** 해외주문가격(`frgn_ordr_prc_p4`) */
    price: number;
    /** 수수료(`fee`) */
    fee: number;
    /** 주문상태(`ordr_st`) 원문 코드 */
    statusCode: string;
    /** 처리결과(`hndl_rslt`) 원문 */
    result: string;
    info: Dict;
}

export interface KbsecOverseasFractionalOrdersFetch {
    rows: KbsecOverseasFractionalOrder[];
    truncated: boolean;
}

/** `createReservedOrder` 결과. 예약주문은 거래소 주문이 아니라 증권사가 보관했다가 내는 주문이라 ccxt `Order`로 만들지 않는다. */
export interface KbsecReservedOrder {
    /** 예약주문번호. 국내는 `ordr_no`, 미국은 `rsrv_ordr_no`다. 응답에 없으면 `undefined` */
    id: string | undefined;
    symbol: string;
    side: 'buy' | 'sell';
    type: 'limit' | 'market';
    /** 실제로 보낸 수량(내림한 정수) */
    amount: number;
    price: number | undefined;
    info: Dict;
}

/** `cancelReservedOrder` 결과(미국 `SPAO2106`). */
export interface KbsecReservedOrderCancel {
    /** 취소 요청에 붙은 주문번호(`ordr_no`). 응답에 없으면 `undefined` */
    id: string | undefined;
    /** 취소한 예약주문번호 */
    reservedOrderId: string;
    info: Dict;
}

/** 국내 예약주문 처리 결과 한 줄(`SSQM0831`). 코드의 뜻이 명세에 없는 필드는 원문 이름으로 둔다. */
export interface KbsecReservedOrderResult extends KrTimestamped {
    /** 주문일자(`ordr_dt`) */
    date: string;
    /** 일련번호(`sq`) */
    sequence: string;
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 주문구분명(`ordr_clsf_nm`) 원문 */
    sideName: string;
    /** 주문구분코드(`ordr_ccd`). 예약주문 접수 명세의 코드표(`00` 지정가, `03` 시장가 등)를 쓴다 */
    orderTypeCode: string;
    /** 주문수량(`ordr_q`) */
    quantity: number;
    /** 주문단가(`ordr_uprc`) */
    price: number;
    /** 실제로 나간 주문의 번호(`ordr_no`) */
    orderId: string;
    /** 주문여부명(`ordr_f_nm`) 원문 */
    orderedName: string;
    /** 메시지(`msg`) */
    message: string;
    info: Dict;
}

export interface KbsecReservedOrderResultsFetch {
    rows: KbsecReservedOrderResult[];
    truncated: boolean;
}

/** 국내 예약주문 접수 한 줄(`SSQM0834`). */
export interface KbsecReservedOrderEntry extends KrTimestamped {
    /** 일련번호(`sq`) */
    sequence: string;
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 매매거래구분코드(`trd_dl_ccd`)에서 옮긴 방향. `01`, `02`가 아니면 `unknown`이다 */
    side: KbsecTradeSide;
    /** 매매구분코드명(`trd_ccd_nm`) 원문 */
    sideName: string;
    /** 주문수량(`ordr_q`) */
    quantity: number;
    /** 주문단가(`ordr_uprc`) */
    price: number;
    /** 전량잔량구분코드명(`tv_rv_ccd_nm`) 원문 */
    reservationTypeName: string;
    /** 취소구분명(`cncl_clsf_nm`) 원문 */
    cancelName: string;
    /** 등록일자(`rgst_dt`) */
    registeredDate: string;
    /** 주문일자(`ordr_dt`) */
    orderDate: string;
    info: Dict;
}

export interface KbsecReservedOrdersFetch {
    rows: KbsecReservedOrderEntry[];
    truncated: boolean;
}

/** 거래 한 건의 상세(`SWQM2412`). 나머지 70여 필드(세금 항목, 신용·미수 변동 등)는 `info`에 원문으로 남는다. */
export interface KbsecLedgerEntryDetail {
    /** 거래일련번호(`dl_sq`) */
    sequence: string;
    /** 거래종류코드(`dl_knd_cd`) 원문 */
    kindCode: string;
    /** 거래종류명(`dl_knd_nm`) 원문 */
    kindName: string;
    /** 종목번호(`is_no`) 원문 */
    code: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 거래수량(`dl_q`) */
    quantity: number;
    /** 단가(`uprc_p4`) */
    price: number;
    /** 거래금액(`dl_amt`) */
    amount: number;
    /** 수수료(`fee`) */
    fee: number;
    /** 거래세(`dl_tx`) */
    tax: number;
    /** 정산금액(`ec_amt`) */
    settledAmount: number;
    /** 적요(`smry`) */
    summary: string;
    /** 예수금금일잔액(`tfnd_tdy_ra`) */
    cashBalance: number;
    info: Dict;
}

/** 계좌 권리 발생 한 줄(`SRQM3051`). 날짜 필드는 모두 YYYYMMDD 원문이다. */
export interface KbsecCorporateAction extends KrTimestamped {
    /** 기준일자(`bss_dt`) */
    baseDate: string;
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 권리구분코드명(`rgt_ccd_nm`) 원문 */
    rightName: string;
    /** 보유수량(`hld_q`) */
    quantity: number;
    /** 배정수량(`alct_q`) */
    allocatedQuantity: number;
    /** 권리비율(`rgt_rt`) */
    rightRatio: number;
    /** 발행가(`isng_prc`) */
    issuePrice: number;
    /** 현금지급일자(`csh_py_dt`) */
    cashPaymentDate: string;
    /** 주식입출고일자(`stck_io_stck_dt`) */
    stockDate: string;
    /** 배당예정금액(`dvdnd_expt_amt`) */
    expectedDividend: number;
    /** 배당확정금액(`dvdnd_dfnt_amt`) */
    confirmedDividend: number;
    info: Dict;
}

export interface KbsecCorporateActionsFetch {
    rows: KbsecCorporateAction[];
    truncated: boolean;
}

/**
 * 해외 주문 한 건(`SPQM1818`). 응답에 티커가 없고 표준종목코드(`stnd_is_cd`)만 있어 통합 심볼을 만들지 않는다.
 * 주문상태도 이름(`ordr_st_nm`)만 오므로 원문으로 둔다.
 */
export interface KbsecOverseasOrderEntry {
    /** 주문일자(`ordr_dt`) */
    date: string;
    /** 주문시간(`ordr_tm`) */
    time: string;
    /** 주문번호(`ordr_no`) */
    id: string;
    /** 원주문번호(`orgn_ordr_no`) */
    originalId: string;
    /** 표준종목코드(`stnd_is_cd`) 원문 */
    standardCode: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 주문상태명(`ordr_st_nm`) 원문 */
    statusName: string;
    /** 주문구분명(`ordr_clsf_nm`) 원문 */
    orderTypeName: string;
    /** 통화코드(`crncy_cd`) */
    currency: string;
    /** 해외주문수량(`frgn_ordr_q_p6`) */
    quantity: number;
    /** 해외주문가격(`frgn_ordr_prc_p6`) */
    price: number;
    /** 체결수량(`ccls_q_p6`) */
    filledQuantity: number;
    /** 해외체결가격(`frgn_ccls_prc_p6`) */
    filledPrice: number;
    /** 미체결수량(`nccls_q_p6`) */
    remainingQuantity: number;
    /** 거부사유(`rfsl_rsn`) */
    rejectReason: string;
    info: Dict;
}

export interface KbsecOverseasOrdersFetch {
    rows: KbsecOverseasOrderEntry[];
    truncated: boolean;
}

/** `fetchFractionalHoldings` 결과. `truncated`가 `true`면 `rows`에 없는 종목은 보유 0이 아니라 **읽지 못한 것**이다. */
export interface KbsecFractionalHoldingsFetch {
    rows: KbsecFractionalHolding[];
    truncated: boolean;
}

/**
 * 계좌원장 거래내역 한 줄(`SWQA2301`, CMA는 `SWQB2301`). 금액의 부호와 입출 방향은 명세에 없어 원문 그대로 옮긴다. 적요유형코드(`smry_typ_cd`)·
 * 거래유형코드(`dl_typ_cd`)·세목별 세금·외화 필드는 `info`에 있다.
 */
export interface KbsecLedgerEntry extends KrTimestamped {
    /** 거래일자 `YYYYMMDD`(`dl_dt`, 한국 날짜) */
    date: string;
    /** 거래일련번호(`dl_sq`) */
    sequence: string;
    /** 적요명(`smry_nm`), 예: 현금매수 */
    summary: string;
    /** 표준종목코드(`stnd_is_cd`). 입출금처럼 종목이 없는 줄은 빈 문자열이다. */
    standardCode: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 수량(`q`) */
    quantity: number;
    /** 거래단가(`dl_uprc`, CMA 원장은 `uprc`) */
    price: number;
    /** 거래금액(`dl_amt`) */
    amount: number;
    /** 정산금액(`ec_amt`) */
    settledAmount: number;
    /** 수수료(`fee`) */
    fee: number;
    /** 거래 뒤 예수금잔고(`tfnd_blnc`) */
    cashBalance: number;
    info: Dict;
}

/** `fetchAccountLedger` 결과. `truncated`가 `true`면 기간 안의 거래가 다 오지 않았다. */
export interface KbsecLedgerFetch {
    rows: KbsecLedgerEntry[];
    truncated: boolean;
}

/** `fetchWithdrawableAmount` 결과(`SWQN2302`). 금액은 모두 원이다. 나머지 100여 필드는 `info`에 원문으로 남는다. */
export interface KbsecWithdrawableAmount {
    /** 익일출금가능금액(`ndy_o_amt_psbl_amt`) */
    nextDay: number;
    /** 익익일출금가능금액(`nxt2_dy_o_amt_psbl_amt`) */
    dayAfterNext: number;
    /** 예수금액(`tfnd_amt`) */
    deposit: number;
    /** 익일예수금액(`ndy_tfnd_amt`) */
    nextDayDeposit: number;
    /** 익익일예수금액(`nxt2_dy_tfnd_amt`) */
    dayAfterNextDeposit: number;
    info: Dict;
}

/** 개인별 쿠폰 한 장(`SZQM6019`). 상태구분과 발행구분 같은 코드는 뜻이 명세에 없어 원문 코드로 둔다. */
export interface KbsecCoupon {
    /** 쿠폰코드(`cpn_cd`) */
    code: string;
    /** 쿠폰발행명(`cpn_isng_nm`) */
    name: string;
    /** 상태구분(`st_clsf`) 원문 코드 */
    statusCode: string;
    /** 금액(`amt`) */
    amount: number;
    /** 잔존일수(`rmd_dy_c`) */
    remainingDays: number;
    /** 시작일자(`strt_dt`, YYYYMMDD) */
    startDate: string;
    /** 종료일자(`end_dt`, YYYYMMDD) */
    endDate: string;
    /** 사용일자(`use_dt`, YYYYMMDD) */
    usedDate: string;
    /** 쿠폰적용가능상품명(`cpn_aplc_psbl_gds_nm`) */
    applicableProduct: string;
    info: Dict;
}

/** 기간매매손익 행 하나(`SSQM2392`). 주문일자와 종목 단위다. 국내만 지원한다. */
export interface KbsecRealizedPnlRow extends KrTimestamped {
    /** 주문일자(`ordr_dt`, YYYYMMDD) */
    date: string;
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 체결수량(`ccls_q`) */
    quantity: number;
    /** 매수수량(`b_q`) */
    buyQuantity: number;
    /** 매입가격(`byng_prc`) */
    buyPrice: number;
    /** 매도가격(`s_prc`) */
    sellPrice: number;
    /** 매매손익(`trd_pl`) */
    pnl: number;
    /** 매매제비용(`trd_svrl_cst`) */
    costs: number;
    /** 매매순손익(`trd_nt_pl`) */
    netPnl: number;
    /** 신용유형명(`crdt_typ_nm`) */
    creditType: string;
    info: Dict;
}

export interface KbsecRealizedPnlFetch {
    rows: KbsecRealizedPnlRow[];
    truncated: boolean;
}

/**
 * 종목기본정보(`SIQM4900`) 중 이름·유형 부분. 국내만 지원한다(해외 종목코드로도 되는지 명세에 없어 확인 불가).
 */
export interface KbsecStockInfo {
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 표준종목코드(`stnd_is_cd`) */
    standardCode: string | undefined;
    /** 단축종목코드(`shrt_is_cd`) */
    shortCode: string | undefined;
    /** 한글종목명(`hngl_is_nm`) */
    name: string | undefined;
    /** 한글단축명(`hngl_shrt_nm`) */
    shortName: string | undefined;
    /** 영문종목명(`eng_is_nm`) */
    englishName: string | undefined;
    /** 종목유형명(`is_typ_nm`) */
    typeName: string | undefined;
    /** 종목세부유형명(`is_dtl_typ_nm`) */
    detailTypeName: string | undefined;
    info: Dict;
}

/**
 * 종목기본정보(`SIQM4900`) 중 매매제한·위험등급 부분. 같은 TR 이 `KbsecStockInfo` 와 한 번에 준다. 국내만 지원한다.
 */
export interface KbsecStockWarning {
    /** 매매제한구분명(`trd_rstn_clsf_nm`). 제한이 없으면 빈 문자열로 온다(추정, 확인 못 함). */
    tradingRestriction: string | undefined;
    /** 매매제한시작일자 `YYYYMMDD`(`trd_rstn_strt_dt`) */
    tradingRestrictionStart: string | undefined;
    /** 매매제한종료일자 `YYYYMMDD`(`trd_rstn_end_dt`) */
    tradingRestrictionEnd: string | undefined;
    /** 입출제한구분명(`io_rstn_clsf_nm`) */
    depositWithdrawalRestriction: string | undefined;
    /** 위험등급구분코드(`rsk_grd_clsf_cd`) */
    riskGradeCode: string | undefined;
    /** 위험등급명(`rsk_grd_nm`) */
    riskGradeName: string | undefined;
    info: Dict;
}

/**
 * 투자자 유형별 매매(`IVU10430`)의 한 값 축(기본은 순매수). 13개 유형을 준다 — 다른 증권사보다 세분화됐다.
 * 수량은 `amt_q_clsf` 파라미터로 대금 대신 받을 수 있다.
 */
export interface KbsecInvestorAmounts {
    individual: number;
    foreign: number;
    institution: number;
    securities: number;
    insurance: number;
    investmentTrust: number;
    merchantBank: number;
    bank: number;
    fund: number;
    privateFund: number;
    otherCorporate: number;
    government: number;
    nativeForeign: number;
    program: number;
    foreignBrokerTotal: number;
}

/** 종목별 투자자 매매동향 하루치(`IVU10430`). 국내만 지원한다. */
export interface KbsecInvestorTradingRecord extends KrTimestamped {
    /** 일자 `YYYYMMDD`(`dt`) */
    date: string;
    /** 종가(`cls_prc`) */
    close: number;
    /** 전일대비(`bdy_cmpr`) */
    change: number;
    /** 등락율(`up_dwn_r_p2`) */
    percentage: number;
    /** 거래량(`vlm`) */
    volume: number;
    amounts: KbsecInvestorAmounts;
    info: Dict;
}

/** 외국계 거래원 한 곳의 매도 또는 매수 현황(`IVU10420`). */
export interface KbsecBrokerFlow {
    /** 증권사 코드(`s_scrts_cmpny1`, `b_scrts_cmpny1`) */
    code: string;
    /** 증권사명(`s_scrts_cmpny_nm1`, `b_scrts_cmpny_nm1`) */
    name: string;
    /** 수량(`s_q1`, `b_q1`) */
    quantity: number;
    /** 증감(`s_incrs_dcrs1`, `b_incrs_dcrs1`) */
    change: number;
    /** 비율(`s_rt1_p2`, `b_rt1_p2`) */
    ratio: number;
}

/** 당일 주요 외국계 거래원 한 줄(`IVU10420`). 같은 줄의 매도 상위와 매수 상위 거래원을 짝지어 준다. */
export interface KbsecForeignBrokerRow {
    sell: KbsecBrokerFlow;
    buy: KbsecBrokerFlow;
    info: Dict;
}

/** 종목별 프로그램매매 추이 한 줄(`IVU10450`). 금액과 수량의 단위는 명세에 없어 원문 그대로 옮긴다. */
export interface KbsecProgramTradingTrendRow extends KrTimestamped {
    /** 일자(`dt`, YYYYMMDD) */
    date: string;
    /** 시간(`tm`). 일별 조회에서는 비어 있을 수 있다 */
    time: string;
    /** 거래소코드(`excg_cd`, KRX 또는 NXT) */
    exchange: string;
    /** 현재가(`now_prc`) */
    price: number;
    /** 전일대비(`bdy_cmpr`) */
    change: number;
    /** 등락율(`up_dwn_r_p2`) */
    percentage: number;
    /** 누적거래량(`acml_vlm`) */
    volume: number;
    /** 순매수금액(`nt_b_amt`) */
    netBuyAmount: number;
    /** 순매수금액증감(`nt_b_amt_incrs_dcrs`) */
    netBuyAmountChange: number;
    /** 매도금액(`s_amt`) */
    sellAmount: number;
    /** 매수금액(`b_amt`) */
    buyAmount: number;
    /** 순매수수량(`nt_b_q`) */
    netBuyQuantity: number;
    /** 순매수수량증감(`nt_b_q_incrs_dcrs`) */
    netBuyQuantityChange: number;
    /** 매도수량(`s_q`) */
    sellQuantity: number;
    /** 매수수량(`b_q`) */
    buyQuantity: number;
    info: Dict;
}

/** 시장 하나의 등락 종목 수(`IVSA0070`). */
export interface KbsecMarketBreadth {
    /** 상한 종목 수(`*_ulmt_is_c`) */
    upperLimit: number;
    /** 상승 종목 수(`*_up_is_c`) */
    advancing: number;
    /** 보합 종목 수(`*_unchng_is_c`) */
    unchanged: number;
    /** 하락 종목 수(`*_dwn_is_c`) */
    declining: number;
    /** 하한 종목 수(`*_llmt_is_c`) */
    lowerLimit: number;
}

/** 시장종합의 지수 한 줄. */
export interface KbsecOverviewIndex {
    /** 지수ID(`indx_id`) */
    id: string;
    /** 지수명(`indx_nm`) */
    name: string;
    /** 현재지수(`now_indx_p2`) */
    value: number;
    /** 전일대비(`bdy_cmpr_p2`) */
    change: number;
    /** 등락율(`up_dwn_r_p2`) */
    percentage: number;
    /** 거래량(`vlm`) */
    volume: number;
    /** 거래대금(`dl_tw_amt`) */
    tradingValue: number;
    info: Dict;
}

/** 시장종합의 파생상품 한 줄. */
export interface KbsecOverviewDerivative {
    /** 종목코드(`is_cd`) */
    code: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 현재가(`now_prc_p2`) */
    price: number;
    /** 전일대비(`bdy_cmpr_p2`) */
    change: number;
    /** 등락율(`up_dwn_r_p2`) */
    percentage: number;
    /** 거래량(`vlm`) */
    volume: number;
    /** 미결제약정수량(`nstmt_agr_q`) */
    openInterest: number;
    info: Dict;
}

/** 시장종합의 해외 지표 한 줄. */
export interface KbsecOverviewGlobal {
    /** 심볼코드(`symbl_cd`) */
    code: string;
    /** 심볼명(`symbl_nm`) */
    name: string;
    /** 현재가(`now_prc`) */
    price: number;
    /** 전일대비(`bdy_cmpr_p2`) */
    change: number;
    /** 등락율(`up_dwn_r_p2`) */
    percentage: number;
    /** 일자시간(`dt_tm`) */
    dateTime: string;
    info: Dict;
}

/** 시장종합의 투자자별 순매수 한 줄. */
export interface KbsecOverviewInvestor {
    /** 투자자코드(`invstr_cd`) */
    code: string;
    /** 투자자구분명(`invstr_clsf_nm`) */
    name: string;
    /** 코스피순매수(`kspi_nt_b`) */
    kospi: number;
    /** 코스닥순매수(`ksdq_nt_b`) */
    kosdaq: number;
    /** 선물순매수(`fts_nt_b`) */
    futures: number;
    /** 콜옵션순매수(`call_opt_nt_b`) */
    callOptions: number;
    /** 풋옵션순매수(`put_opt_nt_b`) */
    putOptions: number;
    /** 스타선물순매수(`star_fts_nt_b`) */
    starFutures: number;
    /** 주식선물순매수(`stk_fts_nt_b`) */
    stockFutures: number;
    info: Dict;
}

/** `fetchMarketOverview` 결과(`IVSA0070`). */
export interface KbsecMarketOverview {
    /** 조회일시(`inq_dy_tm`) */
    queriedAt: string;
    kospi: KbsecMarketBreadth;
    kosdaq: KbsecMarketBreadth;
    /** 차익순매수(`mprft_nt_b`) */
    arbitrageNetBuy: number;
    /** 비차익순매수(`nmp_nt_b`) */
    nonArbitrageNetBuy: number;
    indices: KbsecOverviewIndex[];
    derivatives: KbsecOverviewDerivative[];
    globals: KbsecOverviewGlobal[];
    investors: KbsecOverviewInvestor[];
    info: Dict;
}

/**
 * KB 가 공식으로 제공하는 순위 분석 API는 9종이 넘는다(외국인/기관매매상위·프로그램매매상위·거래대금상위·업종랭킹 등). 지금은 그중
 * 일곱을 구현했다. 나머지는 `fetchRankings`가 `NotSupported`를 던진다.
 */
export type KbsecRankingType =
    | 'FLUCTUATION' | 'VOLUME' | 'PROGRAM_TRADING' | 'TRADING_VALUE' | 'OPEN_CHANGE_RATE'
    | 'EXTENDED_HOURS_CHANGE_RATE' | 'SURGE_PLUNGE';

/**
 * 순위 행 하나. 일곱 랭킹 TR이 공통으로 주는 필드만 정리했다. 나머지 원문은 `info`에 있다. 국내만 지원한다.
 */
export interface KbsecRankingItem {
    /**
     * 순위. 대부분(`IVU10240`·`IVU10280`·`IVS10920`·`IVU10210`·`IVS10910`)은 `rnk` 필드값이다. `IVS11190`·`IVU10270`은
     * 응답에 순위 필드가 없어(명세에 없음), 정렬구분 입력값대로 이미 정렬된 응답이라는 전제로 배열 순서(1부터)를 순위로 쓴다 —
     * 서버가 준 값이 아니라 추정값이다.
     */
    rank: number;
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 현재가(`now_prc`) */
    last: number;
    /** 전일대비(`bdy_cmpr`) */
    change: number;
    /** 등락율(`up_dwn_r_p2`) */
    percentage: number;
    /** 거래량(TR 마다 필드명이 다르다 — 등락률상위는 `vlm`, 거래량상위는 `acml_vlm`) */
    volume: number;
    info: Dict;
}

/** 환율 행 하나(`IVA60190`). `close`는 필드명(`cls_prc_p4`, 종가)대로 종가 기준이지 실시간이 아니다. */
export interface KbsecExchangeRate {
    /** 통화 코드(`crncy_cd`, 예: `USD`) */
    currency: string;
    /** 국가명(`ntn_nm`) */
    countryName: string;
    /** 통화 코드명(`crncy_cd_nm`) */
    currencyName: string;
    /** 종가(`cls_prc_p4`) */
    close: number;
    /** 전일대비(`bdy_cmpr_p4`) */
    change: number;
    /** 전일대비율(`bdy_cmpr_r_p2`) */
    percentage: number;
    info: Dict;
}

/** 세계지수 조회 범위(`lnd_clsf`). 공식 예제는 `MAJOR`(주요지수)를 기본값으로 쓴다. */
export type KbsecWorldIndexScope = 'MAJOR' | 'AMERICA' | 'EUROPE' | 'ASIA';

const KBSEC_WORLD_INDEX_SCOPE_CODE: Record<KbsecWorldIndexScope, string> = {
    MAJOR: '1', AMERICA: 'C', EUROPE: 'E', ASIA: 'S',
};

/** 세계지수 행 하나(`IVA60140`). */
export interface KbsecWorldIndex {
    /** 국가명(`ntn_nm`) */
    countryName: string;
    /** 종목코드(`is_cd`) */
    code: string;
    /** 종목코드명(`is_cd_nm`) */
    name: string;
    /** 종가(`cls_prc_p2`) */
    close: number;
    /** 전일대비(`bdy_cmpr_p2`) */
    change: number;
    /** 전일대비율(`bdy_cmpr_r_p2`) */
    percentage: number;
    info: Dict;
}

/** 종목 기업개요(`IVM10050`). 국내 종목만 지원한다. */
export interface KbsecCompanyProfile {
    /** 자본금(`cptl_amt`) */
    capital: number;
    /** 상장주식수(`lstng_stk_c`) */
    sharesOutstanding: number;
    /** 시가총액(`opn_prc_tl_amt`) */
    marketCap: number;
    /** 배당수익율(`dvdnd_yld_p2`) */
    dividendYield: number;
    /** PER(`per`). 명세상 다른 지표와 달리 문자 타입이다(사유 미상). 숫자로 못 읽으면 0이고, 원본은 `info.per`에 있다. */
    per: number;
    /** PBR(`pbr_p2`) */
    pbr: number;
    /** EPS(`eps_p2`) */
    eps: number;
    /** BPS(`bps_p2`) */
    bps: number;
    /** 외국인보유비중(`fgnr_hld_sgrvt_p2`, %) */
    foreignHoldingRate: number;
    info: Dict;
}

/**
 * 증시주변자금동향(`IVA10370`) 헤드라인 지표. 응답 48개 필드 중 고객예탁금·미수금·신용잔고·선물예수금만 정리했다.
 * 나머지(채권 수익율 10종과 각 전일대비)는 성격이 달라(금리, 자금 흐름이 아니다) `info`에만 남긴다. 국내만 지원한다.
 */
export interface KbsecMarketFundFlow extends KrTimestamped {
    /** 기준일자 `YYYYMMDD`(`dt`) */
    date: string;
    /** 고객예탁금(`cs_dpst`) */
    customerDeposit: number;
    /** 고객예탁금 전일대비(`cs_dpst_cmpr_amt`) */
    customerDepositChange: number;
    /** 미수금(`rcvamt`) */
    receivables: number;
    /** 미수금 전일대비(`rcvamt_cmpr_amt`) */
    receivablesChange: number;
    /** 신용잔고(`crdt_blnc`) */
    creditBalance: number;
    /** 신용잔고 전일대비(`crdt_blnc_cmpr_amt`) */
    creditBalanceChange: number;
    /** 선물예수금(`fts_tfnd`) */
    futuresDeposit: number;
    /** 선물예수금 전일대비(`fts_tfnd_cmpr_amt`) */
    futuresDepositChange: number;
    info: Dict;
}

/** 신고가/신저가 구분(`nw_stk_lw_ccd`). */
export type KbsecHighLowType = 'HIGH' | 'LOW';

const KBSEC_HIGH_LOW_TYPE_CODE: Record<KbsecHighLowType, string> = { HIGH: '1', LOW: '2' };

/** 신고가/신저가 행 하나(`IVU10550`). 국내만 지원한다. */
export interface KbsecHighLowItem {
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 현재가(`now_prc`) */
    last: number;
    /** 전일대비(`bdy_cmpr`) */
    change: number;
    /** 등락율(`up_dwn_r_p2`) */
    percentage: number;
    /** 거래량(`vlm`) */
    volume: number;
    /** 고가(`hgh_prc`) */
    high: number;
    /** 저가(`lw_prc`) */
    low: number;
    info: Dict;
}

/** 투자자구분코드(`invstr_ccd`). */
export type KbsecInvestorCode =
    | 'FOREIGNER' | 'INSTITUTION' | 'FOREIGNER_INSTITUTION' | 'SECURITIES' | 'INSURANCE'
    | 'INVESTMENT_TRUST' | 'PRIVATE_EQUITY' | 'BANK' | 'MERCHANT_BANK' | 'FUND'
    | 'OTHER' | 'GOVERNMENT' | 'INDIVIDUAL' | 'OTHER_FOREIGNER';

const KBSEC_INVESTOR_CODE: Record<KbsecInvestorCode, string> = {
    FOREIGNER: '0', INSTITUTION: '1', FOREIGNER_INSTITUTION: '2', SECURITIES: '3', INSURANCE: '4',
    INVESTMENT_TRUST: '5', PRIVATE_EQUITY: '6', BANK: '7', MERCHANT_BANK: '8', FUND: '9',
    OTHER: 'A', GOVERNMENT: 'B', INDIVIDUAL: 'C', OTHER_FOREIGNER: 'D',
};

/** 순위구분(`rnk_clsf`). */
export type KbsecInvestorRankingType = 'BUY' | 'SELL' | 'HOLDING_UP' | 'HOLDING_DOWN' | 'CONSECUTIVE_BUY' | 'CONSECUTIVE_SELL';

const KBSEC_INVESTOR_RANKING_TYPE_CODE: Record<KbsecInvestorRankingType, string> = {
    BUY: '0', SELL: '1', HOLDING_UP: '2', HOLDING_DOWN: '3', CONSECUTIVE_BUY: '4', CONSECUTIVE_SELL: '5',
};

/** 외국인·기관매매상위 행 하나(`IVU10020`). 국내만 지원한다. 27개 응답 필드 중 뜻이 명확한 것만 정리했다(나머지는 `info`). */
export interface KbsecInvestorRankingItem {
    /** 통합 심볼(`005930/KRW`) */
    symbol: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 현재가(`now_prc`) */
    last: number;
    /** 전일대비(`bdy_cmpr`) */
    change: number;
    /** 전일대비율(`bdy_cmpr_r_p2`) */
    percentage: number;
    /** 거래량(`vlm`) */
    volume: number;
    /** 순매수·순매도 수량(`nt_b_s_q`) — 방향은 조회한 `rnk_clsf`를 따른다. */
    netQuantity: number;
    /** 보유율(`hld_rt_p2`, %) */
    holdingRate: number;
    info: Dict;
}

/**
 * 그리드를 필드 이름으로 가를 수 없는 TR 의 응답 원문(`fetchOneMarketMarginUsage`, `fetchDepositDetails`).
 * 배열이 아닌 필드는 `fields`에, 배열(그리드)은 응답에 나온 순서대로 `grids`에 담는다. 그리드마다 무엇인지는 명세에 없다.
 */
export interface KbsecRawResponse {
    fields: Dict;
    grids: Dict[][];
    info: Dict;
}

/** 응답 본문을 배열이 아닌 필드와 그리드(배열)로 나눈다. */
function kbsecRawResponse(body: Dict): KbsecRawResponse {
    const fields: Dict = {};
    const grids: Dict[][] = [];
    for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value)) grids.push(value as Dict[]);
        else fields[key] = value;
    }
    return { fields, grids, info: body };
}

/** 테마그룹 한 줄(`IVS11430`). 국내만 지원한다. */
export interface KbsecThemeGroup {
    /** 테마코드(`thm_cd`) */
    code: string;
    /** 테마명(`thm_nm`) */
    name: string;
    /** 지수(`indx_p2`) */
    index: number;
    /** 전일대비(`bdy_cmpr_p2`) 원문 값. 전일대비구분코드(`bdy_cmpr_ccd`)는 `info`에 있다 */
    change: number;
    /** 전일대비등락율(`bdy_cmpr_up_dwn_r_p2`, %) */
    percentage: number;
    /** 시가총액(`opn_prc_tl_amt`) */
    marketCap: number;
    /** 시가총액전일대비(`opn_prc_tl_amt_bdy_cmpr`) */
    marketCapChange: number;
    /** 거래량(`vlm`, 주) */
    volume: number;
    /** 거래대금(`dl_tw_amt`, 백만원) */
    tradingValue: number;
    /** 테마종목수(`thm_is_c`) */
    stockCount: number;
    info: Dict;
}

/** 업종랭킹(`IVM30010`)의 시장. */
export type KbsecSectorMarket = 'KOSPI' | 'KOSDAQ';

const KBSEC_SECTOR_MARKET_CODE: Record<KbsecSectorMarket, string> = { KOSPI: '1', KOSDAQ: '2' };

/** 업종랭킹(`IVM30010`)의 지수 하나. 전일대비는 원문 값이고, 전일대비구분코드(`bdy_cmpr_ccd`)는 `info`에 있다. */
export interface KbsecSectorIndex {
    /** 지수ID(`indx_id`) */
    id: string;
    /** 지수명(`indx_nm`) */
    name: string;
    /** 현재지수(`now_indx_p2`) */
    value: number;
    /** 전일대비(`bdy_cmpr_p2`) */
    change: number;
    /** 등락율(`up_dwn_r_p2`, %) */
    percentage: number;
    info: Dict;
}

/**
 * `fetchSectorRanking` 결과. 실계좌 응답은 머리 레코드 하나(시장 지수)와 업종 지수 배열(`out2`)이었다. 명세의 "같은 필드 그리드 둘"이
 * 이 두 부분이다.
 */
export interface KbsecSectorRanking {
    /** 머리 레코드의 지수. 실계좌 코스피 조회에서는 `KGG01P`였다 */
    market: KbsecSectorIndex;
    /** 업종 지수 행 */
    sectors: KbsecSectorIndex[];
    info: Dict;
}

function kbsecSectorIndex(row: Dict): KbsecSectorIndex {
    return {
        id: pickStr(row, 'indx_id'),
        name: pickStr(row, 'indx_nm'),
        value: pickNum(row, 'now_indx_p2'),
        change: pickNum(row, 'bdy_cmpr_p2'),
        percentage: pickNum(row, 'up_dwn_r_p2'),
        info: row,
    };
}

/** 해외 차트(`GSC10060`)의 차트구분. */
export type KbsecOverseasChartType = 'tick' | 'minute' | 'day' | 'week' | 'month' | 'year';

const KBSEC_OVERSEAS_CHART_CODE: Record<KbsecOverseasChartType, string> = { tick: '1', minute: '2', day: '3', week: '4', month: '5', year: '6' };
/** 해외 차트 종류 가운데 기간 봉의 타임프레임. 틱과 분봉은 없다. */
const KBSEC_OVERSEAS_CHART_PERIOD: Partial<Record<KbsecOverseasChartType, string>> = { day: '1d', week: '1w', month: '1M', year: '1y' };

/** 해외 차트 레코드수 상한(명세의 최대요청개수) */
const KBSEC_OVERSEAS_CHART_MAX = 5000;

/** 해외 차트(`GSC10060`) 봉 하나. 일자와 시간은 미국 동부 현지 시각이다(실계좌 확인). */
export interface KbsecOverseasCandle extends KrTimestamped {
    /** 봉 시각(UTC 밀리초). 현지 일자와 시간을 서머타임을 반영해 바꿨다. 일봉은 현지 자정이다 */
    timestamp: number | undefined;
    /** 일자(`dt`) 원문 */
    date: string;
    /** 시간(`tm`) 원문 */
    time: string;
    /** 시가(`opn_prc_p4`) */
    open: number;
    /** 고가(`hgh_prc_p4`) */
    high: number;
    /** 저가(`lw_prc_p4`) */
    low: number;
    /** 종가(`cls_prc_p4`) */
    close: number;
    /** 거래량(`vlm`) */
    volume: number;
    /** 거래대금(`dl_tw_amt`) */
    tradingValue: number;
    info: Dict;
}

/** `fetchOverseasCandles` 결과. */
export interface KbsecOverseasCandles {
    /** 그리드 앞에 오는 필드 원문(종목명, 현재가, 시세구분 등). 실계좌의 시세구분(`mrkt_prc_clsf`)은 `15분지연`이었다 */
    fields: Dict;
    candles: KbsecOverseasCandle[];
}

/** 원마켓플러스 매매정산현황 상세(`SKQO3390`) 한 줄. 항목데이터 1~4가 무엇인지 명세에 없어 원문 문자열로 둔다. */
export interface KbsecOneMarketSettlementItem {
    /** 인덱스(`idx`) */
    index: string;
    /** ISO코드(`iso_cd`) */
    isoCode: string;
    /** 통화코드(`crncy_cd`) */
    currency: string;
    /** 항목한글명(`item_hngl_nm`) */
    name: string;
    /** 항목영문명(`item_eng_nm`) */
    englishName: string;
    /** 항목데이터1~4(`item_data1`~`item_data4`) 원문 */
    values: string[];
    info: Dict;
}

/** 원마켓플러스 주문가능금액 현황(`SKQM3350`)의 통화별 한 줄. 금액은 그 통화 기준이다. */
export interface KbsecOneMarketCurrencyBuyingPower {
    /** 통화코드(`crncy_cd`) */
    currency: string;
    /** 국가명(`ntn_nm`) */
    country: string;
    /** 외화예수금(`fcrncy_tfnd`) */
    deposit: number;
    /** 외화사용가능금액(`fcrncy_use_psbl_amt_p2`) */
    usable: number;
    /** 외화통합주문가능금액(`fcrncy_unty_ordr_psbl_amt_p2`) */
    unifiedOrderable: number;
    /** 외화미수주문가능금액(`fcrncy_rcvbl_ordr_psbl_amt_p2`) */
    receivableOrderable: number;
    info: Dict;
}

/** 원마켓플러스 주문가능금액 현황(`SKQM3350`). 머리 금액은 필드 이름대로 원화다. */
export interface KbsecOneMarketBuyingPower {
    /** 국내원주문가능금액(`dmstc_orgn_ordr_psbl_amt`) */
    domesticOrderable: number;
    /** 국내제공사용가능원화금액(`dmstc_ofr_use_psbl_krw_amt`) */
    domesticProvidedKrw: number;
    /** 국내타통화사용금액(`dmstc_otr_crncy_use_amt`) */
    domesticOtherCurrencyUsed: number;
    /** 외화예수금원화환산금액(`fcr_tfnd_krw_exch_amt`) */
    foreignDepositInKrw: number;
    /** 해외주식미결제합계원화금액(`frsk_ust_sum_krw_amt`) */
    unsettledOverseasInKrw: number;
    /** 환전대상원화주문증거금(`exch_mny_trgt_krw_ordr_mgn`) */
    exchangeOrderMarginKrw: number;
    currencies: KbsecOneMarketCurrencyBuyingPower[];
    info: Dict;
}

/**
 * 해외 주문가능금액(`SPQM2106`, 원마켓이 아닌 계좌용). 금액은 필드 이름대로 외화와 원화로 나눈다.
 * 통화가 이름에 없는 금액(`ordr_psbl_amt_p2`, `pcnt100_ordr_psbl_amt`)은 `info`에만 있다.
 */
export interface KbsecOverseasOrderable {
    /** 외화주문가능금액(`fcrncy_ordr_psbl_amt`) */
    foreignAmount: number;
    /** 원화주문가능금액(`krw_ordr_psbl_amt`) */
    krwAmount: number;
    /** 주문가능수량(`ordr_psbl_q`) */
    maxQuantity: number;
    /** 100퍼센트주문가능수량(`pcnt100_ordr_psbl_q`) */
    fullMarginQuantity: number;
    /** 해외주문가격(`frgn_ordr_prc_p4`) */
    price: number;
    /** 종목증거금율(`is_mgn_r_p4`) */
    marginRate: number;
    /** 적용증거금율(`aplc_mgn_r_p4`) */
    appliedMarginRate: number;
    info: Dict;
}

/**
 * 해외 체결현황 한 줄(`SPQM2204`). `fetchOverseasOrders`(`SPQM1818`)와 같은 모양이고 단축종목코드가 더 있다.
 * 종목명(`name`)은 단축종목명(`shrt_is_nm`)이다.
 */
export interface KbsecOverseasOrderStatusEntry extends KbsecOverseasOrderEntry {
    /** 단축종목코드(`shrt_is_cd`) */
    shortCode: string;
}

export interface KbsecOverseasOrderStatusFetch {
    rows: KbsecOverseasOrderStatusEntry[];
    truncated: boolean;
}

/** 종합계좌 잔고현황(`SSQM2932`)의 종목 한 줄. */
export interface KbsecIntegratedHolding {
    /** 종목코드(`is_cd`) */
    code: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 상품유형(`gds_typ`) 원문 */
    productType: string;
    /** 구분(`clsf`) 원문, 예: 현금 */
    kind: string;
    /** 통화코드(`crncy_cd`). 실계좌의 국내 종목 행은 빈 값이었다 */
    currency: string;
    /** 잔고수량(`blnc_q_p6`). 같은 이름의 `blnc_q`는 실계좌에서 값이 달라 쓰지 않는다 */
    quantity: number;
    /** 주문가능수량(`ordr_psbl_q_p6`) */
    orderableQuantity: number;
    /** 매입평균가(`byng_avr_prc`) */
    averagePrice: number;
    /** 현재가(`now_prc`) */
    price: number;
    /** 평가금액(`val_amt`) */
    valuation: number;
    /** 손익금액(`pl_amt`) */
    pnl: number;
    /** 수익율(`yld`) */
    returnRate: number;
    info: Dict;
}

/**
 * `fetchIntegratedBalance` 결과(`SSQM2932`). 실계좌 표본(국내 6행)에서 평가금액 = 잔고수량 × 현재가, 머리 평가금액합계 = 행 합계가 성립했다.
 * 통화코드가 있는 해외 행은 표본이 없어 금액이 그 통화 기준인지 원화 환산인지 확인하지 못했다.
 */
export interface KbsecIntegratedBalance {
    /** 평가금액합계(`val_amt_sum`) */
    valuation: number;
    /** 매입금액합계(`byng_amt_sum`) */
    purchaseAmount: number;
    /** 손익금액합계(`pl_amt_sum`) */
    pnl: number;
    /** 예수금(`tfnd`) */
    deposit: number;
    /** 주문가능현금(`ordr_psbl_csh`) */
    orderableCash: number;
    /** 출금가능금액(`o_amt_psbl_amt`) */
    withdrawable: number;
    holdings: KbsecIntegratedHolding[];
    info: Dict;
}

/** 공휴일관리(`SPAM2508`) 한 줄. 월, 영업일, 공휴일, 결제일 필드의 형식이 명세에 없어 원문으로 둔다. */
export interface KbsecHolidayRow {
    /** 월(`mm`) */
    month: string;
    /** 영업일(`bsnss_dy`) */
    businessDay: string;
    /** 공휴일(`hldy`) */
    holiday: string;
    /** 결제일(`stmt_dy`) */
    settlementDay: string;
    /** 익영업일(`nxt_bsnss_dy`) */
    nextBusinessDay: string;
    /** 익결제일자(`nxt_stlmt_dt`) */
    nextSettlementDate: string;
    /** 해외주식주문가능여부(`frgn_stk_ordr_psbl_f`) 원문 */
    overseasOrderable: string;
    info: Dict;
}

/** `fetchHolidays` 결과. */
export interface KbsecHolidays {
    /** 그리드 앞에 오는 필드 원문(익영업일, 익결제일자) */
    fields: Dict;
    rows: KbsecHolidayRow[];
}

/** 총 잔고 조회(`SSQM0005`)의 계좌 한 줄. */
export interface KbsecAccountSummaryRow {
    /** 계좌번호(`ac_no`) */
    accountNumber: string;
    /** 계좌별명(`ac_ncknm`) */
    nickname: string;
    /** 상품유형코드(`gds_typ_cd`) 원문 */
    productTypeCode: string;
    /** 상품유형상세명(`gds_typ_dtls_nm`) */
    productTypeName: string;
    /** 상품상태구분코드(`gds_st_ccd`) 원문 */
    statusCode: string;
    /** 평가액(`val_amt`) */
    valuation: number;
    /** 예수금액(`tfnd_amt`) */
    deposit: number;
    /** 출금가능금액(`o_amt_psbl_amt`) */
    withdrawable: number;
    /** 익익일예수금(`nxt2_dy_tfnd`) */
    dayAfterNextDeposit: number;
    /** 최종거래일자(`fnl_dl_dt`) */
    lastTradeDate: string;
    info: Dict;
}

export interface KbsecAccountSummaryFetch {
    rows: KbsecAccountSummaryRow[];
    truncated: boolean;
}

/** 주식자산평가 실시간(`SSQN2952`)의 종목 한 줄. */
export interface KbsecRealtimeAssetHolding {
    /** 단축종목코드(`shrt_is_cd`) */
    shortCode: string;
    /** 표준종목코드(`stnd_is_cd`) */
    standardCode: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 신용유형명(`crdt_typ_nm`) */
    creditTypeName: string;
    /** 잔고수량(`blnc_q_p6`) */
    quantity: number;
    /** 주문가능수량(`ordr_psbl_q_p6`) */
    orderableQuantity: number;
    /** 매입평균가(`byng_avr_prc`) */
    averagePrice: number;
    /** 매입금액(`byng_amt`) */
    purchaseAmount: number;
    /** 현재가(`now_prc`) */
    price: number;
    /** 평가금액(`val_amt`) */
    valuation: number;
    /** 평가손익(`val_pl`) */
    unrealizedPnl: number;
    /** 평가수익율(`val_yld`) */
    returnRate: number;
    info: Dict;
}

/** `fetchRealtimeAssetValuation` 결과. */
export interface KbsecRealtimeAssetValuation {
    /** 당일실현손익(`thdy_rlztn_pl`) */
    realizedPnlToday: number;
    /** 매입금액합계(`byng_amt_sum`) */
    purchaseAmount: number;
    /** 총신용대출금액(`tl_crdt_ln_amt`) */
    creditLoan: number;
    /** 익일예수금(`ndy_tfnd`) */
    nextDayDeposit: number;
    /** 익익일예수금(`nxt2_dy_tfnd`) */
    dayAfterNextDeposit: number;
    holdings: KbsecRealtimeAssetHolding[];
    info: Dict;
}

/**
 * 해외 소수점 주문접수내역(`SPQM5473`) 한 줄. 금액과 가격 필드(`dl_amt`, `ordr_prc`, `ccls_prc`, `ccls_amt`, `fee`, `ec_amt`)는 원화인지 외화인지
 * 명세로 가를 수 없어 `info`에만 둔다.
 */
export interface KbsecOverseasFractionalOrderEntry {
    /** 매매일자(`trd_dt`) */
    date: string;
    /** 접수번호(`acpt_no`) */
    acceptNumber: string;
    /** 단축종목코드(`shrt_is_cd`) */
    shortCode: string;
    /** 표준종목코드(`stnd_is_cd`) */
    standardCode: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 통화코드(`crncy_cd`) */
    currency: string;
    /** 매매구분명(`trd_clsf_nm`) 원문 */
    sideName: string;
    /** 주문상태(`ordr_st`) 원문 코드 */
    orderStatus: string;
    /** 처리상태(`hndl_st`) 원문 코드 */
    processStatus: string;
    /** 주문수량(`ordr_q`) */
    quantity: number;
    /** 체결수량(`ccls_q`) */
    filledQuantity: number;
    /** 주문접수시간(`ordr_acpt_tm`) */
    acceptTime: string;
    info: Dict;
}

export interface KbsecOverseasFractionalOrderHistoryFetch {
    rows: KbsecOverseasFractionalOrderEntry[];
    truncated: boolean;
}

/** 종목별기간실현손익(`SSQM2443`)의 매체구분. 설명대로 오프라인 `1`, 온라인 `2`, 지점 `3`이다. */
export type KbsecMediaClass = 'OFFLINE' | 'ONLINE' | 'BRANCH';

const KBSEC_MEDIA_CLASS_CODE: Record<KbsecMediaClass, string> = { OFFLINE: '1', ONLINE: '2', BRANCH: '3' };

/** 일자별실현손익상세(`SSQM2442`) 한 줄. 국내만 지원한다. */
export interface KbsecDailyRealizedPnlRow extends KrTimestamped {
    /** 매매일자(`trd_dt`) */
    date: string;
    /** 단축종목코드(`shrt_is_cd`) */
    shortCode: string;
    /** 표준종목코드(`stnd_is_cd`) */
    standardCode: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 신용유형코드(`crdt_typ_cd`) 원문 */
    creditTypeCode: string;
    /** 매매거래구분코드(`trd_dl_ccd`) 원문 */
    tradeTypeCode: string;
    /** 체결수량(`ccls_q`) */
    quantity: number;
    /** 체결단가(`ccls_uprc`) */
    price: number;
    /** 매수단가(`b_uprc`) */
    buyPrice: number;
    /** 매도금액(`s_amt`) */
    sellAmount: number;
    /** 매수금액(`b_amt`) */
    buyAmount: number;
    /** 수수료(`fee`) */
    fee: number;
    /** 제세금(`svrl_tx`) */
    tax: number;
    /** 실현손익(`rlztn_pl`) */
    realizedPnl: number;
    /** 수익율(`yld`) */
    returnRate: number;
    info: Dict;
}

export interface KbsecDailyRealizedPnlFetch {
    rows: KbsecDailyRealizedPnlRow[];
    truncated: boolean;
}

/** 종목별기간실현손익(`SSQM2443`) 한 줄. 국내만 지원한다. */
export interface KbsecSymbolRealizedPnlRow {
    /** 종목코드(`is_cd`) */
    code: string;
    /** 단축종목코드(`shrt_is_cd`) */
    shortCode: string;
    /** 종목명(`is_nm`) */
    name: string;
    /** 실현손익(`rlztn_pl`) */
    realizedPnl: number;
    /** 손익율(`pl_r`) */
    pnlRate: number;
    /** 당일매도수량(`thdy_s_q`). 명세의 이름을 그대로 옮겼다 */
    sellQuantity: number;
    /** 매도체결단가(`s_ccls_uprc`) */
    sellPrice: number;
    /** 매도금액(`s_amt`) */
    sellAmount: number;
    /** 매도수수료(`s_fee`) */
    sellFee: number;
    /** 매도제세금(`s_svrl_tx`) */
    sellTax: number;
    /** 매수평균단가(`b_avr_uprc`) */
    buyAveragePrice: number;
    /** 매수금액(`b_amt`) */
    buyAmount: number;
    /** 매수수수료(`b_fee`) */
    buyFee: number;
    info: Dict;
}

export interface KbsecSymbolRealizedPnlFetch {
    rows: KbsecSymbolRealizedPnlRow[];
    truncated: boolean;
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
    averagePrice?: number | undefined;
    marketValue: number;
    name?: string | undefined;
}

const NO_ORDER_ID = '';

/** 조건(스톱) 주문을 뜻하는 `createOrder` 인자. `createOrder` 는 조건 인자를 받지 않으므로 하나라도 있으면 거절한다. 스탑지정가는 `createTriggerOrder` 로 낸다. */
const UNSUPPORTED_CONDITIONAL_PARAMS = ['triggerPrice', 'stopPrice', 'stopLossPrice', 'takeProfitPrice', 'stopLoss', 'takeProfit'] as const;

// 암묵 API 메서드(`privatePostIvu10140` 등)의 선언이다. `abstract/kbsec.ts` 가 엔드포인트 표(`spec/kbsec.json`)에서 만든다.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface kbsec extends KbsecImplicitApi {}

export class kbsec extends Exchange {
    /** 발급한 토큰을 들고 있는 인증 객체. 앱키·시크릿이 바뀌면 다시 만든다. */
    private authInstance: KbsecAuth | undefined = undefined;
    private authIdentity = '';

    /** 해외 종목의 KB 거래소코드(`krx_cd`). 심볼당 한 번 탐색해 캐시한다. NYSE 종목이 섞여 있어 `NAS` 로 고정하면 안 된다. */
    private readonly usExchangeCache = new Map<string, string>();
    /** 평가금액 산출용 현재가 캐시(code → 가격·조회 시각). */
    private readonly holdingPriceCache = new Map<string, { price: number; at: number }>();
    /** NXT 미상장이 실측으로 확인된 종목(인스턴스 수명). 거부 응답으로 역산하며 영속화하지 않는다. 재시작이 캐시 만료다. */
    private readonly nxtIneligible = new Set<string>();
    /** 조회일자 되감기 캐시(시장별, 그 시장 날짜별). 연휴에 호출마다 같은 실패를 반복하지 않게 한다. 국내와 해외는 날짜 축이 달라 따로 둔다. */
    private businessDateBackoff: Record<'KR' | 'US', { day: string; steps: number }> = { KR: { day: '', steps: 0 }, US: { day: '', steps: 0 } };
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
    /** 일시 오류 뒤 원마켓 증거금을 다시 부르기 전까지 기다리는 시각(epoch ms). 0 이면 대기 없음. */
    private oneMarketRetryAt = 0;
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
                ws: false,
                watchTicker: false,
                watchTrades: false,
                watchOrderBook: false,
                watchOrders: false,
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
                // 국내만 지원한다. 해외 차트는 15분 지연 시세라 `NotSupported` 이고 `fetchOverseasCandles` 로 준다.
                fetchOHLCV: true,
                fetchBalance: true,
                createOrder: true,
                createLimitOrder: true,
                createMarketOrder: true,
                createTriggerOrder: true,
                editOrder: true,
                cancelOrder: true,
                cancelAllOrders: 'emulated',
                fetchOrder: true,
                fetchOrders: true,
                fetchOpenOrders: true,
                fetchClosedOrders: true,
                fetchCanceledOrders: false,
                fetchMyTrades: true,
                fetchTrades: true,
                // KB 에 수수료 조회 TR 이 없어 공시 요율로 추정한다.
                fetchTradingFee: 'emulated',
                fetchStatus: false,
                fetchTime: false,
                // 주식 고유. 장운영상태 TR 로 전·기준·익영업일을 받아 휴장일 캘린더를 채운다.
                fetchMarketCalendar: true,
                fetchStockWarnings: true,
                fetchInvestorTrading: true,
                fetchRankings: true,
                createMarketBuyOrderWithCost: true,
                createConditionalOrder: false,
            },
            urls: {
                api: { private: KBSEC_API_BASE },
                www: 'https://openapi.kbsec.com',
                doc: ['https://openapi.kbsec.com', 'https://github.com/kbsecurities/kb-openapi'],
            },
            // 엔드포인트 표(`spec/kbsec.json`)에서 만든 트리다. 이 클래스가 부르는 TR 이고, 주문을 바꾸는 TR 은 `order: true` 다.
            // TR 은 표에 더한다. 주문 TR 목록(`KBSEC_ORDER_TR_CODES`)과 `order` 표시가 맞는지는 테스트가 본다.
            api: KBSEC_API_TREE,
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
                /** 계좌원장 연속조회 페이지 상한. 기간이 길면 걸릴 수 있고, 걸리면 `truncated` 로 알린다(기간을 좁혀 다시 부른다). */
                ledgerMaxPages: 20,
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
                /** 정규장 안의 국내 주문을 SOR(KRX·NXT 중 유리한 쪽)로 보낸다. 정규장 밖 주문은 세션 게이트가 `MarketClosed` 로 막는다. */
                nxtRouting: undefined,
                /**
                 * 원마켓(통합증거금) 계좌의 미국 주식 매수여력을 원화 환산분으로 보강한다. 원마켓 계좌는 USD 로 미리 환전하지 않고 원화로 미국 주식을 산다.
                 * 켜면 `krw_exch_unty_ordr_psbl_amt`(원화환산 통합 주문가능금액)를 기준으로 읽고, 끄면 외화 예수금(`fcrncy_ordr_psbl_amt`)만 본다.
                 * 계좌가 원마켓에 가입돼 있어야 뜻이 있으므로 계좌를 확인한 뒤 켠다.
                 */
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
    /**
     * TR 본문 `dataHeader` 에 싣는 호스트 주소. `options.hostAddr`(`{ ipAddr, macAddr }`)로 준 값을 쓰고, 빠진 값만 이 호스트에서 모은다.
     * KB 는 빈 값을 받지 않는다.
     */
    private hostAddr(): { ipAddr: string; macAddr: string } {
        const given = this.safeDict(this.options, 'hostAddr', {}) as Dict;
        const auto = kbsecHostAddr();
        return { ipAddr: this.safeString(given, 'ipAddr') || auto.ipAddr, macAddr: this.safeString(given, 'macAddr') || auto.macAddr };
    }

    private getAuth(): KbsecAuth {
        const identity = `${this.apiKey}\u0000${this.secret}`;
        if (this.authInstance === undefined || identity !== this.authIdentity) {
            const api = this.urls.api;
            const baseUrl = typeof api === 'string' ? api : (api?.private ?? KBSEC_API_BASE);
            // 토큰 발급은 자체 전송 경로라 여기서 주소를 확인한다.
            assertSecureUrl(this.id, baseUrl, this.options.allowInsecureUrl === true);
            this.authInstance = new KbsecAuth({ appKey: this.apiKey as string, appSecret: this.secret as string, accountNo: this.uid }, baseUrl, () => this.getTokenStore());
            this.authIdentity = identity;
        }
        return this.authInstance;
    }

    /** 인스턴스 시계(`milliseconds()`)로 본 오늘의 한국 날짜 `YYYYMMDD`. */
    private todayKst(): string {
        return kbsecDateKst(new Date(this.milliseconds()));
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
                dataHeader: this.hostAddr(),
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
        throwIfTokenBreakerOpen((this.apiKey as string), trCode);
        // 요청마다 새 헤더 객체를 쓴다. `authenticate` 가 여기에 토큰을 싣고, 실패했을 때 어느 토큰이었는지 여기서 읽는다.
        const requestHeaders: Dictionary<string> = { ...headers };
        try {
            const response = await super.fetch2(path, api, method, params, requestHeaders, body, config);
            recordKbsecCallOk((this.apiKey as string));
            return response;
        } catch (error) {
            const tokenFailed = error instanceof AuthenticationError && error.detail === KBSEC_ERROR_DETAIL.TOKEN_INVALID;
            if (!tokenFailed) {
                // 응답을 읽고 던진 오류(업무 거절)는 토큰이 통했다는 뜻이므로 차단기를 푼다. 전송 실패는 아무것도 알려 주지 않는다.
                if (error instanceof ExchangeError) recordKbsecCallOk((this.apiKey as string));
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
            recordTokenFailure((this.apiKey as string), trCode, KBSEC_ERROR_DETAIL.TOKEN_INVALID);
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
        const header = safeDict(response, 'dataHeader') as KbsecResponseHeader | undefined;
        const trCode = (url.split('/').pop() ?? '').toUpperCase();
        if (isKbsecBusinessError(header)) {
            const processCode = String(header?.processCode ?? '').trim();
            const processMessage = String(header?.processMessage ?? '').trim();
            const feedback = `KB증권 업무 오류 (${trCode}): ${processMessage} [processCode=${processCode}]`;
            const detail = kbsecErrorDetail(processCode);
            this.throwExactlyMatchedException((this.exceptions as Dict).exact, processCode, feedback, { detail });
            throw new ExchangeError(feedback);
        }
        if (isKbsecTokenFailure(statusCode, header)) {
            throw new AuthenticationError(`${this.id} ${method} ${url} ${statusCode} 토큰이 무효다`, { detail: KBSEC_ERROR_DETAIL.TOKEN_INVALID });
        }
        if (statusCode >= 200 && statusCode < 300 && response === undefined) {
            throw new BadResponse(`KB증권 응답이 JSON 이 아님 (${trCode}): ${responseBody.slice(0, 200)}`);
        }
        return undefined;
    }

    /** TR 을 호출하고 봉투에서 `dataBody` 를 꺼낸다. 오류는 `handleErrors` 가 던진다. */
    private async callTr(trCode: string, dataBody: Dict = {}): Promise<Dict> {
        const implicitMethod = this.implicitApiMethod(implicitMethodName(['private'], 'POST', trCode.toLowerCase()));
        if (implicitMethod === undefined) throw new NotSupported(`${this.id} 에 없는 TR 이다: ${trCode}`);
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

    /** 종목기본정보(`SIQM4900`) 원문 한 행. `fetchStocks`·`fetchStockWarnings`가 함께 쓴다. 국내만 지원한다. */
    private async fetchSecurityInfo(symbol: string, params: Dict = {}): Promise<Dict> {
        const market = this.market(symbol);
        if (this.isUs(market)) throw new NotSupported(`${this.id} fetchStocks() 는 국내 종목만 지원한다: ${symbol}`);
        return this.callTr(KBSEC_TR.SECURITY_INFO, { stnd_is_cd: market.id, ...params });
    }

    /** 종목 상세(이름·유형). 종목마다 요청을 하나씩 보낸다(KB API에 여러 종목을 한 번에 묻는 방법이 없다). 국내만 지원한다. */
    async fetchStocks(symbols: string[], params: Dict = {}): Promise<KbsecStockInfo[]> {
        return Promise.all(symbols.map(async (symbol) => {
            const row = await this.fetchSecurityInfo(symbol, params);
            return {
                symbol,
                standardCode: safeString(row, 'stnd_is_cd') || undefined,
                shortCode: safeString(row, 'shrt_is_cd') || undefined,
                name: safeString(row, 'hngl_is_nm') || undefined,
                shortName: safeString(row, 'hngl_shrt_nm') || undefined,
                englishName: safeString(row, 'eng_is_nm') || undefined,
                typeName: safeString(row, 'is_typ_nm') || undefined,
                detailTypeName: safeString(row, 'is_dtl_typ_nm') || undefined,
                info: row,
            };
        }));
    }

    /** 매매제한·위험등급. `fetchStocks`와 같은 TR(`SIQM4900`)을 다시 부른다. 국내만 지원한다. */
    async fetchStockWarnings(symbol: string, params: Dict = {}): Promise<KbsecStockWarning> {
        const row = await this.fetchSecurityInfo(symbol, params);
        return {
            tradingRestriction: safeString(row, 'trd_rstn_clsf_nm') || undefined,
            tradingRestrictionStart: safeString(row, 'trd_rstn_strt_dt') || undefined,
            tradingRestrictionEnd: safeString(row, 'trd_rstn_end_dt') || undefined,
            depositWithdrawalRestriction: safeString(row, 'io_rstn_clsf_nm') || undefined,
            riskGradeCode: safeString(row, 'rsk_grd_clsf_cd') || undefined,
            riskGradeName: safeString(row, 'rsk_grd_nm') || undefined,
            info: row,
        };
    }

    /**
     * 종목별 투자자 매매동향(`IVU10430`). 개인·외국인·기관 등 13개 유형을 하루 단위로 준다. 국내만 지원한다.
     * 기본은 오늘(KST) 하루, 순매수(`trd_clsf='1'`), 금액 기준(`amt_q_clsf='1'`)이다. `since`와 `params.until`로 기간을 넓히고,
     * `params`로 `trd_clsf`(1순매수·2매수·3매도)나 `amt_q_clsf`(1금액·2수량)를 덮어쓸 수 있다.
     */
    async fetchInvestorTrading(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<KbsecInvestorTradingRecord[]> {
        const [until, query] = this.handleUntilParam('fetchInvestorTrading', limit, params);
        const market = this.market(symbol);
        if (this.isUs(market)) throw new NotSupported(`${this.id} fetchInvestorTrading() 는 국내 종목만 지원한다: ${symbol}`);
        const today = kbsecDateKst(new Date(this.milliseconds()));
        const body = await this.callTr(KBSEC_TR.INVESTOR_TRADING, {
            excg_clsf: '1',
            is_cd: market.id,
            strt_dt: since !== undefined ? kbsecDateKst(new Date(since)) : today,
            end_dt: until !== undefined ? kbsecDateKst(new Date(until)) : today,
            amt_q_clsf: '1',
            trd_clsf: '1',
            acml_clsf: '0',
            ...query,
        });
        return this.limitRows(pickArray(body).map((row) => ({
            ...this.kstStamp(pickStr(row, 'dt')),
            date: pickStr(row, 'dt'),
            close: pickNum(row, 'cls_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'vlm'),
            amounts: {
                individual: pickNum(row, 'indv'),
                foreign: pickNum(row, 'fgnr'),
                institution: pickNum(row, 'ogn'),
                securities: pickNum(row, 'scrt'),
                insurance: pickNum(row, 'insr'),
                investmentTrust: pickNum(row, 'invst_trst'),
                merchantBank: pickNum(row, 'invst_bnk'),
                bank: pickNum(row, 'bnk'),
                fund: pickNum(row, 'fnd'),
                privateFund: pickNum(row, 'prv_o_fnd'),
                otherCorporate: pickNum(row, 'etc_corp'),
                government: pickNum(row, 'ntn'),
                nativeForeign: pickNum(row, 'ntv_fgnr'),
                program: pickNum(row, 'pgm'),
                foreignBrokerTotal: pickNum(row, 'frgn_afflt_dl_orgn_sum'),
            },
            info: row,
        })), since, limit);
    }

    /**
     * 당일 주요 외국계 거래원(`IVU10420`). 종목 하나의 매도 상위와 매수 상위 외국계 거래원을 줄마다 짝지어 준다. 국내만 지원한다.
     * 거래소 구분(`excg_clsf`)은 다른 국내 조회처럼 KRX(`1`)로 보내고 `params`로 바꿀 수 있다(`0` 통합, `2` NXT).
     * 응답에 순위 필드가 없어 줄 순서를 그대로 둔다. 매도와 매수 거래원이 모두 빈 줄은 거른다.
     */
    async fetchForeignBrokers(symbol: string, params: Dict = {}): Promise<KbsecForeignBrokerRow[]> {
        const market = this.market(symbol);
        if (this.isUs(market)) throw new NotSupported(`${this.id} fetchForeignBrokers() 는 국내 종목만 지원한다: ${symbol}`);
        const body = await this.callTr(KBSEC_TR.FOREIGN_BROKERS, { excg_clsf: '1', is_cd: market.id, ...params });
        const flow = (row: Dict, side: 's' | 'b'): KbsecBrokerFlow => ({
            code: pickStr(row, `${side}_scrts_cmpny1`),
            name: pickStr(row, `${side}_scrts_cmpny_nm1`),
            quantity: pickNum(row, `${side}_q1`),
            change: pickNum(row, `${side}_incrs_dcrs1`),
            ratio: pickNum(row, `${side}_rt1_p2`),
        });
        return pickArray(body)
            .map((row) => ({ sell: flow(row, 's'), buy: flow(row, 'b'), info: row }))
            .filter((r) => r.sell.code !== '' || r.sell.name !== '' || r.buy.code !== '' || r.buy.name !== '');
    }

    /**
     * 종목별 프로그램매매 추이(`IVU10450`). 국내만 지원한다.
     * 기간구분(`prd_clsf`)은 공식 예제대로 시간별(`1`)이고 `params`로 일별(`2`)로 바꿀 수 있다. 금액수량구분(`amt_q_clsf`)도 예제대로 금액(`1`)이다.
     * 응답은 두 구분과 관계없이 금액과 수량 필드를 모두 준다. 조회건수(`inq_cnt`)는 설명이 없어 `limit`을 줄 때만 채운다.
     */
    async fetchProgramTradingTrend(symbol: string, limit: Int = undefined, params: Dict = {}): Promise<KbsecProgramTradingTrendRow[]> {
        const market = this.market(symbol);
        if (this.isUs(market)) throw new NotSupported(`${this.id} fetchProgramTradingTrend() 는 국내 종목만 지원한다: ${symbol}`);
        const body = await this.callTr(KBSEC_TR.PROGRAM_TRADING_TREND, {
            excg_clsf: '1', is_cd: market.id, amt_q_clsf: '1', prd_clsf: '1', inq_cnt: limit !== undefined ? String(limit) : '',
            ...params,
        });
        return pickArray(body).map((row) => ({
            ...this.kstStamp(pickStr(row, 'dt'), pickStr(row, 'tm')),
            date: pickStr(row, 'dt'),
            time: pickStr(row, 'tm'),
            exchange: pickStr(row, 'excg_cd'),
            price: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'acml_vlm'),
            netBuyAmount: pickNum(row, 'nt_b_amt'),
            netBuyAmountChange: pickNum(row, 'nt_b_amt_incrs_dcrs'),
            sellAmount: pickNum(row, 's_amt'),
            buyAmount: pickNum(row, 'b_amt'),
            netBuyQuantity: pickNum(row, 'nt_b_q'),
            netBuyQuantityChange: pickNum(row, 'nt_b_q_incrs_dcrs'),
            sellQuantity: pickNum(row, 's_q'),
            buyQuantity: pickNum(row, 'b_q'),
            info: row,
        }));
    }

    /**
     * 시장종합(`IVSA0070`). 입력이 없다. 코스피와 코스닥의 등락 종목 수, 차익과 비차익 순매수, 그리고 그리드 네 개(지수, 파생상품,
     * 해외 지표, 투자자별 순매수)를 한 번에 준다.
     *
     * 그리드끼리 전일대비 같은 필드 이름을 같이 쓰므로, 순서가 아니라 저마다 있는 필드(`indx_id`, `nstmt_agr_q`, `symbl_cd`, `invstr_cd`)로 고른다.
     * 전일대비는 다른 KB 조회처럼 원문 값이고, 전일대비구분코드(`bdy_cmpr_ccd`)는 `info`에 남는다.
     * 증시 주변 자금 부분(`cs_dpst_5` 등)은 `fetchMarketFundFlow`가 따로 있어 옮기지 않고 `info`에 둔다.
     */
    async fetchMarketOverview(params: Dict = {}): Promise<KbsecMarketOverview> {
        const body = await this.callTr(KBSEC_TR.MARKET_OVERVIEW, { ...params });
        const breadth = (prefix: 'kspi' | 'ksdq'): KbsecMarketBreadth => ({
            upperLimit: pickNum(body, `${prefix}_ulmt_is_c`),
            advancing: pickNum(body, `${prefix}_up_is_c`),
            unchanged: pickNum(body, `${prefix}_unchng_is_c`),
            declining: pickNum(body, `${prefix}_dwn_is_c`),
            lowerLimit: pickNum(body, `${prefix}_llmt_is_c`),
        });
        return {
            queriedAt: pickStr(body, 'inq_dy_tm'),
            kospi: breadth('kspi'),
            kosdaq: breadth('ksdq'),
            arbitrageNetBuy: pickNum(body, 'mprft_nt_b'),
            nonArbitrageNetBuy: pickNum(body, 'nmp_nt_b'),
            indices: pickGrid(body, (first) => 'indx_id' in first).rows.map((row) => ({
                id: pickStr(row, 'indx_id'),
                name: pickStr(row, 'indx_nm'),
                value: pickNum(row, 'now_indx_p2'),
                change: pickNum(row, 'bdy_cmpr_p2'),
                percentage: pickNum(row, 'up_dwn_r_p2'),
                volume: pickNum(row, 'vlm'),
                tradingValue: pickNum(row, 'dl_tw_amt'),
                info: row,
            })),
            derivatives: pickGrid(body, (first) => 'nstmt_agr_q' in first).rows.map((row) => ({
                code: pickStr(row, 'is_cd'),
                name: pickStr(row, 'is_nm'),
                price: pickNum(row, 'now_prc_p2'),
                change: pickNum(row, 'bdy_cmpr_p2'),
                percentage: pickNum(row, 'up_dwn_r_p2'),
                volume: pickNum(row, 'vlm'),
                openInterest: pickNum(row, 'nstmt_agr_q'),
                info: row,
            })),
            globals: pickGrid(body, (first) => 'symbl_cd' in first).rows.map((row) => ({
                code: pickStr(row, 'symbl_cd'),
                name: pickStr(row, 'symbl_nm'),
                price: pickNum(row, 'now_prc'),
                change: pickNum(row, 'bdy_cmpr_p2'),
                percentage: pickNum(row, 'up_dwn_r_p2'),
                dateTime: pickStr(row, 'dt_tm'),
                info: row,
            })),
            investors: pickGrid(body, (first) => 'invstr_cd' in first).rows.map((row) => ({
                code: pickStr(row, 'invstr_cd'),
                name: pickStr(row, 'invstr_clsf_nm'),
                kospi: pickNum(row, 'kspi_nt_b'),
                kosdaq: pickNum(row, 'ksdq_nt_b'),
                futures: pickNum(row, 'fts_nt_b'),
                callOptions: pickNum(row, 'call_opt_nt_b'),
                putOptions: pickNum(row, 'put_opt_nt_b'),
                starFutures: pickNum(row, 'star_fts_nt_b'),
                stockFutures: pickNum(row, 'stk_fts_nt_b'),
                info: row,
            })),
            info: body,
        };
    }

    /**
     * 종목 순위. 국내만 지원한다. `FLUCTUATION`(등락률상위)·`VOLUME`(거래량상위)·`PROGRAM_TRADING`(프로그램매매상위)·
     * `TRADING_VALUE`(거래대금상위)·`OPEN_CHANGE_RATE`(시가대비등락률상위)·`EXTENDED_HOURS_CHANGE_RATE`(기간외등락률순위)·
     * `SURGE_PLUNGE`(급등/급락 상위) 일곱 가지를 받고, 나머지는 `NotSupported` 다.
     */
    async fetchRankings(type: KbsecRankingType, params: Dict = {}): Promise<KbsecRankingItem[]> {
        switch (type) {
            case 'FLUCTUATION': return this.fetchFluctuationRanking(params);
            case 'VOLUME': return this.fetchVolumeRanking(params);
            case 'PROGRAM_TRADING': return this.fetchProgramTradingRanking(params);
            case 'TRADING_VALUE': return this.fetchTradingValueRanking(params);
            case 'OPEN_CHANGE_RATE': return this.fetchOpenChangeRateRanking(params);
            case 'EXTENDED_HOURS_CHANGE_RATE': return this.fetchExtendedHoursChangeRateRanking(params);
            case 'SURGE_PLUNGE': return this.fetchSurgePlungeRanking(params);
            default: throw new NotSupported(`${this.id} fetchRankings() 는 ${String(type)} 랭킹을 지원하지 않는다`);
        }
    }

    /** 등락률상위(`IVU10240`). 정렬구분(`srt_clsf`) 기본값은 상승율(`1`)이다. */
    private async fetchFluctuationRanking(params: Dict): Promise<KbsecRankingItem[]> {
        const body = await this.callTr(KBSEC_TR.RANK_FLUCTUATION, {
            excg_clsf: '0', mkt_clsf: '1', inq_cnt: '', srt_clsf: '1',
            ...params,
        });
        return pickArray(body).map((row) => ({
            rank: pickNum(row, 'rnk'),
            symbol: `${pickStr(row, 'is_cd')}/KRW`,
            name: pickStr(row, 'is_nm'),
            last: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'vlm'),
            info: row,
        }));
    }

    /** 거래량상위(`IVU10280`). */
    private async fetchVolumeRanking(params: Dict): Promise<KbsecRankingItem[]> {
        const body = await this.callTr(KBSEC_TR.RANK_VOLUME, {
            excg_clsf: '0', mkt_clsf: '1',
            ...params,
        });
        return pickArray(body).map((row) => ({
            rank: pickNum(row, 'rnk'),
            symbol: `${pickStr(row, 'is_cd')}/KRW`,
            name: pickStr(row, 'is_nm'),
            last: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'acml_vlm'),
            info: row,
        }));
    }

    /** 프로그램매매상위(`IVS10920`). 조회건수(`inq_cnt`) 하나만 입력받는다 — 거래소·시장 구분 없이 KRX 전체를 준다. */
    private async fetchProgramTradingRanking(params: Dict): Promise<KbsecRankingItem[]> {
        const body = await this.callTr(KBSEC_TR.RANK_PROGRAM_TRADING, {
            inq_cnt: '', ...params,
        });
        return pickArray(body).map((row) => ({
            rank: pickNum(row, 'rnk'),
            symbol: `${pickStr(row, 'is_cd')}/KRW`,
            name: pickStr(row, 'is_nm'),
            last: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'vlm'),
            info: row,
        }));
    }

    /**
     * 거래대금상위(`IVU10210`). 거래소·시장·당일전일·조회건수·정렬구분을 공식 예제 기본값(KRX, 전체, 당일, 10건, `1`)대로 쓴다.
     * `srt_clsf`(정렬구분) 명세의 설명 칸에 "1:당일, 2:전일"이 붙어 있는데, 필드 이름 자체는 "정렬구분(1:상위, 2:하위)"이라
     * 다른 필드(`thdy_bdy_clsf`)의 설명이 잘못 붙은 것으로 보인다(사유 미상). 예제 실행값(`1`)만 그대로 썼다.
     */
    private async fetchTradingValueRanking(params: Dict): Promise<KbsecRankingItem[]> {
        const body = await this.callTr(KBSEC_TR.RANK_TRADING_VALUE, {
            excg_clsf: '1', mkt_clsf: '1', thdy_bdy_clsf: '1', inq_cnt: '10', srt_clsf: '1',
            ...params,
        });
        return pickArray(body).map((row) => ({
            rank: pickNum(row, 'rnk'),
            symbol: `${pickStr(row, 'is_cd')}/KRW`,
            name: pickStr(row, 'is_nm'),
            last: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'vlm'),
            info: row,
        }));
    }

    /** 시가대비등락률상위(`IVS10910`). 정렬구분(`srt_clsf`) 기본값은 상승(`1`)이다. 거래소 구분 없이 KRX 통합으로 준다. */
    private async fetchOpenChangeRateRanking(params: Dict): Promise<KbsecRankingItem[]> {
        const body = await this.callTr(KBSEC_TR.RANK_OPEN_CHANGE_RATE, {
            mkt_clsf: '1', inq_cnt: '10', srt_clsf: '1',
            ...params,
        });
        return pickArray(body).map((row) => ({
            rank: pickNum(row, 'rnk'),
            symbol: `${pickStr(row, 'is_cd')}/KRW`,
            name: pickStr(row, 'is_nm'),
            last: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'vlm'),
            info: row,
        }));
    }

    /**
     * 기간외등락률순위(`IVS11190`). 시장·정렬구분(상승율)·당일전일·조회건수를 공식 예제 기본값대로 쓴다. 응답에 순위 필드가
     * 없어(명세에 없음) 배열 순서(1부터)를 순위로 쓴다 — `srt_clsf`대로 이미 정렬된 응답이라는 전제다.
     */
    private async fetchExtendedHoursChangeRateRanking(params: Dict): Promise<KbsecRankingItem[]> {
        const body = await this.callTr(KBSEC_TR.RANK_EXTENDED_HOURS_CHANGE_RATE, {
            mkt_clsf: '1', srt_clsf: '1', thdy_bdy_clsf: '1', inq_cnt: '10',
            ...params,
        });
        return pickArray(body).map((row, index) => ({
            rank: index + 1,
            symbol: `${pickStr(row, 'is_cd')}/KRW`,
            name: pickStr(row, 'is_nm'),
            last: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'vlm'),
            info: row,
        }));
    }

    /**
     * 급등/급락 상위(`IVU10270`). 등락구분(`up_dwn_ccd`) 기본값은 급등(`1`)이고, `params.up_dwn_ccd`를 `'2'`로 주면 급락이다.
     * 기준시간구분(`minute_dy_ccd`)은 공식 예제대로 "분전"(`1`)을 쓴다. 기준시간단위(`minute_dy_unt`)는 공식 예제도 빈 값이라
     * 그대로 둔다 — 서버가 몇 분전을 기본으로 잡는지는 명세에 없다. 응답에 순위 필드가 없어(명세에 없음) 배열 순서(1부터)를 순위로 쓴다.
     */
    private async fetchSurgePlungeRanking(params: Dict): Promise<KbsecRankingItem[]> {
        const body = await this.callTr(KBSEC_TR.RANK_SURGE_PLUNGE, {
            excg_clsf: '1', mkt_clsf: '1', inq_cnt: '10', up_dwn_ccd: '1', minute_dy_ccd: '1', minute_dy_unt: '',
            ...params,
        });
        return pickArray(body).map((row, index) => ({
            rank: index + 1,
            symbol: `${pickStr(row, 'is_cd')}/KRW`,
            name: pickStr(row, 'is_nm'),
            last: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'vlm'),
            info: row,
        }));
    }

    /** 환율 종가 전체(`IVA60190`). 입력 없이 전 통화를 준다. `close`는 종가 기준이지 실시간이 아니다(필드명 `cls_prc_p4`). */
    async fetchExchangeRates(params: Dict = {}): Promise<KbsecExchangeRate[]> {
        const body = await this.callTr(KBSEC_TR.EXCHANGE_RATES, params);
        return pickArray(body).map((row) => ({
            currency: pickStr(row, 'crncy_cd'),
            countryName: pickStr(row, 'ntn_nm'),
            currencyName: pickStr(row, 'crncy_cd_nm'),
            close: pickNum(row, 'cls_prc_p4'),
            change: pickNum(row, 'bdy_cmpr_p4'),
            percentage: pickNum(row, 'bdy_cmpr_r_p2'),
            info: row,
        }));
    }

    /** 세계지수(`IVA60140`). 대륙 범위(`lnd_clsf`)는 공식 예제와 같은 기본값(주요지수)을 쓴다. */
    async fetchWorldIndices(scope: KbsecWorldIndexScope = 'MAJOR', params: Dict = {}): Promise<KbsecWorldIndex[]> {
        const body = await this.callTr(KBSEC_TR.WORLD_INDICES, { lnd_clsf: KBSEC_WORLD_INDEX_SCOPE_CODE[scope], ...params });
        return pickArray(body).map((row) => ({
            countryName: pickStr(row, 'ntn_nm'),
            code: pickStr(row, 'is_cd'),
            name: pickStr(row, 'is_cd_nm'),
            close: pickNum(row, 'cls_prc_p2'),
            change: pickNum(row, 'bdy_cmpr_p2'),
            percentage: pickNum(row, 'bdy_cmpr_r_p2'),
            info: row,
        }));
    }

    /** 종목 기업개요(`IVM10050`). 국내 종목만 지원한다. 응답이 종목 하나짜리 단일 객체라 배열로 안 감는다. */
    async fetchCompanyProfile(symbol: string, params: Dict = {}): Promise<KbsecCompanyProfile> {
        const market = this.market(symbol);
        const body = await this.callTr(KBSEC_TR.COMPANY_PROFILE, { is_cd: market.id, ...params });
        return {
            capital: pickNum(body, 'cptl_amt'),
            sharesOutstanding: pickNum(body, 'lstng_stk_c'),
            marketCap: pickNum(body, 'opn_prc_tl_amt'),
            dividendYield: pickNum(body, 'dvdnd_yld_p2'),
            per: pickNum(body, 'per'),
            pbr: pickNum(body, 'pbr_p2'),
            eps: pickNum(body, 'eps_p2'),
            bps: pickNum(body, 'bps_p2'),
            foreignHoldingRate: pickNum(body, 'fgnr_hld_sgrvt_p2'),
            info: body,
        };
    }

    /** 증시주변자금동향(`IVA10370`). 입력 없이 최신 하루치를 준다. 응답이 배열이 아니라 단일 객체다(`fetchCompanyProfile`과 같다). */
    async fetchMarketFundFlow(params: Dict = {}): Promise<KbsecMarketFundFlow> {
        const body = await this.callTr(KBSEC_TR.MARKET_FUND_FLOW, params);
        return {
            ...this.kstStamp(pickStr(body, 'dt')),
            date: pickStr(body, 'dt'),
            customerDeposit: pickNum(body, 'cs_dpst'),
            customerDepositChange: pickNum(body, 'cs_dpst_cmpr_amt'),
            receivables: pickNum(body, 'rcvamt'),
            receivablesChange: pickNum(body, 'rcvamt_cmpr_amt'),
            creditBalance: pickNum(body, 'crdt_blnc'),
            creditBalanceChange: pickNum(body, 'crdt_blnc_cmpr_amt'),
            futuresDeposit: pickNum(body, 'fts_tfnd'),
            futuresDepositChange: pickNum(body, 'fts_tfnd_cmpr_amt'),
            info: body,
        };
    }

    /**
     * 신고가/신저가(`IVU10550`, 국내만). 기준(`std_clsf`)·기간(`prd_clsf`)·돌파(`excd_clsf`)는 공식 예제 기본값
     * (고저 기준·전일·일시돌파)을 쓴다. 거래소·시장 범위를 바꾸려면 `params`로 넘긴다.
     */
    async fetchNewHighLow(type: KbsecHighLowType, count = 10, params: Dict = {}): Promise<KbsecHighLowItem[]> {
        const body = await this.callTr(KBSEC_TR.NEW_HIGH_LOW, {
            excg_clsf: '1', mkt_clsf: '1', inq_cnt: String(count), nw_stk_lw_ccd: KBSEC_HIGH_LOW_TYPE_CODE[type],
            std_clsf: '1', prd_clsf: '1', excd_clsf: '1',
            ...params,
        });
        return pickArray(body).map((row) => ({
            symbol: `${pickStr(row, 'is_cd')}/KRW`,
            name: pickStr(row, 'is_nm'),
            last: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'up_dwn_r_p2'),
            volume: pickNum(row, 'vlm'),
            high: pickNum(row, 'hgh_prc'),
            low: pickNum(row, 'lw_prc'),
            info: row,
        }));
    }

    /**
     * 외국인·기관매매상위(`IVU10020`, 국내만). 거래소·시장·기간은 공식 예제 기본값(KRX, 코스닥, 전일)을 쓴다.
     * `netQuantity`의 방향은 `type`(순매수·순매도·지분증가·지분감소·연속순매수·연속순매도)을 따른다.
     */
    async fetchInvestorRanking(investor: KbsecInvestorCode, type: KbsecInvestorRankingType, params: Dict = {}): Promise<KbsecInvestorRankingItem[]> {
        const body = await this.callTr(KBSEC_TR.INVESTOR_RANKING, {
            excg_clsf: '1', mkt_clsf: '1', invstr_ccd: KBSEC_INVESTOR_CODE[investor], prd_clsf: '1', rnk_clsf: KBSEC_INVESTOR_RANKING_TYPE_CODE[type],
            ...params,
        });
        return pickArray(body).map((row) => ({
            symbol: `${pickStr(row, 'shrt_is_cd')}/KRW`,
            name: pickStr(row, 'is_nm'),
            last: pickNum(row, 'now_prc'),
            change: pickNum(row, 'bdy_cmpr'),
            percentage: pickNum(row, 'bdy_cmpr_r_p2'),
            volume: pickNum(row, 'vlm'),
            netQuantity: pickNum(row, 'nt_b_s_q'),
            holdingRate: pickNum(row, 'hld_rt_p2'),
            info: row,
        }));
    }

    /**
     * 테마그룹(`IVS11430`). 테마마다 지수, 전일대비, 시가총액, 거래량, 테마종목수를 준다. 국내만 지원한다.
     * 테마코드(`thm_cd`)는 설명이 없는 선택 입력이라 비워 보내고, `themeCode`를 주면 그 값을 보낸다. 비웠을 때 어느 테마를 주는지는 명세에 없다.
     */
    async fetchThemeGroups(themeCode: Str = undefined, params: Dict = {}): Promise<KbsecThemeGroup[]> {
        const body = await this.callTr(KBSEC_TR.THEME_GROUPS, { thm_cd: themeCode ?? '', ...params });
        return pickArray(body).map((row) => ({
            code: pickStr(row, 'thm_cd'),
            name: pickStr(row, 'thm_nm'),
            index: pickNum(row, 'indx_p2'),
            change: pickNum(row, 'bdy_cmpr_p2'),
            percentage: pickNum(row, 'bdy_cmpr_up_dwn_r_p2'),
            marketCap: pickNum(row, 'opn_prc_tl_amt'),
            marketCapChange: pickNum(row, 'opn_prc_tl_amt_bdy_cmpr'),
            volume: pickNum(row, 'vlm'),
            tradingValue: pickNum(row, 'dl_tw_amt'),
            stockCount: pickNum(row, 'thm_is_c'),
            info: row,
        }));
    }

    /**
     * 업종랭킹(`IVM30010`). 시장구분(`mkt_clsf`)은 설명대로 코스피 `1`, 코스닥 `2`를 보낸다. 명세는 필드가 같은 그리드 둘을 적지만,
     * 실계좌 응답은 머리 레코드 하나(시장 지수)와 업종 지수 배열이었다. 머리 레코드는 `market`, 배열은 `sectors`로 옮긴다.
     */
    async fetchSectorRanking(market: KbsecSectorMarket, params: Dict = {}): Promise<KbsecSectorRanking> {
        const code = KBSEC_SECTOR_MARKET_CODE[market] as string | undefined;
        if (code === undefined) throw new NotSupported(`${this.id} fetchSectorRanking() 는 ${String(market)} 시장을 지원하지 않는다`);
        const body = await this.callTr(KBSEC_TR.RANK_SECTOR, { mkt_clsf: code, ...params });
        return {
            market: kbsecSectorIndex(kbsecRawResponse(body).fields),
            sectors: pickArray(body).map(kbsecSectorIndex),
            info: body,
        };
    }

    /**
     * 미국 공휴일관리(`SPAM2508`). 처리구분은 설명대로 조회(`4`)를 보낸다(공식 예제는 `1`). ISO코드는 설명에 있는 미국(`US`)만 보낸다.
     * 종료일자(`end_dt`)는 필수 입력이라 `params.until`(ms)의 한국 날짜를 보내고, 없으면 오늘이다. 등록일자와 공휴일구분코드처럼 설명이 없는
     * 선택 입력은 비워 보낸다. 행의 월, 영업일, 공휴일, 결제일 필드는 형식이 명세에 없어 원문으로 준다.
     */
    async fetchHolidays(params: Dict = {}): Promise<KbsecHolidays> {
        const [until, query] = this.handleUntilParam('fetchHolidays', undefined, params);
        const body = await this.callTr(KBSEC_TR.HOLIDAYS_US, {
            hndl_clsf: '4', iso_cd: 'US', dr_dt: '', end_dt: until !== undefined ? kbsecDateKst(new Date(until)) : this.todayKst(), nxt_bsnss_dy: '', nxt_stlmt_dt: '',
            hldy_ccd: '', frgn_stk_ordr_psbl_f: '', ...query,
        });
        return {
            fields: kbsecRawResponse(body).fields,
            rows: pickArray(body).map((row) => ({
                month: pickStr(row, 'mm'),
                businessDay: pickStr(row, 'bsnss_dy'),
                holiday: pickStr(row, 'hldy'),
                settlementDay: pickStr(row, 'stmt_dy'),
                nextBusinessDay: pickStr(row, 'nxt_bsnss_dy'),
                nextSettlementDate: pickStr(row, 'nxt_stlmt_dt'),
                overseasOrderable: pickStr(row, 'frgn_stk_ordr_psbl_f'),
                info: row,
            })),
        };
    }

    // ============ 시세 ============

    /** 해외 종목의 현재가 응답. 거래소코드를 후보 순서대로 시도해 실데이터가 나온 응답을 돌려준다. 못 찾으면 `undefined`. */
    private async callUsQuote(base: string, params: Dict = {}): Promise<Dict | undefined> {
        const cached = this.usExchangeCache.get(base);
        const candidates = cached !== undefined ? [cached] : KBSEC_US_EXCHANGES;
        for (const krxCode of candidates) {
            const row = await this.callTr(KBSEC_TR.QUOTE_US, { krx_cd: krxCode, is_cd: base, ...params });
            if (pickNum(row, 'now_prc_p4') > 0) {
                this.usExchangeCache.set(base, krxCode);
                return row;
            }
        }
        return undefined;
    }

    override async fetchTicker(symbol: string, params: Dict = {}): Promise<Ticker> {
        const market = this.market(symbol);
        let row: Dict | undefined;
        if (this.isUs(market)) {
            row = await this.callUsQuote(market.id as string, params);
            if (row === undefined) {
                throw new NullResponse(`${this.id} fetchTicker() ${symbol} 해외 현재가 없음 — 거래소코드 전 계열 미매칭`);
            }
        } else {
            // 국내 현재가 입력은 `excg_clsf`(0 통합, 1 KRX, 2 NXT)와 `shrt_cd`(단축코드)다. `is_cd` 를 보내면 "해당자료가 없습니다"가 온다.
            row = await this.callTr(KBSEC_TR.QUOTE_KR, { excg_clsf: '1', shrt_cd: market.id, ...params });
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
    override async fetchOrderBook(symbol: string, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        const market = this.market(symbol);
        const isUs = this.isUs(market);
        const row = isUs
            ? await this.callTr(KBSEC_TR.ORDERBOOK_US, {
                krx_cd: this.usExchangeCache.get(market.id as string) ?? KBSEC_US_EXCHANGES[0],
                is_cd: market.id,
                ...params,
            })
            : await this.callTr(KBSEC_TR.ORDERBOOK_KR, { is_cd: market.id, ovtm_mkt_clsf: '1', ...params });
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
     * 해외 차트(`GSC10060`)는 15분 지연 시세다. 지연 봉을 공통 메서드에 섞지 않으려고 해외는 `fetchOverseasCandles`로만 준다.
     * 시장구분(`mkt_clsf`)은 코스피(`0`)로 보낸다. 코스닥 종목에서 빈 응답이 오면 `params.mkt_clsf` 에 `'1'` 을 넘긴다.
     *
     * `since` 가 있으면 `since` 부터 `limit`(기본 100) 개이고, 없으면 가장 최근 `limit` 개다. `params.until`(ms)은 그 시각까지의 봉만 남긴다.
     * 명세의 시작일(`strt_dy`)은 뜻을 확인하지 못해 비워 보낸다. 대신 지금부터 `since`(또는 `until`)까지 덮을 만큼 최근 봉을 받아 거른다.
     * 조회건수 상한(9999)으로도 `since` 까지 닿지 못하면 경고 로그를 남기고 받은 가장 오래된 봉부터 돌려준다.
     */
    override async fetchOHLCV(
        symbol: string, timeframe = '1d', since: Int = undefined, limit: Int = undefined, params: Dict = {},
    ): Promise<OHLCV[]> {
        const market = this.market(symbol);
        if (this.isUs(market)) {
            throw new NotSupported(`${this.id} fetchOHLCV() 는 국내 종목만 지원한다: 해외 차트는 15분 지연 시세라 fetchOverseasCandles 로 준다`);
        }
        const { chrt_clsf, minute } = kbsecChartParams(timeframe);
        const wanted = limit ?? 100;
        const until = this.safeInteger(params, 'until');
        const query = this.omit(params, 'until');
        // 조회는 가장 최근 봉부터 개수로만 하므로, 지금부터 그 시각까지 들어가는 봉 수를 달력 시간으로 넉넉히 센다.
        const barsSince = (from: number): number => Math.ceil((this.milliseconds() - from) / kbsecBarMs(timeframe)) + 1;
        let count = wanted;
        if (since !== undefined) count = Math.max(wanted, barsSince(since));
        else if (until !== undefined) count = wanted + Math.max(0, barsSince(until));
        count = Math.min(count, KBSEC_CHART_MAX);
        const body = await this.callTr(KBSEC_TR.CHART_KR, {
            info_ccd: '1', // 원주가
            mkt_clsf: '0', // KOSPI. KOSDAQ 종목도 KB 가 종목코드로 해석하는지는 실측이 필요하다.
            chrt_clsf,
            minute_tck_indx: minute,
            is_cd: market.id,
            inq_clsf: '2', // 데이터 수로 조회
            inq_cnt: kbsecNum(count),
            ...query,
        });
        const received = pickArray(body);
        const rows = received.filter(row => kbsecCandleTimestamp(pickStr(row, 'dt'), pickStr(row, 'tm')) !== undefined);
        // 일·주·월봉은 KB 가 현지 자정(00:00 KST)으로 주므로 기간 첫날의 00:00 UTC 로 옮긴다(`candlePeriodUtcMs`).
        const daily = isDailyOrLongerTimeframe(timeframe);
        const candles = this.parseOHLCVs(rows, market, timeframe)
            .map((candle) => (daily ? [candlePeriodUtcMs(candle[0] as number, timeframe, 'KR'), ...candle.slice(1)] as OHLCV : candle))
            .filter((candle) => until === undefined || (candle[0] as number) <= until);
        const oldest = candles[0]?.[0];
        if (since !== undefined && received.length >= count && oldest !== undefined && oldest > since) {
            logger.warn({ symbol: market.symbol, timeframe, since, oldest, count }, '[kbsec] 봉 조회건수 상한에 닿아 since 까지 받지 못했다. 받은 가장 오래된 봉부터 돌려준다');
        }
        return this.filterBySinceLimit(candles, since, wanted, 0) as OHLCV[];
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

    /**
     * 해외 차트(`GSC10060`). 봉의 일자와 시간은 미국 동부 현지 시각이라(실계좌 확인) `timestamp`를 UTC 로 채우고 원문도 함께 준다.
     * 실계좌의 시세구분(`mrkt_prc_clsf`)은 `15분지연`이었다. 차트구분은 설명대로 틱 `1`, 분 `2`, 일 `3`, 주 `4`, 월 `5`, 년 `6`이고, 레코드수는 `limit`(기본 100, 최대 5000)이다.
     * 거래소코드(`krx_cd`)는 `fetchTrades`처럼 현재가 조회로 찾은 값을 쓴다. 묶음과 수정주가사용여부는 공식 예제처럼 비워 보내고,
     * 검색시작일은 설명대로 기본값인 빈값을, 설명이 없는 구분(`clsf`)도 빈값을 보낸다. 바꾸려면 `params`로 준다.
     */
    async fetchOverseasCandles(symbol: string, chartType: KbsecOverseasChartType = 'day', limit: Int = undefined, params: Dict = {}): Promise<KbsecOverseasCandles> {
        const market = this.market(symbol);
        if (!this.isUs(market)) throw new NotSupported(`${this.id} fetchOverseasCandles() 는 해외 종목만 지원한다(국내는 fetchOHLCV): ${symbol}`);
        const chrtClsf = KBSEC_OVERSEAS_CHART_CODE[chartType] as string | undefined;
        if (chrtClsf === undefined) throw new NotSupported(`${this.id} fetchOverseasCandles() 는 ${String(chartType)} 차트를 지원하지 않는다`);
        const base = market.id as string;
        if (this.usExchangeCache.get(base) === undefined) await this.callUsQuote(base);
        const body = await this.callTr(KBSEC_TR.CHART_US, {
            krx_cd: this.usExchangeCache.get(base) ?? KBSEC_US_EXCHANGES[0],
            is_cd: base,
            chrt_clsf: chrtClsf,
            bndl: '',
            mdfy_stk_prc_use_f: '',
            rcrd_c: kbsecNum(Math.min(limit ?? 100, KBSEC_OVERSEAS_CHART_MAX)),
            srch_strt_dy: '',
            clsf: '',
            ...params,
        });
        // 일·주·월·연봉은 KB 가 현지 자정(00:00 ET)으로 주므로 기간 첫날의 00:00 UTC 로 옮긴다(`candlePeriodUtcMs`).
        const period = KBSEC_OVERSEAS_CHART_PERIOD[chartType];
        const stamp = (row: Dict): number | undefined => {
            const ms = kbsecUsCandleTimestamp(pickStr(row, 'dt'), pickStr(row, 'tm'));
            return ms !== undefined && period !== undefined ? candlePeriodUtcMs(ms, period, 'US') : ms;
        };
        // 일자나 시각을 읽을 수 없는 봉은 지어낸 시각으로 채우지 않고 버린다.
        const rows = pickArray(body).filter((row) => stamp(row) !== undefined);
        return {
            fields: kbsecRawResponse(body).fields,
            candles: rows.map((row) => ({
                ...this.msStamp(stamp(row)),
                date: pickStr(row, 'dt'),
                time: pickStr(row, 'tm'),
                open: pickNum(row, 'opn_prc_p4'),
                high: pickNum(row, 'hgh_prc_p4'),
                low: pickNum(row, 'lw_prc_p4'),
                close: pickNum(row, 'cls_prc_p4'),
                volume: pickNum(row, 'vlm'),
                tradingValue: pickNum(row, 'dl_tw_amt'),
                info: row,
            })),
        };
    }

    /**
     * 시간대별 체결 내역. 국내(`IVU10080`, 당일만)와 해외(`GSA10020`)를 종목 국가로 가른다.
     *
     * 국내는 체결가·체결수량·체결시각만 채운다. 방향(매도매수구분, `sell_buy_ccd`)과 체결ID는 코드값 의미를 확정할 근거가
     * 없어(명세에 설명 없음) 채우지 않는다 — `info`에 원본이 남아 있다. 시각은 조회 시점의 한국 날짜(`todayKst`)와
     * 체결시각(`ccls_tm`, HHMMSS)을 합쳐 만든다(TR 이름대로 당일 데이터라서 가능한 조합이다).
     *
     * 해외는 체결구분(`ccls_clsf`, `1`:매수자체결 `2`:매도자체결)이 명세에 명시돼 있어 `side`를 채운다. 시각은 한국시각
     * 변환 필드(`kor_dt`·`kor_tm`)를 그대로 쓴다(국내와 달리 여러 날짜를 한 번에 준다). 거래소코드(`krx_cd`)는 `fetchTicker`가
     * 쓰는 캐시(`usExchangeCache`)를 그대로 재사용한다 — 없으면 먼저 현재가 조회로 채운다.
     */
    async fetchTrades(symbol: string, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        const market = this.market(symbol);
        if (this.isUs(market)) return this.fetchOverseasTradesTimeline(market, since, limit, params);
        const body = await this.callTr(KBSEC_TR.TRADES_TIMELINE_KR, {
            excg_clsf: '1', is_cd: market.id, ovtm_mkt_clsf: '0', inq_cnt: kbsecNum(limit ?? 30),
            ...params,
        });
        const today = this.todayKst();
        const trades = pickArray(body).map((row) => {
            const timestamp = kbsecCandleTimestamp(today, pickStr(row, 'ccls_tm'));
            return this.safeTrade({
                info: row,
                id: undefined,
                order: undefined,
                timestamp,
                datetime: timestamp !== undefined ? this.iso8601(timestamp) : undefined,
                symbol: market.symbol,
                type: undefined,
                side: undefined,
                takerOrMaker: undefined,
                price: pickNum(row, 'ccls_prc'),
                amount: pickNum(row, 'ccls_q'),
                cost: undefined,
                fee: undefined,
            }, market);
        });
        return since !== undefined ? trades.filter((trade) => (trade.timestamp ?? 0) >= since) : trades;
    }

    private async fetchOverseasTradesTimeline(market: MarketInterface, since: Int, limit: Int, params: Dict): Promise<Trade[]> {
        const base = market.id as string;
        if (this.usExchangeCache.get(base) === undefined) await this.callUsQuote(base);
        const krxCode = this.usExchangeCache.get(base) ?? KBSEC_US_EXCHANGES[0];
        const body = await this.callTr(KBSEC_TR.TRADES_TIMELINE_US, {
            krx_cd: krxCode, is_cd: base, rcrd_c: kbsecNum(limit ?? 30),
            ...params,
        });
        const trades = pickArray(body).map((row) => {
            const timestamp = kbsecCandleTimestamp(pickStr(row, 'kor_dt'), pickStr(row, 'kor_tm'));
            const ccls_clsf = pickStr(row, 'ccls_clsf');
            return this.safeTrade({
                info: row,
                id: undefined,
                order: undefined,
                timestamp,
                datetime: timestamp !== undefined ? this.iso8601(timestamp) : undefined,
                symbol: market.symbol,
                type: undefined,
                side: ccls_clsf === '1' ? 'buy' : ccls_clsf === '2' ? 'sell' : undefined,
                takerOrMaker: undefined,
                price: pickNum(row, 'now_prc_p4'),
                amount: pickNum(row, 'ccls_q'),
                cost: undefined,
                fee: undefined,
            }, market);
        });
        return since !== undefined ? trades.filter((trade) => (trade.timestamp ?? 0) >= since) : trades;
    }

    // ============ 잔고 ============

    /**
     * 통화와 보유 종목의 잔고. 현금은 통화 키(`KRW`, `USD`), 보유 종목은 종목 코드 키이며 `total` 이 **수량**이다. 평균 단가·평가금액·종목명은
     * 각 항목의 `info` 에 있다(`averagePrice`, `marketValue`, `name`, `quoteCurrency`).
     *
     * 예수금을 읽지 못하면 던진다. 보유를 일부만 읽었으면 던지지 않고 `info.readStatus` 가 `PARTIAL`, 못 읽은 시장(`KR`, `US`)이
     * `info.unreadMarkets` 다. **이때 그 시장에서 목록에 없는 종목은 미보유가 아니라 미확인이다.**
     * - 국내(`KR`): 계좌자산평가(`SSQM2952`)가 국내 행을 주면 읽은 것이다. 실패해서 보유주식(`SSQM1801`) 경로로 내려갔는데 그 행이 전부
     *   걸러졌거나, 종목코드를 못 읽어 버린 행이 있거나, 연속조회가 상한에서 잘렸거나, 계좌자산평가가 실패했는데 보유주식도 비었으면 못 읽은 것이다.
     *   계좌자산평가가 성공했는데 국내 행이 없고 보유주식도 비었으면 두 조회가 모두 "보유 없음"이라 읽은 것으로 본다.
     * - 해외(`US`): 이번 조회가 성공했고 해외 그리드를 한 번이라도 본 적이 있으면 읽은 것이다. 그리드를 본 적이 없으면 빈 응답이
     *   "보유 없음"인지 "그리드를 못 알아봄"인지 가를 수 없다.
     *
     * `USD` 항목은 해외 잔고평가(`SPQM2226`)의 통화별 예수금 그리드에서 온다(예수금·주문가능금액). 그 그리드를 못 읽었으면 `USD` 항목이 없다.
     * **없다는 것은 0 이 아니라 모른다는 뜻이다.** `options.krwIntegratedMargin` 이 켜져 있고 원화환산 외화예수금이 있으면 그것을 환율로 환산한 USD 가 우선한다.
     */
    override async fetchBalance(params: Dict = {}): Promise<Balances> {
        // 여러 TR 을 부르지만 `params` 는 기준이 되는 예수금 조회에만 합친다.
        const deposit = await this.callTr(KBSEC_TR.DEPOSIT, { ...params });
        // 실측 필드: ordr_psbl_csh(주문가능현금) · ordr_std_dpstn_csh(주문기준예수금)
        const krwFields = ['ordr_psbl_csh', 'ordr_std_dpstn_csh', 'do_psbl_csh'];
        // 후보 필드가 모두 없으면 0 이 아니라 모르는 것이다. 0 으로 두면 "예수금 없음"과 섞인다.
        if (!krwFields.some((k) => k in deposit)) {
            throw new BadResponse(`${this.id} fetchBalance() 예수금 응답에 주문가능현금 필드가 없다 (${KBSEC_TR.DEPOSIT})`);
        }
        const krw = pickNum(deposit, ...krwFields);

        // 원마켓(통합증거금) 계좌는 달러 예수금이 0 이어도 원화로 미국 주식을 산다. `krwIntegratedMargin` 옵션이 켜져 있으면 원화환산 외화 예수금을 **USD 로 환산해**
        // 라벨과 값의 축을 맞춘다. USD 라벨에 원화 값을 담지 않는다.
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
                // 옵션을 켰는데 USD 항목이 안 생기는 경우가 있다. 안 남기면 "켰는데 왜 그대로냐"를 로그로 확인할 방법이 없다.
                // `margin` 이 없으면 계좌가 원마켓 미신청(H049)이다. 코드로 만들 수 있는 매수여력이 아니라 사람이 할 일이다.
                this.oneMarketNoticeLogged = true;
                logger.warn({ marginSeen: margin !== undefined, krwEquivalentForeign: margin?.krwEquivalentForeign ?? null },
                    '[kbsec] krwIntegratedMargin 옵션은 켜졌는데 USD 매수여력이 안 생겼다 — marginSeen=false 면 계좌가 원마켓 미신청(H049)이다. 인스턴스당 1회만 남긴다');
            }
        }

        // 1순위는 계좌자산평가(`SSQM2952`)다. 실보유수량·매입평균가·평가금액을 명시적으로 주므로 추정이 없다. 실패하면 보유주식 경로로 내려간다.
        // 잔고가 조용히 0 이 되는 것이 이 클래스에서 가장 피해가 큰 실패 모드라, 검증 안 된 경로로 통째로 갈아타지 않는다.
        const assetEval = await this.fetchDomesticHoldingsFromAssetEval();
        const domestic = assetEval.status === 'ok'
            ? { rows: assetEval.rows, read: assetEval.complete }
            : await this.fetchDomesticHoldingsFromHoldingRows(assetEval.status === 'failed');
        const overseas = await this.fetchOverseasHoldings();

        return this.parseBalance({ krw, deposit, holdings: [...domestic.rows, ...overseas.rows], domesticRead: domestic.read, overseas, oneMarketUsd });
    }

    override parseBalance(response: Dict): Balances {
        const overseas = response.overseas as OverseasHoldings;
        const unreadMarkets: string[] = [];
        if (response.domesticRead === false) unreadMarkets.push('KR');
        if (!overseas.read) unreadMarkets.push('US');
        const result: Dict = {
            info: {
                readStatus: (unreadMarkets.length === 0 ? 'COMPLETE' : 'PARTIAL') as KbsecReadStatus,
                unreadMarkets,
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
     * 조회가 실패하면 `failed`, 성공했지만 국내 행이 없으면 `empty` 를 돌려주고 호출부가 보유주식(`SSQM1801`) 경로로 떨어진다.
     */
    private async fetchDomesticHoldingsFromAssetEval(): Promise<{ status: 'ok'; rows: HoldingRow[]; complete: boolean } | { status: 'empty' | 'failed' }> {
        let rows: Dict[];
        try {
            // A=통합시세. KRX 만 보면 NXT 체결분 현재가가 빈다.
            rows = pickArray(await this.callTr(KBSEC_TR.ASSET_EVAL, { excg_mktpr_ccd: 'A' }));
        } catch (err) {
            logger.warn({ err }, '[kbsec] 계좌자산평가 조회 실패 — 보유주식 경로로 폴백');
            return { status: 'failed' };
        }
        if (rows.length === 0) return { status: 'empty' };

        const out: HoldingRow[] = [];
        let domesticRows = 0;
        // 버린 보유: 종목코드 없이 수량이 있는 행, 수량 필드가 없는 국내 행. 합계 행처럼 코드와 수량이 모두 없는 행은 세지 않는다.
        let droppedHoldings = 0;
        for (const row of rows) {
            const code = kbsecNormalizeCode(pickStr(row, 'is_cd', 'shrt_cd', 'is_no', 'stnd_is_cd'));
            if (code === '') {
                if (pickNum(row, 'ec_q') > 0) droppedHoldings++;
                continue;
            }
            // 해외는 이 경로의 범위가 아니다. `SPQM2226` 이 담당하므로 여기서 읽으면 중복 계상된다.
            if (kbsecMarketOf(code) !== 'KR') continue;
            domesticRows++;
            if (!('ec_q' in row)) {
                droppedHoldings++;
                continue;
            }
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
            return { status: 'empty' };
        }
        if (droppedHoldings > 0) logger.warn({ droppedHoldings }, '[kbsec] 계좌자산평가에서 종목코드나 수량을 읽지 못한 보유 행이 있다 — 국내를 못 읽은 시장으로 표시');
        return { status: 'ok', rows: out, complete: droppedHoldings === 0 };
    }

    /**
     * 국내 보유 — 보유주식(`SSQM1801`) 경로. 계좌자산평가가 국내 행을 주지 않았을 때만 쓴다. `read` 는 국내 보유를 빠짐없이 읽었는가다.
     * `primaryFailed` 는 계좌자산평가가 실패(예외)했는가다. 그때 이 경로마저 비면 "보유 없음"이라고 말할 근거가 없다.
     */
    private async fetchDomesticHoldingsFromHoldingRows(primaryFailed: boolean): Promise<{ rows: HoldingRow[]; read: boolean }> {
        const { rows: holdingRows, truncated } = await this.fetchHoldingRows();
        let dropped = 0;
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
                if (code === '') dropped++;
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
        const allFiltered = holdingRows.length > 0 && out.length === 0;
        if (allFiltered) {
            logger.warn({ rows: holdingRows.length, rowKeys: Object.keys(holdingRows[0] ?? {}).slice(0, 40) },
                '[kbsec] 보유주식 행은 있으나 전부 걸러짐 — 종목코드/수량 필드명 불일치');
        }
        const read = !truncated && dropped === 0 && !allFiltered && !(primaryFailed && holdingRows.length === 0);
        if (!read) {
            logger.warn({ primaryFailed, rows: holdingRows.length, kept: out.length, dropped, truncated },
                '[kbsec] 국내 보유를 다 읽지 못했다 — readStatus PARTIAL, unreadMarkets 에 KR');
        }
        return { rows: out, read };
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
        if (this.milliseconds() < this.overseasHoldingsRetryAt) return { rows: [], usdCash: undefined, read: false };
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
            // 종목코드 없이 수량이 있는 행은 보유를 잃은 것이다. 이 행이 있으면 다 읽었다고 하지 않는다.
            let droppedHoldings = 0;
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
                    if (code === '' && OVERSEAS_QTY_CANDIDATES.some((k) => pickNum(row, k) > 0)) droppedHoldings++;
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
            return { rows: out, usdCash, read: this.overseasGridSeen && droppedHoldings === 0 };
        } catch (err) {
            const permanent = this.isPermanentFailure(err);
            if (permanent) {
                this.overseasHoldingsUnavailable = true;
            } else {
                this.overseasHoldingsRetryAt = this.milliseconds() + (this.options.transientRetryCooldown as number);
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

    /** 평가용 현재가. 잔고 조회를 잇달아 불러도 종목마다 TR 을 다시 부르지 않도록 TTL 동안 캐시한다. */
    private async holdingPrice(code: string): Promise<number> {
        const cached = this.holdingPriceCache.get(code);
        if (cached !== undefined && this.milliseconds() - cached.at < (this.options.holdingPriceTtl as number)) return cached.price;
        let price = 0;
        try {
            price = (await this.fetchTicker(code)).last ?? 0;
        } catch (err) {
            logger.debug({ err, code }, '[kbsec] 평가용 현재가 조회 실패');
        }
        if (price > 0) this.holdingPriceCache.set(code, { price, at: this.milliseconds() });
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
    private async fetchHoldingRows(): Promise<{ rows: Dict[]; truncated: boolean }> {
        const attempts = [
            { inq_clsf: KBSEC_INQ_STOCK, mkt_tm_ccd: KBSEC_SESSION_REGULAR },
            { inq_clsf: KBSEC_INQ_ALL, mkt_tm_ccd: KBSEC_SESSION_REGULAR },
        ];
        const maxPages = this.options.holdingsMaxPages as number;
        let lastRaw: Dict = {};
        for (const [i, params] of attempts.entries()) {
            // 0건일 때 남길 근거로 마지막 응답을 기억한다.
            const { rows, truncated } = await this.collectTrPages(KBSEC_TR.HOLDINGS, params, (row) => row, maxPages, (body) => {
                lastRaw = body;
                return pickArray(body);
            });
            if (truncated) {
                // 상한에 걸려 중단했다. 조용히 자르면 그 종목들이 청산으로 읽힌다.
                logger.error({ pages: maxPages, rows: rows.length }, '[kbsec] 보유주식 연속조회 상한 도달 — 목록이 잘렸다(청산 오판 위험)');
            }
            if (rows.length > 0) {
                if (i > 0) {
                    logger.warn({ attempt: i, params, rows: rows.length }, '[kbsec] 보유주식 — 기본 조합은 0건, 대체 조합에서 조회됨 (조합 고정 필요)');
                }
                return { rows, truncated };
            }
        }
        logger.warn({ attempts: attempts.length, topLevelKeys: Object.keys(lastRaw).slice(0, 20) },
            '[kbsec] 보유주식 0건 — 응답에 배열이 없거나 비어 있다(파라미터/필드명 확인 필요)');
        return { rows: [], truncated: false };
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
                const ordrDt = kbsecBusinessDateKst(steps, new Date(this.milliseconds()));
                let rows: Dict[];
                try {
                    const result = await this.collectTrPages(KBSEC_TR.TRADES_KR, {
                        inq_clsf: KBSEC_INQ_STOCK, // 주식
                        ccls_clsf: KBSEC_CCLS_FILLED, // 체결만. 비우면 거부된다(8654)
                        ordr_dt: ordrDt,
                        cn_clsf: KBSEC_CONT_FIRST,
                    }, (row: Dict) => row);
                    // 잘리면 빼야 할 매도가 덜 빠진다. 과다보고 쪽이라 보정은 계속하고 기록만 남긴다.
                    if (result.truncated) logger.warn({ ordrDt, rows: result.rows.length }, '[kbsec] 결제대기 매도 조회가 페이지 상한에서 잘렸다');
                    rows = result.rows;
                } catch (err) {
                    // `kbsecBusinessDateKst` 의 휴장일 표에 없는 휴장일에는 조회일자가 KB 영업일보다 앞서 거부된다. 그 날짜 하나만
                    // 건너뛰고 나머지 영업일은 계속 본다. 통째로 포기하면 공휴일마다 보정이 조용히 꺼진다.
                    if (err instanceof ExchangeError && err.detail === KBSEC_ERROR_DETAIL.FUTURE_QUERY_DATE) {
                        logger.debug({ ordrDt }, '[kbsec] 결제대기 매도 조회 — 휴장일 건너뜀');
                        continue;
                    }
                    throw err;
                }
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

    /**
     * 이 인스턴스에서 다시 불러도 답이 같은 영구 실패인가. KB 가 응답으로 거절한 업무 오류(권한 없음 I446, 미신청 H049 등)만 해당한다.
     * 연결 끊김, 시간 초과, 5xx, 토큰 차단기, 토큰 무효(I445, 재발급으로 풀린다)는 냉각 뒤 다시 부른다.
     */
    private isPermanentFailure(err: unknown): boolean {
        return err instanceof ExchangeError && !(err instanceof AuthenticationError && err.detail === KBSEC_ERROR_DETAIL.TOKEN_INVALID);
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
        if (this.oneMarketUnavailable || this.milliseconds() < this.oneMarketRetryAt) return undefined;
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
            const permanent = this.isPermanentFailure(err);
            if (permanent) this.oneMarketUnavailable = true;
            else this.oneMarketRetryAt = this.milliseconds() + (this.options.transientRetryCooldown as number);
            logger.warn({ err, latched: permanent },
                '[kbsec] 원마켓 증거금 조회 실패 — 영구 실패면 이 인스턴스에서 재시도하지 않는다(반복 실패는 계정 제한 사유)');
            return undefined;
        }
    }

    /**
     * 국내 매수주문가능금액(원). 예수금만 보면 미수·증거금 규칙이 빠져 주문가능액을 과대평가하므로 KB 가 계산한 값을 그대로 쓴다.
     * 값이 없거나 0 이하면 `undefined` 다.
     */
    async fetchBuyableAmount(symbol: Str = undefined, params: Dict = {}): Promise<number | undefined> {
        const body = await this.callTr(KBSEC_TR.BUYABLE_KR, {
            is_no: symbol !== undefined ? kbsecBaseSymbol(symbol) : '',
            bnd_mktio_ccd: '1',
            ...params,
        });
        const amount = pickNum(body, 'ordr_psbl_csh');
        return amount > 0 ? amount : undefined;
    }

    /**
     * 해외 매수여력 — **원마켓(통합증거금)** 지원.
     *
     * KB 원마켓플러스는 원화로 미국 주식을 산다(USD 사전 환전 불필요). 그래서 매수여력이 두 갈래로 온다.
     * `fcrncy_ordr_psbl_amt`(외화 주문가능금액)와 `krw_exch_unty_ordr_psbl_amt`(원화환산 통합 주문가능금액)다.
     * `krwIntegratedMargin` 옵션이 켜져 있으면 통합 기준을 쓰고, 꺼져 있으면 순수 외화만 본다. `fcrncy_unty_ordr_psbl_amt_p2` 의 `unty` 는 **통합**이라
     * 원화를 환산해 더한 값이므로 옵션을 꺼도 통합 금액이 USD 로 둔갑하지 않게 이 값은 순수 외화로 쓰지 않는다.
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

    /**
     * 원마켓플러스 주문가능금액 현황(`SKQM3350`). 입력이 없다. 원화 기준 머리 금액과 통화별 외화 금액을 함께 준다. 실계좌 응답의 통화 행
     * 10개 중 4개는 통화코드가 빈 채움 행이라 거른다.
     * 종목과 가격을 정해 묻는 조회는 `fetchOverseasBuyableAmount`(`SKQM2106`)다.
     */
    async fetchOneMarketBuyingPower(params: Dict = {}): Promise<KbsecOneMarketBuyingPower> {
        const body = await this.callTr(KBSEC_TR.ONEMARKET_BUYABLE_ALL, { ...params });
        return {
            domesticOrderable: pickNum(body, 'dmstc_orgn_ordr_psbl_amt'),
            domesticProvidedKrw: pickNum(body, 'dmstc_ofr_use_psbl_krw_amt'),
            domesticOtherCurrencyUsed: pickNum(body, 'dmstc_otr_crncy_use_amt'),
            foreignDepositInKrw: pickNum(body, 'fcr_tfnd_krw_exch_amt'),
            unsettledOverseasInKrw: pickNum(body, 'frsk_ust_sum_krw_amt'),
            exchangeOrderMarginKrw: pickNum(body, 'exch_mny_trgt_krw_ordr_mgn'),
            currencies: pickArray(body).filter((row) => pickStr(row, 'crncy_cd') !== '').map((row) => ({
                currency: pickStr(row, 'crncy_cd'),
                country: pickStr(row, 'ntn_nm'),
                deposit: pickNum(row, 'fcrncy_tfnd'),
                usable: pickNum(row, 'fcrncy_use_psbl_amt_p2'),
                unifiedOrderable: pickNum(row, 'fcrncy_unty_ordr_psbl_amt_p2'),
                receivableOrderable: pickNum(row, 'fcrncy_rcvbl_ordr_psbl_amt_p2'),
                info: row,
            })),
            info: body,
        };
    }

    /**
     * 해외 주문가능금액(`SPQM2106`). 원마켓이 아닌 계좌용 조회이고, 원마켓 계좌는 `fetchOverseasBuyableAmount`를 쓴다. 해외 종목만 지원한다.
     * 해외주문가격(`frgn_ordr_prc_p4`)은 `price`를 주면 보낸다. 통화코드와 ISO코드는 공식 예제처럼 비워 보내고, 설명이 없는 적용환율과
     * 주문가격(`ordr_prc`)도 비워 보낸다.
     */
    async fetchOverseasOrderableAmount(symbol: string, price: Num = undefined, params: Dict = {}): Promise<KbsecOverseasOrderable> {
        const market = this.market(symbol);
        if (!this.isUs(market)) throw new NotSupported(`${this.id} fetchOverseasOrderableAmount() 는 해외 종목만 지원한다: ${symbol}`);
        const body = await this.callTr(KBSEC_TR.BUYABLE_US, {
            crncy_cd: '',
            stnd_is_cd: market.id,
            iso_cd: '',
            frgn_ordr_prc_p4: price !== undefined ? kbsecNum(price, 4) : '',
            aplc_exch_r: '',
            ordr_prc: '',
            ...params,
        });
        return {
            foreignAmount: pickNum(body, 'fcrncy_ordr_psbl_amt'),
            krwAmount: pickNum(body, 'krw_ordr_psbl_amt'),
            maxQuantity: pickNum(body, 'ordr_psbl_q'),
            fullMarginQuantity: pickNum(body, 'pcnt100_ordr_psbl_q'),
            price: pickNum(body, 'frgn_ordr_prc_p4'),
            marginRate: pickNum(body, 'is_mgn_r_p4'),
            appliedMarginRate: pickNum(body, 'aplc_mgn_r_p4'),
            info: body,
        };
    }

    /**
     * 평가손익 조회(`SSQM0006`, 국내만). 조회구분(`inq_clsf`)과 매매구분(`trd_clsf`) 둘 다 명세에 "전체" 코드값이
     * 문서화돼 있어(`2`·`00`) 그 값을 기본으로 쓴다 — 공식 예제는 신용(`1`)·자기융자(`1`)만 좁혀 보여주지만,
     * 잔고 전체를 보는 것이 이 메서드의 목적에 맞다.
     *
     * 연속조회는 `collectTrPages`가 끝까지 따라간다(상한 `options.holdingsMaxPages`).
     */
    async fetchUnrealizedPnl(params: Dict = {}): Promise<KbsecUnrealizedPnlFetch> {
        const result = await this.collectTrPages(KBSEC_TR.UNREALIZED_PNL, {
            inq_clsf: '2', spclz_ordr_ccd: '', trd_clsf: '00', act_cd: '', is_cd: '', ...params,
        }, (row) => ({
            symbol: `${kbsecNormalizeCode(pickStr(row, 'is_cd'))}/KRW`,
            name: pickStr(row, 'is_nm'),
            quantity: pickNum(row, 'ec_q'),
            averagePrice: pickNum(row, 'avr_uprc'),
            last: pickNum(row, 'now_prc'),
            unrealizedPnl: pickNum(row, 'val_pl_amt'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length }, '[kbsec] 평가손익 연속조회가 잘렸다 — 목록에 없는 종목은 0이 아니라 미확인이다');
        }
        return result;
    }

    /**
     * 국내주식 소수점 매매 보유잔고(`SSQM5472`). `createOrder`의 `params.fractional`로 산 소수점 보유를 읽는다.
     *
     * 업무구분코드(`jb_ccd`)는 명세 설명이 "고정"이고 값이 없어 공식 예제의 `1`을 쓴다. 기준일자(`std_dt`)는 선택 입력이라
     * 비워 보낸다 — 비웠을 때 서버가 어느 날짜를 기준으로 삼는지는 명세에 없으니, 날짜를 정하려면 `params.std_dt`로 넘긴다.
     * 연속조회는 `collectTrPages`가 끝까지 따라간다(상한 `options.holdingsMaxPages`).
     */
    async fetchFractionalHoldings(params: Dict = {}): Promise<KbsecFractionalHoldingsFetch> {
        const result = await this.collectTrPages(KBSEC_TR.FRAC_HOLDINGS_KR, {
            jb_ccd: '1', is_cd: '', std_dt: '', hd_pin_no: '', ...params,
        }, (row) => ({
            symbol: `${kbsecNormalizeCode(pickStr(row, 'is_cd', 'iso_cd'))}/KRW`,
            name: pickStr(row, 'is_nm'),
            quantity: pickNum(row, 'hld_q'),
            orderableQuantity: pickNum(row, 'ordr_psbl_q'),
            averagePrice: pickNum(row, 'avr_uprc'),
            cost: pickNum(row, 'byng_amt'),
            marketValue: pickNum(row, 'val_amt'),
            unrealizedPnl: pickNum(row, 'val_pl'),
            unrealizedPnlRate: pickNum(row, 'val_pl_r'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length }, '[kbsec] 소수점 보유 연속조회가 잘렸다 — 목록에 없는 종목은 보유 0이 아니라 미확인이다');
        }
        return result;
    }

    /**
     * 해외 소수점 보유잔고(`SPQM5472`). 국내 `fetchFractionalHoldings`의 해외 짝이다.
     *
     * 원화외화구분코드(`krw_fcrncy_ccd`)는 설명된 값 중 외화(`2`)를 보낸다. 해외 정산 조회처럼 금액을 외화 축으로 받고, 행마다 통화코드를
     * `currency`로 돌려준다. 거래소 구분(`frgn_krx_ccd`)과 기준일자(`std_dt`)는 설명이 없는 선택 입력이라 비워 보낸다.
     * 연속조회는 끝까지 따라간다(상한 `options.holdingsMaxPages`).
     */
    async fetchOverseasFractionalHoldings(params: Dict = {}): Promise<KbsecOverseasFractionalHoldingsFetch> {
        const result = await this.collectTrPages(KBSEC_TR.FRAC_HOLDINGS_US, {
            is_cd: '', frgn_krx_ccd: '', std_dt: '', krw_fcrncy_ccd: '2', ...params,
        }, (row) => {
            const currency = pickStr(row, 'crncy_cd');
            return {
                symbol: `${kbsecNormalizeCode(pickStr(row, 'is_cd'))}/${currency || 'USD'}`,
                name: pickStr(row, 'is_nm'),
                quantity: pickNum(row, 'hld_q'),
                orderableQuantity: pickNum(row, 'ordr_psbl_q'),
                averagePrice: pickNum(row, 'avr_uprc'),
                cost: pickNum(row, 'byng_amt'),
                marketValue: pickNum(row, 'val_amt'),
                unrealizedPnl: pickNum(row, 'val_pl'),
                unrealizedPnlRate: pickNum(row, 'val_pl_r'),
                currency,
                info: row,
            };
        });
        if (result.truncated) {
            logger.warn({ rows: result.rows.length }, '[kbsec] 해외 소수점 보유 연속조회가 잘렸다 — 목록에 없는 종목은 보유 0이 아니라 미확인이다');
        }
        return result;
    }

    /**
     * 소수점 주문가능금액. 국내 종목은 `SSQN5472`, 미국 종목은 `SPQN5472`를 부른다. `amount`(주문금액)를 주면 그 금액으로 살 수 있는
     * 예상 수량과 예상 수수료가 함께 온다. 주문금액은 소수점 아래를 버린다(`createMarketBuyOrderWithCost`와 같다).
     *
     * 미국 쪽 입력은 이 TR 명세에 설명이 없다. 같은 필드를 쓰는 짝 주문 TR(`SKAM2201`) 명세의 값을 따른다: 거래소 `US`, 금액 기준
     * (`amt_q_clsf=0`), 외화(`crncy_ccd=1`, USD), 유사시장가(`frgn_ordr_typ_cd=E`). `createMarketBuyOrderWithCost`가 보내는 값과 같다.
     * 국내의 100%주문가능금액(`pcnt100_ordr_psbl_amt`)과 미국의 원화환산 통합주문가능금액은 `info`에 남는다.
     */
    async fetchFractionalBuyableAmount(symbol: string, amount: Num = undefined, params: Dict = {}): Promise<KbsecFractionalBuyable> {
        const market = this.market(symbol);
        const ordrAmt = amount !== undefined ? kbsecNum(Math.floor(amount)) : '';
        const common = (body: Dict) => ({
            expectedQuantity: pickNum(body, 'expct_stk_q_p6'),
            feeRate: pickNum(body, 'fee_r_p10'),
            referencePrice: pickNum(body, 'val_sprc_p8'),
            info: body,
        });
        if (!this.isUs(market)) {
            const body = await this.callTr(KBSEC_TR.FRAC_BUYABLE_KR, { is_cd: market.id, ordr_amt: ordrAmt, ...params });
            return { amount: pickNum(body, 'mx_ordr_psbl_amt'), currency: 'KRW', expectedFee: pickNum(body, 'expct_fee'), ...common(body) };
        }
        const body = await this.callTr(KBSEC_TR.FRAC_BUYABLE_US, {
            is_cd: market.id, frgn_krx_ccd: 'US', ordr_amt: ordrAmt, dcml_ordr_q_p6: '', amt_q_clsf: '0', crncy_ccd: '1',
            frgn_ordr_typ_cd: 'E', frgn_ordr_prc_p4: '', ...params,
        });
        return { amount: pickNum(body, 'fcrncy_unty_ordr_psbl_amt_p2'), currency: 'USD', expectedFee: pickNum(body, 'fcrncy_fee_p2'), ...common(body) };
    }

    /**
     * 국내 소수점 매매내역(`SSQM5765`). 주문구분(`ordr_clsf`)과 매매구분(`trd_clsf`)은 설명된 전체(`0`)를 보낸다.
     * 매매일자는 설명이 없는 선택 입력이라 `since`를 줄 때만 채우고(끝은 `params.until`, 없으면 오늘), 없으면 비워 보낸다.
     * 방향은 매매거래구분코드(`trd_dl_ccd`)를 `01` 매도, `02` 매수로 옮긴다(`SSAM5764` 명세의 설명). 그 밖의 값은 `unknown`이다.
     */
    async fetchFractionalTrades(since: Int = undefined, params: Dict = {}): Promise<KbsecFractionalTradesFetch> {
        const until = this.safeInteger(params, 'until');
        const from = since !== undefined ? kbsecDateKst(new Date(since)) : '';
        const to = until !== undefined ? kbsecDateKst(new Date(until)) : (since !== undefined ? this.todayKst() : '');
        const result = await this.collectTrPages(KBSEC_TR.FRAC_TRADES_KR, {
            ordr_clsf: '0', trd_clsf: '0', trd_strt_dt: from, trd_end_dt: to, is_cd: '', ...this.omit(params, 'until'),
        }, (row) => ({
            ...this.kstStamp(pickStr(row, 'trd_dt')),
            date: pickStr(row, 'trd_dt'),
            acceptNo: pickStr(row, 'acpt_no'),
            symbol: `${kbsecNormalizeCode(pickStr(row, 'is_cd'))}/KRW`,
            name: pickStr(row, 'is_nm'),
            side: kbsecTwoDigitSide(pickStr(row, 'trd_dl_ccd')),
            orderAmount: pickNum(row, 'ordr_amt'),
            orderQuantity: pickNum(row, 'dmstc_stk_dcml_ordr_q_p6'),
            orderPrice: pickNum(row, 'ordr_prc'),
            filledQuantity: pickNum(row, 'dmstc_stk_dcml_ccls_q_p6'),
            filledPrice: pickNum(row, 'ccls_prc'),
            filledAmount: pickNum(row, 'ccls_amt'),
            fee: pickNum(row, 'fee'),
            tax: pickNum(row, 'dl_tx'),
            settledAmount: pickNum(row, 'ec_amt'),
            rejectReason: pickStr(row, 'rfsl_rsn'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from, to }, '[kbsec] 소수점 매매내역 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다');
        }
        return result;
    }

    /**
     * 국내 온주/소수점 주문체결내역(`SSQM5475`). 소수점 서비스로 낸 주문을 온주(1주 단위) 부분까지 함께 준다.
     *
     * 매매구분(`trd_clsf`)은 설명된 전체(`99`), 주문상태(`ordr_st`)와 거래구분(`dl_clsf`)은 설명된 전체(`0`)를 보낸다.
     * 조회일자는 필수라 `since`가 없으면 오늘 하루다(끝은 `params.until`, 없으면 오늘). 출력에 매매구분 코드가 없어 방향은
     * 매매구분명(`sideName`) 원문으로만 준다. 기간별 매수·매도 합계(`prd_pr_*_sum`)는 옮기지 않는다.
     */
    async fetchFractionalOrders(since: Int = undefined, params: Dict = {}): Promise<KbsecFractionalOrdersFetch> {
        const until = this.safeInteger(params, 'until');
        const to = until !== undefined ? kbsecDateKst(new Date(until)) : this.todayKst();
        const from = since !== undefined ? kbsecDateKst(new Date(since)) : to;
        const result = await this.collectTrPages(KBSEC_TR.FRAC_ORDERS_KR, {
            inq_strt_dt: from, inq_end_dt: to, trd_clsf: '99', is_cd: '', ordr_st: '0', dl_clsf: '0', ...this.omit(params, 'until'),
        }, (row) => ({
            ...this.kstStamp(pickStr(row, 'ordr_dt'), pickStr(row, 'ordr_tm')),
            date: pickStr(row, 'ordr_dt'),
            time: pickStr(row, 'ordr_tm'),
            id: pickStr(row, 'ordr_no'),
            originalId: pickStr(row, 'orgn_ordr_no'),
            symbol: `${kbsecNormalizeCode(pickStr(row, 'shrt_is_cd', 'stnd_is_cd'))}/KRW`,
            name: pickStr(row, 'hngl_shrt_nm'),
            dealType: pickStr(row, 'dl_clsf'),
            sideName: pickStr(row, 'trd_clsf_nm'),
            orderAmount: pickNum(row, 'krw_ordr_amt'),
            orderQuantity: pickNum(row, 'ordr_q_p6'),
            orderPrice: pickNum(row, 'ordr_prc_p4'),
            filledQuantity: pickNum(row, 'dcml_ccls_q_p6'),
            filledPrice: pickNum(row, 'ccls_prc_p4'),
            filledAmount: pickNum(row, 'ccls_amt', 'ccls_amt_p3'),
            fee: pickNum(row, 'fee', 'fee_p4'),
            remainingQuantity: pickNum(row, 'nccls_q'),
            result: pickStr(row, 'hndl_rslt'),
            rejectReason: pickStr(row, 'rfsl_rsn_cntnt'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from, to }, '[kbsec] 소수점 주문체결내역 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다');
        }
        return result;
    }

    /**
     * 해외 소수점 주문접수내역(`SPQN5473`, 주문 화면용). 기간 입력이 없는 TR 이다.
     * 매매구분(`trd_clsf`)은 설명된 전체(`99`), 주문상태(`ordr_st`)는 설명된 전체(`3`)를 보낸다. 거래소 구분과 특화주문구분은 설명이 없어
     * 비워 보낸다. 방향은 매매구분 코드(`01` 매도, `02` 매수)를 옮기고, 통화는 행마다 `currency`로 준다.
     */
    async fetchOverseasFractionalOrders(params: Dict = {}): Promise<KbsecOverseasFractionalOrdersFetch> {
        const result = await this.collectTrPages(KBSEC_TR.FRAC_ORDERS_US, {
            trd_clsf: '99', is_cd: '', frgn_krx_ccd: '', ordr_st: '3', spclz_ordr_ccd: '', ...params,
        }, (row) => {
            const currency = pickStr(row, 'crncy_cd');
            return {
                date: pickStr(row, 'ordr_dt'),
                time: pickStr(row, 'acpt_tm'),
                acceptNo: pickStr(row, 'acpt_no'),
                symbol: `${kbsecNormalizeCode(pickStr(row, 'shrt_is_cd'))}/${currency || 'USD'}`,
                name: pickStr(row, 'is_nm'),
                side: kbsecTwoDigitSide(pickStr(row, 'trd_clsf')),
                currency,
                amount: pickNum(row, 'fcrncy_ordr_amt'),
                quantity: pickNum(row, 'ordr_q'),
                price: pickNum(row, 'frgn_ordr_prc_p4'),
                fee: pickNum(row, 'fee'),
                statusCode: pickStr(row, 'ordr_st'),
                result: pickStr(row, 'hndl_rslt'),
                info: row,
            };
        });
        if (result.truncated) {
            logger.warn({ rows: result.rows.length }, '[kbsec] 해외 소수점 주문접수내역 연속조회가 잘렸다');
        }
        return result;
    }

    /**
     * 해외 소수점 주문접수내역(`SPQM5473`). 주문 화면용 `fetchOverseasFractionalOrders`(`SPQN5473`)와 달리 매매일자, 체결 결과와 요약 그리드를 준다.
     *
     * 부점구분, 지점번호, 조회구분은 설명의 고정값(`1`, `999`, `1`)을 보낸다(공식 예제는 지점번호를 비운다). 주문상태, 매매구분, 원화외화구분은
     * 설명된 전체(`3`, `99`, `0`)를 보낸다. 합계구분, 해외거래소구분, 관리자사번은 설명이 없어 비워 보낸다. 매매일자도 설명이 없는 선택 입력이라
     * `since`를 줄 때만 `fetchOverseasOrders`처럼 미국 현지 일자로 채운다(끝은 `params.until`, 없으면 오늘). 행은 접수번호(`acpt_no`)가 있는
     * 그리드에서 읽고, 요약 그리드는 내보내지 않는다. 연속조회는 끝까지 따라가고, 상한(`holdingsMaxPages`)에 걸리면 `truncated`로 알린다.
     */
    async fetchOverseasFractionalOrderHistory(since: Int = undefined, params: Dict = {}): Promise<KbsecOverseasFractionalOrderHistoryFetch> {
        const until = this.safeInteger(params, 'until');
        const from = since !== undefined ? kbsecDateUsEastern(new Date(since)) : '';
        const to = until !== undefined ? kbsecDateUsEastern(new Date(until)) : (since !== undefined ? kbsecDateUsEastern(new Date(this.milliseconds())) : '');
        const result = await this.collectTrPages(KBSEC_TR.FRAC_ORDER_HISTORY_US, {
            dprt_clsf: '1', brn_no: '999', inq_clsf: '1', sum_clsf: '', ordr_st: '3', trd_strt_dt: from, trd_end_dt: to, trd_clsf: '99',
            krw_fcrncy_ccd: '0', is_cd: '', frgn_krx_ccd: '', mngr_eno: '', ...this.omit(params, 'until'),
        }, (row) => ({
            date: pickStr(row, 'trd_dt'),
            acceptNumber: pickStr(row, 'acpt_no'),
            shortCode: pickStr(row, 'shrt_is_cd'),
            standardCode: pickStr(row, 'stnd_is_cd'),
            name: pickStr(row, 'is_nm'),
            currency: pickStr(row, 'crncy_cd'),
            sideName: pickStr(row, 'trd_clsf_nm'),
            orderStatus: pickStr(row, 'ordr_st'),
            processStatus: pickStr(row, 'hndl_st'),
            quantity: pickNum(row, 'ordr_q'),
            filledQuantity: pickNum(row, 'ccls_q'),
            acceptTime: pickStr(row, 'ordr_acpt_tm'),
            info: row,
        }), undefined, (body) => pickGrid(body, (first) => 'acpt_no' in first).rows);
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from, to }, '[kbsec] 해외 소수점 주문접수내역 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다');
        }
        return result;
    }

    // ============ 예약주문 ============

    /**
     * 예약주문을 접수한다. 국내는 `SSAM0831`, 미국은 `SPAO2104`다. **라이브 미검증**이라 실계좌에서 최소 수량으로 먼저 확인할 것.
     *
     * 예약주문은 장 밖에서 걸어 두는 주문이라 거래시간 차단(`MarketClosed`)을 적용하지 않는다. 수량은 내림하고 1주 미만이면 거부한다.
     * 국내는 지정가(`00`)와 시장가(`03`)만, 미국은 지정가(`2`)만 받는다. 미국 시장가는 주문가격이 필수 입력인데 시장가일 때 보낼 값이
     * 명세에 없어 막는다. 신용유형은 현금(`00`)이다. 기간예약(`strt_dt`·`end_dt`), 시간 지정 같은 설명 없는 선택 입력은 비워 보내고
     * `params`로 채울 수 있다. 두 TR 모두 `KBSEC_ORDER_TR_CODES`에 있어 실패해도 재시도하지 않는다.
     */
    async createReservedOrder(
        symbol: string, type: OrderType, side: OrderSide, amount: number, price: Num = undefined, params: Dict = {},
    ): Promise<KbsecReservedOrder> {
        const market = this.market(symbol);
        const base = market.id as string;
        const isKr = !this.isUs(market);
        if (type !== 'limit' && type !== 'market') throw new NotSupported(`${this.id} createReservedOrder() 는 지정가와 시장가만 지원한다: ${type}`);
        if (!isKr && type === 'market') throw new NotSupported(`${this.id} 미국 예약주문은 지정가만 지원한다(시장가의 주문가격 값이 명세에 없다)`);
        this.checkOrderArguments(market, type, side, amount, price, params);
        const submittedQty = Math.floor(amount);
        if (submittedQty < 1) {
            throw new InvalidOrder(`${this.id} 예약주문은 1주 미만을 낼 수 없다 (수량 ${amount})`, { detail: KBSEC_ERROR_DETAIL.QUANTITY_INVALID });
        }
        const isLimit = type === 'limit';
        let response: Dict;
        if (isKr) {
            response = await this.callTr(KBSEC_TR.RESERVED_ORDER_KR, {
                ordr_jb_clsf: side === 'buy' ? KBSEC_ORDER_SIDE_KR.BUY : KBSEC_ORDER_SIDE_KR.SELL,
                is_cd: base,
                ordr_uprc: isLimit ? kbsecNum(price ?? 0) : '',
                ordr_q: kbsecNum(submittedQty),
                ordr_ccd: isLimit ? KBSEC_ORDER_TYPE_KR.LIMIT : KBSEC_ORDER_TYPE_KR.MARKET,
                crdt_typ_cd: KBSEC_CREDIT_CASH,
                ln_dt: '', cncl_ordr_no: '', tv_rv_ccd: '', strt_dt: '', end_dt: '', mkt_tm_ccd: '',
                ...params,
            });
        } else {
            response = await this.callTr(KBSEC_TR.RESERVED_ORDER_US, {
                is_cd: base,
                trd_dl_ccd: side === 'buy' ? KBSEC_ORDER_SIDE_US.BUY : KBSEC_ORDER_SIDE_US.SELL,
                ordr_typ_cd: KBSEC_ORDER_TYPE_US.LIMIT,
                ordr_q: kbsecNum(submittedQty),
                frgn_ordr_prc_p4: kbsecNum(price ?? 0, 4),
                strt_tm: '', end_tm: '', ovtm_ordr_ccd: '', bskt_ordr_no: '', frgn_stp_prc_p4: '',
                ...params,
            });
        }
        const id = pickStr(response, isKr ? 'ordr_no' : 'rsrv_ordr_no');
        logger.info({ symbol, side, type, submittedQty, price, id }, `[kbsec] ${isKr ? '국내' : '해외'} 예약주문 접수`);
        return {
            id: id === '' ? undefined : id,
            symbol: market.symbol,
            side: side === 'buy' ? 'buy' : 'sell',
            type,
            amount: submittedQty,
            price: isLimit ? price : undefined,
            info: response,
        };
    }

    /**
     * 미국 예약주문을 취소한다(`SPAO2106`). **라이브 미검증**이다. 국내 예약주문을 취소하는 TR 은 명세에 없어 `NotSupported`다.
     * 종목코드(필수)와 취소주문번호(`cncl_ordr_no`)에 예약주문번호를 넣고, 설명이 없는 나머지 입력은 비워 보낸다.
     */
    async cancelReservedOrder(id: string, symbol: string, params: Dict = {}): Promise<KbsecReservedOrderCancel> {
        const market = this.market(symbol);
        if (!this.isUs(market)) throw new NotSupported(`${this.id} 국내 예약주문 취소 TR 이 명세에 없다`);
        const response = await this.callTr(KBSEC_TR.RESERVED_CANCEL_US, {
            is_cd: market.id, trd_clsf: '', ordr_typ: '', ordr_q: '', frgn_ordr_prc_p4: '', cncl_ordr_no: id, ...params,
        });
        const orderNo = pickStr(response, 'ordr_no');
        logger.info({ symbol, reservedOrderId: id, orderNo }, '[kbsec] 해외 예약주문 취소 접수');
        return { id: orderNo === '' ? undefined : orderNo, reservedOrderId: id, info: response };
    }

    /**
     * 국내 예약주문 처리 결과(`SSQM0831`). 매매구분, 처리구분, 전량잔량구분은 설명된 전체(`0`)를 보낸다.
     * 주문일자는 필수라 `since`가 없으면 오늘이다. 종료일자는 선택 입력이라 `params.until`이나 `since`가 있을 때만 채운다(없으면 오늘).
     */
    async fetchReservedOrderResults(since: Int = undefined, params: Dict = {}): Promise<KbsecReservedOrderResultsFetch> {
        const until = this.safeInteger(params, 'until');
        const from = since !== undefined ? kbsecDateKst(new Date(since)) : this.todayKst();
        const to = until !== undefined ? kbsecDateKst(new Date(until)) : (since !== undefined ? this.todayKst() : '');
        const result = await this.collectTrPages(KBSEC_TR.RESERVED_RESULTS_KR, {
            ordr_dt: from, trd_clsf: '0', hndl_clsf: '0', tv_rv_ccd: '0', end_dt: to, is_cd: '', ...this.omit(params, 'until'),
        }, (row) => ({
            ...this.kstStamp(pickStr(row, 'ordr_dt')),
            date: pickStr(row, 'ordr_dt'),
            sequence: pickStr(row, 'sq'),
            symbol: `${kbsecNormalizeCode(pickStr(row, 'is_no'))}/KRW`,
            name: pickStr(row, 'is_nm'),
            sideName: pickStr(row, 'ordr_clsf_nm'),
            orderTypeCode: pickStr(row, 'ordr_ccd'),
            quantity: pickNum(row, 'ordr_q'),
            price: pickNum(row, 'ordr_uprc'),
            orderId: pickStr(row, 'ordr_no'),
            orderedName: pickStr(row, 'ordr_f_nm'),
            message: pickStr(row, 'msg'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from, to }, '[kbsec] 예약주문 처리 결과 연속조회가 잘렸다');
        }
        return result;
    }

    /**
     * 국내 예약주문 접수 목록(`SSQM0834`). 처리구분은 설명된 고정값(`1`), 선택구분은 설명된 일반예약주문(`1`),
     * 조회구분은 설명된 전체(`3`)를 보낸다. 기간은 선택 입력이라 `since`를 줄 때만 채운다(끝은 `params.until`, 없으면 오늘).
     */
    async fetchReservedOrders(since: Int = undefined, params: Dict = {}): Promise<KbsecReservedOrdersFetch> {
        const until = this.safeInteger(params, 'until');
        const from = since !== undefined ? kbsecDateKst(new Date(since)) : '';
        const to = until !== undefined ? kbsecDateKst(new Date(until)) : (since !== undefined ? this.todayKst() : '');
        const result = await this.collectTrPages(KBSEC_TR.RESERVED_ORDERS_KR, {
            hndl_clsf: '1', chc_clsf: '1', inq_clsf: '3', strt_dt: from, end_dt: to, is_cd: '', ...this.omit(params, 'until'),
        }, (row) => ({
            sequence: pickStr(row, 'sq'),
            symbol: `${kbsecNormalizeCode(pickStr(row, 'is_no'))}/KRW`,
            name: pickStr(row, 'is_nm'),
            side: kbsecTwoDigitSide(pickStr(row, 'trd_dl_ccd')),
            sideName: pickStr(row, 'trd_ccd_nm'),
            quantity: pickNum(row, 'ordr_q'),
            price: pickNum(row, 'ordr_uprc'),
            reservationTypeName: pickStr(row, 'tv_rv_ccd_nm'),
            cancelName: pickStr(row, 'cncl_clsf_nm'),
            registeredDate: pickStr(row, 'rgst_dt'),
            ...this.kstStamp(pickStr(row, 'ordr_dt')),
            orderDate: pickStr(row, 'ordr_dt'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from, to }, '[kbsec] 예약주문 접수 목록 연속조회가 잘렸다');
        }
        return result;
    }

    // ============ 거래 상세, 권리, 해외 주문내역 ============

    /**
     * 거래 한 건의 상세(`SWQM2412`). `fetchAccountLedger` 행의 일자(`date`)와 거래일련번호(`sequence`)를 넣어 부른다.
     *
     * 출력에 그리드 표지(`grid_cnt` 등)가 없어 한 건짜리 응답으로 읽는다. 목록을 주는 KB TR 은 모두 그리드 표지가 있고, 표지가 없는
     * `SWQN2302`는 한 건짜리였다. 거래일련번호와 거래종류 필드가 둘 다 응답에 없으면 0 을 채운 빈 거래를 만들지 않고 던진다.
     */
    async fetchLedgerEntryDetail(date: string, sequence: string, params: Dict = {}): Promise<KbsecLedgerEntryDetail> {
        const body = await this.callTr(KBSEC_TR.LEDGER_DETAIL, { inq_dt: date, dl_sq: sequence, ...params });
        if (!('dl_sq' in body) && !('dl_knd_cd' in body)) {
            throw new BadResponse(`${this.id} 거래내역상세 응답에 거래일련번호와 거래종류 필드가 없다 (${KBSEC_TR.LEDGER_DETAIL})`);
        }
        return {
            sequence: pickStr(body, 'dl_sq'),
            kindCode: pickStr(body, 'dl_knd_cd'),
            kindName: pickStr(body, 'dl_knd_nm'),
            code: pickStr(body, 'is_no'),
            name: pickStr(body, 'is_nm'),
            quantity: pickNum(body, 'dl_q'),
            price: pickNum(body, 'uprc_p4'),
            amount: pickNum(body, 'dl_amt'),
            fee: pickNum(body, 'fee'),
            tax: pickNum(body, 'dl_tx'),
            settledAmount: pickNum(body, 'ec_amt'),
            summary: pickStr(body, 'smry'),
            cashBalance: pickNum(body, 'tfnd_tdy_ra'),
            info: body,
        };
    }

    /**
     * 계좌 권리 발생 내역(`SRQM3051`). 배당, 유상증자, 무상증자 같은 권리의 배정과 지급을 준다.
     * 권리구분(`rgt_clsf`)은 설명된 전체(`0`)를 보낸다. 시작일자는 설명이 없는 선택 입력이라 `since`를 줄 때만 채운다.
     */
    async fetchCorporateActions(since: Int = undefined, params: Dict = {}): Promise<KbsecCorporateActionsFetch> {
        const from = since !== undefined ? kbsecDateKst(new Date(since)) : '';
        const result = await this.collectTrPages(KBSEC_TR.CORPORATE_ACTIONS, {
            strt_dt: from, rgt_clsf: '0', is_cd: '', ...params,
        }, (row) => ({
            ...this.kstStamp(pickStr(row, 'bss_dt')),
            baseDate: pickStr(row, 'bss_dt'),
            symbol: `${kbsecNormalizeCode(pickStr(row, 'is_cd'))}/KRW`,
            name: pickStr(row, 'is_nm'),
            rightName: pickStr(row, 'rgt_ccd_nm'),
            quantity: pickNum(row, 'hld_q'),
            allocatedQuantity: pickNum(row, 'alct_q'),
            rightRatio: pickNum(row, 'rgt_rt'),
            issuePrice: pickNum(row, 'isng_prc'),
            cashPaymentDate: pickStr(row, 'csh_py_dt'),
            stockDate: pickStr(row, 'stck_io_stck_dt'),
            expectedDividend: pickNum(row, 'dvdnd_expt_amt'),
            confirmedDividend: pickNum(row, 'dvdnd_dfnt_amt'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from }, '[kbsec] 권리 발생 내역 연속조회가 잘렸다');
        }
        return result;
    }

    /**
     * 해외 주문내역(`SPQM1818`, 주문번호별). 체결과 미체결 주문을 함께 준다.
     *
     * 체결구분과 거래구분은 설명된 전체(`0`), 매매구분은 설명된 전체(`99`), 원화통합증거금신청여부는 설명된 외화(`0`)를 보낸다.
     * 주문일자는 설명이 없는 선택 입력이라 `since`를 줄 때만 미국 현지 일자로 채운다(끝은 `params.until`, 없으면 오늘). 해외 정산 조회
     * (`SPQM2205`)가 미국 현지 일자로 확인됐다. 시작시간과 종료시간은 설명이 없어 비워 보낸다(공식 예제의 `090000`은 시간 필터다).
     * 응답에 티커가 없어 표준종목코드를 원문으로 주고, 주문상태도 이름만 오므로 원문으로 준다. 미체결만 보려면 `params.ccls_clsf`를 `2`로 준다.
     */
    async fetchOverseasOrders(since: Int = undefined, params: Dict = {}): Promise<KbsecOverseasOrdersFetch> {
        const until = this.safeInteger(params, 'until');
        const from = since !== undefined ? kbsecDateUsEastern(new Date(since)) : '';
        const to = until !== undefined ? kbsecDateUsEastern(new Date(until)) : (since !== undefined ? kbsecDateUsEastern(new Date(this.milliseconds())) : '');
        const result = await this.collectTrPages(KBSEC_TR.ORDER_HISTORY_US, {
            strt_ordr_dt: from, end_ordr_dt: to, ccls_clsf: '0', frgn_krx_ccd: '', trd_clsf: '99', stnd_is_cd: '', iso_cd: '',
            krw_unty_mgn_rqst_f: '0', start_tm: '', end_tm: '', dl_clsf: '0', ...this.omit(params, 'until'),
        }, (row) => ({
            date: pickStr(row, 'ordr_dt'),
            time: pickStr(row, 'ordr_tm'),
            id: pickStr(row, 'ordr_no'),
            originalId: pickStr(row, 'orgn_ordr_no'),
            standardCode: pickStr(row, 'stnd_is_cd'),
            name: pickStr(row, 'is_nm'),
            statusName: pickStr(row, 'ordr_st_nm'),
            orderTypeName: pickStr(row, 'ordr_clsf_nm'),
            currency: pickStr(row, 'crncy_cd'),
            quantity: pickNum(row, 'frgn_ordr_q_p6'),
            price: pickNum(row, 'frgn_ordr_prc_p6'),
            filledQuantity: pickNum(row, 'ccls_q_p6'),
            filledPrice: pickNum(row, 'frgn_ccls_prc_p6'),
            remainingQuantity: pickNum(row, 'nccls_q_p6'),
            rejectReason: pickStr(row, 'rfsl_rsn'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from, to }, '[kbsec] 해외 주문내역 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다');
        }
        return result;
    }

    /**
     * 해외 체결현황(`SPQM2204`). `fetchOverseasOrders`(`SPQM1818`)와 같은 주문 목록에 단축종목코드를 더 준다.
     *
     * 시작과 종료 주문일자가 필수 입력이라 `since`가 없으면 던진다. 날짜는 `fetchOverseasOrders`처럼 미국 현지 일자이고, 끝은 `params.until`,
     * 없으면 오늘이다. 체결구분, 매매구분, 거래구분은 설명된 전체(`0`, `99`, `0`)를 보낸다. 해외거래소구분, ISO코드, 원화통합증거금신청여부,
     * 다이렉트인덱싱여부는 설명이 없어 비워 보낸다. 미체결만 보려면 `params.ccls_clsf`를 `2`로 준다. 연속조회는 끝까지 따라가고,
     * 상한(`holdingsMaxPages`)에 걸리면 `truncated`로 알린다.
     */
    async fetchOverseasOrderStatus(since: Int = undefined, params: Dict = {}): Promise<KbsecOverseasOrderStatusFetch> {
        if (since === undefined) throw new ArgumentsRequired(`${this.id} fetchOverseasOrderStatus() 는 since 인자가 필요하다(시작 주문일자가 필수 입력이다)`);
        const until = this.safeInteger(params, 'until');
        const from = kbsecDateUsEastern(new Date(since));
        const to = kbsecDateUsEastern(new Date(until ?? this.milliseconds()));
        const result = await this.collectTrPages(KBSEC_TR.ORDER_STATUS_US, {
            strt_ordr_dt: from, end_ordr_dt: to, ccls_clsf: '0', frgn_krx_ccd: '', trd_clsf: '99', stnd_is_cd: '', iso_cd: '',
            krw_unty_mgn_rqst_f: '', dl_clsf: '0', drid_f: '', ...this.omit(params, 'until'),
        }, (row) => ({
            date: pickStr(row, 'ordr_dt'),
            time: pickStr(row, 'ordr_tm'),
            id: pickStr(row, 'ordr_no'),
            originalId: pickStr(row, 'orgn_ordr_no'),
            standardCode: pickStr(row, 'stnd_is_cd'),
            shortCode: pickStr(row, 'shrt_is_cd'),
            name: pickStr(row, 'shrt_is_nm'),
            statusName: pickStr(row, 'ordr_st_nm'),
            orderTypeName: pickStr(row, 'ordr_clsf_nm'),
            currency: pickStr(row, 'crncy_cd'),
            quantity: pickNum(row, 'frgn_ordr_q_p6'),
            price: pickNum(row, 'frgn_ordr_prc_p6'),
            filledQuantity: pickNum(row, 'ccls_q_p6'),
            filledPrice: pickNum(row, 'frgn_ccls_prc_p6'),
            remainingQuantity: pickNum(row, 'nccls_q_p6'),
            rejectReason: pickStr(row, 'rfsl_rsn'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from, to }, '[kbsec] 해외 체결현황 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다');
        }
        return result;
    }

    /**
     * 계좌원장 거래내역(`SWQA2301`, 위탁·금융상품·저축 계좌). 입금·출금·입고·출고·매수·매도를 날짜 범위로 준다.
     *
     * ccxt `fetchLedger`로 옮기지 않는다. 원장 항목의 `type`(trade·transaction·fee)과 `direction`(in·out)을 채우려면
     * 적요유형코드(`smry_typ_cd`)·거래유형코드(`dl_typ_cd`)의 뜻을 알아야 하는데 명세에 없고, 한글 적요명을 문자열로 가르는 것은 추측이다.
     *
     * 입력은 세 규칙으로 채운다. 필수 입력 조회구분(`inq_clsf`)은 공식 예제값 `1`, 설명이 있는 선택 입력은 설명대로
     * (입금~매도 여섯 플래그 `1:설정`, 정렬 `1:과거순`), **설명이 없는 선택 입력**(`dl_md_ccd` 거래매체구분코드, `onl_prt_ccd`,
     * `md_isnc_tno`, `crdt_crd_isnc_info`, `isng_bl_at_trsns_xcl_f`)은 비워 보낸다. 필터일 수 있는 값을 예제대로 채우면 일부 거래가
     * 조용히 빠질 수 있고, 비워서 거부되면 오류로 드러난다. 거래구분(`dl_clsf`, `1:간편거래로 출력`)은 필드가 줄 수 있어 비운다.
     *
     * 기간은 한국 날짜 단위다. `since`가 있으면 그날부터, 없으면 오늘 하루치다. 끝은 `params.until`(ms)이 있으면 그날, 없으면 오늘이다.
     * 연속조회 상한은 `options.ledgerMaxPages`이고, 걸리면 `truncated`가 `true`다(기간을 좁혀 다시 부른다).
     */
    async fetchAccountLedger(since: Int = undefined, params: Dict = {}): Promise<KbsecLedgerFetch> {
        return this.fetchLedgerRows(KBSEC_TR.LEDGER, { dl_clsf: '' }, since, params);
    }

    /**
     * CMA 계좌원장 거래내역(`SWQB2301`). 입력 규칙과 기간, 연속조회는 `fetchAccountLedger`와 같다. 다른 점은 셋이다.
     * 거래구분(`dl_clsf`) 입력이 없다. 설명이 없는 선택 입력 현금자산이자입금제외여부(`csh_asts_itst_i_amt_xcl_f`)가 하나 더 있어 비워 보낸다.
     * 출력의 거래단가가 `dl_uprc`가 아니라 `uprc`(단가)다.
     */
    async fetchCmaLedger(since: Int = undefined, params: Dict = {}): Promise<KbsecLedgerFetch> {
        return this.fetchLedgerRows(KBSEC_TR.LEDGER_CMA, { csh_asts_itst_i_amt_xcl_f: '' }, since, params);
    }

    /** 두 계좌원장 TR(`SWQA2301`·`SWQB2301`)의 공통 조회. `trFields`는 TR마다 다른 입력이다. */
    private async fetchLedgerRows(trCode: string, trFields: Dict, since: Int, params: Dict): Promise<KbsecLedgerFetch> {
        const until = this.safeInteger(params, 'until');
        const endDt = until !== undefined ? kbsecDateKst(new Date(until)) : this.todayKst();
        const strtDt = since !== undefined ? kbsecDateKst(new Date(since)) : endDt;
        const result = await this.collectTrPages(trCode, {
            inq_clsf: '1',
            inq_clsf1: '1', inq_clsf2: '1', inq_clsf3: '1', inq_clsf4: '1', inq_clsf5: '1', inq_clsf6: '1',
            strt_dt: strtDt, end_dt: endDt, is_no: '', strt_no: '', srt_clsf: '1',
            dl_md_ccd: '', md_isnc_tno: '', crdt_crd_isnc_info: '', onl_prt_ccd: '', isng_bl_at_trsns_xcl_f: '',
            ...trFields,
            ...this.omit(params, 'until'),
        }, (row) => ({
            ...this.kstStamp(pickStr(row, 'dl_dt')),
            date: pickStr(row, 'dl_dt'),
            sequence: pickStr(row, 'dl_sq'),
            summary: pickStr(row, 'smry_nm'),
            standardCode: pickStr(row, 'stnd_is_cd'),
            name: pickStr(row, 'is_nm'),
            quantity: pickNum(row, 'q'),
            price: pickNum(row, 'dl_uprc', 'uprc'),
            amount: pickNum(row, 'dl_amt'),
            settledAmount: pickNum(row, 'ec_amt'),
            fee: pickNum(row, 'fee'),
            cashBalance: pickNum(row, 'tfnd_blnc'),
            info: row,
        }), this.options.ledgerMaxPages as number);
        if (result.truncated) {
            logger.warn({ trCode, rows: result.rows.length, strtDt, endDt }, '[kbsec] 계좌원장 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다');
        }
        return result;
    }

    /**
     * 다음키(`nxt_key`)가 있는 목록 TR을 끝까지 읽어 행을 모은다. 첫 페이지만 보면 2페이지 이후 행이 결과에서 빠진다.
     *
     * - 다음키가 빈 값이면 멈춘다(KB 는 마지막 페이지에 공백을 주고, `pickStr`가 잘라낸다).
     * - 같은 다음키가 되풀이되면 그 페이지는 버리고 `truncated`로 표시한다. 담으면 같은 행이 두 번 들어간다.
     * - 페이지 상한은 `maxPages`(기본 `options.holdingsMaxPages`)다. 상한에 걸리면 `truncated`로 표시한다.
     * - 호출하는 쪽이 `request`에 넣은 `nxt_key`는 무시하고 처음부터 읽는다.
     * - 행은 첫 배열에서 읽는다. 그리드가 둘 이상인 TR 은 `rowsOf`로 행 그리드를 고른다.
     *
     * 조회 실패는 그대로 던진다(빈 목록으로 삼키지 않는다).
     */
    private async collectTrPages<T>(
        trCode: string, request: Dict, parse: (row: Dict) => T, maxPages = this.options.holdingsMaxPages as number,
        rowsOf: (body: Dict) => Dict[] = pickArray,
    ): Promise<{ rows: T[]; truncated: boolean }> {
        const base = this.omit(request, 'nxt_key');
        const rows: T[] = [];
        let nextKey = '';
        let truncated = false;
        for (let page = 0; page < maxPages; page++) {
            // 연속구분(`cn_clsf`)을 받는 TR 은 둘째 페이지부터 `1`(연속)을 보낸다.
            const continued = nextKey !== '' && 'cn_clsf' in base ? { cn_clsf: KBSEC_CONT_NEXT } : {};
            const body = await this.callTr(trCode, { ...base, ...continued, nxt_key: nextKey });
            const pageRows = rowsOf(body).map(parse);
            const prevKey = nextKey;
            nextKey = pickStr(body, 'nxt_key');
            if (nextKey !== '' && nextKey === prevKey) {
                truncated = true;
                break;
            }
            rows.push(...pageRows);
            if (nextKey === '') break;
            if (page === maxPages - 1) truncated = true;
        }
        return { rows, truncated };
    }

    /**
     * 익일·익익일 출금가능금액(`SWQN2302`). 매도대금이 결제되는 날을 기준으로 출금할 수 있는 금액이다.
     *
     * 구분코드(`ccd`)는 명세에 설명이 있는 값 `1`(익일·익익일 예수금 포함)을 보낸다. 다른 값의 뜻은 명세에 없다.
     * 출금가능금액 두 필드가 응답에 모두 없으면 0 을 돌려주지 않고 던진다. 0 이면 "출금할 돈이 없다"와 "모른다"가 섞인다.
     */
    async fetchWithdrawableAmount(params: Dict = {}): Promise<KbsecWithdrawableAmount> {
        const body = await this.callTr(KBSEC_TR.WITHDRAWABLE, { ccd: '1', ...params });
        if (!('ndy_o_amt_psbl_amt' in body) && !('nxt2_dy_o_amt_psbl_amt' in body)) {
            throw new BadResponse(`${this.id} 출금가능금액 응답에 익일·익익일 출금가능금액 필드가 없다 (${KBSEC_TR.WITHDRAWABLE})`);
        }
        return {
            nextDay: pickNum(body, 'ndy_o_amt_psbl_amt'),
            dayAfterNext: pickNum(body, 'nxt2_dy_o_amt_psbl_amt'),
            deposit: pickNum(body, 'tfnd_amt'),
            nextDayDeposit: pickNum(body, 'ndy_tfnd_amt'),
            dayAfterNextDeposit: pickNum(body, 'nxt2_dy_tfnd_amt'),
            info: body,
        };
    }

    /**
     * 예수금 상세(`SWQM2302`). 증거금, 대용, 담보, 대출, 미수 금액 100여 필드를 한 레코드로 준다. 응답을 원문으로 돌려준다.
     * 대용총액(`sbt_tl_amt`)이 한 레코드에 두 번 있어서 JSON 에는 한 값만 남고, 어느 쪽이 남는지 명세로 가를 수 없다.
     * 익일·익익일 출금가능금액만 필요하면 `fetchWithdrawableAmount`를 쓴다.
     */
    async fetchDepositDetails(params: Dict = {}): Promise<KbsecRawResponse> {
        return kbsecRawResponse(await this.callTr(KBSEC_TR.DEPOSIT_DETAIL, { ...params }));
    }

    /**
     * 글로벌원마켓 증거금사용현황(`SPQN3390`). 응답을 원문으로 돌려준다. 결제일자별 출금액 필드와 증거금구분별 그리드가 같은 이름
     * (`iso_cd`, `prt_clsf`, `o_amt1`~`o_amt4`)을 쓰는데, 그리드 경계와 데이터1~4(`data1`~`data4`)의 뜻이 명세에 없다.
     */
    async fetchOneMarketMarginUsage(params: Dict = {}): Promise<KbsecRawResponse> {
        return kbsecRawResponse(await this.callTr(KBSEC_TR.ONEMARKET_MARGIN_USAGE, { ...params }));
    }

    /** 원마켓플러스 매매정산현황 상세(`SKQO3390`). 항목명과 항목데이터1~4로 된 표다. 항목데이터가 무엇인지 명세에 없어 원문 문자열로 준다. */
    async fetchOneMarketSettlementDetail(params: Dict = {}): Promise<KbsecOneMarketSettlementItem[]> {
        const body = await this.callTr(KBSEC_TR.ONEMARKET_SETTLEMENT_DETAIL, { ...params });
        return pickArray(body).map((row) => ({
            index: pickStr(row, 'idx'),
            isoCode: pickStr(row, 'iso_cd'),
            currency: pickStr(row, 'crncy_cd'),
            name: pickStr(row, 'item_hngl_nm'),
            englishName: pickStr(row, 'item_eng_nm'),
            values: ['item_data1', 'item_data2', 'item_data3', 'item_data4'].map((key) => pickStr(row, key)),
            info: row,
        }));
    }

    /**
     * 총 잔고 조회(`SSQM0005`). 계좌마다 평가액, 예수금액, 출금가능금액을 준다. 조회구분은 설명대로 계좌정보(`3`)를 보낸다(공식 예제는 `1`).
     * 상품그룹코드는 설명된 전체(`00`)를, 체결결제구분은 공식 예제처럼 체결기준(`1`)을 보낸다. 출력 이름과 같은 입력 세 개(`tl_val_amt` 등)는
     * 비워 보낸다. 응답 머리의 총액은 내보내지 않는다. 연속조회에서 페이지별 합계인지 전체 합계인지 명세에 없다.
     */
    async fetchAccountSummary(params: Dict = {}): Promise<KbsecAccountSummaryFetch> {
        const result = await this.collectTrPages(KBSEC_TR.ACCOUNT_SUMMARY, {
            inq_clsf: '3', tl_val_amt: '', tl_tfnd_amt: '', tl_o_amt_psbl_amt: '', gds_grp_cd: '00', ccls_stmt_clsf: '1', ...params,
        }, (row) => ({
            accountNumber: pickStr(row, 'ac_no'),
            nickname: pickStr(row, 'ac_ncknm'),
            productTypeCode: pickStr(row, 'gds_typ_cd'),
            productTypeName: pickStr(row, 'gds_typ_dtls_nm'),
            statusCode: pickStr(row, 'gds_st_ccd'),
            valuation: pickNum(row, 'val_amt'),
            deposit: pickNum(row, 'tfnd_amt'),
            withdrawable: pickNum(row, 'o_amt_psbl_amt'),
            dayAfterNextDeposit: pickNum(row, 'nxt2_dy_tfnd'),
            lastTradeDate: pickStr(row, 'fnl_dl_dt'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length }, '[kbsec] 총 잔고 연속조회가 잘렸다');
        }
        return result;
    }

    /**
     * 주식자산평가 실시간(`SSQN2952`). 거래소시세구분은 설명대로 통합(`A`)을 보낸다(공식 예제는 `1`). 같은 이름의 입력을 계좌자산평가(`SSQM2952`)가
     * A, K, N 으로 받는 것은 실계좌로 확인했다. 특화주문구분은 설명에 퇴직연금 코드(51, 52)만 있어 일반 계좌로 부를 때는 비워 보낸다.
     * 합계구분은 공식 예제처럼 합산(`1`)을, 익익일예수금제외여부는 공식 예제처럼 빈값을 보낸다. 종목코드는 설명이 없는 선택 입력이라 비워 보낸다.
     */
    async fetchRealtimeAssetValuation(params: Dict = {}): Promise<KbsecRealtimeAssetValuation> {
        const body = await this.callTr(KBSEC_TR.ASSET_EVAL_REALTIME, {
            is_cd: '', sum_clsf: '1', spclz_ordr_ccd: '', nxt2_dy_tfnd_xcl_f: '', excg_mktpr_ccd: 'A', ...params,
        });
        return {
            realizedPnlToday: pickNum(body, 'thdy_rlztn_pl'),
            purchaseAmount: pickNum(body, 'byng_amt_sum'),
            creditLoan: pickNum(body, 'tl_crdt_ln_amt'),
            nextDayDeposit: pickNum(body, 'ndy_tfnd'),
            dayAfterNextDeposit: pickNum(body, 'nxt2_dy_tfnd'),
            holdings: pickArray(body).map((row) => ({
                shortCode: pickStr(row, 'shrt_is_cd'),
                standardCode: pickStr(row, 'stnd_is_cd'),
                name: pickStr(row, 'is_nm'),
                creditTypeName: pickStr(row, 'crdt_typ_nm'),
                quantity: pickNum(row, 'blnc_q_p6'),
                orderableQuantity: pickNum(row, 'ordr_psbl_q_p6'),
                averagePrice: pickNum(row, 'byng_avr_prc'),
                purchaseAmount: pickNum(row, 'byng_amt'),
                price: pickNum(row, 'now_prc'),
                valuation: pickNum(row, 'val_amt'),
                unrealizedPnl: pickNum(row, 'val_pl'),
                returnRate: pickNum(row, 'val_yld'),
                info: row,
            })),
            info: body,
        };
    }

    /**
     * 종합계좌 잔고현황(`SSQM2932`, 종합위탁계좌와 신연금저축계좌). 조회구분은 설명의 계좌별(`1`), 유가증권구분은 설명된 전체(`0`)를 보낸다.
     * 채권평가방법은 공식 예제처럼 빈 값을 보낸다. 설명이 없는 거래소시세구분(`excg_mktpr_ccd`)은 실계좌에서 공식 예제값 `1`과 형제 TR 의
     * 통합(`A`)이 모두 받아들여졌고 결과가 같아서, 형제 TR 과 맞춰 `A`를 보낸다.
     */
    async fetchIntegratedBalance(params: Dict = {}): Promise<KbsecIntegratedBalance> {
        const body = await this.callTr(KBSEC_TR.INTEGRATED_BALANCE, { inq_clsf: '1', scrts_ccd: '0', bnd_val_wy_cd: '', excg_mktpr_ccd: 'A', ...params });
        return {
            valuation: pickNum(body, 'val_amt_sum'),
            purchaseAmount: pickNum(body, 'byng_amt_sum'),
            pnl: pickNum(body, 'pl_amt_sum'),
            deposit: pickNum(body, 'tfnd'),
            orderableCash: pickNum(body, 'ordr_psbl_csh'),
            withdrawable: pickNum(body, 'o_amt_psbl_amt'),
            holdings: pickArray(body).filter((row) => pickStr(row, 'is_cd') !== '').map((row) => ({
                code: pickStr(row, 'is_cd'),
                name: pickStr(row, 'is_nm'),
                productType: pickStr(row, 'gds_typ'),
                kind: pickStr(row, 'clsf'),
                currency: pickStr(row, 'crncy_cd'),
                quantity: pickNum(row, 'blnc_q_p6'),
                orderableQuantity: pickNum(row, 'ordr_psbl_q_p6'),
                averagePrice: pickNum(row, 'byng_avr_prc'),
                price: pickNum(row, 'now_prc'),
                valuation: pickNum(row, 'val_amt'),
                pnl: pickNum(row, 'pl_amt'),
                returnRate: pickNum(row, 'yld'),
                info: row,
            })),
            info: body,
        };
    }

    /**
     * 개인별 쿠폰(`SZQM6019`). 수수료 혜택 같은 쿠폰의 금액과 유효기간을 읽는다.
     *
     * 상태구분(`st_clsf`)은 설명이 없는 선택 입력이라 비워 보낸다. 공식 예시값 `1`이 어느 상태를 고르는지 모르므로, 예시값을 따르면
     * 다른 상태의 쿠폰이 조용히 빠질 수 있다. 대표고객번호(`rprst_cs_no`)는 "계좌 또는 고객번호 필수"지만 계좌가 앱키에 묶이므로 비워 보낸다.
     * 연속조회 키가 없는 TR 이라 한 번만 부른다. 쿠폰코드와 쿠폰명이 모두 빈 행은 쿠폰이 아니라서 거른다.
     */
    async fetchCoupons(params: Dict = {}): Promise<KbsecCoupon[]> {
        const body = await this.callTr(KBSEC_TR.COUPONS, { rprst_cs_no: '', st_clsf: '', ...params });
        return pickArray(body)
            .filter((row) => pickStr(row, 'cpn_cd') !== '' || pickStr(row, 'cpn_isng_nm') !== '')
            .map((row) => ({
                code: pickStr(row, 'cpn_cd'),
                name: pickStr(row, 'cpn_isng_nm'),
                statusCode: pickStr(row, 'st_clsf'),
                amount: pickNum(row, 'amt'),
                remainingDays: pickNum(row, 'rmd_dy_c'),
                startDate: pickStr(row, 'strt_dt'),
                endDate: pickStr(row, 'end_dt'),
                usedDate: pickStr(row, 'use_dt'),
                applicableProduct: pickStr(row, 'cpn_aplc_psbl_gds_nm'),
                info: row,
            }));
    }

    /**
     * 기간매매손익현황(`SSQM2392`). 주문일자와 종목 단위로 매매손익, 제비용, 순손익을 읽는다.
     *
     * 입력은 모두 설명이 없는 선택 입력이다. 주문일자는 `since`를 주면 한국 날짜로 바꿔 보내고, 끝은 `params.until`, 없으면 오늘이다.
     * `since`가 없으면 두 날짜를 비워 보낸다. 그때 KB가 어느 기간을 주는지는 명세에 없다. 조회구분(`inq_clsf`)은 예시값 `1`이 무엇을
     * 고르는지 몰라 비워 보낸다. 출력 이름과 같은 입력 세 개(`trd_pl` 등)와 종목번호(`is_no`)도 비워 보낸다.
     *
     * 응답 머리의 합계(매매손익, 제비용, 순손익)는 내보내지 않는다. 연속조회에서 페이지별 합계인지 기간 전체 합계인지 명세에 없다.
     * 연속조회는 끝까지 따라가고, 상한(`holdingsMaxPages`)에 걸리면 `truncated`로 알린다.
     */
    async fetchRealizedPnl(since: Int = undefined, params: Dict = {}): Promise<KbsecRealizedPnlFetch> {
        const until = this.safeInteger(params, 'until');
        const from = since !== undefined ? kbsecDateKst(new Date(since)) : '';
        const to = until !== undefined ? kbsecDateKst(new Date(until)) : (since !== undefined ? this.todayKst() : '');
        const result = await this.collectTrPages(KBSEC_TR.PNL_PERIOD, {
            is_no: '', ordr_dt_from: from, ordr_dt_to: to, trd_svrl_cst: '', trd_pl: '', trd_nt_pl: '', inq_clsf: '',
            ...this.omit(params, 'until'),
        }, (row) => ({
            ...this.kstStamp(pickStr(row, 'ordr_dt')),
            date: pickStr(row, 'ordr_dt'),
            symbol: `${kbsecNormalizeCode(pickStr(row, 'is_no'))}/KRW`,
            name: pickStr(row, 'is_nm'),
            quantity: pickNum(row, 'ccls_q'),
            buyQuantity: pickNum(row, 'b_q'),
            buyPrice: pickNum(row, 'byng_prc'),
            sellPrice: pickNum(row, 's_prc'),
            pnl: pickNum(row, 'trd_pl'),
            costs: pickNum(row, 'trd_svrl_cst'),
            netPnl: pickNum(row, 'trd_nt_pl'),
            creditType: pickStr(row, 'crdt_typ_nm'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from, to }, '[kbsec] 기간매매손익 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다');
        }
        return result;
    }

    /** 실현손익 조회(`SSQM2442`, `SSQM2443`)의 공통 입력. 시작일자를 검사하고 한국 날짜로 기간을 채운다. */
    private realizedPnlRequest(method: string, mdClsf: string, since: Int, params: Dict): Dict {
        if (since === undefined) throw new ArgumentsRequired(`${this.id} ${method}() 는 since 인자가 필요하다(조회 시작일자가 필수 입력이다)`);
        const until = this.safeInteger(params, 'until');
        return {
            inq_strt_dt: kbsecDateKst(new Date(since)),
            inq_end_dt: until !== undefined ? kbsecDateKst(new Date(until)) : this.todayKst(),
            md_clsf: mdClsf,
            ...this.omit(params, 'until'),
        };
    }

    /**
     * 일자별실현손익상세(`SSQM2442`, 국내). 필수 입력 매체구분(`md_clsf`, 1 오프라인, 2 온라인, 3 지점)은 공식 예제값 `1`을 보낸다.
     * 실계좌(2026-09-24)에서 1, 2, 3 의 첫 페이지 행과 머리 합계가 모두 같아 행을 거르는 값이 아니었다. `params.md_clsf`로 바꿀 수 있다.
     * 조회 시작일자와 종료일자가 필수라 `since`가 없으면 던진다. 날짜는 한국 날짜이고, 끝은 `params.until`, 없으면 오늘이다. 종목코드는 설명이
     * 없는 선택 입력이라 비워 보낸다. 응답 머리의 합계는 내보내지 않는다(연속조회에서 페이지별 합계인지 명세에 없다).
     */
    async fetchRealizedPnlDaily(since: Int = undefined, params: Dict = {}): Promise<KbsecDailyRealizedPnlFetch> {
        const request: Dict = { is_cd: '', ...this.realizedPnlRequest('fetchRealizedPnlDaily', '1', since, params) };
        const result = await this.collectTrPages(KBSEC_TR.PNL_DAILY, request, (row) => ({
            ...this.kstStamp(pickStr(row, 'trd_dt')),
            date: pickStr(row, 'trd_dt'),
            shortCode: pickStr(row, 'shrt_is_cd'),
            standardCode: pickStr(row, 'stnd_is_cd'),
            name: pickStr(row, 'is_nm'),
            creditTypeCode: pickStr(row, 'crdt_typ_cd'),
            tradeTypeCode: pickStr(row, 'trd_dl_ccd'),
            quantity: pickNum(row, 'ccls_q'),
            price: pickNum(row, 'ccls_uprc'),
            buyPrice: pickNum(row, 'b_uprc'),
            sellAmount: pickNum(row, 's_amt'),
            buyAmount: pickNum(row, 'b_amt'),
            fee: pickNum(row, 'fee'),
            tax: pickNum(row, 'svrl_tx'),
            realizedPnl: pickNum(row, 'rlztn_pl'),
            returnRate: pickNum(row, 'yld'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from: request.inq_strt_dt, to: request.inq_end_dt }, '[kbsec] 일자별실현손익 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다');
        }
        return result;
    }

    /**
     * 종목별기간실현손익(`SSQM2443`, 국내). 종목 단위 기간 합계라 개별 매매로 나눌 수 없다. 기간과 연속조회는 `fetchRealizedPnlDaily`와 같다.
     * 매체구분은 기본값 없이 호출하는 쪽이 고른다. 권한이 없는 계정에서는 I446 을 준다.
     */
    async fetchRealizedPnlBySymbol(media: KbsecMediaClass, since: Int = undefined, params: Dict = {}): Promise<KbsecSymbolRealizedPnlFetch> {
        const mdClsf = KBSEC_MEDIA_CLASS_CODE[media] as string | undefined;
        if (mdClsf === undefined) throw new NotSupported(`${this.id} fetchRealizedPnlBySymbol() 는 ${String(media)} 매체구분을 지원하지 않는다`);
        const request = this.realizedPnlRequest('fetchRealizedPnlBySymbol', mdClsf, since, params);
        const result = await this.collectTrPages(KBSEC_TR.PNL_BY_SYMBOL, request, (row) => ({
            code: pickStr(row, 'is_cd'),
            shortCode: pickStr(row, 'shrt_is_cd'),
            name: pickStr(row, 'is_nm'),
            realizedPnl: pickNum(row, 'rlztn_pl'),
            pnlRate: pickNum(row, 'pl_r'),
            sellQuantity: pickNum(row, 'thdy_s_q'),
            sellPrice: pickNum(row, 's_ccls_uprc'),
            sellAmount: pickNum(row, 's_amt'),
            sellFee: pickNum(row, 's_fee'),
            sellTax: pickNum(row, 's_svrl_tx'),
            buyAveragePrice: pickNum(row, 'b_avr_uprc'),
            buyAmount: pickNum(row, 'b_amt'),
            buyFee: pickNum(row, 'b_fee'),
            info: row,
        }));
        if (result.truncated) {
            logger.warn({ rows: result.rows.length, from: request.inq_strt_dt, to: request.inq_end_dt }, '[kbsec] 종목별기간실현손익 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다');
        }
        return result;
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
     * - `params.sor` 는 국내 라우팅(`K` KRX · `N` NXT · `S` SOR)이다. 생략하면 `options.nxtRouting` 을 따른다.
     * - **조건 인자는 받지 않는다.** `params` 에 `triggerPrice`·`stopPrice`·`stopLossPrice`·`takeProfitPrice`·`stopLoss`·`takeProfit` 가 있으면 요청 없이 `NotSupported` 다.
     *   버리고 일반 주문으로 내면 조건 주문을 의도한 호출이 곧바로 체결된다. 스탑지정가는 `createTriggerOrder` 로 낸다.
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
                throw new NotSupported(`${this.id} createOrder() does not support ${key} (conditional orders): 조건 인자는 받지 않는다. 스탑지정가는 createTriggerOrder() 로 낸다`);
            }
        }
        this.checkOrderArguments(market, type, side, amount, price, params);
        const isKr = !this.isUs(market);
        const base = market.id as string;
        const fractional = params.fractional === true;
        const sorOverride = safeString(params, 'sor');
        const extra = omit(params, ['fractional', 'sor', 'timeInForce', 'postOnly', 'reduceOnly', 'clientOrderId', 'cost']);

        // 세션 게이트. 거래시간 밖 주문은 KB 로 보내지 않고 `MarketClosed` 로 막는다.
        // KRX 판정은 시장이 아는 사실이라 이 클래스가 자기 시간표를 갖지 않고 공용 술어에 맡긴다.
        if (isKr) await this.refreshMarketCalendar();
        const closed = marketSessionBlockReason('kbsec', symbol, new Date(this.milliseconds()), masterDataOf(this.options));
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

        // 주 단위 주문은 1주 미만이면 수량이 0 으로 나가 거부된다(`주문수량을 확인하십시오`, 2329). 거부될 주문은 보내지 않는다.
        // 미국 소수점 주문은 위에서 `params.fractional` 로 따로 나갔다.
        if (submittedQty < 1) {
            throw new InvalidOrder(`${this.id} 1주 미만 주문 불가 (수량 ${amount}). 미국 소수점 주문은 params.fractional 을 준다`, { detail: KBSEC_ERROR_DETAIL.QUANTITY_INVALID });
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
            // `nxtRouting` 옵션이 켜져 있으면 SOR 에 맡긴다(KRX/NXT 중 유리한 쪽). 꺼져 있으면 KRX 고정이다.
            // 단 NXT 미상장 종목이 이미 확인됐으면 왕복을 건너뛴다.
            const wantSor = sorOverride === undefined && await this.isOptionEnabled('nxtRouting') && !this.nxtIneligible.has(base);
            try {
                response = await send(sorOverride ?? (wantSor ? KBSEC_SOR.SOR : KBSEC_SOR.KRX));
            } catch (err) {
                // NXT 미상장 종목(우선주 등)은 SOR 로 나가면 통째로 거부된다. 브로커가 사유와 조치를 그대로 알려 준다(`KRX로 주문해주세요`).
                // 업무 거부라 주문은 접수되지 않았고, 재전송이 중복 주문이 되지 않는다.
                if (!wantSor || !(err instanceof ExchangeError) || err.detail !== KBSEC_ERROR_DETAIL.NXT_INELIGIBLE) throw err;
                // 한 번 확인한 종목은 인스턴스 수명 동안 기억해 다음 주문부터 KRX 로 바로 보낸다.
                this.nxtIneligible.add(base);
                logger.warn({ symbol, side, submittedQty }, '[kbsec] NXT 미상장 — KRX 로 재주문 (이후 이 종목은 KRX 직행)');
                response = await send(KBSEC_SOR.KRX);
            }
        } else {
            response = await this.callTr(KBSEC_TR.ORDER_US, {
                trd_dl_ccd: side === 'buy' ? KBSEC_ORDER_SIDE_US.BUY : KBSEC_ORDER_SIDE_US.SELL,
                is_cd: base,
                frgn_ordr_typ_cd: isLimit ? KBSEC_ORDER_TYPE_US.LIMIT : KBSEC_ORDER_TYPE_US.MARKET,
                // 국내와 같은 이유로 내림이다. `kbsecNum` 은 반올림이라 요청 수량보다 많이 살 수 있다.
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
     * 스탑지정가 주문을 낸다. 조건가격(`triggerPrice`)에 닿으면 `price` 지정가 주문이 된다. 국내(`ordr_ccd='S0'`)·해외
     * (`frgn_ordr_typ_cd='C'`) 모두 지정가만 지원한다 — 시장가 트리거(해외 명세엔 `B` 코드가 있다)는 라이브 미검증이라 아직 안 쓴다.
     * `price`·`triggerPrice` 둘 다 필수다.
     */
    override async createTriggerOrder(
        symbol: string, _type: OrderType, side: OrderSide, amount: number, price: Num = undefined, triggerPrice: Num = undefined, params: Dict = {},
    ): Promise<Order> {
        if (triggerPrice === undefined) throw new ArgumentsRequired(`${this.id} createTriggerOrder() 는 triggerPrice 인자가 필요하다`);
        if (price === undefined) throw new ArgumentsRequired(`${this.id} createTriggerOrder() 는 price 인자가 필요하다(스탑지정가는 지정가만 지원한다)`);
        const market = this.market(symbol);
        const base = market.id as string;
        const isKr = !this.isUs(market);
        this.checkOrderArguments(market, 'limit', side, amount, price, params);

        if (isKr) await this.refreshMarketCalendar();
        const closed = marketSessionBlockReason('kbsec', symbol, new Date(this.milliseconds()), masterDataOf(this.options));
        if (closed !== null) {
            logger.info({ symbol, side, reason: closed }, '[kbsec] 거래시간 외 주문 차단');
            throw new MarketClosed(closed);
        }

        const submittedQty = Math.floor(amount);
        if (submittedQty < 1) {
            throw new InvalidOrder(`${this.id} 1주 미만 주문 불가 (수량 ${amount})`, { detail: KBSEC_ERROR_DETAIL.QUANTITY_INVALID });
        }

        let response: Dict;
        if (isKr) {
            const trCode = side === 'buy' ? KBSEC_TR.BUY_KR : KBSEC_TR.SELL_KR;
            response = await this.callTr(trCode, buildKrOrderBody({
                base, amount: submittedQty, price, isLimit: true,
                jbClsf: side === 'buy' ? KBSEC_ORDER_SIDE_KR.BUY : KBSEC_ORDER_SIDE_KR.SELL,
            }, { ordr_ccd: KBSEC_ORDER_TYPE_KR.STOP_LIMIT, stpd_prc: kbsecNum(triggerPrice) }));
        } else {
            response = await this.callTr(KBSEC_TR.ORDER_US, {
                trd_dl_ccd: side === 'buy' ? KBSEC_ORDER_SIDE_US.BUY : KBSEC_ORDER_SIDE_US.SELL,
                is_cd: base,
                frgn_ordr_typ_cd: KBSEC_ORDER_TYPE_US.STOP_LIMIT,
                frgn_ordr_q: kbsecNum(submittedQty),
                frgn_ordr_prc_p4: kbsecNum(price, 4),
                frgn_stp_prc_p4: kbsecNum(triggerPrice, 4),
                ...params,
            });
        }
        const orderId = pickStr(response, 'ordr_no', 'odno');
        logger.info({ symbol, side, amount, submittedQty, price, triggerPrice, orderId }, `[kbsec] ✅ ${isKr ? '국내' : '해외'} 스탑지정가 주문 접수`);
        return this.confirmedOrder(orderId, market, side as 'buy' | 'sell', 'limit', submittedQty, price, response);
    }

    /**
     * 접수된 주문의 실체결을 확정해 `Order` 로 만든다.
     *
     * 접수 응답에는 체결 정보가 없으므로 계좌 체결내역에서 주문번호로 찾아 확정한다.
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
        const product = (a: number, b: Num): number => Number(Precise.stringMul(numberToString(a), numberToString(b ?? 0)) ?? 0);
        const cost = clamped ? product(filled, matched.average) : (matched.amount ?? product(matched.filled, matched.average));
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
     * 미국 주식 시장가 매수를 금액으로 낸다. 소수점매도/매수주문(`SKAM2201`)을 금액 기준(`amt_q_clsf='0'`)으로 부른다.
     * 이 TR 은 `ORDER_US`(`SKAM2101`)와 주문유형코드 값이 다르다 — 시장가(`1`)가 없고 유사시장가(`E`)를 쓴다.
     * 체결 확정은 하지 않는다(다른 소수점 주문과 같다) — `order.info.fillConfirmed` 는 항상 `false` 다.
     */
    async createMarketBuyOrderWithCost(symbol: string, cost: number, params: Dict = {}): Promise<Order> {
        const market = this.market(symbol);
        if (!this.isUs(market)) throw new NotSupported(`${this.id} createMarketBuyOrderWithCost() 는 미국 종목만 지원한다: ${symbol}`);
        if (!(cost > 0)) throw new ArgumentsRequired(`${this.id} createMarketBuyOrderWithCost() requires a cost argument above 0`);

        const closed = marketSessionBlockReason('kbsec', symbol, new Date(this.milliseconds()), masterDataOf(this.options));
        if (closed !== null) {
            logger.info({ symbol, cost, reason: closed }, '[kbsec] 거래시간 외 주문 차단');
            throw new MarketClosed(closed);
        }

        // 실제로 나가는 금액은 내림값이다(소수점 아래는 버린다). ordr_amt 가 decimal:0 필드라 반올림하면 초과 주문이 나간다.
        const submittedCost = Math.floor(cost);
        const response = await this.callTr(KBSEC_TR.FRAC_ORDER_US, {
            frgn_krx_ccd: 'US',
            trd_dl_ccd: KBSEC_ORDER_SIDE_US.BUY,
            is_cd: market.id,
            amt_q_clsf: '0', // 0-금액, 1-수량
            tv_s_est_f: '',
            frgn_ordr_typ_cd: 'E', // 2-지정가, E-유사시장가
            crncy_ccd: '1', // 0-원화, 1-외화(USD)
            ordr_amt: kbsecNum(submittedCost),
            dcml_ordr_q_p6: '',
            frgn_ordr_prc_p4: '',
            spclz_ordr_ccd: '33', // 소수점매매주문(소수점매매-금액기준)
            cpn_cd: '',
            cutn_mtr_cnfr_f: '',
            ...params,
        });
        const orderId = pickStr(response, 'ordr_no', 'odno');
        logger.info({ symbol, cost, submittedCost, orderId }, '[kbsec] ✅ 금액 기준 시장가 매수');
        return this.safeOrder({
            id: orderId === NO_ORDER_ID ? undefined : orderId,
            timestamp: this.milliseconds(),
            symbol: market.symbol,
            type: 'market',
            side: 'buy',
            cost: submittedCost,
            status: 'open',
            trades: [],
            info: { ...response, fillConfirmed: false, fractional: true },
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
        if (!isPartial && amount !== undefined) {
            logger.warn({ orderId: id, symbol, amount }, '[kbsec] params.partial 이 없어 전부정정한다 — 수량은 바꾸지 않고 잔량 전체의 가격만 바꾼다');
        }
        const response = await this.callTr(KBSEC_TR.AMEND_KR, buildKrOrderBody(
            { base, amount: isPartial ? amount : 0, price, sor, jbClsf: KBSEC_ORDER_SIDE_KR.AMEND },
            { crct_clsf: isPartial ? '1' : '2', orgn_ordr_no: id },
        ));
        const newId = pickStr(response, 'ordr_no', 'odno');
        logger.info({ orderId: id, newOrderId: newId, symbol, price, sor, isPartial }, '[kbsec] ✅ 정정주문 — 주문번호가 바뀌었다');
        // 전부정정은 수량을 보내지 않으므로 반환값에도 싣지 않는다(정정 뒤 수량은 잔량이고 이 응답으로는 알 수 없다).
        return this.editedOrder(response, market, price, isPartial ? amount : undefined);
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
     * 못 찾으면(이미 체결·조회 실패) 발주 때와 같은 정책으로 되짚는다. 같은 인스턴스 안에서는 `nxtRouting` 옵션과 NXT 캐시가 그대로라 같은 값이 나온다.
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
    override async cancelOrder(id: string, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} cancelOrder() requires a symbol argument`);
        const market = this.market(symbol);
        let response: Dict;
        if (!this.isUs(market)) {
            // 원주문의 라우팅(SOR)을 싣는다. 정정과 같이 SOR 주문을 KRX 로 취소하면 거부될 수 있다.
            const sor = safeString(params, 'sor_ordr_ccd') ?? await this.resolveOrderSor(id, symbol);
            response = await this.callTr(KBSEC_TR.CANCEL_KR, buildKrOrderBody(
                { base: market.id as string, jbClsf: KBSEC_ORDER_SIDE_KR.CANCEL, sor },
                { crct_clsf: '2', orgn_ordr_no: id, ...params }, // 2=전부취소
            ));
        } else {
            response = await this.callTr(KBSEC_TR.AMEND_CANCEL_US, {
                is_cd: market.id,
                orgn_ordr_no: id,
                crct_cncl_clsf: '2',
                ...params,
            });
        }
        logger.info({ orderId: id, symbol }, '[kbsec] ✅ 주문 취소');
        return this.safeOrder({ id, symbol: market.symbol, status: 'canceled', trades: [], info: response }, market);
    }

    /**
     * 미체결 주문을 모두 취소한다(심볼을 주면 그 종목만). 취소를 시도한 주문마다 미체결 조회로 받은 주문을 항목으로 돌려준다.
     * 취소된 항목은 `status: 'canceled'` 이고 취소 응답 원문이 `info.cancelResponse` 에 있다. 실패한 항목은 `status: 'open'` 이고
     * `info.cancelError`(메시지)와 `info.cancelErrorDetail`(오류의 `detail`)이 있다. 일부가 실패해도 던지지 않는다.
     */
    override async cancelAllOrders(symbol: Str = undefined, params: Dict = {}): Promise<Order[]> {
        const open = await this.fetchOpenOrders(symbol, undefined, undefined, params);
        const results: Order[] = [];
        for (const order of open) {
            try {
                // 목록 행의 라우팅을 넘겨 주문마다 미체결 목록을 다시 조회하지 않는다.
                const sor = pickStr((order.info ?? {}) as Dict, 'sor_ordr_ccd');
                const canceled = await this.cancelOrder(order.id as string, order.symbol, sor !== '' ? { sor_ordr_ccd: sor } : {});
                results.push({ ...order, status: 'canceled', info: { ...order.info, cancelResponse: canceled.info } });
            } catch (err) {
                logger.warn({ err, orderId: order.id }, '[kbsec] 주문 취소 실패');
                results.push({
                    ...order,
                    info: {
                        ...order.info,
                        cancelError: err instanceof Error ? err.message : String(err),
                        cancelErrorDetail: err instanceof BaseError ? err.detail : undefined,
                    },
                });
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
     * 2854 가 아닌 오류는 그대로 던진다. 날짜와 무관한 실패를 날짜 탓으로 삼키지 않는다. 해외 조회(`US`)는 미국 현지 날짜로 되감는다.
     */
    private async callOnBusinessDate<T>(call: (ordrDt: string) => Promise<T>, country: 'KR' | 'US' = 'KR'): Promise<T> {
        const today = country === 'US' ? kbsecDateUsEastern(new Date(this.milliseconds())) : this.todayKst();
        if (this.businessDateBackoff[country].day !== today) this.businessDateBackoff[country] = { day: today, steps: 0 };
        const startSteps = this.businessDateBackoff[country].steps;
        let lastErr: unknown;
        for (let steps = startSteps; steps <= (this.options.businessDateMaxBackoff as number); steps++) {
            const now = new Date(this.milliseconds());
            const ordrDt = country === 'US' ? kbsecBusinessDateUsEastern(steps, now) : kbsecBusinessDateKst(steps, now);
            try {
                const result = await call(ordrDt);
                // 새로 되감았을 때만 WARN 을 남긴다. 캐시가 적중한 경우는 조용히 지나간다.
                if (steps !== startSteps) {
                    logger.warn({ ordrDt, steps, country }, '[kbsec] 조회일자를 영업일보다 더 되감아 성공 — 미등록 휴장일로 보임');
                    this.businessDateBackoff[country] = { day: today, steps };
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
     * 국내 주문·체결 목록(`SSQM2341`)의 행을 모든 페이지 읽는다. 날짜를 주지 않으면 가장 최근 영업일이다.
     * 목록이 페이지 상한(`holdingsMaxPages`)에서 잘리면 일부만 돌려주지 않고 던진다. 빠진 주문은 취소 누락이나 재주문으로 이어진다.
     */
    private async fetchDomesticOrderRows(cclsClsf: string, market: MarketInterface | undefined, date: Str, params: Dict = {}): Promise<Dict[]> {
        const request = (ordr_dt: string): Promise<{ rows: Dict[]; truncated: boolean }> => this.collectTrPages(KBSEC_TR.TRADES_KR, {
            inq_clsf: KBSEC_INQ_STOCK, // 주식
            ccls_clsf: cclsClsf, // 구분 필드를 비우면 거부된다(`체결구분을 확인하십시오`, 8654)
            ordr_dt,
            is_cd: market?.id ?? '',
            cn_clsf: KBSEC_CONT_FIRST,
            ...params,
        }, (row: Dict) => row);
        const result = date !== undefined ? await request(date) : await this.callOnBusinessDate(request);
        if (result.truncated) {
            throw new BadResponse(`${this.id} 주문·체결 목록(${KBSEC_TR.TRADES_KR})이 페이지 상한(holdingsMaxPages)에서 잘렸다. 일부만 돌려주지 않는다`);
        }
        return result.rows;
    }

    /**
     * 주문·체결 목록 행을 주문 단위로 묶는다. 이 TR 은 한 행이 한 체결이고, 분할체결의 둘째 체결부터는 주문번호를 지운 연속 행으로 온다.
     * 헤더 행이 주문 하나를 열고 뒤따르는 연속 행의 체결을 그 주문에 더한다. 헤더 없이 온 연속 행은 귀속할 곳이 없어 버린다.
     */
    private ordersFromRows(rows: Dict[], market: MarketInterface | undefined, limit: Int): Order[] {
        const groups: { header: Dict; filled: number; cost: number }[] = [];
        for (const row of rows) {
            const fill = parseKbsecDomesticFillRow(row);
            const lastGroup = groups[groups.length - 1];
            if (!fill.continuation) {
                groups.push({ header: row, filled: fill.filledQty, cost: fill.cost });
            } else if (lastGroup !== undefined) {
                lastGroup.filled += fill.filledQty;
                lastGroup.cost += fill.cost;
            }
        }
        const orders = groups.map(({ header, filled, cost }) => this.parseOrderGroup(header, filled, cost, market));
        const matched = market === undefined ? orders : orders.filter((order) => order.symbol === market.symbol);
        return limit === undefined ? matched : matched.slice(0, limit);
    }

    /**
     * 국내 미체결 주문. 계좌별주문체결조회(`SSQM2341`)에서 체결구분 `미체결`로 뽑는다. 이 TR 은 미체결이 0건이면 플래그 `B` 와 1861 로 주는데,
     * 그것은 빈 결과로 흡수한다. 해외 미체결은 지원하지 않는다. 모든 페이지를 읽고 분할체결 행을 주문 단위로 묶는다.
     *
     * **`since` 는 적용하지 않는다.** 미체결 행에는 주문 시각의 날짜가 없어 `Order.timestamp` 를 채울 수 없고, 기본 필터는 timestamp 가 없는 항목을
     * 전부 버려서 `since` 를 주면 미체결이 있는데도 빈 목록이 나왔다. 미체결은 빠지면 위험한 목록이라 시각을 모르는 항목을 거르지 않고 전부 돌려준다.
     * `symbol` 과 `limit` 은 그대로 적용한다.
     */
    override async fetchOpenOrders(symbol: Str = undefined, _since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        const market = symbol !== undefined ? this.market(symbol) : undefined;
        if (market !== undefined && this.isUs(market)) throw new NotSupported(`${this.id} fetchOpenOrders() 는 국내 종목만 지원한다`);
        const rows = await this.fetchDomesticOrderRows(KBSEC_CCLS_PENDING, market, undefined, params);
        return this.ordersFromRows(rows, market, limit);
    }

    /**
     * 국내 전체 주문(체결+미체결+취소). 계좌별주문체결조회(`SSQM2341`)에서 체결구분 전체(`KBSEC_CCLS_ALL`)로 뽑아 주문 단위로 묶는다. 해외는 지원하지 않는다.
     *
     * `since` 는 적용하지 않는다. 이 TR 행에는 `timestamp`를 채우지 않아서(체결·미체결 모두), `since`를 그대로 넘기면
     * 기본 필터가 전부 버려 빈 목록이 나온다. `fetchOpenOrders`와 같은 이유다. `params.date`(`YYYYMMDD`)로 조회 영업일을 지정할 수 있다.
     */
    override async fetchOrders(symbol: Str = undefined, _since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        const market = symbol !== undefined ? this.market(symbol) : undefined;
        if (market !== undefined && this.isUs(market)) throw new NotSupported(`${this.id} fetchOrders() 는 국내 종목만 지원한다`);
        const rows = await this.fetchDomesticOrderRows(KBSEC_CCLS_ALL, market, safeString(params, 'date'), this.omit(params, 'date'));
        return this.ordersFromRows(rows, market, limit);
    }

    /**
     * 국내 종료 주문(전량 체결, 취소). 전체 주문(`fetchOrders`)에서 `open` 이 아닌 주문만 돌려준다. 체결 내역 자체(단가·수량 등 행 단위 상세)는
     * `fetchMyTrades`로 본다. 해외는 지원하지 않는다. `since`를 적용하지 않는 이유는 `fetchOrders`와 같다.
     */
    override async fetchClosedOrders(symbol: Str = undefined, _since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        const closed = (await this.fetchOrders(symbol, undefined, undefined, params)).filter((order) => order.status !== 'open');
        return limit === undefined ? closed : closed.slice(0, limit);
    }

    override parseOrder(order: Dict, market: MarketInterface | undefined = undefined): Order {
        const fill = parseKbsecDomesticFillRow(order);
        return this.parseOrderGroup(order, fill.filledQty, fill.cost, market);
    }

    /**
     * 헤더 행과 그 주문의 체결 합계로 주문을 만든다. 필드 이름은 `parseKbsecDomesticFillRow` 가 정본이다.
     * 상태는 미체결수량(`nccls_q`)으로 정한다. 남았으면 `open`, 전량 체결이면 `closed`, 남지 않았는데 덜 체결됐으면 `canceled`(전부나 일부 취소)다.
     * 미체결수량 필드가 없으면 취소를 가릴 수 없어 체결 수량만 본다.
     */
    private parseOrderGroup(header: Dict, filled: number, cost: number, market: MarketInterface | undefined): Order {
        const fill = parseKbsecDomesticFillRow(header);
        const quantity = fill.orderQty;
        const knowsUnfilled = 'nccls_q' in header;
        const remaining = knowsUnfilled ? fill.unfilledQty : Math.max(0, quantity - filled);
        const fullyFilled = quantity > 0 && filled >= quantity;
        const status = fullyFilled ? 'closed' : remaining > 0 || !knowsUnfilled ? 'open' : 'canceled';
        // `A005930` 을 그대로 두면 심볼 필터가 맞지 않고 취소가 해외 TR 로 잘못 넘어간다. 종목코드를 정규화해 심볼로 옮긴다.
        const symbol = fill.symbol !== '' ? this.market(fill.symbol).symbol : market?.symbol;
        return this.safeOrder({
            info: header,
            id: fill.orderId === '' ? undefined : fill.orderId,
            symbol,
            type: pickStr(header, 'ordr_ccd') === KBSEC_ORDER_TYPE_KR.MARKET ? 'market' : 'limit',
            side: fill.side ?? undefined,
            status,
            price: pickNum(header, 'ordr_uprc'),
            amount: quantity,
            filled,
            remaining: fullyFilled ? 0 : remaining,
            cost,
            average: filled > 0 && cost > 0 ? cost / filled : undefined,
            trades: [],
        }, market);
    }

    /**
     * 주문 한 건을 조회한다. 국내는 미체결 목록에 있으면 `open`(체결분이 있으면 반영), 체결내역에만 있으면 `closed` 다.
     * 미국은 체결내역과 해외 체결현황(`SPQM2204`, 최근 사흘)을 함께 보고 잔량으로 상태를 정한다. 어디에도 없을 때만 `OrderNotFound` 다.
     *
     * `params.date`(`YYYYMMDD`)를 주면 그날의 체결내역을 조회하고 실패를 던진다(국내는 한국 날짜, 미국은 미국 현지 날짜). 생략하면 가장 최근 영업일이다.
     */
    override async fetchOrder(id: string, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} fetchOrder() requires a symbol argument`);
        const market = this.market(symbol);
        const trades = (await this.fetchMyTrades(symbol, undefined, undefined, params)).filter(trade => trade.order === id);
        // 체결 행의 수량과 금액은 문자열로 더한다. `Number` 로 더하면 부동소수 잡음이 남는다.
        const sum = (pick: (trade: Trade) => Num): number => Number(trades.reduce((acc, trade) => Precise.stringAdd(acc, numberToString(pick(trade) ?? 0)) ?? acc, '0'));
        const filled = sum((trade) => trade.amount);
        const cost = sum((trade) => trade.cost);
        const tradeInfo = trades.map(trade => trade.info);
        if (this.isUs(market)) return this.overseasOrderOf(id, market, trades, filled, cost);
        const open = (await this.fetchOpenOrders(symbol)).find(order => order.id === id);
        if (open === undefined && trades.length === 0) {
            throw new OrderNotFound(`${this.id} fetchOrder() ${symbol} 주문 ${id} 을 체결내역과 미체결 목록에서 찾지 못했다`);
        }
        if (open === undefined) {
            return this.safeOrder({
                id, symbol: market.symbol, status: 'closed', side: trades[0]?.side, filled, cost,
                average: filled > 0 ? cost / filled : undefined, trades: [], info: { trades: tradeInfo },
            }, market);
        }
        // 미체결 행의 체결수량은 그 날 목록에 보인 것이다. 이 주문의 체결내역 합계가 정본이다.
        const amount = open.amount as number;
        return this.safeOrder({
            ...open, filled, cost, remaining: Math.max(0, amount - filled), average: filled > 0 ? cost / filled : undefined,
            status: filled >= amount && amount > 0 ? 'closed' : 'open', trades: [],
        }, market);
    }

    /** 미국 주문 한 건. 체결내역에 없어도 해외 체결현황에 있으면 미체결이나 취소로 돌려준다. 둘 다 없을 때만 `OrderNotFound` 다. */
    private async overseasOrderOf(id: string, market: MarketInterface, trades: Trade[], filled: number, cost: number): Promise<Order> {
        const lookbackMs = 3 * 24 * 60 * 60 * 1000;
        const status = (await this.fetchOverseasOrderStatus(this.milliseconds() - lookbackMs)).rows.find(row => row.id === id);
        if (status === undefined && trades.length === 0) {
            throw new OrderNotFound(`${this.id} fetchOrder() ${market.symbol} 주문 ${id} 을 체결내역과 해외 체결현황에서 찾지 못했다`);
        }
        const tradeInfo = trades.map(trade => trade.info);
        if (status === undefined) {
            return this.safeOrder({
                id, symbol: market.symbol, status: 'closed', side: trades[0]?.side, filled, cost,
                average: filled > 0 ? cost / filled : undefined, trades: [], info: { trades: tradeInfo },
            }, market);
        }
        // 체결내역이 비었으면(조회 날짜가 다른 경우) 체결현황의 체결수량과 체결가를 쓴다.
        const totalFilled = trades.length > 0 ? filled : status.filledQuantity;
        const totalCost = trades.length > 0 ? cost : status.filledQuantity * status.filledPrice;
        const amount = status.quantity;
        const remaining = status.remainingQuantity;
        const orderStatus = remaining > 0 ? 'open'
            : amount > 0 && totalFilled >= amount ? 'closed'
            : status.rejectReason !== '' ? 'rejected' : 'canceled';
        return this.safeOrder({
            id, symbol: market.symbol, status: orderStatus, side: trades[0]?.side, amount, filled: totalFilled, remaining,
            price: status.price > 0 ? status.price : undefined, cost: totalCost,
            average: totalFilled > 0 && totalCost > 0 ? totalCost / totalFilled : undefined,
            trades: [], info: { status: status.info, trades: tradeInfo },
        }, market);
    }

    /**
     * 체결내역. 계좌 체결내역을 종목 단위로 준다(`symbol` 이 필요하다). 국내는 `SSQM2341`, 해외는 `SPQM2103` 이고 모든 페이지를 읽는다.
     *
     * 조회일자는 세 가지다. `params.date`(`YYYYMMDD`)를 주면 그날만 조회한다. `since` 를 주면 그 날짜부터 오늘까지 영업일마다 조회한다(최대 31일).
     * 둘 다 없으면 가장 최근 영업일이다. 날짜는 국내가 한국 날짜, 미국이 미국 현지 날짜다. 체결 행에는 시각이 없어 `since` 는 날짜 단위로만 적용된다.
     *
     * 분할체결은 식별자를 지운 연속 행으로 온다. 이 함수가 그 행을 앞 헤더에 귀속시키므로 주문번호(`trade.order`)별로 `amount` 를 더하면 체결수량이다.
     * 단가가 0 인 체결은 체결가를 모르므로 버린다.
     */
    override async fetchMyTrades(symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        if (symbol === undefined) throw new ArgumentsRequired(`${this.id} fetchMyTrades() requires a symbol argument`);
        const market = this.market(symbol);
        const country = this.isUs(market) ? 'US' : 'KR';
        const explicitDate = safeString(params, 'date');
        const dates = explicitDate !== undefined ? [explicitDate] : since !== undefined ? this.tradeDatesSince(since, country) : undefined;
        if (country === 'US') return this.fetchOverseasTrades(market, dates, limit);
        if (dates === undefined) return this.fillRowsToTrades(await this.fetchDomesticOrderRows(KBSEC_CCLS_FILLED, market, undefined), market, limit);
        const rows: Dict[] = [];
        for (const date of dates) rows.push(...await this.onDateSkippingHoliday(date, (d) => this.fetchDomesticOrderRows(KBSEC_CCLS_FILLED, market, d), dates.length > 1));
        return this.fillRowsToTrades(rows, market, limit);
    }

    /** `since` 의 날짜부터 오늘까지의 평일(`YYYYMMDD`). 국내는 한국 날짜, 해외는 미국 현지 날짜다. 31일을 넘으면 던진다. */
    private tradeDatesSince(since: number, country: 'KR' | 'US'): string[] {
        const dateOf = (at: number): string => country === 'US' ? kbsecDateUsEastern(new Date(at)) : kbsecDateKst(new Date(at));
        const toUtc = (ymd: string): number => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
        const day = 24 * 60 * 60 * 1000;
        const start = toUtc(dateOf(since));
        const end = toUtc(dateOf(this.milliseconds()));
        if (end - start > 31 * day) throw new BadRequest(`${this.id} fetchMyTrades() 는 since 부터 31일까지만 조회한다. 기간을 나눠 부른다`);
        const dates: string[] = [];
        for (let at = start; at <= end; at += day) {
            const dow = new Date(at).getUTCDay();
            if (dow !== 0 && dow !== 6) dates.push(new Date(at).toISOString().slice(0, 10).replace(/-/g, ''));
        }
        return dates;
    }

    /** 날짜 하나를 조회한다. 여러 날을 도는 중이면 휴장일 거부(2854)는 그날만 건너뛴다. 하루만 조회하면 그대로 던진다. */
    private async onDateSkippingHoliday<T>(date: string, call: (date: string) => Promise<T[]>, skipHoliday: boolean): Promise<T[]> {
        try {
            return await call(date);
        } catch (err) {
            if (skipHoliday && err instanceof ExchangeError && err.detail === KBSEC_ERROR_DETAIL.FUTURE_QUERY_DATE) return [];
            throw err;
        }
    }

    /**
     * 해외 체결내역 — `SPQM2103`. 응답 필드는 공식 스펙 이름(`ccls_q_p6`·`frgn_ccls_prc_p6`·`dl_clsf_nm`)이 1순위이고 국내 이름은 폴백이다.
     * 체결구분은 비우면 거부되므로 명시한다. 조회일자는 미국 현지 날짜이고, 날짜를 주지 않으면 미국 날짜 기준 가장 최근 영업일이다.
     * 모든 페이지를 읽고, 페이지 상한에서 잘리면 던진다.
     *
     * 영구 실패(`isPermanentFailure`)면 이 인스턴스에서는 다시 부르지 않는다(반복 실패는 계정 제한 사유). 해외 체결 확정이 실패해도 주문
     * 자체는 접수된 상태다.
     */
    private async fetchOverseasTrades(market: MarketInterface, dates: string[] | undefined, limit: Int): Promise<Trade[]> {
        if (this.overseasFillsUnavailable) {
            throw new ExchangeError(`${this.id} 해외 체결 조회가 이 인스턴스에서 영구 실패해 다시 부르지 않는다`);
        }
        try {
            const request = async (ordr_dt: string): Promise<Dict[]> => {
                const result = await this.collectTrPages(KBSEC_TR.ORDERS_US, {
                    ccls_clsf: KBSEC_CCLS_FILLED, // 체결만. 비우면 거부된다
                    ordr_dt,
                    is_cd: market.id,
                }, (row: Dict) => row);
                if (result.truncated) {
                    throw new BadResponse(`${this.id} 해외 체결 목록(${KBSEC_TR.ORDERS_US})이 페이지 상한(holdingsMaxPages)에서 잘렸다. 일부만 돌려주지 않는다`);
                }
                return result.rows;
            };
            const rows: Dict[] = [];
            if (dates === undefined) rows.push(...await this.callOnBusinessDate(request, 'US'));
            else for (const date of dates) rows.push(...await this.onDateSkippingHoliday(date, request, dates.length > 1));
            const trades = this.fillRowsToTrades(rows, market, limit);
            if (rows.length > 0 && trades.length === 0) {
                logger.warn({ rows: rows.length, rowKeys: Object.keys(rows[0] ?? {}).slice(0, 40) }, '[kbsec] 해외 체결 행은 있으나 전부 걸러짐 — 응답 필드명 불일치');
            }
            return trades;
        } catch (err) {
            const permanent = this.isPermanentFailure(err);
            if (permanent) this.overseasFillsUnavailable = true;
            logger.warn({ err, symbol: market.symbol, trCode: KBSEC_TR.ORDERS_US, latched: permanent },
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
    async fetchMarketCalendar(params: Dict = {}): Promise<CalendarDay[]> {
        const body = await this.callTr(KBSEC_TR.MARKET_STATUS, { ...params });
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
     * 한 매매구분의 하루치 정산 행. 연속조회는 `collectTrPages` 를 따른다. 같은 키가 또 오면 그 페이지를 버리고 잘렸다고 표시한다.
     * 담고 나서 멈추면 같은 행이 두 번 들어가고 잘린 것을 완주로 보고한다.
     */
    private async fetchSettlementSide(tradeDateKst: string, trdClsf: string): Promise<KbsecSettlementFetch> {
        let rows: KbsecSettlementRow[];
        let truncated: boolean;
        try {
            ({ rows, truncated } = await this.collectTrPages(KBSEC_TR.SETTLEMENT_KR, {
                trd_dt: tradeDateKst,
                clsf: KBSEC_SETTLE_CLSF.BY_PRICE,
                trd_clsf: trdClsf,
                // KB 공식 예제가 결제일자에 매매일자와 같은 값을 넣는다. 실측상 필터가 아니다. 빈 값으로 보내도 같은 행 수가 온다.
                stmt_dt: tradeDateKst,
            }, parseKbsecDomesticSettlementRow, this.options.settlementMaxPages as number, pickSettlementGrid));
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
        let raw: KbsecOverseasSettlementRow[];
        let truncated: boolean;
        try {
            // 같은 키가 또 오면 앞 페이지와 같은 내용이다. `collectTrPages` 는 그 페이지를 버린다. 담으면 비용이 몇 배로 부풀고 완주한 것처럼 보인다.
            ({ rows: raw, truncated } = await this.collectTrPages(KBSEC_TR.SETTLEMENT_US, {
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
            }, parseKbsecOverseasSettlementRow, this.options.settlementMaxPages as number, pickOverseasSettlementGrid));
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
