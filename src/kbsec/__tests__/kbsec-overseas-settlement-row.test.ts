/**
 * @fileoverview 해외 정산 행 파서 (`SPQM2205`) 회귀 테스트.
 *
 * 회귀 방지 대상:
 * (a) KB 원시 행(제로패딩 문자열)을 USD 축 값으로 읽는다
 * (b) 비용은 **수수료 + 세금**이다 — 정산금액이 아니다(이중 차감 방지)
 * (c) 방향은 이름이 정본이고 `etc_trd_ccd` 가 폴백. 둘 다 없으면 null
 * (d) 검산식이 **`|약정 − 정산| ≈ 수수료`** 다. 세금은 정산금액에 안 들어간다 —
 * 국내(`= 수수료 + 세금`) 식을 옮기면 세금 붙은 매도 묶음이 통째로 버려진다
 * (e) 부호가 매수·매도로 갈린다(매수는 더하고 매도는 뺀다)
 * (f) USD 가 아닌 행은 버린다 — 축이 다른 금액을 USD 필드에 넣지 않는다
 * (g) 검산 불가(정산금액 0)와 검산 실패는 다르다
 *
 * 기대값은 **요구사항에서 유도**한다. 입력은 실서버 응답과 같은 모양의 원시 행을 쓰되,
 * 기대값에 구현이 낸 숫자를 그대로 적지 않는다 — 국내 쪽 구현에서 정확히 그 사고가 있었다.
 */
import { describe, it, expect } from 'vitest';
import {
    parseKbsecOverseasSettlementRow, kbsecOverseasSettlementCostUsd,
    kbsecOverseasSettlementSideOf, kbsecResolveOverseasSettlementRows,
    KBSEC_OVERSEAS_SETTLE_TRD_CLSF,
} from '../kbsec-overseas-settlement-row';

/** 실서버 응답과 같은 모양의 매수 행 — KB 는 금액을 제로패딩 문자열로 준다. */
const BUY_RAW = {
    ordr_dt: '20260123', stmt_dt: '20260127', shrt_is_cd: 'KO', shrt_is_nm: '코카콜라',
    trd_clsf_nm: '매수', etc_trd_ccd: '02', crncy_cd: 'USD', frgn_krx_ccd: 'US',
    stmt_q_p6: '00000016.000000', frgn_stmt_prc_p6: '00000063.825625',
    frgn_agr_amt_p4: '0000001021.2100', frgn_trd_fee_p4: '0000000002.5500',
    frgn_dl_tx_p4: '0000000000.0000', ptp_tx_amt: '0.000000',
    frgn_stmt_amt_p4: '0000001023.7600', stmt_amt_p4: '0000001023.7600', stmt_f: ' ',
};

/** 실서버 응답과 같은 모양의 매도 행 — 세금이 붙는데 정산금액에는 안 들어간다. */
const SELL_RAW = {
    ordr_dt: '20260213', stmt_dt: '20260218', shrt_is_cd: 'JNJ', trd_clsf_nm: '매도',
    etc_trd_ccd: '01', crncy_cd: 'USD',
    stmt_q_p6: '00000004.000000', frgn_stmt_prc_p6: '00000500.867500',
    frgn_agr_amt_p4: '0000002003.4700', frgn_trd_fee_p4: '0000000005.0600',
    frgn_dl_tx_p4: '0000000000.0500', ptp_tx_amt: '0.000000',
    frgn_stmt_amt_p4: '0000001998.4100', stmt_amt_p4: '0000001998.4100',
};

const num = (s: string): number => Number(s);

describe('(a) 원시 행 → USD 축', () => {
    it('필드를 뜻대로 읽는다', () => {
        const r = parseKbsecOverseasSettlementRow(BUY_RAW);

        expect(r.symbol).toBe('KO');
        expect(r.side).toBe('buy');
        expect(r.orderDateUs).toBe(BUY_RAW.ordr_dt);
        expect(r.settlementDateUs).toBe(BUY_RAW.stmt_dt);
        expect(r.quantity).toBe(num(BUY_RAW.stmt_q_p6));
        expect(r.priceUsd).toBe(num(BUY_RAW.frgn_stmt_prc_p6));
        expect(r.notionalUsd).toBe(num(BUY_RAW.frgn_agr_amt_p4));
        expect(r.feeUsd).toBe(num(BUY_RAW.frgn_trd_fee_p4));
        expect(r.settledUsd).toBe(num(BUY_RAW.frgn_stmt_amt_p4));
        expect(r.currency).toBe('USD');
    });

    it('약정금액이 없으면 수량 × 단가로 채운다', () => {
        const r = parseKbsecOverseasSettlementRow({ ...BUY_RAW, frgn_agr_amt_p4: '' });
        expect(r.notionalUsd).toBeCloseTo(
            num(BUY_RAW.stmt_q_p6) * num(BUY_RAW.frgn_stmt_prc_p6), 6);
    });

    it('세금은 거래세 + PTP 원천징수 합계다', () => {
        const r = parseKbsecOverseasSettlementRow({
            ...SELL_RAW, frgn_dl_tx_p4: '0000000000.0500', ptp_tx_amt: '0.030000',
        });
        expect(r.taxUsd).toBeCloseTo(0.05 + 0.03, 6);
    });
});

describe('(b) 비용은 수수료 + 세금', () => {
    it('정산금액을 비용으로 쓰지 않는다', () => {
        const r = parseKbsecOverseasSettlementRow(SELL_RAW);
        const cost = kbsecOverseasSettlementCostUsd(r);

        expect(cost).toBeCloseTo(r.feeUsd + r.taxUsd, 6);
        // 정산금액은 비용이 이미 반영된 금액이다. 그걸 비용으로 쓰면 자릿수가 통째로 어긋난다.
        expect(cost).not.toBeCloseTo(r.settledUsd, 2);
    });
});

describe('(c) 매매 방향', () => {
    it('이름이 정본이다', () => {
        expect(kbsecOverseasSettlementSideOf(BUY_RAW)).toBe('buy');
        expect(kbsecOverseasSettlementSideOf(SELL_RAW)).toBe('sell');
    });

    it('이름이 비면 기타매매구분코드로 읽는다 — 두 자리 코드다', () => {
        const noName = { ...SELL_RAW, trd_clsf_nm: '    ' };
        expect(kbsecOverseasSettlementSideOf(noName)).toBe('sell');
        expect(kbsecOverseasSettlementSideOf({
            ...noName, etc_trd_ccd: KBSEC_OVERSEAS_SETTLE_TRD_CLSF.BUY,
        })).toBe('buy');
    });

    it('국내 한 자리 코드는 방향으로 읽지 않는다 — 도메인이 다르다', () => {
        // 국내 `SSQM2121` 은 `1` 매도 · `2` 매수다. 그 값이 해외 행에 실려 오면 뜻이 없다.
        expect(kbsecOverseasSettlementSideOf({
            trd_clsf_nm: ' ', etc_trd_ccd: '1',
        })).toBeNull();
    });

    it('어느 쪽으로도 못 읽으면 null 이다 — 추측하지 않는다', () => {
        expect(kbsecOverseasSettlementSideOf({ trd_clsf_nm: '  ', etc_trd_ccd: '  ' })).toBeNull();
    });
});

describe('(d)(e) 묶음 검산 — 정산금액 항등식', () => {
    const buy = () => parseKbsecOverseasSettlementRow(BUY_RAW);
    const sell = () => parseKbsecOverseasSettlementRow(SELL_RAW);

    it('매수는 정산 = 약정 + 수수료 로 성립한다', () => {
        const r = buy();
        expect(r.settledUsd).toBeCloseTo(r.notionalUsd + r.feeUsd, 4);
        expect(kbsecResolveOverseasSettlementRows([r]).rows).toHaveLength(1);
    });

    it('매도는 정산 = 약정 − 수수료 다. 세금은 **정산금액 밖**이라 살아남아야 한다', () => {
        const r = sell();
        // 요구사항: 세금이 붙어도 항등식은 수수료만으로 성립한다(실측 매도 22행 전수).
        expect(r.taxUsd).toBeGreaterThan(0);
        expect(r.settledUsd).toBeCloseTo(r.notionalUsd - r.feeUsd, 4);
        // 국내식(`|약정 − 정산| = 수수료 + 세금`)을 옮기면 이 행이 버려진다.
        expect(kbsecResolveOverseasSettlementRows([r]).rows).toHaveLength(1);
    });

    it('항등식이 깨진 묶음은 통째로 버린다', () => {
        const broken = { ...sell(), settledUsd: sell().notionalUsd * 0.5 };
        const out = kbsecResolveOverseasSettlementRows([broken]);
        expect(out.rows).toHaveLength(0);
        expect(out.inconsistent).toBe(1);
    });

    it('같은 (일자 × 종목 × 방향) 은 합쳐서 잰다 — 행이 쪼개져도 검산이 성립한다', () => {
        const r = sell();
        // 한 행을 반으로 쪼갠 것과 같은 묶음. 합계로 보면 항등식이 그대로 성립한다.
        const half = (v: number): number => v / 2;
        const a = { ...r, notionalUsd: half(r.notionalUsd), feeUsd: half(r.feeUsd), settledUsd: 0 };
        const b = {
            ...r, notionalUsd: half(r.notionalUsd), feeUsd: half(r.feeUsd),
            settledUsd: r.settledUsd,
        };
        expect(kbsecResolveOverseasSettlementRows([a, b]).rows).toHaveLength(2);
    });

    it('다른 날짜는 다른 묶음이다 — 합산해서 재면 안 된다', () => {
        const r = sell();
        const other = { ...r, orderDateUs: '20260212', settledUsd: r.notionalUsd * 0.5 };
        const out = kbsecResolveOverseasSettlementRows([r, other]);
        // 어긋난 쪽만 버려진다. 한 묶음으로 봤다면 둘 다 버려졌을 것이다.
        expect(out.rows.map(x => x.orderDateUs)).toEqual([r.orderDateUs]);
        expect(out.inconsistent).toBe(1);
    });
});

describe('(f) 통화 축', () => {
    it('USD 가 아닌 행은 버리고 센다 — 원화 축 응답이 USD 필드로 들어가지 않게', () => {
        const krw = parseKbsecOverseasSettlementRow({
            ...BUY_RAW, crncy_cd: 'KRW',
            frgn_agr_amt_p4: '0001441948.0000', frgn_trd_fee_p4: '0000003600.0000',
            frgn_stmt_amt_p4: '0001445548.0000',
        });
        const out = kbsecResolveOverseasSettlementRows([krw]);

        expect(out.rows).toHaveLength(0);
        expect(out.foreignCurrency).toBe(1);
        // 검산은 통과하는 행이다(원화 축에서도 항등식은 성립한다). 통화를 안 보면 그대로 통과한다.
        expect(krw.settledUsd).toBeCloseTo(krw.notionalUsd + krw.feeUsd, 4);
    });

    it('USD 행과 섞이면 USD 만 남는다', () => {
        const usd = parseKbsecOverseasSettlementRow(BUY_RAW);
        const hkd = parseKbsecOverseasSettlementRow({ ...SELL_RAW, crncy_cd: 'HKD' });
        const out = kbsecResolveOverseasSettlementRows([usd, hkd]);

        expect(out.rows.map(r => r.symbol)).toEqual(['KO']);
        expect(out.foreignCurrency).toBe(1);
    });
});

describe('(g) 검산 불가와 검산 실패', () => {
    it('정산금액이 0 이면 잴 근거가 없다 — 통과시킨다', () => {
        const r = { ...parseKbsecOverseasSettlementRow(SELL_RAW), settledUsd: 0 };
        const out = kbsecResolveOverseasSettlementRows([r]);
        expect(out.rows).toHaveLength(1);
        expect(out.inconsistent).toBe(0);
    });
});
