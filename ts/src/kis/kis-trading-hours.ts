/**
 * @fileoverview KRX 거래시간의 재수출 — 정본은 `../krx-trading-hours` 다.
 *
 * `kis.ts` 가 이 경로를 import 하고 테스트가 `vi.mock('../kis-trading-hours',...)` 로 이 경로를 가로챈다.
 * 경로를 바꾸면 목이 빗나가므로 경로는 두고, 사본이 아니라 **재수출**만 둔다.
 */
export {
    checkKRXTradingHours,
    getKrxMarketPhase,
    getTimeUntilKrxOpen,
    getNxtSession,
    isNxtExtendedTradable,
} from '../krx-trading-hours';
export type { KrxMarketPhase, NxtSession } from '../krx-trading-hours';
