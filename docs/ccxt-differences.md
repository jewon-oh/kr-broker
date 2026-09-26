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
| 기간 인자 | 기간 시작은 `since`(ms), 개수는 `limit`, 기간 끝은 `params.until`(ms)로 줍니다. 증권사 고유 조회도 이 규칙을 따릅니다. 예외는 README의 [기간 조회](../README.md#기간-조회)에 적었습니다 |
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
| 주문의 `params` | 거래소가 읽은 키를 뺀 나머지를 요청에 합칩니다. 뒤에 합친 값이 라이브러리가 계산한 필드를 덮을 수 있습니다 | 토스증권도 읽은 키를 뺀 나머지를 주문과 정정 본문 끝에 합칩니다. 다만 라이브러리가 인자로 채우는 필드(`symbol`, `side`, `orderType`, `quantity`, `orderAmount`, `price`, `confirmHighValueOrder`, 정정의 `orderId`)를 `params`로 주면 요청 없이 `BadRequest`를 던집니다. 돌려주는 주문과 실제 요청이 어긋나지 않게 하려는 것입니다. 한국투자증권과 KB증권은 ccxt처럼 `params`가 계산된 필드를 덮습니다 |
| 체결 내역(`fetchMyTrades`) | 체결 한 건이 거래 하나입니다 | 한국투자증권과 토스증권은 체결 단위 조회가 없어 주문 하나를 거래 하나로 돌려줍니다. 수량과 가격은 그 주문의 누적 체결 수량과 평균가이고, id 는 주문 단위라 체결이 늘면 같은 id 가 더 큰 수량으로 다시 나옵니다. 거래를 쌓을 때는 id 로 덮어씁니다. 한국투자증권 거래의 시각은 주문 시각이고 `since`는 조회 시작일로만 씁니다 |
| `editOrder`의 `amount` | 정정 뒤 주문의 수량입니다 | 같은 뜻(정정 뒤 주문의 총수량, 체결분 포함)입니다. 원주문을 조회해 체결 수량과 잔량의 합과 같을 때만 잔량 전부를 새 가격으로 정정하고, 다르면 요청 전에 `NotSupported`를 던집니다. KB증권 미국은 원주문의 체결 수량을 믿을 만한 조회로 확인할 수 없어, `amount`를 주면 요청 없이 `NotSupported`를 던집니다. 수량을 바꾸려면 취소한 뒤 다시 주문합니다. 잔량 일부만 새 가격으로 옮기는 일부정정은 한국투자증권과 KB증권 국내에서만 `params.partial: true`로 받고, 이때 `amount`는 옮길 수량입니다. 토스증권 국내는 일부 체결된 주문을 정정하지 않습니다. 한국투자증권 모의투자의 미국 정정은 대조할 조회가 없어 `amount` 대신 `params.amount`(정정 수량)를 받습니다 |
| 접수 여부를 모르는 주문 | 대응하는 오류 클래스가 없습니다 | `OrderOutcomeUnknown`을 던집니다. `RequestTimeout`의 하위 클래스이고 `retryable`이 `false`입니다 |
| 심볼 형식 | 대부분 암호화폐 쌍(`BTC/USDT`)입니다 | 국내는 `005930/KRW`, 미국은 `AAPL/USD`입니다. `BASE`는 종목코드나 티커입니다. 클래스 주식은 `BRK.B/USD`처럼 점으로 적고, 한국투자증권 종목 마스터의 `BRK/B` 표기도 같은 종목으로 받습니다. 현금 코드와 같은 티커는 종목 통합 코드 표(`commonStockCodes`)의 코드를 `BASE`로 씁니다. 표에는 미국 티커 `USD` 한 줄이 있어서 그 종목의 심볼은 `ProShares Ultra Semiconductors/USD`입니다. `market.id`와 `baseId`는 티커 `USD`로 남고, 입력은 `USD/USD`와 `USD`도 받습니다. 표는 생성자 인자 `commonStockCodes`로 덮습니다 |
| 호가단위 | 종목마다 `precision.price` 하나이고, 주문 경로가 가격을 이 값으로 반올림합니다 | 국내는 가격대별 호가단위라 `precision.price`를 비웁니다. `priceToPrecision()`은 세 증권사 모두 KRX 호가 단위 표로 반올림합니다. 주문 경로는 가격을 바꾸지 않고, 일반 주식인 것을 알 때 표에 맞지 않는 가격을 요청 전에 `InvalidOrder`로 막습니다 |
| 잔고 키 | 통화 코드를 키로 합니다. 현물 보유는 기초 통화 코드(`market.base`)로 실립니다. 두 자산이 같은 코드를 쓰면 한쪽의 통합 코드를 바꿉니다(`commonCurrencies`) | 현금은 통화(`KRW`, `USD`)를, 보유 종목은 `market.base`(국내 `005930`, 미국 `AAPL`, 클래스 주식 `BRK.B`)를 키로 합니다. 현금 코드와 같은 티커는 `commonStockCodes`의 코드를 키로 합니다. 미국 티커 `USD` 보유는 `ProShares Ultra Semiconductors` 키에, 달러 현금은 `USD` 키에 실립니다. ccxt의 `commonCurrencies`와 달리 이 표는 종목 코드에만 적용해서 같은 코드의 현금은 바꾸지 않습니다. 표에 없는 티커가 같은 잔고의 현금 키와 겹치면 한쪽을 덮어쓰지 않고 `NotSupported`를 던집니다. 그때는 `commonStockCodes`에 그 티커를 더합니다. 한국투자증권은 `params.scope`로, 토스증권은 `params.symbol`과 `params.currency`로 보유와 현금을 나눠 받을 수도 있습니다. KB증권에는 나눠 받는 인자가 없습니다 |
| 잔고 값(`free`, `used`, `total`) | `free`는 거래에 쓸 수 있는 양, `used`는 묶이거나 처리 중인 양, `total`은 `free + used`입니다. 거래소가 주지 않는 값은 비울 수 있습니다 | 뜻은 ccxt와 같습니다. `free`는 지금 주문에 쓸 수 있는 양, `total`은 정산이 끝난 뒤 계좌에 남을 양, `used`는 `total − free`입니다. 모르는 값은 0으로 채우지 않고 비웁니다. 보유 종목의 `total`은 보유 수량입니다. 보유 종목의 `free`는 한국투자증권이 주문가능수량(`ord_psbl_qty`, 행에 없으면 보유 수량), KB증권이 국내 주문가능수량(`ordr_psbl_q`)이고, KB증권 해외 보유는 비어 있습니다. 토스증권은 `params.symbol`로 한 종목만 받을 때 매도 가능 수량(`GET /sellable-quantity`)으로 채우고, 전체 잔고에서는 비웁니다. 현금의 `free`는 세 증권사 모두 주문 가능 금액입니다. 현금의 `total`은 한국투자증권 원화가 예수금총금액(`dnca_tot_amt`)이고 주문가능현금이 더 큰 날은 비웁니다. 한국투자증권 달러는 외화예수금이고, 달러 행이 없으면 `USD` 항목이 없습니다. KB증권 달러는 예수금(`tfnd`)이고 주문가능금액이 더 크면 비웁니다. 토스증권 현금과 KB증권 원화는 예수금을 읽지 않아 `total`과 `used`가 비어 있습니다 |
| 실주문 | `createOrder()`가 곧바로 주문을 냅니다 | 같습니다. 모의 서버가 있는 증권사는 한국투자증권 하나뿐입니다 |
| 휴장일 | 없습니다 | 증권사 캘린더 API로 판정합니다. `fetchMarketCalendar`가 있습니다 |
| 오류 필드 | 오류 클래스와 메시지입니다 | `detail`, `brokerCode`, `retryable`이 더 있습니다. `brokerCode`(Python 판 `broker_code`)는 증권사가 응답에 실어 보낸 원래 오류 코드입니다. 한국투자증권은 `msg_cd`, 토스증권은 오류 코드, KB증권은 `processCode`이고, 코드 표에 없는 코드도 싣습니다. 라이브러리가 요청 전에 막은 오류에는 없습니다. `detail`은 라이브러리가 가른 원인 이름입니다. 한국투자증권과 토스증권은 대개 `brokerCode`와 같고, KB증권은 정규화한 이름(`TOKEN_INVALID` 등)이라 표에 없는 코드나 일부 코드(`I446` 등)에서는 비어 있습니다. 요청 전에 막은 오류는 라이브러리가 정한 이름(`price-tick-invalid` 등)입니다. 원인으로 가를 때는 `detail`을, 증권사 코드로 가를 때는 `brokerCode`를 읽습니다 |
| 토큰 | 거래소 클래스마다 인증 방식이 다릅니다 | 토큰 발급에 잠금을 걸고 `options.tokenStore`로 프로세스 사이에서 공유합니다 |
| 실시간 지원 범위 | 거래소마다 `has`의 `watch*` 값이 다릅니다 | 한국투자증권과 토스증권이 `watch*`를 지원하고, KB증권은 웹소켓 API가 없습니다. 콜백으로 받는 `createPriceStream`도 있습니다. `watch*`에 ccxt에 없는 `params.signal`(`AbortSignal`)을 주면, 신호가 올 때 기다리던 호출이 `AbortError`로 끝납니다 |
| 결과 행의 시각 | 통합 구조(`Ticker`, `Trade`, `Order` 등)에 `timestamp`와 `datetime`이 있습니다 | 통합 구조는 같습니다. 다만 KB증권의 `Ticker`, `OrderBook`, `Order`, `Trade`는 응답의 시각 형식을 확인하지 못해 `timestamp`가 비어 있습니다. 시각으로 정렬하거나 `since`로 거르는 코드는 KB증권에서 쓸 수 없습니다. 증권사 고유 조회는 국내 행에만 `timestamp`를 넣고 해외 행은 날짜의 시간대를 확인하지 못해 비워 둡니다 |
| 추가 메서드 | 통합 메서드에 없습니다 | `fetchMarketCalendar`, `fetchInvestorTrading`, `fetchBuyableAmount` 등 증권사 고유 메서드가 있습니다. `has`에 올린 확장 메서드는 ccxt의 `has`처럼 세 증권사에서 같은 인자로 부르고 같은 모양을 받습니다. `fetchMarketCalendar(params)`는 세 증권사 모두 날짜별 개장 여부(`CalendarDay[]`)를 돌려주고, `fetchInvestorTrading(symbol, since, limit, params)`는 한국투자증권과 KB증권이 종목의 개인, 외국인, 기관 순매수 대금(`InvestorTradingRecord[]`)을 돌려줍니다. `fetchStockWarnings`는 토스증권만 `has`에 있습니다. `has`에 없는 고유 메서드는 이름이 같아도 증권사마다 인자와 결과가 다를 수 있습니다. 예를 들어 `fetchRankings`는 순위 종류(`type`)가 증권사마다 달라 `has`에 올리지 않았고, `fetchSellableQuantity`는 토스증권만 숫자를 돌려줍니다. 인자와 결과는 [증권사별 문서](brokers/README.md)에서 확인합니다 |
| Python 판의 타입 | Python 패키지에 `py.typed`가 없고, camelCase 별칭은 실행 중에만 붙습니다. 통합 구조의 숫자 필드는 `Decimal`을 포함한 `Num`입니다 | `py.typed`를 싣고, camelCase 별칭을 클래스마다 타입 검사기에만 보이는 블록(`if TYPE_CHECKING:`)에 선언합니다. `async with`는 호출한 클래스 타입을 돌려줍니다. 통합 구조의 숫자 필드는 TypeScript 판처럼 `float`입니다. 실행 동작은 ccxt와 같습니다 |
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
