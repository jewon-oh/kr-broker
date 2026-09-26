/**
 * `kis.fetchInvestorTrading` — 종목의 투자자별 매매동향(`inquire-investor`, TR `FHKST01010900`).
 * 세 증권사 공통 모양(`InvestorTradingRecord`)이다. 둘째 인자로 `params` 를 넘기던 옛 호출은 한 판 동안 받는다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { BadRequest, BadSymbol } from '../../base/errors';
import { logger } from '../../logger';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

const INVESTOR_PATH = '/quotations/inquire-investor';

beforeEach(() => {
    mockFetch.mockReset();
});

describe('fetchInvestorTrading', () => {
    it('개인·외국인·기관의 순매수 대금을 공통 모양으로 돌려주고, 매수·매도 값은 info 원문에 둔다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                stck_bsop_date: '20260922', stck_clpr: '71000', prdy_vrss: '500', prdy_vrss_sign: '2',
                prsn_ntby_qty: '-1000', prsn_ntby_tr_pbmn: '-71000000', prsn_shnu_vol: '2000', prsn_shnu_tr_pbmn: '142000000',
                prsn_seln_vol: '3000', prsn_seln_tr_pbmn: '213000000',
                frgn_ntby_qty: '800', frgn_ntby_tr_pbmn: '56800000', frgn_shnu_vol: '1800', frgn_shnu_tr_pbmn: '127800000',
                frgn_seln_vol: '1000', frgn_seln_tr_pbmn: '71000000',
                orgn_ntby_qty: '200', orgn_ntby_tr_pbmn: '14200000', orgn_shnu_vol: '500', orgn_shnu_tr_pbmn: '35500000',
                orgn_seln_vol: '300', orgn_seln_tr_pbmn: '21300000',
            }],
        }));

        const [record] = await newKis().fetchInvestorTrading('005930/KRW');

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(INVESTOR_PATH));
        expect(String(mockFetch.mock.calls[call]![0])).toContain('FID_INPUT_ISCD=005930');
        expect(String(mockFetch.mock.calls[call]![0])).toContain('FID_COND_MRKT_DIV_CODE=J');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST01010900');
        expect(record).toEqual({
            timestamp: Date.parse('2026-09-21T15:00:00Z'), datetime: '2026-09-21T15:00:00.000Z',
            date: '20260922', close: 71000, change: 500, individual: -71000000, foreign: 56800000, institution: 14200000,
            info: expect.objectContaining({ prsn_shnu_vol: '2000', frgn_seln_tr_pbmn: '71000000', prdy_vrss_sign: '2' }),
        });
    });

    it('결과가 하나면(객체) 한 원소 배열로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { stck_bsop_date: '20260922', stck_clpr: '71000' },
        }));

        const records = await newKis().fetchInvestorTrading('005930/KRW');

        expect(records).toHaveLength(1);
        expect(records[0]!.date).toBe('20260922');
    });

    it('since 와 params.until 로 받은 영업일을 거르고 limit 개를 준다. until 은 요청에 싣지 않는다', async () => {
        const days = ['20260922', '20260921', '20260918', '20260917'].map((d) => ({ stck_bsop_date: d }));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValue(dataOk({ output: days }));
        const broker = newKis();

        const ranged = await broker.fetchInvestorTrading('005930/KRW', Date.parse('2026-09-17T15:00:00Z'), 2, { until: Date.parse('2026-09-21T03:00:00Z') });
        const latest = await broker.fetchInvestorTrading('005930/KRW', undefined, 1);

        expect(ranged.map((r) => r.date)).toEqual(['20260921', '20260918']);
        expect(latest.map((r) => r.date)).toEqual(['20260922']);
        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(INVESTOR_PATH));
        expect(String(mockFetch.mock.calls[call]![0])).not.toContain('until');
    });

    it('limit 자리에 ms 같은 큰 수가 오면 요청 없이 BadRequest 다', async () => {
        await expect(newKis().fetchInvestorTrading('005930/KRW', undefined, Date.parse('2026-09-21T03:00:00Z'))).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('둘째 인자로 params 를 넘기던 옛 호출도 받고, 인스턴스마다 한 번 경고한다', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValue(dataOk({ output: [{ stck_bsop_date: '20260922' }] }));
        const broker = newKis();

        const records = await broker.fetchInvestorTrading('005930/KRW', { FID_COND_MRKT_DIV_CODE: 'NX' });
        await broker.fetchInvestorTrading('005930/KRW', { FID_COND_MRKT_DIV_CODE: 'NX' });

        expect(records.map((r) => r.date)).toEqual(['20260922']);
        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(INVESTOR_PATH));
        expect(String(mockFetch.mock.calls[call]![0])).toContain('FID_COND_MRKT_DIV_CODE=NX');
        expect(warn.mock.calls.filter((c) => String(c[1]).includes('fetchInvestorTrading(symbol, params)'))).toHaveLength(1);
        warn.mockRestore();
    });

    it('해외 종목은 BadSymbol이고 요청을 보내지 않는다', async () => {
        const broker = newKis({ masterData: KIS_MASTER_FIXTURE });
        await expect(broker.fetchInvestorTrading('AAPL/USD')).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
