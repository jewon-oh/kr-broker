/**
 * @fileoverview `WatchHub` — ccxt pro 의 `watch*` 의미(호출마다 다음 갱신)를 구현하는 대기열.
 */

import { describe, it, expect, vi } from 'vitest';

import { WatchHub } from '../watch-hub';

describe('WatchHub', () => {
    it('next 는 다음 resolve 값을 받고, 기다리는 쪽이 여럿이면 모두 같은 값을 받는다', async () => {
        const hub = new WatchHub();
        const a = hub.next<number>('ticker:X');
        const b = hub.next<number>('ticker:X');

        hub.resolve('ticker:X', 1);

        expect(await Promise.all([a, b])).toEqual([1, 1]);
    });

    it('기다리는 쪽이 없을 때의 resolve 는 버린다', async () => {
        const hub = new WatchHub();
        hub.resolve('ticker:X', 1);
        const next = hub.next<number>('ticker:X');

        hub.resolve('ticker:X', 2);

        expect(await next).toBe(2);
    });

    it('push 는 기다리는 쪽이 없으면 쌓아 두고, 다음 nextBatch 가 한꺼번에 가져간다', async () => {
        const hub = new WatchHub();
        hub.push('trades:X', 'a');
        hub.push('trades:X', 'b');

        expect(await hub.nextBatch('trades:X')).toEqual(['a', 'b']);

        const pending = hub.nextBatch('trades:X');
        hub.push('trades:X', 'c');
        expect(await pending).toEqual(['c']);
    });

    it('reject 는 해시를 주면 그 해시만, 주지 않으면 전부 거절한다', async () => {
        const hub = new WatchHub();
        const a = hub.next('a');
        const b = hub.next('b');

        hub.reject(new Error('a 만'), ['a']);
        await expect(a).rejects.toThrow('a 만');

        hub.reject(new Error('전부'));
        await expect(b).rejects.toThrow('전부');
    });
});

describe('WatchHub — AbortSignal', () => {
    it('신호가 오면 그 대기자만 AbortError 로 거절하고, 같은 해시의 다른 대기자는 계속 기다린다', async () => {
        const hub = new WatchHub();
        const controller = new AbortController();
        const aborted = hub.next<number>('ticker:X', controller.signal);
        const other = hub.next<number>('ticker:X');

        controller.abort();
        hub.resolve('ticker:X', 1);

        await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
        expect(await other).toBe(1);
    });

    it('신호의 reason 을 cause 로 싣는다', async () => {
        const hub = new WatchHub();
        const controller = new AbortController();
        const reason = new Error('시간 초과');
        const pending = hub.next('ticker:X', controller.signal);

        controller.abort(reason);

        await expect(pending).rejects.toMatchObject({ name: 'AbortError', cause: reason });
    });

    it('포기한 nextBatch 대기자는 항목을 가져가지 않는다. 항목은 쌓여 다음 호출이 받는다', async () => {
        const hub = new WatchHub();
        const controller = new AbortController();
        const abandoned = hub.nextBatch('trades:X', controller.signal);
        controller.abort();
        await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });

        hub.push('trades:X', 'a');

        expect(await hub.nextBatch('trades:X')).toEqual(['a']);
    });

    it('이미 중단된 신호면 대기자를 등록하지 않고 곧바로 거절하며, 쌓인 항목은 그대로 둔다', async () => {
        const hub = new WatchHub();
        hub.push('trades:X', 'a');

        await expect(hub.nextBatch('trades:X', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
        await expect(hub.next('ticker:X', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });

        hub.push('trades:X', 'b');
        expect(await hub.nextBatch('trades:X')).toEqual(['a', 'b']);
    });

    it('값을 받거나 거절되면 신호의 abort 처리기를 뗀다', async () => {
        const hub = new WatchHub();
        const controller = new AbortController();
        const removed = vi.spyOn(controller.signal, 'removeEventListener');

        const resolved = hub.next('ticker:X', controller.signal);
        hub.resolve('ticker:X', 1);
        await resolved;
        const rejected = hub.next('ticker:X', controller.signal);
        hub.reject(new Error('닫음'));
        await expect(rejected).rejects.toThrow('닫음');

        expect(removed.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(2);
    });
});
