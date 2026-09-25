/**
 * @fileoverview 수수료율 단위 해석과 적용 기간 선택, 실효 요율.
 */

import { describe, expect, it } from 'vitest';

import { krxSellTaxRate } from '../../krx-sell-tax';
import { normalizeCommissionRate, pickCommissionRate } from '../toss-fee';
import { getTossEffectiveFeeRate, tossMarketCountry } from '../toss-types';

describe('normalizeCommissionRate', () => {
    it.each([
        ['0.00015', 0.00015],   // 국내 0.015%: 공식 문서의 소수 비율
        ['0.001', 0.001],       // 미국 0.1%: 소수 비율. 백분율로 읽으면 100배 작아진다
        ['0.1', 0.001],         // 미국 0.1%: 백분율로 온 응답
        ['0.015', 0.00015],     // 국내 0.015%: 백분율로 온 응답
        ['0.02', 0.0002],
        ['0.05', 0.0005],
        ['0', 0],
    ])('%s → %d', (raw, expected) => {
        expect(normalizeCommissionRate(raw)).toBeCloseTo(expected, 12);
    });

    it.each(['95', '-1', 'abc', '', ' ', '10'])('있을 수 없는 값(%s)은 null 이다', (raw) => {
        expect(normalizeCommissionRate(raw)).toBeNull();
    });

    it('숫자도 받는다', () => {
        expect(normalizeCommissionRate(0.00015)).toBe(0.00015);
    });

    it('null·undefined 는 무료(0%)가 아니라 모르는 값(null)이다', () => {
        expect(normalizeCommissionRate(null)).toBeNull();
        expect(normalizeCommissionRate(undefined)).toBeNull();
    });
});

describe('pickCommissionRate', () => {
    const rows = [
        { marketCountry: 'KR' as const, commissionRate: '0', startDate: '2026-01-01', endDate: '2026-03-31' },
        { marketCountry: 'KR' as const, commissionRate: '0.00025', startDate: null, endDate: null },
        { marketCountry: 'KR' as const, commissionRate: '0.0001', startDate: '2026-06-01', endDate: '2026-12-31' },
        { marketCountry: 'US' as const, commissionRate: '0.001', startDate: null, endDate: null },
    ];

    it('적용 기간 안의 행 중 시작일이 가장 늦은 것을 쓴다', () => {
        expect(pickCommissionRate(rows, 'KR', '2026-08-03')).toBe(0.0001);
    });

    it('기간이 지난 이벤트는 쓰지 않는다', () => {
        expect(pickCommissionRate(rows, 'KR', '2026-05-01')).toBe(0.00025);
    });

    it('종료일 당일까지 유효하다', () => {
        expect(pickCommissionRate(rows, 'KR', '2026-03-31')).toBe(0);
    });

    it('유효한 행이 없으면 null 이다', () => {
        expect(pickCommissionRate([rows[0]], 'KR', '2026-08-03')).toBeNull();
        expect(pickCommissionRate(rows, 'US', '2026-08-03')).toBe(0.001);
    });

    it('고른 행의 수수료율이 null 이면 0 이 아니라 null 이다(호출하는 쪽이 기본 요율을 쓴다)', () => {
        const unknown = { marketCountry: 'KR' as const, commissionRate: null as unknown as string, startDate: '2026-08-01', endDate: null };
        expect(pickCommissionRate([unknown, rows[1]], 'KR', '2026-08-03')).toBeNull();
    });
});

describe('getTossEffectiveFeeRate', () => {
    const at = new Date('2026-08-03T00:00:00Z');

    it('국내 매도에만 증권거래세를 더한다', () => {
        expect(getTossEffectiveFeeRate('KR', 'buy', at)).toBeCloseTo(0.00015, 10);
        expect(getTossEffectiveFeeRate('KR', 'sell', at)).toBeCloseTo(0.00015 + krxSellTaxRate(at), 10);
        expect(getTossEffectiveFeeRate('US', 'sell', at)).toBeCloseTo(0.001, 10);
    });

    it('ETF·ETN 매도는 증권거래세가 없다', () => {
        expect(getTossEffectiveFeeRate('KR', 'sell', at, undefined, true)).toBeCloseTo(0.00015, 10);
    });

    it('brokerage 를 주면 기본 요율 대신 쓴다', () => {
        expect(getTossEffectiveFeeRate('KR', 'buy', at, 0)).toBe(0);
    });
});

describe('tossMarketCountry', () => {
    it.each([
        ['005930', 'KR'], ['005930/KRW', 'KR'], ['0101N0', 'KR'], ['0193L0', 'KR'], ['0197X0/KRW', 'KR'],
        ['AAPL', 'US'], ['AAPL/USD', 'US'], ['BRK.B', 'US'], ['T', 'US'],
    ])('%s → %s', (symbol, expected) => {
        expect(tossMarketCountry(symbol)).toBe(expected);
    });
});
