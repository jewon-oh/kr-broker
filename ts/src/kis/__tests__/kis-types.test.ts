import { describe, it, expect } from 'vitest';
import {
    isOverseasSymbol,
    isKrxDomesticCode,
    KIS_BROKERAGE_FEE,
    krxSellTaxRate,
    getKisEffectiveFeeRate,
} from '../kis-types';

describe('isOverseasSymbol — KRX 코드 (6자리 숫자) vs 해외', () => {
    it('KRX 6자리 숫자 코드는 국내 (false)', () => {
        expect(isOverseasSymbol('005930')).toBe(false);
        expect(isOverseasSymbol('035420')).toBe(false);
        expect(isOverseasSymbol('000020')).toBe(false);
    });

    it('영문 ticker 는 해외 (true)', () => {
        expect(isOverseasSymbol('AAPL')).toBe(true);
        expect(isOverseasSymbol('NET')).toBe(true);
        expect(isOverseasSymbol('BRK/B')).toBe(true);
    });

    it('5자리 또는 7자리 숫자는 KRX 아님 (해외)', () => {
        expect(isOverseasSymbol('12345')).toBe(true);
        expect(isOverseasSymbol('1234567')).toBe(true);
    });

    it('풀형식 국내(005930/KRW)는 base 로 판정 → 국내 (false) — 오라우팅 방어', () => {
        expect(isOverseasSymbol('005930/KRW')).toBe(false);
        expect(isOverseasSymbol('035420/KRW')).toBe(false);
        expect(isOverseasSymbol('005930/USDT')).toBe(false); // quote 오염돼도 base 기준
    });

    it('풀형식 해외(AAPL/USD)는 base 도 비-6자리 → 해외 (true) 유지', () => {
        expect(isOverseasSymbol('AAPL/USD')).toBe(true);
        expect(isOverseasSymbol('NET/USD')).toBe(true);
        expect(isOverseasSymbol('NVDD')).toBe(true);
    });

    it('신형 영숫자 KR 코드(0193L0/0197X0)는 국내 (false) — 인버스2X ETF 라우팅', () => {
        expect(isOverseasSymbol('0193L0')).toBe(false);
        expect(isOverseasSymbol('0197X0')).toBe(false);
        expect(isOverseasSymbol('0193L0/KRW')).toBe(false); // 풀형식도 base 기준
    });
});

describe('isKrxDomesticCode — 숫자로 시작하는 6자리 영숫자', () => {
    it('6자리 숫자와 신형 영숫자 코드는 목록에 없어도 국내 코드다', () => {
        for (const code of ['005930', '069500', '0193L0', '0197X0', '0101N0', '0193L1']) expect(isKrxDomesticCode(code), code).toBe(true);
    });

    it('해외 티커와 모양이 다른 값은 국내가 아니다', () => {
        for (const code of ['AAPL', 'NVDD', 'BRK.B', 'A00593', '12345', '1234567', '0193L', '']) expect(isKrxDomesticCode(code), code).toBe(false);
    });
});

describe('KIS 수수료/거래세', () => {
    it('위탁수수료는 0.015%', () => {
        expect(KIS_BROKERAGE_FEE).toBe(0.00015);
    });

    it('매도 거래세는 체결 연도를 따른다 — 상수가 아니다', () => {
        expect(krxSellTaxRate(new Date('2024-06-15T00:00:00Z'))).toBe(0.0018);
        expect(krxSellTaxRate(new Date('2025-06-15T00:00:00Z'))).toBe(0.0015);
        expect(krxSellTaxRate(new Date('2026-06-15T00:00:00Z'))).toBe(0.002);
    });

    it("getKisEffectiveFeeRate('buy') = 위탁수수료만", () => {
        expect(getKisEffectiveFeeRate('buy')).toBe(0.00015);
    });

    it("getKisEffectiveFeeRate('sell') = 위탁 + 그 시점의 거래세", () => {
        // 2026년 체결: 0.015% + 0.20%
        expect(getKisEffectiveFeeRate('sell', new Date('2026-06-15T00:00:00Z'))).toBeCloseTo(0.00215, 6);
        // 2024년 체결이면 같은 함수가 0.00195 다 — 세율이 바뀌었다는 것이 여기서 드러난다.
        expect(getKisEffectiveFeeRate('sell', new Date('2024-06-15T00:00:00Z'))).toBeCloseTo(0.00195, 6);
    });
});
