#!/usr/bin/env node
/**
 * @fileoverview CI 가 Python 의존성을 설치하는 잠금 파일(`python/requirements/*.txt`)을 다시 만들거나, `pyproject.toml` 과 맞는지 본다.
 *
 * 잠금 파일은 CI 전용이다. 사용하는 쪽의 설치(`pip install kr-broker @ git+…`)는 `pyproject.toml` 의 하한을 따르고 이 파일을 읽지 않는다.
 * 파일마다 `.in`(직접 요구하는 것)과 `.txt`(`uv pip compile --universal --generate-hashes` 로 푼 판과 해시)가 짝이다.
 * `--universal` 이라 파일 하나가 환경 마커로 Python 3.10 과 3.13 을 함께 덮는다. Dependabot(`uv` 생태계)도 `.txt` 머리말의 명령으로 다시 만든다.
 *
 * - `runtime`: `[project] dependencies`. pip-audit 가 감사하는 운영 의존성이다.
 * - `ci`: `runtime.txt` 로 묶은 운영 의존성, `dev` extra, `[build-system] requires`. CI 는 이 파일로 설치하고 패키지 자신을 `--no-build-isolation` 으로 빌드한다.
 * - `pip-audit`: 감사 도구.
 *
 * 인자 없이 돌리면 uv 로 세 파일을 다시 만든다(네트워크 필요). 이미 있는 판은 그대로 두고, `--upgrade` 나 `--upgrade-package <이름>` 같은 인자는 uv 에 넘긴다.
 * `--check` 는 네트워크 없이 `.in` 이 `pyproject.toml` 과 같은지, `.txt` 가 정해진 명령으로 만들어졌고 `.in` 의 범위를 만족하는 판을 담았는지 본다.
 * 빠진 하위 의존성은 CI 의 `pip install --require-hashes` 가 잡는다.
 *
 * ```bash
 * pnpm python:lock                              # 다시 만든다
 * pnpm python:lock --upgrade                    # 모든 판을 최신으로
 * node scripts/python-lock.mjs --check          # pyproject.toml 과 맞는지
 * ```
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_DIR = path.join(ROOT, 'python', 'requirements');
const PYPROJECT = path.join(ROOT, 'python', 'pyproject.toml');

/** 다시 만드는 순서. `ci.in` 이 `runtime.txt` 를 제약으로 읽으므로 `runtime` 이 먼저다. */
const LOCKS = ['runtime', 'ci', 'pip-audit'];

/** 모든 잠금 파일을 만드는 옵션. 지원하는 가장 낮은 Python 을 기준으로 푼다. */
const COMPILE_OPTIONS = ['--universal', '--generate-hashes', '--python-version', '3.10'];

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

function read(file) {
    return readFileSync(file, 'utf8');
}

/** PEP 503 이름 정규화. */
function normalizeName(name) {
    return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** `pyproject.toml` 의 `[section]` 에서 `key = [...]` 문자열 배열을 읽는다. 이 저장소가 쓰는 모양(한 줄이나 여러 줄의 따옴표 문자열)만 읽는다. */
export function tomlStringArray(text, section, key) {
    const body = text.split(/^\[/m).find((part) => part.startsWith(`${section}]`));
    const match = body === undefined ? null : new RegExp(String.raw`^${key}\s*=\s*\[((?:[^\]"']|"[^"]*"|'[^']*')*)\]`, 'm').exec(body);
    if (match === null) throw new Error(`pyproject.toml 의 [${section}] 에서 ${key} 배열을 읽지 못했다`);
    return [...(match[1] ?? '').matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
}

/** `.in` 파일에서 요구사항과 옵션 줄(`-c`, `-r`)을 나눈다. 주석과 빈 줄은 뺀다. */
export function parseIn(text) {
    const lines = text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean);
    return { options: lines.filter((line) => line.startsWith('-')), requirements: lines.filter((line) => !line.startsWith('-')) };
}

/** `.txt` 에서 고정한 판(`이름==판`)을 읽는다. 키는 정규화한 이름이다. */
export function parsePins(text) {
    const pins = new Map();
    for (const match of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)/gm)) pins.set(normalizeName(match[1] ?? ''), match[2] ?? '');
    return pins;
}

/** 숫자로만 된 판(`2.34.2`)을 비교한다. 그 밖의 모양이면 `undefined`. */
function compareRelease(a, b) {
    if (!/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b)) return undefined;
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const diff = (x[i] ?? 0) - (y[i] ?? 0);
        if (diff !== 0) return Math.sign(diff);
    }
    return 0;
}

/**
 * 요구사항 하나(`requests>=2.33.0`)를 고정한 판이 만족하는지. 판을 읽을 수 없거나 연산자를 모르면 이유를 문자열로 돌려준다.
 * @returns {true | string}
 */
export function satisfies(requirement, pins) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/.exec(requirement);
    if (match === null) return `요구사항 ${requirement} 을(를) 읽지 못했다`;
    const name = normalizeName(match[1] ?? '');
    const pinned = pins.get(name);
    if (pinned === undefined) return `${name} 의 고정한 판이 없다`;
    for (const spec of (match[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const op = /^(==|!=|>=|<=|>|<|~=)\s*(\S+)$/.exec(spec);
        const cmp = op === null ? undefined : compareRelease(pinned, op[2] ?? '');
        if (op === null || cmp === undefined) return `${name} ${spec} 를 이 검사가 비교하지 못한다(판 ${pinned})`;
        // `~=2.3.1` 은 `>=2.3.1, ==2.3.*` 이다.
        const prefix = (op[2] ?? '').split('.').slice(0, -1);
        const compatible = cmp >= 0 && prefix.every((part, i) => Number(part) === Number(pinned.split('.')[i] ?? 0));
        const ok = { '==': cmp === 0, '!=': cmp !== 0, '>=': cmp >= 0, '<=': cmp <= 0, '>': cmp > 0, '<': cmp < 0, '~=': compatible }[op[1] ?? ''];
        if (!ok) return `${name} ${pinned} 이(가) ${spec} 를 만족하지 않는다`;
    }
    return true;
}

/** 두 요구사항 목록이 같은지(순서와 공백은 무시). */
function sameRequirements(a, b) {
    const key = (list) => list.map((r) => r.replace(/\s+/g, '')).sort().join('\n');
    return key(a) === key(b);
}

function check() {
    const pyproject = read(PYPROJECT);
    const expected = {
        runtime: tomlStringArray(pyproject, 'project', 'dependencies'),
        ci: [...tomlStringArray(pyproject, 'project.optional-dependencies', 'dev'), ...tomlStringArray(pyproject, 'build-system', 'requires')],
    };
    const problems = [];
    for (const lock of LOCKS) {
        const input = parseIn(read(path.join(LOCK_DIR, `${lock}.in`)));
        const compiled = read(path.join(LOCK_DIR, `${lock}.txt`));
        const own = input.requirements;
        const want = expected[lock];
        if (want !== undefined && !sameRequirements(own, want)) {
            problems.push(`${lock}.in 의 요구사항(${own.join(', ')})이 pyproject.toml(${want.join(', ')})과 다르다`);
        }
        const command = ['uv pip compile', ...COMPILE_OPTIONS, `${lock}.in`, '-o', `${lock}.txt`].join(' ');
        if (!compiled.split('\n', 5).some((line) => line.trim() === `#    ${command}`)) {
            problems.push(`${lock}.txt 의 머리말이 \`${command}\` 로 만든 모양이 아니다`);
        }
        const pins = parsePins(compiled);
        const nested = input.options.flatMap((option) => {
            const ref = /^-r\s+(\S+)\.in$/.exec(option);
            return ref === null ? [] : parseIn(read(path.join(LOCK_DIR, `${ref[1]}.in`))).requirements;
        });
        for (const requirement of [...own, ...nested]) {
            const result = satisfies(requirement, pins);
            if (result !== true) problems.push(`${lock}.txt: ${result}`);
        }
    }
    const runtimePins = parsePins(read(path.join(LOCK_DIR, 'runtime.txt')));
    const ciPins = parsePins(read(path.join(LOCK_DIR, 'ci.txt')));
    for (const [name, version] of runtimePins) {
        if (ciPins.get(name) !== version) problems.push(`ci.txt 의 ${name} 판(${ciPins.get(name) ?? '없음'})이 runtime.txt(${version})와 다르다`);
    }
    if (problems.length > 0) {
        fail(`Python 잠금 파일(python/requirements)이 pyproject.toml 과 맞지 않는다:\n  ${problems.join('\n  ')}\n`
            + '.in 을 pyproject.toml 에 맞춘 뒤 pnpm python:lock 으로 다시 만든다.');
    }
    process.stdout.write(`Python 잠금 파일 ${LOCKS.length}개가 pyproject.toml 과 맞는다.\n`);
}

function compile(extra) {
    const version = spawnSync('uv', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (version.status !== 0) fail('uv 가 필요하다. 설치 방법은 https://docs.astral.sh/uv/getting-started/installation/ 에 있다.');
    for (const lock of LOCKS) {
        process.stdout.write(`▶ ${lock}.txt\n`);
        const result = spawnSync('uv', ['pip', 'compile', '--quiet', ...COMPILE_OPTIONS, ...extra, `${lock}.in`, '-o', `${lock}.txt`], {
            cwd: LOCK_DIR,
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });
        if (result.status !== 0) fail(`${lock}.txt 를 만들지 못했다`);
    }
    check();
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.includes('--check')) check();
    else compile(args);
}
