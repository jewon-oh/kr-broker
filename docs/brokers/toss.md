<!-- 이 문서는 생성물입니다. 손으로 고치지 않습니다. `docs/coverage/`의 자료를 고친 뒤 `pnpm docs:gen`을 실행합니다. -->

# 토스증권(`toss`) 지원 현황

> 이 문서는 생성물입니다. 손으로 고치지 않습니다. `docs/coverage/`의 자료를 고친 뒤 `pnpm docs:gen`을 실행합니다.

조사일은 2026-09-21입니다. 증권사 API를 호출하지 않고 공식 명세와 저장소의 소스를 대조했습니다.

전체 기능 표는 [기능별 지원](README.md#기능별-지원)에 있습니다.

## 목차

- [요약](#요약)
- [커버리지 요약](#커버리지-요약)
- [출처](#출처)
- [카테고리별 공식 API](#카테고리별-공식-api)
  - [Auth](#auth)
  - [Market Data](#market-data)
  - [Stock Info](#stock-info)
  - [Market Info](#market-info)
  - [Ranking](#ranking)
  - [Market Indicators](#market-indicators)
  - [Account](#account)
  - [Asset](#asset)
  - [Order](#order)
  - [Conditional Order](#conditional-order)
  - [Conditional Order History](#conditional-order-history)
  - [Order History](#order-history)
  - [Order Info](#order-info)
  - [Realtime](#realtime)
- [이 증권사에서만 쓰는 기능](#이-증권사에서만-쓰는-기능)
- [알려진 한계](#알려진-한계)
- [미구현 API](#미구현-api)

## 요약

| 항목 | 내용 |
|---|---|
| 클래스 | `toss` |
| 인증 필드 `apiKey` | 클라이언트 ID |
| 인증 필드 `secret` | 클라이언트 시크릿 |
| 인증 필드 `uid` | 계좌 순번(`accountSeq`), 선택. 비워 두면 처음 계좌 API를 호출할 때 첫 계좌를 찾아 채웁니다. |
| 모의투자 | 지원하지 않습니다. `setSandboxMode(true)`는 `NotSupported`를 던집니다. |
| 지원 시장 | 국내(KR), 미국(US) |
| 호출 한도 | 계정 전체 호출 간격이 100ms(초당 10건)입니다. 여기에 그룹별 한도(`rateLimitBuckets`)를 더합니다. 개장 직후 09:00부터 09:10까지는 일부 그룹의 한도가 절반입니다. |
| 공식 API | 39개 중 통합 18개, 확장 18개, 암묵과 내부 3개, 미구현 0개 |
| 커버리지 | 통합과 확장 기준 92.3%, 암묵과 내부 포함 기준 100.0% |

## 커버리지 요약

웹소켓 채널도 API 1개로 집계합니다. 값의 뜻은 [표기 규칙](README.md#표기-규칙)에 있습니다.

| 구분 | 공식 API 수 | 통합 | 확장 | 암묵과 내부 | 미구현 | 통합과 확장 기준 | 암묵과 내부 포함 기준 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Auth | 1 | 0 | 0 | 1 | 0 | 0.0% (0/1) | 100.0% (1/1) |
| Market Data | 5 | 4 | 1 | 0 | 0 | 100.0% (5/5) | 100.0% (5/5) |
| Stock Info | 8 | 1 | 7 | 0 | 0 | 100.0% (8/8) | 100.0% (8/8) |
| Market Info | 3 | 0 | 2 | 1 | 0 | 66.7% (2/3) | 100.0% (3/3) |
| Ranking | 1 | 0 | 1 | 0 | 0 | 100.0% (1/1) | 100.0% (1/1) |
| Market Indicators | 3 | 0 | 3 | 0 | 0 | 100.0% (3/3) | 100.0% (3/3) |
| Account | 1 | 0 | 0 | 1 | 0 | 0.0% (0/1) | 100.0% (1/1) |
| Asset | 1 | 1 | 0 | 0 | 0 | 100.0% (1/1) | 100.0% (1/1) |
| Order | 3 | 3 | 0 | 0 | 0 | 100.0% (3/3) | 100.0% (3/3) |
| Conditional Order | 3 | 3 | 0 | 0 | 0 | 100.0% (3/3) | 100.0% (3/3) |
| Conditional Order History | 2 | 2 | 0 | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) |
| Order History | 2 | 2 | 0 | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) |
| Order Info | 3 | 2 | 1 | 0 | 0 | 100.0% (3/3) | 100.0% (3/3) |
| Realtime | 3 | 0 | 3 | 0 | 0 | 100.0% (3/3) | 100.0% (3/3) |
| **합계** | 39 | 18 | 18 | 3 | 0 | 92.3% (36/39) | 100.0% (39/39) |

## 출처

| 출처 | 주소 |
|---|---|
| 토스증권 REST 명세(OpenAPI 3) v1.2.17 | https://openapi.tossinvest.com/openapi-docs/latest/openapi.json |
| 토스증권 웹소켓 명세(AsyncAPI 3) v1.2.2 | https://openapi.tossinvest.com/openapi-docs/latest/asyncapi.json |
| 토스증권 개요 문서(호출 한도, 오류 코드, 웹소켓 가이드) | https://openapi.tossinvest.com/openapi-docs/overview.md |

## 카테고리별 공식 API

### Auth

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| OAuth2 토큰 발급 | `POST /oauth2/token` | 국내, 미국 | 암묵 | `publicPostOauth2Token` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1oauth2~1token/post) | 공개 래퍼는 없고 `authenticate`가 내부에서 부릅니다. 클라이언트당 유효 토큰은 1개입니다. |

### Market Data

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 호가 조회 | `GET /api/v1/orderbook` | 국내, 미국 | 통합 | `fetchOrderBook` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1orderbook/get) | 무효 호가를 거르고 `limit`은 클라이언트에서 자릅니다. |
| 현재가 조회(200건까지) | `GET /api/v1/prices` | 국내, 미국 | 통합 | `fetchTicker` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1prices/get) | `fetchTickers`도 같은 API 이며 200건씩 나눠 부릅니다. `last`, `close`만 채웁니다. |
| 최근 체결 내역(당일, 최대 50건) | `GET /api/v1/trades` | 국내, 미국 | 통합 | `fetchTrades` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1trades/get) | 당일 최근 50건만 주므로 `since`는 클라이언트에서 거릅니다. 방향(매수·매도)과 체결ID는 응답에 없어 `undefined`입니다. |
| 상, 하한가 조회 | `GET /api/v1/price-limits` | 국내, 미국 | 확장 | `fetchPriceLimit` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1price-limits/get) | 미국은 상, 하한가가 null입니다. |
| 캔들 조회(1m, 1d) | `GET /api/v1/candles` | 국내, 미국 | 통합 | `fetchOHLCV` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1candles/get) | 1m, 1d만 되고 다른 주기는 NotSupported 다. 최대 200봉씩 10쪽. |

### Stock Info

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 종목 기본 정보(200건까지) | `GET /api/v1/stocks` | 국내, 미국 | 확장 | `fetchStocks` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1stocks/get) | 200종목을 초과해도 나누지 않습니다. 국내는 거래정지, NXT 지원 여부가 실립니다. |
| 마켓별 전체 종목 | `GET /api/v1/stocks/all` | 국내, 미국 | 통합 | `fetchMarkets` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1stocks~1all/get) | 마켓 7개를 1회씩 호출합니다. `status`, `securityType`는 `params`로 전달됩니다. `taker`와 `maker`는 시장별 기본 위탁수수료율(국내 0.00015, 미국 0.001)입니다. |
| 매수 유의사항 | `GET /api/v1/stocks/{symbol}/warnings` | 국내, 미국 | 확장 | `fetchStockWarnings` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1stocks~1{symbol}~1warnings/get) | 시장 범위는 스펙에 명시가 없습니다. 실계좌 호출(2026-09-24)은 오류 없이 끝났지만 자료가 없어 응답 필드는 확인하지 못했다. |
| 종목 투자자별 매매동향 | `GET /api/v1/stocks/{symbol}/investor-trading` | 국내 | 확장 | `fetchStockInvestorTrading` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1stocks~1{symbol}~1investor-trading/get) | 국내 전용이며 미국 종목은 400 unsupported-market입니다. 거래대금 없이 주식 수만 줘서 순매수 대금을 싣는 공통 `fetchInvestorTrading`으로 옮기지 않습니다. 시장 단위 대금은 `fetchMarketInvestorTrading`입니다. |
| 프로그램매매 동향 | `GET /api/v1/stocks/{symbol}/program-trades` | 국내 | 확장 | `fetchProgramTrades` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1stocks~1{symbol}~1program-trades/get) | 국내 전용이며 KRX 거래만 집계합니다. |
| 공매도 동향 | `GET /api/v1/stocks/{symbol}/short-selling` | 국내 | 확장 | `fetchShortSelling` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1stocks~1{symbol}~1short-selling/get) | 국내 전용입니다. 비중의 분모(정규장 외 세션 포함 누적 거래량·거래대금)가 없는 날짜는 비중이 null입니다. |
| 신용거래 동향 | `GET /api/v1/stocks/{symbol}/credit-trades` | 국내 | 확장 | `fetchCreditTrades` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1stocks~1{symbol}~1credit-trades/get) | 국내 전용입니다. 신용대주(개인)는 대차거래(기관)와 다른 데이터입니다. |
| 대차거래 동향 | `GET /api/v1/stocks/{symbol}/securities-lending` | 국내 | 확장 | `fetchSecuritiesLending` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1stocks~1{symbol}~1securities-lending/get) | 국내 전용입니다. |

### Market Info

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 환율 조회 | `GET /api/v1/exchange-rate` | 국내, 미국 | 암묵 | `privateMarketGetExchangeRate` | `spec-only` | `fetchExchangeRate` (확장) | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1exchange-rate/get) | 내부 `usdKrwRate`가 부르고 공개 래퍼는 없습니다. 참고용 표시 환율입니다. |
| 국내 장 운영 정보 | `GET /api/v1/market-calendar/KR` | 국내 | 확장 | `fetchMarketSessions` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1market-calendar~1KR/get) | `date`를 전달하지 못합니다. 세션 시각 원본을 돌려줍니다. 날짜별 개장 여부는 `fetchMarketCalendar`가 이 결과로 만들고, `currentKrSession`도 같은 API를 씁니다. |
| 해외 장 운영 정보 | `GET /api/v1/market-calendar/US` | 미국 | 확장 | `fetchMarketSessions` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1market-calendar~1US/get) | `date`를 전달하지 못합니다. 4세션(데이마켓 포함)의 시각 원본을 돌려줍니다. 날짜별 개장 여부는 `fetchMarketCalendar`가 이 결과로 만들고, `currentUsSession`도 같은 API를 씁니다. |

### Ranking

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 주식 랭킹(상위 100) | `GET /api/v1/rankings` | 국내, 미국 | 확장 | `fetchRankings` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1rankings/get) | `excludeInvestmentCaution`은 `params`로 전달됩니다. |

### Market Indicators

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 시장 지표 현재가(지수, 국채 8종) | `GET /api/v1/market-indicators/prices` | 국내 | 확장 | `fetchMarketIndicators` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1market-indicators~1prices/get) | 심볼은 KOSPI, KOSDAQ, KR_BOND_2Y, 3Y, 5Y, 10Y, 20Y, 30Y 8종입니다. |
| 시장 지표 캔들 | `GET /api/v1/market-indicators/{symbol}/candles` | 국내 | 확장 | `fetchMarketIndicatorOHLCV` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1market-indicators~1{symbol}~1candles/get) | 분봉은 지수만, 국채는 일봉만 됩니다. `fetchOHLCV('KOSPI')`는 심볼 판정이 미국이라 일반 `/candles`를 부릅니다. |
| 투자자별 매매대금(KOSPI, KOSDAQ) | `GET /api/v1/market-indicators/{symbol}/investor-trading` | 국내 | 확장 | `fetchMarketInvestorTrading` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1market-indicators~1{symbol}~1investor-trading/get) | 시장 단위(KOSPI, KOSDAQ)이며 종목 단위가 아닙니다. |

### Account

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 계좌 목록 | `GET /api/v1/accounts` | 국내, 미국 | 암묵 | `privateMarketGetAccounts` | `real` | `fetchAccounts` (통합) | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1accounts/get) | 내부 `loadAccountSeq`가 `uid`를 채우려고 부르고 공개 래퍼는 없습니다. |

### Asset

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 보유 주식 | `GET /api/v1/holdings` | 국내, 미국 | 통합 | `fetchBalance` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1holdings/get) | 계좌 합산 손익(`profitLoss`)은 쓰지 않습니다. 종목 행 원본은 `balances[code].info`에 있습니다. 응답에 매도 가능 수량이 없어 전체 잔고의 보유 `free`는 비어 있습니다. |

### Order

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 주문 생성 | `POST /api/v1/orders` | 국내, 미국 | 통합 | `createOrder` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1orders/post) | 금액 주문(소수점 매수)은 미국 시장가 전용이며 `createMarketBuyOrderWithCost`가 부릅니다. 국내는 정수 주만 됩니다. `params`에서 읽지 않은 키는 본문 끝에 합칩니다. 라이브러리가 채우는 본문 필드를 `params`로 주면 요청 없이 `BadRequest`입니다. |
| 주문 정정 | `POST /api/v1/orders/{orderId}/modify` | 국내, 미국 | 통합 | `editOrder` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1orders~1{orderId}~1modify/post) | 잔량 전부를 새 가격으로 정정합니다. 정정 전에 주문 상세로 체결 수량과 잔량을 읽어, 국내는 잔량을 수량으로 싣고 미국은 가격만 보냅니다. `amount`는 정정 뒤 총수량이고 다르면 `NotSupported`입니다. 명세의 `quantity`가 총수량인지 옮길 수량인지 정해지지 않아 일부 체결된 국내 주문은 정정하지 않습니다. 정정하면 새 `orderId`가 발급됩니다. 조건주문 정정(`params.trigger`)은 아직 안 씁니다. |
| 주문 취소 | `POST /api/v1/orders/{orderId}/cancel` | 국내, 미국 | 통합 | `cancelOrder` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1orders~1{orderId}~1cancel/post) | `cancelAllOrders`는 미체결을 조회해 하나씩 취소하는 emulated 다. 토스는 취소마다 새 주문번호를 발급합니다. 취소를 접수한 뒤 원주문 상세를 조회해, 원주문이 `CANCELED`면 `canceled`, `FILLED`면 `closed`, `REJECTED`면 `rejected`를 돌려줍니다. 확정하지 못하면 `status`를 비웁니다. 취소가 거절되면 원주문이 이전 상태로 돌아가 아직 반영되지 않은 것과 구별할 수 없어서, 이때도 비웁니다. 새 주문번호는 `info.orderId`에, 조회한 원주문은 `info.order`에 있습니다. |

### Conditional Order

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 조건주문 생성(SINGLE, OCO, OTO) | `POST /api/v1/conditional-orders` | 국내, 미국 | 통합 | `createTriggerOrder` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1conditional-orders/post) | `createTriggerOrder`나 `createOrder`의 `triggerPrice`로 부릅니다. `triggerPrice`가 없으면 요청 전에 `ArgumentsRequired`를 던집니다. 국내는 KRX 정규장에서만, 해외는 모든 세션에서 발동합니다. 테스트는 국내 종목뿐입니다. |
| 조건주문 취소 | `DELETE /api/v1/conditional-orders/{conditionalOrderId}` | 국내, 미국 | 통합 | `cancelOrder` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1conditional-orders~1{conditionalOrderId}/delete) | `params.trigger:true`로 부릅니다. 명세상 취소 응답(204)이 곧 취소 완료라서, 조회하지 않고 `canceled`를 돌려줍니다. |
| 조건주문 수정 | `POST /api/v1/conditional-orders/{conditionalOrderId}/modify` | 국내, 미국 | 통합 | `editOrder` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1conditional-orders~1{conditionalOrderId}~1modify/post) | `editOrder(id, symbol, type, side, amount, price, { trigger: true, ... })`로 부른다. 등록(`createTriggerOrder`)과 같은 planConditionalOrder를 재사용해 조건 전체(타입·만료일·감시조건)를 다시 보낸다 — 부분 필드만 정정할 수 없다. 수정하면 새 conditionalOrderId가 발급되고 옛 ID는 무효화된다. |

### Conditional Order History

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 조건주문 목록 | `GET /api/v1/conditional-orders` | 국내, 미국 | 통합 | `fetchOpenOrders` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1conditional-orders/get) | OPEN만 받습니다. `limit` 100과 `cursor`로 최대 10쪽(1,000건)까지 이어 받고 옵션 `conditionalOrdersMaxPages`로 쪽 수를 바꿉니다. 상한을 넘으면 로그를 남기고 나머지를 자릅니다. CLOSED는 받지 못합니다. |
| 조건주문 상세 | `GET /api/v1/conditional-orders/{conditionalOrderId}` | 국내, 미국 | 통합 | `fetchOrder` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1conditional-orders~1{conditionalOrderId}/get) | `params.trigger:true`로 부릅니다. |

### Order History

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 주문 목록 | `GET /api/v1/orders` | 국내, 미국 | 통합 | `fetchOpenOrders` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1orders/get) | `fetchClosedOrders`(전량 체결만), `fetchCanceledOrders`, `fetchMyTrades`(일부 체결된 미체결 포함)도 같은 API 다. OPEN은 서버가 전량을 주고 CLOSED는 100건씩 최대 10쪽을 받습니다. |
| 주문 상세 | `GET /api/v1/orders/{orderId}` | 국내, 미국 | 통합 | `fetchOrder` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1orders~1{orderId}/get) | 주문 접수 뒤 체결 확인 폴링과 취소 접수 뒤 확정 조회도 이 API를 씁니다. `editOrder`도 정정 전에 이 API로 체결 수량과 잔량을 읽습니다. 상태 `CANCEL_REJECTED`와 `REPLACE_REJECTED`는 `rejected`로 옮깁니다. 명세는 두 상태를 거절된 취소나 정정 요청을 기록한 별도 레코드로 정의하고, 원주문은 이전 상태로 돌아간다고 적습니다. |

### Order Info

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 매수 가능 금액 | `GET /api/v1/buying-power` | 국내, 미국 | 통합 | `fetchBalance` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1buying-power/get) | KRW, USD 현금 항목의 `free`로 실립니다. 예수금을 주는 API가 없어 현금 `total`은 비어 있습니다. 개장 직후 09:00~09:10은 한도가 절반입니다. |
| 판매 가능 수량 | `GET /api/v1/sellable-quantity` | 국내, 미국 | 확장 | `fetchSellableQuantity` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1sellable-quantity/get) | 보유 수량에서 미체결 매도 주문에 잡힌 수량, 결제 전 미결제분 등을 뺀 값입니다. `fetchBalance({symbol})`가 이 값을 그 종목의 `free`로 씁니다. 응답에 값이 없으면 0이 아니라 `BadResponse`를 던집니다. |
| 매매 수수료율 | `GET /api/v1/commissions` | 국내, 미국 | 통합 | `fetchTradingFee` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json#/paths/~1api~1v1~1commissions/get) | `fetchCommissions`(확장)가 원본을 줍니다. 24시간 캐시합니다. |

### Realtime

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 실시간 체결 | `WS trade:kr, trade:us` | 국내, 미국 | 확장 | `createPriceStream` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/asyncapi.json#/channels/realtime-trade) | createPriceStream(onTrade)로 받는다. KIS(ts/src/kis/kis-price-ws.ts)와 별개 구현이다 — 토스는 인증이 handshake 헤더라 `ws` 패키지가 필수다(표준 WebSocket은 헤더를 못 싣는다). 선언형 full-replace 구독, 계정당 동시 연결 2개, 연결당 구독 100건, 선언 5회/초. 실계좌(2026-09-24)에서 미국은 45초 동안 체결 17건을 받았고 가격과 수량에 이상이 없었다. 국내는 추석 연휴 휴장일에 불러 구독만 받아들여졌고 프레임은 오지 않았다. 국내 채널은 거래일에 다시 확인해야 한다. |
| 실시간 호가 | `WS orderbook:kr, orderbook:us` | 국내, 미국 | 확장 | `createPriceStream` | `real` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/asyncapi.json#/channels/realtime-orderbook) | createPriceStream(onOrderbook)로 받는다. 구독 초기 스냅샷이 없어 REST 호가로 먼저 조회해야 한다(호출부 책임, 클라이언트가 자동으로 채우지 않는다). 실계좌(2026-09-24)에서 미국은 45초 동안 호가 12건(매도, 매수 각 10단계)을 받았고 가격 정렬에 이상이 없었다. 국내는 추석 연휴 휴장일에 불러 구독만 받아들여졌고 프레임은 오지 않았다. 국내 채널은 거래일에 다시 확인해야 한다. |
| 본인 주문 이벤트 | `WS personal:order:{accountSeq}` | 국내, 미국 | 확장 | `createPriceStream` | `spec-only` | - | [명세](https://openapi.tossinvest.com/openapi-docs/latest/asyncapi.json#/channels/realtime-order) | `watchOrders` 대신 시세와 같은 `createPriceStream(onOrder)`로 받는다(trade·orderbook과 한 WS 연결을 공유). `order`는 REST 주문 조회와 같은 원본이라 ccxt Order가 필요하면 `parseOrder`를 호출부가 부른다. 끊긴 구간의 이벤트는 다시 전달되지 않는다(재연결 후 REST로 재동기화 필요). 실계좌(2026-09-24)에서 구독은 받아들여졌고, 주문이 없어 수신은 없었다. |

## 이 증권사에서만 쓰는 기능

ccxt의 통합 메서드로 표현하기 어려운 증권사 고유 기능입니다.

| 기능 | 지원 | 관련 API | 지원 범위 |
|---|---|---:|---|
| 서버 감시 조건 주문(SINGLE, OCO, OTO) | 지원 | 5개 | 등록·수정(`editOrder`, `{trigger:true}`), 취소, 상세 조회, 미체결 목록을 지원합니다. 수정은 조건 전체를 다시 보내는 재설정이라 새 conditionalOrderId가 발급됩니다. 미체결 목록은 100건씩 최대 10쪽까지 받습니다. 종료된 조건 주문은 조회하지 못합니다. OCO는 양쪽 매도 지정가만, 시장가는 SINGLE만 받도록 사전 검사합니다. 국내 조건 주문은 KRX 정규장에서만 발동하고 해외는 모든 세션에서 발동합니다. 발동 세션 차이는 응답에 표시하지 않습니다. |
| 소수점 매수(금액 주문) | 부분 | 1개 | 미국 시장가 매수만 지원합니다. `createMarketBuyOrderWithCost`와 `params.cost`로 금액을 지정합니다. 정규장 종료 1시간 전까지의 접수 창을 사전 검사합니다. `supportsFractionalBuy`로 가능 여부를 확인합니다. 국내 종목에는 금액 주문이 없습니다. |
| 소수점 매도(미국 시장가 매도, 소수 6자리) | 지원 | 1개 | 미국 시장가 매도를 소수 6자리까지 지원합니다. |
| 시가단일가(OPG)와 장마감 지정가(CLS) | 지원 | 1개 | `timeInForce` 값을 서버에 전달합니다. 시장과 주문 유형 조합 검사는 서버에 맡깁니다. 조회 응답의 `timeInForce`를 반환합니다. |
| 착오 주문 방지 플래그(1억원 이상) | 지원 | 3개 | 주문 생성, 조건 주문 등록, 주문 정정에서 `confirmHighValueOrder`를 자동으로 켭니다. 끄는 옵션은 없습니다. |
| 멱등키 `clientOrderId` | 지원 | 2개 | 36자 이하, 10분 유효한 멱등키를 지원합니다. 충돌은 `DuplicateOrderId`로 옮깁니다. 처리 중인 요청은 `OrderOutcomeUnknown`으로 옮깁니다. |
| 국내 확장 세션과 미국 4세션 캘린더 | 부분 | 2개 | 캘린더 조회, 세션 판정, 세션별 주문 형태 사전 검사를 지원합니다. 시장가를 지정가로 바꾸는 옵션도 있습니다. `date`를 지정한 조회는 지원하지 않습니다. |
| 종목 유의사항(정리매매, 투자경고, 단기과열, VI) | 지원 | 1개 | `fetchStockWarnings`로 조회합니다. 주문 경로는 조회 결과를 미리 확인하지 않습니다. |
| 거래정지, NXT 지원, 정리매매 여부 | 부분 | 1개 | `fetchStocks`가 원본을 반환합니다. 200종목을 초과해도 나누어 호출하지 않습니다. |
| 투자자별 매매대금(시장 단위) | 지원 | 1개 | `fetchMarketInvestorTrading`으로 코스피와 코스닥 단위를 조회합니다. |
| 종목 단위 수급 5종(국내 전용) | 지원 | 5개 | 투자자별 매매동향(`fetchStockInvestorTrading`), 프로그램매매 동향(`fetchProgramTrades`), 공매도 동향(`fetchShortSelling`), 신용거래 동향(`fetchCreditTrades`), 대차거래 동향(`fetchSecuritiesLending`)을 모두 지원합니다. |
| 랭킹 | 지원 | 1개 | `fetchRankings`로 시장 전체 랭킹을 조회합니다. 토스증권 체결 기준이며 기간은 실시간부터 1년까지입니다. |
| 시장 지표(코스피, 코스닥, 국채 시세와 캔들) | 지원 | 2개 | 현재가(`fetchMarketIndicators`)와 캔들(`fetchMarketIndicatorOHLCV`)을 모두 지원합니다. |
| 상한가와 하한가 | 지원 | 1개 | `fetchPriceLimit`로 조회합니다. 서버는 가격 범위를 벗어난 주문을 별도로 `price-out-of-range`로 거절합니다. |
| 매도 가능 수량 | 지원 | 1개 | `fetchSellableQuantity`로 조회합니다. 오류 `insufficient-sellable-quantity`는 별도로 `InsufficientFunds`로 옮깁니다. |
| 참고 환율 | 부분 | 1개 | 통합증거금 환산과 고액 주문 판정에 내부에서만 씁니다. 공개 메서드는 없습니다. |
| 통합증거금 | 부분 | 2개 | `krwIntegratedMargin` 옵션이 원화 예수금의 달러 환산분을 합산합니다. 토스증권이 USD 매수 가능 금액에 원화 환산분을 넣는지는 문서에 없어 확인 불가입니다. |
| 클라이언트당 토큰 1개 | 지원 | 1개 | 재발급하면 이전 토큰이 무효가 됩니다. 저장소 잠금(`tokenStore`)과 401 응답 뒤 1회 재시도로 대응합니다. |
| 실시간 체결, 호가, 본인 주문 웹소켓 | 부분 | 3개 | 체결, 호가, 본인 주문 이벤트를 모두 createPriceStream으로 지원합니다. 호가 구독 초기 스냅샷은 없어 REST로 먼저 조회해야 합니다. |
| 주문 정정(국내 수량과 가격, 미국 가격만) | 지원 | 1개 | `editOrder`로 냅니다. 조건주문 정정(`params.trigger`)은 아직 안 씁니다. |

## 알려진 한계

- 캔들과 조건 주문은 국내 종목 테스트로만 확인했습니다. 미국 종목은 확인하지 못했습니다.
- 미체결 조건 주문은 100건씩 최대 10쪽(1,000건)까지 받습니다. 옵션 `conditionalOrdersMaxPages`로 쪽 수를 바꿉니다.
- 상한을 넘으면 로그를 남기고 나머지를 자릅니다. `fetchOpenOrders`와 `includeTrigger`를 켠 `cancelAllOrders`가 같은 범위를 대상으로 합니다.
- 종료된 조건 주문(CLOSED)은 조회하지 못합니다.
- 휴장일 조회에 기준일 `date`를 전달하지 못합니다.
- `fetchStocks`는 200종목을 초과해도 나누어 호출하지 않습니다.
- `fetchBalance`는 계좌 합산 손익과 종목별 손익을 반환하지 않습니다. 종목 행 원본은 `info`에 있습니다.
- 웹소켓이 없어서 체결 확인은 주문 조회를 6회, 350ms 간격으로 반복합니다.
- 통합증거금 환산에서 토스증권이 USD 매수 가능 금액에 원화 환산분을 넣는지는 문서에 없어 확인 불가입니다.
- 국내 호가단위는 가격대별이라 ccxt의 단일 `precision.price`로 표현하지 못합니다.

## 미구현 API

미구현 API는 0개입니다. 우선순위는 작은 수가 먼저입니다. 우선순위가 없는 API는 제안 유형(통합, params 확대, 확장, watch*) 순으로 정렬합니다. 제안 메서드 이름은 설계 후보이고 확정한 이름이 아닙니다.
