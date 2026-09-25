/**
 * @fileoverview 사전·배열 다루기와 URL 경로·쿼리 조립. 입력을 바꾸지 않고 새 값을 돌려주는 함수가 대부분이다.
 */

import type { Dict, Dictionary, IndexType, List } from '../types';
import { isArray, isDict, isNumber } from './type';

export const keys = Object.keys;
export const values = (x: List | Dictionary<any>): any[] => (isArray(x) ? x : Object.values(x));
export const extend = (...args: any[]): Dict => Object.assign({}, ...args);
export const clone = <T>(x: T): T => (isArray(x) ? (Array.from(x) as T) : (extend(x) as T));
export const unique = <T>(x: T[]): T[] => Array.from(new Set(x));
export const inArray = (needle: unknown, haystack: unknown[]): boolean => haystack.includes(needle);
export const flatten = (x: any[], out: any[] = []): any[] => {
    for (const v of x) {
        if (isArray(v)) flatten(v, out);
        else out.push(v);
    }
    return out;
};

/** 사전이면 값 배열, 배열이면 그대로, 없으면 빈 배열. */
export const toArray = (object: Dictionary<any> | any[] | undefined | null): any[] => {
    if (object === undefined || object === null) return [];
    return Object.values(object);
};

export const isEmpty = (object: unknown): boolean => {
    if (object === undefined || object === null) return true;
    if (isArray(object)) return object.length < 1;
    if (isDict(object)) return Object.keys(object).length < 1;
    return false;
};

/** 숫자만 골라 더한다. 숫자가 하나도 없으면 `undefined`. */
export const sum = (...xs: unknown[]): number | undefined => {
    const numbers = xs.filter(isNumber);
    return numbers.length > 0 ? numbers.reduce((a, b) => a + b, 0) : undefined;
};

/** 키를 정렬한 새 사전. */
export const keysort = (x: Dictionary<any> | undefined, out: Dictionary<any> = {}): Dictionary<any> => {
    if (x === undefined) return out;
    for (const k of Object.keys(x).sort()) out[k] = x[k];
    return out;
};

/** 지정한 키를 뺀 사본. `omit(x, 'a', 'b')` 와 `omit(x, ['a', 'b'])` 를 모두 받는다. 배열이 들어오면 그대로 돌려준다. */
export const omit = <T extends Dictionary<any> | undefined>(x: T, ...args: Array<string | number | Array<string | number>>): T => {
    if (x === undefined || isArray(x)) return x;
    const out = clone(x) as Dictionary<any>;
    for (const k of args) {
        if (isArray(k)) {
            for (const kk of k) delete out[kk];
        } else {
            delete out[k];
        }
    }
    return out as T;
};

/** 배열(또는 사전의 값)을 `k` 필드 값으로 묶어 `{ 값: [항목...] }` 을 만든다. */
export const groupBy = (x: Dictionary<any> | any[] | undefined, k: string, out: Dictionary<any[]> = {}): Dictionary<any[]> => {
    if (x === undefined) return out;
    for (const v of values(x)) {
        if (k in v) {
            const p = v[k];
            out[p] = out[p] || [];
            out[p].push(v);
        }
    }
    return out;
};

/** 배열(또는 사전의 값)을 `k` 필드 값으로 색인한다. 같은 값이 여럿이면 뒤의 것이 이긴다. */
export const indexBy = (x: Dictionary<any> | any[] | undefined, k: IndexType, out: Dictionary<any> = {}): Dictionary<any> => {
    if (x === undefined) return out;
    for (const v of values(x)) {
        if (k in v) out[v[k]] = v;
    }
    return out;
};

export const filterBy = (x: Dictionary<any> | any[] | undefined, k: string, value: unknown = undefined, out: any[] = []): any[] => {
    if (x === undefined) return out;
    for (const v of values(x)) {
        if (v[k] === value) out.push(v);
    }
    return out;
};

/** `key` 로 정렬한 사본(원본은 그대로). 키가 없는 항목은 `defaultValue` 로 비교한다. */
export const sortBy = (array: any[], key: IndexType, descending = false, defaultValue: any = 0): any[] => {
    const direction = descending ? -1 : 1;
    return array.slice().sort((a: Dictionary<any>, b: Dictionary<any>) => {
        const first = key in a ? a[key] : defaultValue;
        const second = key in b ? b[key] : defaultValue;
        if (first < second) return -direction;
        if (first > second) return direction;
        return 0;
    });
};

export const sortBy2 = (array: any[], key1: IndexType, key2: IndexType, descending = false): any[] => {
    const direction = descending ? -1 : 1;
    return array.slice().sort((a: Dictionary<any>, b: Dictionary<any>) => {
        if (a[key1] < b[key1]) return -direction;
        if (a[key1] > b[key1]) return direction;
        if (a[key2] < b[key2]) return -direction;
        if (a[key2] > b[key2]) return direction;
        return 0;
    });
};

/**
 * 일반 객체는 깊게 합치고, 그 밖의 값(배열·함수·원시값)은 뒤의 것으로 덮어쓴다. 입력은 바꾸지 않고, 결과는 입력의 하위 일반 객체를 공유하지 않는다.
 * `describe()` 의 기본값 위에 증권사별 값과 사용자 설정을 얹을 때 쓴다.
 */
export const deepExtend = (...args: any[]): any => {
    let result: any = null;
    let resultIsObject = false;
    for (const arg of args) {
        if (arg !== null && typeof arg === 'object' && arg.constructor === Object) {
            if (result === null || !resultIsObject) {
                result = {};
                resultIsObject = true;
            }
            for (const key in arg) {
                if (key === '__proto__') continue; // 프로토타입을 덮어쓰는 키는 받지 않는다
                const value = arg[key];
                const current = result[key];
                const valueIsPlain = value !== null && typeof value === 'object' && value.constructor === Object;
                const currentIsPlain = current !== null && typeof current === 'object' && current.constructor === Object;
                // 일반 객체는 합치거나 복사한다. 결과가 입력의 하위 객체를 공유하지 않아서 결과를 고쳐도 입력이 안 바뀐다.
                result[key] = valueIsPlain ? (currentIsPlain ? deepExtend(current, value) : deepExtend(value)) : value;
            }
        } else {
            result = arg;
            resultIsObject = false;
        }
    }
    return result;
};

// ============ 경로·쿼리 ============

/** `'candles/{unit}/{code}'` 처럼 `{}` 로 감싼 이름들. */
export function extractParams(path: string): string[] {
    const re = /{([\w-]+)}/g;
    const matches: string[] = [];
    let match = re.exec(path);
    while (match) {
        const name = match[1];
        if (name !== undefined) matches.push(name);
        match = re.exec(path);
    }
    return matches;
}

/** 경로의 `{이름}` 자리를 `params` 값으로 채운다. 배열 값과 없는 이름은 그대로 둔다. */
export function implodeParams(path: string | undefined, params: Dictionary<any> | any[]): string {
    if (path === undefined) return '';
    if (!isArray(params)) {
        for (const key of Object.keys(params)) {
            // 함수로 치환해야 값에 든 `$&` 같은 문자가 치환 패턴으로 해석되지 않는다.
            if (!isArray(params[key])) path = path.replace('{' + key + '}', () => String(params[key]));
        }
    }
    return path;
}

/**
 * 쿼리 문자열(`a=1&b=x%20y`)로 만든다. 값이 `undefined`·`null` 인 키는 뺀다. 배열은 쉼표로 이어 한 값으로 보낸다.
 * 키 순서는 입력 순서를 따른다(서명 대상 문자열이 순서에 민감하면 호출하는 쪽에서 `keysort` 한다).
 */
export function urlencode(params: Dictionary<any>): string {
    const parts: string[] = [];
    for (const key of Object.keys(params)) {
        const value = params[key];
        if (value === undefined || value === null) continue;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    }
    return parts.join('&');
}
