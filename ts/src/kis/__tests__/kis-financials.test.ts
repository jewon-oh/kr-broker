/**
 * `kis.fetchFinancials` — 대차대조표, 손익계산서, 재무비율 등 재무 조회 7종(`finance/*`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { BadRequest, BadSymbol, NotSupported } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

beforeEach(() => {
    mockFetch.mockReset();
});

/** 경로가 들어간 첫 호출의 순번. */
const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index][0])).searchParams);

describe('fetchFinancials', () => {
    const CASES = [
        { statement: 'BALANCE_SHEET', path: '/finance/balance-sheet', tr: 'FHKST66430100', divKey: 'FID_DIV_CLS_CODE', field: 'total_aset', name: 'totalAssets' },
        { statement: 'INCOME_STATEMENT', path: '/finance/income-statement', tr: 'FHKST66430200', divKey: 'FID_DIV_CLS_CODE', field: 'thtr_ntin', name: 'netIncome' },
        { statement: 'FINANCIAL_RATIO', path: '/finance/financial-ratio', tr: 'FHKST66430300', divKey: 'FID_DIV_CLS_CODE', field: 'roe_val', name: 'roe' },
        { statement: 'PROFITABILITY_RATIO', path: '/finance/profit-ratio', tr: 'FHKST66430400', divKey: 'FID_DIV_CLS_CODE', field: 'sale_ntin_rate', name: 'netProfitMargin' },
        { statement: 'OTHER_KEY_RATIO', path: '/finance/other-major-ratios', tr: 'FHKST66430500', divKey: 'fid_div_cls_code', field: 'ev_ebitda', name: 'evToEbitda' },
        { statement: 'STABILITY_RATIO', path: '/finance/stability-ratio', tr: 'FHKST66430600', divKey: 'fid_div_cls_code', field: 'crnt_rate', name: 'currentRatio' },
        { statement: 'GROWTH_RATIO', path: '/finance/growth-ratio', tr: 'FHKST66430800', divKey: 'fid_div_cls_code', field: 'totl_aset_inrt', name: 'totalAssetGrowth' },
    ] as const;

    it.each(CASES)('$statement 는 $path 를 TR $tr 로 부르고, 연·분기 키는 예제대로 $divKey 다', async (c) => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stac_yymm: '202512', [c.field]: '12.34', extra: 'x' }],
        }));

        const [record] = await newKis().fetchFinancials('000660/KRW', c.statement, 'annual');

        const call = find(c.path);
        expect(headersOf(mockFetch, call).tr_id).toBe(c.tr);
        expect(queryOf(call)).toEqual({ [c.divKey]: '0', fid_cond_mrkt_div_code: 'J', fid_input_iscd: '000660' });
        expect(record.settlementMonth).toBe('202512');
        expect(record.values[c.name]).toBe(12.34);
        expect(record.info).toHaveProperty('extra', 'x');
    });

    it('대차대조표는 항목 10개를 모두 values 에 옮기고, 분기는 1 을 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                stac_yymm: '202506', cras: '100', fxas: '200', total_aset: '300', flow_lblt: '40', fix_lblt: '60', total_lblt: '100',
                cpfn: '10', cfp_surp: '20', prfi_surp: '170', total_cptl: '200',
            }],
        }));

        const [record] = await newKis().fetchFinancials('005930/KRW', 'BALANCE_SHEET', 'quarter');

        expect(queryOf(find('/finance/balance-sheet')).FID_DIV_CLS_CODE).toBe('1');
        expect(record.values).toEqual({
            currentAssets: 100, fixedAssets: 200, totalAssets: 300, currentLiabilities: 40, fixedLiabilities: 60, totalLiabilities: 100,
            capitalStock: 10, capitalSurplus: 20, retainedEarnings: 170, totalEquity: 200,
        });
    });

    it('연·분기 구분이 틀리거나 종류가 없거나 해외 종목이면 보내기 전에 던진다', async () => {
        const broker = newKis({ masterData: KIS_MASTER_FIXTURE });
        await expect(broker.fetchFinancials('005930/KRW', 'BALANCE_SHEET', 'monthly' as never)).rejects.toThrow(BadRequest);
        await expect(broker.fetchFinancials('005930/KRW', 'CASH_FLOW' as never, 'annual')).rejects.toThrow(NotSupported);
        await expect(broker.fetchFinancials('AAPL/USD', 'BALANCE_SHEET', 'annual')).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
