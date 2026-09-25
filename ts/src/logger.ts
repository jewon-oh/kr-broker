/**
 * @fileoverview 라이브러리 전체가 쓰는 로거. 기본은 아무것도 출력하지 않는다.
 *
 * ccxt 가 `verbose` 로 라이브러리 수준의 출력을 정하듯이, 로거도 인스턴스가 아니라 라이브러리에 하나만 둔다. 출력을 보려면 `setLogger` 로
 * 원하는 구현(pino, console 등)을 넘긴다.
 *
 * ```ts
 * import { setLogger } from 'kr-broker';
 * setLogger({ debug: console.debug, info: console.info, warn: console.warn, error: console.error });
 * ```
 *
 * 모듈이 `import { logger } from './logger'` 로 받는 `logger` 는 호출 시점의 현재 구현으로 전달하는 얇은 대리자다. 그래서 나중에 `setLogger` 로
 * 구현을 바꿔도 이미 import 한 곳이 바뀐 구현을 쓴다.
 */

/** 로그에 함께 싣는 필드. */
export type BrokerLogContext = Record<string, unknown>;

/**
 * 로그 함수. 두 가지 호출 모양을 받는다: `(메시지, 컨텍스트?)`, `(컨텍스트, 메시지)`.
 *
 * pino 와 비슷하지만 같지 않다(컨텍스트를 먼저 줄 때 메시지가 필수다).
 */
export interface BrokerLogFn {
    (message: string, context?: BrokerLogContext): void;
    (context: BrokerLogContext, message: string): void;
}

/** 라이브러리가 쓰는 로거. */
export interface BrokerLogger {
    debug: BrokerLogFn;
    info: BrokerLogFn;
    warn: BrokerLogFn;
    error: BrokerLogFn;
}

/** 아무것도 하지 않는 로거. 기본값이다. */
export const noopLogger: BrokerLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

/** 현재 구현. */
let current: BrokerLogger = noopLogger;

/** 라이브러리가 쓸 로거 구현을 바꾼다. `noopLogger` 를 넘기면 출력을 끈다. */
export function setLogger(next: BrokerLogger): void {
    current = next;
}

type Level = keyof BrokerLogger;

/** 호출 시점의 현재 구현으로 전달한다. 인자를 가공하지 않는다. */
const forward = (level: Level): BrokerLogFn =>
    ((...args: unknown[]) => (current[level] as (...a: unknown[]) => void)(...args)) as BrokerLogFn;

/** 모듈이 import 해서 쓰는 로거. 현재 구현으로 전달하는 대리자다. */
export const logger: BrokerLogger = {
    debug: forward('debug'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
};
