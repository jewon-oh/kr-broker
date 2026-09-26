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
- 미국 주문 취소와 정정에는 `params.amount`(취소나 정정 수량)가 필요합니다. `editOrder`에 `amount`(정정 뒤 총수량)를 주면, 미체결 조회가 없어 원주문과 대조할 수 없으므로 `NotSupported`를 던집니다.
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

### 세 증권사의 장 시간 게이트

세 증권사는 같은 판정 함수(`krxOrderBlockReason`, `usOrderBlockReason`)로 장 시간을 판정합니다. 판정 시각은 인스턴스 시계(`milliseconds()`)입니다. 아래 표의 구분 열에서 "시장 규칙"은 시장이 주문을 받지 않는 시간이라 늘 막는다는 뜻입니다. "옵션"은 시장은 주문을 받지만, 호출하는 쪽이 막을지 고르는 정책이라는 뜻입니다.

| 시각 | 한국투자증권 | 토스증권 | KB증권 | 구분 |
|---|---|---|---|---|
| 국내 정규장(09:00~15:30) 밖과 휴장일 | 막습니다 | 막습니다. 확장세션은 아래 행을 봅니다 | 막습니다 | 시장 규칙 |
| 국내 15:20~15:30의 신규 매수 | `options.blockAuctionBuys`를 켜면 막습니다 | 같습니다 | 같습니다 | 옵션(기본 꺼짐) |
| 국내 확장세션 | `nxtRouting`을 켜거나 `session: 'nxt'`를 주면 NXT 프리마켓(08:00~08:50), 메인마켓(09:00~15:20), 애프터마켓(15:30~20:00)에 엽니다 | `nxtRouting`을 켜면 장 운영 캘린더의 프리마켓과 애프터마켓에 지정가만 엽니다 | 막습니다 | 증권사별 |
| 미국 정규장(09:30~16:00 ET) 밖과 휴장일 | 막습니다 | 장 운영 캘린더로 판정합니다. 주간거래, 프리마켓, 애프터마켓에는 정수 수량 지정가만 엽니다 | 막습니다 | 시장 규칙 |
| 미국 09:25~09:30(ET) | 막습니다 | 장 운영 캘린더를 따릅니다(프리마켓) | 막습니다 | 주문을 받는지 확인하지 못한 시간대 |
| 미국 15:50~16:00(ET)의 신규 매수 | `options.blockAuctionBuys`를 켜면 막습니다 | 같습니다 | 같습니다 | 옵션(기본 꺼짐) |
| 정정(`editOrder`) | 국내는 KRX 정규장과 NXT 세션이 모두 닫혔을 때, 미국은 정규장 밖에서 막습니다 | `createOrder`와 같이 판정합니다. 확장세션에서는 지정가 정정만 보냅니다 | `createOrder`와 같이 판정합니다 | |

정정은 원주문 조회보다 먼저 판정합니다. 장 밖이면 조회와 정정 요청을 보내지 않습니다. 정정은 신규 매수가 아니므로 `blockAuctionBuys`를 켜도 세 증권사 모두 동시호가 시간의 정정을 막지 않습니다. 토스증권의 조건주문 정정(`params.trigger: true`)은 등록처럼 게이트를 거치지 않습니다.

토스증권은 장 운영 캘린더를 받지 못하면 정적 시간표로 판정합니다. 국내는 KRX 정규장, 미국은 정규장만 엽니다.

KRX 15:20~15:30은 종가 단일가 매매 시간이고, 이 시간에도 호가를 받습니다. 단일가라서 시장가의 체결가가 예상과 크게 다를 수 있습니다. 진입을 피하려면 `blockAuctionBuys`를 켭니다. 매도(청산)는 옵션을 켜도 막지 않습니다.

### 한국투자증권의 경로별 장 시간 게이트

한국투자증권은 주문 경로마다 게이트가 다릅니다. 아래 표에서 "없음"인 경로는 라이브러리가 시각을 보지 않고 요청을 보냅니다. 장 시간 판단은 증권사 응답에 맡깁니다.

| 경로 | 막는 시각 |
|---|---|
| `createOrder` 국내 정규장, `createTriggerOrder`, `createCreditOrder` | KRX 정규장(09:00~15:30) 밖과 휴장일. `blockAuctionBuys`를 켜면 15:20~15:30의 신규 매수도 막습니다 |
| `createOrder` 국내 확장세션(`session: 'nxt'` 또는 `nxtRouting` 자동 판정) | NXT 프리마켓(08:00~08:50), 메인마켓(09:00~15:20), 애프터마켓(15:30~20:00) 밖과 휴장일 |
| `createOrder` 미국 | 정규장(09:30~16:00 ET) 밖. `blockAuctionBuys`를 켜면 15:50~16:00(ET)의 신규 매수도 막습니다 |
| `editOrder` 국내 | KRX 정규장과 NXT 확장세션이 모두 닫힌 시각과 휴장일 |
| `editOrder` 미국 | 정규장(09:30~16:00 ET) 밖 |
| `cancelOrder`, `cancelAllOrders` | 없음 |
| `createDaytimeOrder`, `createDerivativeOrder`, `createBondOrder`, `createOverseasDerivativeOrder` | 없음. 이 시장들의 시간표는 라이브러리에 없습니다 |
| 예약주문(`createReservedOrder`, `createOverseasReservedOrder`) | 없음. 장 밖에 내는 주문입니다 |

## cancelAllOrders는 항목의 status로 확인합니다

`cancelAllOrders()`는 미체결 주문을 조회해 하나씩 취소합니다. 일부를 취소하지 못해도 던지지 않습니다. 세 증권사 모두 미체결 조회로 받은 주문을 항목으로 반환합니다.

- 취소된 주문은 `status`가 `canceled`이고, 취소 응답 원문이 `info.cancelResponse`에 있습니다.
- 토스증권은 취소를 접수한 주문의 원주문 상세를 조회해 `status`를 정합니다. 취소가 확정되지 않으면 `status`를 비웁니다. 취소가 거절됐을 수도 있으니 `fetchOrder`로 확인합니다.
- 취소하지 못한 주문은 원래 상태(`open`)로 남습니다. 오류 메시지는 `info.cancelError`에, 오류의 `detail`은 `info.cancelErrorDetail`에 있습니다.
- 토스증권은 취소하려는 사이에 끝난 주문을 원인 코드대로 `closed`, `canceled`, `rejected`로 옮깁니다.
- 미체결 조회가 실패하거나 쪽 상한에서 잘리면 하나도 취소하지 않고 던집니다.

반환값을 보지 않으면 취소되지 않은 주문을 놓칩니다. `status`가 `open`이거나 비어 있는 항목이 남았는지 확인하십시오.

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
- 조회는 `maxRetriesOnFailure` 횟수만큼 다시 보냅니다. 한국투자증권은 시간 초과를 재시도하지 않습니다. 주문은 다시 보내지 않고, 접수 여부를 모르는 실패를 `OrderOutcomeUnknown`으로 바꿉니다.

## 앱키가 남을 수 있는 곳

라이브러리는 비밀을 자동으로 숨기지 않습니다. 소스에는 마스킹 코드가 없습니다. 아래 위치에 비밀이 그대로 남습니다.

| 위치 | 남는 값 |
|---|---|
| 인스턴스의 `apiKey`, `secret`, `uid` | 앱키, 시크릿, 계좌 정보 |
| 인스턴스의 `token`(한국투자증권), `accessToken`(토스증권) | 접근 토큰 |
| `last_request_headers` | 한국투자증권은 `authorization`, `appkey`, `appsecret`. 토스증권은 `Authorization`. KB증권은 `Authorization`, `appKey` |
| `last_request_body` | 토스증권 토큰 발급 본문에 `client_secret`. KB증권 본문에 호스트의 IPv4와 MAC 주소(`options.hostAddr`로 보낼 값을 정할 수 있습니다) |
| `last_request_url` | 한국투자증권 조회 주소의 쿼리에 계좌번호(`CANO`)와 상품 코드 |
| `last_http_response`, `last_json_response` | 한국투자증권 토큰 발급 직후에는 접근 토큰이 든 응답 |
| 오류 메시지 | 한국투자증권 토큰 발급 실패 메시지에 응답 본문 전체. HTTP 오류 메시지에 요청 주소와 응답 본문 |
| `verbose`가 켜진 로그 | 요청과 응답의 헤더와 본문. 알려진 비밀 헤더(`authorization`, `appkey`, `appsecret`)와 본문 필드(`appsecret`, `secretkey`, `client_secret`, `access_token`, `approval_key`, `refresh_token`)는 `***`로 가리지만, 계좌번호 같은 나머지 값은 그대로 남습니다. JSON 이나 폼으로 읽지 못한 본문은 원문 대신 길이만 남깁니다 |
| `options.tokenStore`가 가리키는 저장소 | 접근 토큰(JSON) |

요청 주소가 `https`가 아니면 라이브러리는 보내기 전에 `BadRequest`를 던집니다. 앱키와 토큰이 평문으로 나가지 않게 하려는 것입니다. 루프백 주소는 예외이고, 다른 주소는 `options.allowInsecureUrl`을 켜야 보냅니다.

`JSON.stringify(broker)`와 `console.log(broker)`는 `apiKey`와 `secret`을 그대로 출력합니다. 인스턴스를 로그에 넣지 마십시오.

`last_*` 값은 요청마다 덮어씁니다. 토큰 발급 요청의 값은 다음 요청을 보내면 사라집니다. 다음 요청 전에 오류 보고 도구가 인스턴스를 수집하면 값이 함께 외부로 전송됩니다.

## 실시간 체결통보를 주문 판단의 근거로 쓰지 않습니다

한국투자증권의 실시간 연결(`ws://ops.koreainvestment.com`)은 암호화되지 않은 평문 연결입니다. 같은 망에 있는 제3자는 접속키와 HTS ID 를 읽을 수 있습니다. 라이브러리는 체결통보 TR(`H0STCNI0`, `H0STCNI9`, `H0GSCNI0`, `H0GSCNI9`) 가운데 암호화되지 않은 프레임을 버립니다. 그래도 `watchOrders()`가 알려 준 체결을 근거로 다음 주문을 내기 전에는 `fetchOrder`나 `fetchMyTrades`로 한 번 더 확인하십시오. 증권사가 암호화된 주소를 제공하면 `urls.ws`와 `urls.wsTest`로 바꿀 수 있습니다.

## 로그에 비밀이 남지 않게 하는 방법

1. 실전 환경에서 `verbose`를 켜지 않습니다. `verbose`는 기본이 `false`입니다. TypeScript 판은 `setLogger`로 로거를 전달했을 때만 로그를 출력합니다. Python 판은 표준 `logging`의 `kr_broker` 로거로 남기므로, 앱이 `logging.basicConfig(level=logging.DEBUG)`만 해도 출력됩니다.
2. `setLogger`에 전달하는 로거(Python 판은 `kr_broker` 로거의 핸들러)에서 `headers`, `body`, `err` 필드를 제외하거나 마스킹합니다. 라이브러리는 알려진 비밀 필드만 가리고 나머지는 그대로 전달합니다.
3. 기본 로거는 아무것도 출력하지 않습니다. `setLogger`를 호출하지 않으면 라이브러리는 로그를 남기지 않습니다.
4. 오류를 로그에 남길 때는 `error.name`, `error.detail`, `error.brokerCode`, 정리한 메시지만 씁니다. `error.message`에는 요청 주소와 응답 본문이 들어 있을 수 있고, `error.cause`는 하위 오류를 그대로 담습니다.
5. `last_request_*`와 `last_http_response`를 로그, 오류 보고 도구, 크래시 덤프에 넣지 않습니다.
6. 앱키와 시크릿은 환경 변수나 비밀 저장소에서 읽습니다. 코드와 저장소에 넣지 않습니다. 방법은 [앱키 발급 가이드](guides/credentials.md)에 있습니다.
7. `tokenStore`로 쓰는 저장소는 앱키와 같은 수준으로 접근을 제한합니다.
8. 이슈와 PR에 로그를 올리기 전에 앱키, 시크릿, 토큰, 계좌번호를 지웁니다.

앱키가 노출됐다면 [보안 정책](../SECURITY.md)의 절차를 따르십시오.
