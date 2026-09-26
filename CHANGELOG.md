# 변경 이력

이 파일은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따르고, 버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다. 0.x에서 버전을 올리는 규칙은 [버전 정책](docs/versioning.md)에 있습니다.

## [Unreleased]

### 바뀜(호환되지 않음)

- `editOrder`의 `amount`를 ccxt와 같이 정정 뒤 주문의 총수량(체결분 포함)으로 받습니다. 원주문을 조회해 체결 수량과 잔량의 합과 같을 때만 잔량 전부를 새 가격으로 정정하고, 다르면 정정 요청 없이 `NotSupported`를 던집니다. 한국투자증권 국내에서 `amount`로 일부정정하던 코드는 `params.partial: true`를 더합니다. 토스증권 국내는 `amount` 없이도 부를 수 있고, 일부 체결된 주문은 정정하지 않고 `NotSupported`를 던집니다. 한국투자증권 모의투자의 미국 정정은 `amount` 대신 `params.amount`를 씁니다. KB증권 미국 정정은 원주문의 체결 수량을 확인할 믿을 만한 조회가 없어, `amount`를 주면 요청 없이 `NotSupported`를 던집니다. `amount`를 빼면 잔량 전부의 가격만 정정합니다.
- 한국투자증권이 국내 15:20~15:30과 미국 15:50~16:00(ET)의 신규 매수를 기본으로 보냅니다. 예전처럼 막으려면 `options.blockAuctionBuys`를 켭니다. 한국투자증권의 미국 주문과 정정은 09:25~09:30(ET)에 요청 없이 `MarketClosed`를 던집니다.
- 토스증권과 KB증권 `editOrder`가 장 시간을 판정합니다. 장 밖이면 원주문 조회와 정정 요청을 보내지 않고 `MarketClosed`를 던집니다. 예전에는 장 밖에도 정정 요청을 보냈습니다. 판정은 각 증권사의 `createOrder`와 같습니다. 토스증권은 장 운영 캘린더로 판정하고, 국내 프리마켓과 애프터마켓은 `nxtRouting`을 켰을 때만 엽니다. 확장세션에서는 지정가 정정만 보냅니다. KB증권은 국내 KRX 정규장과 미국 정규장만 엽니다. 미국 종목은 `options.masterData`에서 상장 거래소를 찾지 못하면 막습니다. 정정은 신규 매수가 아니므로 `blockAuctionBuys`를 켜도 동시호가 시간의 정정은 막지 않습니다. 토스증권의 조건주문 정정(`params.trigger: true`)은 예전처럼 게이트를 거치지 않습니다. 토스증권은 Python 판도 같습니다.
- 한국투자증권 `cancelAllOrders`는 일부 주문을 취소하지 못해도 던지지 않습니다. 예외로 실패를 잡던 코드는 반환 항목의 `status`를 봅니다. 세 증권사 모두 항목은 미체결 조회로 받은 주문입니다. 취소 응답 원문은 `info.cancelResponse`에, 실패 사유는 `info.cancelError`와 `info.cancelErrorDetail`에 있습니다.
- 토스증권과 KB증권의 `priceToPrecision`이 국내 주식 가격을 KRX 호가 단위 표로 반올림합니다(70030 → 70000). 세 증권사 모두 종목이 일반 주식인 것을 알면, 호가 단위에 맞지 않는 국내 지정가를 요청 전에 `InvalidOrder`(`detail: 'price-tick-invalid'`)로 막습니다. 주문 가격은 바꾸지 않습니다. KB증권이 서버에서 받은 거절은 예전처럼 `detail`이 `PRICE_INVALID`입니다.
- 토스증권 `createOrder`와 `editOrder`는 `params`에서 읽지 않은 키를 요청 본문에 합칩니다. 라이브러리가 인자로 채우는 필드(`symbol`, `side`, `orderType`, `quantity`, `orderAmount`, `price`, `confirmHighValueOrder`, 정정의 `orderId`)를 `params`로 주면 요청 없이 `BadRequest`를 던집니다. `editOrder`에 ccxt 조건 인자(`stopPrice` 등)를 주면 요청 없이 `NotSupported`를 던집니다.
- 잔고의 보유 종목 키를 `market.base`로 맞춥니다. 한국투자증권 해외 슬래시 티커의 키가 `BRK/B`에서 `BRK.B`로 바뀝니다. 예전에는 `balance[market.base]`로 찾으면 보유가 없다고 읽혔습니다. Python 판도 같습니다.
- 세 증권사 `fetchBalance`는 같은 잔고 안에서 보유 종목 키가 현금 키(`KRW`, `USD`)와 겹치면 `NotSupported`를 던집니다. 예전에는 미국 티커 `USD`를 가진 계좌에서 한쪽이 사라졌습니다. 한국투자증권과 토스증권은 달러 현금이 보유를 덮었고, KB증권은 보유 수량이 `balance.USD`에 들어갔습니다. 이제 그 종목은 아래 항목의 통합 코드로 실리므로 겹치지 않습니다. 이 검사는 종목 통합 코드 표에 없는 티커가 새로 겹칠 때 알리는 안전장치로 남습니다. 한국투자증권은 미국 보유(`'us'`)와 달러 현금(`'usd'`)을 `params.scope`로 나눠 받습니다. 토스증권은 `params.symbol`과 `params.currency`로 나눠 받습니다. KB증권에는 나눠 받는 인자가 없습니다.
- 미국 티커 `USD`(ProShares Ultra Semiconductors)처럼 현금 코드와 같은 티커는 통합 코드를 종목 이름으로 바꿉니다. ccxt의 `commonCurrencies`와 같은 방식이지만 종목 코드에만 적용하므로 달러 현금은 그대로 `USD`입니다. 세 증권사 모두 그 종목의 심볼은 `USD/USD`에서 `ProShares Ultra Semiconductors/USD`로 바뀝니다. `market.base`와 잔고 키는 `ProShares Ultra Semiconductors`입니다. `market.id`와 `baseId`는 `USD`로 남고, 증권사에 보내는 종목 코드도 `USD`입니다. 입력은 새 심볼과 함께 `USD/USD`와 `USD`도 받으므로 주문하는 코드는 고치지 않아도 됩니다. 결과의 심볼이나 잔고 키에서 `USD`를 찾던 코드는 새 코드로 찾고, 티커가 필요하면 `market(key).id`를 씁니다. KB증권도 그 종목을 가진 계좌의 잔고를 돌려줍니다. 한국투자증권 `fetchOHLCV`는 야후 조회 함수에 통합 심볼 대신 티커를 넘깁니다. Python 판도 같습니다.
- 잔고의 `free`, `used`, `total`을 ccxt의 뜻으로 맞춥니다. `free`는 지금 주문에 쓸 수 있는 양, `total`은 정산이 끝난 뒤 계좌에 남을 양, `used`는 `total − free`입니다. 모르는 값은 0이나 다른 값으로 채우지 않고 비웁니다. 현금을 `total`로 읽던 코드는 `free`나 `info`의 예수금(KB증권은 `balances.info.deposit`)을 읽도록 바꿉니다. 한국투자증권과 토스증권은 Python 판도 같습니다.
- 한국투자증권 `fetchBalance`는 원화 주문가능현금이 예수금총금액보다 큰 날 `KRW`의 `total`과 `used`를 비웁니다. 예전에는 `total`이 `free`보다 작고 `used`가 0이었습니다. 달러 예수금 행이 없으면 `USD` 항목을 싣지 않습니다. 예전에는 0을 실었습니다.
- 토스증권 `fetchBalance`는 현금의 `total`과 `used`를 비웁니다. 예전에는 `total`에 매수 가능 금액을, `used`에 0을 실었습니다. 전체 잔고의 보유 종목도 `free`와 `used`를 비웁니다. `params.symbol`로 한 종목만 받으면 매도 가능 수량(`GET /sellable-quantity`)을 한 번 더 조회해 `free`로 씁니다. `fetchSellableQuantity`는 응답에 값이 없으면 0 대신 `BadResponse`를 던집니다.
- KB증권 `fetchBalance`는 `KRW`의 `total`과 `used`를 비웁니다. 국내 보유 종목의 `free`는 주문가능수량(`ordr_psbl_q`)이고, 해외 보유 종목의 `free`는 비웁니다. 예전에는 둘 다 보유 수량이었습니다. `USD`는 주문가능금액이 예수금보다 크면 `total`과 `used`를 비웁니다. `krwIntegratedMargin`으로 환산한 `USD`에는 `free`만 싣습니다.
- 토스증권 `cancelOrder`는 취소를 접수한 뒤 원주문의 상세(`GET /orders/{orderId}`)를 조회해 상태를 확인합니다. 예전에는 접수만 되면 `status: 'canceled'`를 돌려줬지만, 명세에서 취소는 `PENDING_CANCEL`을 거쳐 끝납니다. 원주문이 `CANCELED`면 `canceled`, `REJECTED`면 `rejected`입니다. 취소가 닿기 전에 전량 체결됐으면(`FILLED`) `closed`입니다. 예산 안에 확정되지 않거나 조회가 실패하거나 `confirmExecution`이 꺼져 있으면 `status`를 비웁니다. 취소가 거절되면 원주문이 이전 상태로 돌아가 아직 반영되지 않은 것과 구별할 수 없으므로, 이때도 `rejected`가 아니라 빈 값입니다. `status === 'canceled'`로 취소 성공을 세던 코드는 빈 `status`를 "모름"으로 다루고 `fetchOrder`로 확인합니다. 조회는 `createOrder`의 체결 확인과 같은 옵션(`confirmExecution`, `confirmBudget`)을 따릅니다. 조회마다 주문 내역 호출 한도(`order_history`)를 씁니다. `params.confirmExecution: false`로 호출마다 끌 수도 있습니다. 새 주문번호는 `info.orderId`에, 조회한 원주문은 `info.order`에 있습니다. `cancelAllOrders`의 항목도 같은 상태를 쓰고 확정 조회를 주문마다 합니다. 미확정 주문이 10건이면 조회가 최대 60회 늘어 기본 예산에서 15초 넘게 걸릴 수 있습니다. 조건주문 취소는 예전처럼 `canceled`입니다. Python 판도 같습니다.
- `package.json`의 `exports`에서 다시 내보내기만 하던 경로 `kr-broker/kis/kis-trading-hours`와 `kr-broker/kis/us-market-hours`를 뺐습니다. 같은 함수를 `kr-broker/krx-trading-hours`와 `kr-broker/us-market-hours`에서 가져옵니다.
- Python 판의 의존성 하한을 알려진 취약점이 없는 판으로 올렸습니다(`requests>=2.33.0`, `aiohttp>=3.14.3`, `cryptography>=50.0.0`). 예전 하한 그대로 설치하면 requests 1건, aiohttp 38건, cryptography 6건의 알려진 취약점이 걸렸습니다. 이보다 낮은 판을 고정해 쓰던 환경은 함께 올려야 설치됩니다.
- `package.json`의 `exports`에서 증권사 클래스가 안에서만 쓰는 경로 세 개를 뺐습니다. `kr-broker/kis/master-search-rank`, `kr-broker/kbsec/kbsec-fill-warnings`, `kr-broker/kbsec/kbsec-token-breaker`입니다. 테스트 훅 `__resetKbsecTokenBreaker`, `kbsecTokenBreakerState`, `__resetFillSideWarn`은 테스트 전용 경로 `kr-broker/testing`에서 가져옵니다. 이 경로는 호환을 약속하지 않습니다. 나머지 이름(`rankMasterMatches`, `throwIfTokenBreakerOpen`, `recordTokenFailure`, `recordKbsecCallOk`, `warnIfFillSideUnreadable`, `warnIfFillTotalsInconsistent`, `warnFillWithoutPrice`)은 대신할 경로가 없습니다. 검색 결과의 정렬은 종목 검색 함수(`searchKRXStocks`, `searchOverseasStocks`)가 하고, 토큰 차단기와 체결 경고는 `kbsec` 클래스가 처리합니다. 공개 API인 하위 경로는 [버전 정책](docs/versioning.md)에 적었습니다.
- 라이브러리 안에서 쓰지 않던 공개 이름 넷을 지웠습니다.
  - `kr-broker/kbsec/kbsec-types`의 `KBSEC_CODE_FUTURE_QUERY_DATE`. 이 거절은 오류의 `detail`이 `KBSEC_ERROR_DETAIL.FUTURE_QUERY_DATE`(`kr-broker/kbsec/kbsec-error-codes`)인지로 가립니다.
  - `kr-broker/kbsec/kbsec-types`의 `kbsecIsAlgoOrderType`. 대신할 이름은 없습니다.
  - `kr-broker/kbsec/kbsec-types`의 `KBSEC_OVERSEAS_EXCHANGE`. 미국 거래소 코드는 `KBSEC_US_EXCHANGES`에 있습니다.
  - `kr-broker/kis/kis-types`의 `KIS_DEFAULT_FEE_RATE`. `KIS_BROKERAGE_FEE`를 쓰고, 매도라면 `krxSellTaxRate()`를 더합니다. Python 판은 0.5.0에서 지웠습니다.
- 0.5.0에서 `@deprecated` 별칭으로 남긴 옛 이름을 지웠습니다. 아래의 새 이름으로 바꿉니다. 한국투자증권과 KB증권의 새 이름은 옛 이름과 같은 경로에 있습니다. Python 판 이름(`KISAuth`, `KISCandleService` 등)은 그대로입니다.
  - 한국투자증권: `KISAuth` → `KisAuth`, `KISCandleService` → `KisCandleService`, `KISCredentials` → `KisCredentials`, `KISCachedToken` → `KisCachedToken`, `KISDailyCandle` → `KisDailyCandle`, `KISOverseasDailyCandle` → `KisOverseasDailyCandle`, `KISApprovalResponse` → `KisApprovalResponse`
  - KB증권: `KBSecAuth` → `KbsecAuth`, `KBSecErrorMapping` → `KbsecErrorMapping`, `KBSecCredentials` → `KbsecCredentials`, `KBSecDataHeader` → `KbsecDataHeader`, `KBSecRequestEnvelope` → `KbsecRequestEnvelope`, `KBSecResponseEnvelope` → `KbsecResponseEnvelope`, `KBSecCommonOutput` → `KbsecCommonOutput`, `KBSecTokenResponse` → `KbsecTokenResponse`, `KBSecCachedToken` → `KbsecCachedToken`, `KBSecResponseHeader` → `KbsecResponseHeader`, `isKBSecOrderTr` → `isKbsecOrderTr`, `isKBSecTokenFailure` → `isKbsecTokenFailure`, `isKBSecBusinessError` → `isKbsecBusinessError`
  - `'KR' | 'US'` 타입: `TossMarketCountry`(`kr-broker/toss/toss-types`), `KBSecMarketCountry`(`kr-broker/kbsec/kbsec-types`), `CalendarMarket`(`kr-broker/market-calendar`와 진입점) → `StockMarketGroup`(`kr-broker/broker-market-group`와 진입점)
- 토큰 저장소(`options.tokenStore`)에서 옛 키(자격증명 앞 12자)를 더 읽거나 쓰지 않고, 발급 락도 새 키로 잡습니다. 0.5.0에서 옛 판과 함께 돌리려고 남긴 이행 단계를 걷어냈습니다. Python 판도 같습니다.
  - 0.5.0 전 판에서 곧바로 올리면 저장소의 토큰을 찾지 못해 한 번 새로 발급합니다. 그 판의 프로세스가 같은 저장소를 쓰는 동안에는 두 판이 서로의 토큰을 보지 못합니다. 토스증권은 새로 발급하면 직전 토큰이 무효가 되므로 401이 되풀이됩니다. 0.5.0으로 먼저 올리고, 옛 판이 발급한 토큰이 만료된 뒤(토큰 수명은 하루 안팎) 이번 판으로 올립니다.
  - 0.5.0과 이번 판이 함께 도는 동안에는 두 판의 발급 락이 다릅니다. 두 판이 같은 때 토큰을 새로 받으려 하면 서로의 락을 보지 못해 둘 다 발급합니다.
  - 옛 키는 저장할 때 준 TTL이 지나면 사라집니다. TTL을 지키지 않는 저장소라면 `kis:token:`, `kis:approval:`, `toss:token:`, `kbsec:token:` 뒤에 자격증명 앞 12자가 붙은 키를 지웁니다.
- 한국투자증권과 KB증권 `fetchOHLCV`의 기본 `timeframe`을 ccxt와 같은 1분봉(`'1m'`)으로 바꿉니다. 예전에는 일봉(`'1d'`)이었습니다. `timeframe`을 빼고 일봉을 받던 코드는 `'1d'`를 직접 줍니다. 토스증권은 이미 1분봉이었습니다. `limit`을 주지 않으면 세 증권사 모두 예전처럼 최대 100개입니다. Python 판도 같고, 토스증권 `fetch_ohlcv`는 `timeframe`에 `None`을 주면 `NotSupported` 대신 1분봉을 받습니다.
- `has`에 올린 확장 메서드를 ccxt의 `has`처럼 세 증권사에서 같은 인자로 부르고 같은 모양을 받도록 맞춥니다. 옛 이름과 옛 호출 모양은 한 판 동안 인스턴스마다 한 번 경고 로그를 남기고 동작합니다. 다음 판에서 지웁니다. Python 판(한국투자증권, 토스증권)도 같습니다.
  - `fetchMarketCalendar(params)`는 세 증권사 모두 날짜별 개장 여부(`CalendarDay[]`)를 돌려줍니다. 시장은 `params.market`(기본 `'KR'`)으로 고릅니다. 한국투자증권과 KB증권은 `'US'`를 받으면 요청 없이 `NotSupported`를 던집니다. 토스증권은 예전에 세션 시각 원본을 돌려줬고, 이제 그 결과는 `fetchMarketSessions(market)`로 받습니다. 시장 문자열을 넘기던 옛 호출(`fetchMarketCalendar('KR')`)은 예전처럼 세션 시각 원본을 돌려줍니다. 휴장일 표를 채우려고 부르던 코드는 `fetchMarketCalendar({ market })`로 바꿉니다.
  - 한국투자증권과 KB증권 `fetchInvestorTrading(symbol, since, limit, params)`는 공통 타입 `InvestorTradingRecord[]`를 돌려줍니다. 필드는 `date`, `close`, `change`와 개인, 외국인, 기관의 순매수 대금(`individual`, `foreign`, `institution`)입니다. 대금의 단위는 증권사 응답 그대로라 증권사마다 다를 수 있으므로, 증권사를 섞어 더하지 않습니다. 한국투자증권의 매수·매도 수량과 대금, KB증권의 등락률과 거래량, 나머지 투자자 유형은 `info` 원문에서 읽습니다. `KisInvestorTradingRecord`와 `KbsecInvestorTradingRecord`는 새 타입의 옛 이름으로 남깁니다. 한국투자증권은 `since`, `limit`, `params.until`로 받은 영업일을 거릅니다. 둘째 인자로 `params`를 넘기던 옛 호출도 받습니다.
  - 토스증권의 시장 단위 조회 `fetchInvestorTrading`은 `fetchMarketInvestorTrading`으로 옮기고, 토스증권 `has`에서 `fetchInvestorTrading`을 뺍니다.
  - 한국투자증권 `fetchStockWarnings`는 `fetchVolatilityInterruptions`로, KB증권 `fetchStockWarnings`는 `fetchTradingRestriction`으로 옮깁니다. 두 증권사의 `has`에서 `fetchStockWarnings`를 뺍니다. `fetchStockWarnings`는 토스증권의 유의사항 조회 이름으로 남습니다.
  - `fetchRankings`는 순위 종류(`type`)가 증권사마다 달라 세 증권사의 `has`에서 뺍니다. 메서드는 그대로입니다.
- 한국투자증권 `fetchOrders`, `fetchOrder`, `fetchClosedOrders`는 체결 수량이 주문 수량보다 적은 주문을 잔량이 0이어도 `closed`로 돌려주지 않습니다. ccxt에서 `closed`는 전량 체결입니다. 예전에는 10주 가운데 3주가 체결되고 나머지가 취소된 주문이 `closed`였습니다. 국내 행의 취소 여부(`cncl_yn`)가 `Y`이면 예전처럼 `canceled`이고, 그 밖에는 `status`를 비웁니다. 나머지가 취소, 정정, 거부 가운데 무엇으로 끝났는지 행만으로는 알 수 없기 때문입니다. 미국 행은 취소 여부를 읽지 않으므로 늘 비웁니다. 이런 주문은 `fetchClosedOrders`에서 빠집니다. 끝난 주문의 체결을 `fetchClosedOrders`로 모으던 코드는 `fetchOrders`의 `filled`나 `fetchMyTrades`를 읽습니다. `fetchOpenOrders`와 `cancelAllOrders`는 미체결 조회의 행이라 이때도 `open`으로 둡니다. Python 판도 같습니다.
- Python 판 통합 메서드(`fetch_order`, `create_order`, `fetch_balance` 등)의 반환 타입을 `Dict[str, Any]`에서 통합 구조 타입으로 바꿨습니다. 타입은 `kr_broker.base.types`의 `Order`, `Trade`, `Ticker`, `OrderBook`, `Balances`, `Balance`, `MarketInterface`, `TradingFeeInterface`입니다. ccxt처럼 `TypedDict`로 적었고(`Balances`는 `dict`를 상속한 타입입니다), 필드는 TypeScript 판과 같습니다. 반환 값은 예전처럼 `dict`입니다. 타입 검사기로 보면, 결과를 `Dict[str, Any]` 인자에 넘기거나 타입에 없는 키를 쓰는 코드가 오류로 잡힙니다. 이런 코드는 결과를 새 타입이나 `Mapping[str, Any]`로 받습니다. 같은 모듈의 옛 별칭 `Order`, `Trade`, `Ticker`, `OrderBook`, `Balances`는 새 타입으로 바뀌었고, `Market`은 `Optional[MarketInterface]`입니다.

### 추가

- 종목 통합 코드 표를 둡니다. 기본값은 `kr-broker/broker-market-group`의 `COMMON_STOCK_CODES`입니다. 인스턴스의 `commonStockCodes`는 생성자 인자로 덮습니다. 표에 없는 티커가 현금 키와 겹쳐 `NotSupported`가 나면 이 표에 그 티커를 더합니다. 기반 클래스의 `commonStockCode(ticker)`와 `stockTicker(code)`가 표로 코드를 바꿉니다. 같은 모듈의 `commonStockCode`, `stockTicker`는 표를 인자로 받습니다. `toStreamSymbol`과 `KisPriceWs` 옵션의 `commonStockCodes`도 표를 받습니다. Python 판 이름은 `common_stock_code`, `stock_ticker`입니다.
- `options.blockAuctionBuys`(세 증권사, 기본 꺼짐)를 켜면 종가 동시호가(국내 15:20~15:30, 미국 15:50~16:00 ET)의 신규 매수를 요청 전에 `MarketClosed`로 막습니다.
- 세 증권사가 함께 쓰는 주문 게이트를 공개합니다. `kr-broker/krx-trading-hours`의 `krxOrderBlockReason`과 `krxAuctionBuyBlockReason`, `kr-broker/us-market-hours`의 `usOrderBlockReason`과 `usAuctionBuyBlockReason`입니다. Python 판 이름은 `krx_order_block_reason` 등입니다. `marketSessionBlockReason`은 다섯째 인자로 `{ side, blockAuctionBuys }`를 받습니다.
- `kr-broker/krx-tick-size`(Python 판 `kr_broker.krx_tick_size`)에 KRX 주식 호가 단위 표(`KRX_STOCK_TICK_SIZES`)와 `getKrxTickSize`, `krxTickViolation`을 둡니다.
- `kr-broker/broker-time`에 한국 표준시 오프셋 `KST_OFFSET_MS`와 한국 날짜 `kstYmd`(`YYYYMMDD`), 한국 시각 `kstHms`(`HHMMSS`)를 둡니다. 세 증권사가 이 정의를 함께 씁니다. Python 판은 `kr_broker.broker_time`의 `KST_OFFSET_MS`와 `kst_ymd`입니다.
- 오류에 `brokerCode`(Python 판 `broker_code`)를 더합니다. 증권사가 응답에 실어 보낸 원래 오류 코드입니다. 한국투자증권은 `msg_cd`, 토스증권은 오류 코드, KB증권은 `processCode`이고, 코드 표에 없는 코드도 싣습니다. 라이브러리가 요청 전에 막은 오류에는 없습니다. KB증권은 토큰 발급이 업무 코드로 거절된 오류에도 싣습니다. `detail` 값은 그대로이고, 뜻은 라이브러리가 가른 원인 이름으로 정합니다. KB증권의 원래 코드를 오류 메시지에서 꺼내던 코드는 `brokerCode`를 읽습니다.
- Python 판에 `py.typed`를 싣습니다. 이제 mypy도 이 패키지의 타입을 읽으므로, 통합 메서드의 결과를 반환 타입과 다르게 쓰던 코드는 mypy에서도 오류로 잡힙니다. camelCase 이름(`fetchBalance` 등)을 타입 검사기가 알 수 있게 선언했습니다. `async with`로 받은 인스턴스는 기반 `Exchange`가 아니라 증권사 클래스로 보입니다. 예전에는 pyright(VS Code의 Pylance)가 이 두 경우를 오류로 표시했습니다.
- 한국투자증권에 `fetchTrades`를 더합니다. 주식현재가 체결(`inquire-ccnl`)의 최근 30건을 오래된 것부터 돌려주고, 국내만 지원합니다. 미국 종목은 요청 없이 `NotSupported`를 던집니다. 체결 행에 날짜가 없어 호출마다 일자별 시세(`inquire-daily-price`)를 한 번 더 조회하고, 거래량이 있는 가장 최근 거래일을 가장 새 체결의 날짜로 붙입니다. 앞 행보다 시각이 늦은 행이 나오면 날짜가 바뀐 것이므로 그 행부터는 `timestamp`를 비웁니다. 일자별 시세를 받지 못했거나, 거래량이 있는 날이 없거나, 가장 새 체결이 지금보다 1분 넘게 늦으면 모든 행의 `timestamp`를 비우고, 던지지는 않습니다. 방향과 체결 id는 응답에 없어 비웁니다. Python 판도 같습니다.
- 한국투자증권에 `fetchCanceledOrders`를 더합니다. `fetchOrders` 결과에서 `status`가 `canceled`인 주문만 고르고, `limit`은 고른 뒤에 적용합니다. 국내는 취소 여부(`cncl_yn`)가 `Y`인 주문이 나오며, 일부 체결 뒤 취소한 주문도 들어갑니다. 미국 주문은 취소 표시가 없어 나오지 않습니다. Python 판도 같습니다.
- Python 판에 KB증권(`kr_broker.kbsec`, `kr_broker.async_support.kbsec`)을 옮기기 시작합니다. 지금은 인증과 오류 처리, 시세, 수수료 추정, 휴장일, 투자자 매매동향을 옮겼습니다. 두 판은 새 요청 픽스처 `ts/src/test/static/request/kbsec.json`을 함께 돌립니다.
  - 토큰 발급은 봉투 형태가 거절되면 평면 형태로 한 번 더 보내고, 토큰 저장소를 씁니다.
  - 토큰이 무효(401, `I445`)면 토큰을 회전하고 한 번만 다시 보냅니다. 다시 발급한 토큰의 `jti`가 같으면 폐기한 뒤 한 번 더 발급합니다. 그래도 토큰 실패가 이어지면 토큰 차단기가 호출을 멈춥니다.
  - 오류는 `processCode`로 분류하고, 코드를 `broker_code`에 싣습니다. TR 본문은 입력 필드를 모두 채워 보냅니다.
  - 통합 메서드는 `fetch_ticker`, `fetch_order_book`, `fetch_ohlcv`(국내만), `fetch_trades`, `fetch_trading_fee`(공시 요율로 추정)입니다. 고유 조회는 `fetch_market_calendar`, `refresh_market_calendar`, `fetch_investor_trading`입니다. `price_to_precision`은 TypeScript 판처럼 국내 가격을 KRX 호가 단위 표로 반올림합니다. 나머지 통합 메서드는 `has`가 `False`라서 부르면 `NotSupported`를 던집니다. 83개 TR은 모두 암묵 메서드로 부를 수 있습니다.
  - 국내 `fetch_trades`는 TypeScript 판처럼 일봉을 한 번 더 조회해 체결 날짜를 붙입니다. 국내 `fetch_ohlcv`와 이 일봉 조회는 `options['masterData']`로 코스닥 종목임을 알면 코스닥 시장구분으로 보냅니다.
  - KB증권은 웹소켓을 제공하지 않아서 ccxt처럼 `kr_broker.pro`에 넣지 않았습니다. 그래서 `kr_broker.pro.exchanges`는 이제 `kr_broker.exchanges`의 일부입니다.
  - 테스트 훅 `reset_kbsec_token_breaker`를 `kr_broker.testing`에서 가져옵니다.

### 바뀜

- 한국투자증권 실시간 연결 코드를 `KisRealtimeStream` 하나로 모았습니다. `KisPriceWs`(`createPriceStream`)는 그 위에서 체결가와 호가만 읽습니다. `KisPriceWs`의 생성자 옵션과 메서드, 콜백, 내보내는 이름은 그대로입니다. 두 클래스가 다르게 처리하던 부분은 아래처럼 맞췄고, Python 판도 같습니다.
  - `createRealtimeStream`도 구독이 거부되면 경고 로그를 남깁니다. 거부된 구독은 목록에 남아 다시 접속할 때 다시 등록합니다. 예전에는 목록에서 지워 다시 접속해도 등록하지 않았습니다.
  - `createPriceStream`도 평문 체결통보 프레임과, 복호 key 를 받기 전에 온 암호화 프레임을 버립니다.
  - `createRealtimeStream`의 연결 로그를 `KisPriceWs`와 같게 남깁니다. 연결 종료 로그에는 `code`, `reason`, `wasClean`을 싣고, 오류 로그에는 원인을 싣습니다. 접속하면 등록할 구독 수도 남깁니다.
  - `KisPriceWs`는 `start`와 `updateSubs`로 받은 배열을 복사해 둡니다. 옵션의 `url`과 `isVirtual`은 생성할 때 한 번 읽습니다. 넘긴 뒤 배열이나 옵션 객체를 바꿔도 다음 접속에 반영되지 않습니다.
  - Python `KisPriceWs`는 `KisRealtimeStream`을 상속합니다. 그래서 `subscribe`와 `unsubscribe`가 생겼고, 모듈 상수 `RECONNECT_BASE_MS`와 `RECONNECT_MAX_MS`는 없어졌습니다. 재접속 간격은 클래스 속성 `reconnect_base_ms`, `reconnect_max_ms`에 남아 있습니다.
- `kr-broker/kis/kis-types`의 `getTickSize`(Python 판 `kis_types.get_tick_size`)는 `getKrxTickSize`의 옛 이름으로 남깁니다. 다음 판에서 지웁니다.
- 라이브러리 안에서 쓰지 않는 공개 이름에 `@deprecated`를 붙였습니다. 다음 판에서 지웁니다. Python 판의 같은 이름(`check_krx_trading_hours`, `get_time_until_us_market_open`, `is_toss_trading_open`, `time_until_toss_open`, `parse_kis_realtime_frame`, `kis_types`의 `KIS_RATE_LIMIT_ERROR_CODE`, `KIS_LEDGER_RATE_LIMIT_ERROR_CODE`, `KIS_RATE_LIMIT_ERROR_CODES`)도 함께 지웁니다.
  - `kr-broker/kbsec/kbsec-settlement-match`와 `kr-broker/kbsec/kbsec-overseas-settlement-match`의 모든 이름. 정산 대조는 호출하는 쪽의 거래 기록을 KB증권의 정산 행과 맞추는 일이므로, 대조 코드를 호출하는 쪽으로 옮깁니다. 정산 행은 `fetchDomesticSettlements`와 `fetchOverseasSettlements`가 계속 돌려줍니다.
  - `kr-broker/kbsec/kbsec-types`의 `kbsecTodayKst`
  - `kr-broker/kis/kis-types`의 속도 제한 코드 `KIS_RATE_LIMIT_ERROR_CODE`, `KIS_LEDGER_RATE_LIMIT_ERROR_CODE`, `KIS_RATE_LIMIT_ERROR_CODES`. 오류 메시지에서 이 코드를 찾던 코드는 `RateLimitExceeded`로 가릅니다. 증권사가 준 코드는 오류의 `brokerCode`(Python 판 `broker_code`)에 있습니다.
  - `kr-broker/kis/kis-realtime-parser`의 `parseKisRealtimeFrame`, `kr-broker/kis/kis-price-ws`의 `isKisWsSupported`와 `isUsingGlobalWebSocket`
  - `kr-broker/krx-trading-hours`의 `checkKRXTradingHours`. `checkKRXTradingHoursAt(now)`를 씁니다.
  - `kr-broker/toss/toss-trading-hours`의 `isTossTradingOpen`과 `timeUntilTossOpen`. `kr-broker/trading-hours`의 `isTradingHours('toss', now)`와 `getTimeUntilMarketOpen('toss', now)`를 씁니다.
  - `kr-broker/us-market-hours`의 `getTimeUntilUsMarketOpen`
- 휴장일 캘린더를 채우고 비우는 `applyMarketCalendar`와 `resetMarketCalendar`를 테스트 전용 경로 `kr-broker/testing`으로 옮깁니다. 두 함수는 프로세스 전체의 캘린더를 바꾸므로 테스트에서만 씁니다. `kr-broker/market-calendar`의 두 이름은 `@deprecated`를 붙여 한 판 동안 남기고, 다음 판에서 뺍니다. Python 판은 `kr_broker.testing`에서 `apply_market_calendar`와 `reset_market_calendar`를 가져옵니다. `kr_broker.market_calendar`의 두 이름도 다음 판에서 뺍니다.
- 이 저장소의 CI가 커밋 이력도 검사합니다. `pnpm hygiene:history`는 위생 검사의 패턴으로 모든 커밋의 메시지와 추가된 줄을 봅니다. 작성자 이메일은 GitHub noreply 주소(`…@users.noreply.github.com`)만 받습니다. 커미터 이메일은 웹에서 병합할 때 GitHub이 적는 서비스 주소도 받습니다. PR에서는 PR 브랜치의 커밋과, 스쿼시 병합 커밋의 제목이 될 PR 제목도 봅니다. 위생 검사의 이메일 규칙은 `example.*` 도메인에 더해 GitHub noreply 주소, `noreply@anthropic.com`(공동 작성자 트레일러), `support@github.com`(Dependabot 서명 트레일러)을 허용합니다.
- 이 저장소의 CI가 Python 의존성을 해시를 고정한 잠금 파일(`python/requirements/*.txt`)로 설치하고, `pip-audit`도 운영 의존성의 잠금 파일을 감사합니다. 예전에는 PyPI 최신판을 해시 없이 받아 감사했습니다. Dependabot은 Python 의존성을 `uv` 생태계로 올립니다. 사용하는 쪽의 설치와 `pyproject.toml`의 하한은 그대로입니다.
- KB증권 `KbsecAuth.getAccessToken`(`kr-broker/kbsec/kbsec-auth`)은 토큰 발급이 거절되면 `Error` 대신 `AuthenticationError`를 던집니다. 증권사가 준 업무 코드는 `brokerCode`에 싣습니다. 본문 형태 두 가지가 모두 거절되면 먼저 보낸 형태의 코드를 싣습니다. 나중에 보내는 형태는 원인과 관계없이 `E021`을 받기 때문입니다. `detail`은 예전처럼 비어 있습니다. `kbsec` 클래스의 비공개 호출이 던지는 오류는 예전처럼 `AuthenticationError`입니다. 메시지 앞의 `kbsec 토큰을 받지 못했다:`는 빠집니다. 토큰 무효(`I445`) 뒤 재발급이 실패했을 때도 `Error` 대신 `AuthenticationError`를 던집니다.

### 고침

- 한국투자증권 `KisPriceWs.start()`를 재접속 대기 중에 다시 부르면 연결을 두 번 열던 것을 고쳤습니다. 새로 접속한 뒤 예약돼 있던 재접속이 한 번 더 돌아 방금 연 연결을 끊었습니다.
- 한국투자증권 `KisPriceWs`의 구독 목록에 같은 구독이 겹쳐 있으면 등록 프레임을 한 번만 보냅니다. 예전에는 두 번 보내 거부 응답을 받았습니다(Python 판도 같습니다).
- 한국투자증권 `candles()`의 봉 조회는 달력에 없는 날짜와 범위를 넘는 시각의 행을 건너뜁니다. 예전에는 국내와 해외 날짜 `20260230`을 3월 2일로, 분봉 시각 `240000`을 다음 날 0시로 읽었습니다. 앞의 0이 빠진 분봉 시각(`93000`)은 시각이 `NaN`인 봉이 됐지만, 이제는 09:30으로 읽습니다. Python 판도 같습니다.
- 범위를 넘는 시각(`240000`)을 그날 0시나 다음 날로 읽던 봉 경로를 더 고쳤습니다. KB증권 국내 `fetchOHLCV`와 해외 `fetchOverseasCandles`는 이런 행을 건너뜁니다. `fetchOverseasCandles`는 날짜를 읽을 수 없는 행도 건너뜁니다. 예전에는 `timestamp`를 비운 채 남겼습니다. 한국투자증권 `fetchIndexOHLCV`의 분봉과 `fetchMinuteOHLCVAt`, `fetchOverseasMinuteOHLCV`도 건너뜁니다. 한국투자증권 `fetchExpectedPriceTrend`의 추이와 KB증권 `fetchTrades`의 체결은 행을 남기고 `timestamp`를 비웁니다.
- 한국투자증권의 장 시간 게이트와 토스증권의 정적 시간표 폴백이 벽시계 대신 인스턴스 시계(`milliseconds()`)로 시각을 판정합니다.
- KB증권 `fetchBalance`는 미국 보유가 0건인 계좌에서도 미국 시장을 읽은 것으로 봅니다. 예전에는 프로세스가 시작된 뒤 보유 행을 한 번도 받지 못하면 조회가 성공해도 `info.readStatus`가 `PARTIAL`이었습니다. `unreadMarkets`에도 `US`가 남았습니다. 이제는 응답에 예수금 그리드가 있거나 종목 그리드에 빈 행만 있어도 읽은 것으로 봅니다. 대신 응답에 알아보지 못한 배열이 있거나, 종목코드는 있는데 수량을 읽지 못한 행이 있으면 `US`를 못 읽은 시장으로 둡니다. 이전 조회에서 보유를 읽은 인스턴스도 마찬가지입니다. 예전에는 보유를 읽은 뒤에 이런 응답을 받으면 읽지 못한 종목을 뺀 잔고를 `COMPLETE`로 돌려줬습니다. 그래서 증권사가 명세에 없는 배열을 보내면 보유를 읽었어도 `PARTIAL`입니다. 그 배열의 필드 이름은 경고 로그에 남깁니다. 달러 예수금 행을 찾지 못하면 받은 통화구분명을 경고 로그에 남깁니다. 예수금 그리드는 예수금(`tfnd`) 필드가 있는 배열만 고릅니다. 명세상 종목 그리드에도 통화구분명이 있어서, 예전에는 예수금 그리드 없이 종목 그리드만 오면 그 행을 예수금으로 읽어 `USD`를 0으로 실을 수 있었습니다. 이제는 `USD`를 비웁니다.
- KB증권 국내 `fetchTrades`가 체결 시각에 조회한 날의 한국 날짜를 붙이지 않습니다. 장 밖에 직전 영업일의 체결이 오면 틀린 날짜가 붙었고, 지금보다 늦은 시각이 나오기도 했습니다. 이제 한국투자증권처럼 호출마다 일봉(`IVS11560`)을 한 번 더 조회하고, 거래량이 있는 가장 최근 거래일을 가장 새 체결의 날짜로 붙입니다. 일봉은 코스피 시장구분으로 조회하고, `options.masterData`가 코스닥 종목이라고 알려 주면 코스닥 시장구분으로 조회합니다. 앞 행보다 시각이 늦은 행이 나오면 날짜가 바뀐 것이므로 그 행부터는 `timestamp`를 비웁니다. 일봉을 받지 못했거나, 최근 일봉 30개에 거래량이 있는 날이 없거나, 가장 새 체결이 지금보다 1분 넘게 늦으면 모든 행의 `timestamp`를 비웁니다. 이때 던지지는 않습니다.
- KB증권 국내 `fetchOHLCV`는 `options.masterData`로 코스닥 종목임을 알면 시장구분(`mkt_clsf`)을 코스닥(`'1'`)으로 보냅니다. 예전에는 `params.mkt_clsf`를 주지 않으면 코스닥 종목도 코스피(`'0'`) 시장구분으로 조회했습니다. `params.mkt_clsf`를 주면 예전처럼 그 값을 씁니다.

## [0.5.0] - 2026-09-25

0.1.0 다음으로 태그를 붙인 첫 버전입니다. 저장소의 버전 번호는 태그 없이 0.4.0까지 올랐고, 그 사이의 변경도 모두 이 절에 적었습니다.

### 바뀜(호환되지 않음)

- `package.json`의 `exports`에서 내부 모듈 경로 세 개를 뺐습니다. `kr-broker/kis/kis-auth`, `kr-broker/kis/kis-candle-pagination`, `kr-broker/kbsec/kbsec-fill-row`는 증권사 클래스가 안에서 쓰는 도우미라 대신할 경로가 없습니다. 인증과 연속조회, 체결 행 해석은 `kis`와 `kbsec` 클래스의 메서드가 처리합니다.
- 진입점(`kr-broker`)에서 휴장일 캘린더를 바꾸는 함수와 내부 도우미를 더 내보내지 않습니다. 빠진 이름은 `applyMarketCalendar`, `resetMarketCalendar`, `refreshMarketCalendar`, `expandBusinessDays`, `CALENDAR_RETRY_MS`입니다. `resetMarketCalendar()`를 부르면 같은 프로세스의 모든 인스턴스가 받은 휴장일을 잃습니다. 다섯 이름은 `kr-broker/market-calendar`에서 가져옵니다. 캘린더는 인스턴스의 `refreshMarketCalendar()`로 받습니다. 읽기 함수(`marketCalendarStatus`, `marketDayStatus`, `isMarketClosedDay`)와 캘린더 타입은 진입점에 남았습니다.
- `kr-broker/krx-sell-tax`의 `__resetKrxSellTaxWarnLatchForTest`를 지웠습니다. 테스트도 쓰지 않던 훅입니다.
- `Exchange`에서 인덱스 시그니처(`[key: string]: any`)를 없앴습니다. 예전에는 메서드 이름을 잘못 적어도(`k.fetchTickr()`) 컴파일되고, 실행해야 `is not a function`으로 드러났습니다. 이제는 컴파일 오류입니다. 세 증권사 클래스의 암묵 메서드(`privateMarketGetPrices` 등)는 엔드포인트 표에서 만든 선언으로 타입을 얻습니다. 이름을 문자열로 만들어 `exchange[name]`으로 부르던 코드는 `exchange.implicitApiMethod(name)`으로 바꿉니다. 없는 이름이면 `undefined`입니다. `Exchange`를 상속해 `api` 트리를 직접 적은 클래스는 암묵 메서드를 `declare privateGetFoo: ImplicitApiMethod;`로 선언합니다. `kr-broker/kis/kis-candle-service`의 `KisCandleService`는 한국투자증권 암묵 메서드가 있는 인스턴스만 받습니다.
- Python 판에서 쓰지 않던 이름을 지웠습니다. `kr_broker.kis_types`의 `get_kis_effective_fee_rate`와 `KIS_DEFAULT_FEE_RATE`는 `KIS_BROKERAGE_FEE`로 바꿉니다. 매도라면 `krx_sell_tax_rate()`를 더합니다. `kr_broker.us_market_hours.et_wall_clock`은 `et_ymd()`나 `format_et_wall_clock()`으로 바꿉니다. 증권사 클래스가 없던 `kr_broker/abstract/kbsec.py`도 지웠습니다.
- 한국투자증권과 토스증권 `createOrder`가 받지 않는 ccxt 조건 인자를 주면 요청 없이 `NotSupported`를 던집니다. 한국투자증권은 `triggerPrice`, `stopPrice`, `stopLossPrice`, `takeProfitPrice`, `stopLoss`, `takeProfit`를, 토스는 `triggerPrice`를 뺀 다섯 키를 막습니다. 예전에는 이 인자를 버리거나 본문에 합쳐, 조건 없는 일반 주문이 바로 나갈 수 있었습니다. 한국투자증권 스탑지정가는 `createTriggerOrder`로, 토스 조건주문은 `params.triggerPrice`나 `createTriggerOrder`로 냅니다. KB증권은 이미 같은 인자를 막았고, `stopLoss`와 `takeProfit`도 더했습니다.
- 일봉, 주봉, 월봉의 `timestamp`를 세 증권사 모두 그 기간 첫날(그 시장의 현지 날짜)의 00:00 UTC로 맞춥니다. 주봉은 월요일, 월봉은 1일입니다. ccxt의 일봉 관례와 같습니다. 바뀌는 곳은 한국투자증권 미국 일봉(야후의 09:30 ET), 야후 주봉과 월봉(현지 자정), 토스 일봉(현지 자정), KB증권 국내 봉과 `fetchOverseasCandles`의 일, 주, 월, 연봉(현지 자정)입니다. 한국투자증권 국내 일봉(09:00 KST = 00:00 UTC)은 그대로입니다. Python 판도 같습니다.
- KB증권 토큰 발급이 연결 실패나 시간 초과, 업무 코드 없는 5xx, 429로 끝나면 `AuthenticationError` 대신 `NetworkError` 계열(`NetworkError`, `RequestTimeout`, `ExchangeNotAvailable`, `RateLimitExceeded`)을 던집니다. 예전에는 일시 장애도 자격증명 오류처럼 보였습니다. 이때는 다른 본문 형태로 다시 보내지 않습니다. 봉투에 업무 코드가 있는 실패(E021 등)는 그대로 `AuthenticationError`입니다.
- 한국투자증권 캔들의 야후 조회가 404 가 아닌 4xx(조회 폭 초과 422 등)로 끝나면 `BadRequest`를 던집니다. 예전에는 일시 장애처럼 보이는 `ExchangeNotAvailable`이었습니다. 5xx 와 재시도를 다 쓴 실패는 그대로 `ExchangeNotAvailable`입니다.
- 요청 주소가 `https`가 아니면 보내기 전에 `BadRequest`를 던집니다. 루프백 주소는 예외입니다. 프록시 시험 등으로 평문 주소가 필요하면 `options.allowInsecureUrl`을 켭니다.
- `fetchOHLCV(symbol, timeframe, since, limit)`에 `since`를 주면 세 증권사 모두 `since`부터 앞에서 `limit`개를 돌려줍니다(ccxt 규칙). 예전에는 `since`를 줘도 가장 최근 `limit`개였습니다. `since`가 없으면 예전처럼 최근 `limit`개입니다. 한국투자증권은 받은 봉을 `since`와 `params.until`로 거릅니다. 예전에는 `until` 뒤 봉이 섞였습니다.
- KB증권 `fetchOHLCV`의 `params.until`은 요청 본문에 싣지 않고 받은 봉을 거르는 데만 씁니다.
- 토스증권 `fetchClosedOrders`와 `fetchCanceledOrders`는 `params.until`보다 늦게 낸 주문을 뺍니다. 예전에는 같은 날이면 섞였습니다.
- 증권사 고유 조회의 기간 끝을 위치 인자가 아니라 `params.until`(ms)로 받습니다. 예전 `until` 자리는 `limit`이 되었고, 그 자리에 ms 같은 큰 수가 오면 `BadRequest`를 던집니다.
- 날짜나 시각을 `YYYYMMDD`, `HHMMSS` 문자열로 받던 한국투자증권 조회는 그 인자를 없애고 `params.until`(ms)의 한국 날짜와 시각을 씁니다.
- 한국투자증권과 KB증권의 고유 결과 타입에서 필드 이름을 ccxt 용어로 바꿨습니다(`lastPrice` → `last`, `changeRate` → `percentage`, `closePrice` → `close`, `openPrice` → `open`, `highPrice` → `high`, `lowPrice` → `low`). 토스증권의 원문 응답 타입은 API 의 JSON 키를 그대로 따르므로 바꾸지 않았습니다.
- `fetchBondEvaluations`, `fetchCorporateSchedules`, `fetchOverseasCorporateActions`는 종목 인자를 `since` 앞으로 옮겼습니다.
- `kr-broker/kbsec/kbsec-types`에서 내보내던 `KBSEC_KRW_INTEGRATED_MARGIN_FLAG`를 지웠습니다. 패키지 안에서 쓰지 않던 예전 기능 플래그 이름입니다. 원마켓 계좌는 `options.krwIntegratedMargin`으로 켭니다.
- 한국투자증권 `fetchOHLCV`에 지원하지 않는 타임프레임을 주면 ccxt 오류 클래스 `NotSupported`를 던집니다. 토스증권과 같습니다. 예전에는 `name`만 `UnsupportedTimeframeError`인 일반 `Error`였습니다. Python 판도 `UnsupportedTimeframeError`를 없애고 `NotSupported`를 던집니다. `name`이 `UnsupportedTimeframeError`인지 보던 코드는 `NotSupported`로 가리도록 바꿉니다.
- `kr-broker/broker-time`의 `timeframeToMs`는 읽지 못한 타임프레임에 5분 대신 `NaN`을 돌려줍니다. 월봉 `1M`과 대문자 주봉 `1W`도 `NaN`입니다. 5분을 받아 쓰던 코드는 `NaN`인지 확인한 뒤 기본값을 직접 정합니다.
- 주문 요청이 증권사 오류 코드 없이 HTTP 5xx 로 끝나거나 해석할 수 없는 응답(비어 있지 않은 비JSON)을 받으면 `OrderOutcomeUnknown`을 던집니다. 예전에는 다시 보내도 될 것처럼 보이는 `ExchangeNotAvailable`이었습니다. 증권사 오류 코드로 분류한 5xx 는 그대로입니다. 상태 표에 없는 5xx(524 등)는 조회에서도 `ExchangeNotAvailable`입니다.
- 캔들 조회가 실패하면 빈 배열이 아니라 오류를 던집니다. 야후에 없는 심볼은 `BadSymbol`, 재시도를 다 쓴 실패는 `ExchangeNotAvailable`, `RateLimitExceeded`, `NetworkError`입니다. 한국투자증권 `candles()`의 기간별 조회와 해외 기간별 조회도 던집니다. 조회에 성공했는데 봉이 없을 때만 빈 배열입니다.
- 한국투자증권 `fetchBalance`는 `params.scope`에 모르는 값을 주면 `BadRequest`를 던집니다. 예전에는 요청 없이 빈 잔고를 돌려줬습니다.
- 토스증권 `fetchBalance`는 보유 응답에 `items`가 없거나 매수 가능 금액 응답에 `cashBuyingPower`가 없으면 `BadResponse`를 던집니다. KB증권 `fetchBalance`는 예수금 응답에 주문가능현금 필드가 없으면 `BadResponse`를 던집니다.
- KB증권 `fetchMyTrades(symbol, since)`는 `since`의 날짜부터 오늘까지 평일마다 조회해 합칩니다(최대 31일, 넘으면 `BadRequest`). 예전에는 `since`의 하루만 조회했습니다. 미국 종목의 조회일자는 미국 현지 날짜입니다.
- KB증권 `fetchClosedOrders`는 전체 주문에서 종료된 주문(`closed`, `canceled`)만 돌려줍니다. 예전에는 체결이 있는 주문을 `open` 상태까지 돌려줬습니다. 주문 조회 세 개(`fetchOpenOrders`, `fetchOrders`, `fetchClosedOrders`)는 분할체결 행을 주문 단위로 묶고, 남은 수량 없이 덜 체결된 주문을 `canceled`로 냅니다.
- KB증권 미국 주문은 1주 미만 수량이면 요청 없이 `InvalidOrder`를 던집니다. 소수점 주문은 `params.fractional`로 냅니다.
- 국내 종목코드 판정(`isKrxDomesticCode`)은 목록이 아니라 모양(숫자로 시작하는 6자리 영숫자)으로 합니다. 세 증권사와 Python 판이 같은 판정을 씁니다. `KNOWN_ALNUM_KRX_CODES`는 예시로만 남았습니다.

- 토큰 저장소 키가 자격증명 앞 12자에서 자격증명 전체의 SHA-256 앞 32자로 바뀝니다(`kis:token:`, `kis:approval:`, `toss:token:`, `kbsec:token:` 접두는 그대로). 이번 판은 이행 단계라 옛 키도 읽고 쓰며, 발급 락은 옛 키로 잡습니다. 옛 판과 새 판이 함께 도는 동안에도 추가 발급이 일어나지 않습니다. 옛 키는 다음 판에서 걷어냅니다. 저장소 키를 직접 읽는 운영 도구는 새 키로 바꿉니다.
- HTTP 리다이렉트를 따르지 않습니다. 3xx 응답은 `ExchangeNotAvailable`입니다.
- 조회 재시도도 요청 간격 조절을 다시 거치고, 오류의 `retryAfterMs`(토스 429 의 `Retry-After`)만큼 기다립니다. 비공개 호출의 인증은 간격 조절 뒤에 합니다.
- 한국투자증권 `createOrder`의 `params.session`에 `'regular'`나 `'nxt'`가 아닌 값을 주면 `BadRequest`를 던집니다. 예전에는 정규장 주문으로 처리했습니다.
- 한국투자증권 확장세션 주문(`session: 'nxt'`, `nxtRouting` 자동 판정)은 NXT 프리마켓, 메인마켓, 애프터마켓에만 나갑니다. 새벽과 휴장일, NXT 가 멈추는 시간(08:50~09:00, 15:20~15:30)에는 요청 없이 `MarketClosed`입니다. 예전에는 `session: 'nxt'`를 주면 시각을 보지 않고 보냈습니다.
- 한국투자증권 `createCreditOrder`가 `createOrder`와 같은 정규장 게이트를 거칩니다. `editOrder`는 국내에서 KRX 정규장과 NXT 가 모두 닫혀 있으면, 미국에서 완전 마감이면 요청 없이 `MarketClosed`입니다. 경로별 게이트는 [안전 수칙](docs/SAFETY.md)에 표로 적었습니다.
- 토스증권 `fetchClosedOrders`는 전량 체결된 주문만 돌려줍니다. 예전에는 토스의 종료된 주문(`CLOSED`) 전체라 취소, 거부, 정정으로 대체된 주문이 섞여 있었습니다. 취소된 주문은 새로 넣은 `fetchCanceledOrders`로 받습니다.
- 토스증권 `fetchMyTrades`는 일부 체결된 채 걸려 있는 미체결 주문의 누적 체결도 돌려줍니다. 한국투자증권 `fetchMyTrades`는 `since`를 조회 시작일로만 쓰고 주문 시각으로 거르지 않습니다. 예전에는 `since` 앞에 낸 주문이 그 뒤에 체결된 것이 빠졌습니다. 두 증권사 모두 주문 하나가 거래 하나라, 같은 id 의 거래는 덮어써야 합니다.
- 토스증권 `cancelAllOrders`는 취소하려던 사이에 끝난 주문을 원인 코드대로 옮깁니다(`already-filled`는 `closed`, `already-canceled`는 `canceled`, `already-rejected`는 `rejected`). 정정으로 대체됐거나 원인을 모르면 원래 상태로 둡니다. 원인 코드와 원문은 `info.cancelErrorDetail`, `info.cancelError`에 싣습니다. 예전에는 넷을 모두 `canceled`로 돌려줬습니다.
- KB증권 국내 `editOrder`는 `params.partial` 없이 준 `amount`를 반환값에 싣지 않습니다. 이때는 수량을 보내지 않고 잔량 전체의 가격만 바꾸므로 정정 뒤 수량을 응답으로 알 수 없습니다. `editOrder`의 `amount` 뜻이 증권사마다 다른 점은 [ccxt와 다른 점](docs/ccxt-differences.md)에 적었습니다.

### 추가

- `Exchange.httpRequest(url, method, headers, body, timeoutMs)`: 응답 해석 없이 HTTP 요청 하나를 보내고 응답을 돌려줍니다. Python 판의 `http_request`와 같습니다. `fetchYahooCandles`는 마지막 인자로 이 메서드를 가진 전송을 받고, 한국투자증권은 자기 인스턴스를 넘깁니다. 그래서 야후 요청도 인스턴스의 헤더와 `verbose` 로그, 주소 검사를 따릅니다. 인자 없이 부르면 예전처럼 전역 `fetch`로 보냅니다.
- KB증권 `options.hostAddr`(`{ ipAddr, macAddr }`)로 TR 본문에 싣는 호스트 주소를 정할 수 있습니다. 주지 않으면 예전처럼 이 호스트에서 모읍니다.
- `watch*`가 `params.signal`(`AbortSignal`)을 받습니다. 신호가 오면 기다리던 호출만 `AbortError`로 끝나고, 쌓인 갱신은 다음 호출이 받습니다.
- 한국투자증권 `createPriceStream`과 Python `create_price_stream`이 구독 거부 콜백 `onSubscribeError`(`on_subscribe_error`)를 받습니다.
- `ExchangeClosedByUser`(ccxt 와 같은 이름, `ExchangeError` 아래)를 더했습니다. 한국투자증권과 토스증권의 `close()`는 기다리던 `watch*`를 이 오류로 끝냅니다. `ExchangeError`를 잡던 코드는 그대로 동작합니다.
- 모든 증권사에 `close()`가 있습니다. KB증권처럼 실시간 연결이 없는 증권사에서는 아무것도 하지 않습니다.
- 토스증권과 KB증권이 `has.fetchTrades`를 선언합니다(구현은 예전부터 있었습니다). Python 토스 판에 `fetch_trades`를 더했습니다.
- Python 판을 더했습니다(`python/`). 한국투자증권과 토스증권의 인증, 서명, 오류 처리, 호출 간격 조절이 있고, 모든 엔드포인트를 암묵 메서드로 부를 수 있습니다.
- 토스증권의 통합 메서드(웹소켓 제외)를 Python 판에 옮겼습니다. 요청 픽스처에는 현재 시각을 고정하는 `now`를 더했습니다.
- 한국투자증권의 통합 메서드(웹소켓 제외)를 Python 판에 옮겼습니다. 종목 마스터, 야후 파이낸스 캔들, 한국투자증권 원본 캔들(`candles()`) 도우미도 함께 옮겼고, 요청 픽스처에 한국투자증권 케이스를 더했습니다.
- Python 비동기 판(`kr_broker.async_support`)을 더했습니다. ccxt 처럼 비동기 판 소스가 정본이고, 동기 판 증권사 파일은 `scripts/gen-python-sync.mjs`가 그 소스에서 만듭니다. HTTP 는 aiohttp 로 보내고, 토큰 저장소는 동기 구현과 비동기 구현을 모두 받습니다.
- Python 실시간 판(`kr_broker.pro`)을 더했습니다. ccxt Pro 처럼 비동기 판을 상속하고 한국투자증권과 토스증권의 `watch_ticker`, `watch_trades`, `watch_order_book`, `watch_orders`, `create_price_stream`을 TypeScript 판과 같게 옮겼습니다. 한국투자증권은 `create_realtime_stream`도 있습니다. 의존성에 `cryptography`(체결통보 복호)가 더해졌습니다.
- 엔드포인트 표(`ts/src/spec/*.json`)에 세 증권사의 모든 엔드포인트를 담았습니다. 표가 `describe().api`와 어긋나면 테스트가 실패합니다.
- TypeScript 판과 Python 판이 함께 쓰는 요청 픽스처(`ts/src/test/static/request/`)를 더했습니다.
- 한국투자증권과 토스증권에 `watchTicker`, `watchTrades`, `watchOrderBook`, `watchOrders`, `close`를 넣었습니다.
- 고유 결과 행에 `timestamp`와 `datetime`을 넣었습니다(국내 행만. 해외 행은 날짜의 시간대를 확인하지 못해 비워 둡니다).

### 바뀜

- 공개 이름의 접두 표기를 `Kis*`와 `Kbsec*`로 맞췄습니다. 옛 이름은 같은 경로에서 `@deprecated` 별칭으로 남겼고 다음 판에서 지웁니다. 대문자 상수(`KIS_...`, `KBSEC_...`)와 Python 판 이름은 그대로입니다.
  - 한국투자증권: `KISAuth` → `KisAuth`, `KISCandleService` → `KisCandleService`, `KISCredentials` → `KisCredentials`, `KISCachedToken` → `KisCachedToken`, `KISDailyCandle` → `KisDailyCandle`, `KISOverseasDailyCandle` → `KisOverseasDailyCandle`, `KISApprovalResponse` → `KisApprovalResponse`
  - KB증권: `KBSecAuth` → `KbsecAuth`, `KBSecErrorMapping` → `KbsecErrorMapping`, `KBSecCredentials` → `KbsecCredentials`, `KBSecDataHeader` → `KbsecDataHeader`, `KBSecRequestEnvelope` → `KbsecRequestEnvelope`, `KBSecResponseEnvelope` → `KbsecResponseEnvelope`, `KBSecCommonOutput` → `KbsecCommonOutput`, `KBSecTokenResponse` → `KbsecTokenResponse`, `KBSecCachedToken` → `KbsecCachedToken`, `KBSecResponseHeader` → `KbsecResponseHeader`, `isKBSecOrderTr` → `isKbsecOrderTr`, `isKBSecTokenFailure` → `isKbsecTokenFailure`, `isKBSecBusinessError` → `isKbsecBusinessError`
- 국내와 미국을 가리키는 `'KR' | 'US'` 타입을 `StockMarketGroup`(`kr-broker/broker-market-group`, 진입점에서도 내보냄) 하나로 모았습니다. `TossMarketCountry`, `KBSecMarketCountry`, `CalendarMarket`은 이 타입의 `@deprecated` 별칭이고 다음 판에서 지웁니다.
- 공개 타입의 선택 속성(`ConstructorArgs`, `BaseErrorOptions`, `KisPriceWsOptions`, `KisRealtimeStreamOptions`, `KbsecCredentials` 등)이 `undefined`를 명시적으로 받습니다. 사용하는 쪽이 `exactOptionalPropertyTypes`를 켜도 `{ uid: process.env.X }`처럼 값이 없을 수 있는 인자를 그대로 넘길 수 있습니다. 이 저장소도 이 검사를 켰습니다.
- 이 저장소가 `noUncheckedIndexedAccess` 검사도 켰습니다. 배열 원소나 레코드 값을 꺼내는 곳은 값이 없는 경우를 따져 타입을 좁혔습니다. 공개 타입과 동작은 바뀌지 않았습니다.
- 토스증권과 KB증권이 캐시 시각과 세션 판정, 날짜 기본값을 인스턴스 시계(`milliseconds()`)에서 읽습니다. 예전에는 `Date.now()`와 `new Date()`를 섞어 써서, `milliseconds`를 바꿔 끼우면 일부 경로만 시각이 바뀌었습니다. 한국투자증권은 이미 인스턴스 시계만 씁니다.
- 토스증권이 확장세션 국내 주문을 막을 때 내는 오류 문구가 옵션 이름 `nxtRouting`을 가리킵니다. 예전 문구는 `nxt-routing`이었습니다.
- `build`가 `tsc` 뒤에 `tsc-alias -f`를 돌려 `dist/`의 상대 경로에 확장자를 채웁니다. GitHub 주소로 설치하면 `prepare`가 같은 빌드를 돌립니다.
- 저장소 배치를 ccxt와 같게 바꿨습니다. TypeScript 소스는 `ts/src/`, Python 패키지는 `python/kr_broker/`, 두 판이 함께 쓰는 테스트 자료는 `ts/src/test/static/`, 예제는 `examples/ts/`와 `examples/py/`에 있습니다. 패키지 이름과 하위 경로(`kr-broker/…`)로 가져오는 코드는 바꿀 필요가 없습니다.

### 고침

- 클래스 주식을 슬래시 표기(`BRK/B`)로 주면, KB증권과 토스증권이 첫 슬래시 앞만 종목코드로 써서 `BRK`로 요청하던 것을 고쳤습니다. 야후 봉 조회(`fetchYahooCandles`)도 `BRK`로 불러 `BadSymbol`로 실패했습니다. 이제 끝의 `/KRW`나 `/USD`만 떼고, 남은 슬래시는 통합 표기의 점으로 바꿉니다(`BRK/B` → `BRK.B`, 야후는 `BRK-B`). 통합 심볼 `BRK.B/USD`로 부르는 호출은 바뀌지 않습니다(Python 판도 같습니다).
- KB증권 `createOrder`와 `createTriggerOrder`, `createMarketBuyOrderWithCost`의 장 시간 게이트가 벽시계 대신 인스턴스 시계(`milliseconds()`)로 지금을 읽습니다. 앞선 인스턴스 시계 변경에서 이 세 곳이 빠졌습니다.
- 야후 주봉과 월봉 끝에 붙어 오는 하루치 시세 봉이 같은 기간의 봉과 함께 결과에 두 번 들어가던 것을 고쳤습니다. 이제 오늘까지 담은 기간 봉만 남깁니다(Python 판도 같습니다).
- 토스증권의 미체결 조건주문과 종료된 주문 조회가, 서버가 이미 요청한 커서를 다음 커서로 다시 주면 같은 쪽을 쪽 수 상한까지 되풀이해 받고 같은 주문을 여러 번 담던 것을 고쳤습니다. 이제 되풀이된 커서에서 멈추고, 이미 담은 주문번호는 건너뜁니다(Python 판도 같습니다).
- KB증권이 조회 기준 영업일(`ordr_dt`)을 정할 때 받아 둔 KRX 휴장일 캘린더도 건너뜁니다. 예전에는 주말만 건너뛰어, 공휴일마다 KB가 거절할 조회(2854)를 먼저 보냈습니다. 캘린더에 없는 휴장일은 예전처럼 2854를 받고 하루씩 되감습니다.
- 한국투자증권의 주문, 체결, 잔고 시각과 KB증권 캔들 시각을 `kstStamp`와 같은 규칙으로 읽습니다. 예전에는 달력에 없는 날짜(`20260230`)를 다른 날로 넘겼고, 한국투자증권은 앞의 0이 빠진 시각(`93000`)을 그날 0시로 읽었습니다. 이제 달력에 없는 날짜는 `undefined`이고, 빠진 0은 채워 읽습니다. 범위를 넘는 시각(`250000`)은 다음 시각으로 넘기지 않고 그날 0시로 읽습니다(Python 판도 같습니다).
- KB증권 응답의 숫자 필드가 공백으로만 채워져 오면 0으로 읽고 다음 후보 필드를 보지 않던 것을 고쳤습니다. 이제 공백만 있는 값은 빈 값으로 보고 다음 후보를 읽습니다. 체결 행과 보유, 잔고를 읽는 `pickNum` 계열이 정산 행 파서와 같은 규칙을 씁니다.
- Python 판이 응답의 숫자 문자열을 TypeScript 판(JavaScript `Number`)과 같게 읽습니다. 예전에는 `'1_000'`을 1000으로, `'inf'`를 무한대로 읽고 `'0x10'`은 읽지 못했습니다. 이제 앞의 둘은 `NaN`이고 `'0x10'`은 16입니다.
- Python 판 주문 메서드가 숫자 인자(`amount`, `price`, `trigger_price`)와 `params`의 숫자 값에 `Decimal`을 받습니다(ccxt와 같습니다). 예전에는 `Decimal`을 숫자로 읽지 못해, 한국투자증권은 `Decimal` 수량을 `InvalidOrder`로 거절했고 토스는 조건주문 가격과 `params['cost']`를 빠진 값으로 읽었습니다.
- Python 비동기 판의 콜백 타입 힌트(`confirm_execution`의 `probe`, 토큰 발급 함수, `stockDirectory.find_kr_market`)를 코루틴을 돌려주는 모양으로 고쳤습니다. 동기 판 생성기가 `Awaitable[X]`를 `X`로 바꿉니다.
- 한국투자증권 미체결(국내, 미국)과 잔고, 주문체결 조회가 첫 쪽만 받던 것을 고쳤습니다. 응답 헤더 `tr_cont`가 `F`나 `M`이면 연속조회로 이어 받고, 10쪽을 넘으면 일부만 돌려주지 않고 `BadResponse`를 던집니다. 그래서 `cancelAllOrders`가 뒤쪽 미체결을 남긴 채 성공을 돌려주지 않습니다.
- 한국투자증권 분봉 연속조회가 경계 시각의 봉을 두 번 넣던 것을 고쳤습니다. 재표본한 분봉의 거래량이 두 번 더해지지 않습니다.
- 한국투자증권 캔들의 조회 날짜를 실행 환경의 시간대가 아니라 한국 날짜로 만듭니다. 예전에는 서버 시간대가 한국이 아니면 오늘 봉이 빠질 수 있었습니다.
- 한국투자증권 `fetchOHLCV`가 야후에 통합 심볼(`BRK.B`)을 넘깁니다. 야후 조회 폭이 상한(분봉)을 넘으면 경고 로그를 남기고, 상한 안의 과거 분봉 요청이 422 로 거절되던 것을 고쳤습니다.
- 실시간: 한국투자증권 실시간 콜백이 던지면 처리되지 않은 promise 거부로 프로세스가 끝나던 것을 고쳤습니다. 연결을 준비하는 중에 `stop()`이나 `close()`를 부르면 소켓이 뒤늦게 열려 남던 것을 고쳤습니다(한국투자증권, 토스증권). 옛 소켓의 늦은 이벤트는 무시합니다. 토스 핑 타이머가 프로세스 종료를 막지 않습니다.
- 실시간: 구독이 한 번 거부되면 같은 종목의 `watch*`가 영원히 기다리던 것을 고쳤습니다. 체결통보 구독이 거부되면 `watchOrders(symbol)`도 거절합니다. `KisPriceWs.updateSubs`가 빠진 구독을 해지합니다. 다건 프레임에 필드가 늘어도 두 번째 레코드부터 값이 밀리지 않습니다.
- 실시간: 한국투자증권 `watchOrders`가 정정과 취소 통보를 원주문(`ooder_no`)에 반영하고, 체결단가로 `cost`와 `average`를 채웁니다. 거부 여부(`rfus_yn`)는 `'1'`을 거부로 읽습니다(예전에는 `'Y'`와 비교해 거부를 잡지 못했습니다). 접수 통보의 수량과 단가, 해외 체결단가의 소수 자리도 공식 예제의 필드 설명대로 읽습니다.
- Python 실시간: 시간 초과로 취소된 `watch_*` 대기자에게 갱신이 넘어가 사라지던 것을 고쳤습니다. 한 인스턴스를 `asyncio.run` 여러 번에 걸쳐 쓰면 세션과 실시간 연결을 새 이벤트 루프에서 다시 엽니다.
- 한국투자증권 `market()`과 `amountToPrecision()`이 종목 마스터 없이도 동작합니다. 예전에는 마스터 없이 `loadMarkets()`를 부르면 `BadSymbol`, 부르기 전에는 `markets not loaded`였습니다.
- 토스증권 국내 종목의 `createMarketBuyOrderWithCost`는 요청 없이 `NotSupported`를 던집니다. 예전에는 수량 검사에 걸려 `ArgumentsRequired`였습니다.
- 한국투자증권 `fetchBalance`가 같은 종목의 잔고 행(현금, 자기융자, 대출일자별)을 마지막 행으로 덮어쓰던 것을 고쳤습니다. 수량을 더하고, 원문 행 전부를 `info.rows`에 싣습니다. `info`의 나머지 필드는 첫 행입니다.
- 한국투자증권 원화와 달러 잔고, KB증권 `fetchOrder`의 체결 합계를 문자열 십진 연산으로 계산합니다. 예전에는 `799.9000000000001` 같은 부동소수 잡음이 남았습니다.
- 토스증권 미국 소수점 시장가 매도 수량을 십진으로 자릅니다. 예전에는 `8.2`주가 `8.199999`주로 나가 0.000001주가 남았습니다.
- 한국투자증권 `fetchTicker`의 `change`가 등락률이 반올림으로 `0.00`이면 0 이 되던 것을 고쳤습니다. 이때는 전일대비부호로 부호를 정합니다.
- Python 비동기 판이 코루틴 함수 옵션(`nxtRouting`, `krwIntegratedMargin`, `usExtendedLimit`, `usdKrwRate`, `stockDirectory.find_kr_market`)을 기다립니다. 예전에는 코루틴 객체를 그대로 써서 옵션이 꺼진 것으로 읽혔습니다. `tokenStore`에 코루틴을 돌려주는 함수를 넘기면 `NotSupported`입니다.
- Python 비동기 판은 동시에 부른 `load_markets()`가 조회 하나를 함께 기다리고, `close()`는 띄운 작업을 5초까지만 기다립니다.
- Python 동기 판은 `~/.netrc`와 환경 변수 프록시를 따르지 않고(`requests_trust_env`로 켤 수 있습니다), `close()`가 사용자가 넘긴 세션을 닫지 않습니다. charset 없는 `text/*` 응답은 UTF-8 로 읽어 한글 오류 원문이 깨지지 않습니다.
- 달력에 없는 날짜(`00000000`, 달 `13`)의 `kstStamp`가 Python 판에서 `ValueError`를 던지고 TypeScript 판에서 다른 날로 넘기던 것을 고쳤습니다. 두 판 모두 `timestamp`와 `datetime`을 비웁니다.
- 보안: verbose 로그에서 JSON 이나 폼으로 읽지 못한 본문은 원문 대신 길이만 남깁니다. 예전에는 원문을 그대로 남겨, 깨진 JSON 에 섞인 비밀 필드가 가려지지 않았습니다.
- 토스증권 조건주문의 `triggerPrice`(둘째 조건 포함)가 없거나 숫자가 아니면 `ArgumentsRequired`, 0 이하면 `InvalidOrder`를 요청 전에 던집니다. 예전에는 트리거 가격이 빠진 조건을 보냈고, 고액주문 확인 플래그도 붙지 않았습니다.
- 보안: verbose 로그에서 비밀 헤더(`authorization`, `appkey`, `appsecret`)와 본문 필드(`appsecret`, `secretkey`, `client_secret`, `access_token`, `approval_key`, `refresh_token`)를 가립니다. 한국투자증권 체결통보 TR 은 암호화되지 않은 프레임을 버립니다. 실시간 주소는 `urls.ws`와 `urls.wsTest`를 따릅니다. 토스 `TossTokenRejected.failedToken`은 열거되지 않습니다.
- KB증권 토큰 차단기가 프로세스 전체에 하나라 한 계정의 실패가 다른 계정의 주문까지 막던 것을 고쳤습니다. 앱키마다 따로 셉니다.
- 토큰 발급 락을 잡은 뒤 저장소를 다시 읽지 않아 한국투자증권과 KB증권이 한 번 더 발급하던 것을 고쳤습니다. 락을 못 잡으면 발급 상한(12초)까지 저장소를 다시 읽습니다.
- KB증권 `invalidate`가 동시 요청 가운데 먼저 받은 새 토큰까지 지우던 것, 만료 직전의 짧은 `expires_in`에 TR 마다 토큰을 발급하던 것을 고쳤습니다. 토스 `invalidate`는 같은 토큰일 때만 지우는 원자적 삭제를 씁니다.
- 한국투자증권 요청 간격 조절이 시스템 시각 대신 단조 시계를 씁니다. 시스템 시각이 뒤로 가도 요청이 멈추지 않습니다.
- Python 비동기 판 `throttle`이 모르는 버킷에 `ExchangeError`를 던집니다(동기 판, TypeScript 판과 같다).
- KB증권 주문·체결 조회(`SSQM2341`, `SPQM2103`)가 첫 페이지만 읽던 것을 고쳤습니다. 모든 페이지를 읽고, 페이지 상한에서 잘리면 일부만 돌려주지 않고 `BadResponse`를 던집니다. 연속 페이지에는 연속구분(`cn_clsf`) `1`을 보냅니다.
- KB증권 미국 `fetchOrder`가 체결되지 않은 주문을 `OrderNotFound`로 던지던 것을 고쳤습니다. 해외 체결현황(`SPQM2204`)에서 찾아 `open`, `canceled`, `rejected`로 돌려줍니다.
- KB증권 해외 체결 조회가 조회일자를 한국 날짜로 보내던 것을 고쳤습니다. 조회일자 되감기 캐시를 국내와 해외로 나눠, 한쪽의 휴장일 되감기가 다른 쪽 조회 날짜를 밀어내지 않습니다.
- KB증권 국내 취소가 원주문의 라우팅(SOR)을 싣지 않고 KRX 로 보내던 것을 고쳤습니다.
- KB증권 `fetchBalance`가 계좌자산평가에서 종목코드나 수량을 읽지 못한 보유 행을 버린 채 `COMPLETE`로 내던 것을 고쳤습니다. 해외 경로도 같습니다. 보유주식 연속조회가 같은 다음키를 되풀이하면 `PARTIAL`입니다.
- KB증권이 `A` 접두를 붙여 준 신형 영숫자 국내 코드(`A0193L0`)를 해외 종목으로 분류해 계좌자산평가 경로에서 보유가 빠지던 것을 고쳤습니다.
- KB증권의 해외 체결 조회와 원마켓 증거금 조회가 연결 끊김이나 5xx 한 번에 인스턴스 수명 내내 꺼지던 것을 고쳤습니다. KB 가 응답으로 거절한 업무 오류만 영구 실패로 봅니다.
- `options.confirmBudget` 함수가 던지면 주문을 보낸 뒤에 예외가 나가던 것을 고쳤습니다. 기본 예산을 씁니다.
- Python 판: 토스 계좌 순번(`uid`)을 정수로 주면 비동기 판이 요청 전에 `TypeError`를 던지던 것을 고쳤습니다. 동기 판은 보내기 전에 실패한 요청을 `OrderOutcomeUnknown`이 아니라 `BadRequest`로 던집니다.
- KB증권 `fetchBalance`가 국내 보유를 다 읽지 못했는데도 `info.readStatus`를 `COMPLETE`로 내던 것을 고쳤습니다. 계좌자산평가(`SSQM2952`)가 실패해 보유주식(`SSQM1801`)으로 내려갔는데 그 행이 전부 걸러졌거나, 종목코드를 못 읽어 버린 행이 있거나, 연속조회가 상한에서 잘렸거나, 결과가 비었으면 `PARTIAL`이고 `info.unreadMarkets`에 `KR`이 들어갑니다. 예전에는 해외 조회만 보고 판정해서 `unreadMarkets`에는 `US`만 나왔습니다.
- 빌드한 `dist/`를 Node.js ESM에서 불러오지 못하던 것을 고쳤습니다(확장자 없는 상대 경로 `./base` 때문에 `ERR_UNSUPPORTED_DIR_IMPORT`). CI가 `exports`의 모든 경로를 Node.js로 불러와 확인합니다(`scripts/check-dist-imports.mjs`).
- KB증권의 `fetchTicker`, `fetchOrderBook`, `fetchBalance`, `cancelOrder`, `fetchOpenOrders` 등이 `params`를 요청에 싣지 않던 것을 고쳤습니다.
- 한국투자증권 해외 실시간 체결과 호가(`HDFSCNT0`, `HDFSASP0`, `HDFSASP1`)의 필드 이름이 한 칸씩 밀려 있던 것을 고쳤습니다.
- 토스증권 주문 조회의 `fee.cost`가 문자열(`"889"`)이던 것을 고쳤습니다. 고친 메서드는 `fetchOrder`, `fetchOpenOrders`, `fetchClosedOrders`입니다. 값은 `fees[0].cost`와 같은 숫자입니다.
- 토스증권 수수료율(`GET /commissions`)의 `commissionRate`가 `null`이면 수수료를 0%로 읽던 것을 고쳤습니다. 이제 `null`은 수수료율을 모르는 경우로 다룹니다. 이때 `fetchTradingFee`는 시장별 기본 위탁수수료율(국내 0.015%, 미국 0.1%)을 돌려줍니다.
- 토스증권 미국 주식의 `editOrder`가 고액주문 확인 표시(`confirmHighValueOrder`)를 붙이지 못하던 것을 고쳤습니다. 미국 정정은 수량을 받지 않습니다. 그래서 정정 전에 주문 상세(`GET /orders/{orderId}`)를 조회하고 남은 수량과 새 가격으로 주문 금액을 계산합니다. 조회가 실패하면 표시 없이 정정 요청을 보냅니다.
- 토스증권 `createOrder`가 체결 확정 조회에서 `null`을 받으면 `TypeError`를 던지던 것을 고쳤습니다. 이때 주문은 이미 접수됐으므로 오류를 던지지 않고 `status: 'open'`인 주문을 돌려줍니다.
- 토스증권 `fetchBalance`에 `symbol`과 `currency`를 함께 주면 요청 없이 빈 잔고를 돌려주던 것을 고쳤습니다. 이제 `symbol`의 보유 수량과 `currency`의 현금을 함께 받습니다.
- 토스증권 미국 장 운영 캘린더에서 세션 키가 없는 날을 개장일로 보던 것을 고쳤습니다. 날짜가 없는 항목은 오류 없이 건너뜁니다.
- 토스증권 `fetchMarketCalendar`가 `'KR'`이 아닌 값을 모두 미국으로 보던 것을 고쳤습니다. 대소문자는 가리지 않고(`'kr'`은 국내) `'KR'`과 `'US'` 밖의 값에는 요청 없이 `BadRequest`를 던집니다.
- 한국투자증권 `cancelAllOrders`가 국내 주문의 원주문 조직번호(`KRX_FWDG_ORD_ORGNO`)를 비워 보내던 것을 고쳤습니다. 취소 요청에 미체결 행의 주문채번지점번호(`ord_gno_brno`)를 싣습니다. 한국투자증권 공식 예제와 같은 방식입니다.
- 한국투자증권 해외 주문과 체결의 시각이 13~14시간 어긋나던 것을 고쳤습니다. 국내 주문일시가 없을 때 현지 주문일시(`ord_dt`, `ord_tmd`)를 한국 시각으로 읽었기 때문입니다. 이제 미국 동부 시각으로 읽고 서머타임을 반영합니다.
- 한국투자증권 `fetchOHLCV`의 4시간 봉에서 1시간 봉 하나가 빠지던 것을 고쳤습니다.
- 한국투자증권 `fetchOHLCV`가 월봉(`1M`)과 주봉(`1W`)의 진행 중인 마지막 봉 시각을 5분 단위로 내리던 것을 고쳤습니다.
- 한국투자증권 `fetchOHLCV`가 미국 일봉을 한국투자증권 API로 다시 받을 때 쓰는 기준일(`BYMD`)을 고쳤습니다. 예전에는 실행 환경의 시간대에 따라 날짜가 달라졌습니다. 이제 미국 동부 날짜를 씁니다.
- 한국투자증권 `fetchOHLCV`가 `BRK.B` 같은 미국 종목을 야후 파이낸스에서 찾지 못하던 것을 고쳤습니다. 야후 표기(`BRK-B`)로 조회합니다.
- 한국투자증권 `fetchRankings`의 해외 순위 심볼이 `BRK/B/USD`로 나오던 것을 고쳤습니다. 다른 메서드와 같은 `BRK.B/USD`입니다.
- 한국투자증권 국내 종목 마스터 검색이 `0193L0`처럼 영문자가 든 코드를 코드로 찾지 못하던 것을 고쳤습니다. 코드도 대소문자를 가리지 않고 비교합니다.

## [0.1.0] - 2026-09-21

첫 공개 버전입니다. 이 버전에는 태그를 만들지 않았습니다.

### 추가

- 한국 증권사 API를 ccxt처럼 쓰는 클래스 `kis`(한국투자증권), `toss`(토스증권), `kbsec`(KB증권)을 냈습니다.
- ccxt식 통합 자료 구조(`Market`, `Ticker`, `Order`, `Trade`, `Balances`)와 오류 계층(`ExchangeError` 계열)을 따랐고, 주문 접수 여부를 모를 때 던지는 `OrderOutcomeUnknown`을 추가했습니다.
- 증권사 캘린더 API로 받는 휴장일, 토큰 발급 잠금, 증권사별 호출 한도를 넣었습니다.

[Unreleased]: https://github.com/jewon-oh/kr-broker/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/jewon-oh/kr-broker/releases/tag/v0.5.0
