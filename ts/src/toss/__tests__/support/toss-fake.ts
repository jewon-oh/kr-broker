/**
 * @fileoverview 토스 클래스 테스트용 가짜 서버. `globalThis.fetch` 를 바꿔 경로별로 응답한다.
 */

import { vi, type Mock } from 'vitest';

import { toss } from '../../../toss';
import type { Dict } from '../../../base';

export const TOSS_HOST = 'https://openapi.tossinvest.com';

export const CREDS = { apiKey: 'toss-client-id-123456', secret: 'toss-secret', uid: 'ACC-001' } as const;

export interface FakeReply {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
}

/** JSON 200 응답(`result` 봉투). */
export function jsonOk(result: unknown): FakeReply {
    return { status: 200, body: { result } };
}

/** 토큰 발급 응답. */
export function tokenOk(token = 'access-token-1', expiresIn = 86400): FakeReply {
    return { status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: expiresIn } };
}

/** 오류 응답. `code` 를 `error.code` 로 싣는다. */
export function errorReply(status: number, code: string, message = '거절', extra: Dict = {}): FakeReply {
    return { status, body: { error: { code, message, ...extra } } };
}

/** 한 요청. `path` 에 쿼리는 없다. */
export interface FakeRequest {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Record<string, string>;
    body: Dict | undefined;
    rawBody: string | undefined;
}

export type Route = FakeReply | ((request: FakeRequest) => FakeReply | Error);

/** 응답 객체 모양(`fetch` 의 `Response` 중 클래스가 읽는 부분). */
function toResponse(reply: FakeReply): unknown {
    const text = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        statusText: '',
        headers: new Headers(reply.headers ?? {}),
        text: async () => text,
    };
}

export interface FakeToss {
    fetch: Mock;
    /** 지금까지 나간 요청(토큰 발급 제외 여부는 `includeToken`). */
    requests(includeToken?: boolean): FakeRequest[];
    /** `METHOD /path` 로 나간 요청. */
    requestsTo(key: string): FakeRequest[];
}

/**
 * 경로별 응답을 정한다. 키는 `METHOD /path`(`/api/v1` 부터)이고, 끝에 `*` 를 붙이면 접두어 일치다.
 * 값이 함수면 요청을 받아 응답을 만들고, `Error` 를 돌려주면 연결 오류로 실패한다. 라우트가 없는 요청은 연결 오류다.
 * 토큰 발급(`POST /oauth2/token`)은 `token` 이 없으면 기본 토큰으로 응답한다.
 */
export function installFakeToss(routes: Record<string, Route>, token: Route = tokenOk()): FakeToss {
    const seen: FakeRequest[] = [];
    const mock = vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const parsed = new URL(String(url));
        const method = init?.method ?? 'GET';
        const rawBody = init?.body;
        let body: Dict | undefined;
        if (rawBody !== undefined && rawBody.startsWith('{')) body = JSON.parse(rawBody) as Dict;
        const request: FakeRequest = {
            method,
            path: parsed.pathname,
            query: parsed.searchParams,
            headers: init?.headers ?? {},
            body,
            rawBody,
        };
        seen.push(request);
        const key = `${method} ${request.path}`;
        let route: Route | undefined = request.path === '/oauth2/token' ? token : routes[key];
        if (route === undefined) {
            for (const [pattern, candidate] of Object.entries(routes)) {
                if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) { route = candidate; break; }
            }
        }
        if (route === undefined) throw new TypeError(`unrouted: ${key}`);
        const reply = typeof route === 'function' ? route(request) : route;
        if (reply instanceof Error) throw reply;
        return toResponse(reply);
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    return {
        fetch: mock,
        requests: (includeToken = false) => seen.filter((r) => includeToken || r.path !== '/oauth2/token'),
        requestsTo: (key) => seen.filter((r) => `${r.method} ${r.path}` === key),
    };
}

/** 대기 없이 도는 토스 인스턴스. 체결 확정 조회 간격도 0 이다. */
export function makeToss(config: Dict = {}): toss {
    const { options, ...rest } = config;
    return new toss({ ...CREDS, enableRateLimit: false, ...rest, options: { confirmBudget: { intervalMs: 0 }, ...options } });
}

/** 연결이 끊긴 것처럼 실패시키는 오류(Node 의 `fetch failed` 모양). */
export function networkFailure(code: string): Error {
    return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}
