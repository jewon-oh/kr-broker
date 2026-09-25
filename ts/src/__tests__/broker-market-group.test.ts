/**
 * 심볼 → 종목코드.
 */
import { describe, expect, it } from 'vitest';

import { symbolBaseCode } from '../broker-market-group';

describe('symbolBaseCode', () => {
    it('끝의 /KRW·/USD 만 떼고, 클래스 주식의 슬래시는 통합 표기의 점으로 바꾼다', () => {
        expect(['005930/KRW', '005930', 'AAPL/USD', 'AAPL', 'BRK.B/USD', 'BRK/B', 'BRK/B/USD'].map(symbolBaseCode))
            .toEqual(['005930', '005930', 'AAPL', 'AAPL', 'BRK.B', 'BRK.B', 'BRK.B']);
    });
});
