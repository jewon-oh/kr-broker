# 안전 가이드

실계좌에 연결하기 전에 읽는 안내입니다. 소스와 README에서 확인한 사실만 적었고, 확인하지 못한 것은 "확인 불가"로 표시했습니다.

## 실주문이 기본입니다

`createOrder()`는 호출하는 즉시 증권사에 주문을 냅니다. 확인 단계와 시험 모드는 기본으로 켜져 있지 않습니다.

모의 서버는 한국투자증권에만 있습니다. 서버를 바꾸려면 인스턴스를 만들 때 `sandbox: true`를 전달합니다.

```ts
const broker = new kis({ apiKey, secret, uid, sandbox: true });
```

## 증권사별 모의투자 지원

| 증권사 | 클래스 | 모의투자 | `has.sandbox` |
|---|---|---|---|
| 한국투자증권 | `kis` | 지원합니다 | `true` |
| 토스증권 | `toss` | 없습니다 | `false` |
| KB증권 | `kbsec` | 없습니다 | `false` |

토스증권과 KB증권 인스턴스에서는 `setSandboxMode(true)`가 `NotSupported`를 던집니다. 생성자에 `sandbox: true`를 전달해도 같습니다.

한국투자증권에서 `sandbox: true`를 켜면 다음이 바뀝니다.

- 접속 주소가 모의투자 도메인으로 바뀝니다.
- 요청 간격이 500ms로 늘어납니다. 소스 주석은 모의투자의 상한을 초당 2건으로 적었습니다.
- 캐시한 접근 토큰을 버립니다.
- 모의투자가 지원하지 않는 조회는 `NotSupported`를 던집니다. 예를 들어 휴장일 조회(`fetchMarketCalendar`)가 있습니다.
- 미국 주문 취소에는 `params.amount`(취소 수량)가 필요합니다.
- 미국 주식 시장가 주문은 장마감지정가(LOC)가 아니라 지정가로 나갑니다.

모의투자 앱키는 실전 앱키와 따로 발급받습니다. 발급 절차는 [앱키 발급 가이드](guides/credentials.md)에 있습니다.

모의투자와 실전의 체결 방식이 같은지는 확인 불가입니다. 모의투자에서 통과한 코드도 실전에서는 소액으로 다시 확인하십시오.

## 소액 시험 절차

모의 서버가 없는 증권사와 한국투자증권 실전 계좌에서 처음 주문을 낼 때 따르는 순서입니다.

1. 읽기 요청부터 확인합니다. `fetchBalance()`와 `fetchTicker()`가 성공하는지 봅니다. 인증 오류는 읽기 요청에서 나옵니다.
2. 체결되지 않을 가격으로 1주 지정가 주문을 냅니다. 예를 들어 현재가보다 충분히 낮은 매수가입니다.
3. `fetchOpenOrders()`로 주문이 미체결로 보이는지 확인합니다. 증권사 앱에서도 같은 주문이 보이는지 대조합니다.
4. `cancelOrder()`로 주문을 취소하고 `fetchOpenOrders()`에서 사라졌는지 확인합니다.
5. 체결 경로를 확인합니다. 체결될 가격으로 1주 지정가 주문을 내고 `fetchMyTrades()`와 `fetchBalance()`의 값을 증권사 앱과 대조합니다.
6. 매도도 같은 순서로 확인합니다.
7. 자동으로 주문하는 코드에는 한 번에 낼 주문 금액의 상한을 직접 둡니다. 라이브러리에는 금액 상한이 없습니다.

장 시간 밖에서 주문하면 라이브러리가 `MarketClosed`를 던지고 주문 요청을 보내지 않습니다. 시험은 장 시간 안에서 하십시오.

## OrderOutcomeUnknown이 나오면 재주문하지 않습니다

`OrderOutcomeUnknown`은 주문 요청이 시간 초과나 연결 끊김으로 끝났거나, 증권사 오류 코드 없는 5xx 나 해석할 수 없는 응답을 받았다는 뜻입니다. 증권사가 주문을 접수했는지 알 수 없습니다.

`OrderOutcomeUnknown`의 `retryable`은 `false`이고 라이브러리는 주문 요청을 다시 보내지 않습니다. 호출하는 코드도 같은 주문을 다시 내지 마십시오. 접수됐다면 같은 주문이 두 번 들어갑니다.

### 접수 여부 확인 방법

1. `fetchOpenOrders(symbol)`로 주문한 종목의 미체결 주문을 봅니다.
2. `fetchMyTrades(symbol)`로 주문한 종목의 체결 내역을 봅니다.
3. `fetchBalance()`로 보유 수량이 바뀌었는지 봅니다.
4. 증권사 앱이나 웹에서 주문 내역을 봅니다.

세 조회에 모두 없어도 접수되지 않았다고 단정하지 마십시오. 체결과 조회 반영 사이에 시차가 있을 수 있습니다. 반영 시차의 길이는 확인 불가입니다. 몇 분 뒤에 다시 조회하고 증권사 앱과 대조하십시오.

증권사별로 조회 범위가 다릅니다.

| 증권사 | 미체결 조회 | 체결 조회 |
|---|---|---|
| 한국투자증권 | 국내와 미국(미국은 실전만) | `fetchMyTrades` |
| 토스증권 | 국내와 미국 | `fetchMyTrades`(`emulated`) |
| KB증권 | 국내만 | `fetchMyTrades` |

KB증권의 미국 주문은 `fetchOpenOrders`가 조회하지 않으므로 `fetchMyTrades`와 증권사 앱으로 확인합니다.

### 토스증권의 clientOrderId

토스증권은 `createOrder`의 `params.clientOrderId`를 멱등키로 받습니다. 소스 주석은 `clientOrderId`를 36자 이하, 유효 10분으로 적었고, 같은 값으로 다시 보내면 이전 결과를 반환한다고 적었습니다. 재전송 동작을 실계좌로 확인했는지는 확인 불가입니다.

한국투자증권과 KB증권 클래스에는 멱등키를 보내는 기능이 없습니다. KB증권은 `clientOrderId`를 받아도 증권사로 보내지 않습니다.

### 자동 매매 코드에서

- `OrderOutcomeUnknown`을 잡으면 주문한 종목의 주문을 멈추고 접수 여부 확인을 마친 뒤에 다시 시작합니다.
- 오류를 잡지 않고 루프가 같은 주문을 다시 내는 구조를 피합니다.
- 조회는 `maxRetriesOnFailure` 횟수만큼 다시 보냅니다. 주문은 다시 보내지 않고, 접수 여부를 모르는 실패를 `OrderOutcomeUnknown`으로 바꿉니다.

## 앱키가 남을 수 있는 곳

라이브러리는 비밀을 자동으로 숨기지 않습니다. 소스에는 마스킹 코드가 없습니다. 아래 위치에 비밀이 그대로 남습니다.

| 위치 | 남는 값 |
|---|---|
| 인스턴스의 `apiKey`, `secret`, `uid` | 앱키, 시크릿, 계좌 정보 |
| 인스턴스의 `token`(한국투자증권), `accessToken`(토스증권) | 접근 토큰 |
| `last_request_headers` | 한국투자증권은 `authorization`, `appkey`, `appsecret`. 토스증권은 `Authorization`. KB증권은 `Authorization`, `appKey` |
| `last_request_body` | 토스증권 토큰 발급 본문에 `client_secret`. KB증권 본문에 호스트의 IPv4와 MAC 주소 |
| `last_request_url` | 한국투자증권 조회 주소의 쿼리에 계좌번호(`CANO`)와 상품 코드 |
| `last_http_response`, `last_json_response` | 한국투자증권 토큰 발급 직후에는 접근 토큰이 든 응답 |
| 오류 메시지 | 한국투자증권 토큰 발급 실패 메시지에 응답 본문 전체. HTTP 오류 메시지에 요청 주소와 응답 본문 |
| `verbose`가 켜진 로그 | 요청과 응답의 헤더와 본문. 알려진 비밀 헤더(`authorization`, `appkey`, `appsecret`)와 본문 필드(`appsecret`, `secretkey`, `client_secret`, `access_token`, `approval_key`, `refresh_token`)는 `***`로 가리지만, 계좌번호 같은 나머지 값은 그대로 남습니다 |
| `options.tokenStore`가 가리키는 저장소 | 접근 토큰(JSON) |

`JSON.stringify(broker)`와 `console.log(broker)`는 `apiKey`와 `secret`을 그대로 출력합니다. 인스턴스를 로그에 넣지 마십시오.

`last_*` 값은 요청마다 덮어씁니다. 토큰 발급 요청의 값은 다음 요청을 보내면 사라집니다. 다음 요청 전에 오류 보고 도구가 인스턴스를 수집하면 값이 함께 외부로 전송됩니다.

## 실시간 체결통보를 주문 판단의 근거로 쓰지 않습니다

한국투자증권의 실시간 연결(`ws://ops.koreainvestment.com`)은 암호화되지 않은 평문 연결입니다. 같은 망에 있는 제3자는 접속키와 HTS ID 를 읽을 수 있습니다. 라이브러리는 체결통보 TR(`H0STCNI0`, `H0STCNI9`, `H0GSCNI0`, `H0GSCNI9`) 가운데 암호화되지 않은 프레임을 버립니다. 그래도 `watchOrders()`가 알려 준 체결을 근거로 다음 주문을 내기 전에는 `fetchOrder`나 `fetchMyTrades`로 한 번 더 확인하십시오. 증권사가 암호화된 주소를 제공하면 `urls.ws`와 `urls.wsTest`로 바꿀 수 있습니다.

## 로그에 비밀이 남지 않게 하는 방법

1. 실전 환경에서 `verbose`를 켜지 않습니다. `verbose`는 기본이 `false`입니다. TypeScript 판은 `setLogger`로 로거를 전달했을 때만 로그를 출력합니다. Python 판은 표준 `logging`의 `kr_broker` 로거로 남기므로, 앱이 `logging.basicConfig(level=logging.DEBUG)`만 해도 출력됩니다.
2. `setLogger`에 전달하는 로거(Python 판은 `kr_broker` 로거의 핸들러)에서 `headers`, `body`, `err` 필드를 제외하거나 마스킹합니다. 라이브러리는 알려진 비밀 필드만 가리고 나머지는 그대로 전달합니다.
3. 기본 로거는 아무것도 출력하지 않습니다. `setLogger`를 호출하지 않으면 라이브러리는 로그를 남기지 않습니다.
4. 오류를 로그에 남길 때는 `error.name`, `error.detail`, 정리한 메시지만 씁니다. `error.message`에는 요청 주소와 응답 본문이 들어 있을 수 있고, `error.cause`는 하위 오류를 그대로 담습니다.
5. `last_request_*`와 `last_http_response`를 로그, 오류 보고 도구, 크래시 덤프에 넣지 않습니다.
6. 앱키와 시크릿은 환경 변수나 비밀 저장소에서 읽습니다. 코드와 저장소에 넣지 않습니다. 방법은 [앱키 발급 가이드](guides/credentials.md)에 있습니다.
7. `tokenStore`로 쓰는 저장소는 앱키와 같은 수준으로 접근을 제한합니다.
8. 이슈와 PR에 로그를 올리기 전에 앱키, 시크릿, 토큰, 계좌번호를 지웁니다.

앱키가 노출됐다면 [보안 정책](../SECURITY.md)의 절차를 따르십시오.
