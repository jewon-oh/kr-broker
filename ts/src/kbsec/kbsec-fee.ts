/**
 * @fileoverview KB증권 매매비용 **추정** 정본.
 *
 * ## 왜 별도 파일인가 — 추정기가 둘이었고 서로 달랐다
 *
 * 같은 "KB 수수료"를 두 곳이 각자 계산했고 값이 서로 어긋났다:
 *
 * - `kbsec` 클래스의 수수료 추정 — 국내 0.015% + 매도세, 해외 0.1%
 * - 호출하는 쪽의 거래 기록 수수료 추정 — **KB증권이 요율표에 없어** 폴백 0.1%
 *
 * 그리고 실제로 저장돼 **진입 leg 손익에 들어가는** 값은 후자다. 그래서 국내 KB 매매는
 * 위탁수수료가 6.7배 과대 계상되고 **매도 증권거래세 0.18% 는 통째로 빠진** 채 기록돼 왔다.
 * 승률·기대수익·손실 한도 판정이 전부 이 값을 쓴다.
 *
 * 상수를 여기 한 곳에 두고 두 호출부가 같이 읽게 해서 다시 어긋나지 않게 한다.
 *
 * 위 문단의 "0.18%" 는 당시의 값이다. 그 뒤 **매도세는 상수가 아니라
 * 시행일별 표**가 됐다 — 2025년 0.15%, 2026년 0.20%. `KR_SELL_TAX_SCHEDULE` 참조.
 *
 * ## 이건 어디까지나 **추정치**다 — 최종 목표는 실측 교체
 *
 * 여기 값은 공시 요율에서 온 근사이고, KB 가 **실제로 청구한** 금액이 아니다. 한 계정의
 * 한 달치 해외주식 실측에서는 매매제비용이 총매매손익보다 커서 순손익이 음수였다.
 * 비용이 총손익을 뒤집을 만큼 크므로, 요율을 아무리 다듬어도 실제 청구액과는 어긋난다.
 *
 * 정본은 KB 정산 TR 이 준다 — 해외 `SPQM2205`(매매가정산현황: `frgn_trd_fee_p4` 해외매매
 * 수수료 · `frgn_dl_tx_p4` 해외거래세), 국내 `SSQM2121`(계좌별매매가정산현황: `fee` · `dl_tx`).
 * 둘 다 **일자 × 종목 × 매매구분** 단위다(주문번호는 어느 손익·정산 TR 에도 없다).
 * 그 행들은 `fetchDomesticSettlements`·`fetchOverseasSettlements` 로 받을 수 있고, 이 모듈은 조회 실패나 아직 정산되지 않은 구간의 폴백으로 쓴다.
 */

import { krxSellTaxRate, KRX_SELL_TAX_SCHEDULE } from '../krx-sell-tax';
import { kbsecMarketOf, type KBSecMarketCountry } from './kbsec-types';

/** 국내 위탁수수료율(공시 근사) — 실청구액은 정산 TR 로 확정한다. */
export const KBSEC_BROKERAGE_FEE = 0.00015;
/** 해외(미국) 위탁수수료율(공시 근사). SEC fee 등 기타 제비용은 포함돼 있지 않다. */
export const KBSEC_US_BROKERAGE_FEE = 0.001;

/**
 * 국내 매도 증권거래세는 **브로커 밖의 정본**을 쓴다(`../krx-sell-tax`).
 *
 * 정부가 정하는 세금이라 KB·KIS·토스가 같은 값을 써야 하는데, 종전엔 셋이 각자 `0.0018` 을
 * 가지고 있었고 셋 다 2024년 값이 갱신되지 않은 채 남아 있었다. 여기서 재수출해 KB 호출부가 그대로
 * 읽게 하되, 값 자체는 한 곳에서만 관리한다.
 */
export { krxSellTaxRate as krSellTaxRate, KRX_SELL_TAX_SCHEDULE as KR_SELL_TAX_SCHEDULE };

/**
 * 실효 매매비용률 — 위탁수수료 + (국내 매도면) 증권거래세.
 *
 * `rate` 는 **실효율**이다(`cost = 명목금액 × rate` 가 성립한다). 종전 어댑터는 `cost` 에만
 * 세금을 더하고 `rate` 로는 위탁수수료율만 돌려줘서 둘이 어긋났다 — 토스·KIS 어댑터는
 * 이미 세금을 포함한 실효율을 돌려주고 있어 브로커끼리도 축이 달랐다.
 */
export function kbsecEstimatedFeeRate(
    market: KBSecMarketCountry,
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
 * (USD 명목을 주면 USD 비용, KRW 명목을 주면 KRW 비용). 단위가 이름에 없는 값을 통화 변환
 * 없이 넘겨 1,400배 어긋난 사고가 실제로 있었다 — 넘기기 전에 축을 확인할 것.
 *
 * `at` 은 체결 시각이다(생략하면 현재). 국내 매도세가 시행일마다 달라 과거 거래를 다시
 * 계산할 때는 그 거래의 시각을 넘겨야 한다 — `krSellTaxRate` 주석 참조.
 */
export function kbsecEstimatedFee(
    notional: number,
    symbol: string,
    side: 'buy' | 'sell',
    at: Date = new Date(),
): { cost: number; rate: number; market: KBSecMarketCountry } {
    const market = kbsecMarketOf(symbol);
    const rate = kbsecEstimatedFeeRate(market, side, at);
    return { cost: notional * rate, rate, market };
}
