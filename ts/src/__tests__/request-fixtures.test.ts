/**
 * @fileoverview `ts/src/test/static/request/*.json` 을 TypeScript 판으로 돌린다. Python 판(`python/<패키지>/test/test_request_fixtures.py`)도 같은 파일을 돌리므로,
 * 둘 다 통과하면 두 판이 같은 요청(URL·헤더·본문)을 만들고 같은 응답을 같은 결과와 오류로 바꾼다는 뜻이다.
 *
 * 케이스마다 새 인스턴스를 만들고, 가짜 `fetch` 가 `http` 목록을 순서대로 응답한다. 케이스에 `now` 가 있으면 `Date` 만 그 시각으로 고정한다
 * (호출 간격 조절기가 쓰는 `performance.now` 와 타이머는 그대로 둔다). 형식은 `ts/src/test/static/README.md` 에 있다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deepExtend } from '../base/functions/generic';
import type { Dict } from '../base/types';
import { kbsec } from '../kbsec';
import { kis } from '../kis';
import { __resetKbsecTokenBreaker, resetMarketCalendar } from '../testing';
import type { BrokerTokenStore } from '../options';
import { toss } from '../toss';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/static/request');
const BROKERS: Record<string, new (config: Dict) => Dict> = { kbsec, kis, toss } as unknown as Record<string, new (config: Dict) => Dict>;

interface FixtureRequest { method: string; url: string; headers: Record<string, string>; body: string | null }
interface FixtureExchange {
    request: FixtureRequest;
    response?: { status: number; headers?: Record<string, string>; body: unknown };
    network?: 'timeout' | 'reset';
}
interface FixtureCase {
    description: string;
    config?: Dict;
    tokenStore?: Record<string, unknown>;
    /** 현재 시각(UTC epoch ms). 있으면 `Date` 를 이 시각으로 고정한다. */
    now?: number;
    method: string;
    args: unknown[];
    http: FixtureExchange[];
    output?: unknown;
    /** `brokerCode` 의 `null` 은 "없어야 한다"이다(요청 전에 막은 오류). */
    error?: { class: string; detail?: string; brokerCode?: string | null };
    tokenStoreAfter?: Record<string, 'present' | 'absent'>;
}
interface FixtureFile { broker: string; config: Dict; tokenStore?: Record<string, unknown>; cases: FixtureCase[] }

/** 픽스처용 토큰 저장소. 값은 JSON 문자열로 둔다(실제 저장소와 같다). */
class MemoryTokenStore implements BrokerTokenStore {
    readonly values = new Map<string, string>();
    private readonly locks = new Map<string, string>();

    constructor(initial: Record<string, unknown> = {}) {
        for (const [key, value] of Object.entries(initial)) this.values.set(key, JSON.stringify(value));
    }

    async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
    async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
    async delete(key: string): Promise<void> { this.values.delete(key); }
    async deleteIfAccessTokenEquals(key: string, accessToken: string): Promise<boolean> {
        const raw = this.values.get(key);
        if (raw === undefined) return false;
        try {
            if ((JSON.parse(raw) as Dict).accessToken !== accessToken) return false;
        } catch {
            return false;
        }
        this.values.delete(key);
        return true;
    }
    async tryLock(key: string, owner: string): Promise<boolean> {
        if (this.locks.has(key)) return false;
        this.locks.set(key, owner);
        return true;
    }
    async unlock(key: string, owner: string): Promise<void> {
        if (this.locks.get(key) === owner) this.locks.delete(key);
    }
}

/** `null` 값은 "설정하지 않음" 이다(Python 판의 `None` 기본값과 맞춘다). */
function dropNulls(config: Dict): Dict {
    return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== null));
}

/**
 * 결과를 비교할 모양으로 바꾼다. 객체에서 값이 `null`·`undefined` 인 키를 뺀다. JSON 에는 `undefined` 가 없고 Python 판에는 둘의 구분이 없어서
 * 두 판 모두 "키 없음"으로 본다. 배열의 `undefined` 는 `null` 로 둔다.
 */
function comparable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : comparable(item)));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([, item]) => item !== undefined && item !== null)
            .map(([key, item]) => [key, comparable(item)]));
    }
    return value;
}

function fakeFetch(exchanges: FixtureExchange[], seen: FixtureRequest[]) {
    let index = 0;
    return vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        seen.push({ method: init.method ?? 'GET', url: String(url), headers: { ...(init.headers ?? {}) }, body: init.body ?? null });
        const exchange = exchanges[index++];
        if (exchange === undefined) throw new Error(`픽스처에 없는 요청: ${init.method ?? 'GET'} ${String(url)}`);
        if (exchange.network === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        if (exchange.network === 'reset') throw new TypeError('fetch failed');
        const reply = exchange.response as NonNullable<FixtureExchange['response']>;
        const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        // 야후 파이낸스 봉 조회처럼 `ok`·`json()` 을 읽는 코드가 있어 실제 `Response` 처럼 둘 다 준다.
        return {
            ok: reply.status >= 200 && reply.status < 300,
            status: reply.status,
            statusText: '',
            headers: new Headers(reply.headers ?? {}),
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
        };
    });
}

const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.json')).sort();

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // 휴장일 캘린더와 KB증권 토큰 차단기는 모듈 전역이라 앞 케이스의 상태가 다음 케이스에 섞이지 않게 비운다.
    resetMarketCalendar();
    __resetKbsecTokenBreaker();
});

describe.each(files)('test/static/request/%s', (file) => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as FixtureFile;
    const Broker = BROKERS[fixture.broker]!;

    it.each(fixture.cases.map((c) => [c.description, c] as const))('%s', async (_description, c) => {
        const store = new MemoryTokenStore(c.tokenStore ?? fixture.tokenStore ?? {});
        const config = dropNulls(deepExtend(fixture.config, c.config ?? {}, { options: { tokenStore: store } }) as Dict);
        const seen: FixtureRequest[] = [];
        vi.stubGlobal('fetch', fakeFetch(c.http, seen));
        if (c.now !== undefined) {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(c.now);
        }
        const broker = new Broker(config);
        // 인자의 `null` 은 "주지 않음"(`undefined`)이다. 인자가 사전이면 그 값의 `null` 도 같다. Python 판의 `None` 과 맞춘다.
        const absent = (value: unknown): unknown => (value === null ? undefined : value);
        const args = c.args.map((arg) => (arg !== null && typeof arg === 'object' && !Array.isArray(arg)
            ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, absent(value)]))
            : absent(arg)));

        let result: unknown;
        let error: unknown;
        try {
            result = await (broker[c.method] as (...args: unknown[]) => Promise<unknown>)(...args);
        } catch (e) {
            error = e;
        }

        expect(seen).toEqual(c.http.map((h) => h.request));
        if (c.error !== undefined) {
            expect(error, '오류를 던져야 한다').toBeInstanceOf(Error);
            expect((error as Error).name).toBe(c.error.class);
            if (c.error.detail !== undefined) expect((error as { detail?: string }).detail).toBe(c.error.detail);
            if (c.error.brokerCode !== undefined) expect((error as { brokerCode?: string }).brokerCode ?? null).toBe(c.error.brokerCode);
        } else {
            if (error !== undefined) throw error;
            expect(comparable(result)).toEqual(comparable(c.output));
        }
        for (const [key, state] of Object.entries(c.tokenStoreAfter ?? {})) {
            expect(store.values.has(key), `${key} 는 ${state} 여야 한다`).toBe(state === 'present');
        }
    });
});
