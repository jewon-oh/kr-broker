# kr-broker

**한국 증권사 API를 ccxt처럼 쓰는 TypeScript 라이브러리**

[![CI](https://github.com/jewon-oh/kr-broker/actions/workflows/ci.yaml/badge.svg)](https://github.com/jewon-oh/kr-broker/actions/workflows/ci.yaml)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

한국투자증권(KIS), 토스증권, KB증권의 Open API를 같은 메서드와 같은 자료 구조로 사용합니다. 사용법은 [ccxt](https://github.com/ccxt/ccxt)를 따릅니다. `loadMarkets()`, `fetchTicker()`, `fetchBalance()`, `createOrder()`를 안다면 따로 배울 것이 거의 없습니다.

> [!IMPORTANT]
> 이 프로젝트는 증권사와 관계가 없는 비공식 라이브러리입니다. 투자 조언이 아니며, 사용해서 생긴 손실은 작성자가 책임지지 않습니다. 각 증권사의 약관은 [약관과 시세 데이터](#약관과-시세-데이터) 절에 정리했습니다.

## 특징

- **같은 사용법**: ccxt의 코드 패턴을 따릅니다. `describe()`, `has`, `urls`, `api`, `requiredCredentials`가 ccxt와 같습니다. `fetch*`, `create*`, `cancel*` 메서드도 같은 이름입니다.
- **통합 자료 구조**: `Market`, `Ticker`, `OrderBook`, `Order`, `Trade`, `Balances`, `OHLCV`를 증권사와 관계없이 같은 모양으로 반환합니다.
- **통합 심볼**: 국내는 `005930/KRW`, 미국은 `AAPL/USD` 형식을 사용합니다.
- **ccxt식 오류 계층**: ccxt의 오류 클래스를 그대로 사용합니다. `ExchangeError`, `InsufficientFunds`, `InvalidOrder`, `RateLimitExceeded`, `NetworkError` 등입니다. 주문 접수 여부를 모를 때 던지는 `OrderOutcomeUnknown`은 ccxt에 없는 오류입니다. 장이 닫혔을 때 던지는 `MarketClosed`는 ccxt와 같은 위치(`OperationRejected` 아래)에 있습니다.
- **접수 여부를 모르는 주문은 재시도하지 않습니다**: 조회 재시도 횟수는 `maxRetriesOnFailure` 옵션으로 정합니다. 주문 요청이 시간 초과나 연결 끊김으로 끝나면 재시도하지 않고 `OrderOutcomeUnknown`을 던집니다. 재시도하면 중복 주문이 되기 때문입니다. 증권사가 요청을 처리하기 전에 거절한 경우(토큰 무효, NXT 미상장)에만 다시 보냅니다.
- **휴장일은 증권사 API로 받습니다**: 직접 작성한 휴장일 표가 없습니다.
- **토큰과 호출 한도**: 토큰 발급에는 잠금을 걸고, 요청은 증권사별 호출 한도에 맞춰 보냅니다.
- **의존성**: 실시간 시세용 `ws` 하나입니다.

## 지원 증권사

| 증권사 | 클래스 | 모의투자 |
|---|---|---|
| 한국투자증권 | `kis` | `sandbox: true`로 연결합니다 |
| 토스증권 | `toss` | 없습니다 |
| KB증권 | `kbsec` | 없습니다 |

국내 주식과 미국 주식을 다룹니다.

### 기능별 지원

공식 API 대비 지원 비율은 `kis` 7.2%(24/334), `toss` 53.8%(21/39), `kbsec` 25.8%(24/93)입니다. 통합 메서드나 확장 메서드로 호출하는 API만 집계했습니다.

| 기능 | `kis` | `toss` | `kbsec` | 제약 |
|---|---|---|---|---|
| 현재가 `fetchTicker` | 지원 | 지원 | 지원 | `kis` 미국은 `masterData`가 필요합니다.<br>`toss` `last`와 `close`만 채웁니다. |
| 여러 종목 현재가 `fetchTickers` | 미구현 | 지원 | 증권사 없음 | `kis` 관심종목 멀티종목 시세 API가 있습니다.<br>`toss` 종목 지정이 필요합니다. 200건씩 나누어 호출합니다.<br>`kbsec` 여러 종목을 한 번에 조회하는 API가 없습니다. |
| 호가 `fetchOrderBook` | 부분 | 지원 | 지원 | `kis` 국내만 지원합니다. 미국 호가 API는 미구현입니다.<br>`toss` 무효 호가를 거르고 `limit`은 클라이언트에서 자릅니다. |
| 캔들 `fetchOHLCV` | 지원 | 부분 | 부분 | `kis` 야후 파이낸스에서 받습니다. 미국 일봉이 비면 한국투자증권 API로 받습니다.<br>`toss` 1분봉과 일봉만 받습니다. 미국은 확인하지 못했습니다.<br>`kbsec` 국내만 지원합니다. 코스닥은 `params.mkt_clsf`를 지정합니다. |
| 종목 목록 `fetchMarkets` | 지원 | 지원 | 미구현 | `kis` `masterData`가 필요합니다.<br>`toss` `taker`와 `maker`는 시장별 기본 위탁수수료율입니다.<br>`kbsec` 해외 종목 목록 API(`SIAM4983`)가 있습니다. 국내 종목 목록 API는 확인 불가입니다. |
| 실시간 시세 `createPriceStream` | 부분 | 미구현 | 증권사 없음 | `kis` 미국은 지연 체결만 받습니다.<br>`toss` 웹소켓 채널 3개가 있습니다.<br>`kbsec` 웹소켓 API가 없습니다. |
| 잔고 `fetchBalance` | 지원 | 지원 | 지원 |  |
| 수수료율 `fetchTradingFee` | 지원 | 지원 | 대체 | `kis` 고정 요율표를 사용합니다.<br>`toss` 조회한 뒤 24시간 캐시합니다.<br>`kbsec` 공시 요율로 추정합니다. |
| 매수 가능 금액 | 부분 | 지원 | 지원 | `kis` 국내 주문 가능 현금만 `fetchBalance`에 담습니다.<br>`toss` `fetchBalance`에 담습니다.<br>`kbsec` `fetchBuyableAmount`와 `fetchOverseasBuyableAmount`로 조회합니다. |
| 청구된 수수료와 거래세 | 미구현 | 증권사 없음 | 지원 | `kis` 기간 손익과 수수료 API가 있습니다.<br>`toss` 정산 조회 API가 없습니다. 주문 상세에 수수료와 세금이 있습니다.<br>`kbsec` `fetchDomesticSettlements`와 `fetchOverseasSettlements`로 조회합니다. |
| 지정가와 시장가 `createOrder` | 부분 | 지원 | 지원 | `kis` 미국은 지정가만 받습니다. 실전 시장가는 장마감지정가로 나갑니다. |
| 소수점 주문 | 증권사 없음 | 부분 | 부분 | `kis` 공식 API 목록에 소수점 주문이 없습니다.<br>`toss` 미국만 지원합니다.<br>`kbsec` 국내만 지원합니다. 취소와 조회는 없습니다. |
| 금액 기준 매수 `createMarketBuyOrderWithCost` | 증권사 없음 | 부분 | 미구현 | `kis` 공식 API 목록에 금액 주문이 없습니다.<br>`toss` 미국 시장가 매수만 지원합니다.<br>`kbsec` 미국 소수점 주문 API가 있습니다. 금액 지정 여부는 확인 불가입니다. |
| 조건과 트리거 주문 `createTriggerOrder` | 미구현 | 미검증 | 미구현 | `kis` 스탑지정가 인자 `CNDT_PRIC`을 보내지 않습니다. `createTriggerOrder`는 `NotSupported`를 던집니다.<br>`toss` `createTriggerOrder`나 `createOrder`의 `triggerPrice`로 냅니다. 국내 종목은 테스트로 확인했고 미국은 확인하지 못했습니다.<br>`kbsec` 주문 TR은 스톱지정가를 받습니다. 조건 주문 인자(`triggerPrice`, `stopPrice` 등)는 요청 전에 `NotSupported`로 거절합니다. |
| 정정 `editOrder` | 미구현 | 미구현 | 부분 | `kis` 정정 구분 `RVSE_CNCL_DVSN_CD=01`을 보내지 않습니다. `editOrder`는 `NotSupported`를 던집니다.<br>`toss` 국내는 수량과 가격, 미국은 가격만 정정하는 API가 있습니다. `editOrder`는 `NotSupported`를 던집니다.<br>`kbsec` 미국은 가격만 정정합니다. `price`가 없으면 요청 전에 `ArgumentsRequired`를 던집니다. |
| 취소 `cancelOrder` | 지원 | 지원 | 지원 | `toss` 조건 주문은 `params.trigger`로 취소합니다.<br>`kbsec` 전량 취소만 씁니다. |
| 전체 취소 `cancelAllOrders` | 대체 | 대체 | 대체 | `kis` 미국은 실전만 지원합니다.<br>`kbsec` 국내만 지원합니다. |
| 정규장 밖 주문 | 부분 | 지원 | 미구현 | `kis` 국내만 지원합니다. `options.nxtRouting`이 필요합니다.<br>`toss` 정수 지정가만 받습니다. 국내는 `options.nxtRouting`이 필요합니다.<br>`kbsec` 주문 TR이 시간외 시장을 받지만 세션 검사가 정규장 밖 주문을 막습니다. |
| 주문 조회 `fetchOrder` | 지원 | 지원 | 부분 | `kbsec` 미국은 체결 내역만 조회합니다. |
| 주문 목록 `fetchOrders` | 지원 | 증권사 없음 | 미구현 | `toss` 주문 목록 API는 상태(OPEN, CLOSED)를 지정해야 합니다.<br>`kbsec` `SSQM2341`의 체결구분 전체로 만들 수 있습니다. |
| 미체결 `fetchOpenOrders` | 부분 | 지원 | 부분 | `kis` 미국은 실전만 지원합니다.<br>`toss` 미체결 조건 주문은 100건씩 최대 10쪽(1,000건)까지 받습니다.<br>`kbsec` 국내만 지원합니다. `since`는 적용하지 않습니다. |
| 종료 주문 `fetchClosedOrders` | 대체 | 지원 | 미구현 | `kis` `fetchOrders` 결과에서 체결 완료만 고릅니다.<br>`toss` 100건씩 최대 10쪽을 받습니다.<br>`kbsec` `SSQM2341`로 만들 수 있습니다. 체결은 `fetchMyTrades`로 봅니다. |
| 체결 내역 `fetchMyTrades` | 지원 | 대체 | 지원 | `kis` `fee`가 비어 있습니다.<br>`toss` 주문 목록 API로 만듭니다. |
| 휴장일 `fetchMarketCalendar` | 부분 | 지원 | 부분 | `kis` 국내만, 실전만 지원합니다.<br>`toss` 세션 시각 원본을 반환합니다.<br>`kbsec` 국내만 지원합니다. |
| 종목 정보 `fetchStocks` | 미구현 | 지원 | 미구현 | `kis` 종목 상세 API `search-stock-info`를 암묵 API로만 호출합니다.<br>`toss` 200종목을 초과해도 나누어 호출하지 않습니다.<br>`kbsec` 종목기본정보 API `SIQM4900`이 있습니다. |
| 거래정지와 경고 `fetchStockWarnings` | 미구현 | 지원 | 미구현 | `kis` VI 현황 API `inquire-vi-status`가 있습니다.<br>`kbsec` `SIQM4900`이 매매제한과 위험등급을 줍니다. |
| 투자자별 매매동향 `fetchInvestorTrading` | 미구현 | 부분 | 미구현 | `kis` `inquire-investor`를 암묵 API로만 호출합니다.<br>`toss` 국내 시장 단위만 지원합니다.<br>`kbsec` 종목별 투자자 API `IVU10430`이 있습니다. |
| 종목 랭킹 `fetchRankings` | 미구현 | 지원 | 미구현 | `kis` 순위 API가 있습니다.<br>`kbsec` 순위 API가 있습니다. |

각 값의 뜻과 증권사별 공식 API 목록은 [docs/brokers/](docs/brokers/README.md)에 있습니다.

`has`는 메서드 단위라서 시장별 제약까지는 알려 주지 못합니다. 시장별 제약은 기능별 지원 표를 기준으로 삼으십시오.

`fetchMarketCalendar`는 세 증권사 모두 있지만 반환 형식이 다릅니다. 토스증권은 세션 시각 원본을, 한국투자증권과 KB증권은 날짜별 캘린더 목록을 반환합니다.

한국투자증권과 토스증권에서 정규장 밖 국내 주문을 내려면 `options.nxtRouting`을 켜야 하고, 지정가 주문만 받습니다. 토스증권은 미국도 정규장 밖에는 정수 수량의 지정가 주문만 받습니다. `options.usExtendedLimit`을 켜면 미국 정규장 밖의 시장가 주문을 지정가 주문으로 변환해 냅니다.

```ts
new kis({}).has.fetchOHLCV; // true, false, 'emulated' 중 하나
```

## 설치

npm에는 아직 게시하지 않았습니다. 저장소를 받아 빌드합니다.

```bash
git clone https://github.com/jewon-oh/kr-broker.git
cd kr-broker
pnpm install
pnpm build
```

Node.js 22 이상이 필요합니다.

## 빠른 시작

```ts
import { kis } from 'kr-broker';

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
```

**실주문이 기본입니다.** ccxt와 마찬가지로 `createOrder()`는 바로 주문을 냅니다. 한국투자증권은 `sandbox: true`로 모의투자 서버에 연결합니다. 토스증권과 KB증권은 모의 서버가 없어서 `setSandboxMode(true)`가 `NotSupported`를 던집니다. 처음에는 소액이나 모의계좌로 확인하십시오.

## 사용법

### 시장과 심볼

`loadMarkets()`가 종목 목록을 불러와 인스턴스에 저장합니다. KB증권은 종목 목록 API를 아직 쓰지 않습니다. 그래서 심볼 형식으로 종목을 판별하고, `loadMarkets()`는 요청 없이 끝납니다. 심볼은 `BASE/QUOTE` 형식이고 국내는 종목코드 6자리에 `/KRW`, 미국은 티커에 `/USD`를 붙입니다. 알 수 없는 심볼은 `BadSymbol`입니다.

### 잔고

`fetchBalance()`는 ccxt의 `Balances`를 반환합니다. 현금은 통화(`KRW`, `USD`)를 키로 하고, 보유 종목은 종목코드를 키로 합니다. `total`은 수량입니다. 평균단가와 평가금액 같은 증권사 고유 값은 각 항목의 `info`에 있습니다. 조회에 실패하면 빈 잔고가 아니라 오류를 던집니다.

### 주문

```ts
import { toss } from 'kr-broker';

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
```

`createOrder(symbol, type, side, amount, price?, params?)`로 주문합니다. `type`은 `'limit'`과 `'market'`, `side`는 `'buy'`와 `'sell'`입니다. 증권사 고유 옵션은 `params`로 전달합니다. 한국투자증권은 정수 주 단위라서 소수 수량을 내림합니다.

### 오류

```ts
import { kis, InsufficientFunds, MarketClosed, NetworkError, OrderOutcomeUnknown, RateLimitExceeded } from 'kr-broker';

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
```

| 오류 | 뜻 | 재시도 |
|---|---|---|
| `NetworkError`, `RequestTimeout` | 조회 요청이 끊기거나 시간 초과 | `maxRetriesOnFailure` 횟수만큼 다시 보냅니다(기본 0, 한국투자증권은 3) |
| `RateLimitExceeded` | 호출 한도 초과 | 잠시 뒤 |
| `AuthenticationError`, `PermissionDenied` | 키가 틀렸거나 권한이 없음 | 하지 않습니다 |
| `InsufficientFunds`, `InvalidOrder` | 잔고나 주문 값 문제 | 하지 않습니다 |
| `MarketClosed` | 장 시간 밖이거나 휴장일 | 개장 뒤 |
| `OrderOutcomeUnknown` | 주문 접수 여부를 모름 | **재시도하지 않습니다.** 미체결 주문과 체결 내역으로 확인합니다 |

### 휴장일과 장 시간

```ts
import { kis, checkKRXTradingHoursAt, isKrxBusinessDayKst, marketCalendarStatus } from 'kr-broker';

const broker = new kis({
    apiKey: process.env.KIS_APP_KEY ?? '',
    secret: process.env.KIS_APP_SECRET ?? '',
    uid: process.env.KIS_ACCOUNT_NO ?? '',
});

async function main(): Promise<void> {
    // 증권사 캘린더 API를 불러 공용 캘린더를 채운다. 실주문 직전에도 자동으로 갱신하지만, 주문 밖에서 장 시간을 판정하려면 시작할 때 부른다.
    await broker.refreshMarketCalendar();

    const now = new Date();
    console.log(checkKRXTradingHoursAt(now)); // { tradable, reason }
    console.log(isKrxBusinessDayKst('20261005')); // KST 날짜가 영업일인가
    console.log(marketCalendarStatus('KR')); // 캘린더를 몇 일치 알고 있는가
}

main().catch(console.error);
```

한국 휴장일은 계산으로 구할 수 없습니다. 설날과 추석은 음력이고 임시공휴일은 수시로 지정됩니다. 그래서 이 라이브러리에는 휴장일 표가 없고, 증권사 캘린더 API를 호출합니다. 한국투자증권은 국내 휴장일 조회 API, 토스증권은 시장 캘린더 API, KB증권은 영업일 조회 API를 사용합니다. 캘린더에 없는 날짜는 주말만 휴장으로 보고 평일은 영업일로 봅니다. 이때 그 달에 한 번 경고를 남깁니다.

### 인스턴스 옵션

`new kis({ ..., enableRateLimit, rateLimit, timeout, orderTimeout, options })`로 조정합니다.

| 옵션 | 기본값 | 뜻 |
|---|---|---|
| `enableRateLimit` | `true` | 요청 사이에 대기해 호출 한도를 지킵니다 |
| `rateLimit` | 증권사별 | 요청 간격(ms). 엔드포인트마다 `cost`를 곱합니다 |
| `timeout` | 조회 상한 | 조회 요청 시간 상한(ms) |
| `options.maxRetriesOnFailure` | `0` | 조회 재시도 횟수입니다. 한국투자증권은 기본 `3`입니다. 주문 요청은 시간 초과나 연결 끊김 뒤에 재시도하지 않습니다 |
| `orderTimeout` | 주문 상한 | 주문 요청 시간 상한(ms). 넘으면 `OrderOutcomeUnknown` |
| `options.tokenStore` | 없음 | 접근 토큰과 발급 잠금을 여러 프로세스가 나눠 쓰는 저장소(`BrokerTokenStore`)입니다. 없으면 프로세스 메모리 캐시만 사용합니다. 함수를 전달하면 사용할 때마다 호출합니다 |
| `options.nxtRouting` | `false` | 정규장 밖(넥스트레이드 프리마켓과 애프터마켓) 국내 주문을 허용합니다(한국투자증권과 토스증권). KB증권에서는 정규장 안에서 주문을 SOR로 보내는 데만 사용하고 정규장 밖은 허용하지 않습니다. 불리언이거나 불리언을 반환하는 함수입니다 |
| `options.krwIntegratedMargin` | `false` | 통합증거금 계좌의 미국 주식 매수여력을 원화 예수금 환산분으로 보강합니다(토스증권과 KB증권) |
| `options.usExtendedLimit` | `false` | 미국 정규장 밖에서 시장가 주문을 지정가 주문으로 변환해 냅니다(토스증권) |
| `options.usdKrwRate` | 없음 | 1달러당 원화를 반환하는 `() => Promise<number>`입니다. 원화 환산에 사용합니다(토스증권과 KB증권) |
| `options.masterData` | 빈 데이터 | 한국투자증권 종목 마스터 파일을 옮긴 `KisMasterData`입니다. 종목 검색과 해외 거래소 판별에 사용합니다(한국투자증권과 KB증권) |
| `options.stockDirectory` | 없음 | 국내 종목이 코스피인지 코스닥인지 알려 주는 `BrokerStockDirectory`입니다. 없으면 마스터 데이터로 판별합니다(한국투자증권) |
| `options.confirmBudget` | `{ attempts: 6, intervalMs: 350 }` | 주문 접수 뒤 체결을 확정하려고 조회하는 횟수와 간격입니다(토스증권과 KB증권). KB증권 국내 주문은 `{ attempts: 5, intervalMs: 1000 }`이 기본입니다. 한국투자증권은 이 옵션을 읽지 않습니다. 객체이거나 객체를 반환하는 함수입니다 |
| `options.confirmExecution` | `true` | `false`면 접수 뒤 체결 조회를 하지 않습니다(토스증권) |

설정은 전부 인스턴스가 받습니다. 환경 변수는 읽지 않습니다. 라이브러리 전체에 적용되는 설정은 로거 하나뿐입니다. 기본 로거는 아무것도 출력하지 않습니다. `setLogger({ debug, info, warn, error })`로 원하는 로거를 전달합니다.

## 알려진 한계

- 한국투자증권의 미국 주식 주문은 지정가만 받습니다. 실전에서 시장가로 주문하면 장마감지정가(LOC) 주문으로 나갑니다.
- 토스증권의 캔들과 조건 주문은 국내 종목 테스트로만 확인했습니다. 미국 종목은 확인하지 못했습니다.
- 토스증권 미체결 조건 주문은 100건씩 최대 10쪽(1,000건)까지 받습니다. 넘으면 로그를 남기고 나머지는 자릅니다. `fetchOpenOrders`와 `includeTrigger`를 켠 `cancelAllOrders`가 이 범위를 대상으로 합니다.
- 한국투자증권 캔들은 증권사 API가 아니라 야후 파이낸스에서 받습니다. 미국 일봉, 주봉, 월봉이 비어 있으면 한국투자증권 API로 다시 받습니다.
- KB증권 캔들은 코스피를 기본으로 조회합니다. 코스닥 종목은 `params.mkt_clsf = '1'`을 전달합니다.
- KB증권은 조건 주문을 지원하지 않습니다. `createOrder`에 `triggerPrice`, `stopPrice`, `stopLossPrice`, `takeProfitPrice`를 전달하면 요청을 보내기 전에 `NotSupported`를 던집니다.
- KB증권 미체결 행에는 주문 시각이 없어서 `fetchOpenOrders`는 `since`를 적용하지 않습니다. `since`를 전달해도 미체결 전체를 반환합니다.
- 국내 호가단위는 가격대별이라 ccxt의 단일 `precision.price`로 표현할 수 없습니다.
- 실계좌 검증은 만든 사람이 가진 계좌로 확인한 범위까지만 했습니다.

## 약관과 시세 데이터

이 저장소는 시세 데이터를 포함하지 않습니다. 받아 사용하는 시세와 계좌 정보에는 각 증권사의 약관이 적용됩니다.

- 한국투자증권: 오픈 API 서비스 이용 약관(고객, 2022-10-01 시행)이 적용됩니다. 제5조는 시세정보를 고객이 직접 개발한 프로그램 등 개인의 업무에만 쓰게 합니다. 제3자에게 제공하는 것은 금지합니다. 앱키와 시크릿키는 제3자에게 대여하거나 위임하거나 누설할 수 없습니다. 제9조에 따라 서버에 일정 수준 이상의 부하를 주면 증권사가 이용을 중지할 수 있습니다.
- 토스증권: 오픈 API 서비스 이용 약관(2026-08-12 개정본)이 적용됩니다. 국내와 해외 주식 시세를 개인투자자 본인의 매매 목적에만 쓰게 합니다. 제3자 제공과 배포, 상업적 이용은 금지합니다. 법인 고객은 대상이 아닙니다.
- KB증권: Open API 서비스 이용약관(일반 고객용, 2026-07-16 제정)이 적용됩니다. 제5조는 시세정보를 본인 자산의 투자 목적에만 쓰게 합니다. 제3자에게 분배, 제공, 재전송, 판매, 배포하는 것은 금지합니다. 투자정보나 자문 서비스, 웹사이트나 모바일 앱 제공, 계좌대여업 같은 상업적이거나 불법적인 용도도 금지합니다.

세 약관 모두 코드를 소스로 공개하는 일 자체를 제한하는 조항은 없었습니다. 받은 시세를 다른 사람에게 제공하거나 서비스로 판매해서는 안 됩니다. 남의 계좌를 대신 운용하거나 투자 판단을 제공하는 서비스에는 금융투자업 인가나 등록이 필요할 수 있습니다. 서비스를 만들기 전에 전문가와 상의하십시오.

약관은 바뀌므로 쓰기 전에 최신 약관을 확인하십시오. 작성자가 읽은 것은 개인 고객용 약관입니다. 법인 고객용이나 제휴 기관용 약관은 읽지 않았습니다. 이 절은 법률 자문이 아닙니다.

## 개발

```bash
pnpm install
pnpm typecheck   # 소스, 테스트, 예제까지 타입 검사
pnpm test
pnpm build
```

`examples/`의 파일은 타입 검사 대상이라 README의 코드와 항상 같은 API를 사용합니다.

기여는 [기여 안내](CONTRIBUTING.md), 보안 신고는 [보안 정책](SECURITY.md), 그 밖의 안내는 [문서](docs/README.md)를 보십시오.

## 면책

이 소프트웨어는 있는 그대로 제공되며 어떠한 보증도 하지 않습니다. 이 저장소는 KB증권, 한국투자증권, 토스증권과 아무 관계가 없으며, 세 증권사는 이 코드를 보증하지 않습니다. 회사명과 서비스명은 각 소유자의 상표이며 어느 회사의 API인지 밝히는 용도로만 사용합니다. 투자 손실을 포함해 이 코드를 사용해 생긴 결과는 사용자가 책임집니다.

## 라이선스

MIT License입니다. 자세한 내용은 [LICENSE](LICENSE)를 보십시오. `src/base/`는 ccxt(MIT)의 구조를 따르고 일부 코드를 옮겼습니다. 고지문은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.
