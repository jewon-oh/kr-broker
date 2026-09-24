/**
 * @fileoverview `kbsec.fetchRankings` — 등락률상위(`IVU10240`)·거래량상위(`IVU10280`)·프로그램매매상위(`IVS10920`)·거래대금상위(`IVU10210`)·
 * 시가대비등락률상위(`IVS10910`)·기간외등락률순위(`IVS11190`)·급등급락상위(`IVU10270`) 일곱만 지원한다. 국내만 지원한다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { NotSupported } from '../../base/errors';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchRankings', () => {
    it('FLUCTUATION 은 등락률상위(IVU10240)를 부르고 공통 필드로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.RANK_FLUCTUATION]: {
                Record1: [{ rnk: '1', is_cd: '005930', is_nm: '삼성전자', now_prc: '71000', bdy_cmpr: '1500', up_dwn_r_p2: '2.16', vlm: '12345' }],
            },
        });

        const [item] = await newExchange().fetchRankings('FLUCTUATION');

        expect(trBody(mockFetch, KBSEC_TR.RANK_FLUCTUATION).dataBody).toMatchObject({ excg_clsf: '0', mkt_clsf: '1', srt_clsf: '1' });
        expect(item).toMatchObject({
            rank: 1, symbol: '005930/KRW', name: '삼성전자', last: 71000, change: 1500, percentage: 2.16, volume: 12345,
        });
    });

    it('VOLUME 은 거래량상위(IVU10280)를 부르고 같은 모양으로 정리한다 — 거래량 필드명이 다르다(acml_vlm)', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.RANK_VOLUME]: {
                Record1: [{ rnk: '1', is_cd: '000660', is_nm: 'SK하이닉스', now_prc: '180000', bdy_cmpr: '3000', up_dwn_r_p2: '1.7', acml_vlm: '987654' }],
            },
        });

        const [item] = await newExchange().fetchRankings('VOLUME');

        expect(trBody(mockFetch, KBSEC_TR.RANK_VOLUME).dataBody).toMatchObject({ excg_clsf: '0', mkt_clsf: '1' });
        expect(item).toMatchObject({
            rank: 1, symbol: '000660/KRW', name: 'SK하이닉스', last: 180000, change: 3000, percentage: 1.7, volume: 987654,
        });
    });

    it('PROGRAM_TRADING 은 프로그램매매상위(IVS10920)를 부르고 같은 모양으로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.RANK_PROGRAM_TRADING]: {
                Record1: [{ rnk: '1', is_cd: '005380', is_nm: '현대차', now_prc: '250000', bdy_cmpr: '5000', up_dwn_r_p2: '2.04', vlm: '456789' }],
            },
        });

        const [item] = await newExchange().fetchRankings('PROGRAM_TRADING');

        expect(trBody(mockFetch, KBSEC_TR.RANK_PROGRAM_TRADING).dataBody).toMatchObject({ inq_cnt: '' });
        expect(item).toMatchObject({
            rank: 1, symbol: '005380/KRW', name: '현대차', last: 250000, change: 5000, percentage: 2.04, volume: 456789,
        });
    });

    it('TRADING_VALUE 는 거래대금상위(IVU10210)를 부르고 같은 모양으로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.RANK_TRADING_VALUE]: {
                Record1: [{ rnk: '1', is_cd: '005930', is_nm: '삼성전자', now_prc: '71000', bdy_cmpr: '1500', up_dwn_r_p2: '2.16', vlm: '12345', dl_tw_amt: '999999999' }],
            },
        });

        const [item] = await newExchange().fetchRankings('TRADING_VALUE');

        expect(trBody(mockFetch, KBSEC_TR.RANK_TRADING_VALUE).dataBody).toMatchObject({
            excg_clsf: '1', mkt_clsf: '1', thdy_bdy_clsf: '1', inq_cnt: '10', srt_clsf: '1',
        });
        expect(item).toMatchObject({
            rank: 1, symbol: '005930/KRW', name: '삼성전자', last: 71000, change: 1500, percentage: 2.16, volume: 12345,
        });
    });

    it('OPEN_CHANGE_RATE 는 시가대비등락률상위(IVS10910)를 부르고 같은 모양으로 정리한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.RANK_OPEN_CHANGE_RATE]: {
                Record1: [{ rnk: '1', is_cd: '000660', is_nm: 'SK하이닉스', now_prc: '180000', bdy_cmpr: '3000', up_dwn_r_p2: '1.7', vlm: '987654' }],
            },
        });

        const [item] = await newExchange().fetchRankings('OPEN_CHANGE_RATE');

        expect(trBody(mockFetch, KBSEC_TR.RANK_OPEN_CHANGE_RATE).dataBody).toMatchObject({ mkt_clsf: '1', inq_cnt: '10', srt_clsf: '1' });
        expect(item).toMatchObject({
            rank: 1, symbol: '000660/KRW', name: 'SK하이닉스', last: 180000, change: 3000, percentage: 1.7, volume: 987654,
        });
    });

    it('EXTENDED_HOURS_CHANGE_RATE 는 기간외등락률순위(IVS11190)를 부르고, 순위 필드가 없어 배열 순서를 순위로 쓴다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.RANK_EXTENDED_HOURS_CHANGE_RATE]: {
                Record1: [
                    { is_cd: '005930', is_nm: '삼성전자', now_prc: '71000', bdy_cmpr: '1500', up_dwn_r_p2: '2.16', vlm: '12345' },
                    { is_cd: '000660', is_nm: 'SK하이닉스', now_prc: '180000', bdy_cmpr: '3000', up_dwn_r_p2: '1.7', vlm: '987654' },
                ],
            },
        });

        const items = await newExchange().fetchRankings('EXTENDED_HOURS_CHANGE_RATE');

        expect(trBody(mockFetch, KBSEC_TR.RANK_EXTENDED_HOURS_CHANGE_RATE).dataBody).toMatchObject({ mkt_clsf: '1', srt_clsf: '1', thdy_bdy_clsf: '1' });
        expect(items).toMatchObject([
            { rank: 1, symbol: '005930/KRW', name: '삼성전자', last: 71000 },
            { rank: 2, symbol: '000660/KRW', name: 'SK하이닉스', last: 180000 },
        ]);
    });

    it('SURGE_PLUNGE 는 급등/급락 상위(IVU10270)를 부른다 — 기본은 급등', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.RANK_SURGE_PLUNGE]: {
                Record1: [{ is_cd: '005930', is_nm: '삼성전자', now_prc: '71000', bdy_cmpr: '1500', up_dwn_r_p2: '2.16', vlm: '12345' }],
            },
        });

        const [item] = await newExchange().fetchRankings('SURGE_PLUNGE');

        expect(trBody(mockFetch, KBSEC_TR.RANK_SURGE_PLUNGE).dataBody).toMatchObject({ up_dwn_ccd: '1' });
        expect(item).toMatchObject({ rank: 1, symbol: '005930/KRW', name: '삼성전자' });
    });

    it('SURGE_PLUNGE 는 params.up_dwn_ccd 를 2 로 주면 급락을 부른다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.RANK_SURGE_PLUNGE]: { Record1: [] } });

        await newExchange().fetchRankings('SURGE_PLUNGE', { up_dwn_ccd: '2' });

        expect(trBody(mockFetch, KBSEC_TR.RANK_SURGE_PLUNGE).dataBody).toMatchObject({ up_dwn_ccd: '2' });
    });

    it('구현하지 않은 종류는 NotSupported', async () => {
        await expect(newExchange().fetchRankings('MARKET_CAP' as never)).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
