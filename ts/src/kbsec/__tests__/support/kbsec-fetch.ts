/**
 * @fileoverview KB증권 테스트용 가짜 서버 — `fetch` 목 하나에 토큰 발급과 TR 응답을 라우팅한다.
 *
 * 각 테스트 파일이 자기 `vi.hoisted` 로 만든 `mockFetch` 를 넘긴다. TR 응답은 TR 코드(대소문자 무관)를 키로 준다. 값이 문자열이면 업무 실패로 취급하고,
 * 객체면 `dataBody` 로 실은 성공 응답이다. 라우팅에 없는 TR 은 빈 성공 응답이다.
 */

import type { Mock } from 'vitest';

export const CREDS = { apiKey: 'kb-app-key-123456', secret: 'kb-secret' } as const;

interface MockResponse {
    ok: boolean;
    status: number;
    text: () => Promise<string>;
}

export function envelope(header: Record<string, unknown>, dataBody: unknown, status = 200): MockResponse {
    const text = JSON.stringify({ dataHeader: header, dataBody });
    return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/** 성공 응답. processFlag `A` 다(실측 규격). */
export const jsonOk = (dataBody: unknown): MockResponse =>
    envelope({ processFlag: 'A', processCode: '0011', processMessage: '정상적으로 조회되었습니다.' }, dataBody);

/** 업무 실패 응답. HTTP 200 인데 processFlag `B` 다. `resultCode`/`resultMessage` 는 실패해도 200/성공으로 온다. */
export const bizError = (processMessage: string, processCode = '9999'): MockResponse =>
    envelope({ resultCode: '200', resultMessage: '성공', processFlag: 'B', processCode, processMessage }, {});

export const tokenOk = (token = 'kb-token-1'): MockResponse =>
    envelope({ processFlag: 'A', processCode: '0000' }, { access_token: token, token_type: 'Bearer', expires_in: 86400 });

export type TrRoutes = Record<string, unknown | ((body: Record<string, unknown>) => unknown)>;

/** 토큰은 항상 성공시키고 TR 응답만 라우팅한다. */
export function routeTr(mockFetch: Mock, byTr: TrRoutes): void {
    const routes: Record<string, unknown> = {};
    for (const [tr, value] of Object.entries(byTr)) routes[tr.toLowerCase()] = value;
    mockFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
        const u = String(url);
        if (u.includes('/oauth2/token')) return tokenOk();
        const tr = u.split('/api/v1/')[1] ?? '';
        let value = routes[tr];
        if (typeof value === 'function') {
            const sent = init?.body !== undefined ? (JSON.parse(init.body) as { dataBody?: Record<string, unknown> }).dataBody ?? {} : {};
            value = (value as (b: Record<string, unknown>) => unknown)(sent);
        }
        if (typeof value === 'string') return bizError(value);
        if (tr in routes) return jsonOk(value);
        return jsonOk({});
    });
}

/** 지금까지 나간 TR 요청의 TR 코드(소문자)를 순서대로. */
export function calledTrs(mockFetch: Mock): string[] {
    return mockFetch.mock.calls
        .map(c => String(c[0]))
        .filter(u => u.includes('/api/v1/'))
        .map(u => u.split('/api/v1/')[1]!);
}

/** 특정 TR 호출의 요청 본문(마지막 호출). */
export function trBody(mockFetch: Mock, tr: string): { dataHeader: Record<string, unknown>; dataBody: Record<string, unknown> } {
    const calls = mockFetch.mock.calls.filter(c => String(c[0]).endsWith(`/api/v1/${tr.toLowerCase()}`));
    if (calls.length === 0) throw new Error(`${tr} 호출이 없다`);
    return JSON.parse((calls[calls.length - 1]![1] as { body: string }).body);
}

/** 특정 TR 호출의 요청 헤더(마지막 호출). */
export function trHeaders(mockFetch: Mock, tr: string): Record<string, string> {
    const calls = mockFetch.mock.calls.filter(c => String(c[0]).endsWith(`/api/v1/${tr.toLowerCase()}`));
    if (calls.length === 0) throw new Error(`${tr} 호출이 없다`);
    return (calls[calls.length - 1]![1] as { headers: Record<string, string> }).headers;
}
