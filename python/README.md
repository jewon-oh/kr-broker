# kr-broker (Python)

한국투자증권과 토스증권 Open API를 [ccxt](https://github.com/ccxt/ccxt) 방식으로 부르는 Python 라이브러리입니다.
TypeScript 판과 같은 저장소에 있고, 같은 엔드포인트 표(`ts/src/spec/*.json`)와 요청 픽스처(`ts/src/test/static/request/`)를 씁니다.

## 설치

PyPI 에는 아직 게시하지 않았습니다. GitHub 주소로 설치합니다.

```bash
pip install "kr-broker @ git+https://github.com/jewon-oh/kr-broker.git@v0.5.0#subdirectory=python"
```

위 명령은 태그 `v0.5.0`에 고정합니다. 다른 버전이나 커밋은 `@` 뒤를 바꿉니다(`...kr-broker.git@9759def#subdirectory=python`).

Python 3.10 이상이 필요하고, 의존성은 `requests`(동기 판), `aiohttp`(비동기 판과 실시간 판), `cryptography`(한국투자증권 체결통보 복호)입니다.

## 지금 되는 것

- 한국투자증권(`kr_broker.kis`)과 토스증권(`kr_broker.toss`)의 인증, 서명, 오류 처리, 호출 간격 조절입니다.
- 두 증권사의 모든 엔드포인트를 암묵 메서드로 부를 수 있습니다. 한국투자증권 272개, 토스증권 36개입니다.
- 두 증권사 모두 아래 표의 통합 메서드를 부를 수 있습니다. 실시간(`watch_ticker`, `watch_trades`, `watch_order_book`, `watch_orders`)은 `kr_broker.pro`에 있습니다.

| 분류 | 한국투자증권 통합 메서드 | 토스증권 통합 메서드 |
|---|---|---|
| 종목과 시세 | `fetch_markets`, `fetch_ticker`, `fetch_tickers`, `fetch_order_book`, `fetch_ohlcv` | `fetch_markets`, `fetch_ticker`, `fetch_tickers`, `fetch_order_book`, `fetch_ohlcv` |
| 잔고와 수수료 | `fetch_balance`, `fetch_trading_fee` | `fetch_balance`, `fetch_trading_fee` |
| 주문 | `create_order`, `create_limit_order`, `create_market_order`, `create_trigger_order`, `edit_order`, `cancel_order`, `cancel_all_orders` | `create_order`, `create_limit_order`, `create_market_order`, `create_market_buy_order_with_cost`, `create_trigger_order`, `edit_order`, `cancel_order`, `cancel_all_orders` |
| 주문 조회 | `fetch_order`, `fetch_orders`, `fetch_open_orders`, `fetch_closed_orders`, `fetch_my_trades` | `fetch_order`, `fetch_open_orders`, `fetch_closed_orders`, `fetch_my_trades` |
| 고유 조회 | `fetch_market_calendar`, `fetch_stock_warnings`, `fetch_investor_trading`, `fetch_rankings` | `fetch_market_calendar`, `fetch_stock_warnings`, `fetch_investor_trading`, `fetch_rankings` |

고유 조회는 이름이 같아도 증권사마다 인자와 결과가 다릅니다. 예를 들어 `fetch_investor_trading`은 한국투자증권에서 종목 단위이고 토스증권에서 시장 단위입니다.

## 쓰는 법

ccxt 와 같습니다. 증권사 클래스에 설정 사전을 넘기고, 메서드는 snake_case 와 camelCase 이름으로 모두 부를 수 있습니다.

```python
import kr_broker

toss = kr_broker.toss({'apiKey': CLIENT_ID, 'secret': CLIENT_SECRET})
rate = toss.private_market_get_exchange_rate({'baseCurrency': 'USD', 'quoteCurrency': 'KRW'})

kis = kr_broker.kis({'apiKey': APP_KEY, 'secret': APP_SECRET, 'uid': '12345678-01'})
price = kis.privateGetUapiDomesticStockV1QuotationsInquirePrice({
    'tr_id': 'FHKST01010100',          # KIS 의 TR ID 는 params 로 넘기면 헤더로 옮겨진다
    'FID_COND_MRKT_DIV_CODE': 'J',
    'FID_INPUT_ISCD': '005930',
})

kis.set_sandbox_mode(True)             # 한국투자증권 모의투자
```

암묵 메서드 이름은 `api 이름 + HTTP 메서드 + 경로`입니다. 전체 목록은 `kr_broker/abstract/kis.py`와 `kr_broker/abstract/toss.py`에 있습니다.

주문 메서드의 숫자 인자(`amount`, `price`, `trigger_price`)와 `params`의 숫자 값에는 ccxt처럼 `Decimal`도 넘길 수 있습니다. 라이브러리가 입구에서 `float`로 바꾸므로, `float`로 나타낼 수 없는 자릿수는 요청에 실리지 않습니다. 결과의 숫자는 `float`입니다.

통합 메서드의 결과는 ccxt처럼 `dict`입니다. 반환 타입은 `kr_broker.base.types`의 `Order`, `Trade`, `Ticker`, `OrderBook`, `Balances`, `MarketInterface`, `TradingFeeInterface`입니다. ccxt처럼 `TypedDict`로 적었고(`Balances`는 `dict`를 상속한 타입입니다), 필드는 TypeScript 판과 같습니다. pyright(VS Code의 Pylance)와 mypy는 이 타입으로 필드와 값의 타입을 알려 줍니다(패키지에 `py.typed`가 있습니다). camelCase 이름과 `async with`로 받은 인스턴스도 같은 타입으로 검사합니다.

### 한국투자증권 통합 메서드

한국투자증권 통합 메서드는 TypeScript 판과 같은 요청을 만들고 같은 결과를 돌려줍니다. 인자와 `params`의 뜻은 `kr_broker/kis.py` 모듈 설명에 있습니다.

```python
kis = kr_broker.kis({
    'apiKey': APP_KEY, 'secret': APP_SECRET, 'uid': '12345678-01',
    'options': {'masterData': MASTER_DATA},   # 해외 종목의 거래소를 찾는 종목 마스터(kr_broker/kis_master_data.py 참고)
})
ticker = kis.fetch_ticker('005930/KRW')
balance = kis.fetch_balance()
order = kis.create_order('005930/KRW', 'limit', 'buy', 1, 70000)   # 휴장일 캘린더로 거래시간을 확인한 뒤 낸다
us_order = kis.create_order('AAPL/USD', 'limit', 'buy', 1, 170.5)
candles = kis.fetch_ohlcv('005930/KRW', '1d', limit=100)            # 야후 파이낸스에서 받는다
```

`create_order`는 거래시간 밖이면 요청을 보내지 않고 `MarketClosed`를 던집니다. 접수 응답에는 체결 정보가 없어서 `filled`가 비어 있습니다.
체결은 `fetch_order`와 `fetch_my_trades`로 확인합니다. 미국 주식은 지정가만 받고 `price`가 필요합니다.
해외 종목의 거래소는 `options['masterData']`에서 찾으므로, 마스터 데이터가 없으면 미국 종목의 시세와 주문은 `BadSymbol`입니다.

### 토스증권 통합 메서드

토스증권 통합 메서드는 TypeScript 판과 같은 요청을 만들고 같은 결과를 돌려줍니다. 인자와 `params`의 뜻은 `kr_broker/toss.py` 모듈 설명에 있습니다.

```python
toss = kr_broker.toss({'apiKey': CLIENT_ID, 'secret': CLIENT_SECRET, 'uid': ACCOUNT_SEQ})
ticker = toss.fetch_ticker('005930/KRW')
balance = toss.fetch_balance()
order = toss.create_order('005930/KRW', 'limit', 'buy', 1, 70000)   # 장 운영 캘린더로 세션을 확인한 뒤 낸다
stop = toss.create_trigger_order('005930/KRW', 'market', 'sell', 1, None, 65000, {'expireDate': '2026-12-31'})
```

`create_order`는 장 운영 캘린더로 지금 열린 세션을 확인합니다. 세션 밖이면 요청을 보내지 않고 `MarketClosed`를 던집니다.
주문이 접수되면 주문 상세를 짧게 조회해 체결 수량과 평균가, 수수료를 확정합니다.

### 오류

오류 클래스는 ccxt 계층을 따르고 `kr_broker`에서 바로 가져올 수 있습니다. 증권사가 준 원래 오류 코드는 `error.broker_code`에, 라이브러리가 가른 원인 이름은 `error.detail`에 있습니다.

```python
try:
    kis.private_post_uapi_domestic_stock_v1_trading_order_cash({...})
except kr_broker.OrderOutcomeUnknown:
    ...  # 주문이 접수됐는지 모른다. 다시 보내지 말고 주문 조회로 확인한다
except kr_broker.InsufficientFunds as e:
    print(e.detail)
```

주문 요청은 재시도하지 않습니다. 시간 초과나 연결 끊김, 증권사 오류 코드 없는 5xx, 해석할 수 없는 응답으로 끝나면 `OrderOutcomeUnknown`입니다.

동기 판의 시간 상한(`timeout`, `orderTimeout`)은 `requests`의 상한이라 연결 한 번과 소켓 읽기 한 번에 따로 걸립니다. 응답이 조금씩 오래 흘러오면 상한을 넘겨도 `RequestTimeout`이 나지 않습니다. 비동기 판과 TypeScript 판은 요청 전체에 상한을 겁니다.

동기 판은 `~/.netrc`와 환경 변수 프록시(`HTTPS_PROXY` 등)를 따르지 않습니다. `.netrc`의 Basic 인증이 `Authorization` 헤더를 덮어쓰지 않게 하려는 것입니다. 따르게 하려면 클래스 속성 `requests_trust_env`를 `True`로 둡니다. 비동기 판의 `aiohttp_trust_env`와 같습니다.

비동기 판에서 주문 호출을 `asyncio.wait_for`로 끊으면 `OrderOutcomeUnknown`이 아니라 `TimeoutError`가 나옵니다. 요청이 이미 나갔을 수 있으므로 이때도 다시 보내지 마십시오. 주문의 시간 상한은 `orderTimeout`으로 정합니다.

### 토큰 저장소

증권사 토큰은 발급 횟수에 제한이 있고, 토스는 클라이언트당 유효 토큰이 하나뿐입니다. 여러 프로세스가 같은 키를 쓰면
`options['tokenStore']`에 `kr_broker.BrokerTokenStore` 계약(`get`, `set`, `delete`, `delete_if_access_token_equals`, `try_lock`, `unlock`)을
따르는 저장소를 넘깁니다. 넘기지 않으면 프로세스 메모리에만 둡니다. 저장소 대신 저장소를 돌려주는 함수를 넘길 수도 있는데, 이 함수는 저장소를 바로 돌려줘야 합니다. 코루틴을 돌려주면 `NotSupported`입니다.

### 비동기 판

ccxt 의 `ccxt.async_support` 처럼 `kr_broker.async_support` 에 같은 이름의 증권사 클래스가 있습니다. 요청을 보내는 메서드는 코루틴이고, HTTP 는 aiohttp 로 보냅니다.

```python
import asyncio

import kr_broker.async_support as kr_broker


async def main():
    async with kr_broker.kis({'apiKey': APP_KEY, 'secret': APP_SECRET, 'uid': '12345678-01'}) as kis:
        ticker = await kis.fetch_ticker('005930/KRW')
        balance = await kis.fetch_balance()

asyncio.run(main())
```

- `async with` 를 쓰지 않으면 다 쓴 뒤 `await kis.close()` 로 HTTP 세션을 닫습니다. 설정에 `session` 으로 넘긴 세션은 닫지 않습니다(동기 판도 같습니다). `close()` 는 기다리지 않고 띄운 작업(토큰 저장소 정리 등)을 5초까지 기다리고, 그때까지 안 끝난 작업은 취소합니다.
- 켜고 끄는 옵션(`nxtRouting`, `blockAuctionBuys`, `krwIntegratedMargin`, `usExtendedLimit`)과 `usdKrwRate`, `stockDirectory.find_kr_market` 에는 비동기 판에서 코루틴 함수도 넘길 수 있습니다.
- 여러 코루틴이 동시에 `load_markets()` 를 부르면 조회는 한 번만 나가고 결과를 함께 씁니다.
- 동기 판은 비동기 판 소스에서 만들므로 요청과 응답 해석이 같습니다. 요청 픽스처를 두 판으로 모두 돌립니다.
- 토큰 저장소는 메서드가 값을 돌려주는 동기 구현과 코루틴을 돌려주는 비동기 구현(예: `redis.asyncio`)을 모두 받습니다.
- 한국투자증권이 토큰 만료로 응답하면 두 판 모두 메모리의 토큰을 바로 비웁니다. 저장소의 토큰은 동기 판이 그 자리에서 지우고, 비동기 판은 기다리지 않는 작업으로 지웁니다(TypeScript 판과 같습니다).

### 실시간 판(Pro)

ccxt 의 `ccxt.pro` 처럼 `kr_broker.pro` 의 증권사 클래스가 비동기 판을 상속하고 `watch_*` 를 더합니다. 웹소켓은 aiohttp 로 엽니다.

```python
import asyncio

import kr_broker.pro as kr_broker


async def main():
    async with kr_broker.kis({'apiKey': APP_KEY, 'secret': APP_SECRET, 'uid': '12345678-01'}) as kis:
        while True:
            ticker = await kis.watch_ticker('005930/KRW')   # 부를 때마다 다음 갱신을 돌려준다
            print(ticker['last'])

asyncio.run(main())
```

- `watch_*` 는 처음 부를 때 구독합니다. 체결과 주문은 기다리는 쪽이 없을 때 쌓아 두었다가 다음 호출에 한꺼번에 돌려줍니다.
- 연결이 끊기면 다시 잇고 구독을 다시 보냅니다. `close()` 는 실시간 연결과 HTTP 세션을 함께 닫고, 기다리던 `watch_*` 는 `ExchangeError` 로 끝납니다.
- 한국투자증권의 `watch_orders` 는 체결통보를 HTS ID 로 구독하므로 `options['htsId']` 가 필요합니다. 체결통보 본문은 구독 응답이 준 키로 복호합니다(`cryptography` 패키지).
- 같은 앱키와 접속키로 다른 프로그램이 이미 연결돼 있으면 한국투자증권이 새 연결을 끊습니다.
- 토스증권의 `watch_ticker` 는 체결 가격만 채웁니다. 호가는 구독 직후 스냅샷을 보내지 않아서 첫 값이 다음 호가 변경 때 옵니다.
- 가격만 콜백으로 받으려면 `create_price_stream()`, 한국투자증권의 다른 실시간 TR 을 받으려면 `create_realtime_stream()` 을 씁니다. TypeScript 판의 같은 이름 메서드와 같습니다.

## 개발

```bash
cd python
uv venv && uv pip install -e '.[dev]'
.venv/bin/pytest
```

`kr_broker/abstract/*.py`는 `node scripts/gen-python-abstract.mjs`가 엔드포인트 표에서 만듭니다. 직접 고치지 않습니다.

`kr_broker/kis.py`, `kr_broker/toss.py` 같은 동기 판 여섯 파일은 `node scripts/gen-python-sync.mjs`가 `kr_broker/async_support/`의 같은 이름 파일에서 만듭니다.
ccxt 와 같은 규칙으로 `async`와 `await`를 지웁니다. 고칠 때는 `async_support/` 쪽 파일을 고치고 생성 스크립트를 돌립니다. 파일 첫 줄에 생성 표시가 있습니다.
