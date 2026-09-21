# 변경 이력

이 파일은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따르고, 버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다. 0.x에서 버전을 올리는 규칙은 [버전 정책](docs/versioning.md)에 있습니다.

## [Unreleased]

## [0.1.0] - 2026-09-21

첫 공개 버전입니다.

### 추가

- 한국 증권사 API를 ccxt처럼 쓰는 클래스 `kis`(한국투자증권), `toss`(토스증권), `kbsec`(KB증권)을 냈습니다.
- ccxt식 통합 자료 구조(`Market`, `Ticker`, `Order`, `Trade`, `Balances`)와 오류 계층(`ExchangeError` 계열)을 따랐고, 주문 접수 여부를 모를 때 던지는 `OrderOutcomeUnknown`을 추가했습니다.
- 증권사 캘린더 API로 받는 휴장일, 토큰 발급 잠금, 증권사별 호출 한도를 넣었습니다.

[Unreleased]: https://github.com/jewon-oh/kr-broker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jewon-oh/kr-broker/releases/tag/v0.1.0
