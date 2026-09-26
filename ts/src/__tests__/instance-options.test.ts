/**
 * @fileoverview 인스턴스 옵션 — 토큰 저장소·기능 옵션·체결 확정 예산·마스터 데이터가 전역 설정 없이 인스턴스마다 따로 동작하는지 고정한다.
 *
 * ccxt 처럼 `new kis({ ..., options })` 로 넘긴 값이 그 인스턴스에만 적용되고, 값이 함수면 쓸 때마다 다시 읽는다.
 */
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { kis } from '../kis';
import { toss } from '../toss';
import { kbsec } from '../kbsec';
import type { BrokerTokenStore } from '../options';
import { KIS_MASTER_FIXTURE } from './support/kis-master-fixture';

const kisWith = (options: Record<string, unknown> = {}): kis => new kis({ apiKey: 'app-key-123456789', secret: 'secret', uid: '12345678-01', options });

const fakeStore = (): BrokerTokenStore => ({
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    deleteIfAccessTokenEquals: async () => false,
    tryLock: async () => true,
    unlock: async () => undefined,
});

describe('getTokenStore — options.tokenStore', () => {
    it('옵션을 주지 않으면 저장소가 없다(프로세스 메모리 캐시만 쓴다)', () => {
        expect(kisWith().getTokenStore()).toBeNull();
        expect(new toss({ apiKey: 'c', secret: 's' }).getTokenStore()).toBeNull();
        expect(new kbsec({ apiKey: 'a', secret: 's' }).getTokenStore()).toBeNull();
    });

    it('저장소를 그대로 넘길 수 있다', () => {
        const store = fakeStore();

        const got = kisWith({ tokenStore: store }).getTokenStore();

        expect(got).not.toBeNull();
        expect(got?.tryLock).toBe(store.tryLock);
    });

    it('★함수를 넘기면 부를 때마다 다시 부른다 — 나중에 생기는 저장소도 읽고, 없으면 null 이다', () => {
        let current: BrokerTokenStore | null = null;
        const broker = kisWith({ tokenStore: () => current });
        expect(broker.getTokenStore()).toBeNull();

        current = fakeStore();
        expect(broker.getTokenStore()).toBe(current);

        current = null;
        expect(broker.getTokenStore()).toBeNull();
    });

    it('인스턴스마다 따로다', () => {
        const a = kisWith({ tokenStore: fakeStore() });
        const b = kisWith();

        expect(a.getTokenStore()).not.toBeNull();
        expect(b.getTokenStore()).toBeNull();
    });
});

describe('isOptionEnabled — 켜고 끄는 옵션', () => {
    it('옵션이 없으면 꺼져 있다', async () => {
        expect(await kisWith().isOptionEnabled('nxtRouting')).toBe(false);
    });

    it('불리언을 그대로 읽는다', async () => {
        expect(await kisWith({ nxtRouting: true }).isOptionEnabled('nxtRouting')).toBe(true);
        expect(await kisWith({ nxtRouting: false }).isOptionEnabled('nxtRouting')).toBe(false);
    });

    it('★함수는 부를 때마다 읽는다 — 동기 값과 Promise 를 모두 받는다', async () => {
        let on = false;
        const sync = kisWith({ nxtRouting: () => on });
        const async = kisWith({ nxtRouting: async () => on });

        expect(await sync.isOptionEnabled('nxtRouting')).toBe(false);
        expect(await async.isOptionEnabled('nxtRouting')).toBe(false);

        on = true;
        expect(await sync.isOptionEnabled('nxtRouting')).toBe(true);
        expect(await async.isOptionEnabled('nxtRouting')).toBe(true);
    });

    it('true 가 아닌 값은 꺼진 것이다 — 문자열 "false" 나 1 을 켜짐으로 읽지 않는다', async () => {
        expect(await kisWith({ nxtRouting: 'false' }).isOptionEnabled('nxtRouting')).toBe(false);
        expect(await kisWith({ nxtRouting: 1 }).isOptionEnabled('nxtRouting')).toBe(false);
        expect(await kisWith({ nxtRouting: () => 'yes' }).isOptionEnabled('nxtRouting')).toBe(false);
    });

    it('함수가 던지면 그대로 던진다 — 읽지 못한 값을 꺼짐으로 삼키지 않는다', async () => {
        const broker = kisWith({ nxtRouting: () => { throw new Error('flag store down'); } });

        await expect(broker.isOptionEnabled('nxtRouting')).rejects.toThrow('flag store down');
    });

    it('인스턴스마다 따로다', async () => {
        const on = kisWith({ nxtRouting: true });
        const off = kisWith();

        expect(await on.isOptionEnabled('nxtRouting')).toBe(true);
        expect(await off.isOptionEnabled('nxtRouting')).toBe(false);
    });
});

describe('getConfirmBudget — options.confirmBudget', () => {
    it('옵션이 없으면 증권사가 정한 기본값이고, 그것도 없으면 공용 기본값이다', () => {
        expect(kisWith().getConfirmBudget()).toEqual({ attempts: 6, intervalMs: 350 });
        expect(kisWith().getConfirmBudget({ attempts: 5, intervalMs: 1000 })).toEqual({ attempts: 5, intervalMs: 1000 });
    });

    it('옵션이 증권사 기본값을 이긴다 — 비워 둔 항목은 증권사 기본값이다', () => {
        const broker = kisWith({ confirmBudget: { intervalMs: 0 } });

        expect(broker.getConfirmBudget({ attempts: 5, intervalMs: 1000 })).toEqual({ attempts: 5, intervalMs: 0 });
    });

    it('★함수는 부를 때마다 읽는다', () => {
        let attempts = 2;
        const broker = kisWith({ confirmBudget: () => ({ attempts }) });
        expect(broker.getConfirmBudget().attempts).toBe(2);

        attempts = 4;
        expect(broker.getConfirmBudget().attempts).toBe(4);
    });

    it('범위를 벗어난 값은 무시하고 아래 층의 값을 쓴다', () => {
        const broker = kisWith({ confirmBudget: { attempts: 0, intervalMs: 99_999 } });

        expect(broker.getConfirmBudget({ attempts: 5, intervalMs: 1000 })).toEqual({ attempts: 5, intervalMs: 1000 });
    });

    it('★주문을 보낸 뒤에 부르므로 옵션 함수가 던지거나 객체가 아닌 값을 줘도 던지지 않고 아래 층의 값을 쓴다', () => {
        const defaults = { attempts: 5, intervalMs: 1000 };
        const throwing = kisWith({ confirmBudget: () => { throw new Error('boom'); } });
        expect(throwing.getConfirmBudget(defaults)).toEqual(defaults);
        expect(kisWith({ confirmBudget: () => Promise.resolve({ attempts: 2 }) }).getConfirmBudget(defaults)).toEqual(defaults);
        expect(kisWith({ confirmBudget: [3, 100] }).getConfirmBudget(defaults)).toEqual(defaults);
    });
});

describe('masterData — 인스턴스마다 자기 종목 데이터를 갖는다', () => {
    it('★두 인스턴스가 서로 다른 마스터로 종목을 만든다 — 전역 데이터가 없다', async () => {
        const withFixture = kisWith({ masterData: KIS_MASTER_FIXTURE });
        const empty = kisWith();

        const fixtureSymbols = (await withFixture.loadMarkets())['AAPL/USD'];
        const emptyMarkets = await empty.loadMarkets();

        expect(fixtureSymbols).toMatchObject({ id: 'AAPL', options: { exchange: 'NAS' } });
        expect(emptyMarkets['AAPL/USD']).toBeUndefined();
        expect(Object.keys(emptyMarkets).every((symbol) => symbol.endsWith('/KRW'))).toBe(true);   // 보충 종목만 남는다
    });

    it('넘긴 마스터 객체를 인스턴스가 바꾸지 않는다', () => {
        const before = JSON.stringify(KIS_MASTER_FIXTURE);

        kisWith({ masterData: KIS_MASTER_FIXTURE });

        expect(JSON.stringify(KIS_MASTER_FIXTURE)).toBe(before);
    });
});

describe('usdKrwRate — options.usdKrwRate', () => {
    it('KB 는 옵션이 없으면 원마켓 환산을 하지 못하고 던진다 — 환율을 지어내지 않는다', async () => {
        const broker = new kbsec({ apiKey: 'a', secret: 's', options: { krwIntegratedMargin: true } });
        // `callTr` 은 비공개 메서드라 그 모양만 적어 가로챈다.
        const call = vi.spyOn(broker as unknown as { callTr: () => Promise<unknown> }, 'callTr').mockImplementation(async () => ({ ordr_psbl_csh: '1000' }));
        vi.spyOn(broker, 'fetchOneMarketMargin').mockResolvedValue({ krwEquivalentForeign: 1_450_000 } as never);

        await expect(broker.fetchBalance()).rejects.toThrow('usdKrwRate');
        call.mockRestore();
    });
});

/** 주석을 뺀 소스. 설명문에 적힌 이름이 검사에 걸리지 않게 한다. */
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('환경 변수와 전역 설정', () => {
    /** 패키지의 비테스트 소스 파일. */
    function sourceFiles(dir: string, out: string[] = []): string[] {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) {
                if (name !== '__tests__' && name !== 'node_modules') sourceFiles(full, out);
            } else if (name.endsWith('.ts')) {
                out.push(full);
            }
        }
        return out;
    }
    const files = sourceFiles(path.resolve(__dirname, '..'));

    it('소스가 있다 — 빈 목록으로 아래 검사가 통과하지 않는다', () => {
        expect(files.length).toBeGreaterThan(50);
    });

    it('★패키지 소스가 환경 변수를 읽지 않는다 — 값은 옵션으로만 받는다', () => {
        const offenders = files.filter((file) => /process\.env/.test(strip(readFileSync(file, 'utf8'))));

        expect(offenders.map((file) => path.relative(path.resolve(__dirname, '..'), file))).toEqual([]);
    });

    it('★모듈 수준에서 바꾸는 설정 함수(configure*·register*)가 없다 — 로거(setLogger)만 라이브러리 전체에 하나다', () => {
        const offenders = files.filter((file) => /export\s+(?:async\s+)?function\s+(?:configure|register)[A-Z]\w*/.test(strip(readFileSync(file, 'utf8'))));

        expect(offenders.map((file) => path.relative(path.resolve(__dirname, '..'), file))).toEqual([]);
    });
});

describe('옵션 키 선언', () => {
    /** 증권사가 기본값을 선언하지 않고 사용자에게서만 받는 키. README 에 적힌 키(`allowInsecureUrl`, `hostAddr`, `htsId`)와 ccxt 관례의 키다. */
    const USER_ONLY_KEYS: ReadonlySet<string> = new Set(['allowInsecureUrl', 'hostAddr', 'htsId', 'sandbox', 'testnet', 'defaultSubType']);
    const BROKER_FILES: ReadonlyArray<readonly [string, () => { options: object }]> = [
        ['kis.ts', () => kisWith()],
        ['toss.ts', () => new toss({ apiKey: 'c', secret: 's' })],
        ['kbsec.ts', () => new kbsec({ apiKey: 'a', secret: 's' })],
    ];

    /**
     * 소스가 이름을 적어 읽는 옵션 키. `this.options.x`, `safeX(this.options, 'x')`(`safeX2` 는 앞의 두 키), `isOptionEnabled('x')`,
     * `handleOptionAndParams(params, path, 'x')`, `masterDataOf(this.options)` 를 본다. 이름을 변수로 받는 읽기는 보지 않는다.
     */
    function optionKeysRead(file: string): string[] {
        const text = strip(readFileSync(path.resolve(__dirname, '..', file), 'utf8'));
        const keys = [
            ...text.matchAll(/this\.options\.(\w+)/g),
            ...text.matchAll(/isOptionEnabled\(\s*'(\w+)'/g),
            ...text.matchAll(/handleOptionAndParams\([^,()]*,[^,()]*,\s*'(\w+)'/g),
        ].map((m) => m[1]!);
        for (const m of text.matchAll(/safe\w*?(2?)\(\s*this\.options\s*,\s*'(\w+)'(?:\s*,\s*'(\w+)')?/g)) {
            keys.push(m[2]!, ...(m[1] === '2' && m[3] !== undefined ? [m[3]] : []));
        }
        if (/masterDataOf\(\s*this\.options\s*\)/.test(text)) keys.push('masterData');
        return [...new Set(keys)];
    }

    it('★소스가 읽는 옵션 키는 증권사가 기본값을 선언했거나 사용자만 넘기는 키다 — 읽는 쪽과 선언 쪽의 키 오타를 잡는다', () => {
        const declared = BROKER_FILES.map(([file, make]) => [file, new Set(Object.keys(make().options))] as const);
        // 기반 클래스가 읽는 키는 한 증권사만 선언해도 된다(`defaultType` 은 KB, `maxRetriesOnFailure` 는 KIS 만 선언한다).
        const targets = [['base/Exchange.ts', new Set(declared.flatMap(([, keys]) => [...keys]))] as const, ...declared];
        const undeclared = targets.flatMap(([file, known]) => {
            const keys = optionKeysRead(file);
            expect(keys.length, `${file} 에서 읽는 옵션 키를 찾지 못했다`).toBeGreaterThan(0);
            return keys.filter((key) => !known.has(key) && !USER_ONLY_KEYS.has(key)).map((key) => `${file}: ${key}`);
        });

        expect(undeclared).toEqual([]);
    });
});
