/**
 * @fileoverview [이전됨] KRX 거래시간 — 정본은 `../krx-trading-hours` 다.
 *
 * ## 왜 옮겼나
 *
 * 이 파일에 있던 348줄은 **전부 시장(KRX/NXT) 지식**이었다 — 개장 09:00, 마감 15:30,
 * 공휴일 JSON, 동시호가 단계, NXT 확장세션. **KIS 라는 브로커의 지식은 한 줄도 없다.**
 * 그런데 디렉토리가 `kis/` 라서 두 가지 일이 벌어졌다:
 *
 * 1. **다른 브로커가 KIS 폴더의 파일에 의존했다** — `toss/toss-trading-hours.ts` 가
 * `../kis/us-market-hours` 를 import 한다. 토스가 KIS 를 쓰는 게 아니라 *미국 장*
 * 시간이 필요했을 뿐인데, 그 지식이 KIS 폴더에 놓여 있었다.
 * 2. **공용 표가 따로 생겼다** — `../trading-hours.ts` 에 `kis`/`toss` 항목이 다시
 * 적혀 있었다(09:00~15:30, `weekdaysOnly`). 그 사본은 **공휴일을 모른다**. 즉
 * 설날·추석·광복절 09:00~15:30 에 `isTradingHours('kis')` 는 `true`(개장)를,
 * 여기 `checkKRXTradingHours` 는 `false`(휴장)를 답했다. **사본이 "열려 있다"는
 * 관대한 방향으로 틀렸다** — 빠진 쪽은 늘 경고가 사라지는 방향으로 틀린다.
 *
 * 어떤 브로커를 통해 알게 된 사실이라고 해서 그 브로커의 지식인 것은 아니다.
 *
 * ## 이 shim 을 남겨 둔 이유
 *
 * `kis.ts` 가 이 경로를 import 하고, 여러 테스트가
 * `vi.mock('../kis-trading-hours',...)` 로 **이 경로를 가로챈다**. 경로를 바꾸면 그
 * 목이 조용히 빗나가 실제 시계가 테스트에 들어간다.
 * 그래서 소비 경로는 그대로 두고 구현만 중립 위치로 옮겼다. 사본이 아니라 **재수출**이다.
 */
export {
    checkKRXTradingHours,
    getKrxMarketPhase,
    getTimeUntilKrxOpen,
    getNxtSession,
    isNxtExtendedTradable,
} from '../krx-trading-hours';
export type { KrxMarketPhase, NxtSession } from '../krx-trading-hours';
