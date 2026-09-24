/**
 * @fileoverview 순수 함수: safe 헬퍼, `Precise`, `decimalToPrecision`, 시각 변환, 사전·경로 도우미.
 */

import { describe, it, expect } from 'vitest';

import {
    DECIMAL_PLACES, NO_PADDING, PAD_WITH_ZERO, Precise, ROUND, SIGNIFICANT_DIGITS, TICK_SIZE, TRUNCATE,
    decimalToPrecision, numberToString, omitZero, parseNumber, precisionFromString,
} from '../functions/number';
import { iso8601, parse8601, parseTimeframe } from '../functions/time';
import {
    clone, deepExtend, extend, extractParams, filterBy, groupBy, implodeParams, indexBy, keysort, omit, sortBy, sortBy2, sum, toArray, unique, urlencode,
} from '../functions/generic';
import {
    safeBool, safeBool2, safeDict, safeFloat, safeFloat2, safeInteger, safeInteger2, safeIntegerN, safeIntegerProduct, safeList, safeNumber, safeNumber2,
    safeNumberN, safeString, safeString2, safeStringLower, safeStringLower2, safeStringN, safeStringUpper, safeTimestamp, safeValue, safeValue2, isDict,
} from '../functions/type';
import { NotSupported } from '../errors';

describe('safe 헬퍼', () => {
    const o = { a: 'x', n: 12.5, s: '42', e: '', z: null, t: true, obj: { k: 1 }, list: [1, 2] };

    it('safeString: 문자열은 그대로, 유한한 숫자는 문자열로, 그 밖에는 기본값', () => {
        expect(safeString(o, 'a')).toBe('x');
        expect(safeString(o, 'n')).toBe('12.5');
        expect(safeString(o, 'e')).toBeUndefined();
        expect(safeString(o, 'z', 'dflt')).toBe('dflt');
        expect(safeString(o, 'missing', 'dflt')).toBe('dflt');
        expect(safeString(o, 'obj')).toBeUndefined();
        expect(safeString({ v: Infinity }, 'v')).toBeUndefined();
        expect(safeString(undefined, 'a', 'd')).toBe('d');
        expect(safeString('str', 'a', 'd')).toBe('d');
    });

    it('safeString2·safeStringN: 값이 있는 첫 키를 쓴다(빈 문자열과 null 은 건너뛴다)', () => {
        expect(safeString2(o, 'e', 'a')).toBe('x');
        expect(safeString2(o, 'z', 'missing', 'd')).toBe('d');
        expect(safeStringN(o, ['e', 'z', 'missing', 'n'])).toBe('12.5');
        expect(safeStringN(undefined, ['a'], 'd')).toBe('d');
    });

    it('대소문자 변환 계열', () => {
        expect(safeStringLower({ v: 'BUY' }, 'v')).toBe('buy');
        expect(safeStringUpper({ v: 'krw' }, 'v')).toBe('KRW');
        expect(safeStringLower2({ side: 'ASK' }, 'ask_bid', 'side')).toBe('ask');
        expect(safeStringLower({ v: 5 }, 'v')).toBe('5');
        expect(safeStringLower({}, 'v', 'd')).toBe('d');
    });

    it('safeInteger: 0 쪽으로 버리고 숫자 문자열도 받는다', () => {
        expect(safeInteger(o, 'n')).toBe(12);
        expect(safeInteger(o, 's')).toBe(42);
        expect(safeInteger({ v: '-3.9' }, 'v')).toBe(-3);
        expect(safeInteger({ v: 'abc' }, 'v', 7)).toBe(7);
        expect(safeInteger(o, 'e', 7)).toBe(7);
        expect(safeInteger2(o, 'missing', 's')).toBe(42);
        expect(safeIntegerN(o, ['missing', 'n'])).toBe(12);
    });

    it('safeFloat 와 safeNumber', () => {
        expect(safeFloat({ v: '1.5abc' }, 'v')).toBe(1.5);
        expect(safeFloat2(o, 'missing', 'n')).toBe(12.5);
        expect(safeNumber({ v: '1e-8' }, 'v')).toBe(1e-8);
        expect(safeNumber({ v: '70000' }, 'v')).toBe(70000);
        expect(safeNumber({ v: 'abc' }, 'v', -1)).toBe(-1);
        expect(safeNumber({ v: '' }, 'v')).toBeUndefined();
        expect(safeNumber2({ b: '2' }, 'a', 'b')).toBe(2);
        expect(safeNumberN({ c: '3' }, ['a', 'b', 'c'])).toBe(3);
    });

    it('safeTimestamp 는 초를 밀리초로, safeIntegerProduct 는 계수를 곱한다', () => {
        expect(safeTimestamp({ t: 1_700_000_000 }, 't')).toBe(1_700_000_000_000);
        expect(safeTimestamp({ t: '1700000000.5' }, 't')).toBe(1_700_000_000_500);
        expect(safeIntegerProduct({ v: '0.5' }, 'v', 100)).toBe(50);
        expect(safeTimestamp({}, 't', 9)).toBe(9);
    });

    it('safeValue 는 값을 그대로, 없거나 빈 값이면 기본값', () => {
        expect(safeValue(o, 'obj')).toBe(o.obj);
        expect(safeValue(o, 'e', 'd')).toBe('d');
        expect(safeValue(o, 'z', 'd')).toBe('d');
        expect(safeValue(o, 'n')).toBe(12.5);
        expect(safeValue2(o, 'missing', 'a')).toBe('x');
        expect(safeValue([10, 20], 1)).toBe(20);
    });

    it('safeBool 은 실제 불리언만 받는다', () => {
        expect(safeBool(o, 't')).toBe(true);
        expect(safeBool({ v: 'true' }, 'v', false)).toBe(false);
        expect(safeBool({ v: 1 }, 'v')).toBeUndefined();
        expect(safeBool({ v: false }, 'v', true)).toBe(false);
        expect(safeBool2({ b: true }, 'a', 'b')).toBe(true);
    });

    it('safeDict·safeList 는 모양이 맞을 때만 받는다', () => {
        expect(safeDict(o, 'obj')).toBe(o.obj);
        expect(safeDict(o, 'list')).toBeUndefined();
        expect(safeDict(o, 'a', {})).toEqual({});
        expect(safeList(o, 'list')).toBe(o.list);
        expect(safeList(o, 'obj')).toBeUndefined();
        expect(safeList(o, 'missing', [])).toEqual([]);
    });

    it('isDict 는 일반 객체만 참이다', () => {
        expect(isDict({})).toBe(true);
        expect(isDict(Object.create(null))).toBe(true);
        expect(isDict([])).toBe(false);
        expect(isDict(new Date())).toBe(false);
        expect(isDict(null)).toBe(false);
        expect(isDict(/x/)).toBe(false);
    });
});

describe('Precise', () => {
    it('부동소수 오차 없이 더하고 뺀다', () => {
        expect(Precise.stringAdd('0.1', '0.2')).toBe('0.3');
        expect(Precise.stringSub('1', '0.9')).toBe('0.1');
        expect(Precise.stringSub('0.3', '0.5')).toBe('-0.2');
        expect(Precise.stringAdd('123456789012345678.5', '0.5')).toBe('123456789012345679');
    });

    it('곱하고 나눈다(나눗셈은 소수 18자리에서 버린다)', () => {
        expect(Precise.stringMul('70000', '3')).toBe('210000');
        expect(Precise.stringMul('0.1', '0.1')).toBe('0.01');
        expect(Precise.stringMul('-2.5', '4')).toBe('-10');
        expect(Precise.stringDiv('1', '3')).toBe('0.333333333333333333');
        expect(Precise.stringDiv('1', '3', 4)).toBe('0.3333');
        expect(Precise.stringDiv('10', '4')).toBe('2.5');
    });

    it('0 으로 나누면 undefined, 입력이 undefined 면 결과도 undefined', () => {
        expect(Precise.stringDiv('1', '0')).toBeUndefined();
        expect(Precise.stringMul(undefined, '1')).toBeUndefined();
        expect(Precise.stringSub('1', undefined)).toBeUndefined();
        expect(Precise.stringGt(undefined, '1')).toBeUndefined();
    });

    it('stringAdd 는 한쪽만 없으면 다른 쪽을 돌려준다', () => {
        expect(Precise.stringAdd(undefined, '5')).toBe('5');
        expect(Precise.stringAdd('5', undefined)).toBe('5');
        expect(Precise.stringAdd(undefined, undefined)).toBeUndefined();
    });

    it('지수 표기와 앞뒤 0 을 정규화한다', () => {
        expect(Precise.stringMul('1e-8', '1')).toBe('0.00000001');
        expect(Precise.stringMul('1e3', '1')).toBe('1000');
        expect(Precise.stringAdd('1.500', '0')).toBe('1.5');
        expect(Precise.stringAdd('.5', '.5')).toBe('1');
        expect(Precise.stringNeg('0')).toBe('0');
        expect(Precise.stringAbs('-0.25')).toBe('0.25');
    });

    it('숫자가 아닌 문자열은 던진다', () => {
        expect(() => Precise.stringAdd('abc', '1')).toThrow();
        expect(() => Precise.stringMul('1.2.3', '1')).toThrow();
    });

    it('비교와 최솟값·최댓값', () => {
        expect(Precise.stringGt('1.01', '1.001')).toBe(true);
        expect(Precise.stringGe('1', '1.0')).toBe(true);
        expect(Precise.stringLt('-1', '0')).toBe(true);
        expect(Precise.stringLe('2', '1')).toBe(false);
        expect(Precise.stringEquals('1.50', '1.5')).toBe(true);
        expect(Precise.stringEq('0', '-0')).toBe(true);
        expect(Precise.stringMin('3', '2.5')).toBe('2.5');
        expect(Precise.stringMax('3', '2.5')).toBe('3');
        expect(Precise.stringMod('10', '3')).toBe('1');
        expect(Precise.stringMod('1.5', '0.4')).toBe('0.3');
    });
});

describe('numberToString·parseNumber·omitZero·precisionFromString', () => {
    it('지수 표기를 풀어 쓴다', () => {
        expect(numberToString(1e-8)).toBe('0.00000001');
        expect(numberToString(-1.5e-7)).toBe('-0.00000015');
        expect(numberToString(1e21)).toBe('1000000000000000000000');
        expect(numberToString(1.5e21)).toBe('1500000000000000000000');
        expect(numberToString(123.45)).toBe('123.45');
        expect(numberToString('abc')).toBe('abc');
        expect(numberToString(undefined)).toBeUndefined();
    });

    it('parseNumber 는 못 읽으면 기본값이고 빈 문자열을 0 으로 읽지 않는다', () => {
        expect(parseNumber('1e-8')).toBe(1e-8);
        expect(parseNumber('12.50')).toBe(12.5);
        expect(parseNumber('')).toBeUndefined();
        expect(parseNumber(null, 3)).toBe(3);
        expect(parseNumber('abc', 3)).toBe(3);
        expect(parseNumber(NaN, 3)).toBe(3);
        expect(parseNumber(0)).toBe(0);
        expect(parseNumber(true)).toBeUndefined();
    });

    it('omitZero 는 0 을 값 없음으로 본다', () => {
        expect(omitZero('0')).toBeUndefined();
        expect(omitZero('0.000')).toBeUndefined();
        expect(omitZero('')).toBeUndefined();
        expect(omitZero('1.5')).toBe('1.5');
    });

    it('precisionFromString', () => {
        expect(precisionFromString('0.0001')).toBe(4);
        expect(precisionFromString('0.10')).toBe(1);
        expect(precisionFromString('1e-4')).toBe(4);
        expect(precisionFromString('100')).toBe(0);
        expect(precisionFromString(undefined)).toBe(0);
    });
});

describe('decimalToPrecision', () => {
    describe('TICK_SIZE(호가 단위)', () => {
        it('TRUNCATE 는 단위의 배수로 버린다', () => {
            expect(decimalToPrecision('70123', TRUNCATE, 100, TICK_SIZE)).toBe('70100');
            expect(decimalToPrecision(70123, TRUNCATE, 5, TICK_SIZE)).toBe('70120');
            expect(decimalToPrecision('0.129', TRUNCATE, 0.01, TICK_SIZE)).toBe('0.12');
            expect(decimalToPrecision('123.456', TRUNCATE, 0.05, TICK_SIZE)).toBe('123.45');
            expect(decimalToPrecision('0.00000019', TRUNCATE, 1e-7, TICK_SIZE)).toBe('0.0000001');
        });

        it('ROUND 는 가장 가까운 배수로, 절반은 0 에서 먼 쪽으로 올린다', () => {
            expect(decimalToPrecision('70150', ROUND, 100, TICK_SIZE)).toBe('70200');
            expect(decimalToPrecision('70149', ROUND, 100, TICK_SIZE)).toBe('70100');
            expect(decimalToPrecision('0.125', ROUND, 0.01, TICK_SIZE)).toBe('0.13');
            expect(decimalToPrecision('123.456', ROUND, 0.01, TICK_SIZE)).toBe('123.46');
            expect(decimalToPrecision('-0.125', ROUND, 0.01, TICK_SIZE)).toBe('-0.13');
            expect(decimalToPrecision('1008', ROUND, 5, TICK_SIZE)).toBe('1010');
        });

        it('십진 문자열로 계산하므로 부동소수 나머지 연산의 오차가 없다', () => {
            expect(decimalToPrecision(0.3, TRUNCATE, 0.1, TICK_SIZE)).toBe('0.3');
            expect(decimalToPrecision(1.15, ROUND, 0.1, TICK_SIZE)).toBe('1.2');
            expect(decimalToPrecision('0.7999999999999999', ROUND, 0.01, TICK_SIZE)).toBe('0.8');
        });

        it('음수는 0 쪽으로 버리고, 0 으로 떨어지면 부호 없는 0', () => {
            expect(decimalToPrecision('-1.239', TRUNCATE, 0.01, TICK_SIZE)).toBe('-1.23');
            expect(decimalToPrecision('-0.001', TRUNCATE, 0.01, TICK_SIZE)).toBe('0');
            expect(decimalToPrecision('0.004', TRUNCATE, 0.01, TICK_SIZE)).toBe('0');
        });

        it('PAD_WITH_ZERO 는 단위의 소수 자릿수만큼 0 을 채운다', () => {
            expect(decimalToPrecision('1', ROUND, 0.001, TICK_SIZE, PAD_WITH_ZERO)).toBe('1.000');
            expect(decimalToPrecision('1.5', TRUNCATE, 0.25, TICK_SIZE, PAD_WITH_ZERO)).toBe('1.50');
            expect(decimalToPrecision('70123', TRUNCATE, 100, TICK_SIZE, PAD_WITH_ZERO)).toBe('70100');
            expect(decimalToPrecision('1.5', TRUNCATE, 0.25, TICK_SIZE, NO_PADDING)).toBe('1.5');
        });

        it('단위가 0 이하이거나 정수배 규칙에 안 맞는 인자는 던진다', () => {
            expect(() => decimalToPrecision('1', TRUNCATE, 0, TICK_SIZE)).toThrow();
            expect(() => decimalToPrecision('1', TRUNCATE, -1, TICK_SIZE)).toThrow();
            expect(() => decimalToPrecision('1', TRUNCATE, undefined, TICK_SIZE)).toThrow();
            expect(() => decimalToPrecision('abc', TRUNCATE, 1, TICK_SIZE)).toThrow();
        });

        it('문자열로 준 단위도 받는다', () => {
            expect(decimalToPrecision('1.239', TRUNCATE, '0.01', TICK_SIZE)).toBe('1.23');
        });
    });

    describe('DECIMAL_PLACES', () => {
        it('소수점 아래 자릿수로 버림·반올림', () => {
            expect(decimalToPrecision('123.456', TRUNCATE, 2, DECIMAL_PLACES)).toBe('123.45');
            expect(decimalToPrecision('123.456', ROUND, 2, DECIMAL_PLACES)).toBe('123.46');
            expect(decimalToPrecision('123.456', ROUND, 0, DECIMAL_PLACES)).toBe('123');
            expect(decimalToPrecision('999.999', ROUND, 2, DECIMAL_PLACES)).toBe('1000');
            expect(decimalToPrecision('-1.005', TRUNCATE, 2, DECIMAL_PLACES)).toBe('-1');
            expect(decimalToPrecision(1e-7, ROUND, 8, DECIMAL_PLACES)).toBe('0.0000001');
        });

        it('PAD_WITH_ZERO 는 자릿수를 채운다', () => {
            expect(decimalToPrecision('1.5', ROUND, 3, DECIMAL_PLACES, PAD_WITH_ZERO)).toBe('1.500');
        });

        it('정수가 아닌 자릿수는 던진다', () => {
            expect(() => decimalToPrecision('1', TRUNCATE, 0.5, DECIMAL_PLACES)).toThrow();
        });

        it('자릿수가 음수면 10·100 단위로 맞춘다', () => {
            expect(decimalToPrecision(1234, ROUND, -2, DECIMAL_PLACES)).toBe('1200');
            expect(decimalToPrecision(1299, TRUNCATE, -2, DECIMAL_PLACES)).toBe('1200');
        });
    });

    describe('SIGNIFICANT_DIGITS', () => {
        it('유효숫자 개수로 맞춘다', () => {
            expect(decimalToPrecision('0.00123456', ROUND, 3, SIGNIFICANT_DIGITS)).toBe('0.00123');
            expect(decimalToPrecision('123456', TRUNCATE, 2, SIGNIFICANT_DIGITS)).toBe('120000');
        });
    });
});

describe('iso8601', () => {
    it('밀리초 시각을 UTC ISO 문자열로', () => {
        expect(iso8601(0)).toBe('1970-01-01T00:00:00.000Z');
        expect(iso8601(1_700_000_000_123)).toBe('2023-11-14T22:13:20.123Z');
        expect(iso8601(1_700_000_000_123.9)).toBe('2023-11-14T22:13:20.123Z');
        expect(iso8601('1700000000123')).toBe('2023-11-14T22:13:20.123Z');
    });

    it('숫자가 아니거나 음수이거나 범위를 넘으면 undefined', () => {
        expect(iso8601(undefined)).toBeUndefined();
        expect(iso8601(null)).toBeUndefined();
        expect(iso8601(NaN)).toBeUndefined();
        expect(iso8601(-1)).toBeUndefined();
        expect(iso8601('abc')).toBeUndefined();
        expect(iso8601('')).toBeUndefined();
        expect(iso8601('12ab')).toBeUndefined();
        expect(iso8601(8.64e15 + 1)).toBeUndefined();
        expect(iso8601(Infinity)).toBeUndefined();
    });
});

describe('parse8601', () => {
    const UTC_MS = Date.UTC(2026, 8, 21, 9, 30, 0);

    it('시간대가 있으면 그 시간대로 읽는다', () => {
        expect(parse8601('2026-09-21T09:30:00Z')).toBe(UTC_MS);
        expect(parse8601('2026-09-21T18:30:00+09:00')).toBe(UTC_MS);
        expect(parse8601('2026-09-21T04:30:00-0500')).toBe(UTC_MS);
        expect(parse8601('2026-09-21T09:30:00.250Z')).toBe(UTC_MS + 250);
    });

    it('시간대가 없는 문자열은 UTC 로 읽는다(한국 시각을 적어 보내는 응답은 9시간 어긋난다)', () => {
        expect(parse8601('2026-09-21T09:30:00')).toBe(UTC_MS);
        expect(parse8601('2026-09-21 09:30:00')).toBe(UTC_MS);
        // 같은 문자열이 KST 였다면 9시간을 뺀 값이 진짜 시각이다.
        const kstWallClock = parse8601('2026-09-21T18:30:00') as number;
        expect(kstWallClock - 9 * 3600 * 1000).toBe(UTC_MS);
    });

    it('날짜로 볼 수 없는 값은 undefined', () => {
        expect(parse8601('20260921')).toBeUndefined();
        expect(parse8601('1700000000000')).toBeUndefined();
        expect(parse8601('2026-09-21')).toBeUndefined(); // 콜론이 없다
        expect(parse8601('09:30:00')).toBeUndefined(); // 대시가 없다
        expect(parse8601('')).toBeUndefined();
        expect(parse8601(undefined)).toBeUndefined();
        expect(parse8601('not-a-date:xx')).toBeUndefined();
        expect(parse8601(20260921)).toBeUndefined();
    });
});

describe('parseTimeframe', () => {
    it('봉 주기를 초로', () => {
        expect(parseTimeframe('1m')).toBe(60);
        expect(parseTimeframe('4h')).toBe(4 * 3600);
        expect(parseTimeframe('1d')).toBe(86400);
        expect(parseTimeframe('1w')).toBe(7 * 86400);
    });

    it('모르는 단위는 NotSupported', () => {
        expect(() => parseTimeframe('1x')).toThrow(NotSupported);
        expect(() => parseTimeframe(undefined)).toThrow(NotSupported);
    });
});

describe('사전·배열 도우미', () => {
    it('extend·clone·omit 은 입력을 바꾸지 않는다', () => {
        const a = { x: 1, y: 2 };
        expect(extend(a, { y: 3 })).toEqual({ x: 1, y: 3 });
        expect(a).toEqual({ x: 1, y: 2 });
        const copy = clone(a);
        copy.x = 9;
        expect(a.x).toBe(1);
        expect(clone([1, 2])).toEqual([1, 2]);
        expect(omit(a, 'x')).toEqual({ y: 2 });
        expect(omit({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ b: 2 });
        expect(omit({ a: 1, b: 2, c: 3 }, 'a', 'b')).toEqual({ c: 3 });
        expect(omit(undefined, 'a')).toBeUndefined();
        expect(a).toEqual({ x: 1, y: 2 });
    });

    it('keysort 는 키 순서로 정렬한 새 사전', () => {
        expect(Object.keys(keysort({ b: 1, a: 2, c: 3 }))).toEqual(['a', 'b', 'c']);
    });

    it('deepExtend 는 일반 객체만 깊게 합치고 나머지는 덮어쓴다', () => {
        const merged = deepExtend({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2], e: 3 }, d: undefined });
        expect(merged).toEqual({ a: { b: 1, c: [2], e: 3 }, d: undefined });
        class Marker {}
        const marker = new Marker();
        expect(deepExtend({ m: { x: 1 } }, { m: marker }).m).toBe(marker);
        const input = { a: { b: 1 } };
        deepExtend(input, { a: { b: 2 } });
        expect(input.a.b).toBe(1);
        expect(deepExtend(undefined, { a: 1 })).toEqual({ a: 1 });
    });

    it('indexBy·groupBy·filterBy·sortBy·unique·toArray·sum', () => {
        const rows = [{ id: 'a', k: 2 }, { id: 'b', k: 1 }, { id: 'c', k: 2 }];
        expect(Object.keys(indexBy(rows, 'id'))).toEqual(['a', 'b', 'c']);
        expect(groupBy(rows, 'k')['2']).toHaveLength(2);
        expect(filterBy(rows, 'k', 2).map((r) => r.id)).toEqual(['a', 'c']);
        expect(sortBy(rows, 'k').map((r) => r.id)).toEqual(['b', 'a', 'c']);
        expect(sortBy(rows, 'k', true).map((r) => r.id)).toEqual(['a', 'c', 'b']);
        expect(sortBy2(rows, 'k', 'id', true).map((r) => r.id)).toEqual(['c', 'a', 'b']);
        expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']); // 원본은 그대로
        expect(unique([1, 1, 2])).toEqual([1, 2]);
        expect(toArray({ a: 1, b: 2 })).toEqual([1, 2]);
        expect(toArray(undefined)).toEqual([]);
        expect(sum(1, 2, undefined, 'x')).toBe(3);
        expect(sum()).toBeUndefined();
    });
});

describe('경로·쿼리', () => {
    it('extractParams 는 {} 안의 이름을 뽑는다', () => {
        expect(extractParams('candles/{unit}/{code}')).toEqual(['unit', 'code']);
        expect(extractParams('market/all')).toEqual([]);
    });

    it('implodeParams 는 경로의 자리를 채우고 없는 이름은 그대로 둔다', () => {
        expect(implodeParams('ticker/{code}', { code: '005930', extra: 1 })).toBe('ticker/005930');
        expect(implodeParams('a/{x}/{y}', { x: 1 })).toBe('a/1/{y}');
        expect(implodeParams('a/{x}', { x: [1, 2] })).toBe('a/{x}');
        expect(implodeParams(undefined, {})).toBe('');
        expect(implodeParams('https://{hostname}/v1', { hostname: 'api.test' })).toBe('https://api.test/v1');
    });

    it('urlencode 는 undefined·null 을 빼고 값을 인코딩한다', () => {
        expect(urlencode({ a: 1, b: 'x y', c: undefined, d: null, e: false })).toBe('a=1&b=x%20y&e=false');
        expect(urlencode({ 'k k': '한글' })).toBe('k%20k=%ED%95%9C%EA%B8%80');
        expect(urlencode({})).toBe('');
    });
});
