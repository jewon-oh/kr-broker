/**
 * @fileoverview 토큰 재발급 **교차 프로세스 락** — 브로커 공용.
 *
 * `refreshPromise` 는 같은 프로세스 안에서만 발급을 하나로 만든다. 토큰 저장소(`options.tokenStore`)를 나눠 쓰는 프로세스 사이에서는
 * 이 락을 잡은 쪽만 발급한다. 토스는 재발급이 직전 토큰을 무효로 만들고, KIS 와 KB증권은 발급 빈도를 제한하기 때문이다.
 */

import { logger } from './logger';
import type { BrokerTokenStore } from './options';

/** 락을 못 잡았을 때 다른 프로세스의 발급을 기다리는 최대 시간. 토스 발급 상한(10초)보다 길게 잡는다. */
const DEFAULT_WAIT_MS = 12_000;
/** 기다리는 동안 저장소를 다시 읽는 간격. */
const DEFAULT_POLL_MS = 250;

export interface TokenRefreshLockParams<T> {
    /** 로그 접두 (예: `[TossAuth]`). */
    label: string;
    /** 토큰 저장소. 없으면 락 없이 바로 발급한다(단일 프로세스). */
    store: BrokerTokenStore | null;
    /** 토큰 저장소 키 — 락 키는 여기에 `:lock` 을 붙인다. */
    storeKey: string;
    /** 락 TTL. 발급이 이보다 오래 걸리면 다른 프로세스가 들어온다. */
    lockTtlMs: number;
    /**
     * 저장소 캐시에서 **유효한** 토큰을 읽는다. 없거나 만료면 `null`.
     * 락을 못 잡았을 때 다른 프로세스가 넣어 준 것을 가져오기 위해 쓴다.
     */
    readCached: () => Promise<T | null>;
    /** 새 토큰을 발급하고 **캐시에 저장까지** 한다. */
    issueAndCache: () => Promise<T>;
    /** 락 미획득 시 최대 대기 시간(ms). */
    waitMs?: number;
    /** 대기 중 저장소를 다시 읽는 간격(ms). */
    pollMs?: number;
}

/**
 * 교차 프로세스 락을 걸고 토큰을 발급한다.
 *
 * 순서:
 * 1. 저장소가 없으면 그냥 발급한다(단일 프로세스).
 * 2. `store.tryLock` 으로 락을 잡으면 저장소를 한 번 더 읽고, 없을 때만 발급한다. 락은 **자기 락일 때만** 푼다.
 * 3. 못 잡으면 `DEFAULT_POLL_MS` 간격으로 최대 `DEFAULT_WAIT_MS` 동안 저장소를 다시 읽는다. 다른 프로세스가 넣었으면 그걸 쓴다.
 * 4. 그래도 없으면 직접 발급한다(최후 폴백). 이 경로도 `issueAndCache` 를 거치므로 저장이 빠지지 않는다.
 */
export async function refreshTokenWithLock<T>(params: TokenRefreshLockParams<T>): Promise<T> {
    const { label, store, storeKey, lockTtlMs, readCached, issueAndCache } = params;
    if (!store) return issueAndCache();

    const lockKey = `${storeKey}:lock`;
    const lockValue = `${process.pid}:${Date.now()}`;

    // 락 획득만 try 로 감싼다. 발급이 실패하면 그 실패를 그대로 던져야 한다. 락 오류로 오인해 다시 발급하면
    // 발급 횟수 제한이 있는 브로커(KIS 는 분당 1회)에 실패한 요청을 한 번 더 보내게 된다.
    let acquired = false;
    try {
        acquired = await store.tryLock(lockKey, lockValue, lockTtlMs);
    } catch (err) {
        logger.warn({ err }, `${label} 토큰 저장소 락 획득 실패 — 폴백 진행`);
    }
    if (acquired) {
        try {
            // 락을 잡기 직전에 다른 프로세스가 발급을 마치고 락을 풀었을 수 있다. 저장소에 있으면 발급하지 않는다.
            const cached = await readCached().catch(() => null);
            if (cached !== null) return cached;
            return await issueAndCache();
        } finally {
            // 자기 락만 푼다 — 만료된 뒤 다른 프로세스가 잡은 락을 지우지 않게.
            try {
                await store.unlock(lockKey, lockValue);
            } catch (err) {
                logger.debug({ err }, `${label} 토큰 저장소 락 해제 실패 (자동 만료, 무시)`);
            }
        }
    }

    // 락 미획득 → 다른 프로세스가 발급 중. 발급 상한까지 짧은 간격으로 저장소를 다시 읽는다. 한 번만 보고 직접 발급하면
    // 상대의 발급이 길어질 때 두 곳이 발급한다(토스는 두 토큰 중 하나가 곧바로 무효다). 대기는 횟수로 센다.
    const pollMs = params.pollMs ?? DEFAULT_POLL_MS;
    const polls = Math.max(1, Math.ceil((params.waitMs ?? DEFAULT_WAIT_MS) / pollMs));
    for (let i = 0; i < polls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        try {
            const cached = await readCached();
            if (cached !== null) {
                logger.info(`${label} 🤝 다른 프로세스 발급 토큰 사용 (분산 락 협업)`);
                return cached;
            }
        } catch (err) {
            logger.debug({ err }, `${label} 협업 토큰 재조회 실패`);
        }
    }

    logger.warn({}, `${label} 분산 락 협업 실패 — 직접 발급 폴백 (발급 빈도 제한 위험)`);
    return issueAndCache();
}
