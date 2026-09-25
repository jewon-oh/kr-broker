/**
 * @fileoverview KB증권 매매비용 추정 정본 테스트.
 *
 * ## 무엇을 막는가
 *
 * 같은 "KB 수수료"를 어댑터와 호출하는 쪽의 거래 기록이 각자
 * 계산했고 값이 서로 어긋났다. 실현손익 계산에 들어가는 쪽은 후자인데,
 * 거기엔 KB증권 요율이 아예 없어 폴백 0.1% 가 쓰였다 — 국내 매매는 위탁수수료가 6.7배
 * 과대이면서 **매도 증권거래세 0.18% 는 통째로 빠진** 채 기록됐다.
 *
 * 그래서 이 스위트가 지키는 것은 두 가지다:
 * ① 국내/해외 × 매수/매도 네 조합의 실효율이 맞는가 (특히 국내 매도의 세금)
 * ② `kbsec.fetchTradingFee` 와 정본 모듈이 **같은 값**을 내는가 (다시 어긋나면 여기서 실패한다)
 */

import { describe, it, expect } from 'vitest';

import {
    KBSEC_BROKERAGE_FEE, KBSEC_US_BROKERAGE_FEE,
    KR_SELL_TAX_SCHEDULE, krSellTaxRate,
    kbsecEstimatedFee, kbsecEstimatedFeeRate,
} from '../kbsec-fee';
import { kbsec } from '../../kbsec';

/** 종전 폴백값 — 이 값으로 되돌아가면 회귀다. */
const OLD_FALLBACK_RATE = 0.001;

const KR = '005930/KRW';
const US = 'AAPL/USD';

/** 시행일 한복판의 시각 — 경계 오차에 걸리지 않게 연중으로 잡는다. */
const MID_2024 = new Date('2024-06-15T00:00:00Z');
const MID_2025 = new Date('2025-06-15T00:00:00Z');
const MID_2026 = new Date('2026-06-15T00:00:00Z');

describe('krSellTaxRate — 시행일별 매도 증권거래세', () => {
    it('해마다 다르다 — 상수 하나로 두면 어느 해도 맞지 않는다', () => {
        expect(krSellTaxRate(MID_2024)).toBe(0.0018);
        expect(krSellTaxRate(MID_2025)).toBe(0.0015);
        expect(krSellTaxRate(MID_2026)).toBe(0.002);
    });

    it('경계는 KST 1월 1일이다 (UTC 자정으로 잡으면 연말 하루가 어긋난다)', () => {
        // 2025-12-31 23:59 KST = 아직 0.15%
        expect(krSellTaxRate(new Date('2025-12-31T14:59:00Z'))).toBe(0.0015);
        // 2026-01-01 00:00 KST = 0.20%
        expect(krSellTaxRate(new Date('2025-12-31T15:00:00Z'))).toBe(0.002);
    });

    it('표는 최신 시행일이 먼저다 (뒤집히면 조회가 옛 값을 돌려준다)', () => {
        const froms = KR_SELL_TAX_SCHEDULE.map((e) => e.fromUtcMs);
        expect(froms).toStrictEqual([...froms].sort((a, b) => b - a));
    });

    it('표보다 앞선 시각도 값을 돌려준다 (가장 오래된 시행일 값)', () => {
        const oldest = KR_SELL_TAX_SCHEDULE[KR_SELL_TAX_SCHEDULE.length - 1]!;
        expect(krSellTaxRate(new Date('2019-01-01T00:00:00Z'))).toBe(oldest.rate);
    });
});

describe('kbsecEstimatedFeeRate — 실효율 네 조합', () => {
    it('국내 매수는 위탁수수료만', () => {
        expect(kbsecEstimatedFeeRate('KR', 'buy')).toBe(KBSEC_BROKERAGE_FEE);
    });

    it('국내 매도는 위탁수수료 + 그 시점의 증권거래세', () => {
        expect(kbsecEstimatedFeeRate('KR', 'sell', MID_2026)).toBe(KBSEC_BROKERAGE_FEE + 0.002);
        expect(kbsecEstimatedFeeRate('KR', 'sell', MID_2025)).toBe(KBSEC_BROKERAGE_FEE + 0.0015);
        // 세금이 수수료의 10배를 넘는다 — 빠뜨리면 국내 매도 비용이 사실상 0 이 된다.
        expect(krSellTaxRate(MID_2026)).toBeGreaterThan(KBSEC_BROKERAGE_FEE * 10);
    });

    it('해외는 매수·매도 모두 세금 없이 위탁수수료만 (국내 매도세를 붙이지 않는다)', () => {
        expect(kbsecEstimatedFeeRate('US', 'buy')).toBe(KBSEC_US_BROKERAGE_FEE);
        expect(kbsecEstimatedFeeRate('US', 'sell')).toBe(KBSEC_US_BROKERAGE_FEE);
        // 연도가 바뀌어도 해외는 그대로다 — 국내 표가 해외에 적용되면 여기서 실패한다.
        expect(kbsecEstimatedFeeRate('US', 'sell', MID_2025)).toBe(KBSEC_US_BROKERAGE_FEE);
    });

    it('국내 요율이 종전 폴백 0.1% 와 다르다 (회귀 가드)', () => {
        expect(kbsecEstimatedFeeRate('KR', 'buy')).not.toBe(OLD_FALLBACK_RATE);
        expect(kbsecEstimatedFeeRate('KR', 'sell')).not.toBe(OLD_FALLBACK_RATE);
        // 종전엔 매수가 6.7배 과대였다.
        expect(OLD_FALLBACK_RATE / KBSEC_BROKERAGE_FEE).toBeCloseTo(6.67, 1);
    });
});

describe('kbsecEstimatedFee — 심볼로 시장을 가른다', () => {
    it('국내 6자리 코드 → KR', () => {
        expect(kbsecEstimatedFee(1_000_000, KR, 'sell').market).toBe('KR');
        // 2026년 체결: 100만원 × (0.015% + 0.20%) = 2,150원
        expect(kbsecEstimatedFee(1_000_000, KR, 'sell', MID_2026).cost).toBeCloseTo(2150, 6);
        // 2025년 체결이면 같은 금액이라도 세율이 달라 1,650원이다
        expect(kbsecEstimatedFee(1_000_000, KR, 'sell', MID_2025).cost).toBeCloseTo(1650, 6);
        expect(kbsecEstimatedFee(1_000_000, KR, 'buy').cost).toBe(150);
    });

    it('해외 티커 → US', () => {
        expect(kbsecEstimatedFee(1_000, US, 'buy').market).toBe('US');
        expect(kbsecEstimatedFee(1_000, US, 'buy').cost).toBe(1);
        expect(kbsecEstimatedFee(1_000, US, 'sell').cost).toBe(1);
    });

    it('cost = 명목 × rate 가 성립한다 (rate 가 실효율이라는 계약)', () => {
        for (const [symbol, side] of [[KR, 'buy'], [KR, 'sell'], [US, 'buy'], [US, 'sell']] as const) {
            const { cost, rate } = kbsecEstimatedFee(12_345, symbol, side);
            expect(cost).toBeCloseTo(12_345 * rate, 10);
        }
    });
});

describe('kbsec.fetchTradingFee — 정본과 같은 값을 낸다', () => {
    const exchange = new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret', rateLimit: 0 });

    it('국내 매도 — 세금 포함이다', async () => {
        const fee = await exchange.fetchTradingFee(KR, { side: 'sell' });
        // 지금 체결이라 오늘 세율을 쓴다. 숫자를 하드코딩하면 시행일이 바뀔 때 깨진다.
        expect(fee.taker).toBe(KBSEC_BROKERAGE_FEE + krSellTaxRate());
        expect(fee.maker).toBe(fee.taker);
        expect(fee.symbol).toBe(KR);
        expect(fee.percentage).toBe(true);
        expect(fee.tierBased).toBe(false);
    });

    it('추정치임을 info 에 밝힌다 — KB 에 수수료 조회 TR 이 없다', async () => {
        expect((await exchange.fetchTradingFee(KR)).info).toMatchObject({ estimated: true, side: 'buy' });
    });

    it('해외 매수 — 미국 위탁수수료율', async () => {
        const fee = await exchange.fetchTradingFee(US, { side: 'buy' });
        expect(fee.taker).toBe(KBSEC_US_BROKERAGE_FEE);
        expect(fee.symbol).toBe(US);
    });

    it('방향을 생략하면 매수다 — 국내 매수에는 세금이 없다', async () => {
        expect((await exchange.fetchTradingFee(KR)).taker).toBe(KBSEC_BROKERAGE_FEE);
    });

    it('정본 모듈과 같은 값 (값이 둘로 갈라지면 여기서 실패한다)', async () => {
        for (const [symbol, side] of [[KR, 'buy'], [KR, 'sell'], [US, 'buy'], [US, 'sell']] as const) {
            const viaClass = await exchange.fetchTradingFee(symbol, { side });
            expect(viaClass.taker).toBe(kbsecEstimatedFee(777_777, symbol, side).rate);
        }
    });

    it('has 표에는 emulated 로 적혀 있다 — API 가 준 값이 아니라 공시 요율로 재구성한 값이다', () => {
        expect(exchange.has.fetchTradingFee).toBe('emulated');
    });
});
