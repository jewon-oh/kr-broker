/**
 * @fileoverview KIS 해외 거래소 코드의 주문용 매핑과 해외주식 종목 마스터의 재수출 — 마스터의 정본은 `../overseas-stock-master` 다.
 *
 * KIS 는 거래소 코드를 두 체계로 쓴다. 마스터와 시세 조회는 3글자(EXCD, `OverseasMarket`), 주문과 잔고는 4글자(OVRS_EXCG_CD)다.
 * - NASD: 나스닥, NYSE: 뉴욕, AMEX: 아멕스 (미국 잔고 조회는 실전이 NASD 한 번으로 미국 전체를 받고, 모의는 세 거래소를 따로 부른다)
 * - SEHK: 홍콩, SHAA: 상해, SZAA: 심천
 * - HASE: 하노이, VNSE: 호치민, TKSE: 일본
 *
 * 마스터 조회는 증권사 중립 모듈로 옮겼고, 공개 경로(`kr-broker/kis/kis-overseas-master`)를 쓰는 쪽을 위해 여기서 다시 내보낸다.
 */

import type { OverseasMarket } from '../overseas-stock-master';

export {
    getOverseasMarketForCode,
    getOverseasStockByCode,
    searchOverseasStocks,
} from '../overseas-stock-master';
export type { OverseasMarket, OverseasStock } from '../overseas-stock-master';

/** KIS 주문/잔고용 거래소 코드 (4글자) */
export type OverseasOrderMarket = 'NASD' | 'NYSE' | 'AMEX' | 'SEHK' | 'SHAA' | 'SZAA' | 'HASE' | 'VNSE' | 'TKSE';

/**
 * 시세 코드 → 주문 코드 매핑 (NAS → NASD 등).
 * 주문 시 OVRS_EXCG_CD 파라미터로 변환해 사용.
 */
export function toOrderMarketCode(quoteCode: OverseasMarket): OverseasOrderMarket {
    const map: Record<OverseasMarket, OverseasOrderMarket> = {
        NAS: 'NASD',
        NYS: 'NYSE',
        AMS: 'AMEX',
        HKS: 'SEHK',
        SHS: 'SHAA',
        SZS: 'SZAA',
        HSX: 'VNSE',
        HNX: 'HASE',
        TSE: 'TKSE',
    };
    return map[quoteCode];
}
