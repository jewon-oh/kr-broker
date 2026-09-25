/**
 * @fileoverview 증권사 API 엔드포인트 표(`spec/*.json`)의 타입. 경로·HTTP 메서드·비용·버킷에 더해 파라미터·응답 필드까지 담는다.
 *
 * 필드 이름은 TS 쪽 관례(camelCase) 대신 **snake_case**를 쓴다. TypeScript 판과 Python 판이 함께 읽는 자료라 어느 한쪽 관례를 기준으로 삼지 않는다.
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
    /** `params`·`response` 의 근거(소스 파일 경로와 메서드 이름, 또는 공식 문서 링크). 줄 번호는 코드가 바뀌면 어긋나므로 적지 않는다. */
    evidence?: string;
}

export interface BrokerSpec {
    schema_version: 1;
    broker: 'toss' | 'kis' | 'kbsec';
    /** 키는 ccxt 식 암묵 메서드 이름(`privateGetUapiDomesticStockV1QuotationsInquirePrice`)이다. `implicitMethodNames()` 가 만든다. */
    endpoints: Record<string, EndpointSpec>;
}
