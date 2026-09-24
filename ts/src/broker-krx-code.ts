/**
 * @fileoverview 국내(KRX) 종목코드 판정 — **이 파일은 어떤 모듈도 import 하지 않는다.**
 *
 * 순수 함수 하나와 상수 둘만 담는다.
 */

/** KRX 종목코드 자릿수 */
export const KIS_KRX_CODE_DIGITS = 6;

const KIS_KRX_CODE_RE = new RegExp(`^\\d{${KIS_KRX_CODE_DIGITS}}$`);

/**
 * 신형 영숫자 KRX 단축코드 화이트리스트. KRX 가 2026-05-27 단일종목 레버리지·인버스 ETF 에 6자리 영숫자 코드를 도입해, 6자리 숫자
 * 가정이 이 종목들을 해외로 잘못 나눴다. 임의의 6자리 영숫자를 국내로 넓히지 않도록 큐레이션한 목록으로만 한정한다.
 */
export const KNOWN_ALNUM_KRX_CODES: ReadonlySet<string> = new Set([
    '0193L0', // PLUS 삼성전자선물단일종목인버스2X (삼성전자 005930)
    '0197X0', // SOL SK하이닉스선물단일종목인버스2X (SK하이닉스 000660)
]);

/**
 * 국내 KRX 종목코드인가 — 6자리 숫자(대다수)이거나 큐레이션한 신형 영숫자 코드다. 6자리 숫자는 해외 티커와 겹치지 않아 안전하고,
 * 영숫자는 화이트리스트와 정확히 일치할 때만 국내로 본다.
 */
export function isKrxDomesticCode(code: string): boolean {
    return KIS_KRX_CODE_RE.test(code) || KNOWN_ALNUM_KRX_CODES.has(code);
}
