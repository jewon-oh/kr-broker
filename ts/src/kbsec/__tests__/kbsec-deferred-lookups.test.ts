/**
 * @fileoverview 보류했던 KB 조회: 테마그룹(`IVS11430`), 업종랭킹(`IVM30010`), 해외 차트(`GSC10060`),
 * 예수금 상세(`SWQM2302`), 글로벌원마켓 증거금사용현황(`SPQN3390`), 원마켓플러스 매매정산 상세(`SKQO3390`), 원마켓플러스 주문가능금액 현황
 * (`SKQM3350`), 해외 주문가능금액(`SPQM2106`), 해외 체결현황(`SPQM2204`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { ArgumentsRequired, NotSupported } from '../../base/errors';
import { kbsecUsCandleTimestamp } from '../kbsec-chart';
import { KBSEC_ORDER_TR_CODES, KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fetchThemeGroups', () => {
    it('테마코드를 비워 보내고 한 줄을 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.THEME_GROUPS]: {
                inq_cnt: '1',
                Record1: [{
                    thm_cd: '0012', thm_nm: '2차전지', indx_p2: '1234.56', bdy_cmpr_ccd: '2', bdy_cmpr_p2: '12.5', bdy_cmpr_up_dwn_r_p2: '1.02',
                    opn_prc_tl_amt: '98000000', opn_prc_tl_amt_bdy_cmpr: '-1500', vlm: '3000000', dl_tw_amt: '4500', thm_is_c: '27',
                }],
            },
        });

        const rows = await newExchange().fetchThemeGroups();

        expect(trBody(mockFetch, KBSEC_TR.THEME_GROUPS).dataBody).toEqual({ thm_cd: '' });
        expect(rows).toEqual([{
            code: '0012', name: '2차전지', index: 1234.56, change: 12.5, percentage: 1.02, marketCap: 98000000, marketCapChange: -1500,
            volume: 3000000, tradingValue: 4500, stockCount: 27, info: expect.objectContaining({ bdy_cmpr_ccd: '2' }),
        }]);
    });

    it('themeCode 를 주면 그 값을 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.THEME_GROUPS]: { Record1: [] } });

        await newExchange().fetchThemeGroups('0012');

        expect(trBody(mockFetch, KBSEC_TR.THEME_GROUPS).dataBody).toEqual({ thm_cd: '0012' });
    });
});

describe('fetchSectorRanking', () => {
    // 실계좌 응답 모양: 머리 레코드 하나(시장 지수)와 업종 지수 배열(out2).
    const HEAD = { lngth: '00100', indx_id: 'KGG01P', indx_nm: '코스피', now_indx_p2: '2650.12', bdy_cmpr_ccd: '2', bdy_cmpr_p2: '12.34', up_dwn_r_p2: '0.47' };
    const SECTOR = { indx_id: 'KGS19P', indx_nm: '전기전자', now_indx_p2: '31000.5', bdy_cmpr_ccd: '5', bdy_cmpr_p2: '-10', up_dwn_r_p2: '-0.03' };

    it('시장을 설명된 코드로 보내고 머리 레코드는 market, out2 행은 sectors 로 옮긴다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.RANK_SECTOR]: { ...HEAD, out2_RecordSize: '1', out2: [SECTOR] } });

        const r = await newExchange().fetchSectorRanking('KOSDAQ');

        expect(trBody(mockFetch, KBSEC_TR.RANK_SECTOR).dataBody).toEqual({ mkt_clsf: '2' });
        expect(r.market).toMatchObject({ id: 'KGG01P', name: '코스피', value: 2650.12, change: 12.34, percentage: 0.47 });
        expect(r.sectors).toEqual([{ id: 'KGS19P', name: '전기전자', value: 31000.5, change: -10, percentage: -0.03, info: SECTOR }]);
        expect(r.info).toHaveProperty('out2');
    });

    it('코스피는 1 이고, 모르는 시장은 요청 없이 거절한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.RANK_SECTOR]: {} });
        const ex = newExchange();

        await ex.fetchSectorRanking('KOSPI');
        expect(trBody(mockFetch, KBSEC_TR.RANK_SECTOR).dataBody).toEqual({ mkt_clsf: '1' });

        mockFetch.mockClear();
        await expect(ex.fetchSectorRanking('KONEX' as never)).rejects.toThrow(NotSupported);
        expect(calledTrs(mockFetch)).toEqual([]);
    });
});

describe('fetchOverseasCandles', () => {
    const quoteOnNys = (body: Record<string, unknown>) => (body.krx_cd === 'NYS' ? { now_prc_p4: '180.5' } : { now_prc_p4: '0' });

    it('현재가 조회로 거래소코드를 찾고 전체 입력을 보낸다. 봉 시각은 미국 동부 시각을 UTC 로 바꾸고 원문도 둔다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.QUOTE_US]: quoteOnNys,
            [KBSEC_TR.CHART_US]: {
                hngl_is_nm: '애플', mrkt_prc_clsf: '지연', now_prc_p4: '180.5',
                Record1: [{ dt: '20260922', tm: '160000', opn_prc_p4: '178', hgh_prc_p4: '181', lw_prc_p4: '177.5', cls_prc_p4: '180.5', vlm: '5000', dl_tw_amt: '900000' }],
            },
        });

        const chart = await newExchange().fetchOverseasCandles('AAPL/USD');

        expect(trBody(mockFetch, KBSEC_TR.CHART_US).dataBody).toEqual({
            krx_cd: 'NYS', is_cd: 'AAPL', chrt_clsf: '3', bndl: '', mdfy_stk_prc_use_f: '', rcrd_c: '100', srch_strt_dy: '', clsf: '',
        });
        expect(chart.fields).toMatchObject({ hngl_is_nm: '애플', mrkt_prc_clsf: '지연' });
        // 봉 시각은 미국 동부 현지 시각이다(실계좌 확인). 2026-09-22 16:00 EDT = 20:00Z.
        expect(chart.candles).toEqual([{
            timestamp: Date.UTC(2026, 8, 22, 20, 0, 0),
            datetime: '2026-09-22T20:00:00.000Z',
            date: '20260922', time: '160000', open: 178, high: 181, low: 177.5, close: 180.5, volume: 5000, tradingValue: 900000,
            info: expect.objectContaining({ dt: '20260922' }),
        }]);
    });

    it('차트구분을 설명된 코드로 보내고 레코드수는 5000 을 넘기지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_US]: quoteOnNys, [KBSEC_TR.CHART_US]: {} });

        await newExchange().fetchOverseasCandles('AAPL', 'minute', 9000);

        expect(trBody(mockFetch, KBSEC_TR.CHART_US).dataBody).toMatchObject({ chrt_clsf: '2', rcrd_c: '5000' });
    });

    it('봉 시각 변환은 서머타임을 따른다 — 여름 EDT 는 4시간, 겨울 EST 는 5시간을 더하고 일봉은 현지 자정이다', () => {
        expect(kbsecUsCandleTimestamp('20260922', '093000')).toBe(Date.UTC(2026, 8, 22, 13, 30, 0));
        expect(kbsecUsCandleTimestamp('20260115', '093015')).toBe(Date.UTC(2026, 0, 15, 14, 30, 15));
        expect(kbsecUsCandleTimestamp('20260115', '')).toBe(Date.UTC(2026, 0, 15, 5, 0, 0));
        expect(kbsecUsCandleTimestamp('', '093000')).toBeUndefined();
    });

    it('국내 종목과 모르는 차트구분은 요청 없이 거절한다', async () => {
        routeTr(mockFetch, {});
        const ex = newExchange();

        await expect(ex.fetchOverseasCandles('005930/KRW')).rejects.toThrow(NotSupported);
        await expect(ex.fetchOverseasCandles('AAPL', 'second' as never)).rejects.toThrow(NotSupported);
        expect(calledTrs(mockFetch)).toEqual([]);
    });
});

describe('fetchDepositDetails / fetchOneMarketMarginUsage', () => {
    it('예수금 상세는 입력 없이 부르고 레코드를 원문으로 준다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.DEPOSIT_DETAIL]: { tfnd_amt: '1000000', sbt_tl_amt: '50000', mrtg_rt: '0' } });

        const raw = await newExchange().fetchDepositDetails();

        expect(trBody(mockFetch, KBSEC_TR.DEPOSIT_DETAIL).dataBody).toEqual({});
        expect(raw).toEqual({
            fields: { tfnd_amt: '1000000', sbt_tl_amt: '50000', mrtg_rt: '0' },
            grids: [],
            info: { tfnd_amt: '1000000', sbt_tl_amt: '50000', mrtg_rt: '0' },
        });
    });

    it('증거금사용현황은 머리 필드와 그리드를 나눠 원문으로 준다', async () => {
        const grid = [{ mgn_clsf: '1', mgn_clsf_nm: '원화', iso_cd: 'US', prt_clsf: '1', o_amt1: '100', data1: 'A' }];
        routeTr(mockFetch, { [KBSEC_TR.ONEMARKET_MARGIN_USAGE]: { iso_cd: 'US', stmt_dt: '20260922', grid_cnt3: '1', Record3: grid } });

        const raw = await newExchange().fetchOneMarketMarginUsage();

        expect(trBody(mockFetch, KBSEC_TR.ONEMARKET_MARGIN_USAGE).dataBody).toEqual({});
        expect(raw.fields).toEqual({ iso_cd: 'US', stmt_dt: '20260922', grid_cnt3: '1' });
        expect(raw.grids).toEqual([grid]);
    });
});

describe('fetchOneMarketSettlementDetail', () => {
    it('항목명과 항목데이터 네 개를 원문 문자열로 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.ONEMARKET_SETTLEMENT_DETAIL]: {
                grid_cnt: '1',
                Record1: [{
                    idx: '1', iso_cd: 'US', crncy_cd: 'USD', item_hngl_nm: '매수대금', item_eng_nm: 'BUY AMOUNT',
                    item_data1: '1,000.00', item_data2: '', item_data3: '0', item_data4: '20260922',
                }],
            },
        });

        const rows = await newExchange().fetchOneMarketSettlementDetail();

        expect(trBody(mockFetch, KBSEC_TR.ONEMARKET_SETTLEMENT_DETAIL).dataBody).toEqual({});
        expect(rows).toEqual([{
            index: '1', isoCode: 'US', currency: 'USD', name: '매수대금', englishName: 'BUY AMOUNT',
            values: ['1,000.00', '', '0', '20260922'], info: expect.objectContaining({ idx: '1' }),
        }]);
    });
});

describe('fetchOneMarketBuyingPower', () => {
    it('원화 머리 금액과 통화별 금액을 옮기고 통화코드가 빈 채움 행은 거른다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.ONEMARKET_BUYABLE_ALL]: {
                dmstc_orgn_ordr_psbl_amt: '5000000', dmstc_ofr_use_psbl_krw_amt: '4000000', dmstc_otr_crncy_use_amt: '0',
                fcr_tfnd_krw_exch_amt: '1400000', frsk_ust_sum_krw_amt: '70000', exch_mny_trgt_krw_ordr_mgn: '0', grid_cnt: '1',
                Record1: [{
                    crncy_cd: 'USD', ntn_nm: '미국', fcrncy_tfnd: '1000.5', fcrncy_use_psbl_amt_p2: '950.25',
                    fcrncy_unty_ordr_psbl_amt_p2: '3800', fcrncy_rcvbl_ordr_psbl_amt_p2: '0',
                }, {
                    // 실계좌 응답에는 통화코드가 빈 채움 행이 섞여 온다.
                    crncy_cd: '', ntn_nm: '', fcrncy_tfnd: '0', fcrncy_use_psbl_amt_p2: '0', fcrncy_unty_ordr_psbl_amt_p2: '0', fcrncy_rcvbl_ordr_psbl_amt_p2: '0',
                }],
            },
        });

        const power = await newExchange().fetchOneMarketBuyingPower();

        expect(trBody(mockFetch, KBSEC_TR.ONEMARKET_BUYABLE_ALL).dataBody).toEqual({});
        expect(power).toMatchObject({
            domesticOrderable: 5000000, domesticProvidedKrw: 4000000, domesticOtherCurrencyUsed: 0, foreignDepositInKrw: 1400000,
            unsettledOverseasInKrw: 70000, exchangeOrderMarginKrw: 0,
            currencies: [{ currency: 'USD', country: '미국', deposit: 1000.5, usable: 950.25, unifiedOrderable: 3800, receivableOrderable: 0 }],
        });
    });
});

describe('fetchOverseasOrderableAmount', () => {
    it('가격을 주면 해외주문가격으로 보내고 나머지는 비운다. 통화가 이름에 없는 금액은 옮기지 않는다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.BUYABLE_US]: {
                fcrncy_ordr_psbl_amt: '1000.5', ordr_psbl_q: '5', krw_ordr_psbl_amt: '1400000', frgn_ordr_prc_p4: '180.5',
                pcnt100_ordr_psbl_q: '5', pcnt100_ordr_psbl_amt: '902.5', ordr_psbl_amt_p2: '1000.5', is_mgn_r_p4: '100', rcvbl_psbl_f: 'N',
                aplc_mgn_r_p4: '100',
            },
        });

        const r = await newExchange().fetchOverseasOrderableAmount('AAPL/USD', 180.5);

        expect(trBody(mockFetch, KBSEC_TR.BUYABLE_US).dataBody).toEqual({
            crncy_cd: '', stnd_is_cd: 'AAPL', iso_cd: '', frgn_ordr_prc_p4: '180.5000', aplc_exch_r: '', ordr_prc: '',
        });
        expect(r).toEqual({
            foreignAmount: 1000.5, krwAmount: 1400000, maxQuantity: 5, fullMarginQuantity: 5, price: 180.5, marginRate: 100, appliedMarginRate: 100,
            info: expect.objectContaining({ pcnt100_ordr_psbl_amt: '902.5' }),
        });
    });

    it('국내 종목은 요청 없이 거절한다', async () => {
        routeTr(mockFetch, {});

        await expect(newExchange().fetchOverseasOrderableAmount('005930')).rejects.toThrow(NotSupported);
        expect(calledTrs(mockFetch)).toEqual([]);
    });
});

describe('fetchOverseasOrderStatus', () => {
    it('since 가 없으면 요청 없이 던진다', async () => {
        routeTr(mockFetch, {});

        await expect(newExchange().fetchOverseasOrderStatus()).rejects.toThrow(ArgumentsRequired);
        expect(calledTrs(mockFetch)).toEqual([]);
    });

    it('미국 현지 일자와 설명된 전체값을 보내고, 연속조회를 따라가며 단축종목코드를 옮긴다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-23T02:00:00Z')); // 미국 동부 9/22 22:00
        const row = (no: string) => ({
            ordr_dt: '20260922', ordr_tm: '223001', ordr_no: no, orgn_ordr_no: '', shrt_is_nm: 'APPLE', shrt_is_cd: 'AAPL', stnd_is_cd: 'US0378331005',
            ordr_st_nm: '체결', ordr_clsf_nm: '지정가', crncy_cd: 'USD', frgn_ordr_q_p6: '2', frgn_ordr_prc_p6: '180.5', ccls_q_p6: '2',
            frgn_ccls_prc_p6: '180.4', nccls_q_p6: '0', rfsl_rsn: '',
        });
        routeTr(mockFetch, {
            [KBSEC_TR.ORDER_STATUS_US]: (sent: Record<string, unknown>) => (sent.nxt_key === ''
                ? { nxt_key: 'K2', Record1: [row('9001')] }
                : { nxt_key: '', Record1: [row('9002')] }),
        });

        const result = await newExchange().fetchOverseasOrderStatus(Date.UTC(2026, 8, 21, 2, 0)); // 미국 동부 9/20 22:00

        expect(trBody(mockFetch, KBSEC_TR.ORDER_STATUS_US).dataBody).toEqual({
            strt_ordr_dt: '20260920', end_ordr_dt: '20260922', ccls_clsf: '0', frgn_krx_ccd: '', trd_clsf: '99', stnd_is_cd: '', iso_cd: '',
            krw_unty_mgn_rqst_f: '', dl_clsf: '0', drid_f: '', nxt_key: 'K2',
        });
        expect(result.truncated).toBe(false);
        expect(result.rows.map((r) => r.id)).toEqual(['9001', '9002']);
        expect(result.rows[0]).toMatchObject({
            date: '20260922', time: '223001', shortCode: 'AAPL', standardCode: 'US0378331005', name: 'APPLE', statusName: '체결',
            quantity: 2, price: 180.5, filledQuantity: 2, filledPrice: 180.4, remainingQuantity: 0,
        });
    });
});

describe('배선', () => {
    it('새 TR 9개가 API 트리에 조회로 올라 있고, 자료를 주지 않는 종목관리는 빠져 있다', () => {
        const api = newExchange().describe().api as Record<string, Record<string, Record<string, { cost: number; order?: boolean }>>>;
        const leaves = Object.values(api).flatMap((section) => Object.values(section).flatMap((methods) => Object.entries(methods)));
        const codes = [
            KBSEC_TR.THEME_GROUPS, KBSEC_TR.RANK_SECTOR, KBSEC_TR.CHART_US, KBSEC_TR.DEPOSIT_DETAIL,
            KBSEC_TR.ONEMARKET_MARGIN_USAGE, KBSEC_TR.ONEMARKET_SETTLEMENT_DETAIL, KBSEC_TR.ONEMARKET_BUYABLE_ALL, KBSEC_TR.BUYABLE_US,
            KBSEC_TR.ORDER_STATUS_US,
        ];
        for (const code of codes) {
            const leaf = leaves.find(([name]) => name === code.toLowerCase());
            expect(leaf, code).toBeDefined();
            expect(leaf?.[1].order, code).toBeUndefined();
            expect(KBSEC_ORDER_TR_CODES.has(code), code).toBe(false);
        }
        expect(leaves.find(([name]) => name === KBSEC_TR.MASTER_KR.toLowerCase())).toBeUndefined();
    });
});
