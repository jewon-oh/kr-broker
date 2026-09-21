/**
 * @fileoverview 거래소별 거래시간 — **거래소 ID 축**의 공용 술어.
 *
 * ## 이 파일이 KRX 시간표를 다시 적지 않는 이유
 *
 * 예전에는 이 파일이 KRX 시간표를 **직접 다시 적고 있었다**:
 *
 * ```ts
 * kis: { openMinutes: 9*60, closeMinutes: 15*60+30, weekdaysOnly: true },
 * toss: { openMinutes: 9*60, closeMinutes: 15*60+30, weekdaysOnly: true }, // "kis 와 동일"
 * ```
 *
 * 값은 정본(`./krx-trading-hours`)과 같아 보였지만 **`weekdaysOnly` 는 공휴일을 모른다.**
 * 그래서 설날·추석·광복절 09:00~15:30 에 두 술어가 정반대를 답했다:
 *
 * | 시각 (KST) | `isTradingHours('kis')` | `checkKRXTradingHours` |
 * |-------------------------|-------------------------|--------------------------|
 * | 평일 10:00 | `true` | `tradable: true` |
 * | 토요일 10:00 | `false` | `tradable: false` |
 * | **광복절(금) 10:00** | **`true`** ←틀림 | `tradable: false` |
 *
 * **사본은 "열려 있다"는 관대한 방향으로 어긋났다.** 게이트가 어긋나는 방향은 늘 이쪽이다 —
 * 목록에서 빠진 항목은 *차단이 사라지는* 결과가 된다.
 * 연 15일가량, 토스 캘린더 API 가 실패한 순간에만 드러나는 조용한 빈틈이었다.
 *
 * ## 지금 구조
 *
 * KRX 시간표는 **한 곳**(`./krx-trading-hours`)에만 있고, 이 파일은 *거래소 ID → 시장*
 * 매핑만 한다. 주식 브로커 3사(kis·toss·kbsec)는 모두 KRX 정규장을 공유하므로
 * `isStockBrokerExchange` 하나로 라우팅한다 — 브로커가 늘어도 여기 표를 고칠 일이 없다.
 * 이 패키지가 모르는 거래소는 시간 제한이 없다고 본다.
 *
 * 이 파일의 축은 **거래소 ID**(`'kis'`, `'toss'`)다. 시장 하나만 보는 `krx-trading-hours` 의
 * `getTimeUntilKrxOpen` 과 헷갈리지 않게 한다. 거래소 ID 자리에 `'stock'` 같은 시장 이름을
 * 넘기면 "표에 없음 = 제한 없음" 으로 **조용히 0** 이 나온다.
 */
import { isStockBrokerExchange, marketGroupOf } from './broker-market-group';
import { isKrxDomesticCode } from './kis/kis-types';
// 이 마스터는 KIS 가 배포하는 파일에서 왔지만 내용은 **미국 상장 거래소 정보**다(어디서 얻었는지와 무엇을 다루는지는 별개다).
import { getOverseasMarketForCode } from './kis/kis-overseas-master';
import { EMPTY_KIS_MASTER_DATA, type KisMasterData } from './kis/kis-master-data';
import { checkKRXTradingHoursAt, getTimeUntilKrxOpen } from './krx-trading-hours';
import { getUsMarketPhase, formatEtWallClock } from './us-market-hours';

/**
 * 현재 시각에 거래소가 운영 중인지 확인.
 * 주식 브로커(kis/toss/kbsec)는 KRX 정규장이고, 이 패키지가 모르는 거래소는 시간을 제한하지 않아 항상 `true`.
 *
 * KRX 판정은 `./krx-trading-hours` 정본에 위임한다 — 공휴일 포함.
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
 *
 * 예전에는 여기서 1분 단위로 최대 72시간을 검색했는데, **연휴가 72시간을 넘으면 0** 을
 * 돌려주었고 그 0 은 "지금 열려 있다"와 구분되지 않았다(설 연휴 + 주말은 5일을 넘는다).
 * 정본의 닫힌 형식 계산(14일 skip 루프)에 위임해 그 빈틈을 없앤다.
 */
export function getTimeUntilMarketOpen(exchangeId: string, now: Date = new Date()): number {
    if (!isStockBrokerExchange(exchangeId)) return 0; // 이 패키지가 모르는 거래소는 시간 제한이 없다
    return getTimeUntilKrxOpen(now);
}

/**
 * 지금 이 심볼이 주문을 받지 않는 이유 — 받으면 `null`.
 *
 * ## 판정 축은 통화도, 심볼 모양도 아니라 **상장 거래소**다
 *
 * 예전 축은 `'KR' | 'US'` 였고, 그 값은 이렇게 나왔다:
 *
 * ```ts
 * kbsecMarketOf = isOverseasSymbol(base) ? 'US' : 'KR' // "6자리 숫자가 아니면 해외"
 * ```
 *
 * 즉 **"국내가 아니면 전부 미국"** 이다. 그런데 `kis-overseas-master.ts` 의
 * `OverseasMarket` 은 이미 `TSE`(도쿄)·`HKS`(홍콩)·`SHS`/`SZS`(상해·심천)·`HSX`/`HNX`
 * (베트남)를 포함한다. 도쿄 종목이 들어오는 순간 `'US'` 로 라벨링되고 **NYSE 시간
 * (22:30~05:00 KST)** 이 적용된다 — 도쿄장은 09:00~15:00 KST 이므로 **실제 장중엔 막고,
 * 닫혔을 때 열어 주는** 정확히 뒤집힌 게이트가 된다.
 *
 * 그래서 거래소를 먼저 판정하고, `marketGroupOf` 로 그룹을 얻는다. 그룹을 모르면
 * **막는다** — 예전처럼 미국으로 추정하지 않는다. 세션을 모르는 채 주문을 내보내는 것보다
 * 못 내는 편이 낫다.
 *
 * 현재 해외 마스터에는 미국 3거래소(NAS·NYS·AMS ≈ 12,200종목)만 적재된다. 즉 이 함수가
 * `null`(모름)을 돌려주는 경우는 *마스터에 없는 티커* 뿐이고, 그건 실제로 주문을 내면
 * 안 되는 상태다.
 *
 * @param exchangeId 거래소 ID — 이 패키지가 모르는 거래소면 항상 `null`(제한 없음)
 * @param symbol 주문 심볼 (`005930/KRW`, `AAPL/USD`, `AAPL` 모두 허용)
 * @param now 기준 시각
 * @param masterData 해외 종목의 상장 거래소를 찾는 마스터 데이터(`options.masterData`). 없으면 빈 데이터라 모든 해외 티커가 "거래소 미상"이다.
 */
export function marketSessionBlockReason(
    exchangeId: string,
    symbol: string,
    now: Date = new Date(),
    masterData: KisMasterData = EMPTY_KIS_MASTER_DATA,
): string | null {
    if (!isStockBrokerExchange(exchangeId)) return null;

    const base = symbol.split('/')[0].trim().toUpperCase();
    if (isKrxDomesticCode(base)) return tradingHoursBlockReason(exchangeId, now);

    // 해외 — **거래소를 먼저 판정한다**. 심볼 모양으로 미국을 추정하지 않는다.
    const venue = getOverseasMarketForCode(masterData, base);
    const group = marketGroupOf(venue);

    if (group === 'KR') return tradingHoursBlockReason(exchangeId, now);
    if (group === 'US') {
        // 미국장: 정규장 + 종가 동시호가만 접수. 프리/애프터는 브로커 계약이 달라 여기서 막는다.
        const phase = getUsMarketPhase(now);
        if (phase === 'open' || phase === 'closing-auction') return null;
        return `미국장 정규장 외 (${formatEtWallClock(now)}, phase=${phase})`;
    }

    // fail-closed — 상장 거래소를 모르면 어느 세션을 적용할지도 모른다.
    return venue
        ? `세션 표에 없는 거래소 — venue=${venue} (${base})`
        : `상장 거래소 미상 — 해외 마스터에 없는 티커 (${base})`;
}
