/**
 * @fileoverview 해외 정산 매칭·안분 (`SPQM2205` 정산 행 ↔ 우리 체결).
 *
 * 회귀 방지 대상:
 * (a) 그룹에 거래가 하나면 비용을 통째로 받는다. 요율 = 비용 ÷ 명목
 * (b) 여럿이면 **명목 비중으로 안분**한다 — 나눠 준 합이 그룹 비용과 같아야 한다
 * (c) 수량을 모르는 거래가 섞이면 `unallocatable` — 추측해서 나누지 않는다
 * (d) 정산 행이 없으면 `no-settlement`(추정치 유지). 조회 실패와 다른 갈래다
 * (e) 우리 명목 합이 KB 약정 합과 어긋나면 아무것도 안 덮는다
 * (f) 일자 축 — 우리 일자와 KB `ordr_dt` 가 어긋나면 매칭이 조용히 0건이 된다.
 * 그래서 안 붙은 KB 묶음을 따로 세어 돌려준다
 * (g) 결제단가는 조인 키가 아니다 — 우리 체결 2건이 TR 1행(가중평균)으로 뭉쳐도 붙는다
 *
 * 기대값은 요구사항에서 유도한다. 비용 총액·안분 합처럼 **정의로 결정되는 값**만 단언하고,
 * 구현이 낸 숫자를 옮겨 적지 않는다.
 */
import { describe, it, expect } from 'vitest';
import {
    matchKbsecOverseasSettlements, type KbsecOverseasSettlementTrade,
} from '../kbsec-overseas-settlement-match';
import type { KbsecOverseasSettlementRow } from '../kbsec-overseas-settlement-row';

const DATE_US = '20260213';
/** JNJ 매도 묶음 예시 — 4주 · 가중평균 500.8675 · 수수료 5.06 · SEC fee 0.05. */
const QTY = 4;
const PRICE = 500.8675;
const NOTIONAL = QTY * PRICE;
const FEE = 5.06;
const TAX = 0.05;
const COST = FEE + TAX;

function row(over: Partial<KbsecOverseasSettlementRow> = {}): KbsecOverseasSettlementRow {
    return {
        symbol: 'JNJ', side: 'sell', orderDateUs: DATE_US, settlementDateUs: '20260218',
        quantity: QTY, priceUsd: PRICE, notionalUsd: NOTIONAL,
        feeUsd: FEE, taxUsd: TAX, settledUsd: NOTIONAL - FEE, currency: 'USD',
        ...over,
    };
}

function trade(over: Partial<KbsecOverseasSettlementTrade> = {}): KbsecOverseasSettlementTrade {
    return {
        id: 't1', symbol: 'JNJ', side: 'SELL', orderDateUs: DATE_US,
        priceUsd: PRICE, quantity: QTY,
        ...over,
    };
}

describe('(a) 단일 거래', () => {
    it('그룹 비용을 통째로 받고 요율은 비용 ÷ 명목이다', () => {
        const { matches } = matchKbsecOverseasSettlements([trade()], [row()]);

        expect(matches).toHaveLength(1);
        const m = matches[0]!;
        expect(m.kind).toBe('matched');
        if (m.kind !== 'matched') return;
        expect(m.costUsd).toBeCloseTo(COST, 6);
        expect(m.rate).toBeCloseTo(COST / m.notionalUsd, 10);
        expect(m.groupTrades).toBe(1);
    });

    it('수량을 몰라도 단일 거래면 KB 약정금액을 분모로 덮는다', () => {
        const { matches } = matchKbsecOverseasSettlements([trade({ quantity: null })], [row()]);
        const m = matches[0]!;
        expect(m.kind).toBe('matched');
        if (m.kind !== 'matched') return;
        expect(m.notionalUsd).toBeCloseTo(NOTIONAL, 6);
        expect(m.costUsd).toBeCloseTo(COST, 6);
    });
});

describe('(b)(g) 안분 — TR 은 가중평균 한 행으로 준다', () => {
    /** 예: 같은 날 JNJ 매도 2건(501.64 · 500.23, 각 2주)이 TR 1행(4주)으로 뭉친다. */
    const two = [
        trade({ id: 'a', priceUsd: 501.64, quantity: 2 }),
        trade({ id: 'b', priceUsd: 500.23, quantity: 2 }),
    ];
    const merged = row({
        notionalUsd: 501.64 * 2 + 500.23 * 2,
        settledUsd: 501.64 * 2 + 500.23 * 2 - FEE,
    });

    it('단가가 달라도 붙는다 — 단가는 조인 키가 아니다', () => {
        const { matches } = matchKbsecOverseasSettlements(two, [merged]);
        expect(matches.map(m => m.kind)).toEqual(['matched', 'matched']);
    });

    it('나눠 준 비용의 합이 그룹 비용과 같다', () => {
        const { matches } = matchKbsecOverseasSettlements(two, [merged]);
        const sum = matches.reduce((s, m) => s + (m.kind === 'matched' ? m.costUsd : 0), 0);
        expect(sum).toBeCloseTo(COST, 8);
    });

    it('명목이 큰 쪽이 더 많이 가져간다 — 가중치는 명목이다', () => {
        const { matches } = matchKbsecOverseasSettlements(two, [merged]);
        const a = matches[0]!, b = matches[1]!;
        if (a.kind !== 'matched' || b.kind !== 'matched') throw new Error('matched 여야 한다');
        expect(a.costUsd).toBeGreaterThan(b.costUsd);
        // 비용이 명목에 정률이므로 두 거래의 실효율은 같아야 한다.
        expect(a.rate).toBeCloseTo(b.rate, 10);
    });
});

describe('(c) 안분 근거가 없으면 덮지 않는다', () => {
    it('수량 모르는 거래가 섞이면 그룹 전체가 unallocatable 이다', () => {
        const { matches } = matchKbsecOverseasSettlements([
            trade({ id: 'a', quantity: 2 }),
            trade({ id: 'b', quantity: null }),
        ], [row()]);

        expect(matches.map(m => m.kind)).toEqual(['unallocatable', 'unallocatable']);
    });

    it('unallocatable 이 notional-mismatch 로 둔갑하지 않는다 — 진단이 가려진다', () => {
        // 아는 것만 더하면 우리 합이 KB 보다 작아 "명목 불일치" 처럼 보인다. 그 오진을 막는다.
        const { matches } = matchKbsecOverseasSettlements([
            trade({ id: 'a', quantity: 2 }),
            trade({ id: 'b', quantity: null }),
        ], [row()]);
        expect(matches.every(m => m.kind !== 'notional-mismatch')).toBe(true);
    });
});

describe('(d) 정산이 없는 거래', () => {
    it('행이 없으면 no-settlement — 추정치를 유지한다', () => {
        const { matches } = matchKbsecOverseasSettlements([trade()], []);
        expect(matches[0]!.kind).toBe('no-settlement');
    });

    it('비용이 0 인 묶음도 no-settlement 로 본다', () => {
        const { matches } = matchKbsecOverseasSettlements(
            [trade()], [row({ feeUsd: 0, taxUsd: 0, settledUsd: NOTIONAL })]);
        expect(matches[0]!.kind).toBe('no-settlement');
    });

    it('방향이 다르면 안 붙는다', () => {
        const { matches } = matchKbsecOverseasSettlements([trade({ side: 'BUY' })], [row()]);
        expect(matches[0]!.kind).toBe('no-settlement');
    });
});

describe('(e) 명목 대조', () => {
    it('기록에 없는 매매가 섞이면 아무것도 적용하지 않는다', () => {
        // KB 는 6주치 비용을 주는데 우리 쪽 기록엔 4주뿐이다 — 남의 비용을 더하면 안 된다.
        const bigger = row({
            quantity: 6, notionalUsd: 6 * PRICE, settledUsd: 6 * PRICE - FEE,
        });
        const { matches } = matchKbsecOverseasSettlements([trade()], [bigger]);

        const m = matches[0]!;
        expect(m.kind).toBe('notional-mismatch');
        if (m.kind !== 'notional-mismatch') return;
        expect(m.ourUsd).toBeCloseTo(QTY * PRICE, 6);
        expect(m.theirUsd).toBeCloseTo(6 * PRICE, 6);
    });

    it('소수 절사분은 통과시킨다 — 허용 오차 안이다', () => {
        const { matches } = matchKbsecOverseasSettlements(
            [trade({ priceUsd: PRICE + 0.0001 })], [row()]);
        expect(matches[0]!.kind).toBe('matched');
    });
});

describe('(f) 일자 축', () => {
    it('KB 일자와 우리 일자가 어긋나면 안 붙는다', () => {
        // 우리 거래를 KST 일자로 잡으면 미국 주문일자보다 하루 뒤가 된다.
        const { matches } = matchKbsecOverseasSettlements(
            [trade({ orderDateUs: '20260214' })], [row()]);
        expect(matches[0]!.kind).toBe('no-settlement');
    });

    it('안 붙은 KB 묶음을 세어 돌려준다 — 매칭 결과만 보면 "매매 없음" 과 같아 보인다', () => {
        const { matches, unmatched } = matchKbsecOverseasSettlements(
            [trade({ orderDateUs: '20260214' })], [row()]);

        expect(matches[0]!.kind).toBe('no-settlement');
        expect(unmatched).toHaveLength(1);
        expect(unmatched[0]!.key).toContain(DATE_US);
        expect(unmatched[0]!.rows).toBe(1);
        expect(unmatched[0]!.costUsd).toBeCloseTo(COST, 6);
    });

    it('제대로 붙으면 남는 묶음이 없다', () => {
        const { unmatched } = matchKbsecOverseasSettlements([trade()], [row()]);
        expect(unmatched).toEqual([]);
    });

    it('구간 조회라 여러 날이 한 번에 온다 — 날짜별로 갈라 붙인다', () => {
        const day1 = row({ orderDateUs: '20260212' });
        const day2 = row({ orderDateUs: '20260213', feeUsd: FEE * 2, taxUsd: 0,
            settledUsd: NOTIONAL - FEE * 2 });
        const { matches, unmatched } = matchKbsecOverseasSettlements([
            trade({ id: 'a', orderDateUs: '20260212' }),
            trade({ id: 'b', orderDateUs: '20260213' }),
        ], [day1, day2]);

        expect(unmatched).toEqual([]);
        const a = matches[0]!, b = matches[1]!;
        if (a.kind !== 'matched' || b.kind !== 'matched') throw new Error('matched 여야 한다');
        expect(a.costUsd).toBeCloseTo(FEE + TAX, 6);
        expect(b.costUsd).toBeCloseTo(FEE * 2, 6);
    });
});

describe('행 위생', () => {
    it('방향을 못 읽은 행은 버린다 — 어느 쪽에 붙일지 모르는 비용이다', () => {
        const { matches, unmatched } = matchKbsecOverseasSettlements([trade()], [row({ side: null })]);
        expect(matches[0]!.kind).toBe('no-settlement');
        expect(unmatched).toEqual([]);
    });

    it('일자를 못 읽은 행도 버린다', () => {
        const { matches } = matchKbsecOverseasSettlements([trade()], [row({ orderDateUs: '' })]);
        expect(matches[0]!.kind).toBe('no-settlement');
    });

    it('결과는 입력 순서를 지킨다 — 호출하는 쪽이 인덱스로 맞춘다', () => {
        const { matches } = matchKbsecOverseasSettlements([
            trade({ id: 'x', symbol: 'AAPL' }), trade({ id: 'y' }), trade({ id: 'z', symbol: 'V' }),
        ], [row()]);
        expect(matches.map(m => m.tradeId)).toEqual(['x', 'y', 'z']);
    });
});
