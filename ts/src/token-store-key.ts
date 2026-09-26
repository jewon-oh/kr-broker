/**
 * @fileoverview 토큰 저장소 키. 자격증명 원문 대신 해시를 키로 쓴다.
 */
import { createHash } from 'node:crypto';

/** 토큰 저장소 키. 자격증명의 SHA-256 앞 32자(128비트)를 쓴다. 원문이 저장소에 드러나지 않고 다른 계정과 키가 겹치지 않는다. */
export function tokenStoreKey(prefix: string, credentialId: string): string {
    return `${prefix}${createHash('sha256').update(credentialId).digest('hex').slice(0, 32)}`;
}
