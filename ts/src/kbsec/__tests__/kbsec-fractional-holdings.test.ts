/**
 * @fileoverview `kbsec.fetchFractionalHoldings` — 국내주식 소수점 매매 보유잔고(`SSQM5472`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

const holding = (code: string, qty: string) => ({
    is_cd: code, is_nm: '삼성전자', hld_q: qty, ordr_psbl_q: qty, avr_uprc: '68000', byng_amt: '20400',
    val_amt: '21300', val_pl: '900', val_pl_r: '4.41',
});

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchFractionalHoldings', () => {
    it('업무구분 1·기준일자 빈 값으로 부르고 소수점 수량을 그대로 읽는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_HOLDINGS_KR]: { nxt_key: '', Record1: [holding('005930', '0.3')] } });

        const { rows, truncated } = await newExchange().fetchFractionalHoldings();

        expect(trBody(mockFetch, KBSEC_TR.FRAC_HOLDINGS_KR).dataBody).toMatchObject({ jb_ccd: '1', std_dt: '', nxt_key: '' });
        expect(truncated).toBe(false);
        expect(rows).toMatchObject([{
            symbol: '005930/KRW', name: '삼성전자', quantity: 0.3, orderableQuantity: 0.3, averagePrice: 68000,
            cost: 20400, marketValue: 21300, unrealizedPnl: 900, unrealizedPnlRate: 4.41,
        }]);
    });

    it('종목코드가 비고 ISO 코드만 오면 ISO 코드에서 6자리를 뽑는다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.FRAC_HOLDINGS_KR]: { nxt_key: '', Record1: [{ ...holding('', '1'), iso_cd: 'KR7005930003' }] },
        });

        const { rows } = await newExchange().fetchFractionalHoldings();

        expect(rows[0]!.symbol).toBe('005930/KRW');
    });

    it('다음키를 따라 두 번째 페이지까지 읽는다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.FRAC_HOLDINGS_KR]: (body: Record<string, unknown>) => (body.nxt_key === ''
                ? { nxt_key: 'K1', Record1: [holding('005930', '0.5')] }
                : { nxt_key: '', Record1: [holding('000660', '0.2')] }),
        });

        const { rows, truncated } = await newExchange().fetchFractionalHoldings();

        expect(rows.map(r => r.symbol)).toEqual(['005930/KRW', '000660/KRW']);
        expect(truncated).toBe(false);
        expect(calledTrs(mockFetch).filter(tr => tr === KBSEC_TR.FRAC_HOLDINGS_KR.toLowerCase())).toHaveLength(2);
    });

    it('params 로 기준일자를 지정할 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FRAC_HOLDINGS_KR]: { nxt_key: '', Record1: [] } });

        await newExchange().fetchFractionalHoldings({ std_dt: '20260922' });

        expect(trBody(mockFetch, KBSEC_TR.FRAC_HOLDINGS_KR).dataBody).toMatchObject({ std_dt: '20260922' });
    });
});
