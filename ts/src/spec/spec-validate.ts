/**
 * @fileoverview `BrokerSpec` 구조 검증과 `describe().api` 파생. 외부 검증 라이브러리 없이 손으로 확인한다
 * (이 패키지는 의존성을 `ws` 하나로 유지한다).
 */
import type { Dict } from '../base/types';
import { implicitMethodName } from '../base/Exchange';
import type { BrokerSpec, EndpointSpec, SpecHttpMethod } from './spec-types';

const HTTP_METHODS: readonly SpecHttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE'];

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

const PATH_DELIMITER = /[^a-zA-Z0-9]/;

/**
 * 엔드포인트의 암묵 메서드 이름. `camel` 은 `Exchange.defineRestApiEndpoint` 가 붙이는 이름(`implicitMethodName`)이고, `snake` 는 ccxt Python 의
 * `define_rest_api_endpoint` 규칙대로 같은 조각을 소문자로 `_` 로 잇는다(Python 판이 쓴다).
 */
export function implicitMethodNames(ep: Pick<EndpointSpec, 'api' | 'method' | 'path'>): { camel: string; snake: string } {
    const method = ep.method.toLowerCase();
    const apiParts = [ep.api[0]].concat(ep.api.slice(1).flatMap((name) => name.split(PATH_DELIMITER)));
    const pathParts = ep.path.split(PATH_DELIMITER).filter((p) => p.length > 0).map((p) => p.toLowerCase());
    const snake = [...apiParts, method, ...pathParts].join('_');
    return { camel: implicitMethodName(ep.api, ep.method, ep.path), snake };
}

/** 구조가 어긋나면 던진다. 통과하면 아무것도 반환하지 않는다. */
export function validateBrokerSpec(spec: BrokerSpec): void {
    if (spec.schema_version !== 1) throw new Error(`spec.schema_version 은 1 이어야 한다: ${String(spec.schema_version)}`);
    if (!isNonEmptyString(spec.broker)) throw new Error('spec.broker 가 없다');
    const snakes = new Set<string>();
    for (const [key, ep] of Object.entries(spec.endpoints)) {
        const where = `${spec.broker}.${key}`;
        validateEndpoint(where, ep);
        const { camel, snake } = implicitMethodNames(ep);
        if (key !== camel) throw new Error(`${where}: 키는 암묵 메서드 이름(${camel})이어야 한다`);
        if (snakes.has(snake)) throw new Error(`${where}: snake_case 이름이 겹친다: ${snake}`);
        snakes.add(snake);
    }
}

function validateEndpoint(where: string, ep: EndpointSpec): void {
    if (!Array.isArray(ep.api) || ep.api.length === 0) throw new Error(`${where}: api 배열이 비었다`);
    if (!HTTP_METHODS.includes(ep.method)) throw new Error(`${where}: method 값이 잘못됐다: ${String(ep.method)}`);
    if (!isNonEmptyString(ep.path)) throw new Error(`${where}: path 가 없다`);
    if (typeof ep.cost !== 'number' || ep.cost <= 0) throw new Error(`${where}: cost 는 양수여야 한다`);
    if (ep.params !== undefined) {
        if (!Array.isArray(ep.params)) throw new Error(`${where}: params 가 배열이 아니다`);
        for (const p of ep.params) {
            if (!isNonEmptyString(p.name)) throw new Error(`${where}: params 항목에 name 이 없다`);
            if (typeof p.required !== 'boolean') throw new Error(`${where}: params.${p.name}.required 가 boolean 이 아니다`);
            if (!isNonEmptyString(p.description)) throw new Error(`${where}: params.${p.name}.description 이 없다`);
        }
    }
    if (ep.response !== undefined) {
        if (!Array.isArray(ep.response)) throw new Error(`${where}: response 가 배열이 아니다`);
        for (const r of ep.response) {
            if (!isNonEmptyString(r.field)) throw new Error(`${where}: response 항목에 field 가 없다`);
        }
    }
    const documented = ep.params !== undefined || ep.response !== undefined;
    if (documented && !isNonEmptyString(ep.evidence)) throw new Error(`${where}: params·response 를 적었으면 evidence 가 있어야 한다`);
}

/**
 * `spec.endpoints` 를 `defineRestApi()` 가 기대하는 `{ apiName: { httpMethod: { path: config } } }` 모양으로 접는다.
 * 증권사 클래스의 `describe().api` 는 생성기(`scripts/gen-ts-abstract.mjs`)가 같은 규칙으로 만든 상수(`abstract/<id>.ts`)이고, 테스트가 둘을 대조한다.
 */
export function deriveApiTree(spec: BrokerSpec): Dict {
    const tree: Dict = {};
    for (const ep of Object.values(spec.endpoints)) {
        let node = tree;
        for (const part of ep.api) {
            node[part] = (node[part] as Dict | undefined) ?? {};
            node = node[part] as Dict;
        }
        const methodKey = ep.method.toLowerCase();
        node[methodKey] = (node[methodKey] as Dict | undefined) ?? {};
        const config: Dict = { cost: ep.cost };
        if (ep.bucket !== undefined) config.bucket = ep.bucket;
        if (ep.order !== undefined) config.order = ep.order;
        if (ep.peak !== undefined) config.peak = ep.peak;
        (node[methodKey] as Dict)[ep.path] = config;
    }
    return tree;
}
