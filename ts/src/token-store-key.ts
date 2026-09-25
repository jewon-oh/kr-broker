/**
 * @fileoverview 토큰 저장소 키. 자격증명 원문 대신 해시를 키로 쓴다.
 */
import { createHash } from 'node:crypto';
import type { BrokerTokenStore } from './options';

/** 토큰 저장소 키. 자격증명의 SHA-256 앞 32자(128비트)를 쓴다. 원문이 저장소에 드러나지 않고 다른 계정과 키가 겹치지 않는다. */
export function tokenStoreKey(prefix: string, credentialId: string): string {
    return `${prefix}${createHash('sha256').update(credentialId).digest('hex').slice(0, 32)}`;
}

/** 옛 키 형식(자격증명 앞 12자). 앞 12자가 같은 두 계정이 키를 나눠 썼다. 이행 기간에만 읽고 쓴다. */
export function legacyTokenStoreKey(prefix: string, credentialId: string): string {
    return `${prefix}${credentialId.slice(0, 12)}`;
}

/**
 * 키 형식을 바꾸는 판의 이행용 저장소. 옛 판 프로세스와 함께 도는 동안(롤링 배포) 서로 "토큰 없음"으로 보고 새로 발급하지 않게 한다.
 * 토스는 새 발급이 직전 토큰을 무효로 만들어서 두 판이 번갈아 발급하면 401 이 되풀이된다.
 *
 * - 읽기는 새 키에 없으면 옛 키에서 읽는다.
 * - 쓰기와 삭제는 두 키에 모두 한다.
 * - 발급 락은 옛 키로 잡는다. 옛 판과 같은 락을 써야 동시 발급이 막힌다.
 *
 * `legacyOf` 는 새 키 → 옛 키 대응표다. 표에 없는 키는 그대로 넘긴다. 다음 판에서 이 어댑터를 걷어낸다.
 */
export function withLegacyTokenKeys(store: BrokerTokenStore, legacyOf: Readonly<Record<string, string>>): BrokerTokenStore {
    const legacy = (key: string): string | undefined => (Object.prototype.hasOwnProperty.call(legacyOf, key) ? legacyOf[key] : undefined);
    const lockKeyOf = (key: string): string => {
        const suffix = ':lock';
        const old = key.endsWith(suffix) ? legacy(key.slice(0, -suffix.length)) : undefined;
        return old === undefined ? key : `${old}${suffix}`;
    };
    return {
        async get(key) {
            const value = await store.get(key);
            const old = legacy(key);
            return value !== null && value !== undefined || old === undefined ? value : store.get(old);
        },
        async set(key, value, ttlMs) {
            await store.set(key, value, ttlMs);
            const old = legacy(key);
            if (old !== undefined) await store.set(old, value, ttlMs);
        },
        async delete(key) {
            await store.delete(key);
            const old = legacy(key);
            if (old !== undefined) await store.delete(old);
        },
        async deleteIfAccessTokenEquals(key, accessToken) {
            const current = await store.deleteIfAccessTokenEquals(key, accessToken);
            const old = legacy(key);
            const previous = old !== undefined ? await store.deleteIfAccessTokenEquals(old, accessToken) : false;
            return current || previous;
        },
        tryLock: (key, owner, ttlMs) => store.tryLock(lockKeyOf(key), owner, ttlMs),
        unlock: (key, owner) => store.unlock(lockKeyOf(key), owner),
    };
}
