/**
 * @fileoverview 테스트 전용 훅. 모듈 전역 상태를 비우거나 읽거나 채운다.
 *
 * KB증권 토큰 차단기와 체결 경고, 휴장일 캘린더는 상태를 모듈에 둔다. 그래서 한 프로세스에서 돌린 테스트끼리 상태가 넘어가므로, 테스트마다 이 훅으로 비운다.
 * 이 경로(`kr-broker/testing`)는 호환을 약속하지 않는다. 운영 코드에서 가져오지 않는다.
 */
export { __resetKbsecTokenBreaker, kbsecTokenBreakerState } from './kbsec/kbsec-token-breaker';
export { __resetFillSideWarn } from './kbsec/kbsec-fill-warnings';
export { applyMarketCalendar, resetMarketCalendar } from './market-calendar-state';
