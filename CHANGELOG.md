# 변경 이력

이 파일은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따르고, 버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다. 0.x에서 버전을 올리는 규칙은 [버전 정책](docs/versioning.md)에 있습니다.

## [Unreleased]

### 바뀜(호환되지 않음)

- 증권사 고유 조회의 기간 끝을 위치 인자가 아니라 `params.until`(ms)로 받습니다. 예전 `until` 자리는 `limit`이 되었고, 그 자리에 ms 같은 큰 수가 오면 `BadRequest`를 던집니다.
- 날짜나 시각을 `YYYYMMDD`, `HHMMSS` 문자열로 받던 한국투자증권 조회는 그 인자를 없애고 `params.until`(ms)의 한국 날짜와 시각을 씁니다.
- 한국투자증권과 KB증권의 고유 결과 타입에서 필드 이름을 ccxt 용어로 바꿨습니다(`lastPrice` → `last`, `changeRate` → `percentage`, `closePrice` → `close`, `openPrice` → `open`, `highPrice` → `high`, `lowPrice` → `low`). 토스증권의 원문 응답 타입은 API 의 JSON 키를 그대로 따르므로 바꾸지 않았습니다.
- `fetchBondEvaluations`, `fetchCorporateSchedules`, `fetchOverseasCorporateActions`는 종목 인자를 `since` 앞으로 옮겼습니다.
- `kr-broker/kbsec/kbsec-types`에서 내보내던 `KBSEC_KRW_INTEGRATED_MARGIN_FLAG`를 지웠습니다. 패키지 안에서 쓰지 않던 예전 기능 플래그 이름입니다. 원마켓 계좌는 `options.krwIntegratedMargin`으로 켭니다.

### 추가

- Python 판을 더했습니다(`python/`). 한국투자증권과 토스증권의 인증, 서명, 오류 처리, 호출 간격 조절이 있고, 모든 엔드포인트를 암묵 메서드로 부를 수 있습니다. 한국투자증권의 통합 메서드는 차례로 옮깁니다.
- 토스증권의 통합 메서드(웹소켓 제외)를 Python 판에 옮겼습니다. 요청 픽스처에는 현재 시각을 고정하는 `now`를 더했습니다.
- 엔드포인트 표(`ts/src/spec/*.json`)에 세 증권사의 모든 엔드포인트를 담았습니다. 표가 `describe().api`와 어긋나면 테스트가 실패합니다.
- TypeScript 판과 Python 판이 함께 쓰는 요청 픽스처(`ts/src/test/static/request/`)를 더했습니다.
- 한국투자증권과 토스증권에 `watchTicker`, `watchTrades`, `watchOrderBook`, `watchOrders`, `close`를 넣었습니다.
- 고유 결과 행에 `timestamp`와 `datetime`을 넣었습니다(국내 행만. 해외 행은 날짜의 시간대를 확인하지 못해 비워 둡니다).

### 바뀜

- 토스증권이 확장세션 국내 주문을 막을 때 내는 오류 문구가 옵션 이름 `nxtRouting`을 가리킵니다. 예전 문구는 `nxt-routing`이었습니다.
- `build`가 `tsc` 뒤에 `tsc-alias -f`를 돌려 `dist/`의 상대 경로에 확장자를 채웁니다. GitHub 주소로 설치하면 `prepare`가 같은 빌드를 돌립니다.
- 저장소 배치를 ccxt와 같게 바꿨습니다. TypeScript 소스는 `ts/src/`, Python 패키지는 `python/kr_broker/`, 두 판이 함께 쓰는 테스트 자료는 `ts/src/test/static/`, 예제는 `examples/ts/`와 `examples/py/`에 있습니다. 패키지 이름과 하위 경로(`kr-broker/…`)로 가져오는 코드는 바꿀 필요가 없습니다.

### 고침

- 빌드한 `dist/`를 Node.js ESM에서 불러오지 못하던 것을 고쳤습니다(확장자 없는 상대 경로 `./base` 때문에 `ERR_UNSUPPORTED_DIR_IMPORT`). CI가 `exports`의 모든 경로를 Node.js로 불러와 확인합니다(`scripts/check-dist-imports.mjs`).
- KB증권의 `fetchTicker`, `fetchOrderBook`, `fetchBalance`, `cancelOrder`, `fetchOpenOrders` 등이 `params`를 요청에 싣지 않던 것을 고쳤습니다.
- 한국투자증권 해외 실시간 체결과 호가(`HDFSCNT0`, `HDFSASP0`, `HDFSASP1`)의 필드 이름이 한 칸씩 밀려 있던 것을 고쳤습니다.

## [0.1.0] - 2026-09-21

첫 공개 버전입니다.

### 추가

- 한국 증권사 API를 ccxt처럼 쓰는 클래스 `kis`(한국투자증권), `toss`(토스증권), `kbsec`(KB증권)을 냈습니다.
- ccxt식 통합 자료 구조(`Market`, `Ticker`, `Order`, `Trade`, `Balances`)와 오류 계층(`ExchangeError` 계열)을 따랐고, 주문 접수 여부를 모를 때 던지는 `OrderOutcomeUnknown`을 추가했습니다.
- 증권사 캘린더 API로 받는 휴장일, 토큰 발급 잠금, 증권사별 호출 한도를 넣었습니다.

[Unreleased]: https://github.com/jewon-oh/kr-broker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jewon-oh/kr-broker/releases/tag/v0.1.0
