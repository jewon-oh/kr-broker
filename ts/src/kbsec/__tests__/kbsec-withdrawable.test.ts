/**
 * @fileoverview `kbsec.fetchWithdrawableAmount` — 익일·익익일 출금가능금액(`SWQN2302`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { BadResponse } from '../../base/errors';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchWithdrawableAmount', () => {
    it('구분코드는 설명이 있는 값 1 을 보내고, 출금가능금액과 예수금을 옮긴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.WITHDRAWABLE]: {
                ndy_o_amt_psbl_amt: '1,200,000', nxt2_dy_o_amt_psbl_amt: '1500000',
                tfnd_amt: '900000', ndy_tfnd_amt: '1200000', nxt2_dy_tfnd_amt: '1500000', mrtg_rt: '0',
            },
        });

        const result = await newExchange().fetchWithdrawableAmount();

        expect(trBody(mockFetch, KBSEC_TR.WITHDRAWABLE).dataBody).toEqual({ ccd: '1' });
        expect(result).toMatchObject({
            nextDay: 1200000, dayAfterNext: 1500000, deposit: 900000, nextDayDeposit: 1200000, dayAfterNextDeposit: 1500000,
        });
        expect(result.info).toHaveProperty('mrtg_rt', '0');
    });

    it('출금가능금액이 0 이면 0 을 돌려준다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.WITHDRAWABLE]: { ndy_o_amt_psbl_amt: '0', nxt2_dy_o_amt_psbl_amt: '0' } });

        await expect(newExchange().fetchWithdrawableAmount()).resolves.toMatchObject({ nextDay: 0, dayAfterNext: 0 });
    });

    it('출금가능금액 필드가 둘 다 없으면 0 대신 BadResponse 를 던진다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.WITHDRAWABLE]: { tfnd_amt: '900000' } });

        await expect(newExchange().fetchWithdrawableAmount()).rejects.toBeInstanceOf(BadResponse);
    });

    it('params 로 구분코드를 바꿔 보낼 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.WITHDRAWABLE]: { ndy_o_amt_psbl_amt: '1', nxt2_dy_o_amt_psbl_amt: '1' } });

        await newExchange().fetchWithdrawableAmount({ ccd: '' });

        expect(trBody(mockFetch, KBSEC_TR.WITHDRAWABLE).dataBody).toEqual({ ccd: '' });
    });
});
