/**
 * @fileoverview `kis` 의 API 트리와 암묵 메서드 선언. `scripts/gen-ts-abstract.mjs` 가 `ts/src/spec/kis.json` 에서 만든 생성 파일이다.
 * 직접 고치지 말고 JSON 을 고친 뒤 `node scripts/gen-ts-abstract.mjs` 를 돌린다.
 */
import type { Dict, ImplicitApiMethod } from '../base/types';

/** `describe().api` 에 넣는 트리. `Exchange.defineRestApi` 가 엔드포인트마다 암묵 메서드를 만든다. */
export const KIS_API_TREE: Dict = {
    public: {
        post: {
            'oauth2/tokenP': { cost: 1 },
            'oauth2/Approval': { cost: 1 },
        },
    },
    private: {
        get: {
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
            'uapi/overseas-price/v1/quotations/price': { cost: 1 },
            'uapi/overseas-price/v1/quotations/dailyprice': { cost: 1 },
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
};

/** `KIS_API_TREE` 의 엔드포인트마다 생기는 암묵 메서드. 증권사 클래스가 선언 병합으로 받는다. */
export interface KisImplicitApi {
    publicPostOauth2TokenP: ImplicitApiMethod;
    publicPostOauth2Approval: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquirePrice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsIntstockMultprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireAskingPriceExpCcn: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireDailyItemchartprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireTimeItemchartprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireInvestor: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsSearchStockInfo: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireViStatus: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsVolumeRank: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingFluctuation: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingAfterHourBalance: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingBulkTransNum: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingDisparity: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingExpTransUpdown: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingMarketCap: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingNearNewHighlow: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingPreferDisparateRatio: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingQuoteBalance: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingTopInterestStock: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingTradedByCompany: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingVolumePower: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingCreditBalance: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingDividendRate: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingFinanceRatio: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingHtsTopView: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingMarketValue: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingOvertimeExpTransFluct: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingOvertimeFluctuation: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingOvertimeVolume: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingProfitAssetIndex: ImplicitApiMethod;
    privateGetUapiDomesticStockV1RankingShortSale: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsExpClosingPrice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireCcnl: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireTimeItemconclusion: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireTimeOvertimeconclusion: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireOvertimePrice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireOvertimeAskingPrice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireDailyOvertimeprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireMember: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsFrgnmemTradeTrend: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireDailyIndexchartprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireTimeIndexchartprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireTimeDailychartprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireDailyPrice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquirePrice2: ImplicitApiMethod;
    privateGetUapiEtfetnV1QuotationsInquirePrice: ImplicitApiMethod;
    privateGetUapiEtfetnV1QuotationsInquireComponentStockPrice: ImplicitApiMethod;
    privateGetUapiEtfetnV1QuotationsNavComparisonTrend: ImplicitApiMethod;
    privateGetUapiEtfetnV1QuotationsNavComparisonDailyTrend: ImplicitApiMethod;
    privateGetUapiEtfetnV1QuotationsNavComparisonTimeTrend: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireElwPrice: ImplicitApiMethod;
    privateGetUapiElwV1RankingUpdownRate: ImplicitApiMethod;
    privateGetUapiElwV1RankingVolumeRank: ImplicitApiMethod;
    privateGetUapiElwV1RankingIndicator: ImplicitApiMethod;
    privateGetUapiElwV1RankingSensitivity: ImplicitApiMethod;
    privateGetUapiElwV1RankingQuickChange: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsCompareStocks: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsExpirationStocks: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsNewlyListed: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsUdrlAssetList: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsUdrlAssetPrice: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsIndicatorTrendCcnl: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsIndicatorTrendDaily: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsIndicatorTrendMinute: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsSensitivityTrendCcnl: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsSensitivityTrendDaily: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsVolatilityTrendCcnl: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsVolatilityTrendDaily: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsVolatilityTrendMinute: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsCondSearch: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsLpTradeTrend: ImplicitApiMethod;
    privateGetUapiElwV1QuotationsVolatilityTrendTick: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1QuotationsDisplayBoardCallput: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1QuotationsDisplayBoardFutures: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1QuotationsDisplayBoardOptionList: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1QuotationsDisplayBoardTop: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1QuotationsExpPriceTrend: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1QuotationsInquireAskingPrice: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1QuotationsInquirePrice: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1QuotationsInquireDailyFuopchartprice: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1QuotationsInquireTimeFuopchartprice: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsInquirePrice: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsOptPrice: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsStockDetail: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsOptDetail: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsSearchContractDetail: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsSearchOptDetail: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsInquireAskingPrice: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsOptAskingPrice: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsMarketTime: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsInvestorUnpdTrend: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsTickCcnl: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsDailyCcnl: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsWeeklyCcnl: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsMonthlyCcnl: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsInquireTimeFuturechartprice: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsOptTickCcnl: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsOptDailyCcnl: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsOptWeeklyCcnl: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1QuotationsOptMonthlyCcnl: ImplicitApiMethod;
    privateGetUapiDomesticBondV1QuotationsInquirePrice: ImplicitApiMethod;
    privateGetUapiDomesticBondV1QuotationsInquireAskingPrice: ImplicitApiMethod;
    privateGetUapiDomesticBondV1QuotationsInquireCcnl: ImplicitApiMethod;
    privateGetUapiDomesticBondV1QuotationsInquireDailyPrice: ImplicitApiMethod;
    privateGetUapiDomesticBondV1QuotationsInquireDailyItemchartprice: ImplicitApiMethod;
    privateGetUapiDomesticBondV1QuotationsIssueInfo: ImplicitApiMethod;
    privateGetUapiDomesticBondV1QuotationsSearchBondInfo: ImplicitApiMethod;
    privateGetUapiDomesticBondV1QuotationsAvgUnit: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsCompProgramTradeDaily: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsCompProgramTradeToday: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsEstimatePerform: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingInquireAlgoCcnl: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquireBalance: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquireBalanceSettlementPl: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquireBalanceValuationPl: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquireCcnl: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquireCcnlBstime: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquireDailyAmountFee: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquireDeposit: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquireNgtBalance: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquireNgtCcnl: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquirePsblNgtOrder: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingInquirePsblOrder: ImplicitApiMethod;
    privateGetUapiDomesticFutureoptionV1TradingNgtMarginDetail: ImplicitApiMethod;
    privateGetUapiDomesticBondV1TradingInquireBalance: ImplicitApiMethod;
    privateGetUapiDomesticBondV1TradingInquireDailyCcld: ImplicitApiMethod;
    privateGetUapiDomesticBondV1TradingInquirePsblOrder: ImplicitApiMethod;
    privateGetUapiDomesticBondV1TradingInquirePsblRvsecncl: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1TradingInquireCcld: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1TradingInquireDailyCcld: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1TradingInquireDailyOrder: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1TradingInquireDeposit: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1TradingInquirePeriodCcld: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1TradingInquirePeriodTrans: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1TradingInquirePsamount: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1TradingInquireUnpd: ImplicitApiMethod;
    privateGetUapiOverseasFutureoptionV1TradingMarginDetail: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsDailyCreditBalance: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsDailyLoanTrans: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsDailyShortSale: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireDailyTradeVolume: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInvestorTradeByStockDaily: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInvestorTrendEstimate: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsFrgnmemPchsTrend: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireMemberDaily: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsProgramTradeByStock: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsProgramTradeByStockDaily: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsForeignInstitutionTotal: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsFrgnmemTradeEstimate: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsCaptureUplowprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInvestorProgramTradeToday: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireInvestorDailyByMarket: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsMktfunds: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsExpPriceTrend: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsPbarTratio: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsTradprtByamt: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsIntstockGrouplist: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsIntstockStocklistByGroup: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsPsearchTitle: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsPsearchResult: ImplicitApiMethod;
    privateGetUapiDomesticStockV1FinanceBalanceSheet: ImplicitApiMethod;
    privateGetUapiDomesticStockV1FinanceIncomeStatement: ImplicitApiMethod;
    privateGetUapiDomesticStockV1FinanceFinancialRatio: ImplicitApiMethod;
    privateGetUapiDomesticStockV1FinanceProfitRatio: ImplicitApiMethod;
    privateGetUapiDomesticStockV1FinanceOtherMajorRatios: ImplicitApiMethod;
    privateGetUapiDomesticStockV1FinanceStabilityRatio: ImplicitApiMethod;
    privateGetUapiDomesticStockV1FinanceGrowthRatio: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoPaidinCapin: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoBonusIssue: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoDividend: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoPurreq: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoMergerSplit: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoRevSplit: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoCapDcrs: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoListInfo: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoPubOffer: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoForfeit: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoMandDeposit: ImplicitApiMethod;
    privateGetUapiDomesticStockV1KsdinfoSharehldMeet: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsCreditByCompany: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInvestOpbysec: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInvestOpinion: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsNewsTitle: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsSearchInfo: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsLendableByCompany: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireIndexPrice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireIndexDailyPrice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireIndexTimeprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireIndexTickprice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsInquireIndexCategoryPrice: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsExpIndexTrend: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsExpTotalIndex: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsCompInterest: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsMarketTime: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingMarketCap: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingNewHighlow: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingPriceFluct: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingUpdownRate: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingTradeVol: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingTradePbmn: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingTradeGrowth: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingTradeTurnover: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingVolumePower: ImplicitApiMethod;
    privateGetUapiOverseasStockV1RankingVolumeSurge: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsInquireAskingPrice: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsPriceDetail: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsInquireCcnl: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsInquireDailyChartprice: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsInquireTimeIndexchartprice: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsInquireTimeItemchartprice: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsIndustryPrice: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsIndustryTheme: ImplicitApiMethod;
    privateGetUapiOverseasStockV1QuotationsCountriesHoliday: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsBrknewsTitle: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsNewsTitle: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsInquireSearch: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsColableByCompany: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsPeriodRights: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsRightsByIce: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsSearchInfo: ImplicitApiMethod;
    privateGetUapiDomesticStockV1QuotationsChkHoliday: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquireBalance: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquirePsblOrder: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquirePsblRvsecncl: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquireDailyCcld: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquirePeriodTradeProfit: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquireAccountBalance: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquireBalanceRlzPl: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquireCreditPsamount: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquirePeriodProfit: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingInquirePsblSell: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingIntgrMargin: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingOrderResvCcnl: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingPeriodRights: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingPensionInquireBalance: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingPensionInquireDailyCcld: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingPensionInquireDeposit: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingPensionInquirePresentBalance: ImplicitApiMethod;
    privateGetUapiDomesticStockV1TradingPensionInquirePsblOrder: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsPrice: ImplicitApiMethod;
    privateGetUapiOverseasPriceV1QuotationsDailyprice: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingInquireBalance: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingInquirePresentBalance: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingInquireCcnl: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingInquireNccs: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingAlgoOrdno: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingForeignMargin: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingInquirePaymtStdrBalance: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingInquirePeriodProfit: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingInquirePeriodTrans: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingInquirePsamount: ImplicitApiMethod;
    privateGetUapiOverseasStockV1TradingOrderResvList: ImplicitApiMethod;
    privatePostUapiDomesticStockV1TradingOrderCash: ImplicitApiMethod;
    privatePostUapiDomesticStockV1TradingOrderRvsecncl: ImplicitApiMethod;
    privatePostUapiOverseasStockV1TradingOrder: ImplicitApiMethod;
    privatePostUapiOverseasStockV1TradingOrderRvsecncl: ImplicitApiMethod;
    privatePostUapiDomesticStockV1TradingOrderCredit: ImplicitApiMethod;
    privatePostUapiDomesticStockV1TradingOrderResv: ImplicitApiMethod;
    privatePostUapiDomesticStockV1TradingOrderResvRvsecncl: ImplicitApiMethod;
    privatePostUapiOverseasStockV1TradingDaytimeOrder: ImplicitApiMethod;
    privatePostUapiOverseasStockV1TradingDaytimeOrderRvsecncl: ImplicitApiMethod;
    privatePostUapiOverseasStockV1TradingOrderResv: ImplicitApiMethod;
    privatePostUapiOverseasStockV1TradingOrderResvCcnl: ImplicitApiMethod;
    privatePostUapiDomesticFutureoptionV1TradingOrder: ImplicitApiMethod;
    privatePostUapiDomesticFutureoptionV1TradingOrderRvsecncl: ImplicitApiMethod;
    privatePostUapiOverseasFutureoptionV1TradingOrder: ImplicitApiMethod;
    privatePostUapiOverseasFutureoptionV1TradingOrderRvsecncl: ImplicitApiMethod;
    privatePostUapiDomesticBondV1TradingBuy: ImplicitApiMethod;
    privatePostUapiDomesticBondV1TradingSell: ImplicitApiMethod;
    privatePostUapiDomesticBondV1TradingOrderRvsecncl: ImplicitApiMethod;
}

/** `private` GET 엔드포인트의 경로. 경로를 실행 중에 골라 부르는 곳이 경로 오타를 컴파일할 때 잡는다. */
export type KisPrivateGetPath =
    | 'uapi/domestic-stock/v1/quotations/inquire-price'
    | 'uapi/domestic-stock/v1/quotations/intstock-multprice'
    | 'uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn'
    | 'uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice'
    | 'uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice'
    | 'uapi/domestic-stock/v1/quotations/inquire-investor'
    | 'uapi/domestic-stock/v1/quotations/search-stock-info'
    | 'uapi/domestic-stock/v1/quotations/inquire-vi-status'
    | 'uapi/domestic-stock/v1/quotations/volume-rank'
    | 'uapi/domestic-stock/v1/ranking/fluctuation'
    | 'uapi/domestic-stock/v1/ranking/after-hour-balance'
    | 'uapi/domestic-stock/v1/ranking/bulk-trans-num'
    | 'uapi/domestic-stock/v1/ranking/disparity'
    | 'uapi/domestic-stock/v1/ranking/exp-trans-updown'
    | 'uapi/domestic-stock/v1/ranking/market-cap'
    | 'uapi/domestic-stock/v1/ranking/near-new-highlow'
    | 'uapi/domestic-stock/v1/ranking/prefer-disparate-ratio'
    | 'uapi/domestic-stock/v1/ranking/quote-balance'
    | 'uapi/domestic-stock/v1/ranking/top-interest-stock'
    | 'uapi/domestic-stock/v1/ranking/traded-by-company'
    | 'uapi/domestic-stock/v1/ranking/volume-power'
    | 'uapi/domestic-stock/v1/ranking/credit-balance'
    | 'uapi/domestic-stock/v1/ranking/dividend-rate'
    | 'uapi/domestic-stock/v1/ranking/finance-ratio'
    | 'uapi/domestic-stock/v1/ranking/hts-top-view'
    | 'uapi/domestic-stock/v1/ranking/market-value'
    | 'uapi/domestic-stock/v1/ranking/overtime-exp-trans-fluct'
    | 'uapi/domestic-stock/v1/ranking/overtime-fluctuation'
    | 'uapi/domestic-stock/v1/ranking/overtime-volume'
    | 'uapi/domestic-stock/v1/ranking/profit-asset-index'
    | 'uapi/domestic-stock/v1/ranking/short-sale'
    | 'uapi/domestic-stock/v1/quotations/exp-closing-price'
    | 'uapi/domestic-stock/v1/quotations/inquire-ccnl'
    | 'uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion'
    | 'uapi/domestic-stock/v1/quotations/inquire-time-overtimeconclusion'
    | 'uapi/domestic-stock/v1/quotations/inquire-overtime-price'
    | 'uapi/domestic-stock/v1/quotations/inquire-overtime-asking-price'
    | 'uapi/domestic-stock/v1/quotations/inquire-daily-overtimeprice'
    | 'uapi/domestic-stock/v1/quotations/inquire-member'
    | 'uapi/domestic-stock/v1/quotations/frgnmem-trade-trend'
    | 'uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice'
    | 'uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice'
    | 'uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice'
    | 'uapi/domestic-stock/v1/quotations/inquire-daily-price'
    | 'uapi/domestic-stock/v1/quotations/inquire-price-2'
    | 'uapi/etfetn/v1/quotations/inquire-price'
    | 'uapi/etfetn/v1/quotations/inquire-component-stock-price'
    | 'uapi/etfetn/v1/quotations/nav-comparison-trend'
    | 'uapi/etfetn/v1/quotations/nav-comparison-daily-trend'
    | 'uapi/etfetn/v1/quotations/nav-comparison-time-trend'
    | 'uapi/domestic-stock/v1/quotations/inquire-elw-price'
    | 'uapi/elw/v1/ranking/updown-rate'
    | 'uapi/elw/v1/ranking/volume-rank'
    | 'uapi/elw/v1/ranking/indicator'
    | 'uapi/elw/v1/ranking/sensitivity'
    | 'uapi/elw/v1/ranking/quick-change'
    | 'uapi/elw/v1/quotations/compare-stocks'
    | 'uapi/elw/v1/quotations/expiration-stocks'
    | 'uapi/elw/v1/quotations/newly-listed'
    | 'uapi/elw/v1/quotations/udrl-asset-list'
    | 'uapi/elw/v1/quotations/udrl-asset-price'
    | 'uapi/elw/v1/quotations/indicator-trend-ccnl'
    | 'uapi/elw/v1/quotations/indicator-trend-daily'
    | 'uapi/elw/v1/quotations/indicator-trend-minute'
    | 'uapi/elw/v1/quotations/sensitivity-trend-ccnl'
    | 'uapi/elw/v1/quotations/sensitivity-trend-daily'
    | 'uapi/elw/v1/quotations/volatility-trend-ccnl'
    | 'uapi/elw/v1/quotations/volatility-trend-daily'
    | 'uapi/elw/v1/quotations/volatility-trend-minute'
    | 'uapi/elw/v1/quotations/cond-search'
    | 'uapi/elw/v1/quotations/lp-trade-trend'
    | 'uapi/elw/v1/quotations/volatility-trend-tick'
    | 'uapi/domestic-futureoption/v1/quotations/display-board-callput'
    | 'uapi/domestic-futureoption/v1/quotations/display-board-futures'
    | 'uapi/domestic-futureoption/v1/quotations/display-board-option-list'
    | 'uapi/domestic-futureoption/v1/quotations/display-board-top'
    | 'uapi/domestic-futureoption/v1/quotations/exp-price-trend'
    | 'uapi/domestic-futureoption/v1/quotations/inquire-asking-price'
    | 'uapi/domestic-futureoption/v1/quotations/inquire-price'
    | 'uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice'
    | 'uapi/domestic-futureoption/v1/quotations/inquire-time-fuopchartprice'
    | 'uapi/overseas-futureoption/v1/quotations/inquire-price'
    | 'uapi/overseas-futureoption/v1/quotations/opt-price'
    | 'uapi/overseas-futureoption/v1/quotations/stock-detail'
    | 'uapi/overseas-futureoption/v1/quotations/opt-detail'
    | 'uapi/overseas-futureoption/v1/quotations/search-contract-detail'
    | 'uapi/overseas-futureoption/v1/quotations/search-opt-detail'
    | 'uapi/overseas-futureoption/v1/quotations/inquire-asking-price'
    | 'uapi/overseas-futureoption/v1/quotations/opt-asking-price'
    | 'uapi/overseas-futureoption/v1/quotations/market-time'
    | 'uapi/overseas-futureoption/v1/quotations/investor-unpd-trend'
    | 'uapi/overseas-futureoption/v1/quotations/tick-ccnl'
    | 'uapi/overseas-futureoption/v1/quotations/daily-ccnl'
    | 'uapi/overseas-futureoption/v1/quotations/weekly-ccnl'
    | 'uapi/overseas-futureoption/v1/quotations/monthly-ccnl'
    | 'uapi/overseas-futureoption/v1/quotations/inquire-time-futurechartprice'
    | 'uapi/overseas-futureoption/v1/quotations/opt-tick-ccnl'
    | 'uapi/overseas-futureoption/v1/quotations/opt-daily-ccnl'
    | 'uapi/overseas-futureoption/v1/quotations/opt-weekly-ccnl'
    | 'uapi/overseas-futureoption/v1/quotations/opt-monthly-ccnl'
    | 'uapi/domestic-bond/v1/quotations/inquire-price'
    | 'uapi/domestic-bond/v1/quotations/inquire-asking-price'
    | 'uapi/domestic-bond/v1/quotations/inquire-ccnl'
    | 'uapi/domestic-bond/v1/quotations/inquire-daily-price'
    | 'uapi/domestic-bond/v1/quotations/inquire-daily-itemchartprice'
    | 'uapi/domestic-bond/v1/quotations/issue-info'
    | 'uapi/domestic-bond/v1/quotations/search-bond-info'
    | 'uapi/domestic-bond/v1/quotations/avg-unit'
    | 'uapi/domestic-stock/v1/quotations/comp-program-trade-daily'
    | 'uapi/domestic-stock/v1/quotations/comp-program-trade-today'
    | 'uapi/domestic-stock/v1/quotations/estimate-perform'
    | 'uapi/overseas-stock/v1/trading/inquire-algo-ccnl'
    | 'uapi/domestic-futureoption/v1/trading/inquire-balance'
    | 'uapi/domestic-futureoption/v1/trading/inquire-balance-settlement-pl'
    | 'uapi/domestic-futureoption/v1/trading/inquire-balance-valuation-pl'
    | 'uapi/domestic-futureoption/v1/trading/inquire-ccnl'
    | 'uapi/domestic-futureoption/v1/trading/inquire-ccnl-bstime'
    | 'uapi/domestic-futureoption/v1/trading/inquire-daily-amount-fee'
    | 'uapi/domestic-futureoption/v1/trading/inquire-deposit'
    | 'uapi/domestic-futureoption/v1/trading/inquire-ngt-balance'
    | 'uapi/domestic-futureoption/v1/trading/inquire-ngt-ccnl'
    | 'uapi/domestic-futureoption/v1/trading/inquire-psbl-ngt-order'
    | 'uapi/domestic-futureoption/v1/trading/inquire-psbl-order'
    | 'uapi/domestic-futureoption/v1/trading/ngt-margin-detail'
    | 'uapi/domestic-bond/v1/trading/inquire-balance'
    | 'uapi/domestic-bond/v1/trading/inquire-daily-ccld'
    | 'uapi/domestic-bond/v1/trading/inquire-psbl-order'
    | 'uapi/domestic-bond/v1/trading/inquire-psbl-rvsecncl'
    | 'uapi/overseas-futureoption/v1/trading/inquire-ccld'
    | 'uapi/overseas-futureoption/v1/trading/inquire-daily-ccld'
    | 'uapi/overseas-futureoption/v1/trading/inquire-daily-order'
    | 'uapi/overseas-futureoption/v1/trading/inquire-deposit'
    | 'uapi/overseas-futureoption/v1/trading/inquire-period-ccld'
    | 'uapi/overseas-futureoption/v1/trading/inquire-period-trans'
    | 'uapi/overseas-futureoption/v1/trading/inquire-psamount'
    | 'uapi/overseas-futureoption/v1/trading/inquire-unpd'
    | 'uapi/overseas-futureoption/v1/trading/margin-detail'
    | 'uapi/domestic-stock/v1/quotations/daily-credit-balance'
    | 'uapi/domestic-stock/v1/quotations/daily-loan-trans'
    | 'uapi/domestic-stock/v1/quotations/daily-short-sale'
    | 'uapi/domestic-stock/v1/quotations/inquire-daily-trade-volume'
    | 'uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily'
    | 'uapi/domestic-stock/v1/quotations/investor-trend-estimate'
    | 'uapi/domestic-stock/v1/quotations/frgnmem-pchs-trend'
    | 'uapi/domestic-stock/v1/quotations/inquire-member-daily'
    | 'uapi/domestic-stock/v1/quotations/program-trade-by-stock'
    | 'uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily'
    | 'uapi/domestic-stock/v1/quotations/foreign-institution-total'
    | 'uapi/domestic-stock/v1/quotations/frgnmem-trade-estimate'
    | 'uapi/domestic-stock/v1/quotations/capture-uplowprice'
    | 'uapi/domestic-stock/v1/quotations/investor-program-trade-today'
    | 'uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market'
    | 'uapi/domestic-stock/v1/quotations/mktfunds'
    | 'uapi/domestic-stock/v1/quotations/exp-price-trend'
    | 'uapi/domestic-stock/v1/quotations/pbar-tratio'
    | 'uapi/domestic-stock/v1/quotations/tradprt-byamt'
    | 'uapi/domestic-stock/v1/quotations/intstock-grouplist'
    | 'uapi/domestic-stock/v1/quotations/intstock-stocklist-by-group'
    | 'uapi/domestic-stock/v1/quotations/psearch-title'
    | 'uapi/domestic-stock/v1/quotations/psearch-result'
    | 'uapi/domestic-stock/v1/finance/balance-sheet'
    | 'uapi/domestic-stock/v1/finance/income-statement'
    | 'uapi/domestic-stock/v1/finance/financial-ratio'
    | 'uapi/domestic-stock/v1/finance/profit-ratio'
    | 'uapi/domestic-stock/v1/finance/other-major-ratios'
    | 'uapi/domestic-stock/v1/finance/stability-ratio'
    | 'uapi/domestic-stock/v1/finance/growth-ratio'
    | 'uapi/domestic-stock/v1/ksdinfo/paidin-capin'
    | 'uapi/domestic-stock/v1/ksdinfo/bonus-issue'
    | 'uapi/domestic-stock/v1/ksdinfo/dividend'
    | 'uapi/domestic-stock/v1/ksdinfo/purreq'
    | 'uapi/domestic-stock/v1/ksdinfo/merger-split'
    | 'uapi/domestic-stock/v1/ksdinfo/rev-split'
    | 'uapi/domestic-stock/v1/ksdinfo/cap-dcrs'
    | 'uapi/domestic-stock/v1/ksdinfo/list-info'
    | 'uapi/domestic-stock/v1/ksdinfo/pub-offer'
    | 'uapi/domestic-stock/v1/ksdinfo/forfeit'
    | 'uapi/domestic-stock/v1/ksdinfo/mand-deposit'
    | 'uapi/domestic-stock/v1/ksdinfo/sharehld-meet'
    | 'uapi/domestic-stock/v1/quotations/credit-by-company'
    | 'uapi/domestic-stock/v1/quotations/invest-opbysec'
    | 'uapi/domestic-stock/v1/quotations/invest-opinion'
    | 'uapi/domestic-stock/v1/quotations/news-title'
    | 'uapi/domestic-stock/v1/quotations/search-info'
    | 'uapi/domestic-stock/v1/quotations/lendable-by-company'
    | 'uapi/domestic-stock/v1/quotations/inquire-index-price'
    | 'uapi/domestic-stock/v1/quotations/inquire-index-daily-price'
    | 'uapi/domestic-stock/v1/quotations/inquire-index-timeprice'
    | 'uapi/domestic-stock/v1/quotations/inquire-index-tickprice'
    | 'uapi/domestic-stock/v1/quotations/inquire-index-category-price'
    | 'uapi/domestic-stock/v1/quotations/exp-index-trend'
    | 'uapi/domestic-stock/v1/quotations/exp-total-index'
    | 'uapi/domestic-stock/v1/quotations/comp-interest'
    | 'uapi/domestic-stock/v1/quotations/market-time'
    | 'uapi/overseas-stock/v1/ranking/market-cap'
    | 'uapi/overseas-stock/v1/ranking/new-highlow'
    | 'uapi/overseas-stock/v1/ranking/price-fluct'
    | 'uapi/overseas-stock/v1/ranking/updown-rate'
    | 'uapi/overseas-stock/v1/ranking/trade-vol'
    | 'uapi/overseas-stock/v1/ranking/trade-pbmn'
    | 'uapi/overseas-stock/v1/ranking/trade-growth'
    | 'uapi/overseas-stock/v1/ranking/trade-turnover'
    | 'uapi/overseas-stock/v1/ranking/volume-power'
    | 'uapi/overseas-stock/v1/ranking/volume-surge'
    | 'uapi/overseas-price/v1/quotations/inquire-asking-price'
    | 'uapi/overseas-price/v1/quotations/price-detail'
    | 'uapi/overseas-price/v1/quotations/inquire-ccnl'
    | 'uapi/overseas-price/v1/quotations/inquire-daily-chartprice'
    | 'uapi/overseas-price/v1/quotations/inquire-time-indexchartprice'
    | 'uapi/overseas-price/v1/quotations/inquire-time-itemchartprice'
    | 'uapi/overseas-price/v1/quotations/industry-price'
    | 'uapi/overseas-price/v1/quotations/industry-theme'
    | 'uapi/overseas-stock/v1/quotations/countries-holiday'
    | 'uapi/overseas-price/v1/quotations/brknews-title'
    | 'uapi/overseas-price/v1/quotations/news-title'
    | 'uapi/overseas-price/v1/quotations/inquire-search'
    | 'uapi/overseas-price/v1/quotations/colable-by-company'
    | 'uapi/overseas-price/v1/quotations/period-rights'
    | 'uapi/overseas-price/v1/quotations/rights-by-ice'
    | 'uapi/overseas-price/v1/quotations/search-info'
    | 'uapi/domestic-stock/v1/quotations/chk-holiday'
    | 'uapi/domestic-stock/v1/trading/inquire-balance'
    | 'uapi/domestic-stock/v1/trading/inquire-psbl-order'
    | 'uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl'
    | 'uapi/domestic-stock/v1/trading/inquire-daily-ccld'
    | 'uapi/domestic-stock/v1/trading/inquire-period-trade-profit'
    | 'uapi/domestic-stock/v1/trading/inquire-account-balance'
    | 'uapi/domestic-stock/v1/trading/inquire-balance-rlz-pl'
    | 'uapi/domestic-stock/v1/trading/inquire-credit-psamount'
    | 'uapi/domestic-stock/v1/trading/inquire-period-profit'
    | 'uapi/domestic-stock/v1/trading/inquire-psbl-sell'
    | 'uapi/domestic-stock/v1/trading/intgr-margin'
    | 'uapi/domestic-stock/v1/trading/order-resv-ccnl'
    | 'uapi/domestic-stock/v1/trading/period-rights'
    | 'uapi/domestic-stock/v1/trading/pension/inquire-balance'
    | 'uapi/domestic-stock/v1/trading/pension/inquire-daily-ccld'
    | 'uapi/domestic-stock/v1/trading/pension/inquire-deposit'
    | 'uapi/domestic-stock/v1/trading/pension/inquire-present-balance'
    | 'uapi/domestic-stock/v1/trading/pension/inquire-psbl-order'
    | 'uapi/overseas-price/v1/quotations/price'
    | 'uapi/overseas-price/v1/quotations/dailyprice'
    | 'uapi/overseas-stock/v1/trading/inquire-balance'
    | 'uapi/overseas-stock/v1/trading/inquire-present-balance'
    | 'uapi/overseas-stock/v1/trading/inquire-ccnl'
    | 'uapi/overseas-stock/v1/trading/inquire-nccs'
    | 'uapi/overseas-stock/v1/trading/algo-ordno'
    | 'uapi/overseas-stock/v1/trading/foreign-margin'
    | 'uapi/overseas-stock/v1/trading/inquire-paymt-stdr-balance'
    | 'uapi/overseas-stock/v1/trading/inquire-period-profit'
    | 'uapi/overseas-stock/v1/trading/inquire-period-trans'
    | 'uapi/overseas-stock/v1/trading/inquire-psamount'
    | 'uapi/overseas-stock/v1/trading/order-resv-list';
