#!/usr/bin/env node
/**
 * @fileoverview 저장소 파일에 비밀이나 사설 식별자로 보이는 값이 없는지 본다. 공개 저장소에 한 번 커밋한 값은 이력에 남는다.
 *
 * 보는 것: JWT 모양(`eyJ…`), 개인 키 블록, AWS 액세스 키 모양, 사설 IP(`10.`, `172.16~31.`, `192.168.`),
 * `example.*` 가 아닌 이메일 주소, 홈 디렉터리 경로. 대상은 git 이 추적하는 파일과 아직 커밋하지 않은 새 파일이다(`.gitignore` 제외).
 *
 * 주문번호나 계좌번호처럼 패턴으로 가릴 수 없는 값은 PR 템플릿의 "픽스처와 비밀" 항목으로 사람이 확인한다.
 * 걸린 값은 출력하지 않고 파일, 줄, 패턴 이름만 알린다. 출력한 값도 CI 로그에 남기 때문이다.
 *
 * ```bash
 * pnpm hygiene:check
 * ```
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 공개하면 안 되는 것으로 보이는 문자열 패턴. */
const PATTERNS = [
    { name: 'JWT 모양', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/ },
    { name: '개인 키 블록', re: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/ },
    { name: 'AWS 액세스 키 모양', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: '사설 IP', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/ },
    { name: '이메일 주소', re: /\b[\w.+-]+@(?!example\.)[\w-]+\.[A-Za-z]{2,}\b/ },
    { name: '홈 디렉터리 경로', re: /\/(?:home|Users)\/[A-Za-z][\w.-]*\// },
];

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

const findings = [];
let scanned = 0;
for (const file of files) {
    let buf;
    try {
        buf = await readFile(path.join(ROOT, file));
    } catch {
        continue; // 작업 트리에서 지운 파일
    }
    if (buf.includes(0)) continue; // 바이너리
    scanned++;
    buf.toString('utf8').split('\n').forEach((line, index) => {
        for (const { name, re } of PATTERNS) {
            if (re.test(line)) findings.push(`${file}:${index + 1} ${name}`);
        }
    });
}

if (findings.length > 0) {
    process.stderr.write(`공개하면 안 되는 것으로 보이는 값 ${findings.length}건(값은 출력하지 않는다):\n  ${findings.join('\n  ')}\n`);
    process.exit(1);
}
process.stdout.write(`파일 ${scanned}개에서 비밀이나 사설 식별자로 보이는 값을 찾지 못했다.\n`);
