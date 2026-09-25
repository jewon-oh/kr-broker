/**
 * @fileoverview KB 정산 조회(`fetchDomesticSettlements` `SSQM2121`, `fetchOverseasSettlements` `SPQM2205`)의 연속조회와 실패 분기.
 *
 * - 다음키를 따라 끝까지 읽는다. 같은 키가 또 오면 그 페이지를 버리고 `truncated` 로 표시한다(담으면 비용이 두 번 들어간다).
 * - 페이지 상한(`options.settlementMaxPages`)에 걸리면 `truncated` 다.
 * - 조회 실패는 빈 배열이 아니라 `{ ok: false }` 다. 빈 배열로 삼키면 호출하는 쪽이 "그날 매매가 없었다"로 읽는다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';

type Body = Record<string, string>;
const ok = (body: unknown) => {
    const text = JSON.stringify({ dataHeader: { processFlag: 'A', processCode: '0011' }, dataBody: body });
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};
const tokenOk = () => ({ ok: true, status: 200, text: async () => '{"access_token":"tok","expires_in":86400}' });

/** TR 코드별 응답 함수를 받아 가짜 서버를 세우고, TR 마다 받은 요청 본문을 모은다. */
function serve(routes: Record<string, (body: Body) => unknown>): Record<string, Body[]> {
    const seen: Record<string, Body[]> = {};
    mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
        if (String(url).includes('/oauth2/token')) return tokenOk();
        const tr = String(url).split('/').pop()!.toUpperCase();
        const body = JSON.parse(init.body).dataBody as Body;
        (seen[tr] ??= []).push(body);
        const route = routes[tr];
        return route === undefined ? ok({}) : route(body);
    });
    return seen;
}

const newExchange = (options: Record<string, unknown> = {}) =>
    new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0, options });

/** `거래금액 − 수수료 − 세금 = 정산금액` 이 맞는 국내 매도 행. 종목코드만 바꿔 쓴다. */
const krRow = (code: string) => ({
    is_no: `A${code}`, is_nm: '종목', trd_clsf: '매도', dl_clsf: '현금매도',
    ccls_q: '38', tl_ccls_q: '38', ccls_uprc: '55100',
    dl_amt: '2093800', fee: '200', dl_tx: '1046', ffs_tx: '3140',
    incm_tx: '0', rsdnt_tx: '0', ec_amt: '2089414',
    fncng_amt: '0', rfnd_amt: '0', krx_ccls_amt: '2093800', nxtd_ccls_amt: '0',
});

/** `|약정 − 정산| = 수수료` 가 맞는 해외 매수 행. 종목만 바꿔 쓴다. */
const usRow = (symbol: string) => ({
    ordr_dt: '20260123', stmt_dt: '20260127', shrt_is_cd: symbol, shrt_is_nm: '종목',
    trd_clsf_nm: '매수', etc_trd_ccd: '02', crncy_cd: 'USD', frgn_krx_ccd: 'US',
    stmt_q_p6: '00000016.000000', frgn_stmt_prc_p6: '00000063.825625',
    frgn_agr_amt_p4: '0000001021.2100', frgn_trd_fee_p4: '0000000002.5500',
    frgn_dl_tx_p4: '0000000000.0000', ptp_tx_amt: '0.000000',
    frgn_stmt_amt_p4: '0000001023.7600', stmt_amt_p4: '0000001023.7600',
});

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('국내 정산(SSQM2121)', () => {
    it('매도와 매수를 따로 부르고, 다음키를 따라 둘째 쪽까지 읽는다', async () => {
        const seen = serve({
            [KBSEC_TR.SETTLEMENT_KR]: (b) => {
                if (b.trd_clsf === '2') return ok({ nxt_key: '', Record1: [] });
                return b.nxt_key === '' ? ok({ nxt_key: 'K2', Record1: [krRow('035420')] }) : ok({ nxt_key: '   ', Record1: [krRow('005930')] });
            },
        });

        const result = await newExchange().fetchDomesticSettlements('20260923');

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows.map((r) => r.symbol)).toEqual(['035420', '005930']);
        expect(result.truncated).toBe(false);
        expect(seen[KBSEC_TR.SETTLEMENT_KR].map((b) => [b.trd_clsf, b.nxt_key])).toEqual([['1', ''], ['1', 'K2'], ['2', '']]);
    });

    it('같은 다음키가 또 오면 그 페이지를 버리고 잘렸다고 표시한다', async () => {
        serve({
            [KBSEC_TR.SETTLEMENT_KR]: (b) => (b.trd_clsf === '2' ? ok({ nxt_key: '', Record1: [] }) : ok({ nxt_key: 'K2', Record1: [krRow('035420')] })),
        });

        const result = await newExchange().fetchDomesticSettlements('20260923');

        expect(result.ok && result.truncated).toBe(true);
        expect(result.ok && result.rows.map((r) => r.symbol)).toEqual(['035420']);
    });

    it('페이지 상한에 걸리면 잘렸다고 표시한다', async () => {
        const seen = serve({
            [KBSEC_TR.SETTLEMENT_KR]: (b) => (b.trd_clsf === '2'
                ? ok({ nxt_key: '', Record1: [] })
                : ok({ nxt_key: `K${Number(b.nxt_key.slice(1) || 0) + 1}`, Record1: [krRow('035420')] })),
        });

        const result = await newExchange({ settlementMaxPages: 2 }).fetchDomesticSettlements('20260923');

        expect(result.ok && result.truncated).toBe(true);
        expect(seen[KBSEC_TR.SETTLEMENT_KR].filter((b) => b.trd_clsf === '1')).toHaveLength(2);
    });

    it('조회가 실패하면 빈 배열이 아니라 ok: false 를 돌려주고 던지지 않는다', async () => {
        serve({
            [KBSEC_TR.SETTLEMENT_KR]: (b) => {
                if (b.trd_clsf === '2') throw new TypeError('fetch failed');
                return ok({ nxt_key: '', Record1: [krRow('035420')] });
            },
        });

        const result = await newExchange().fetchDomesticSettlements('20260923');

        expect(result.ok).toBe(false);
    });
});

describe('해외 정산(SPQM2205)', () => {
    it('다음키를 따라 둘째 쪽까지 읽는다', async () => {
        const seen = serve({
            [KBSEC_TR.SETTLEMENT_US]: (b) => (b.nxt_key === ''
                ? ok({ nxt_key: 'K2', Record1: [usRow('KO')] })
                : ok({ nxt_key: '', Record1: [usRow('JNJ')] })),
        });

        const result = await newExchange().fetchOverseasSettlements('20260101', '20260131');

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows.map((r) => r.symbol)).toEqual(['KO', 'JNJ']);
        expect(result.truncated).toBe(false);
        expect(seen[KBSEC_TR.SETTLEMENT_US].map((b) => b.nxt_key)).toEqual(['', 'K2']);
    });

    it('같은 다음키가 또 오면 그 페이지를 버리고 잘렸다고 표시한다', async () => {
        serve({ [KBSEC_TR.SETTLEMENT_US]: () => ok({ nxt_key: 'K2', Record1: [usRow('KO')] }) });

        const result = await newExchange().fetchOverseasSettlements('20260101', '20260131');

        expect(result.ok && result.truncated).toBe(true);
        expect(result.ok && result.rows.map((r) => r.symbol)).toEqual(['KO']);
    });

    it('조회가 실패하면 ok: false 를 돌려주고 던지지 않는다', async () => {
        serve({ [KBSEC_TR.SETTLEMENT_US]: () => { throw new TypeError('fetch failed'); } });

        const result = await newExchange().fetchOverseasSettlements('20260101', '20260131');

        expect(result.ok).toBe(false);
    });
});
