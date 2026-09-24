/**
 * @fileoverview `spec/*.json` 이 실제 `describe().api`(런타임에 요청을 만드는 표)와 같은지 양쪽으로 대조한다.
 * 어긋나면 스펙 표가 거짓말을 하는 것이다. 사람도, Python 판의 `abstract/*.py` 도 이 표를 믿는다.
 * `describe().api` 에 엔드포인트를 더하면 이 테스트가 실패하며 `spec/*.json` 에 넣을 줄을 알려 준다.
 */
import { describe, expect, it } from 'vitest';

import type { Dict } from '../../base/types';
import { kis } from '../../kis';
import { kbsec } from '../../kbsec';
import { toss } from '../../toss';
import { deriveApiTree, implicitMethodNames } from '../spec-validate';
import type { BrokerSpec } from '../spec-types';
import kisSpec from '../kis.json';
import kbsecSpec from '../kbsec.json';
import tossSpec from '../toss.json';

const HTTP_METHOD_KEY = /^(?:get|post|put|delete|head|patch)$/i;

/** `api` 트리를 `이름 → 스펙 모양 한 줄` 로 편다. 잎이 숫자면 `{ cost }` 로 읽는다(`defineRestApi` 와 같다). */
function flattenApi(api: Dict, paths: string[] = [], out: Dict = {}): Dict {
    for (const [key, value] of Object.entries(api)) {
        if (!HTTP_METHOD_KEY.test(key)) {
            flattenApi(value as Dict, paths.concat([key]), out);
            continue;
        }
        for (const [path, raw] of Object.entries(value as Dict)) {
            const config = (typeof raw === 'number' ? { cost: raw } : raw) as Dict;
            const ep: Dict = { api: paths, method: key.toUpperCase(), path, cost: config.cost ?? 1 };
            for (const extra of ['bucket', 'order', 'peak']) if (config[extra] !== undefined) ep[extra] = config[extra];
            out[implicitMethodNames(ep as { api: string[]; method: 'GET'; path: string }).camel] = ep;
        }
    }
    return out;
}

function structural(spec: BrokerSpec): Dict {
    return flattenApi(deriveApiTree(spec));
}

describe.each([
    ['toss', tossSpec, () => new toss().api],
    ['kis', kisSpec, () => new kis().api],
    ['kbsec', kbsecSpec, () => new kbsec().api],
])('%s: spec/*.json ↔ describe().api', (_id, spec, liveApi) => {
    const live = flattenApi(liveApi() as Dict);
    const fromSpec = structural(spec as BrokerSpec);

    it('describe().api 의 엔드포인트가 모두 스펙에 있다', () => {
        const missing = Object.keys(live).filter((name) => !(name in fromSpec)).map((name) => `"${name}": ${JSON.stringify(live[name])}`);
        expect(missing, 'spec/*.json 에 이 줄을 넣는다').toEqual([]);
    });

    it('스펙의 엔드포인트가 모두 describe().api 에 있다', () => {
        expect(Object.keys(fromSpec).filter((name) => !(name in live))).toEqual([]);
    });

    it('경로·HTTP 메서드·비용·버킷·주문 여부가 같다', () => {
        for (const name of Object.keys(live)) if (name in fromSpec) expect(fromSpec[name], name).toEqual(live[name]);
    });
});

describe('implicitMethodNames', () => {
    it('ccxt 규칙대로 camelCase 와 snake_case 이름을 만든다', () => {
        expect(implicitMethodNames({ api: ['private', 'market'], method: 'GET', path: 'exchange-rate' }))
            .toEqual({ camel: 'privateMarketGetExchangeRate', snake: 'private_market_get_exchange_rate' });
        expect(implicitMethodNames({ api: ['public'], method: 'POST', path: 'oauth2/tokenP' }))
            .toEqual({ camel: 'publicPostOauth2TokenP', snake: 'public_post_oauth2_tokenp' });
        expect(implicitMethodNames({ api: ['private'], method: 'POST', path: 'ivu10020' }))
            .toEqual({ camel: 'privatePostIvu10020', snake: 'private_post_ivu10020' });
    });

    it('이름은 실제 인스턴스의 암묵 메서드와 같다', () => {
        const ex = new kis();
        const name = implicitMethodNames({ api: ['private'], method: 'GET', path: 'uapi/domestic-stock/v1/quotations/inquire-price' }).camel;
        expect(typeof ex[name]).toBe('function');
    });
});
