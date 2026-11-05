/**
 * @fileoverview 확장세션 시장가 → 지정가 전환.
 *
 * 확장세션(프리/애프터·NXT)은 **지정가만 접수한다.** 그래서 확장세션의 시장가 주문은 최종가(`last`)를 지정가로 바꿔 낸다.
 * 토스증권과 한국투자증권 클래스가 이 구현 하나를 같이 쓴다.
 *
 * ## 두 가지 불변식
 *
 * 1. **중복 호가를 쌓지 않는다** — 같은 방향 미체결이 있으면 재발주하지 않는다.
 * 조회에 실패해도 발주하지 않는다(중복 누적이 미발주보다 나쁘다).
 * 2. **기준가를 못 구하면 발주하지 않는다** — 지정가를 지어내지 않는다.
 *
 * ## 낡은 미체결을 바꾸는 선택 동작
 *
 * 기본은 같은 방향 미체결이 있으면 건너뛰는 것이다. 그런데 그 미체결이 직전에 이 전환으로 낸 지정가라면, 가격이 움직인 뒤에도 첫 기준가에 묶여
 * 다음 시도가 계속 건너뛰어진다(청산이 장 마감 뒤 애프터마켓까지 밀린다). 호출하는 쪽이 `onDuplicate` 를 넘기면 건너뛰는 대신 그 훅이 정한다.
 * 훅은 같은 방향 미체결 목록과 현재 기준가를 받고, 새 지정가(`price`)나 보류 사유(`error`)를 돌려준다. 증권사 클래스가 정정·취소를 맡는다.
 */
import type { Order, OrderSide, Ticker } from './base/types';

/** 미체결 한 건. 건너뛸 때는 `id`·`side` 만 쓰고, 낡은 미체결을 바꿀 때(`onDuplicate`)는 나머지도 본다. */
export type ExtendedSessionOpenOrder = Pick<Order, 'id' | 'side'> & Partial<Pick<Order, 'price' | 'amount' | 'filled' | 'remaining'>>;

/** 전환에 필요한 최소 능력. 증권사 클래스 전체가 아니라 미체결 조회와 시세 조회만 본다(클래스 인스턴스를 그대로 넘겨도 된다). */
export interface ExtendedSessionQuoteSource {
    fetchOpenOrders(symbol: string): Promise<ExtendedSessionOpenOrder[]>;
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
    /**
     * 같은 방향 낡은 미체결을 바꿨다(`onDuplicate` 가 채운다). `edited` 면 그 주문을 새 가격으로 정정했으므로 새 주문을 내지 않고 정정된 주문(`order`)이
     * 결과다. `canceled` 면 취소를 확인했으므로 호출하는 쪽이 `price` 로 새 주문을 낸다.
     */
    replaced?: { orderId: string; action: 'edited' | 'canceled'; order?: Order | undefined };
}

/** `onDuplicate` 훅의 입력. 같은 방향 미체결 목록(비어 있지 않다)과 현재 기준가(최종가, 0 보다 크다). */
export interface ExtendedSessionDuplicate {
    open: ExtendedSessionOpenOrder[];
    price: number;
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
    onDuplicate?: (duplicate: ExtendedSessionDuplicate) => Promise<ExtendedSessionLimit>,
): Promise<ExtendedSessionLimit> {
    // 같은 방향 미체결 호가가 이미 있으면 재발주하지 않는다(호가 누적 방지).
    let duplicates: ExtendedSessionOpenOrder[] = [];
    try {
        const open = await source.fetchOpenOrders(order.symbol);
        duplicates = open.filter(o => (o.side ?? '').toLowerCase() === order.side);
    } catch (err) {
        // 조회 실패 시 발주를 막는다 — 중복 호가 누적이 미발주보다 나쁘다.
        onWarn?.(err, `${label} 확장세션 미체결 조회 실패 — 발주 보류`);
        return { error: '확장세션: 미체결 주문 조회 실패 — 중복 발주 위험으로 보류' };
    }
    const dup = duplicates[0];
    if (dup !== undefined && onDuplicate === undefined) {
        return { error: `확장세션 지정가 미체결 대기 중(${dup.id}) — 중복 발주 스킵` };
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
    // 낡은 미체결을 바꿀 수 있는 호출자는 훅이 정한다. 훅은 새 호가를 쌓지 않는다는 불변식을 지켜야 한다(정정하거나, 취소를 확인한 뒤에만 가격을 준다).
    if (dup !== undefined && onDuplicate !== undefined) return onDuplicate({ open: duplicates, price: last });
    return { price: last };
}
