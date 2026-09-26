/**
 * @fileoverview KIS 접근 토큰과 실시간 접속키(approval_key)의 캐시.
 *
 * KIS 토큰 정책:
 * - 유효기간은 24시간이고, 발급은 분당 1회로 제한된다.
 * - 6시간 안에 다시 발급하면 기존 토큰을 돌려준다.
 *
 * 그래서 발급 전에 프로세스 메모리 → 토큰 저장소(`BrokerTokenStore`) 순서로 유효한 토큰을 찾고, 없으면 여러 프로세스가 동시에 발급하지 않도록
 * 저장소 락을 잡고 한 곳만 발급한다(`token-refresh-lock.ts`). 이 모듈은 발급 요청 자체를 보내지 않는다. 요청은 `kis` 클래스가
 * `fetch` 파이프라인으로 보내고, 그 함수를 `KisTokenSource` 로 넘겨 준다.
 */

import { refreshTokenWithLock } from '../token-refresh-lock';
import { logger } from '../logger';
import type { BrokerTokenStore } from '../options';
import { tokenStoreKey } from '../token-store-key';
import {
    KIS_TOKEN_EXPIRY_MS,
    KIS_TOKEN_SAFETY_MARGIN_MS,
    KIS_TOKEN_MIN_LIFETIME_MS,
    type KisCachedToken,
} from './kis-types';

/** 토큰 저장소 키의 접두사. 키 본체는 앱키의 해시다(`tokenStoreKey`). */
const KIS_TOKEN_KEY_PREFIX = 'kis:token:';
const KIS_APPROVAL_KEY_PREFIX = 'kis:approval:';

/** 저장소 락 TTL(ms). 토큰 발급 빈도 제한(1분)보다 길게 잡아 락이 풀린 뒤 다시 시도해도 안전하게 한다. */
const TOKEN_FETCH_LOCK_TTL_MS = 90 * 1000;

/** 저장소에 넣을 때 만료 직전에 꺼내 쓰지 않도록 TTL 에서 빼는 여유. */
const STORE_TTL_MARGIN_MS = 60_000;

/** 발급 요청을 보내는 쪽. `kis` 클래스가 자기 `fetch` 로 구현한다. */
export interface KisTokenSource {
    /** 접근 토큰을 발급한다. 서버가 준 유효 시간(초)이 있으면 함께 돌려준다. */
    requestToken(): Promise<{ accessToken: string; expiresInSec?: number | undefined }>;
    /** 실시간 접속키를 발급한다. */
    requestApprovalKey(): Promise<string>;
}

/**
 * 캐시 수명(ms). 서버가 준 `expires_in` 이 정본이다.
 *
 * 사양의 24시간을 코드에 그대로 옮긴 값만 쓰면 서버가 수명을 줄이거나 토큰이 일찍 무효가 됐을 때 이 코드만 아직 유효하다고 믿게 된다.
 * 마진을 빼서 음수가 되면 갱신 요청이 몰리므로 하한을 둔다. 서버 값이 없거나 이상하면 사양의 24시간에서 마진을 뺀 값을 쓴다.
 */
function resolveTokenLifetimeMs(expiresInSec: unknown): number {
    const sec = Number(expiresInSec);
    if (!Number.isFinite(sec) || sec <= 0) return KIS_TOKEN_EXPIRY_MS;
    const withMargin = sec * 1000 - KIS_TOKEN_SAFETY_MARGIN_MS;
    if (withMargin < KIS_TOKEN_MIN_LIFETIME_MS) {
        logger.warn({ expiresInSec: sec }, '[KISAuth] 서버 토큰 수명이 안전 마진보다 짧다 — 하한 적용');
        return KIS_TOKEN_MIN_LIFETIME_MS;
    }
    return withMargin;
}

export class KisAuth {
    private cachedToken: KisCachedToken | null = null;
    private refreshPromise: Promise<string> | null = null;
    private cachedApprovalKey: { key: string; expiresAt: number } | null = null;
    private approvalPromise: Promise<string> | null = null;

    /**
     * @param appKey 저장소 키를 만드는 데 쓴다.
     * @param source 발급 요청을 보내는 쪽.
     * @param storeOf 지금 쓸 토큰 저장소를 돌려주는 함수. 저장소가 없으면 `null` 이고, 그러면 프로세스 메모리 캐시만 쓴다.
     */
    constructor(
        private readonly appKey: string,
        private readonly source: KisTokenSource,
        private readonly storeOf: () => BrokerTokenStore | null = () => null,
    ) {}

    private get storeKey(): string {
        return tokenStoreKey(KIS_TOKEN_KEY_PREFIX, this.appKey);
    }

    private get approvalStoreKey(): string {
        return tokenStoreKey(KIS_APPROVAL_KEY_PREFIX, this.appKey);
    }

    /**
     * 유효한 접근 토큰. 프로세스 메모리 → 토큰 저장소 → 신규 발급 순서로 찾는다. 같은 프로세스의 동시 호출은 한 번의 발급으로 합치고,
     * 여러 프로세스의 동시 발급은 저장소 락으로 막는다.
     */
    async getAccessToken(): Promise<string> {
        if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) return this.cachedToken.accessToken;
        if (this.refreshPromise) return this.refreshPromise;

        this.refreshPromise = this.fetchTokenFromStoreOrIssue();
        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    /** 저장소에 유효한 토큰이 있으면 쓰고, 없으면 락을 잡고 발급한다. 락 안의 폴백 발급도 저장까지 마친다. */
    private async fetchTokenFromStoreOrIssue(): Promise<string> {
        const cached = await this.readCachedToken();
        if (cached !== null) return cached;

        return refreshTokenWithLock<string>({
            label: '[KISAuth]',
            store: this.storeOf(),
            storeKey: this.storeKey,
            lockTtlMs: TOKEN_FETCH_LOCK_TTL_MS,
            readCached: () => this.readCachedToken(),
            issueAndCache: async () => {
                const token = await this.issueTokenAndCacheLocal();
                const store = this.storeOf();
                if (store) await this.saveTokenToStore(store);
                return token;
            },
        });
    }

    /** 저장소의 유효한 토큰. 없거나 만료면 `null`. */
    private async readCachedToken(): Promise<string | null> {
        const store = this.storeOf();
        if (!store) return null;
        try {
            const raw = await store.get(this.storeKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as KisCachedToken;
            if (parsed.expiresAt <= Date.now()) return null;
            this.cachedToken = parsed;
            logger.debug({ expiresAt: new Date(parsed.expiresAt).toISOString() }, '[KISAuth] 저장소에서 토큰 복원');
            return parsed.accessToken;
        } catch (err) {
            logger.warn({ err }, '[KISAuth] 토큰 저장소 조회 실패 — 신규 발급 폴백');
            return null;
        }
    }

    /** 토큰을 발급해 프로세스 메모리에 둔다. 저장소에는 호출하는 쪽이 넣는다. */
    private async issueTokenAndCacheLocal(): Promise<string> {
        logger.info('[KISAuth] 접근 토큰 발급 요청...');
        const issued = await this.source.requestToken();
        this.cachedToken = {
            accessToken: issued.accessToken,
            expiresAt: Date.now() + resolveTokenLifetimeMs(issued.expiresInSec),
        };
        logger.info({
            expiresIn: issued.expiresInSec,
            expiresAt: new Date(this.cachedToken.expiresAt).toISOString(),
        }, '[KISAuth] 접근 토큰 발급 완료');
        return issued.accessToken;
    }

    /** 저장소에 토큰을 넣는다. TTL 은 토큰 만료까지 남은 시간에서 여유를 뺀 값이다. */
    private async saveTokenToStore(store: BrokerTokenStore): Promise<void> {
        if (!this.cachedToken) return;
        try {
            const ttlMs = this.cachedToken.expiresAt - Date.now() - STORE_TTL_MARGIN_MS;
            if (ttlMs <= 0) return;
            await store.set(this.storeKey, JSON.stringify(this.cachedToken), ttlMs);
        } catch (err) {
            logger.warn({ err }, '[KISAuth] 토큰 저장소 저장 실패 (무시 — 프로세스 메모리 캐시는 유효)');
        }
    }

    /**
     * 실시간 접속용 approval_key. 접근 토큰과 따로 발급되는 세션 키이고 24시간쯤 유효하다. 프로세스 메모리와 토큰 저장소에 둔다.
     */
    async getApprovalKey(): Promise<string> {
        if (this.cachedApprovalKey && this.cachedApprovalKey.expiresAt > Date.now()) return this.cachedApprovalKey.key;
        if (this.approvalPromise) return this.approvalPromise;
        this.approvalPromise = this.fetchApprovalKey();
        try {
            return await this.approvalPromise;
        } finally {
            this.approvalPromise = null;
        }
    }

    private async fetchApprovalKey(): Promise<string> {
        const store = this.storeOf();
        if (store) {
            try {
                const raw = await store.get(this.approvalStoreKey);
                if (raw) {
                    const parsed = JSON.parse(raw) as { key: string; expiresAt: number };
                    if (parsed.expiresAt > Date.now()) {
                        this.cachedApprovalKey = parsed;
                        return parsed.key;
                    }
                }
            } catch (err) {
                logger.warn({ err }, '[KISAuth] approval_key 저장소 조회 실패 — 신규 발급');
            }
        }

        logger.info('[KISAuth] 실시간 접속키(approval_key) 발급 요청...');
        const key = await this.source.requestApprovalKey();
        this.cachedApprovalKey = { key, expiresAt: Date.now() + KIS_TOKEN_EXPIRY_MS };
        if (store) {
            try {
                const ttlMs = KIS_TOKEN_EXPIRY_MS - STORE_TTL_MARGIN_MS;
                if (ttlMs > 0) await store.set(this.approvalStoreKey, JSON.stringify(this.cachedApprovalKey), ttlMs);
            } catch (err) {
                logger.warn({ err }, '[KISAuth] approval_key 저장소 저장 실패 (프로세스 메모리 캐시는 유효)');
            }
        }
        logger.info('[KISAuth] 실시간 접속키 발급 완료');
        return key;
    }

    /** 토큰 캐시를 프로세스 메모리와 저장소에서 모두 지운다. 다음 호출이 새 토큰을 발급받는다. */
    async invalidate(): Promise<void> {
        this.cachedToken = null;
        const store = this.storeOf();
        if (store) {
            try {
                await store.delete(this.storeKey);
            } catch (err) {
                logger.debug({ err }, '[KISAuth] 토큰 저장소 삭제 실패 (프로세스 메모리 무효화는 완료)');
            }
        }
        logger.info('[KISAuth] 토큰 캐시 초기화');
    }
}
