/**
 * KB 응답 행의 값 읽기. `pickNum`·`pickPositiveNum`·`pickStr`(kbsec-pick)과 체결·정산 행 파서가 같은 규칙을 쓴다.
 *
 * KB 는 값이 없으면 공백으로 채워 보내기도 한다. 공백만 있는 값은 빈 값으로 보고 다음 후보로 넘어간다.
 */
import { describe, expect, it } from 'vitest';

import { parseKbsecDomesticFillRow } from '../kbsec-fill-row';
import { kbsecNumber, kbsecNumberOf, kbsecString } from '../kbsec-number';
import { pickNum, pickPositiveNum, pickStr } from '../kbsec-pick';

describe('kbsecNumberOf', () => {
    it('쉼표와 앞뒤 공백을 떼고 읽는다', () => {
        expect(kbsecNumberOf('1,234.5')).toBe(1234.5);
        expect(kbsecNumberOf(' 0000000010 ')).toBe(10);
        expect(kbsecNumberOf(7)).toBe(7);
    });

    it('비었거나 공백만 있거나 숫자가 아니면 undefined 다', () => {
        for (const value of [undefined, null, '', '   ', ',', 'abc']) {
            expect(kbsecNumberOf(value)).toBeUndefined();
        }
    });
});

describe('후보 필드 읽기', () => {
    const row = { blank: '   ', zero: '0000000000', qty: '12', name: '  삼성전자  ' };

    it('공백만 있는 값은 건너뛰고 다음 후보를 읽는다 — Number(공백) 의 0 에서 멈추지 않는다', () => {
        expect(pickNum(row, 'blank', 'qty')).toBe(12);
        expect(kbsecNumber(row, 'blank', 'qty')).toBe(12);
    });

    it('값이 있으면 0 이어도 그 후보에서 멈춘다(pickNum). 양수만 고르는 쪽은 넘어간다(pickPositiveNum)', () => {
        expect(pickNum(row, 'zero', 'qty')).toBe(0);
        expect(pickPositiveNum(row, 'blank', 'zero', 'qty')).toBe(12);
    });

    it('하나도 못 읽으면 0 이고, 행이 없어도 0 이다', () => {
        expect(pickNum(row, 'missing', 'blank')).toBe(0);
        expect(pickNum(undefined, 'qty')).toBe(0);
        expect(kbsecNumber(undefined, 'qty')).toBe(0);
    });

    it('문자열은 공백이 아닌 첫 후보를 앞뒤 공백을 떼어 준다', () => {
        expect(pickStr(row, 'blank', 'name')).toBe('삼성전자');
        expect(kbsecString(row, 'missing')).toBe('');
    });
});

describe('체결 행 파서', () => {
    it('총체결수량이 공백이면 체결수량 후보를 읽는다', () => {
        const fill = parseKbsecDomesticFillRow({ tl_ccls_q: '   ', ccls_q: '5', ccls_uprc: '70,000', ordr_no: '0000000101' });
        expect(fill.filledQty).toBe(5);
        expect(fill.price).toBe(70000);
    });
});
