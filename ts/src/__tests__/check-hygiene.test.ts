/**
 * 위생 검사(`scripts/check-hygiene.mjs`)의 패턴과 파일 읽기 규칙.
 *
 * 저장소 전체가 통과하는지는 `pnpm hygiene:check` 가 본다. 이 파일도 검사 대상이라, 걸려야 하는 예는 조각을 이어 붙여 실행할 때 만든다.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(ROOT, 'scripts/check-hygiene.mjs');

interface Hygiene {
    PATTERNS: readonly { name: string }[];
    scanLine(line: string): string[];
    linesOf(buf: Buffer): { binary: boolean; lines: string[] };
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
