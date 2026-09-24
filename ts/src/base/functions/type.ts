/**
 * @fileoverview 증권사 응답에서 값을 안전하게 꺼내는 `safe*` 함수들과 타입 판별 함수.
 *
 * 증권사 응답은 같은 필드가 문자열이었다가 숫자였다가 빈 문자열이었다가 하므로, 응답을 그대로 읽으면 곳곳에 방어 코드가 생긴다.
 * 이 함수들은 없는 키, `null`, 빈 문자열을 모두 `undefined` 로 취급하고, 못 읽는 값은 기본값을 돌려준다(던지지 않는다).
 *
 * - `safeX(o, k, d)`: 키 하나. `safeX2(o, k1, k2, d)`: 두 키를 차례로 시도. `safeXN(o, [k...], d)`: 키 배열을 차례로 시도.
 * - ccxt 의 구조를 따른다.
 */

import type { Bool, Dict, Int, List, NullableIndexType, Num, Str } from '../types';
import { parseNumber } from './number';

export const isNumber = (x: unknown): x is number => Number.isFinite(x);
export const isInteger = (x: unknown): x is number => Number.isInteger(x);
export const isArray = (x: unknown): x is List => Array.isArray(x);
export const isString = (x: unknown): x is string => typeof x === 'string';
export const isObject = (x: unknown): x is Dict => x !== undefined && x !== null && typeof x === 'object';
export const hasProps = (x: unknown): boolean => x !== undefined && x !== null;

/** 일반 객체(`{}`)만 참이다. 배열·정규식·클래스 인스턴스는 거짓이다. */
export const isDict = (x: unknown): x is Dict => {
    if (!isObject(x) || isArray(x) || x instanceof RegExp) return false;
    const proto = Object.getPrototypeOf(x);
    return proto === Object.prototype || proto === null;
};

// ============ 키 조회 ============

/** 키의 값. 값이 없거나 `null` 이거나 빈 문자열이면 `undefined`. */
export function prop(o: unknown, k: NullableIndexType): unknown {
    if (k !== undefined && k !== null && isObject(o)) {
        const x = o[k];
        if (x !== null && x !== '') return x;
    }
    return undefined;
}

/** 키 배열을 차례로 시도해 처음 값이 있는 키의 값을 돌려준다. */
export function propN(o: unknown, keys: NullableIndexType[]): unknown {
    if (!isObject(o)) return undefined;
    for (const k of keys) {
        if (k === undefined || k === null) continue;
        const x = o[k];
        if (x !== undefined && x !== null && x !== '') return x;
    }
    return undefined;
}

const prop2 = (o: unknown, k1: NullableIndexType, k2: NullableIndexType): unknown => propN(o, [k1, k2]);

// ============ 값 변환 ============

export function asFloat(x: unknown): number {
    if (isString(x) && x.length !== 0) return parseFloat(x);
    if (isNumber(x)) return x;
    return NaN;
}

export function asInteger(x: unknown): number {
    if (isString(x) && x.length !== 0) return Math.trunc(Number(x));
    if (isNumber(x)) return Math.trunc(x);
    return NaN;
}

const toFloat = (x: unknown, d?: number): Num => {
    if (x === undefined) return d;
    const n = asFloat(x);
    return isNumber(n) ? n : d;
};

const toInteger = (x: unknown, d?: number): Int => {
    if (x === undefined) return d;
    const n = asInteger(x);
    return isNumber(n) ? n : d;
};

const toProduct = (x: unknown, factor: number, d?: number): Int => {
    if (x === undefined) return d;
    const product = asFloat(x) * factor;
    return isNumber(product) ? Math.trunc(product) : d;
};

const asStr = (x: unknown, d?: string): Str => {
    if (x === undefined) return d;
    if (typeof x === 'string') return x;
    if (Number.isFinite(x)) return String(x);
    return d;
};

const toLower = (x: unknown, d?: string): Str => asStr(x)?.toLowerCase() ?? d;
const toUpper = (x: unknown, d?: string): Str => asStr(x)?.toUpperCase() ?? d;

// ============ safeFloat ============

export function safeFloat(o: unknown, k: NullableIndexType, defaultValue?: number): Num {
    return toFloat(prop(o, k), defaultValue);
}
export function safeFloat2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: number): Num {
    return toFloat(prop2(o, k1, k2), defaultValue);
}
export function safeFloatN(o: unknown, keys: NullableIndexType[], defaultValue?: number): Num {
    return toFloat(propN(o, keys), defaultValue);
}

// ============ safeInteger ============

export function safeInteger(o: unknown, k: NullableIndexType, defaultValue: number): number;
export function safeInteger(o: unknown, k: NullableIndexType, defaultValue?: number): Int;
export function safeInteger(o: unknown, k: NullableIndexType, defaultValue?: number): Int {
    return toInteger(prop(o, k), defaultValue);
}
export function safeInteger2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue: number): number;
export function safeInteger2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: number): Int;
export function safeInteger2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: number): Int {
    return toInteger(prop2(o, k1, k2), defaultValue);
}
export function safeIntegerN(o: unknown, keys: NullableIndexType[], defaultValue: number): number;
export function safeIntegerN(o: unknown, keys: NullableIndexType[], defaultValue?: number): Int;
export function safeIntegerN(o: unknown, keys: NullableIndexType[], defaultValue?: number): Int {
    return toInteger(propN(o, keys), defaultValue);
}

// ============ safeIntegerProduct / safeTimestamp ============

/** 값에 계수를 곱한 뒤 소수점 아래를 버린다. */
export function safeIntegerProduct(o: unknown, k: NullableIndexType, factor: number, defaultValue?: number): Int {
    return toProduct(prop(o, k), factor, defaultValue);
}
export function safeIntegerProduct2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, factor: number, defaultValue?: number): Int {
    return toProduct(prop2(o, k1, k2), factor, defaultValue);
}
export function safeIntegerProductN(o: unknown, keys: NullableIndexType[], factor: number, defaultValue?: number): Int {
    return toProduct(propN(o, keys), factor, defaultValue);
}

/** 초 단위 값을 밀리초로 바꾼다. */
export function safeTimestamp(o: unknown, k: NullableIndexType, defaultValue?: number): Int {
    return toProduct(prop(o, k), 1000, defaultValue);
}
export function safeTimestamp2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: number): Int {
    return toProduct(prop2(o, k1, k2), 1000, defaultValue);
}
export function safeTimestampN(o: unknown, keys: NullableIndexType[], defaultValue?: number): Int {
    return toProduct(propN(o, keys), 1000, defaultValue);
}

// ============ safeValue ============

/** 값을 변환 없이 돌려준다. 값이 없거나 `null`·빈 문자열이면 기본값이다. */
export function safeValue(o: unknown, k: NullableIndexType, defaultValue?: any): any {
    const x = prop(o, k);
    return x !== undefined ? x : defaultValue;
}
export function safeValue2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: any): any {
    const x = prop2(o, k1, k2);
    return x !== undefined ? x : defaultValue;
}
export function safeValueN(o: unknown, keys: NullableIndexType[], defaultValue?: any): any {
    const x = propN(o, keys);
    return x !== undefined ? x : defaultValue;
}

// ============ safeString ============

export function safeString(o: unknown, k: NullableIndexType, defaultValue: string): string;
export function safeString(o: unknown, k: NullableIndexType, defaultValue?: string): Str;
export function safeString(o: unknown, k: NullableIndexType, defaultValue?: string): Str {
    return asStr(prop(o, k), defaultValue);
}
export function safeString2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue: string): string;
export function safeString2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: string): Str;
export function safeString2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: string): Str {
    return asStr(prop2(o, k1, k2), defaultValue);
}
export function safeStringN(o: unknown, keys: NullableIndexType[], defaultValue: string): string;
export function safeStringN(o: unknown, keys: NullableIndexType[], defaultValue?: string): Str;
export function safeStringN(o: unknown, keys: NullableIndexType[], defaultValue?: string): Str {
    return asStr(propN(o, keys), defaultValue);
}

export function safeStringLower(o: unknown, k: NullableIndexType, defaultValue?: string): Str {
    return toLower(prop(o, k), defaultValue);
}
export function safeStringLower2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: string): Str {
    return toLower(prop2(o, k1, k2), defaultValue);
}
export function safeStringLowerN(o: unknown, keys: NullableIndexType[], defaultValue?: string): Str {
    return toLower(propN(o, keys), defaultValue);
}

export function safeStringUpper(o: unknown, k: NullableIndexType, defaultValue?: string): Str {
    return toUpper(prop(o, k), defaultValue);
}
export function safeStringUpper2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: string): Str {
    return toUpper(prop2(o, k1, k2), defaultValue);
}
export function safeStringUpperN(o: unknown, keys: NullableIndexType[], defaultValue?: string): Str {
    return toUpper(propN(o, keys), defaultValue);
}

// ============ safeNumber ============

/** 문자열로 읽은 값을 `number` 로 바꾼다. `'1e-8'` 같은 지수 표기도 읽는다. */
export function safeNumber(o: unknown, k: NullableIndexType, defaultValue?: number): Num {
    return parseNumber(safeString(o, k), defaultValue);
}
export function safeNumber2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: number): Num {
    return parseNumber(safeString2(o, k1, k2), defaultValue);
}
export function safeNumberN(o: unknown, keys: NullableIndexType[], defaultValue?: number): Num {
    return parseNumber(safeStringN(o, keys), defaultValue);
}

// ============ safeBool / safeDict / safeList ============

/** 값이 실제 불리언일 때만 받는다. `'true'` 같은 문자열은 기본값이 된다. */
export function safeBool(o: unknown, k: NullableIndexType, defaultValue: boolean): boolean;
export function safeBool(o: unknown, k: NullableIndexType, defaultValue?: boolean): Bool;
export function safeBool(o: unknown, k: NullableIndexType, defaultValue?: boolean): Bool {
    const x = prop(o, k);
    return typeof x === 'boolean' ? x : defaultValue;
}
export function safeBool2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue: boolean): boolean;
export function safeBool2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: boolean): Bool;
export function safeBool2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: boolean): Bool {
    const x = prop2(o, k1, k2);
    return typeof x === 'boolean' ? x : defaultValue;
}

/** 값이 일반 객체일 때만 받는다. */
export function safeDict(o: unknown, k: NullableIndexType, defaultValue: Dict): Dict;
export function safeDict(o: unknown, k: NullableIndexType, defaultValue?: Dict): Dict | undefined;
export function safeDict(o: unknown, k: NullableIndexType, defaultValue?: Dict): Dict | undefined {
    const x = prop(o, k);
    return isDict(x) ? x : defaultValue;
}
export function safeDict2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue: Dict): Dict;
export function safeDict2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: Dict): Dict | undefined;
export function safeDict2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: Dict): Dict | undefined {
    const x = prop2(o, k1, k2);
    return isDict(x) ? x : defaultValue;
}

/** 값이 배열일 때만 받는다. */
export function safeList(o: unknown, k: NullableIndexType, defaultValue: List): List;
export function safeList(o: unknown, k: NullableIndexType, defaultValue?: List): List | undefined;
export function safeList(o: unknown, k: NullableIndexType, defaultValue?: List): List | undefined {
    const x = prop(o, k);
    return isArray(x) ? x : defaultValue;
}
export function safeList2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue: List): List;
export function safeList2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: List): List | undefined;
export function safeList2(o: unknown, k1: NullableIndexType, k2: NullableIndexType, defaultValue?: List): List | undefined {
    const x = prop2(o, k1, k2);
    return isArray(x) ? x : defaultValue;
}
