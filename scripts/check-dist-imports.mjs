#!/usr/bin/env node
/**
 * @fileoverview 빌드한 `dist/` 를 Node.js 로 불러올 수 있는지 본다. `package.json` 의 `exports` 에 적힌 경로를 하나씩 import 한다.
 *
 * TypeScript 는 확장자 없는 상대 경로(`./base`)를 그대로 내보내는데, Node.js ESM 은 이를 풀지 못한다(`ERR_UNSUPPORTED_DIR_IMPORT`).
 * `pnpm build` 가 `tsc-alias -f` 로 경로를 채우므로, 이 검사는 그 단계가 빠지거나 깨졌을 때 실패한다.
 *
 * ```bash
 * pnpm build && node scripts/check-dist-imports.mjs
 * ```
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const failures = [];
let count = 0;
for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    const file = typeof target === 'string' ? target : target?.default;
    if (typeof file !== 'string') continue;
    count++;
    try {
        await import(pathToFileURL(path.join(ROOT, file)).href);
    } catch (err) {
        failures.push(`${key} (${file}): ${err instanceof Error ? err.message : err}`);
    }
}

if (failures.length > 0) {
    process.stderr.write(`dist 를 Node.js 로 불러오지 못한 exports ${failures.length}/${count}개:\n  ${failures.join('\n  ')}\n`);
    process.exit(1);
}
process.stdout.write(`dist 의 exports ${count}개를 모두 Node.js 로 불러왔다.\n`);
