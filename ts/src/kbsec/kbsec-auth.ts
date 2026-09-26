/**
 * @fileoverview KB증권 OAuth2 토큰 관리
 * @description appKey + appSecret → access_token 발급/갱신/캐시.
 *
 * 토큰 정책:
 * - OAuth2 Client Credentials Grant (POST /oauth2/token)
 * - 요청/응답이 `{ dataHeader, dataBody }` 봉투 — 토큰 발급도 예외가 아니다.
 * - 응답 expires_in(초) 기준 만료 60초 전 자동 재발급 (가이드 예시 86400s)
 * - 프로세스 메모리 캐시. 토큰 저장소(`options.tokenStore`)가 있으면 여러 프로세스가 토큰을 나눠 쓴다.
 *
 * **1차 자료 간 불일치**
 * 포털 개발가이드 페이지는 토큰 요청을 평면 JSON + snake_case(`grant_type`)로,
 * 공식 예제 저장소(github.com/kbsecurities/kb-openapi)는 봉투 + camelCase(`grantType`)로
 * 적고 있다. 저장소 쪽 형태를 먼저 보내고, 실패하면 오류 종류와 관계없이 가이드 형태로
 * **1회 폴백**한다. 통한 형태는 인스턴스가 기억한다.
 */

import { refreshTokenWithLock } from '../token-refresh-lock';
import { logger } from '../logger';
import type { BrokerTokenStore } from '../options';
import { tokenStoreKey } from '../token-store-key';
import { AuthenticationError, BaseError, ExchangeNotAvailable, NetworkError, RateLimitExceeded, RequestTimeout } from '../base/errors';
import type { FetchSignal } from '../base/types';
import { isKbsecBusinessError, type KbsecResponseHeader } from './kbsec-envelope';


import {
    KBSEC_API_BASE,
    KBSEC_TOKEN_PATH,
    KBSEC_REVOKE_PATH,
    KBSEC_TOKEN_SAFETY_MARGIN_MS,
    KBSEC_TOKEN_DEFAULT_TTL_MS,
    type KbsecCredentials,
    type KbsecCachedToken,
    type KbsecTokenResponse,
    type KbsecResponseEnvelope,
} from './kbsec-types';

/** 토큰 저장소 키 접두사. 뒤에 앱키의 해시가 붙는다(`tokenStoreKey`). */
const KBSEC_TOKEN_KEY_PREFIX = 'kbsec:token:';

/** 토큰 발급 요청 본문 — 저장소 예제 형태(봉투 + grantType). */
function envelopeBody(creds: KbsecCredentials): unknown {
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
function flatBody(creds: KbsecCredentials): unknown {
    return {
        grant_type: 'client_credentials',
        appKey: creds.appKey,
        appSecret: creds.appSecret,
    };
}

/** KB 봉투(`dataHeader.processCode`)의 업무 코드. JSON 이 아니거나 코드가 비었으면 `undefined` 다. */
function kbsecProcessCodeOf(text: string): string | undefined {
    try {
        const code = (JSON.parse(text) as KbsecResponseEnvelope<unknown>)?.dataHeader?.processCode;
        return typeof code === 'string' && code.trim() !== '' ? code : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 토큰 발급·폐기 요청의 시간 상한(ms). 조회 상한(20초)보다 짧다. 토큰 요청이 응답 없이 멈추면 그 뒤의 모든 TR 이 같이 멈추기 때문이다
 * (TR 은 `getAccessToken()` 을 기다린 다음에야 나간다). 상한에 걸려도 즉시 재발급을 되풀이하지 않는다. KB 는 발급 빈도를 제한하고 반복
 * 실패를 계정 제한 사유로 든다. 오류는 호출부로 올라가고 다음 요청이 다시 시도한다.
 */
const AUTH_TIMEOUT_MS = 10_000;

/**
 * JSON 을 POST 하고 본문까지 읽는다. 상한에 걸리면 **요청 자체를 끊고**(`AbortSignal`) `RequestTimeout` 을 던진다.
 * 연결 실패는 `NetworkError` 로 던진다. 전송 계층의 `TypeError` 를 그대로 올리면 호출부가 자격증명 오류(`AuthenticationError`)로 감싼다.
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
        if (err instanceof BaseError) throw err;
        throw new NetworkError(`kbsec ${op} 요청 실패: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
        if (timer) clearTimeout(timer);
        if (timedOut) logger.warn({ op, timeoutMs: AUTH_TIMEOUT_MS }, '[KBSecAuth] 요청 상한 초과 — 요청을 취소했다');
    }
}

/** 토큰 발급 락 TTL — KIS 구현에서 가져온 값. */
const TOKEN_FETCH_LOCK_TTL_MS = 90 * 1000;

/**
 * 토큰 폐기 시도 쿨다운. 토큰 장애 중에는 **모든 TR 이** I445 로 실패하므로 실패마다 폐기를 부르지 않는다.
 * 폐기는 성공하면 한 번으로 족하고, 실패했다면 곧바로 다시 해도
 * 결과가 같다 — 반복은 KB 가 경고하는 "잘못된 조회의 과도한 반복" 만 만든다.
 */
const REVOKE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * JWT 의 `jti` — **토큰 동일성 판정의 정본**.
 *
 * 앞 100자 비교로 판정하지 말 것. 헤더와 payload 앞부분(`sub`·`aud`)이 모든 토큰에서 같아
 * 서로 다른 토큰도 접두가 일치한다.
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

export class KbsecAuth {
    private credentials: KbsecCredentials;
    private cachedToken: KbsecCachedToken | null = null;
    private refreshPromise: Promise<string> | null = null;
    /** 어느 본문 형태가 통했는지 기억 — 두 번째 발급부터는 폴백 왕복을 생략한다. */
    private workingShape: 'envelope' | 'flat' | null = null;
    /** 마지막 폐기 시도 시각(ms). {@link REVOKE_COOLDOWN_MS} 참조 — 인스턴스 단위로만 제한한다. */
    private lastRevokeAttemptAt = 0;

    /**
     * @param baseUrl API 서버 주소. 생략하면 운영 서버다.
     * @param storeOf 지금 쓸 토큰 저장소를 돌려주는 함수. 저장소가 없으면 `null` 이고, 그러면 프로세스 메모리 캐시만 쓴다.
     */
    constructor(
        credentials: KbsecCredentials,
        readonly baseUrl: string = KBSEC_API_BASE,
        private readonly storeOf: () => BrokerTokenStore | null = () => null,
    ) {
        this.credentials = credentials;
    }

    get appKey(): string {
        return this.credentials.appKey;
    }

    private get storeKey(): string {
        return tokenStoreKey(KBSEC_TOKEN_KEY_PREFIX, this.credentials.appKey);
    }

    /**
     * 유효한 access_token 반환.
     * 우선순위: 프로세스 메모리 캐시 → 토큰 저장소 → 신규 발급.
     * 같은 프로세스 내 동시 갱신은 refreshPromise 로 단일화한다.
     */
    async getAccessToken(): Promise<string> {
        if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
            return this.cachedToken.accessToken;
        }
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = this.fetchFromStoreOrIssue();
        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    /**
     * 토큰 캐시 강제 초기화 — 프로세스 메모리와 토큰 저장소 모두. 토큰 실패 시 재시도 **전에** 부른다.
     *
     * `await` 가 계약의 일부다. 저장소 삭제가 끝나기 전에 재시도하면 방금 무효로 판정한 토큰을 저장소에서 다시 읽는다.
     */
    async invalidate(failedToken?: string): Promise<void> {
        // 실패한 토큰이 캐시에 그대로 있을 때만 비운다. 동시 요청 가운데 먼저 끝난 쪽이 새 토큰을 받아 뒀으면 그것을 지우지 않는다.
        if (failedToken === undefined || this.cachedToken?.accessToken === failedToken) this.cachedToken = null;
        const store = this.storeOf();
        if (store) {
            try {
                if (failedToken) {
                    // compare-and-delete — 남의 토큰을 지우지 않는다 (구현은 `options.tokenStore` 로 넘기는 토큰 저장소).
                    if (!await store.deleteIfAccessTokenEquals(this.storeKey, failedToken)) {
                        logger.info('[KBSecAuth] 메모리 캐시만 무효화 — 토큰 저장소에는 이미 다른(더 새) 토큰이 있다');
                        return;
                    }
                } else {
                    await store.delete(this.storeKey);
                }
            } catch (err) {
                logger.debug({ err }, '[KBSecAuth] 토큰 저장소 삭제 실패 (메모리 캐시 무효화는 완료)');
            }
        }
        logger.info('[KBSecAuth] 토큰 캐시 초기화');
    }


    /**
     * 토큰 실패(I445) 뒤 **실제로 회전시킨다** — 토큰 장애 대응.
     *
     * KB 는 쓸 수 없게 된 활성 토큰을 재발급 요청에도 같은 `jti` 로 되돌려줄 수 있어, `invalidate()` 만으로는 회복되지 않는다.
     * 재발급 결과가 **실패한 토큰과 같은 `jti`** 일 때만 `/oauth2/revoke` 로 명시 폐기하고 한 번 더 발급한다. 재발급이 새 토큰을
     * 주면 폐기를 부르지 않으므로 다른 프로세스가 쓰는 멀쩡한 토큰을 폐기하지 않는다. 폐기가 실패하면 재발급한 토큰을 그대로 둔다.
     *
     * @param failedToken TR 이 I445 로 거부당할 때 실제로 보냈던 토큰.
     */
    async rotateAfterTokenFailure(failedToken: string): Promise<void> {
        await this.invalidate(failedToken);
        const reissued = await this.getAccessToken();
        if (tokenJti(reissued) === null || tokenJti(reissued) !== tokenJti(failedToken)) {
            return;   // 정상 회전 — 폐기할 이유가 없다.
        }

        // 쿨다운이 없으면 안 된다. 이 상태에서는 **모든 TR 이** I445 로 실패하므로, 그때마다 폐기를 부르면
        // KB 가 경고하는 "잘못된 조회의 과도한 반복" 을 이 코드가 일으킨다. 폐기는 성공해도 한 번이면 족하다.
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
                const flag = (JSON.parse(text) as KbsecResponseEnvelope<unknown>)?.dataHeader?.processFlag;
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
     * 토큰 저장소 → 없으면 **교차 프로세스 락**을 걸고 발급한다. KB 는 발급 빈도를 제한하므로 여러 프로세스가 함께 발급하지 않게 한다.
     *
     * 저장은 `requestToken` 안에서 이미 await 로 한다 — 그래서 `issueAndCache` 가 곧 발급이다.
     */
    private async fetchFromStoreOrIssue(): Promise<string> {
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

    /** 토큰 저장소의 **유효한** 토큰. 없거나 만료면 null. */
    private async readCachedToken(): Promise<string | null> {
        const store = this.storeOf();
        if (!store) return null;
        try {
            const raw = await store.get(this.storeKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as KbsecCachedToken;
            if (parsed.expiresAt <= Date.now()) return null;
            this.cachedToken = parsed;
            return parsed.accessToken;
        } catch (err) {
            logger.debug({ err }, '[KBSecAuth] 토큰 저장소 조회 실패 — 신규 발급');
            return null;
        }
    }

    private async issueToken(): Promise<string> {
        const shapes: Array<'envelope' | 'flat'> = this.workingShape
            ? [this.workingShape]
            : ['envelope', 'flat'];

        // 형태별 오류를 **전부** 모아 던진다. 마지막 시도(`flat`)는 서버가 늘 `E021 앱키로 앱정보 추출 중 오류` 로 답하므로,
        // 그 오류만 던지면 진짜 원인(envelope 응답)이 가려진다.
        const failures: string[] = [];
        // `brokerCode` 는 첫 형태의 업무 코드만 싣는다. flat 의 E021 을 실으면 위와 같은 이유로 원인을 잘못 가리킨다.
        let brokerCode: string | undefined;
        for (const shape of shapes) {
            try {
                const token = await this.requestToken(shape);
                this.workingShape = shape;
                return token;
            } catch (err) {
                // 연결 실패, 시간 초과, 5xx, 429 는 본문 형태와 관계없다. 다른 형태로 다시 보내면 KB 가 제한하는 발급 요청만 늘므로
                // 그 오류를 그대로 던진다. 호출부는 자격증명 오류가 아니라 일시 장애로 읽는다.
                if (err instanceof NetworkError) throw err;
                if (failures.length === 0 && err instanceof BaseError) brokerCode = err.brokerCode;
                failures.push(`${shape}: ${String(err)}`);
                logger.warn(
                    { shape, err: String(err) },
                    '[KBSecAuth] 토큰 발급 실패 — 다른 본문 형태로 재시도',
                );
            }
        }
        // 정답 형태(envelope)가 앞에 오므로 목록 순서 그대로가 곧 진단 우선순위다.
        throw new AuthenticationError(`[KBSecAuth] 토큰 발급 실패 — 시도한 본문 형태 전부 실패\n  ${failures.join('\n  ')}`, { brokerCode });
    }

    private async requestToken(shape: 'envelope' | 'flat'): Promise<string> {
        const body = shape === 'envelope' ? envelopeBody(this.credentials) : flatBody(this.credentials);
        // 요청 시간 상한 — 여기서 응답 없이 멈추면 **그 뒤의 모든 TR 이 같이 멈춘다**
        // (TR 은 getAccessToken() 을 await 한 다음에야 나간다). 상한에 걸려도 즉시 재발급
        // 루프를 만들지 않는다: KB 는 발급 빈도 제한이 있고 반복 실패를 계정 제한 사유로 든다.
        const { res, text } = await postJson(`oauth2/token:${shape}`, `${this.baseUrl}${KBSEC_TOKEN_PATH}`, body);

        if (!res.ok) {
            const message = `KB증권 토큰 발급 오류: ${res.status} ${text.slice(0, 300)}`;
            if (res.status === 429) throw new RateLimitExceeded(message);
            // KB 는 자격증명 오류(E021 등)도 HTTP 500 과 봉투의 processCode 로 준다. 업무 코드가 없는 5xx 만 일시 장애다.
            const brokerCode = kbsecProcessCodeOf(text);
            if (res.status >= 500 && brokerCode === undefined) throw new ExchangeNotAvailable(message);
            throw new AuthenticationError(message, { brokerCode });
        }

        let parsed: KbsecResponseEnvelope<KbsecTokenResponse> & KbsecTokenResponse;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error(`KB증권 토큰 응답이 JSON 이 아님: ${text.slice(0, 200)}`);
        }

        // 봉투 응답(dataBody.access_token)과 평면 응답(access_token) 모두 수용.
        const payload: KbsecTokenResponse = parsed.dataBody ?? parsed;
        const accessToken = payload.access_token ?? payload.accessToken;
        if (!accessToken) {
            // KB 는 발급 거절을 HTTP 200 과 빈 토큰, 실패 봉투(`processFlag B`)로도 준다.
            const brokerCode = isKbsecBusinessError(parsed.dataHeader as KbsecResponseHeader | undefined) ? kbsecProcessCodeOf(text) : undefined;
            throw new AuthenticationError(`KB증권 토큰 응답에 access_token 없음: ${text.slice(0, 200)}`, { brokerCode });
        }

        const ttlMs = typeof payload.expires_in === 'number' && payload.expires_in > 0
            ? payload.expires_in * 1000
            : KBSEC_TOKEN_DEFAULT_TTL_MS;
        // 수명이 안전 여유의 두 배보다 짧으면(KB 는 만료 직전에 3초, 1초를 준다) 여유를 수명의 절반으로 줄인다. 여유를 다 빼면 만료 시각이
        // 지금이 되어 TR 마다 새로 발급한다.
        const shortLived = ttlMs <= KBSEC_TOKEN_SAFETY_MARGIN_MS * 2;
        const expiresAt = Date.now() + (shortLived ? Math.floor(ttlMs / 2) : ttlMs - KBSEC_TOKEN_SAFETY_MARGIN_MS);

        this.cachedToken = { accessToken, expiresAt };

        // 저장소 쓰기도 await 한다. 기다리지 않으면 동시 발급 경합에서 쓰기 순서가
        // 보장되지 않아 **더 오래된 토큰이 캐시에 남을 수 있다**.
        const store = this.storeOf();
        const ttlSec = Math.floor((expiresAt - Date.now()) / 1000);
        if (store && ttlSec > 0 && !shortLived) {
            // 수명이 짧거나 남은 수명이 0 이하인 토큰은 저장하지 않는다. 다른 프로세스가 곧 만료될 토큰을 가져다 쓰게 된다.
            try {
                await store.set(this.storeKey, JSON.stringify(this.cachedToken), ttlSec * 1000);
            } catch (err) {
                logger.warn({ err }, '[KBSecAuth] 토큰 저장소 쓰기 실패 (메모리 캐시는 유효)');
            }
        }

        logger.info(
            { shape, expiresInSec: Math.floor(ttlMs / 1000) },
            '[KBSecAuth] ✅ 접근 토큰 발급 완료',
        );
        return accessToken;
    }
}
