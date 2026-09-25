/**
 * KB 해외 보유 조회가 **일시적으로** 실패해도 "보유 0" 으로 읽히지 않고, 프로세스를 재시작하지 않아도 회복한다.
 *
 * 사고 배경 — KB 해외 잔고 TR 이 연결 타임아웃으로 한 번 실패했다. 종전 코드는 "우리 쪽
 * 데드라인 오류가 아니면 영구 실패" 라는 부정형으로 판정해 이 일시 오류에도 **영구 래치**를 걸었고, 그 뒤
 * `[]` 만 돌려줬다. 한편 `getBalance` 는 "그리드를 한 번이라도 봤는가"(`overseasGridSeen`, 이력)만 보고
 * 미보유 0 을 확정했다. 이력은 그 뒤 조회가 실패해도 참으로 남아, 보유 중인 미국 종목이 전부 "잔고 소멸
 * 의심" 경보를 냈다(실제로 소멸한 종목은 없었으므로 전부 오경보였다).
 *
 * 이 파일은 **실제 `kbsec`** 를 fetch mock 으로 호출한다. 판정 규칙을 로컬 함수로 복사해 검증하는
 * 방식(`kbsec-absent-market.test.ts`)은 어댑터의 상태(래치·냉각·실패 표시)를 볼 수 없어 이 결함을 못 잡는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';

const CREDS = { appKey: 'kb-app-key-123456', appSecret: 'kb-secret' };

const OVERSEAS_OK = {
    Record1: [{ crncy_clsf_nm: 'USD', tfnd: '1000.00', ordr_psbl_amt_p2: '1000.00' }],
    Record2: [
        { is_cd: 'JNJ', is_nm: '존슨앤드존슨', frgn_hld_q_p6: '2', now_prc_p4: '366.0000', byng_avr_prc_p4: '365.8251' },
    ],
};

const envelope = (header: Record<string, unknown>, body: unknown) => {
    const text = JSON.stringify({ dataHeader: header, dataBody: body });
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};
const jsonOk = (body: unknown) => envelope({ resultCode: '00000', processFlag: 'A', processCode: '0011' }, body);
const businessError = () => envelope(
    { processFlag: 'B', processCode: 'I446', processMessage: 'API 사용 권한이 없습니다.' }, {});
const tokenOk = () => {
    const text = '{"access_token":"tok","expires_in":86400}';
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};

type UsMode = 'ok' | 'timeout' | 'business';
let usMode: UsMode = 'ok';

function route() {
    mockFetch.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/oauth2/token')) return tokenOk();
        const tr = u.split('/api/v1/')[1] ?? '';
        if (tr === KBSEC_TR.HOLDINGS_US.toLowerCase()) {
            if (usMode === 'timeout') {
                // undici 의 연결 타임아웃 — 우리 쪽 시간 상한 오류(`RequestTimeout`)가 아니다.
                throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
            }
            if (usMode === 'business') return businessError();
            return jsonOk(OVERSEAS_OK);
        }
        if (tr === KBSEC_TR.DEPOSIT.toLowerCase()) return jsonOk({ ordr_psbl_csh: '5000000' });
        return jsonOk({});   // 국내 보유 등 — 빈 응답(국내 빈 응답은 신뢰할 수 있는 "없음")
    });
}

const usCalls = () => mockFetch.mock.calls
    .filter(c => String(c[0]).endsWith(`/api/v1/${KBSEC_TR.HOLDINGS_US.toLowerCase()}`)).length;

function makeService(): kbsec {
    return new kbsec({ apiKey: CREDS.appKey, secret: CREDS.appSecret, rateLimit: 0 });
}

const COOLDOWN_PASSED_MS = 6 * 60 * 1000;   // 냉각 5분을 넘긴다

beforeEach(() => {
    mockFetch.mockReset();
    usMode = 'ok';
    route();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T21:10:00Z'));
});
afterEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
});

describe('KB 해외 보유 조회 — 일시 오류', () => {
    it('사고 재현 — 그리드를 본 뒤 해외 조회가 연결 타임아웃으로 실패하면 미보유가 아니라 PARTIAL(해외 미확인)이다', async () => {
        const svc = makeService();
        const first = await svc.fetchBalance();
        expect(first.JNJ!.total).toBe(2); // 그리드를 봤다(이력)
        expect(first.info.readStatus).toBe('COMPLETE');

        usMode = 'timeout';
        vi.setSystemTime(Date.now() + 1000);
        const failed = await svc.fetchBalance();

        // 목록에 없는 종목 — 종전에는 이력만 보고 확인된 미보유로 읽었다. 방금까지 목록에 있던 종목도 지금 못 읽는 것이지 사라진 것이 아니다.
        expect(failed.info.readStatus).toBe('PARTIAL');
        expect(failed.info.unreadMarkets).toEqual(['US']);
        expect(failed.JNJ).toBeUndefined();
        expect(failed.USD).toBeUndefined();
    });

    it('국내는 영향 없다 — 해외 조회 실패 중에도 국내는 읽은 시장이다', async () => {
        const svc = makeService();
        await svc.fetchBalance();
        usMode = 'timeout';
        vi.setSystemTime(Date.now() + 1000);

        const b = await svc.fetchBalance();

        expect(b.info.unreadMarkets).toEqual(['US']); // 국내는 미확인 시장에 없다
        expect(b.KRW!.free).toBe(5_000_000);
    });

    it('일시 오류는 영구 래치를 걸지 않는다 — 냉각이 지나면 다시 부르고, 성공하면 자가 치유된다', async () => {
        const svc = makeService();
        await svc.fetchBalance();
        usMode = 'timeout';
        vi.setSystemTime(Date.now() + 1000);
        expect((await svc.fetchBalance()).info.readStatus).toBe('PARTIAL');

        usMode = 'ok';
        vi.setSystemTime(Date.now() + COOLDOWN_PASSED_MS);
        const recovered = await svc.fetchBalance();
        const again = await svc.fetchBalance();

        expect(recovered.info.readStatus).toBe('COMPLETE'); // 조회가 됐다 — 목록에 없으면 확인된 미보유
        expect(recovered.JNJ!.total).toBe(2);
        expect(again.JNJ!.total).toBe(2);
        // 성공, 실패, 회복, 이어진 조회. 성공한 뒤에는 냉각이 없어 조회마다 다시 부른다.
        expect(usCalls()).toBe(4);
    });

    it('냉각 중에는 다시 부르지 않는다 — 잔고 조회가 반복돼도 실패가 곱해지지 않는다', async () => {
        const svc = makeService();
        usMode = 'timeout';

        await svc.fetchBalance();
        await svc.fetchBalance();
        await svc.fetchBalance();

        expect(usCalls()).toBe(1);
    });
});

describe('KB 해외 보유 조회 — 영구 오류', () => {
    it('업무 오류(권한 없음)는 래치한다 — 냉각이 지나도 다시 부르지 않고, 그동안 PARTIAL 이다', async () => {
        const svc = makeService();
        await svc.fetchBalance(); // 그리드를 봤다
        usMode = 'business';
        vi.setSystemTime(Date.now() + 1000);

        expect((await svc.fetchBalance()).info.readStatus).toBe('PARTIAL');
        const callsAfterLatch = usCalls();

        vi.setSystemTime(Date.now() + COOLDOWN_PASSED_MS);
        expect((await svc.fetchBalance()).info.readStatus).toBe('PARTIAL');
        expect(usCalls()).toBe(callsAfterLatch); // 영구 실패라 재시도하지 않는다(계정 제한 방지)
    });
});
