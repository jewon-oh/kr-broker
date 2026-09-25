/**
 * @fileoverview KIS 가 직접 주는 캔들(OHLCV) 조회
 * @description `kis.fetchOHLCV` 는 이력이 충분한 야후 파이낸스를 먼저 쓴다. 이 모듈은 KIS 원본 캔들이 필요한 경로(심층 이력 채우기, 당일 분봉,
 * 야후가 빈 해외 일봉)를 `kis` 인스턴스의 암묵 API 로 조회한다.
 *
 * - fetchDailyOHLCV: 기간별(일/주/월) 캔들
 * - fetchDailyOHLCVPaged: 창을 과거로 옮겨 가며 심층 이력을 모은다
 * - fetchMinuteOHLCV: 당일 분봉
 * - fetchOverseasDailyOHLCV: 미국 기간별(일/주/월) 캔들
 * - resampleMinuteCandles: N분봉 리샘플링
 */

import { logger } from '../logger';
import { etYmd } from '../us-market-hours';
import { resampleCandles } from './candle-resample';
import type { Exchange } from '../base';
import { planWindows, mergeCandles } from './kis-candle-pagination';
import type { KISDailyCandle, KISOverseasDailyCandle } from './kis-types';
import type { OverseasMarket } from './kis-overseas-master';

// ============ 캔들 관련 상수 ============

/** KIS 캔들 조회용 거래 ID */
const CANDLE_TR_IDS = {
    /** 기간별 시세 (일/주/월/년) — 국내 */
    DAILY_CHART: 'FHKST03010100',
    /** 분봉 시세 (당일) — 국내 */
    MINUTE_CHART: 'FHKST03010200',
    /** 해외주식 기간별시세 (일/주/월) — overseas-price/v1/quotations/dailyprice */
    OVERSEAS_DAILY_CHART: 'HHDFS76240000',
} as const;

/** 해외주식 일/주/월 구분 코드 (GUBN) */
const OVERSEAS_GUBN_MAP: Record<string, '0' | '1' | '2'> = {
    '1d': '0',
    '1w': '1',
    '1W': '1',
    '1M': '2',
};

/** 분봉 API 1회 최대 반환 건수 */
const MINUTE_PAGE_SIZE = 30;

/** 기간 코드별 일수 승수 (주말/공휴일 마진 포함) */
const PERIOD_DAY_MULTIPLIER: Record<string, number> = {
    'W': 7,
    'M': 30,
};

/** 날짜 마진 계수 (공휴일/주말 고려) */
const DATE_MARGIN_FACTOR = 1.5;

// ============ 서비스 ============

export class KISCandleService {
    /** @param exchange 자격증명을 채운 `kis` 인스턴스. 암묵 API(`privateGet…`)를 부른다. */
    constructor(private readonly exchange: Exchange) { }

    /**
     * 기간별(일/주/월) 캔들 조회
     * KIS inquire-daily-itemchartprice 사용
     */
    async fetchDailyOHLCV(
        stockCode: string,
        periodCode: string,
        limit: number,
    ): Promise<number[][]> {
        const today = new Date();
        const dayMultiplier = PERIOD_DAY_MULTIPLIER[periodCode] ?? 1;
        const startDate = this.formatDate(
            new Date(today.getTime() - limit * dayMultiplier * DATE_MARGIN_FACTOR * 24 * 60 * 60 * 1000)
        );
        const rows = await this.fetchDailyOHLCVRange(
            stockCode, periodCode, startDate, this.formatDate(today),
        );
        return rows.slice(-limit);
    }

    /**
     * 창을 과거로 옮겨 가며 **여러 번 호출해** 심층 이력을 채운다.
     *
     * KIS 한 응답이 ~100행이라, 800봉을 원하면 8번 호출해야 한다. 한 번만 호출하면
     * 100봉을 "성공" 으로 읽어 심층 구간이 영영 쌓이지 않는다.
     *
     * **빈 창이 나오면 멈춘다.** 상장 이전 구간까지 창을 계속 옮기면 호출만 낭비된다.
     * 신규 상장주는 1~2창에서 끝난다.
     *
     * @param neededCandles 더 받아야 할 캔들 수. 0 이하면 **한 번도 호출하지 않는다**.
     */
    async fetchDailyOHLCVPaged(
        stockCode: string,
        periodCode: string,
        neededCandles: number,
        opts: { nowMs?: number; onPage?: (i: number) => Promise<void> } = {},
    ): Promise<number[][]> {
        const windows = planWindows(neededCandles, opts.nowMs ?? Date.now());
        if (windows.length === 0) return [];

        const pages: number[][][] = [];
        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            const rows = await this.fetchDailyOHLCVRange(stockCode, periodCode, w.start, w.end);
            if (rows.length === 0) {
                logger.debug({ stockCode, page: i + 1, window: w },
                    '[KISCandleService] 빈 창 — 페이지네이션 중단(상장 이전 추정)');
                break;
            }
            pages.push(rows);
            if (opts.onPage) await opts.onPage(i);
        }
        const merged = mergeCandles(pages);
        logger.info({ stockCode, periodCode, pages: pages.length, candles: merged.length },
            '[KISCandleService] 페이지네이션 완료');
        return merged;
    }

    /**
     * 기간을 **명시해서** 일/주/월 캔들을 조회한다.
     *
     * KIS 는 한 응답에 **약 100행**만 준다(`output2`). `fetchDailyOHLCV` 는 기간을
     * 내부에서 계산하고 항상 오늘로 끝나므로, 800봉을 요청해도 **최근 100봉만** 돌아온다.
     * 호출부가 그걸 "성공" 으로 읽으면(길이 > 0) 심층 폴백도 실행되지 않아
     * 심층 이력이 쌓이지 않는다. 창을 옮겨 가며 호출하려면 기간이 인자여야 한다.
     *
     * @param startDate `YYYYMMDD`
     * @param endDate `YYYYMMDD`
     */
    async fetchDailyOHLCVRange(
        stockCode: string,
        periodCode: string,
        startDate: string,
        endDate: string,
    ): Promise<number[][]> {
        try {
            const response = await this.exchange.privateGetUapiDomesticStockV1QuotationsInquireDailyItemchartprice({
                FID_COND_MRKT_DIV_CODE: 'J',
                FID_INPUT_ISCD: stockCode,
                FID_INPUT_DATE_1: startDate,
                FID_INPUT_DATE_2: endDate,
                FID_PERIOD_DIV_CODE: periodCode,
                FID_ORG_ADJ_PRC: '0',
                tr_id: CANDLE_TR_IDS.DAILY_CHART,
            });
            const data = response.output2 as KISDailyCandle[] | undefined;

            logger.info({
                stockCode, periodCode, startDate, endDate,
                length: Array.isArray(data) ? data.length : 'N/A',
            }, '[KISCandleService] fetchDailyOHLCV 응답');

            if (!Array.isArray(data)) return [];

            return data
                .map(candle => {
                    const dateStr = candle.stck_bsop_date;
                    const timestamp = new Date(
                        `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T09:00:00+09:00`
                    ).getTime();

                    return [
                        timestamp,
                        Number(candle.stck_oprc),
                        Number(candle.stck_hgpr),
                        Number(candle.stck_lwpr),
                        Number(candle.stck_clpr),
                        Number(candle.acml_vol),
                    ];
                })
                .sort((a, b) => a[0] - b[0]);
        } catch (err) {
            // 실패를 `[]` 로 바꾸지 않는다(분봉과 같다). 빈 창은 페이지네이션이 "상장 이전"으로 읽는다.
            logger.error({ err, stockCode, periodCode, startDate, endDate },
                '[KISCandleService] 기간별 캔들 조회 실패');
            throw err;
        }
    }

    /**
     * 분봉 캔들 조회 (당일만)
     * KIS inquire-time-itemchartprice 사용
     * 한 번에 최대 30건, 연속 조회로 limit까지 수집
     */
    async fetchMinuteOHLCV(
        stockCode: string,
        minuteInterval: number,
        limit: number,
    ): Promise<number[][]> {
        try {
            const allCandles: number[][] = [];
            let cursor = '';

            while (allCandles.length < limit) {
                const response = await this.exchange.privateGetUapiDomesticStockV1QuotationsInquireTimeItemchartprice({
                    FID_COND_MRKT_DIV_CODE: 'J',
                    FID_INPUT_ISCD: stockCode,
                    FID_INPUT_HOUR_1: cursor,
                    FID_PW_DATA_INCU_YN: 'N',
                    FID_ETC_CLS_CODE: '',
                    tr_id: CANDLE_TR_IDS.MINUTE_CHART,
                });
                const data = response.output2 as Array<Record<string, string>> | undefined;

                if (!Array.isArray(data) || data.length === 0) break;

                for (const item of data) {
                    const dateStr = item.stck_bsop_date;
                    const timeStr = item.stck_cntg_hour;
                    if (!dateStr || !timeStr) continue;

                    const timestamp = new Date(
                        `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}` +
                        `T${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}:${timeStr.slice(4, 6)}+09:00`
                    ).getTime();

                    allCandles.push([
                        timestamp,
                        Number(item.stck_oprc),
                        Number(item.stck_hgpr),
                        Number(item.stck_lwpr),
                        Number(item.stck_prpr),
                        Number(item.cntg_vol),
                    ]);
                }

                if (data.length < MINUTE_PAGE_SIZE) break;

                const lastTime = data[data.length - 1].stck_cntg_hour;
                if (!lastTime || lastTime === cursor) break;
                cursor = lastTime;
            }

            logger.info({
                stockCode, minuteInterval, count: allCandles.length,
            }, '[KISCandleService] fetchMinuteOHLCV 완료');

            const sorted = allCandles.sort((a, b) => a[0] - b[0]);
            if (minuteInterval <= 1) return sorted.slice(-limit);

            return this.resampleMinuteCandles(sorted, minuteInterval).slice(-limit);
        } catch (err) {
            // 실패를 `[]` 로 바꾸지 않는다.
            //
            // 여기서 빈 배열을 돌려주면 호출부(수집·워밍 작업)는 빈 배열을
            // **"휴장/거래정지"** 로 읽고 서킷브레이커를 **리셋**한다. 그러면 KIS 에 한 건도
            // 닿지 못한 날에도 작업이 `완료` 로 끝난다. 실제로 네트워크가 전면 차단됐을 때(egress 정책 누락)
            // `upserted:0 skipped:100 rows:0 total:100` + "완료" 로 끝난 적이 있다.
            // 원인은 네트워크 차단이었는데 로그의 결론은 성공이었다.
            //
            // "데이터가 없다" 와 "물어보지 못했다" 는 다른 사실이고, 그 둘을 같은 값으로
            // 표현하는 순간 호출부는 구별할 방법이 없다. 호출부가 이미 `catch` 를
            // 갖고 있으므로 그대로 올린다.
            logger.error({ err, stockCode, minuteInterval }, '[KISCandleService] 분봉 캔들 조회 실패');
            throw err;
        }
    }

    /**
     * 1분봉 데이터를 N분봉으로 리샘플링
     * 오름차순 정렬된 OHLCV 배열 기준
     */
    resampleMinuteCandles(candles: number[][], intervalMinutes: number): number[][] {
        return resampleCandles(candles, intervalMinutes);
    }

    /**
     * 해외주식 기간별 캔들 조회 (HHDFS76240000)
     *
     * KIS 한 번 호출당 100건 반환 — 더 필요하면 BYMD 를 이전 페이지 마지막 일자로 갱신해
     * 반복 호출. timeframe 은 1d/1w/1M 만 지원 (KIS 해외 분봉 미지원).
     * BYMD 는 미국 거래일이라 실행 환경의 시간대가 아니라 미국 동부 날짜로 적는다.
     */
    async fetchOverseasDailyOHLCV(
        ticker: string,
        market: OverseasMarket,
        timeframe: string,
        limit: number,
    ): Promise<number[][]> {
        const gubn = OVERSEAS_GUBN_MAP[timeframe];
        if (!gubn) {
            logger.warn({ ticker, market, timeframe },
                '[KISCandleService] 해외 timeframe 미지원 — 1d/1w/1M 만 사용 가능');
            return [];
        }

        try {
            const all: number[][] = [];
            let bymd = etYmd(Date.now());
            const PAGE_SIZE = 100;
            const MAX_PAGES = 10;

            for (let page = 0; page < MAX_PAGES && all.length < limit; page++) {
                const response = await this.exchange.privateGetUapiOverseasPriceV1QuotationsDailyprice({
                    AUTH: '',
                    EXCD: market,
                    SYMB: ticker.toUpperCase(),
                    GUBN: gubn,
                    BYMD: bymd,
                    MODP: '1',
                    tr_id: CANDLE_TR_IDS.OVERSEAS_DAILY_CHART,
                });
                const data = response.output2 as KISOverseasDailyCandle[] | undefined;

                if (!Array.isArray(data) || data.length === 0) break;

                for (const c of data) {
                    if (!c.xymd) continue;
                    const dateStr = c.xymd;
                    const ts = new Date(
                        `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T00:00:00Z`,
                    ).getTime();
                    all.push([
                        ts,
                        Number(c.open),
                        Number(c.high),
                        Number(c.low),
                        Number(c.clos),
                        Number(c.tvol),
                    ]);
                }

                if (data.length < PAGE_SIZE) break;
                // 다음 페이지: 마지막 일자보다 하루 전을 BYMD 로
                const lastXymd = data[data.length - 1].xymd;
                if (!lastXymd) break;
                const lastDate = new Date(
                    `${lastXymd.slice(0, 4)}-${lastXymd.slice(4, 6)}-${lastXymd.slice(6, 8)}T00:00:00Z`,
                );
                lastDate.setUTCDate(lastDate.getUTCDate() - 1);
                bymd = this.formatUtcDate(lastDate);
            }

            const sorted = all.sort((a, b) => a[0] - b[0]);
            logger.info({ ticker, market, timeframe, count: sorted.length },
                '[KISCandleService] fetchOverseasDailyOHLCV 완료');
            return sorted.slice(-limit);
        } catch (err) {
            logger.error({ err, ticker, market, timeframe },
                '[KISCandleService] 해외 기간별 캔들 조회 실패');
            throw err;
        }
    }

    /** 날짜를 YYYYMMDD 형식으로 변환 */
    private formatDate(date: Date): string {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}${m}${d}`;
    }

    /** 날짜를 UTC 달력 기준 YYYYMMDD 로 변환 */
    private formatUtcDate(date: Date): string {
        const y = date.getUTCFullYear();
        const m = String(date.getUTCMonth() + 1).padStart(2, '0');
        const d = String(date.getUTCDate()).padStart(2, '0');
        return `${y}${m}${d}`;
    }
}
