"""토큰 실패 차단기. 폐기와 회전까지 했는데도 토큰 실패가 이어지면 KB증권 호출을 멈춘다. TypeScript 판 `ts/src/kbsec/kbsec-token-breaker.ts` 와 같다.

토큰 회전(`KbsecAuth.rotate_after_token_failure`)을 대신하지 않는다. 폐기마저 KB 가 거절하는 경우의 마지막 장치다. KB 는 "잘못된 조회의 과도한 반복"을
계정 제한 사유로 들고, 이 오류를 HTTP 500 과 봉투 안의 processCode 로 주므로 429 를 세는 호출 간격 조절로는 막을 수 없다.

앱키마다 따로 센다. 정상 응답이 한 번 오면 그 앱키의 차단기는 바로 닫힌다. 인스턴스를 다시 만들어도 상태가 남도록 모듈에 둔다.
동기 판과 비동기 판이 이 모듈 하나를 함께 쓴다(생성하지 않는 모듈이다). 테스트는 `kr_broker.testing.reset_kbsec_token_breaker` 로 비운다.
"""

import logging
import math
from typing import Dict

from kr_broker.base import functions as fn
from kr_broker.base.errors import ExchangeNotAvailable
from kr_broker.base.types import Str

logger = logging.getLogger('kr_broker')

# 이 횟수만큼 연속 실패하면 연다. 일시적 오류는 통과시키고 지속되는 장애만 잡는 값이다.
TOKEN_BREAKER_THRESHOLD = 5
# 열려 있는 동안 KB 를 부르지 않는다(ms).
TOKEN_BREAKER_OPEN_MS = 10 * 60 * 1000

# 앱키별 `{'streak': 연속 실패 수, 'openUntil': 열려 있는 끝 시각(ms)}`.
_states: Dict[Str, Dict[str, int]] = {}


def throw_if_token_breaker_open(app_key: Str, tr_code: str) -> None:
    """차단기가 열려 있으면 요청을 보내지 않고 `ExchangeNotAvailable`(`retryable=False`)을 던진다."""
    state = _states.get(app_key)
    if state is None or state['openUntil'] <= fn.milliseconds():
        return
    left_sec = math.ceil((state['openUntil'] - fn.milliseconds()) / 1000)
    raise ExchangeNotAvailable(
        f'KB증권 토큰 실패가 연속 {TOKEN_BREAKER_THRESHOLD}회 이어져 호출을 중단했다 '
        f'({tr_code}, {left_sec}초 후 재시도). 폐기·회전으로도 낫지 않는 상태이며 '
        '반복 호출은 KB 가 명시한 계정 제한 사유다 — KB 개발자포털에서 앱키 상태를 확인할 것.',
        retryable=False,
    )


def record_token_failure(app_key: Str, tr_code: str, process_code: str) -> None:
    """회전 뒤에도 남은 토큰 실패를 센다. 연속 `TOKEN_BREAKER_THRESHOLD` 회가 되면 `TOKEN_BREAKER_OPEN_MS` 동안 연다."""
    state = _states.setdefault(app_key, {'streak': 0, 'openUntil': 0})
    state['streak'] += 1
    if state['streak'] < TOKEN_BREAKER_THRESHOLD or state['openUntil'] > fn.milliseconds():
        return
    state['openUntil'] = fn.milliseconds() + TOKEN_BREAKER_OPEN_MS
    logger.error('[kbsec] 토큰 실패가 연속 임계를 넘어 KB 호출을 중단한다 — 폐기·회전으로도 낫지 않는 상태다. '
                 'KB 개발자포털에서 앱키 상태를 확인할 것(반복 실패는 KB 가 명시한 계정 제한 사유): trCode=%s processCode=%s streak=%s',
                 tr_code, process_code, state['streak'])


def record_kbsec_call_ok(app_key: Str) -> None:
    """토큰이 통한 응답을 받았다. 그 앱키의 차단기를 닫는다."""
    state = _states.get(app_key)
    if state is None or (state['streak'] == 0 and state['openUntil'] == 0):
        return
    if state['openUntil'] > 0:
        logger.info('[kbsec] 토큰 정상 응답 — 차단기 해제')
    state['streak'] = 0
    state['openUntil'] = 0


def reset_kbsec_token_breaker() -> None:
    """테스트용. 모든 앱키의 상태를 지운다."""
    _states.clear()


def kbsec_token_breaker_state(app_key: Str) -> Dict[str, int]:
    """이 앱키의 `{'streak', 'openUntil'}`. 센 적이 없으면 둘 다 0 이다."""
    state = _states.get(app_key)
    return {'streak': 0 if state is None else state['streak'], 'openUntil': 0 if state is None else state['openUntil']}
