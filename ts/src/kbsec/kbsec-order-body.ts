/**
 * @fileoverview 국내 주문 본문 빌더.
 *
 * 국내 주문 4종(매수·매도·정정·취소)은 **입력 레이아웃이 같다**(명세 확인). 필수 여부만 다르므로 본문을 한곳에서 만들고 차이는
 * `override` 로 덮는다. 새 주문 변형(시간외 등)을 추가할 때 필드를 다시 나열하지 않게 하려는 것이다.
 */

import {
    KBSEC_CREDIT_CASH,
    KBSEC_ORDER_TYPE_KR,
    KBSEC_SESSION_REGULAR,
    KBSEC_SOR,
    kbsecNum,
} from './kbsec-types';

export interface KrOrderInput {
    base: string;
    /** 수량. 취소는 전부 취소라 0 이어도 된다. */
    amount?: number | undefined;
    price?: number | undefined;
    isLimit?: boolean | undefined;
    /** 주문업무구분 — `KBSEC_ORDER_SIDE_KR`. */
    jbClsf: string;
    /** 대체거래소 라우팅. 생략하면 KRX. */
    sor?: string | undefined;
    /** 시장시간구분. 생략하면 정규장. */
    session?: string | undefined;
}

export function buildKrOrderBody(
    input: KrOrderInput,
    override: Record<string, unknown> = {},
): Record<string, unknown> {
    const isLimit = input.isLimit ?? true;
    return {
        mkt_tm_clsf: input.session ?? KBSEC_SESSION_REGULAR,
        ordr_jb_clsf: input.jbClsf,
        // 매도구분은 `1` 선물대용매도 · `2` 입고예정매도 · `3` 공매도다. 일반 현금매매는 해당 없음이라 빈 값이 정본이다.
        s_clsf: '',
        is_cd: input.base,
        // 수량은 **내림**이다. `kbsecNum` 의 `toFixed(0)` 은 반올림이라 8.87주가 9주로 나가 요청보다 많이 산다.
        // 국내 주식은 주 단위라 소수는 어차피 못 쓰고, 초과보다 미달이 안전한 방향이다.
        ordr_q: kbsecNum(Math.floor(input.amount ?? 0)),
        // 시장가는 단가를 **빈 값**으로 보낸다. `'0'` 을 보내면 `주문단가를 확인하십시오`(1896)로 거부된다. 공식 예제 콘솔도 빈 값이다.
        ordr_uprc: isLimit ? kbsecNum(input.price ?? 0) : '',
        ordr_ccd: isLimit ? KBSEC_ORDER_TYPE_KR.LIMIT : KBSEC_ORDER_TYPE_KR.MARKET,
        crdt_typ_cd: KBSEC_CREDIT_CASH,
        sor_ordr_ccd: input.sor ?? KBSEC_SOR.KRX,
        ...override,
    };
}
