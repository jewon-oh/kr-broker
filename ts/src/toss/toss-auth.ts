/**
 * @fileoverview 토스증권 OAuth2 토큰의 캐시와 발급 조정.
 *
 * 토큰 발급 요청 자체는 `toss` 클래스가 다른 요청과 같은 경로(`fetch2`)로 보낸다. 이 모듈은 발급한 토큰을 어디에 두고 언제 다시 받을지를 맡는다.
 *
 * - 응답의 `expires_in`(초)에서 안전 여유를 뺀 시각까지 프로세스 메모리에 둔다.
 * - 토큰 저장소(`options.tokenStore`)가 있으면 여러 프로세스가 같은 토큰을 나눠 쓴다.
 * - 토스는 클라이언트 하나에 유효한 토큰이 하나뿐이고 새로 발급하면 이전 토큰이 즉시 무효가 된다. 프로세스 둘이 동시에 발급하면 서로의 토큰을
 *   무효로 만드는 왕복이 시작되므로, 발급은 저장소의 락으로 한 번에 하나만 한다.
 */

import { refreshTokenWithLock } from '../token-refresh-lock';
import { logger } from '../logger';
import type { BrokerTokenStore } from '../options';
import { legacyTokenStoreKey, tokenStoreKey, withLegacyTokenKeys } from '../token-store-key';

/** 토큰 저장소 키의 접두사. 클라이언트 ID 앞 12자리로 구분해 전체 ID 가 저장소에 남지 않게 한다. */
const TOKEN_KEY_PREFIX = 'toss:token:';

/** 만료 직전에 요청이 나가지 않도록 앞당기는 시간. */
export const TOSS_TOKEN_SAFETY_MARGIN_MS = 60_000;

/** 응답에 `expires_in` 이 없을 때 쓰는 유효 시간(공식 예시는 86400초). */
export const TOSS_TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** 발급 락의 유효 시간. 발급이 이보다 오래 걸리면 다른 프로세스가 들어온다. */
const TOKEN_FETCH_LOCK_TTL_MS = 90_000;

/** 토큰 발급 응답에서 필요한 값. */
export interface TossIssuedToken {
    accessToken: string;
    /** 유효 시간(초). 없거나 0 이하면 기본값을 쓴다. */
    expiresInSeconds?: number | undefined;
    tokenType?: string | undefined;
}

interface CachedToken {
    accessToken: string;
    expiresAt: number;
}

export class TossAuth {
    private cachedToken: CachedToken | null = null;
    private refreshPromise: Promise<string> | null = null;

    /**
     * @param clientId 저장소 키를 만드는 데 쓴다.
     * @param issue 토큰을 새로 발급받는 함수. 실패하면 던진다.
     * @param rawStoreOf 지금 쓸 토큰 저장소를 돌려주는 함수. 저장소가 없으면 `null` 이고, 그러면 프로세스 메모리 캐시만 쓴다.
     */
    constructor(
        private readonly clientId: string,
        private readonly issue: () => Promise<TossIssuedToken>,
        private readonly rawStoreOf: () => BrokerTokenStore | null = () => null,
    ) {}

    private get storeKey(): string {
        return tokenStoreKey(TOKEN_KEY_PREFIX, this.clientId);
    }

    /** 저장소. 옛 키 형식(클라이언트 ID 앞 12자)을 쓰는 판과 함께 도는 동안 두 키를 함께 읽고 쓴다. */
    private storeOf(): BrokerTokenStore | null {
        const store = this.rawStoreOf();
        return store === null ? null : withLegacyTokenKeys(store, { [this.storeKey]: legacyTokenStoreKey(TOKEN_KEY_PREFIX, this.clientId) });
    }

    /**
     * 유효한 액세스 토큰. 메모리 캐시, 토큰 저장소, 새 발급 순으로 찾는다.
     * 같은 프로세스 안의 동시 갱신은 하나로 합친다.
     */
    async getAccessToken(): Promise<string> {
        if (this.cachedToken !== null && this.cachedToken.expiresAt > Date.now()) {
            return this.cachedToken.accessToken;
        }
        if (this.refreshPromise !== null) return this.refreshPromise;
        this.refreshPromise = this.readStoreOrIssue();
        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    /** 저장소에 유효한 토큰이 있으면 그것을 쓰고, 없으면 락을 잡고 발급한다. */
    private async readStoreOrIssue(): Promise<string> {
        const cached = await this.readStoredToken();
        if (cached !== null) return cached;

        return refreshTokenWithLock<string>({
            label: '[toss]',
            store: this.storeOf(),
            storeKey: this.storeKey,
            lockTtlMs: TOKEN_FETCH_LOCK_TTL_MS,
            readCached: () => this.readStoredToken(),
            // 락을 잡은 뒤 저장소를 다시 읽는 단계는 `refreshTokenWithLock` 이 한다.
            issueAndCache: async () => {
                const token = await this.issueToken();
                const store = this.storeOf();
                if (store !== null) await this.saveToStore(store);
                return token;
            },
        });
    }

    /** 저장소에 있는 유효한 토큰. 없거나 만료됐으면 `null`. */
    private async readStoredToken(): Promise<string | null> {
        const store = this.storeOf();
        if (store === null) return null;
        try {
            const raw = await store.get(this.storeKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as CachedToken;
            if (parsed.expiresAt <= Date.now()) return null;
            this.cachedToken = parsed;
            logger.debug({ expiresAt: new Date(parsed.expiresAt).toISOString() }, '[toss] 저장소에서 토큰을 가져왔다');
            return parsed.accessToken;
        } catch (err) {
            logger.warn({ err }, '[toss] 토큰 저장소 조회에 실패해 새로 발급한다');
            return null;
        }
    }

    /** 토큰을 새로 발급해 메모리에 둔다. */
    private async issueToken(): Promise<string> {
        logger.info('[toss] 접근 토큰을 발급한다');
        const issued = await this.issue();
        if (!issued.accessToken) throw new Error('토스 토큰 응답에 access_token 이 없다');
        const ttlMs = issued.expiresInSeconds !== undefined && issued.expiresInSeconds > 0
            ? issued.expiresInSeconds * 1000
            : TOSS_TOKEN_DEFAULT_TTL_MS;
        this.cachedToken = {
            accessToken: issued.accessToken,
            expiresAt: Date.now() + ttlMs - TOSS_TOKEN_SAFETY_MARGIN_MS,
        };
        logger.info({ tokenType: issued.tokenType, expiresIn: issued.expiresInSeconds }, '[toss] 접근 토큰을 발급했다');
        return issued.accessToken;
    }

    /** 메모리에 있는 토큰을 저장소에 넣는다(만료까지 남은 시간 동안). */
    private async saveToStore(store: BrokerTokenStore): Promise<void> {
        if (this.cachedToken === null) return;
        try {
            const ttlMs = this.cachedToken.expiresAt - Date.now();
            if (ttlMs <= 0) return;
            await store.set(this.storeKey, JSON.stringify(this.cachedToken), ttlMs);
        } catch (err) {
            logger.warn({ err }, '[toss] 토큰을 저장소에 넣지 못했다(메모리 캐시는 유효하다)');
        }
    }

    /**
     * 토큰 캐시를 비운다(메모리와 저장소).
     *
     * `failedToken` 을 주면 그 토큰이 캐시에 그대로 있을 때만 지운다. 토스는 클라이언트당 유효 토큰이 하나라서 401 은
     * "내 토큰이 다른 프로세스의 새 발급으로 이미 무효가 됐다"는 뜻일 수 있고, 그때 저장소에는 그 프로세스가 방금 넣은 유효한 새 토큰이 있다.
     * 무조건 지우면 또 발급하게 되고, 그 발급이 상대의 토큰을 다시 무효로 만들어 프로세스끼리 401, 삭제, 재발급을 되풀이한다.
     * 인자 없이 부르면 무조건 지운다(강제 재인증).
     */
    async invalidate(failedToken?: string): Promise<void> {
        const force = failedToken === undefined;
        if (force || this.cachedToken?.accessToken === failedToken) {
            this.cachedToken = null;
        }
        const store = this.storeOf();
        let storeKept = false;
        if (store !== null) {
            try {
                // 읽고 따로 지우면 그사이 다른 프로세스가 넣은 새 토큰을 지운다. 같은 토큰일 때만 지우는 원자적 삭제를 쓴다.
                if (force) await store.delete(this.storeKey);
                else storeKept = !await store.deleteIfAccessTokenEquals(this.storeKey, failedToken);
            } catch (err) {
                logger.debug({ err }, '[toss] 저장소의 토큰을 지우지 못했다(메모리 캐시는 비웠다)');
            }
        }
        if (storeKept) {
            logger.info('[toss] 401 을 받은 토큰이 이미 다른 토큰으로 바뀌어 있어 저장소의 새 토큰을 유지한다');
        } else {
            logger.info('[toss] 토큰 캐시를 비웠다');
        }
    }
}
