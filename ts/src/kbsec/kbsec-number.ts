/**
 * @fileoverview KB 응답 행의 값 읽기. 로거에 기대지 않는 순수 함수라 `kbsec-pick` 과 체결·정산 행 파서가 함께 쓴다.
 *
 * KB 는 필드가 전부 `char` 라 숫자도 문자열로 오고, 값이 없으면 공백으로 채워 보내기도 한다(마지막 쪽의 `nxt_key` 등).
 * 공백만 있는 값은 빈 값으로 보고 다음 후보로 넘어간다. `Number('   ')` 는 0 이라, 공백을 숫자로 읽으면 뒤 후보에 닿지 못한다.
 */

/** 값 하나를 숫자로 읽는다. 쉼표는 지운다. 비었거나(공백만 있는 값 포함) 숫자가 아니면 `undefined` 다. */
export function kbsecNumberOf(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).replace(/,/g, '').trim();
    if (text === '') return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
}

/** 문자열·쉼표 섞인 KB 숫자를 number 로 읽는다. 키를 앞에서부터 시도하고 하나도 못 읽으면 0 이다. */
export function kbsecNumber(raw: Record<string, unknown> | undefined, ...keys: string[]): number {
    if (!raw) return 0;
    for (const k of keys) {
        const n = kbsecNumberOf(raw[k]);
        if (n !== undefined) return n;
    }
    return 0;
}

/** 공백이 아닌 첫 후보 문자열(앞뒤 공백을 뗀 값). 없으면 `''`. */
export function kbsecString(raw: Record<string, unknown> | undefined, ...keys: string[]): string {
    if (!raw) return '';
    for (const k of keys) {
        const v = raw[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
}
