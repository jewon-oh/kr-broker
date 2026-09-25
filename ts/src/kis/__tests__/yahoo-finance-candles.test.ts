/**
 * @fileoverview yahoo-finance-candles 단위 테스트
 * @description 미지원 timeframe 의 silent 1d 폴백 제거 회귀 방지.
 * 버스트 스로틀(빈 응답) 재시도 회복.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NotSupported } from '../../base/errors';
import { fetchYahooCandles } from '../yahoo-finance-candles';

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

/** Yahoo chart API 정상 응답 mock (candles: [tsMs, o, h, l, c, v][]). */
function yahooOk(candles: OHLCV[]): Response {
    return {
        ok: true,
        json: async () => ({
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
        }),
    } as unknown as Response;
}

/** result:null — 버스트 스로틀 신호(재시도 대상). */
const yahooEmpty = (): Response =>
    ({ ok: true, json: async () => ({ chart: { result: null, error: null } }) } as unknown as Response);

/** chart.error — 존재하지 않는 심볼(재시도 무의미). */
const yahooChartError = (): Response =>
    ({ ok: true, json: async () => ({ chart: { result: null, error: { code: 'Not Found', description: 'No data' } } }) } as unknown as Response);

/** 429 Too Many Requests — 일시적(재시도 대상). */
const yahoo429 = (): Response =>
    ({ ok: false, status: 429, json: async () => ({}) } as unknown as Response);

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

    it('chart.error(심볼 부재) → 재시도 없이 즉시 [] (한 번만 호출)', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(yahooChartError());
        const out = await fetchYahooCandles('BADSYM', '1d', 10);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(out).toEqual([]);
    });

    it('연속 빈 응답 → 최대 3회 시도 후 []', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(yahooEmpty());
        const out = await fetchYahooCandles('005930', '1d', 10);
        expect(spy).toHaveBeenCalledTimes(3);
        expect(out).toEqual([]);
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
