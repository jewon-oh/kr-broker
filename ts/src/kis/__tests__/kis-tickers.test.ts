/**
 * `kis.fetchTickers` — 관심종목(멀티종목) 시세조회(`intstock-multprice`, TR `FHKST11300006`), 한 번에 최대 30종목.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

const MULTI_PATH = '/quotations/intstock-multprice';

beforeEach(() => {
    mockFetch.mockReset();
});

describe('fetchTickers', () => {
    it('요청한 종목마다 slot 번호가 매겨진 파라미터를 보내고, 코드로 결과를 짝짓는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [
                { inter_shrn_iscd: '000660', inter2_prpr: '180000', prdy_ctrt: '1.0', prdy_vrss_sign: '2', inter2_prdy_vrss: '1800', acml_vol: '500', acml_tr_pbmn: '90000000' },
                { inter_shrn_iscd: '005930', inter2_prpr: '71000', prdy_ctrt: '0.5', prdy_vrss_sign: '2', inter2_prdy_vrss: '350', acml_vol: '1000', acml_tr_pbmn: '71000000' },
            ],
        }));

        const tickers = await newKis().fetchTickers(['005930/KRW', '000660/KRW']);

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(MULTI_PATH));
        expect(String(mockFetch.mock.calls[call]![0])).toContain('FID_COND_MRKT_DIV_CODE_1=J');
        expect(String(mockFetch.mock.calls[call]![0])).toContain('FID_INPUT_ISCD_1=005930');
        expect(String(mockFetch.mock.calls[call]![0])).toContain('FID_INPUT_ISCD_2=000660');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST11300006');
        expect(Object.keys(tickers)).toEqual(expect.arrayContaining(['005930/KRW', '000660/KRW']));
        expect(tickers['005930/KRW']).toMatchObject({ symbol: '005930/KRW', last: 71000 });
        expect(tickers['000660/KRW']).toMatchObject({ symbol: '000660/KRW', last: 180000 });
    });

    it('symbols 가 없으면 ArgumentsRequired', async () => {
        await expect(newKis().fetchTickers([])).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('30종목을 넘으면 BadRequest', async () => {
        const symbols = Array.from({ length: 31 }, (_, i) => `${String(i).padStart(6, '0')}/KRW`);
        await expect(newKis({ masterData: KIS_MASTER_FIXTURE }).fetchTickers(symbols)).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('해외 종목이 섞여 있으면 BadSymbol이고 요청을 보내지 않는다', async () => {
        const broker = newKis({ masterData: KIS_MASTER_FIXTURE });
        await expect(broker.fetchTickers(['005930/KRW', 'AAPL/USD'])).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
