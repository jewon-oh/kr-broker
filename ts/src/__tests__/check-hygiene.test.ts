/**
 * 위생 검사(`scripts/check-hygiene.mjs`)의 패턴과 파일 읽기 규칙.
 *
 * 저장소 전체가 통과하는지는 `pnpm hygiene:check` 가 본다. 이 파일도 검사 대상이라, 걸려야 하는 예는 조각을 이어 붙여 실행할 때 만든다.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(ROOT, 'scripts/check-hygiene.mjs');

interface Hygiene {
    PATTERNS: readonly { name: string }[];
    COMMIT_EMAIL_RULE: string;
    EMAIL_ALLOWED: Readonly<Record<'author' | 'committer' | 'text', (address: string) => boolean>>;
    scanLine(line: string): string[];
    linesOf(buf: Buffer): { binary: boolean; lines: string[] };
    scanPatch(lines: Iterable<string>): Promise<{ findings: string[]; binaries: { sha: string; file: string; blob: string }[] }>;
    scanHistory(options: { cwd: string; revs?: string[] }): Promise<{ shallow: boolean; commits: number; findings: string[] }>;
}

// 검사기는 타입 선언이 없는 .mjs 다. 경로를 변수로 만들어 불러오면 경계 검사와 타입 검사가 파일 안쪽으로 따라가지 않는다.
const hygiene = (await import(pathToFileURL(SCRIPT).href)) as Hygiene;

/** 조각을 이어 붙인다. 소스 줄에는 완성된 값이 없다. */
const join = (...parts: string[]): string => parts.join('');

/** 걸려야 하는 줄은 그 패턴에만 걸리고, 걸리지 않아야 하는 줄은 그 패턴에 걸리지 않는다. */
function expectRule(name: string, hits: string[], misses: string[]): void {
    expect(hygiene.PATTERNS.map((p) => p.name)).toContain(name);
    for (const line of hits) expect(hygiene.scanLine(line), line).toContain(name);
    for (const line of misses) expect(hygiene.scanLine(line), line).not.toContain(name);
}

describe('check-hygiene 패턴', () => {
    it('긴 base64 문자열: 80자 넘는 무작위 값은 걸리고, 메서드 이름과 토스 주문번호, SRI 해시, 16진수는 걸리지 않는다', () => {
        const digest = (seed: string): Buffer => createHash('sha512').update(seed).digest();
        const secret = Buffer.concat([digest('a'), digest('b')]).toString('base64'); // 172자, KIS 앱시크릿(180자)과 비슷한 모양
        expectRule('긴 base64 문자열', [
            `appsecret: '${secret}'`,
            `appsecret=${secret}&grant_type=client_credentials`,
            secret.slice(0, 80),
        ], [
            'privateGetUapiDomesticStockV1QuotationsInquireDailyItemchartpriceAndOverseasStockV1Price',
            "orderId: 'bAGzNvMOOTa5Uy0xVzYNbxDJ3Qpobwau4jDF3hyZZGWbpHm7wha8CFZc7aXVOWAl'",
            `integrity: sha512-${digest('c').toString('base64')}`,
            `sha: ${digest('d').toString('hex')}`,
            secret.slice(0, 79),
        ]);
    });

    it('KIS 접속키 모양: approval_key 에 붙은 UUID 만 걸린다', () => {
        const uuid = ['a1b2c3d4', 'e5f6', '4a7b', '8c9d', '0e1f2a3b4c5d'].join('-');
        expectRule('KIS 접속키 모양', [
            `{"header": {"approval_key": "${uuid}", "custtype": "P"}}`,
            `approvalKey: '${uuid}'`,
            `APPROVAL_KEY=${uuid}`,
        ], [
            "approval_key: 'approval-key'",
            `orderId: '${uuid}'`,
            "const approvalKey = this.safeString(response, 'approval_key');",
        ]);
    });

    it('client_secret 값: 따옴표 안이나 = 뒤의 16자 넘는 영숫자 값만 걸린다', () => {
        const value = join('Zx9aQ4bR', '7cS2dT5eU8f');
        expectRule('client_secret 값', [
            `grant_type=client_credentials&client_id=id&client_secret=${value}`,
            `{"client_secret": "${value}"}`,
            `clientSecret: '${value}'`,
            `TOSS_CLIENT_SECRET=${value}`,
        ], [
            'grant_type=client_credentials&client_id=toss-client-id-123456&client_secret=toss-secret',
            "client_secret: this.secret ?? '',",
            '{"client_secret":"***"}',
            "secret: process.env.TOSS_CLIENT_SECRET ?? '',",
            'client_secret: process.env.TOSS_CLIENT_SECRET_V2,',
            "'client_secret': self.secret or '',",
        ]);
    });

    it('링크로컬 주소: IPv4 169.254/16 과 IPv6 fe80/10 이 걸린다', () => {
        expectRule('링크로컬 주소', [
            join('ping 169.254', '.12.34'),
            join('fe80:', ':1'),
            join('[FE80:', ':1c2d:3e4f:5a6b:7c8d%eth0]'),
            join('feb0:0:0:0', ':1:2:3:4'),
        ], [
            '169.25.1.1',
            '1169.254.1.1',
            'fe80:12:34',
            'fec0::1',
            'coffee80::1',
        ]);
    });

    it('IPv6 사설 주소: fc00/7 이 걸리고, 주소 모양이 아니면 걸리지 않는다', () => {
        expectRule('IPv6 사설 주소', [
            join('fd12:3456:789a:1:', ':1'),
            join('fc00:', ':'),
            join('FD00:', ':abcd/64'),
        ], [
            'fc22:30:00',
            'fdescribe()',
            'ffd0::1',
            'fe00::1',
        ]);
    });

    it('.lan 호스트: .lan 으로 끝나는 호스트만 걸린다', () => {
        expectRule('.lan 호스트', [
            join('nas.home', '.lan'),
            join('http://router', '.lan/admin'),
            join('printer', '.lan:8080'),
        ], [
            'plan',
            'kr.lang',
            'foo.land',
            'x.lan.example.com',
            'x.lan-2',
            '.lan',
        ]);
    });

    it('이메일 주소: example.* 도메인, GitHub noreply 주소, noreply@anthropic.com 이 아니면 걸린다', () => {
        expectRule('이메일 주소', [
            join('someone', '@mail.test'),
            join('Signed-off-by: A <a.b+c', '@corp.co.kr>'),
            join('me', '@sub.example.test'),
            join('x', '@users.noreply.github.com.evil.test'),
            join('noreply', '@anthropic.com.evil.test'),
            join('Committer: GitHub <noreply', '@github.com>'),
        ], [
            'alice@example.com',
            'Co-Authored-By: Claude <noreply@anthropic.com>',
            'Co-authored-by: someone <12345+someone@users.noreply.github.com>',
            'Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
            '"packageManager": "pnpm@11.18.0"',
            'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
            '"@types/node": "^22.0.0"',
        ]);
    });

    const githubNoreply = [
        '12345+someone@users.noreply.github.com',
        'someone@users.noreply.github.com',
        '49699333+dependabot[bot]@users.noreply.github.com',
        '41898282+github-actions[bot]@users.noreply.github.com',
        '12345+Someone@Users.NoReply.GitHub.com',
    ];
    const neverAllowed = [
        '',
        join('someone', '@mail.test'),
        join('someone', '@users.noreply.github.com.evil.test'),
        '@users.noreply.github.com',
        join('a b', '@users.noreply.github.com'),
        join('support', '@github.com'),
        join('noreply', '@github.io'),
        join('noreply', '@anthropic.com.evil.test'),
    ];
    // 웹에서 병합한 커밋과 Dependabot 커밋에 GitHub 이 커미터로 적는 서비스 주소. 파일과 메시지에서는 걸리므로 조각을 이어 만든다.
    const githubService = join('noreply', '@github.com');
    const anthropic = 'noreply@anthropic.com';

    it('작성자 이메일: GitHub noreply 주소(봇 포함)만 허용하고, GitHub 서비스 주소와 noreply@anthropic.com 은 걸린다', () => {
        for (const address of githubNoreply) expect(hygiene.EMAIL_ALLOWED.author(address), address).toBe(true);
        for (const address of [...neverAllowed, githubService, join('NoReply', '@GitHub.com'), anthropic, 'alice@example.com'])
            expect(hygiene.EMAIL_ALLOWED.author(address), address).toBe(false);
    });

    it('커미터 이메일: GitHub noreply 주소와 GitHub 서비스 주소를 허용하고, noreply@anthropic.com 은 걸린다', () => {
        for (const address of [...githubNoreply, githubService, join('NoReply', '@GitHub.com')]) expect(hygiene.EMAIL_ALLOWED.committer(address), address).toBe(true);
        for (const address of [...neverAllowed, anthropic, 'alice@example.com']) expect(hygiene.EMAIL_ALLOWED.committer(address), address).toBe(false);
    });

    it('파일과 커밋 메시지의 이메일: GitHub noreply 주소, noreply@anthropic.com, example.* 을 허용하고, GitHub 서비스 주소는 걸린다', () => {
        for (const address of [...githubNoreply, anthropic, 'alice@example.com']) expect(hygiene.EMAIL_ALLOWED.text(address), address).toBe(true);
        for (const address of [...neverAllowed, githubService]) expect(hygiene.EMAIL_ALLOWED.text(address), address).toBe(false);
    });

    it('Windows 홈 경로: 드라이브 문자 뒤 Users 아래 사용자 폴더가 있으면 걸린다', () => {
        expectRule('Windows 홈 경로', [
            join('C:', '\\Users\\alice\\project'),
            join('c:/Us', 'ers/bob/'),
            join('"D:', '\\\\Users\\\\carol\\\\repo"'),
        ], [
            'C:\\Program Files\\node',
            'C:\\Users\\',
            'see Users/ folder',
        ]);
    });
});

describe('check-hygiene 파일 읽기', () => {
    const privateIp = join('10.1', '.2.3');

    it('NUL 바이트가 없으면 UTF-8 줄로 나눈다', () => {
        expect(hygiene.linesOf(Buffer.from(`a\n${privateIp}\n`))).toEqual({ binary: false, lines: ['a', privateIp, ''] });
    });

    it('★BOM 이 있는 UTF-16(LE, BE)은 건너뛰지 않고 풀어 읽는다', () => {
        const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`한글\n${privateIp}`, 'utf16le')]);
        const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`한글\n${privateIp}`, 'utf16le').swap16()]);
        for (const buf of [le, be]) {
            const { binary, lines } = hygiene.linesOf(buf);
            expect(binary).toBe(false);
            expect(lines).toEqual(['한글', privateIp]);
            expect(hygiene.scanLine(lines[1]!)).toEqual(['사설 IP']);
        }
    });

    it('★그 밖에 NUL 바이트가 있는 파일은 ASCII 로 읽히는 구간을 뽑아 본다(BOM 없는 UTF-16 포함)', () => {
        const binary = Buffer.concat([Buffer.from([0x00, 0x01, 0xff, 0x8b]), Buffer.from(`host=${privateIp};`), Buffer.from([0x00, 0x9c])]);
        const utf16 = Buffer.from(`host=${privateIp};`, 'utf16le');
        for (const buf of [binary, utf16]) {
            const { binary: isBinary, lines } = hygiene.linesOf(buf);
            expect(isBinary).toBe(true);
            expect(lines.flatMap((line) => hygiene.scanLine(line))).toContain('사설 IP');
        }
    });

    it('ASCII 구간이 없는 바이너리에서는 아무것도 걸리지 않는다', () => {
        const noise = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 97 + 13) % 256).map((b) => (b >= 0x20 && b < 0x7f ? b | 0x80 : b)));
        const { binary, lines } = hygiene.linesOf(noise);
        expect(binary).toBe(true);
        expect(lines.flatMap((line) => hygiene.scanLine(line))).toEqual([]);
    });
});

describe('check-hygiene 커밋 이력', () => {
    const privateIp = join('10.1', '.2.3');
    const personal = join('someone', '@mail.test');
    const noreply = '12345+someone@users.noreply.github.com';
    const dirs: string[] = [];
    afterAll(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    });

    /** 사용자 git 설정과 훅이 끼어들지 않는 임시 저장소. `commit` 은 만든 커밋의 SHA 앞 12자를 돌려준다. */
    function tempRepo() {
        const dir = mkdtempSync(path.join(tmpdir(), 'kr-broker-hygiene-'));
        dirs.push(dir);
        writeFileSync(path.join(dir, '.gitconfig-empty'), '');
        const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig-empty'), GIT_CONFIG_NOSYSTEM: '1' };
        const repo = path.join(dir, 'repo');
        const git = (args: string[], cwd = repo, author = noreply, committer = noreply): string => execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: committer },
        });
        git(['init', '-q', '-b', 'main', repo], dir);
        const write = (file: string, content: string | Buffer): void => writeFileSync(path.join(repo, file), content);
        const commit = (message: string, author = noreply, committer = noreply): string => {
            git(['add', '-A']);
            git(['commit', '-q', '--no-verify', '--allow-empty', '-m', message], repo, author, committer);
            return git(['rev-parse', 'HEAD']).trim().slice(0, 12);
        };
        return { dir, repo, git, write, commit };
    }

    it('추가된 줄의 파일과 줄 번호를 알리고, 헝크 안의 +++ 줄도 추가된 줄로 읽고, 바이너리의 새 blob 을 모은다', async () => {
        const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
        const { findings, binaries } = await hygiene.scanPatch([
            `\x01${a}`,
            '',
            'diff --git a/fixtures/x.json b/fixtures/x.json',
            'new file mode 100644',
            `index ${'0'.repeat(40)}..${'1'.repeat(40)}`,
            '--- /dev/null',
            '+++ b/fixtures/x.json',
            '@@ -0,0 +1,3 @@',
            '+{',
            `+  "host": "${privateIp}",`,
            `+++ ${privateIp}`,
            `\x01${b}`,
            '',
            'diff --git a/fixtures/x.json b/fixtures/x.json',
            `index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644`,
            '--- a/fixtures/x.json',
            '+++ b/fixtures/x.json',
            '@@ -2 +1,0 @@',
            `-  "host": "${privateIp}",`,
            '@@ -5,0 +10 @@',
            '+ok',
            'diff --git a/img.png b/img.png',
            'new file mode 100644',
            `index ${'0'.repeat(40)}..${'3'.repeat(40)}`,
            'Binary files /dev/null and b/img.png differ',
            'diff --git a/old.png b/old.png',
            'deleted file mode 100644',
            `index ${'4'.repeat(40)}..${'0'.repeat(40)}`,
            'Binary files a/old.png and /dev/null differ',
        ]);
        expect(findings).toEqual([`${a.slice(0, 12)} fixtures/x.json:2 사설 IP`, `${a.slice(0, 12)} fixtures/x.json:3 사설 IP`]);
        expect(binaries).toEqual([{ sha: b, file: 'img.png', blob: '3'.repeat(40) }]);
    });

    it('★지운 파일의 줄, 바이너리, 메시지, 커밋 이메일(작성자 칸의 GitHub 서비스 주소 포함), 병합 커밋에서 새로 들어간 줄이 걸린다', async () => {
        const { repo, git, write, commit } = tempRepo();
        write('a.txt', `a\nhost=${privateIp}\n`);
        write('b.bin', Buffer.concat([Buffer.from([0, 1]), Buffer.from(`host=${privateIp};`), Buffer.from([0])]));
        const added = commit('init');
        git(['rm', '-q', 'a.txt', 'b.bin']);
        commit('rm');
        const message = commit(`chore: note\n\nsee ${personal}`);
        const author = commit('author', personal);
        const serviceAuthor = commit('service author', join('noreply', '@github.com'));
        const committer = commit('committer', noreply, personal);
        commit('web merge', noreply, join('noreply', '@github.com'));
        git(['checkout', '-q', '-b', 'side']);
        write('s.txt', 'side\n');
        commit('side');
        git(['checkout', '-q', 'main']);
        write('m.txt', 'main\n');
        commit('main');
        git(['merge', '-q', '--no-ff', '--no-commit', 'side']);
        write('s.txt', `side\n${privateIp}\n`);
        const merge = commit('merge');

        const result = await hygiene.scanHistory({ cwd: repo });
        expect(result.shallow).toBe(false);
        expect(result.commits).toBe(10);
        expect([...result.findings].sort()).toEqual([
            `${added} a.txt:2 사설 IP`,
            `${added} b.bin (바이너리) 사설 IP`,
            `${message} 메시지:3 이메일 주소`,
            `${author} 작성자 ${hygiene.COMMIT_EMAIL_RULE}`,
            `${serviceAuthor} 작성자 ${hygiene.COMMIT_EMAIL_RULE}`,
            `${committer} 커미터 ${hygiene.COMMIT_EMAIL_RULE}`,
            `${merge} s.txt:2 사설 IP`,
        ].sort());
    }, 30_000);

    it('noreply 주소와 걸리지 않는 내용만 있으면 아무것도 걸리지 않고, 얕은 클론은 shallow 로 알린다', async () => {
        const { dir, repo, git, write, commit } = tempRepo();
        write('a.txt', 'alice@example.com\n');
        commit('feat: 첫 커밋\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
        write('a.txt', 'b\n');
        commit('fix: 둘째 커밋');
        const clean = await hygiene.scanHistory({ cwd: repo });
        expect(clean).toEqual({ shallow: false, commits: 2, findings: [] });

        const shallow = path.join(dir, 'shallow');
        git(['clone', '-q', '--depth', '1', pathToFileURL(repo).href, shallow], dir);
        expect(await hygiene.scanHistory({ cwd: shallow })).toEqual({ shallow: true, commits: 1, findings: [] });
    }, 30_000);
});
