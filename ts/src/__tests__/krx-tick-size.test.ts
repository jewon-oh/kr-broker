/**
 * @fileoverview KRX 주식 호가 단위 표(`krx-tick-size`)와, 세 증권사의 `priceToPrecision` 이 이 표로 국내 가격을 반올림하는지 본다.
 *
 * 주문 경로가 가격을 바꾸지 않고 요청 전에 막는지는 요청 픽스처(한국투자증권, 토스증권)와 `kbsec-orders.test.ts`(KB증권)가 본다.
 */
import { describe, expect, it } from 'vitest';

import { EMPTY_KIS_MASTER_DATA, type KisMasterData } from '../kis/kis-master-data';
import { kbsec } from '../kbsec';
import { kis } from '../kis';
import { getKrxTickSize, krxTickViolation } from '../krx-tick-size';
import { toss } from '../toss';

const MASTER: KisMasterData = {
    ...EMPTY_KIS_MASTER_DATA,
    kospi: [
        { code: '005930', name: '삼성전자', market: 'KOSPI', securityType: 'STOCK' },
        { code: '069500', name: 'KODEX 200', market: 'KOSPI', securityType: 'ETF' },
    ],
    nasdaq: [{ code: 'AAPL', name: 'APPLE INC', nameKr: '애플', market: 'NAS', currency: 'USD' }],
};

describe('getKrxTickSize', () => {
    it('구간의 아래 끝은 그 구간의 단위이고 위 끝은 다음 구간의 단위다', () => {
        const prices = [1999, 2000, 4999, 5000, 19999, 20000, 49999, 50000, 199999, 200000, 499999, 500000];
        expect(prices.map(getKrxTickSize)).toEqual([1, 5, 5, 10, 10, 50, 50, 100, 100, 500, 500, 1000]);
    });
});

describe('krxTickViolation', () => {
    it('단위의 배수인 양의 정수만 통과한다', () => {
        expect(krxTickViolation(70_000)).toBeNull();
        expect(krxTickViolation(1_999)).toBeNull();
        expect(krxTickViolation(70_030)).toContain('100원');
        expect(krxTickViolation(4_997)).toContain('5원');
        expect(krxTickViolation(70_000.5)).not.toBeNull();
        expect(krxTickViolation(0)).not.toBeNull();
    });
});

describe('priceToPrecision 은 세 증권사 모두 국내 주식 가격을 표로 반올림한다', () => {
    const brokers = {
        kis: new kis({ apiKey: 'k', secret: 's', uid: '12345678-01', options: { masterData: MASTER } }),
        toss: new toss({ apiKey: 'k', secret: 's' }),
        kbsec: new kbsec({ apiKey: 'k', secret: 's', options: { masterData: MASTER } }),
    };

    it.each(Object.entries(brokers))('%s: 70030 → 70000, 4997 → 4995', (_name, broker) => {
        expect(broker.priceToPrecision('005930/KRW', 70_030)).toBe('70000');
        expect(broker.priceToPrecision('005930/KRW', 4_997)).toBe('4995');
    });

    it('종목 유형이 주식이 아니라고 알면(ETF) 손대지 않는다', () => {
        expect(brokers.kis.priceToPrecision('069500/KRW', 35_005)).toBe('35005');
        expect(brokers.kbsec.priceToPrecision('069500/KRW', 35_005)).toBe('35005');
        const loaded = new toss({ apiKey: 'k', secret: 's' });
        loaded.setMarkets([loaded.safeMarketStructure({
            id: '069500', symbol: '069500/KRW', base: '069500', quote: 'KRW', baseId: '069500', quoteId: 'KRW', type: 'spot', spot: true,
            active: true, precision: { amount: 1 }, options: { country: 'KR', market: 'KOSPI', securityType: 'ETF' },
        })]);
        expect(loaded.priceToPrecision('069500/KRW', 35_005)).toBe('35005');
    });

    it('미국 종목은 국내 표를 쓰지 않는다', () => {
        expect(brokers.kis.priceToPrecision('AAPL/USD', 229.456)).toBe('229.46');
        expect(brokers.toss.priceToPrecision('AAPL/USD', 229.456)).toBe('229.456');
        expect(brokers.kbsec.priceToPrecision('AAPL/USD', 229.456)).toBe('229.456');
    });
});
