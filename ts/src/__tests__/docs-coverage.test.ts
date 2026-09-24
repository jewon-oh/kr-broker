/**
 * 지원 범위 문서의 잠금. `docs/coverage/` 의 자료와 `docs/brokers/` 의 생성물이 코드와 어긋나지 않는다.
 *
 * 코드를 고치고 자료를 안 고치거나 자료만 고치면 이 테스트가 실패한다. 문서가 지원한다고 적은 것이 실제로 있고,
 * 코드에 있는 것이 문서에 빠지지 않는다.
 *
 * - 자료가 스키마에 맞고 `id` 가 겹치지 않는다.
 * - `describe().api` 의 모든 엔드포인트가 자료에 있다(상태는 `missing` 이 아니다).
 * - 상태가 `integrated`, `extended` 인 항목의 메서드가 실제로 있다.
 * - `has` 가 `true` 나 `emulated` 인 키가 기능 자료에 있고, 셀 값이 `has` 와 맞다.
 * - 근거(`경로:줄`)가 빈 줄이나 다른 API 의 정의 줄이 아니라 그 API 를 가리킨다.
 * - 생성기가 만든 결과가 커밋된 `docs/brokers/` 와 같다.
 *
 * 공개 저장소로 내보낸 뒤에도 돌아야 하므로 패키지 밖 경로를 읽지 않는다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Exchange } from '../base';
import { kbsec } from '../kbsec';
import { kis } from '../kis';
import { toss } from '../toss';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GENERATOR = path.join(ROOT, 'scripts/gen-broker-docs.mjs');

// ============ 자료 형태 ============

interface ApiEntry {
    id: string;
    category: string;
    endpoint: string;
    status: 'integrated' | 'extended' | 'implicit' | 'internal' | 'missing';
    method: string | null;
    evidence: string[];
    priority?: number;
}

interface BrokerCoverage {
    broker: string;
    profile: {
        class: string;
        credentials: Record<'apiKey' | 'secret' | 'uid', { required: boolean }>;
        sandbox: { supported: boolean };
        rateLimit: { ms: number };
    };
    apis: ApiEntry[];
}

interface FeatureCell {
    status: string;
    constraint?: string;
    note?: string;
    methods?: string[];
    apis?: string[];
}

interface FeatureRow {
    id: string;
    hasKeys: string[];
    methods: string[];
    cells: Record<string, FeatureCell>;
}

interface Coverage {
    brokers: Record<string, BrokerCoverage>;
    features: { features: FeatureRow[] };
}

interface Generator {
    loadCoverage(root: string): Promise<Coverage>;
    validateCoverage(data: Coverage): string[];
    checkGenerated(root: string): Promise<string[]>;
    checkEvidence(data: Coverage, root: string): Promise<string[]>;
}

// 생성기는 타입 선언이 없는 .mjs 다. 경로를 변수로 만들어 불러오면 경계 검사와 타입 검사가 파일 안쪽으로 따라가지 않는다.
const generator = (await import(pathToFileURL(GENERATOR).href)) as Generator;
const coverage = await generator.loadCoverage(ROOT);

const BROKERS: ReadonlyArray<[string, () => Exchange]> = [
    ['kis', () => new kis({ apiKey: 'kis-app-key-123456', secret: 'kis-secret', uid: '12345678-01' })],
    ['toss', () => new toss({ apiKey: 'toss-client-id-123456', secret: 'toss-secret', uid: 'ACC-001' })],
    ['kbsec', () => new kbsec({ apiKey: 'kb-app-key-123456', secret: 'kb-secret' })],
];

// ============ 도구 ============

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch']);

/** `describe().api` 트리를 `{ 메서드, 경로 }` 목록으로 편다. 동사 키 아래의 키(또는 배열 원소)가 경로다. */
function flattenApi(node: unknown, verb?: string): Array<{ method: string; path: string }> {
    if (Array.isArray(node)) return verb === undefined ? [] : node.filter((p): p is string => typeof p === 'string').map((path) => ({ method: verb.toUpperCase(), path }));
    if (node === null || typeof node !== 'object') return [];
    const out: Array<{ method: string; path: string }> = [];
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (verb !== undefined) out.push({ method: verb.toUpperCase(), path: key });
        else if (HTTP_VERBS.has(key)) out.push(...flattenApi(value, key));
        else out.push(...flattenApi(value));
    }
    return out;
}

const normalizePath = (p: string): string => p.replace(/^\/+/, '').toLowerCase();

/** 자료의 엔드포인트(`GET /api/v1/prices`)가 트리의 경로(`prices`)를 가리키는가. 마지막 경로 조각 경계까지 맞아야 한다. */
function endpointMatches(entry: ApiEntry, method: string, apiPath: string): boolean {
    const space = entry.endpoint.indexOf(' ');
    if (entry.endpoint.slice(0, space) !== method) return false;
    const target = normalizePath(entry.endpoint.slice(space + 1));
    const key = normalizePath(apiPath);
    return target === key || target.endsWith(`/${key}`);
}

/** `fetchTicker` 이나 `candles().fetchDailyOHLCV` 가 인스턴스에서 부를 수 있는 메서드인가. */
function hasMethod(exchange: Exchange, name: string): boolean {
    let target: unknown = exchange;
    const parts = name.split('().');
    for (const [index, part] of parts.entries()) {
        const member = (target as Record<string, unknown>)[part];
        if (typeof member !== 'function') return false;
        if (index < parts.length - 1) target = (member as () => unknown).call(target);
    }
    return true;
}

/** `has` 에서 메서드 이름꼴의 키만. `spot`, `sandbox` 같은 성질 플래그는 뺀다. */
const isMethodKey = (key: string): boolean => /^(fetch|create|cancel|edit)[A-Z]/.test(key);

const IMPLEMENTED = new Set(['지원', '부분', '대체', '미검증']);

// ============ 테스트 ============

describe('자료 스키마', () => {
    it('★자료가 스키마에 맞는다', () => {
        expect(generator.validateCoverage(coverage)).toEqual([]);
    });

    it.each(BROKERS.map(([name]) => name))('%s: id 가 겹치지 않는다', (name) => {
        const ids = coverage.brokers[name].apis.map((e) => e.id);

        expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    });

    it('기능 자료의 id 가 겹치지 않는다', () => {
        const ids = coverage.features.features.map((f) => f.id);

        expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    });
});

describe.each(BROKERS)('%s: 자료와 코드의 일치', (name, make) => {
    const data = coverage.brokers[name];

    it('프로필이 클래스와 같다(클래스 이름, 모의투자, 인증 필드, 호출 간격)', () => {
        const exchange = make();

        expect(data.profile.class).toBe(exchange.id);
        expect(data.profile.sandbox.supported).toBe(Boolean(exchange.has.sandbox));
        for (const key of ['apiKey', 'secret', 'uid'] as const) {
            expect(data.profile.credentials[key].required, `requiredCredentials.${key}`).toBe(Boolean(exchange.requiredCredentials[key]));
        }
        expect(data.profile.rateLimit.ms).toBe(exchange.rateLimit);
    });

    it('★`describe().api` 의 모든 엔드포인트가 자료에 있다(미구현이 아니다)', () => {
        const leaves = flattenApi(make().describe().api);
        expect(leaves.length).toBeGreaterThan(0);

        const absent: string[] = [];
        for (const leaf of leaves) {
            const found = data.apis.filter((e) => endpointMatches(e, leaf.method, leaf.path));
            const listed = found.some((e) => e.status !== 'missing');
            if (!listed) absent.push(`${leaf.method} ${leaf.path}${found.length > 0 ? ' (자료에는 있으나 상태가 missing)' : ''}`);
        }

        expect(absent, '`api` 트리에 있는 엔드포인트는 docs/coverage 자료에 implicit 이상으로 적어야 한다').toEqual([]);
    });

    it('★상태가 통합, 확장인 항목의 메서드가 실제로 있다', () => {
        const exchange = make();
        const listed = data.apis.filter((e) => e.status === 'integrated' || e.status === 'extended');
        expect(listed.length).toBeGreaterThan(0);

        const absent = listed.filter((e) => e.method === null || !hasMethod(exchange, e.method)).map((e) => `${e.id} → ${String(e.method)}`);

        expect(absent, '자료의 method 가 클래스에 없다').toEqual([]);
    });

    it('암묵 항목에 메서드 이름이 있으면 실제로 있다', () => {
        const exchange = make();
        const absent = data.apis.filter((e) => e.status === 'implicit' && e.method !== null && !hasMethod(exchange, e.method)).map((e) => `${e.id} → ${String(e.method)}`);

        expect(absent).toEqual([]);
    });

    it('★`has` 가 true, emulated 인 메서드 키가 기능 자료에 있다', () => {
        const keys = new Set(coverage.features.features.flatMap((f) => f.hasKeys));
        const declared = Object.entries(make().has).filter(([key, value]) => isMethodKey(key) && (value === true || value === 'emulated')).map(([key]) => key);

        expect(declared.filter((key) => !keys.has(key)), 'features.json 의 hasKeys 에 없는 has 키').toEqual([]);
    });

    it('★기능 표의 셀 값이 `has` 와 맞는다', () => {
        const has = make().has;
        const wrong: string[] = [];
        for (const row of coverage.features.features) {
            if (row.hasKeys.length === 0) continue;
            const values = row.hasKeys.map((key) => has[key]);
            const status = row.cells[name].status;
            const expected = values.some((v) => v === true) ? 'implemented' : values.some((v) => v === 'emulated') ? 'emulated' : 'absent';
            const ok = expected === 'implemented' ? ['지원', '부분', '미검증'].includes(status) : expected === 'emulated' ? status === '대체' : ['미구현', '증권사 없음'].includes(status);
            if (!ok) wrong.push(`${row.id}: has=${JSON.stringify(values)} 인데 셀 값이 ${status}`);
        }

        expect(wrong).toEqual([]);
    });

    it('★구현으로 적은 셀의 메서드가 실제로 있다', () => {
        const exchange = make();
        const absent: string[] = [];
        for (const row of coverage.features.features) {
            const cell = row.cells[name];
            if (!IMPLEMENTED.has(cell.status)) continue;
            for (const method of cell.methods ?? row.methods) if (!hasMethod(exchange, method)) absent.push(`${row.id}: ${method}`);
        }

        expect(absent).toEqual([]);
    });

    it('근거(evidence) 파일이 있고 줄 번호가 파일 안이다', () => {
        const lineCounts = new Map<string, number>();
        const wrong: string[] = [];
        for (const entry of data.apis) {
            for (const ref of entry.evidence) {
                const [file, lines] = ref.split(':');
                const full = path.join(ROOT, file);
                if (!existsSync(full)) { wrong.push(`${entry.id}: ${file} 가 없다`); continue; }
                if (!lineCounts.has(file)) lineCounts.set(file, readFileSync(full, 'utf8').split('\n').length);
                const last = Number(lines.split('-').pop());
                if (last > (lineCounts.get(file) ?? 0)) wrong.push(`${entry.id}: ${ref} 는 파일 길이(${lineCounts.get(file)}줄)를 넘는다`);
            }
        }

        expect(wrong).toEqual([]);
    });
});

describe('스키마 검사기가 어긋난 자료를 잡는다', () => {
    const clone = (): Coverage => JSON.parse(JSON.stringify(coverage)) as Coverage;
    const errorsOf = (mutate: (c: Coverage) => void): string => {
        const c = clone();
        mutate(c);
        return generator.validateCoverage(c).join('\n');
    };

    it('id 중복', () => {
        expect(errorsOf((c) => { c.brokers.toss.apis[1].id = c.brokers.toss.apis[0].id; })).toContain('id가 중복됩니다');
    });

    it('알 수 없는 status', () => {
        expect(errorsOf((c) => { (c.brokers.kbsec.apis[0] as { status: string }).status = 'done'; })).toContain('status는');
    });

    it('missing 이 아닌 항목의 priority', () => {
        expect(errorsOf((c) => { const e = c.brokers.toss.apis.find((a) => a.status === 'integrated'); if (e) e.priority = 1; })).toContain('priority는 missing 항목에만');
    });

    it('통합 항목의 method 가 없음', () => {
        expect(errorsOf((c) => { const e = c.brokers.toss.apis.find((a) => a.status === 'integrated'); if (e) e.method = null; })).toContain('method가 필요합니다');
    });

    it('구현으로 적은 셀이 미구현 API 를 가리킴', () => {
        // 토스는 2단계까지 끝나 missing 이 하나도 없다 — kis 로 검증한다.
        const missing = coverage.brokers.kis.apis.find((a) => a.status === 'missing')?.id ?? '';
        expect(missing).not.toBe('');
        expect(errorsOf((c) => { c.features.features[0].cells.kis.apis = [missing]; })).toContain('미구현 API를 가리킵니다');
    });

    it('증권사 없음 셀에 apis', () => {
        const id = coverage.brokers.kbsec.apis[0].id;
        expect(errorsOf((c) => { c.features.features[0].cells.kbsec = { status: '증권사 없음', apis: [id] }; })).toContain('증권사 없음 셀에는 apis');
    });

    it('마침표로 끝나는 constraint', () => {
        expect(errorsOf((c) => { c.features.features[0].cells.kis.constraint = '제약입니다.'; })).toContain('마침표 없는 문장');
    });
});

describe('근거 검사기가 어긋난 근거를 잡는다', () => {
    const clone = (): Coverage => JSON.parse(JSON.stringify(coverage)) as Coverage;
    const kbEntry = (c: Coverage, id: string): ApiEntry => {
        const e = c.brokers.kbsec.apis.find((a) => a.id === id);
        if (e === undefined) throw new Error(`kbsec.json 에 ${id} 가 없다`);
        return e;
    };
    const lineOf = (file: string, match: (line: string) => boolean): number => {
        const index = readFileSync(path.join(ROOT, file), 'utf8').split('\n').findIndex(match);
        if (index < 0) throw new Error(`${file} 에 찾는 줄이 없다`);
        return index + 1;
    };
    const problemsOf = async (mutate: (c: Coverage) => void): Promise<string> => {
        const c = clone();
        mutate(c);
        return (await generator.checkEvidence(c, ROOT)).join('\n');
    };

    it('★지금 자료의 근거는 모두 통과한다', async () => {
        expect(await generator.checkEvidence(coverage, ROOT)).toEqual([]);
    });

    it('빈 줄이나 닫는 기호를 가리키면 잡는다', async () => {
        const brace = lineOf('ts/src/kbsec.ts', (l) => l === '    }');

        expect(await problemsOf((c) => { kbEntry(c, 'SSQM2341').evidence = [`ts/src/kbsec.ts:${brace}`]; })).toContain('빈 줄이나 닫는 기호');
    });

    it('줄이 밀려 옆 상수(다른 API 의 정의 줄)를 가리키면 잡는다', async () => {
        const other = lineOf('ts/src/kbsec/kbsec-types.ts', (l) => l.includes("TRADES_KR: 'SSQM2341',"));

        expect(await problemsOf((c) => { kbEntry(c, 'SSQM0004').evidence = [`ts/src/kbsec/kbsec-types.ts:${other}`]; }))
            .toContain('다른 API(SSQM2341)의 정의 줄');
    });

    it('id 가 코드에 문자열로 나오는데 근거가 id, 상수, 메서드를 하나도 담지 않으면 잡는다', async () => {
        const unrelated = lineOf('ts/src/kbsec.ts', (l) => l.startsWith('import {'));

        expect(await problemsOf((c) => { kbEntry(c, 'SSQM2341').evidence = [`ts/src/kbsec.ts:${unrelated}`]; })).toContain('어느 것도 담지 않은');
    });

    it('파일 밖 줄과 뒤집힌 범위를 잡는다', async () => {
        expect(await problemsOf((c) => { kbEntry(c, 'SSQM2341').evidence = ['ts/src/kbsec.ts:999999']; })).toContain('밖이거나 범위가 뒤집혔습니다');
        expect(await problemsOf((c) => { kbEntry(c, 'SSQM2341').evidence = ['ts/src/kbsec.ts:20-10']; })).toContain('밖이거나 범위가 뒤집혔습니다');
    });
});

describe('생성물', () => {
    it('★생성기 결과가 커밋된 docs/brokers/ 와 같다', async () => {
        const diffs = await generator.checkGenerated(ROOT);

        expect(diffs, '문서가 자료와 다르다. 패키지 폴더에서 `pnpm docs:gen` 을 실행해 다시 만들고 함께 커밋한다').toEqual([]);
    });

    it.each(BROKERS.map(([name]) => name))('%s 문서: 맨 위에 목차와 카테고리별 개수 표가 있다', (name) => {
        const text = readFileSync(path.join(ROOT, 'docs/brokers', `${name}.md`), 'utf8');

        expect(text.indexOf('## 목차')).toBeGreaterThan(-1);
        expect(text.indexOf('## 목차')).toBeLessThan(text.indexOf('## 요약'));
        expect(text.indexOf('| 구분 | 공식 API 수 |')).toBeLessThan(text.indexOf('## 카테고리별 공식 API'));
        expect(text).toContain('- [미구현 API](#미구현-api)');
    });

    it('판단 근거(note)가 있는 셀이 색인 문서의 판단 근거 표에 실린다', () => {
        const text = readFileSync(path.join(ROOT, 'docs/brokers/README.md'), 'utf8');
        const noted = coverage.features.features.flatMap((row) => Object.values(row.cells)).filter((c) => c.note !== undefined);

        expect(noted.length).toBeGreaterThan(0);
        expect(text).toContain('### 판단 근거');
        for (const c of noted) expect(text).toContain(c.note as string);
    });

    it('`--check` 가 종료 코드 0 으로 끝난다', () => {
        const result = spawnSync(process.execPath, [GENERATOR, '--check'], { cwd: ROOT, encoding: 'utf8' });

        expect(result.status, result.stderr).toBe(0);
    });
});
