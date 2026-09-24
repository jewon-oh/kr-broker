/**
 * @fileoverview `kbsec.fetchRealizedPnl` — 기간매매손익현황(`SSQM2392`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = (options: Record<string, unknown> = {}) => new kbsec({ ...CREDS, rateLimit: 0, options });

const row = (dt: string) => ({
    ordr_dt: dt, trd_pl: '52,000', trd_svrl_cst: '1,300', trd_nt_pl: '50700', byng_prc: '70000', s_prc: '72600',
    ccls_q: '20', is_no: 'A005930', is_nm: '삼성전자', crdt_typ_cd: '00', crdt_typ_nm: '보통', b_q: '0',
});

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fetchRealizedPnl', () => {
    it('since 가 없으면 기간과 설명 없는 입력을 모두 비워 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.PNL_PERIOD]: { nxt_key: '', trd_pl: '0', Record1: [] } });

        await newExchange().fetchRealizedPnl();

        expect(trBody(mockFetch, KBSEC_TR.PNL_PERIOD).dataBody).toEqual({
            is_no: '', ordr_dt_from: '', ordr_dt_to: '', trd_svrl_cst: '', trd_pl: '', trd_nt_pl: '', inq_clsf: '', nxt_key: '',
        });
    });

    it('since·until 을 한국 날짜로 바꿔 보내고, until 이 없으면 끝은 오늘이다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z')); // KST 9/23 01:30
        routeTr(mockFetch, { [KBSEC_TR.PNL_PERIOD]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchRealizedPnl(Date.UTC(2026, 8, 1, 16, 0));
        expect(trBody(mockFetch, KBSEC_TR.PNL_PERIOD).dataBody).toMatchObject({ ordr_dt_from: '20260902', ordr_dt_to: '20260923' });

        mockFetch.mockReset();
        routeTr(mockFetch, { [KBSEC_TR.PNL_PERIOD]: { nxt_key: '', Record1: [] } });
        await newExchange().fetchRealizedPnl(Date.UTC(2026, 8, 1, 16, 0), { until: Date.UTC(2026, 8, 10, 0, 0) });
        const body = trBody(mockFetch, KBSEC_TR.PNL_PERIOD).dataBody;
        expect(body).toMatchObject({ ordr_dt_from: '20260902', ordr_dt_to: '20260910' });
        expect(body).not.toHaveProperty('until');
    });

    it('행을 옮기고 종목번호의 A 접두어를 떼어 심볼을 만든다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.PNL_PERIOD]: { nxt_key: '', trd_pl: '999', Record1: [row('20260910')] } });

        const { rows, truncated } = await newExchange().fetchRealizedPnl();

        expect(truncated).toBe(false);
        expect(rows).toMatchObject([{
            date: '20260910', symbol: '005930/KRW', name: '삼성전자', quantity: 20, buyQuantity: 0, buyPrice: 70000, sellPrice: 72600,
            pnl: 52000, costs: 1300, netPnl: 50700, creditType: '보통',
        }]);
    });

    it('연속조회를 끝까지 따라가고 상한에 걸리면 truncated 다', async () => {
        let n = 0;
        routeTr(mockFetch, { [KBSEC_TR.PNL_PERIOD]: () => ({ nxt_key: `K${++n}`, Record1: [row(`2026091${n}`)] }) });

        const { rows, truncated } = await newExchange({ holdingsMaxPages: 3 }).fetchRealizedPnl();

        expect(rows).toHaveLength(3);
        expect(truncated).toBe(true);
        expect(calledTrs(mockFetch).filter(tr => tr === KBSEC_TR.PNL_PERIOD.toLowerCase())).toHaveLength(3);
    });
});
