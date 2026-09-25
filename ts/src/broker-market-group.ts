/**
 * @fileoverview 증권사 ID 판정, 심볼의 종목코드, 상장 시장 → 시장 그룹(KR/US) 판정 — **어떤 모듈도 import 하지 않는다.**
 *
 * 거래 시간 판정(`trading-hours.ts`)이 쓰는 순수 표와 함수를 이 파일에 독립적으로 둔다.
 */

/** 주식 시장 그룹: 국내(KR) 와 미국(US). 시장을 가리키는 `'KR' | 'US'` 는 이 타입 하나를 쓴다. */
export type StockMarketGroup = 'KR' | 'US';

/** 이 패키지가 다루는 증권사 거래소 ID. */
export const STOCK_BROKER_EXCHANGES: ReadonlySet<string> = new Set(['kis', 'toss', 'kbsec']);

/** `exchangeId` 가 이 패키지가 다루는 증권사인가. */
export function isStockBrokerExchange(exchangeId: string): boolean {
    return STOCK_BROKER_EXCHANGES.has(exchangeId);
}

/**
 * 심볼에서 종목코드를 꺼낸다. 끝의 `/KRW`·`/USD` 만 떼고, 남은 `/` 는 클래스 주식 표기로 보고 통합 표기의 `.` 로 바꾼다
 * (`BRK/B` → `BRK.B`, `BRK.B/USD` → `BRK.B`). 대소문자와 공백은 그대로 둔다.
 */
export function symbolBaseCode(symbol: string): string {
    return symbol.replace(/\/(KRW|USD)$/, '').replaceAll('/', '.');
}

/**
 * KIS 해외 시세코드(3글자) → 표준 상장 시장명. KR/US 밖(홍콩·중국·베트남·일본)도 담는다. 표기 표준화는 그룹 판정과 별개라서,
 * 그룹 표에 없는 시장은 `marketGroupOf` 가 `null` 을 돌려주므로 KR/US 전용 경로에 섞여 들어가지 않는다. `AMS` 는 암스테르담이 아니라
 * AMEX 다(KIS `EXCD` 축).
 */
export const BROKER_MARKET_CODE_TO_MARKET = {
    NAS: 'NASDAQ',
    NYS: 'NYSE',
    AMS: 'AMEX',
    HKS: 'HKEX',
    SHS: 'SSE',
    SZS: 'SZSE',
    HSX: 'HOSE',
    HNX: 'HNX',
    TSE: 'TSE',
} as const;

export type BrokerMarketCode = keyof typeof BROKER_MARKET_CODE_TO_MARKET;

/**
 * 시장 이름을 표준명으로 — 시세코드면 표준명으로 바꾸고, 이미 표준명이면 그대로 둔다(멱등). 대문자로 맞추고 앞뒤 공백을 뗀다.
 * 비었으면 `null`.
 */
export function normalizeMarketName(market?: string | null): string | null {
    if (!market) return null;
    const key = market.trim().toUpperCase();
    return BROKER_MARKET_CODE_TO_MARKET[key as BrokerMarketCode] ?? key;
}

/**
 * 상장 시장 → 시장 그룹 표. 그룹 값(`KR`, `US`)도 그대로 통과시켜, 이미 정규화된 입력과 시장명 입력을 함께 받는다. 시세코드(NAS·NYS·AMS)는
 * 적지 않는다 — `normalizeMarketName` 이 먼저 표준명으로 바꾸므로, 두 곳에 적으면 한쪽만 갱신되는 문제가 생긴다.
 */
const MARKET_TO_GROUP: Readonly<Record<string, StockMarketGroup>> = {
    KR: 'KR',
    KOSPI: 'KR',
    KOSDAQ: 'KR',
    KONEX: 'KR',
    KRX: 'KR',
    KSE: 'KR',
    NXT: 'KR',
    US: 'US',
    NYSE: 'US',
    NASDAQ: 'US',
    AMEX: 'US',
    NYSEARCA: 'US',
    ARCA: 'US',
    BATS: 'US',
    OTC: 'US',
};

/**
 * 상장 시장의 시장 그룹. **모르면 `null` 을 돌려준다.** 소비처가 `market === 'US' ? 'US' : 'KR'` 같은 기본값으로 모르는 값을 조용히 한쪽으로
 * 분류하면 안 된다. 호출부가 `null` 을 명시적으로 처리하게 하려는 것이다.
 */
export function marketGroupOf(market?: string | null): StockMarketGroup | null {
    const name = normalizeMarketName(market);
    return name ? MARKET_TO_GROUP[name] ?? null : null;
}
