# test/static/ — 두 판이 함께 쓰는 테스트 자료

`request/<증권사>.json`(요청 픽스처)을 TypeScript 판(`ts/src/__tests__/request-fixtures.test.ts`)과 Python 판(`python/<패키지>/test/test_request_fixtures.py`)이
똑같이 돌린다. 둘 다 통과하면 두 판이 같은 요청(URL·헤더·본문)을 만들고, 같은 응답을 같은 결과나 같은 오류로 바꾼다는 뜻이다.
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
            "method": "privateMarketGetExchangeRate",   // 부를 메서드(camelCase 이름)
            "args": [{ "baseCurrency": "USD" }],
            "http": [                       // 오가는 HTTP 교환. 순서대로 응답한다
                {
                    "request": { "method": "GET", "url": "...", "headers": { }, "body": null },   // 기대하는 요청(헤더는 전부 같아야 한다)
                    "response": { "status": 200, "headers": { }, "body": { } }                // 가짜 응답. body 가 문자열이면 그대로 보낸다
                },
                { "request": { }, "network": "timeout" }                                         // 응답 대신 시간 초과("timeout")나 연결 끊김("reset")
            ],
            "output": { },                  // 돌려받을 값. error 와 함께 쓰지 않는다
            "error": { "class": "InsufficientFunds", "detail": "insufficient-buying-power" },   // 던질 오류(클래스 이름은 정확히 같아야 한다)
            "tokenStoreAfter": { "<키>": "present" }   // (선택) 끝난 뒤 저장소에 키가 있는지("present")·없는지("absent")
        }
    ]
}
```

- 케이스마다 새 인스턴스를 만든다. 호출 간격 조절은 꺼 두어 테스트가 기다리지 않는다.
- 요청 본문은 문자열 그대로 비교한다. 두 판 모두 JavaScript 의 `JSON.stringify` 와 같은 모양(공백 없음, 한글 그대로, 정수 값의 실수는 소수점 없이)으로 보낸다.
- `http` 목록보다 요청이 많거나 적으면 실패한다.
