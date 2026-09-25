/**
 * @fileoverview KRX 주식 호가가격단위(세 증권사 공용).
 *
 * 한국거래소가 2023-01-25 부터 유가증권시장과 코스닥시장에 함께 적용하는 주식 호가가격단위 표다. 가격대마다 단위가 달라
 * ccxt 의 단일 `precision.price` 로 적을 수 없으므로 이 표로 판정한다. ETF·ETN 처럼 주식이 아닌 종목은 다른 표를 쓰므로 여기서 다루지 않는다.
 *
 * `priceToPrecision` 은 이 표로 반올림한다. 주문 경로는 가격을 바꾸지 않고, 일반 주식인 것을 알 때만 표에 맞지 않는 가격을 요청 전에 막는다.
 */

/** 가격 상한(미만)과 그 구간의 호가 단위. 낮은 구간부터 적는다. 50만원 이상은 `KRX_STOCK_TOP_TICK_SIZE` 다. */
export const KRX_STOCK_TICK_SIZES: readonly (readonly [number, number])[] = [
    [2_000, 1],
    [5_000, 5],
    [20_000, 10],
    [50_000, 50],
    [200_000, 100],
    [500_000, 500],
];

/** 마지막 구간(50만원 이상)의 호가 단위. */
export const KRX_STOCK_TOP_TICK_SIZE = 1_000;

/** 호가 단위에 맞지 않는 가격을 요청 전에 막을 때 `InvalidOrder` 의 `detail`. 토스가 같은 거절에 쓰는 코드와 같다. */
export const KRX_TICK_INVALID_DETAIL = 'price-tick-invalid';

/** 가격대의 호가 단위. */
export function getKrxTickSize(price: number): number {
    const row = KRX_STOCK_TICK_SIZES.find(([below]) => price < below);
    return row === undefined ? KRX_STOCK_TOP_TICK_SIZE : row[1];
}

/** 표에 맞지 않는 가격이면 막는 사유, 맞으면 `null`. 가격은 양의 정수이고 그 가격대 호가 단위의 배수여야 한다. */
export function krxTickViolation(price: number): string | null {
    const tick = getKrxTickSize(price);
    if (Number.isInteger(price) && price > 0 && price % tick === 0) return null;
    return `호가 단위에 맞지 않는 가격이다: ${price} (이 가격대의 호가 단위는 ${tick}원)`;
}
