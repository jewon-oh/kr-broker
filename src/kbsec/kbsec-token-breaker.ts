/**
 * @fileoverview 토큰 실패 차단기 — **폐기와 회전까지 했는데도 토큰 실패가 이어지면 호출을 멈춘다.**
 *
 * 과거 장애의 마지막 안전망이다. 그때 KB 는 발급 요청에 **같은 토큰**만 돌려줬고(`expiresInSec` 이 경과 시간만큼만 줄었다),
 * 재시도 경로가 무한히 돌아 몇 시간 동안 수천 건의 실패 호출을 쌓았다.
 *
 * `KBSecAuth.rotateAfterTokenFailure`(명시 폐기 뒤 회전)가 그 상태를 실제로 풀었다. 이 차단기는 그것을 대체하지 않는다.
 * **폐기마저 KB 가 거절하는 경우**의 백스톱이다. 그때는 우리 쪽에서 쓸 수단이 없으므로 반복 호출하는 것 자체가 유일한 피해가 된다.
 * KB 는 "잘못된 조회의 과도한 반복"을 계정 제한 사유로 명시하므로, 고칠 수 없는 상태에서 제동 없이 재시도하면 장애를 스스로 키운다.
 *
 * 429 를 세는 레이트리밋으로는 막을 수 없다. KB 는 이 오류를 HTTP 500 과 봉투 안의 processCode 로 주기 때문에, 상태 코드에 가려진 업무
 * 오류는 제동 장치를 그대로 통과한다.
 *
 * 프로세스 안 상태다. 프로세스마다 독립적으로 멈추면 충분하고, 정상 응답이 한 번 오면 즉시 닫힌다. 인스턴스를 다시 만들어도 상태가
 * 유지되도록 모듈 수준에 둔다.
 */

import { logger } from '../logger';
import { ExchangeNotAvailable } from '../base/errors';

const TOKEN_BREAKER = {
    /** 이 횟수만큼 **연속** 실패하면 연다. 일시적 오류는 통과시키고 지속되는 장애만 잡아내는 값이다. */
    THRESHOLD: 5,
    /** 열려 있는 동안 KB 를 부르지 않는다. */
    OPEN_MS: 10 * 60 * 1000,
} as const;

let tokenFailureStreak = 0;
let breakerOpenUntil = 0;

/** 차단기가 열려 있으면 KB 를 부르지 않고 즉시 실패시킨다. */
export function throwIfTokenBreakerOpen(trCode: string): void {
    if (breakerOpenUntil <= Date.now()) return;
    const leftSec = Math.ceil((breakerOpenUntil - Date.now()) / 1000);
    throw new ExchangeNotAvailable(
        `KB증권 토큰 실패가 연속 ${TOKEN_BREAKER.THRESHOLD}회 이어져 호출을 중단했다 `
        + `(${trCode}, ${leftSec}초 후 재시도). 폐기·회전으로도 낫지 않는 상태이며 `
        + '반복 호출은 KB 가 명시한 계정 제한 사유다 — KB 개발자포털에서 앱키 상태를 확인할 것.',
        { retryable: false },
    );
}

/** 회전 뒤에도 실패한 토큰 오류 1건을 센다. 임계를 넘으면 차단기를 연다. */
export function recordTokenFailure(trCode: string, processCode: string): void {
    tokenFailureStreak++;
    if (tokenFailureStreak < TOKEN_BREAKER.THRESHOLD || breakerOpenUntil > Date.now()) return;
    breakerOpenUntil = Date.now() + TOKEN_BREAKER.OPEN_MS;
    logger.error(
        { trCode, processCode, streak: tokenFailureStreak, openMs: TOKEN_BREAKER.OPEN_MS },
        '[kbsec] 토큰 실패가 연속 임계를 넘어 KB 호출을 중단한다 — 폐기·회전으로도 낫지 않는 상태다. '
        + 'KB 개발자포털에서 앱키 상태를 확인할 것(반복 실패는 KB 가 명시한 계정 제한 사유)',
    );
}

/** 토큰이 정상 동작한 호출 1건. 연속 카운터와 차단기를 즉시 초기화한다. */
export function recordKbsecCallOk(): void {
    if (tokenFailureStreak === 0 && breakerOpenUntil === 0) return;
    if (breakerOpenUntil > 0) {
        logger.info({}, '[kbsec] 토큰 정상 응답 — 차단기 해제');
    }
    tokenFailureStreak = 0;
    breakerOpenUntil = 0;
}

/** 테스트 전용. 차단기 상태를 초기화한다. */
export function __resetKbsecTokenBreaker(): void {
    tokenFailureStreak = 0;
    breakerOpenUntil = 0;
}

/** 테스트·진단용. 현재 차단기 상태. */
export function kbsecTokenBreakerState(): { streak: number; openUntil: number } {
    return { streak: tokenFailureStreak, openUntil: breakerOpenUntil };
}
