/**
 * @fileoverview KB증권 OAuth2 토큰 관리
 * @description appKey + appSecret → access_token 발급/갱신/캐시.
 *
 * 토큰 정책:
 * - OAuth2 Client Credentials Grant (POST /oauth2/token)
 * - 요청/응답이 `{ dataHeader, dataBody }` 봉투 — 토큰 발급도 예외가 아니다.
 * - 응답 expires_in(초) 기준 만료 60초 전 자동 재발급 (가이드 예시 86400s)
 * - 인메모리 캐시 + (가용 시) Redis 캐시로 다중 pod 재사용
 *
 * **1차 자료 간 불일치**
 * 포털 개발가이드 페이지는 토큰 요청을 평면 JSON + snake_case(`grant_type`)로,
 * 공식 예제 저장소(github.com/kbsecurities/kb-openapi)는 봉투 + camelCase(`grantType`)로
 * 적고 있다. 실동작 코드인 저장소 쪽을 **1순위**로 시도하고, 400/401 이면 가이드 형태로
 * **1회 폴백**한다 — 어느 쪽이 맞든 실서버에서 자동으로 통과하게 하는 것이 목적이다.
 * (모의투자 서버가 없어 사전 검증이 불가능한 데서 온 방어다.)
 */

import { refreshTokenWithLock } from '../token-refresh-lock';
import { logger } from '../logger';
import type { BrokerTokenStore } from '../options';
import { legacyTokenStoreKey, tokenStoreKey, withLegacyTokenKeys } from '../token-store-key';
import { RequestTimeout } from '../base/errors';
import type { FetchSignal } from '../base/types';


import {
    KBSEC_API_BASE,
    KBSEC_TOKEN_PATH,
    KBSEC_REVOKE_PATH,
    KBSEC_TOKEN_SAFETY_MARGIN_MS,
    KBSEC_TOKEN_DEFAULT_TTL_MS,
    type KBSecCredentials,
    type KBSecCachedToken,
    type KBSecTokenResponse,
    type KBSecResponseEnvelope,
} from './kbsec-types';

/** Redis 키 prefix — appKey 앞 12자리로 분리 캐시(전체 노출 회피). */
const KBSEC_TOKEN_KEY_PREFIX = 'kbsec:token:';

/** 토큰 발급 요청 본문 — 저장소 예제 형태(봉투 + grantType). */
function envelopeBody(creds: KBSecCredentials): unknown {
    return {
        dataHeader: { ipAddr: '', macAddr: '' },
        dataBody: {
            appKey: creds.appKey,
            appSecret: creds.appSecret,
            grantType: 'client_credentials',
        },
    };
}

/** 토큰 발급 요청 본문 — 포털 가이드 형태(평면 + grant_type). 폴백용. */
function flatBody(creds: KBSecCredentials): unknown {
    return {
        grant_type: 'client_credentials',
        appKey: creds.appKey,
        appSecret: creds.appSecret,
    };
}

/**
 * 토큰 발급·폐기 요청의 시간 상한(ms). 조회 상한(20초)보다 짧다. 토큰 요청이 응답 없이 멈추면 그 뒤의 모든 TR 이 같이 멈추기 때문이다
 * (TR 은 `getAccessToken()` 을 기다린 다음에야 나간다). 상한에 걸려도 즉시 재발급을 되풀이하지 않는다. KB 는 발급 빈도를 제한하고 반복
 * 실패를 계정 제한 사유로 든다. 오류는 호출부로 올라가고 다음 요청이 다시 시도한다.
 */
const AUTH_TIMEOUT_MS = 10_000;

/**
 * JSON 을 POST 하고 본문까지 읽는다. 상한에 걸리면 **요청 자체를 끊고**(`AbortSignal`) `RequestTimeout` 을 던진다.
 *
 * 응답 헤더만 오고 본문이 안 오는 경우도 무한정 기다리게 되므로 본문 읽기까지 상한이 덮는다. `Promise.race` 는 전송 계층이 신호를 안 듣는
 * 경우의 백스톱이다. 버려진 promise 의 늦은 실패는 삼켜 `unhandledRejection` 으로 프로세스가 종료되지 않게 한다.
 */
async function postJson(op: string, url: string, body: unknown): Promise<{ res: Response; text: string }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = () => new RequestTimeout(`kbsec ${op} 요청이 ${AUTH_TIMEOUT_MS}ms 안에 끝나지 않았다`);

    const exchange = (async () => {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            // 리다이렉트를 따르면 앱키와 시크릿이 든 본문을 다른 호스트로 다시 보낸다. 3xx 는 `res.ok` 가 거짓이라 실패로 처리된다.
            redirect: 'manual',
            signal: controller.signal as FetchSignal,
        });
        return { res, text: await res.text() };
    })();
    exchange.catch(() => { /* 상한이 먼저 걸렸으면 호출부는 이미 떠났다 */ });

    try {
        return await Promise.race([
            exchange,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                    reject(timeout());
                }, AUTH_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]);
    } catch (err) {
        // 취소가 먼저 걸려 전송 계층이 AbortError 로 실패한 경우도 같은 오류로 통일한다.
        if (timedOut && !(err instanceof RequestTimeout)) throw timeout();
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
        if (timedOut) logger.warn({ op, timeoutMs: AUTH_TIMEOUT_MS }, '[KBSecAuth] 요청 상한 초과 — 요청을 취소했다');
    }
}

/** 토큰 발급 락 TTL — KIS 구현에서 가져온 값. */
const TOKEN_FETCH_LOCK_TTL_MS = 90 * 1000;

/**
 * 토큰 폐기 시도 쿨다운. 장애 중에는 **모든 TR 이** I445 라 실패가 분당 수십 건 발생한다
 * (실측 ≈30건/분). 폐기는 성공하면 한 번으로 족하고, 실패했다면 곧바로 다시 해도
 * 결과가 같다 — 반복은 KB 가 경고하는 "잘못된 조회의 과도한 반복" 만 만든다.
 */
const REVOKE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * JWT 의 `jti` — **토큰 동일성 판정의 정본**.
 *
 * 앞 100자 비교로 판정하지 말 것. 헤더와 payload 앞부분(`sub`·`aud`)이 모든 토큰에서 같아
 * 서로 다른 토큰도 접두가 일치한다(장애 조사에서 실제로 오판한 적이 있다).
 * 형식이 JWT 가 아니거나 `jti` 가 없으면 `null` — 그때는 동일성을 **모르는 것**으로 다룬다.
 */
export function tokenJti(token: string): string | null {
    const payload = token.split('.')[1];
    if (!payload) return null;
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { jti?: unknown };
        return typeof claims.jti === 'string' && claims.jti.length > 0 ? claims.jti : null;
    } catch {
        return null;
    }
}

export class KBSecAuth {
    private credentials: KBSecCredentials;
    private cachedToken: KBSecCachedToken | null = null;
    private refreshPromise: Promise<string> | null = null;
    /** 어느 본문 형태가 통했는지 기억 — 두 번째 발급부터는 폴백 왕복을 생략한다. */
    private workingShape: 'envelope' | 'flat' | null = null;
    /** 마지막 폐기 시도 시각(ms). {@link REVOKE_COOLDOWN_MS} 참조 — 파드 단위로만 제한한다. */
    private lastRevokeAttemptAt = 0;

    /**
     * @param baseUrl API 서버 주소. 생략하면 운영 서버다.
     * @param rawStoreOf 지금 쓸 토큰 저장소를 돌려주는 함수. 저장소가 없으면 `null` 이고, 그러면 프로세스 메모리 캐시만 쓴다.
     */
    constructor(
        credentials: KBSecCredentials,
        readonly baseUrl: string = KBSEC_API_BASE,
        private readonly rawStoreOf: () => BrokerTokenStore | null = () => null,
    ) {
        this.credentials = credentials;
    }

    /** 저장소. 옛 키 형식(앱키 앞 12자)을 쓰는 판과 함께 도는 동안 두 키를 함께 읽고 쓴다. */
    private storeOf(): BrokerTokenStore | null {
        const store = this.rawStoreOf();
        return store === null ? null : withLegacyTokenKeys(store, { [this.storeKey]: legacyTokenStoreKey(KBSEC_TOKEN_KEY_PREFIX, this.credentials.appKey) });
    }

    get appKey(): string {
        return this.credentials.appKey;
    }

    private get storeKey(): string {
        return tokenStoreKey(KBSEC_TOKEN_KEY_PREFIX, this.credentials.appKey);
    }

    /**
     * 유효한 access_token 반환.
     * 우선순위: 인메모리 캐시 → Redis 캐시 → 신규 발급.
     * 같은 프로세스 내 동시 갱신은 refreshPromise 로 단일화한다.
     */
    async getAccessToken(): Promise<string> {
        if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
            return this.cachedToken.accessToken;
        }
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = this.fetchFromRedisOrIssue();
        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    /**
     * 토큰 캐시 강제 초기화 — 인메모리 + Redis 모두. 토큰 실패 시 재시도 **전에** 부른다.
     *
     * `await` 가 계약의 일부다. 종전엔 `void redis.del(...)` 였는데, 그러면 DEL 이 아직
     * 전송되는 중에 재시도가 `getAccessToken()` → Redis 조회를 해서 **방금 무효라고
     * 판정한 그 토큰을 다시 읽어 온다**. 재발급이 일어난 것처럼 보이지만 실제로는
     * 같은 무효 토큰으로 재시도하는 셈이라, 자가복구가 조용히 무효가 된다.
     * KIS·Toss 어댑터는 이미 `async invalidate()` 로 await 한다 — kbsec 만 달랐다.
     */
    async invalidate(failedToken?: string): Promise<void> {
        this.cachedToken = null;
        const store = this.storeOf();
        if (store) {
            try {
                if (failedToken) {
                    // compare-and-delete — 남의 토큰을 지우지 않는다 (구현은 `options.tokenStore` 로 넘기는 토큰 저장소).
                    if (!await store.deleteIfAccessTokenEquals(this.storeKey, failedToken)) {
                        logger.info('[KBSecAuth] 인메모리만 무효화 — Redis 에는 이미 다른(더 새) 토큰이 있다');
                        return;
                    }
                } else {
                    await store.delete(this.storeKey);
                }
            } catch (err) {
                logger.debug({ err }, '[KBSecAuth] Redis 토큰 캐시 삭제 실패 (인메모리 무효화는 완료)');
            }
        }
        logger.info('[KBSecAuth] 토큰 캐시 초기화');
    }


    /**
     * 토큰 실패(I445) 뒤 **실제로 회전시킨다** — 토큰 장애 대응.
     *
     * ## 왜 `invalidate()` 만으로는 안 되나
     *
     * 장애 때 실측: 전날 토큰이 24h 만료돼 I445 가 났고 곧바로 새 토큰이 발급됐는데,
     * **그 새 토큰으로도 모든 TR 이 I445** 였다. 그 뒤 수백 번 재발급을 요청해도 KB 는 **같은
     * 토큰(같은 `jti`)** 만 돌려줬다 — 캐시가 아니라 KB 쪽에서 그렇다(Redis DEL + 파드 재시작
     * 뒤에도 동일, `expiresInSec` 이 경과 시간만큼만 감소). 즉 "하루 한 개" 정책의 활성 토큰이
     * 쓸 수 없는 상태로 고정되면 발급 요청은 영원히 그것을 되돌려주고 자가복구가 성립하지 않는다.
     *
     * ## 그래서
     *
     * 재발급 결과가 **실패한 토큰과 같은 `jti`** 일 때만 `/oauth2/revoke` 로 명시 폐기하고 한 번 더
     * 발급한다. 조건을 이렇게 좁힌 것이 안전장치다 — 재발급이 정상으로 회전하면(대부분의 I445)
     * 폐기를 아예 부르지 않으므로, 멀쩡한 토큰을 폐기해 다른 파드의 연결을 끊을 위험이 없다.
     * 폐기가 실패해도 종전 동작으로 되돌아갈 뿐이다(더 나빠지지 않는다).
     *
     * @param failedToken TR 이 I445 로 거부당할 때 실제로 보냈던 토큰.
     */
    async rotateAfterTokenFailure(failedToken: string): Promise<void> {
        await this.invalidate(failedToken);
        const reissued = await this.getAccessToken();
        if (tokenJti(reissued) === null || tokenJti(reissued) !== tokenJti(failedToken)) {
            return;   // 정상 회전 — 폐기할 이유가 없다.
        }

        // 쿨다운이 없으면 안 된다. 이 상태에서는 **모든 TR 이** I445 라 실패가 분당 30건씩
        // 발생하고(실측), 그때마다 폐기를 부르면 KB 가 경고하는 "잘못된 조회의
        // 과도한 반복" 을 이 코드가 일으킨다. 폐기는 성공해도 한 번이면 족하다.
        const now = Date.now();
        if (now - this.lastRevokeAttemptAt < REVOKE_COOLDOWN_MS) {
            logger.debug(
                { sinceMs: now - this.lastRevokeAttemptAt },
                '[KBSecAuth] 폐기 쿨다운 중 — 이번 실패는 종전 동작으로',
            );
            return;
        }
        this.lastRevokeAttemptAt = now;

        logger.warn(
            { jti: tokenJti(failedToken) },
            '[KBSecAuth] 재발급이 같은 토큰을 돌려줬다 — 명시 폐기 후 재발급',
        );
        const revoked = await this.revokeToken(failedToken);
        if (!revoked) return;   // 폐기 실패 — 종전 동작 유지.

        // 폐기 뒤에는 **무조건** 지운다 — KB 에서 폐기된 토큰이라 누가 갖고 있든 쓸 수 없다.
        await this.invalidate();
        const fresh = await this.getAccessToken();
        logger.info(
            { rotated: tokenJti(fresh) !== tokenJti(failedToken), jti: tokenJti(fresh) },
            '[KBSecAuth] 폐기 후 재발급 완료',
        );
    }

    /**
     * `/oauth2/revoke` 호출. 성공 = `processFlag: 'A'`.
     *
     * 본문 필드 이름이 공식 문서에 없어 **후보를 순서대로 시도**하고 성공한 형태를 로그로 남긴다
     * (`issueToken` 의 envelope/flat 폴백과 같은 수법). 확정되면 후보를 하나로 줄일 것.
     */
    private async revokeToken(token: string): Promise<boolean> {
        const candidates: Array<[string, Record<string, unknown>]> = [
            ['token', { appKey: this.credentials.appKey, appSecret: this.credentials.appSecret, token }],
            ['accessToken', { appKey: this.credentials.appKey, appSecret: this.credentials.appSecret, accessToken: token }],
            ['access_token', { appKey: this.credentials.appKey, appSecret: this.credentials.appSecret, access_token: token }],
        ];
        for (const [label, dataBody] of candidates) {
            try {
                // 요청 시간 상한 — 폐기가 응답 없이 멈추면 회전 경로 전체가 멈춘다.
                // 상한에 걸리면 다음 후보 형태로 넘어간다(아래 catch).
                const { res, text } = await postJson(
                    `oauth2/revoke:${label}`,
                    `${this.baseUrl}${KBSEC_REVOKE_PATH}`,
                    { dataHeader: { ipAddr: '', macAddr: '' }, dataBody },
                );
                const flag = (JSON.parse(text) as KBSecResponseEnvelope<unknown>)?.dataHeader?.processFlag;
                if (flag === 'A') {
                    logger.info({ shape: label }, '[KBSecAuth] 토큰 폐기 성공');
                    return true;
                }
                logger.debug({ shape: label, status: res.status, body: text.slice(0, 200) }, '[KBSecAuth] 토큰 폐기 실패 — 다음 형태 시도');
            } catch (err) {
                logger.debug({ err, shape: label }, '[KBSecAuth] 토큰 폐기 요청 오류 — 다음 형태 시도');
            }
        }
        logger.warn({ shapes: candidates.map(([label]) => label) }, '[KBSecAuth] 토큰 폐기 — 시도한 본문 형태 전부 실패');
        return false;
    }

    /**
     * Redis 캐시 → 없으면 **교차 pod 락**을 걸고 발급.
     *
     * 종전엔 `refreshPromise`(프로세스 내 단일화)뿐이라 **pod 가 둘이면 둘 다 발급**했다.
     * KB 는 발급 빈도 제한이 있고 "잘못된 조회의 과도한 반복" 을 계정 제한 사유로 경고한다.
     * KIS 에만 있던 락을 공용 모듈로 분리해 여기에도 건다.
     *
     * 저장은 `requestToken` 안에서 이미 await 로 한다 — 그래서 `issueAndCache` 가 곧 발급이다.
     */
    private async fetchFromRedisOrIssue(): Promise<string> {
        const cached = await this.readCachedToken();
        if (cached !== null) return cached;

        return refreshTokenWithLock<string>({
            label: '[KBSecAuth]',
            store: this.storeOf(),
            storeKey: this.storeKey,
            lockTtlMs: TOKEN_FETCH_LOCK_TTL_MS,
            readCached: () => this.readCachedToken(),
            issueAndCache: () => this.issueToken(),
        });
    }

    /** Redis 캐시의 **유효한** 토큰. 없거나 만료면 null. */
    private async readCachedToken(): Promise<string | null> {
        const store = this.storeOf();
        if (!store) return null;
        try {
            const raw = await store.get(this.storeKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as KBSecCachedToken;
            if (parsed.expiresAt <= Date.now()) return null;
            this.cachedToken = parsed;
            return parsed.accessToken;
        } catch (err) {
            logger.debug({ err }, '[KBSecAuth] Redis 토큰 캐시 조회 실패 — 신규 발급');
            return null;
        }
    }

    private async issueToken(): Promise<string> {
        const shapes: Array<'envelope' | 'flat'> = this.workingShape
            ? [this.workingShape]
            : ['envelope', 'flat'];

        // 형태별 오류를 **전부** 모은다. 종전엔 마지막 시도의 오류만 던졌는데, 폴백 순서상
        // 그건 언제나 `flat` 이다. flat 은 문서가 "틀린 형태"로 확정한 쪽이라 서버가 늘
        // `E021 앱키로 앱정보 추출 중 오류` 를 준다 — 즉 **원인과 무관한 "키가 이상하다"는
        // 메시지가 최종 오류로 올라와** 진짜 원인(envelope 응답)이 가려졌다.
        // 이것 때문에 멀쩡한 키를 무효로 오진한 적이 있다.
        const failures: string[] = [];
        for (const shape of shapes) {
            try {
                const token = await this.requestToken(shape);
                this.workingShape = shape;
                return token;
            } catch (err) {
                failures.push(`${shape}: ${String(err)}`);
                logger.warn(
                    { shape, err: String(err) },
                    '[KBSecAuth] 토큰 발급 실패 — 다른 본문 형태로 재시도',
                );
            }
        }
        // 정답 형태(envelope)가 앞에 오므로 목록 순서 그대로가 곧 진단 우선순위다.
        throw new Error(`[KBSecAuth] 토큰 발급 실패 — 시도한 본문 형태 전부 실패\n  ${failures.join('\n  ')}`);
    }

    private async requestToken(shape: 'envelope' | 'flat'): Promise<string> {
        const body = shape === 'envelope' ? envelopeBody(this.credentials) : flatBody(this.credentials);
        // 요청 시간 상한 — 여기서 응답 없이 멈추면 **그 뒤의 모든 TR 이 같이 멈춘다**
        // (TR 은 getAccessToken() 을 await 한 다음에야 나간다). 상한에 걸려도 즉시 재발급
        // 루프를 만들지 않는다: KB 는 발급 빈도 제한이 있고 반복 실패를 계정 제한 사유로 든다.
        const { res, text } = await postJson(`oauth2/token:${shape}`, `${this.baseUrl}${KBSEC_TOKEN_PATH}`, body);

        if (!res.ok) {
            throw new Error(`KB증권 토큰 발급 오류: ${res.status} ${text.slice(0, 300)}`);
        }

        let parsed: KBSecResponseEnvelope<KBSecTokenResponse> & KBSecTokenResponse;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error(`KB증권 토큰 응답이 JSON 이 아님: ${text.slice(0, 200)}`);
        }

        // 봉투 응답(dataBody.access_token)과 평면 응답(access_token) 모두 수용.
        const payload: KBSecTokenResponse = parsed.dataBody ?? parsed;
        const accessToken = payload.access_token ?? payload.accessToken;
        if (!accessToken) {
            throw new Error(`KB증권 토큰 응답에 access_token 없음: ${text.slice(0, 200)}`);
        }

        const ttlMs = typeof payload.expires_in === 'number' && payload.expires_in > 0
            ? payload.expires_in * 1000
            : KBSEC_TOKEN_DEFAULT_TTL_MS;
        const expiresAt = Date.now() + Math.max(0, ttlMs - KBSEC_TOKEN_SAFETY_MARGIN_MS);

        this.cachedToken = { accessToken, expiresAt };

        // Redis 쓰기도 await 한다. fire-and-forget 이면 동시 발급 경합에서 쓰기 순서가
        // 보장되지 않아 **더 오래된 토큰이 캐시에 남을 수 있다**. KIS·Toss 와 동일.
        const store = this.storeOf();
        const ttlSec = Math.floor((expiresAt - Date.now()) / 1000);
        if (store && ttlSec > 0) {
            // 남은 수명이 0 이하면 쓰지 않는다 — KB 가 `expires_in` 을 3초·1초로 주는 응답이
            // 실제로 관측됐다. 그걸 최소 1초로 끌어올려 저장하면 다른 파드가
            // 곧바로 만료될 토큰을 가져다 쓴다. 캐시 미스가 재발급보다 싸다.
            try {
                await store.set(this.storeKey, JSON.stringify(this.cachedToken), ttlSec * 1000);
            } catch (err) {
                logger.warn({ err }, '[KBSecAuth] Redis 토큰 저장 실패 (인메모리 캐시는 유효)');
            }
        }

        logger.info(
            { shape, expiresInSec: Math.floor(ttlMs / 1000) },
            '[KBSecAuth] ✅ 접근 토큰 발급 완료',
        );
        return accessToken;
    }
}
