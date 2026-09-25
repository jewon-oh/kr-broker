/**
 * @fileoverview 토큰 실패 차단기 — **폐기와 회전까지 했는데도 토큰 실패가 이어지면 호출을 멈춘다.**
 *
 * `KbsecAuth.rotateAfterTokenFailure`(명시 폐기 뒤 회전)를 대체하지 않는다. **폐기마저 KB 가 거절하는 경우**의 백스톱이다.
 * 그때는 클라이언트가 쓸 수단이 없으므로 반복 호출 자체가 피해가 된다. KB 는 "잘못된 조회의 과도한 반복"을 계정 제한 사유로 명시하므로,
 * 고칠 수 없는 상태에서 제동 없이 재시도하면 장애를 스스로 키운다.
 *
 * 429 를 세는 레이트리밋으로는 막을 수 없다. KB 는 이 오류를 HTTP 500 과 봉투 안의 processCode 로 주기 때문에, 상태 코드에 가려진 업무
 * 오류는 제동 장치를 그대로 통과한다.
 *
 * 프로세스 안 상태이고 앱키마다 따로 센다. 한 계정의 실패가 같은 프로세스의 다른 계정을 막지 않는다. 정상 응답이 한 번 오면 그 앱키의
 * 차단기는 즉시 닫힌다. 인스턴스를 다시 만들어도 상태가 유지되도록 모듈 수준의 `Map` 에 둔다.
 */

import { logger } from '../logger';
import { ExchangeNotAvailable } from '../base/errors';

const TOKEN_BREAKER = {
    /** 이 횟수만큼 **연속** 실패하면 연다. 일시적 오류는 통과시키고 지속되는 장애만 잡아내는 값이다. */
    THRESHOLD: 5,
    /** 열려 있는 동안 KB 를 부르지 않는다. */
    OPEN_MS: 10 * 60 * 1000,
} as const;

/** 앱키별 상태. 한 프로세스가 KB 계정 여럿을 쓰면 한 계정의 실패가 다른 계정을 막지 않아야 한다. */
const states = new Map<string, { streak: number; openUntil: number }>();

function stateOf(appKey: string): { streak: number; openUntil: number } {
    let state = states.get(appKey);
    if (state === undefined) {
        state = { streak: 0, openUntil: 0 };
        states.set(appKey, state);
    }
    return state;
}

export function throwIfTokenBreakerOpen(appKey: string, trCode: string): void {
    const state = states.get(appKey);
    if (state === undefined || state.openUntil <= Date.now()) return;
    const leftSec = Math.ceil((state.openUntil - Date.now()) / 1000);
    throw new ExchangeNotAvailable(
        `KB증권 토큰 실패가 연속 ${TOKEN_BREAKER.THRESHOLD}회 이어져 호출을 중단했다 `
        + `(${trCode}, ${leftSec}초 후 재시도). 폐기·회전으로도 낫지 않는 상태이며 `
        + '반복 호출은 KB 가 명시한 계정 제한 사유다 — KB 개발자포털에서 앱키 상태를 확인할 것.',
        { retryable: false },
    );
}

export function recordTokenFailure(appKey: string, trCode: string, processCode: string): void {
    const state = stateOf(appKey);
    state.streak++;
    if (state.streak < TOKEN_BREAKER.THRESHOLD || state.openUntil > Date.now()) return;
    state.openUntil = Date.now() + TOKEN_BREAKER.OPEN_MS;
    logger.error(
        { trCode, processCode, streak: state.streak, openMs: TOKEN_BREAKER.OPEN_MS },
        '[kbsec] 토큰 실패가 연속 임계를 넘어 KB 호출을 중단한다 — 폐기·회전으로도 낫지 않는 상태다. '
        + 'KB 개발자포털에서 앱키 상태를 확인할 것(반복 실패는 KB 가 명시한 계정 제한 사유)',
    );
}

export function recordKbsecCallOk(appKey: string): void {
    const state = states.get(appKey);
    if (state === undefined || (state.streak === 0 && state.openUntil === 0)) return;
    if (state.openUntil > 0) {
        logger.info({}, '[kbsec] 토큰 정상 응답 — 차단기 해제');
    }
    state.streak = 0;
    state.openUntil = 0;
}

/** 테스트용. 모든 앱키의 상태를 지운다. */
export function __resetKbsecTokenBreaker(): void {
    states.clear();
}

export function kbsecTokenBreakerState(appKey: string): { streak: number; openUntil: number } {
    const state = states.get(appKey);
    return { streak: state?.streak ?? 0, openUntil: state?.openUntil ?? 0 };
}
