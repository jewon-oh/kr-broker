/**
 * @fileoverview 실체결 확정 — 증권사 공용 폴링
 *
 * ## 왜 필요한가
 * 브로커 주문 **접수 응답에는 체결 정보가 없다.** 접수 직후 조회해도 `execution` 은 아직
 * 비어 있어, 한 번만 읽고 포기하면 증권사 클래스는 "요청가/요청수량"을 체결값으로 기록하게 된다.
 * 그 순간 기록되는 진입가는 **호가**가 되고, 사후에 아무도 고치지 않는다 — 잔고 대조는
 * "잔고 존재 여부"만 보고 단가·수량은 보지 않는다.
 *
 * 라이브 실측(토스): 주문 성공 111ms 뒤에 포지션이 생성됐다. 기록된 평단은 114,200(호가),
 * 실제 체결가는 114,100 이었다.
 *
 * 2차 효과로 **슬리피지 계측이 무력화된다.** 호출하는 쪽이
 * `expectedPrice(시그널 시점) vs orderResult.price` 를 비교할 때 후자가 호가면, 이 지표는
 * "시그널→주문접수 사이 가격변동"만 재고 실제 체결 괴리는 구조적으로 0 이다.
 *
 * ## 왜 공용 모듈인가
 * 같은 결함이 증권사마다 형태만 다르게 나타난다(KIS=지정가 조회 자체가 없음,
 * KB증권=`avgPrice` 미반환). 폴링 예산·종료 판정·부분체결
 * 처리·폴백 경고는 전부 브로커 무관한 로직이라 여기 한 곳에 둔다. 증권사 클래스는 **자기 응답을
 * `ExecutionProbe` 로 옮기는 매핑 함수 하나만** 제공하면 된다.
 */

import { logger } from './logger';
import type { Fee, Trade } from './base/types';

/** 브로커가 확정한 체결값 — 추정치는 담지 않는다(모르면 undefined). */
export interface ExecutionSnapshot {
    /** 체결 수량 */
    filled: number;
    /** 평균 체결가 */
    average?: number;
    /** 체결 금액(네이티브 통화) — 있으면 `filled × average` 보다 우선한다 */
    amount?: number;
    /** 실수수료(수수료+세금, 네이티브 통화) */
    fee?: number;
    /** `fee` 의 통화 */
    feeCurrency?: string;
}

/** 1회 조회 결과 — 증권사 클래스가 자기 응답을 이 형태로 옮긴다. */
export interface ExecutionProbe {
    /** 확정된 체결. 아직 없으면 null. */
    snapshot: ExecutionSnapshot | null;
    /**
     * 더 이상 체결이 늘지 않는 상태인가(완전체결·취소·거부).
     * true 면 남은 예산을 쓰지 않고 즉시 종료한다.
     */
    terminal: boolean;
}

export interface ConfirmExecutionParams {
    /** 로그 접두 — 증권사 클래스 이름 (예: `[toss]`) */
    label: string;
    /** 로그 식별용 주문 ID */
    orderId: string;
    /** 거래소 식별자 — 로그에 싣는다 (예: `toss`) */
    exchange: string;
    /** 1회 조회. **throw 해도 된다** — 조회 실패로 보고 다음 시도로 넘어간다. */
    probe: (attempt: number) => Promise<ExecutionProbe>;
    /**
     * 증권사 클래스가 제시하는 **기본 예산** — 공용 기본값(6×350ms)을 대신한다. `budget` 이 있으면 `budget` 이 여전히 이긴다.
     * 브로커·시장마다 체결이 잡히는 시간과 조회 제한이 달라서(예: KRX 지정가는 몇 초 뒤, KB 는 반복 조회를 계정 제한 사유로 경고)
     * 증권사 클래스가 시장별로 다른 값을 낼 수 있어야 한다.
     */
    defaults?: Partial<ConfirmBudget>;
    /** 사용자가 정한 예산(`options.confirmBudget`). 있는 값이 `defaults` 와 공용 기본값을 이긴다. */
    budget?: Partial<ConfirmBudget>;
}

export interface ConfirmBudget {
    attempts: number;
    intervalMs: number;
}

/** `options.confirmBudget` 의 값. 예산 객체이거나 예산 객체를 돌려주는 함수다. 비워 둔 항목은 아래 층의 값을 쓴다. */
export type ConfirmBudgetOption = Partial<ConfirmBudget> | (() => Partial<ConfirmBudget>) | undefined;

/**
 * 폴링 예산 기본값.
 *
 * 6회 × 350ms ≈ 최대 1.75s. 간격은 브로커 주문조회 레이트리밋에서 역산했다 — 토스
 * ORDER_INFO 그룹이 6 TPS(개장 피크 09:00~09:10 KST 는 3 TPS)라 350ms(≈2.9 TPS)면
 * 피크에도 자기 자신만으로는 한도를 넘지 않는다. 한도가 더 엄격한 브로커는 `options.confirmBudget` 으로 낮춘다.
 */
const DEFAULTS = { ATTEMPTS: 6, INTERVAL_MS: 350 } as const;

const ATTEMPTS_RANGE = { min: 1, max: 50 } as const;
/** 0 허용 = 폴링 없이 즉시 1회만(테스트·초저지연 브로커). */
const INTERVAL_RANGE = { min: 0, max: 10_000 } as const;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 범위 안의 정수면 그 값, 아니면 `undefined`. 범위를 벗어난 값은 경고를 남기고 무시한다. */
function validBudgetValue(name: string, value: number | undefined, range: { min: number; max: number }): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
        logger.warn({ name, value, ...range }, '[execution-confirm] 예산 값이 범위를 벗어나 무시한다');
        return undefined;
    }
    return value;
}

/**
 * 예산 해석 — 뒤의 층이 앞의 층을 이긴다: 공용 기본값 < `defaults`(증권사 클래스) < `overrides`(사용자 옵션). 범위를 벗어난 값은 무시한다.
 * 호출할 때마다 계산한다. 옵션이 함수면 그 시점의 값을 본다.
 */
export function resolveConfirmBudget(defaults?: Partial<ConfirmBudget>, overrides?: Partial<ConfirmBudget>): ConfirmBudget {
    const pick = (name: keyof ConfirmBudget, range: { min: number; max: number }, fallback: number): number =>
        validBudgetValue(name, overrides?.[name], range) ?? validBudgetValue(name, defaults?.[name], range) ?? fallback;
    return {
        attempts: pick('attempts', ATTEMPTS_RANGE, DEFAULTS.ATTEMPTS),
        intervalMs: pick('intervalMs', INTERVAL_RANGE, DEFAULTS.INTERVAL_MS),
    };
}

/**
 * 체결이 확정될 때까지 짧게 폴링한다.
 *
 * 종료 조건:
 * - `terminal` — 완전체결이면 그 값, 취소·거부면 그때까지의 부분체결(있으면)이 최종값.
 * - 예산 소진 — 그때까지 **가장 많이 채워진** 스냅샷.
 *
 * 부분체결에서 즉시 반환하지 않는 이유: 시장가는 수백 ms 안에 잔량이 마저 체결되는 일이
 * 흔한데, 첫 조각만 기록하면 DB 수량이 실제 보유보다 작아진다.
 *
 * **주문 자체는 이미 접수 성공**이므로 절대 throw 하지 않는다. 확정 실패는 `null` —
 * 호출부가 요청값으로 폴백하되, 그 사실이 로그에 남는다(종전엔 이 경로에 로그가 전혀 없어
 * 호가가 체결가로 기록되는 것을 아무도 몰랐다).
 */
export async function confirmExecution(p: ConfirmExecutionParams): Promise<ExecutionSnapshot | null> {
    const { attempts, intervalMs } = resolveConfirmBudget(p.defaults, p.budget);
    let best: ExecutionSnapshot | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (attempt > 1 && intervalMs > 0) await sleep(intervalMs);

        let probe: ExecutionProbe;
        try {
            probe = await p.probe(attempt);
        } catch (err) {
            logger.warn({ err, orderId: p.orderId, exchange: p.exchange, attempt, attempts },
                `${p.label} 체결 조회 실패 — 재시도`);
            continue;
        }

        const snap = probe.snapshot;
        if (snap && snap.filled > 0 && (best === null || snap.filled > best.filled)) best = snap;

        if (probe.terminal) {
            if (best === null) {
                logger.warn({ orderId: p.orderId, exchange: p.exchange, attempt },
                    `${p.label} 주문이 체결 없이 종료 — 체결 기록 없음`);
            }
            return best;
        }
    }

    logger.warn({
        orderId: p.orderId, exchange: p.exchange,
        attempts, waitedMs: (attempts - 1) * intervalMs, filled: best?.filled ?? 0,
    }, best === null
        ? `${p.label} ⚠️ 체결 미확인 — 요청 수량/호가로 기록됨(진입가·슬리피지 오차 가능)`
        : `${p.label} ⚠️ 부분체결 상태로 예산 소진 — 관측된 체결분으로 기록`);
    return best;
}

/** 체결내역 1행의 최소 형태. 증권사 클래스의 `fetchMyTrades` 가 돌려주는 ccxt `Trade` 를 그대로 받는다. */
export type TradeLike = Partial<Pick<Trade, 'order' | 'price' | 'amount' | 'cost' | 'info'>> & {
    /** 수수료. 행에 수수료 정보가 없으면 비운다. */
    fee?: Pick<Fee, 'cost'> | null;
};

const num = (v: number | null | undefined): number => (Number.isFinite(v as number) ? (v as number) : 0);

/**
 * **체결내역 목록**만 제공하는 증권사용 probe 팩토리 (KIS·KB증권).
 *
 * 이들은 "주문 1건 조회"가 없고 계좌 체결내역만 준다. 그래서 주문 id 로 걸러 합산해야 한다:
 * **분할체결이면 같은 주문의 행이 여러 개**라, 첫 행만 집으면(`find`) 수량·단가가 실제보다
 * 작게 기록된다. 수량 가중으로 합산하고 요청 수량을 다 채웠을 때만 종료로 본다 —
 * 체결내역에는 "이 주문 끝났다"는 신호가 없기 때문이다.
 */
export function tradeListProbe(params: {
    fetchTrades: () => Promise<TradeLike[]>;
    orderId: string;
    /** 요청 수량 — 이만큼 채워지면 terminal. 0 이하면 체결이 보이는 즉시 종료. */
    requestedQty: number;
    feeCurrency?: string;
}): () => Promise<ExecutionProbe> {
    // 행은 있는데 수량이 0 으로 읽힌 경우의 경고 — probe 하나당 한 번(폴링마다 쌓이지 않게).
    let zeroQtyWarned = false;
    return async () => {
        const rows = (await params.fetchTrades())
            .filter(t => t.order === params.orderId);

        const filled = rows.reduce((a, t) => a + num(t.amount), 0);
        if (!(filled > 0)) {
            // 우리 주문의 행이 **있는데** 수량이 0 이면 "아직 미체결" 이 아니라 **필드명 불일치**다
            // (KB증권 클래스가 실제로 이 상태였는데 로그가 전혀 없어 알아채지 못했다 — 그냥 null 이었다). 원본 응답(`info`)의 키만 남긴다.
            if (rows.length > 0 && !zeroQtyWarned) {
                zeroQtyWarned = true;
                const raw = rows[0].info;
                const rowKeys = Object.keys((typeof raw === 'object' && raw !== null ? raw : rows[0]) as object).slice(0, 40);
                logger.warn({ orderId: params.orderId, rows: rows.length, rowKeys },
                    '[execution-confirm] 주문의 체결 행은 있으나 수량이 0 으로 읽힘 — 응답 필드명 대조 필요');
            }
            return { snapshot: null, terminal: false };
        }

        // 체결금액은 브로커가 준 cost 합이 1순위, 없으면 수량×단가로 역산.
        const cost = rows.reduce((a, t) => a + (num(t.cost) || num(t.amount) * num(t.price)), 0);
        const average = cost > 0 ? cost / filled : undefined;
        const hasFee = rows.some(t => t.fee?.cost != null);
        const fee = hasFee ? rows.reduce((a, t) => a + num(t.fee?.cost), 0) : undefined;

        return {
            snapshot: {
                filled,
                average,
                amount: cost > 0 ? cost : undefined,
                fee,
                feeCurrency: params.feeCurrency,
            },
            terminal: params.requestedQty > 0 ? filled >= params.requestedQty : true,
        };
    };
}

/**
 * 호가 대비 실제 체결 괴리(bps) — 진짜 슬리피지.
 * 확정가·기준가가 모두 유효할 때만 값이 있다.
 */
export function fillDeviationBps(quotedPrice: number | undefined, filledPrice: number | undefined): number | null {
    if (quotedPrice == null || !(quotedPrice > 0) || filledPrice == null || !(filledPrice > 0)) return null;
    return Math.round(((filledPrice - quotedPrice) / quotedPrice) * 10_000);
}
