# kr-broker (Python)

한국투자증권과 토스증권 Open API를 [ccxt](https://github.com/ccxt/ccxt) 방식으로 부르는 Python 라이브러리입니다.
TypeScript 판과 같은 저장소에 있고, 같은 엔드포인트 표(`ts/src/spec/*.json`)와 요청 픽스처(`ts/src/test/static/request/`)를 씁니다.

## 설치

```bash
pip install kr-broker
```

Python 3.10 이상이 필요하고, 의존성은 `requests`(동기 판)와 `aiohttp`(비동기 판)입니다.

## 지금 되는 것

- 한국투자증권(`kr_broker.kis`)과 토스증권(`kr_broker.toss`)의 인증, 서명, 오류 처리, 호출 간격 조절입니다.
- 두 증권사의 모든 엔드포인트를 암묵 메서드로 부를 수 있습니다. 한국투자증권 272개, 토스증권 36개입니다.
- 두 증권사 모두 아래 표의 통합 메서드를 부를 수 있습니다. 웹소켓(`watch_*`)은 아직 없어서 `broker.has`에서 `False`입니다.

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

오류 클래스는 ccxt 계층을 따르고 `kr_broker`에서 바로 가져올 수 있습니다. 증권사 오류 코드는 `error.detail`에 있습니다.

```python
try:
    kis.private_post_uapi_domestic_stock_v1_trading_order_cash({...})
except kr_broker.OrderOutcomeUnknown:
    ...  # 주문이 접수됐는지 모른다. 다시 보내지 말고 주문 조회로 확인한다
except kr_broker.InsufficientFunds as e:
    print(e.detail)
```

주문 요청은 재시도하지 않습니다. 시간 초과나 연결 끊김으로 끝나면 `OrderOutcomeUnknown`입니다.

### 토큰 저장소

증권사 토큰은 발급 횟수에 제한이 있고, 토스는 클라이언트당 유효 토큰이 하나뿐입니다. 여러 프로세스가 같은 키를 쓰면
`options['tokenStore']`에 `kr_broker.BrokerTokenStore` 계약(`get`, `set`, `delete`, `delete_if_access_token_equals`, `try_lock`, `unlock`)을
따르는 저장소를 넘깁니다. 넘기지 않으면 프로세스 메모리에만 둡니다.

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

- `async with` 를 쓰지 않으면 다 쓴 뒤 `await kis.close()` 로 HTTP 세션을 닫습니다. 설정에 `session` 으로 넘긴 aiohttp 세션은 닫지 않습니다.
- 동기 판은 비동기 판 소스에서 만들므로 요청과 응답 해석이 같습니다. 요청 픽스처를 두 판으로 모두 돌립니다.
- 토큰 저장소는 메서드가 값을 돌려주는 동기 구현과 코루틴을 돌려주는 비동기 구현(예: `redis.asyncio`)을 모두 받습니다.
- 한국투자증권이 토큰 만료로 응답하면 두 판 모두 메모리의 토큰을 바로 비웁니다. 저장소의 토큰은 동기 판이 그 자리에서 지우고, 비동기 판은 기다리지 않는 작업으로 지웁니다(TypeScript 판과 같습니다).

## 개발

```bash
cd python
uv venv && uv pip install -e '.[dev]'
.venv/bin/pytest
```

`kr_broker/abstract/*.py`는 `node scripts/gen-python-abstract.mjs`가 엔드포인트 표에서 만듭니다. 직접 고치지 않습니다.

`kr_broker/kis.py`, `kr_broker/toss.py` 같은 동기 판 여섯 파일은 `node scripts/gen-python-sync.mjs`가 `kr_broker/async_support/`의 같은 이름 파일에서 만듭니다.
ccxt 와 같은 규칙으로 `async`와 `await`를 지웁니다. 고칠 때는 `async_support/` 쪽 파일을 고치고 생성 스크립트를 돌립니다. 파일 첫 줄에 생성 표시가 있습니다.
