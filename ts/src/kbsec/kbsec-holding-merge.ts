/**
 * @fileoverview 같은 종목의 보유 행을 하나로 합친다.
 *
 * KB 는 한 종목을 여러 행으로 줄 수 있다. 해외는 온주와 소수점 주가 따로 온다(sbih#6718 — XLE 11주와 0.1435주). 잔고는 종목 코드를 키로
 * 담으므로 그대로 대입하면 뒤의 행이 앞의 행을 지워 보유가 줄어 보인다. 실제로 11주가 조회에서 사라져 보유 동기화가 잡지 못했다.
 */

import { Precise, numberToString } from '../base';

/** 합칠 보유 행 — `kbsec.ts` 의 `HoldingRow` 와 같은 모양이다 */
export interface MergeableHolding {
    code: string;
    quantity: number;
    orderableQuantity?: number | undefined;
    averagePrice?: number | undefined;
    marketValue: number;
    name?: string | undefined;
}

const add = (a: number, b: number): number => Number(Precise.stringAdd(numberToString(a), numberToString(b)));

/**
 * 종목 코드(`keyOf` 로 정규화한 뒤)가 같은 행을 합친다. 수량과 평가금액은 더하고 평단은 수량 가중 평균이다.
 * 주문가능수량은 모든 행이 알 때만 더한다 — 한 행이라도 모르면 합도 모른다. 평단을 모르는 행이 섞이면 평단도 모른다(아는 행만으로
 * 평균을 내면 틀린 값이다). 순서는 처음 나온 순서를 지킨다.
 */
export function mergeHoldingRows<T extends MergeableHolding>(rows: readonly T[], keyOf: (code: string) => string = (code) => code): T[] {
    const byCode = new Map<string, T>();
    for (const row of rows) {
        const code = keyOf(row.code);
        const prev = byCode.get(code);
        if (prev === undefined) {
            byCode.set(code, { ...row, code });
            continue;
        }
        const quantity = add(prev.quantity, row.quantity);
        const bothPriced = prev.averagePrice !== undefined && row.averagePrice !== undefined;
        byCode.set(code, {
            ...prev,
            quantity,
            orderableQuantity: prev.orderableQuantity !== undefined && row.orderableQuantity !== undefined
                ? add(prev.orderableQuantity, row.orderableQuantity) : undefined,
            averagePrice: bothPriced && quantity > 0
                ? (prev.averagePrice! * prev.quantity + row.averagePrice! * row.quantity) / quantity : undefined,
            marketValue: prev.marketValue + row.marketValue,
            name: prev.name ?? row.name,
        });
    }
    return [...byCode.values()];
}
