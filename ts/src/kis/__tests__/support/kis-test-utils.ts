/**
 * @fileoverview `kis` 클래스 테스트 공용 도구. 가짜 `fetch` 응답과 테스트용 인스턴스를 만든다.
 */
import { kis } from '../../../kis';
import type { KisMasterData } from '../../kis-master-data';

/** 테스트 자격증명. 앱키 앞 12자가 토큰 저장소 키가 된다. */
export const CREDENTIALS = { apiKey: 'TEST-APPKEY-123456789', secret: 'test-app-secret', uid: '12345678-01' } as const;

/** 실제 `Response` 처럼 `text()` 를 가진 가짜 응답. 본문은 JSON 문자열이다. */
export function jsonResponse(body: unknown, status = 200) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        headers: new Headers(),
        text: async () => raw,
        json: async () => JSON.parse(raw),
    };
}

export const tokenOk = (token = 'tok') => jsonResponse({ access_token: token, token_type: 'Bearer', expires_in: 86400 });

/** KIS 정상 응답 봉투(`rt_cd=0`)에 `output*` 을 얹은 가짜 응답. */
export const dataOk = (payload: Record<string, unknown>) => jsonResponse({ rt_cd: '0', msg_cd: 'MCA00000', msg1: 'ok', ...payload });

/** KIS 업무 오류(`rt_cd=1`) 응답. 상태 코드를 주면 그 상태로 온다(초당 거래건수 초과는 500 으로 온다). */
export const businessError = (msgCd: string, msg1 = '오류', status = 200) => jsonResponse({ rt_cd: '1', msg_cd: msgCd, msg1 }, status);

/**
 * 테스트용 인스턴스. 기본은 모의투자에 유량 제한을 끈 상태다(모의는 호출 간격이 0.5초라 유량 제한을 켜 두면 테스트가 느려진다).
 * 재시도 간격도 1ms 로 줄인다.
 */
export function newKis(config: { sandbox?: boolean; rateLimit?: boolean; masterData?: KisMasterData; options?: Record<string, unknown> } = {}): kis {
    return new kis({
        ...CREDENTIALS,
        sandbox: config.sandbox ?? true,
        enableRateLimit: config.rateLimit ?? false,
        options: {
            maxRetriesOnFailureDelay: 1,
            ...(config.masterData !== undefined ? { masterData: config.masterData } : {}),
            ...config.options,
        },
    });
}

/** 데이터 호출 URL 목록(토큰 호출 제외). */
export function dataUrls(mockFetch: { mock: { calls: unknown[][] } }): string[] {
    return mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => !u.includes('/oauth2/'));
}

/** 호출 순번의 요청 헤더. */
export function headersOf(mockFetch: { mock: { calls: unknown[][] } }, index: number): Record<string, string> {
    return (mockFetch.mock.calls[index]![1] as { headers: Record<string, string> }).headers;
}

/** 호출 순번의 요청 본문(JSON). */
export function bodyOf(mockFetch: { mock: { calls: unknown[][] } }, index: number): Record<string, string> {
    return JSON.parse(String((mockFetch.mock.calls[index]![1] as { body: string }).body)) as Record<string, string>;
}
