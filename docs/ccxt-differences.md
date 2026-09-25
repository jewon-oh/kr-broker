# ccxt와 다른 점

`kr-broker` 라이브러리는 [ccxt](https://github.com/ccxt/ccxt)의 사용법을 따릅니다. ccxt 사용자는 같은 메서드 이름과 같은 인자 순서로 시작합니다. 같은 것과 다른 것을 나눠서 적었습니다.

현재 구현을 기준으로 적었습니다. ccxt 설명 중 확인하지 못한 것은 "확인 불가"로 적었습니다.

## ccxt와 같은 것

| 항목 | 내용 |
|---|---|
| 선언 구조 | `describe()`가 `id`, `name`, `urls`, `api`, `has`, `requiredCredentials`, `exceptions`, `precisionMode`를 선언합니다 |
| `has` | 메서드 이름을 키로 하고 값은 `true`, `false`, `'emulated'` 중 하나입니다 |
| 메서드 이름 | `loadMarkets`, `fetchMarkets`, `fetchTicker`, `fetchTickers`, `fetchOrderBook`, `fetchOHLCV`, `fetchBalance`, `createOrder`, `cancelOrder`, `cancelAllOrders`, `fetchOrder`, `fetchOrders`, `fetchOpenOrders`, `fetchClosedOrders`, `fetchMyTrades`, `fetchTradingFee`, `setSandboxMode` |
| 인자 순서 | `createOrder(symbol, type, side, amount, price, params)`, `fetchOHLCV(symbol, timeframe, since, limit, params)`, `fetchMyTrades(symbol, since, limit, params)`, `cancelOrder(id, symbol, params)` |
| 기간 인자 | 기간 시작은 `since`(ms), 개수는 `limit`, 기간 끝은 `params.until`(ms)로 줍니다. 증권사 고유 조회도 이 규칙을 따릅니다 |
| 자료 구조 | `Market`, `Ticker`, `OrderBook`, `Order`, `Trade`, `Balances`, `OHLCV` |
| 실시간 | `watchTicker`, `watchTrades`, `watchOrderBook`, `watchOrders`는 호출할 때마다 다음 갱신을 돌려줍니다. 다 쓰면 `close()`로 연결을 닫고, 기다리던 `watch*`는 `ExchangeClosedByUser`로 끝납니다. `close()`는 실시간 연결이 없는 증권사에도 있습니다 |
| 오류 계층 | `BaseError` 아래에 `ExchangeError`와 `OperationFailed` 두 갈래가 있고 클래스 이름이 같습니다 |
| `MarketClosed` | ccxt의 `OperationRejected` 아래에 있습니다 |
| 자격증명 | `apiKey`, `secret`, `uid` 필드와 `requiredCredentials`로 검사합니다 |
| 인스턴스 옵션 | `enableRateLimit`, `rateLimit`, `timeout`, `verbose`, `options.maxRetriesOnFailure`, `options.maxRetriesOnFailureDelay` |
| 정밀도 | `precisionMode`의 기본이 `TICK_SIZE`입니다. `decimalToPrecision`과 `Precise`를 ccxt에서 옮겨 왔습니다 |
| 마지막 요청 기록 | `last_request_url`, `last_request_headers`, `last_request_body`, `last_http_response` |

ccxt에 있는 오류 클래스 중 주식 거래에 필요한 것만 옮겼습니다. 전체 목록은 `ts/src/base/errors.ts`에 있습니다.

## ccxt와 다른 것

| 항목 | ccxt | `kr-broker` |
|---|---|---|
| 주문 재시도 | `maxRetriesOnFailure`로 재시도 횟수를 정합니다. 주문을 재시도에서 빼는 규칙이 있는지는 확인 불가입니다 | 주문 요청은 시간 초과나 연결 끊김 뒤에 `maxRetriesOnFailure`와 관계없이 다시 보내지 않습니다. 증권사가 처리 전에 거절한 두 경우만 예외입니다 |
| 체결 내역(`fetchMyTrades`) | 체결 한 건이 거래 하나입니다 | 한국투자증권과 토스증권은 체결 단위 조회가 없어 주문 하나를 거래 하나로 돌려줍니다. 수량과 가격은 그 주문의 누적 체결 수량과 평균가이고, id 는 주문 단위라 체결이 늘면 같은 id 가 더 큰 수량으로 다시 나옵니다. 거래를 쌓을 때는 id 로 덮어씁니다. 한국투자증권 거래의 시각은 주문 시각이고 `since`는 조회 시작일로만 씁니다 |
| `editOrder`의 `amount` | 정정 뒤 주문의 수량입니다 | 증권사마다 뜻이 다릅니다. 한국투자증권 국내는 `amount`만큼만 새 가격으로 옮기는 일부정정을 보냅니다(나머지 수량이 원래 가격에 남는다는 것은 공식 예제 설명에 기댄 추정입니다). KB증권 국내는 `params.partial: true`일 때만 일부정정하고, 없으면 `amount`를 무시하고 잔량 전체의 가격만 바꿉니다. 토스증권 국내는 `amount`를 정정 수량으로 보냅니다. 미국 정정은 KB증권과 토스증권이 가격만 바꿉니다 |
| 접수 여부를 모르는 주문 | 대응하는 오류 클래스가 없습니다 | `OrderOutcomeUnknown`을 던집니다. `RequestTimeout`의 하위 클래스이고 `retryable`이 `false`입니다 |
| 심볼 형식 | 대부분 암호화폐 쌍(`BTC/USDT`)입니다 | 국내는 `005930/KRW`, 미국은 `AAPL/USD`입니다. `BASE`는 종목코드나 티커입니다 |
| 호가단위 | 종목마다 `precision.price` 하나입니다 | 국내는 가격대별 호가단위라 `precision.price`를 비웁니다. 한국투자증권은 표로 반올림합니다 |
| 잔고 키 | 통화 코드를 키로 합니다 | 현금은 통화(`KRW`, `USD`)를, 보유 종목은 종목코드를 키로 합니다 |
| 실주문 | `createOrder()`가 곧바로 주문을 냅니다 | 같습니다. 모의 서버가 있는 증권사는 한국투자증권 하나뿐입니다 |
| 휴장일 | 없습니다 | 증권사 캘린더 API로 판정합니다. `fetchMarketCalendar`가 있습니다 |
| 오류 필드 | 오류 클래스와 메시지입니다 | `detail`과 `retryable`이 더 있습니다. 한국투자증권과 토스증권의 `detail`은 증권사 오류 코드입니다. KB증권의 `detail`은 정규화한 이름(`TOKEN_INVALID` 등)이고, 표에 없는 오류나 일부 코드(`I446` 등)에서는 비어 있습니다. KB증권의 원래 코드는 오류 메시지에 있습니다 |
| 토큰 | 거래소 클래스마다 인증 방식이 다릅니다 | 토큰 발급에 잠금을 걸고 `options.tokenStore`로 프로세스 사이에서 공유합니다 |
| 실시간 지원 범위 | 거래소마다 `has`의 `watch*` 값이 다릅니다 | 한국투자증권과 토스증권이 `watch*`를 지원하고, KB증권은 웹소켓 API가 없습니다. 콜백으로 받는 `createPriceStream`도 있습니다. `watch*`에 ccxt에 없는 `params.signal`(`AbortSignal`)을 주면, 신호가 올 때 기다리던 호출이 `AbortError`로 끝납니다 |
| 결과 행의 시각 | 통합 구조(`Ticker`, `Trade`, `Order` 등)에 `timestamp`와 `datetime`이 있습니다 | 통합 구조는 같습니다. 다만 KB증권의 `Ticker`, `OrderBook`, `Order`, `Trade`는 응답의 시각 형식을 확인하지 못해 `timestamp`가 비어 있습니다. 시각으로 정렬하거나 `since`로 거르는 코드는 KB증권에서 쓸 수 없습니다. 증권사 고유 조회는 국내 행에만 `timestamp`를 넣고 해외 행은 날짜의 시간대를 확인하지 못해 비워 둡니다 |
| 추가 메서드 | 통합 메서드에 없습니다 | `fetchMarketCalendar`, `fetchStockWarnings`, `fetchInvestorTrading`, `fetchRankings`, `fetchBuyableAmount` 등 증권사 고유 메서드가 있습니다. 이름이 같아도 증권사마다 인자와 결과가 다릅니다. `has`의 값은 메서드가 있다는 뜻일 뿐이고, 같은 코드로 부를 수 있다는 뜻은 아닙니다. 예를 들어 `fetchMarketCalendar`는 토스증권만 시장 인자를 받고, `fetchInvestorTrading`은 토스증권만 시장 단위(`KOSPI`, `KOSDAQ`)입니다. `fetchStockWarnings`는 KB증권만 객체 하나를 돌려주고, `fetchSellableQuantity`는 토스증권만 숫자를 돌려줍니다. 인자와 결과는 [증권사별 문서](brokers/README.md)에서 확인합니다 |
| 소스 문법 | ccxt는 TypeScript 소스를 다른 언어로 변환하므로 문법에 제한이 있습니다 | 변환하지 않으므로 옵셔널 체이닝, `??`, `private`, `override`, `declare`, `Map`, `Set`을 씁니다 |

### 주문 재시도

접수 여부를 모르는 주문을 다시 보내면 같은 주문이 두 번 접수될 수 있습니다. 이유와 예외는 [FAQ](faq.md)에 있습니다. 확인 절차는 [안전 가이드](SAFETY.md)에 있습니다.

### 실주문

ccxt와 마찬가지로 `createOrder()`는 확인 없이 주문을 냅니다. `has.sandbox`가 `true`인 증권사는 `kis` 하나입니다. 토스증권과 KB증권 인스턴스에서는 `setSandboxMode(true)`가 `NotSupported`를 던집니다.

### 호가단위

국내 호가단위 표와 예외는 [FAQ](faq.md)에 있습니다. 미국 종목은 0.01달러 단위입니다.

### 실시간 시세

`kis`와 `toss` 인스턴스는 ccxt Pro와 같은 `watchTicker`, `watchTrades`, `watchOrderBook`, `watchOrders`를 제공합니다. `watch*`는 처음 부를 때 구독합니다. 체결과 주문은 기다리는 호출이 없는 동안 쌓아 두었다가 다음 호출에 한꺼번에 돌려줍니다. 증권사마다 다른 점은 다음과 같습니다.

- 한국투자증권의 미국 종목은 지연 체결과 1단계 호가만 받습니다.
- 한국투자증권의 `watchOrders`는 체결통보를 HTS ID로 구독하므로 `options.htsId`가 필요합니다.
- 한국투자증권은 같은 앱키와 접속키로 이미 연결된 프로그램이 있으면 새 연결을 곧바로 끊습니다.
- 토스증권의 `watchTicker`는 체결 가격만 채웁니다.

실시간 데이터를 콜백으로 받으려면 `createPriceStream({ onTrade, onOrderbook })`을 씁니다. `kis`는 `KisPriceWs`를, `toss`는 `TossPriceWs`를 반환합니다. 토스증권은 본인 주문 이벤트(`onOrder`)도 받습니다. 구독은 `start(subs)`로 시작하고 `updateSubs(subs)`로 바꾸며 `stop()`으로 끝냅니다. `updateSubs`는 빠진 구독을 해지합니다. 한국투자증권은 구독이 거부되면 경고 로그를 남기고, `onSubscribeError`를 주면 그 콜백도 부릅니다. 한국투자증권의 다른 실시간 TR은 `createRealtimeStream(onRecord)`로 TR 번호를 지정해 구독합니다.

한국투자증권의 접속키는 `getApprovalKey()`가 발급합니다. KB증권 클래스에는 실시간 시세 기능이 없습니다.
