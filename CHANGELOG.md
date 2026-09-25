# 변경 이력

이 파일은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따르고, 버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다. 0.x에서 버전을 올리는 규칙은 [버전 정책](docs/versioning.md)에 있습니다.

## [Unreleased]

### 바뀜(호환되지 않음)

- `package.json`의 `exports`에서 내부 모듈 경로 세 개를 뺐습니다. `kr-broker/kis/kis-auth`, `kr-broker/kis/kis-candle-pagination`, `kr-broker/kbsec/kbsec-fill-row`는 증권사 클래스가 안에서 쓰는 도우미라 대신할 경로가 없습니다. 인증과 연속조회, 체결 행 해석은 `kis`와 `kbsec` 클래스의 메서드가 처리합니다.
- 진입점(`kr-broker`)에서 휴장일 캘린더를 바꾸는 함수와 내부 도우미를 더 내보내지 않습니다. 빠진 이름은 `applyMarketCalendar`, `resetMarketCalendar`, `refreshMarketCalendar`, `expandBusinessDays`, `CALENDAR_RETRY_MS`입니다. `resetMarketCalendar()`를 부르면 같은 프로세스의 모든 인스턴스가 받은 휴장일을 잃습니다. 다섯 이름은 `kr-broker/market-calendar`에서 가져옵니다. 캘린더는 인스턴스의 `refreshMarketCalendar()`로 받습니다. 읽기 함수(`marketCalendarStatus`, `marketDayStatus`, `isMarketClosedDay`)와 캘린더 타입은 진입점에 남았습니다.
- `kr-broker/krx-sell-tax`의 `__resetKrxSellTaxWarnLatchForTest`를 지웠습니다. 테스트도 쓰지 않던 훅입니다.
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
- 토스증권과 KB증권이 캐시 시각과 세션 판정, 날짜 기본값을 인스턴스 시계(`milliseconds()`)에서 읽습니다. 예전에는 `Date.now()`와 `new Date()`를 섞어 써서, `milliseconds`를 바꿔 끼우면 일부 경로만 시각이 바뀌었습니다. 한국투자증권은 이미 인스턴스 시계만 씁니다.
- 토스증권이 확장세션 국내 주문을 막을 때 내는 오류 문구가 옵션 이름 `nxtRouting`을 가리킵니다. 예전 문구는 `nxt-routing`이었습니다.
- `build`가 `tsc` 뒤에 `tsc-alias -f`를 돌려 `dist/`의 상대 경로에 확장자를 채웁니다. GitHub 주소로 설치하면 `prepare`가 같은 빌드를 돌립니다.
- 저장소 배치를 ccxt와 같게 바꿨습니다. TypeScript 소스는 `ts/src/`, Python 패키지는 `python/kr_broker/`, 두 판이 함께 쓰는 테스트 자료는 `ts/src/test/static/`, 예제는 `examples/ts/`와 `examples/py/`에 있습니다. 패키지 이름과 하위 경로(`kr-broker/…`)로 가져오는 코드는 바꿀 필요가 없습니다.

### 고침

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

첫 공개 버전입니다.

### 추가

- 한국 증권사 API를 ccxt처럼 쓰는 클래스 `kis`(한국투자증권), `toss`(토스증권), `kbsec`(KB증권)을 냈습니다.
- ccxt식 통합 자료 구조(`Market`, `Ticker`, `Order`, `Trade`, `Balances`)와 오류 계층(`ExchangeError` 계열)을 따랐고, 주문 접수 여부를 모를 때 던지는 `OrderOutcomeUnknown`을 추가했습니다.
- 증권사 캘린더 API로 받는 휴장일, 토큰 발급 잠금, 증권사별 호출 한도를 넣었습니다.

[Unreleased]: https://github.com/jewon-oh/kr-broker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jewon-oh/kr-broker/releases/tag/v0.1.0
