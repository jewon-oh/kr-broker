/**
 * 빠른 시작 — 한국투자증권 모의계좌에 연결해 시세와 잔고를 읽고 주문을 낸다.
 *
 * 앱키와 시크릿은 KIS Developers에서 발급한다. 이 파일은 타입 검사 대상이라 README의 코드와 항상 같은 API를 쓴다.
 */
import { kis } from '../../ts/src';

const broker = new kis({
    apiKey: process.env.KIS_APP_KEY ?? '',
    secret: process.env.KIS_APP_SECRET ?? '',
    uid: process.env.KIS_ACCOUNT_NO ?? '', // 계좌번호. 예: 12345678-01
    sandbox: true, // 모의투자. 실전은 생략한다.
});

async function main(): Promise<void> {
    await broker.loadMarkets();

    const ticker = await broker.fetchTicker('005930/KRW');
    console.log(ticker.symbol, ticker.last, ticker.bid, ticker.ask);

    const balance = await broker.fetchBalance({ scope: 'kr' });
    console.log(balance.free, balance.total);

    const order = await broker.createOrder('005930/KRW', 'limit', 'buy', 1, 70000);
    console.log(order.id, order.status);
}

main().catch(console.error);
