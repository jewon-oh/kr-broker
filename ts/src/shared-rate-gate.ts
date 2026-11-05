/**
 * @fileoverview 호출 한도를 프로세스 사이에 나누는 선택 장치.
 *
 * 스로틀(`Throttler`)과 429 휴식은 인스턴스 메모리에 있다. 같은 계정을 여러 프로세스가 쓰면(봇 자식, 스냅샷 워커, API, 롤링 중 두 번째 파드)
 * 프로세스마다 한도를 따로 세서 합이 한도를 넘고, 429 를 받은 프로세스만 쉬어서 나머지는 계속 429 를 맞는다. 주문이 429 를 받으면 재시도 없이 실패한다.
 *
 * 이 장치는 이미 토큰 공유에 쓰는 저장소(`BrokerTokenStore`, 보통 Redis)의 기존 연산만 써서 두 가지를 나눈다. 저장소를 새로 요구하지 않는다.
 * - **슬롯**: 버킷의 간격(`rateLimit × cost`)만큼 유효한 락(`tryLock`)을 잡은 프로세스만 요청을 보낸다. 락은 풀지 않고 만료로 끝난다.
 *   계정·버킷마다 한 간격에 요청 하나가 나간다.
 * - **휴식**: 429 를 받은 프로세스가 쉬어야 하는 시각을 저장소에 적어(`set`) 다른 프로세스도 그 시각까지 기다린다.
 *
 * ## 실패하면 막지 않는다
 *
 * 주문을 저장소 장애에 묶지 않는다. 저장소 명령이 실패하거나 `STORE_OP_TIMEOUT_MS` 안에 끝나지 않으면 그 호출은 공유를 포기하고 프로세스 메모리 한도만으로
 * 간다(종전 동작). 그리고 `STORE_COOLDOWN_MS` 동안은 저장소를 아예 부르지 않아 주문마다 대기를 또 쓰지 않는다. 슬롯 대기도 `MAX_SLOT_WAIT_MS` 를 넘기지 않는다.
 * 이 장치가 늦추는 시간은 주문 한 건에 최대 `MAX_SLOT_WAIT_MS` 다.
 */

import { randomUUID } from 'node:crypto';

import { logger } from './logger';
import type { BrokerTokenStore } from './options';

/** 저장소 명령 하나에 줄 시간(ms). 넘으면 그 호출은 공유를 포기한다. Redis 명령 상한(호스트 설정 10초)보다 훨씬 짧게 잡아, 장애 때 주문이 그만큼 매달리지 않게 한다. */
const STORE_OP_TIMEOUT_MS = 250;
/** 저장소가 실패하거나 느리면 이 시간(ms) 동안 공유를 건너뛴다. */
const STORE_COOLDOWN_MS = 5_000;
/** 슬롯을 얻으려고 기다리는 최대 시간(ms). 넘으면 그냥 보낸다(서버가 429 로 막을 수 있지만 주문이 무한히 밀리는 것보다 낫다). */
const MAX_SLOT_WAIT_MS = 2_000;
/** 슬롯을 못 얻었을 때 다시 시도하는 간격(ms). */
const SLOT_POLL_MS = 20;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const TIMED_OUT = Symbol('timed-out');

/** `work` 를 `ms` 까지만 기다린다. 넘으면 `TIMED_OUT`. 밀린 `work` 의 실패는 삼킨다. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
    try {
        return await Promise.race([work, expired]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        work.catch(() => undefined);
    }
}

export class SharedRateGate {
    /** 이 시각(ms)까지는 저장소를 부르지 않는다. */
    private unavailableUntil = 0;
    private readonly owner = randomUUID();

    /**
     * @param storeOf 지금 쓸 저장소. 없으면 `null` 이고 그러면 이 장치는 아무것도 하지 않는다.
     * @param keyPrefix 계정을 가르는 키 접두(예: `rate:toss:<자격증명 해시>:`). 버킷 이름과 종류가 뒤에 붙는다.
     */
    constructor(
        private readonly storeOf: () => BrokerTokenStore | null,
        private readonly keyPrefix: string,
    ) {}

    private key(bucket: string, kind: 'slot' | 'blocked'): string {
        return `${this.keyPrefix}${bucket}:${kind}`;
    }

    private usableStore(): BrokerTokenStore | null {
        if (Date.now() < this.unavailableUntil) return null;
        return this.storeOf();
    }

    /** 저장소 명령 하나를 짧은 마감 안에서 한다. 실패하거나 넘기면 `undefined` 이고 한동안 저장소를 부르지 않는다. */
    private async guard<T>(operation: () => Promise<T>): Promise<T | undefined> {
        try {
            const result = await within(operation(), STORE_OP_TIMEOUT_MS);
            if (result !== TIMED_OUT) return result;
            this.trip(new Error(`저장소 명령이 ${STORE_OP_TIMEOUT_MS}ms 안에 끝나지 않았다`));
        } catch (err) {
            this.trip(err);
        }
        return undefined;
    }

    private trip(err: unknown): void {
        this.unavailableUntil = Date.now() + STORE_COOLDOWN_MS;
        logger.warn({ err, cooldownMs: STORE_COOLDOWN_MS }, '[shared-rate-gate] 공유 저장소를 쓰지 못해 프로세스 메모리 한도로 간다');
    }

    /**
     * 버킷의 슬롯 하나를 얻을 때까지 기다린다. `slotMs` 는 이 요청이 차지하는 시간(`rateLimit × cost`)이다.
     * 저장소가 없거나 실패하거나 `MAX_SLOT_WAIT_MS` 를 넘기면 기다리지 않고 돌아온다.
     */
    async acquire(bucket: string, slotMs: number): Promise<void> {
        const ttl = Math.ceil(slotMs);
        if (!(ttl > 0)) return;
        const deadline = Date.now() + MAX_SLOT_WAIT_MS;
        for (;;) {
            const store = this.usableStore();
            if (store === null) return;
            const got = await this.guard(() => store.tryLock(this.key(bucket, 'slot'), this.owner, ttl));
            if (got === undefined || got) return;
            if (Date.now() >= deadline) {
                logger.warn({ bucket, waitedMs: MAX_SLOT_WAIT_MS }, '[shared-rate-gate] 슬롯을 얻지 못한 채 대기 상한을 넘겨 그냥 보낸다');
                return;
            }
            await sleep(SLOT_POLL_MS);
        }
    }

    /** 다른 프로세스가 적어 둔 휴식 종료 시각(epoch ms). 없거나 저장소를 쓸 수 없으면 0. */
    async blockedUntil(bucket: string): Promise<number> {
        const store = this.usableStore();
        if (store === null) return 0;
        const raw = await this.guard(() => store.get(this.key(bucket, 'blocked')));
        const until = raw === undefined || raw === null ? 0 : Number(raw);
        return Number.isFinite(until) ? until : 0;
    }

    /** 이 버킷이 `untilMs`(epoch ms)까지 쉬어야 한다고 적는다. 이미 지난 시각이면 적지 않는다. */
    async markBlocked(bucket: string, untilMs: number): Promise<void> {
        const store = this.usableStore();
        const ttl = Math.ceil(untilMs - Date.now());
        if (store === null || !(ttl > 0)) return;
        await this.guard(() => store.set(this.key(bucket, 'blocked'), String(Math.ceil(untilMs)), ttl));
    }
}
