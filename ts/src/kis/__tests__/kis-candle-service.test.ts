/**
 * `KisCandleService`(`kis.candles()`)의 국내 봉 메서드 네 개: 요청 인자와 결과.
 * 날짜 경계와 한국, 미국 동부 시각 변환은 실행 환경의 시간대(`process.env.TZ`)를 바꿔 가며 같은 값이 나오는지 본다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger } from '../../logger';
import { KisCandleService } from '../kis-candle-service';
import type { kis } from '../../kis';

type Params = Record<string, unknown>;
type Reply = { output2?: unknown } | Error;

/** 시계와 봉 조회 암묵 API 만 흉내 낸다. 인자를 기록하고 준비한 응답을 차례로 준다. 응답이 떨어지면 빈 `output2` 다. */
function fakeKis(nowMs: number, replies: { daily?: Reply[]; minute?: Reply[]; overseas?: Reply[] } = {}) {
    const calls = { daily: [] as Params[], minute: [] as Params[], overseas: [] as Params[] };
    const answer = (queue: Reply[] | undefined): { output2?: unknown } => {
        const next = queue?.shift() ?? { output2: [] };
        if (next instanceof Error) throw next;
        return next;
    };
    const exchange = {
        milliseconds: () => nowMs,
        privateGetUapiDomesticStockV1QuotationsInquireDailyItemchartprice: async (params: Params) => {
            calls.daily.push(params);
            return answer(replies.daily);
        },
        privateGetUapiDomesticStockV1QuotationsInquireTimeItemchartprice: async (params: Params) => {
            calls.minute.push(params);
            return answer(replies.minute);
        },
        privateGetUapiOverseasPriceV1QuotationsDailyprice: async (params: Params) => {
            calls.overseas.push(params);
            return answer(replies.overseas);
        },
    };
    return { service: new KisCandleService(exchange as unknown as kis), calls };
}

const dailyRow = (date: string, close: number) => ({
    stck_bsop_date: date, stck_oprc: String(close - 1), stck_hgpr: String(close + 1), stck_lwpr: String(close - 2), stck_clpr: String(close), acml_vol: '100',
});
const minuteRow = (hms: string, close: number, date = '20260925') => ({
    stck_bsop_date: date, stck_cntg_hour: hms, stck_oprc: String(close), stck_hgpr: String(close + 1), stck_lwpr: String(close - 1),
    stck_prpr: String(close), cntg_vol: '10',
});
/** 10:59 부터 1분씩 거슬러 `count` 개. 분봉 API 가 주는 순서(최근 먼저)다. */
const minutesBack = (count: number, close = 100) =>
    Array.from({ length: count }, (_, i) => minuteRow(`10${String(59 - i).padStart(2, '0')}00`, close + i));
const kst = (text: string) => Date.parse(`${text}+09:00`);

const NOW = Date.parse('2026-09-25T06:00:00Z'); // 한국 9/25 15:00

afterEach(() => {
    vi.restoreAllMocks();
});

describe('fetchDailyOHLCV', () => {
    it('limit × 1.5 일(주봉 ×7, 월봉 ×30) 전부터 오늘까지를 한국 날짜로 묻고, 종목코드와 기간 코드, 수정주가 여부, TR 을 싣는다', async () => {
        const { service, calls } = fakeKis(NOW);

        await service.fetchDailyOHLCV('005930', 'D', 10);
        await service.fetchDailyOHLCV('005930', 'W', 4);
        await service.fetchDailyOHLCV('005930', 'M', 2);

        expect(calls.daily[0]).toEqual({
            FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_DATE_1: '20260910', FID_INPUT_DATE_2: '20260925',
            FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0', tr_id: 'FHKST03010100',
        });
        expect(calls.daily.map((p) => [p.FID_PERIOD_DIV_CODE, p.FID_INPUT_DATE_1, p.FID_INPUT_DATE_2])).toEqual([
            ['D', '20260910', '20260925'], ['W', '20260814', '20260925'], ['M', '20260627', '20260925'],
        ]);
    });

    it('오래된 순으로 정렬해 마지막 limit 개를 돌려준다. 봉 시각은 그날 09:00 KST 다', async () => {
        const { service } = fakeKis(NOW, { daily: [{ output2: [dailyRow('20260924', 30), dailyRow('20260922', 10), dailyRow('20260925', 40), dailyRow('20260923', 20)] }] });

        const candles = await service.fetchDailyOHLCV('005930', 'D', 3);

        expect(candles).toEqual([
            [kst('2026-09-23T09:00:00'), 19, 21, 18, 20, 100],
            [kst('2026-09-24T09:00:00'), 29, 31, 28, 30, 100],
            [kst('2026-09-25T09:00:00'), 39, 41, 38, 40, 100],
        ]);
    });
});

describe('fetchDailyOHLCVPaged', () => {
    it('neededCandles 가 0 이하면 한 번도 부르지 않는다', async () => {
        const { service, calls } = fakeKis(NOW);

        expect(await service.fetchDailyOHLCVPaged('005930', 'D', 0)).toEqual([]);
        expect(await service.fetchDailyOHLCVPaged('005930', 'D', -5)).toEqual([]);
        expect(calls.daily).toHaveLength(0);
    });

    it('140일 창을 겹치지 않게 과거로 옮겨 부르고, 빈 창에서 멈추고, 겹친 봉은 한 번만 담아 오래된 순으로 합친다', async () => {
        const { service, calls } = fakeKis(0, {
            daily: [{ output2: [dailyRow('20260925', 30), dailyRow('20260508', 20)] }, { output2: [dailyRow('20260508', 21), dailyRow('20251220', 10)] }, { output2: [] }],
        });
        const onPage = vi.fn(async () => undefined);

        const candles = await service.fetchDailyOHLCVPaged('005930', 'W', 250, { nowMs: NOW, onPage });

        expect(calls.daily.map((p) => [p.FID_INPUT_DATE_1, p.FID_INPUT_DATE_2])).toEqual([
            ['20260509', '20260925'], ['20251220', '20260508'], ['20250802', '20251219'],
        ]);
        expect(calls.daily.every((p) => p.FID_PERIOD_DIV_CODE === 'W' && p.FID_INPUT_ISCD === '005930')).toBe(true);
        // 겹친 5/8 봉은 뒤 창의 것을 쓴다.
        expect(candles.map((c) => [c[0], c[4]])).toEqual([
            [kst('2025-12-20T09:00:00'), 10], [kst('2026-05-08T09:00:00'), 21], [kst('2026-09-25T09:00:00'), 30],
        ]);
        expect(onPage.mock.calls).toEqual([[0], [1]]);
    });

    it('창 수는 100봉에 하나, 최대 12개다', async () => {
        const rows = { output2: [dailyRow('20260925', 1)] };
        const { service, calls } = fakeKis(NOW, { daily: Array.from({ length: 20 }, () => rows) });

        await service.fetchDailyOHLCVPaged('005930', 'D', 5_000);

        expect(calls.daily).toHaveLength(12);
    });

    it('창 하나가 실패하면 그 오류를 그대로 던진다', async () => {
        const boom = new Error('EGW00201');
        const { service } = fakeKis(NOW, { daily: [{ output2: [dailyRow('20260925', 1)] }, boom] });
        vi.spyOn(logger, 'error').mockImplementation(() => undefined);

        await expect(service.fetchDailyOHLCVPaged('005930', 'D', 200)).rejects.toBe(boom);
    });
});

describe('fetchDailyOHLCVRange', () => {
    it('받은 기간을 그대로 싣고, 값을 숫자로 읽어 오래된 순으로 돌려준다', async () => {
        const { service, calls } = fakeKis(NOW, { daily: [{ output2: [dailyRow('20260522', 2), dailyRow('20260521', 1)] }] });

        const candles = await service.fetchDailyOHLCVRange('000660', 'M', '20260101', '20260522');

        expect(calls.daily).toEqual([{
            FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '000660', FID_INPUT_DATE_1: '20260101', FID_INPUT_DATE_2: '20260522',
            FID_PERIOD_DIV_CODE: 'M', FID_ORG_ADJ_PRC: '0', tr_id: 'FHKST03010100',
        }]);
        expect(candles).toEqual([[kst('2026-05-21T09:00:00'), 0, 2, -1, 1, 100], [kst('2026-05-22T09:00:00'), 1, 3, 0, 2, 100]]);
    });

    it('output2 가 배열이 아니면 빈 배열이다', async () => {
        const { service } = fakeKis(NOW, { daily: [{ output2: undefined }, { output2: { stck_bsop_date: '20260522' } }] });

        expect(await service.fetchDailyOHLCVRange('005930', 'D', '20260501', '20260522')).toEqual([]);
        expect(await service.fetchDailyOHLCVRange('005930', 'D', '20260501', '20260522')).toEqual([]);
    });

    it('실패는 빈 배열로 바꾸지 않고 로그를 남긴 뒤 그대로 던진다', async () => {
        const boom = new Error('network');
        const { service } = fakeKis(NOW, { daily: [boom] });
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

        await expect(service.fetchDailyOHLCVRange('005930', 'D', '20260501', '20260522')).rejects.toBe(boom);
        expect(error).toHaveBeenCalledWith(
            { err: boom, stockCode: '005930', periodCode: 'D', startDate: '20260501', endDate: '20260522' }, '[KISCandleService] 기간별 캔들 조회 실패');
    });
});

describe('fetchMinuteOHLCV', () => {
    it('첫 쪽은 커서 없이, 다음 쪽은 앞 쪽 마지막 시각을 커서로 묻고, 30건보다 적게 오면 멈춘다', async () => {
        const { service, calls } = fakeKis(NOW, { minute: [{ output2: minutesBack(30) }, { output2: [minuteRow('102900', 99)] }] });

        const candles = await service.fetchMinuteOHLCV('005930', 1, 100);

        expect(calls.minute).toEqual([
            { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_HOUR_1: '', FID_PW_DATA_INCU_YN: 'N', FID_ETC_CLS_CODE: '', tr_id: 'FHKST03010200' },
            { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_HOUR_1: '103000', FID_PW_DATA_INCU_YN: 'N', FID_ETC_CLS_CODE: '', tr_id: 'FHKST03010200' },
        ]);
        expect(candles).toHaveLength(31);
        expect(candles[0]).toEqual([kst('2026-09-25T10:29:00'), 99, 100, 98, 99, 10]);
        expect(candles.at(-1)![0]).toBe(kst('2026-09-25T10:59:00'));
    });

    it('limit 개를 모으면 더 묻지 않고 가장 최근 limit 개를 오래된 순으로 준다', async () => {
        const { service, calls } = fakeKis(NOW, { minute: [{ output2: minutesBack(30) }, { output2: minutesBack(30) }] });

        const candles = await service.fetchMinuteOHLCV('005930', 1, 20);

        expect(calls.minute).toHaveLength(1);
        expect(candles.map((c) => c[0])).toEqual(Array.from({ length: 20 }, (_, i) => kst(`2026-09-25T10:${String(40 + i)}:00`)));
    });

    it('커서가 제자리면 멈추고, 날짜나 시각이 빈 행은 건너뛴다', async () => {
        const page = [...minutesBack(29), minuteRow('103000', 1)];
        const { service, calls } = fakeKis(NOW, { minute: [{ output2: page }, { output2: page }, { output2: [minuteRow('', 5), minuteRow('100000', 5, '')] }] });

        const candles = await service.fetchMinuteOHLCV('005930', 1, 100);

        expect(calls.minute.map((p) => p.FID_INPUT_HOUR_1)).toEqual(['', '103000']);
        expect(candles).toHaveLength(30);

        const { service: blanks } = fakeKis(NOW, { minute: [{ output2: [minuteRow('', 5), minuteRow('100000', 5, ''), minuteRow('100100', 7)] }] });
        expect(await blanks.fetchMinuteOHLCV('005930', 1, 100)).toEqual([[kst('2026-09-25T10:01:00'), 7, 8, 6, 7, 10]]);
    });

    it('minuteInterval 이 2 이상이면 N분봉으로 합친다. 구간은 한국 시각의 N분 경계에서 시작한다', async () => {
        // 10:39 부터 10:30 까지. 종가는 10:30 이 0, 10:39 가 9 다.
        const rows = Array.from({ length: 10 }, (_, i) => minuteRow(`10${39 - i}00`, 9 - i));
        const { service } = fakeKis(NOW, { minute: [{ output2: rows }] });

        const candles = await service.fetchMinuteOHLCV('005930', 5, 10);

        expect(candles).toEqual([
            [kst('2026-09-25T10:30:00'), 0, 5, -1, 4, 50],
            [kst('2026-09-25T10:35:00'), 5, 10, 4, 9, 50],
        ]);
    });

    it('실패는 빈 배열로 바꾸지 않고 로그를 남긴 뒤 그대로 던진다', async () => {
        const boom = new Error('network');
        const { service } = fakeKis(NOW, { minute: [boom] });
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

        await expect(service.fetchMinuteOHLCV('005930', 1, 10)).rejects.toBe(boom);
        expect(error).toHaveBeenCalledWith({ err: boom, stockCode: '005930', minuteInterval: 1 }, '[KISCandleService] 분봉 캔들 조회 실패');
    });
});

/** 실행 환경의 시간대. 한국, 미국 동부와 함께 날짜선 양 끝(UTC+14, 서부)도 돈다. 값은 1월의 `getTimezoneOffset()`이다. */
const ZONES: ReadonlyArray<[string, number]> = [
    ['UTC', 0], ['Asia/Seoul', -540], ['America/New_York', 300], ['America/Los_Angeles', 480], ['Pacific/Kiritimati', -840],
];

describe.each(ZONES)('실행 환경 시간대 %s', (zone, januaryOffset) => {
    const original = process.env.TZ;

    beforeEach(() => {
        process.env.TZ = zone;
        // 시간대가 실제로 바뀌었는지 먼저 본다. 바뀌지 않으면 아래 테스트는 아무것도 검사하지 않는다.
        expect(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()).toBe(januaryOffset);
    });

    afterEach(() => {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
    });

    it('국내 일봉 기간은 한국 자정을 기준으로 날짜가 바뀐다', async () => {
        const before = fakeKis(Date.parse('2026-09-25T14:59:59.999Z')); // 한국 9/25 23:59:59.999
        const after = fakeKis(Date.parse('2026-09-25T15:00:00.000Z')); // 한국 9/26 00:00

        await before.service.fetchDailyOHLCV('005930', 'D', 2);
        await after.service.fetchDailyOHLCV('005930', 'D', 2);
        await before.service.fetchDailyOHLCVPaged('005930', 'D', 1);
        await after.service.fetchDailyOHLCVPaged('005930', 'D', 1);

        const dates = (calls: Params[]) => calls.map((p) => [p.FID_INPUT_DATE_1, p.FID_INPUT_DATE_2]);
        expect(dates(before.calls.daily)).toEqual([['20260922', '20260925'], ['20260509', '20260925']]);
        expect(dates(after.calls.daily)).toEqual([['20260923', '20260926'], ['20260510', '20260926']]);
    });

    it('국내 일봉과 분봉의 시각은 한국 시각으로 읽는다', async () => {
        const { service } = fakeKis(NOW, {
            daily: [{ output2: [dailyRow('20260101', 1), dailyRow('20261231', 2)] }],
            minute: [{ output2: [minuteRow('000000', 1, '20260101'), minuteRow('235900', 2, '20261231')] }],
        });

        const daily = await service.fetchDailyOHLCVRange('005930', 'D', '20260101', '20261231');
        const minute = await service.fetchMinuteOHLCV('005930', 1, 10);

        expect(daily.map((c) => c[0])).toEqual([Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-12-31T00:00:00Z')]);
        expect(minute.map((c) => c[0])).toEqual([Date.parse('2025-12-31T15:00:00Z'), Date.parse('2026-12-31T14:59:00Z')]);
    });

    it('N분봉 구간은 한국 시각의 정각과 N분 경계에서 시작한다', async () => {
        const { service } = fakeKis(NOW, { minute: [{ output2: [minuteRow('091500', 3), minuteRow('090100', 2), minuteRow('085900', 1)] }] });

        const candles = await service.fetchMinuteOHLCV('005930', 60, 10);

        expect(candles.map((c) => [c[0], c[5]])).toEqual([[kst('2026-09-25T08:00:00'), 10], [kst('2026-09-25T09:00:00'), 20]]);
    });

    it.each([
        // 서머타임(EDT, UTC-4): 동부 자정은 04:00Z 다.
        ['2026-09-25T03:59:59Z', '20260924'], ['2026-09-25T04:00:00Z', '20260925'],
        // 표준시(EST, UTC-5): 동부 자정은 05:00Z 다.
        ['2026-01-15T04:59:59Z', '20260114'], ['2026-01-15T05:00:00Z', '20260115'],
        // 서머타임 시작일(3/8)의 자정은 아직 표준시, 끝나는 날(11/1)의 자정은 아직 서머타임이다.
        ['2026-03-08T04:59:59Z', '20260307'], ['2026-03-08T05:00:00Z', '20260308'],
        ['2026-11-01T03:59:59Z', '20261031'], ['2026-11-01T04:00:00Z', '20261101'],
    ])('해외 일봉의 기준일(BYMD)은 미국 동부 날짜다 — %s → %s', async (now, bymd) => {
        const { service, calls } = fakeKis(Date.parse(now));

        await service.fetchOverseasDailyOHLCV('AAPL', 'NAS', '1d', 10);

        expect(calls.overseas.map((p) => p.BYMD)).toEqual([bymd]);
    });

    it('해외 일봉의 다음 기준일은 앞 쪽 마지막 날의 하루 전 달력 날짜이고, 봉 시각은 그날 00:00 UTC 다', async () => {
        const day = (i: number) => new Date(Date.UTC(2026, 5, 7) - i * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
        const row = (xymd: string) => ({ xymd, open: '1', high: '2', low: '0.5', clos: '1.5', tvol: '10' });
        const { service, calls } = fakeKis(Date.parse('2026-06-08T12:00:00Z'), {
            overseas: [{ output2: Array.from({ length: 100 }, (_, i) => row(day(i))) }, { output2: [row('20260227')] }],
        });

        const candles = await service.fetchOverseasDailyOHLCV('AAPL', 'NAS', '1d', 150);

        // 100번째 날은 2026-02-28 이다. 그 하루 전은 2/27 이다.
        expect(calls.overseas.map((p) => p.BYMD)).toEqual(['20260608', '20260227']);
        expect(candles[0]![0]).toBe(Date.UTC(2026, 1, 27));
        expect(candles.at(-1)![0]).toBe(Date.UTC(2026, 5, 7));
    });
});
