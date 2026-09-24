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
import { KBSecAuth } from '../kbsec-auth';

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

describe('KBSecAuth 토큰 발급 오류 보고', () => {
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

        const auth = new KBSecAuth(CREDS);
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

        const auth = new KBSecAuth(CREDS);
        await expect(auth.getAccessToken()).resolves.toBe('TOK');
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
});
