/**
 * @fileoverview KB 응답 행의 숫자 읽기. 정산 행 파서 둘(국내·해외)이 같이 쓴다.
 */

/** 문자열·쉼표 섞인 KB 숫자를 number 로 읽는다. 키를 앞에서부터 시도하고 하나도 못 읽으면 0 이다. */
export function kbsecNumber(raw: Record<string, unknown>, ...keys: string[]): number {
    for (const k of keys) {
        const v = raw[k];
        if (v === undefined || v === null || String(v).trim() === '') continue;
        const n = Number(String(v).replace(/,/g, ''));
        if (Number.isFinite(n)) return n;
    }
    return 0;
}
