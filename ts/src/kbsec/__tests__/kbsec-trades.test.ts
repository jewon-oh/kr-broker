/**
 * @fileoverview `kbsec.fetchTrades` — 시간대별 체결(`IVU10080`, 국내만, 당일).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchTrades', () => {
    it('체결가·체결수량을 채우고 방향은 undefined 로 둔다(코드값 근거 없음)', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: {
                Record1: [{ ccls_tm: '093015', ccls_prc: '71000', ccls_q: '10', sell_buy_ccd: '1', acml_vlm: '12345' }],
            },
        });

        const [trade] = await newExchange().fetchTrades('005930/KRW');

        expect(trBody(mockFetch, KBSEC_TR.TRADES_TIMELINE_KR).dataBody).toMatchObject({
            excg_clsf: '1', is_cd: '005930', ovtm_mkt_clsf: '0',
        });
        expect(trade).toMatchObject({ symbol: '005930/KRW', price: 71000, amount: 10, side: undefined, id: undefined });
        expect(trade!.timestamp).toBeTypeOf('number');
    });

    it('params 로 시간외장구분을 덮어쓸 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_TIMELINE_KR]: { Record1: [] } });

        await newExchange().fetchTrades('005930/KRW', undefined, undefined, { ovtm_mkt_clsf: '1' });

        expect(trBody(mockFetch, KBSEC_TR.TRADES_TIMELINE_KR).dataBody).toMatchObject({ ovtm_mkt_clsf: '1' });
    });

    it('since 를 미래로 주면 전부 걸러진다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: {
                Record1: [{ ccls_tm: '093015', ccls_prc: '71000', ccls_q: '10' }],
            },
        });

        const trades = await newExchange().fetchTrades('005930/KRW', Date.now() + 24 * 60 * 60 * 1000);

        expect(trades).toEqual([]);
    });

    it('since 없이 부르면 전부 반환한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: {
                Record1: [{ ccls_tm: '093015', ccls_prc: '71000', ccls_q: '10' }, { ccls_tm: '093020', ccls_prc: '71100', ccls_q: '5' }],
            },
        });

        const trades = await newExchange().fetchTrades('005930/KRW');

        expect(trades).toHaveLength(2);
    });
});
