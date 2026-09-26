#!/usr/bin/env node
/**
 * @fileoverview Python 판의 비동기 소스(`python/<패키지>/async_support/*.py`)에서 동기 판(`python/<패키지>/*.py`)을 만든다.
 *
 * ccxt 가 `async_support/<거래소>.py` 에서 동기 판을 만드는 규칙과 같다. 줄마다 다음만 바꾸므로 줄 번호가 바뀌지 않는다
 * (맨 위에 생성 표시 한 줄이 붙는다).
 *
 * - `async def`·`async with`·`async for` → `def`·`with`·`for`
 * - `await ` → 지운다
 * - `Awaitable[X]` → `X` (비동기 판의 콜백 힌트를 동기 모양으로 되돌린다). `typing` 가져오기의 `Awaitable` 도 뺀다.
 * - `<패키지>.async_support.` → `<패키지>.` (가져오는 곳을 동기 짝으로 바꾼다. 짝 모듈은 이름과 인자가 같다.)
 *
 * 바꾼 결과에 `async`·`await`·`asyncio`·`Awaitable` 이 남거나, 지울 `await ` 가 문자열이나 주석 안에 있으면 실패한다
 * (줄 단위 치환이 로그 문구나 설명을 몰래 바꾸지 않게 한다). 비동기 소스는 asyncio 를 직접 쓰지 않고
 * `async_support/base/runtime.py` 의 `sleep_seconds`·`new_lock`·`new_semaphore`·`maybe_await` 를 쓴다.
 *
 * ```bash
 * node scripts/gen-python-sync.mjs          # 동기 판을 다시 쓴다
 * node scripts/gen-python-sync.mjs --check  # 동기 판이 비동기 소스에서 만든 것과 같은지만 본다(다르면 종료 코드 1)
 * ```
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pythonPackageName } from './gen-python-abstract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY_ROOT = path.join(ROOT, 'python');

/** 비동기 소스가 정본인 모듈. 전역 상태를 두 판이 함께 써야 하는 모듈(`market_calendar` 등)은 여기 넣지 않고 짝을 손으로 쓴다. */
export const GENERATED_MODULES = [
    'kis.py',
    'toss.py',
    'kbsec.py',
    'kis_candle_service.py',
    'kis_yahoo_candles.py',
    'execution_confirm.py',
    'extended_session_limit.py',
];

const LEFTOVER = /\bawait\b|\basync\s+(?:def|with|for)\b|\basyncio\b|\bAwaitable\b/;

/** `Awaitable[X]` 를 `X` 로 벗긴다. 괄호 짝을 세므로 `Awaitable[Dict[str, Any]]` 처럼 겹친 힌트도 된다. */
function unwrapAwaitable(line) {
    const head = 'Awaitable[';
    let out = line;
    for (let start = out.indexOf(head); start >= 0; start = out.indexOf(head)) {
        let depth = 1;
        let end = start + head.length;
        for (; end < out.length && depth > 0; end++) {
            if (out[end] === '[') depth++;
            else if (out[end] === ']') depth--;
        }
        if (depth > 0) break; // 한 줄에서 닫히지 않으면 그대로 두고 LEFTOVER 가 알린다.
        out = out.slice(0, start) + out.slice(start + head.length, end - 1) + out.slice(end);
    }
    return out;
}

/**
 * 줄의 각 글자가 코드인지(문자열과 주석 밖인지) 표시한다. 세 따옴표 문자열은 여러 줄에 걸치므로 여는 따옴표를 `state.open` 으로 넘긴다.
 * f-string 의 `{}` 안도 문자열로 본다.
 */
export function codeMask(line, state) {
    const mask = new Array(line.length).fill(false);
    let i = 0;
    while (i < line.length) {
        if (state.open !== null) {
            const close = line.indexOf(state.open, i);
            if (close < 0) return mask;
            i = close + state.open.length;
            state.open = null;
            continue;
        }
        const ch = line[i];
        if (ch === '#') return mask;
        if (ch === '"' || ch === "'") {
            const triple = ch.repeat(3);
            if (line.startsWith(triple, i)) {
                state.open = triple;
                i += 3;
                continue;
            }
            let j = i + 1;
            while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
            i = j + 1;
            continue;
        }
        mask[i] = true;
        i++;
    }
    return mask;
}

/** `from typing import ...` 줄에서 `Awaitable` 을 뺀다. */
function dropAwaitableImport(line) {
    if (!/^\s*from typing import /.test(line)) return line;
    return line.replace(/\bAwaitable, /, '').replace(/, Awaitable\b/, '');
}

/** 비동기 소스 한 파일을 동기 판으로 바꾼다. `source` 는 비동기 소스의 저장소 기준 경로다(생성 표시에 쓴다). */
export function toSync(text, pkg, source) {
    const asyncPrefix = new RegExp(`\\b${pkg}\\.async_support\\.`, 'g');
    const state = { open: null };
    text.split('\n').forEach((line, index) => {
        const mask = codeMask(line, state);
        for (const match of line.matchAll(/\bawait\s+/g)) {
            if (!mask[match.index]) {
                throw new Error(`${source}:${index + 1} 문자열이나 주석 안의 await 를 지우게 된다. 문구를 바꾼다: ${line.trim()}`);
            }
        }
    });
    const lines = text.split('\n').map((line) => line
        .replace(/^(\s*)async\s+(def|with|for)\b/, '$1$2')
        .replace(/\bawait\s+/g, '')
        .replace(asyncPrefix, `${pkg}.`))
        .map((line) => dropAwaitableImport(unwrapAwaitable(line)));
    lines.forEach((line, index) => {
        if (LEFTOVER.test(line)) {
            throw new Error(`${source}:${index + 1} 동기 판으로 바꾸지 못한 비동기 구문이 남는다: ${line.trim()}`);
        }
    });
    return [`# 이 파일은 scripts/gen-python-sync.mjs 가 ${source} 에서 만든다. 직접 고치지 않는다.`, ...lines].join('\n');
}

async function main() {
    const check = process.argv.includes('--check');
    const pkg = pythonPackageName(PY_ROOT);
    const stale = [];
    for (const name of GENERATED_MODULES) {
        const source = `python/${pkg}/async_support/${name}`;
        const target = path.join(PY_ROOT, pkg, name);
        const generated = toSync(await readFile(path.join(ROOT, source), 'utf8'), pkg, source);
        const current = await readFile(target, 'utf8').catch(() => null);
        if (current === generated) continue;
        if (check) stale.push(path.relative(ROOT, target));
        else await writeFile(target, generated);
    }
    if (stale.length > 0) {
        process.stderr.write(`동기 판이 비동기 소스와 다르다. node scripts/gen-python-sync.mjs 로 다시 만든다:\n${stale.map((f) => `  ${f}`).join('\n')}\n`);
        process.exit(1);
    }
    process.stdout.write(check ? `동기 판 ${GENERATED_MODULES.length}개가 비동기 소스와 같다\n` : `동기 판 ${GENERATED_MODULES.length}개를 만들었다\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
