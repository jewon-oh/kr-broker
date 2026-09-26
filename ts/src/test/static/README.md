# test/static/ — 두 판이 함께 쓰는 테스트 자료

`request/<증권사>.json`(요청 픽스처)을 TypeScript 판(`ts/src/__tests__/request-fixtures.test.ts`)과 Python 판(`python/<패키지>/test/test_request_fixtures.py`)이
똑같이 돌린다. 둘 다 통과하면 두 판이 같은 요청(URL, 헤더, 본문)을 만들고, 같은 응답을 같은 결과나 같은 오류로 바꾼다는 뜻이다.
TypeScript 판이 실계좌로 확인한 기준 구현이므로, 새 케이스는 TypeScript 판에서 먼저 통과시킨다.

## 형식

```jsonc
{
    "schema_version": 1,
    "broker": "toss",                       // 증권사 클래스 이름
    "config": { "apiKey": "...", "enableRateLimit": false },   // 모든 케이스의 생성자 설정
    "tokenStore": { "<키>": { "accessToken": "...", "expiresAt": 4102444800000 } },  // 토큰 저장소에 미리 넣을 값
    "cases": [
        {
            "description": "무엇을 확인하는가",
            "config": { },                  // (선택) 이 케이스에만 덧씌울 설정. null 은 "설정하지 않음"이다
            "tokenStore": { },              // (선택) 이 케이스의 토큰 저장소
            "now": 1774400400000,           // (선택) 현재 시각(UTC epoch ms). 장 시간 판정과 주문 시각이 이 시각을 쓴다
            "method": "privateMarketGetExchangeRate",   // 부를 메서드(camelCase 이름)
            "args": [{ "baseCurrency": "USD" }],   // null 은 "주지 않음"이다
            "http": [                       // 오가는 HTTP 교환. 순서대로 응답한다
                {
                    "request": { "method": "GET", "url": "...", "headers": { }, "body": null },   // 기대하는 요청(헤더는 전부 같아야 한다)
                    "response": { "status": 200, "headers": { }, "body": { } }                // 가짜 응답. body 가 문자열이면 그대로 보낸다
                },
                { "request": { }, "network": "timeout" }                                         // 응답 대신 시간 초과("timeout")나 연결 끊김("reset")
            ],
            "output": { },                  // 돌려받을 값. error 와 함께 쓰지 않는다
            "error": { "class": "InsufficientFunds", "detail": "insufficient-buying-power", "brokerCode": "insufficient-buying-power" },   // 던질 오류(클래스 이름은 정확히 같아야 한다)
            "tokenStoreAfter": { "<키>": "present" }   // (선택) 끝난 뒤 저장소에 키가 있는지("present")·없는지("absent")
        }
    ]
}
```

- 케이스마다 새 인스턴스를 만든다. 호출 간격 조절은 꺼 두어 테스트가 기다리지 않는다.
- 휴장일 캘린더(`market-calendar`)와 KB증권 토큰 차단기는 모듈 전역 상태라서 케이스가 끝날 때마다 비운다.
- `now`가 있으면 현재 시각을 그 값으로 고정한다. TypeScript 판은 `Date`만 바꾼다(`vi.useFakeTimers({ toFake: ['Date'] })`).
  Python 판은 패키지의 시계 `kr_broker.base.functions.milliseconds`를 바꿔 끼운다. 호출 간격 조절기의 단조 시계와 타이머는 그대로 둔다.
  주문 접수처럼 결과에 현재 시각이 실리는 케이스는 `now`를 적는다.
- 결과(`output`)는 객체에서 값이 `null`인 키를 없는 키와 같게 보고 비교한다. JSON에는 `undefined`가 없고 Python 판에는 `null`과
  `undefined`의 구분이 없기 때문이다. 그래서 `output`에는 값이 있는 키만 적는다.
- 오류(`error`)는 클래스 이름을 비교하고, `detail`과 `brokerCode`는 적은 것만 비교한다. Python 판은 `brokerCode`를 `broker_code`로 읽는다.
  `brokerCode`의 `null`은 그 필드가 없어야 한다는 뜻이다(증권사 응답 없이 막은 오류).
- `args`의 `null`은 TypeScript 판에서 `undefined`로 넘긴다. Python 판에서 인자의 기본값이 `None`인 것과 맞춘다.
- 요청 본문은 문자열 그대로 비교한다. 두 판 모두 JavaScript의 `JSON.stringify`와 같은 모양(공백 없음, 한글 그대로, 정수 값의 실수는 소수점 없이)으로 보낸다.
- `http` 목록보다 요청이 많거나 적으면 실패한다.
- 증권사 API 가 아닌 요청도 같은 `http` 목록이 응답한다. 한국투자증권 `fetchOHLCV` 의 야후 파이낸스 캔들 요청이 그렇다. 이 요청은 서명과 공통 헤더 없이
  `User-Agent` 만 싣는다.
