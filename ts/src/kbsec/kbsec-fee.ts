/**
 * @fileoverview KB증권 매매비용 **추정** 정본.
 *
 * KB 매매비용 추정 상수는 이 파일 한 곳에만 둔다. 국내 매도세는 상수가 아니라 시행일별 표다(`KR_SELL_TAX_SCHEDULE`).
 *
 * ## 이건 어디까지나 **추정치**다
 *
 * 여기 값은 공시 요율에서 온 근사이고, KB 가 **실제로 청구한** 금액이 아니다.
 *
 * 정본은 KB 정산 TR 이 준다 — 해외 `SPQM2205`(매매가정산현황: `frgn_trd_fee_p4` 해외매매
 * 수수료 · `frgn_dl_tx_p4` 해외거래세), 국내 `SSQM2121`(계좌별매매가정산현황: `fee` · `dl_tx`).
 * 둘 다 **일자 × 종목 × 매매구분** 단위다(주문번호는 어느 손익·정산 TR 에도 없다).
 * 그 행들은 `fetchDomesticSettlements`·`fetchOverseasSettlements` 로 받을 수 있고, 이 모듈은 조회 실패나 아직 정산되지 않은 구간의 폴백으로 쓴다.
 */

import type { StockMarketGroup } from '../broker-market-group';
import { krxSellTaxRate, KRX_SELL_TAX_SCHEDULE } from '../krx-sell-tax';
import { kbsecMarketOf } from './kbsec-types';

/** 국내 위탁수수료율(공시 근사) — 실청구액은 정산 TR 로 확정한다. */
export const KBSEC_BROKERAGE_FEE = 0.00015;
/** 해외(미국) 위탁수수료율(공시 근사). SEC fee 등 기타 제비용은 포함돼 있지 않다. */
export const KBSEC_US_BROKERAGE_FEE = 0.001;

/**
 * 국내 매도 증권거래세는 **브로커 밖의 정본**을 쓴다(`../krx-sell-tax`).
 *
 * 정부가 정하는 세금이라 KB·KIS·토스가 같은 값을 쓴다. 여기서 재수출해 KB 호출부가 그대로
 * 읽게 하되, 값 자체는 한 곳에서만 관리한다.
 */
export { krxSellTaxRate as krSellTaxRate, KRX_SELL_TAX_SCHEDULE as KR_SELL_TAX_SCHEDULE };

/**
 * 실효 매매비용률 — 위탁수수료 + (국내 매도면) 증권거래세.
 *
 * `rate` 는 **실효율**이다(`cost = 명목금액 × rate` 가 성립한다). 토스·KIS 처럼 세금을 포함한다.
 */
export function kbsecEstimatedFeeRate(
    market: StockMarketGroup,
    side: 'buy' | 'sell',
    at: Date = new Date(),
): number {
    const brokerage = market === 'KR' ? KBSEC_BROKERAGE_FEE : KBSEC_US_BROKERAGE_FEE;
    const tax = market === 'KR' && side === 'sell' ? krxSellTaxRate(at) : 0;
    return brokerage + tax;
}

/**
 * 명목금액에 대한 추정 매매비용.
 *
 * `notional` 의 통화는 호출부가 정한다 — 이 함수는 비율만 곱하므로 통화를 바꾸지 않는다
 * (USD 명목을 주면 USD 비용, KRW 명목을 주면 KRW 비용). 넘기기 전에 통화 축을 확인할 것.
 *
 * `at` 은 체결 시각이다(생략하면 현재). 국내 매도세가 시행일마다 달라 과거 거래를 다시
 * 계산할 때는 그 거래의 시각을 넘겨야 한다 — `krSellTaxRate` 주석 참조.
 */
export function kbsecEstimatedFee(
    notional: number,
    symbol: string,
    side: 'buy' | 'sell',
    at: Date = new Date(),
): { cost: number; rate: number; market: StockMarketGroup } {
    const market = kbsecMarketOf(symbol);
    const rate = kbsecEstimatedFeeRate(market, side, at);
    return { cost: notional * rate, rate, market };
}
