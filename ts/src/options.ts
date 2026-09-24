/**
 * @fileoverview 증권사 인스턴스가 `options` 로 받는 값의 모양.
 *
 * ccxt 가 `new binance({ apiKey, secret, options: { ... } })` 로 모든 설정을 인스턴스에 넘기듯이, 이 라이브러리도 전역 설정 없이 인스턴스마다
 * 옵션을 받는다.
 *
 * ```ts
 * const broker = new kis({
 *     apiKey, secret, uid,
 *     options: {
 *         tokenStore,                                // 여러 프로세스가 토큰을 나눠 쓴다
 *         nxtRouting: true,                          // 정규장 밖 주문을 NXT 로 낸다
 *         masterData: { kospi, kosdaq, nasdaq, nyse, amex },
 *     },
 * });
 * ```
 *
 * 값이 함수인 옵션(`tokenStore`, `nxtRouting`, `confirmBudget` 등)은 쓸 때마다 호출한다. 운영 중에 바뀌는 값을 넘길 수 있다.
 */

/**
 * 접근 토큰과 발급 락을 프로세스 사이에 나누는 저장소.
 *
 * 증권사 토큰은 발급 횟수에 제한이 있고, 토스는 클라이언트당 유효 토큰이 하나뿐이라(재발급이 직전 토큰을 무효로 만든다) 여러 프로세스가
 * 토큰을 공유해야 한다. 그 저장소를 특정 제품(Redis 등)이 아니라 인증 모듈이 쓰는 연산 여섯 개로 선언한다. 저장소가 없으면 인증 모듈은
 * 프로세스 안 메모리 캐시만 쓴다.
 *
 * 메서드는 실패하면 던진다. 호출하는 쪽이 저마다 로그와 대체 동작(새로 발급 등)을 정한다.
 */
export interface BrokerTokenStore {
    get(key: string): Promise<string | null>;
    /** `ttlMs` 뒤에 사라지게 저장한다. */
    set(key: string, value: string, ttlMs: number): Promise<void>;
    delete(key: string): Promise<void>;
    /**
     * 저장된 값(JSON)의 `accessToken` 이 `accessToken` 과 같을 때만 지운다. 남의 새 토큰을 지우지 않기 위해서다. 지웠으면 `true`.
     * 값이 없거나 JSON 이 아니면 지우지 않는다(모르는 값을 지우는 쪽이 사고의 원인이었다).
     */
    deleteIfAccessTokenEquals(key: string, accessToken: string): Promise<boolean>;
    /** `ttlMs` 동안 유효한 락을 잡는다. 이미 잡혀 있으면 `false`. */
    tryLock(key: string, owner: string, ttlMs: number): Promise<boolean>;
    /** `owner` 가 잡은 락일 때만 푼다. */
    unlock(key: string, owner: string): Promise<void>;
}

/** `options.tokenStore` 의 값. 저장소이거나, 호출 때마다 저장소(지금 쓸 수 없으면 `null`)를 돌려주는 함수다. */
export type TokenStoreOption = BrokerTokenStore | (() => BrokerTokenStore | null) | null | undefined;

/** 켜고 끄는 옵션(`nxtRouting`, `krwIntegratedMargin`, `usExtendedLimit`)의 값. 불리언이거나 불리언을 돌려주는 함수다. */
export type FlagOption = boolean | (() => boolean | Promise<boolean>) | undefined;

/** `options.usdKrwRate` 의 값. 1달러당 원화를 돌려준다. 조회에 실패하면 던질 수 있고, 부르는 쪽이 실패를 다룬다. */
export type UsdKrwRateOption = () => Promise<number>;

/** 국내 종목이 KOSPI 인지 KOSDAQ 인지 알려 주는 곳. `options.stockDirectory` 로 넘긴다. */
export interface BrokerStockDirectory {
    /** 6자리 종목코드의 시장. 모르면 `undefined`. 조회가 실패하면 던진다. */
    findKrMarket(code: string): Promise<'KOSPI' | 'KOSDAQ' | undefined>;
}

/** 옵션 값에서 토큰 저장소를 꺼낸다. 함수면 지금 호출한다. */
export function resolveTokenStore(option: TokenStoreOption): BrokerTokenStore | null {
    if (option === undefined || option === null) return null;
    return typeof option === 'function' ? option() : option;
}

/** 옵션 값이 켜져 있는가. 값이 없거나 `true` 가 아니면 꺼진 것이다. */
export async function resolveFlag(option: FlagOption): Promise<boolean> {
    if (typeof option === 'function') return (await option()) === true;
    return option === true;
}
