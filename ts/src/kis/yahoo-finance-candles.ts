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

import { NotSupported } from '../base/errors';
import { logger } from '../logger';
import { resampleCandles } from './candle-resample';
import { timeframeToMs } from '../broker-time';
import { isKrxDomesticCode } from './kis-types';

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
 * 분봉 (1m/5m/15m/30m) 은 Yahoo 가 *strict* 60-day 경계를 적용 — period1 이
 * "now - 60days" 와 같거나 더 과거이면 422 "must be within the last 60 days"
 * 로 거부 → 빈 응답. 운영 사고: 클램핑 후 정확히 60일 경계로 요청 →
 * 매 사이클 빈 응답 → 동일 갭 무한 재검출. 1일 안전 버퍼로 회피.
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
 * Yahoo 는 100+심볼 버스트(스크리너 유니버스 등) 시 개별 요청은 정상이나 result:null(빈 응답)을
 * 자주 반환한다 → 4h(=1h 리샘플) 캔들이 전부 비어 호출하는 쪽이 "캔들 데이터 부족" 으로 분석을 건너뛴다.
 * 호출하는 쪽의 동시성 상한만으로는 부족해, 지터 백오프 재시도로 스로틀에서 회복한다.
 * 심볼 부재(chart.error)는 재시도 무의미 → 즉시 반환.
 */
const YAHOO_MAX_ATTEMPTS = 3;
const YAHOO_RETRY_BASE_MS = 500;

const yahooSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 프로세스 전역 Yahoo 동시 요청 상한. 스크리너 유니버스(100+심볼)를 호출하는 쪽의
 * 동시성 상한 × 여러 호출자 × 재시도로 동시에 반복 호출하면 Yahoo 가
 * `result:null`(빈 응답)을 대량 반환한다 (개별/소규모 요청은 정상 — 순수 버스트 스로틀).
 * 세마포어로 동시성을 낮게 직렬화하면 각 요청이 안정 성공하고, 호출하는 쪽이 성공한 캔들을
 * 저장해 두므로 콜드 사이클 1회만 비용이 든다(이후 캐시 조회). 재시도(위)도 이 상한 안에서 큐잉된다.
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
 * (지연된) 현재 시각**을 준다. 그대로 저장하면 폴링마다 타임스탬프가 달라지고,
 * 캔들 저장소의 유니크 키가 (exchange, symbol, timeframe, marketType, timestamp) 이면
 * **갱신이 아니라 새 행**이 쌓인다.
 *
 * 실측(005930 `1h`): 11:50:16~19 KST 에 4번 폴링해 02:30:15/16/17/18 네 행이
 * 생겼다(무료 시세 20분 지연분이 그대로 타임스탬프가 됨). 이런 행이 누적돼 최근 60봉이
 * 60시간이 아니라 24.3시간만 커버했고, 그 위에서 계산하는 Supertrend 같은 지표 기반 진입·청산이
 * 노이즈를 추세로 읽었다.
 *
 * UTC 정시로 내리면 안 된다. 미국장 시간봉은 개장(13:30 UTC)에 앵커돼
 * 13:30·14:30·15:30… 으로 오는 **정상** 봉이라, 정시 정렬은 전 구간 키를 바꿔버린다
 * (KIS 해외 1h 의 99.2% 가 여기 해당). 그래서 절대 격자가 아니라 **직전 완성봉에서
 * tf 배수만큼** 떨어진 지점으로 스냅해 세션 위상을 보존한다.
 *
 * 일봉·주봉·월봉(`d`, `w`, `W`, `M`)은 대상이 아니다 — 진행 중 봉 문제가 없고, 키를 바꾸면 기존 적재분과 어긋난다.
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
 * @returns CCXT 호환 OHLCV: [[timestamp, open, high, low, close, volume], ...]
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

    // Yahoo interval 매핑 — 미지원 timeframe 은 1d silent 폴백이 운영 환경 사고 원인이었음.
    // 호출 측에서 명시적 timeframe 사용을 강제하기 위해 에러 throw 로 전환.
    const interval = YAHOO_INTERVAL_MAP[timeframe];
    if (!interval) {
        logger.error({ timeframe, stockCode }, '[YahooFinance] ❌ 미지원 timeframe — silent 폴백 차단');
        throw new NotSupported(
            `[YahooFinance] 미지원 타임프레임 '${timeframe}'. `
            + `지원: ${Object.keys(YAHOO_INTERVAL_MAP).join(', ')}. `
            + `이전 동작(1d silent 폴백)은 지표 오계산 사고로 폐기.`,
        );
    }

    // URL 구성 (재시도 간 불변 — 루프 밖에서 1회 계산)
    const params = new URLSearchParams({ interval });

    // 요청 윈도 → Yahoo `range` 버킷 매핑.
    // 핵심: undici(Node fetch)는 period1/period2 intraday 요청에 HTTP 400 을 반환한다
    // (curl·브라우저는 200). 캔들 조회가 전부 period 를 써서 주식 캔들이 모두 실패했다. `range`
    // 파라미터는 undici 에서도 정상(200)이므로 항상 range 로 조회한다. range 는 "지금까지"를
    // 반환하지만 호출부는 최근 limit개만 슬라이스하므로 무해(라이브 분석 until≈now).
    const maxRangeMs = YAHOO_MAX_RANGE_MS[timeframe];
    if (since) {
        let windowMs = (until ?? Date.now()) - since;
        if (maxRangeMs) windowMs = Math.min(windowMs, maxRangeMs);
        params.set('range', toYahooRange(windowMs));
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
                    // 429/5xx = 일시적 스로틀 → 재시도. 그 외 4xx = 즉시 포기.
                    const retryable = response.status === 429 || response.status >= 500;
                    logger.warn({ status: response.status, yahooSymbol, attempt, retryable },
                        '[YahooFinance] API 응답 에러');
                    if (retryable && canRetry) { await backoff(); continue; }
                    return [];
                }

                const data = await response.json() as YahooChartResponse;

                if (data.chart.error) {
                    // 존재하지 않는 심볼 등 — 재시도 무의미.
                    logger.warn({ error: data.chart.error, yahooSymbol }, '[YahooFinance] 차트 에러');
                    return [];
                }

                const result = data.chart.result?.[0];
                if (!result?.timestamp || !result?.indicators?.quote?.[0]) {
                    // result:null = 버스트 스로틀 신호(개별 요청은 정상) → 백오프 재시도.
                    if (canRetry) {
                        logger.debug({ yahooSymbol, attempt }, '[YahooFinance] 빈 응답 — 재시도');
                        await backoff();
                        continue;
                    }
                    logger.warn({ yahooSymbol, attempts: YAHOO_MAX_ATTEMPTS }, '[YahooFinance] 빈 응답 (재시도 소진)');
                    return [];
                }

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

                // 진행 중 마지막 봉만 그리드에 스냅 → 폴링마다 새 행이 쌓이지 않는다. 4h 는 받은 1h 봉의 격자로 맞춘 뒤 합친다.
                const needsResample = timeframe === '4h';
                alignTailToSeriesGrid(candles, needsResample ? '1h' : timeframe);
                dedupeByTimestampKeepLast(candles);

                // 종목당 1줄 → 유니버스 스캔에서 분당 수백 줄.
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

                // 최신 limit개만 반환
                return finalCandles.slice(-limit);
            } catch (err) {
                // 네트워크/타임아웃 = 일시적 → 재시도.
                if (canRetry) {
                    logger.debug({ err, yahooSymbol, attempt }, '[YahooFinance] 요청 실패 — 재시도');
                    await backoff();
                    continue;
                }
                logger.warn({ err, stockCode, yahooSymbol: toYahooTicker(stockCode), timeframe },
                    '[YahooFinance] 캔들 조회 실패 (재시도 소진)');
                return [];
            }
        }
        return [];
    } finally {
        releaseYahooSlot();
    }
}

// ============ 내부 유틸 ============

/**
 * 요청 윈도(ms) → Yahoo `range` 버킷.
 * undici 가 period1/period2 를 400 처리하므로 range 로만 조회한다. 표준 Yahoo range 값 중
 * 요청 윈도를 덮는 최소 버킷을 고른다(약간 넘치면 호출부가 limit 슬라이스로 정리).
 */
function toYahooRange(windowMs: number): string {
    const days = windowMs / (24 * 60 * 60 * 1000);
    if (days <= 1) return '1d';
    if (days <= 5) return '5d';
    if (days <= 30) return '1mo';
    if (days <= 90) return '3mo';
    if (days <= 180) return '6mo';
    if (days <= 366) return '1y';
    if (days <= 731) return '2y';
    if (days <= 1826) return '5y';
    if (days <= 3651) return '10y';
    return 'max';
}

/**
 * 종목코드 → Yahoo Finance 티커 변환
 * - 한국 주식: 005930 → 005930.KS (KOSPI), KOSDAQ 종목은 058470 → 058470.KQ
 * - 미국 주식: AAPL → AAPL (접미사 없음). 클래스 주식의 점은 야후 표기인 하이픈으로 바꾼다(BRK.B → BRK-B)
 * - 프론트에서 'stock:AAPL' 또는 '005930/KRW' 형태로 올 수 있으므로 처리
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
