/**
 * @fileoverview 테스트 전용 훅. 모듈 전역 상태를 비우거나 읽거나 채운다.
 *
 * KB증권 토큰 차단기와 체결 경고, 휴장일 캘린더는 상태를 모듈에 둔다. 그래서 한 프로세스에서 돌린 테스트끼리 상태가 넘어가므로, 테스트마다 이 훅으로 비운다.
 * 이 경로(`kr-broker/testing`)는 호환을 약속하지 않는다. 운영 코드에서 가져오지 않는다.
 *
 * `tokenStoreKey(prefix, credentialId)` 는 증권사 인증이 토큰 저장소(`options.tokenStore`)에 쓰는 키다. 테스트가 키 규칙을 흉내 내지 않도록 내보낸다.
 * 접두사와 자격증명은 증권사마다 이렇다: 한국투자증권 접근 토큰 `'kis:token:'` + 앱키, 실시간 접속키 `'kis:approval:'` + 앱키,
 * 토스증권 `'toss:token:'` + 클라이언트 ID, KB증권 `'kbsec:token:'` + 앱키.
 */
export { __resetKbsecTokenBreaker, kbsecTokenBreakerState } from './kbsec/kbsec-token-breaker';
export { __resetFillSideWarn } from './kbsec/kbsec-fill-warnings';
export { applyMarketCalendar, resetMarketCalendar } from './market-calendar-state';
export { tokenStoreKey } from './token-store-key';
