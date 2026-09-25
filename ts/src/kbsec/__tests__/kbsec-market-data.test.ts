/**
 * @fileoverview `kbsec` 시세 — `fetchTicker`·`fetchOrderBook`·`fetchOHLCV`.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { NotSupported, NullResponse } from '../../base/errors';
import { logger } from '../../logger';
import { KBSEC_TR } from '../kbsec-types';
import { kbsecCandleTimestamp } from '../kbsec-chart';
import { __resetKbsecTokenBreaker } from '../kbsec-token-breaker';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
});

describe('fetchTicker — 국내', () => {
    const KR_QUOTE = {
        now_prc: '70000', b_sq1_askprc: '69900', s_sq1_askprc: '70100', hgh_prc: '71000', lw_prc: '69000', opn_prc: '69500',
        up_dwn_r_p2: '6.68', acml_vlm: '1234567', bdy_vlm_cmpr_p2: '96.64',
    };

    it('입력은 excg_clsf 와 shrt_cd 다 — is_cd 를 보내면 "해당자료가 없습니다"가 온다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_KR]: KR_QUOTE });

        await newExchange().fetchTicker('005930/KRW');

        expect(trBody(mockFetch, KBSEC_TR.QUOTE_KR).dataBody).toEqual({ excg_clsf: '1', shrt_cd: '005930' });
    });

    it('문자열 숫자를 number 로 읽고 통합 구조에 채운다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_KR]: KR_QUOTE });

        const ticker = await newExchange().fetchTicker('005930/KRW');

        expect(ticker).toMatchObject({
            symbol: '005930/KRW', last: 70000, close: 70000, bid: 69900, ask: 70100, high: 71000, low: 69000, open: 69500, baseVolume: 1234567,
        });
        expect(ticker.info).toEqual(KR_QUOTE);
    });

    it('등락률은 up_dwn_r_p2 다 — 전일 거래량 대비(bdy_vlm_cmpr_p2)를 등락률로 읽지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_KR]: KR_QUOTE });

        expect((await newExchange().fetchTicker('005930/KRW')).percentage).toBe(6.68);
    });

    it('보합이면 등락률 0 이 정상 값이다 — 시가·종가로 다시 계산해 바꾸지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_KR]: { ...KR_QUOTE, up_dwn_r_p2: '0.00', opn_prc: '69000' } });

        expect((await newExchange().fetchTicker('005930/KRW')).percentage).toBe(0);
    });

    it('장 밖에서 now_prc 가 0 이면 종가로 폴백한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_KR]: { now_prc: '000000000', bdy_cls_prc: '68000' } });

        expect((await newExchange().fetchTicker('005930/KRW')).last).toBe(68000);
    });

    it('현재가도 종가도 없으면 NullResponse 다 — 0 을 가격으로 쓰지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_KR]: { now_prc: '000000000' } });

        await expect(newExchange().fetchTicker('005930/KRW')).rejects.toThrow(NullResponse);
    });

    it('시각을 지어내지 않는다 — 응답 시각을 모르면 timestamp 가 비어 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_KR]: KR_QUOTE });

        const ticker = await newExchange().fetchTicker('005930/KRW');

        expect(ticker.timestamp).toBeUndefined();
        expect(ticker.datetime).toBeUndefined();
    });
});

describe('fetchTicker — 해외', () => {
    const US_QUOTE = { now_prc_p4: '100.0000', b_askprc_p4: '99.9000', s_askprc_p4: '100.2000', hgh_prc_p4: '101', lw_prc_p4: '98', up_dwn_r_p2: '1.5', vlm: '5000' };

    it('_p4 계열 필드로 읽는다 — 국내 이름으로 읽으면 전부 실패한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_US]: US_QUOTE });

        const ticker = await newExchange().fetchTicker('AAPL/USD');

        expect(ticker).toMatchObject({ symbol: 'AAPL/USD', last: 100, bid: 99.9, ask: 100.2, high: 101, low: 98, percentage: 1.5, baseVolume: 5000 });
    });

    it('거래소코드를 순회한다 — 나스닥에 없으면 뉴욕에서 찾고, 찾은 코드를 기억한다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.QUOTE_US]: (body: Record<string, unknown>) => (body.krx_cd === 'NYS' ? US_QUOTE : {}) });
        const exchange = newExchange();

        await exchange.fetchTicker('XOM/USD');
        const firstRun = calledTrs(mockFetch).filter(tr => tr === KBSEC_TR.QUOTE_US.toLowerCase()).length;
        await exchange.fetchTicker('XOM/USD');
        const secondRun = calledTrs(mockFetch).filter(tr => tr === KBSEC_TR.QUOTE_US.toLowerCase()).length - firstRun;

        expect(firstRun).toBe(2); // NAS(빈 응답) → NYS
        expect(secondRun).toBe(1); // 기억한 코드로 한 번
        expect(trBody(mockFetch, KBSEC_TR.QUOTE_US).dataBody.krx_cd).toBe('NYS');
    });

    it('어느 거래소에서도 못 찾으면 NullResponse 다', async () => {
        routeTr(mockFetch, {});

        await expect(newExchange().fetchTicker('ZZZZ/USD')).rejects.toThrow(NullResponse);
    });
});

describe('fetchOrderBook', () => {
    it('국내 — 매수는 가격 내림차순, 매도는 오름차순이고 [가격, 수량]이다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDERBOOK_KR]: {
            b1_aprc: '69900', b_pstn_b1_aprc_q: '100', b2_aprc: '69800', b_pstn_b2_aprc_q: '200',
            s1_aprc: '70000', s_pstn_s1_aprc_q: '50', s2_aprc: '70100', s_pstn_s2_aprc_q: '60',
        } });

        const book = await newExchange().fetchOrderBook('005930/KRW');

        expect(book.symbol).toBe('005930/KRW');
        expect(book.bids).toEqual([[69900, 100], [69800, 200]]);
        expect(book.asks).toEqual([[70000, 50], [70100, 60]]);
        expect(trBody(mockFetch, KBSEC_TR.ORDERBOOK_KR).dataBody).toEqual({ is_cd: '005930', ovtm_mkt_clsf: '1' });
    });

    it('해외 — 필드 계열이 다르다(가격 b_askprc{N}_p4, 잔량 b_askprc_q{N})', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDERBOOK_US]: {
            b_askprc1_p4: '99.9', b_askprc_q1: '10', s_askprc1_p4: '100.1', s_askprc_q1: '20',
        } });

        const book = await newExchange().fetchOrderBook('AAPL/USD');

        expect(book.bids).toEqual([[99.9, 10]]);
        expect(book.asks).toEqual([[100.1, 20]]);
    });

    it('limit 은 각 쪽의 호가 수를 자른다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDERBOOK_KR]: {
            b1_aprc: '3', b2_aprc: '2', b3_aprc: '1', s1_aprc: '4', s2_aprc: '5', s3_aprc: '6',
        } });

        const book = await newExchange().fetchOrderBook('005930/KRW', 2);

        expect(book.bids.map(level => level[0])).toEqual([3, 2]);
        expect(book.asks.map(level => level[0])).toEqual([4, 5]);
    });

    it('호가가 하나도 없으면 NullResponse 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.ORDERBOOK_KR]: {} });

        await expect(newExchange().fetchOrderBook('005930/KRW')).rejects.toThrow(NullResponse);
    });
});

describe('fetchOHLCV — 국내(명세 기준, 실계좌 미검증)', () => {
    /** KB 는 `dt` 와 `tm` 을 long 으로 줘서 앞의 0 이 빠질 수 있다. 값은 한국 시각이다. */
    const ROWS = {
        Record1: [
            { dt: '20260819', tm: '91000', opn_prc_p2: '70100.00', hgh_prc_p2: '70300.00', lw_prc_p2: '70000.00', cls_prc_p2: '70200.00', vlm: '1500' },
            { dt: '20260819', tm: '90000', opn_prc_p2: '70000.00', hgh_prc_p2: '70200.00', lw_prc_p2: '69900.00', cls_prc_p2: '70100.00', vlm: '2500' },
        ],
    };

    it('명세의 필드 이름(opn_prc_p2 …)으로 읽고 시각은 한국 시각을 UTC 밀리초로 바꾼다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: ROWS });

        const candles = await newExchange().fetchOHLCV('005930/KRW', '1m');

        // 2026-08-19 09:00:00 KST = 00:00:00Z. 오래된 봉이 먼저다.
        expect(candles).toEqual([
            [Date.UTC(2026, 7, 19, 0, 0, 0), 70000, 70200, 69900, 70100, 2500],
            [Date.UTC(2026, 7, 19, 0, 10, 0), 70100, 70300, 70000, 70200, 1500],
        ]);
    });

    it('종전에는 존재하지 않는 필드(open_prc …)를 읽고 모든 봉의 시각이 현재가 됐다 — 이제는 봉마다 자기 시각이다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: ROWS });

        const candles = await newExchange().fetchOHLCV('005930/KRW', '1m');

        expect(new Set(candles.map(c => c[0])).size).toBe(2);
    });

    it('요청 — 분봉은 chrt_clsf B 와 분 단위, 조회 건수는 최대 9999 다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: {} });

        await newExchange().fetchOHLCV('005930/KRW', '5m', undefined, 50000);

        expect(trBody(mockFetch, KBSEC_TR.CHART_KR).dataBody).toMatchObject({
            is_cd: '005930', chrt_clsf: 'B', minute_tck_indx: '5', inq_clsf: '2', inq_cnt: '9999', info_ccd: '1',
        });
    });

    it('시장구분은 코스피로 보내고 params.mkt_clsf 로 코스닥을 고를 수 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: {} });

        await newExchange().fetchOHLCV('005930/KRW', '1d');
        await newExchange().fetchOHLCV('247540/KRW', '1d', undefined, undefined, { mkt_clsf: '1' });

        const bodies = mockFetch.mock.calls
            .filter(call => String(call[0]).endsWith(`/api/v1/${KBSEC_TR.CHART_KR.toLowerCase()}`))
            .map(call => JSON.parse((call[1] as { body: string }).body).dataBody);
        expect(bodies.map(b => b.mkt_clsf)).toEqual(['0', '1']);
    });

    it('일봉 — 시각이 없어도 거래일의 00:00 UTC 로 읽는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: { Record1: [{ dt: '20260819', tm: '0', cls_prc_p2: '70200.00' }] } });

        const [candle] = await newExchange().fetchOHLCV('005930/KRW', '1d');

        expect(candle![0]).toBe(Date.UTC(2026, 7, 19)); // 거래일 08-19 의 00:00 UTC
    });

    it('limit 은 최근 봉부터 자르고 since 는 그 시각 이후만 남긴다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: ROWS });

        const latest = await newExchange().fetchOHLCV('005930/KRW', '1m', undefined, 1);
        const recent = await newExchange().fetchOHLCV('005930/KRW', '1m', Date.UTC(2026, 7, 19, 0, 5, 0));

        expect(latest.map(c => c[0])).toEqual([Date.UTC(2026, 7, 19, 0, 10, 0)]);
        expect(recent.map(c => c[0])).toEqual([Date.UTC(2026, 7, 19, 0, 10, 0)]);
    });

    describe('since·until', () => {
        /** 2026-08-19 15:00 KST */
        const NOW = Date.UTC(2026, 7, 19, 6, 0, 0);
        const KST_MS = 9 * 60 * 60 * 1000;
        /** 한국 시각 ms → 명세의 `dt`·`tm` 행. 종가는 행을 가리는 표지다. */
        const kstRow = (ms: number, close: number) => {
            const iso = new Date(ms + KST_MS).toISOString();
            return { dt: iso.slice(0, 10).replaceAll('-', ''), tm: iso.slice(11, 19).replaceAll(':', ''), cls_prc_p2: String(close) };
        };
        /** 조회건수(`inq_cnt`)만큼 `NOW` 부터 거꾸로 `stepMs` 간격의 봉을 준다(가장 최근이 먼저). 종가는 봉의 한국 날짜(일)다. */
        const recentBars = (stepMs: number, anchor: number) => (sent: Record<string, unknown>) => ({
            Record1: Array.from({ length: Number(sent.inq_cnt) }, (_, i) => anchor - i * stepMs)
                .map((ms) => kstRow(ms, new Date(ms + KST_MS).getUTCDate())),
        });
        const DAY = 24 * 60 * 60 * 1000;
        /** 08-19 0시(KST) */
        const TODAY = Date.UTC(2026, 7, 18, 15, 0, 0);

        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(NOW);
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('since 가 있으면 지금부터 since 까지 덮을 만큼 받고 since 부터 limit 개를 돌려준다(최근 limit 개가 아니다)', async () => {
            routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: recentBars(DAY, TODAY) });

            const candles = await newExchange().fetchOHLCV('005930/KRW', '1d', TODAY - 8 * DAY, 2);

            expect(candles.map(c => c[4])).toEqual([11, 12]);
            // 08-11 0시부터 지금까지 달력으로 9일 남짓이다.
            expect(trBody(mockFetch, KBSEC_TR.CHART_KR).dataBody).toMatchObject({ inq_clsf: '2', inq_cnt: '10', strt_dy: '' });
        });

        it('until 뒤의 봉은 빼고 그 앞의 최근 limit 개를 돌려준다. until 은 TR 입력으로 보내지 않는다', async () => {
            routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: recentBars(DAY, TODAY) });

            // 일봉은 거래일의 00:00 UTC 다. 08-15 봉까지 받는다.
            const candles = await newExchange().fetchOHLCV('005930/KRW', '1d', undefined, 2, { until: Date.UTC(2026, 7, 15) });

            expect(candles.map(c => c[4])).toEqual([14, 15]);
            const sent = trBody(mockFetch, KBSEC_TR.CHART_KR).dataBody;
            expect(sent).not.toHaveProperty('until');
            expect(Number(sent.inq_cnt)).toBeGreaterThanOrEqual(2 + 4);
        });

        it('조회건수 상한(9999)으로도 since 에 닿지 못하면 경고를 남기고 받은 가장 오래된 봉부터 돌려준다', async () => {
            const warn = vi.spyOn(logger, 'warn');
            const MINUTE = 60 * 1000;
            routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: recentBars(MINUTE, NOW) });

            const candles = await newExchange().fetchOHLCV('005930/KRW', '1m', NOW - 30 * DAY, 2);

            expect(trBody(mockFetch, KBSEC_TR.CHART_KR).dataBody).toMatchObject({ inq_cnt: '9999' });
            expect(candles.map(c => c[0])).toEqual([NOW - 9998 * MINUTE, NOW - 9997 * MINUTE]);
            expect(warn).toHaveBeenCalledWith(expect.objectContaining({ symbol: '005930/KRW', count: 9999 }), expect.stringContaining('since 까지 받지 못했다'));
            warn.mockRestore();
        });
    });

    it('일자를 읽을 수 없는 행은 버린다 — 지어낸 시각으로 채우지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: { Record1: [{ dt: '', tm: '', cls_prc_p2: '1' }, ROWS.Record1[1]] } });

        expect(await newExchange().fetchOHLCV('005930/KRW', '1m')).toHaveLength(1);
    });

    it('범위를 넘는 시각(240000)의 행은 그날 0시로 두지 않고 버린다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.CHART_KR]: { Record1: [{ ...ROWS.Record1[0], tm: '240000' }, ROWS.Record1[1]] } });

        const candles = await newExchange().fetchOHLCV('005930/KRW', '1m');

        expect(candles.map(c => c[0])).toEqual([Date.UTC(2026, 7, 19, 0, 0, 0)]);
    });

    it('해외는 지원하지 않는다 — 해외 차트는 15분 지연 시세라 fetchOverseasCandles 로만 준다', async () => {
        await expect(newExchange().fetchOHLCV('AAPL/USD', '1d')).rejects.toThrow(NotSupported);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('알 수 없는 timeframe 은 NotSupported 다 — 일봉으로 바꿔 돌려주지 않는다', async () => {
        await expect(newExchange().fetchOHLCV('005930/KRW', '7x')).rejects.toThrow(NotSupported);
    });
});

describe('kbsecCandleTimestamp', () => {
    it('앞 0 이 빠진 시각을 채운다', () => {
        expect(kbsecCandleTimestamp('20260819', '90000')).toBe(Date.UTC(2026, 7, 19, 0, 0, 0));
        expect(kbsecCandleTimestamp('20260819', '')).toBe(Date.UTC(2026, 7, 18, 15, 0, 0));
    });

    it('읽을 수 없으면 undefined 다', () => {
        expect(kbsecCandleTimestamp('', '090000')).toBeUndefined();
        expect(kbsecCandleTimestamp('2026-08-19', '090000')).toBeUndefined();
    });
});
