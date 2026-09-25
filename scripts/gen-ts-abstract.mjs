#!/usr/bin/env node
/**
 * @fileoverview `ts/src/spec/*.json` 으로 TypeScript 판의 암묵 API 모듈(`ts/src/abstract/<증권사>.ts`)을 만든다.
 *
 * 모듈에는 두 가지가 들어간다. 증권사 클래스가 `describe().api` 에 넣는 API 트리 상수(`deriveApiTree(spec)` 와 같다)와, ccxt 의
 * `abstract/<거래소>.d.ts` 처럼 엔드포인트마다 암묵 메서드 하나를 적은 인터페이스다. 증권사 클래스가 인터페이스를 선언 병합으로 받는다.
 * 실행 코드가 JSON 을 불러오지 않도록 표를 TypeScript 상수로 옮긴다.
 *
 * ```bash
 * node scripts/gen-ts-abstract.mjs          # 파일을 다시 쓴다
 * node scripts/gen-ts-abstract.mjs --check  # 파일이 스펙과 같은지만 본다(다르면 종료 코드 1)
 * ```
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { endpointConfig, implicitMethodNames } from './gen-python-abstract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BROKERS = ['kis', 'toss', 'kbsec'];
const SPEC_DIR = path.join(ROOT, 'ts/src/spec');
const OUT_DIR = path.join(ROOT, 'ts/src/abstract');

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const CAPITALIZE = (s) => (s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** 생성하는 이름. 클래스 이름 표기(`Kis`·`Kbsec`)를 따른다. */
export function generatedNames(broker) {
    return { tree: `${broker.toUpperCase()}_API_TREE`, api: `${CAPITALIZE(broker)}ImplicitApi` };
}

/** `spec.endpoints` 를 `describe().api` 모양으로 접는다. `ts/src/spec/spec-validate.ts` 의 `deriveApiTree` 와 같고, 테스트가 둘을 대조한다. */
export function apiTree(spec) {
    const tree = {};
    for (const ep of Object.values(spec.endpoints)) {
        let node = tree;
        for (const part of ep.api) node = node[part] ??= {};
        const methodNode = node[ep.method.toLowerCase()] ??= {};
        methodNode[ep.path] = endpointConfig(ep);
    }
    return tree;
}

function tsString(value) {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function tsValue(value) {
    return typeof value === 'string' ? tsString(value) : String(value);
}

/** 잎(엔드포인트 설정)은 값이 전부 원시값인 객체다. 그 위의 이름·HTTP 메서드 마디는 객체를 담는다. */
function isLeaf(node) {
    return Object.values(node).every((value) => typeof value !== 'object');
}

function renderNode(node, indent) {
    const lines = [];
    for (const [key, value] of Object.entries(node)) {
        if (isLeaf(value)) {
            const config = Object.entries(value).map(([k, v]) => `${k}: ${tsValue(v)}`).join(', ');
            lines.push(`${indent}${tsString(key)}: { ${config} },`);
        } else {
            lines.push(`${indent}${IDENTIFIER.test(key) ? key : tsString(key)}: {`, ...renderNode(value, `${indent}    `), `${indent}},`);
        }
    }
    return lines;
}

export function renderTsAbstract(spec) {
    const names = generatedNames(spec.broker);
    const lines = [
        '/**',
        ` * @fileoverview \`${spec.broker}\` 의 API 트리와 암묵 메서드 선언. \`scripts/gen-ts-abstract.mjs\` 가 \`ts/src/spec/${spec.broker}.json\` 에서 만든 생성 파일이다.`,
        ` * 직접 고치지 말고 JSON 을 고친 뒤 \`node scripts/gen-ts-abstract.mjs\` 를 돌린다.`,
        ' */',
        "import type { Dict, ImplicitApiMethod } from '../base/types';",
        '',
        '/** `describe().api` 에 넣는 트리. `Exchange.defineRestApi` 가 엔드포인트마다 암묵 메서드를 만든다. */',
        `export const ${names.tree}: Dict = {`,
        ...renderNode(apiTree(spec), '    '),
        '};',
        '',
        `/** \`${names.tree}\` 의 엔드포인트마다 생기는 암묵 메서드. 증권사 클래스가 선언 병합으로 받는다. */`,
        `export interface ${names.api} {`,
    ];
    for (const [key, ep] of Object.entries(spec.endpoints)) {
        const { camel } = implicitMethodNames(ep);
        if (key !== camel) throw new Error(`${spec.broker}.${key}: 키가 암묵 메서드 이름(${camel})과 다르다`);
        lines.push(`    ${camel}: ImplicitApiMethod;`);
    }
    lines.push('}');
    return `${lines.join('\n')}\n`;
}

async function main() {
    const check = process.argv.includes('--check');
    const stale = [];
    if (!check) await mkdir(OUT_DIR, { recursive: true });
    for (const broker of BROKERS) {
        const spec = JSON.parse(await readFile(path.join(SPEC_DIR, `${broker}.json`), 'utf8'));
        const text = renderTsAbstract(spec);
        const file = path.join(OUT_DIR, `${broker}.ts`);
        if (check) {
            const current = await readFile(file, 'utf8').catch(() => '');
            if (current !== text) stale.push(path.relative(ROOT, file));
        } else {
            await writeFile(file, text);
        }
    }
    if (check && stale.length > 0) {
        process.stderr.write(`TypeScript 암묵 API 선언이 스펙과 다르다. node scripts/gen-ts-abstract.mjs 로 다시 만든다:\n  ${stale.join('\n  ')}\n`);
        process.exit(1);
    }
    if (check) process.stdout.write('TypeScript 암묵 API 선언이 스펙과 같다.\n');
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
