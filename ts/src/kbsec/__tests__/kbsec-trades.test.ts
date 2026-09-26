/**
 * @fileoverview `kbsec.fetchTrades`의 시간대별 체결(`IVU10080`, 국내만)과 체결 날짜를 정하는 일봉(`IVS11560`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker } from '../../testing';
import { CREDS, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fetchTrades', () => {
    it('체결가·체결수량을 채우고 방향은 undefined 로 둔다(코드값 근거 없음)', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: {
                Record1: [{ ccls_tm: '093015', ccls_prc: '71000', ccls_q: '10', sell_buy_ccd: '1', acml_vlm: '12345' }],
            },
        });

        const [trade] = await newExchange().fetchTrades('005930/KRW');

        expect(trBody(mockFetch, KBSEC_TR.TRADES_TIMELINE_KR).dataBody).toMatchObject({
            excg_clsf: '1', is_cd: '005930', ovtm_mkt_clsf: '0',
        });
        expect(trade).toMatchObject({ symbol: '005930/KRW', price: 71000, amount: 10, side: undefined, id: undefined });
    });

    it('params 로 시간외장구분을 덮어쓸 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.TRADES_TIMELINE_KR]: { Record1: [] } });

        await newExchange().fetchTrades('005930/KRW', undefined, undefined, { ovtm_mkt_clsf: '1' });

        expect(trBody(mockFetch, KBSEC_TR.TRADES_TIMELINE_KR).dataBody).toMatchObject({ ovtm_mkt_clsf: '1' });
    });

    it('since 를 미래로 주면 전부 걸러진다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: {
                Record1: [{ ccls_tm: '093015', ccls_prc: '71000', ccls_q: '10' }],
            },
        });

        const trades = await newExchange().fetchTrades('005930/KRW', Date.now() + 24 * 60 * 60 * 1000);

        expect(trades).toEqual([]);
    });

    it('since 없이 부르면 전부 반환한다', async () => {
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: {
                Record1: [{ ccls_tm: '093015', ccls_prc: '71000', ccls_q: '10' }, { ccls_tm: '093020', ccls_prc: '71100', ccls_q: '5' }],
            },
        });

        const trades = await newExchange().fetchTrades('005930/KRW');

        expect(trades).toHaveLength(2);
    });
});

describe('fetchTrades 체결 날짜(일봉 기준)', () => {
    /** 2026-03-25(수) 10:00 KST. */
    const NOW = Date.UTC(2026, 2, 25, 1, 0, 0);
    const trades = (...times: string[]) => ({ Record1: times.map((ccls_tm) => ({ ccls_tm, ccls_prc: '71000', ccls_q: '1' })) });
    const days = (...rows: Array<[string, string]>) => ({ Record1: rows.map(([dt, vlm]) => ({ dt, tm: '0', cls_prc_p2: '71000.00', vlm })) });
    const datetimes = (list: Array<{ datetime?: string | undefined }>) => list.map((trade) => trade.datetime);

    const at = (now: number) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now);
    };

    it('장중이면 오늘 일봉(거래량 있음)의 날짜를 붙인다. 시계 차이 1분 안의 체결은 받아들인다', async () => {
        at(NOW);
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: trades('100020', '095958'),
            [KBSEC_TR.CHART_KR]: days(['20260325', '1520000'], ['20260324', '9800000']),
        });

        const result = await newExchange().fetchTrades('005930/KRW');

        expect(trBody(mockFetch, KBSEC_TR.CHART_KR).dataBody).toMatchObject({ is_cd: '005930', chrt_clsf: 'D', inq_cnt: '30' });
        expect(datetimes(result)).toEqual(['2026-03-25T01:00:20.000Z', '2026-03-25T00:59:58.000Z']);
    });

    it.each([
        ['장 전(거래량 0 인 오늘 일봉은 건너뛴다)', Date.UTC(2026, 2, 24, 23, 0, 0), days(['20260325', '0'], ['20260324', '12000000']), '2026-03-24'],
        ['주말', Date.UTC(2026, 2, 28, 1, 0, 0), days(['20260327', '12000000'], ['20260326', '9000000']), '2026-03-27'],
    ])('%s이면 직전 영업일 날짜를 붙인다', async (_label, now, chart, day) => {
        at(now);
        routeTr(mockFetch, { [KBSEC_TR.TRADES_TIMELINE_KR]: trades('153000', '152959'), [KBSEC_TR.CHART_KR]: chart });

        const result = await newExchange().fetchTrades('005930/KRW');

        expect(datetimes(result)).toEqual([`${day}T06:30:00.000Z`, `${day}T06:29:59.000Z`]);
    });

    it('저유동 종목이면 거래량이 있는 마지막 일봉(며칠 전)의 날짜를 붙인다', async () => {
        at(NOW);
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: trades('143000', '110000'),
            [KBSEC_TR.CHART_KR]: days(['20260325', '0'], ['20260324', '0'], ['20260323', '0'], ['20260320', '150'], ['20260319', '80']),
        });

        const result = await newExchange().fetchTrades('247540/KRW');

        expect(datetimes(result)).toEqual(['2026-03-20T05:30:00.000Z', '2026-03-20T02:00:00.000Z']);
    });

    it('앞 행보다 시각이 늦은 행이 나오면 그 행부터 끝까지 timestamp 를 비운다. since 를 주면 빈 행은 빠진다', async () => {
        at(NOW);
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: trades('093500', '091000', '152000', '140000'),
            [KBSEC_TR.CHART_KR]: days(['20260325', '1520000'], ['20260324', '9800000']),
        });
        const exchange = newExchange();

        expect(datetimes(await exchange.fetchTrades('005930/KRW'))).toEqual(['2026-03-25T00:35:00.000Z', '2026-03-25T00:10:00.000Z', undefined, undefined]);
        expect(datetimes(await exchange.fetchTrades('005930/KRW', Date.UTC(2026, 2, 25, 0, 20)))).toEqual(['2026-03-25T00:35:00.000Z']);
    });

    it('일봉 조회가 실패하면 던지지 않고 모든 행의 timestamp 를 비운다', async () => {
        at(NOW);
        routeTr(mockFetch, { [KBSEC_TR.TRADES_TIMELINE_KR]: trades('095959', '095958'), [KBSEC_TR.CHART_KR]: '조회 실패' });

        const result = await newExchange().fetchTrades('005930/KRW');

        expect(result.map((trade) => trade.timestamp)).toEqual([undefined, undefined]);
    });

    it('가장 새 체결이 그 날짜로 보아 지금보다 1분 넘게 늦으면 모든 행의 timestamp 를 비운다', async () => {
        at(NOW);
        routeTr(mockFetch, {
            [KBSEC_TR.TRADES_TIMELINE_KR]: trades('153000', '152959'),
            [KBSEC_TR.CHART_KR]: days(['20260325', '1520000'], ['20260324', '9800000']),
        });

        const result = await newExchange().fetchTrades('005930/KRW');

        expect(result.map((trade) => trade.timestamp)).toEqual([undefined, undefined]);
    });
});
