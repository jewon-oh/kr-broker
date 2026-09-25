/**
 * @fileoverview 고유 메서드가 ccxt 규칙을 따르게 하는 기반 도우미: `params.until` 꺼내기, `limit` 자르기, 한국 날짜·시각으로 `timestamp` 만들기.
 */

import { describe, it, expect } from 'vitest';

import { BadRequest } from '../errors';
import { FakeExchange } from './support/fake-exchange';

const ex = () => new FakeExchange({});

describe('handleUntilParam', () => {
    it('params.until 을 꺼내고 나머지 params 에서는 뺀다', () => {
        const [until, rest] = ex().handleUntilParam('fetchX', 10, { until: 1_780_000_000_000, other: 'x' });

        expect(until).toBe(1_780_000_000_000);
        expect(rest).toEqual({ other: 'x' });
    });

    it('until 이 없으면 undefined 이고 params 는 그대로다', () => {
        expect(ex().handleUntilParam('fetchX', undefined, { other: 'x' })).toEqual([undefined, { other: 'x' }]);
    });

    it('limit 자리에 ms 같은 큰 수가 오면 옛 위치 인자 until 로 보고 BadRequest 다', () => {
        expect(() => ex().handleUntilParam('fetchX', 1_780_000_000_000, {})).toThrow(BadRequest);
    });
});

describe('limitRows', () => {
    const rows = [{ timestamp: 3 }, { timestamp: 2 }, { timestamp: 1 }];

    it('since 가 없으면 가장 최근 것부터 limit 개를 남긴다(행 순서는 그대로다)', () => {
        expect(ex().limitRows(rows, undefined, 2)).toEqual([{ timestamp: 3 }, { timestamp: 2 }]);
    });

    it('since 가 있으면 가장 이른 것부터 limit 개를 남긴다', () => {
        expect(ex().limitRows(rows, 1, 2)).toEqual([{ timestamp: 2 }, { timestamp: 1 }]);
    });

    it('limit 이 없으면 그대로이고, 순서를 가를 필드를 고를 수 있다', () => {
        expect(ex().limitRows(rows, undefined, undefined)).toBe(rows);
        expect(ex().limitRows([{ day: '20260922' }, { day: '20260921' }], undefined, 1, 'day')).toEqual([{ day: '20260922' }]);
    });
});

describe('kstStamp, msStamp', () => {
    it('한국 날짜와 시각을 UTC ms 와 ISO 문자열로 바꾼다. 시각이 없으면 그날 0시다', () => {
        expect(ex().kstStamp('20260922', '153000')).toEqual({ timestamp: Date.parse('2026-09-22T06:30:00Z'), datetime: '2026-09-22T06:30:00.000Z' });
        expect(ex().kstStamp('20260922')).toEqual({ timestamp: Date.parse('2026-09-21T15:00:00Z'), datetime: '2026-09-21T15:00:00.000Z' });
    });

    it('앞자리 0 이 빠진 시각은 채워 읽고, 날짜를 못 읽으면 둘 다 비운다', () => {
        expect(ex().kstStamp('20260922', '93000').timestamp).toBe(Date.parse('2026-09-22T00:30:00Z'));
        expect(ex().kstStamp('')).toEqual({ timestamp: undefined, datetime: undefined });
        expect(ex().kstStamp(undefined, '153000')).toEqual({ timestamp: undefined, datetime: undefined });
    });

    it('★달력에 없는 날짜는 다른 날로 넘기지 않고 비운다(Python 판과 같다)', () => {
        for (const ymd of ['00000000', '20261300', '20260230', '20260000']) {
            expect(ex().kstStamp(ymd, '153000'), ymd).toEqual({ timestamp: undefined, datetime: undefined });
        }
    });

    it('범위를 넘는 시각은 다음 시각으로 넘기지 않고 그날 0시로 읽는다', () => {
        const midnight = Date.parse('2026-09-21T15:00:00Z');
        for (const hms of ['9300', '250000', '126000', '120060', 'abcdef']) {
            expect(ex().kstStamp('20260922', hms).timestamp, hms).toBe(midnight);
        }
    });

    it('msStamp 는 이미 있는 ms 로 datetime 을 채운다', () => {
        expect(ex().msStamp(Date.parse('2026-09-22T06:30:00Z'))).toEqual({ timestamp: Date.parse('2026-09-22T06:30:00Z'), datetime: '2026-09-22T06:30:00.000Z' });
        expect(ex().msStamp(undefined)).toEqual({ timestamp: undefined, datetime: undefined });
    });
});
