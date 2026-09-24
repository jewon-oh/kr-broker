/**
 * @fileoverview 국내(KRX) 종목의 KOSPI/KOSDAQ 시장 구분 해석
 * @description Yahoo 티커 접미사(.KS/.KQ)를 정확히 붙이려면 시장 구분이 필요하다.
 * 종목 디렉터리(`options.stockDirectory`, 종목 DB 등) 조회 기반으로 6자리 국내 종목코드를 KOSPI/KOSDAQ 로 분류하고, 디렉터리가 없으면
 * 마스터 데이터(`options.masterData`)로 판별한다.
 * 미해석 시 undefined(→ 호출 측이 .KS 기본값 사용). `kis` 클래스의 캔들 조회 경로가 쓴다.
 */

import { logger } from '../logger';
import type { BrokerStockDirectory } from '../options';
import { isKrxDomesticCode } from './kis-types';
import type { KisMasterData } from './kis-master-data';
import { getKRXStockByCode } from './kis-stock-master';

/** 시장 구분을 찾는 곳. 디렉터리가 우선이고, 없으면 마스터 데이터를 본다. */
export interface KrMarketSources {
    stockDirectory?: BrokerStockDirectory | null;
    masterData: KisMasterData;
}

/**
 * 국내 주식 시장 구분 조회 — 종목 디렉터리 기반.
 * 6자리 숫자 코드가 아니거나 조회 실패 시 undefined(호출 측 .KS 기본값).
 *
 * @param symbol 종목코드 또는 '005930/KRW' 등 (앞부분만 사용)
 */
export async function resolveKrMarket(symbol: string, sources: KrMarketSources): Promise<'KOSPI' | 'KOSDAQ' | undefined> {
    const code = symbol.split('/')[0];
    if (!isKrxDomesticCode(code)) return undefined;
    try {
        // 종목 디렉터리가 우선이고, 없으면 KIS 마스터 데이터로 판별한다.
        const directory = sources.stockDirectory;
        if (directory) return await directory.findKrMarket(code);
        return getKRXStockByCode(sources.masterData, code)?.market;
    } catch (err) {
        // 조회 실패도 `undefined` 였다 — 호출부는 그걸 기본값 **`.KS`(KOSPI)** 로
        // 읽는다. 즉 KOSDAQ 종목이 KOSPI 티커로 조회된다. "KOSPI 다" 와 "못 읽었다" 가
        // 같은 값이라 조용한 오라우팅이 된다(캔들 라우팅에서 이미 같은 유형의 사고가 있었다 —
        // 티커 오판으로 **다른 자산 가격을 조용히 반환**).
        // 동작(기본값 폴백)은 그대로 두고 사유를 남긴다.
        logger.warn(
            { code, err: err instanceof Error ? err.message : String(err) },
            '[KrMarket] 종목 디렉터리 조회 실패 — 기본값(.KS/KOSPI) 사용. KOSDAQ 종목이면 잘못된 티커로 조회된다',
        );
    }
    return undefined;
}
