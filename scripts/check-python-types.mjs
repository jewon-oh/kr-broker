#!/usr/bin/env node
/**
 * @fileoverview Python 판을 pyright 로 타입 검사하고, 파일별 오류 수를 기준선(`python/pyright-baseline.json`)과 비교한다.
 *
 * 설정은 `python/pyproject.toml` 의 `[tool.pyright]` 에 있다. 기존 오류는 기준선으로 두고 새 오류만 막는다.
 * 어느 파일이든 오류가 기준선보다 많으면 그 파일의 오류를 보여 주고 실패한다. 기준선보다 적으면 기준선을 낮추라고 알리고 실패한다.
 * 파일별로 세는 이유는, 실패할 때 어느 파일을 봐야 하는지 바로 알 수 있고, 다른 파일에서 줄인 오류가 새 오류를 가리지 않기 때문이다.
 *
 * pyright 는 `npx` 로 `PYRIGHT_VERSION` 을 받아 돌린다. 처음 한 번은 npm 레지스트리에서 내려받는다.
 * `--python` 을 주지 않으면 pyright 가 PATH 의 Python 에서 의존성을 찾는다.
 *
 * ```bash
 * node scripts/check-python-types.mjs                                 # 기준선과 비교한다
 * node scripts/check-python-types.mjs --python python/.venv/bin/python # 이 Python 의 site-packages 로 import 를 푼다
 * node scripts/check-python-types.mjs --update                        # 지금 오류 수로 기준선을 다시 쓴다
 * ```
 */

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pythonPackageName } from './gen-python-abstract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY_ROOT = path.join(ROOT, 'python');
const BASELINE = path.join(PY_ROOT, 'pyright-baseline.json');
const WINDOWS = process.platform === 'win32';

/** 버전을 올리면 오류 수가 바뀔 수 있다. 올린 뒤 `--update` 로 기준선을 다시 쓴다. */
const PYRIGHT_VERSION = '1.1.414';

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

function argValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

/** `--python` 에 명령 이름(`python3`)을 줘도 되게 실행 파일의 절대 경로로 바꾼다. pyright 는 경로만 받는다. */
function resolvePython(python) {
    const result = spawnSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    if (result.status !== 0) fail(`Python 을 실행하지 못했다: ${python}`);
    return result.stdout.trim();
}

function runPyright(python) {
    // 버전을 고정했으므로 npm 캐시에 있으면 레지스트리에 묻지 않는다.
    const args = ['--yes', '--prefer-offline', `pyright@${PYRIGHT_VERSION}`, '--outputjson'];
    if (python !== undefined) args.push('--pythonpath', resolvePython(python));
    // Windows 의 npx 는 .cmd 라 셸을 거쳐야 실행된다. 셸이 인자를 나누지 않게 공백 있는 인자는 따옴표로 감싼다.
    const result = WINDOWS
        ? spawnSync(['npx', ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(' '), { cwd: PY_ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 })
        : spawnSync('npx', args, { cwd: PY_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    // 종료 코드 0 은 오류 없음, 1 은 오류 있음이다. 그 밖은 pyright 를 돌리지 못한 경우다.
    if (result.status !== 0 && result.status !== 1) fail(`pyright 를 돌리지 못했다(종료 코드 ${result.status}).\n${result.stderr ?? ''}${result.error ?? ''}`);
    try {
        return JSON.parse(result.stdout);
    } catch {
        fail(`pyright 출력을 읽지 못했다.\n${result.stdout}\n${result.stderr}`);
    }
}

const packageDir = path.join(PY_ROOT, pythonPackageName());
const report = runPyright(argValue('--python'));
const errors = report.generalDiagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => ({ ...diagnostic, key: path.relative(packageDir, diagnostic.file).split(path.sep).join('/') }));

// import 를 풀지 못하면 의존성이 없는 Python 을 본 것이다. 이 상태의 오류 수는 기준선과 비교하지도, 기준선으로 쓰지도 않는다.
const unresolved = [...new Set(errors.filter((e) => e.rule === 'reportMissingImports').map((e) => e.message))];
if (unresolved.length > 0) {
    fail(`pyright 가 import 를 풀지 못했다. 의존성을 설치한 Python(pip install -e './python[dev]')을 --python 으로 준다.\n  ${unresolved.join('\n  ')}`);
}

const counts = {};
for (const { key } of errors) counts[key] = (counts[key] ?? 0) + 1;
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
const total = errors.length;

if (process.argv.includes('--update')) {
    await writeFile(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
    process.stdout.write(`pyright ${PYRIGHT_VERSION}: 기준선을 오류 ${total}개(파일 ${Object.keys(sorted).length}개)로 다시 썼다.\n`);
    process.exit(0);
}

const baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
const keys = [...new Set([...Object.keys(baseline), ...Object.keys(counts)])].sort();
const increased = keys.filter((key) => (counts[key] ?? 0) > (baseline[key] ?? 0));
const decreased = keys.filter((key) => (counts[key] ?? 0) < (baseline[key] ?? 0));
const baselineTotal = Object.values(baseline).reduce((sum, count) => sum + count, 0);

if (increased.length > 0) {
    const lines = [];
    for (const key of increased) {
        lines.push(`\n${key}: 기준선 ${baseline[key] ?? 0}개 → ${counts[key]}개`);
        for (const error of errors.filter((e) => e.key === key)) {
            const { line, character } = error.range.start;
            lines.push(`  ${path.relative(ROOT, error.file)}:${line + 1}:${character + 1} ${error.message.split('\n')[0]}${error.rule ? ` (${error.rule})` : ''}`);
        }
    }
    fail(`pyright ${PYRIGHT_VERSION}: 기준선보다 오류가 늘었다. 새 오류를 고친다(오류 ${total}개, 기준선 ${baselineTotal}개).${lines.join('\n')}`);
}
if (decreased.length > 0) {
    const lines = decreased.map((key) => `  ${key}: 기준선 ${baseline[key]}개 → ${counts[key] ?? 0}개`);
    fail(`pyright ${PYRIGHT_VERSION}: 오류가 기준선보다 줄었다. node scripts/check-python-types.mjs --update 로 기준선을 낮춘다.\n${lines.join('\n')}`);
}
process.stdout.write(`pyright ${PYRIGHT_VERSION}: 오류 ${total}개로 기준선과 같다.\n`);
