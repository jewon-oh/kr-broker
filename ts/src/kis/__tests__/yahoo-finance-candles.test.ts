/**
 * @fileoverview yahoo-finance-candles 단위 테스트
 * @description 미지원 timeframe 의 silent 1d 폴백 제거 회귀 방지.
 * 버스트 스로틀(빈 응답) 재시도 회복.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { BadRequest, BadSymbol, ExchangeNotAvailable, NetworkError, NotSupported } from '../../base/errors';
import { fetchYahooCandles } from '../yahoo-finance-candles';
import { logger } from '../../logger';

describe('fetchYahooCandles — 미지원 timeframe', () => {
    it("'3m' 같은 미지원 timeframe 은 throw — silent 1d 폴백 차단", async () => {
        await expect(fetchYahooCandles('005930', '3m')).rejects.toThrow(/미지원 타임프레임/);
    });

    it("'8h' (Yahoo 미지원) 도 throw", async () => {
        await expect(fetchYahooCandles('005930', '8h')).rejects.toThrow(/미지원 타임프레임/);
    });

    it('★ccxt 오류 클래스 NotSupported 를 던지고 메시지에 타임프레임을 담는다(토스증권과 같다)', async () => {
        const error = await fetchYahooCandles('005930', '2d').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotSupported);
        expect((error as Error).name).toBe('NotSupported');
        expect((error as Error).message).toContain("'2d'");
    });
});

// ============ 재시도 (버스트 스로틀 회복) ============

type OHLCV = [number, number, number, number, number, number];

/** `fetch` 가 돌려주는 응답 모양. 본문은 `text()` 로 읽힌다. */
function fakeResponse(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, statusText: '', headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
}

/** Yahoo chart API 정상 응답 mock (candles: [tsMs, o, h, l, c, v][]). */
function yahooOk(candles: OHLCV[]): Response {
    return fakeResponse(200, {
            chart: {
                result: [{
                    timestamp: candles.map(c => Math.floor(c[0] / 1000)), // ms → s (코드가 다시 *1000)
                    indicators: {
                        quote: [{
                            open: candles.map(c => c[1]),
                            high: candles.map(c => c[2]),
                            low: candles.map(c => c[3]),
                            close: candles.map(c => c[4]),
                            volume: candles.map(c => c[5]),
                        }],
                    },
                }],
                error: null,
            },
        });
}

/** result:null — 버스트 스로틀 신호(재시도 대상). */
const yahooEmpty = (): Response =>
    fakeResponse(200, { chart: { result: null, error: null } });

/** chart.error — 존재하지 않는 심볼(재시도 무의미). */
const yahooChartError = (): Response =>
    fakeResponse(200, { chart: { result: null, error: { code: 'Not Found', description: 'No data' } } });

/** 429 Too Many Requests — 일시적(재시도 대상). */
const yahoo429 = (): Response =>
    fakeResponse(429, {});

describe('fetchYahooCandles — 재시도 (버스트 스로틀 회복)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('빈 응답(result:null) 후 성공 → 재시도로 캔들 반환', async () => {
        const c: OHLCV[] = [[1_700_000_000_000, 1, 2, 0.5, 1.5, 100]];
        const spy = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(yahooEmpty())
            .mockResolvedValueOnce(yahooOk(c));
        const out = await fetchYahooCandles('005930', '1d', 10);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(out).toHaveLength(1);
        expect(out[0][4]).toBe(1.5); // close
    });

    it('chart.error(심볼 부재) → 재시도 없이 BadSymbol (한 번만 호출)', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(yahooChartError());
        await expect(fetchYahooCandles('BADSYM', '1d', 10)).rejects.toBeInstanceOf(BadSymbol);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('★연속 빈 응답 → 최대 3회 시도 후 던진다 — 조회 실패를 "봉 없음"과 같은 빈 배열로 돌려주지 않는다', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(yahooEmpty());
        await expect(fetchYahooCandles('005930', '1d', 10)).rejects.toBeInstanceOf(ExchangeNotAvailable);
        expect(spy).toHaveBeenCalledTimes(3);
    });

    it('결과는 왔는데 시각이 없으면 그 구간에 봉이 없는 것이라 재시도 없이 빈 배열이다', async () => {
        const noBars = fakeResponse(200, { chart: { result: [{ meta: { symbol: 'AAPL' }, indicators: { quote: [{}] } }], error: null } });
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(noBars);
        expect(await fetchYahooCandles('AAPL', '5m', 10)).toEqual([]);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('404 는 BadSymbol, 재시도를 다 쓴 5xx 는 ExchangeNotAvailable, 연결 실패는 NetworkError 다', async () => {
        const status = (code: number): Response => fakeResponse(code, {});
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(status(404));
        await expect(fetchYahooCandles('005930', '1d', 10)).rejects.toBeInstanceOf(BadSymbol);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(status(503));
        await expect(fetchYahooCandles('005930', '1d', 10)).rejects.toBeInstanceOf(ExchangeNotAvailable);
        // ★조회 폭 초과(422) 같은 그 밖의 4xx 는 일시 장애가 아니라 요청 문제라 BadRequest 이고, 다시 보내지 않는다.
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(status(422));
        spy.mockClear();
        await expect(fetchYahooCandles('005930', '1d', 10)).rejects.toBeInstanceOf(BadRequest);
        expect(spy).toHaveBeenCalledTimes(1);
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        await expect(fetchYahooCandles('005930', '1d', 10)).rejects.toBeInstanceOf(NetworkError);
    });

    it('429(일시적) 후 성공 → 재시도로 캔들 반환', async () => {
        const c: OHLCV[] = [[1_700_000_000_000, 1, 2, 0.5, 1.5, 100]];
        const spy = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(yahoo429())
            .mockResolvedValueOnce(yahooOk(c));
        const out = await fetchYahooCandles('NVDA', '1d', 10);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(out).toHaveLength(1);
    });
});

describe('fetchYahooCandles — range 파라미터 (undici period 400 회피)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('since 지정 시 period1/period2 대신 range 로 조회 (undici 400 회피)', async () => {
        const c: OHLCV[] = [[1_700_000_000_000, 1, 2, 0.5, 1.5, 100]];
        let capturedUrl = '';
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            capturedUrl = String(url);
            return yahooOk(c);
        });
        const since = Date.now() - 200 * 24 * 3600 * 1000; // ~200일
        await fetchYahooCandles('005930', '4h', 200, since, Date.now());
        expect(capturedUrl).toContain('range=1y'); // 200일 → 1y 버킷
        expect(capturedUrl).not.toContain('period1');
        expect(capturedUrl).not.toContain('period2');
        expect(capturedUrl).toContain('interval=1h'); // 4h → 1h (리샘플)
    });

    it('since 미지정 시 기본 range 사용', async () => {
        const c: OHLCV[] = [[1_700_000_000_000, 1, 2, 0.5, 1.5, 100]];
        let capturedUrl = '';
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            capturedUrl = String(url);
            return yahooOk(c);
        });
        await fetchYahooCandles('005930', '1d', 10);
        expect(capturedUrl).toContain('range=');
        expect(capturedUrl).not.toContain('period1');
    });
});

describe('fetchYahooCandles — since·until', () => {
    const NOW = Date.parse('2026-03-25T12:00:00Z');
    const bar = (iso: string): OHLCV => [Date.parse(iso), 1, 2, 0.5, 1.5, 100];
    // 미국 일봉은 개장 시각(14:30 UTC)에 온다. 먼 과거 구간 뒤에 최근 봉이 이어진다.
    const daily = [
        bar('2023-12-29T14:30:00Z'), bar('2024-01-02T14:30:00Z'), bar('2024-01-03T14:30:00Z'), bar('2024-01-04T14:30:00Z'),
        bar('2024-01-05T14:30:00Z'), bar('2024-01-08T14:30:00Z'), bar('2026-03-24T13:30:00Z'),
    ];
    let urls: string[] = [];

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        urls = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            urls.push(String(url));
            return yahooOk(daily);
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('★since 가 있으면 since 부터 until 까지의 봉을 앞에서부터 limit 개 준다', async () => {
        const out = await fetchYahooCandles('AAPL', '1d', 3, Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 6));

        expect(out.map((c) => new Date(c[0]).toISOString().slice(0, 10))).toEqual(['2024-01-02', '2024-01-03', '2024-01-04']);
        // range 는 지금에서 거슬러 세므로 until 이 아니라 since 부터 지금까지를 덮는다(814일 → 5y).
        expect(urls[0]).toContain('range=5y');
    });

    it('since 없이 until 만 주면 until 이전의 최근 limit 개다', async () => {
        const out = await fetchYahooCandles('AAPL', '1d', 2, undefined, Date.UTC(2024, 0, 6));

        // 야후는 미국 일봉을 개장 시각(09:30 ET)에 두지만, 일봉은 거래일의 00:00 UTC 로 옮긴다.
        expect(out.map((c) => c[0])).toEqual([Date.parse('2024-01-04T00:00:00Z'), Date.parse('2024-01-05T00:00:00Z')]);
    });

    it('★분봉의 조회 폭이 range 값보다 좁으면 일수로 적는다 — 3mo·1mo 는 야후가 422 로 거절한다', async () => {
        await fetchYahooCandles('AAPL', '5m', 10, NOW - 40 * 86_400_000);
        await fetchYahooCandles('AAPL', '1m', 10, NOW - 5.5 * 86_400_000);
        await fetchYahooCandles('AAPL', '5m', 10, NOW - 20 * 86_400_000);

        expect(urls.map((u) => new URL(u).searchParams.get('range'))).toEqual(['40d', '6d', '1mo']);
    });

    it('★since 가 조회 폭 상한보다 오래되면 상한까지 줄여 받고 경고를 남긴다', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

        await fetchYahooCandles('AAPL', '5m', 10, Date.UTC(2024, 0, 1));

        expect(new URL(urls[0]).searchParams.get('range')).toBe('59d');
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({ timeframe: '5m', since: Date.UTC(2024, 0, 1) }), expect.stringContaining('상한'));
    });
});

describe('fetchYahooCandles — 동시성 상한 (버스트 스로틀 회피)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('20개 동시 호출 → 실제 동시 요청은 YAHOO_MAX_CONCURRENT(6) 이하로 직렬화', async () => {
        const c: OHLCV[] = [[1_700_000_000_000, 1, 2, 0.5, 1.5, 100]];
        let concurrent = 0;
        let maxConcurrent = 0;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise(r => setTimeout(r, 30));
            concurrent--;
            return yahooOk(c);
        });
        await Promise.all(Array.from({ length: 20 }, () => fetchYahooCandles('005930', '1d', 10)));
        expect(maxConcurrent).toBeLessThanOrEqual(6);
        expect(maxConcurrent).toBeGreaterThan(1); // 병렬성은 유지(완전 직렬 아님)
    });
});

describe('fetchYahooCandles — 일·주·월봉 시각', () => {
    afterEach(() => vi.restoreAllMocks());

    it('국내 일봉(09:00 KST)은 그대로 거래일의 00:00 UTC 이고, 미국 일봉(09:30 ET)은 거래일의 00:00 UTC 로 옮긴다', async () => {
        const bar = (ms: number): OHLCV => [ms, 1, 1, 1, 1, 1];
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(yahooOk([bar(Date.parse('2026-09-22T00:00:00Z')), bar(Date.parse('2026-09-23T00:00:00Z'))]))
            .mockResolvedValueOnce(yahooOk([bar(Date.parse('2026-09-22T13:30:00Z')), bar(Date.parse('2026-09-23T13:30:00Z'))]));

        const kr = await fetchYahooCandles('005930', '1d', 10);
        const us = await fetchYahooCandles('AAPL', '1d', 10);

        expect(kr.map((c) => c[0])).toEqual([Date.parse('2026-09-22T00:00:00Z'), Date.parse('2026-09-23T00:00:00Z')]);
        expect(us.map((c) => c[0])).toEqual([Date.parse('2026-09-22T00:00:00Z'), Date.parse('2026-09-23T00:00:00Z')]);
    });

    it('주봉은 월요일의 00:00 UTC 이고, 끝에 붙는 하루치 시세 봉은 같은 주의 기간 봉을 남기고 버린다', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(yahooOk([
            [Date.parse('2026-09-13T15:00:00Z'), 250, 270, 245, 264, 1000],   // 09-14(월) 00:00 KST
            [Date.parse('2026-09-20T15:00:00Z'), 264, 285, 263, 285, 900],    // 09-21(월) 00:00 KST
            [Date.parse('2026-09-23T06:30:00Z'), 284, 285, 281, 285, 200],    // 09-23 15:30 KST, 오늘 하루치
        ]));

        const out = await fetchYahooCandles('005930', '1w', 10);

        expect(out).toEqual([
            [Date.parse('2026-09-14T00:00:00Z'), 250, 270, 245, 264, 1000],
            [Date.parse('2026-09-21T00:00:00Z'), 264, 285, 263, 285, 900],
        ]);
    });
});

describe('fetchYahooCandles — 전송', () => {
    afterEach(() => vi.restoreAllMocks());

    it('넘겨받은 전송(증권사 인스턴스의 httpRequest)으로 보내고 전역 fetch 는 부르지 않는다', async () => {
        const global = vi.spyOn(globalThis, 'fetch');
        const body = await yahooOk([[Date.parse('2026-09-23T00:00:00Z'), 1, 1, 1, 1, 1]]).text();
        const httpRequest = vi.fn(async () => ({ status: 200, statusText: '', headers: {}, text: async () => body }));

        const out = await fetchYahooCandles('005930', '1d', 10, undefined, undefined, undefined, { httpRequest });

        expect(out).toHaveLength(1);
        expect(global).not.toHaveBeenCalled();
        expect(httpRequest).toHaveBeenCalledWith(expect.stringContaining('/005930.KS?'), 'GET', expect.objectContaining({ 'User-Agent': expect.any(String) }), undefined, 10_000);
    });
});
