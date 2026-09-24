/**
 * @fileoverview `WatchHub` — ccxt pro 의 `watch*` 의미(호출마다 다음 갱신)를 구현하는 대기열.
 */

import { describe, it, expect } from 'vitest';

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
