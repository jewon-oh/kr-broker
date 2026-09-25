# 기여 안내

`kr-broker`에 기여해 주셔서 감사합니다. 개발 절차, 커밋 형식, 테스트 규칙, 증권사 API 변경에 대응하는 방법을 적었습니다.

기여한 코드는 저장소의 [LICENSE](LICENSE) 조건으로 배포됩니다.

## 시작하기 전에

- 버그와 제안은 [이슈](https://github.com/jewon-oh/kr-broker/issues/new/choose) 양식으로 올립니다.
- 큰 변경은 PR 전에 이슈로 먼저 의논합니다.
- 보안 문제는 이슈에 올리지 않습니다. [보안 정책](SECURITY.md)의 경로를 따릅니다.
- 사용법 질문은 [FAQ](docs/faq.md)와 [안전 가이드](docs/SAFETY.md)를 먼저 봅니다.

`kr-broker` 라이브러리는 증권사와 관계가 없는 비공식 프로젝트입니다. 주문 경로의 코드는 실계좌로 실제 주문을 냅니다. 주문 경로를 바꾸는 PR은 검토가 오래 걸릴 수 있습니다.

## 저장소 구조

배치는 [ccxt](https://github.com/ccxt/ccxt)와 같습니다.

```text
ts/src/                  TypeScript 판
  base/                  공통 계층(Exchange, 오류, 공용 함수)
  kis.ts, kis/           증권사 클래스와 보조 모듈(toss, kbsec 도 같은 모양)
  spec/                  두 판이 함께 쓰는 엔드포인트 표
  test/static/request/   두 판이 함께 돌리는 요청 픽스처
python/kr_broker/        Python 판
  base/  abstract/       공통 계층과 엔드포인트 표에서 만든 암묵 API 선언
  async_support/         비동기 판. 증권사 클래스의 정본이다
  kis.py, toss.py        동기 판 증권사 클래스(async_support/ 에서 만든다)
  test/                  Python 테스트
examples/ts/, examples/py/
docs/                    문서와 지원 현황 자료(docs/coverage/)
scripts/                 문서 생성기와 암묵 API 생성기
```

## 개발 절차

구현 언어별로 절을 나눕니다. 구현이 늘어나면 언어별 절을 추가합니다.

### TypeScript(Node.js)

Node.js 22와 pnpm이 필요합니다. `.nvmrc`가 Node.js 버전을, `package.json`의 `packageManager`가 pnpm 버전을 지정합니다.

```bash
git clone https://github.com/jewon-oh/kr-broker.git
cd kr-broker
pnpm install
pnpm typecheck   # 소스, 테스트, examples/ 까지 타입 검사
pnpm test
pnpm build
pnpm hygiene:check   # 비밀이나 사설 식별자로 보이는 값 검사
```

- `pnpm typecheck`는 `examples/ts/`도 검사합니다. README의 예제 코드가 실제 API와 어긋나면 `pnpm typecheck`가 실패합니다.
- 테스트 하나만 실행하려면 `pnpm exec vitest run ts/src/kis/__tests__/kis-order.test.ts`처럼 경로를 지정합니다.
- 테스트는 `ts/src/**/__tests__/` 아래에 둡니다.
- 테스트는 `fetch`를 가짜 함수로 대체합니다. 증권사 서버를 호출하지 않습니다.
- `docs/coverage/`의 자료를 고쳤다면 `pnpm docs:gen`으로 `docs/brokers/`와 README의 기능 표를 다시 만듭니다. README는 `<!-- coverage:start -->`와 `<!-- coverage:end -->` 사이만 바뀝니다. `pnpm docs:check`는 둘이 자료와 다르면 실패합니다.
- CI는 `pnpm typecheck`, `pnpm hygiene:check`, `pnpm test`, `pnpm docs:check`, `pnpm build`, `pnpm audit --prod`를 실행합니다. 테스트는 Linux의 Node.js 22와 24, Windows의 Node.js 22에서 실행합니다.

PR을 올리기 전에 `pnpm typecheck`, `pnpm test`, `pnpm build`가 통과해야 합니다. 빌드한 `dist/`는 `node scripts/check-dist-imports.mjs`로 Node.js에서 불러와지는지 확인합니다.

### Python

Python 3.10 이상이 필요합니다. `python/`에서 설치하고 테스트합니다.

```bash
cd python
python -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest
```

- `python/kr_broker/abstract/`는 `node scripts/gen-python-abstract.mjs`가 `ts/src/spec/*.json`에서 만드는 파일입니다. 직접 고치지 말고 엔드포인트 표를 고친 뒤 다시 만듭니다.
- 동작은 TypeScript 판과 같아야 합니다. 두 판이 함께 돌리는 요청 픽스처(`ts/src/test/static/request/`)에 케이스를 더하고, TypeScript 판에서 먼저 통과시킨 뒤 Python 판을 맞춥니다. 형식은 [ts/src/test/static/README.md](ts/src/test/static/README.md)에 있습니다.
- 증권사 클래스와 I/O 가 있는 도우미는 `python/kr_broker/async_support/`의 비동기 판이 정본입니다. 동기 판(`kis.py`, `toss.py` 등 `scripts/gen-python-sync.mjs`의 `GENERATED_MODULES`)은 `node scripts/gen-python-sync.mjs`로 만듭니다. 동기 판 파일을 직접 고치면 CI가 실패합니다.
- 비동기 판 소스는 asyncio 를 직접 쓰지 않고 `async_support/base/runtime.py`의 `sleep_seconds`, `new_lock`, `new_semaphore`, `maybe_await`를 씁니다. 생성 스크립트가 이 이름들을 동기 짝(`base/runtime.py`)으로 바꿉니다.
- 두 판이 함께 써야 하는 전역 상태(휴장일 캘린더, 한국투자증권 앱키 슬롯)는 생성하지 않는 모듈(`market_calendar.py`, `kis_rate_limit.py`)에 둡니다. 베이스(`base/`)와 캘린더 갱신 함수는 동기 짝과 비동기 짝(`async_support/base/`, `async_support/market_calendar.py`)을 손으로 씁니다. 한쪽을 고치면 다른 쪽도 고칩니다. `test_async_support.py`가 두 짝의 인자가 같은지 봅니다.
- CI는 `node scripts/gen-python-abstract.mjs --check`, `node scripts/gen-python-sync.mjs --check`, `pytest`를 Python 3.10과 3.13에서 실행합니다.

## 커밋과 PR

커밋 메시지는 [Conventional Commits](https://www.conventionalcommits.org/ko/v1.0.0/) 형식입니다.

```text
type(scope): 설명
```

- `type`은 `feat`, `fix`, `docs`, `test`, `refactor`, `ci`, `chore` 중 하나입니다.
- `scope`는 `kis`, `toss`, `kbsec`, `base`, `docs`처럼 바뀐 곳을 적습니다. 생략해도 됩니다.
- 설명은 한국어나 영어로 씁니다. 한 줄에 무엇이 바뀌었는지 적습니다.
- 파괴적 변경은 `type!:`로 표시하고 본문에 `BREAKING CHANGE:`를 적습니다.

PR 하나에는 목적 하나만 담습니다. 사용자에게 보이는 변경은 `CHANGELOG.md`의 `[Unreleased]`에 적습니다. 버전을 어떻게 올리는지는 [버전 정책](docs/versioning.md)에 있습니다.

PR 본문은 [PR 템플릿](.github/pull_request_template.md)의 항목을 채웁니다.

## 계약 테스트

세 증권사는 같은 상황에서 같은 계약을 지켜야 합니다. 계약은 공통 스위트가 코드로 정의합니다. TypeScript 구현의 위치는 `ts/src/__tests__/support/broker-contract-suite.ts`입니다.

계약은 일곱 가지입니다.

1. 알려진 업무 오류는 증권사가 선언한 오류 클래스로 던지고, 세부 원인 코드는 `detail`에 남깁니다.
2. 분류 밖의 업무 오류는 `ExchangeError` 그대로 던집니다. 하위 클래스로 추측해서 좁히지 않습니다.
3. 주문 요청이 연결 오류나 시간 초과로 끝나면 `OrderOutcomeUnknown`을 던지고 요청을 다시 보내지 않습니다. 조회의 연결 오류는 `NetworkError`입니다.
4. 실패해도 증권사의 원문 메시지를 잃지 않습니다.
5. 장 시간 밖의 주문은 `MarketClosed`를 던지고 주문 요청을 증권사에 보내지 않습니다.
6. 조회가 실패하면 빈 값을 반환하지 않고 던집니다.
7. 정상 주문은 접수 결과(`Order`)를 반환하고 주문 요청을 정확히 한 번 보냅니다.

### 새 증권사를 추가하는 규칙

1. `Exchange`를 상속한 클래스를 만듭니다. `describe()`에 `has`, `urls`, `api`, `requiredCredentials`, `exceptions`를 선언합니다.
2. 주문을 내는 엔드포인트는 `api`에 `order: true`로 적습니다. `order: true`가 있어야 요청을 다시 보내지 않고 `OrderOutcomeUnknown`으로 바꿉니다.
3. 증권사 하네스(`BrokerContractHarness`)를 만들어 `defineBrokerContractSuite`를 호출합니다. `ts/src/kis/__tests__/kis-contract.test.ts`가 예입니다.
4. 진입점의 `exchanges`와 `brokers`에 클래스를 추가합니다.
5. 오류 코드 표에는 실측했거나 공식 자료로 확인한 코드만 넣습니다. 추측으로 채우지 않습니다. 항목마다 원문 문구와 요청 종류를 주석으로 남깁니다.
6. README의 지원 표와 CHANGELOG를 고칩니다.

### 새 기능을 추가하는 규칙

1. `has`에 기능 이름을 적고 메서드를 구현합니다. `has`와 구현이 어긋나면 `ts/src/__tests__/broker-capabilities.test.ts`가 실패합니다.
2. `emulated`는 증권사 API에 같은 조회가 없어서 다른 조회로 만든 값일 때만 씁니다.
3. 주문을 내는 요청에는 재시도를 붙이지 않습니다.
4. 조회가 실패했을 때 빈 값을 반환하지 않습니다.
5. 계약이 다루지 않는 동작은 증권사 테스트 파일에 테스트를 추가합니다.
6. 계약 스위트를 바꾸는 PR은 세 증권사 테스트가 모두 통과해야 합니다.

## 테스트 픽스처 규칙

픽스처는 테스트가 쓰는 가짜 응답과 가짜 자격증명입니다. 언어와 관계없이 아래 규칙을 지킵니다.

- 실계좌 정보를 넣지 않습니다. 앱키, 시크릿, 접근 토큰, 계좌번호, 계좌 순번, 주문번호, 이름, 전화번호, 이메일이 대상입니다.
- 호스트의 IP와 MAC 주소도 넣지 않습니다. KB증권 요청 본문에 두 값이 담깁니다.
- 자격증명은 가짜 값을 씁니다. 기존 테스트는 `TEST-APPKEY-123456789`와 `12345678-01` 같은 값을 씁니다.
- 실제 응답을 바탕으로 만든 픽스처는 필드 구조를 그대로 두고 값을 바꿉니다.
- 수량, 가격, 체결 시각처럼 계좌 활동을 드러내는 값도 바꿉니다.
- 커밋한 비밀은 이력에 남습니다. 커밋 전에 `git diff`로 픽스처를 확인합니다.
- `pnpm hygiene:check`는 JWT, 개인 키, AWS 액세스 키 모양과 사설 IP, `example.*`가 아닌 이메일, 홈 디렉터리 경로를 찾습니다. 계좌번호와 주문번호는 패턴으로 가릴 수 없으므로 직접 확인합니다.
- 실수로 올렸다면 PR을 닫고 [보안 정책](SECURITY.md)의 절차대로 앱키를 폐기합니다.

## 증권사 API 변경 대응

증권사가 API 명세를 바꾸면 라이브러리가 어긋납니다. 대응 순서는 다음과 같습니다.

1. [증권사 API 변경 이슈](https://github.com/jewon-oh/kr-broker/issues/new?template=broker_api_change.yml)로 변경을 알립니다. 공식 공지나 명세의 주소와 변경 시점을 적습니다.
2. 변경을 공식 문서나 실측으로 확인합니다. 추측으로 코드를 고치지 않습니다.
3. 바뀐 응답 형식으로 픽스처를 고칩니다. 픽스처 규칙을 지킵니다.
4. 오류 코드가 바뀌었으면 오류 코드 표를 고칩니다. 실측한 문구를 주석으로 남깁니다.
5. `has`와 README의 지원 표가 바뀌면 함께 고칩니다.
6. CHANGELOG에 적고, 버전은 [버전 정책](docs/versioning.md)의 증권사 API 변경 대응 표로 정합니다.

주문 경로를 고쳤다면 소액으로 실계좌에서 확인한 뒤 결과를 PR에 적습니다. 값은 가려서 적습니다. 실계좌로 확인하지 못했다면 PR에 그렇게 적습니다.

## AI 보조 기여 고지

코딩 도구나 대화형 모델을 썼다면 PR 본문의 AI 사용 항목에 도구와 사용한 부분을 적어 주십시오. 고지해도 불이익은 없습니다.

AI가 쓴 코드도 제출한 사람이 이해하고 직접 검증해야 합니다. 주문 경로와 오류 분류는 특히 그렇습니다.
