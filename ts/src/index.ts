/**
 * @fileoverview 패키지 진입점. ccxt 처럼 증권사 클래스(`kis`·`toss`·`kbsec`)와 그 부모(`Exchange`), 오류 계층, 자료 구조를 내보낸다.
 *
 * ```ts
 * import { kis } from '<패키지 이름>';
 * const broker = new kis({ apiKey, secret, uid: '12345678-01' });
 * await broker.loadMarkets();
 * const ticker = await broker.fetchTicker('005930/KRW');
 * ```
 *
 * 설정은 전부 인스턴스가 받는다(`options`). 라이브러리 수준의 설정은 로거(`setLogger`) 하나뿐이고, 기본은 아무것도 출력하지 않는다.
 */

import { Exchange } from './base';
import { kis } from './kis';
import { kbsec } from './kbsec';
import { toss } from './toss';

export * from './base';
export { kis, kbsec, toss };
export * from './market-calendar';
export { setLogger, noopLogger } from './logger';
export type { BrokerLogger, BrokerLogFn, BrokerLogContext } from './logger';
export type { BrokerStockDirectory, BrokerTokenStore, FlagOption, TokenStoreOption, UsdKrwRateOption } from './options';
export type { ConfirmBudget, ConfirmBudgetOption } from './execution-confirm';
export type { KisMasterData } from './kis/kis-master-data';
export type { KRXStock } from './kis/kis-stock-master';
export type { OverseasStock } from './kis/kis-overseas-master';
export { checkKRXTradingHoursAt, getKrxMarketPhase, isKrxBusinessDayKst } from './krx-trading-hours';
export { getUsMarketPhase } from './us-market-hours';

/** 지원하는 증권사 id 목록. */
export const exchanges = ['kis', 'kbsec', 'toss'] as const;

export type ExchangeId = typeof exchanges[number];

/** 증권사 id → 클래스. `new brokers[id]({...})` 로 만든다. */
export const brokers = { kis, kbsec, toss } as const;

export default { Exchange, kis, kbsec, toss, exchanges, brokers };
