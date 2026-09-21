/**
 * @fileoverview 토큰 재발급 **교차 프로세스 락** — 브로커 공용.
 *
 * ## 왜 있는가
 *
 * 세 주식 브로커의 인증부를 대조한 결과는 "같은 락이 세 곳에 있다" 가 아니라 **"1곳에만 있다"** 였다:
 *
 * | 브로커 | 프로세스 내 단일화 | **교차 프로세스 락** | 저장소 저장 |
 * |---|---|---|---|
 * | KIS | ✓ | **✓** | ✓ |
 * | toss | ✓ | **✗** | ✓ |
 * | kbsec | ✓ | **✗** | ✓ |
 *
 * `refreshPromise` 는 **같은 프로세스 안**에서만 발급을 하나로 만든다. 프로세스가 둘이면 둘 다
 * 동시에 발급한다. 그게 왜 나쁜지는 브로커마다 다르다:
 *
 * - **토스**: 문서상 *client 당 유효 토큰 1개, 재발급 시 이전 토큰 즉시 무효화*. 두 프로세스가
 * 동시에 만료를 맞으면 **서로의 토큰을 죽이는 핑퐁**이 성립한다.
 * - **KB**: 발급 자체에 빈도 제한이 있고, "잘못된 조회의 과도한 반복" 을 계정 제한 사유로
 * 경고한다.
 * - **KIS**: 토큰 발급이 **분당 1회** 제한이다. 그래서 여기만 락이 있었다.
 *
 * 즉 이 파일은 중복 제거가 아니라 **한 곳에만 있던 장치를 나머지에 주는 것**이고, 주는 김에
 * 공용 구현 하나로 둔다. 세 곳에 각자 쓰면 KIS 에서 나온 결함(폴백 발급이 저장소에 저장되지 않음)이
 * 브로커마다 따로 생긴다. 실제로 그 버그는 **KIS 구현에만** 있었다.
 */

import { logger } from './logger';
import type { BrokerTokenStore } from './options';

/** 락 미획득 시 다른 프로세스의 발급을 기다리는 기본 시간. KIS 구현에서 가져온 값. */
const DEFAULT_WAIT_MS = 1_500;

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
    /** 락 미획득 시 대기 시간(ms). */
    waitMs?: number;
}

/**
 * 교차 프로세스 락을 걸고 토큰을 발급한다.
 *
 * 순서:
 * 1. 저장소가 없으면 그냥 발급한다(단일 프로세스 개발 환경).
 * 2. `SET NX PX` 로 락을 잡으면 발급하고, **자기 락일 때만** 푼다.
 * 3. 못 잡으면 잠깐 기다렸다가 캐시를 다시 본다 — 다른 프로세스가 넣었으면 그걸 쓴다.
 * 4. 그래도 없으면 직접 발급한다(최후 폴백). 이 경로도 `issueAndCache` 를 거치므로
 * **저장이 빠질 수 없다** — KIS 에서 이 경로만 저장을 빠뜨려 다른 프로세스가 계속 재발급하던
 * 결함이 구조적으로 재발하지 않는다.
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

    // 락 미획득 → 다른 프로세스가 발급 중. 짧게 대기 후 캐시 재조회.
    await new Promise(resolve => setTimeout(resolve, params.waitMs ?? DEFAULT_WAIT_MS));
    try {
        const cached = await readCached();
        if (cached !== null) {
            logger.info(`${label} 🤝 다른 프로세스 발급 토큰 사용 (분산 락 협업)`);
            return cached;
        }
    } catch (err) {
        logger.debug({ err }, `${label} 협업 토큰 재조회 실패 — 직접 발급으로 폴백`);
    }

    logger.warn({}, `${label} 분산 락 협업 실패 — 직접 발급 폴백 (발급 빈도 제한 위험)`);
    return issueAndCache();
}
