/**
 * @fileoverview KB증권 `processCode` → 오류 클래스 표.
 *
 * KB 는 코드 체계를 공개하지 않는다. 그래서 이 표의 **모든 항목은 실측한 것**이고, 실측하지 않은 코드는 넣지 않는다.
 * 표에 없는 코드는 `ExchangeError`(증권사가 거절했으나 분류 밖)로 남는다. 코드를 추측해 채우면 잘못된 종류가 붙어 재시도와 기록 판단이 틀어진다.
 *
 * 항목을 추가할 때는 실측한 문구와 TR 을 주석으로 남긴다.
 *
 * `1861`(조회할 자료가 없습니다)과 `2149`(해당자료가 없습니다)는 이 표에 없다. `kbsec-envelope.ts` 가 정상적인 빈 결과로 흡수하므로 던져지지 않는다.
 * 해외 정산에 국내의 매매구분 `9` 를 보내면 1861 이 돌아오는데, 거부가 "거래 없음"처럼 보이는 원인이 바로 이것이다.
 *
 * 클래스만으로는 원인을 다 말하지 못하는 항목은 `detail` 문자열을 함께 둔다. `detail` 은 던져진 오류의 `error.detail` 로 전해진다.
 */

import {
    AccountNotEnabled, AuthenticationError, BadRequest, ExchangeError, InsufficientFunds, InvalidOrder, PermissionDenied,
    type ErrorClass,
} from '../base/errors';

/** `detail` 값. 클래스보다 구체적인 원인이다. */
export const KBSEC_ERROR_DETAIL = {
    /** 토큰이 무효다. 재발급하고 한 번 다시 보내면 복구된다. */
    TOKEN_INVALID: 'TOKEN_INVALID',
    /** 매도할 보유 수량이 모자란다(`InsufficientFunds` 로 던져진다). */
    INSUFFICIENT_POSITION: 'INSUFFICIENT_POSITION',
    /** 주문 단가를 거부했다(호가단위 위반 등). */
    PRICE_INVALID: 'PRICE_INVALID',
    /** 주문 수량이 0 이하이거나 최소 수량 미만이다. */
    QUANTITY_INVALID: 'QUANTITY_INVALID',
    /** 이 상품·세션에서 허용되지 않는 주문 유형이다(시장가 불가 등). */
    ORDER_TYPE_NOT_ALLOWED: 'ORDER_TYPE_NOT_ALLOWED',
    /** 넥스트레이드(NXT)에 상장돼 있지 않은 종목이다. KRX 로 다시 주문하면 된다. */
    NXT_INELIGIBLE: 'NXT_INELIGIBLE',
    /** 조회일자가 KB 의 현재 영업일보다 앞서 있다. 영업일을 되감아 다시 조회하면 된다. */
    FUTURE_QUERY_DATE: 'FUTURE_QUERY_DATE',
} as const;

export interface KBSecErrorMapping {
    error: ErrorClass;
    detail?: string;
}

/** 실측한 processCode 의 매핑. 키는 코드 문자열이다. */
export const KBSEC_PROCESS_CODES: Readonly<Record<string, KBSecErrorMapping>> = {
    // 토큰 검증 실패 — 재발급과 1회 재시도로 복구된다. 재시도 뒤에도 남으면 인증 실패다(SSQM0004 실측).
    I445: { error: AuthenticationError, detail: KBSEC_ERROR_DETAIL.TOKEN_INVALID },
    // `API 사용 권한이 없습니다.` — 해외 잔고·주문 TR 에서 실측.
    I446: { error: PermissionDenied },
    // `앱키로 앱정보 추출 중 오류...` — 앱키 자체가 틀렸을 때 실측(processFlag B).
    E021: { error: AuthenticationError },
    // `증거수량이 부족하여 주문불가합니다` — SSAM1801 매도 재시도 실측(분할체결을 잘못 읽고 같은 매도를 반복했을 때 거부됐다).
    1951: { error: InsufficientFunds, detail: KBSEC_ERROR_DETAIL.INSUFFICIENT_POSITION },
    // `주문단가를 확인하십시오` — 실측.
    1896: { error: InvalidOrder, detail: KBSEC_ERROR_DETAIL.PRICE_INVALID },
    // `주문수량을 확인하십시오` — 실측.
    2329: { error: InvalidOrder, detail: KBSEC_ERROR_DETAIL.QUANTITY_INVALID },
    // `시장가주문은 매도만 가능합니다` — 해외 시장가 매수 거부(SKAM2101), 실측.
    G474: { error: InvalidOrder, detail: KBSEC_ERROR_DETAIL.ORDER_TYPE_NOT_ALLOWED },
    // `시장 구분값을 확인하세요` — `mkt_tm_ccd` 를 빠뜨려 전량 거부된 사례(SSQM1801), 요청 필드 오류.
    3576: { error: BadRequest },
    // `체결구분을 확인하십시오` — 구분 필드를 비웠을 때 실측(요청 오류).
    8654: { error: BadRequest },
    // `글로벌원마켓 미신청계좌입니다` — SPQM3390 실측. 계좌 가입이 필요하다.
    H049: { error: AccountNotEnabled },
    // `NXT에서 거래할 수 없는 종목입니다. KRX로 주문해주세요.` — SOR 로 보낸 우선주 등에서 실측. 접수되지 않은 거부라 KRX 로 다시 보내도 중복이 아니다.
    L545: { error: ExchangeError, detail: KBSEC_ERROR_DETAIL.NXT_INELIGIBLE },
    // `주문일자가 현재일자보다 큽니다` — 조회일자가 KB 영업일보다 앞설 때 실측(주말·휴장일 조회).
    2854: { error: ExchangeError, detail: KBSEC_ERROR_DETAIL.FUTURE_QUERY_DATE },
};

/** `Exchange.exceptions.exact` 에 넣는 표. */
export function kbsecExactExceptions(): Record<string, ErrorClass> {
    const exact: Record<string, ErrorClass> = {};
    for (const [code, mapping] of Object.entries(KBSEC_PROCESS_CODES)) exact[code] = mapping.error;
    return exact;
}

/** 이 processCode 의 `detail`. 없으면 `undefined`. */
export function kbsecErrorDetail(processCode: string): string | undefined {
    return KBSEC_PROCESS_CODES[processCode.trim()]?.detail;
}
