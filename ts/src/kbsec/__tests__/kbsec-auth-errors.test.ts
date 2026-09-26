/**
 * 토큰 발급 실패 시 **어느 오류를 올려보내는가**.
 *
 * ## 왜 이걸 고정하나
 *
 * `issueToken` 은 `envelope` → `flat` 순으로 폴백한다. 종전에는 **마지막 시도의 오류만**
 * 던졌는데 그건 언제나 `flat` 이고, flat 은 API 문서가 "틀린 형태"로 확정한 쪽이라 서버가 늘
 * `E021 앱키로 앱정보 추출 중 오류` 를 준다. 즉 원인이 무엇이든 최종 오류는 **"키가
 * 이상하다"** 로 고정돼 올라왔다.
 *
 * 이 때문에 멀쩡한 키를 무효로 오진한 적이 있다. 진짜 원인은 envelope 응답에 있었다:
 * `processCode 9999 · "API 입력 전문에 정의되지 않은 필드입니다. [ordrCtnMtrCsntF]"`
 *
 * 그래서 **모든 형태의 오류를 모아** 던지고, 정답 형태(envelope)가 앞에 오게 한다.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { KbsecAuth } from '../kbsec-auth';
import { kbsec } from '../../kbsec';
import { AuthenticationError, ExchangeNotAvailable, NetworkError, RateLimitExceeded } from '../../base/errors';
import { __resetKbsecTokenBreaker } from '../../testing';

const CREDS = { appKey: 'AK', appSecret: 'AS' };

/** KB 응답을 흉내 내는 fetch mock — 형태별로 다른 본문을 돌려준다. */
function mockFetch(bodyFor: (shape: 'envelope' | 'flat') => { status: number; body: unknown }): void {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
        const sent = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        const shape = sent.dataBody ? 'envelope' : 'flat';
        const { status, body } = bodyFor(shape);
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => JSON.stringify(body),
        };
    }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('KbsecAuth 토큰 발급 오류 보고', () => {
    it('두 형태의 오류를 모두 담는다 — flat 의 E021 만 올라오면 키를 오진한다', async () => {
        // 실서버 응답 재현: envelope 는 HTTP 200 인데 토큰이 없고, flat 은 500 E021.
        mockFetch((shape) => (shape === 'envelope'
            ? {
                status: 200,
                body: {
                    dataHeader: {
                        processFlag: 'B', processCode: '9999',
                        processMessage: 'API 입력 전문에 정의되지 않은 필드입니다. [ordrCtnMtrCsntF]',
                    },
                    dataBody: { access_token: '', token_type: '', expires_in: 0 },
                },
            }
            : {
                status: 500,
                body: {
                    dataHeader: {
                        processFlag: 'B', processCode: 'E021',
                        processMessage: '앱키로 앱정보 추출 중 오류가 발생했습니다.',
                    },
                    dataBody: { access_token: '', token_type: '', expires_in: 0 },
                },
            }));

        const auth = new KbsecAuth(CREDS);
        await expect(auth.getAccessToken()).rejects.toThrow(/ordrCtnMtrCsntF/);

        // 두 형태가 모두 보고돼야 한다 — 하나만 보이면 진단이 한쪽으로 치우친다.
        const msg = await auth.getAccessToken().then(
            () => '',
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        expect(msg).toContain('envelope');
        expect(msg).toContain('flat');
        expect(msg).toContain('E021');
        // 정답 형태가 먼저 나와야 진단 우선순위가 맞다.
        expect(msg.indexOf('envelope')).toBeLessThan(msg.indexOf('flat'));
    });

    it('envelope 이 성공하면 flat 은 시도하지 않는다', async () => {
        mockFetch(() => ({
            status: 200,
            body: {
                dataHeader: { processFlag: 'A', processCode: '0000' },
                dataBody: { access_token: 'TOK', token_type: 'Bearer', expires_in: 86400 },
            },
        }));

        const auth = new KbsecAuth(CREDS);
        await expect(auth.getAccessToken()).resolves.toBe('TOK');
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
});

describe('KbsecAuth 토큰 발급 실패의 brokerCode', () => {
    const envelopeOf = (code: string, message: string) => ({
        dataHeader: { processFlag: 'B', processCode: code, processMessage: message },
        dataBody: { access_token: '', token_type: '', expires_in: 0 },
    });

    it('비공개 호출의 토큰 발급 실패는 첫 형태(envelope)의 업무 코드를 brokerCode 에 싣고 detail 은 비운다', async () => {
        __resetKbsecTokenBreaker();
        // 실서버 응답 재현: envelope 는 HTTP 200 과 빈 토큰(9999), flat 은 500 E021.
        mockFetch((shape) => (shape === 'envelope'
            ? { status: 200, body: envelopeOf('9999', 'API 입력 전문에 정의되지 않은 필드입니다.') }
            : { status: 500, body: envelopeOf('E021', '앱키로 앱정보 추출 중 오류가 발생했습니다.') }));

        const error = await new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0 }).privatePostSsqm0004({}).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).brokerCode).toBe('9999');
        expect((error as AuthenticationError).detail).toBeUndefined();
    });

    it('HTTP 500 봉투의 업무 코드(E021)도 brokerCode 에 싣는다', async () => {
        mockFetch(() => ({ status: 500, body: envelopeOf('E021', '앱키로 앱정보 추출 중 오류가 발생했습니다.') }));

        const error = await new KbsecAuth(CREDS).getAccessToken().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).brokerCode).toBe('E021');
    });

    it('첫 형태의 응답에 업무 코드가 없으면 flat 의 E021 을 싣지 않고 비운다', async () => {
        mockFetch((shape) => (shape === 'envelope'
            ? { status: 403, body: '<html>Forbidden</html>' }
            : { status: 500, body: envelopeOf('E021', '앱키로 앱정보 추출 중 오류가 발생했습니다.') }));

        const error = await new KbsecAuth(CREDS).getAccessToken().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).brokerCode).toBeUndefined();
        expect(String((error as Error).message)).toContain('E021');
    });
});

describe('KbsecAuth 토큰 발급의 일시 장애', () => {
    const e021 = {
        dataHeader: { processFlag: 'B', processCode: 'E021', processMessage: '앱키로 앱정보 추출 중 오류가 발생했습니다.' },
        dataBody: { access_token: '', token_type: '', expires_in: 0 },
    };

    it('연결이 실패하면 NetworkError 이고, 다른 본문 형태로 다시 보내지 않는다', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

        const error = await new KbsecAuth(CREDS).getAccessToken().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(NetworkError);
        expect(String((error as Error).message)).toContain('oauth2/token:envelope');
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('업무 코드가 없는 5xx 는 ExchangeNotAvailable, 429 는 RateLimitExceeded 이고 한 번만 보낸다', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '<html>Service Unavailable</html>' })));
        await expect(new KbsecAuth(CREDS).getAccessToken()).rejects.toBeInstanceOf(ExchangeNotAvailable);
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, text: async () => '' })));
        await expect(new KbsecAuth(CREDS).getAccessToken()).rejects.toBeInstanceOf(RateLimitExceeded);
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('HTTP 500 이어도 봉투에 업무 코드(E021)가 있으면 일시 장애가 아니고 두 형태를 모두 시도한다', async () => {
        mockFetch(() => ({ status: 500, body: e021 }));

        const error = await new KbsecAuth(CREDS).getAccessToken().catch((e: unknown) => e);

        expect(error).not.toBeInstanceOf(NetworkError);
        expect(String((error as Error).message)).toContain('E021');
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it('비공개 호출은 토큰 요청의 연결 실패를 AuthenticationError 가 아니라 NetworkError 로 받는다', async () => {
        __resetKbsecTokenBreaker();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

        const error = await new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0 }).privatePostSsqm0004({}).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(AuthenticationError);
    });
});
