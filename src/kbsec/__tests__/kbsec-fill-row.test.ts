/**
 * @fileoverview SSQM2341 체결 행 파서 — 필드명을 테스트로 고정한다.
 *
 * 어댑터가 KB 가 주지 않는 이름(`ccls_q`·`trd_clsf`)을 읽어 체결 확인·결제대기 차감이 전부
 * 0 이던 회귀(실서버에서 발견)의 재발을 막는다. 스펙 이름이 1순위, 종전 이름은 폴백이다.
 */
import { describe, it, expect } from 'vitest';
import {
    parseKbsecDomesticFillRow, parseKbsecOverseasFillRow, kbsecFillSideOf, kbsecResolveFills,
    kbsecFillTotalsInconsistent, kbsecFillTotalsCheckedOrders,
} from '../kbsec-fill-row';

/** KB 공식 스펙(outputSpec) 이름으로 만든 행 — 값은 문자열로 온다. */
const SPEC_ROW = {
    orgn_ordr_no: '0000000000', ccls_ntc_ccd: '1', stnd_is_no: 'KR7005930003',
    ordr_q: '10', tl_ccls_q: '7', nccls_q: '3', trd_dl_ccd_nm: '현금매수',
    ordr_typ_cd: '00', ordr_md_cd: 'OPENAPI', ccls_ntc_tm: '093012', ordr_no: '0000022222',
    hngl_shrt_nm: '삼성전자', ordr_uprc: '70,000', ccls_uprc: '69,800', ordr_tm: '093000',
    ordr_ccd: '00', crct_cncl_ccd: '0', sor_ordr_ccd: 'K',
};

describe('parseKbsecDomesticFillRow — 스펙 필드명', () => {
    it('총체결수량 tl_ccls_q · 미체결 nccls_q · 체결단가 ccls_uprc · 주문번호 ordr_no', () => {
        const f = parseKbsecDomesticFillRow(SPEC_ROW);
        expect(f.orderId).toBe('0000022222');
        expect(f.filledQty).toBe(7);
        expect(f.unfilledQty).toBe(3);
        expect(f.orderQty).toBe(10);
        expect(f.price).toBe(69800);          // 천단위 콤마 제거
        expect(f.cost).toBe(7 * 69800);       // 행에 체결금액이 없으면 수량×단가
        expect(f.side).toBe('buy');
    });

    it('표준종목번호(ISIN) → 6자리, A 접두 단축코드 → 6자리', () => {
        expect(parseKbsecDomesticFillRow(SPEC_ROW).symbol).toBe('005930');
        expect(parseKbsecDomesticFillRow({ ...SPEC_ROW, stnd_is_no: 'A005930' }).symbol).toBe('005930');
        expect(parseKbsecDomesticFillRow({ is_cd: 'A000660' }).symbol).toBe('000660');
    });

    it('ccls_q 가 있어도 tl_ccls_q 가 이긴다 — 스펙 이름이 1순위', () => {
        const f = parseKbsecDomesticFillRow({ ...SPEC_ROW, ccls_q: '99' });
        expect(f.filledQty).toBe(7);
    });

    it('단가 0 이면 금액도 0 — 모르는 값을 지어내지 않는다', () => {
        const f = parseKbsecDomesticFillRow({ ...SPEC_ROW, ccls_uprc: '0' });
        expect(f.price).toBe(0);
        expect(f.cost).toBe(0);
    });

    it('명시 체결금액(ccls_amt)이 있으면 그 값', () => {
        const f = parseKbsecDomesticFillRow({ ...SPEC_ROW, ccls_amt: '488,600' });
        expect(f.cost).toBe(488600);
    });
});

describe('parseKbsecDomesticFillRow — 종전 이름 폴백', () => {
    it('ccls_q / ccls_prc / is_cd / trd_clsf 만 있는 행도 읽힌다', () => {
        const f = parseKbsecDomesticFillRow({
            ordr_no: 'A1', is_cd: '005930', trd_clsf: '1', ccls_prc: '69000', ccls_q: '3',
        });
        expect(f).toMatchObject({ orderId: 'A1', symbol: '005930', side: 'sell', filledQty: 3, price: 69000, cost: 207000 });
    });

    it('trd_clsf 는 1 이 매도, 그 외는 매수(종전 규칙 유지)', () => {
        expect(kbsecFillSideOf({ trd_clsf: '1' })).toBe('sell');
        expect(kbsecFillSideOf({ trd_clsf: '2' })).toBe('buy');
    });
});

describe('kbsecFillSideOf — 매매거래구분명 (값은 실서버 조회로 확정할 예정)', () => {
    it("'매도' 가 들어 있으면 매도, '매수' 가 들어 있으면 매수", () => {
        expect(kbsecFillSideOf({ trd_dl_ccd_nm: '현금매도' })).toBe('sell');
        expect(kbsecFillSideOf({ trd_dl_ccd_nm: '매도' })).toBe('sell');
        expect(kbsecFillSideOf({ trd_dl_ccd_nm: '신용매도' })).toBe('sell');
        expect(kbsecFillSideOf({ trd_dl_ccd_nm: '현금매수' })).toBe('buy');
        expect(kbsecFillSideOf({ trd_dl_ccd_nm: '매수' })).toBe('buy');
    });

    it('trd_dl_ccd_nm 이 있으면 trd_clsf 보다 우선한다', () => {
        expect(kbsecFillSideOf({ trd_dl_ccd_nm: '현금매수', trd_clsf: '1' })).toBe('buy');
    });

    it('두 축 다 없거나 읽을 수 없으면 null — 추측하지 않는다', () => {
        expect(kbsecFillSideOf({})).toBeNull();
        expect(kbsecFillSideOf({ trd_dl_ccd_nm: '' })).toBeNull();
        expect(kbsecFillSideOf({ trd_dl_ccd_nm: '정정' })).toBeNull();
        // ordr_typ_cd(주문유형코드)는 방향 축이 아니다 — 1 이라도 매도로 읽지 않는다.
        expect(kbsecFillSideOf({ ordr_typ_cd: '1' })).toBeNull();
    });
});

describe('parseKbsecOverseasFillRow — SPQM2103 스펙 필드명', () => {
    it('ccls_q_p6 / frgn_ccls_prc_p6 / dl_clsf_nm / is_cd / ccls_ttm', () => {
        const f = parseKbsecOverseasFillRow({
            ordr_no: '0000012345', is_cd: 'AAPL', is_nm: 'APPLE INC', crncy_cd: 'USD',
            dl_clsf_nm: '매수', frgn_ordr_q_p6: '3.000000', frgn_ordr_prc_p6: '230.500000',
            ccls_q_p6: '3.000000', frgn_ccls_prc_p6: '230.120000', ccls_ttm: '22303015',
        });
        expect(f).toMatchObject({
            orderId: '0000012345', symbol: 'AAPL', side: 'buy', filledQty: 3, orderQty: 3,
            price: 230.12, seq: '22303015',
        });
        expect(f.cost).toBeCloseTo(690.36, 6);
    });

    it('국내 이름(ccls_q / ccls_uprc)만 있는 행도 폴백으로 읽힌다', () => {
        const f = parseKbsecOverseasFillRow({ ordr_no: 'X', is_cd: 'XOM', ccls_q: '2', ccls_uprc: '19.5', trd_clsf: '1' });
        expect(f).toMatchObject({ symbol: 'XOM', side: 'sell', filledQty: 2, price: 19.5 });
    });
});

/**
 * 한 행 = **한 체결**이고, 분할체결은 식별자를 지운 연속 행으로 이어진다.
 *
 * 실서버 조회 원문의 형태(종목코드·주문번호·종목명은 공개를 위해 가공한 값, `SSQM2341`):
 *
 * ```
 * {"ordr_no":"0000033333","stnd_is_no":"A051910","trd_dl_ccd_nm":"매도",
 *  "ordr_q":4,"tl_ccls_q":1,"nccls_q":0,"ccls_uprc":152300}
 * {"ordr_no":"0000000000","stnd_is_no":" ","trd_dl_ccd_nm":" ",
 *  "ordr_q":0,"tl_ccls_q":3,"nccls_q":0,"ccls_uprc":152200}
 * ```
 *
 * 응답 헤더가 해석을 확증한다 — `s_ccls_q=4`, `s_ccls_amt=608900 = 1×152,300 + 3×152,200`.
 * 종전 구현은 연속 행을 주문번호 `0000000000` 의 별개 체결로 읽어 **주문번호 매칭에서
 * 탈락**시켰고, 분할체결된 매도가 첫 행의 수량만 확정돼 나머지가 호출하는 쪽 기록에 미종결 상태로 남았다.
 */
describe('kbsecResolveFills — 실서버 응답 원문 형태 2행', () => {
    /** 실서버 조회 원문의 형태 그대로. 공백 폭까지 원문을 지킨다 — 파서가 trim 을 하는지도 같이 검증된다. */
    const HEADER = {
        ordr_no: '0000033333', stnd_is_no: 'A051910', hngl_shrt_nm: 'LG화학',
        trd_dl_ccd_nm: '매도', ordr_q: '000000000000000004', tl_ccls_q: '000000000000000001',
        nccls_q: '000000000000000000', ccls_uprc: '000000000000152300',
        crct_cncl_ccd: '               ', ccls_ntc_tm: '      ', ordr_tm: '      ',
    };
    const CONTINUATION = {
        ordr_no: '0000000000', stnd_is_no: '            ', hngl_shrt_nm: '                    ',
        trd_dl_ccd_nm: '                    ', ordr_q: '000000000000000000',
        tl_ccls_q: '000000000000000003', nccls_q: '000000000000000000',
        ccls_uprc: '000000000000152200',
        crct_cncl_ccd: '               ', ccls_ntc_tm: '      ', ordr_tm: '      ',
    };
    const parsed = () => [HEADER, CONTINUATION].map(parseKbsecDomesticFillRow);

    it('연속 행은 continuation 으로 판별된다 — ordr_no 가 전부 0', () => {
        const [h, c] = parsed();
        expect(h.continuation).toBe(false);
        expect(c.continuation).toBe(true);
        expect(c.orderId).toBe('');   // 자기 식별자는 비운다
        expect(c.symbol).toBe('');
        expect(c.side).toBeNull();
    });

    it('연속 행이 헤더에 귀속돼 총 4주가 된다 — 종전엔 1주였다', () => {
        const fills = kbsecResolveFills(parsed());
        expect(fills.map(f => [f.orderId, f.symbol, f.side, f.qty, f.price])).toEqual([
            ['0000033333', '051910', 'sell', 1, 152300],
            ['0000033333', '051910', 'sell', 3, 152200],
        ]);
        expect(fills.reduce((a, f) => a + f.qty, 0)).toBe(4);
    });

    it('금액이 KB 응답 헤더와 맞는다 — s_ccls_amt=608,900', () => {
        const total = kbsecResolveFills(parsed()).reduce((a, f) => a + f.cost, 0);
        expect(total).toBe(608_900);
    });

    it('수량 검산이 성립한다 — Σ체결(1+3) + 잔여미체결(0) = 주문수량(4)', () => {
        expect(kbsecFillTotalsInconsistent(parsed())).toBe(false);
        expect(kbsecFillTotalsCheckedOrders(parsed())).toBe(1);
    });

    it('연속 행을 놓치면(헤더만) 검산이 깨진다 — 이 사고를 드러내는 신호', () => {
        expect(kbsecFillTotalsInconsistent([parseKbsecDomesticFillRow(HEADER)])).toBe(true);
    });
});

describe('kbsecResolveFills — 체결 건별 합산', () => {
    const row = (over: Record<string, unknown>) => parseKbsecDomesticFillRow({
        ordr_no: 'A1', stnd_is_no: 'A005930', trd_dl_ccd_nm: '현금매수', ordr_q: '10', ...over,
    });

    it('단일 행 — 그 행의 수량·단가가 곧 체결', () => {
        const f = kbsecResolveFills([row({ tl_ccls_q: '10', ccls_uprc: '70000' })]);
        expect(f).toEqual([{ orderId: 'A1', symbol: '005930', side: 'buy', qty: 10, price: 70000, cost: 700000 }]);
    });

    it('행 순서를 그대로 지킨다 — 차분도 정렬도 하지 않는다', () => {
        const f = kbsecResolveFills([
            row({ tl_ccls_q: '4', ccls_uprc: '70000', ccls_ntc_tm: '090001' }),
            row({ ordr_no: '0000000000', tl_ccls_q: '6', ccls_uprc: '69000', ccls_ntc_tm: '090003' }),
        ]);
        expect(f.map(i => [i.qty, i.price])).toEqual([[4, 70000], [6, 69000]]);
        expect(f.reduce((a, i) => a + i.qty, 0)).toBe(10);
    });

    it('주문번호가 다르면 각자 자기 것이다 — 연속 행이 아니면 귀속하지 않는다', () => {
        const f = kbsecResolveFills([
            row({ ordr_no: 'A1', tl_ccls_q: '3', ccls_uprc: '70000' }),
            row({ ordr_no: 'B2', tl_ccls_q: '5', ccls_uprc: '68000' }),
        ]);
        expect(f.map(i => [i.orderId, i.qty])).toEqual([['A1', 3], ['B2', 5]]);
    });

    it('`ordr_no` 가 **빈 문자열**인 행은 귀속 대상이 아니다 — 전부 0 만 "없음" 이다', () => {
        const f = kbsecResolveFills([
            row({ ordr_no: 'A1', tl_ccls_q: '3', ccls_uprc: '70000' }),
            row({ ordr_no: '', tl_ccls_q: '1', ccls_uprc: '1000' }),
        ]);
        // 빈 값은 그냥 모르는 것 — 남의 주문에 붙이지 않는다(종전 동작 유지).
        expect(f.map(i => [i.orderId, i.qty])).toEqual([['A1', 3], ['', 1]]);
    });

    it('헤더 없이 시작하는 연속 행은 식별자를 못 얻는다 — 소비처가 버릴 수 있게', () => {
        // 페이지 경계(`nxt_key`)에서 실제로 생길 수 있는 모양이다.
        const f = kbsecResolveFills([row({ ordr_no: '0000000000', tl_ccls_q: '3', ccls_uprc: '69000' })]);
        expect(f).toEqual([{ orderId: '', symbol: '', side: null, qty: 3, price: 69000, cost: 207000 }]);
    });

    it('수량 0 인 행은 내지 않는다', () => {
        expect(kbsecResolveFills([row({ tl_ccls_q: '0', ccls_uprc: '70000' })])).toEqual([]);
    });

    it('단가 0 이어도 수량은 낸다 — 버릴지는 소비처가 정한다', () => {
        const f = kbsecResolveFills([row({ tl_ccls_q: '2', ccls_uprc: '0' })]);
        expect(f).toEqual([{ orderId: 'A1', symbol: '005930', side: 'buy', qty: 2, price: 0, cost: 0 }]);
    });
});

/**
 * 수량 모델 자가진단 — 주문 단위 `Σ체결 + 잔여미체결 = 주문수량`.
 * 깨지면 연속 행을 놓쳤거나 모델이 또 바뀐 것이고, 둘 다 분할체결 과소확정으로 이어진다.
 */
describe('kbsecFillTotalsInconsistent — 주문 단위 수량 검산', () => {
    const at = (o: Record<string, string>) => parseKbsecDomesticFillRow({ ...SPEC_ROW, ...o });

    it('부분체결 1건 — 7 + 미체결 3 = 10', () => {
        expect(kbsecFillTotalsInconsistent([at({})])).toBe(false);
    });

    it('전량 체결 — 10 + 0 = 10', () => {
        expect(kbsecFillTotalsInconsistent([at({ tl_ccls_q: '10', nccls_q: '0' })])).toBe(false);
    });

    it('분할체결 2건 합산 — 4 + 6 + 미체결 0 = 10 (종전 모델에선 "깨짐" 이었다)', () => {
        const rows = [
            at({ tl_ccls_q: '4', nccls_q: '6' }),
            at({ ordr_no: '0000000000', ordr_q: '0', tl_ccls_q: '6', nccls_q: '0' }),
        ];
        expect(kbsecFillTotalsInconsistent(rows)).toBe(false);
    });

    it('합이 모자라면 깨진다 — 연속 행을 못 받았다는 신호', () => {
        expect(kbsecFillTotalsInconsistent([at({ tl_ccls_q: '4', nccls_q: '0' })])).toBe(true);
    });

    it('정정·취소가 낀 주문은 통째로 뺀다 — 부분취소면 멀쩡해도 깨진다(오탐)', () => {
        const amended = at({ tl_ccls_q: '7', nccls_q: '1', ordr_q: '10', crct_cncl_ccd: '2' });
        expect(amended.amended).toBe(true);
        expect(kbsecFillTotalsInconsistent([amended])).toBe(false);
    });

    it('주문수량·체결수량이 없는 주문은 판정하지 않는다', () => {
        expect(kbsecFillTotalsInconsistent([at({ ordr_q: '0' })])).toBe(false);
        expect(kbsecFillTotalsInconsistent([at({ tl_ccls_q: '0' })])).toBe(false);
    });

    it('판정한 주문 수를 따로 센다 — 0 이면 통과가 아니라 아무것도 못 본 것', () => {
        expect(kbsecFillTotalsCheckedOrders([at({})])).toBe(1);
        expect(kbsecFillTotalsCheckedOrders([at({ crct_cncl_ccd: '2' })])).toBe(0);
    });
});

/**
 * 음성 검증 — **단일체결만 있던 종전 표본은 값이 하나도 안 바뀐다.**
 * 실서버에서 받은 표본(18행, 25행)이 전부 이 모양이었다.
 */
describe('회귀 없음 — 단일체결 표본', () => {
    /** 실측 6행 중 4행의 형태(종목코드와 주문번호는 가공한 값). */
    const SINGLES = [
        { ordr_no: '0000044441', stnd_is_no: 'A000660', trd_dl_ccd_nm: '매도', ordr_q: '1', tl_ccls_q: '1', nccls_q: '0', ccls_uprc: '345500' },
        { ordr_no: '0000044442', stnd_is_no: 'A035420', trd_dl_ccd_nm: '매수', ordr_q: '2', tl_ccls_q: '2', nccls_q: '0', ccls_uprc: '213750' },
        { ordr_no: '0000044443', stnd_is_no: 'A035720', trd_dl_ccd_nm: '매수', ordr_q: '10', tl_ccls_q: '10', nccls_q: '0', ccls_uprc: '50100' },
        { ordr_no: '0000044444', stnd_is_no: 'A051910', trd_dl_ccd_nm: '매수', ordr_q: '4', tl_ccls_q: '4', nccls_q: '0', ccls_uprc: '148900' },
    ];
    const parsed = SINGLES.map(parseKbsecDomesticFillRow);

    it('연속 행으로 오인하지 않는다', () => {
        expect(parsed.every(r => !r.continuation)).toBe(true);
    });

    it('검산 전원 통과 — 판정 주문 4건', () => {
        expect(kbsecFillTotalsInconsistent(parsed)).toBe(false);
        expect(kbsecFillTotalsCheckedOrders(parsed)).toBe(4);
    });

    it('수량·단가·방향이 행 그대로 나온다', () => {
        expect(kbsecResolveFills(parsed).map(f => [f.symbol, f.side, f.qty, f.price])).toEqual([
            ['000660', 'sell', 1, 345500],
            ['035420', 'buy', 2, 213750],
            ['035720', 'buy', 10, 50100],
            ['051910', 'buy', 4, 148900],
        ]);
    });
});
