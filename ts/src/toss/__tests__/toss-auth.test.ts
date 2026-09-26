/**
 * @fileoverview 토큰 캐시와 발급 조정.
 *
 * 토스는 클라이언트 하나에 유효한 토큰이 하나뿐이라 새로 발급하면 이전 토큰이 즉시 무효가 된다. 프로세스 둘이 401 을 받고 저마다 저장소의 토큰을
 * 지우고 다시 발급하면 서로의 토큰을 죽이는 왕복이 된다. 가짜 서버는 발급할 때마다 이전 토큰을 무효화하고, 유효하지 않은 토큰의 요청에 401 을 준다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrokerTokenStore } from '../../options';
import { tokenStoreKey } from '../../token-store-key';
import { TossAuth } from '../toss-auth';
import { errorReply, installFakeToss, jsonOk, makeToss, tokenOk, type FakeToss } from './support/toss-fake';

const CLIENT = 'toss-client-id-abcdef';
const STORE_KEY = tokenStoreKey('toss:token:', CLIENT);

/** 두 프로세스가 나눠 쓰는 가짜 토큰 저장소. */
function makeStore(): BrokerTokenStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    const locks = new Set<string>();
    return {
        data,
        get: async (key) => data.get(key) ?? null,
        set: async (key, value) => { data.set(key, value); },
        delete: async (key) => { data.delete(key); },
        deleteIfAccessTokenEquals: async (key, accessToken) => {
            const raw = data.get(key);
            if (raw === undefined || (JSON.parse(raw) as { accessToken?: string }).accessToken !== accessToken) return false;
            data.delete(key);
            return true;
        },
        tryLock: async (key) => { if (locks.has(key)) return false; locks.add(key); return true; },
        unlock: async (key) => { locks.delete(key); },
    };
}

describe('TossAuth', () => {
    const issued = (token: string, expiresInSeconds = 86400) => async () => ({ accessToken: token, expiresInSeconds });

    it('메모리에 둔 토큰을 다시 쓴다', async () => {
        const issue = vi.fn(issued('tok-1'));
        const auth = new TossAuth(CLIENT, issue);
        expect(await auth.getAccessToken()).toBe('tok-1');
        expect(await auth.getAccessToken()).toBe('tok-1');
        expect(issue).toHaveBeenCalledTimes(1);
    });

    it('만료 안전 여유(60초)보다 짧은 토큰은 매번 다시 발급한다', async () => {
        const issue = vi.fn(issued('tok-x', 30));
        const auth = new TossAuth(CLIENT, issue);
        await auth.getAccessToken();
        await auth.getAccessToken();
        expect(issue).toHaveBeenCalledTimes(2);
    });

    it('expires_in 이 없으면 24시간으로 본다', async () => {
        const issue = vi.fn(async () => ({ accessToken: 'tok-d' }));
        const auth = new TossAuth(CLIENT, issue);
        await auth.getAccessToken();
        await auth.getAccessToken();
        expect(issue).toHaveBeenCalledTimes(1);
    });

    it('같은 프로세스의 동시 요청은 발급을 하나로 합친다', async () => {
        const issue = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return { accessToken: 'tok-1' }; });
        const auth = new TossAuth(CLIENT, issue);
        const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
        expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
        expect(issue).toHaveBeenCalledTimes(1);
    });

    it('access_token 이 없는 응답은 던진다', async () => {
        await expect(new TossAuth(CLIENT, async () => ({ accessToken: '' })).getAccessToken()).rejects.toThrow('access_token');
    });

    it('invalidate() 뒤에는 다시 발급한다', async () => {
        const issue = vi.fn(issued('tok-1'));
        const auth = new TossAuth(CLIENT, issue);
        await auth.getAccessToken();
        await auth.invalidate();
        await auth.getAccessToken();
        expect(issue).toHaveBeenCalledTimes(2);
    });

    describe('저장소를 나눠 쓸 때', () => {
        let store: ReturnType<typeof makeStore>;
        beforeEach(() => {
            store = makeStore();
        });

        it('발급한 토큰을 저장소에 넣고, 다른 프로세스는 그것을 쓴다', async () => {
            const issueA = vi.fn(issued('tok-1'));
            const issueB = vi.fn(issued('tok-B'));
            expect(await new TossAuth(CLIENT, issueA, () => store).getAccessToken()).toBe('tok-1');
            expect(await new TossAuth(CLIENT, issueB, () => store).getAccessToken()).toBe('tok-1');
            expect(issueB).not.toHaveBeenCalled();
        });

        it('저장소의 토큰이 다른 프로세스가 넣은 새 토큰이면 지우지 않고 그것을 쓴다', async () => {
            const issue = vi.fn(issued('tok-1'));
            const auth = new TossAuth(CLIENT, issue, () => store);
            await auth.getAccessToken();
            store.data.set(STORE_KEY, JSON.stringify({ accessToken: 'tok-2', expiresAt: Date.now() + 3_600_000 }));

            await auth.invalidate('tok-1');

            expect(store.data.has(STORE_KEY)).toBe(true);
            expect(await auth.getAccessToken()).toBe('tok-2');
            expect(issue).toHaveBeenCalledTimes(1);
        });

        it('저장소의 토큰이 실패한 그 토큰이면 지우고 새로 발급한다', async () => {
            let n = 0;
            const auth = new TossAuth(CLIENT, async () => ({ accessToken: `tok-${++n}`, expiresInSeconds: 86400 }), () => store);
            await auth.getAccessToken();
            await auth.invalidate('tok-1');
            expect(store.data.has(STORE_KEY)).toBe(false);
            expect(await auth.getAccessToken()).toBe('tok-2');
        });

        it('인자 없이 부르면 무조건 지운다', async () => {
            const auth = new TossAuth(CLIENT, issued('tok-1'), () => store);
            await auth.getAccessToken();
            store.data.set(STORE_KEY, JSON.stringify({ accessToken: 'tok-other', expiresAt: Date.now() + 3_600_000 }));
            await auth.invalidate();
            expect(store.data.has(STORE_KEY)).toBe(false);
        });

        it('메모리 토큰이 이미 새 토큰이면 실패한 옛 토큰으로는 지우지 않는다', async () => {
            let n = 0;
            const auth = new TossAuth(CLIENT, async () => ({ accessToken: `tok-${++n}`, expiresInSeconds: 86400 }), () => store);
            await auth.getAccessToken();
            await auth.invalidate('tok-1');
            expect(await auth.getAccessToken()).toBe('tok-2');
            await auth.invalidate('tok-1'); // 같은 프로세스의 늦은 요청이 옛 토큰으로 뒤따라 부른다
            expect(await auth.getAccessToken()).toBe('tok-2');
            expect(n).toBe(2);
        });

        it('락을 기다리는 사이 다른 프로세스가 발급을 끝냈으면 또 발급하지 않는다', async () => {
            const issue = vi.fn(issued('tok-mine'));
            // 처음 읽기(락 전)는 비어 있고, 이후 읽기(락 후)에는 다른 프로세스가 넣은 토큰이 있다.
            let reads = 0;
            store.get = async (key) => {
                reads += 1;
                return key === STORE_KEY && reads >= 2 ? JSON.stringify({ accessToken: 'tok-other', expiresAt: Date.now() + 3_600_000 }) : (store.data.get(key) ?? null);
            };
            expect(await new TossAuth(CLIENT, issue, () => store).getAccessToken()).toBe('tok-other');
            expect(issue).not.toHaveBeenCalled();
        });
    });
});

describe('토큰 발급 요청(클래스)', () => {
    it('client_credentials 를 폼 인코딩 본문으로 보낸다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/prices': jsonOk([{ symbol: '005930', lastPrice: '1' }]) }, tokenOk('tok-abc'));
        await makeToss({ apiKey: CLIENT, secret: 'toss-secret' }).fetchTicker('005930');
        const [request] = fake.requests(true);
        expect(request!.method).toBe('POST');
        expect(request!.path).toBe('/oauth2/token');
        expect(request!.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(request!.rawBody).toContain('grant_type=client_credentials');
        expect(request!.rawBody).toContain(`client_id=${CLIENT}`);
        expect(request!.rawBody).toContain('client_secret=toss-secret');
        expect(fake.requestsTo('GET /api/v1/prices')[0]!.headers.Authorization).toBe('Bearer tok-abc');
    });

    it('한 번 받은 토큰은 여러 요청에 다시 쓴다', async () => {
        const fake = installFakeToss({ 'GET /api/v1/prices': jsonOk([{ symbol: '005930', lastPrice: '1' }]) });
        const exchange = makeToss();
        await exchange.fetchTicker('005930');
        await exchange.fetchTicker('005930');
        expect(fake.requestsTo('POST /oauth2/token')).toHaveLength(1);
    });
});

describe('두 프로세스 왕복', () => {
    /** 발급하면 이전 토큰이 죽는 가짜 토스. */
    function fakeTossServer(): { state: { current: string; issued: number }; fake: FakeToss; issue: () => string } {
        const state = { current: '', issued: 0 };
        const issue = (): string => { state.issued += 1; state.current = `tok-${state.issued}`; return state.current; };
        const fake = installFakeToss(
            {
                'GET /api/v1/prices': (request) => (request.headers.Authorization === `Bearer ${state.current}`
                    ? jsonOk([{ symbol: '005930', lastPrice: '1' }])
                    : errorReply(401, 'token-revoked', '새로 발급된 토큰으로 대체되어 이전 토큰이 무효화되었다')),
            },
            () => tokenOk(issue()),
        );
        return { state, fake, issue };
    }

    it('다른 프로세스가 토큰을 새로 발급해도 401 처리가 추가 발급을 일으키지 않는다', async () => {
        const store = makeStore();
        const { state, issue } = fakeTossServer();
        const podA = makeToss({ apiKey: CLIENT, options: { tokenStore: store } });
        const podB = makeToss({ apiKey: CLIENT, options: { tokenStore: store } });
        await podA.fetchTicker('005930'); // A 가 tok-1 을 발급해 저장소에 넣는다
        await podB.fetchTicker('005930'); // B 는 저장소의 tok-1 을 쓴다
        expect(state.issued).toBe(1);

        // 제3의 프로세스가 tok-2 를 발급해 저장소에 넣는다. A 와 B 의 tok-1 은 무효가 된다.
        const fresh = issue();
        store.data.set(STORE_KEY, JSON.stringify({ accessToken: fresh, expiresAt: Date.now() + 3_600_000 }));

        await expect(podA.fetchTicker('005930')).resolves.toBeDefined(); // A: 401, 저장소의 tok-2 로 다시
        await expect(podB.fetchTicker('005930')).resolves.toBeDefined(); // B: 401, 같은 tok-2 로 다시
        expect(state.current).toBe(fresh);
        // 발급은 tok-1, tok-2 둘뿐이다. 저장소의 새 토큰을 무조건 지우면 A 와 B 가 번갈아 tok-3, tok-4 를 발급한다.
        expect(state.issued).toBe(2);
    });
});
