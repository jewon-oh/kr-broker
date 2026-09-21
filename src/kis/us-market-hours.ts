/**
 * @fileoverview [이전됨] 미국 장 시간 — 정본은 `../us-market-hours` 다.
 *
 * 이유는 `./kis-trading-hours.ts` 헤더 참조. 요약하면 NYSE 개장 시각은
 * **시장의 사실**이지 KIS 의 사실이 아니다. 그런데 이 파일이 KIS 폴더에 있어서
 * 토스 어댑터가 미국 장 시간을 얻으려고 `../kis/us-market-hours` 를 import 하고 있었다.
 *
 * 소비 경로를 그대로 두는 이유는, 여러 테스트가 `vi.mock('../us-market-hours',...)`
 * 로 이 경로를 mock 하기 때문이다.
 */
export { getUsMarketPhase, getTimeUntilUsMarketOpen, formatEtWallClock } from '../us-market-hours';
export type { UsMarketPhase } from '../us-market-hours';
