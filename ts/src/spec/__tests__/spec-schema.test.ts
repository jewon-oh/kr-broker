/**
 * @fileoverview `spec/*.json` 구조 검증(린트). 외부 스키마 라이브러리 없이 `validateBrokerSpec` 으로 돈다.
 */
import { describe, expect, it } from 'vitest';

import { validateBrokerSpec } from '../spec-validate';
import type { BrokerSpec } from '../spec-types';
import kisSpec from '../kis.json';
import kbsecSpec from '../kbsec.json';
import tossSpec from '../toss.json';

describe('spec/*.json 구조 검증', () => {
    it.each([
        ['toss', tossSpec],
        ['kis', kisSpec],
        ['kbsec', kbsecSpec],
    ])('%s', (_name, spec) => {
        expect(() => validateBrokerSpec(spec as BrokerSpec)).not.toThrow();
    });

    it('schema_version 이 아니면 던진다', () => {
        const bad = { ...tossSpec, schema_version: 2 } as unknown as BrokerSpec;
        expect(() => validateBrokerSpec(bad)).toThrow(/schema_version/);
    });

    it('키가 암묵 메서드 이름이 아니면 던진다', () => {
        const bad = JSON.parse(JSON.stringify(tossSpec)) as BrokerSpec;
        bad.endpoints.exchangeRate = bad.endpoints.privateMarketGetExchangeRate;
        delete bad.endpoints.privateMarketGetExchangeRate;
        expect(() => validateBrokerSpec(bad)).toThrow(/암묵 메서드 이름/);
    });

    it('params 를 적었는데 evidence 가 없으면 던진다', () => {
        const bad = JSON.parse(JSON.stringify(tossSpec)) as BrokerSpec;
        delete bad.endpoints.privateMarketGetExchangeRate.evidence;
        expect(() => validateBrokerSpec(bad)).toThrow(/evidence/);
    });

    it('params 항목에 name 이 없으면 던진다', () => {
        const bad = JSON.parse(JSON.stringify(tossSpec)) as BrokerSpec;
        // @ts-expect-error — 의도적으로 잘못된 값을 넣어 검증기가 잡는지 본다.
        delete bad.endpoints.privateMarketGetExchangeRate.params![0].name;
        expect(() => validateBrokerSpec(bad)).toThrow(/params/);
    });
});
