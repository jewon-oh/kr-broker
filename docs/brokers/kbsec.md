<!-- 이 문서는 생성물입니다. 손으로 고치지 않습니다. `docs/coverage/`의 자료를 고친 뒤 `pnpm docs:gen`을 실행합니다. -->

# KB증권(`kbsec`) 지원 현황

> 이 문서는 생성물입니다. 손으로 고치지 않습니다. `docs/coverage/`의 자료를 고친 뒤 `pnpm docs:gen`을 실행합니다.

조사일은 2026-09-21입니다. 증권사 API를 호출하지 않고 공식 명세와 저장소의 소스를 대조했습니다.

전체 기능 표는 [기능별 지원](README.md#기능별-지원)에 있습니다.

## 목차

- [요약](#요약)
- [커버리지 요약](#커버리지-요약)
- [출처](#출처)
- [카테고리별 공식 API](#카테고리별-공식-api)
  - [투자정보](#투자정보)
  - [고객계좌](#고객계좌)
  - [트레이딩](#트레이딩)
- [이 증권사에서만 쓰는 기능](#이-증권사에서만-쓰는-기능)
- [알려진 한계](#알려진-한계)
- [미구현 API](#미구현-api)

## 요약

| 항목 | 내용 |
|---|---|
| 클래스 | `kbsec` |
| 인증 필드 `apiKey` | 앱키 |
| 인증 필드 `secret` | 앱시크릿 |
| 인증 필드 `uid` | 계좌 메모, 선택. 계좌번호를 받는 TR이 없습니다. 사람이 계정을 구분하는 메모로만 씁니다. |
| 모의투자 | 지원하지 않습니다. `setSandboxMode(true)`는 `NotSupported`를 던집니다. |
| 지원 시장 | 국내(KR), 미국(US) |
| 호출 한도 | KB증권은 호출 한도 수치를 공개하지 않습니다. 400ms(초당 2.5건)는 낮게 잡은 시작값입니다. |
| 공식 API | 93개 중 통합 18개, 확장 6개, 암묵과 내부 1개, 미구현 68개 |
| 커버리지 | 통합과 확장 기준 25.8%, 암묵과 내부 포함 기준 26.9% |

## 커버리지 요약

웹소켓 채널도 API 1개로 집계합니다. 값의 뜻은 [표기 규칙](README.md#표기-규칙)에 있습니다.

| 구분 | 공식 API 수 | 통합 | 확장 | 암묵과 내부 | 미구현 | 통합과 확장 기준 | 암묵과 내부 포함 기준 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 투자정보 | 31 | 5 | 1 | 0 | 25 | 19.4% (6/31) | 19.4% (6/31) |
| 고객계좌 | 24 | 2 | 2 | 1 | 19 | 16.7% (4/24) | 20.8% (5/24) |
| 트레이딩 | 38 | 11 | 3 | 0 | 24 | 36.8% (14/38) | 36.8% (14/38) |
| **합계** | 93 | 18 | 6 | 1 | 68 | 25.8% (24/93) | 26.9% (25/93) |

## 출처

| 출처 | 주소 |
|---|---|
| KB증권 공식 TR 명세 93종(kb-openapi 저장소 커밋 159480c, 2026-07-29) | https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json |
| KB증권 공식 예제(투자정보 29종 호출 함수) | https://github.com/kbsecurities/kb-openapi |
| KB증권 Open API 포털(공지가 렌더링되지 않아 확인하지 못했습니다) | https://openapi.kbsec.com |

## 카테고리별 공식 API

### 투자정보

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 종목기본정보 | `POST /api/v1/siqm4900` | 국내 | 미구현 | - | `spec-only` | `fetchSecurityInfo` (확장) | [Tkb_SIQM4900_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SIQM4900_B2C) |  |
| 종목기업개요 | `POST /api/v1/ivm10050` | 국내 | 미구현 | - | `spec-only` | `fetchCompanyProfile` (확장) | [Tkb_IVM10050_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVM10050_B2C) |  |
| 장운영상태 조회 | `POST /api/v1/szqm0771` | 국내 | 확장 | `fetchMarketCalendar` | `spec-only` | - | [Tkb_SZQM0771_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SZQM0771_B2C) | 전영업일, 기준영업일, 익영업일 3개만 읽습니다. 장운영구분코드(stk_mkoprt_ccd 등)와 주문기준일자 ±3, 납회일 여부, 온라인마감 여부는 미노출. 함께 노출: refreshMarketCalendar |
| 공휴일관리 | `POST /api/v1/spam2508` | 국내, 미국 | 미구현 | - | `spec-only` | `fetchMarketCalendar` (통합) | [Tkb_SPAM2508_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPAM2508_B2C) |  |
| 주식현재가 | `POST /api/v1/ivu10140` | 국내 | 통합 | `fetchTicker` | `real` | - | [Tkb_IVU10140_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10140_B2C) | 거래소구분 excg_clsf는 1(KRX) 고정이라 통합(0), NXT(2) 시세는 노출하지 않습니다. 상하한가(ulmt_prc, llmt_prc), 매매수량단위(trd_q_unt)는 응답에 있으나 미사용 |
| 주식호가 | `POST /api/v1/ivu10070` | 국내 | 통합 | `fetchOrderBook` | `real` | - | [Tkb_IVU10070_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10070_B2C) | 10호가. 시간외장구분 ovtm_mkt_clsf는 1로 고정 |
| 주식시간대별추이 | `POST /api/v1/ivu10080` | 국내 | 미구현 | - | `spec-only` | `fetchTrades` (통합) | [Tkb_IVU10080_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10080_B2C) |  |
| 통합차트 | `POST /api/v1/ivs11560` | 국내 | 통합 | `fetchOHLCV` | `spec-only` | - | [Tkb_IVS11560_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVS11560_B2C) | 실계좌 미검증(테스트 제목). 시장구분 mkt_clsf는 코스피 고정, 수정주가(info_ccd 2)는 미노출 |
| 종목별투자자 | `POST /api/v1/ivu10430` | 국내 | 미구현 | - | `spec-only` | `fetchInvestorTrend` (확장) | [Tkb_IVU10430_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10430_B2C) |  |
| 당일주요외국계거래원 | `POST /api/v1/ivu10420` | 국내 | 미구현 | - | `spec-only` | `fetchForeignBrokerTrend` (확장) | [Tkb_IVU10420_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10420_B2C) |  |
| 종목별프로그램매매추이 | `POST /api/v1/ivu10450` | 국내 | 미구현 | - | `spec-only` | `fetchProgramTradingTrend` (확장) | [Tkb_IVU10450_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10450_B2C) |  |
| 외국인기관매매상위 | `POST /api/v1/ivu10020` | 국내 | 미구현 | - | `spec-only` | `fetchInvestorRanking` (확장) | [Tkb_IVU10020_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10020_B2C) |  |
| 테마그룹조회 | `POST /api/v1/ivs11430` | 국내 | 미구현 | - | `spec-only` | `fetchThemeGroups` (확장) | [Tkb_IVS11430_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVS11430_B2C) |  |
| 프로그램매매상위 | `POST /api/v1/ivs10920` | 국내 | 미구현 | - | `spec-only` | `fetchProgramTradingRanking` (확장) | [Tkb_IVS10920_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVS10920_B2C) |  |
| 거래량상위 | `POST /api/v1/ivu10280` | 국내 | 미구현 | - | `spec-only` | `fetchVolumeRanking` (확장) | [Tkb_IVU10280_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10280_B2C) |  |
| 급등/급락 상위 | `POST /api/v1/ivu10270` | 국내 | 미구현 | - | `spec-only` | `fetchSurgePlungeRanking` (확장) | [Tkb_IVU10270_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10270_B2C) |  |
| 거래대금상위 | `POST /api/v1/ivu10210` | 국내 | 미구현 | - | `spec-only` | `fetchTradingValueRanking` (확장) | [Tkb_IVU10210_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10210_B2C) |  |
| 등락률상위 | `POST /api/v1/ivu10240` | 국내 | 미구현 | - | `spec-only` | `fetchChangeRateRanking` (확장) | [Tkb_IVU10240_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10240_B2C) |  |
| 시가대비등락률상위 | `POST /api/v1/ivs10910` | 국내 | 미구현 | - | `spec-only` | `fetchOpenChangeRateRanking` (확장) | [Tkb_IVS10910_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVS10910_B2C) |  |
| 기간외등락률순위 | `POST /api/v1/ivs11190` | 국내 | 미구현 | - | `spec-only` | `fetchExtendedHoursRanking` (확장) | [Tkb_IVS11190_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVS11190_B2C) |  |
| 신고/신저 | `POST /api/v1/ivu10550` | 국내 | 미구현 | - | `spec-only` | `fetchNewHighLow` (확장) | [Tkb_IVU10550_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10550_B2C) |  |
| 업종랭킹 | `POST /api/v1/ivm30010` | 국내 | 미구현 | - | `spec-only` | `fetchSectorRanking` (확장) | [Tkb_IVM30010_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVM30010_B2C) |  |
| 시장종합 | `POST /api/v1/ivsa0070` | 국내 | 미구현 | - | `spec-only` | `fetchMarketSummary` (확장) | [Tkb_IVSA0070_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVSA0070_B2C) |  |
| 세계지수 | `POST /api/v1/iva60140` | 국내, 미국 | 미구현 | - | `spec-only` | `fetchWorldIndices` (확장) | [Tkb_IVA60140_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVA60140_B2C) |  |
| 환율종합 | `POST /api/v1/iva60190` | 국내, 미국 | 미구현 | - | `spec-only` | `fetchExchangeRates` (확장) | [Tkb_IVA60190_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVA60190_B2C) |  |
| 증시주변자금동향 | `POST /api/v1/iva10370` | 국내 | 미구현 | - | `spec-only` | `fetchMarketFundFlow` (확장) | [Tkb_IVA10370_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVA10370_B2C) |  |
| 종목관리 | `POST /api/v1/siam4983` | 미국 | 미구현 | - | `spec-only` | `fetchMarkets` (통합) | [Tkb_SIAM4983_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SIAM4983_B2C) |  |
| 현재가 | `POST /api/v1/gss10030` | 미국 | 통합 | `fetchTicker` | `spec-only` | - | [Tkb_GSS10030_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_GSS10030_B2C) | 거래소 NAS, NYS, AMX 순회. 상하한가, 시세지연구분(mrkt_prc_clsf), 호가단위(b_askprc_unt_p4), 휴장여부(clsd_mrkt_f), 거래정지구분(dl_spsn_ccd)은 응답에 있으나 미사용 |
| 호가 | `POST /api/v1/gss10040` | 미국 | 통합 | `fetchOrderBook` | `spec-only` | - | [Tkb_GSS10040_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_GSS10040_B2C) | 거래소코드는 fetchTicker가 캐시한 값을 쓰고 없으면 NAS로 고정합니다. |
| 시간대별체결 | `POST /api/v1/gsa10020` | 미국 | 미구현 | - | `spec-only` | `fetchTrades` (통합) | [Tkb_GSA10020_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_GSA10020_B2C) |  |
| 차트 | `POST /api/v1/gsc10060` | 미국 | 미구현 | - | `spec-only` | `fetchOHLCV` (통합) | [Tkb_GSC10060_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_GSC10060_B2C) |  |

### 고객계좌

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 글로벌원마켓 증거금사용현황 | `POST /api/v1/spqn3390` | 미국 | 미구현 | - | `spec-only` | `fetchOneMarketMarginUsage` (확장) | [Tkb_SPQN3390_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQN3390_B2C) |  |
| 예수금내역 | `POST /api/v1/ssqm0004` | 국내 | 통합 | `fetchBalance` | `real` | - | [Tkb_SSQM0004_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0004_B2C) | 주문가능현금만 읽습니다. |
| 예수금조회 | `POST /api/v1/swqm2302` | 국내 | 미구현 | - | `spec-only` | `fetchDepositDetails` (확장) | [Tkb_SWQM2302_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQM2302_B2C) |  |
| 익일익익일 출금가능금액 조회 | `POST /api/v1/swqn2302` | 국내 | 미구현 | - | `spec-only` | `fetchWithdrawableAmount` (확장) | [Tkb_SWQN2302_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQN2302_B2C) |  |
| 총 잔고 조회 | `POST /api/v1/ssqm0005` | 국내 | 미구현 | - | `spec-only` | `fetchAccountSummary` (확장) | [Tkb_SSQM0005_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0005_B2C) |  |
| 평가손익 조회 | `POST /api/v1/ssqm0006` | 국내 | 미구현 | - | `spec-only` | `fetchUnrealizedPnl` (확장) | [Tkb_SSQM0006_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0006_B2C) |  |
| 총 자산평가 내역 조회 | `POST /api/v1/ssqm0009` | 국내 | 미구현 | - | `spec-only` | `fetchTotalAssetValuation` (확장) | [Tkb_SSQM0009_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0009_B2C) |  |
| 보유주식 조회 | `POST /api/v1/ssqm1801` | 국내 | 내부 | - | `real` | - | [Tkb_SSQM1801_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM1801_B2C) | 주문가능수량, 일반수량만 줍니다. |
| 종합계좌 잔고현황 조회 (종합위탁계좌, 신연금저축계좌) | `POST /api/v1/ssqm2932` | 국내 | 미구현 | - | `spec-only` | `fetchIntegratedBalance` (확장) | [Tkb_SSQM2932_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2932_B2C) |  |
| 계좌자산평가 | `POST /api/v1/ssqm2952` | 국내 | 통합 | `fetchBalance` | `real` | - | [Tkb_SSQM2952_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2952_B2C) | 실보유수량 ec_q, 매입평균가, 평가금액은 읽습니다. 종목별 거래세율(dl_tx_r_p4), 농특세율, 수수료율(fee_r_p9), NXT 상장구분(nxtd_lstng_ccd)은 응답에 있으나 미사용 |
| 주식자산평가조회 (실시간) | `POST /api/v1/ssqn2952` | 국내 | 미구현 | - | `spec-only` | `fetchRealtimeAssetValuation` (확장) | [Tkb_SSQN2952_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQN2952_B2C) |  |
| 국내주식 소수점 매매 보유잔고내역 조회 | `POST /api/v1/ssqm5472` | 국내 | 미구현 | - | `spec-only` | `fetchFractionalHoldings` (확장) | [Tkb_SSQM5472_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM5472_B2C) |  |
| 계좌원장 거래내역 조회 (위탁, 금융상품, 저축) | `POST /api/v1/swqa2301` | 국내 | 미구현 | - | `spec-only` | `fetchLedger` (통합) | [Tkb_SWQA2301_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQA2301_B2C) |  |
| 계좌원장 거래내역 조회 (CMA) | `POST /api/v1/swqb2301` | 국내 | 미구현 | - | `spec-only` | `fetchLedger` (통합) | [Tkb_SWQB2301_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQB2301_B2C) |  |
| 거래내역상세 조회 | `POST /api/v1/swqm2412` | 국내 | 미구현 | - | `spec-only` | `fetchLedgerEntry` (통합) | [Tkb_SWQM2412_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQM2412_B2C) |  |
| 개인별쿠폰 조회 | `POST /api/v1/szqm6019` | 국내 | 미구현 | - | `spec-only` | `fetchCoupons` (확장) | [Tkb_SZQM6019_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SZQM6019_B2C) |  |
| 계좌별매매가정산현황 | `POST /api/v1/ssqm2121` | 국내 | 확장 | `fetchDomesticSettlements` | `real` | - | [Tkb_SSQM2121_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2121_B2C) | KB가 실제로 청구한 수수료, 거래세, 농특세. 매도와 매수를 따로 호출합니다. |
| 기간매매손익현황 | `POST /api/v1/ssqm2392` | 국내 | 미구현 | - | `spec-only` | `fetchRealizedPnlSummary` (확장) | [Tkb_SSQM2392_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2392_B2C) |  |
| 일자별실현손익상세 | `POST /api/v1/ssqm2442` | 국내 | 미구현 | - | `spec-only` | `fetchRealizedPnlDaily` (확장) | [Tkb_SSQM2442_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2442_B2C) |  |
| 종목별기간실현손익 | `POST /api/v1/ssqm2443` | 국내 | 미구현 | - | `spec-only` | `fetchRealizedPnlBySymbol` (확장) | [Tkb_SSQM2443_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2443_B2C) |  |
| 매매정산현황상세(원마켓플러스) | `POST /api/v1/skqo3390` | 미국 | 미구현 | - | `spec-only` | `fetchOneMarketSettlementDetail` (확장) | [Tkb_SKQO3390_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKQO3390_B2C) |  |
| 매매가 정산 현황 | `POST /api/v1/spqm2205` | 미국 | 확장 | `fetchOverseasSettlements` | `real` | - | [Tkb_SPQM2205_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2205_B2C) | USD 축 구간 조회 |
| 당일매매손익 | `POST /api/v1/spqm2206` | 미국 | 미구현 | - | `spec-only` | `fetchOverseasPnlToday` (확장) | [Tkb_SPQM2206_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2206_B2C) |  |
| 기간별매매손익 | `POST /api/v1/spqm2207` | 미국 | 미구현 | - | `spec-only` | `fetchOverseasPnlPeriod` (확장) | [Tkb_SPQM2207_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2207_B2C) |  |

### 트레이딩

| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 매수주문가능금액 조회 | `POST /api/v1/ssqm1802` | 국내 | 확장 | `fetchBuyableAmount` | `spec-only` | - | [Tkb_SSQM1802_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM1802_B2C) | 금액만 준다(수량 필드 없음) |
| 주문체결현황 | `POST /api/v1/ssqm0832` | 국내 | 미구현 | - | `spec-only` | - | [Tkb_SSQM0832_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0832_B2C) |  |
| 실시간 주식체결 미체결 | `POST /api/v1/ssqm0833` | 국내 | 미구현 | - | `spec-only` | `fetchOpenOrders` (통합) | [Tkb_SSQM0833_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0833_B2C) |  |
| 계좌별주문체결조회 | `POST /api/v1/ssqm2341` | 국내 | 통합 | `fetchMyTrades` | `real` | - | [Tkb_SSQM2341_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2341_B2C) | 체결구분 ccls_clsf 0(전체)로 이 TR 만으로 fetchOrders, fetchClosedOrders를 만들 수 있습니다. 지금은 1(체결)과 2(미체결)만 씁니다. 함께 노출: fetchOpenOrders. `fetchOpenOrders`는 `since`를 적용하지 않습니다. 미체결 행에 주문 시각이 없기 때문입니다. |
| 현금매도주문 | `POST /api/v1/ssam1801` | 국내 | 통합 | `createOrder` | `real` | - | [Tkb_SSAM1801_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM1801_B2C) | 공매도, 입고예정매도 구분(s_clsf)은 빈 값으로 고정합니다. 조건 주문 인자를 받으면 요청 전에 `NotSupported`를 던집니다. |
| 현금매수주문 | `POST /api/v1/ssam1802` | 국내 | 통합 | `createOrder` | `real` | - | [Tkb_SSAM1802_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM1802_B2C) | 주문구분 16종 중 지정가(00), 시장가(03) 2종만 노출합니다. 조건부지정가(05), 최유리(12), 최우선(13), FOK, IOC, 시간외종가(99), 중간가(M3), 스톱지정가(S0)와 시장시간 2~5, 9(시간외, 대량호가 계열)는 미노출입니다. 세션 게이트가 정규장 밖을 막습니다. 조건 주문 인자를 받으면 요청 전에 `NotSupported`를 던집니다. |
| 정정주문 | `POST /api/v1/ssam1805` | 국내 | 통합 | `editOrder` | `real` | - | [Tkb_SSAM1805_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM1805_B2C) | 일부정정과 전부정정을 모두 씁니다. `price`가 없으면 요청 전에 `ArgumentsRequired`를 던집니다. |
| 취소주문 | `POST /api/v1/ssam1806` | 국내 | 통합 | `cancelOrder` | `real` | - | [Tkb_SSAM1806_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM1806_B2C) | 전부취소만 씁니다. |
| 소수점 매매 주문가능금액 확인 | `POST /api/v1/ssqn5472` | 국내 | 미구현 | - | `spec-only` | `fetchFractionalBuyableAmount` (확장) | [Tkb_SSQN5472_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQN5472_B2C) |  |
| 소수점 매도 | `POST /api/v1/ssam5762` | 국내 | 통합 | `createOrder` | `real` | - | [Tkb_SSAM5762_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM5762_B2C) | 전량매도설정(tv_s_est_f)은 미노출 |
| 소수점 매수 | `POST /api/v1/ssam5763` | 국내 | 통합 | `createOrder` | `real` | - | [Tkb_SSAM5763_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM5763_B2C) | 체결 확정을 하지 않습니다. 시장가로만 나갑니다. |
| 소수점 주문 취소 | `POST /api/v1/ssam5764` | 국내 | 미구현 | - | `spec-only` | `cancelOrder` (통합) | [Tkb_SSAM5764_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM5764_B2C) |  |
| 온주/소수점 주문체결내역 조회 | `POST /api/v1/ssqm5475` | 국내 | 미구현 | - | `spec-only` | `fetchOrders` (통합) | [Tkb_SSQM5475_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM5475_B2C) |  |
| 소수점 매매 내역 조회 | `POST /api/v1/ssqm5765` | 국내 | 미구현 | - | `spec-only` | `fetchMyTrades` (통합) | [Tkb_SSQM5765_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM5765_B2C) |  |
| 예약주문처리 조회 | `POST /api/v1/ssqm0831` | 국내 | 미구현 | - | `spec-only` | `fetchReservedOrderResults` (확장) | [Tkb_SSQM0831_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0831_B2C) |  |
| 예약주문접수 조회 | `POST /api/v1/ssqm0834` | 국내 | 미구현 | - | `spec-only` | `fetchReservedOrders` (확장) | [Tkb_SSQM0834_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0834_B2C) |  |
| 예약주문접수(현금신용통합) | `POST /api/v1/ssam0831` | 국내 | 미구현 | - | `spec-only` | `createReservedOrder` (확장) | [Tkb_SSAM0831_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM0831_B2C) |  |
| 주문가능금액조회(원마켓플러스) | `POST /api/v1/skqm2106` | 미국 | 확장 | `fetchOverseasBuyableAmount` | `spec-only` | - | [Tkb_SKQM2106_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKQM2106_B2C) | 원마켓플러스 기준 원화환산 통합 주문가능금액 |
| 주문가능금액현황조회(원마켓플러스) | `POST /api/v1/skqm3350` | 미국 | 미구현 | - | `spec-only` | `fetchOneMarketBuyingPower` (확장) | [Tkb_SKQM3350_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKQM3350_B2C) |  |
| 원마켓 계좌증거금조회 | `POST /api/v1/spqm3390` | 미국 | 확장 | `fetchOneMarketMargin` | `real` | - | [Tkb_SPQM3390_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM3390_B2C) | 원마켓 미신청 계좌는 실패해 인스턴스에서 다시 부르지 않습니다. |
| 주문가능금액조회 | `POST /api/v1/spqm2106` | 미국 | 미구현 | - | `spec-only` | `fetchOverseasBuyableAmount` (확장) | [Tkb_SPQM2106_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2106_B2C) |  |
| 소수점 보유잔고내역조회 | `POST /api/v1/spqm5472` | 미국 | 미구현 | - | `spec-only` | `fetchFractionalHoldings` (확장) | [Tkb_SPQM5472_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM5472_B2C) |  |
| 소수점 주문가능금액조회 | `POST /api/v1/spqn5472` | 미국 | 미구현 | - | `spec-only` | `fetchFractionalBuyableAmount` (확장) | [Tkb_SPQN5472_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQN5472_B2C) |  |
| 소수점매도/매수주문 | `POST /api/v1/skam2201` | 미국 | 미구현 | - | `spec-only` | `createOrder` (통합) | [Tkb_SKAM2201_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKAM2201_B2C) |  |
| 소수점정정/취소주문 | `POST /api/v1/skam2202` | 미국 | 미구현 | - | `spec-only` | `editOrder` (통합) | [Tkb_SKAM2202_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKAM2202_B2C) |  |
| 소수점 주문접수내역조회 | `POST /api/v1/spqm5473` | 미국 | 미구현 | - | `spec-only` | `fetchFractionalOrders` (확장) | [Tkb_SPQM5473_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM5473_B2C) |  |
| 소수점 주문접수내역조회(주문용) | `POST /api/v1/spqn5473` | 미국 | 미구현 | - | `spec-only` | `fetchFractionalOrders` (확장) | [Tkb_SPQN5473_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQN5473_B2C) |  |
| 계좌예수금변동현황조회 | `POST /api/v1/spqm2220` | 미국 | 미구현 | - | `spec-only` | `fetchCurrencyDeposits` (확장) | [Tkb_SPQM2220_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2220_B2C) |  |
| 잔고평가조회 | `POST /api/v1/spqm2226` | 미국 | 통합 | `fetchBalance` | `real` | - | [Tkb_SPQM2226_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2226_B2C) | 응답 그리드가 둘입니다. 환율(std_exch_r)과 수수료율, 최소수수료(fee_r_p10, mn_fee_p4)는 미사용 |
| 계좌잔고 평가조회(통화별예수금) | `POST /api/v1/spqo2226` | 미국 | 미구현 | - | `spec-only` | `fetchBalance` (통합) | [Tkb_SPQO2226_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQO2226_B2C) |  |
| 계좌권리발생내역 | `POST /api/v1/srqm3051` | 국내 | 미구현 | - | `spec-only` | `fetchCorporateActions` (확장) | [Tkb_SRQM3051_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SRQM3051_B2C) |  |
| 매도/매수주문 | `POST /api/v1/skam2101` | 미국 | 통합 | `createOrder` | `real` | - | [Tkb_SKAM2101_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKAM2101_B2C) | 주문유형 14종 중 시장가(1), 지정가(2)만 노출합니다. MOO(5), MOC(6), LOO(9), LOC(A), STOP 시장가(B), STOP 지정가(C), IOC(D), VWAP, TWAP는 미노출입니다. 시장가 매수는 KB가 받지 않아 지정가로 바꿔 보냅니다. 조건 주문 인자를 받으면 요청 전에 `NotSupported`를 던집니다. |
| 정정/취소주문 | `POST /api/v1/skam2102` | 미국 | 통합 | `editOrder` | `real` | - | [Tkb_SKAM2102_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKAM2102_B2C) | 정정은 가격만 바꿉니다. 함께 노출: cancelOrder. `price`가 없으면 요청 전에 `ArgumentsRequired`를 던집니다. |
| 주식예약주문미국 | `POST /api/v1/spao2104` | 미국 | 미구현 | - | `spec-only` | `createReservedOrder` (확장) | [Tkb_SPAO2104_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPAO2104_B2C) |  |
| 예약주문취소미국 | `POST /api/v1/spao2106` | 미국 | 미구현 | - | `spec-only` | `cancelReservedOrder` (확장) | [Tkb_SPAO2106_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPAO2106_B2C) |  |
| 체결현황 | `POST /api/v1/spqm2204` | 미국 | 미구현 | - | `spec-only` | `fetchOrders` (통합) | [Tkb_SPQM2204_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2204_B2C) |  |
| 주문번호별주문내역 | `POST /api/v1/spqm1818` | 미국 | 미구현 | - | `spec-only` | `fetchOrder` (통합) | [Tkb_SPQM1818_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM1818_B2C) |  |
| 주문체결조회 | `POST /api/v1/spqm2103` | 미국 | 통합 | `fetchMyTrades` | `spec-only` | - | [Tkb_SPQM2103_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2103_B2C) | 체결구분 ccls_clsf의 값 체계가 국내와 다릅니다. 명세는 1 전체, 2 체결, 3 미체결입니다. 코드는 1(KBSEC_CCLS_FILLED)을 보내므로 명세대로면 전체 조회가 됩니다. 3을 보내 해외 fetchOpenOrders를 만들 수 있습니다. 실계좌 확인이 필요합니다. |

## 이 증권사에서만 쓰는 기능

ccxt의 통합 메서드로 표현하기 어려운 증권사 고유 기능입니다.

| 기능 | 지원 | 관련 API | 지원 범위 |
|---|---|---:|---|
| 원마켓(원마켓플러스) 통합증거금 | 부분 | 5개 | 주문 가능 금액(`SKQM2106`)과 계좌 증거금(`SPQM3390`)을 확장 메서드로 제공합니다. `krwIntegratedMargin` 옵션이 원화 환산 외화 예수금을 USD로 바꿔 `fetchBalance`에 더합니다. 통화별 총괄, 증거금 사용 현황, 정산 상세는 없습니다. |
| 국내 소수점 매매 | 부분 | 7개 | 매수와 매도만 `createOrder`의 `params.fractional`로 냅니다. 취소, 주문 가능 금액, 보유 잔고, 내역 조회는 없습니다. 낸 주문을 취소하거나 조회할 방법이 없습니다. |
| 해외 소수점 매매 | 미구현 | 6개 | 해외 소수점 주문은 `NotSupported`로 막습니다. |
| 국내 SOR 라우팅과 NXT | 부분 | 5개 | `nxtRouting` 옵션이나 `params.sor`로 K, N, S를 고릅니다. 세션 검사가 정규장(09:00부터 15:30까지) 밖을 막아 NXT 프리마켓과 애프터마켓 주문은 나가지 않습니다. 시세는 KRX로 고정합니다. |
| 주문 유형 | 부분 | 4개 | 국내 주문구분 16종 중 지정가와 시장가만 씁니다. 국내 시장시간 구분 6종 중 정규장만 씁니다. 해외 주문유형 14종 중 시장가와 지정가만 씁니다. 스톱지정가, 조건부지정가, 최유리, FOK, IOC, 중간가, 시간외, MOO, MOC, LOO, LOC, VWAP, TWAP는 TR이 받지만 노출하지 않습니다. `has.createConditionalOrder`는 `false`입니다. |
| 예약주문 | 미구현 | 5개 | 국내와 미국의 예약주문 접수, 취소, 조회를 모두 지원하지 않습니다. |
| 정산(실청구 수수료와 세금) | 지원 | 2개 | `fetchDomesticSettlements`와 `fetchOverseasSettlements`로 조회합니다. |
| 실현 손익과 평가 손익 | 미구현 | 6개 | 손익 조회 메서드가 없습니다. 정산 행에서 호출하는 쪽이 직접 계산해야 합니다. |
| 장운영상태와 공휴일 | 부분 | 2개 | 국내는 전영업일, 기준영업일, 익영업일 3개만 압니다. 미국 휴장일은 채우지 않습니다. |
| 종목 마스터와 기본정보 | 미구현 | 2개 | `market()`은 심볼 모양만 봅니다. 해외 종목 목록, 호가단위, 소수점 가능 여부, 매매제한을 API로 받을 수 있지만 쓰지 않습니다. |
| 수급, 순위, 시장 종합 | 미구현 | 17개 | 외국인, 기관, 프로그램 매매, 거래량과 등락률 순위, 신고가와 신저가, 시장 종합, 세계지수, 환율, 증시 자금 조회를 지원하지 않습니다. |
| 계좌 원장, 쿠폰, 권리 | 미구현 | 5개 | 계좌 원장, 거래내역 상세, 쿠폰, 권리 발생 내역 조회를 지원하지 않습니다. |
| 자산평가 | 미구현 | 6개 | 총잔고, 총 자산평가, 종합계좌, 실시간 자산평가, 예수금 상세 조회를 지원하지 않습니다. 익일과 익익일 출금 가능 금액 조회도 없습니다. |

## 알려진 한계

- 조건 주문을 지원하지 않습니다. `createOrder`에 조건 주문 인자를 전달하면 요청 전에 `NotSupported`를 던집니다. 인자는 `triggerPrice`, `stopPrice`, `stopLossPrice`, `takeProfitPrice`입니다.
- `editOrder`는 `price`가 없으면 요청 전에 `ArgumentsRequired`를 던집니다.
- 미체결 행에 주문 시각이 없어서 `fetchOpenOrders`는 `since`를 적용하지 않습니다. `since`를 전달해도 미체결 전체를 반환합니다.
- 국내 캔들은 코스피를 기본으로 조회합니다. 코스닥 종목은 `params.mkt_clsf = '1'`을 전달합니다.
- 해외 캔들은 지원하지 않습니다. 봉 시각의 기준이 명세에 없습니다.
- 정규장 밖 국내 주문과 NXT 시세를 지원하지 않습니다.
- 국내 소수점 주문은 취소와 조회 방법이 없습니다.
- 미국 주문 정정은 가격만 바꿉니다.
- 미국 주문 조회는 체결 내역만 반환합니다.
- 미국 휴장일은 채우지 않습니다.
- KB증권은 잘못된 조회의 과도한 반복을 계정 제한 사유로 듭니다.
- 영구 실패한 조회는 같은 인스턴스에서 다시 호출하지 않습니다.
- `SSQM0832`(주문체결현황)는 실계좌에서 `I446`(API 사용 권한 없음)이 나와 연결하지 않았습니다.
- 국내 호가단위는 가격대별이라 ccxt의 단일 `precision.price`로 표현하지 못합니다.

## 미구현 API

미구현 API는 68개입니다. 우선순위는 작은 수가 먼저입니다. 우선순위가 없는 API는 제안 유형(통합, params 확대, 확장, watch*) 순으로 정렬합니다. 제안 메서드 이름은 설계 후보이고 확정한 이름이 아닙니다.

### 우선순위 미정, 통합 제안: 17개

| API 이름 | 엔드포인트 | 시장 | 제안 메서드 | 제안 유형 | 명세 | 비고 |
|---|---|---|---|---|---|---|
| 공휴일관리 | `POST /api/v1/spam2508` | 국내, 미국 | `fetchMarketCalendar` | 통합 | [Tkb_SPAM2508_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPAM2508_B2C) | 국가별 공휴일, 영업일, 결제일. has.fetchMarketCalendar를 국가 인자로 넓히면 kbsec만 쓰는 배포에서도 미국 휴장일을 압니다. 공식 HEAD(5120174)에서 명세와 예제가 삭제되어 실계좌 호출로 존재를 확인해야 합니다. |
| 주식시간대별추이 | `POST /api/v1/ivu10080` | 국내 | `fetchTrades` | 통합 | [Tkb_IVU10080_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10080_B2C) | 체결시각, 체결가, 체결수량, 매도매수구분을 줍니다. ccxt Trade로 옮길 수 있습니다. 거래소구분(0 통합, 1 KRX, 2 NXT)과 정규장, 시간외 구분을 입력으로 받습니다. |
| 종목관리 | `POST /api/v1/siam4983` | 미국 | `fetchMarkets` | 통합 | [Tkb_SIAM4983_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SIAM4983_B2C) | 명세 필드가 ISO코드, SEDOL, 해외거래소, 통화, 호가단위, 매매단위, 소수점매매 여부, 매매제한입니다. 입력 없이 호출하면 전 종목이라고 공식 예제가 적습니다. 해외 종목 목록과 검색을 KB 자체로 만들 수 있습니다. 시장 구분은 필드 기준 추정(국내 종목 포함 여부 확인 불가) |
| 시간대별체결 | `POST /api/v1/gsa10020` | 미국 | `fetchTrades` | 통합 | [Tkb_GSA10020_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_GSA10020_B2C) | 해외 시간대별 체결. 국내 IVU10080과 같은 fetchTrades로 묶을 수 있습니다. |
| 차트 | `POST /api/v1/gsc10060` | 미국 | `fetchOHLCV` | 통합 | [Tkb_GSC10060_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_GSC10060_B2C) | 봉 시각이 한국 시각인지 현지 시각인지 명세에 없습니다. 실계좌 호출로 확인해야 합니다. 차트구분 틱, 분, 일, 주, 월, 년, 최대 5000건 |
| 계좌원장 거래내역 조회 (위탁, 금융상품, 저축) | `POST /api/v1/swqa2301` | 국내 | `fetchLedger` | 통합 | [Tkb_SWQA2301_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQA2301_B2C) | 위탁, 금융상품, 저축 계좌원장. ccxt에 fetchLedger가 있습니다. |
| 계좌원장 거래내역 조회 (CMA) | `POST /api/v1/swqb2301` | 국내 | `fetchLedger` | 통합 | [Tkb_SWQB2301_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQB2301_B2C) | CMA 계좌원장 |
| 거래내역상세 조회 | `POST /api/v1/swqm2412` | 국내 | `fetchLedgerEntry` | 통합 | [Tkb_SWQM2412_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQM2412_B2C) | 거래내역 상세 75필드 |
| 실시간 주식체결 미체결 | `POST /api/v1/ssqm0833` | 국내 | `fetchOpenOrders` | 통합 | [Tkb_SSQM0833_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0833_B2C) | 실시간 미체결. 권한과 SSQM2341 대비 이점은 확인 불가 |
| 소수점 주문 취소 | `POST /api/v1/ssam5764` | 국내 | `cancelOrder` | 통합 | [Tkb_SSAM5764_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM5764_B2C) | 소수점 주문을 취소하는 경로가 없습니다. 주문번호는 돌려주지만 취소, 조회 TR이 배선되지 않았습니다. |
| 온주/소수점 주문체결내역 조회 | `POST /api/v1/ssqm5475` | 국내 | `fetchOrders` | 통합 | [Tkb_SSQM5475_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM5475_B2C) | 온주와 소수점 주문체결내역 기간 조회. has.fetchOrders가 false 인 이유를 해소합니다. |
| 소수점 매매 내역 조회 | `POST /api/v1/ssqm5765` | 국내 | `fetchMyTrades` | 통합 | [Tkb_SSQM5765_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM5765_B2C) | 소수점 매매 내역 |
| 소수점매도/매수주문 | `POST /api/v1/skam2201` | 미국 | `createOrder` | 통합 | [Tkb_SKAM2201_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKAM2201_B2C) | 금액 기준 주문(amt_q_clsf)과 쿠폰을 지원합니다. 지금은 해외 소수점을 NotSupported로 막습니다. |
| 소수점정정/취소주문 | `POST /api/v1/skam2202` | 미국 | `editOrder` | 통합 | [Tkb_SKAM2202_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKAM2202_B2C) | 해외 소수점 정정, 취소. 취소는 cancelOrder(params.fractional) |
| 계좌잔고 평가조회(통화별예수금) | `POST /api/v1/spqo2226` | 미국 | `fetchBalance` | 통합 | [Tkb_SPQO2226_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQO2226_B2C) | SPQM2226 첫 그리드와 겹치는지 확인 불가 |
| 체결현황 | `POST /api/v1/spqm2204` | 미국 | `fetchOrders` | 통합 | [Tkb_SPQM2204_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2204_B2C) | 체결구분 0 전체, 1 체결, 2 미체결. 기간(strt~end) 조회 |
| 주문번호별주문내역 | `POST /api/v1/spqm1818` | 미국 | `fetchOrder` | 통합 | [Tkb_SPQM1818_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM1818_B2C) | 주문번호별 주문내역. 해외 fetchOrder가 미체결 주문을 못 찾는 한계를 메울 수 있습니다. |

### 우선순위 미정, 확장 제안

<details>
<summary>50개 보기</summary>

| API 이름 | 엔드포인트 | 시장 | 제안 메서드 | 제안 유형 | 명세 | 비고 |
|---|---|---|---|---|---|---|
| 종목기본정보 | `POST /api/v1/siqm4900` | 국내 | `fetchSecurityInfo` | 확장 | [Tkb_SIQM4900_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SIQM4900_B2C) | 종목명, 종목유형, 매매제한, 위험등급을 줍니다. market()이 심볼 모양만 보는 한계를 이 TR로 메울 수 있습니다. 시장 구분은 추정(해외 종목 포함 여부 확인 불가) |
| 종목기업개요 | `POST /api/v1/ivm10050` | 국내 | `fetchCompanyProfile` | 확장 | [Tkb_IVM10050_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVM10050_B2C) | 자본금, 상장주식수, 시가총액, 신용잔고, 배당수익률 |
| 종목별투자자 | `POST /api/v1/ivu10430` | 국내 | `fetchInvestorTrend` | 확장 | [Tkb_IVU10430_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10430_B2C) | 종목별 투자자(개인, 외국인, 기관 등) 일별 매매 |
| 당일주요외국계거래원 | `POST /api/v1/ivu10420` | 국내 | `fetchForeignBrokerTrend` | 확장 | [Tkb_IVU10420_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10420_B2C) | 당일 주요 외국계 거래원의 매도, 매수 상위 |
| 종목별프로그램매매추이 | `POST /api/v1/ivu10450` | 국내 | `fetchProgramTradingTrend` | 확장 | [Tkb_IVU10450_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10450_B2C) | 종목별 프로그램 매매 추이(시간별, 일별) |
| 외국인기관매매상위 | `POST /api/v1/ivu10020` | 국내 | `fetchInvestorRanking` | 확장 | [Tkb_IVU10020_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10020_B2C) | 외국인, 기관 매매상위. 투자자구분 14종과 기간 7종 선택 |
| 테마그룹조회 | `POST /api/v1/ivs11430` | 국내 | `fetchThemeGroups` | 확장 | [Tkb_IVS11430_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVS11430_B2C) | 공식 저장소 HEAD(5120174)에서 명세와 예제가 삭제되었습니다. 살아 있는지 확인 불가 |
| 프로그램매매상위 | `POST /api/v1/ivs10920` | 국내 | `fetchProgramTradingRanking` | 확장 | [Tkb_IVS10920_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVS10920_B2C) |  |
| 거래량상위 | `POST /api/v1/ivu10280` | 국내 | `fetchVolumeRanking` | 확장 | [Tkb_IVU10280_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10280_B2C) |  |
| 급등/급락 상위 | `POST /api/v1/ivu10270` | 국내 | `fetchSurgePlungeRanking` | 확장 | [Tkb_IVU10270_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10270_B2C) |  |
| 거래대금상위 | `POST /api/v1/ivu10210` | 국내 | `fetchTradingValueRanking` | 확장 | [Tkb_IVU10210_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10210_B2C) |  |
| 등락률상위 | `POST /api/v1/ivu10240` | 국내 | `fetchChangeRateRanking` | 확장 | [Tkb_IVU10240_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10240_B2C) |  |
| 시가대비등락률상위 | `POST /api/v1/ivs10910` | 국내 | `fetchOpenChangeRateRanking` | 확장 | [Tkb_IVS10910_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVS10910_B2C) |  |
| 기간외등락률순위 | `POST /api/v1/ivs11190` | 국내 | `fetchExtendedHoursRanking` | 확장 | [Tkb_IVS11190_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVS11190_B2C) | 시간외 등락률 순위 |
| 신고/신저 | `POST /api/v1/ivu10550` | 국내 | `fetchNewHighLow` | 확장 | [Tkb_IVU10550_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVU10550_B2C) | 신고가, 신저가 |
| 업종랭킹 | `POST /api/v1/ivm30010` | 국내 | `fetchSectorRanking` | 확장 | [Tkb_IVM30010_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVM30010_B2C) |  |
| 시장종합 | `POST /api/v1/ivsa0070` | 국내 | `fetchMarketSummary` | 확장 | [Tkb_IVSA0070_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVSA0070_B2C) | 코스피, 코스닥 상승, 하락, 상하한가 종목 수 등 |
| 세계지수 | `POST /api/v1/iva60140` | 국내, 미국 | `fetchWorldIndices` | 확장 | [Tkb_IVA60140_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVA60140_B2C) |  |
| 환율종합 | `POST /api/v1/iva60190` | 국내, 미국 | `fetchExchangeRates` | 확장 | [Tkb_IVA60190_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVA60190_B2C) | 환율 종가. usdKrwRate 옵션의 기본 공급원 후보이나 실시간인지 종가 기준인지는 확인 불가 |
| 증시주변자금동향 | `POST /api/v1/iva10370` | 국내 | `fetchMarketFundFlow` | 확장 | [Tkb_IVA10370_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_IVA10370_B2C) | 고객예탁금, 미수금, 신용잔고 등 증시주변자금 |
| 글로벌원마켓 증거금사용현황 | `POST /api/v1/spqn3390` | 미국 | `fetchOneMarketMarginUsage` | 확장 | [Tkb_SPQN3390_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQN3390_B2C) | 글로벌원마켓 증거금 사용 현황(결제일별) |
| 예수금조회 | `POST /api/v1/swqm2302` | 국내 | `fetchDepositDetails` | 확장 | [Tkb_SWQM2302_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQM2302_B2C) | 증거금, 대용, 미결제 매도대금 등 예수금 상세 97필드 |
| 익일익익일 출금가능금액 조회 | `POST /api/v1/swqn2302` | 국내 | `fetchWithdrawableAmount` | 확장 | [Tkb_SWQN2302_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SWQN2302_B2C) | 익일, 익익일 출금가능금액 |
| 총 잔고 조회 | `POST /api/v1/ssqm0005` | 국내 | `fetchAccountSummary` | 확장 | [Tkb_SSQM0005_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0005_B2C) | 상품군별 평가액, 예수금, 출금가능금액 합계 |
| 평가손익 조회 | `POST /api/v1/ssqm0006` | 국내 | `fetchUnrealizedPnl` | 확장 | [Tkb_SSQM0006_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0006_B2C) | 종목별 평가손익, 평균단가, 현재가 |
| 총 자산평가 내역 조회 | `POST /api/v1/ssqm0009` | 국내 | `fetchTotalAssetValuation` | 확장 | [Tkb_SSQM0009_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0009_B2C) | 총 자산평가. 고객등급, 투자성향 필드를 함께 줍니다. |
| 종합계좌 잔고현황 조회 (종합위탁계좌, 신연금저축계좌) | `POST /api/v1/ssqm2932` | 국내 | `fetchIntegratedBalance` | 확장 | [Tkb_SSQM2932_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2932_B2C) | 종합위탁, 신연금저축 계좌 잔고. 미수, 대용, 신용, 담보부족 금액 |
| 주식자산평가조회 (실시간) | `POST /api/v1/ssqn2952` | 국내 | `fetchRealtimeAssetValuation` | 확장 | [Tkb_SSQN2952_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQN2952_B2C) | 실시간 주식자산평가. SSQM2952 와의 차이는 확인 불가 |
| 국내주식 소수점 매매 보유잔고내역 조회 | `POST /api/v1/ssqm5472` | 국내 | `fetchFractionalHoldings` | 확장 | [Tkb_SSQM5472_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM5472_B2C) | 국내 소수점 보유잔고 |
| 개인별쿠폰 조회 | `POST /api/v1/szqm6019` | 국내 | `fetchCoupons` | 확장 | [Tkb_SZQM6019_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SZQM6019_B2C) | 개인별 쿠폰(수수료 혜택 등) 조회 |
| 기간매매손익현황 | `POST /api/v1/ssqm2392` | 국내 | `fetchRealizedPnlSummary` | 확장 | [Tkb_SSQM2392_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2392_B2C) | 기간 매매손익 현황 |
| 일자별실현손익상세 | `POST /api/v1/ssqm2442` | 국내 | `fetchRealizedPnlDaily` | 확장 | [Tkb_SSQM2442_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2442_B2C) | 일자별 실현손익 상세 |
| 종목별기간실현손익 | `POST /api/v1/ssqm2443` | 국내 | `fetchRealizedPnlBySymbol` | 확장 | [Tkb_SSQM2443_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM2443_B2C) | 종목별 기간 실현손익 |
| 매매정산현황상세(원마켓플러스) | `POST /api/v1/skqo3390` | 미국 | `fetchOneMarketSettlementDetail` | 확장 | [Tkb_SKQO3390_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKQO3390_B2C) | 원마켓플러스 매매정산현황 상세 |
| 당일매매손익 | `POST /api/v1/spqm2206` | 미국 | `fetchOverseasPnlToday` | 확장 | [Tkb_SPQM2206_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2206_B2C) | 당일 매매손익 |
| 기간별매매손익 | `POST /api/v1/spqm2207` | 미국 | `fetchOverseasPnlPeriod` | 확장 | [Tkb_SPQM2207_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2207_B2C) | 기간별 매매손익 |
| 소수점 매매 주문가능금액 확인 | `POST /api/v1/ssqn5472` | 국내 | `fetchFractionalBuyableAmount` | 확장 | [Tkb_SSQN5472_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQN5472_B2C) | 소수점 매수 가능금액, 예상수수료, 예상주식수 |
| 예약주문처리 조회 | `POST /api/v1/ssqm0831` | 국내 | `fetchReservedOrderResults` | 확장 | [Tkb_SSQM0831_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0831_B2C) | 예약주문 처리 결과 조회 |
| 예약주문접수 조회 | `POST /api/v1/ssqm0834` | 국내 | `fetchReservedOrders` | 확장 | [Tkb_SSQM0834_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0834_B2C) | 예약주문 접수 목록 |
| 예약주문접수(현금신용통합) | `POST /api/v1/ssam0831` | 국내 | `createReservedOrder` | 확장 | [Tkb_SSAM0831_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSAM0831_B2C) | 예약주문 접수(현금, 신용 통합). 미국은 SPAO2104가 같은 이름으로 대응 |
| 주문가능금액현황조회(원마켓플러스) | `POST /api/v1/skqm3350` | 미국 | `fetchOneMarketBuyingPower` | 확장 | [Tkb_SKQM3350_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SKQM3350_B2C) | 통화별 총괄. 종목별 조회(SKQM2106)로 충분해 보류한 항목이다(상수 주석) |
| 주문가능금액조회 | `POST /api/v1/spqm2106` | 미국 | `fetchOverseasBuyableAmount` | 확장 | [Tkb_SPQM2106_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2106_B2C) | 원화, 외화 주문가능금액과 수량. 원마켓이 아닌 계좌의 출처 후보이며 실계좌 확인이 필요합니다. |
| 소수점 보유잔고내역조회 | `POST /api/v1/spqm5472` | 미국 | `fetchFractionalHoldings` | 확장 | [Tkb_SPQM5472_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM5472_B2C) | 국내 SSQM5472와 같은 이름으로 묶습니다. |
| 소수점 주문가능금액조회 | `POST /api/v1/spqn5472` | 미국 | `fetchFractionalBuyableAmount` | 확장 | [Tkb_SPQN5472_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQN5472_B2C) | 국내 SSQN5472와 같은 이름으로 묶습니다. |
| 소수점 주문접수내역조회 | `POST /api/v1/spqm5473` | 미국 | `fetchFractionalOrders` | 확장 | [Tkb_SPQM5473_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM5473_B2C) | 소수점 주문접수내역 |
| 소수점 주문접수내역조회(주문용) | `POST /api/v1/spqn5473` | 미국 | `fetchFractionalOrders` | 확장 | [Tkb_SPQN5473_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQN5473_B2C) | 주문 화면용 조회. SPQM5473 과의 차이는 확인 불가 |
| 계좌예수금변동현황조회 | `POST /api/v1/spqm2220` | 미국 | `fetchCurrencyDeposits` | 확장 | [Tkb_SPQM2220_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPQM2220_B2C) | 통화별 예수금 변동 현황 |
| 계좌권리발생내역 | `POST /api/v1/srqm3051` | 국내 | `fetchCorporateActions` | 확장 | [Tkb_SRQM3051_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SRQM3051_B2C) | 계좌 권리(배정) 발생 내역. 시장은 필드 이름으로 국내로 추정했고 확인 불가. 시장 구분은 필드 이름으로 추정 |
| 주식예약주문미국 | `POST /api/v1/spao2104` | 미국 | `createReservedOrder` | 확장 | [Tkb_SPAO2104_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPAO2104_B2C) | 미국 주식 예약주문 |
| 예약주문취소미국 | `POST /api/v1/spao2106` | 미국 | `cancelReservedOrder` | 확장 | [Tkb_SPAO2106_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SPAO2106_B2C) | 미국 예약주문 취소 |

</details>

### 우선순위 미정, 제안 없음: 1개

| API 이름 | 엔드포인트 | 시장 | 제안 메서드 | 제안 유형 | 명세 | 비고 |
|---|---|---|---|---|---|---|
| 주문체결현황 | `POST /api/v1/ssqm0832` | 국내 | - | - | [Tkb_SSQM0832_B2C](https://github.com/kbsecurities/kb-openapi/blob/159480c/frontend/src/app/openapi-test/samples.generated.json#Tkb_SSQM0832_B2C) | 권한이 생기기 전에는 배선하지 않습니다. 반복 실패가 계정 제한 사유입니다 [제안 없음: SSQM2341로 대체]. 실계좌에서 I446(API 사용 권한 없음) 실측 |
