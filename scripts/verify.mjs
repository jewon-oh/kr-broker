#!/usr/bin/env node
/**
 * @fileoverview CI 가 돌리는 검사를 로컬에서 한 번에 돌린다(`pnpm verify`).
 *
 * 순서는 CI 와 같다. 하나라도 실패하면 거기서 멈추고 종료 코드 1 로 끝난다. 네트워크가 필요한 `pnpm audit --prod` 는 돌리지 않는다.
 * pyright 는 처음 한 번 `npx` 로 내려받는다.
 *
 * Python 단계(`pytest`, 예제 문법 검사, pyright 기준선 검사)는 `KR_BROKER_PYTHON`, `python/.venv` 의 Python, PATH 의 `python3`·`python` 순서로
 * `pytest` 와 패키지 의존성을 불러올 수 있는 Python 을 찾아 쓴다. 찾지 못하면 설치 방법을 알리고 실패한다. `--no-python` 을 주면 건너뛴다.
 *
 * ```bash
 * pnpm verify
 * pnpm verify --no-python
 * ```
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';

/** 명령 하나를 돌린다. 실패하면 이름을 알리고 끝낸다. */
function run(name, command, args, options = {}) {
    process.stdout.write(`\n▶ ${name}\n`);
    const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: options.shell ?? false, ...options });
    if (result.status !== 0) {
        process.stderr.write(`\n✗ ${name} 이(가) 실패했다\n`);
        process.exit(1);
    }
}

function pnpm(script) {
    // Windows 의 pnpm 은 .cmd 라 셸을 거쳐야 실행된다.
    run(`pnpm ${script}`, 'pnpm', ['run', '--silent', script], { shell: WINDOWS });
}

function node(script, ...args) {
    run(`node ${script} ${args.join(' ')}`.trim(), process.execPath, [script, ...args]);
}

/** `pytest` 와 패키지의 의존성(비동기 판의 aiohttp, 실시간 판의 cryptography)을 불러올 수 있는 Python 실행 파일. 없으면 `undefined`. */
function findPython() {
    const venv = path.join(ROOT, 'python', '.venv', WINDOWS ? 'Scripts' : 'bin', WINDOWS ? 'python.exe' : 'python');
    const candidates = [process.env.KR_BROKER_PYTHON, existsSync(venv) ? venv : undefined, 'python3', 'python'].filter(Boolean);
    return candidates.find((candidate) => spawnSync(candidate, ['-c', 'import pytest, kr_broker.async_support, kr_broker.pro'], { cwd: path.join(ROOT, 'python'), stdio: 'ignore' }).status === 0);
}

const skipPython = process.argv.includes('--no-python');

pnpm('typecheck');
pnpm('hygiene:check');
pnpm('test');
pnpm('docs:check');
pnpm('build');
node('scripts/check-dist-imports.mjs');
node('scripts/gen-python-abstract.mjs', '--check');
node('scripts/gen-python-sync.mjs', '--check');

if (skipPython) {
    process.stdout.write('\n--no-python: pytest 와 예제 문법 검사, pyright 기준선 검사를 건너뛴다\n');
} else {
    const python = findPython();
    if (python === undefined) {
        process.stderr.write('\n✗ pytest 와 kr_broker 의존성을 불러올 수 있는 Python 을 찾지 못했다. python/ 에서 python -m venv .venv 뒤\n'
            + "  .venv/bin/pip install -e '.[dev]' 로 설치하거나(CONTRIBUTING.md 의 Python 절), KR_BROKER_PYTHON 에 Python 경로를 준다.\n"
            + '  Python 단계를 빼려면 pnpm verify --no-python 을 쓴다.\n');
        process.exit(1);
    }
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
    run('pytest', python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], { cwd: path.join(ROOT, 'python'), env });
    const examples = readdirSync(path.join(ROOT, 'examples', 'py')).filter((file) => file.endsWith('.py')).map((file) => path.join('examples', 'py', file));
    run('예제 문법 검사', python, ['-m', 'py_compile', ...examples], { env });
    node('scripts/check-python-types.mjs', '--python', python);
}

process.stdout.write('\n✓ 모든 검사를 통과했다\n');
