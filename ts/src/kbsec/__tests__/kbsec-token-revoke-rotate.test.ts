/**
 * KB 토큰 **명시 폐기 후 회전** — 장애 대응.
 *
 * ## 무엇이 고장나 있었나
 *
 * "I445 → `invalidate` → 재발급 → 1회 재시도" 는 동작했다. 그런데 그 자가복구가
 * **KB 가 재발급에 같은 토큰을 돌려주는 경우**를 풀지 못한다. 실측 사례:
 *
 * - 전날 토큰이 24h 만료 → I445 → 새 토큰 발급 → **그 새 토큰도 전 TR 이 I445**
 * - 이후 수백 번 재발급을 요청해도 KB 는 **같은 `jti`** 만 돌려줬다.
 * 토큰 캐시를 비우고 프로세스를 재시작해도 바뀌지 않았고 `expiresInSec` 은 경과 시간만큼만 줄었다
 * → 캐시 문제가 아니라 **KB 쪽 활성 토큰이 쓸 수 없는 상태로 고정된 것**이다.
 *
 * ## 이 스위트가 지키는 것
 *
 * 1. 재발급이 **같은 `jti`** 를 주면 `/oauth2/revoke` 를 부르고 **한 번 더** 발급한다.
 * 2. 재발급이 정상으로 회전하면(다른 `jti`) **폐기를 부르지 않는다** — 이 조건이 안전장치다.
 * 무조건 폐기하면 멀쩡한 토큰을 없애 다른 프로세스의 진행 중 호출을 끊는다.
 * 3. 폐기가 실패해도 종전 동작으로 되돌아갈 뿐이다(더 나빠지지 않는다).
 * 4. `tokenJti` 는 **앞자리 비교가 아니라 `jti`** 로 판정한다 — 조사 중 앞 100자를 비교해
 * "같은 토큰" 이라 오판했다. 헤더와 `sub`·`aud` 가 같아 서로 다른 토큰도 접두가 일치한다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockGetRedis: vi.fn(() => null as unknown),
}));

global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { tokenJti } from '../kbsec-auth';

const CREDS = { appKey: 'kb-app-key-123456', appSecret: 'kb-secret' };

/** TR 한 번 호출. 요청 간격 조절은 끈다(`rateLimit: 0`). */
const newExchange = () => new kbsec({ apiKey: CREDS.appKey, secret: CREDS.appSecret, rateLimit: 0 });
const call = async (exchange: kbsec): Promise<unknown> => (await exchange.privatePostSsqm1801({})).dataBody;

type MockRes = { ok: boolean; status: number; text: () => Promise<string> };

function envelope(status: number, header: Record<string, string>, dataBody: unknown = {}): MockRes {
    const body = JSON.stringify({ dataHeader: header, dataBody });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** 실제 KB 토큰과 같은 모양의 JWT — 접두는 같고 `jti` 만 다르다(오판 재현 방지). */
function jwt(jti: string): string {
    const head = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS512' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
        sub: 'token', aud: CREDS.appKey, iss: 'unogw', jti,
        iat: 1788497211, exp: 1788583611,
    })).toString('base64url');
    return `${head}.${body}.sig-${jti}`;
}

const okResponse = (): MockRes => envelope(200, { processFlag: 'A', processCode: '0011' }, { o_msg: '정상' });
const i445Response = (): MockRes => envelope(500, {
    processFlag: 'B', processCode: 'I445', processMessage: '토큰 검증에 실패했습니다.',
});

/** 발급 응답이 줄 토큰 순서. 다 쓰면 마지막 것을 계속 준다(=KB 가 같은 토큰을 되돌려주는 상태). */
let issueQueue: string[] = [];
let lastIssued = '';
let revokeCalls: Array<Record<string, unknown>> = [];
let revokeSucceeds = true;
let trQueue: Array<() => MockRes> = [];
let sentAuth: string[] = [];

function installFetch(): void {
    mockFetch.mockImplementation(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
        const u = String(url);
        if (u.includes('/oauth2/revoke')) {
            const parsed = JSON.parse(init?.body ?? '{}') as { dataBody?: Record<string, unknown> };
            revokeCalls.push(parsed.dataBody ?? {});
            return revokeSucceeds
                ? envelope(200, { processFlag: 'A', processCode: '0000' })
                : envelope(500, { processFlag: 'B', processCode: 'T022', processMessage: '유효하지 않은 클라이언트 정보입니다.' });
        }
        if (u.includes('/oauth2/token')) {
            lastIssued = issueQueue.length > 1 ? (issueQueue.shift() as string) : issueQueue[0]!;
            return envelope(200, { processFlag: 'A', processCode: '0000' }, {
                access_token: lastIssued, token_type: 'Bearer', expires_in: 86400,
            });
        }
        sentAuth.push(init?.headers?.Authorization ?? '');
        const next = trQueue.shift();
        if (!next) throw new Error(`예상치 못한 TR 호출 — 큐가 비었다 (누적 ${sentAuth.length}회)`);
        return next();
    });
}

beforeEach(() => {
    mockFetch.mockReset();
    issueQueue = [];
    revokeCalls = [];
    revokeSucceeds = true;
    trQueue = [];
    sentAuth = [];
    lastIssued = '';
});

describe('tokenJti — 동일성 판정', () => {
    it('접두가 같아도 `jti` 가 다르면 다른 토큰이다 (앞자리 비교 오판 방지)', () => {
        const a = jwt('aaa');
        const b = jwt('bbb');
        expect(a.slice(0, 60)).toBe(b.slice(0, 60));   // 접두는 실제로 같다
        expect(tokenJti(a)).toBe('aaa');
        expect(tokenJti(a)).not.toBe(tokenJti(b));
    });

    it('JWT 가 아니거나 jti 가 없으면 null — "모른다" 로 다룬다', () => {
        expect(tokenJti('TOK1')).toBeNull();
        expect(tokenJti('a.b.c')).toBeNull();
        const noJti = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'token' })).toString('base64url')}.s`;
        expect(tokenJti(noJti)).toBeNull();
    });
});

describe('후속 I445 회전 — 재발급이 같은 토큰이면 폐기한다', () => {
    it('같은 jti 로 재발급되면 revoke 를 부르고 새 토큰으로 재시도한다', async () => {
        // 발급: 같은 토큰 두 번(KB 가 되돌려주는 상태) → 폐기 뒤에야 새 토큰.
        issueQueue = [jwt('dead'), jwt('dead'), jwt('fresh')];
        trQueue = [i445Response, okResponse];
        installFetch();

        const client = newExchange();
        await expect(call(client)).resolves.toMatchObject({ o_msg: '정상' });

        expect(revokeCalls).toHaveLength(1);
        expect(revokeCalls[0]).toMatchObject({ appKey: CREDS.appKey, appSecret: CREDS.appSecret, token: jwt('dead') });
        // 재시도는 **새 토큰**으로 나갔다.
        expect(sentAuth[0]).toBe(`bearer ${jwt('dead')}`);
        expect(sentAuth[1]).toBe(`bearer ${jwt('fresh')}`);
    });

    it('재발급이 정상 회전하면 revoke 를 부르지 않는다 (멀쩡한 토큰을 날리지 않는다)', async () => {
        issueQueue = [jwt('old'), jwt('new')];
        trQueue = [i445Response, okResponse];
        installFetch();

        const client = newExchange();
        await expect(call(client)).resolves.toMatchObject({ o_msg: '정상' });

        expect(revokeCalls).toHaveLength(0);
        expect(sentAuth[1]).toBe(`bearer ${jwt('new')}`);
    });

    it('폐기가 실패하면 종전 동작으로 되돌아간다 — 재시도는 그대로 1회', async () => {
        revokeSucceeds = false;
        issueQueue = [jwt('dead')];   // 언제나 같은 토큰
        trQueue = [i445Response, okResponse];
        installFetch();

        const client = newExchange();
        await expect(call(client)).resolves.toMatchObject({ o_msg: '정상' });

        // 후보 본문 3종을 모두 시도하고 포기한다.
        expect(revokeCalls.length).toBeGreaterThanOrEqual(1);
        expect(sentAuth).toHaveLength(2);
    });

    it('쿨다운 — 실패가 연달아 나도 폐기는 한 번만 시도한다 (KB 의 "과도한 반복" 제한 회피)', async () => {
        issueQueue = [jwt('dead')];   // KB 가 언제나 같은 토큰을 준다
        trQueue = [i445Response, okResponse, i445Response, okResponse, i445Response, okResponse];
        installFetch();

        const client = newExchange();
        // 같은 클라이언트로 세 번 — 장애 중 실패가 연달아 발생하는 상황.
        await call(client);
        await call(client);
        await call(client);

        // 첫 회만 폐기 후보(3종)를 시도하고, 이후 두 번은 쿨다운에 걸려 아예 부르지 않는다.
        expect(revokeCalls.length).toBeLessThanOrEqual(3);
        expect(sentAuth).toHaveLength(6);
    });

    it('JWT 가 아닌 토큰(구 목·테스트 픽스처)이면 폐기 경로를 타지 않는다', async () => {
        issueQueue = ['TOK-plain'];
        trQueue = [i445Response, okResponse];
        installFetch();

        const client = newExchange();
        await expect(call(client)).resolves.toMatchObject({ o_msg: '정상' });
        expect(revokeCalls).toHaveLength(0);
    });
});
