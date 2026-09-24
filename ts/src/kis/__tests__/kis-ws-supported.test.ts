/**
 * KIS WS 가용 판정.
 *
 * ## 원래 사고
 *
 * 운영 환경(Node 20)에는 전역 `WebSocket` 이 없어 `KisPriceWs.connect` 가 조용히
 * 반환하고 영구 비연결이 됐다. 예외를 던지지 않아 호출부의 `try/catch` 로는 못 잡고,
 * WS 시작 성공 로그가 그대로 찍혔다 — **WS 가 한 번도 붙은 적 없는데도.**
 * 1차 수정은 로그를 정확하게 만들었지만 **못 붙는 것 자체는 그대로**였다.
 *
 * ## 현재 계약
 *
 * 전역이 없으면 **`ws` 패키지로 폴백**한다. `ws@^8` 은 이 패키지의 런타임 의존성이고
 * 브라우저 호환 이벤트 API 를 제공해 `WsLike` 를 그대로 만족한다.
 *
 * | 함수 | 답하는 질문 |
 * |---|---|
 * | `isKisWsSupported` | **붙을 수 있는가** — 전역 또는 `ws` 중 하나라도 있으면 true |
 * | `isUsingGlobalWebSocket` | **무엇으로 붙는가** — 전역이면 true, `ws` 폴백이면 false |
 *
 * 두 질문을 한 함수가 겸하면 안 된다. 종전엔 겸했고, 그래서 "전역이 없다" 가 곧 "못 쓴다" 로
 * 읽혔다 — 반복해서 나타나는 형태다(한 값이 두 사실을 표현하면 호출부가 구별할 수 없다).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isKisWsSupported, isUsingGlobalWebSocket } from '../kis-price-ws';

type GlobalWithWs = { WebSocket?: unknown };

const g = globalThis as GlobalWithWs;
const original = g.WebSocket;

afterEach(() => {
    if (original === undefined) delete g.WebSocket;
    else g.WebSocket = original;
});

describe('isUsingGlobalWebSocket — 무엇으로 붙는가', () => {
    it('전역 WebSocket 이 없으면 false (Node 21 미만 = 프로덕션)', () => {
        delete g.WebSocket;
        expect(isUsingGlobalWebSocket()).toBe(false);
    });

    it('전역 WebSocket 이 생성자면 true', () => {
        g.WebSocket = class {};
        expect(isUsingGlobalWebSocket()).toBe(true);
    });

    it('생성자가 아닌 값이면 false — undefined 만 걸러서는 안 된다', () => {
        // 폴리필을 잘못 주입해 객체/문자열이 들어가는 경우. `connect()` 는 `new Ctor()` 를
        // 하므로 함수가 아니면 어차피 못 쓴다 — 판정이 그 사실과 어긋나면 안 된다.
        g.WebSocket = {};
        expect(isUsingGlobalWebSocket()).toBe(false);
    });
});

describe('isKisWsSupported — 붙을 수 있는가', () => {
    it('전역이 없어도 true — `ws` 패키지로 폴백한다 (이 수정의 요점)', async () => {
        delete g.WebSocket;
        expect(isUsingGlobalWebSocket()).toBe(false);
        // 종전 계약이라면 여기서 false 였고, 그게 프로덕션에서 WS 가 영영 안 붙던 상태다.
        await expect(isKisWsSupported()).resolves.toBe(true);
    });

    it('전역이 있으면 당연히 true', async () => {
        g.WebSocket = class {};
        await expect(isKisWsSupported()).resolves.toBe(true);
    });

    it('현재 실행 런타임에서도 true — 로컬(22+)·CI/프로덕션(20) 어디서도', async () => {
        await expect(isKisWsSupported()).resolves.toBe(true);
    });
});
