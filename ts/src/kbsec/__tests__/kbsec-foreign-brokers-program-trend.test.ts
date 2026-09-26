/**
 * @fileoverview `kbsec.fetchForeignBrokers`(`IVU10420`)와 `kbsec.fetchProgramTradingTrend`(`IVU10450`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { NotSupported } from '../../base/errors';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

const brokerRow = (s: string, b: string) => ({
    s_scrts_cmpny1: s, s_scrts_cmpny_nm1: s ? `매도${s}` : '', s_q1: '1,200', s_incrs_dcrs1: '-300', s_rt1_p2: '12.5',
    b_scrts_cmpny1: b, b_scrts_cmpny_nm1: b ? `매수${b}` : '', b_q1: '900', b_incrs_dcrs1: '100', b_rt1_p2: '9.25',
});

describe('fetchForeignBrokers', () => {
    it('KRX 로 종목코드를 보내고, 줄마다 매도와 매수 거래원을 짝지어 옮긴다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FOREIGN_BROKERS]: { out_RecordSize: '1', Record1: [brokerRow('035', '036')] } });

        const [row] = await newExchange().fetchForeignBrokers('005930/KRW');

        expect(trBody(mockFetch, KBSEC_TR.FOREIGN_BROKERS).dataBody).toEqual({ excg_clsf: '1', is_cd: '005930' });
        expect(row!.sell).toEqual({ code: '035', name: '매도035', quantity: 1200, change: -300, ratio: 12.5 });
        expect(row!.buy).toEqual({ code: '036', name: '매수036', quantity: 900, change: 100, ratio: 9.25 });
    });

    it('매도와 매수 거래원이 모두 빈 줄은 거르고, 한쪽만 있는 줄은 남긴다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.FOREIGN_BROKERS]: { Record1: [brokerRow('035', '036'), brokerRow('', '037'), brokerRow('', '')] } });

        const rows = await newExchange().fetchForeignBrokers('005930/KRW');

        expect(rows.map(r => [r.sell.code, r.buy.code])).toEqual([['035', '036'], ['', '037']]);
    });

    it('미국 종목은 NotSupported 다', async () => {
        await expect(newExchange().fetchForeignBrokers('AAPL/USD')).rejects.toBeInstanceOf(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchProgramTradingTrend', () => {
    it('기본은 KRX, 금액, 시간별이고 limit 이 없으면 조회건수를 비워 보낸다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.PROGRAM_TRADING_TREND]: { Record1: [] } });

        await newExchange().fetchProgramTradingTrend('005930/KRW');

        expect(trBody(mockFetch, KBSEC_TR.PROGRAM_TRADING_TREND).dataBody).toEqual({
            excg_clsf: '1', is_cd: '005930', amt_q_clsf: '1', prd_clsf: '1', inq_cnt: '',
        });
    });

    it('limit 은 조회건수로, params 는 기간구분을 바꾼다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.PROGRAM_TRADING_TREND]: { Record1: [] } });

        await newExchange().fetchProgramTradingTrend('005930/KRW', 30, { prd_clsf: '2' });

        expect(trBody(mockFetch, KBSEC_TR.PROGRAM_TRADING_TREND).dataBody).toMatchObject({ inq_cnt: '30', prd_clsf: '2' });
    });

    it('한 줄의 가격과 금액, 수량 필드를 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.PROGRAM_TRADING_TREND]: {
                Record1: [{
                    dt: '20260923', tm: '101500', excg_cd: 'KRX', now_prc: '71,500', bdy_cmpr: '500', up_dwn_r_p2: '0.70', acml_vlm: '5000000',
                    nt_b_amt: '-1200', nt_b_amt_incrs_dcrs: '-200', s_amt: '5200', b_amt: '4000', nt_b_q: '-17000', nt_b_q_incrs_dcrs: '-3000',
                    s_q: '73000', b_q: '56000',
                }],
            },
        });

        const [row] = await newExchange().fetchProgramTradingTrend('005930/KRW');

        expect(row).toMatchObject({
            date: '20260923', time: '101500', exchange: 'KRX', price: 71500, change: 500, percentage: 0.7, volume: 5000000,
            netBuyAmount: -1200, netBuyAmountChange: -200, sellAmount: 5200, buyAmount: 4000,
            netBuyQuantity: -17000, netBuyQuantityChange: -3000, sellQuantity: 73000, buyQuantity: 56000,
        });
    });

    it('미국 종목은 NotSupported 다', async () => {
        await expect(newExchange().fetchProgramTradingTrend('AAPL/USD')).rejects.toBeInstanceOf(NotSupported);
    });
});
