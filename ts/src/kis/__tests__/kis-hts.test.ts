/**
 * KIS HTS 사용자 ID(`options.htsId`)가 필요한 조회: 관심종목 그룹과 그룹별 종목, 조건검색 목록과 결과.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

/** HTS ID 를 넣은 인스턴스. */
const newKis = () => newKisBase({ options: { htsId: 'myhts' } });

beforeEach(() => {
    mockFetch.mockReset();
});

/** 경로가 들어간 첫 호출의 순번. */
const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index][0])).searchParams);

describe('options.htsId 가 없을 때', () => {
    const CASES: Array<[string, (b: ReturnType<typeof newKisBase>) => Promise<unknown>]> = [
        ['fetchWatchlistGroups', (b) => b.fetchWatchlistGroups()],
        ['fetchWatchlist', (b) => b.fetchWatchlist('001')],
        ['fetchScreeners', (b) => b.fetchScreeners()],
        ['fetchScreenerResult', (b) => b.fetchScreenerResult('0')],
    ];

    it.each(CASES)('%s 는 보내기 전에 ArgumentsRequired 다', async (_name, call) => {
        await expect(call(newKisBase())).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('관심종목', () => {
    it('fetchWatchlistGroups 는 예제의 구분값과 HTS ID 를 보내고 그룹을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output2: [{ date: '20260923', trnm_hour: '090000', data_rank: '1', inter_grp_code: '001', inter_grp_name: '반도체', ask_cnt: '12' }],
        }));

        const [group] = await newKis().fetchWatchlistGroups();

        const call = find('/quotations/intstock-grouplist');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHKCM113004C7');
        expect(queryOf(call)).toEqual({ TYPE: '1', FID_ETC_CLS_CODE: '00', USER_ID: 'myhts' });
        expect(group).toMatchObject({ groupCode: '001', groupName: '반도체', count: 12, rank: 1, date: '20260923', time: '090000' });
    });

    it('fetchWatchlist 는 그룹 코드를 보내고 종목코드와 시장 코드를 원문 그대로 둔다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { inter_grp_name: '반도체' },
            output2: [{
                fid_mrkt_cls_code: 'J', data_rank: '1', exch_code: 'KRX', jong_code: '005930', color_code: '0', memo: '메모',
                hts_kor_isnm: '삼성전자', fxdt_ntby_qty: '100', cntg_unpr: '71000', cntg_cls_code: '1',
            }],
        }));

        const [item] = await newKis().fetchWatchlist('001');

        const call = find('/quotations/intstock-stocklist-by-group');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHKCM113004C6');
        expect(queryOf(call)).toEqual({
            TYPE: '1', USER_ID: 'myhts', INTER_GRP_CODE: '001', FID_ETC_CLS_CODE: '4', DATA_RANK: '', INTER_GRP_NAME: '', HTS_KOR_ISNM: '', CNTG_CLS_CODE: '',
        });
        expect(item).toMatchObject({
            code: '005930', name: '삼성전자', marketCode: 'J', exchangeCode: 'KRX', memo: '메모', colorCode: '0', baseNetBuyVolume: 100, tradePrice: 71000, tradeTypeCode: '1', rank: 1,
        });
    });

    it('fetchWatchlist 는 그룹 코드가 없으면 보내기 전에 ArgumentsRequired 다', async () => {
        await expect(newKis().fetchWatchlist('')).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('조건검색', () => {
    it('fetchScreeners 는 소문자 user_id 를 보내고 조건을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output2: [{ user_id: 'myhts', seq: '0', grp_nm: '기본', condition_nm: '골든크로스' }],
        }));

        const [screener] = await newKis().fetchScreeners();

        const call = find('/quotations/psearch-title');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHKST03900300');
        expect(queryOf(call)).toEqual({ user_id: 'myhts' });
        expect(screener).toMatchObject({ seq: '0', name: '골든크로스', groupName: '기본' });
    });

    it('fetchScreenerResult 는 조건키값을 보내고 결과 종목을 통합 심볼로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output2: [{
                code: '005930', name: '삼성전자', daebi: '2', price: '71000', chgrate: '0.71', acml_vol: '9000000', trade_amt: '639000000000', change: '500',
                cttr: '105.3', open: '70500', high: '71500', low: '70000', high52: '88000', low52: '50000', expprice: '0', recprice: '70500',
                uplmtprice: '91600', dnlmtprice: '49400', stotprice: '4238000',
            }],
        }));

        const [item] = await newKis().fetchScreenerResult('0');

        const call = find('/quotations/psearch-result');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHKST03900400');
        expect(queryOf(call)).toEqual({ user_id: 'myhts', seq: '0' });
        expect(item).toMatchObject({
            symbol: '005930/KRW', name: '삼성전자', price: 71000, change: 500, percentage: 0.71, volume: 9000000, amount: 639000000000, strength: 105.3,
            open: 70500, high: 71500, low: 70000, high52Week: 88000, low52Week: 50000, basePrice: 70500, upperLimitPrice: 91600, lowerLimitPrice: 49400, marketCap: 4238000,
        });
    });

    it('fetchScreenerResult 는 조건키값이 없으면 보내기 전에 ArgumentsRequired 다', async () => {
        await expect(newKis().fetchScreenerResult('')).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
