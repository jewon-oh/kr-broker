/**
 * 증권사 클래스 **공통 계약 테스트 스위트**. 세 증권사(KB, KIS, 토스)가 같은 상황에서 같은 계약을 지키는지 같은 단언으로 본다.
 *
 * ccxt 는 거래소마다 구현이 달라도 호출하는 쪽이 같은 계약을 믿을 수 있게 한다. 이 스위트가 그 계약을 코드로 적은 것이다.
 * 증권사마다 다른 것은 **상황을 만드는 방법**(요청을 어떻게 가짜로 응답하는가)뿐이라, 그 부분만 `BrokerContractHarness` 로
 * 넘기고 단언은 이 파일 하나에 둔다. 증권사 테스트 파일은 자기 `vi.mock` 과 하네스를 준비해 `defineBrokerContractSuite` 를 부른다.
 *
 * ## 계약
 *
 * 1. 알려진 업무 오류는 증권사가 선언한 오류 클래스로 던져지고, 세부 원인 코드가 있으면 `detail` 에 남는다.
 * 2. 분류 밖의 업무 오류는 추측하지 않는다. `ExchangeError` 그 자체다(하위 클래스로 좁히지 않는다).
 * 3. 주문 요청이 연결 오류나 시간 초과로 끝나면 접수 여부를 모른다(`OrderOutcomeUnknown`). 원인 오류를 잃지 않고 주문을 다시 보내지 않는다.
 *    조회의 연결 오류는 `NetworkError` 이고 미확정이 아니다.
 * 4. 실패해도 원문 메시지를 잃지 않는다. 사람이 진단할 수 있다.
 * 5. 장 시간 밖은 실패가 아니라 예정된 조건이다. `MarketClosed` 이고 **주문 요청이 증권사에 나가지 않는다**.
 * 6. 조회가 실패하면 빈 값이 아니라 던진다. 실패와 "없음"을 가른다.
 * 7. 정상 주문은 접수 결과(`Order`)를 돌려준다. 모의 주문이 없어서 그대로 부르면 주문 요청이 정확히 한 번 나간다.
 * 8. 일괄 취소(`cancelAllOrders`)가 일부만 실패하면 던지지 않고 주문마다 결과를 돌려준다. 취소하지 못한 주문은 `canceled` 가 아니라
 *    원래 상태(`open`)이고 실패 사유(`info.cancelError`)를 싣는다. 항목은 미체결 조회로 받은 주문이라 수량과 방향을 잃지 않는다.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    BaseError, ExchangeError, MarketClosed, NetworkError, OrderOutcomeUnknown,
    type Balances, type Dict, type ErrorClass, type Order,
} from '../../base';

/** 증권사가 실측한 업무 오류 하나. 이 상황을 만들면 이 오류 클래스(와 세부 원인)로 던져져야 한다. */
export interface ClassifiedFailure {
    label: string;
    wire: () => void;
    error: ErrorClass;
    /** 증권사 오류 코드. 적으면 `error.detail` 이 이 값과 같아야 한다. */
    detail?: string;
}

/** 증권사마다 다른 "상황을 만드는 방법". */
export interface BrokerContractHarness {
    /** 테스트 이름에 쓰는 이름 */
    name: string;
    /** 각 테스트 앞에서 초기화한다(가짜 응답, 시각, 목 상태). */
    reset(): void;
    /** 주문 한 건을 낸다(장이 열려 있는 상태의 지정가 매수). 어떤 인자도 생략하지 않는다. */
    placeOrder(): Promise<Order>;
    /** 조회 한 건을 낸다(시세 한 종목). */
    fetchTicker(): Promise<unknown>;
    /** 잔고를 조회한다. */
    fetchBalance(): Promise<Balances>;
    /** 알려진 업무 오류 샘플들 */
    classified: ClassifiedFailure[];
    /** 증권사가 모르는 업무 오류로 주문이 거절되게 한다. */
    wireUnclassifiedBusinessError(): void;
    /** 주문 요청이 연결 오류로 실패하게 한다(`cause.code` 에 Node 오류 코드). */
    wireOrderNetworkFailure(code: string): void;
    /** 조회 요청이 연결 오류로 실패하게 한다. */
    wireReadNetworkFailure(code: string): void;
    /** 정상 접수로 응답하게 한다. */
    wireOrderAccepted(): void;
    /** 장을 열거나 닫는다. */
    setMarketOpen(open: boolean): void;
    /** 지금까지 증권사에 나간 **주문** 요청 수. 토큰·조회 요청은 세지 않는다. */
    orderRequestsSent(): number;
    /** 잔고 조회가 실패하게 한다. */
    wireBalanceFailure(): void;
    /** `cancelAllWithOneRejected` 가 쓰는 미체결 주문 두 건의 주문번호. */
    cancelAllTargets: { canceled: string; rejected: string };
    /** 미체결 주문 두 건 가운데 하나는 취소되고 하나는 증권사가 거절하게 한 뒤 `cancelAllOrders` 를 부른다. */
    cancelAllWithOneRejected(): Promise<Order[]>;
}

/** 던져진 값을 기다려 받는다. 던지지 않으면 실패로 취급한다. */
async function caught(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        return error as Error;
    }
    throw new Error('던져지지 않고 성공했다');
}

export function defineBrokerContractSuite(h: BrokerContractHarness): void {
    describe(`증권사 계약: ${h.name}`, () => {
        beforeEach(() => {
            h.reset();
        });

        describe('1. 알려진 업무 오류의 분류', () => {
            it.each(h.classified.map((c) => [c.label, c] as const))('%s', async (_label, sample) => {
                sample.wire();

                const error = await caught(h.placeOrder());

                expect(error).toBeInstanceOf(sample.error);
                if (sample.detail !== undefined) expect((error as BaseError).detail).toBe(sample.detail);
            });
        });

        describe('2. 분류 밖의 업무 오류는 추측하지 않는다', () => {
            it('ExchangeError 그 자체이고 장 시간 밖이나 미확정으로 좁히지 않는다', async () => {
                h.wireUnclassifiedBusinessError();

                const error = await caught(h.placeOrder());

                expect(Object.getPrototypeOf(error)).toBe(ExchangeError.prototype);
            });
        });

        describe('3. 연결 실패', () => {
            it.each(['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET'])('주문 요청이 연결 오류(%s)로 끝나면 OrderOutcomeUnknown 이고 원인을 잃지 않는다', async (code) => {
                h.wireOrderNetworkFailure(code);

                const error = await caught(h.placeOrder()) as OrderOutcomeUnknown;

                expect(error).toBeInstanceOf(OrderOutcomeUnknown);
                expect(error.retryable).toBe(false);
                expect(error.cause).toBeInstanceOf(Error);
            });

            it('접수 여부를 모르는 주문은 다시 보내지 않는다. 다시 보내면 중복 주문이다', async () => {
                h.wireOrderNetworkFailure('ECONNRESET');

                await caught(h.placeOrder());

                expect(h.orderRequestsSent()).toBe(1);
            });

            it('조회의 연결 오류는 NetworkError 이고 미확정이 아니다', async () => {
                h.wireReadNetworkFailure('ECONNRESET');

                const error = await caught(h.fetchTicker());

                expect(error).toBeInstanceOf(NetworkError);
                expect(error).not.toBeInstanceOf(OrderOutcomeUnknown);
            });
        });

        describe('4. 원문 메시지를 잃지 않는다', () => {
            it('업무 오류와 연결 오류 모두 비어 있지 않은 메시지를 싣는다', async () => {
                h.wireUnclassifiedBusinessError();
                const business = await caught(h.placeOrder());
                h.reset();
                h.wireOrderNetworkFailure('ECONNRESET');
                const network = await caught(h.placeOrder());

                expect(business.message.length).toBeGreaterThan(0);
                expect(network.message.length).toBeGreaterThan(0);
            });
        });

        describe('5. 장 시간 밖은 예정된 조건이다', () => {
            it('MarketClosed 이고 주문 요청이 증권사에 나가지 않는다', async () => {
                h.setMarketOpen(false);

                const error = await caught(h.placeOrder());

                expect(error).toBeInstanceOf(MarketClosed);
                expect(h.orderRequestsSent()).toBe(0);
            });

            it('장이 열려 있으면 MarketClosed 가 아니다. 진짜 실패와 섞이면 안 된다', async () => {
                h.setMarketOpen(true);
                h.wireUnclassifiedBusinessError();

                const error = await caught(h.placeOrder());

                expect(error).not.toBeInstanceOf(MarketClosed);
            });
        });

        describe('6. 조회 실패와 "없음"을 가른다', () => {
            it('잔고 조회가 실패하면 빈 잔고가 아니라 던진다', async () => {
                h.wireBalanceFailure();

                expect(await caught(h.fetchBalance())).toBeInstanceOf(BaseError);
            });
        });

        describe('8. 일괄 취소의 일부 실패', () => {
            it('던지지 않고 주문마다 결과를 돌려준다. 취소하지 못한 주문은 canceled 가 아니라 open 이고 사유를 싣는다', async () => {
                const results = await h.cancelAllWithOneRejected();

                const byId = new Map(results.map((order) => [order.id, order]));
                const canceled = byId.get(h.cancelAllTargets.canceled);
                const rejected = byId.get(h.cancelAllTargets.rejected);
                expect(results).toHaveLength(2);
                expect(canceled?.status).toBe('canceled');
                expect((canceled?.info as Dict).cancelResponse).toBeDefined();
                expect(rejected?.status).toBe('open');
                expect(String((rejected?.info as Dict).cancelError ?? '')).not.toBe('');
                for (const order of results) {
                    expect(order.amount).toBeGreaterThan(0);
                    expect(order.side).toBeDefined();
                }
            });
        });

        describe('7. 정상 주문', () => {
            it('접수 결과를 돌려주고 주문 요청이 정확히 한 번 나간다. 모의 주문이 없다', async () => {
                h.wireOrderAccepted();

                const order = await h.placeOrder();

                expect(order.id).toBeTruthy();
                expect(order.info).toBeDefined();
                expect(h.orderRequestsSent()).toBe(1);
            });
        });
    });
}
