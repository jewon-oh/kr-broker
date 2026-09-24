/**
 * @fileoverview KIS 종목 마스터 **데이터의 모양**. `kis`·`kbsec` 인스턴스가 `options.masterData` 로 받는다.
 *
 * 종목 검색과 해외 주문의 거래소 코드 판별에는 KIS 공식 마스터 파일(kospi/kosdaq, 나스닥/뉴욕/아멕스)이 필요하다. 그 파일은 재배포 조건이
 * 명시돼 있지 않아 라이브러리에 싣지 않는다. 사용하는 쪽이 KIS 가 공개하는 마스터 파일을 내려받아 이 모양으로 넘긴다.
 *
 * 이 파일은 타입만 정의하고 어떤 데이터도 import 하지 않는다.
 */

import type { KRXStock } from './kis-stock-master';
import type { OverseasStock } from './kis-overseas-master';

export interface KisMasterData {
    /** KOSPI 상장 종목 */
    kospi: readonly KRXStock[];
    /** KOSDAQ 상장 종목 */
    kosdaq: readonly KRXStock[];
    /** 나스닥 종목 */
    nasdaq: readonly OverseasStock[];
    /** 뉴욕증권거래소 종목 */
    nyse: readonly OverseasStock[];
    /** 아멕스 종목 */
    amex: readonly OverseasStock[];
}

/** 데이터가 없는 상태. `options.masterData` 를 넘기지 않았을 때의 기본값이다. 검색은 빈 결과, 조회는 미등록이다. */
export const EMPTY_KIS_MASTER_DATA: KisMasterData = {
    kospi: [], kosdaq: [], nasdaq: [], nyse: [], amex: [],
};

/** 인스턴스 옵션에서 마스터 데이터를 꺼낸다. 넘기지 않았으면 빈 데이터다. */
export function masterDataOf(options: { masterData?: KisMasterData | undefined }): KisMasterData {
    return options.masterData ?? EMPTY_KIS_MASTER_DATA;
}
