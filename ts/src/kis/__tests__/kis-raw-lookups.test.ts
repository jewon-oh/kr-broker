/**
 * 출처가 서로 달라 원문으로 돌려주는 KIS 조회: 프로그램매매 종합현황(일간, 시간), 종목추정실적, 해외 지정가체결내역.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { BadRequest, BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import type { KisMarket } from '../../kis';

const newKis = () => newKisBase({ masterData: KIS_MASTER_FIXTURE });

beforeEach(() => {
    mockFetch.mockReset();
});

/** 경로가 들어간 첫 호출의 순번. */
const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index]![0])).searchParams);

describe('프로그램매매 종합현황', () => {
    it('fetchProgramTradingDaily 는 시장 코드와 기간을 보내고 행을 원문으로 돌려준다', async () => {
        const rows = [{ stck_bsop_date: '20260922', arbt_smtm_ntby_qty: '100', arbt_smtn_ntby_qty: '100' }];
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: rows })).mockResolvedValueOnce(dataOk({ output: rows }));

        const k = newKis();
        const result = await k.fetchProgramTradingDaily('KOSDAQ', Date.parse('2026-09-01T00:00:00+09:00'), { until: Date.parse('2026-09-22T00:00:00+09:00') });
        await k.fetchProgramTradingDaily('KOSPI');

        const calls = mockFetch.mock.calls.flatMap((c, i) => (String(c[0]).includes('/quotations/comp-program-trade-daily') ? [i] : []));
        expect(headersOf(mockFetch, calls[0]!).tr_id).toBe('FHPPG04600001');
        expect(queryOf(calls[0]!)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_MRKT_CLS_CODE: 'Q', FID_INPUT_DATE_1: '20260901', FID_INPUT_DATE_2: '20260922' });
        expect(queryOf(calls[1]!)).toMatchObject({ FID_MRKT_CLS_CODE: 'K', FID_INPUT_DATE_1: '', FID_INPUT_DATE_2: '' });
        expect(result).toEqual(rows);
    });

    it('fetchProgramTradingToday 는 시장 코드만 채우고 선택 입력을 비운다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [{ bsop_hour: '101500' }] }));

        const result = await newKis().fetchProgramTradingToday('KOSPI');

        const call = find('/quotations/comp-program-trade-today');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPPG04600101');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_MRKT_CLS_CODE: 'K', FID_SCTN_CLS_CODE: '', FID_INPUT_ISCD: '', FID_COND_MRKT_DIV_CODE1: '', FID_INPUT_HOUR_1: '' });
        expect(result).toEqual([{ bsop_hour: '101500' }]);
    });

    it('시장이 틀리면 보내기 전에 BadRequest 다', async () => {
        await expect(newKis().fetchProgramTradingDaily('KONEX' as KisMarket)).rejects.toThrow(BadRequest);
        await expect(newKis().fetchProgramTradingToday('KONEX' as KisMarket)).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('블록 원문 조회', () => {
    it('fetchEstimatedPerformance 는 종목코드를 보내고 네 블록을 돌려준다', async () => {
        const blocks = { output1: { sht_cd: '265520' }, output2: [{ data1: '1' }], output3: [{ data1: '2' }], output4: [{ dt: '202512' }] };
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk(blocks));

        const result = await newKis().fetchEstimatedPerformance('265520/KRW');

        const call = find('/quotations/estimate-perform');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHKST668300C0');
        expect(queryOf(call)).toEqual({ SHT_CD: '265520' });
        expect(result).toEqual(blocks);
        await expect(newKis().fetchEstimatedPerformance('AAPL/USD')).rejects.toThrow(BadSymbol);
    });

    it('fetchOverseasAlgoFills 는 계좌와 주문번호를 보내고 네 블록 이름을 모두 담는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [{ ccld_seq: '1' }], output3: { ccld_cnt: '1' } }));

        const result = await newKis().fetchOverseasAlgoFills('0030001');

        const call = find('/overseas-stock/v1/trading/inquire-algo-ccnl');
        expect(headersOf(mockFetch, call).tr_id).toBe('TTTS6059R');
        expect(queryOf(call)).toEqual({
            CANO: '12345678', ACNT_PRDT_CD: '01', ORD_DT: '', ORD_GNO_BRNO: '', ODNO: '0030001', TTLZ_ICLD_YN: '', CTX_AREA_NK200: '', CTX_AREA_FK200: '',
        });
        expect(result).toEqual({ output: [{ ccld_seq: '1' }], output1: undefined, output2: undefined, output3: { ccld_cnt: '1' } });
    });
});
