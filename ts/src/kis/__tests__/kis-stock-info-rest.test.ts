/**
 * KIS 국내주식 종목정보 확장 메서드: 신용가능 종목, 투자의견(종목, 증권사별), 시황·공시 제목, 상품기본조회, 대주가능 종목.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

beforeEach(() => {
    mockFetch.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

/** 경로가 들어간 첫 호출의 순번. */
const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index]![0])).searchParams);

const SINCE = Date.parse('2026-01-01T00:00:00Z');

describe('fetchCreditStocks', () => {
    it('신용주문 가능 여부를 fid_slct_yn 으로 옮기고 나머지는 예제의 전체와 정렬을 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output: [{ stck_shrn_iscd: '005930', hts_kor_isnm: '삼성전자', crdt_rate: '45' }] }))
            .mockResolvedValueOnce(dataOk({ output: [] }));
        const broker = newKis();

        const [stock] = await broker.fetchCreditStocks(true);
        await broker.fetchCreditStocks(false);

        const calls = mockFetch.mock.calls.map((c, i) => [String(c[0]), i] as const).filter(([u]) => u.includes('/quotations/credit-by-company'));
        expect(headersOf(mockFetch, calls[0]![1]).tr_id).toBe('FHPST04770000');
        expect(queryOf(calls[0]![1])).toEqual({
            fid_rank_sort_cls_code: '1', fid_slct_yn: '0', fid_input_iscd: '0000', fid_cond_scr_div_code: '20477', fid_cond_mrkt_div_code: 'J',
        });
        expect(queryOf(calls[1]![1]).fid_slct_yn).toBe('1');
        expect(stock).toMatchObject({ symbol: '005930/KRW', name: '삼성전자', creditRate: 45 });
    });

    it('orderable 이 불리언이 아니면 보내기 전에 ArgumentsRequired 다', async () => {
        await expect(newKis().fetchCreditStocks(undefined as unknown as boolean)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('투자의견', () => {
    it('fetchInvestmentOpinions 는 종목과 기간을 보내고, 끝 날짜 기본값은 오늘이며, 행에 없는 종목은 부른 종목으로 채운다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                stck_bsop_date: '20260920', invt_opnn: '매수', invt_opnn_cls_code: '2', rgbf_invt_opnn: '중립', rgbf_invt_opnn_cls_code: '3',
                mbcr_name: '한국증권', hts_goal_prc: '95000', stck_prdy_clpr: '71000', dprt: '33.8', stft_esdg: '100',
            }],
        }));

        const [opinion] = await newKis().fetchInvestmentOpinions('005930/KRW', SINCE);

        const call = find('/quotations/invest-opinion');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST663300C0');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '16633', FID_INPUT_ISCD: '005930', FID_INPUT_DATE_1: '20260101', FID_INPUT_DATE_2: '20260923',
        });
        expect(opinion).toMatchObject({
            date: '20260920', symbol: '005930/KRW', memberName: '한국증권', opinion: '매수', opinionCode: '2', previousOpinion: '중립', previousOpinionCode: '3',
            targetPrice: 95000, previousClose: 71000, divergenceRate: 33.8, futuresSpread: 100,
        });
    });

    it('fetchBrokerOpinions 는 회원사코드와 의견 전체(0)를 보내고 종목을 통합 심볼로 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stck_bsop_date: '20260920', stck_shrn_iscd: '000660', hts_kor_isnm: 'SK하이닉스', invt_opnn: 'BUY', hts_goal_prc: '250000' }],
        }));

        const [opinion] = await newKis().fetchBrokerOpinions('00003', SINCE, undefined, { until: Date.parse('2026-06-30T00:00:00Z') });

        const call = find('/quotations/invest-opbysec');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST663400C0');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '16634', FID_INPUT_ISCD: '00003', FID_DIV_CLS_CODE: '0', FID_INPUT_DATE_1: '20260101', FID_INPUT_DATE_2: '20260630',
        });
        expect(opinion).toMatchObject({ symbol: '000660/KRW', name: 'SK하이닉스', opinion: 'BUY', targetPrice: 250000 });
    });

    it('회원사코드나 since 가 없으면 보내기 전에 ArgumentsRequired 다', async () => {
        const broker = newKis();
        await expect(broker.fetchBrokerOpinions('', SINCE)).rejects.toThrow(ArgumentsRequired);
        await expect(broker.fetchInvestmentOpinions('005930/KRW', undefined as unknown as number)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchNewsTitles', () => {
    it('입력을 모두 비우고 종목만 채우며, 작성 시각과 관련 종목을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                cntt_usiq_srno: '2026092300001', news_ofer_entp_code: '2', data_dt: '20260923', data_tm: '093000',
                hts_pbnt_titl_cntt: '삼성전자 공시', news_lrdv_code: '01', dorg: '연합뉴스', iscd1: '005930', iscd2: ' ', iscd3: '',
            }],
        }));

        const [news] = await newKis().fetchNewsTitles('005930/KRW');

        const call = find('/quotations/news-title');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST01011800');
        expect(queryOf(call)).toEqual({
            FID_NEWS_OFER_ENTP_CODE: '', FID_COND_MRKT_CLS_CODE: '', FID_INPUT_ISCD: '005930', FID_TITL_CNTT: '', FID_INPUT_DATE_1: '', FID_INPUT_HOUR_1: '',
            FID_RANK_SORT_CLS_CODE: '', FID_INPUT_SRNO: '',
        });
        expect(news).toMatchObject({
            id: '2026092300001', timestamp: Date.parse('2026-09-23T00:30:00Z'), title: '삼성전자 공시', source: '연합뉴스', providerCode: '2', categoryCode: '01', codes: ['005930'],
        });
    });

    it('종목을 주지 않으면 종목코드도 비워 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [] }));

        await newKis().fetchNewsTitles();

        expect(queryOf(find('/quotations/news-title')).FID_INPUT_ISCD).toBe('');
    });
});

describe('fetchProductInfo', () => {
    it('국내주식 상품유형(300)으로 묻고 예제 필드 목록의 값을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                pdno: '000660', prdt_type_cd: '300', std_pdno: 'KR7000660001', shtn_pdno: 'A000660', prdt_sale_stat_cd: '1', prdt_risk_grad_cd: '3',
                prdt_clsf_cd: '101', sale_strt_dt: '19960101', sale_end_dt: '99991231', frst_erlm_dt: '19960101',
            },
        }));

        const info = await newKis().fetchProductInfo('000660/KRW');

        const call = find('/quotations/search-info');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTPF1604R');
        expect(queryOf(call)).toEqual({ PDNO: '000660', PRDT_TYPE_CD: '300' });
        expect(info).toMatchObject({
            symbol: '000660/KRW', standardCode: 'KR7000660001', shortCode: 'A000660', saleStatusCode: '1', riskGradeCode: '3', classificationCode: '101',
            saleStartDate: '19960101', saleEndDate: '99991231', firstRegisteredDate: '19960101',
        });
    });
});

describe('fetchLendableStocks', () => {
    it('전체 조회 입력과 예제의 대주가능 여부(Y)를 보내고 output1 을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{
                pdno: '005930', prdt_name: '삼성전자', papr: '100', bfdy_clpr: '71000', sbst_prvs: '56800', psbl_yn: 'Y',
                lmt_qty1: '1000', use_qty1: '200', trad_psbl_qty2: '800', bass_dt: '20260922',
            }],
            output2: { tot_stup_lmt_qty: '1000' },
        }));

        const [stock] = await newKis().fetchLendableStocks();

        const call = find('/quotations/lendable-by-company');
        expect(headersOf(mockFetch, call).tr_id).toBe('CTSC2702R');
        expect(queryOf(call)).toEqual({ EXCG_DVSN_CD: '00', PDNO: '', THCO_STLN_PSBL_YN: 'Y', INQR_DVSN_1: '0', CTX_AREA_FK200: '', CTX_AREA_NK100: '' });
        expect(stock).toMatchObject({
            symbol: '005930/KRW', name: '삼성전자', parValue: 100, previousClose: 71000, collateralPrice: 56800, available: true,
            limitQuantity: 1000, usedQuantity: 200, tradableQuantity: 800, baseDate: '20260922',
        });
    });
});

describe('해외 종목', () => {
    const CASES: Array<[string, (b: ReturnType<typeof newKis>) => Promise<unknown>]> = [
        ['fetchInvestmentOpinions', (b) => b.fetchInvestmentOpinions('AAPL/USD', SINCE)],
        ['fetchNewsTitles', (b) => b.fetchNewsTitles('AAPL/USD')],
        ['fetchProductInfo', (b) => b.fetchProductInfo('AAPL/USD')],
        ['fetchLendableStocks', (b) => b.fetchLendableStocks('AAPL/USD')],
    ];

    it.each(CASES)('%s 는 BadSymbol 이고 요청을 보내지 않는다', async (_name, call) => {
        await expect(call(newKis({ masterData: KIS_MASTER_FIXTURE }))).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
