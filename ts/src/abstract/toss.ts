/**
 * @fileoverview `toss` 의 API 트리와 암묵 메서드 선언. `scripts/gen-ts-abstract.mjs` 가 `ts/src/spec/toss.json` 에서 만든 생성 파일이다.
 * 직접 고치지 말고 JSON 을 고친 뒤 `node scripts/gen-ts-abstract.mjs` 를 돌린다.
 */
import type { Dict, ImplicitApiMethod } from '../base/types';

/** `describe().api` 에 넣는 트리. `Exchange.defineRestApi` 가 엔드포인트마다 암묵 메서드를 만든다. */
export const TOSS_API_TREE: Dict = {
    public: {
        post: {
            'oauth2/token': { cost: 1, bucket: 'auth' },
        },
    },
    private: {
        market: {
            get: {
                'accounts': { cost: 1, bucket: 'account' },
                'exchange-rate': { cost: 1, bucket: 'market_info' },
                'market-calendar/KR': { cost: 1, bucket: 'market_info' },
                'market-calendar/US': { cost: 1, bucket: 'market_info' },
                'prices': { cost: 1, bucket: 'market_data' },
                'orderbook': { cost: 1, bucket: 'market_data' },
                'candles': { cost: 1, bucket: 'market_data_chart' },
                'trades': { cost: 1, bucket: 'market_data' },
                'price-limits': { cost: 1, bucket: 'market_data' },
                'stocks': { cost: 1, bucket: 'stock' },
                'stocks/all': { cost: 1, bucket: 'stock_all' },
                'stocks/{symbol}/warnings': { cost: 1, bucket: 'stock' },
                'rankings': { cost: 1, bucket: 'ranking' },
                'market-indicators/{symbol}/investor-trading': { cost: 1, bucket: 'market_indicator' },
                'market-indicators/prices': { cost: 1, bucket: 'market_indicator' },
                'market-indicators/{symbol}/candles': { cost: 1, bucket: 'market_indicator_chart' },
                'stocks/{symbol}/investor-trading': { cost: 1, bucket: 'stock_trading_trend' },
                'stocks/{symbol}/program-trades': { cost: 1, bucket: 'stock_trading_trend' },
                'stocks/{symbol}/short-selling': { cost: 1, bucket: 'stock_trading_trend' },
                'stocks/{symbol}/credit-trades': { cost: 1, bucket: 'stock_trading_trend' },
                'stocks/{symbol}/securities-lending': { cost: 1, bucket: 'stock_trading_trend' },
            },
        },
        account: {
            get: {
                'holdings': { cost: 1, bucket: 'asset' },
                'buying-power': { cost: 1, bucket: 'order_info', peak: true },
                'commissions': { cost: 1, bucket: 'order_info', peak: true },
                'sellable-quantity': { cost: 1, bucket: 'order_info', peak: true },
                'orders': { cost: 1, bucket: 'order_history' },
                'orders/{orderId}': { cost: 1, bucket: 'order_history' },
                'conditional-orders': { cost: 1, bucket: 'conditional_order_history' },
                'conditional-orders/{conditionalOrderId}': { cost: 1, bucket: 'conditional_order_history' },
            },
            post: {
                'orders': { cost: 1, bucket: 'order', order: true },
                'orders/{orderId}/cancel': { cost: 1, bucket: 'order', order: true },
                'orders/{orderId}/modify': { cost: 1, bucket: 'order', order: true },
                'conditional-orders': { cost: 1, bucket: 'conditional_order', order: true },
                'conditional-orders/{conditionalOrderId}/modify': { cost: 1, bucket: 'conditional_order', order: true },
            },
            delete: {
                'conditional-orders/{conditionalOrderId}': { cost: 1, bucket: 'conditional_order', order: true },
            },
        },
    },
};

/** `TOSS_API_TREE` 의 엔드포인트마다 생기는 암묵 메서드. 증권사 클래스가 선언 병합으로 받는다. */
export interface TossImplicitApi {
    publicPostOauth2Token: ImplicitApiMethod;
    privateMarketGetAccounts: ImplicitApiMethod;
    privateMarketGetExchangeRate: ImplicitApiMethod;
    privateMarketGetMarketCalendarKR: ImplicitApiMethod;
    privateMarketGetMarketCalendarUS: ImplicitApiMethod;
    privateMarketGetPrices: ImplicitApiMethod;
    privateMarketGetOrderbook: ImplicitApiMethod;
    privateMarketGetCandles: ImplicitApiMethod;
    privateMarketGetTrades: ImplicitApiMethod;
    privateMarketGetPriceLimits: ImplicitApiMethod;
    privateMarketGetStocks: ImplicitApiMethod;
    privateMarketGetStocksAll: ImplicitApiMethod;
    privateMarketGetStocksSymbolWarnings: ImplicitApiMethod;
    privateMarketGetRankings: ImplicitApiMethod;
    privateMarketGetMarketIndicatorsSymbolInvestorTrading: ImplicitApiMethod;
    privateMarketGetMarketIndicatorsPrices: ImplicitApiMethod;
    privateMarketGetMarketIndicatorsSymbolCandles: ImplicitApiMethod;
    privateMarketGetStocksSymbolInvestorTrading: ImplicitApiMethod;
    privateMarketGetStocksSymbolProgramTrades: ImplicitApiMethod;
    privateMarketGetStocksSymbolShortSelling: ImplicitApiMethod;
    privateMarketGetStocksSymbolCreditTrades: ImplicitApiMethod;
    privateMarketGetStocksSymbolSecuritiesLending: ImplicitApiMethod;
    privateAccountGetHoldings: ImplicitApiMethod;
    privateAccountGetBuyingPower: ImplicitApiMethod;
    privateAccountGetCommissions: ImplicitApiMethod;
    privateAccountGetSellableQuantity: ImplicitApiMethod;
    privateAccountGetOrders: ImplicitApiMethod;
    privateAccountGetOrdersOrderId: ImplicitApiMethod;
    privateAccountGetConditionalOrders: ImplicitApiMethod;
    privateAccountGetConditionalOrdersConditionalOrderId: ImplicitApiMethod;
    privateAccountPostOrders: ImplicitApiMethod;
    privateAccountPostOrdersOrderIdCancel: ImplicitApiMethod;
    privateAccountPostOrdersOrderIdModify: ImplicitApiMethod;
    privateAccountPostConditionalOrders: ImplicitApiMethod;
    privateAccountPostConditionalOrdersConditionalOrderIdModify: ImplicitApiMethod;
    privateAccountDeleteConditionalOrdersConditionalOrderId: ImplicitApiMethod;
}
