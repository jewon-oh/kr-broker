/**
 * @fileoverview 해외주식 종목 마스터 (NASDAQ/NYSE/AMEX 전체, 증권사 중립)
 * @description 공식 마스터 파일 (nasmst.cod 등) 을 JSON 으로 바꾼 데이터에서 종목을 찾는다.
 * 데이터는 `kis`·`kbsec` 인스턴스의 `options.masterData` 로 받아 함수의 첫 인자로 넘긴다. 갱신은 마스터 데이터를 다시 만들어 넘긴다.
 *
 * 마스터 파일은 KIS 가 배포하지만 내용은 미국 상장 거래소 정보다. 거래소 코드는 KIS 시세 조회용(3글자, EXCD 파라미터)을 쓴다.
 * - NAS: 나스닥, NYS: 뉴욕, AMS: 아멕스
 * - HKS: 홍콩, SHS: 상해, SZS: 심천
 * - HSX: 호치민, HNX: 하노이, TSE: 도쿄
 *
 * KIS 주문/잔고용 코드(4글자)로 바꾸는 `toOrderMarketCode` 는 `kis/kis-overseas-master` 에 있다.
 *
 * 넘겨받은 나스닥·뉴욕·아멕스 행을 거르지 않고 그대로 쓴다. ticker 형식은 KIS 정식 (BRK/B 등).
 */

import { logger } from './logger';
import type { KisMasterData } from './stock-master-data';
import { rankMasterMatches } from './master-search-rank';

/** KIS 시세 조회용 거래소 코드 (3글자) */
export type OverseasMarket = 'NAS' | 'NYS' | 'AMS' | 'HKS' | 'SHS' | 'SZS' | 'HSX' | 'HNX' | 'TSE';

/** 해외주식 종목 정보 */
export interface OverseasStock {
    /** 티커 (예: 'AAPL', 'NVDA'). KIS pdno 파라미터에 그대로 사용 */
    code: string;
    /** 종목명 (영문) */
    name: string;
    /** 한글명 (선택) */
    nameKr?: string;
    /** 시세 조회용 거래소 코드 (EXCD) */
    market: OverseasMarket;
    /** 통화 (USD / HKD / CNY / JPY / VND) — KIS 마스터에서 string 으로 옴 */
    currency: string;
    /** ETF 여부 (KIS 종목 분류 — security type 3 또는 subCode 001/002/005/006) */
    isEtf?: boolean;
}

/** 파생 목록 캐시 — 마스터 데이터 객체가 같으면 다시 만들지 않는다. 다른 데이터 객체를 넘기면 그 객체로 새로 만든다. */
const overseasCache = new WeakMap<KisMasterData, readonly OverseasStock[]>();

function overseasStockMaster(data: KisMasterData): readonly OverseasStock[] {
    let list = overseasCache.get(data);
    if (list === undefined) {
        list = [...data.nasdaq, ...data.nyse, ...data.amex];
        overseasCache.set(data, list);
    }
    return list;
}

/**
 * 해외주식 종목 검색.
 *
 * @param data 마스터 데이터
 * @param query 검색어 (티커/한글명/영문명)
 * @param limit 최대 반환 개수 (기본 50)
 * @param market 거래소 필터 (선택, 미지정 시 전체)
 */
export function searchOverseasStocks(
    data: KisMasterData,
    query?: string,
    limit: number = 50,
    market?: OverseasMarket,
): OverseasStock[] {
    const master = overseasStockMaster(data);
    const filtered = market
        ? master.filter(s => s.market === market)
        : master;

    if (!query || query.trim().length === 0) {
        return filtered.slice(0, limit);
    }

    const q = query.trim().toLowerCase();
    const results = filtered.filter(stock =>
        stock.code.toLowerCase().includes(q)
        || stock.name.toLowerCase().includes(q)
        || (stock.nameKr?.toLowerCase().includes(q) ?? false),
    );

    logger.debug({ query, market, resultCount: results.length }, '[KIS OverseasMaster] 종목 검색');
    // 자르기 **전에** 관련도 정렬 — 안 하면 정확히 그 코드인 종목이 한도 밖으로 밀린다.
    return rankMasterMatches(results, q, s => s.code).slice(0, limit);
}

/** 티커로 전체 종목 정보 lookup. 메타데이터가 필요한 경로용. */
export function getOverseasStockByCode(data: KisMasterData, code: string): OverseasStock | undefined {
    return overseasStockMaster(data).find(s => s.code === code.toUpperCase());
}

/** 티커로 시세 거래소 코드 lookup */
export function getOverseasMarketForCode(data: KisMasterData, code: string): OverseasMarket | undefined {
    return getOverseasStockByCode(data, code)?.market;
}
