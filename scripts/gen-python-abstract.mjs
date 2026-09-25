#!/usr/bin/env node
/**
 * @fileoverview `ts/src/spec/*.json` 으로 Python 판의 암묵 API 선언(`python/<패키지>/abstract/*.py`)을 만든다.
 *
 * ccxt 의 `abstract/<거래소>.py` 와 같은 모양이다. 엔드포인트마다 `snake_case = camelCase = Entry(path, api, method, config)` 한 줄이 생기고,
 * 증권사 클래스(`class kis(Exchange, ImplicitAPI)`)가 이 클래스를 상속해 `private_get_...` 메서드를 얻는다.
 *
 * ```bash
 * node scripts/gen-python-abstract.mjs          # 파일을 다시 쓴다
 * node scripts/gen-python-abstract.mjs --check  # 파일이 스펙과 같은지만 본다(다르면 종료 코드 1)
 * ```
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Python 판 클래스가 있는 증권사만 만든다. KB증권은 Python 판이 없다. */
export const BROKERS = ['toss', 'kis'];
const SPEC_DIR = path.join(ROOT, 'ts/src/spec');
const PY_ROOT = path.join(ROOT, 'python');

/** `python/` 아래의 Python 패키지 이름. 공개 저장소 이름에 따라 바뀌므로 코드에 적지 않고 찾는다. */
export function pythonPackageName(pyRoot = PY_ROOT) {
    const found = readdirSync(pyRoot).filter((name) => existsSync(path.join(pyRoot, name, '__init__.py')));
    if (found.length !== 1) throw new Error(`${pyRoot} 에 Python 패키지가 하나여야 한다: ${found.join(', ') || '없음'}`);
    return found[0];
}

const CAPITALIZE = (s) => (s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const PATH_DELIMITER = /[^a-zA-Z0-9]/;

/** `ts/src/spec/spec-validate.ts` 의 `implicitMethodNames` 와 같은 규칙이다. 두 구현이 같은지는 테스트가 본다. */
export function implicitMethodNames(ep) {
    const parts = ep.path.split(PATH_DELIMITER);
    const method = ep.method.toLowerCase();
    const camel = [ep.api[0]].concat(ep.api.slice(1).map(CAPITALIZE)).join('') + CAPITALIZE(method) + CAPITALIZE(parts.map(CAPITALIZE).join(''));
    const apiParts = [ep.api[0]].concat(ep.api.slice(1).flatMap((name) => name.split(PATH_DELIMITER)));
    const snake = [...apiParts, method, ...parts.filter((p) => p.length > 0).map((p) => p.toLowerCase())].join('_');
    return { camel, snake };
}

/** JSON 값을 Python 리터럴로 쓴다. 스펙에 나오는 값(문자열·숫자·불리언·배열·사전)만 다룬다. */
function pyLiteral(value) {
    if (value === true) return 'True';
    if (value === false) return 'False';
    if (value === null) return 'None';
    if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return `[${value.map(pyLiteral).join(', ')}]`;
    return `{${Object.entries(value).map(([k, v]) => `${pyLiteral(k)}: ${pyLiteral(v)}`).join(', ')}}`;
}

/** 엔드포인트 설정(`describe().api` 의 잎과 같은 값). */
function endpointConfig(ep) {
    const config = { cost: ep.cost };
    for (const key of ['bucket', 'order', 'peak']) if (ep[key] !== undefined) config[key] = ep[key];
    return config;
}

export function renderAbstract(spec, packageName) {
    const lines = [
        `# 이 파일은 scripts/gen-python-abstract.mjs 가 ts/src/spec/${spec.broker}.json 에서 만든다. 직접 고치지 않는다.`,
        `from ${packageName}.base.types import Entry`,
        '',
        '',
        'class ImplicitAPI:',
    ];
    for (const [key, ep] of Object.entries(spec.endpoints)) {
        const { camel, snake } = implicitMethodNames(ep);
        if (key !== camel) throw new Error(`${spec.broker}.${key}: 키가 암묵 메서드 이름(${camel})과 다르다`);
        const api = ep.api.length > 1 ? pyLiteral(ep.api) : pyLiteral(ep.api[0]);
        lines.push(`    ${snake} = ${camel} = Entry(${pyLiteral(ep.path)}, ${api}, ${pyLiteral(ep.method)}, ${pyLiteral(endpointConfig(ep))})`);
    }
    return `${lines.join('\n')}\n`;
}

async function main() {
    const check = process.argv.includes('--check');
    const stale = [];
    const packageName = pythonPackageName();
    for (const broker of BROKERS) {
        const spec = JSON.parse(await readFile(path.join(SPEC_DIR, `${broker}.json`), 'utf8'));
        const text = renderAbstract(spec, packageName);
        const file = path.join(PY_ROOT, packageName, 'abstract', `${broker}.py`);
        if (check) {
            const current = await readFile(file, 'utf8').catch(() => '');
            if (current !== text) stale.push(path.relative(ROOT, file));
        } else {
            await writeFile(file, text);
        }
    }
    if (check && stale.length > 0) {
        process.stderr.write(`Python 암묵 API 선언이 스펙과 다르다. node scripts/gen-python-abstract.mjs 로 다시 만든다:\n  ${stale.join('\n  ')}\n`);
        process.exit(1);
    }
    if (check) process.stdout.write('Python 암묵 API 선언이 스펙과 같다.\n');
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
