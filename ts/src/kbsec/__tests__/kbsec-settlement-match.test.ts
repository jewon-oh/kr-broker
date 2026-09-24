/**
 * @fileoverview 정산 행 ↔ `Trade` 매칭·안분.
 *
 * 회귀 방지 대상:
 * (a) 단일 거래 그룹 — 안분 없이 그룹 비용을 통째로 받는다
 * (b) 분할체결 — 우리 단가가 가중평균이라 KB 단가와 하나도 안 맞아도 그룹 합계로 맞는다
 * (단가를 조인 키로 쓰면 여기서 조용히 0건이 된다)
 * (c) 같은 단가 다중 거래 — 명목 비중 안분. 단가가 같으면 근사가 아니라 정확하다
 * (d) 안분 근거(수량)가 없는 다중 그룹은 `unallocatable` — 나눠 짐작하지 않는다
 * (e) 우리 명목 합과 `dl_amt` 합이 어긋나면 `notional-mismatch` — 아무것도 안 덮는다
 * (f) 정산 행이 없으면 `no-settlement` — 추정치 유지
 * (g) 방향·종목을 못 읽은 정산 행은 버린다
 */
import { describe, it, expect } from 'vitest';
import { matchKbsecSettlements, type KbsecSettlementTrade } from '../kbsec-settlement-match';
import type { KbsecSettlementRow } from '../kbsec-settlement-row';

/** 고정 환율. 원화 단가 = `priceUsd × FX`. */
const FX = 1345;

function trade(over: Partial<KbsecSettlementTrade> & { id: string }): KbsecSettlementTrade {
    return {
        symbol: '035420', side: 'SELL', priceUsd: 55100 / FX, usdToKrwRate: FX, quantity: 38,
        ...over,
    };
}

function settlement(over: Partial<KbsecSettlementRow> = {}): KbsecSettlementRow {
    return {
        symbol: '035420', side: 'sell', quantity: 38, priceKrw: 55100,
        notionalKrw: 2093800, feeKrw: 200, taxKrw: 1046 + 3140, settledKrw: 2089414,
        continuation: false,
        ...over,
    };
}

describe('matchKbsecSettlements — 단일 거래 그룹', () => {
    it('그룹 비용을 통째로 받는다 (매도 1건)', () => {
        const [m] = matchKbsecSettlements([trade({ id: 't1' })], [settlement()]);
        expect(m.kind).toBe('matched');
        if (m.kind !== 'matched') return;
        expect(m.costKrw).toBe(200 + 1046 + 3140);
        expect(m.groupTrades).toBe(1);
        // 실효율 = 비용 / 명목. 매도세 0.20% 에 위탁수수료가 더해진 값이다.
        expect(m.rate).toBeCloseTo(4386 / 2093800, 10);
    });

    it('분할체결 — 우리 단가가 KB 단가 어느 것과도 다르지만 맞는다', () => {
        // KB 는 `clsf=1`(단가별)로 단가마다 행을 쪼갠다. 우리 Trade 는 가중평균 하나다.
        const rows = [
            settlement({ quantity: 1, priceKrw: 152300, notionalKrw: 152300, feeKrw: 15, taxKrw: 304, settledKrw: 151981 }),
            settlement({ quantity: 3, priceKrw: 152200, notionalKrw: 456600, feeKrw: 44, taxKrw: 910, settledKrw: 455646 }),
        ];
        const weighted = (152300 + 3 * 152200) / 4;      // = 152,225
        const t = trade({ id: 't1', symbol: '035420', priceUsd: weighted / FX, quantity: 4 });
        const [m] = matchKbsecSettlements([t], rows);

        expect(m.kind).toBe('matched');
        if (m.kind !== 'matched') return;
        expect(m.costKrw).toBe(15 + 304 + 44 + 910);
    });
});

describe('matchKbsecSettlements — 같은 단가 다중 거래', () => {
    /**
     * 같은 종목 매도 3건의 체결 단가가 전부 같은 경우다. KB 는 `clsf=1` 이라 이걸 한 행으로
     * 준다 — 우리 3건에 나눠야 한다. 단가가 같으므로 수량 비중 안분이 **정확**하다.
     */
    const rows = [settlement({
        symbol: '068270', quantity: 21, priceKrw: 111300,
        notionalKrw: 2337300, feeKrw: 210, taxKrw: 4674, settledKrw: 2332416,
    })];

    it('명목 비중으로 나눈다 — 합계는 그룹 비용과 같다', () => {
        const px = 111300 / FX;
        const trades = [
            trade({ id: 'a', symbol: '068270', priceUsd: px, quantity: 7 }),
            trade({ id: 'b', symbol: '068270', priceUsd: px, quantity: 7 }),
            trade({ id: 'c', symbol: '068270', priceUsd: px, quantity: 7 }),
        ];
        const ms = matchKbsecSettlements(trades, rows);
        expect(ms.every(m => m.kind === 'matched')).toBe(true);

        const total = ms.reduce((s, m) => s + (m.kind === 'matched' ? m.costKrw : 0), 0);
        expect(total).toBeCloseTo(210 + 4674, 6);
        for (const m of ms) {
            if (m.kind !== 'matched') continue;
            expect(m.costKrw).toBeCloseTo((210 + 4674) / 3, 6);
            expect(m.groupTrades).toBe(3);
        }
    });

    it('수량이 갈리면 그 비중대로 나눈다', () => {
        const px = 111300 / FX;
        const trades = [
            trade({ id: 'a', symbol: '068270', priceUsd: px, quantity: 14 }),
            trade({ id: 'b', symbol: '068270', priceUsd: px, quantity: 7 }),
        ];
        const ms = matchKbsecSettlements(trades, rows);
        const a = ms[0], b = ms[1];
        expect(a.kind).toBe('matched');
        expect(b.kind).toBe('matched');
        if (a.kind !== 'matched' || b.kind !== 'matched') return;
        expect(a.costKrw / b.costKrw).toBeCloseTo(2, 6);
    });

    it('수량을 모르는 거래가 섞이면 안분하지 않는다 — 나눠 짐작하지 않는다', () => {
        const px = 111300 / FX;
        const trades = [
            trade({ id: 'a', symbol: '068270', priceUsd: px, quantity: null }),
            trade({ id: 'b', symbol: '068270', priceUsd: px, quantity: 7 }),
        ];
        const ms = matchKbsecSettlements(trades, rows);
        expect(ms.map(m => m.kind)).toEqual(['unallocatable', 'unallocatable']);
    });
});

describe('matchKbsecSettlements — 안전장치', () => {
    it('우리 명목 합이 KB 합과 어긋나면 그룹 전체를 안 덮는다', () => {
        // 우리 장부엔 38주뿐인데 KB 는 60주어치를 정산했다 — 장부 밖 매매가 섞였다는 뜻.
        const rows = [settlement({ quantity: 60, notionalKrw: 3306000, feeKrw: 320, taxKrw: 6612 })];
        const [m] = matchKbsecSettlements([trade({ id: 't1', quantity: 38 })], rows);
        expect(m.kind).toBe('notional-mismatch');
        if (m.kind !== 'notional-mismatch') return;
        expect(Math.round(m.ourKrw)).toBe(2093800);
        expect(m.theirKrw).toBe(3306000);
    });

    it('환율 왕복의 부동소수 꼬리는 허용오차 안이다', () => {
        // 원화 단가를 `priceUsd × fx` 로 되짚으므로 정확히 정수로 안 떨어진다.
        const t = trade({ id: 't1', priceUsd: 55100 / FX + 1e-9 });
        const [m] = matchKbsecSettlements([t], [settlement()]);
        expect(m.kind).toBe('matched');
    });

    it('정산 행이 없으면 `no-settlement` — 미정산 구간이라 추정치를 남긴다', () => {
        const [m] = matchKbsecSettlements([trade({ id: 't1' })], []);
        expect(m.kind).toBe('no-settlement');
    });

    it('매수 정산만 온 날의 매도 거래는 `no-settlement` — 방향을 섞지 않는다', () => {
        const rows = [settlement({ side: 'buy' })];
        const [m] = matchKbsecSettlements([trade({ id: 't1', side: 'SELL' })], rows);
        expect(m.kind).toBe('no-settlement');
    });

    it('방향·종목을 못 읽은 정산 행은 버린다 — 어느 쪽에 붙일지 모르는 비용은 안 쓴다', () => {
        const rows = [settlement({ side: null }), settlement({ symbol: '' })];
        const [m] = matchKbsecSettlements([trade({ id: 't1' })], rows);
        expect(m.kind).toBe('no-settlement');
    });

    it('결과는 입력 순서를 유지한다', () => {
        const trades = [
            trade({ id: 'a', symbol: '035420' }),
            trade({ id: 'b', symbol: '000660', quantity: 1, priceUsd: 1 }),
        ];
        const ms = matchKbsecSettlements(trades, [settlement()]);
        expect(ms.map(m => m.tradeId)).toEqual(['a', 'b']);
    });
});
