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
import { logger } from '../../logger';

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

/** ok=정상 그리드, empty=성공했지만 배열이 없음, timeout=연결 타임아웃, business=권한 오류. 나머지는 `US_BODIES` 의 응답이다. */
type UsMode = 'ok' | 'empty' | 'timeout' | 'business' | keyof typeof US_BODIES;

const CASH_GRID = OVERSEAS_OK.Record1;
/** 해외 잔고평가(SPQM2226)가 성공으로 주는 응답 모양들. 모두 해외 보유 행을 읽을 수 있는지가 판정을 가른다. */
const US_BODIES = {
    /** 보유 0 건. 예수금 그리드만 온다 */
    cashOnly: { Record1: CASH_GRID },
    /** 보유 0 건. 종목 그리드가 빈 행 50개를 싣고 온다 */
    blankRows: {
        Record1: CASH_GRID,
        Record2: Array.from({ length: 50 }, () => ({ is_cd: '', is_nm: '', frgn_hld_q_p6: '', now_prc_p4: '', byng_avr_prc_p4: '' })),
    },
    /** 수량이 숫자 0 인 종목 행. 보유 0 이다 */
    zeroQuantity: { Record1: CASH_GRID, Record2: [{ is_cd: 'JNJ', is_nm: '존슨앤드존슨', frgn_hld_q_p6: '0', now_prc_p4: '366.0000' }] },
    /** 종목 그리드의 종목코드와 수량 필드 이름이 모두 어긋났다. 고를 수 없는 배열이다 */
    renamedGrid: { Record1: CASH_GRID, Record2: [{ shrt_is_cd: 'JNJ', is_nm: '존슨앤드존슨', hld_q_p6: '2' }] },
    /** 종목코드는 맞고 수량 필드 이름만 어긋났다 */
    renamedQuantity: { Record1: CASH_GRID, Record2: [{ is_cd: 'JNJ', is_nm: '존슨앤드존슨', hld_q_p6: '2', now_prc_p4: '366.0000' }] },
    /** 예수금 그리드 없이, 종목코드 이름이 어긋난 종목 그리드만 온다. 종목 그리드에도 통화구분명이 있다 */
    renamedCodeNoCash: { Record2: [{ mkt_clsf_nm: '나스닥', crncy_clsf_nm: 'USD', shrt_is_cd: 'JNJ', hld_q_p6: '2' }] },
    /** 종목 그리드가 객체 안에 들어 있다 */
    nestedGrid: { Record1: CASH_GRID, Output2: { grid: [{ shrt_is_cd: 'JNJ', hld_q_p6: '2' }] } },
};
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
            if (usMode !== 'ok') return jsonOk(US_BODIES[usMode]);
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

    // 해외 보유 조회(SPQM2226)는 그리드를 알아보지 못하면 조용히 빈 배열을 준다. 이것을 보유 0 으로 읽어 살아 있는 포지션을
    // 외부 청산으로 처리한 사고가 있었다.
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

// 해외 보유가 0 건인 계좌는 종목 행을 한 번도 받지 못한다. 그래도 응답 모양을 알아봤으면 "보유 없음"을 읽은 것이다. 반대로 알아보지 못한
// 배열이나 읽지 못한 보유 행이 있으면, 이름이 어긋난 종목 그리드를 "보유 없음"으로 읽지 않도록 못 읽은 것으로 둔다.
describe('KB fetchBalance — 해외 보유 0 건과 응답 모양', () => {
    const warnMessages = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map((c) => [c[0], String(c[1])] as const);

    it('보유 0 건이고 예수금 그리드만 오면 처음 부른 인스턴스에서도 해외를 읽은 것이다', async () => {
        usMode = 'cashOnly';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('COMPLETE');
        expect(b.info.unreadMarkets).not.toContain('US');
        expect(b.USD).toMatchObject({ free: 1000, total: 1000 });
    });

    it('종목 그리드가 빈 행만 담아 와도 읽은 것이다 — 필드 이름으로 종목 그리드를 골랐다', async () => {
        usMode = 'blankRows';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('COMPLETE');
        expect(codesOf(b)).toEqual(expect.arrayContaining(['KRW', 'USD', '005930']));
        expect(codesOf(b)).toHaveLength(3);
    });

    it('종목 행의 수량이 숫자 0 이면 보유 0 이고 읽은 것이다', async () => {
        usMode = 'zeroQuantity';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('COMPLETE');
        expect(codesOf(b)).not.toContain('JNJ');
    });

    it('알아보지 못한 배열이 있으면 못 읽은 것이고, 그 배열의 필드 이름을 경고로 남긴다', async () => {
        usMode = 'renamedGrid';
        const warn = vi.spyOn(logger, 'warn');

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['US']);
        const logged = warnMessages(warn).find(([, message]) => message.includes('알아보지 못한 배열'));
        expect(logged?.[0]).toMatchObject({ unknownArrays: [{ len: 1, keys: ['shrt_is_cd', 'is_nm', 'hld_q_p6'] }] });
        warn.mockRestore();
    });

    it('★종목코드는 있는데 수량 필드를 읽지 못한 행이 있으면 못 읽은 것이다 — 수량 필드 이름이 어긋나도 보유 0 건이 되지 않는다', async () => {
        usMode = 'renamedQuantity';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['US']);
    });

    it('★통화구분명만으로는 예수금 그리드라고 보지 않는다 — 종목코드 이름이 어긋난 종목 그리드만 오면 못 읽은 것이다', async () => {
        usMode = 'renamedCodeNoCash';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['US']);
        // 종목 그리드의 `crncy_clsf_nm: 'USD'` 행을 예수금으로 읽어 달러 잔고를 0 으로 싣지 않는다. 모르는 현금은 비운다.
        expect(b.USD).toBeUndefined();
    });

    it('★객체 안에 든 배열도 알아보지 못한 배열로 센다', async () => {
        usMode = 'nestedGrid';

        const b = await makeService().fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['US']);
    });

    it('★보유 행을 읽은 뒤라도 알아보지 못한 배열이 오면 못 읽은 것이다 — 이력이 이름 불일치를 덮지 않는다', async () => {
        const svc = makeService();
        expect((await svc.fetchBalance()).info.readStatus).toBe('COMPLETE'); // 보유 행을 읽었다
        usMode = 'renamedGrid';
        vi.setSystemTime(Date.now() + 1000);

        const b = await svc.fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['US']);
        expect(codesOf(b)).not.toContain('JNJ');
    });

    it('예수금 그리드만 와서 읽은 뒤에 조회가 실패하면 못 읽은 것이다', async () => {
        const svc = makeService();
        usMode = 'cashOnly';
        expect((await svc.fetchBalance()).info.readStatus).toBe('COMPLETE');
        usMode = 'timeout';
        vi.setSystemTime(Date.now() + 1000);

        const b = await svc.fetchBalance();

        expect(b.info.readStatus).toBe('PARTIAL');
        expect(b.info.unreadMarkets).toEqual(['US']);
        expect(b.USD).toBeUndefined();
    });
});

describe('KB fetchBalance — 항목의 모양', () => {
    it('보유 종목의 total 은 수량이고, 평균 단가·평가금액·종목명·통화는 info 에 있다', async () => {
        const b = await makeService().fetchBalance();

        expect(b['005930']!.total).toBe(10);
        expect(b['005930']!.info).toEqual({ quoteCurrency: 'KRW', averagePrice: 68000, marketValue: 700000, name: '삼성전자' });
        expect(b['JNJ']!.total).toBe(2);
        expect(b['JNJ']!.info).toMatchObject({ quoteCurrency: 'USD', averagePrice: 365.8251, marketValue: 732, name: '존슨앤드존슨' });
    });

    it('현금은 통화 키다 — KRW 는 예수금 TR, USD 는 해외 잔고평가의 통화별 예수금 그리드에서 온다', async () => {
        const b = await makeService().fetchBalance();

        // 예수금 TR 의 어느 필드가 계좌 현금인지 모른다. 주문가능현금만 free 로 싣는다.
        expect(b.KRW).toMatchObject({ free: 5_000_000, used: undefined, total: undefined });
        // 주문가능금액이 매수여력이다. 예수금에서 주문가능금액을 뺀 만큼은 묶인 금액이다.
        expect(b.USD).toMatchObject({ free: 1000, used: 0, total: 1000 });
    });

    it('해외 예수금 그리드를 못 읽으면 USD 항목이 없다 — 0 이 아니라 모른다는 뜻이다', async () => {
        usMode = 'timeout';

        const b = await makeService().fetchBalance();

        expect(b.USD).toBeUndefined();
        expect(b.KRW!.free).toBe(5_000_000);
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

    /** 예수금·해외 잔고평가는 기본 응답이고, 국내 보유 두 TR 과 해외 예수금 그리드만 바꾼다. */
    const routeWith = (routes: { assetEval?: unknown; holdings?: unknown; usdCash?: Record<string, string> }) => {
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/token')) return tokenOk();
            const tr = u.split('/api/v1/')[1] ?? '';
            if (tr === KBSEC_TR.HOLDINGS_US.toLowerCase()) {
                return jsonOk({ Record1: [routes.usdCash ?? OVERSEAS_OK.Record1[0]], Record2: OVERSEAS_OK.Record2 });
            }
            if (tr === KBSEC_TR.DEPOSIT.toLowerCase()) return jsonOk({ ordr_psbl_csh: '5000000' });
            if (tr === KBSEC_TR.ASSET_EVAL.toLowerCase()) {
                if (routes.assetEval === undefined) throw connectTimeout();
                return jsonOk(routes.assetEval);
            }
            if (tr === KBSEC_TR.HOLDINGS.toLowerCase() && routes.holdings !== undefined) return jsonOk(routes.holdings);
            return jsonOk({});
        });
    };

    it('국내 보유의 free 는 주문가능수량(ordr_psbl_q)이고 used 는 total − free 다. 해외 보유는 매도 가능 수량을 읽지 않아 free 가 비어 있다', async () => {
        routeWith({ assetEval: { Record2: [{ ...DOMESTIC_ASSET_EVAL.Record2[0], ordr_psbl_q: '8' }] } });

        const b = await makeService().fetchBalance();

        expect(b['005930']).toMatchObject({ free: 8, used: 2, total: 10 });
        expect(b.JNJ).toMatchObject({ free: undefined, used: undefined, total: 2 });
    });

    it('계좌자산평가 행에 주문가능수량이 없으면 free 를 보유 수량으로 채우지 않고 비운다', async () => {
        const b = await makeService().fetchBalance();

        expect(b['005930']).toMatchObject({ free: undefined, used: undefined, total: 10 });
    });

    it('보유주식 폴백 경로에서도 free 는 주문가능수량이다', async () => {
        routeWith({ holdings: { Record2: [{ shrt_cd: '005930', is_nm: '삼성전자', gnrl_q: '10', ordr_psbl_q: '7' }] } });

        const b = await makeService().fetchBalance();

        expect(b['005930']).toMatchObject({ free: 7, used: 3, total: 10 });
    });

    it('USD 주문가능금액이 예수금보다 크면 예수금을 정산 뒤 현금으로 볼 수 없어 total 과 used 를 비운다', async () => {
        routeWith({ assetEval: DOMESTIC_ASSET_EVAL, usdCash: { crncy_clsf_nm: 'USD', tfnd: '1000.00', ordr_psbl_amt_p2: '1200.00' } });

        const b = await makeService().fetchBalance();

        expect(b.USD).toMatchObject({ free: 1200, used: undefined, total: undefined });
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

describe('KB fetchBalance — 달러 예수금 행', () => {
    it('예수금 그리드에 USD 행이 없으면 받은 통화구분명 목록을 경고로 남긴다. 금액은 남기지 않는다', async () => {
        const warn = vi.spyOn(logger, 'warn');
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/token')) return tokenOk();
            const tr = u.split('/api/v1/')[1] ?? '';
            if (tr === KBSEC_TR.HOLDINGS_US.toLowerCase()) {
                return jsonOk({
                    Record1: [
                        { crncy_clsf_nm: '미국달러', tfnd: '1234.56', ordr_psbl_amt_p2: '1234.56' },
                        { crncy_clsf_nm: '홍콩달러', tfnd: '78.90', ordr_psbl_amt_p2: '78.90' },
                    ],
                    Record2: OVERSEAS_OK.Record2,
                });
            }
            if (tr === KBSEC_TR.DEPOSIT.toLowerCase()) return jsonOk({ ordr_psbl_csh: '5000000' });
            if (tr === KBSEC_TR.ASSET_EVAL.toLowerCase()) return jsonOk(DOMESTIC_ASSET_EVAL);
            return jsonOk({});
        });

        const b = await makeService().fetchBalance();

        // 매칭 규칙은 그대로다. USD 행을 못 찾으면 USD 항목이 없다.
        expect(b.USD).toBeUndefined();
        const logged = warn.mock.calls.filter((c) => String(c[1]).includes('USD 행이 없다'));
        expect(logged).toHaveLength(1);
        expect(logged[0]![0]).toMatchObject({ currencyNames: ['미국달러', '홍콩달러'] });
        const text = JSON.stringify(logged[0]![0]);
        expect(text).not.toContain('1234');
        expect(text).not.toContain('78.9');
        warn.mockRestore();
    });

    it('USD 행이 있으면 통화구분명 경고를 남기지 않는다', async () => {
        const warn = vi.spyOn(logger, 'warn');

        const b = await makeService().fetchBalance();

        expect(b.USD).toMatchObject({ free: 1000, total: 1000 });
        expect(warn.mock.calls.filter((c) => String(c[1]).includes('USD 행이 없다'))).toHaveLength(0);
        warn.mockRestore();
    });
});
