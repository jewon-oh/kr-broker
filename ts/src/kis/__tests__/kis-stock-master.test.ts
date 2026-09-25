/**
 * 국내 종목 마스터 검색.
 */
import { describe, expect, it } from 'vitest';

import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { searchKRXStocks } from '../kis-stock-master';

describe('searchKRXStocks', () => {
    it('★영문자가 든 신형 코드(0193L0)도 대소문자를 가리지 않고 코드로 찾는다', () => {
        for (const query of ['0193L0', '0193l0', '193l']) {
            expect(searchKRXStocks(KIS_MASTER_FIXTURE, query).map((stock) => stock.code), query).toEqual(['0193L0']);
        }
    });

    it('숫자 코드와 한글명 검색은 그대로다', () => {
        expect(searchKRXStocks(KIS_MASTER_FIXTURE, '005930').map((stock) => stock.code)).toEqual(['005930']);
        expect(searchKRXStocks(KIS_MASTER_FIXTURE, '삼성').map((stock) => stock.code)).toEqual(['005930', '0193L0']);
    });
});
