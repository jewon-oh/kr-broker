/**
 * `kis.fetchStocks` — 국내 종목 상세(`search-stock-info`, TR `CTPF1002R`). 이 API는 종목마다 하나씩 물어야 한다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

const INFO_PATH = '/quotations/search-stock-info';

beforeEach(() => {
    mockFetch.mockReset();
});

describe('fetchStocks', () => {
    it('종목마다 요청을 하나씩 보내고, 필드를 정리해 반환한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                prdt_name: '삼성전자', prdt_abrv_name: '삼성전자', excg_dvsn_cd: 'KSC',
                scts_mket_lstg_dt: '19750611', scts_mket_lstg_abol_dt: '', kosdaq_mket_lstg_dt: '', kosdaq_mket_lstg_abol_dt: '',
                lstg_abol_dt: '', tr_stop_yn: 'N', admn_item_yn: 'N', cptt_trad_tr_psbl_yn: 'Y', nxt_tr_stop_yn: 'N',
            },
        }));

        const [info] = await newKis().fetchStocks(['005930/KRW']);

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(INFO_PATH));
        expect(String(mockFetch.mock.calls[call]![0])).toContain('PRDT_TYPE_CD=300');
        expect(String(mockFetch.mock.calls[call]![0])).toContain('PDNO=005930');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTPF1002R');
        expect(info).toMatchObject({
            symbol: '005930/KRW', name: '삼성전자', abbreviatedName: '삼성전자', exchangeCode: 'KSC', kospiListedAt: '19750611',
            kospiDelistedAt: undefined, tradingHalted: false, administrativeIssue: false, nxtTradable: true, nxtTradingHalted: false,
        });
    });

    it('거래정지·관리종목·NXT거래정지는 각각 그 값이 Y일 때만 true', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { prdt_name: '테스트', prdt_abrv_name: '테스트', excg_dvsn_cd: 'KSC', tr_stop_yn: 'Y', admn_item_yn: 'Y', nxt_tr_stop_yn: 'Y', cptt_trad_tr_psbl_yn: 'N' },
        }));

        const [info] = await newKis().fetchStocks(['005930/KRW']);

        expect(info).toMatchObject({ tradingHalted: true, administrativeIssue: true, nxtTradingHalted: true, nxtTradable: false });
    });

    it('여러 종목이면 종목 수만큼 요청하고, 종목마다 다른 응답을 정확히 짝짓는다', async () => {
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.includes('/oauth2/')) return tokenOk();
            if (u.includes('PDNO=005930')) return dataOk({ output: { prdt_name: '삼성전자', prdt_abrv_name: '삼성전자', excg_dvsn_cd: 'KSC' } });
            if (u.includes('PDNO=000660')) return dataOk({ output: { prdt_name: 'SK하이닉스', prdt_abrv_name: 'SK하이닉스', excg_dvsn_cd: 'KSC' } });
            throw new Error(`예상 밖의 요청: ${u}`);
        });

        const infos = await newKis().fetchStocks(['005930/KRW', '000660/KRW']);

        expect(infos.map((i) => i.name)).toEqual(['삼성전자', 'SK하이닉스']);
        expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes(INFO_PATH))).toHaveLength(2);
    });

    it('해외 종목은 BadSymbol이고 요청을 보내지 않는다', async () => {
        const broker = newKis({ masterData: KIS_MASTER_FIXTURE });
        await expect(broker.fetchStocks(['AAPL/USD'])).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
