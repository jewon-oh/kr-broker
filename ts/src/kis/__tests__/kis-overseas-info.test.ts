/**
 * KIS 해외주식 시세분석 확장 메서드: 해외속보와 해외뉴스 제목, 조건검색, 담보대출 가능 종목, 기간별 권리, 권리종합, 상품기본정보.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

/** 해외 종목 마스터를 넣은 인스턴스. AAPL 의 시세 거래소는 NAS 다. */
const newKis = () => newKisBase({ masterData: KIS_MASTER_FIXTURE });

beforeEach(() => {
    mockFetch.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

/** 경로가 들어간 첫 호출의 순번. */
const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index][0])).searchParams);

describe('해외 뉴스', () => {
    it('fetchBreakingNewsTitles 는 제공업체 전체와 화면 코드를 보내고 관련 종목 10칸에서 빈 칸을 뺀다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                cntt_usiq_srno: '1', news_ofer_entp_code: '2', data_dt: '20260923', data_tm: '063000', hts_pbnt_titl_cntt: '엔비디아 급등',
                news_lrdv_code: '01', dorg: '연합', iscd1: 'NVDA', iscd2: '', iscd10: 'AMD',
            }],
        }));

        const [news] = await newKis().fetchBreakingNewsTitles();

        const call = find('/quotations/brknews-title');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST01011801');
        expect(queryOf(call)).toEqual({
            FID_NEWS_OFER_ENTP_CODE: '0', FID_COND_SCR_DIV_CODE: '11801', FID_COND_MRKT_CLS_CODE: '', FID_INPUT_ISCD: '', FID_TITL_CNTT: '',
            FID_INPUT_DATE_1: '', FID_INPUT_HOUR_1: '', FID_RANK_SORT_CLS_CODE: '', FID_INPUT_SRNO: '',
        });
        expect(news).toMatchObject({ id: '1', timestamp: Date.parse('2026-09-22T21:30:00Z'), title: '엔비디아 급등', source: '연합', codes: ['NVDA', 'AMD'] });
    });

    it('fetchOverseasNewsTitles 는 입력을 비우고 outblock1 을 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            outblock1: [{
                info_gb: '1', news_key: 'K1', data_dt: '20260923', data_tm: '063000', class_cd: '10', class_name: '미국', source: 'Reuters',
                nation_cd: 'US', exchange_cd: 'NAS', symb: 'AAPL', symb_name: '애플', title: '애플 신제품',
            }],
        }));

        const [news] = await newKis().fetchOverseasNewsTitles();

        const call = find('/overseas-price/v1/quotations/news-title');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHPSTH60100C1');
        expect(queryOf(call)).toEqual({ INFO_GB: '', CLASS_CD: '', NATION_CD: '', EXCHANGE_CD: '', SYMB: '', DATA_DT: '', DATA_TM: '', CTS: '' });
        expect(news).toMatchObject({
            id: 'K1', date: '20260923', time: '063000', title: '애플 신제품', source: 'Reuters', newsType: '1', categoryCode: '10', categoryName: '미국',
            countryCode: 'US', exchangeCode: 'NAS', code: 'AAPL', name: '애플',
        });
    });
});

describe('fetchOverseasScreener', () => {
    it('조건을 주지 않으면 모든 조건을 비우고, 준 조건만 켜서 범위를 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output1: { nrec: '1' }, output2: [{ symb: 'AAPL', name: '애플', rank: '1', last: '227.5', diff: '2', rate: '0.9', popen: '225', phigh: '228', plow: '224', tvol: '5000', avol: '1100', valx: '3400000', shar: '15000', eps: '6.6', per: '34' }] }))
            .mockResolvedValueOnce(dataOk({ output1: { nrec: '0' }, output2: [] }));
        const broker = newKis();

        const [item] = await broker.fetchOverseasScreener('NAS');
        await broker.fetchOverseasScreener('HKS', { price: [100, 200], per: [0, 15] });

        const calls = mockFetch.mock.calls.map((c, i) => [String(c[0]), i] as const).filter(([u]) => u.includes('/quotations/inquire-search'));
        expect(headersOf(mockFetch, calls[0][1]).tr_id).toBe('HHDFS76410000');
        const first = queryOf(calls[0][1]);
        expect(first).toMatchObject({ AUTH: '', EXCD: 'NAS', KEYB: '', CO_YN_PRICECUR: '', CO_ST_PRICECUR: '', CO_EN_PRICECUR: '', CO_YN_PER: '' });
        expect(Object.keys(first)).toHaveLength(27);
        expect(queryOf(calls[1][1])).toMatchObject({ EXCD: 'HKS', CO_YN_PRICECUR: '1', CO_ST_PRICECUR: '100', CO_EN_PRICECUR: '200', CO_YN_PER: '1', CO_ST_PER: '0', CO_EN_PER: '15', CO_YN_RATE: '' });
        expect(item).toMatchObject({
            symbol: 'AAPL/USD', name: '애플', rank: 1, price: 227.5, change: 2, percentage: 0.9, open: 225, high: 228, low: 224,
            volume: 5000, amount: 1100, marketCap: 3400000, shares: 15000, eps: 6.6, per: 34,
        });
    });

    it('설명 밖의 거래소면 보내기 전에 BadRequest 다', async () => {
        await expect(newKis().fetchOverseasScreener('NASD' as never)).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('해외 종목 정보', () => {
    it('fetchOverseasLoanableStocks 는 거래소로 숫자 국가코드를 고르고 예제의 이름순을 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ pdno: 'AAPL', ovrs_item_name: 'APPLE', loan_rt: '50', mgge_mntn_rt: '140', mgge_ensu_rt: '160', loan_exec_psbl_yn: 'Y', crcy_cd: 'USD', tr_mket_name: '나스닥' }],
            output2: { loan_psbl_item_num: '1' },
        }));

        const [stock] = await newKis().fetchOverseasLoanableStocks('AAPL/USD');

        const call = find('/quotations/colable-by-company');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTLN4050R');
        expect(queryOf(call)).toEqual({
            PDNO: 'AAPL', NATN_CD: '840', INQR_SQN_DVSN: '01', PRDT_TYPE_CD: '', INQR_STRT_DT: '', INQR_END_DT: '', INQR_DVSN: '', RT_DVSN_CD: '', RT: '',
            LOAN_PSBL_YN: '', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
        });
        expect(stock).toMatchObject({ code: 'AAPL', name: 'APPLE', loanRate: 50, maintenanceRate: 140, collateralRate: 160, loanAvailable: true, currency: 'USD', marketName: '나스닥' });
    });

    it('fetchOverseasCorporateActions 는 권리 전체(%%)와 현지기준일 구분을 보내고, 끝 날짜 기본값은 오늘이다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                bass_dt: '20260915', rght_type_cd: '03', pdno: 'AAPL', prdt_name: '애플', acpl_bass_dt: '20260914', sbsc_strt_dt: '', sbsc_end_dt: '',
                cash_alct_rt: '0.25', stck_alct_rt: '0', crcy_cd: 'USD', dfnt_yn: 'Y',
            }],
        }));

        const [action] = await newKis().fetchOverseasCorporateActions('AAPL/USD', Date.parse('2026-09-01T00:00:00Z'));

        const call = find('/quotations/period-rights');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTRGT011R');
        expect(queryOf(call)).toEqual({
            RGHT_TYPE_CD: '%%', INQR_DVSN_CD: '02', INQR_STRT_DT: '20260901', INQR_END_DT: '20260923', PDNO: 'AAPL', PRDT_TYPE_CD: '', CTX_AREA_NK50: '', CTX_AREA_FK50: '',
        });
        expect(action).toMatchObject({
            date: '20260915', rightTypeCode: '03', code: 'AAPL', name: '애플', localRecordDate: '20260914', subscriptionStartDate: undefined,
            cashAllocationRate: 0.25, stockAllocationRate: 0, currency: 'USD', confirmed: true,
        });
    });

    it('fetchOverseasRights 는 거래소로 두 글자 국가코드를 고르고 기간이 없으면 비운다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ anno_dt: '20260901', ca_title: '현금배당', record_dt: '20260915', div_lock_dt: '20260914', lock_dt: '', pay_dt: '20260930', validity_dt: '', delist_dt: '' }],
        }));

        const [event] = await newKis().fetchOverseasRights('AAPL/USD');

        const call = find('/quotations/rights-by-ice');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHDFS78330900');
        expect(queryOf(call)).toEqual({ NCOD: 'US', SYMB: 'AAPL', ST_YMD: '', ED_YMD: '' });
        expect(event).toMatchObject({ title: '현금배당', announcedDate: '20260901', recordDate: '20260915', exDividendDate: '20260914', exRightsDate: undefined, paymentDate: '20260930' });
    });

    it('fetchOverseasProductInfo 는 거래소별 상품유형코드(나스닥 512)로 묻는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                std_pdno: 'US0378331005', prdt_name: '애플', prdt_eng_name: 'APPLE INC', natn_name: '미국', tr_mket_name: '나스닥', ovrs_excg_name: 'NASDAQ',
                tr_crcy_cd: 'USD', ovrs_papr: '0.00001', prdt_clsf_name: '주식', buy_unit_qty: '1', sll_unit_qty: '1', lstg_stck_num: '15000000000',
                lstg_dt: '19801212', lstg_abol_item_yn: 'N',
            },
        }));

        const info = await newKis().fetchOverseasProductInfo('AAPL/USD');

        const call = find('/overseas-price/v1/quotations/search-info');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTPF1702R');
        expect(queryOf(call)).toEqual({ PRDT_TYPE_CD: '512', PDNO: 'AAPL' });
        expect(info).toMatchObject({
            symbol: 'AAPL/USD', standardCode: 'US0378331005', name: '애플', englishName: 'APPLE INC', countryName: '미국', marketName: '나스닥',
            exchangeName: 'NASDAQ', currency: 'USD', parValue: 0.00001, buyUnit: 1, sellUnit: 1, listedShares: 15000000000, listedDate: '19801212', delisted: false,
        });
    });

    it('국내 종목이거나 since 가 없으면 보내기 전에 던진다', async () => {
        const broker = newKis();
        await expect(broker.fetchOverseasProductInfo('005930/KRW')).rejects.toThrow(BadSymbol);
        await expect(broker.fetchOverseasRights('005930/KRW')).rejects.toThrow(BadSymbol);
        await expect(broker.fetchOverseasCorporateActions()).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
