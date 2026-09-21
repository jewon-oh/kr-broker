/**
 * @fileoverview 요청 간격 조절기(토큰 버킷).
 *
 * 토큰이 밀리초당 `refillRate` 만큼 차오르고(`capacity` 가 상한), 요청은 `cost` 만큼 토큰을 쓴다. 토큰이 음수인 동안 다음 요청은 기다린다.
 * 그래서 `refillRate = 1 / rateLimit` 이면 "요청 뒤 `rateLimit × cost` 밀리초가 지나야 다음 요청이 나간다"가 된다.
 * 요청은 들어온 순서대로 나간다.
 */

import { monotonic, sleep } from './time';

export interface ThrottlerConfig {
    /** 밀리초당 채워지는 토큰 수. */
    refillRate: number;
    /** 쌓아 둘 수 있는 토큰 상한. */
    capacity: number;
    /** 요청 하나의 기본 비용. */
    cost: number;
}

export class Throttler {
    private tokens = 0;
    private lastRefill = monotonic();
    private tail: Promise<void> = Promise.resolve();

    constructor(private readonly config: ThrottlerConfig) {}

    private refill(): void {
        const current = monotonic();
        const elapsed = current - this.lastRefill;
        this.lastRefill = current;
        this.tokens = Math.min(this.config.capacity, this.tokens + this.config.refillRate * elapsed);
    }

    /** 자기 차례가 오고 토큰이 음수가 아닐 때까지 기다린 뒤 비용만큼 토큰을 쓴다. */
    throttle(cost: number = this.config.cost): Promise<void> {
        const turn = this.tail.then(async () => {
            this.refill();
            while (this.tokens < 0) {
                await sleep(Math.ceil(-this.tokens / this.config.refillRate));
                this.refill();
            }
            this.tokens -= cost;
        });
        this.tail = turn;
        return turn;
    }
}
