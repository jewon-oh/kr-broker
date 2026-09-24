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
        const columns = KIS_REALTIME_COLUMNS.H0IFCNT0;
        const one = columns.map((_, i) => String(i));
        const records = splitKisRealtimeRecords('H0IFCNT0', 2, [...one, ...one.map((v) => `b${v}`)].join('^'));

        expect(records).toHaveLength(2);
        expect(records[0].fields?.[columns[0]]).toBe('0');
        expect(records[1].fields?.[columns[columns.length - 1]]).toBe(`b${columns.length - 1}`);
        expect(records[1].values).toHaveLength(columns.length);
    });

    it('모르는 TR 은 값 수를 건수로 나눈 길이로 자르고 이름을 붙이지 않는다', () => {
        const records = splitKisRealtimeRecords('H0XXXXX0', 2, 'a^b^c^d');

        expect(records).toEqual([{ trId: 'H0XXXXX0', values: ['a', 'b'], fields: undefined }, { trId: 'H0XXXXX0', values: ['c', 'd'], fields: undefined }]);
    });

    it('값이 필드 수보다 모자라면 건수로 나눈 길이로 자르고 있는 값만 이름을 붙인다', () => {
        const [record] = splitKisRealtimeRecords('H0STNAV0', 1, 'A005930^10500');

        expect(record.values).toEqual(['A005930', '10500']);
        expect(Object.keys(record.fields ?? {})).toHaveLength(2);
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
        expect(await decryptKisPayload(encrypt('HTSID^12345678^0000117057'), KEY, IV)).toBe('HTSID^12345678^0000117057');
    });
});

describe('KisRealtimeStream', () => {
    const open = async (records: KisRealtimeRecord[], onSubscribeError = vi.fn()) => {
        const stream = new KisRealtimeStream({ getApprovalKey: async () => 'ak', isVirtual: true, onRecord: (r) => records.push(r), onSubscribeError });
        stream.subscribe('H0IFCNT0', '101W12');
        await flush();
        const ws = FakeWs.instances[0];
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
        expect(frames[0].header).toMatchObject({ approval_key: 'ak', custtype: 'P', 'content-type': 'utf-8' });
        expect(frames[0].body.input.tr_key).toBe('101W12');
        stream.stop();
    });

    it('평문 프레임을 필드 이름으로 묶어 넘기고, PINGPONG 은 되돌려 보낸다', async () => {
        const records: KisRealtimeRecord[] = [];
        const { stream, ws } = await open(records);
        const values = KIS_REALTIME_COLUMNS.H0IFCNT0.map((_, i) => (i === 0 ? '101W12' : String(i)));
        ws.emit('message', { data: `0|H0IFCNT0|001|${values.join('^')}` });
        const ping = '{"header":{"tr_id":"PINGPONG","datetime":"20260923101500"}}';
        ws.emit('message', { data: ping });
        await flush();

        expect(records).toHaveLength(1);
        expect(records[0].fields?.[KIS_REALTIME_COLUMNS.H0IFCNT0[0]]).toBe('101W12');
        expect(ws.sent.at(-1)).toBe(ping);
        stream.stop();
    });

    it('구독 응답의 key, iv 로 체결통보를 복호해 넘긴다', async () => {
        const records: KisRealtimeRecord[] = [];
        const { stream, ws } = await open(records);
        stream.subscribe('H0STCNI9', 'HTSID');
        ws.emit('message', { data: JSON.stringify({ header: { tr_id: 'H0STCNI9', tr_key: 'HTSID', encrypt: 'N' }, body: { rt_cd: '0', msg1: 'SUBSCRIBE SUCCESS', output: { key: KEY, iv: IV } } }) });
        const values = KIS_REALTIME_COLUMNS.H0STCNI0.map((_, i) => (i === 0 ? 'HTSID' : String(i)));
        ws.emit('message', { data: `1|H0STCNI9|001|${encrypt(values.join('^'))}` });
        await vi.waitFor(() => expect(records).toHaveLength(1));

        expect(records[0].trId).toBe('H0STCNI9');
        expect(records[0].fields?.[KIS_REALTIME_COLUMNS.H0STCNI0[0]]).toBe('HTSID');
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

    it('kis.createRealtimeStream 은 모의투자 여부를 따라 KisRealtimeStream 을 만든다', () => {
        const stream = newKis({ sandbox: false }).createRealtimeStream(() => undefined);

        expect(stream).toBeInstanceOf(KisRealtimeStream);
        expect(stream.isConnected()).toBe(false);
    });
});
