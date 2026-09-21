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

const TOKEN_KEY = 'kis:token:TEST-APPKEY-';

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
        await vi.advanceTimersByTimeAsync(2000);
        await pending;

        expect(broker.token).toBe('fallback');
        expect(calls.filter((c) => c === `set ${TOKEN_KEY}`).length).toBeGreaterThan(0);
    });

    it('서버가 준 expires_in 이 캐시 수명의 정본이다 — 마진을 뺀 값을 저장소 TTL 로 쓴다', async () => {
        const { store } = fakeStore();
        mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'short', expires_in: 3600 }));
        const now = Date.now();

        await newKis({ options: { tokenStore: store } }).authenticate();

        const [, , ttlMs] = vi.mocked(store.set).mock.calls[0];
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
        const { store } = fakeStore({ 'kis:approval:TEST-APPKEY-': JSON.stringify({ key: 'stored-approval', expiresAt: Date.now() + 3_600_000 }) });

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
