/**
 * @fileoverview 확장세션 시장가 → 지정가 전환.
 *
 * ## 왜 전환이 필요한가
 *
 * 확장세션(프리/애프터·NXT)은 **지정가만 접수한다.** 그래서 세션 게이트를 열어 줘도
 * 시장가 주문은 주문 형태에서 막히고, 그 결과 **확장세션 청산이 불가능**해진다.
 * 시장가를 그냥 거부하면 사유가 "지정가만 허용" 이라, 호출하는 쪽에서는 주문이
 * 나가지 않은 것처럼 보인다.
 *
 * ## 브로커마다 다르게 처리하면 안 된다
 *
 * 같은 상황에서 한 브로커는 지정가로 전환해 청산하고 다른 브로커는 거부하면,
 * 거부하는 쪽은 확장세션 청산이 불가능하다. 그래서 전환 로직을 이 파일에 두고
 * 토스증권과 한국투자증권 클래스가 같은 구현을 쓴다. 토스증권 구현을 **그대로**
 * 옮겼다. 이미 실제로 쓰이는 경로라서 동작을 바꾸지 않는 것이 이 추출의 조건이다.
 *
 * ## 두 가지 불변식
 *
 * 1. **중복 호가를 쌓지 않는다** — 같은 방향 미체결이 있으면 재발주하지 않는다.
 * 조회에 실패해도 발주하지 않는다(중복 누적이 미발주보다 나쁘다).
 * 2. **기준가를 못 구하면 발주하지 않는다** — 지정가를 지어내지 않는다.
 */
import type { Order, OrderSide, Ticker } from './base/types';

/** 전환에 필요한 최소 능력. 증권사 클래스 전체가 아니라 미체결 조회와 시세 조회만 본다(클래스 인스턴스를 그대로 넘겨도 된다). */
export interface ExtendedSessionQuoteSource {
    fetchOpenOrders(symbol: string): Promise<Array<Pick<Order, 'id' | 'side'>>>;
    fetchTicker(symbol: string): Promise<Pick<Ticker, 'last'>>;
}

/** 전환할 원 주문. 종목과 방향만 쓴다. */
export interface ExtendedSessionOrder {
    symbol: string;
    side: OrderSide;
}

export interface ExtendedSessionLimit {
    /** 산출된 지정가. `error` 가 있으면 없다. */
    price?: number;
    /** 발주를 보류해야 하는 사유. */
    error?: string;
}

/**
 * 확장세션 지정가 산출.
 *
 * @param source 미체결·시세를 조회할 증권사 클래스
 * @param order 원 주문 (symbol·side 사용)
 * @param label 로그 접두 (`[toss]` 등)
 * @param onWarn 조회 실패 경고 훅 — 호출하는 쪽의 로거를 그대로 쓰기 위해 주입받는다
 */
export async function buildExtendedSessionLimit(
    source: ExtendedSessionQuoteSource,
    order: ExtendedSessionOrder,
    label: string,
    onWarn?: (err: unknown, msg: string) => void,
): Promise<ExtendedSessionLimit> {
    // 같은 방향 미체결 호가가 이미 있으면 재발주하지 않는다(호가 누적 방지).
    try {
        const open = await source.fetchOpenOrders(order.symbol);
        const dup = open.find(o => (o.side ?? '').toLowerCase() === order.side);
        if (dup) {
            return { error: `확장세션 지정가 미체결 대기 중(${dup.id}) — 중복 발주 스킵` };
        }
    } catch (err) {
        // 조회 실패 시 발주를 막는다 — 중복 호가 누적이 미발주보다 나쁘다.
        onWarn?.(err, `${label} 확장세션 미체결 조회 실패 — 발주 보류`);
        return { error: '확장세션: 미체결 주문 조회 실패 — 중복 발주 위험으로 보류' };
    }

    // 시세 조회가 실패해도 기준가가 없는 경우와 같다. 지정가를 지어내지 않고 발주를 보류한다.
    let last: number | undefined;
    try {
        last = (await source.fetchTicker(order.symbol)).last;
    } catch {
        last = undefined;
    }
    if (last === undefined || !(last > 0)) {
        return { error: '확장세션: 기준가(last) 조회 실패 — 지정가 산출 불가' };
    }
    return { price: last };
}
