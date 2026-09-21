#!/usr/bin/env node
/**
 * 지원 범위 자료(`docs/coverage/*.json`)로 증권사별 문서(`docs/brokers/`)를 만든다.
 *
 * 만드는 파일은 사람이 손으로 고치지 않는다. 고치려면 `docs/coverage/` 의 자료를 고치고 `docs:gen` 을 다시 돌린다.
 *
 * 사용:
 *   node scripts/gen-broker-docs.mjs            # docs/brokers/ 를 다시 쓴다
 *   node scripts/gen-broker-docs.mjs --check    # 커밋된 문서가 자료와 같은지 검사한다. 다르면 종료 코드 1
 *
 * 같은 모듈이 README 에 끼우는 조각(`renderFeatureMatrix`, `renderCoverageSummary`)도 내보낸다.
 * 외부 의존성이 없는 순수 Node 스크립트다.
 *
 * ## 언어 중립
 *
 * 자료에는 특정 언어의 표기를 넣지 않는다. 메서드 이름은 ccxt 표준 camelCase 가 정본이다.
 * 언어별 표기와 출력 위치는 `LANGUAGES` 가 정한다. 언어를 더하려면 항목 하나를 더한다.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 증권사 표시 순서. */
export const BROKERS = ['kis', 'toss', 'kbsec'];

/** 기능 표의 셀 값. */
export const CELL_STATUSES = ['지원', '부분', '대체', '증권사 없음', '미구현', '미검증'];

/** 구현된 것으로 세는 셀 값(라이브러리에 메서드가 있다). */
export const IMPLEMENTED_CELL_STATUSES = ['지원', '부분', '대체', '미검증'];

/** 공식 API 항목의 구현 상태. 값은 영문, 표에는 한글로 적는다. */
export const API_STATUSES = ['integrated', 'extended', 'implicit', 'internal', 'missing'];
export const API_STATUS_LABEL = { integrated: '통합', extended: '확장', implicit: '암묵', internal: '내부', missing: '미구현' };

/** 검증 수준. */
export const VERIFIED_LEVELS = ['real', 'sandbox', 'spec-only', 'unverified'];

/** 미구현 API 에 붙이는 제안 유형. 정렬 순서이기도 하다. */
export const PROPOSALS = ['통합', 'params 확대', '확장', 'watch*'];

export const MARKET_LABEL = { KR: '국내', US: '미국' };

const CATEGORY_KEYS = ['id', 'category', 'name', 'endpoint', 'markets', 'status', 'method', 'evidence', 'suggested', 'proposal', 'priority', 'verified', 'note', 'spec'];

/**
 * 출력 언어. `formatMethod` 는 ccxt camelCase 이름을 그 언어의 표기로 바꾼다.
 * `outDir` 은 패키지 루트 기준이다.
 */
export const LANGUAGES = {
    typescript: {
        id: 'typescript',
        label: 'TypeScript',
        outDir: 'docs/brokers',
        formatMethod: (name) => name,
    },
};

/** 생성물임을 알리는 문구. 모든 생성 파일의 머리에 들어간다. */
const GENERATED_NOTICE = '이 문서는 생성물입니다. 손으로 고치지 않습니다. `docs/coverage/`의 자료를 고친 뒤 `pnpm docs:gen`을 실행합니다.';

// ============================================================================
// 읽기와 검증
// ============================================================================

export async function loadCoverage(root = PACKAGE_ROOT) {
    const dir = path.join(root, 'docs/coverage');
    const brokers = {};
    for (const id of BROKERS) brokers[id] = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'));
    const features = JSON.parse(await readFile(path.join(dir, 'features.json'), 'utf8'));
    return { brokers, features };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string' && v.length > 0;

/**
 * 자료가 스키마에 맞는지 검사한다.
 * @returns {string[]} 오류 목록. 비어 있으면 통과다.
 */
export function validateCoverage(data) {
    const errors = [];
    const err = (where, message) => errors.push(`${where}: ${message}`);

    for (const id of BROKERS) {
        const b = data.brokers[id];
        const at = `${id}.json`;
        if (!isObject(b)) { err(at, '객체가 아닙니다'); continue; }
        if (b.schemaVersion !== 1) err(at, 'schemaVersion은 1이어야 합니다');
        if (b.broker !== id) err(at, `broker는 ${id}이어야 합니다`);
        if (!isString(b.name)) err(at, 'name이 없습니다');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.checkedOn ?? '')) err(at, 'checkedOn은 YYYY-MM-DD 형식이어야 합니다');
        validateProfile(b.profile, at, err);
        if (!Array.isArray(b.sources) || b.sources.length === 0) err(at, 'sources가 비어 있습니다');
        else b.sources.forEach((s, i) => { if (!isString(s?.name) || !/^https?:\/\//.test(s?.url ?? '')) err(`${at} sources[${i}]`, 'name과 url이 필요합니다'); });
        validateApis(b, at, err);
        validateUnique(b, at, err);
        if (!Array.isArray(b.limitations) || b.limitations.some((l) => !isString(l))) err(at, 'limitations는 문자열 배열이어야 합니다');
    }
    validateFeatures(data, err);
    return errors;
}

function validateProfile(p, at, err) {
    if (!isObject(p)) { err(at, 'profile이 없습니다'); return; }
    if (!isString(p.class)) err(at, 'profile.class가 없습니다');
    for (const key of ['apiKey', 'secret', 'uid']) {
        const c = p.credentials?.[key];
        if (!isObject(c) || !isString(c.label) || typeof c.required !== 'boolean') err(at, `profile.credentials.${key}는 { label, required } 여야 합니다`);
    }
    if (typeof p.sandbox?.supported !== 'boolean' || !isString(p.sandbox?.note)) err(at, 'profile.sandbox는 { supported, note } 여야 합니다');
    if (!Array.isArray(p.markets) || p.markets.length === 0 || p.markets.some((m) => !(m in MARKET_LABEL))) err(at, 'profile.markets는 KR, US 배열이어야 합니다');
    if (!Number.isInteger(p.rateLimit?.ms) || !isString(p.rateLimit?.note)) err(at, 'profile.rateLimit는 { ms, note } 여야 합니다');
}

function validateApis(b, at, err) {
    if (!Array.isArray(b.apis) || b.apis.length === 0) { err(at, 'apis가 비어 있습니다'); return; }
    const seen = new Set();
    const priorityLabels = b.priorities ?? {};
    b.apis.forEach((e, i) => {
        const where = `${at} apis[${i}]${isString(e?.id) ? ` (${e.id})` : ''}`;
        if (!isObject(e)) { err(where, '객체가 아닙니다'); return; }
        for (const key of Object.keys(e)) if (!CATEGORY_KEYS.includes(key)) err(where, `알 수 없는 키 ${key}`);
        for (const key of ['id', 'category', 'name', 'endpoint', 'status', 'verified', 'spec']) if (!isString(e[key])) err(where, `${key}가 비어 있습니다`);
        if (typeof e.note !== 'string') err(where, 'note는 문자열이어야 합니다(없으면 빈 문자열)');
        if (seen.has(e.id)) err(where, 'id가 중복됩니다');
        seen.add(e.id);
        if (!Array.isArray(e.markets) || e.markets.length === 0 || e.markets.some((m) => !(m in MARKET_LABEL))) err(where, 'markets는 KR, US 배열이어야 합니다');
        if (!API_STATUSES.includes(e.status)) err(where, `status는 ${API_STATUSES.join(', ')} 중 하나여야 합니다`);
        if (!VERIFIED_LEVELS.includes(e.verified)) err(where, `verified는 ${VERIFIED_LEVELS.join(', ')} 중 하나여야 합니다`);
        if (!Array.isArray(e.evidence) || e.evidence.some((v) => !/^src\/[\w./-]+\.\w+:\d+(-\d+)?$/.test(v))) err(where, 'evidence는 `경로:줄` 문자열 배열이어야 합니다');
        if (e.method !== null && !/^[A-Za-z_]\w*(\(\)\.[A-Za-z_]\w*)?$/.test(e.method ?? '')) err(where, 'method는 메서드 이름이거나 null이어야 합니다');
        if (e.suggested !== null && !isString(e.suggested)) err(where, 'suggested는 문자열이거나 null이어야 합니다');
        if (e.proposal !== null && !PROPOSALS.includes(e.proposal)) err(where, `proposal은 ${PROPOSALS.join(', ')} 중 하나이거나 null이어야 합니다`);
        if (!/^https?:\/\//.test(e.spec ?? '')) err(where, 'spec은 URL이어야 합니다');
        if ((e.status === 'integrated' || e.status === 'extended') && e.method === null) err(where, `${e.status} 항목에는 method가 필요합니다`);
        if (e.status === 'missing' && e.method !== null) err(where, 'missing 항목의 method는 null이어야 합니다');
        if ('priority' in e) {
            if (e.status !== 'missing') err(where, 'priority는 missing 항목에만 씁니다');
            else if (!Number.isInteger(e.priority) || e.priority < 1) err(where, 'priority는 1 이상의 정수여야 합니다');
            else if (Object.keys(priorityLabels).length > 0 && !(String(e.priority) in priorityLabels)) err(where, `priorities에 ${e.priority} 설명이 없습니다`);
        }
    });
    if (b.priorities !== undefined && (!isObject(b.priorities) || Object.entries(b.priorities).some(([k, v]) => !/^\d+$/.test(k) || !isString(v)))) err(at, 'priorities는 { "번호": "설명" }이어야 합니다');
}

function validateUnique(b, at, err) {
    if (!Array.isArray(b.uniqueFeatures) || b.uniqueFeatures.length === 0) { err(at, 'uniqueFeatures가 비어 있습니다'); return; }
    const ids = new Set((b.apis ?? []).map((e) => e.id));
    b.uniqueFeatures.forEach((u, i) => {
        const where = `${at} uniqueFeatures[${i}]`;
        if (!isString(u?.name) || !isString(u?.scope)) err(where, 'name과 scope가 필요합니다');
        if (!['지원', '부분', '미구현'].includes(u?.support)) err(where, 'support는 지원, 부분, 미구현 중 하나여야 합니다');
        if (!Array.isArray(u?.apis)) err(where, 'apis는 배열이어야 합니다');
        else for (const id of u.apis) if (!ids.has(id)) err(where, `apis에 자료에 없는 id가 있습니다: ${id}`);
    });
}

function validateFeatures(data, err) {
    const f = data.features;
    const at = 'features.json';
    if (!isObject(f)) { err(at, '객체가 아닙니다'); return; }
    if (f.schemaVersion !== 1) err(at, 'schemaVersion은 1이어야 합니다');
    if (JSON.stringify(f.brokers) !== JSON.stringify(BROKERS)) err(at, `brokers는 ${JSON.stringify(BROKERS)} 여야 합니다`);
    if (!Array.isArray(f.features) || f.features.length === 0) { err(at, 'features가 비어 있습니다'); return; }
    const seen = new Set();
    f.features.forEach((row, i) => {
        const where = `${at} features[${i}]${isString(row?.id) ? ` (${row.id})` : ''}`;
        if (!isObject(row)) { err(where, '객체가 아닙니다'); return; }
        for (const key of ['id', 'name', 'group']) if (!isString(row[key])) err(where, `${key}가 비어 있습니다`);
        if (seen.has(row.id)) err(where, 'id가 중복됩니다');
        seen.add(row.id);
        for (const key of ['hasKeys', 'methods']) if (!Array.isArray(row[key]) || row[key].some((v) => !isString(v))) err(where, `${key}는 문자열 배열이어야 합니다`);
        for (const broker of BROKERS) {
            const cell = row.cells?.[broker];
            const cellAt = `${where} ${broker}`;
            if (!isObject(cell)) { err(cellAt, '셀이 없습니다'); continue; }
            for (const key of Object.keys(cell)) if (!['status', 'constraint', 'note', 'methods', 'apis'].includes(key)) err(cellAt, `알 수 없는 키 ${key}`);
            if ('note' in cell && !isString(cell.note)) err(cellAt, 'note는 비어 있지 않은 문자열이어야 합니다');
            if (!CELL_STATUSES.includes(cell.status)) { err(cellAt, `status는 ${CELL_STATUSES.join(', ')} 중 하나여야 합니다`); continue; }
            if ('constraint' in cell && (!isString(cell.constraint) || /[.!?]$/.test(cell.constraint))) err(cellAt, 'constraint는 마침표 없는 문장이어야 합니다');
            if (cell.status === '부분' && !isString(cell.constraint)) err(cellAt, '부분 셀에는 constraint가 필요합니다');
            if (cell.status === '미검증' && !isString(cell.constraint)) err(cellAt, '미검증 셀에는 constraint가 필요합니다');
            const methods = cell.methods ?? row.methods;
            const implemented = IMPLEMENTED_CELL_STATUSES.includes(cell.status);
            if (implemented && methods.length === 0) err(cellAt, `${cell.status} 셀에는 메서드가 필요합니다`);
            if (!implemented && 'methods' in cell) err(cellAt, `${cell.status} 셀에는 methods를 쓰지 않습니다`);
            if (cell.status === '증권사 없음' && (cell.apis ?? []).length > 0) err(cellAt, '증권사 없음 셀에는 apis를 쓰지 않습니다');
            for (const id of cell.apis ?? []) {
                const api = data.brokers[broker]?.apis?.find((e) => e.id === id);
                if (api === undefined) err(cellAt, `apis에 자료에 없는 id가 있습니다: ${id}`);
                else if (implemented && cell.status !== '대체' && api.status === 'missing') err(cellAt, `${cell.status} 셀이 미구현 API를 가리킵니다: ${id}`);
            }
        }
    });
}

// ============================================================================
// 조각
// ============================================================================

const code = (text) => `\`${text}\``;

/** 표 셀에 넣을 문자열. 세로줄과 줄바꿈을 막는다. */
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

const sentence = (text) => (/[.!?)]$/.test(text) ? text : `${text}.`);

function pct(part, whole) {
    if (whole === 0) return '0.0%';
    return `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%`;
}

function tally(apis) {
    const t = { total: apis.length, integrated: 0, extended: 0, implicit: 0, internal: 0, missing: 0 };
    for (const e of apis) t[e.status] += 1;
    t.supported = t.integrated + t.extended;
    t.reachable = t.supported + t.implicit + t.internal;
    return t;
}

function tallyRow(label, apis) {
    const t = tally(apis);
    return `| ${label} | ${t.total} | ${t.integrated} | ${t.extended} | ${t.implicit + t.internal} | ${t.missing} | ${pct(t.supported, t.total)} (${t.supported}/${t.total}) | ${pct(t.reachable, t.total)} (${t.reachable}/${t.total}) |`;
}

const TALLY_HEADER = ['| 구분 | 공식 API 수 | 통합 | 확장 | 암묵과 내부 | 미구현 | 통합과 확장 기준 | 암묵과 내부 포함 기준 |', '|---|---:|---:|---:|---:|---:|---:|---:|'];

/** 기능 이름 칸. ccxt 메서드 이름이면 코드로 덧붙인다. */
function featureLabel(row) {
    return /^(fetch|create|cancel|edit)[A-Z]/.test(row.id) ? `${row.name} ${code(row.id)}` : row.name;
}

/** 기능 × 증권사 표. 제약 열에는 셀의 제약 메모를 증권사별로 모은다. */
export function renderFeatureMatrix(features, { grouped = false } = {}) {
    const header = ['| 기능 | `kis` | `toss` | `kbsec` | 제약 |', '|---|---|---|---|---|'];
    const line = (row) => {
        const constraints = BROKERS.filter((b) => row.cells[b].constraint).map((b) => `${code(b)} ${sentence(row.cells[b].constraint)}`);
        return `| ${cell(featureLabel(row))} | ${BROKERS.map((b) => row.cells[b].status).join(' | ')} | ${cell(constraints.join('<br>'))} |`;
    };
    if (!grouped) return [...header, ...features.features.map(line)].join('\n');
    const groups = [...new Set(features.features.map((r) => r.group))];
    return groups.map((g) => [`### ${g}`, '', ...header, ...features.features.filter((r) => r.group === g).map(line)].join('\n')).join('\n\n');
}

/** 셀에 판단 근거(note)가 있는 기능 목록. 표의 값이 어떤 근거로 정해졌는지 보인다. */
export function renderCellNotes(features) {
    const rows = [];
    for (const row of features.features) {
        for (const b of BROKERS) {
            const c = row.cells[b];
            if (c.note) rows.push(`| ${cell(row.name)} | ${code(b)} | ${c.status} | ${cell(c.note)} |`);
        }
    }
    if (rows.length === 0) return '';
    return ['| 기능 | 증권사 | 값 | 판단 근거 |', '|---|---|---|---|', ...rows].join('\n');
}

/** README 에 끼우는 한 줄 요약. 공식 API 대비 지원 비율(통합과 확장 기준). */
export function renderCoverageSummary(data) {
    const parts = BROKERS.map((id) => {
        const t = tally(data.brokers[id].apis);
        return `${code(id)} ${pct(t.supported, t.total)}(${t.supported}/${t.total})`;
    });
    return `공식 API 대비 지원 비율은 ${parts.join(', ')}입니다. 통합 메서드나 확장 메서드로 호출하는 API만 집계했습니다.`;
}

function specLink(e) {
    const url = e.spec;
    const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
    const base = url.split('#')[0].split('/').pop() ?? '';
    const text = hash !== '' && !hash.startsWith('/') ? hash : (hash.startsWith('/') ? '명세' : base || '명세');
    return `[${cell(text)}](${url})`;
}

function methodCell(e, lang) {
    if (e.method === null) return '-';
    const shown = e.method.split('().').map(lang.formatMethod).join('().');
    return code(shown);
}

function marketCell(e) {
    return e.markets.map((m) => MARKET_LABEL[m]).join(', ');
}

function categoryTable(apis, lang) {
    const rows = apis.map((e) => `| ${cell(e.name)} | ${code(cell(e.endpoint))} | ${marketCell(e)} | ${API_STATUS_LABEL[e.status]} | ${methodCell(e, lang)} | ${code(e.verified)} | ${e.suggested ? `${code(cell(e.suggested))}${e.proposal ? ` (${cell(e.proposal)})` : ''}` : '-'} | ${specLink(e)} | ${e.status === 'missing' ? '' : cell(e.note)} |`);
    return ['| API 이름 | 엔드포인트 | 시장 | 상태 | 메서드 | 검증 | 제안 | 명세 | 비고 |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

function details(summary, body) {
    return ['<details>', `<summary>${summary}</summary>`, '', body, '', '</details>'].join('\n');
}

function unique(list) {
    return [...new Set(list)];
}

// ============================================================================
// 증권사 문서
// ============================================================================

function renderSummaryTable(b) {
    const p = b.profile;
    const credentialRows = ['apiKey', 'secret', 'uid'].map((k) => {
        const c = p.credentials[k];
        return `| 인증 필드 ${code(k)} | ${cell(`${c.label}${c.required ? '' : ', 선택'}${c.note ? `. ${c.note}` : ''}`)} |`;
    });
    const t = tally(b.apis);
    return [
        '| 항목 | 내용 |',
        '|---|---|',
        `| 클래스 | ${code(p.class)} |`,
        ...credentialRows,
        `| 모의투자 | ${p.sandbox.supported ? '지원합니다' : '지원하지 않습니다'}. ${cell(p.sandbox.note)} |`,
        `| 지원 시장 | ${p.markets.map((m) => `${MARKET_LABEL[m]}(${m})`).join(', ')} |`,
        `| 호출 한도 | ${cell(p.rateLimit.note)} |`,
        `| 공식 API | ${t.total}개 중 통합 ${t.integrated}개, 확장 ${t.extended}개, 암묵과 내부 ${t.implicit + t.internal}개, 미구현 ${t.missing}개 |`,
        `| 커버리지 | 통합과 확장 기준 ${pct(t.supported, t.total)}, 암묵과 내부 포함 기준 ${pct(t.reachable, t.total)} |`,
    ].join('\n');
}

function topOf(category) {
    return category.split(' > ')[0];
}

function subOf(category) {
    const i = category.indexOf(' > ');
    return i < 0 ? null : category.slice(i + 3);
}

/** GitHub 제목 링크. 소문자로 바꾸고 글자, 숫자, 공백, 하이픈만 남긴 뒤 공백을 하이픈으로 바꾼다. */
function anchor(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}

function renderToc(b) {
    const tops = unique(b.apis.map((e) => topOf(e.category)));
    const sections = ['요약', '커버리지 요약', '출처', '카테고리별 공식 API', '이 증권사에서만 쓰는 기능', '알려진 한계', '미구현 API'];
    return sections.map((name) => {
        const line = `- [${name}](#${anchor(name)})`;
        return name === '카테고리별 공식 API' ? [line, ...tops.map((top) => `  - [${cell(top)}](#${anchor(top)})`)].join('\n') : line;
    }).join('\n');
}

function renderCategorySummary(b) {
    const tops = unique(b.apis.map((e) => topOf(e.category)));
    const lines = [...TALLY_HEADER, ...tops.map((top) => tallyRow(cell(top), b.apis.filter((e) => topOf(e.category) === top))), tallyRow('**합계**', b.apis)];
    return lines.join('\n');
}

function renderCategories(b, lang) {
    const tops = unique(b.apis.map((e) => topOf(e.category)));
    const hasSub = b.apis.some((e) => subOf(e.category) !== null);
    const out = [];
    for (const top of tops) {
        const inTop = b.apis.filter((e) => topOf(e.category) === top);
        out.push(`### ${top}`);
        const subs = unique(inTop.map((e) => subOf(e.category)));
        if (!hasSub || (subs.length === 1 && subs[0] === null)) {
            out.push(categoryTable(inTop, lang));
            continue;
        }
        for (const sub of subs) {
            const rows = inTop.filter((e) => subOf(e.category) === sub);
            const supported = rows.filter((e) => e.status === 'integrated' || e.status === 'extended').length;
            const label = `${sub ?? top}: ${rows.length}개 중 ${supported}개 지원`;
            out.push(details(label, categoryTable(rows, lang)));
        }
    }
    return out.join('\n\n');
}

function renderUniqueFeatures(b) {
    const rows = b.uniqueFeatures.map((u) => `| ${cell(u.name)} | ${u.support} | ${u.apis.length === 0 ? '-' : `${u.apis.length}개`} | ${cell(u.scope)} |`);
    return ['| 기능 | 지원 | 관련 API | 지원 범위 |', '|---|---|---:|---|', ...rows].join('\n');
}

function priorityKey(e) {
    return e.priority ?? Number.MAX_SAFE_INTEGER;
}

function proposalRank(e) {
    const i = PROPOSALS.indexOf(e.proposal);
    return i < 0 ? PROPOSALS.length : i;
}

function renderMissing(b) {
    const missing = b.apis.map((e, index) => ({ e, index })).filter(({ e }) => e.status === 'missing');
    missing.sort((x, y) => priorityKey(x.e) - priorityKey(y.e) || proposalRank(x.e) - proposalRank(y.e) || x.index - y.index);
    const groups = [];
    for (const { e } of missing) {
        const key = e.priority !== undefined ? `우선순위 ${e.priority}` : `우선순위 미정, ${e.proposal ? `${e.proposal} 제안` : '제안 없음'}`;
        const label = e.priority !== undefined && b.priorities?.[String(e.priority)] ? `${key}(${b.priorities[String(e.priority)]})` : key;
        const last = groups[groups.length - 1];
        if (last && last.key === key) last.rows.push(e);
        else groups.push({ key, label, rows: [e] });
    }
    const intro = [
        `미구현 API는 ${missing.length}개입니다. 우선순위는 작은 수가 먼저입니다.`,
        '우선순위가 없는 API는 제안 유형(통합, params 확대, 확장, watch*) 순으로 정렬합니다.',
        '제안 메서드 이름은 설계 후보이고 확정한 이름이 아닙니다.',
    ].join(' ');
    const header = ['| API 이름 | 엔드포인트 | 시장 | 제안 메서드 | 제안 유형 | 명세 | 비고 |', '|---|---|---|---|---|---|---|'];
    const table = (rows) => [...header, ...rows.map((e) => `| ${cell(e.name)} | ${code(cell(e.endpoint))} | ${marketCell(e)} | ${e.suggested ? code(cell(e.suggested)) : '-'} | ${e.proposal ? cell(e.proposal) : '-'} | ${specLink(e)} | ${cell(e.note)} |`)].join('\n');
    const blocks = groups.map((g) => {
        const title = `${g.label}: ${g.rows.length}개`;
        return g.rows.length > 20 ? [`### ${g.label}`, '', details(`${g.rows.length}개 보기`, table(g.rows))].join('\n') : [`### ${title}`, '', table(g.rows)].join('\n');
    });
    return [intro, ...blocks].join('\n\n');
}

export function renderBrokerDoc(data, id, lang = LANGUAGES.typescript) {
    const b = data.brokers[id];
    const out = [
        `<!-- ${GENERATED_NOTICE} -->`,
        `# ${b.name}(${code(id)}) 지원 현황`,
        `> ${GENERATED_NOTICE}`,
        `조사일은 ${b.checkedOn}입니다. 증권사 API를 호출하지 않고 공식 명세와 저장소의 소스를 대조했습니다.`,
        '전체 기능 표는 [기능별 지원](README.md#기능별-지원)에 있습니다.',
        '## 목차',
        renderToc(b),
        '## 요약',
        renderSummaryTable(b),
        '## 커버리지 요약',
        '웹소켓 채널도 API 1개로 집계합니다. 값의 뜻은 [표기 규칙](README.md#표기-규칙)에 있습니다.',
        renderCategorySummary(b),
        '## 출처',
        ['| 출처 | 주소 |', '|---|---|', ...b.sources.map((s) => `| ${cell(s.name)} | ${s.url} |`)].join('\n'),
        '## 카테고리별 공식 API',
        renderCategories(b, lang),
        '## 이 증권사에서만 쓰는 기능',
        'ccxt의 통합 메서드로 표현하기 어려운 증권사 고유 기능입니다.',
        renderUniqueFeatures(b),
        '## 알려진 한계',
        b.limitations.map((l) => `- ${l}`).join('\n'),
        '## 미구현 API',
        renderMissing(b),
    ];
    return `${out.join('\n\n')}\n`;
}

// ============================================================================
// 색인 문서
// ============================================================================

function renderNotation() {
    return [
        '### 기능 표의 값',
        [
            '| 값 | 뜻 |',
            '|---|---|',
            '| 지원 | 증권사가 지원하는 시장에서 모두 구현했습니다. |',
            '| 부분 | 시장이나 조건에 제한이 있습니다. 제한 내용은 제약 열에 적었습니다. |',
            '| 대체 | 증권사 API에 같은 조회가 없어서 다른 조회 결과로 만든 값입니다. ccxt의 `emulated`입니다. |',
            '| 증권사 없음 | 증권사의 공식 API 목록에 같은 기능이 없습니다. |',
            '| 미구현 | 증권사에는 API가 있지만 라이브러리가 아직 구현하지 않았습니다. |',
            '| 미검증 | 구현했지만 실호출로 확인하지 못한 시장이나 조건이 있습니다. |',
        ].join('\n'),
        '`부분`과 `미검증` 조건이 함께 있으면 `부분`으로 적습니다. 제약 열은 증권사별로 나누어 적습니다.',
        '### 공식 API 항목의 상태',
        [
            '| 값 | 뜻 |',
            '|---|---|',
            '| 통합(`integrated`) | ccxt 통합 메서드가 응답의 주된 출처입니다. |',
            '| 확장(`extended`) | 전용 공개 메서드가 응답을 반환합니다. |',
            '| 암묵(`implicit`) | `api` 트리에만 있고 `privateGet...` 같은 암묵 메서드로 직접 호출합니다. 공개 메서드는 없습니다. |',
            '| 내부(`internal`) | 다른 메서드가 내부에서만 호출합니다. |',
            '| 미구현(`missing`) | 연결하지 않았습니다. |',
        ].join('\n'),
        '### 검증 수준',
        [
            '| 값 | 뜻 |',
            '|---|---|',
            '| `real` | 실계좌 응답으로 확인했습니다. |',
            '| `sandbox` | 모의투자 서버 응답으로 확인했습니다. |',
            '| `spec-only` | 공식 명세나 예제만 보고 구현했고 호출 기록을 확인하지 못했습니다. 미구현 API에도 `spec-only`를 적습니다. |',
            '| `unverified` | 구현했지만 명세나 예제와 어긋나 동작을 의심합니다. |',
        ].join('\n'),
        '### 그 밖의 표기',
        [
            '- 시장은 국내(KR)와 미국(US)으로 적습니다.',
            '- 메서드 이름은 ccxt 표준 camelCase 이름을 정본으로 씁니다.',
            '- 제안 유형 `통합`은 ccxt 통합 메서드에 넣을 수 있다는 뜻입니다.',
            '- 제안 유형 `확장`은 전용 메서드가 필요하다는 뜻입니다.',
            '- 제안 유형 `params 확대`는 기존 메서드의 `params`를 늘린다는 뜻입니다.',
            '- 제안 유형 `watch*`는 ccxt pro 방식의 구독 메서드를 뜻합니다.',
            '- 실계좌 검증은 만든 사람이 가진 계좌로 확인한 범위까지만 했습니다.',
        ].join('\n'),
    ].join('\n\n');
}

export function renderIndexDoc(data) {
    const links = BROKERS.map((id) => `- [${data.brokers[id].name}(${code(id)})](${id}.md)`).join('\n');
    const out = [
        `<!-- ${GENERATED_NOTICE} -->`,
        '# 증권사별 지원 현황',
        `> ${GENERATED_NOTICE}`,
        '세 증권사의 공식 API를 라이브러리가 얼마나 지원하는지 정리한 문서입니다.',
        `증권사별 상세 표는 다음 문서에 있습니다.\n\n${links}`,
        '## 표기 규칙',
        renderNotation(),
        '## 기능별 지원',
        '같은 기능을 세 증권사가 어떻게 지원하는지 비교한 표입니다. 각 값의 뜻은 [표기 규칙](#표기-규칙)에 있습니다.',
        renderFeatureMatrix(data.features, { grouped: true }),
        ...(renderCellNotes(data.features) === '' ? [] : ['### 판단 근거', '값을 정하는 데 판단이 들어간 셀입니다.', renderCellNotes(data.features)]),
        '## 공식 API 커버리지',
        renderCoverageSummary(data),
        [...TALLY_HEADER, ...BROKERS.map((id) => tallyRow(`[${code(id)}](${id}.md)`, data.brokers[id].apis))].join('\n'),
        '웹소켓 채널도 API 1개로 집계합니다. 카테고리별 수치는 증권사별 문서에 있습니다.',
    ];
    return `${out.join('\n\n')}\n`;
}

// ============================================================================
// 생성과 검사
// ============================================================================

/**
 * 자료로 문서를 만든다.
 * @returns {Map<string, string>} 패키지 루트 기준 경로 → 내용
 */
export function generateAll(data) {
    const files = new Map();
    for (const lang of Object.values(LANGUAGES)) {
        files.set(`${lang.outDir}/README.md`, renderIndexDoc(data));
        for (const id of BROKERS) files.set(`${lang.outDir}/${id}.md`, renderBrokerDoc(data, id, lang));
    }
    return files;
}

async function listGenerated(root) {
    const found = [];
    for (const lang of Object.values(LANGUAGES)) {
        try {
            for (const name of await readdir(path.join(root, lang.outDir))) if (name.endsWith('.md')) found.push(`${lang.outDir}/${name}`);
        } catch { /* 폴더가 아직 없다 */ }
    }
    return found;
}

/**
 * 커밋된 문서가 자료와 같은지 비교한다.
 * @returns {Promise<string[]>} 다른 파일마다 한 줄. 비어 있으면 같다.
 */
export async function checkGenerated(root = PACKAGE_ROOT) {
    const data = await loadCoverage(root);
    const problems = validateCoverage(data);
    if (problems.length > 0) return problems;
    const expected = generateAll(data);
    const diffs = [];
    for (const [rel, text] of expected) {
        let actual = null;
        try { actual = await readFile(path.join(root, rel), 'utf8'); } catch { /* 없다 */ }
        if (actual === null) diffs.push(`${rel}: 파일이 없습니다`);
        else if (actual !== text) diffs.push(`${rel}: 자료로 만든 내용과 다릅니다`);
    }
    for (const rel of await listGenerated(root)) if (!expected.has(rel)) diffs.push(`${rel}: 생성기가 만들지 않는 파일입니다`);
    return diffs;
}

export async function writeGenerated(root = PACKAGE_ROOT) {
    const data = await loadCoverage(root);
    const problems = validateCoverage(data);
    if (problems.length > 0) throw new Error(`자료가 스키마에 맞지 않습니다:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    const files = generateAll(data);
    for (const [rel, text] of files) {
        await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await writeFile(path.join(root, rel), text);
    }
    return [...files.keys()];
}

async function main() {
    const argv = process.argv.slice(2);
    const rootIndex = argv.indexOf('--root');
    const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : PACKAGE_ROOT;
    if (argv.includes('--check')) {
        const diffs = await checkGenerated(root);
        if (diffs.length > 0) {
            console.error('지원 범위 문서가 자료와 맞지 않습니다:');
            for (const d of diffs) console.error(`  ${d}`);
            console.error('`pnpm docs:gen`을 실행해 문서를 다시 만들고 함께 커밋하십시오.');
            process.exit(1);
        }
        console.log('지원 범위 문서가 자료와 같습니다.');
        return;
    }
    const written = await writeGenerated(root);
    console.log(`문서 ${written.length}개를 썼습니다:\n${written.map((f) => `  ${f}`).join('\n')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
