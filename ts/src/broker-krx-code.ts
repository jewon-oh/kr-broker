/**
 * @fileoverview 국내(KRX) 종목코드 판정 — **이 파일은 어떤 모듈도 import 하지 않는다.**
 *
 * 순수 함수 하나와 상수 둘만 담는다.
 */

/** KRX 종목코드 자릿수 */
export const KIS_KRX_CODE_DIGITS = 6;

/** 국내 종목코드의 모양: 6자리이고 첫 글자가 숫자, 나머지는 숫자나 영문자다. 다루는 해외 시장의 티커는 이 모양이 아니다. */
const KRX_CODE_SHAPE = new RegExp(`^\\d[0-9A-Za-z]{${KIS_KRX_CODE_DIGITS - 1}}$`);

/** 신형 영숫자 KRX 단축코드의 예(2026-05-27 도입). 판정은 목록이 아니라 모양(`isKrxDomesticCode`)으로 한다. */
export const KNOWN_ALNUM_KRX_CODES: ReadonlySet<string> = new Set([
    '0193L0', // PLUS 삼성전자선물단일종목인버스2X (삼성전자 005930)
    '0197X0', // SOL SK하이닉스선물단일종목인버스2X (SK하이닉스 000660)
]);

/** 국내 KRX 종목코드인가. 6자리 숫자이거나 숫자로 시작하는 6자리 영숫자(`0193L0`)다. 세 증권사가 모두 이 판정을 쓴다. */
export function isKrxDomesticCode(code: string): boolean {
    return KRX_CODE_SHAPE.test(code);
}
