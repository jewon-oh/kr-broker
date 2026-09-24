/**
 * @fileoverview ccxt pro 의 `watch*` 의미를 구현하는 대기열. 호출마다 다음 갱신을 돌려준다.
 *
 * 메시지 해시(`ticker:005930/KRW` 등)마다 기다리는 약속을 모아 두고 새 값이 오면 한꺼번에 푼다. 체결과 주문처럼 여러 건이 쌓이는 것은
 * 기다리는 쪽이 없을 때 모아 두었다가 다음 호출에 한꺼번에 돌려준다(ccxt pro 의 `newUpdates` 와 같다).
 */

/** 쌓아 두는 항목 수의 상한(ccxt pro 의 `tradesLimit` 기본값과 같다). 넘으면 오래된 것부터 버린다. */
const BUFFER_LIMIT = 1000;

interface Waiter {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

export class WatchHub {
    private readonly waiters = new Map<string, Waiter[]>();
    private readonly buffers = new Map<string, unknown[]>();

    /** `hash` 의 다음 값을 기다린다. */
    next<T>(hash: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const list = this.waiters.get(hash) ?? [];
            list.push({ resolve: resolve as (value: unknown) => void, reject });
            this.waiters.set(hash, list);
        });
    }

    /** 기다리는 쪽을 모두 `value` 로 푼다. */
    resolve(hash: string, value: unknown): void {
        const list = this.waiters.get(hash);
        if (list === undefined) return;
        this.waiters.delete(hash);
        for (const waiter of list) waiter.resolve(value);
    }

    /** 쌓아 둔 새 항목이 있으면 바로 돌려주고, 없으면 다음 항목을 기다린다. */
    nextBatch<T>(hash: string): Promise<T[]> {
        const buffered = this.buffers.get(hash);
        if (buffered !== undefined && buffered.length > 0) {
            this.buffers.delete(hash);
            return Promise.resolve(buffered as T[]);
        }
        return this.next<T[]>(hash);
    }

    /** 항목을 쌓는다. 기다리는 쪽이 있으면 쌓인 것까지 한꺼번에 넘긴다. */
    push(hash: string, item: unknown): void {
        const list = this.buffers.get(hash) ?? [];
        list.push(item);
        if (list.length > BUFFER_LIMIT) list.splice(0, list.length - BUFFER_LIMIT);
        if (this.waiters.has(hash)) {
            this.buffers.delete(hash);
            this.resolve(hash, list);
        } else {
            this.buffers.set(hash, list);
        }
    }

    /** 기다리는 약속을 거절한다. `hashes` 를 주지 않으면 전부이고, 쌓아 둔 항목도 버린다. */
    reject(reason: unknown, hashes: string[] | undefined = undefined): void {
        const targets = hashes ?? [...this.waiters.keys()];
        for (const hash of targets) {
            const list = this.waiters.get(hash);
            this.waiters.delete(hash);
            for (const waiter of list ?? []) waiter.reject(reason);
        }
        if (hashes === undefined) this.buffers.clear();
    }
}
