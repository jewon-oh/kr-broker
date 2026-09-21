<!-- 이 문서는 생성물입니다. 손으로 고치지 않습니다. `docs/coverage/`의 자료를 고친 뒤 `pnpm docs:gen`을 실행합니다. -->

# 증권사별 지원 현황

> 이 문서는 생성물입니다. 손으로 고치지 않습니다. `docs/coverage/`의 자료를 고친 뒤 `pnpm docs:gen`을 실행합니다.

세 증권사의 공식 API를 라이브러리가 얼마나 지원하는지 정리한 문서입니다.

증권사별 상세 표는 다음 문서에 있습니다.

- [한국투자증권(`kis`)](kis.md)
- [토스증권(`toss`)](toss.md)
- [KB증권(`kbsec`)](kbsec.md)

## 표기 규칙

### 기능 표의 값

| 값 | 뜻 |
|---|---|
| 지원 | 증권사가 지원하는 시장에서 모두 구현했습니다. |
| 부분 | 시장이나 조건에 제한이 있습니다. 제한 내용은 제약 열에 적었습니다. |
| 대체 | 증권사 API에 같은 조회가 없어서 다른 조회 결과로 만든 값입니다. ccxt의 `emulated`입니다. |
| 증권사 없음 | 증권사의 공식 API 목록에 같은 기능이 없습니다. |
| 미구현 | 증권사에는 API가 있지만 라이브러리가 아직 구현하지 않았습니다. |
| 미검증 | 구현했지만 실호출로 확인하지 못한 시장이나 조건이 있습니다. |

`부분`과 `미검증` 조건이 함께 있으면 `부분`으로 적습니다. 제약 열은 증권사별로 나누어 적습니다.

### 공식 API 항목의 상태

| 값 | 뜻 |
|---|---|
| 통합(`integrated`) | ccxt 통합 메서드가 응답의 주된 출처입니다. |
| 확장(`extended`) | 전용 공개 메서드가 응답을 반환합니다. |
| 암묵(`implicit`) | `api` 트리에만 있고 `privateGet...` 같은 암묵 메서드로 직접 호출합니다. 공개 메서드는 없습니다. |
| 내부(`internal`) | 다른 메서드가 내부에서만 호출합니다. |
| 미구현(`missing`) | 연결하지 않았습니다. |

### 검증 수준

| 값 | 뜻 |
|---|---|
| `real` | 실계좌 응답으로 확인했습니다. |
| `sandbox` | 모의투자 서버 응답으로 확인했습니다. |
| `spec-only` | 공식 명세나 예제만 보고 구현했고 호출 기록을 확인하지 못했습니다. 미구현 API에도 `spec-only`를 적습니다. |
| `unverified` | 구현했지만 명세나 예제와 어긋나 동작을 의심합니다. |

### 그 밖의 표기

- 시장은 국내(KR)와 미국(US)으로 적습니다.
- 메서드 이름은 ccxt 표준 camelCase 이름을 정본으로 씁니다.
- 제안 유형 `통합`은 ccxt 통합 메서드에 넣을 수 있다는 뜻입니다.
- 제안 유형 `확장`은 전용 메서드가 필요하다는 뜻입니다.
- 제안 유형 `params 확대`는 기존 메서드의 `params`를 늘린다는 뜻입니다.
- 제안 유형 `watch*`는 ccxt pro 방식의 구독 메서드를 뜻합니다.
- 실계좌 검증은 만든 사람이 가진 계좌로 확인한 범위까지만 했습니다.

## 기능별 지원

같은 기능을 세 증권사가 어떻게 지원하는지 비교한 표입니다. 각 값의 뜻은 [표기 규칙](#표기-규칙)에 있습니다.

### 시세

| 기능 | `kis` | `toss` | `kbsec` | 제약 |
|---|---|---|---|---|
| 현재가 `fetchTicker` | 지원 | 지원 | 지원 | `kis` 미국은 `masterData`가 필요합니다.<br>`toss` `last`와 `close`만 채웁니다. |
| 여러 종목 현재가 `fetchTickers` | 미구현 | 지원 | 증권사 없음 | `kis` 관심종목 멀티종목 시세 API가 있습니다.<br>`toss` 종목 지정이 필요합니다. 200건씩 나누어 호출합니다.<br>`kbsec` 여러 종목을 한 번에 조회하는 API가 없습니다. |
| 호가 `fetchOrderBook` | 부분 | 지원 | 지원 | `kis` 국내만 지원합니다. 미국 호가 API는 미구현입니다.<br>`toss` 무효 호가를 거르고 `limit`은 클라이언트에서 자릅니다. |
| 캔들 `fetchOHLCV` | 지원 | 부분 | 부분 | `kis` 야후 파이낸스에서 받습니다. 미국 일봉이 비면 한국투자증권 API로 받습니다.<br>`toss` 1분봉과 일봉만 받습니다. 미국은 확인하지 못했습니다.<br>`kbsec` 국내만 지원합니다. 코스닥은 `params.mkt_clsf`를 지정합니다. |
| 종목 목록 `fetchMarkets` | 지원 | 지원 | 미구현 | `kis` `masterData`가 필요합니다.<br>`toss` `taker`와 `maker`는 시장별 기본 위탁수수료율입니다.<br>`kbsec` 해외 종목 목록 API(`SIAM4983`)가 있습니다. 국내 종목 목록 API는 확인 불가입니다. |
| 실시간 시세 `createPriceStream` | 부분 | 미구현 | 증권사 없음 | `kis` 미국은 지연 체결만 받습니다.<br>`toss` 웹소켓 채널 3개가 있습니다.<br>`kbsec` 웹소켓 API가 없습니다. |

### 계좌

| 기능 | `kis` | `toss` | `kbsec` | 제약 |
|---|---|---|---|---|
| 잔고 `fetchBalance` | 지원 | 지원 | 지원 |  |
| 수수료율 `fetchTradingFee` | 지원 | 지원 | 대체 | `kis` 고정 요율표를 사용합니다.<br>`toss` 조회한 뒤 24시간 캐시합니다.<br>`kbsec` 공시 요율로 추정합니다. |
| 매수 가능 금액 | 부분 | 지원 | 지원 | `kis` 국내 주문 가능 현금만 `fetchBalance`에 담습니다.<br>`toss` `fetchBalance`에 담습니다.<br>`kbsec` `fetchBuyableAmount`와 `fetchOverseasBuyableAmount`로 조회합니다. |
| 청구된 수수료와 거래세 | 미구현 | 증권사 없음 | 지원 | `kis` 기간 손익과 수수료 API가 있습니다.<br>`toss` 정산 조회 API가 없습니다. 주문 상세에 수수료와 세금이 있습니다.<br>`kbsec` `fetchDomesticSettlements`와 `fetchOverseasSettlements`로 조회합니다. |

### 주문

| 기능 | `kis` | `toss` | `kbsec` | 제약 |
|---|---|---|---|---|
| 지정가와 시장가 `createOrder` | 부분 | 지원 | 지원 | `kis` 미국은 지정가만 받습니다. 실전 시장가는 장마감지정가로 나갑니다. |
| 소수점 주문 | 증권사 없음 | 부분 | 부분 | `kis` 공식 API 목록에 소수점 주문이 없습니다.<br>`toss` 미국만 지원합니다.<br>`kbsec` 국내만 지원합니다. 취소와 조회는 없습니다. |
| 금액 기준 매수 `createMarketBuyOrderWithCost` | 증권사 없음 | 부분 | 미구현 | `kis` 공식 API 목록에 금액 주문이 없습니다.<br>`toss` 미국 시장가 매수만 지원합니다.<br>`kbsec` 미국 소수점 주문 API가 있습니다. 금액 지정 여부는 확인 불가입니다. |
| 조건과 트리거 주문 `createTriggerOrder` | 미구현 | 미검증 | 미구현 | `kis` 스탑지정가 인자 `CNDT_PRIC`을 보내지 않습니다. `createTriggerOrder`는 `NotSupported`를 던집니다.<br>`toss` `createTriggerOrder`나 `createOrder`의 `triggerPrice`로 냅니다. 국내 종목은 테스트로 확인했고 미국은 확인하지 못했습니다.<br>`kbsec` 주문 TR은 스톱지정가를 받습니다. 조건 주문 인자(`triggerPrice`, `stopPrice` 등)는 요청 전에 `NotSupported`로 거절합니다. |
| 정정 `editOrder` | 미구현 | 미구현 | 부분 | `kis` 정정 구분 `RVSE_CNCL_DVSN_CD=01`을 보내지 않습니다. `editOrder`는 `NotSupported`를 던집니다.<br>`toss` 국내는 수량과 가격, 미국은 가격만 정정하는 API가 있습니다. `editOrder`는 `NotSupported`를 던집니다.<br>`kbsec` 미국은 가격만 정정합니다. `price`가 없으면 요청 전에 `ArgumentsRequired`를 던집니다. |
| 취소 `cancelOrder` | 지원 | 지원 | 지원 | `toss` 조건 주문은 `params.trigger`로 취소합니다.<br>`kbsec` 전량 취소만 씁니다. |
| 전체 취소 `cancelAllOrders` | 대체 | 대체 | 대체 | `kis` 미국은 실전만 지원합니다.<br>`kbsec` 국내만 지원합니다. |
| 정규장 밖 주문 | 부분 | 지원 | 미구현 | `kis` 국내만 지원합니다. `options.nxtRouting`이 필요합니다.<br>`toss` 정수 지정가만 받습니다. 국내는 `options.nxtRouting`이 필요합니다.<br>`kbsec` 주문 TR이 시간외 시장을 받지만 세션 검사가 정규장 밖 주문을 막습니다. |

### 주문 조회

| 기능 | `kis` | `toss` | `kbsec` | 제약 |
|---|---|---|---|---|
| 주문 조회 `fetchOrder` | 지원 | 지원 | 부분 | `kbsec` 미국은 체결 내역만 조회합니다. |
| 주문 목록 `fetchOrders` | 지원 | 증권사 없음 | 미구현 | `toss` 주문 목록 API는 상태(OPEN, CLOSED)를 지정해야 합니다.<br>`kbsec` `SSQM2341`의 체결구분 전체로 만들 수 있습니다. |
| 미체결 `fetchOpenOrders` | 부분 | 지원 | 부분 | `kis` 미국은 실전만 지원합니다.<br>`toss` 미체결 조건 주문은 100건씩 최대 10쪽(1,000건)까지 받습니다.<br>`kbsec` 국내만 지원합니다. `since`는 적용하지 않습니다. |
| 종료 주문 `fetchClosedOrders` | 대체 | 지원 | 미구현 | `kis` `fetchOrders` 결과에서 체결 완료만 고릅니다.<br>`toss` 100건씩 최대 10쪽을 받습니다.<br>`kbsec` `SSQM2341`로 만들 수 있습니다. 체결은 `fetchMyTrades`로 봅니다. |
| 체결 내역 `fetchMyTrades` | 지원 | 대체 | 지원 | `kis` `fee`가 비어 있습니다.<br>`toss` 주문 목록 API로 만듭니다. |

### 시장 정보

| 기능 | `kis` | `toss` | `kbsec` | 제약 |
|---|---|---|---|---|
| 휴장일 `fetchMarketCalendar` | 부분 | 지원 | 부분 | `kis` 국내만, 실전만 지원합니다.<br>`toss` 세션 시각 원본을 반환합니다.<br>`kbsec` 국내만 지원합니다. |
| 종목 정보 `fetchStocks` | 미구현 | 지원 | 미구현 | `kis` 종목 상세 API `search-stock-info`를 암묵 API로만 호출합니다.<br>`toss` 200종목을 초과해도 나누어 호출하지 않습니다.<br>`kbsec` 종목기본정보 API `SIQM4900`이 있습니다. |
| 거래정지와 경고 `fetchStockWarnings` | 미구현 | 지원 | 미구현 | `kis` VI 현황 API `inquire-vi-status`가 있습니다.<br>`kbsec` `SIQM4900`이 매매제한과 위험등급을 줍니다. |
| 투자자별 매매동향 `fetchInvestorTrading` | 미구현 | 부분 | 미구현 | `kis` `inquire-investor`를 암묵 API로만 호출합니다.<br>`toss` 국내 시장 단위만 지원합니다.<br>`kbsec` 종목별 투자자 API `IVU10430`이 있습니다. |
| 종목 랭킹 `fetchRankings` | 미구현 | 지원 | 미구현 | `kis` 순위 API가 있습니다.<br>`kbsec` 순위 API가 있습니다. |

### 판단 근거

값을 정하는 데 판단이 들어간 셀입니다.

| 기능 | 증권사 | 값 | 판단 근거 |
|---|---|---|---|
| 종목 목록 | `kbsec` | 미구현 | `loadMarkets()`가 요청 없이 끝나고 심볼 형식으로 종목을 판별합니다. 해외 종목 목록 API `SIAM4983`을 아직 쓰지 않아 미구현으로 적었습니다. |
| 지정가와 시장가 | `kis` | 부분 | 알려진 한계에 미국 시장가 주문이 장마감지정가(LOC) 주문으로 나간다고 적혀 있어 지원이 아니라 부분으로 적었습니다. |
| 소수점 주문 | `kis` | 증권사 없음 | 공식 예제 저장소의 examples_llm 334개에서 소수점 주문을 찾지 못했습니다. 포털 원문은 로그인 없이 읽지 못해 확인 불가입니다. |
| 금액 기준 매수 | `kis` | 증권사 없음 | 공식 예제 저장소의 examples_llm 334개에서 금액으로 주문하는 API를 찾지 못했습니다. 포털 원문은 로그인 없이 읽지 못해 확인 불가입니다. |
| 금액 기준 매수 | `kbsec` | 미구현 | 미국 소수점 주문 API `SKAM2201`의 명세에서 금액으로 주문하는 필드가 있는지 확인하지 못했습니다. API는 있으므로 증권사 없음이 아니라 미구현으로 적었습니다. |
| 주문 목록 | `toss` | 증권사 없음 | 주문 목록 API `GET /orders`는 `status`가 필수입니다. 상태를 나누지 않는 전체 목록 API가 없다고 판단해 증권사 없음으로 적었습니다. 라이브러리는 `fetchOpenOrders`와 `fetchClosedOrders`로 나눠 제공합니다. |

## 공식 API 커버리지

공식 API 대비 지원 비율은 `kis` 7.2%(24/334), `toss` 53.8%(21/39), `kbsec` 25.8%(24/93)입니다. 통합 메서드나 확장 메서드로 호출하는 API만 집계했습니다.

| 구분 | 공식 API 수 | 통합 | 확장 | 암묵과 내부 | 미구현 | 통합과 확장 기준 | 암묵과 내부 포함 기준 |
|---|---:|---:|---:|---:|---:|---:|---:|
| [`kis`](kis.md) | 334 | 17 | 7 | 2 | 308 | 7.2% (24/334) | 7.8% (26/334) |
| [`toss`](toss.md) | 39 | 15 | 6 | 3 | 15 | 53.8% (21/39) | 61.5% (24/39) |
| [`kbsec`](kbsec.md) | 93 | 18 | 6 | 1 | 68 | 25.8% (24/93) | 26.9% (25/93) |

웹소켓 채널도 API 1개로 집계합니다. 카테고리별 수치는 증권사별 문서에 있습니다.
