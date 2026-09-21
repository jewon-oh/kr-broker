/**
 * @fileoverview KRX 매도 증권거래세 정본.
 *
 * ## 왜 브로커 밖에 있는가
 *
 * 이건 브로커가 정하는 요율이 아니라 **정부가 법으로 정하는 세금**이다. 그런데 종전에는
 * 같은 값이 세 곳에 따로 있었고 셋 다 2024년 값에 멈춰 있었다.
 *
 * - `kbsec/kbsec-fee.ts` — `KBSEC_SELL_TAX = 0.0018`
 * - `kis/kis-types.ts` — `KIS_SELL_TRANSACTION_TAX = 0.0018`
 * - `toss/toss-types.ts` — `TOSS_SELL_TRANSACTION_TAX = 0.0018`
 *
 * 브로커를 하나 고쳐도 나머지 둘이 그대로 남는 구조라, 값을 여기 한 곳으로 모은다.
 * 브로커마다 다른 것은 **위탁수수료**뿐이고 세금은 어느 창구로 팔든 같다.
 *
 * ## 값이 해마다 바뀐다 — 상수로 두면 어느 해도 맞지 않는다
 *
 * | 시행일 | 총 세율 |
 * |---|---|
 * | 2023-01-01 | 0.20% |
 * | 2024-01-01 | 0.18% |
 * | 2025-01-01 | 0.15% |
 * | 2026-01-01 | 0.20% (금융투자소득세 폐지에 따른 세수 보전) |
 *
 * 코드에 하드코딩돼 있던 `0.0018` 은 2024년 값이다. 2025년엔 과대, 2026년엔 과소로 어긋났다.
 * 이 값은 수수료로 저장돼 실현손익에 들어가고, 그 손익을 승률과 expectancy,
 * 손실한도 판단이 읽는다.
 *
 * 코스피는 증권거래세와 농어촌특별세의 합이고 코스닥은 증권거래세 단독인데, 2023년부터
 * 2026년까지는 두 시장의 **총 세율이 같아** 시장 구분 없이 한 표로 덮인다. 한쪽만 바뀌는
 * 개정이 오면 시장을 인자로 받아 나눠야 한다. 코넥스는 별도 세율이고 이 패키지는 거래하지 않는다.
 */

import { logger } from './logger';

/**
 * 시행일별 매도 증권거래세율.
 *
 * `fromUtcMs` 는 시행일 00:00 KST 를 UTC 로 적은 값이다(= 전년 12월 31일 15:00 UTC).
 * 그 시각엔 장이 닫혀 있어 실무 영향은 없지만, 경계를 UTC 자정으로 잡으면 연말 하루가
 * 어긋난 채로 남는다. 조회가 위에서부터 훑으므로 **최신 시행일이 먼저** 와야 한다.
 */
export const KRX_SELL_TAX_SCHEDULE: readonly { readonly fromUtcMs: number; readonly rate: number }[] = [
    { fromUtcMs: Date.UTC(2025, 11, 31, 15), rate: 0.002 },  // 2026-01-01 KST
    { fromUtcMs: Date.UTC(2024, 11, 31, 15), rate: 0.0015 }, // 2025-01-01 KST
    { fromUtcMs: Date.UTC(2023, 11, 31, 15), rate: 0.0018 }, // 2024-01-01 KST
    { fromUtcMs: Date.UTC(2022, 11, 31, 15), rate: 0.002 },  // 2023-01-01 KST
];

/**
 * 표가 덮는 마지막 해의 끝(2026-12-31 24:00 KST). 이보다 뒤 거래는 표에 근거가 없다.
 *
 * 넘어가도 계산은 최신 시행일 값으로 이어간다 — 세율이 그대로일 수도 있어서 멈추는 게 더 나쁘다.
 * 대신 프로세스당 한 번 경고를 남겨 표가 낡았다는 것이 드러나게 한다.
 */
export const KRX_SELL_TAX_SCHEDULE_HORIZON_MS = Date.UTC(2026, 11, 31, 15);

let staleScheduleWarned = false;

/** 테스트 전용 — 경고 래치를 푼다. 프로덕션에서 부르지 말 것. */
export function __resetKrxSellTaxWarnLatchForTest(): void {
    staleScheduleWarned = false;
}

/**
 * 체결 시각의 매도 증권거래세율. 국내 매도에만 붙는다(해외는 0).
 *
 * `at` 을 생략하면 현재 시각이다 — 라이브 체결 경로는 그게 맞다. 과거 거래를 재계산하는
 * 백필·재구성 코드는 **반드시 그 거래의 체결 시각을 넘겨야** 한다. 안 넘기면 오늘 세율로
 * 옛 거래를 정정하게 된다.
 */
export function krxSellTaxRate(at: Date = new Date()): number {
    const ms = at.getTime();
    if (ms >= KRX_SELL_TAX_SCHEDULE_HORIZON_MS && !staleScheduleWarned) {
        staleScheduleWarned = true;
        logger.warn({ at: at.toISOString() },
            '[krxSellTax] 증권거래세 시행일 표가 덮지 않는 시각이다 — 최신 시행일 값으로 계산한다. 표를 갱신할 것');
    }
    for (const entry of KRX_SELL_TAX_SCHEDULE) {
        if (ms >= entry.fromUtcMs) return entry.rate;
    }
    // 표의 가장 오래된 시행일보다 앞선 거래. 이 패키지가 다루는 데이터는 여기 닿지 않는다.
    return KRX_SELL_TAX_SCHEDULE[KRX_SELL_TAX_SCHEDULE.length - 1].rate;
}
