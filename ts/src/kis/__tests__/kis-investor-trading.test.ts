/**
 * `kis.fetchInvestorTrading` — 종목의 투자자별 매매동향(`inquire-investor`, TR `FHKST01010900`).
 * 토스의 같은 이름 메서드는 시장 단위지만, 이 메서드는 종목 단위다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

const INVESTOR_PATH = '/quotations/inquire-investor';

beforeEach(() => {
    mockFetch.mockReset();
});

describe('fetchInvestorTrading', () => {
    it('투자자 유형별 매수·매도를 정리해 돌려준다', async () => {
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
        expect(String(mockFetch.mock.calls[call][0])).toContain('FID_INPUT_ISCD=005930');
        expect(String(mockFetch.mock.calls[call][0])).toContain('FID_COND_MRKT_DIV_CODE=J');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST01010900');
        expect(record).toMatchObject({
            businessDate: '20260922', close: 71000, change: 500, changeSign: '2',
            individual: { netBuyVolume: -1000, netBuyAmount: -71000000, buyVolume: 2000, buyAmount: 142000000, sellVolume: 3000, sellAmount: 213000000 },
            foreign: { netBuyVolume: 800, netBuyAmount: 56800000, buyVolume: 1800, buyAmount: 127800000, sellVolume: 1000, sellAmount: 71000000 },
            institution: { netBuyVolume: 200, netBuyAmount: 14200000, buyVolume: 500, buyAmount: 35500000, sellVolume: 300, sellAmount: 21300000 },
        });
    });

    it('결과가 하나면(객체) 한 원소 배열로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { stck_bsop_date: '20260922', stck_clpr: '71000' },
        }));

        const records = await newKis().fetchInvestorTrading('005930/KRW');

        expect(records).toHaveLength(1);
        expect(records[0].businessDate).toBe('20260922');
    });

    it('해외 종목은 BadSymbol이고 요청을 보내지 않는다', async () => {
        const broker = newKis({ masterData: KIS_MASTER_FIXTURE });
        await expect(broker.fetchInvestorTrading('AAPL/USD')).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
