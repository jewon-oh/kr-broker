/**
 * 주문 관리 — 미체결 주문을 조회하고 취소하며, 체결 내역을 읽는다. 토스증권 예제이고 다른 증권사도 같은 메서드를 쓴다.
 */
import { toss } from '../../ts/src';

const broker = new toss({
    apiKey: process.env.TOSS_CLIENT_ID ?? '',
    secret: process.env.TOSS_CLIENT_SECRET ?? '',
    uid: process.env.TOSS_ACCOUNT_SEQ,
});

async function main(): Promise<void> {
    await broker.loadMarkets();

    // 미체결 주문. 종목을 주면 그 종목만 돌려준다.
    const open = await broker.fetchOpenOrders('005930/KRW');
    for (const order of open) console.log(order.id, order.side, order.amount, order.price, order.status);

    // 미체결 주문 하나를 취소한다.
    const first = open[0];
    if (first?.id) await broker.cancelOrder(first.id, first.symbol);

    // 최근 체결 내역.
    const trades = await broker.fetchMyTrades('005930/KRW', undefined, 20);
    for (const trade of trades) console.log(trade.datetime, trade.side, trade.amount, trade.price, trade.fee);
}

main().catch(console.error);
