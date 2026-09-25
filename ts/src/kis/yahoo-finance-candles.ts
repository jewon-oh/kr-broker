/**
 * @fileoverview Yahoo Finance 캔들 데이터 페처
 * @description KIS 분봉 API 한계(당일만) 보완 — 한국 주식 역사적 OHLCV 공급
 *
 * Yahoo Finance chart API v8 사용:
 * - 1h: 최대 730일 과거 데이터
 * - 1d/1wk/1mo: 무제한에 가까운 과거 데이터
 * - API 키 불필요, 무료
 *
 * 종목코드 변환: KIS '005930' → Yahoo '005930.KS'
 */

import { BadRequest, BadSymbol, BaseError, ExchangeNotAvailable, NetworkError, NotSupported, RateLimitExceeded } from '../base/errors';
import { logger } from '../logger';
import { resampleCandles } from './candle-resample';
import { timeframeToMs } from '../broker-time';
import { isKrxDomesticCode } from './kis-types';
import { sliceCandleWindow } from './kis-candle-pagination';

// ============ 상수 ============

/** Yahoo Finance chart API 기본 URL */
const YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

/** 한국 주식 Yahoo 티커 접미사 (KOSPI=.KS, KOSDAQ=.KQ) */
const YAHOO_KR_SUFFIX = {
    KOSPI: '.KS',
    KOSDAQ: '.KQ',
} as const;

/**
 * CCXT 타임프레임 → Yahoo Finance interval 매핑
 * Yahoo는 60m과 1h를 모두 지원하지만, 1h가 더 안정적
 */
const YAHOO_INTERVAL_MAP: Record<string, string> = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1h',
    '4h': '1h',     // Yahoo는 4h 미지원 → 1h로 가져와서 리샘플링
    '1d': '1d',
    '1w': '1wk',
    '1W': '1wk',
    '1M': '1mo',
};

/**
 * 타임프레임별 Yahoo range 값 (period1/period2 미사용 시 기본 범위)
 */
const YAHOO_DEFAULT_RANGE: Record<string, string> = {
    '1m': '1d',     // 분봉은 최대 7일
    '5m': '60d',    // 5분봉 최대 60일
    '15m': '60d',   // 15분봉 최대 60일
    '30m': '60d',   // 30분봉 최대 60일
    '1h': '1y',     // 시간봉은 최대 ~730일
    '4h': '1y',
    '1d': '5y',
    '1w': '10y',
    '1W': '10y',
    '1M': 'max',
};

/**
 * Yahoo Finance 타임프레임별 최대 조회 기간 (ms)
 * 이 범위를 초과하면 Yahoo가 빈 응답을 반환함.
 *
 * 분봉 (1m/5m/15m/30m) 은 Yahoo 가 *strict* 60-day 경계를 적용 — 경계와 같거나 더 과거를 요청하면
 * 422 "must be within the last 60 days" 로 거부 → 빈 응답. 그래서 경계에서 1일을 뺀다.
 *
 * 1h 도 보수적으로 729 일 (730 경계 회피).
 */
const YAHOO_MAX_RANGE_MS: Record<string, number> = {
    '1m': 6 * 24 * 60 * 60 * 1000,          // 6일 (7일 경계 - 1일 버퍼)
    '5m': 59 * 24 * 60 * 60 * 1000,         // 59일 (60일 경계 - 1일 버퍼)
    '15m': 59 * 24 * 60 * 60 * 1000,        // 59일 (60일 경계 - 1일 버퍼)
    '30m': 59 * 24 * 60 * 60 * 1000,        // 59일 (60일 경계 - 1일 버퍼)
    '1h': 729 * 24 * 60 * 60 * 1000,        // 729일 (730일 경계 - 1일 버퍼)
    '4h': 729 * 24 * 60 * 60 * 1000,        // 729일 (1h 기반)
};

/** Yahoo Finance 요청 타임아웃 (ms) */
const YAHOO_REQUEST_TIMEOUT_MS = 10_000;

/** 공통 User-Agent (봇 차단 회피). */
const YAHOO_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * 빈 응답(result:null)·일시적 실패(429/5xx/타임아웃) 재시도.
 * Yahoo 는 요청이 몰리면 개별 요청이 정상이어도 result:null(빈 응답)을 자주 반환하므로, 지터 백오프 재시도로 스로틀에서 회복한다.
 * 심볼 부재(chart.error)는 재시도하지 않고 바로 던진다.
 */
const YAHOO_MAX_ATTEMPTS = 3;
const YAHOO_RETRY_BASE_MS = 500;

const yahooSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 프로세스 전역 Yahoo 동시 요청 상한. 동시에 많이 부르면 Yahoo 가 `result:null`(빈 응답)을 대량 반환하므로
 * 세마포어로 동시성을 낮춘다. 재시도(위)도 이 상한 안에서 큐잉된다.
 */
const YAHOO_MAX_CONCURRENT = 6;
let yahooActive = 0;
const yahooWaiters: Array<() => void> = [];

async function acquireYahooSlot(): Promise<void> {
    if (yahooActive < YAHOO_MAX_CONCURRENT) {
        yahooActive++;
        return;
    }
    await new Promise<void>(resolve => yahooWaiters.push(resolve));
    yahooActive++;
}

function releaseYahooSlot(): void {
    yahooActive = Math.max(0, yahooActive - 1);
    const next = yahooWaiters.shift();
    if (next) next();
}

// ============ 타입 ============

/** Yahoo Finance chart API 응답 구조 */
interface YahooChartResponse {
    chart: {
        result: Array<{
            meta: {
                symbol: string;
                currency: string;
                exchangeTimezoneName: string;
                regularMarketPrice: number;
            };
            timestamp: number[];
            indicators: {
                quote: Array<{
                    open: (number | null)[];
                    high: (number | null)[];
                    low: (number | null)[];
                    close: (number | null)[];
                    volume: (number | null)[];
                }>;
            };
        }>;
        error: { code: string; description: string } | null;
    };
}

// ============ 공개 API ============

/**
 * 진행 중인 마지막 봉의 타임스탬프를 **시리즈 자신의 그리드**에 맞춘다.
 *
 * Yahoo 차트 API 는 완성된 봉엔 버킷 시작 시각을 주지만, **진행 중인 마지막 봉엔
 * (지연된) 현재 시각**을 준다. 그대로 두면 부를 때마다 마지막 봉의 타임스탬프가 달라진다.
 *
 * UTC 정시로 내리면 안 된다. 미국장 시간봉은 개장(13:30 UTC)에 앵커돼
 * 13:30·14:30·15:30… 으로 오는 **정상** 봉이라, 정시 정렬은 전 구간 시각을 바꿔버린다.
 * 그래서 절대 격자가 아니라 **직전 완성봉에서 tf 배수만큼** 떨어진 지점으로 스냅해 세션 위상을 보존한다.
 *
 * 일봉·주봉·월봉(`d`, `w`, `W`, `M`)은 대상이 아니다 — 진행 중 봉 문제가 없다.
 */
export function alignTailToSeriesGrid(candles: number[][], timeframe: string): void {
    if (/[dwWM]$/.test(timeframe)) return;
    if (candles.length < 2) return;

    const tfMs = timeframeToMs(timeframe);
    if (!Number.isFinite(tfMs) || tfMs <= 0) return;

    const last = candles[candles.length - 1]!;
    const prev = candles[candles.length - 2]!;
    const delta = last[0]! - prev[0]!;
    // delta 가 tf 의 정수배면 이미 그리드 위 — 완성봉이거나 정상 응답이다.
    if (delta <= 0 || delta % tfMs === 0) return;

    last[0] = prev[0]! + Math.floor(delta / tfMs) * tfMs;
}

/** 같은 타임스탬프가 여러 개면 뒤엣것(더 최신 체결)만 남긴다. 제자리 수정, 시간순 유지. */
export function dedupeByTimestampKeepLast(candles: number[][]): void {
    const lastIndexByTs = new Map<number, number>();
    candles.forEach((c, i) => lastIndexByTs.set(c[0]!, i));
    const kept = candles.filter((c, i) => lastIndexByTs.get(c[0]!) === i);
    candles.length = 0;
    candles.push(...kept);
}

/**
 * Yahoo Finance에서 한국 주식 OHLCV 캔들 데이터 조회
 *
 * @param stockCode KIS 종목코드 (예: '005930')
 * @param timeframe CCXT 호환 타임프레임 (1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1M)
 * @param limit 최대 캔들 수
 * @param since 시작 시간 (ms timestamp, 선택)
 * @param until 종료 시간 (ms timestamp, 선택)
 * @param krMarket KOSPI/KOSDAQ 구분 — 미전달 시 .KS 기본값 (KOSDAQ 종목은 .KQ 필요)
 * @returns CCXT 호환 OHLCV: [[timestamp, open, high, low, close, volume], ...]. `since <= 시각 <= until` 인 봉을
 *   ccxt 규칙대로 `limit` 개 준다(`since` 가 있으면 가장 이른 것부터, 없으면 가장 최근 것부터).
 *   분봉은 `since` 가 조회 폭 상한(`YAHOO_MAX_RANGE_MS`)보다 오래되면 상한 안의 봉만 받고 경고를 남긴다.
 * @throws NotSupported 야후가 주지 않는 타임프레임
 */
export async function fetchYahooCandles(
    stockCode: string,
    timeframe: string = '1d',
    limit: number = 500,
    since?: number,
    until?: number,
    krMarket?: 'KOSPI' | 'KOSDAQ',
): Promise<number[][]> {
    // Yahoo 티커 변환 (숫자 코드 → .KS/.KQ 접미사)
    const yahooSymbol = toYahooTicker(stockCode, krMarket);

    // Yahoo interval 매핑 — 모르는 timeframe 은 다른 봉으로 바꾸지 않고 던진다.
    const interval = YAHOO_INTERVAL_MAP[timeframe];
    if (!interval) {
        logger.error({ timeframe, stockCode }, '[YahooFinance] ❌ 미지원 timeframe — silent 폴백 차단');
        throw new NotSupported(
            `[YahooFinance] 미지원 타임프레임 '${timeframe}'. `
            + `지원: ${Object.keys(YAHOO_INTERVAL_MAP).join(', ')}.`,
        );
    }

    // URL 구성 (재시도 간 불변 — 루프 밖에서 1회 계산)
    const params = new URLSearchParams({ interval });

    // 요청 윈도 → Yahoo `range` 버킷 매핑.
    // undici(Node fetch)는 period1/period2 intraday 요청에 HTTP 400 을 받으므로 항상 range 로 조회한다.
    // range 는 지금에서 거슬러 센 기간이라 since 부터 지금까지를 덮게 고르고, 받은 봉을 since·until 로 거른다.
    const maxRangeMs = YAHOO_MAX_RANGE_MS[timeframe];
    if (since !== undefined) {
        const now = Date.now();
        let windowMs = now - since;
        if (maxRangeMs !== undefined && windowMs > maxRangeMs) {
            logger.warn({ yahooSymbol, timeframe, since, earliest: now - maxRangeMs },
                '[YahooFinance] since 가 조회 폭 상한보다 오래돼 상한 안의 봉만 받는다');
            windowMs = maxRangeMs;
        }
        params.set('range', toYahooRange(windowMs, maxRangeMs));
    } else {
        params.set('range', YAHOO_DEFAULT_RANGE[timeframe] ?? '1y');
    }

    const url = `${YAHOO_CHART_BASE_URL}/${yahooSymbol}?${params.toString()}`;
    logger.debug({ url, yahooSymbol, timeframe, interval }, '[YahooFinance] 캔들 요청');

    // 동시성 상한 획득 (버스트 스로틀 회피) — 성공/실패 무관 반드시 release.
    await acquireYahooSlot();
    try {
        // 일시적 실패(빈 응답/429/5xx/타임아웃)는 지터 백오프로 재시도 — 버스트 스로틀 회복.
        for (let attempt = 1; attempt <= YAHOO_MAX_ATTEMPTS; attempt++) {
            const canRetry = attempt < YAHOO_MAX_ATTEMPTS;
            const backoff = (): Promise<void> =>
                yahooSleep(YAHOO_RETRY_BASE_MS * attempt + Math.floor(Math.random() * 250));
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': YAHOO_USER_AGENT },
                    signal: AbortSignal.timeout(YAHOO_REQUEST_TIMEOUT_MS),
                });

                if (!response.ok) {
                    // 429/5xx = 일시적 스로틀 → 재시도. 그 외 4xx = 즉시 포기. 실패는 빈 배열이 아니라 오류다.
                    const retryable = response.status === 429 || response.status >= 500;
                    logger.warn({ status: response.status, yahooSymbol, attempt, retryable },
                        '[YahooFinance] API 응답 에러');
                    if (retryable && canRetry) { await backoff(); continue; }
                    const message = `야후 캔들 조회 실패(${yahooSymbol} ${timeframe}): HTTP ${response.status}`;
                    if (response.status === 404) throw new BadSymbol(message);
                    if (response.status === 429) throw new RateLimitExceeded(message);
                    // 그 밖의 4xx(조회 폭 초과 422 등)는 요청 문제라 다시 보내도 같다.
                    if (response.status < 500) throw new BadRequest(message);
                    throw new ExchangeNotAvailable(message);
                }

                const data = await response.json() as YahooChartResponse;

                if (data.chart.error) {
                    // 존재하지 않는 심볼 등 — 재시도 무의미.
                    logger.warn({ error: data.chart.error, yahooSymbol }, '[YahooFinance] 차트 에러');
                    throw new BadSymbol(`야후 캔들 조회 실패(${yahooSymbol} ${timeframe}): ${JSON.stringify(data.chart.error)}`);
                }

                const result = data.chart.result?.[0];
                if (!result) {
                    // result:null = 버스트 스로틀 신호(개별 요청은 정상) → 백오프 재시도.
                    if (canRetry) {
                        logger.debug({ yahooSymbol, attempt }, '[YahooFinance] 빈 응답 — 재시도');
                        await backoff();
                        continue;
                    }
                    logger.warn({ yahooSymbol, attempts: YAHOO_MAX_ATTEMPTS }, '[YahooFinance] 빈 응답 (재시도 소진)');
                    throw new ExchangeNotAvailable(`야후 캔들 조회 실패(${yahooSymbol} ${timeframe}): ${YAHOO_MAX_ATTEMPTS}번 모두 빈 응답`);
                }
                // 결과는 왔는데 시각이 없으면 그 구간에 봉이 없는 것이다.
                if (!result.timestamp || !result.indicators?.quote?.[0]) return [];

                const { timestamp: timestamps } = result;
                const quote = result.indicators.quote[0];

                // OHLCV 배열 변환 (null 제거)
                const candles: number[][] = [];
                for (let i = 0; i < timestamps.length; i++) {
                    const open = quote.open[i];
                    const high = quote.high[i];
                    const low = quote.low[i];
                    const close = quote.close[i];
                    const volume = quote.volume[i];

                    // null 값 (거래 없음) 건너뛰기
                    if (open == null || high == null || low == null || close == null) continue;

                    candles.push([
                        timestamps[i] * 1000, // 초 → ms 변환
                        open,
                        high,
                        low,
                        close,
                        volume ?? 0,
                    ]);
                }

                // 진행 중 마지막 봉만 그리드에 스냅해 부를 때마다 시각이 바뀌지 않게 한다. 4h 는 받은 1h 봉의 격자로 맞춘 뒤 합친다.
                const needsResample = timeframe === '4h';
                alignTailToSeriesGrid(candles, needsResample ? '1h' : timeframe);
                dedupeByTimestampKeepLast(candles);

                // 종목마다 한 줄이라 debug 로 남긴다.
                logger.debug({
                    yahooSymbol, timeframe, interval,
                    rawCount: timestamps.length,
                    validCount: candles.length,
                    attempt,
                }, '[YahooFinance] 캔들 조회 완료');

                // 4h = 1h 데이터를 4시간 단위로 리샘플링
                const finalCandles = needsResample
                    ? resampleCandles(candles, 4 * 60)
                    : candles;

                return sliceCandleWindow(finalCandles, since, until, limit);
            } catch (err) {
                if (err instanceof BaseError) throw err;
                // 네트워크/타임아웃 = 일시적 → 재시도.
                if (canRetry) {
                    logger.debug({ err, yahooSymbol, attempt }, '[YahooFinance] 요청 실패 — 재시도');
                    await backoff();
                    continue;
                }
                logger.warn({ err, stockCode, yahooSymbol: toYahooTicker(stockCode), timeframe },
                    '[YahooFinance] 캔들 조회 실패 (재시도 소진)');
                throw new NetworkError(`야후 캔들 조회 실패(${yahooSymbol} ${timeframe}): ${err instanceof Error ? err.message : String(err)}`, { cause: err });
            }
        }
        throw new ExchangeNotAvailable(`야후 캔들 조회 실패(${yahooSymbol} ${timeframe})`);
    } finally {
        releaseYahooSlot();
    }
}

// ============ 내부 유틸 ============

const DAY_MS = 24 * 60 * 60 * 1000;

/** 표준 Yahoo range 값과 그 달력일 수. */
const YAHOO_RANGE_BUCKETS: ReadonlyArray<[number, string]> = [
    [1, '1d'], [5, '5d'], [30, '1mo'], [90, '3mo'], [180, '6mo'], [366, '1y'], [731, '2y'], [1826, '5y'], [3651, '10y'],
];

/**
 * 요청 윈도(ms) → Yahoo `range` 버킷.
 * undici 가 period1/period2 를 400 처리하므로 range 로만 조회한다. 표준 Yahoo range 값 중
 * 요청 윈도를 덮는 최소 버킷을 고른다(넘친 봉은 받은 뒤 since·until 로 거른다).
 * 그 버킷이 조회 폭 상한(`maxRangeMs`)을 넘으면 야후가 422 로 거절하므로 일수(`59d`)로 적는다.
 */
function toYahooRange(windowMs: number, maxRangeMs?: number): string {
    const bucket = YAHOO_RANGE_BUCKETS.find(([days]) => windowMs <= days * DAY_MS);
    if (maxRangeMs !== undefined && (bucket === undefined || bucket[0] * DAY_MS > maxRangeMs)) {
        return `${Math.ceil(Math.min(windowMs, maxRangeMs) / DAY_MS)}d`;
    }
    return bucket?.[1] ?? 'max';
}

/**
 * 종목코드 → Yahoo Finance 티커 변환
 * - 한국 주식: 005930 → 005930.KS (KOSPI), KOSDAQ 종목은 058470 → 058470.KQ
 * - 미국 주식: AAPL → AAPL (접미사 없음). 클래스 주식의 점은 야후 표기인 하이픈으로 바꾼다(BRK.B → BRK-B)
 * - `stock:` 접두사와 `/KRW` 같은 접미사는 뗀다
 */
function toYahooTicker(stockCode: string, krMarket?: 'KOSPI' | 'KOSDAQ'): string {
    // 'stock:' 접두사 제거
    let code = stockCode.startsWith('stock:') ? stockCode.slice(6) : stockCode;
    // '/' 포함 시 종목코드만 추출
    code = code.includes('/') ? code.split('/')[0] : code;
    // 이미 .KS/.KQ 접미사 포함 시 그대로 반환
    if (code.endsWith('.KS') || code.endsWith('.KQ')) return code;
    // 국내 KR 코드(6자리 숫자·신형 영숫자) → 한국 주식 (.KS/.KQ 접미사)
    if (isKrxDomesticCode(code)) {
        const suffix = krMarket === 'KOSDAQ' ? YAHOO_KR_SUFFIX.KOSDAQ : YAHOO_KR_SUFFIX.KOSPI;
        return `${code}${suffix}`;
    }
    // 영문 티커 → 미국 주식 (접미사 없음)
    return code.replaceAll('.', '-');
}
