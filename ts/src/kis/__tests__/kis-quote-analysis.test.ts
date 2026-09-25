/**
 * KIS 국내주식 시세분석 확장 메서드(종목 단위 수급): 신용잔고, 대차거래, 공매도, 매수·매도 체결량, 투자자 일별 동향, 추정 가집계,
 * 외국계 순매수 추이, 회원사 일별 동향, 프로그램 매매 추이. 시장 단위 조회(투자자별 프로그램 매매, 시장별 투자자 동향, 증시자금)와
 * 종목의 예상체결가 추이, 매물대, 체결금액별 매매비중.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest, BadSymbol } from '../../base/errors';
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

/** KST 2026-09-23 01:30 에 고정한다. */
const fixKstSep23 = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
};

describe('fetchCreditBalanceHistory', () => {
    it('결제일자 기본값은 오늘(한국 날짜)이고 융자와 대주를 나눠 정리한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                deal_date: '20260922', stlm_date: '20260924', stck_prpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', acml_vol: '9000000',
                whol_loan_new_stcn: '100', whol_loan_rdmp_stcn: '50', whol_loan_rmnd_stcn: '1000', whol_loan_new_amt: '7100000',
                whol_loan_rdmp_amt: '3550000', whol_loan_rmnd_amt: '71000000', whol_loan_rmnd_rate: '0.12', whol_loan_gvrt: '0.05',
                whol_stln_new_stcn: '10', whol_stln_rdmp_stcn: '5', whol_stln_rmnd_stcn: '200', whol_stln_rmnd_amt: '14200000',
            }],
        }));

        const [day] = await newKis().fetchCreditBalanceHistory('005930/KRW');

        const call = find('/quotations/daily-credit-balance');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST04760000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20476', FID_INPUT_ISCD: '005930', FID_INPUT_DATE_1: '20260923' });
        expect(day).toMatchObject({
            tradeDate: '20260922', settlementDate: '20260924', price: 71000, volume: 9000000,
            loan: { newShares: 100, repaidShares: 50, balanceShares: 1000, newAmount: 7100000, repaidAmount: 3550000, balanceAmount: 71000000, balanceRate: 0.12, grantRate: 0.05 },
            stockLoan: { newShares: 10, repaidShares: 5, balanceShares: 200, balanceAmount: 14200000 },
        });
    });

    it('기준일은 params.until 의 한국 날짜로 보내고 until 은 요청에 싣지 않는다. limit 자리에 ms 가 오면 보내기 전에 BadRequest 다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [] }));
        const broker = newKis();

        await broker.fetchCreditBalanceHistory('005930/KRW', undefined, undefined, { until: Date.parse('2026-08-31T16:00:00Z') }); // KST 9/1 01:00
        await expect(broker.fetchCreditBalanceHistory('005930/KRW', undefined, Date.parse('2026-09-01T00:00:00Z'))).rejects.toThrow(BadRequest);

        const q = queryOf(find('/quotations/daily-credit-balance'));
        expect(q.FID_INPUT_DATE_1).toBe('20260901');
        expect(q).not.toHaveProperty('until');
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('since 와 limit 은 받은 행에 ccxt 방식으로 적용하고, 행마다 한국 날짜의 timestamp 를 채운다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ deal_date: '20260922' }, { deal_date: '20260921' }, { deal_date: '20260918' }],
        }));

        const days = await newKis().fetchCreditBalanceHistory('005930/KRW', undefined, 2);

        expect(days.map((d) => d.tradeDate)).toEqual(['20260922', '20260921']);
        expect(days[0]).toMatchObject({ timestamp: Date.parse('2026-09-21T15:00:00Z'), datetime: '2026-09-21T15:00:00.000Z' });
    });
});

describe('fetchStockLendingHistory', () => {
    it('조회구분 3(종목)을 보내고, 기간이 없으면 비워 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{
                bsop_date: '20260922', stck_prpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', acml_vol: '9000000',
                new_stcn: '3000', rdmp_stcn: '1000', prdy_rmnd_vrss: '2000', rmnd_stcn: '50000', rmnd_amt: '3550000000',
            }],
        }));

        const [day] = await newKis().fetchStockLendingHistory('005930/KRW');

        const call = find('/quotations/daily-loan-trans');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHPST074500C0');
        expect(queryOf(call)).toEqual({ MRKT_DIV_CLS_CODE: '3', MKSC_SHRN_ISCD: '005930', START_DATE: '', END_DATE: '', CTS: '' });
        expect(day).toMatchObject({
            businessDate: '20260922', close: 71000, newShares: 3000, repaidShares: 1000, balanceChange: 2000, balanceShares: 50000, balanceAmount: 3550000000,
        });
    });

    it('기간을 주면 한국 날짜로 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: [] }));

        await newKis().fetchStockLendingHistory('005930/KRW', Date.parse('2026-09-01T00:00:00Z'), undefined, { until: Date.parse('2026-09-22T16:00:00Z') });

        const q = queryOf(find('/quotations/daily-loan-trans'));
        expect(q).toMatchObject({ START_DATE: '20260901', END_DATE: '20260923' });
        expect(q).not.toHaveProperty('until');
    });
});

describe('fetchShortSaleHistory', () => {
    it('output2 의 공매도 수량, 대금, 비중을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { stck_prpr: '71000' },
            output2: [{
                stck_bsop_date: '20260922', stck_clpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', acml_vol: '9000000', acml_tr_pbmn: '639000000000',
                ssts_cntg_qty: '300000', ssts_vol_rlim: '3.33', acml_ssts_cntg_qty: '5000000', acml_ssts_cntg_qty_rlim: '2.1',
                ssts_tr_pbmn: '21300000000', ssts_tr_pbmn_rlim: '3.33', acml_ssts_tr_pbmn: '355000000000', acml_ssts_tr_pbmn_rlim: '2.2', avrg_prc: '71000',
            }],
        }));

        const [day] = await newKis().fetchShortSaleHistory('005930/KRW', Date.parse('2026-09-01T00:00:00Z'));

        const call = find('/quotations/daily-short-sale');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST04830000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_DATE_1: '20260901', FID_INPUT_DATE_2: '' });
        expect(day).toMatchObject({
            businessDate: '20260922', close: 71000, amount: 639000000000, shortVolume: 300000, shortVolumeShare: 3.33,
            cumulativeShortVolume: 5000000, cumulativeShortVolumeShare: 2.1, shortAmount: 21300000000, shortAmountShare: 3.33,
            cumulativeShortAmount: 355000000000, cumulativeShortAmountShare: 2.2, averagePrice: 71000,
        });
    });
});

describe('fetchBuySellVolumeHistory', () => {
    it('기간 구분 D 를 보내고 합계와 일별 체결량을 나눠 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { shnu_cnqn_smtn: '5000000', seln_cnqn_smtn: '4000000' },
            output2: [{ stck_bsop_date: '20260922', total_seln_qty: '400000', total_shnu_qty: '500000' }],
        }));

        const result = await newKis().fetchBuySellVolumeHistory('005930/KRW');

        const call = find('/quotations/inquire-daily-trade-volume');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST03010800');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_PERIOD_DIV_CODE: 'D', FID_INPUT_DATE_1: '', FID_INPUT_DATE_2: '' });
        expect(result).toMatchObject({ totalBuyVolume: 5000000, totalSellVolume: 4000000 });
        expect(result.days[0]).toMatchObject({ businessDate: '20260922', buyVolume: 500000, sellVolume: 400000 });
    });
});

describe('fetchInvestorTradingHistory', () => {
    it('투자자 유형마다 필드 이름 규칙이 달라도 같은 모양으로 정리한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { stck_prpr: '71000' },
            output2: [{
                stck_bsop_date: '20260922', stck_oprc: '70500', stck_hgpr: '71500', stck_lwpr: '70000', stck_clpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71',
                acml_vol: '9000000', acml_tr_pbmn: '639000000000',
                frgn_ntby_qty: '1000', frgn_ntby_tr_pbmn: '71000000', frgn_seln_vol: '2000', frgn_shnu_vol: '3000', frgn_seln_tr_pbmn: '142000000', frgn_shnu_tr_pbmn: '213000000',
                frgn_reg_ntby_qty: '900', frgn_reg_ntby_pbmn: '63900000', frgn_reg_askp_qty: '1900', frgn_reg_bidp_qty: '2800', frgn_reg_askp_pbmn: '134900000', frgn_reg_bidp_pbmn: '198800000',
                pe_fund_ntby_vol: '-50', pe_fund_ntby_tr_pbmn: '-3550000', pe_fund_seln_vol: '80', pe_fund_shnu_vol: '30',
                etc_corp_ntby_vol: '20', etc_orgt_ntby_vol: '-5', fund_ntby_qty: '400',
            }],
        }));

        const [day] = await newKis().fetchInvestorTradingHistory('005930/KRW');

        const call = find('/quotations/investor-trade-by-stock-daily');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPTJ04160001');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_DATE_1: '20260923', FID_ORG_ADJ_PRC: '', FID_ETC_CLS_CODE: '' });
        expect(day).toMatchObject({ businessDate: '20260922', open: 70500, high: 71500, low: 70000, close: 71000, volume: 9000000, amount: 639000000000 });
        expect(Object.keys(day!.investors)).toHaveLength(15);
        expect(day!.investors.foreign).toEqual({ netBuyVolume: 1000, netBuyAmount: 71000000, buyVolume: 3000, buyAmount: 213000000, sellVolume: 2000, sellAmount: 142000000 });
        expect(day!.investors.foreignRegistered).toEqual({ netBuyVolume: 900, netBuyAmount: 63900000, buyVolume: 2800, buyAmount: 198800000, sellVolume: 1900, sellAmount: 134900000 });
        expect(day!.investors.privateFund).toMatchObject({ netBuyVolume: -50, netBuyAmount: -3550000, sellVolume: 80, buyVolume: 30 });
        expect(day!.investors.otherCorporation.netBuyVolume).toBe(20);
        expect(day!.investors.otherOrganization.netBuyVolume).toBe(-5);
        expect(day!.investors.pensionFund.netBuyVolume).toBe(400);
    });
});

describe('fetchInvestorEstimates', () => {
    it('종목코드만 보내고 output2 의 가집계를 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output2: [{ bsop_hour_gb: '1', frgn_fake_ntby_qty: '1000', orgn_fake_ntby_qty: '-200', sum_fake_ntby_qty: '800' }],
        }));

        const [slot] = await newKis().fetchInvestorEstimates('005930/KRW');

        const call = find('/quotations/investor-trend-estimate');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHPTJ04160200');
        expect(queryOf(call)).toEqual({ MKSC_SHRN_ISCD: '005930' });
        expect(slot).toMatchObject({ timeSlot: '1', foreignNetBuyVolume: 1000, institutionNetBuyVolume: -200, totalNetBuyVolume: 800 });
    });
});

describe('fetchForeignTradeTicks', () => {
    it('둘째 종목코드는 예제값 99999 를 보내고, 외국인과 외국계 값을 나눠 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                bsop_hour: '100000', stck_prpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', acml_vol: '3000000',
                frgn_seln_vol: '10000', frgn_shnu_vol: '15000', glob_ntby_qty: '4000', frgn_ntby_qty_icdc: '300',
            }],
        }));

        const [tick] = await newKis().fetchForeignTradeTicks('005930/KRW');

        const call = find('/quotations/frgnmem-pchs-trend');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST644400C0');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_ISCD_2: '99999' });
        expect(tick).toMatchObject({
            time: '100000', price: 71000, cumulativeVolume: 3000000, foreignSellVolume: 10000, foreignBuyVolume: 15000, foreignBrokerNetBuyVolume: 4000, foreignNetBuyChange: 300,
        });
    });
});

describe('fetchMemberDailyTrading', () => {
    it('회원사코드와 기간을 보내고 일별 매매를 정리한다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stck_bsop_date: '20260922', total_seln_qty: '5000', total_shnu_qty: '7000', ntby_qty: '2000', stck_prpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', acml_vol: '9000000' }],
        }));

        const [day] = await newKis().fetchMemberDailyTrading('005930/KRW', '00003', Date.parse('2026-09-01T00:00:00Z'));

        const call = find('/quotations/inquire-member-daily');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST04540000');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_ISCD_2: '00003', FID_INPUT_DATE_1: '20260901', FID_INPUT_DATE_2: '20260923', FID_SCTN_CLS_CODE: '',
        });
        expect(day).toMatchObject({ businessDate: '20260922', sellVolume: 5000, buyVolume: 7000, netBuyVolume: 2000, price: 71000, volume: 9000000 });
    });

    it('회원사코드나 since 가 없으면 보내기 전에 ArgumentsRequired 다', async () => {
        const broker = newKis();
        await expect(broker.fetchMemberDailyTrading('005930/KRW', '', Date.now())).rejects.toThrow(ArgumentsRequired);
        await expect(broker.fetchMemberDailyTrading('005930/KRW', '00003', undefined as unknown as number)).rejects.toThrow(ArgumentsRequired);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('프로그램 매매 추이', () => {
    const FLOW = {
        whol_smtn_seln_vol: '1000', whol_smtn_shnu_vol: '1500', whol_smtn_ntby_qty: '500', whol_smtn_seln_tr_pbmn: '71000000',
        whol_smtn_shnu_tr_pbmn: '106500000', whol_smtn_ntby_tr_pbmn: '35500000', whol_ntby_vol_icdc: '100',
    };
    const EXPECTED = { sellVolume: 1000, buyVolume: 1500, netBuyVolume: 500, sellAmount: 71000000, buyAmount: 106500000, netBuyAmount: 35500000, netBuyVolumeChange: 100 };

    it('체결은 시각별로, 순매수 대금 증감은 whol_ntby_tr_pbmn_icdc 로 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ bsop_hour: '100500', stck_prpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', acml_vol: '3000000', ...FLOW, whol_ntby_tr_pbmn_icdc: '7100000' }],
        }));

        const [tick] = await newKis().fetchProgramTradingTicks('005930/KRW');

        const call = find('/quotations/program-trade-by-stock');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPPG04650101');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' });
        expect(tick).toMatchObject({ time: '100500', price: 71000, cumulativeVolume: 3000000, ...EXPECTED, netBuyAmountChange: 7100000 });
    });

    it('일별은 날짜가 없으면 비워 보내고, 순매수 대금 증감은 whol_ntby_tr_pbmn_icdc2 로 읽는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{ stck_bsop_date: '20260922', stck_clpr: '71000', prdy_vrss: '500', prdy_ctrt: '0.71', acml_vol: '9000000', acml_tr_pbmn: '639000000000', ...FLOW, whol_ntby_tr_pbmn_icdc2: '-7100000' }],
        }));

        const [day] = await newKis().fetchProgramTradingHistory('005930/KRW');

        const call = find('/quotations/program-trade-by-stock-daily');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPPG04650201');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_DATE_1: '' });
        expect(day).toMatchObject({ businessDate: '20260922', close: 71000, volume: 9000000, amount: 639000000000, ...EXPECTED, netBuyAmountChange: -7100000 });
    });

    it('일별 기준일은 params.until 의 한국 날짜로 보낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: [] }));

        await newKis().fetchProgramTradingHistory('005930/KRW', undefined, undefined, { until: Date.parse('2026-09-21T16:00:00Z') });

        expect(queryOf(find('/quotations/program-trade-by-stock-daily')).FID_INPUT_DATE_1).toBe('20260922');
    });
});

describe('해외 종목', () => {
    const CASES: Array<[string, (b: ReturnType<typeof newKis>) => Promise<unknown>]> = [
        ['fetchCreditBalanceHistory', (b) => b.fetchCreditBalanceHistory('AAPL/USD')],
        ['fetchStockLendingHistory', (b) => b.fetchStockLendingHistory('AAPL/USD')],
        ['fetchShortSaleHistory', (b) => b.fetchShortSaleHistory('AAPL/USD')],
        ['fetchBuySellVolumeHistory', (b) => b.fetchBuySellVolumeHistory('AAPL/USD')],
        ['fetchInvestorTradingHistory', (b) => b.fetchInvestorTradingHistory('AAPL/USD')],
        ['fetchInvestorEstimates', (b) => b.fetchInvestorEstimates('AAPL/USD')],
        ['fetchForeignTradeTicks', (b) => b.fetchForeignTradeTicks('AAPL/USD')],
        ['fetchMemberDailyTrading', (b) => b.fetchMemberDailyTrading('AAPL/USD', '00003', Date.now())],
        ['fetchProgramTradingTicks', (b) => b.fetchProgramTradingTicks('AAPL/USD')],
        ['fetchProgramTradingHistory', (b) => b.fetchProgramTradingHistory('AAPL/USD')],
        ['fetchExpectedPriceTrend', (b) => b.fetchExpectedPriceTrend('AAPL/USD')],
        ['fetchVolumeProfile', (b) => b.fetchVolumeProfile('AAPL/USD')],
        ['fetchTradeShareByAmount', (b) => b.fetchTradeShareByAmount('AAPL/USD')],
    ];

    it.each(CASES)('%s 는 BadSymbol 이고 요청을 보내지 않는다', async (_name, call) => {
        await expect(call(newKis({ masterData: KIS_MASTER_FIXTURE }))).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchProgramTradingByInvestor', () => {
    it('거래소구분과 시장 코드(코스피 1, 코스닥 4)를 보내고 전체, 차익, 비차익을 나눠 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{
                invr_cls_code: '8000', invr_cls_name: '개인', all_seln_qty: '100', all_seln_amt: '7100000', all_shnu_qty: '150', all_shnu_amt: '10650000',
                all_ntby_qty: '50', all_ntby_amt: '3550000', arbt_seln_qty: '10', arbt_shnu_qty: '20', arbt_ntby_qty: '10', nabt_ntby_qty: '40',
            }],
        }));

        const [row] = await newKis().fetchProgramTradingByInvestor('KOSDAQ');

        const call = find('/quotations/investor-program-trade-today');
        expect(headersOf(mockFetch, call).tr_id).toBe('HHPPG046600C1');
        expect(queryOf(call)).toEqual({ EXCH_DIV_CLS_CODE: 'J', MRKT_DIV_CLS_CODE: '4' });
        expect(row).toMatchObject({
            investorCode: '8000', investorName: '개인',
            total: { sellVolume: 100, sellAmount: 7100000, buyVolume: 150, buyAmount: 10650000, netBuyVolume: 50, netBuyAmount: 3550000 },
            arbitrage: { sellVolume: 10, buyVolume: 20, netBuyVolume: 10 },
            nonArbitrage: { netBuyVolume: 40 },
        });
    });

    it('KOSPI, KOSDAQ 밖의 시장이면 보내기 전에 BadRequest 다', async () => {
        await expect(newKis().fetchProgramTradingByInvestor('KONEX' as never)).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchMarketInvestorTrading', () => {
    it('시장 코드와 업종코드를 두 업종 입력에 같이 보내고, 날짜 기본값은 오늘이며 둘째 날짜도 같다', async () => {
        fixKstSep23();
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                stck_bsop_date: '20260923', bstp_nmix_prpr: '2600.5', bstp_nmix_prdy_vrss: '10.5', bstp_nmix_prdy_ctrt: '0.41', bstp_nmix_oprc: '2590',
                bstp_nmix_hgpr: '2605', bstp_nmix_lwpr: '2588', frgn_ntby_qty: '1000', frgn_ntby_tr_pbmn: '71000000', pe_fund_ntby_vol: '-30',
            }],
        }));

        const [day] = await newKis().fetchMarketInvestorTrading('KOSPI', '0001');

        const call = find('/quotations/inquire-investor-daily-by-market');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPTJ04040000');
        expect(queryOf(call)).toEqual({
            FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001', FID_INPUT_DATE_1: '20260923', FID_INPUT_ISCD_1: 'KSP', FID_INPUT_DATE_2: '20260923', FID_INPUT_ISCD_2: '0001',
        });
        expect(day).toMatchObject({ businessDate: '20260923', indexPrice: 2600.5, indexChange: 10.5, indexChangeRate: 0.41, indexOpen: 2590, indexHigh: 2605, indexLow: 2588 });
        expect(day!.investors.foreign).toEqual({ netBuyVolume: 1000, netBuyAmount: 71000000, buyVolume: undefined, buyAmount: undefined, sellVolume: undefined, sellAmount: undefined });
        expect(day!.investors.privateFund.netBuyVolume).toBe(-30);
    });

    it('업종코드가 네 자리가 아니면 보내기 전에 BadRequest 다', async () => {
        await expect(newKis().fetchMarketInvestorTrading('KOSDAQ', 'KSQ')).rejects.toThrow(BadRequest);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchMarketFunds', () => {
    it('날짜가 없으면 비워 보내고 증시자금 항목을 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                bsop_date: '20260922', bstp_nmix_prpr: '2600', bstp_nmix_prdy_vrss: '10', prdy_ctrt: '0.39', hts_avls: '2100000', cust_dpmn_amt: '550000',
                cust_dpmn_amt_prdy_vrss: '-1200', amt_tnrt: '0.52', uncl_amt: '9000', crdt_loan_rmnd: '180000', futs_tfam_amt: '12000',
                sttp_amt: '800000', mxtp_amt: '300000', bntp_amt: '1200000', mmf_amt: '1900000', secu_lend_amt: '210000',
            }],
        }));

        const [day] = await newKis().fetchMarketFunds();

        const call = find('/quotations/mktfunds');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST649100C0');
        expect(queryOf(call)).toEqual({ FID_INPUT_DATE_1: '' });
        expect(day).toMatchObject({
            businessDate: '20260922', indexPrice: 2600, marketCap: 2100000, customerDeposit: 550000, customerDepositChange: -1200, turnoverRate: 0.52,
            unsettledAmount: 9000, creditLoanBalance: 180000, futuresDeposit: 12000, equityFunds: 800000, mixedFunds: 300000, bondFunds: 1200000,
            moneyMarketFunds: 1900000, collateralLoanBalance: 210000,
        });
    });
});

describe('종목 시세분석', () => {
    it('fetchExpectedPriceTrend 는 전체(0)를 보내고 예상 체결 값과 시각별 추이를 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { antc_cnpr: '71200', antc_cntg_vrss: '200', antc_cntg_prdy_ctrt: '0.28', antc_vol: '50000', antc_tr_pbmn: '3560000000' },
            output2: [{ stck_bsop_date: '20260922', stck_cntg_hour: '085500', stck_prpr: '71200', prdy_vrss: '200', prdy_ctrt: '0.28', acml_vol: '50000' }],
        }));

        const trend = await newKis().fetchExpectedPriceTrend('005930/KRW');

        const call = find('/quotations/exp-price-trend');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST01810000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_MKOP_CLS_CODE: '0' });
        expect(trend).toMatchObject({ expectedPrice: 71200, expectedChange: 200, expectedChangeRate: 0.28, expectedVolume: 50000, expectedAmount: 3560000000 });
        expect(trend.points[0]).toMatchObject({ timestamp: Date.parse('2026-09-21T23:55:00Z'), price: 71200, volume: 50000 });
    });

    it('fetchVolumeProfile 은 화면 코드와 빈 입력시간을 보내고 가격대별 거래를 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: { wghn_avrg_stck_prc: '70850', lstn_stcn: '5969782550' },
            output2: [{ data_rank: '1', stck_prpr: '71000', cntg_vol: '300000', acml_vol_rlim: '12.5' }],
        }));

        const profile = await newKis().fetchVolumeProfile('005930/KRW');

        const call = find('/quotations/pbar-tratio');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST01130000');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_COND_SCR_DIV_CODE: '20113', FID_INPUT_HOUR_1: '' });
        expect(profile).toMatchObject({ weightedAveragePrice: 70850, listedShares: 5969782550 });
        expect(profile.levels[0]).toMatchObject({ rank: 1, price: 71000, volume: 300000, share: 12.5 });
    });

    it('fetchTradeShareByAmount 는 체결금액 구간별 매수·매도를 정리한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [{
                prpr_name: '1천만원 이상', smtn_avrg_prpr: '71000', acml_vol: '2000000', whol_ntby_qty_rate: '3.5', ntby_cntg_csnu: '120',
                seln_cnqn_smtn: '900000', whol_seln_vol_rate: '45', seln_cntg_csnu: '800', shnu_cnqn_smtn: '1100000', whol_shun_vol_rate: '55', shnu_cntg_csnu: '920',
            }],
        }));

        const [bucket] = await newKis().fetchTradeShareByAmount('005930/KRW');

        const call = find('/quotations/tradprt-byamt');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHKST111900C0');
        expect(queryOf(call)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '11119', FID_INPUT_ISCD: '005930' });
        expect(bucket).toMatchObject({
            bucket: '1천만원 이상', averagePrice: 71000, volume: 2000000, netBuyRate: 3.5, netBuyCount: 120, sellVolume: 900000, sellVolumeRate: 45,
            sellCount: 800, buyVolume: 1100000, buyVolumeRate: 55, buyCount: 920,
        });
    });
});
