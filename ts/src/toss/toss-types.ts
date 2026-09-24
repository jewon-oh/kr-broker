/**
 * @fileoverview 토스증권 OpenAPI 응답 타입과 순수 함수.
 *
 * 타입은 공개 OpenAPI 스펙(v1.2.17)을 기준으로 적었다. 숫자는 전부 문자열로 온다. 통합 구조(`Order`·`Ticker` 등)로 바꾸는 일은
 * `toss.ts` 의 `parse*` 메서드가 맡고, 이 파일은 응답 원본의 모양과 시장 판정·수수료 계산 같은 순수 함수만 둔다.
 */

import { krxSellTaxRate } from '../krx-sell-tax';

// ============ 상수 ============

/** 국내주식 위탁수수료율 기본값(근사). 실제 요율은 `GET /commissions` 로 받고, 체결 수수료는 주문 응답의 `execution.commission` 으로 확정된다. */
export const TOSS_BROKERAGE_FEE = 0.00015;

/** 해외(미국)주식 위탁수수료율 기본값(근사). 국내와 달리 증권거래세가 없고 SEC·TAF 같은 소액 수수료는 이 값에 포함해 보수적으로 잡는다. */
export const TOSS_US_BROKERAGE_FEE = 0.001;

/** 고액주문 확인 기준(원화). 주문 금액이 이 값 이상이면 `confirmHighValueOrder: true` 를 보내야 한다. */
export const TOSS_HIGH_VALUE_THRESHOLD_KRW = 100_000_000;

/** 환율을 알 수 없을 때 쓰는 고액주문 확인 기준(달러). 1억원을 보수적인 환율(1달러당 약 1,430원)로 나눈 값이다. */
export const TOSS_HIGH_VALUE_THRESHOLD_USD = 70_000;

export { krxSellTaxRate };

// ============ 시장 판정 ============

/** 종목의 시장 구분. */
export type TossMarketCountry = 'KR' | 'US';

/**
 * 국내 종목코드의 모양: 6자리이고 첫 글자가 숫자, 나머지는 숫자나 영문 대문자다(`005930`, 신형 영숫자 코드 `0101N0`).
 * 미국 티커는 숫자로 시작하지 않으므로 이 모양으로 국내와 갈린다.
 */
const KRX_CODE_SHAPE = /^\d[0-9A-Za-z]{5}$/;

/** 종목 심볼(`005930`, `005930/KRW`, `AAPL`)의 시장. 종목코드의 모양만 본다. */
export function tossMarketCountry(symbol: string): TossMarketCountry {
    return KRX_CODE_SHAPE.test(symbol.split('/')[0]) ? 'KR' : 'US';
}

// ============ 수수료 ============

/**
 * 실효 매매비용률: 위탁수수료에 (국내 매도라면) 증권거래세를 더한 값이다. `비용 = 명목금액 × rate` 가 성립한다.
 *
 * 세금은 브로커가 아니라 법이 정하므로 거래 시각(`at`)의 세율을 쓴다. 과거 거래를 다시 계산할 때는 그 거래의 체결 시각을 넘긴다.
 * `brokerage` 를 주면 기본값 대신 그 요율을 쓴다(`GET /commissions` 로 받은 값).
 * `taxExempt` 는 증권거래세가 붙지 않는 국내 상장 ETF·ETN 매도에 쓴다.
 */
export function getTossEffectiveFeeRate(
    market: TossMarketCountry,
    side: 'buy' | 'sell',
    at: Date = new Date(),
    brokerage: number = market === 'US' ? TOSS_US_BROKERAGE_FEE : TOSS_BROKERAGE_FEE,
    taxExempt = false,
): number {
    const tax = market === 'KR' && side === 'sell' && !taxExempt ? krxSellTaxRate(at) : 0;
    return brokerage + tax;
}

// ============ 계좌·자산 ============

export type TossCurrency = 'KRW' | 'USD';

/** 공통 응답 봉투. 대부분의 응답은 `result` 에 담겨 온다. */
export interface TossEnvelope<T> {
    result: T;
    error?: string;
    error_description?: string;
}

/** `GET /accounts` 항목. `accountSeq` 는 정수다. */
export interface TossAccount {
    accountNo: string;
    accountSeq: number;
    accountType?: string;
}

/** `GET /buying-power`: 통화별 현금 매수 가능 금액. */
export interface TossBuyingPower {
    currency: TossCurrency;
    cashBuyingPower: string;
}

/** `GET /exchange-rate`: 참고 환율. `rate` 는 매수 환율이며 실제 체결 환율과 다를 수 있다. */
export interface TossExchangeRate {
    baseCurrency: TossCurrency;
    quoteCurrency: TossCurrency;
    rate: string;
    midRate?: string;
    validFrom?: string;
    validUntil?: string;
}

/** `GET /holdings` 항목의 평가금액. */
export interface TossHoldingMarketValue {
    purchaseAmount: string;
    amount: string;
    amountAfterCost: string;
}

/** `GET /holdings` 의 보유 종목 하나. */
export interface TossHoldingItem {
    symbol: string;
    name?: string;
    marketCountry: TossMarketCountry;
    currency: TossCurrency;
    quantity: string;
    lastPrice?: string;
    averagePurchasePrice?: string;
    marketValue?: TossHoldingMarketValue;
    cost?: { commission?: string; tax?: string | null };
}

/** `GET /holdings` 응답. 보유 종목 목록만 쓴다. */
export interface TossHoldingsOverview {
    items?: TossHoldingItem[];
}

// ============ 장 운영 캘린더 ============

/** 미국 시장의 세션 이름. 정규장 외에 주간거래·프리마켓·애프터마켓을 모두 운영한다. */
export type TossUsSession = 'dayMarket' | 'preMarket' | 'regularMarket' | 'afterMarket';

/** 세션 운영 구간. ISO 8601 이며 한국 시각 오프셋이 붙어 온다(`2026-03-26T17:00:00+09:00`). */
export interface TossSessionWindow {
    startTime: string;
    endTime: string;
}

/** 미국 캘린더의 영업일 하나. 휴장일이면 네 세션이 모두 `null` 이다. 정규장은 다음날 새벽에 끝나므로 종료 시각이 `date` 의 다음날일 수 있다. */
export interface TossUsBusinessDay {
    date: string;
    dayMarket: TossSessionWindow | null;
    preMarket: TossSessionWindow | null;
    regularMarket: TossSessionWindow | null;
    afterMarket: TossSessionWindow | null;
}

/** `GET /market-calendar/US`: 전일·당일·익일 영업일. */
export interface TossUsMarketCalendar {
    previousBusinessDay?: TossUsBusinessDay | null;
    today?: TossUsBusinessDay | null;
    nextBusinessDay?: TossUsBusinessDay | null;
}

/** 국내 시장의 세션 이름(KRX 와 NXT 통합). */
export type TossKrSession = 'preMarket' | 'regularMarket' | 'afterMarket';

/** 국내 세션 구간. 세션마다 단일가(동시호가) 시각이 따라온다. */
export interface TossKrSessionWindow extends TossSessionWindow {
    singlePriceAuctionStartTime?: string;
    singlePriceAuctionEndTime?: string;
}

/**
 * 국내 캘린더의 영업일 하나. 전 시장이 쉬면 `integrated` 자체가 `null` 이고, 일부만 쉬면(예: NXT 프리마켓) 해당 세션만 `null` 이다.
 */
export interface TossKrBusinessDay {
    date: string;
    integrated: {
        preMarket: TossKrSessionWindow | null;
        regularMarket: TossKrSessionWindow | null;
        afterMarket: TossKrSessionWindow | null;
    } | null;
}

/** `GET /market-calendar/KR`: 전일·당일·익일 영업일. */
export interface TossKrMarketCalendar {
    previousBusinessDay?: TossKrBusinessDay | null;
    today?: TossKrBusinessDay | null;
    nextBusinessDay?: TossKrBusinessDay | null;
}

// ============ 종목 ============

/** `GET /stocks/all` 의 마켓 구분. */
export type TossStockMarket = 'KOSPI' | 'KOSDAQ' | 'NYSE' | 'NASDAQ' | 'AMEX' | 'KR_ETC' | 'US_ETC';

/** `GET /stocks/all` 항목. */
export interface TossListedStock {
    symbol: string;
    name: string;
    securityType: string;
    isCommonShare: boolean;
    isinCode: string;
}

/** `GET /stocks` 항목. 종목명과 상장 상태, 국내 종목의 거래정지·NXT 지원 여부를 알려 준다. */
export interface TossStockInfo {
    symbol: string;
    name: string;
    englishName?: string;
    isinCode?: string;
    market: TossStockMarket;
    securityType: string;
    isCommonShare: boolean;
    status: 'SCHEDULED' | 'ACTIVE' | 'DELISTED';
    currency: TossCurrency;
    listDate?: string | null;
    delistDate?: string | null;
    sharesOutstanding?: string;
    leverageFactor?: string | null;
    koreanMarketDetail?: {
        liquidationTrading: boolean;
        nxtSupported: boolean;
        krxTradingSuspended: boolean;
        nxtTradingSuspended?: boolean | null;
    } | null;
}

// ============ 시세 ============

/** `GET /prices` 항목. */
export interface TossPrice {
    symbol: string;
    timestamp?: string | null;
    lastPrice?: string;
    currency?: TossCurrency;
}

/** `GET /orderbook` 응답. */
export interface TossOrderbookResult {
    timestamp?: string | null;
    currency?: TossCurrency;
    asks?: Array<{ price: string; volume: string }>;
    bids?: Array<{ price: string; volume: string }>;
}

/** `GET /candles` 항목. 1분봉의 `timestamp` 는 봉의 종료 시각이고, 일봉은 그 거래일의 현지 자정이다. */
export interface TossCandle {
    timestamp: string;
    openPrice: string;
    highPrice: string;
    lowPrice: string;
    closePrice: string;
    volume: string;
    currency?: TossCurrency;
}

/** `GET /candles` 응답. 봉은 최신순이다. */
export interface TossCandlesResult {
    candles?: TossCandle[];
    nextBefore?: string | null;
}

// ============ 주문 ============

/** 주문의 세부 상태. */
export type TossOrderStatus =
    | 'PENDING' | 'PENDING_CANCEL' | 'PENDING_REPLACE' | 'PARTIAL_FILLED'
    | 'FILLED' | 'CANCELED' | 'REJECTED'
    | 'CANCEL_REJECTED' | 'REPLACE_REJECTED' | 'REPLACED';

/** 주문의 체결 결과. 수수료와 세금은 브로커가 확정한 값이다. */
export interface TossOrderExecution {
    filledQuantity?: string;
    averageFilledPrice?: string | null;
    filledAmount?: string | null;
    commission?: string | null;
    tax?: string | null;
    filledAt?: string | null;
    settlementDate?: string | null;
}

/** `GET /orders` 항목. */
export interface TossOrder {
    orderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    orderType?: 'LIMIT' | 'MARKET';
    timeInForce?: string;
    status?: TossOrderStatus;
    price?: string | null;
    quantity?: string;
    orderAmount?: string | null;
    currency?: TossCurrency;
    orderedAt?: string;
    canceledAt?: string | null;
    execution?: TossOrderExecution;
}

/** `GET /orders` 응답. */
export interface TossPaginatedOrders {
    orders?: TossOrder[];
    nextCursor?: string | null;
    hasNext?: boolean;
}

/** `POST /orders` 응답. */
export interface TossOrderCreateResponse {
    orderId: string;
    clientOrderId?: string | null;
}

// ============ 조건주문 ============

export type TossConditionalOrderType = 'SINGLE' | 'OCO' | 'OTO';

/** 조건주문 등록 요청의 leg. `orderPrice` 는 지정가일 때만 보낸다. */
export interface TossConditionalLegRequest {
    orderSide: 'BUY' | 'SELL';
    triggerPrice: string;
    orderPrice?: string;
}

/** `POST /conditional-orders` 요청 본문. */
export interface TossConditionalOrderCreateRequest {
    symbol: string;
    type: TossConditionalOrderType;
    quantity: string;
    orderType: 'LIMIT' | 'MARKET';
    /** 만료일(`YYYY-MM-DD`, 한국 시각). */
    expireDate: string;
    clientOrderId?: string;
    first: TossConditionalLegRequest;
    second?: TossConditionalLegRequest;
    confirmHighValueOrder?: boolean;
}

/** 조건주문 등록 응답. */
export interface TossConditionalOrderCreateResponse {
    conditionalOrderId: string;
    status?: string;
}

/** 조건주문 조회 응답의 leg. 조회 응답에는 주문 방향이 없다. */
export interface TossConditionalOrderLeg {
    orderSide?: string;
    triggerPrice?: string;
    orderPrice?: string;
    status?: string;
    triggeredOrderId?: string;
}

/** `GET /conditional-orders` 항목. */
export interface TossConditionalOrder {
    conditionalOrderId: string;
    symbol: string;
    type: TossConditionalOrderType;
    status?: string;
    quantity?: string;
    orderType?: string;
    expireDate?: string;
    createdAt?: string;
    first?: TossConditionalOrderLeg;
    second?: TossConditionalOrderLeg;
}

export interface TossPaginatedConditionalOrders {
    conditionalOrders?: TossConditionalOrder[];
    hasNext?: boolean;
    nextCursor?: string;
}

// ============ 유의사항 ============

/** `GET /stocks/{symbol}/warnings` 의 유의사항 종류. 목록에 없는 값이 올 수 있다. */
export type TossStockWarningType =
    | 'LIQUIDATION_TRADING'
    | 'OVERHEATED'
    | 'INVESTMENT_WARNING'
    | 'INVESTMENT_RISK'
    | 'VI_STATIC_AND_DYNAMIC'
    | 'VI_STATIC'
    | 'VI_DYNAMIC'
    | 'STOCK_WARRANTS';

/** 유의사항 하나. `startDate` 이상 `endDate` 이하인 동안 유효하고, 날짜가 없으면 상시다. */
export interface TossStockWarning {
    warningType: TossStockWarningType | string;
    exchange?: string | null;
    startDate?: string | null;
    endDate?: string | null;
}

// ============ 수수료율 ============

/** `GET /commissions` 항목. */
export interface TossCommission {
    marketCountry: TossMarketCountry;
    commissionRate: string;
    startDate?: string | null;
    endDate?: string | null;
}

/** 당일 상·하한가(`GET /price-limits`) 원본. 해외는 가격 제한이 없어 `upperLimitPrice`·`lowerLimitPrice` 가 `null`이다. */
export interface TossPriceLimit {
    timestamp: string;
    upperLimitPrice: string | null;
    lowerLimitPrice: string | null;
    currency: string;
}

// ============ 투자자별 매매대금 · 랭킹 ============

/** 투자자 유형별 매수·매도 대금(원화, 문자열). */
export interface TossInvestorAmount {
    buyAmount: string;
    sellAmount: string;
}

/** `GET /market-indicators/{KOSPI|KOSDAQ}/investor-trading` 의 기록. 시장 단위이며 종목 단위가 아니다. */
export interface TossInvestorTradingRecord {
    date: string;
    updatedAt: string;
    individual?: TossInvestorAmount;
    foreigner?: TossInvestorAmount;
    institution?: TossInvestorAmount;
    otherCorporation?: TossInvestorAmount;
}

export interface TossInvestorTradingResponse {
    nextUntil?: string | null;
    records?: TossInvestorTradingRecord[];
}

// ============ 종목 단위 수급 ============

/** 매수·매도·순매수 거래량(주식 수, 문자열). */
export interface TossVolumeFlow {
    buyVolume: string;
    sellVolume: string;
    netBuyVolume: string;
}

/** 기관 세부 분류 7종의 매매동향. */
export interface TossInstitutionBreakdown {
    financialInvestment: TossVolumeFlow;
    insurance: TossVolumeFlow;
    trust: TossVolumeFlow;
    privateEquityFund: TossVolumeFlow;
    bank: TossVolumeFlow;
    otherFinancialInstitution: TossVolumeFlow;
    pensionFund: TossVolumeFlow;
}

/** `GET /stocks/{symbol}/investor-trading` 의 일별 기록. 당일 잠정치는 일부 필드가 `null`이다. */
export interface TossStockInvestorTradingRecord {
    date: string;
    updatedAt: string;
    individual: TossVolumeFlow | null;
    foreigner: TossVolumeFlow | null;
    institution: (TossVolumeFlow & { breakdown: TossInstitutionBreakdown | null }) | null;
    otherCorporation: TossVolumeFlow | null;
    foreignerHolding: { holdingQuantity: string; limitQuantity: string; holdingRate: string } | null;
    cfd: { buyBalanceQuantity: string; buyBalanceRate: string; sellBalanceQuantity: string; sellBalanceRate: string } | null;
}

export interface TossStockInvestorTradingResponse {
    nextUntil: string | null;
    records: TossStockInvestorTradingRecord[];
}

/** `GET /stocks/{symbol}/program-trades` 의 일별 기록. */
export interface TossProgramTradeRecord {
    date: string;
    arbitrage: TossVolumeFlow;
    nonArbitrage: TossVolumeFlow;
}

export interface TossProgramTradesResponse {
    nextUntil: string | null;
    records: TossProgramTradeRecord[];
}

/**
 * `GET /stocks/{symbol}/short-selling` 의 일별 기록. 비중의 분모는 정규장 외 세션을 포함한 해당 일자 누적 거래량·거래대금이다.
 * 분모 데이터가 없는 날짜는 비중이 `null`이다.
 */
export interface TossShortSellingRecord {
    date: string;
    updatedAt: string;
    shortSellingVolume: string;
    shortSellingAmount: string;
    shortSellingVolumeRate: string | null;
    shortSellingAmountRate: string | null;
}

export interface TossShortSellingResponse {
    nextUntil: string | null;
    records: TossShortSellingRecord[];
}

/** 신용융자·신용대주 공통 항목(신규·상환·잔고 수량, 잔고 비율, 공여율). */
export interface TossCreditLoan {
    newQuantity: string;
    returnQuantity: string;
    balanceQuantity: string;
    balanceRate: string;
    tradingRate: string;
}

/**
 * `GET /stocks/{symbol}/credit-trades` 의 일별 기록. `marginLoan`(신용융자)은 자기신용·유통금융 합산이고
 * `stockLoan`(신용대주)은 개인 신용거래다. 해당 일자에 한쪽 데이터만 있으면 없는 쪽은 `null`이다.
 */
export interface TossCreditTradeRecord {
    date: string;
    updatedAt: string;
    marginLoan: TossCreditLoan | null;
    stockLoan: TossCreditLoan | null;
}

export interface TossCreditTradesResponse {
    nextUntil: string | null;
    records: TossCreditTradeRecord[];
}

/** `GET /stocks/{symbol}/securities-lending` 의 일별 기록. 기관 투자자 간 주식 대여·차입 거래이며, 신용대주와는 다른 데이터다. */
export interface TossSecuritiesLendingRecord {
    date: string;
    updatedAt: string;
    executionQuantity: string;
    repaymentQuantity: string;
    balanceQuantity: string;
    balanceAmount: string;
}

export interface TossSecuritiesLendingResponse {
    nextUntil: string | null;
    records: TossSecuritiesLendingRecord[];
}

/** 시장 지표 심볼 카탈로그(국내 지수 2종, 국채 6종). 카탈로그 밖 심볼은 서버가 400 `unsupported-symbol`로 거절한다. */
export type TossMarketIndicatorSymbol = 'KOSPI' | 'KOSDAQ' | 'KR_BOND_2Y' | 'KR_BOND_3Y' | 'KR_BOND_5Y' | 'KR_BOND_10Y' | 'KR_BOND_20Y' | 'KR_BOND_30Y';

/** 랭킹 종류. `TOSS_SECURITIES_*` 는 토스증권 체결 기준 집계다. */
export type TossRankingType =
    | 'MARKET_TRADING_AMOUNT' | 'MARKET_TRADING_VOLUME'
    | 'TOP_GAINERS' | 'TOP_LOSERS'
    | 'TOSS_SECURITIES_TRADING_AMOUNT' | 'TOSS_SECURITIES_TRADING_VOLUME';

/**
 * 랭킹 행. 숫자는 `rank` 만 number 이고 나머지는 문자열이다.
 *
 * `price.changeRate` 는 퍼센트가 아니라 소수 비율이다(`0.0217` 은 2.17%). `symbol` 은 접미사 없는 종목코드이고 통화는 `currency` 로 따로 온다.
 */
export interface TossRankingItem {
    rank: number;
    symbol: string;
    currency: TossCurrency;
    price?: { lastPrice?: string; basePrice?: string; changeRate?: string | null };
    tradingVolume?: string;
    tradingAmount?: string;
}

export interface TossRankingsResponse {
    rankedAt?: string | null;
    rankings?: TossRankingItem[];
}
