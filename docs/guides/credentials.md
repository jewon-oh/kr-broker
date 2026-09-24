# 앱키 발급 가이드

세 증권사 모두 Open API 앱키를 발급받아야 시세를 조회하고 주문을 냅니다. 발급 위치와 각 값이 대응하는 라이브러리 필드를 적었습니다. 증권사 화면과 절차는 바뀔 수 있으므로 각 증권사 공식 안내를 함께 확인하십시오.

## 필드 대응표

| 증권사 | `apiKey` | `secret` | `uid` |
|---|---|---|---|
| 한국투자증권 `kis` | 앱키(App Key) | 앱시크릿(App Secret) | 계좌번호 `8자리-2자리`. 뒤 2자리를 생략하면 `01`입니다. 필수입니다 |
| 토스증권 `toss` | 클라이언트 ID(`client_id`) | 클라이언트 시크릿(`client_secret`) | 계좌 순번(`accountSeq`). 계좌번호가 아닙니다. 선택입니다 |
| KB증권 `kbsec` | 앱키(`appKey`) | 앱시크릿(`appSecret`) | 필요 없습니다. 넣어도 사람이 구분하는 메모로만 쓰입니다 |

`kis`의 `uid`가 비어 있으면 `checkRequiredCredentials()`가 `AuthenticationError`를 던집니다.

토스증권의 `uid`를 전달하지 않으면 라이브러리가 처음 계좌 API를 호출할 때 `GET /accounts`가 반환한 첫 계좌의 순번을 채웁니다. 빈 문자열을 전달하면 채우지 않습니다. 계좌가 여러 개면 원하는 순번을 직접 전달하십시오.

KB증권 API에는 계좌번호를 입력받는 요청이 없습니다. 소스 주석은 계좌가 앱키에 연결되어 있는 것으로 보인다고 적었습니다. 계좌가 여러 개인 경우에 검증했는지는 확인 불가입니다.

## 한국투자증권

1. 한국투자증권 계좌를 준비합니다.
2. KIS Developers 포털에서 Open API 서비스를 신청합니다.
3. 발급된 앱키와 앱시크릿을 `apiKey`와 `secret`에 전달합니다.
4. 계좌번호는 `uid`에 `12345678-01` 모양으로 전달합니다.

### 모의투자 앱키

모의투자 앱키는 실전 앱키와 따로 발급합니다. 한국투자증권 공식 저장소의 설정 예시도 실전용과 모의투자용 앱키와 시크릿을 따로 받습니다.

모의투자로 연결하려면 인스턴스를 만들 때 `sandbox: true`를 전달하고, `apiKey`와 `secret`에는 모의투자 앱키를 씁니다.

```ts
const paper = new kis({
    apiKey: process.env.KIS_PAPER_APP_KEY ?? '',
    secret: process.env.KIS_PAPER_APP_SECRET ?? '',
    uid: process.env.KIS_PAPER_ACCOUNT_NO ?? '',
    sandbox: true,
});
```

모의투자 계좌를 여는 절차는 확인 불가입니다. 한국투자증권 공식 안내를 따르십시오.

### 접근 토큰

접근 토큰 발급에는 빈도 제한이 있습니다. 소스는 발급 한도를 분당 1회로 적었습니다. 라이브러리는 토큰을 메모리에 캐시합니다. 여러 프로세스가 같은 앱키를 쓰면 `options.tokenStore`로 토큰을 공유하십시오.

### 접속 주소

| 환경 | 주소 |
|---|---|
| 실전 | `https://openapi.koreainvestment.com:9443` |
| 모의투자 | `https://openapivts.koreainvestment.com:29443` |

호출 서버의 방화벽이 443 포트만 허용한다면 `9443`과 `29443` 포트를 추가로 허용해야 합니다.

## 토스증권

1. 토스증권 WTS에 로그인합니다.
2. 설정 > Open API 메뉴에서 `client_id`와 `client_secret`을 발급받습니다.
3. 같은 메뉴의 허용 IP 관리에 API를 호출할 서버의 IP를 등록합니다.
4. `client_id`를 `apiKey`에, `client_secret`을 `secret`에 전달합니다.

허용 IP 목록에 없는 주소에서 호출하면 토스증권이 403으로 거절합니다. 라이브러리는 403을 `PermissionDenied`로 던집니다.

개인 계정으로 발급할 수 있는지와 발급 심사 조건은 확인 불가입니다.

토스증권은 클라이언트마다 유효한 토큰이 하나뿐입니다. 토큰을 다시 발급하면 직전 토큰이 무효가 됩니다. 같은 클라이언트를 여러 프로세스에서 쓰면 서로의 토큰을 무효로 만들 수 있으므로 `options.tokenStore`로 토큰을 공유하십시오.

토스증권에는 모의 서버가 없습니다.

## KB증권

1. KB증권 계좌를 준비합니다.
2. KB증권 Open API 포털에서 Open API 서비스 사용을 신청합니다.
3. 발급된 앱키와 앱시크릿을 `apiKey`와 `secret`에 전달합니다.

신청 화면의 세부 절차(본인인증 방식, 승인 소요 시간)는 확인 불가입니다.

KB증권에는 모의 서버가 없습니다. 첫 주문이 곧 실계좌 주문입니다. [안전 가이드](../SAFETY.md)의 소액 시험 절차를 따르십시오.

KB증권 API 주소는 `https://developer.kbsec.com:32484`입니다. 비표준 포트를 씁니다. 호출 서버의 방화벽이 443 포트만 허용한다면 32484 포트를 추가로 허용해야 합니다.

## 앱키를 코드에 넣지 않는 방법

라이브러리는 환경 변수를 읽지 않습니다. 코드에서 환경 변수를 읽어 인스턴스에 전달합니다.

```ts
const broker = new kis({
    apiKey: process.env.KIS_APP_KEY ?? '',
    secret: process.env.KIS_APP_SECRET ?? '',
    uid: process.env.KIS_ACCOUNT_NO ?? '',
});
```

`apiKey`나 `secret`이 빈 문자열이면 라이브러리는 첫 비공개 호출에서 `AuthenticationError`를 던집니다. 환경 변수를 설정하지 않았다면 이 오류가 나옵니다.

### 환경 변수 이름

라이브러리가 정한 이름은 없습니다. `examples/`의 예제는 아래 이름을 씁니다.

| 증권사 | 환경 변수 |
|---|---|
| 한국투자증권 | `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_ACCOUNT_NO` |
| 토스증권 | `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`, `TOSS_ACCOUNT_SEQ` |

### 로컬 개발

1. 저장소 밖이나 `.gitignore`에 든 `.env` 파일에 값을 적습니다. 저장소의 `.gitignore`는 `.env`와 `.env.*`를 제외합니다.
2. Node.js 22에서는 `node --env-file=.env <파일>`로 값을 읽습니다.
3. 값 없는 예시 파일은 `.env.example`로 커밋합니다. `.gitignore`가 `.env.example`은 제외하지 않습니다.

### 운영 서버

- 서버의 비밀 저장소나 환경 변수 주입 기능을 씁니다.
- CI에서는 저장소의 비밀 값(GitHub Actions의 secrets)으로 전달합니다.
- 컨테이너 이미지와 로그에 값을 남기지 않습니다.

### 노출됐을 때

앱키를 이슈, 커밋, 로그에 올렸다면 먼저 증권사에서 앱키를 폐기하거나 재발급하십시오. 값을 지우는 것은 그다음입니다. 절차는 [보안 정책](../../SECURITY.md)에 있습니다.

비밀이 로그에 남는 경로와 막는 방법은 [안전 가이드](../SAFETY.md)에 있습니다.
