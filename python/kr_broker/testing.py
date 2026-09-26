"""테스트 전용 훅. 모듈 전역 상태를 채우거나 비운다. TypeScript 판 `ts/src/testing.ts`(`kr-broker/testing`)와 같다.

KB증권 토큰 차단기와 체결 경고, 휴장일 캘린더는 상태를 모듈에 둔다. 그래서 한 프로세스에서 돌린 테스트끼리 상태가 넘어가므로, 테스트마다 이 훅으로 비운다.
이 모듈은 호환을 약속하지 않는다. 운영 코드에서 가져오지 않는다.
`token_store_key(prefix, credential_id)` 는 증권사 인증이 토큰 저장소에 쓰는 키다. 접두사와 자격증명은 TypeScript 판 `testing.ts` 의 설명과 같다.
"""

from kr_broker.base.token_store import token_store_key
from kr_broker.kbsec_fill_warnings import reset_fill_side_warn
from kr_broker.kbsec_token_breaker import reset_kbsec_token_breaker
from kr_broker.market_calendar import apply_market_calendar, reset_market_calendar

__all__ = ['apply_market_calendar', 'reset_fill_side_warn', 'reset_kbsec_token_breaker', 'reset_market_calendar', 'token_store_key']
