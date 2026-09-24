/**
 * @fileoverview 증권사 API 엔드포인트 표(`spec/*.json`)의 타입. `describe().api`(요청을 보내는 런타임 등록)와
 * `docs/coverage/*.json`(사람이 읽는 지원 현황)이 각자 따로 관리되던 것을, 파라미터·응답 필드까지 담는 한 표로
 * 옮기는 것이 목표다(Python 포팅 방침 0단계).
 *
 * 필드 이름은 TS 쪽 관례(camelCase) 대신 **snake_case**를 쓴다. 이 JSON은 나중에 Python 쪽도 그대로
 * 읽어야 하는데, Python 스파이크로 실제 읽어 보니(9/23) `schemaVersion`·`trId`가 Python 관례와
 * 안 맞아 매번 변환이 필요했다. TS 코드에서 `ep.tr_id`처럼 쓰는 게 이 파일 하나 안에서는 어색해도,
 * 두 언어가 공유하는 자료는 어느 한쪽 관례를 절대 기준으로 삼지 않는 편이 낫다.
 */

export type SpecHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type SpecFieldType = 'string' | 'number' | 'boolean' | 'string|null' | 'number|null';

export interface SpecParam {
    name: string;
    required: boolean;
    type: SpecFieldType;
    description: string;
}

export interface SpecResponseField {
    field: string;
    type: SpecFieldType;
    description: string;
}

/** TR 코드가 실전과 모의에서 다른 증권사(KIS 주문류)만 쓴다. 조회성 TR처럼 같으면 문자열 하나로 적는다. */
export interface SpecTrId {
    real: string;
    demo: string;
}

export interface EndpointSpec {
    /** `describe().api` 트리에서 이 엔드포인트가 속하는 이름 경로(예: `['private','market']`, `['private']`). */
    api: string[];
    method: SpecHttpMethod;
    /** `urls.api[api[0]]` 뒤에 붙는 경로. KB 는 TR 코드 소문자(`ivu10020`)를 그대로 쓴다. */
    path: string;
    cost: number;
    bucket?: string;
    /** 주문처럼 재시도하면 안 되는 요청이면 true. */
    order?: boolean;
    /** 개장 직후 한도가 줄어드는 그룹이면 true. */
    peak?: boolean;
    /** KIS·KB 처럼 TR 코드로 엔드포인트를 구분하는 증권사만 쓴다. */
    tr_id?: string | SpecTrId;
    /** 요청 파라미터. 공식 명세와 대조한 엔드포인트에만 적는다. */
    params?: SpecParam[];
    /** 응답 필드. 공식 명세와 대조한 엔드포인트에만 적는다. */
    response?: SpecResponseField[];
    /** `params`·`response` 의 근거(소스 파일 경로·줄 번호, 또는 공식 문서 링크). */
    evidence?: string;
}

export interface BrokerSpec {
    schema_version: 1;
    broker: 'toss' | 'kis' | 'kbsec';
    /** 키는 ccxt 식 암묵 메서드 이름(`privateGetUapiDomesticStockV1QuotationsInquirePrice`)이다. `implicitMethodNames()` 가 만든다. */
    endpoints: Record<string, EndpointSpec>;
}
