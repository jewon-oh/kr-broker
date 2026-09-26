# 버전 정책

`kr-broker` 라이브러리는 [유의적 버전 2.0.0](https://semver.org/lang/ko/)을 따릅니다. 현재 버전은 0.x입니다.

npm에는 아직 게시하지 않았습니다. 버전별 변경은 [CHANGELOG](../CHANGELOG.md)에서 확인합니다.

## 공개 API

버전 규칙은 아래를 공개 API로 보고 적용합니다.

- 진입점이 내보내는 이름(증권사 클래스, `Exchange`, 오류 클래스, 자료 구조 타입, `setLogger`)
- 아래 공개 하위 경로가 내보내는 이름
- 메서드의 이름, 인자 순서, 반환 형식
- 인스턴스 옵션(`options`)의 이름과 기본값
- 오류 클래스의 이름과 상속 관계, `retryable` 값
- 증권사 클래스의 `has` 값
- 심볼 형식(`005930/KRW`, `AAPL/USD`)

### 공개 하위 경로

`package.json`의 `exports`가 여는 하위 경로 가운데 아래 표의 경로가 공개 API입니다. 표에 없는 경로는 예고 없이 바뀌거나 사라질 수 있습니다. `exports`에 경로를 더하거나 빼면 이 표도 고칩니다.

| 범위 | 경로 |
|---|---|
| 공통 | `kr-broker/base/errors`, `kr-broker/base/types`, `kr-broker/broker-krx-code`, `kr-broker/broker-market-group`, `kr-broker/broker-time`, `kr-broker/execution-confirm`, `kr-broker/krx-sell-tax`, `kr-broker/krx-tick-size`, `kr-broker/krx-trading-hours`, `kr-broker/logger`, `kr-broker/market-calendar`, `kr-broker/options`, `kr-broker/token-refresh-lock`, `kr-broker/trading-hours`, `kr-broker/us-market-hours` |
| 한국투자증권 | `kr-broker/kis`, `kr-broker/kis/kis-candle-service`, `kr-broker/kis/kis-error-codes`, `kr-broker/kis/kis-master-data`, `kr-broker/kis/kis-overseas-master`, `kr-broker/kis/kis-price-ws`, `kr-broker/kis/kis-rate-limiter`, `kr-broker/kis/kis-realtime-parser`, `kr-broker/kis/kis-stock-master`, `kr-broker/kis/kis-types`, `kr-broker/kis/kr-market`, `kr-broker/kis/yahoo-finance-candles` |
| 토스증권 | `kr-broker/toss`, `kr-broker/toss/toss-auth`, `kr-broker/toss/toss-errors`, `kr-broker/toss/toss-trading-hours`, `kr-broker/toss/toss-types` |
| KB증권 | `kr-broker/kbsec`, `kr-broker/kbsec/kbsec-auth`, `kr-broker/kbsec/kbsec-chart`, `kr-broker/kbsec/kbsec-envelope`, `kr-broker/kbsec/kbsec-error-codes`, `kr-broker/kbsec/kbsec-fee`, `kr-broker/kbsec/kbsec-order-body`, `kr-broker/kbsec/kbsec-overseas-settlement-match`, `kr-broker/kbsec/kbsec-overseas-settlement-row`, `kr-broker/kbsec/kbsec-settlement-match`, `kr-broker/kbsec/kbsec-settlement-row`, `kr-broker/kbsec/kbsec-tr-inputs`, `kr-broker/kbsec/kbsec-types` |

`kr-broker/logger`로는 라이브러리의 유일한 전역 설정인 로거를 바꿉니다. `kr-broker/token-refresh-lock`의 `refreshTokenWithLock`은 `options.tokenStore`를 직접 구현할 때, 그 저장소가 여러 프로세스 사이의 잠금 규칙에 맞는지 확인하는 데 씁니다.

증권사 클래스 밖에서 쓰도록 남긴 공개 도우미가 셋 있습니다. `kr-broker/kis/kis-types`의 `getKisEffectiveFeeRate`와 `kr-broker/kbsec/kbsec-fee`의 `kbsecEstimatedFee`는 매도 거래세까지 더한 실효 수수료율을 구합니다. `fetchTradingFee`는 거래세를 싣는 자리가 증권사마다 달라서, 두 증권사의 실효율을 같은 방식으로 얻으려면 이 도우미를 씁니다. `kr-broker/broker-time`의 `timeframeToMs`는 읽지 못한 타임프레임에 `NaN`을 돌려줍니다. 진입점의 `parseTimeframe`은 모르는 단위에 `NotSupported`를 던집니다.

`kr-broker/testing`은 테스트 전용 경로입니다. 모듈 전역 상태를 비우거나 읽거나 채우는 훅을 모았습니다. KB증권 토큰 차단기와 체결 경고의 훅(`__resetKbsecTokenBreaker`, `kbsecTokenBreakerState`, `__resetFillSideWarn`)과 휴장일 캘린더를 채우고 비우는 훅(`applyMarketCalendar`, `resetMarketCalendar`)이 있습니다. Python 판은 `kr_broker.testing`에서 캘린더 훅(`apply_market_calendar`, `reset_market_calendar`)을 가져옵니다. 이 경로는 호환을 약속하지 않으므로 운영 코드에서 가져오지 않습니다.

## 0.x의 규칙

| 변경 | 올리는 버전 |
|---|---|
| 파괴적 변경 | minor (0.1.0에서 0.2.0) |
| 기능 추가 | minor |
| 버그 수정 | patch |
| 증권사 API 변경 대응 | patch 또는 minor. 아래 표를 따릅니다 |

파괴적 변경은 CHANGELOG의 `변경` 또는 `제거` 항목에 적고, 코드를 어떻게 고쳐야 하는지 한 줄로 안내합니다.

1.0.0을 내는 시점은 정하지 않았습니다. 1.0.0 이후에는 파괴적 변경을 major로 올립니다.

## 릴리스

- 버전마다 `v<버전>` 태그를 만들고, GitHub Release에 CHANGELOG의 해당 절을 옮깁니다. 만든 태그는 옮기거나 지우지 않습니다.
- 태그를 만들기 전에 버전 번호 세 곳(`package.json`, `python/pyproject.toml`, `python/kr_broker/__init__.py`)과 README, `python/README.md`의 설치 예시를 새 태그로 바꿉니다.

## 증권사 API 변경 대응

증권사가 API를 바꾸면 라이브러리는 바뀐 API를 따라갑니다. 버전은 라이브러리 사용자가 보는 결과에 따라 정합니다.

| 결과 | 올리는 버전 | 예 |
|---|---|---|
| 요청만 고치고 반환 형식, 오류 클래스, 옵션이 그대로입니다 | patch | 요청 필드 이름이 바뀌었습니다 |
| 오류 코드를 기존 오류 클래스에 연결합니다 | patch | 새 거절 코드를 `InvalidOrder`로 분류합니다 |
| 반환 형식, 오류 클래스, `has`, 옵션이 바뀝니다 | minor | 증권사가 기능을 없애서 `has` 값이 `false`가 됩니다 |
| 사용자 코드를 고쳐야 합니다 | minor | 새 필수 인자가 생겼습니다 |

증권사 API가 바뀌어 기존 주문 경로가 동작하지 않으면 수정판을 먼저 냅니다. 파괴적 요소가 있으면 minor로 올립니다.

대응 절차는 [기여 안내](../CONTRIBUTING.md)의 증권사 API 변경 대응에 있습니다.

## 오류 클래스 변경

| 변경 | 처리 |
|---|---|
| 새 오류 클래스 추가 | minor |
| 오류를 더 구체적인 하위 클래스로 바꿈 | minor. CHANGELOG의 `변경`에 적습니다 |
| 오류 클래스의 이름 변경, 삭제, 부모 변경 | 파괴적 변경 |
| `retryable` 값 변경 | 파괴적 변경 |
| `detail` 값 추가 | minor |
| 기존 `detail` 값의 이름 변경 | 파괴적 변경 |

오류를 하위 클래스로 바꿔도 부모 클래스의 `instanceof` 검사는 그대로 통과합니다. 클래스를 정확히 비교하는 코드(`error.name === 'ExchangeError'` 등)는 버전 정책이 보호하지 않습니다.

증권사의 오류 코드는 `brokerCode`에 그대로 담깁니다. 한국투자증권과 토스증권은 `detail`도 대개 같은 값입니다. 증권사가 코드를 바꾸면 이 값도 바뀝니다. 이런 변화는 증권사 API 변경 대응으로 다룹니다.

## has 값 변경

`has`는 메서드 단위로 지원 여부를 알립니다. `true`, `false`, `'emulated'` 중 하나입니다.

| 변경 | 처리 |
|---|---|
| `false`에서 `true` 또는 `'emulated'`로 | 기능 추가. minor |
| `'emulated'`에서 `true`로, 또는 반대로 | minor. CHANGELOG의 `변경`에 적습니다 |
| `true` 또는 `'emulated'`에서 `false`로 | 파괴적 변경 |

`has`와 구현이 어긋나지 않는지는 `ts/src/__tests__/broker-capabilities.test.ts`가 검사합니다. `has`를 바꾸는 PR은 이 테스트를 통과해야 합니다.

`has`는 시장별 제약을 알리지 못합니다. `국내만`, `실전만` 같은 제약이 바뀌면 README의 기능별 지원 표와 CHANGELOG를 고칩니다. `has`는 그대로이므로 버전은 patch 또는 minor로 올립니다.

## TypeScript(Node.js) 지원 범위

| 항목 | 값 |
|---|---|
| `package.json`의 `engines` | Node.js 22 이상 |
| `.nvmrc` | 22 |
| CI 검사 | Linux의 Node.js 22와 24, Windows의 Node.js 22 |

Node.js 22 미만에서는 동작을 확인하지 않았습니다.

지원하는 Node.js 최소 버전을 올리는 변경은 파괴적 변경입니다. CI 매트릭스에 새 Node.js 버전을 추가하는 변경은 patch입니다.

런타임 의존성은 실시간 시세용 `ws` 하나입니다. HTTP 요청은 전역 `fetch`를 사용합니다.

## Python 지원 범위

| 항목 | 값 |
|---|---|
| `pyproject.toml`의 `requires-python` | Python 3.10 이상 |
| CI 검사 | Linux의 Python 3.10과 3.13 |

Python 판은 동기 판(`kr_broker`), 비동기 판(`kr_broker.async_support`), 실시간 판(`kr_broker.pro`)을 TypeScript 판과 같은 버전 번호로 냅니다. 동기 판 증권사 파일은 비동기 판에서 만들므로 두 판의 공개 API는 같습니다.

Python 3.10 미만에서는 동작을 확인하지 않았습니다. 지원하는 Python 최소 버전을 올리는 변경은 파괴적 변경입니다.
