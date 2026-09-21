/**
 * "조회 안 한 시장" 을 "보유 0" 으로 읽지 않는다.
 *
 * 실제로 이 추론이 **살아 있는 포지션 여러 개를 지운** 사고가 있었다. 유지보수 창이 끝나고
 * 호출하는 쪽 프로세스가 재시작하자 부팅 동기화가 돌았는데, KB 해외 보유 조회(`SPQM2226`)가
 * 0건을 주고 있어 보유 종목이 잔고 목록에 없었다. `getBalance` 가 `total: 0` 을
 * 돌려줬고, 호출하는 쪽의 생존 판정은 그걸 "외부 청산" 으로 읽어 여러 포지션을 **손익까지 지어내며**
 * 닫았다. 주식은 KB 에 그대로 있었다.
 *
 * "모름", "없음", "0" 을 한 값으로 뭉갠 데서 나온 같은 종류의 사고 가운데,
 * 이 경우는 판정하는 쪽이 아니라 **판정의 입력을 만드는 쪽**에서 일어났다.
 */
import { describe, it, expect } from 'vitest';

import { kbsecMarketOf } from '../kbsec-types';

/**
 * `getBalance` 의 판정 규칙 — **해외에만** 적용한다.
 *
 * 국내(`SSQM1801`)의 빈 응답은 신뢰할 수 있는 "없음" 이다.
 * 신뢰할 수 없는 건 해외(`SPQM2226`)뿐이다 — 그리드를 못 알아보면 조용히 빈 배열을 준다.
 * 그래서 방어를 US 로 좁힌다. 넓히면 KR 외부청산 감지가 동작하지 않는다.
 */
function isUnknownRatherThanZero(currency: string, overseasGridSeen: boolean): boolean {
    return kbsecMarketOf(currency) === 'US' && !overseasGridSeen;
}

describe('조회하지 못한 시장을 0 으로 처리하지 않는다', () => {
    it('사고 재현 — 해외 그리드를 못 본 상태에서 US 종목은 판단 불가', () => {
        for (const sym of ['V', 'MA', 'KO']) {
            expect(isUnknownRatherThanZero(sym, false)).toBe(true);
        }
    });

    it('국내는 영향 없다 — SSQM1801 의 빈 응답은 신뢰할 수 있는 "없음"', () => {
        // 여기까지 넓히면 KR 외부청산 감지가 동작하지 않는다.
        expect(isUnknownRatherThanZero('005930', false)).toBe(false);
        expect(isUnknownRatherThanZero('000660', false)).toBe(false);
    });

    it('해외 그리드를 한 번이라도 보면 자가 치유 — 정상 판정 복귀', () => {
        expect(isUnknownRatherThanZero('V', true)).toBe(false);
    });
});

describe('시장 판별', () => {
    it('6자리 숫자는 KR, 영문 티커는 US', () => {
        expect(kbsecMarketOf('005930')).toBe('KR');
        expect(kbsecMarketOf('V')).toBe('US');
        expect(kbsecMarketOf('KO')).toBe('US');
    });
});
