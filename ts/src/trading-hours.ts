/**
 * @fileoverview 거래소별 거래시간 — **거래소 ID 축**의 공용 술어.
 *
 * KRX 시간표는 `./krx-trading-hours` 한 곳에만 두고, 이 파일은 거래소 ID → 시장 매핑만 한다. 주식 브로커 3사(kis·toss·kbsec)는 모두
 * KRX 정규장을 공유하므로 `isStockBrokerExchange` 하나로 라우팅한다. 이 패키지가 모르는 거래소는 시간 제한이 없다고 본다.
 * 국내 휴장일은 공용 캘린더(`./market-calendar`)가 알 때만 막는다. 캘린더가 모르는 평일은 열린 날로 본다.
 *
 * 인자는 시장 이름이 아니라 **거래소 ID**(`'kis'`, `'toss'`)다. `'stock'` 같은 시장 이름을 넘기면 "표에 없음 = 제한 없음" 으로 **조용히 0** 이 나온다.
 */
import { isKrxDomesticCode } from './broker-krx-code';
import { isStockBrokerExchange, marketGroupOf, stockTicker } from './broker-market-group';
import { getOverseasMarketForCode } from './overseas-stock-master';
import { EMPTY_KIS_MASTER_DATA, type KisMasterData } from './stock-master-data';
import { checkKRXTradingHoursAt, getTimeUntilKrxOpen, krxAuctionBuyBlockReason } from './krx-trading-hours';
import { usOrderBlockReason } from './us-market-hours';

/**
 * 현재 시각에 거래소가 운영 중인지 확인.
 * 주식 브로커(kis/toss/kbsec)는 KRX 정규장이고, 이 패키지가 모르는 거래소는 시간을 제한하지 않아 항상 `true`.
 *
 * KRX 판정은 `./krx-trading-hours` 정본에 위임한다. 휴장일은 공용 캘린더가 아는 날만 막는다.
 *
 * @param exchangeId 거래소 ID
 * @param now 기준 시각 (기본: 현재)
 * @returns 거래 가능 여부
 */
export function isTradingHours(exchangeId: string, now: Date = new Date()): boolean {
    if (!isStockBrokerExchange(exchangeId)) return true; // 이 패키지가 모르는 거래소는 제한하지 않는다
    return checkKRXTradingHoursAt(now).tradable;
}

/**
 * 거래 불가 사유 — 게이트가 막았을 때 사람이 읽을 문구.
 * 열려 있으면 `null`.
 */
export function tradingHoursBlockReason(exchangeId: string, now: Date = new Date()): string | null {
    if (!isStockBrokerExchange(exchangeId)) return null;
    const { tradable, reason } = checkKRXTradingHoursAt(now);
    return tradable ? null : `KRX ${reason ?? '거래시간 외'}`;
}

/**
 * 다음 거래 시작까지 남은 시간 (ms). 현재 거래 중이면 0.
 * 정본(`getTimeUntilKrxOpen`)에 위임하므로 닫혀 있으면 연휴가 길어도 0 을 돌려주지 않는다.
 */
export function getTimeUntilMarketOpen(exchangeId: string, now: Date = new Date()): number {
    if (!isStockBrokerExchange(exchangeId)) return 0; // 이 패키지가 모르는 거래소는 시간 제한이 없다
    return getTimeUntilKrxOpen(now);
}

/** `marketSessionBlockReason` 의 주문 정책. 시장 규칙이 아니라 호출하는 쪽이 고르는 값이다. */
export interface MarketSessionOrderPolicy {
    /** 주문 방향. 동시호가 신규 매수 차단에 쓴다. */
    side?: string | undefined;
    /** 종가 동시호가(국내 15:20~15:30, 미국 15:50~16:00 ET)의 신규 매수를 막는다. 기본은 `false` 다. */
    blockAuctionBuys?: boolean | undefined;
}

/**
 * 지금 이 심볼이 주문을 받지 않는 이유 — 받으면 `null`.
 *
 * 판정 축은 통화나 심볼 모양이 아니라 **상장 거래소**다. 해외 종목은 마스터 데이터에서 상장 거래소를 찾고 `marketGroupOf` 로 그룹을 얻는다.
 * 그룹을 모르면 미국으로 추정하지 않고 막는다. `masterData` 가 없으면 모든 해외 티커를 막는다.
 * 시간표는 세 증권사 공용 게이트(`krxOrderBlockReason`·`usOrderBlockReason`)와 같다.
 *
 * @param exchangeId 거래소 ID — 이 패키지가 모르는 거래소면 항상 `null`(제한 없음)
 * @param symbol 주문 심볼 (`005930/KRW`, `AAPL/USD`, `AAPL` 모두 허용). `COMMON_STOCK_CODES` 의 통합 코드는 티커로 돌려 찾는다
 * @param now 기준 시각
 * @param masterData 해외 종목의 상장 거래소를 찾는 마스터 데이터(`options.masterData`). 없으면 빈 데이터라 모든 해외 티커가 "거래소 미상"이다.
 * @param policy 동시호가 신규 매수 차단. 생략하면 막지 않는다.
 */
export function marketSessionBlockReason(
    exchangeId: string,
    symbol: string,
    now: Date = new Date(),
    masterData: KisMasterData = EMPTY_KIS_MASTER_DATA,
    policy: MarketSessionOrderPolicy = {},
): string | null {
    if (!isStockBrokerExchange(exchangeId)) return null;
    const { side, blockAuctionBuys = false } = policy;

    const [code = ''] = symbol.split('/');
    const base = stockTicker(code.trim()).toUpperCase();
    const krx = (): string | null => tradingHoursBlockReason(exchangeId, now) ?? (blockAuctionBuys ? krxAuctionBuyBlockReason(now, side) : null);
    if (isKrxDomesticCode(base)) return krx();

    // 해외 — **거래소를 먼저 판정한다**. 심볼 모양으로 미국을 추정하지 않는다.
    const venue = getOverseasMarketForCode(masterData, base);
    const group = marketGroupOf(venue);

    if (group === 'KR') return krx();
    // 미국장: 정규장 + 종가 동시호가만 접수. 프리/애프터는 브로커 계약이 달라 여기서 막는다.
    if (group === 'US') return usOrderBlockReason({ now, side, blockAuctionBuys });

    // fail-closed — 상장 거래소를 모르면 어느 세션을 적용할지도 모른다.
    return venue
        ? `세션 표에 없는 거래소 — venue=${venue} (${base})`
        : `상장 거래소 미상 — 해외 마스터에 없는 티커 (${base})`;
}
