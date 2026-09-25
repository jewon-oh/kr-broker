/**
 * @fileoverview TypeScript 판의 암묵 API 모듈(`ts/src/abstract/*.ts`)이 엔드포인트 표와 같은지 본다.
 * 증권사 클래스의 `describe().api` 가 이 모듈의 상수라서, 상수가 `deriveApiTree(spec)` 와 같으면 실행 중의 요청 표도 스펙과 같다.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Exchange } from '../../base/Exchange';
import type { Dict } from '../../base/types';
import { KBSEC_API_TREE } from '../../abstract/kbsec';
import { KIS_API_TREE } from '../../abstract/kis';
import { TOSS_API_TREE } from '../../abstract/toss';
import { kbsec } from '../../kbsec';
import { kis } from '../../kis';
import { toss } from '../../toss';
import { deriveApiTree } from '../spec-validate';
import type { BrokerSpec } from '../spec-types';
import kisSpec from '../kis.json';
import kbsecSpec from '../kbsec.json';
import tossSpec from '../toss.json';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const GENERATOR = path.join(ROOT, 'scripts/gen-ts-abstract.mjs');

interface Generator {
    renderTsAbstract(spec: BrokerSpec): string;
}

const generator = (await import(pathToFileURL(GENERATOR).href)) as Generator;

describe.each([
    ['kis', kisSpec, KIS_API_TREE, () => new kis()],
    ['toss', tossSpec, TOSS_API_TREE, () => new toss()],
    ['kbsec', kbsecSpec, KBSEC_API_TREE, () => new kbsec()],
] as Array<[string, unknown, Dict, () => Exchange]>)('%s: abstract/*.ts ↔ spec/*.json', (_id, spec, tree, make) => {
    it('API 트리 상수가 deriveApiTree(spec) 와 같다', () => {
        expect(tree).toEqual(deriveApiTree(spec as BrokerSpec));
    });

    it('describe().api 가 이 상수다', () => {
        expect(make().describe().api).toEqual(tree);
    });

    it('선언한 암묵 메서드마다 인스턴스에 메서드가 있다', () => {
        const ex = make();
        const missing = Object.keys((spec as BrokerSpec).endpoints).filter((name) => ex.implicitApiMethod(name) === undefined);
        expect(missing).toEqual([]);
    });
});

describe('scripts/gen-ts-abstract.mjs', () => {
    it('생성 파일 머리에 고치지 말라는 주석을 두고, 엔드포인트마다 암묵 메서드 한 줄을 쓴다', () => {
        const text = generator.renderTsAbstract(tossSpec as BrokerSpec);

        expect(text).toContain('직접 고치지 말고 JSON 을 고친 뒤 `node scripts/gen-ts-abstract.mjs` 를 돌린다.');
        expect(text).toContain('export const TOSS_API_TREE: Dict = {');
        expect(text).toContain("                'orders': { cost: 1, bucket: 'order', order: true },");
        expect(text).toContain('export interface TossImplicitApi {');
        expect(text.split('\n').filter((line) => line.endsWith(': ImplicitApiMethod;')).length).toBe(Object.keys(tossSpec.endpoints).length);
    });

    it('경로 유니언 타입은 쓰는 곳이 있는 kis 에만 만들고, 표의 private GET 경로를 모두 담는다', () => {
        const text = generator.renderTsAbstract(kisSpec as BrokerSpec);
        const paths = Object.values((kisSpec as BrokerSpec).endpoints).filter((ep) => ep.api.join('.') === 'private' && ep.method === 'GET').map((ep) => ep.path);

        expect(text).toContain('export type KisPrivateGetPath =');
        expect(text.split('\n').filter((line) => line.startsWith('    | ')).map((line) => line.replace(/^    \| '(.*)';?$/, '$1'))).toEqual(paths);
        expect(generator.renderTsAbstract(tossSpec as BrokerSpec)).not.toContain('export type');
        expect(generator.renderTsAbstract(kbsecSpec as BrokerSpec)).not.toContain('export type');
    });

    it('커밋된 TypeScript 선언이 표와 같다(--check)', () => {
        const result = spawnSync(process.execPath, [GENERATOR, '--check'], { cwd: ROOT, encoding: 'utf8' });

        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });
});
