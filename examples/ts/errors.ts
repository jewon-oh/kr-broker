/**
 * 오류 처리 — 실패는 오류 클래스로 가른다. 재시도해도 되는 오류와 그렇지 않은 오류를 구분하는 것이 핵심이다.
 */
import { kis, InsufficientFunds, MarketClosed, NetworkError, OrderOutcomeUnknown, RateLimitExceeded } from '../../ts/src';

const broker = new kis({
    apiKey: process.env.KIS_APP_KEY ?? '',
    secret: process.env.KIS_APP_SECRET ?? '',
    uid: process.env.KIS_ACCOUNT_NO ?? '',
    sandbox: true,
});

async function buy(): Promise<void> {
    try {
        await broker.createOrder('005930/KRW', 'limit', 'buy', 1, 70000);
    } catch (error) {
        if (error instanceof MarketClosed) {
            console.log('장이 열리지 않았다. 개장 뒤에 다시 낸다.');
        } else if (error instanceof InsufficientFunds) {
            console.log('주문 가능 금액이 부족하다.');
        } else if (error instanceof OrderOutcomeUnknown) {
            // 요청이 시간 초과나 연결 끊김으로 끝나 접수됐는지 모른다. 다시 내면 중복 주문이 되므로 미체결 주문과 체결 내역을 먼저 확인한다.
            console.log('주문 접수 여부를 모른다. fetchOpenOrders로 확인한다.');
        } else if (error instanceof RateLimitExceeded || error instanceof NetworkError) {
            console.log('조회라면 잠시 뒤 다시 시도해도 된다.');
        } else {
            throw error;
        }
    }
}

buy().catch(console.error);
