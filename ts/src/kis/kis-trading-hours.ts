/**
 * @fileoverview KRX 거래시간의 재수출 — 정본은 `../krx-trading-hours` 다.
 *
 * 공개 경로(`kr-broker/kis/kis-trading-hours`)를 쓰는 쪽을 위해 남긴 **재수출**이다. `kis.ts` 는 정본을 직접 가져오고, 테스트는 이 경로를 목으로
 * 가로채지 않고 시각을 고정한다.
 */
export {
    checkKRXTradingHours,
    getKrxMarketPhase,
    getTimeUntilKrxOpen,
    getNxtSession,
    isNxtExtendedTradable,
} from '../krx-trading-hours';
export type { KrxMarketPhase, NxtSession } from '../krx-trading-hours';
