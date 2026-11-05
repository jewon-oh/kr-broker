/**
 * @fileoverview KIS 토큰 캐시 동작 — 발급 빈도 제한(1분당 1회)을 피하려는 토큰 저장소 영속화와 분산 락.
 *
 * 토큰은 `kis.authenticate()` 가 준비한다. 프로세스 메모리 → 토큰 저장소 → 신규 발급 순서로 찾고, 저장소가 있으면 여러 프로세스가 동시에
 * 발급하지 않도록 락을 잡는다.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import type { BrokerTokenStore } from '../../options';
import { tokenStoreKey } from '../../token-store-key';
import { jsonResponse, newKis, tokenOk } from './support/kis-test-utils';

/** 메모리로 동작하는 가짜 토큰 저장소. 호출을 기록해 검증한다. */
function fakeStore(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    const calls: string[] = [];
    let lockHeldByOther = false;
    const store: BrokerTokenStore = {
        get: vi.fn(async (key: string) => { calls.push(`get ${key}`); return data.get(key) ?? null; }),
        set: vi.fn(async (key: string, value: string) => { calls.push(`set ${key}`); data.set(key, value); }),
        delete: vi.fn(async (key: string) => { calls.push(`delete ${key}`); data.delete(key); }),
        deleteIfAccessTokenEquals: vi.fn(async () => false),
        tryLock: vi.fn(async (key: string) => { calls.push(`lock ${key}`); return !lockHeldByOther; }),
        unlock: vi.fn(async (key: string) => { calls.push(`unlock ${key}`); }),
    };
    return { store, data, calls, holdLock: () => { lockHeldByOther = true; } };
}

const TOKEN_KEY = tokenStoreKey('kis:token:', 'TEST-APPKEY-123456789');

beforeEach(() => {
    mockFetch.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('토큰 캐시 — kis.authenticate', () => {
    it('프로세스 메모리 캐시 hit — 저장소·fetch 를 다시 부르지 않는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk('token-1'));
        const broker = newKis();

        await broker.authenticate();
        await broker.authenticate();

        expect(broker.token).toBe('token-1');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('저장소 캐시 hit(다른 pod 가 발급한 토큰) — fetch 하지 않는다', async () => {
        const { store } = fakeStore({ [TOKEN_KEY]: JSON.stringify({ accessToken: 'stored-token', expiresAt: Date.now() + 3_600_000 }) });
        const broker = newKis({ options: { tokenStore: store } });

        await broker.authenticate();

        expect(broker.token).toBe('stored-token');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('저장소 캐시가 만료된 경우 — 락을 잡고 신규 발급해 저장소에 올린다', async () => {
        const { store, calls } = fakeStore({ [TOKEN_KEY]: JSON.stringify({ accessToken: 'old', expiresAt: Date.now() - 1000 }) });
        mockFetch.mockResolvedValueOnce(tokenOk('new-token'));
        const broker = newKis({ options: { tokenStore: store } });

        await broker.authenticate();

        expect(broker.token).toBe('new-token');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(calls.filter((c) => c.startsWith('lock')).length).toBe(1);
        expect(calls.some((c) => c === `set ${TOKEN_KEY}`)).toBe(true);
        expect(calls.some((c) => c.startsWith('unlock'))).toBe(true);
    });

    it('저장소 없음 → 직접 발급', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk('plain-token'));
        const broker = newKis();

        await broker.authenticate();

        expect(broker.token).toBe('plain-token');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('동시 갱신 — 발급은 한 번만', async () => {
        mockFetch.mockResolvedValue(tokenOk('once'));
        const broker = newKis();

        await Promise.all([broker.authenticate(), broker.authenticate(), broker.authenticate()]);

        expect(broker.token).toBe('once');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('락 미획득 → 1.5초 기다려 저장소를 다시 보고 다른 pod 의 토큰을 쓴다', async () => {
        vi.useFakeTimers();
        const other = { accessToken: 'other-pod-token', expiresAt: Date.now() + 3_600_000 };
        const { store, data, holdLock } = fakeStore();
        holdLock();
        const broker = newKis({ options: { tokenStore: store } });

        const pending = broker.authenticate();
        await vi.advanceTimersByTimeAsync(100);
        data.set(TOKEN_KEY, JSON.stringify(other)); // 그동안 다른 pod 가 발급을 마쳤다
        await vi.advanceTimersByTimeAsync(2000);
        await pending;

        expect(broker.token).toBe('other-pod-token');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('★락 협업이 끝내 실패해 직접 발급해도 저장소에 올린다(안 올리면 다른 pod 가 또 발급한다)', async () => {
        vi.useFakeTimers();
        const { store, calls, holdLock } = fakeStore();
        holdLock();
        mockFetch.mockResolvedValue(tokenOk('fallback'));
        const broker = newKis({ options: { tokenStore: store } });

        const pending = broker.authenticate();
        await vi.advanceTimersByTimeAsync(13_000);   // 락을 쥔 쪽의 발급을 상한(12초)까지 기다린 뒤 직접 발급한다
        await pending;

        expect(broker.token).toBe('fallback');
        expect(calls.filter((c) => c === `set ${TOKEN_KEY}`).length).toBeGreaterThan(0);
    });

    it('서버가 준 expires_in 이 캐시 수명의 정본이다 — 마진을 뺀 값을 저장소 TTL 로 쓴다', async () => {
        const { store } = fakeStore();
        mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'short', expires_in: 3600 }));
        const now = Date.now();

        await newKis({ options: { tokenStore: store } }).authenticate();

        const [, , ttlMs] = vi.mocked(store.set).mock.calls[0]!;
        // 3600초에서 안전 마진 30분과 저장소 여유 1분을 뺀 값 안팎이다.
        expect(ttlMs).toBeGreaterThan(0);
        expect(ttlMs).toBeLessThan(3_600_000 - 30 * 60_000);
        expect(Date.now() - now).toBeLessThan(5000);
    });

    it('서버 수명이 안전 마진보다 짧아도 갱신 요청이 몰리지 않도록 하한을 둔다', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'tiny', expires_in: 60 })).mockResolvedValue(tokenOk('again'));
        const broker = newKis();

        await broker.authenticate();
        await broker.authenticate();

        expect(mockFetch).toHaveBeenCalledTimes(1); // 하한(1분) 동안은 캐시를 쓴다
    });
});

describe('invalidateToken', () => {
    it('프로세스 메모리와 저장소 캐시를 모두 삭제한다', async () => {
        const { store, calls } = fakeStore();
        mockFetch.mockResolvedValueOnce(tokenOk('t')).mockResolvedValueOnce(tokenOk('t2'));
        const broker = newKis({ options: { tokenStore: store } });

        await broker.authenticate();
        await broker.invalidateToken();

        expect(broker.token).toBeUndefined();
        expect(calls.some((c) => c === `delete ${TOKEN_KEY}`)).toBe(true);
        await broker.authenticate();
        expect(broker.token).toBe('t2'); // 다시 발급했다
    });
});

/** 저장된 값의 accessToken 이 같을 때만 지우는 원자적 비교 삭제를 갖춘 가짜 저장소(Redis Lua 의 흉내). */
function casStore(initial: Record<string, string> = {}) {
    const base = fakeStore(initial);
    base.store.deleteIfAccessTokenEquals = vi.fn(async (key: string, accessToken: string) => {
        base.calls.push(`cad ${key} ${accessToken}`);
        const raw = base.data.get(key);
        if (raw === undefined || (JSON.parse(raw) as { accessToken?: string }).accessToken !== accessToken) return false;
        base.data.delete(key);
        return true;
    });
    return base;
}

const cached = (accessToken: string): string => JSON.stringify({ accessToken, expiresAt: Date.now() + 3_600_000 });

describe('invalidateToken — 거절된 토큰일 때만 지운다(compare-and-delete)', () => {
    it('★거절된 토큰을 알면 무조건 삭제가 아니라 비교 삭제를 부른다', async () => {
        const { store, calls, data } = casStore({ [TOKEN_KEY]: cached('t1') });
        mockFetch.mockResolvedValueOnce(tokenOk('unused'));
        const broker = newKis({ options: { tokenStore: store } });
        await broker.authenticate(); // 저장소의 t1 을 복원한다
        expect(broker.token).toBe('t1');

        await broker.invalidateToken('t1');

        expect(calls).toContain(`cad ${TOKEN_KEY} t1`);
        expect(calls.some((c) => c === `delete ${TOKEN_KEY}`)).toBe(false);
        expect(data.has(TOKEN_KEY)).toBe(false); // 같은 토큰이라 지웠다
        expect(broker.token).toBeUndefined();
    });

    it('★그사이 다른 프로세스가 저장소에 넣은 새 토큰은 지우지 않는다 — 상대가 방금 발급한 멀쩡한 토큰이다', async () => {
        const { store, data } = casStore({ [TOKEN_KEY]: cached('t1') });
        const broker = newKis({ options: { tokenStore: store } });
        await broker.authenticate(); // 이 프로세스의 토큰은 t1
        data.set(TOKEN_KEY, cached('t2')); // 다른 프로세스가 t2 를 발급해 저장소에 넣었다

        await broker.invalidateToken('t1'); // t1 로 보낸 요청이 거절됐다

        expect(JSON.parse(data.get(TOKEN_KEY) as string).accessToken).toBe('t2'); // 새 토큰이 살아 있다
        expect(broker.token).toBeUndefined(); // 이 프로세스의 낡은 t1 은 버렸다
        await broker.authenticate();
        expect(broker.token).toBe('t2'); // 저장소의 t2 를 쓴다
        expect(mockFetch).not.toHaveBeenCalled(); // 다시 발급하지 않았다(KIS 는 발급이 분당 1회)
    });

    it('이 프로세스가 이미 새 토큰으로 바뀌었으면 메모리의 새 토큰도 지우지 않는다', async () => {
        const { store } = casStore();
        mockFetch.mockResolvedValueOnce(tokenOk('t2'));
        const broker = newKis({ options: { tokenStore: store } });
        await broker.authenticate(); // t2 를 발급해 저장소에도 넣었다

        await broker.invalidateToken('t1'); // 동시 요청 중 낡은 t1 으로 나갔다 거절된 요청

        expect(broker.token).toBe('t2');
        await broker.authenticate();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('인자 없이 부르면 종전처럼 무조건 지운다(강제 재인증)', async () => {
        const { store, calls } = casStore({ [TOKEN_KEY]: cached('t1') });
        const broker = newKis({ options: { tokenStore: store } });
        await broker.authenticate();

        await broker.invalidateToken();

        expect(calls).toContain(`delete ${TOKEN_KEY}`);
        expect(calls.some((c) => c.startsWith('cad '))).toBe(false);
        expect(broker.token).toBeUndefined();
    });

    it('비교 삭제가 실패해도 던지지 않고 메모리 캐시는 비운다', async () => {
        const { store } = casStore({ [TOKEN_KEY]: cached('t1') });
        store.deleteIfAccessTokenEquals = vi.fn().mockRejectedValue(new Error('redis down'));
        const broker = newKis({ options: { tokenStore: store } });
        await broker.authenticate();

        await expect(broker.invalidateToken('t1')).resolves.toBeUndefined();
        expect(broker.token).toBeUndefined();
    });

    it('★401 을 받으면 그 요청이 쓴 토큰으로 비교 삭제한다 — 헤더의 토큰이 거절된 토큰이다', async () => {
        const { store, calls, data } = casStore();
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/tokenP')
            ? tokenOk('old-token')
            : jsonResponse({ rt_cd: '1', msg_cd: 'X', msg1: 'unauthorized' }, 401)));
        const broker = newKis({ options: { tokenStore: store } });

        await broker.privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' }).catch(() => undefined);
        // 거절 처리의 무효화는 응답을 기다리지 않고 돈다. 마이크로태스크를 비운다.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toContain(`cad ${TOKEN_KEY} old-token`);
        expect(data.has(TOKEN_KEY)).toBe(false);
    });

    it('★401 이 오는 사이 다른 프로세스가 저장소에 새 토큰을 넣었다면 그 토큰은 남는다', async () => {
        const { store, data } = casStore();
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('/oauth2/tokenP')) return tokenOk('old-token');
            data.set(TOKEN_KEY, cached('peer-token')); // 응답이 오는 사이 다른 프로세스가 발급해 넣었다
            return jsonResponse({ rt_cd: '1', msg_cd: 'X', msg1: 'unauthorized' }, 401);
        });
        const broker = newKis({ options: { tokenStore: store } });

        await broker.privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(JSON.parse(data.get(TOKEN_KEY) as string).accessToken).toBe('peer-token');
    });
});

describe('실시간 접속키(approval_key)', () => {
    it('secretkey 로 발급하고(접근토큰의 appsecret 이 아니다) 캐시한다', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ approval_key: 'approval-1' }));
        const broker = newKis();

        expect(await broker.getApprovalKey()).toBe('approval-1');
        expect(await broker.getApprovalKey()).toBe('approval-1');

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0] as [string, { body: string }];
        expect(url).toContain('/oauth2/Approval');
        expect(JSON.parse(init.body)).toEqual({ grant_type: 'client_credentials', appkey: 'TEST-APPKEY-123456789', secretkey: 'test-app-secret' });
    });

    it('저장소에 있으면 발급하지 않는다', async () => {
        const { store } = fakeStore({ [tokenStoreKey('kis:approval:', 'TEST-APPKEY-123456789')]: JSON.stringify({ key: 'stored-approval', expiresAt: Date.now() + 3_600_000 }) });

        expect(await newKis({ options: { tokenStore: store } }).getApprovalKey()).toBe('stored-approval');

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('createPriceStream 은 이 인스턴스의 모의 여부와 접속키를 쓴다', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ approval_key: 'approval-2' }));
        const broker = newKis({ sandbox: true });

        const stream = broker.createPriceStream();

        expect(stream.isConnected()).toBe(false);
        expect(await broker.getApprovalKey()).toBe('approval-2');
    });
});
