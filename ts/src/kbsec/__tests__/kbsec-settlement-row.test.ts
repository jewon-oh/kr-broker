/**
 * @fileoverview `SSQM2121` 정산 행 파서 — 필드명·비용 정의 고정.
 *
 * 회귀 방지 대상:
 * (a) 실서버 응답 행이 그대로 파싱된다 — 필드명이 바뀌면 여기서 깨진다
 * (b) 비용은 `fee + 세금` 이지 `ec_amt` 가 아니다 (이중 차감 방지)
 * (c) 방향은 코드(`1`/`2`)로 와도 이름('매도')으로 와도 읽는다. 못 읽으면 null
 * (d) 검산은 매수·매도 양쪽에서 성립한다(부호가 달라도 절대값은 같다)
 */
import { describe, it, expect } from 'vitest';
import {
    parseKbsecDomesticSettlementRow, kbsecSettlementSideOf, kbsecSettlementCostKrw,
    kbsecResolveSettlementRows, KBSEC_SETTLE_TRD_CLSF, KBSEC_SETTLE_CLSF,
} from '../kbsec-settlement-row';

/**
 * 라이브 응답과 같은 모양의 표본 (국내 종목 매도). `dl_amt − fee − dl_tx − ffs_tx = ec_amt` 가
 * 정확히 맞는 행이다. 이 등식이 이 TR 을 쓰기로 한 근거다.
 */
const LIVE_SELL_ROW: Record<string, unknown> = {
    is_no: 'A035420', is_nm: 'NAVER', trd_clsf: '매도', dl_clsf: '현금매도',
    ccls_q: '38', tl_ccls_q: '38', ccls_uprc: '55100',
    dl_amt: '2093800', fee: '200', dl_tx: '1046', ffs_tx: '3140',
    incm_tx: '0', rsdnt_tx: '0', ec_amt: '2089414',
    fncng_amt: '0', rfnd_amt: '0', krx_ccls_amt: '2093800', nxtd_ccls_amt: '0',
};

describe('parseKbsecDomesticSettlementRow — 실서버 응답 행', () => {
    it('표본 행의 모든 축을 읽는다', () => {
        const row = parseKbsecDomesticSettlementRow(LIVE_SELL_ROW);
        expect(row.symbol).toBe('035420');       // `A` 접두 정규화
        expect(row.side).toBe('sell');
        expect(row.quantity).toBe(38);
        expect(row.priceKrw).toBe(55100);
        expect(row.notionalKrw).toBe(2093800);
        expect(row.feeKrw).toBe(200);
        expect(row.taxKrw).toBe(1046 + 3140);
        expect(row.settledKrw).toBe(2089414);
    });

    it('비용은 수수료 + 세금이다 — `ec_amt` 를 비용으로 쓰지 않는다', () => {
        const row = parseKbsecDomesticSettlementRow(LIVE_SELL_ROW);
        expect(kbsecSettlementCostKrw(row)).toBe(200 + 1046 + 3140);
        // 정산금액은 비용이 **이미 빠진** 금액이다. 이걸 비용으로 쓰면 이중 차감이 된다.
        expect(kbsecSettlementCostKrw(row)).not.toBe(row.settledKrw);
        expect(row.notionalKrw - kbsecSettlementCostKrw(row)).toBe(row.settledKrw);
    });

    it('거래금액이 비면 수량 × 단가로 채운다', () => {
        const row = parseKbsecDomesticSettlementRow({ ...LIVE_SELL_ROW, dl_amt: '' });
        expect(row.notionalKrw).toBe(38 * 55100);
    });

    it('쉼표가 섞인 숫자도 읽는다', () => {
        const row = parseKbsecDomesticSettlementRow({ ...LIVE_SELL_ROW, dl_amt: '2,093,800' });
        expect(row.notionalKrw).toBe(2093800);
    });
});

describe('kbsecSettlementSideOf — 코드와 이름을 모두 받는다', () => {
    it('이름으로 온 매도/매수', () => {
        expect(kbsecSettlementSideOf({ trd_clsf: '매도' })).toBe('sell');
        expect(kbsecSettlementSideOf({ trd_clsf: '현금매수' })).toBe('buy');
    });

    it('코드로 온 매도/매수 — 입력 코드와 같은 어휘', () => {
        expect(kbsecSettlementSideOf({ trd_clsf: KBSEC_SETTLE_TRD_CLSF.SELL })).toBe('sell');
        expect(kbsecSettlementSideOf({ trd_clsf: KBSEC_SETTLE_TRD_CLSF.BUY })).toBe('buy');
    });

    it('`trd_clsf` 가 비면 `dl_clsf` 로 폴백한다', () => {
        expect(kbsecSettlementSideOf({ trd_clsf: '  ', dl_clsf: '현금매도' })).toBe('sell');
    });

    it('어느 쪽으로도 못 읽으면 null — 추측하지 않는다', () => {
        expect(kbsecSettlementSideOf({ trd_clsf: '', dl_clsf: '' })).toBeNull();
        expect(kbsecSettlementSideOf({ trd_clsf: '배당' })).toBeNull();
    });
});

/**
 * 단가별 연속 행 — 라이브 응답과 같은 모양의 표본 (국내 종목 매수).
 *
 * 두 번째 단가부터 종목·방향이 공백이고 **비용은 마지막 행에만** 실린다.
 * 행 단위로 검산하면 비용이 담긴 행이 "필드 오독" 으로 버려진다.
 */
const LIVE_CONTINUATION = [
    { is_no: 'A035720', is_nm: '카카오', trd_clsf: '매수', ccls_q: '97', tl_ccls_q: '0',
      ccls_uprc: '19000', dl_amt: '1843000', fee: '0', dl_tx: '0', ffs_tx: '0', ec_amt: '0' },
    { is_no: '   ', is_nm: '   ', trd_clsf: '   ', ccls_q: '14', tl_ccls_q: '111',
      ccls_uprc: '19010', dl_amt: '266140', fee: '200', dl_tx: '0', ffs_tx: '0', ec_amt: '2109340' },
];

describe('kbsecResolveSettlementRows — 단가별 연속 행', () => {
    it('연속 행을 알아본다 — 종목 식별자가 비어 있다', () => {
        const head = parseKbsecDomesticSettlementRow(LIVE_CONTINUATION[0]!);
        const cont = parseKbsecDomesticSettlementRow(LIVE_CONTINUATION[1]!);
        expect(head.continuation).toBe(false);
        expect(head.symbol).toBe('035720');
        expect(cont.continuation).toBe(true);
        expect(cont.symbol).toBe('');
        expect(cont.side).toBeNull();
        // 비용은 연속 행에 담겨 있다. 이 행을 버리면 그 종목은 비용 0 이 된다.
        expect(kbsecSettlementCostKrw(cont)).toBe(200);
        expect(kbsecSettlementCostKrw(head)).toBe(0);
    });

    it('연속 행을 앞 헤더의 종목·방향으로 이어 붙인다', () => {
        const { rows, inconsistent, orphaned } = kbsecResolveSettlementRows(
            LIVE_CONTINUATION.map(parseKbsecDomesticSettlementRow));

        expect(inconsistent).toBe(0);
        expect(orphaned).toBe(0);
        expect(rows).toHaveLength(2);
        expect(rows.every(r => r.symbol === '035720' && r.side === 'buy')).toBe(true);
        // 묶음 합계가 표본과 맞는다.
        expect(rows.reduce((s, r) => s + r.notionalKrw, 0)).toBe(1843000 + 266140);
        expect(rows.reduce((s, r) => s + kbsecSettlementCostKrw(r), 0)).toBe(200);
    });

    it('묶음으로 검산해야 맞는다 — 행 단위로는 멀쩡한 행이 버려진다', () => {
        const head = parseKbsecDomesticSettlementRow(LIVE_CONTINUATION[0]!);
        const cont = parseKbsecDomesticSettlementRow(LIVE_CONTINUATION[1]!);
        // 행 단위 검산이었다면: |266,140 − 2,109,340| = 1,843,200 ≠ 비용 200 → 버려진다.
        expect(Math.abs(cont.notionalKrw - cont.settledKrw)).not.toBeCloseTo(200, 0);
        // 묶음으로 보면 성립한다: |(1,843,000+266,140) − 2,109,340| = 200.
        const notional = head.notionalKrw + cont.notionalKrw;
        expect(Math.abs(notional - cont.settledKrw)).toBe(200);
        expect(kbsecResolveSettlementRows([head, cont]).rows).toHaveLength(2);
    });

    it('주인 없는 연속 행은 버린다 — 남의 종목에 비용을 얹지 않는다', () => {
        const cont = parseKbsecDomesticSettlementRow(LIVE_CONTINUATION[1]!);
        const { rows, orphaned } = kbsecResolveSettlementRows([cont]);
        expect(rows).toHaveLength(0);
        expect(orphaned).toBe(1);
    });

    it('검산이 깨진 묶음은 통째로 버린다 — 일부만 남기면 합계가 모자란다', () => {
        const rows = [
            parseKbsecDomesticSettlementRow(LIVE_SELL_ROW),
            parseKbsecDomesticSettlementRow({ ...LIVE_SELL_ROW, ec_amt: '1000000' }),
        ];
        const out = kbsecResolveSettlementRows(rows);
        expect(out.rows).toHaveLength(0);
        expect(out.inconsistent).toBe(2);
    });

    it('정상 매도 행은 그대로 통과한다', () => {
        const out = kbsecResolveSettlementRows([parseKbsecDomesticSettlementRow(LIVE_SELL_ROW)]);
        expect(out.rows).toHaveLength(1);
        expect(out.inconsistent).toBe(0);
    });

    it('검산할 근거가 없으면(정산금액 0) 통과 — "못 쟀다" 와 "틀렸다" 는 다르다', () => {
        const noBasis = parseKbsecDomesticSettlementRow(
            { is_no: 'A035420', trd_clsf: '매도', fee: '200' });
        expect(kbsecResolveSettlementRows([noBasis]).rows).toHaveLength(1);
    });
});

describe('입력 코드 — 매매구분을 잘못 보내면 한쪽이 통째로 사라진다', () => {
    it('전체는 9 다 — 1 은 매도 전용 필터라 매수가 안 온다', () => {
        expect(KBSEC_SETTLE_TRD_CLSF.ALL).toBe('9');
        expect(KBSEC_SETTLE_TRD_CLSF.SELL).toBe('1');
        expect(KBSEC_SETTLE_TRD_CLSF.BUY).toBe('2');
    });

    it('단가별은 1, 종목별은 2', () => {
        expect(KBSEC_SETTLE_CLSF.BY_PRICE).toBe('1');
        expect(KBSEC_SETTLE_CLSF.BY_SYMBOL).toBe('2');
    });
});
