/**
 * 버전 정책(`docs/versioning.md`)의 공개 하위 경로 표가 `package.json` 의 `exports` 와 같은지 본다.
 *
 * 표에 없는 경로는 호환을 약속하지 않는다. `exports` 에 경로를 더하거나 빼고 표를 고치지 않으면 이 테스트가 실패한다.
 * 테스트 전용 경로(`kr-broker/testing`)는 `exports` 에 있지만 표에 넣지 않는다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function documentedSubpaths(): string[] {
    const doc = readFileSync(path.join(ROOT, 'docs/versioning.md'), 'utf8');
    const section = doc.split('\n### 공개 하위 경로\n')[1]?.split(/\n#{2,3} /)[0] ?? '';
    return section.split('\n')
        .filter(line => line.startsWith('|'))
        .flatMap(line => [...line.matchAll(/`kr-broker\/([^`]+)`/g)].map(m => `./${m[1]}`));
}

describe('공개 하위 경로', () => {
    it('버전 정책의 표가 exports 의 하위 경로와 같다', () => {
        const keys = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).exports);
        expect(keys).toContain('./testing');
        expect(documentedSubpaths().sort()).toEqual(keys.filter(k => k !== '.' && k !== './testing').sort());
    });
});
