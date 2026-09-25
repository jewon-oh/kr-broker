/**
 * @fileoverview `kbsec.fetchUnrealizedPnl` — 평가손익 조회(`SSQM0006`, 국내만). 연속조회(`nxt_key`)를 끝까지 따라가는지 본다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = (options: Record<string, unknown> = {}) => new kbsec({ ...CREDS, rateLimit: 0, options });

const row = (code: string, pnl: string) => ({ is_cd: code, is_nm: code, ec_q: '10', avr_uprc: '68000', now_prc: '71000', val_pl_amt: pnl });

const pnlCalls = (): number => calledTrs(mockFetch).filter(tr => tr === KBSEC_TR.UNREALIZED_PNL.toLowerCase()).length;

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchUnrealizedPnl', () => {
    it('전체(현금+신용) 기준으로 부르고 공통 필드로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.UNREALIZED_PNL]: { nxt_key: '', Record1: [{ ...row('005930', '30000'), is_nm: '삼성전자' }] },
        });

        const { rows, truncated } = await newExchange().fetchUnrealizedPnl();

        expect(trBody(mockFetch, KBSEC_TR.UNREALIZED_PNL).dataBody).toMatchObject({ inq_clsf: '2', trd_clsf: '00', nxt_key: '' });
        expect(truncated).toBe(false);
        expect(rows).toMatchObject([{
            symbol: '005930/KRW', name: '삼성전자', quantity: 10, averagePrice: 68000, last: 71000, unrealizedPnl: 30000,
        }]);
    });

    it('다음키를 따라 두 번째 페이지까지 읽는다 — 마지막 페이지의 공백 키에서 멈춘다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.UNREALIZED_PNL]: (body: Record<string, unknown>) => (body.nxt_key === ''
                ? { nxt_key: 'K1', Record1: [row('005930', '1')] }
                : { nxt_key: '   ', Record1: [row('000660', '2')] }),
        });

        const { rows, truncated } = await newExchange().fetchUnrealizedPnl();

        expect(rows.map(r => r.symbol)).toEqual(['005930/KRW', '000660/KRW']);
        expect(truncated).toBe(false);
        expect(pnlCalls()).toBe(2);
    });

    it('같은 다음키가 되풀이되면 그 페이지를 버리고 잘렸다고 표시한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.UNREALIZED_PNL]: { nxt_key: 'SAME', Record1: [row('005930', '1')] } });

        const { rows, truncated } = await newExchange().fetchUnrealizedPnl();

        expect(rows).toHaveLength(1);
        expect(truncated).toBe(true);
    });

    it('페이지 상한(holdingsMaxPages)에 걸리면 잘렸다고 표시한다', async () => {
        let n = 0;
        routeTr(mockFetch, { [KBSEC_TR.UNREALIZED_PNL]: () => ({ nxt_key: `K${++n}`, Record1: [row(String(n).padStart(6, '0'), '1')] }) });

        const { rows, truncated } = await newExchange({ holdingsMaxPages: 2 }).fetchUnrealizedPnl();

        expect(rows).toHaveLength(2);
        expect(truncated).toBe(true);
        expect(pnlCalls()).toBe(2);
    });

    it('A 접두 종목코드도 6자리 심볼로 맞춘다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.UNREALIZED_PNL]: { nxt_key: '', Record1: [row('A005930', '1')] } });

        const { rows } = await newExchange().fetchUnrealizedPnl();

        expect(rows[0]!.symbol).toBe('005930/KRW');
    });

    it('params 로 조회구분·매매구분을 덮어쓸 수 있고, 넘긴 nxt_key 는 무시하고 처음부터 읽는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.UNREALIZED_PNL]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchUnrealizedPnl({ inq_clsf: '1', trd_clsf: '01', nxt_key: 'STALE' });

        expect(trBody(mockFetch, KBSEC_TR.UNREALIZED_PNL).dataBody).toMatchObject({ inq_clsf: '1', trd_clsf: '01', nxt_key: '' });
    });
});
