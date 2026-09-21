/**
 * @fileoverview KIS `msg_cd` → 오류 클래스 표. `kis` 클래스의 `exceptions.exact` 가 이 표를 쓴다.
 *
 * 항목은 실측했거나 공식 자료로 동작이 확인된 코드만 넣는다. 표에 없는 코드는 `ExchangeError` 로 남아 호출하는 쪽이 메시지로 가른다.
 * 추측으로 채우면 잘못된 종류가 붙어 재시도·기록 판단이 틀어진다.
 */

import { AuthenticationError, RateLimitExceeded, type ErrorClass } from '../base/errors';

export const KIS_EXCEPTIONS_EXACT: Readonly<Record<string, ErrorClass>> = {
    // 초당 거래건수 초과. 조회는 다시 보내도 되므로 백오프 뒤 재시도한다.
    EGW00201: RateLimitExceeded,
    // 원장 초당 거래건수 초과. EGW00201 과 같은 계열이다.
    EGW00215: RateLimitExceeded,
    // 접근토큰 발급 빈도 제한(1분당 1회).
    EGW00133: RateLimitExceeded,
    // 접근토큰 만료. HTTP 200 으로 오는 경우가 있어 상태 코드로는 잡히지 않는다(공식 샘플이 이 코드를 보고 재발급한다).
    EGW00123: AuthenticationError,
};
