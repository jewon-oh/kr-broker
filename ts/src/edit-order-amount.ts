/**
 * @fileoverview `editOrder` 의 `amount` 대조(세 증권사 공용).
 *
 * ccxt 의 `editOrder(id, symbol, type, side, amount, price)` 에서 `amount` 는 정정 뒤 주문의 총수량(체결분 포함)이다. 국내 증권사의 정정
 * 요청으로 표현할 수 있는 것은 잔량 전부를 새 가격으로 옮기는 정정뿐이라, "amount − 체결 수량 = 잔량" 이 아닌 조합(수량을 줄이거나 늘리는
 * 정정)은 요청 전에 막는다. 잔량 일부만 옮기는 일부정정은 증권사 고유 기능이라 `params.partial` 로만 받는다.
 */

import { NotSupported } from './base/errors';
import { numberToString, Precise } from './base/functions/number';

/** 원주문의 체결 수량과 잔량. 조회로 얻는다. */
export interface EditOrderOriginal {
    filled?: number | undefined;
    remaining?: number | undefined;
}

/** 원주문의 총수량(체결 수량 + 잔량). 둘 중 하나라도 모르면 `undefined`. */
export function editOrderTotal(original: EditOrderOriginal): number | undefined {
    const { filled, remaining } = original;
    if (filled === undefined || remaining === undefined) return undefined;
    return Number(Precise.stringAdd(numberToString(filled), numberToString(remaining)));
}

/**
 * `amount` 가 원주문의 총수량과 같으면 지나가고, 다르면 요청 전에 `NotSupported` 다. 체결 수량이나 잔량을 모르면 대조할 수 없어 던진다.
 * 추정한 잔량으로 정정하지 않기 위해서다.
 */
export function assertWholeRemainingEdit(exchangeId: string, orderId: string, amount: number, original: EditOrderOriginal): void {
    const total = editOrderTotal(original);
    if (total === undefined) {
        throw new NotSupported(`${exchangeId} editOrder() 원주문 ${orderId} 의 체결 수량과 잔량을 몰라 amount 를 대조하지 못했다. amount 를 빼면 잔량 전부를 정정한다`);
    }
    if (Precise.stringEq(numberToString(amount), numberToString(total)) !== true) {
        throw new NotSupported(`${exchangeId} editOrder() 의 amount 는 정정 뒤 총수량(체결 ${original.filled} + 잔량 ${original.remaining} = ${total})이어야 한다: ${amount}. `
            + '수량을 바꾸는 정정은 한 요청으로 낼 수 없다. 취소한 뒤 다시 주문하거나, 증권사가 지원하면 params.partial 로 일부정정한다');
    }
}
