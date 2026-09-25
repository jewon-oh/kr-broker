/**
 * KIS 범용 실시간 구독(`KisRealtimeStream`): 구독과 해지 프레임, 필드 이름 붙이기, 체결통보 복호, 구독 실패 알림.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCipheriv } from 'node:crypto';

import { logger } from '../../logger';
import { KisRealtimeStream, decryptKisPayload, splitKisRealtimeRecords, type KisRealtimeRecord } from '../kis-realtime-stream';
import { KIS_REALTIME_COLUMNS, kisRealtimeColumns } from '../kis-realtime-columns';
import { newKis } from './support/kis-test-utils';

type FakeListener = (ev: Record<string, unknown>) => void;

/** `addEventListener`만 흉내 내고 보낸 프레임을 기록한다. */
class FakeWs {
    static instances: FakeWs[] = [];
    readyState = 1;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, FakeListener[]>();

    constructor(public readonly url: string) {
        FakeWs.instances.push(this);
    }

    addEventListener(type: string, cb: FakeListener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
    }

    send(data: string): void { this.sent.push(data); }
    close(): void { this.readyState = 3; }

    emit(type: string, ev: Record<string, unknown> = {}): void {
        for (const cb of this.listeners.get(type) ?? []) cb(ev);
    }
}

type GlobalWithWs = { WebSocket?: unknown };
const g = globalThis as GlobalWithWs;
const originalWebSocket = g.WebSocket;

beforeEach(() => {
    FakeWs.instances = [];
    g.WebSocket = FakeWs as unknown as typeof WebSocket;
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    if (originalWebSocket === undefined) delete g.WebSocket;
    else g.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
});

/** 비동기 연결(생성자 해석, approval_key 발급)이 끝날 때까지 기다린다. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const KEY = '0123456789abcdef0123456789abcdef';
const IV = 'fedcba9876543210';

const encrypt = (plain: string): string => {
    const cipher = createCipheriv('aes-256-cbc', Buffer.from(KEY, 'utf8'), Buffer.from(IV, 'utf8'));
    return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
};

describe('필드 이름과 건수 나누기', () => {
    it('필드 이름을 아는 TR 은 필드 수로 나눠 이름을 붙인다', () => {
        const columns = KIS_REALTIME_COLUMNS.H0IFCNT0!;
        const one = columns.map((_, i) => String(i));
        const records = splitKisRealtimeRecords('H0IFCNT0', 2, [...one, ...one.map((v) => `b${v}`)].join('^'));

        expect(records).toHaveLength(2);
        expect(records[0]!.fields?.[columns[0]!]).toBe('0');
        expect(records[1]!.fields?.[columns[columns.length - 1]!]).toBe(`b${columns.length - 1}`);
        expect(records[1]!.values).toHaveLength(columns.length);
    });

    it('모르는 TR 은 값 수를 건수로 나눈 길이로 자르고 이름을 붙이지 않는다', () => {
        const records = splitKisRealtimeRecords('H0XXXXX0', 2, 'a^b^c^d');

        expect(records).toEqual([{ trId: 'H0XXXXX0', values: ['a', 'b'], fields: undefined }, { trId: 'H0XXXXX0', values: ['c', 'd'], fields: undefined }]);
    });

    it('값이 필드 수보다 모자라면 건수로 나눈 길이로 자르고 있는 값만 이름을 붙인다', () => {
        const [record] = splitKisRealtimeRecords('H0STNAV0', 1, 'A005930^10500');

        expect(record!.values).toEqual(['A005930', '10500']);
        expect(Object.keys(record!.fields ?? {})).toHaveLength(2);
    });

    it('모의투자 체결통보 TR 은 실전 TR 의 필드 목록을 쓴다', () => {
        expect(kisRealtimeColumns('H0STCNI9')).toBe(KIS_REALTIME_COLUMNS.H0STCNI0);
        expect(kisRealtimeColumns('H0GSCNI9')).toBe(KIS_REALTIME_COLUMNS.H0GSCNI0);
        // 실시간 57개에 `watch*` 가 쓰는 국내 체결·호가(KRX)와 해외 체결 3개를 더했다.
        expect(Object.keys(KIS_REALTIME_COLUMNS)).toHaveLength(60);
    });
});

describe('체결통보 복호', () => {
    it('decryptKisPayload 는 key, iv 로 AES-CBC 복호한다', async () => {
        expect(await decryptKisPayload(encrypt('HTSID^12345678^0000000101'), KEY, IV)).toBe('HTSID^12345678^0000000101');
    });
});

describe('KisRealtimeStream', () => {
    const open = async (records: KisRealtimeRecord[], onSubscribeError = vi.fn()) => {
        const stream = new KisRealtimeStream({ getApprovalKey: async () => 'ak', isVirtual: true, onRecord: (r) => records.push(r), onSubscribeError });
        stream.subscribe('H0IFCNT0', '101W12');
        await flush();
        const ws = FakeWs.instances[0]!;
        ws.emit('open');
        return { stream, ws, onSubscribeError };
    };

    it('모의투자 주소로 접속하고, 열리면 등록 프레임을, 해지하면 tr_type 2 를 보낸다', async () => {
        const { stream, ws } = await open([]);
        stream.subscribe('H0IFCNT0', '101W12');
        stream.subscribe('H0IFASP0', '101W12');
        stream.unsubscribe('H0IFCNT0', '101W12');

        expect(ws.url).toBe('ws://ops.koreainvestment.com:31000/tryitout');
        const frames = ws.sent.map((s) => JSON.parse(s) as { header: Record<string, string>; body: { input: Record<string, string> } });
        expect(frames.map((f) => [f.header.tr_type, f.body.input.tr_id])).toEqual([['1', 'H0IFCNT0'], ['1', 'H0IFASP0'], ['2', 'H0IFCNT0']]);
        expect(frames[0]!.header).toMatchObject({ approval_key: 'ak', custtype: 'P', 'content-type': 'utf-8' });
        expect(frames[0]!.body.input.tr_key).toBe('101W12');
        stream.stop();
    });

    it('평문 프레임을 필드 이름으로 묶어 넘기고, PINGPONG 은 되돌려 보낸다', async () => {
        const records: KisRealtimeRecord[] = [];
        const { stream, ws } = await open(records);
        const values = KIS_REALTIME_COLUMNS.H0IFCNT0!.map((_, i) => (i === 0 ? '101W12' : String(i)));
        ws.emit('message', { data: `0|H0IFCNT0|001|${values.join('^')}` });
        const ping = '{"header":{"tr_id":"PINGPONG","datetime":"20260923101500"}}';
        ws.emit('message', { data: ping });
        await flush();

        expect(records).toHaveLength(1);
        expect(records[0]!.fields?.[KIS_REALTIME_COLUMNS.H0IFCNT0![0]!]).toBe('101W12');
        expect(ws.sent.at(-1)).toBe(ping);
        stream.stop();
    });

    it('구독 응답의 key, iv 로 체결통보를 복호해 넘긴다', async () => {
        const records: KisRealtimeRecord[] = [];
        const { stream, ws } = await open(records);
        stream.subscribe('H0STCNI9', 'HTSID');
        ws.emit('message', { data: JSON.stringify({ header: { tr_id: 'H0STCNI9', tr_key: 'HTSID', encrypt: 'N' }, body: { rt_cd: '0', msg1: 'SUBSCRIBE SUCCESS', output: { key: KEY, iv: IV } } }) });
        const values = KIS_REALTIME_COLUMNS.H0STCNI0!.map((_, i) => (i === 0 ? 'HTSID' : String(i)));
        ws.emit('message', { data: `1|H0STCNI9|001|${encrypt(values.join('^'))}` });
        await vi.waitFor(() => expect(records).toHaveLength(1));

        expect(records[0]!.trId).toBe('H0STCNI9');
        expect(records[0]!.fields?.[KIS_REALTIME_COLUMNS.H0STCNI0![0]!]).toBe('HTSID');
        stream.stop();
    });

    it('key 를 받기 전의 암호화 프레임은 버리고, 구독 실패는 알린다', async () => {
        const records: KisRealtimeRecord[] = [];
        const { stream, ws, onSubscribeError } = await open(records);
        ws.emit('message', { data: '1|H0GSCNI0|001|AAAA' });
        ws.emit('message', { data: JSON.stringify({ header: { tr_id: 'H0IFCNT0', tr_key: '101W12' }, body: { rt_cd: '9', msg1: 'MAX SUBSCRIBE OVER' } }) });
        await flush();

        expect(records).toHaveLength(0);
        expect(onSubscribeError).toHaveBeenCalledWith('H0IFCNT0', '101W12', 'MAX SUBSCRIBE OVER');
        stream.stop();
    });

    it('★암호화되지 않은 체결통보 프레임은 버린다 — 평문 연결 위에서 끼워 넣은 위조 체결을 받지 않는다', async () => {
        const records: KisRealtimeRecord[] = [];
        const { stream, ws } = await open(records);
        stream.subscribe('H0STCNI0', 'HTSID');
        const values = KIS_REALTIME_COLUMNS.H0STCNI0!.map((_, i) => (i === 0 ? 'HTSID' : String(i)));
        for (const trId of ['H0STCNI0', 'H0STCNI9', 'H0GSCNI0', 'H0GSCNI9']) ws.emit('message', { data: `0|${trId}|001|${values.join('^')}` });
        await flush();

        expect(records).toHaveLength(0);
        stream.stop();
    });

    it('접속 주소는 인스턴스의 urls.ws 를 따른다', async () => {
        const kis = newKis({ sandbox: false });
        kis.urls.ws = { public: 'wss://example.invalid:21000' };
        const stream = kis.createRealtimeStream(() => undefined);
        vi.spyOn(kis, 'getApprovalKey').mockResolvedValue('ak');
        stream.subscribe('H0IFCNT0', '101W12');
        await vi.waitFor(() => expect(FakeWs.instances).toHaveLength(1));

        expect(FakeWs.instances[0]!.url).toBe('wss://example.invalid:21000/tryitout');
        stream.stop();
    });

    it('kis.createRealtimeStream 은 모의투자 여부를 따라 KisRealtimeStream 을 만든다', () => {
        const stream = newKis({ sandbox: false }).createRealtimeStream(() => undefined);

        expect(stream).toBeInstanceOf(KisRealtimeStream);
        expect(stream.isConnected()).toBe(false);
    });
});

describe('다건 프레임의 레코드 길이', () => {
    it('값 수가 건수로 나눠떨어지면 그 몫으로 자른다 — KIS 가 필드를 뒤에 더해도 두 번째 건이 어긋나지 않는다', () => {
        const columns = KIS_REALTIME_COLUMNS.H0IFCNT0!;
        const one = [...columns.map((_, i) => String(i)), 'extra'];
        const records = splitKisRealtimeRecords('H0IFCNT0', 2, [...one, ...one.map((v) => `b${v}`)].join('^'));

        expect(records[1]!.fields?.[columns[0]!]).toBe('b0');
        expect(records[1]!.values).toHaveLength(columns.length + 1);
    });
});

describe('KisRealtimeStream 연결 수명', () => {
    const newStream = (overrides: Partial<ConstructorParameters<typeof KisRealtimeStream>[0]> = {}) =>
        new KisRealtimeStream({ getApprovalKey: async () => 'ak', isVirtual: true, onRecord: () => undefined, ...overrides });

    it('onRecord 가 던져도 같은 프레임의 나머지 건을 넘기고 처리되지 않은 거부를 남기지 않는다', async () => {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const seen: string[] = [];
            const stream = newStream({
                onRecord: (r) => {
                    seen.push(r.values[0]!);
                    if (seen.length === 1) throw new Error('boom');
                },
            });
            stream.subscribe('H0XXXXX0', 'K');
            await flush();
            FakeWs.instances[0]!.emit('open');
            FakeWs.instances[0]!.emit('message', { data: '0|H0XXXXX0|002|a^b^c^d' });
            await flush();
            await flush();

            expect(seen).toEqual(['a', 'c']);
            expect(unhandled).not.toHaveBeenCalled();
            stream.stop();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('소켓 생성이 던지면 로그를 남기고 재연결을 예약한다', async () => {
        vi.useFakeTimers();
        try {
            let calls = 0;
            g.WebSocket = class extends FakeWs {
                constructor(url: string) {
                    if (++calls === 1) throw new Error('bad url');
                    super(url);
                }
            } as unknown as typeof WebSocket;
            const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
            const stream = newStream();
            stream.subscribe('H0IFCNT0', '101W12');
            await vi.advanceTimersByTimeAsync(0);

            expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), '[KisRealtimeStream] WS 생성 실패 — 재연결 예약');
            await vi.advanceTimersByTimeAsync(2_000);
            expect(FakeWs.instances).toHaveLength(1);
            stream.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('접속키를 기다리는 사이에 stop() 을 부르면 소켓을 만들지 않는다', async () => {
        let release: (key: string) => void = () => undefined;
        const stream = newStream({ getApprovalKey: () => new Promise<string>((resolve) => { release = resolve; }) });
        stream.subscribe('H0IFCNT0', '101W12');
        await flush();

        stream.stop();
        release('ak');
        await flush();

        expect(FakeWs.instances).toHaveLength(0);
    });

    it('stop() 뒤 곧바로 다시 구독해도 연결은 하나다', async () => {
        const releases: Array<(key: string) => void> = [];
        const stream = newStream({ getApprovalKey: () => new Promise<string>((resolve) => { releases.push(resolve); }) });
        stream.subscribe('H0IFCNT0', '101W12');
        await flush();
        stream.stop();
        stream.subscribe('H0IFASP0', '101W12');
        await flush();

        for (const release of releases) release('ak');
        await flush();

        expect(FakeWs.instances).toHaveLength(1);
        stream.stop();
    });

    it('재연결은 옛 소켓을 닫고, 옛 소켓의 늦은 이벤트로 재연결이나 구독을 하지 않는다', async () => {
        vi.useFakeTimers();
        try {
            const getApprovalKey = vi.fn(async () => 'ak');
            const stream = newStream({ getApprovalKey });
            stream.subscribe('H0IFCNT0', '101W12');
            await vi.advanceTimersByTimeAsync(0);
            const first = FakeWs.instances[0]!;
            first.emit('open');
            first.emit('close', { code: 1006 });
            await vi.advanceTimersByTimeAsync(2_000);
            const second = FakeWs.instances[1]!;

            expect(first.readyState).toBe(3);
            first.emit('close', { code: 1006 });
            first.emit('open');
            await vi.advanceTimersByTimeAsync(30_000);

            expect(FakeWs.instances).toHaveLength(2);
            expect(getApprovalKey).toHaveBeenCalledTimes(2);
            expect(first.sent).toHaveLength(1);
            expect(second.sent).toHaveLength(0);
            stream.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('구독이 거부되면 그 구독을 지워, 다시 구독하면 등록 프레임을 또 보낸다', async () => {
        const onSubscribeError = vi.fn();
        const stream = newStream({ onSubscribeError });
        stream.subscribe('H0STCNT0', '005930');
        await flush();
        const ws = FakeWs.instances[0]!;
        ws.emit('open');
        ws.emit('message', { data: JSON.stringify({ header: { tr_id: 'H0STCNT0', tr_key: '005930' }, body: { rt_cd: '1', msg1: 'MAX SUBSCRIBE OVER' } }) });

        stream.subscribe('H0STCNT0', '005930');

        const registers = ws.sent.map((s) => JSON.parse(s) as { header: { tr_type: string }; body: { input: { tr_id: string } } })
            .filter((f) => f.header.tr_type === '1' && f.body.input.tr_id === 'H0STCNT0');
        expect(registers).toHaveLength(2);
        expect(onSubscribeError).toHaveBeenCalledWith('H0STCNT0', '005930', 'MAX SUBSCRIBE OVER');
        stream.stop();
    });
});
