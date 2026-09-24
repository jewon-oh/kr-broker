# spec/ — 증권사 엔드포인트 표

## 왜 있는가

증권사 API 를 TypeScript 판과 Python 판이 함께 부른다. 두 판이 경로·HTTP 메서드·비용·버킷·주문 여부를 각자 적으면 조용히 어긋난다.
`spec/*.json` 은 이 값들을 한 곳에 모은 표다.

- TypeScript 판: 표가 `describe().api` 와 같은지 `__tests__/spec-parity.test.ts` 가 양쪽으로 대조한다. `describe().api` 에 엔드포인트를 더하면
  이 테스트가 실패하며 표에 넣을 줄을 알려 준다.
- Python 판: `node scripts/gen-python-abstract.mjs` 가 이 표로 `python/<패키지>/abstract/<증권사>.py` 를 만든다(ccxt 의 `abstract/` 와 같은 모양).
  CI 가 `--check` 로 생성물이 표와 같은지 본다.

## 범위

세 증권사의 모든 엔드포인트가 들어 있다. 한국투자증권 272개, 토스증권 36개, KB증권 83개다.
경로·HTTP 메서드·비용·버킷·주문 여부는 모든 항목에 있다. 파라미터(`params`)·응답 필드(`response`)·TR 코드(`tr_id`)는 공식 명세와 대조한
항목에만 적었다(지금은 증권사당 1개).

## 스키마 (`spec-types.ts`)

```
BrokerSpec { schema_version: 1, broker, endpoints: Record<암묵 메서드 이름, EndpointSpec> }
EndpointSpec {
  api: string[]        // describe().api 트리 경로, 예: ['private','market']
  method: 'GET'|'POST'|'PUT'|'DELETE'
  path: string          // KB 는 TR 코드 소문자(ivu10020)
  cost: number
  bucket?: string       // 호출 한도 그룹(있으면)
  order?: boolean       // 주문류(재시도 금지)면 true
  peak?: boolean        // 개장 직후 한도가 줄면 true
  tr_id?: string | { real, demo }   // KIS·KB 처럼 TR 코드가 있는 증권사만
  params?: SpecParam[]              // 공식 명세와 대조한 항목만
  response?: SpecResponseField[]    // 공식 명세와 대조한 항목만
  evidence?: string                 // params·response 의 근거(소스 위치 또는 공식 문서 링크)
}
```

- 키는 ccxt 식 암묵 메서드 이름(`privateGetUapiDomesticStockV1QuotationsInquirePrice`)이다. `implicitMethodNames()` 가 `api`·`method`·`path` 로 만들고,
  검증기가 키와 같은지 본다. Python 판은 같은 규칙의 snake_case 이름(`private_get_uapi_domestic_stock_v1_quotations_inquire_price`)도 쓴다.
- 필드 이름은 snake_case 다. 두 언어가 함께 읽는 자료라 어느 한쪽 관례를 따르지 않았다.
- 검증은 외부 라이브러리 없이 `spec-validate.ts` 의 `validateBrokerSpec()` 이 한다.

## 알려진 한계

- `tr_id` 는 문자열 하나(조회)와 `{ real, demo }`(주문) 두 모양이다. 주문류 TR 을 표에 넣을 때 한 모양으로 맞출지 정한다.
- `docs/coverage/*.json`(지원 현황)과 이 표는 따로 관리한다. 지원 현황은 엔드포인트가 아니라 증권사 API 문서 단위라 항목이 1:1 로 맞지 않는다.
- `describe().api` 는 아직 이 표에서 파생하지 않고 각 증권사 클래스에 그대로 있다. 대조 테스트가 둘이 같음을 보장한다.
