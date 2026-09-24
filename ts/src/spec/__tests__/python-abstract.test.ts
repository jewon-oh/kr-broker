/**
 * @fileoverview Python 판의 암묵 API 선언(`python/<패키지>/abstract/*.py`)이 엔드포인트 표와 같은지 본다.
 * 생성기(`scripts/gen-python-abstract.mjs`)의 이름 규칙이 TypeScript 판의 `implicitMethodNames` 와 같은지도 대조한다.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { implicitMethodNames } from '../spec-validate';
import type { BrokerSpec, EndpointSpec } from '../spec-types';
import kisSpec from '../kis.json';
import kbsecSpec from '../kbsec.json';
import tossSpec from '../toss.json';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const GENERATOR = path.join(ROOT, 'scripts/gen-python-abstract.mjs');

interface Generator {
    implicitMethodNames(ep: EndpointSpec): { camel: string; snake: string };
    renderAbstract(spec: BrokerSpec, packageName: string): string;
}

const generator = (await import(pathToFileURL(GENERATOR).href)) as Generator;

describe('scripts/gen-python-abstract.mjs', () => {
    it.each([
        ['toss', tossSpec],
        ['kis', kisSpec],
        ['kbsec', kbsecSpec],
    ])('%s: 생성기의 이름 규칙이 TypeScript 판과 같다', (_id, spec) => {
        for (const ep of Object.values((spec as BrokerSpec).endpoints)) {
            expect(generator.implicitMethodNames(ep)).toEqual(implicitMethodNames(ep));
        }
    });

    it('엔드포인트마다 snake_case = camelCase = Entry(...) 한 줄을 쓴다', () => {
        const text = generator.renderAbstract(tossSpec as BrokerSpec, 'pkg');

        expect(text).toContain('from pkg.base.types import Entry');
        expect(text).toContain("    private_market_get_exchange_rate = privateMarketGetExchangeRate = Entry('exchange-rate', ['private', 'market'], 'GET', {'cost': 1, 'bucket': 'market_info'})");
        expect(text).toContain("Entry('orders', ['private', 'account'], 'POST', {'cost': 1, 'bucket': 'order', 'order': True})");
        expect(text.split('\n').filter((line) => line.includes('= Entry(')).length).toBe(Object.keys(tossSpec.endpoints).length);
    });

    it('커밋된 Python 선언이 표와 같다(--check)', () => {
        const result = spawnSync(process.execPath, [GENERATOR, '--check'], { cwd: ROOT, encoding: 'utf8' });

        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });
});
