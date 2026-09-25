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

/**
 * 장 시간 게이트를 시각으로 고정할 때 쓰는 시각. 2026-09-22(화)는 KRX 와 미국 모두 평일이다. 테스트는 `vi.useFakeTimers({ toFake: ['Date'] })` 를
 * 켠 뒤 `vi.setSystemTime` 으로 고정한다. 휴장일 캘린더는 모의투자에서 받지 않으므로 이 날은 열린 날로 본다.
 */
export const MARKET_TIMES = {
    /** 10:00 KST. KRX 정규장(NXT 메인마켓). */
    krxRegular: new Date('2026-09-22T01:00:00Z'),
    /** 15:25 KST. KRX 종가 동시호가(NXT 정지). */
    krxClosingAuction: new Date('2026-09-22T06:25:00Z'),
    /** 16:30 KST. KRX 는 닫혔고 NXT 애프터마켓이다. */
    nxtAfterMarket: new Date('2026-09-22T07:30:00Z'),
    /** 21:30 KST. KRX 와 NXT 모두 닫혔다. */
    krxClosed: new Date('2026-09-22T12:30:00Z'),
    /** 10:00 ET(서머타임). 미국 정규장. */
    usRegular: new Date('2026-09-22T14:00:00Z'),
    /** 15:55 ET. 미국 종가 동시호가. */
    usClosingAuction: new Date('2026-09-22T19:55:00Z'),
    /** 20:30 ET. 미국 정규장 밖. */
    usClosed: new Date('2026-09-23T00:30:00Z'),
} as const;

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
