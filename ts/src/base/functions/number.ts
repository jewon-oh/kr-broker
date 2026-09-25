/**
 * @fileoverview 숫자 처리: 문자열 십진 연산(`Precise`)과 정밀도 맞춤(`decimalToPrecision`).
 *
 * 가격과 수량은 부동소수 오차가 주문 거절이나 금액 오차로 이어지므로, 계산은 십진 문자열로 하고 마지막에만 `number` 로 바꾼다.
 * ccxt 의 구조를 따른다.
 */

import type { Num } from '../types';

// 반올림 방식
export const TRUNCATE = 0;
export const ROUND = 1;
export const ROUND_UP = 2;
export const ROUND_DOWN = 3;
// 자릿수를 세는 방식
export const DECIMAL_PLACES = 2;
export const SIGNIFICANT_DIGITS = 3;
/** 자릿수 대신 최소 단위(호가 단위)의 배수로 맞춘다. */
export const TICK_SIZE = 4;
// 뒤쪽 0 채우기
export const NO_PADDING = 5;
export const PAD_WITH_ZERO = 6;

export const precisionConstants = {
    ROUND, TRUNCATE, ROUND_UP, ROUND_DOWN, DECIMAL_PLACES, SIGNIFICANT_DIGITS, TICK_SIZE, NO_PADDING, PAD_WITH_ZERO,
};

const zero = BigInt(0);
const two = BigInt(2);
const ten = BigInt(10);

const pow10 = (exponent: number): bigint => ten ** BigInt(exponent);

// ============ Precise: 십진 문자열 연산 ============

/**
 * 정수 하나와 소수 자릿수로 십진수를 정확히 표현한다. 값은 `integer / 10^decimals` 이다.
 * 정적 메서드(`stringAdd` 등)는 문자열을 받아 문자열을 돌려주고, 입력이 `undefined` 면 `undefined` 를 돌려준다.
 */
export class Precise {
    integer: bigint;
    decimals: number;

    constructor(value: string | bigint, decimals?: number) {
        if (typeof value === 'bigint') {
            this.integer = value;
            this.decimals = decimals ?? 0;
            return;
        }
        let text = value.trim().toLowerCase();
        // 숫자 열을 나누는 방법이 하나뿐인 식이다(`\d+\.?\d*` 는 소수점이 없으면 되추적이 입력 길이의 제곱으로 늘어난다).
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/.test(text)) {
            throw new Error(`십진수가 아니다: ${JSON.stringify(value)}`);
        }
        let exponent = 0;
        const e = text.indexOf('e');
        if (e > -1) {
            exponent = parseInt(text.slice(e + 1), 10);
            text = text.slice(0, e);
        }
        const point = text.indexOf('.');
        const fractionDigits = point > -1 ? text.length - point - 1 : 0;
        this.integer = BigInt(text.replace('.', '') || '0');
        this.decimals = fractionDigits - exponent;
    }

    mul(other: Precise): Precise {
        return new Precise(this.integer * other.integer, this.decimals + other.decimals);
    }

    /** 나눗셈. 결과는 소수 `precision` 자리에서 버린다. */
    div(other: Precise, precision = 18): Precise {
        const distance = precision - this.decimals + other.decimals;
        const numerator = distance >= 0 ? this.integer * pow10(distance) : this.integer / pow10(-distance);
        return new Precise(numerator / other.integer, precision);
    }

    add(other: Precise): Precise {
        if (this.decimals === other.decimals) {
            return new Precise(this.integer + other.integer, this.decimals);
        }
        const [smaller, bigger] = this.decimals > other.decimals ? [other, this] : [this, other];
        const normalised = smaller.integer * pow10(bigger.decimals - smaller.decimals);
        return new Precise(normalised + bigger.integer, bigger.decimals);
    }

    sub(other: Precise): Precise {
        return this.add(new Precise(-other.integer, other.decimals));
    }

    mod(other: Precise): Precise {
        const numerator = this.integer * pow10(Math.max(-this.decimals + other.decimals, 0));
        const rationizerDenominator = Math.max(-other.decimals + this.decimals, 0);
        const denominator = other.integer * pow10(rationizerDenominator);
        return new Precise(numerator % denominator, rationizerDenominator + other.decimals);
    }

    abs(): Precise {
        return new Precise(this.integer < zero ? -this.integer : this.integer, this.decimals);
    }

    neg(): Precise {
        return new Precise(-this.integer, this.decimals);
    }

    gt(other: Precise): boolean { return this.sub(other).integer > zero; }
    ge(other: Precise): boolean { return this.sub(other).integer >= zero; }
    lt(other: Precise): boolean { return other.gt(this); }
    le(other: Precise): boolean { return other.ge(this); }
    min(other: Precise): Precise { return this.lt(other) ? this : other; }
    max(other: Precise): Precise { return this.gt(other) ? this : other; }

    /** 뒤쪽 0 을 걷어 내 같은 값이 같은 표현이 되게 한다. */
    reduce(): this {
        if (this.integer === zero) {
            this.decimals = 0;
            return this;
        }
        while (this.integer % ten === zero) {
            this.integer /= ten;
            this.decimals -= 1;
        }
        return this;
    }

    equals(other: Precise): boolean {
        this.reduce();
        other.reduce();
        return this.decimals === other.decimals && this.integer === other.integer;
    }

    toString(): string {
        this.reduce();
        const sign = this.integer < zero ? '-' : '';
        const digits = (this.integer < zero ? -this.integer : this.integer).toString(10);
        if (this.decimals <= 0) {
            return digits === '0' ? '0' : sign + digits + '0'.repeat(-this.decimals);
        }
        const padded = digits.padStart(this.decimals + 1, '0');
        const point = padded.length - this.decimals;
        return `${sign}${padded.slice(0, point)}.${padded.slice(point)}`;
    }

    static stringMul(a: string | undefined, b: string | undefined): string | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).mul(new Precise(b)).toString();
    }

    /** 나누는 수가 0 이면 `undefined` 를 돌려준다. */
    static stringDiv(a: string | undefined, b: string | undefined, precision = 18): string | undefined {
        if (a === undefined || b === undefined) return undefined;
        const divisor = new Precise(b);
        if (divisor.integer === zero) return undefined;
        return new Precise(a).div(divisor, precision).toString();
    }

    /** 한쪽만 `undefined` 면 다른 쪽을 그대로 돌려준다(더할 값이 없는 것으로 본다). */
    static stringAdd(a: string | undefined, b: string | undefined): string | undefined {
        if (a === undefined && b === undefined) return undefined;
        if (a === undefined) return b;
        if (b === undefined) return a;
        return new Precise(a).add(new Precise(b)).toString();
    }

    static stringSub(a: string | undefined, b: string | undefined): string | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).sub(new Precise(b)).toString();
    }

    static stringAbs(a: string | undefined): string | undefined {
        return a === undefined ? undefined : new Precise(a).abs().toString();
    }

    static stringNeg(a: string | undefined): string | undefined {
        return a === undefined ? undefined : new Precise(a).neg().toString();
    }

    static stringMod(a: string | undefined, b: string | undefined): string | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).mod(new Precise(b)).toString();
    }

    static stringMin(a: string | undefined, b: string | undefined): string | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).min(new Precise(b)).toString();
    }

    static stringMax(a: string | undefined, b: string | undefined): string | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).max(new Precise(b)).toString();
    }

    static stringEquals(a: string | undefined, b: string | undefined): boolean | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).equals(new Precise(b));
    }

    static stringEq(a: string | undefined, b: string | undefined): boolean | undefined {
        return Precise.stringEquals(a, b);
    }

    static stringGt(a: string | undefined, b: string | undefined): boolean | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).gt(new Precise(b));
    }

    static stringGe(a: string | undefined, b: string | undefined): boolean | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).ge(new Precise(b));
    }

    static stringLt(a: string | undefined, b: string | undefined): boolean | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).lt(new Precise(b));
    }

    static stringLe(a: string | undefined, b: string | undefined): boolean | undefined {
        if (a === undefined || b === undefined) return undefined;
        return new Precise(a).le(new Precise(b));
    }
}

// ============ 문자열·숫자 변환 ============

/** 지수 표기(`1e-8`, `1e21`)를 쓰지 않은 십진 문자열로 바꾼다. 숫자가 아닌 값은 `toString()` 결과를 그대로 돌려준다. */
export function numberToString(x: number | string): string;
export function numberToString(x: unknown): string | undefined;
export function numberToString(x: unknown): string | undefined {
    if (x === undefined || x === null) return undefined;
    if (typeof x !== 'number') return String(x);
    const s = x.toString();
    if (s.indexOf('e') < 0) return s;
    if (Math.abs(x) < 1.0) {
        const parts = s.split('e-');
        const digits = parts[0].replace('.', '');
        const e = parseInt(parts[1], 10);
        const negative = s[0] === '-';
        if (e) {
            return (negative ? '-' : '') + '0.' + '0'.repeat(e - 1) + digits.substring(negative ? 1 : 0);
        }
        return s;
    }
    const parts = s.split('e');
    if (parts[1]) {
        let e = parseInt(parts[1], 10);
        const mantissa = parts[0].split('.');
        let fraction = '';
        if (mantissa[1]) {
            e -= mantissa[1].length;
            fraction = mantissa[1];
        }
        return mantissa[0] + fraction + '0'.repeat(e);
    }
    return s;
}

/**
 * 숫자로 읽을 수 있는 값만 `number` 로 바꾸고, 못 읽으면 `d` 를 돌려준다. 빈 문자열과 `null` 은 0 이 아니라 못 읽은 값이다.
 * `'1e-8'` 같은 지수 표기도 읽는다.
 */
export function parseNumber(value: unknown, d?: number): Num {
    if (value === undefined || value === null) return d;
    if (typeof value === 'number') return Number.isNaN(value) ? d : value;
    if (typeof value !== 'string' || value.trim() === '') return d;
    const n = Number(value);
    return Number.isNaN(n) ? d : n;
}

/** 값이 0 이거나 비어 있으면 `undefined`. 0 을 "값 없음"으로 다루는 필드(시가·호가 등)에 쓴다. */
export function omitZero(value: string | undefined): string | undefined {
    if (value === undefined || value === '') return undefined;
    if (parseFloat(value) === 0) return undefined;
    return value;
}

/** `'0.0001'` → 4, `'1e-4'` → 4, `'100'` → 0. 소수 자릿수를 센다. */
export function precisionFromString(str: string | undefined): number {
    if (str === undefined) return 0;
    if (str.indexOf('e') > -1 || str.indexOf('E') > -1) {
        return parseInt(str.replace(/^[-+]?\d\.?\d*[eE]/, ''), 10) * -1;
    }
    let dot = -1;
    let secondDot = -1;
    let lastNonZero = -1;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c !== 48) { // '0'
            lastNonZero = i;
            if (c === 46) { // '.'
                if (dot < 0) dot = i;
                else if (secondDot < 0) secondDot = i;
            }
        }
    }
    if (dot < 0) return 0;
    return (secondDot < 0 ? lastNonZero + 1 : secondDot) - dot - 1;
}

// ============ decimalToPrecision ============

const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
};

const padDecimals = (value: string, places: number): string => {
    const point = value.indexOf('.');
    const whole = point < 0 ? value : value.slice(0, point);
    if (places <= 0) return whole;
    const fraction = point < 0 ? '' : value.slice(point + 1);
    return whole + '.' + (fraction + '0'.repeat(places)).slice(0, places);
};

/** 값을 `tick` 의 정수배로 맞춘 십진 문자열. 나눗셈을 정수로 하므로 부동소수 오차가 없다. */
function quantizeToTick(x: string, tick: string, roundingMode: number): string {
    const value = new Precise(x);
    const step = new Precise(tick);
    let numerator = value.integer;
    let denominator = step.integer;
    if (step.decimals >= 0) numerator *= pow10(step.decimals); else denominator *= pow10(-step.decimals);
    if (value.decimals >= 0) denominator *= pow10(value.decimals); else numerator *= pow10(-value.decimals);
    let ticks: bigint;
    if (roundingMode === TRUNCATE) {
        ticks = numerator / denominator; // BigInt 나눗셈은 0 쪽으로 버린다
    } else {
        const negative = numerator < zero;
        const abs = negative ? -numerator : numerator;
        const rounded = (two * abs + denominator) / (two * denominator); // 절반은 0 에서 먼 쪽으로 올린다
        ticks = negative ? -rounded : rounded;
    }
    return new Precise(ticks * step.integer, step.decimals).toString();
}

/**
 * 값을 지정한 정밀도로 맞춰 문자열로 돌려준다.
 *
 * - `TICK_SIZE`: `numPrecisionDigits` 가 최소 단위(호가 단위)이고, 결과는 그 단위의 정수배다. 정수 연산이라 오차가 없다.
 * - `DECIMAL_PLACES`: `numPrecisionDigits` 는 소수점 아래 자릿수다.
 * - `SIGNIFICANT_DIGITS`: `numPrecisionDigits` 는 유효숫자 개수다.
 *
 * `roundingMode` 는 `TRUNCATE`(0 쪽으로 버림) 또는 `ROUND`(절반은 0 에서 먼 쪽으로 올림)이다.
 * `PAD_WITH_ZERO` 면 정밀도만큼 뒤에 0 을 채운다.
 */
export function decimalToPrecision(
    x: string | number,
    roundingMode: number,
    numPrecisionDigits: number | string | undefined,
    countingMode: number = DECIMAL_PLACES,
    paddingMode: number = NO_PADDING,
): string {
    assert(numPrecisionDigits !== undefined, 'numPrecisionDigits should not be undefined');
    const precision = typeof numPrecisionDigits === 'string' ? parseFloat(numPrecisionDigits) : (numPrecisionDigits as number);
    assert(Number.isFinite(precision), 'numPrecisionDigits has an invalid number');
    if (countingMode === TICK_SIZE) {
        assert(precision > 0, 'negative or zero numPrecisionDigits can not be used with TICK_SIZE precisionMode');
    } else {
        assert(Number.isInteger(precision), 'numPrecisionDigits must be an integer with DECIMAL_PLACES or SIGNIFICANT_DIGITS precisionMode');
    }
    assert(roundingMode === ROUND || roundingMode === TRUNCATE, 'invalid roundingMode provided');
    assert(countingMode === DECIMAL_PLACES || countingMode === SIGNIFICANT_DIGITS || countingMode === TICK_SIZE, 'invalid countingMode provided');
    assert(paddingMode === NO_PADDING || paddingMode === PAD_WITH_ZERO, 'invalid paddingMode provided');

    if (countingMode === TICK_SIZE) {
        const tick = numberToString(precision);
        let result = quantizeToTick(numberToString(x), tick, roundingMode);
        if (paddingMode === PAD_WITH_ZERO) result = padDecimals(result, precisionFromString(tick));
        return result;
    }

    if (precision < 0) {
        // 자릿수가 음수면 10, 100 … 단위로 맞춘다.
        const toNearest = Math.pow(10, -precision);
        const value = Number(x);
        if (roundingMode === ROUND) {
            return (toNearest * parseFloat(decimalToPrecision(value / toNearest, roundingMode, 0, countingMode, paddingMode))).toString();
        }
        return (value - (value % toNearest)).toString();
    }

    // 문자열로 바꿔 부호를 뗀다.
    const str = numberToString(x);
    const isNegative = str[0] === '-';
    const strStart = isNegative ? 1 : 0;
    const strEnd = str.length;
    let strDot = 0;
    for (; strDot < strEnd; strDot++) {
        if (str[strDot] === '.') break;
    }
    const hasDot = strDot < str.length;

    const DOT = 46;
    const ZERO = 48;
    const ONE = ZERO + 1;
    const FIVE = ZERO + 5;
    const NINE = ZERO + 9;

    // -123.4567 이면 `chars` 는 01234567 이다. 맨 앞 0 은 099 → 100 같은 올림을 위해 비워 둔다.
    const chars = new Uint8Array(strEnd - strStart + (hasDot ? 0 : 1));
    chars[0] = ZERO;

    let afterDot = chars.length;
    let digitsStart = -1;
    let digitsEnd = -1;
    for (let i = 1, j = strStart; j < strEnd; j++, i++) {
        const c = str.charCodeAt(j);
        if (c === DOT) {
            afterDot = i--;
        } else if (c < ZERO || c > NINE) {
            throw new Error(`${str}: invalid number (contains an illegal character '${str[j]}')`);
        } else {
            chars[i] = c;
            if (c !== ZERO && digitsStart < 0) digitsStart = i;
        }
    }
    if (digitsStart < 0) digitsStart = 1;

    let precisionStart = countingMode === DECIMAL_PLACES ? afterDot : digitsStart;
    let precisionEnd = precisionStart + precision;

    // 뒤에서부터 자리마다 버림·반올림을 하며 올림을 앞 자리로 넘긴다(999 → 1000).
    digitsEnd = -1;
    let allZeros = true;
    let signNeeded = isNegative;
    for (let i = chars.length - 1, memo = 0; i >= 0; i--) {
        let c = chars[i];
        if (i !== 0) {
            c += memo;
            if (i >= precisionStart + precision) {
                const ceil = roundingMode === ROUND && c >= FIVE && !(c === FIVE && memo); // 1.45 를 2 로 올리지 않는다
                c = ceil ? NINE + 1 : ZERO;
            }
            if (c > NINE) {
                c = ZERO;
                memo = 1;
            } else {
                memo = 0;
            }
        } else if (memo) {
            c = ONE;
        }
        chars[i] = c;
        if (c !== ZERO) {
            allZeros = false;
            digitsStart = i;
            digitsEnd = digitsEnd < 0 ? i + 1 : digitsEnd;
        }
    }

    if (countingMode === SIGNIFICANT_DIGITS) {
        precisionStart = digitsStart;
        precisionEnd = precisionStart + precision;
    }
    if (allZeros) signNeeded = false;

    const readStart = digitsStart >= afterDot || allZeros ? afterDot - 1 : digitsStart;
    const readEnd = digitsEnd < afterDot ? afterDot : digitsEnd;

    const nSign = signNeeded ? 1 : 0;
    const nBeforeDot = nSign + (afterDot - readStart);
    const nAfterDot = Math.max(readEnd - afterDot, 0);
    const actualLength = readEnd - readStart;
    const desiredLength = paddingMode === NO_PADDING ? actualLength : precisionEnd - readStart;
    const pad = Math.max(desiredLength - actualLength, 0);
    const padStart = nBeforeDot + 1 + nAfterDot;
    const padEnd = padStart + pad;
    const isInteger = nAfterDot + pad === 0;

    let out = signNeeded ? '-' : '';
    let i = nSign;
    let j = readStart;
    for (; i < nBeforeDot; i++, j++) out += String.fromCharCode(chars[j]);
    if (!isInteger) out += '.';
    for (i = nBeforeDot + 1, j = afterDot; i < padStart; i++, j++) out += String.fromCharCode(chars[j]);
    for (i = padStart; i < padEnd; i++) out += '0';
    return out;
}
