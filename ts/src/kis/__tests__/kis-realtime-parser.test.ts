/**
 * KIS 실시간 WS 프레임 파서 회귀.
 * 필드 인덱스(KIS_WS_FIELD)를 테스트로 고정 — 실연결 검증 시 상수만 맞추면 본 테스트가 가드.
 */

import { describe, it, expect } from 'vitest';
import { parseKisRealtimeFrame, toStreamSymbol, isPingPong } from '../kis-realtime-parser';

describe('toStreamSymbol', () => {
    // 해외 quote 가 `USDT` → **`USD`** 로 바뀌었다.
    // bare 심볼 캐시·리스너에서 다른 호가통화의 심볼과 겹치지 않게 하려는 것이다.
    it('국내 6자리 → /KRW, 해외 ticker → /USD', () => {
        expect(toStreamSymbol('005930')).toBe('005930/KRW');
        expect(toStreamSymbol('aapl')).toBe('AAPL/USD');
    });
});

describe('isPingPong', () => {
    it('PINGPONG 헤더만 true', () => {
        expect(isPingPong('{"header":{"tr_id":"PINGPONG"}}')).toBe(true);
        expect(isPingPong('{"header":{"tr_id":"H0STCNT0"}}')).toBe(false);
        expect(isPingPong('0|H0STCNT0|001|005930^x')).toBe(false);
    });
});

describe('parseKisRealtimeFrame — 체결', () => {
    it('국내 H0STCNT0: [2]=현재가, [5]=등락율', () => {
        const frame = '0|H0STCNT0|001|005930^093000^79000^5^100^2.5';
        const recs = parseKisRealtimeFrame(frame);
        expect(recs).toEqual([{ kind: 'trade', symbol: '005930', last: 79000, changePct: 2.5 }]);
    });

    it('해외 HDFSCNT0: [1]=종목, [11]=현재가, [14]=등락율', () => {
        const f = new Array(15).fill('x');
        f[0] = 'DNASAAPL'; f[1] = 'AAPL'; f[11] = '185.5'; f[14] = '1.2';
        const recs = parseKisRealtimeFrame(`0|HDFSCNT0|001|${f.join('^')}`);
        expect(recs).toEqual([{ kind: 'trade', symbol: 'AAPL', last: 185.5, changePct: 1.2 }]);
    });

    it('현재가 0/빈값 record 는 제외', () => {
        const frame = '0|H0STCNT0|001|005930^093000^^5^100^2.5';
        expect(parseKisRealtimeFrame(frame)).toEqual([]);
    });
});

describe('parseKisRealtimeFrame — 국내 호가 H0STASP0', () => {
    it('ASKP/BIDP 10단 best-first 파싱(잔량 포함)', () => {
        const f = new Array(43).fill('0');
        f[0] = '005930'; f[1] = '093000'; f[2] = '0';
        f[3] = '79100'; f[4] = '79200';   // ASKP1, ASKP2
        f[13] = '79000'; f[14] = '78900'; // BIDP1, BIDP2
        f[23] = '10'; f[24] = '20';       // ASKP_RSQN1, 2
        f[33] = '30'; f[34] = '40';       // BIDP_RSQN1, 2
        const recs = parseKisRealtimeFrame(`0|H0STASP0|001|${f.join('^')}`);
        expect(recs).toEqual([{
            kind: 'orderbook',
            symbol: '005930',
            asks: [[79100, 10], [79200, 20]],
            bids: [[79000, 30], [78900, 40]],
        }]);
    });
});

describe('parseKisRealtimeFrame — 비대상 프레임', () => {
    it('JSON(제어)·빈·미지원 → []', () => {
        expect(parseKisRealtimeFrame('{"body":{"rt_cd":"0"}}')).toEqual([]);
        expect(parseKisRealtimeFrame('')).toEqual([]);
        expect(parseKisRealtimeFrame('0|UNKNOWN|001|a^b')).toEqual([]);
    });
});
