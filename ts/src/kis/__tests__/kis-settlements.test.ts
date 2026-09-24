/**
 * `kis.fetchDomesticSettlements` — 체결별 매매손익과 청구된 수수료·거래세(`inquire-period-trade-profit`, TR `TTTC8715R`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

const SETTLEMENT_PATH = '/trading/inquire-period-trade-profit';

beforeEach(() => {
    mockFetch.mockReset();
});

describe('fetchDomesticSettlements', () => {
    it('기간과 계좌를 실어 보내고, 체결별 수수료·제세금을 정리해 돌려준다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{
                trad_dt: '20260920', pdno: '005930', prdt_name: '삼성전자', sll_amt: '710000', buy_amt: '700000',
                rlzt_pfls: '9500', pfls_rt: '1.35', fee: '106', tl_tax: '142',
            }],
            output2: {},
        }));

        const [record] = await newKis().fetchDomesticSettlements(Date.parse('2026-09-01T00:00:00+09:00'), undefined, { until: Date.parse('2026-09-22T00:00:00+09:00') });

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(SETTLEMENT_PATH));
        expect(String(mockFetch.mock.calls[call][0])).toContain('INQR_STRT_DT=20260901');
        expect(String(mockFetch.mock.calls[call][0])).toContain('INQR_END_DT=20260922');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTC8715R');
        expect(record).toMatchObject({
            tradeDate: '20260920', symbol: '005930/KRW', productName: '삼성전자',
            sellAmount: 710000, buyAmount: 700000, realizedPnl: 9500, pnlRate: 1.35, fee: 106, tax: 142,
        });
    });

    it('until 을 안 주면 지금(KST)까지 조회한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: [], output2: {} }));

        await newKis().fetchDomesticSettlements(Date.parse('2026-09-01T00:00:00+09:00'));

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(SETTLEMENT_PATH));
        expect(String(mockFetch.mock.calls[call][0])).toContain('INQR_END_DT=');
    });

    it('since 가 없으면 ArgumentsRequired', async () => {
        await expect(newKis().fetchDomesticSettlements(undefined as unknown as number)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
