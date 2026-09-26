#!/usr/bin/env node
/**
 * @fileoverview 저장소 파일에 비밀이나 사설 식별자로 보이는 값이 없는지 본다. 공개 저장소에 한 번 커밋한 값은 이력에 남는다.
 *
 * 보는 것: JWT 모양(`eyJ…`), 개인 키 블록, AWS 액세스 키 모양, KIS 앱키 모양(`PS` + 34자), 긴 Bearer 토큰, GitHub·Slack 토큰,
 * 긴 base64 문자열(KIS 앱시크릿처럼 80자 이상이고 무작위로 보이는 값), KIS 접속키(`approval_key` 에 붙은 UUID), `client_secret` 에 붙은 값,
 * 사설 IP(`10.`, `172.16~31.`, `192.168.`, CGNAT `100.64/10`), 링크로컬 주소(IPv4 `169.254/16`, IPv6 `fe80/10`), IPv6 사설 주소(`fc00/7`),
 * `.lan` 으로 끝나는 호스트, `example.*` 가 아닌 이메일 주소, 홈 디렉터리 경로(유닉스, Windows),
 * 계좌번호 모양(8자리-2자리, 픽스처의 가짜 값 `12345678-01` 등은 허용). 대상은 git 이 추적하는 파일과 아직 커밋하지 않은 새 파일이다(`.gitignore` 제외).
 * NUL 바이트가 있는 파일도 건너뛰지 않는다. BOM 이 있는 UTF-16 은 풀어 읽고, 그 밖의 바이너리는 ASCII 로 읽히는 8자 이상 구간만 본다.
 *
 * 주문번호처럼 패턴으로 가릴 수 없는 값은 PR 템플릿의 "픽스처와 비밀" 항목으로 사람이 확인한다.
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

/** 문자 하나당 섀넌 엔트로피(비트). 80자 넘는 무작위 base64 는 5 를 넘는다. */
function entropy(text) {
    const counts = new Map();
    for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
    return bits;
}

/**
 * 긴 base64 문자열이 비밀로 보이는가. 대문자, 소문자, 숫자가 모두 있고 엔트로피가 높아야 한다.
 * 엔드포인트에서 만든 긴 메서드 이름(`privateGetUapi…`)은 엔트로피가 4.6 을 넘지 않는다.
 */
function looksRandom(text) {
    return /[A-Z]/.test(text) && /[a-z]/.test(text) && /\d/.test(text) && entropy(text) >= 4.8;
}

/** 앞 16비트가 `head` 인 IPv6 주소. 여덟 묶음을 다 적었거나 `::` 로 줄인 모양만 주소로 본다(`fc22:30:00` 같은 값은 아니다). */
function ipv6(head) {
    const group = '[0-9a-f]{1,4}';
    return String.raw`(?<![\w:])${head}(?:(?::${group}){7}|(?::${group}){0,6}::(?:${group}(?::${group}){0,5})?)(?![\w:])`;
}

/**
 * 공개하면 안 되는 것으로 보이는 문자열 패턴. `accept` 가 있으면 `re` 에 걸린 값 가운데 `accept` 를 통과한 것만 센다.
 * @type {readonly { name: string; re: RegExp; accept?: (match: string) => boolean }[]}
 */
export const PATTERNS = [
    { name: 'JWT 모양', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/ },
    { name: '개인 키 블록', re: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/ },
    { name: 'AWS 액세스 키 모양', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: '사설 IP', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/ },
    { name: '링크로컬 주소', re: new RegExp(String.raw`\b169\.254\.\d{1,3}\.\d{1,3}\b|${ipv6('fe[89ab][0-9a-f]')}`, 'i') },
    { name: 'IPv6 사설 주소', re: new RegExp(ipv6('f[cd][0-9a-f]{2}'), 'i') },
    // 호스트 이름 글자 바로 뒤의 `.lan`. 뒤에 다른 이름이 이어지면(`x.lan.example.com`, `x.lan-2`) `.lan` 호스트가 아니다.
    { name: '.lan 호스트', re: /[a-z0-9]\.lan\b(?![.-][a-z0-9])/i },
    { name: 'KIS 앱키 모양', re: /\bPS[A-Za-z0-9]{34}\b/ },
    // 토스 주문번호(64자)보다 길고 KIS 앱시크릿(180자)보다 짧은 80자를 하한으로 둔다. SRI 해시(`sha512-…`)처럼 `-`, `_` 뒤에 붙은 값은 보지 않는다.
    { name: '긴 base64 문자열', re: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/]{80,}={0,2}(?![A-Za-z0-9+/=_-])/, accept: looksRandom },
    { name: 'KIS 접속키 모양', re: /approval[_-]?key["']?\s*[:=]\s*["']?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i },
    // 따옴표로 감싼 값이나 `=` 뒤의 값(폼, 환경 변수)만 본다. 숫자와 영문이 섞인 16자 이상이어야 한다(`toss-secret`, `***`, 변수 이름은 아니다).
    { name: 'client_secret 값', re: /client[_-]?secret(?:["']?\s*:\s*["']|["']?\s*=\s*["']?)(?=[\w.~+/=-]*\d)(?=[\w.~+/=-]*[A-Za-z])[\w.~+/=-]{16,}/i },
    { name: '긴 Bearer 토큰', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/ },
    { name: 'GitHub 토큰 모양', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
    { name: 'Slack 토큰 모양', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
    // 픽스처가 쓰는 가짜 계좌번호는 허용한다.
    { name: '계좌번호 모양', re: /\b(?!12345678-(?:01|22)\b)\d{8}-\d{2}\b/ },
    { name: '이메일 주소', re: /\b[\w.+-]+@(?!example\.)[\w-]+\.[A-Za-z]{2,}\b/ },
    { name: '홈 디렉터리 경로', re: /\/(?:home|Users)\/[A-Za-z][\w.-]*\// },
    { name: 'Windows 홈 경로', re: /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"'`]+(?:\\{1,2}|\/)/i },
];

/** 한 줄에서 걸린 패턴 이름. 한 패턴은 한 번만 센다. */
export function scanLine(line) {
    return PATTERNS.filter(({ re, accept }) => {
        if (accept === undefined) return re.test(line);
        for (const match of line.matchAll(new RegExp(re.source, `${re.flags}g`))) if (accept(match[0])) return true;
        return false;
    }).map(({ name }) => name);
}

/**
 * 파일 내용을 검사할 줄로 나눈다. NUL 바이트가 없으면 UTF-8 이고, BOM 이 있는 UTF-16 은 풀어 읽는다.
 * 그 밖에 NUL 바이트가 있는 파일(BOM 없는 UTF-16, 압축이나 이미지)은 한 바이트씩, 두 바이트씩 읽어 ASCII 로 보이는 8자 이상 구간만 돌려주고
 * `binary` 를 켠다. 이때는 줄 번호에 뜻이 없다.
 */
export function linesOf(buf) {
    if (!buf.includes(0)) return { binary: false, lines: buf.toString('utf8').split('\n') };
    const even = (bytes) => bytes.subarray(0, bytes.length - (bytes.length % 2));
    if (buf[0] === 0xff && buf[1] === 0xfe) return { binary: false, lines: even(buf.subarray(2)).toString('utf16le').split('\n') };
    if (buf[0] === 0xfe && buf[1] === 0xff) return { binary: false, lines: Buffer.from(even(buf.subarray(2))).swap16().toString('utf16le').split('\n') };
    const runs = (text) => text.match(/[\x20-\x7e\t]{8,}/g) ?? [];
    return { binary: true, lines: [...runs(buf.toString('latin1')), ...runs(even(buf).toString('utf16le'))] };
}

async function main() {
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
        scanned++;
        const { binary, lines } = linesOf(buf);
        lines.forEach((line, index) => {
            for (const name of scanLine(line)) findings.push(binary ? `${file} (바이너리) ${name}` : `${file}:${index + 1} ${name}`);
        });
    }

    if (findings.length > 0) {
        process.stderr.write(`공개하면 안 되는 것으로 보이는 값 ${findings.length}건(값은 출력하지 않는다):\n  ${findings.join('\n  ')}\n`);
        process.exit(1);
    }
    process.stdout.write(`파일 ${scanned}개에서 비밀이나 사설 식별자로 보이는 값을 찾지 못했다.\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
