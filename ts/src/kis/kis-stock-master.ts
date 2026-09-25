/**
 * @fileoverview KRX 종목 마스터 (국내주식 심볼 검색용)
 * @description KIS 공식 마스터 파일 (kospi_code.mst / kosdaq_code.mst) 을 JSON 으로 바꾼 데이터에서 종목을 찾는다.
 * 데이터는 `kis` 인스턴스의 `options.masterData` 로 받아 함수의 첫 인자로 넘긴다. 갱신하려면 KIS 공식 마스터 파일을 다시 내려받아
 * 같은 모양으로 만들어 넘긴다.
 *
 * 데이터 출처: KIS Open API 공식 (https://new.real.download.dws.co.kr/common/master/)
 * - kospi — KOSPI 상장 종목 (~1800)
 * - kosdaq — KOSDAQ 상장 종목 (~1800)
 * 합계 ~3600 종목 (펀드/ETN/지수 제외 — 6자리 숫자 단축코드만 등록).
 */

import { logger } from '../logger';
import type { KisMasterData } from './kis-master-data';
import { rankMasterMatches } from './master-search-rank';

/** KRX 종목 정보 */
export interface KRXStock {
    /** 종목코드 (6자리, 예: '005930') */
    code: string;
    /** 종목명 (한글, 예: '삼성전자') */
    name: string;
    /** 영문명 (KIS 마스터 미제공 — KRX 외부 출처 합류 시 채워짐) */
    nameEn?: string;
    /** 시장 구분 */
    market: 'KOSPI' | 'KOSDAQ';
    /** ISIN (12자리, 예: 'KR7005930003') */
    isin?: string;
    /** 증권유형 — STOCK/ETF/ETN/REIT… KIS 마스터 증권그룹구분코드 도출 */
    securityType?: string;
}

/**
 * 신형 영숫자 KRX 단축코드 큐레이션 보충.
 * 2026-05-27 상장 단일종목 인버스2X ETF — 번들 마스터 스냅샷에 없다. 마스터 스냅샷을 다시 만들어도
 * 유지되도록 코드로 병합한다(중복 시 마스터 우선 — 자가치유).
 */
const CURATED_KRX_SUPPLEMENT: readonly KRXStock[] = [
    { code: '0193L0', name: 'PLUS 삼성전자선물단일종목인버스2X', market: 'KOSPI', securityType: 'ETF' },
    { code: '0197X0', name: 'SOL SK하이닉스선물단일종목인버스2X', market: 'KOSPI', securityType: 'ETF' },
];

function buildKrxMaster(data: KisMasterData): readonly KRXStock[] {
    return [
        ...data.kospi,
        ...data.kosdaq,
        ...CURATED_KRX_SUPPLEMENT.filter(
            s => ![...data.kospi, ...data.kosdaq].some(m => m.code === s.code),
        ),
    ];
}

/** 파생 목록 캐시 — 마스터 데이터 객체가 같으면 다시 만들지 않는다. 다른 데이터 객체를 넘기면 그 객체로 새로 만든다. */
const krxCache = new WeakMap<KisMasterData, readonly KRXStock[]>();

function krxStockMaster(data: KisMasterData): readonly KRXStock[] {
    let list = krxCache.get(data);
    if (list === undefined) {
        list = buildKrxMaster(data);
        krxCache.set(data, list);
    }
    return list;
}

/**
 * 종목 검색 (코드, 한글명 매칭).
 *
 * KIS 마스터에 영문명이 없어 영문 검색은 한글명에 들어간 영문 약어 (LG, SK, KT) 로만
 * 매칭. 정확한 영문 검색이 필요하면 별도 출처 (KRX 공식) 합류 검토.
 *
 * @param data 마스터 데이터
 * @param query 검색어
 * @param limit 최대 반환 개수
 */
export function searchKRXStocks(data: KisMasterData, query?: string, limit: number = 50): KRXStock[] {
    if (!query || query.trim().length === 0) {
        // 검색어 없으면 마스터 상위 반환 — KIS 마스터는 코드 오름차순 정렬되어 있음
        return krxStockMaster(data).slice(0, limit);
    }

    const q = query.trim().toLowerCase();

    // 코드도 소문자로 맞춰 비교한다(신형 영숫자 코드 `0193L0`).
    const results = krxStockMaster(data).filter(stock =>
        stock.code.toLowerCase().includes(q)
        || stock.name.toLowerCase().includes(q)
        || (stock.nameEn?.toLowerCase().includes(q) ?? false),
    );

    logger.debug({ query, resultCount: results.length }, '[KIS StockMaster] 종목 검색');
    // 자르기 **전에** 관련도 정렬 — 안 하면 정확히 그 코드인 종목이 한도 밖으로 밀린다.
    return rankMasterMatches(results, q, s => s.code).slice(0, limit);
}

/** 종목 마스터 전체 개수 */
export function getStockMasterCount(data: KisMasterData): number {
    return krxStockMaster(data).length;
}

/** 6자리 코드로 KRX 종목 정확 lookup (거래가능 판정용). 미등록이면 undefined. */
export function getKRXStockByCode(data: KisMasterData, code: string): KRXStock | undefined {
    return krxStockMaster(data).find(s => s.code === code);
}
