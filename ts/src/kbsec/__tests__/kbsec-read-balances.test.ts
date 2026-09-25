/**
 * KB `fetchBalance()` — 잔고 조회가 **얼마나 완전했는지**를 `balances.info` 로 알린다.
 *
 * 배경: KB 는 해외 조회만 실패해도 국내 보유가 담긴 **비어 있지 않은 목록을 성공으로** 돌려줄 수 있다. 소비처가 그 목록에 없는 해외 종목을
 * 보유 0 으로 읽으면 오경보가 난다. 그래서 `info.readStatus`(`COMPLETE`/`PARTIAL`)와 `info.unreadMarkets` 가 그 구분을 값으로 전한다.
 * 예수금을 못 읽으면 던진다. 국내 보유를 다 읽지 못하면(계좌자산평가 실패 뒤 보유주식 폴백이 걸러지거나 비는 등) `unreadMarkets` 에 `KR` 이 들어간다.
 * 실패와 "없음"을 같은 값으로 돌려주지 않는다.
 *
 * 이 파일은 실제 `kbsec` 를 `fetch` 목킹으로 부른다. 판정 규칙을 로컬 함수로 복사해 검증하면 인스턴스 상태(래치·냉각·그리드 이력)를 볼 수 없다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { BadResponse } from '../../base/errors';
import type { Balances } from '../../base/types';

const CREDS = { appKey: 'kb-app-key-123456', appSecret: 'kb-secret' };

const OVERSEAS_OK = {
    Record1: [{ crncy_clsf_nm: 'USD', tfnd: '1000.00', ordr_psbl_amt_p2: '1000.00' }],
    Record2: [
        { is_cd: 'JNJ', is_nm: '존슨앤드존슨', frgn_hld_q_p6: '2', now_prc_p4: '366.0000', byng_avr_prc_p4: '365.8251' },
    ],
};
/** 국내 계좌자산평가(SSQM2952) — 삼성전자 10주. `ec_q` 가 실보유수량이다. */
const DOMESTIC_ASSET_EVAL = {
    Record2: [
        { is_cd: 'A005930', is_nm: '삼성전자', ec_q: '10', val_amt: '700000', now_prc: '70000', byng_avr_prc: '68000' },
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

/** ok=정상 그리드, empty=성공했지만 종목 그리드 없음, timeout=연결 타임아웃, business=권한 오류 */
type UsMode = 'ok' | 'empty' | 'timeout' | 'business';
let usMode: UsMode = 'ok';
let depositFails = false;
/** 예수금 TR 이 성공 플래그로 오지만 주문가능현금 필드가 없다. */
let depositMissingFields = false;
/** 국내 1순위 계좌자산평가(SSQM2952). ok=삼성전자 10주, alnum=삼성전자와 신형 영숫자 코드 ETF, empty=성공했지만 행 없음, timeout=연결 타임아웃 */
type AssetEvalMode = 'ok' | 'alnum' | 'codeless' | 'empty' | 'timeout';
let assetEvalMode: AssetEvalMode = 'ok';
/** 국내 폴백 보유주식(SSQM1801). none=0건, ok=삼성전자 10주, filtered=종목코드 없는 1행(전부 걸러짐), endless=연속조회가 끝나지 않음 */
type HoldingRowsMode = 'none' | 'ok' | 'filtered' | 'endless' | 'repeat';
let holdingRowsMode: HoldingRowsMode = 'none';
let holdingPage = 0;

const connectTimeout = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });

function route() {
    mockFetch.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/oauth2/token')) return tokenOk();
        const tr = u.split('/api/v1/')[1] ?? '';
        if (tr === KBSEC_TR.HOLDINGS_US.toLowerCase()) {
            if (usMode === 'timeout') {
                throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
            }
            if (usMode === 'business') return businessError();
            if (usMode === 'empty') return jsonOk({});
            return jsonOk(OVERSEAS_OK);
        }
        if (tr === KBSEC_TR.DEPOSIT.toLowerCase()) {
            if (depositFails) {
                throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
            }
            return jsonOk(depositMissingFields ? {} : { ordr_psbl_csh: '5000000' });
        }
        if (tr === KBSEC_TR.ASSET_EVAL.toLowerCase()) {
            if (assetEvalMode === 'timeout') throw connectTimeout();
            if (assetEvalMode === 'codeless') {
                return jsonOk({ Record2: [...DOMESTIC_ASSET_EVAL.Record2, { is_cd: '', is_nm: '', ec_q: '5', val_amt: '50000' }, { is_cd: '', is_nm: '합계', val_amt: '750000' }] });
            }
            if (assetEvalMode === 'alnum') {
                return jsonOk({ Record2: [...DOMESTIC_ASSET_EVAL.Record2, { is_cd: 'A0193L0', is_nm: '인버스2X', ec_q: '7', val_amt: '70000', now_prc: '10000' }] });
            }
            return jsonOk(assetEvalMode === 'empty' ? {} : DOMESTIC_ASSET_EVAL);
        }
        if (tr === KBSEC_TR.HOLDINGS.toLowerCase()) {
            if (holdingRowsMode === 'ok') return jsonOk({ Record2: [{ shrt_cd: '005930', is_nm: '삼성전자', gnrl_q: '10', ordr_psbl_q: '10' }] });
            if (holdingRowsMode === 'filtered') return jsonOk({ Record2: [{ is_nm: '합계', gnrl_q: '10', ordr_psbl_q: '10' }] });
            if (holdingRowsMode === 'repeat') {
                return jsonOk({ nxt_key: 'same', Record2: [{ shrt_cd: '005930', is_nm: '삼성전자', gnrl_q: '10', ordr_psbl_q: '10' }] });
            }
            if (holdingRowsMode === 'endless') {
                holdingPage++;
                return jsonOk({ nxt_key: `k${holdingPage}`, Record2: [{ shrt_cd: '005930', is_nm: '삼성전자', gnrl_q: '10', ordr_psbl_q: '10' }] });
            }
            return jsonOk({});
        }
        return jsonOk({});
    });
}

function makeService(): kbsec {
    return new kbsec({ apiKey: CREDS.appKey, secret: CREDS.appSecret, rateLimit: 0 });
}

const COOLDOWN_PASSED_MS = 6 * 60 * 1000;

beforeEach(() => {
    mockFetch.mockReset();
    usMode = 'ok';
    depositFails = false;
    depositMissingFields = false;
    assetEvalMode = 'ok';
    holdingRowsMode = 'none';
    holdingPage = 0;
    route();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
});
afterEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
});

const META_KEYS = new Set(['info', 'timestamp', 'datetime', 'free', 'used', 'total', 'debt']);
/** 잔고 항목의 키(통화와 종목코드). 요약 사전과 `info` 는 뺀다. */
const codesOf = (b: Balances): string[] => Object.keys(b).filter(k => !META_KEYS.has(k));

describe('KB fetchBalance — 완전성 상태', () => {
    it('국내와 해외를 모두 읽으면 COMPLETE 이고 읽지 못한 시장이 없다', async () => {
        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('COMPLETE');
        expect(b.info.unreadMarkets).toEqual([]);
        expect(codesOf(b)).toEqual(expect.arrayContaining(['005930', 'JNJ']));
    });

    it('해외 조회가 실패하면 PARTIAL 이다 — 국내 보유는 담기고, 해외 시장이 읽지 못한 시장으로 표시된다', async () => {
        usMode = 'timeout';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['US']);
        expect(codesOf(b)).toContain('005930');
        expect(codesOf(b)).not.toContain('JNJ');
    });

    it('해외 조회가 성공했어도 그리드를 한 번도 본 적이 없으면 PARTIAL 이다 — 빈 응답이 "없음" 인지 알 수 없다', async () => {
        usMode = 'empty';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['US']);
    });

    it('그리드를 본 뒤 해외 조회가 성공한 빈 응답이면 COMPLETE 이다 — 목록에 없는 종목은 확인된 미보유', async () => {
        const svc = makeService();
        await svc.fetchBalance(); // 그리드를 봤다
        usMode = 'empty';
        vi.setSystemTime(Date.now() + 1000);

        const b = await svc.fetchBalance();

        expect(b.info.readStatus).toBe('COMPLETE');
        expect(codesOf(b)).not.toContain('JNJ');
    });

    it('업무 오류(권한 없음)로 래치가 걸리면 냉각이 지나도 PARTIAL 로 남는다', async () => {
        const svc = makeService();
        await svc.fetchBalance();
        usMode = 'business';
        vi.setSystemTime(Date.now() + 1000);
        expect((await svc.fetchBalance()).info.readStatus).toBe('PARTIAL');

        usMode = 'ok'; // 회복돼도 영구 실패라 다시 부르지 않는다
        vi.setSystemTime(Date.now() + COOLDOWN_PASSED_MS);

        expect((await svc.fetchBalance()).info.readStatus).toBe('PARTIAL');
    });

    it('일시 오류는 냉각 뒤 다시 읽어 COMPLETE 로 회복한다', async () => {
        const svc = makeService();
        await svc.fetchBalance();
        usMode = 'timeout';
        vi.setSystemTime(Date.now() + 1000);
        expect((await svc.fetchBalance()).info.readStatus).toBe('PARTIAL');

        usMode = 'ok';
        vi.setSystemTime(Date.now() + COOLDOWN_PASSED_MS);

        expect((await svc.fetchBalance()).info.readStatus).toBe('COMPLETE');
    });

    it('예수금 조회가 실패하면 던진다 — 빈 잔고와 조회 실패를 같은 값으로 돌려주지 않는다', async () => {
        depositFails = true;

        await expect(makeService().fetchBalance()).rejects.toThrow();
    });

    it('★예수금 응답에 주문가능현금 필드가 없으면 원화 0 과 COMPLETE 가 아니라 BadResponse 로 던진다', async () => {
        depositMissingFields = true;

        await expect(makeService().fetchBalance()).rejects.toBeInstanceOf(BadResponse);
    });
});

describe('KB fetchBalance — 항목의 모양', () => {
    it('보유 종목의 total 은 수량이고, 평균 단가·평가금액·종목명·통화는 info 에 있다', async () => {
        const b = await makeService().fetchBalance();

        expect(b['005930'].total).toBe(10);
        expect(b['005930'].info).toEqual({ quoteCurrency: 'KRW', averagePrice: 68000, marketValue: 700000, name: '삼성전자' });
        expect(b['JNJ'].total).toBe(2);
        expect(b['JNJ'].info).toMatchObject({ quoteCurrency: 'USD', averagePrice: 365.8251, marketValue: 732, name: '존슨앤드존슨' });
    });

    it('현금은 통화 키다 — KRW 는 예수금 TR, USD 는 해외 잔고평가의 통화별 예수금 그리드에서 온다', async () => {
        const b = await makeService().fetchBalance();

        expect(b.KRW).toMatchObject({ free: 5_000_000, used: 0, total: 5_000_000 });
        // 주문가능금액이 매수여력이다. 예수금에서 주문가능금액을 뺀 만큼은 묶인 금액이다.
        expect(b.USD).toMatchObject({ free: 1000, used: 0, total: 1000 });
    });

    it('해외 예수금 그리드를 못 읽으면 USD 항목이 없다 — 0 이 아니라 모른다는 뜻이다', async () => {
        usMode = 'timeout';

        const b = await makeService().fetchBalance();

        expect(b.USD).toBeUndefined();
        expect(b.KRW.free).toBe(5_000_000);
    });

    it('USD 주문가능금액이 예수금보다 작으면 나머지는 used 다', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/token')) return tokenOk();
            const tr = u.split('/api/v1/')[1] ?? '';
            if (tr === KBSEC_TR.HOLDINGS_US.toLowerCase()) {
                return jsonOk({ Record1: [{ crncy_clsf_nm: 'USD', tfnd: '1000.00', ordr_psbl_amt_p2: '850.50' }], Record2: OVERSEAS_OK.Record2 });
            }
            if (tr === KBSEC_TR.DEPOSIT.toLowerCase()) return jsonOk({ ordr_psbl_csh: '5000000' });
            if (tr === KBSEC_TR.ASSET_EVAL.toLowerCase()) return jsonOk(DOMESTIC_ASSET_EVAL);
            return jsonOk({});
        });

        const b = await makeService().fetchBalance();

        expect(b.USD).toMatchObject({ free: 850.5, used: 149.5, total: 1000 });
    });
});

describe('KB fetchBalance — 국내 보유의 완전성', () => {
    it('계좌자산평가가 연결 타임아웃이고 보유주식 폴백이 1행을 주지만 전부 걸러지면 PARTIAL 이고 KR 을 못 읽은 시장으로 표시한다', async () => {
        assetEvalMode = 'timeout';
        holdingRowsMode = 'filtered';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['KR']);
        expect(codesOf(b)).not.toContain('005930');
        expect(codesOf(b)).toEqual(expect.arrayContaining(['KRW', 'JNJ']));
    });

    it('계좌자산평가가 실패해도 보유주식 폴백이 행을 읽으면 COMPLETE 다', async () => {
        assetEvalMode = 'timeout';
        holdingRowsMode = 'ok';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('COMPLETE');
        expect(b.info.unreadMarkets).toEqual([]);
        expect(codesOf(b)).toContain('005930');
    });

    it('계좌자산평가가 실패했는데 보유주식 폴백이 비면 "보유 없음"이라고 말할 근거가 없어 PARTIAL 이다', async () => {
        assetEvalMode = 'timeout';
        holdingRowsMode = 'none';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['KR']);
    });

    it('계좌자산평가가 성공했는데 행이 없고 보유주식도 비면 두 조회가 모두 "보유 없음"이라 COMPLETE 다', async () => {
        assetEvalMode = 'empty';
        holdingRowsMode = 'none';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('COMPLETE');
        expect(codesOf(b)).not.toContain('005930');
    });

    it('보유주식 연속조회가 상한에서 잘리면 PARTIAL 이다 — 잘린 뒤의 종목이 목록에서 빠진다', async () => {
        assetEvalMode = 'timeout';
        holdingRowsMode = 'endless';

        const b = await new kbsec({ apiKey: CREDS.appKey, secret: CREDS.appSecret, rateLimit: 0, options: { holdingsMaxPages: 2 } }).fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['KR']);
    });

    it('A 접두 신형 영숫자 코드(A0193L0)도 국내 보유로 담는다 — 해외로 분류해 건너뛰면 COMPLETE 인 채 보유가 빠진다', async () => {
        assetEvalMode = 'alnum';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('COMPLETE');
        expect(codesOf(b)).toEqual(expect.arrayContaining(['005930', '0193L0']));
        expect((b['0193L0'] as { total: number }).total).toBe(7);
    });

    it('★계좌자산평가에 종목코드 없이 수량이 있는 행이 있으면 그 보유를 잃은 것이라 PARTIAL 이다 — 합계 행(코드와 수량 모두 없음)은 세지 않는다', async () => {
        assetEvalMode = 'codeless';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['KR']);
        expect(codesOf(b)).toContain('005930');
    });

    it('보유주식 연속조회가 같은 다음키를 되풀이하면 끝까지 읽었는지 몰라 PARTIAL 이다', async () => {
        assetEvalMode = 'timeout';
        holdingRowsMode = 'repeat';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['KR']);
    });

    it('국내와 해외를 모두 못 읽으면 두 시장이 다 표시된다', async () => {
        assetEvalMode = 'timeout';
        holdingRowsMode = 'filtered';
        usMode = 'timeout';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['KR', 'US']);
    });
});
