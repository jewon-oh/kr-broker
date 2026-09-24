# kr-broker (Python)

한국투자증권과 토스증권 Open API를 [ccxt](https://github.com/ccxt/ccxt) 방식으로 부르는 Python 라이브러리입니다.
TypeScript 판과 같은 저장소에 있고, 같은 엔드포인트 표(`ts/src/spec/*.json`)와 요청 픽스처(`ts/src/test/static/request/`)를 씁니다.

## 설치

```bash
pip install kr-broker
```

Python 3.10 이상이 필요하고, 의존성은 `requests` 하나입니다.

## 지금 되는 것

- 한국투자증권(`kr_broker.kis`)과 토스증권(`kr_broker.toss`)의 인증, 서명, 오류 처리, 호출 간격 조절입니다.
- 두 증권사의 모든 엔드포인트를 암묵 메서드로 부를 수 있습니다. 한국투자증권 272개, 토스증권 36개입니다.
- 통합 메서드(`fetch_ticker`, `create_order` 등)는 TypeScript 판에서 차례로 옮기는 중입니다. 옮긴 메서드만 `broker.has` 에서 `True` 입니다.

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

암묵 메서드 이름은 `api 이름 + HTTP 메서드 + 경로` 입니다. 전체 목록은 `kr_broker/abstract/kis.py` 와 `kr_broker/abstract/toss.py` 에 있습니다.

### 오류

오류 클래스는 ccxt 계층을 따르고 `kr_broker` 에서 바로 가져올 수 있습니다. 증권사 오류 코드는 `error.detail` 에 있습니다.

```python
try:
    kis.private_post_uapi_domestic_stock_v1_trading_order_cash({...})
except kr_broker.OrderOutcomeUnknown:
    ...  # 주문이 접수됐는지 모른다. 다시 보내지 말고 주문 조회로 확인한다
except kr_broker.InsufficientFunds as e:
    print(e.detail)
```

주문 요청은 재시도하지 않습니다. 시간 초과나 연결 끊김으로 끝나면 `OrderOutcomeUnknown` 입니다.

### 토큰 저장소

증권사 토큰은 발급 횟수에 제한이 있고, 토스는 클라이언트당 유효 토큰이 하나뿐입니다. 여러 프로세스가 같은 키를 쓰면
`options['tokenStore']` 에 `kr_broker.BrokerTokenStore` 계약(`get`, `set`, `delete`, `delete_if_access_token_equals`, `try_lock`, `unlock`)을
따르는 저장소를 넘깁니다. 넘기지 않으면 프로세스 메모리에만 둡니다.

## 개발

```bash
cd python
uv venv && uv pip install -e '.[dev]'
.venv/bin/pytest
```

`kr_broker/abstract/*.py` 는 `node scripts/gen-python-abstract.mjs` 가 엔드포인트 표에서 만듭니다. 직접 고치지 않습니다.
