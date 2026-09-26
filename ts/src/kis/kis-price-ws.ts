/**
 * @fileoverview KIS 실시간 시세 WebSocket 클라이언트
 *
 * 단일 WS 연결로 체결가(H0STCNT0/HDFSCNT0)·호가(H0STASP0) 를 구독해 콜백으로 emit.
 *
 * 연결과 재접속(지수 백오프, 접속키 재발급, 구독 재등록), PINGPONG 되돌림, 구독 거부 알림은 `KisRealtimeStream`이 맡는다.
 * 이 클래스는 그 위에서 프레임을 체결가와 호가로 읽기만 한다. 프레임 파싱은 순수 함수(kis-realtime-parser)로 분리 — 테스트로 고정.
 *
 * WS 생성자 해석(`resolveWsCtor`)과 가용 판정(`isKisWsSupported`, `isUsingGlobalWebSocket`)은 `kis-realtime-stream`에 있고, 이 경로로도 내보낸다.
 */

import { logger } from '../logger';
import { parseKisRealtimePayload, toStreamSymbol } from './kis-realtime-parser';
import { KIS_WS_MAX_REGISTRATIONS, KisRealtimeStream, type KisWsSub } from './kis-realtime-stream';

export { isKisWsSupported, isUsingGlobalWebSocket, resolveWsCtor } from './kis-realtime-stream';
export type { KisWsSub, WsCtor, WsEventLike, WsLike } from './kis-realtime-stream';

export interface KisPriceWsOptions {
    getApprovalKey: () => Promise<string>;
    isVirtual: boolean;
    /** 접속 주소. 없으면 `isVirtual` 에 따라 KIS 기본 주소다. */
    url?: string | undefined;
    onTrade?: ((streamSymbol: string, last: number, changePct: number) => void) | undefined;
    onOrderbook?: ((streamSymbol: string, bids: [number, number][], asks: [number, number][]) => void) | undefined;
    /** 구독 응답이 실패(`rt_cd`가 `0`이 아님)면 부른다. 없으면 로그만 남긴다 */
    onSubscribeError?: ((trId: string, trKey: string, message: string) => void) | undefined;
    /** 콜백 심볼에 쓸 종목 통합 코드 표(`toStreamSymbol`). 없으면 `COMMON_STOCK_CODES` 다. `createPriceStream` 은 인스턴스의 표를 넘긴다 */
    commonStockCodes?: Readonly<Record<string, string>> | undefined;
}

/** 체결가와 호가만 읽는 연결. `KisPriceWs`만 쓴다. */
class KisPriceStream extends KisRealtimeStream {
    protected override readonly label = '[KisPriceWs]';

    constructor(private readonly priceOpts: KisPriceWsOptions) {
        super({
            getApprovalKey: () => priceOpts.getApprovalKey(),
            isVirtual: priceOpts.isVirtual,
            url: priceOpts.url,
            // 프레임은 `onFrame`이 가격으로 읽는다.
            onRecord: () => undefined,
            onSubscribeError: (trId, trKey, message) => priceOpts.onSubscribeError?.(trId, trKey, message),
        });
    }

    override restart(subs: readonly KisWsSub[]): void {
        super.restart(subs);
    }

    override replaceSubs(subs: readonly KisWsSub[]): void {
        super.replaceSubs(subs);
    }

    protected override onFrame(trId: string, countText: string, payload: string): void {
        for (const rec of parseKisRealtimePayload(trId, countText, payload)) {
            const streamSymbol = toStreamSymbol(rec.symbol, this.priceOpts.commonStockCodes);
            // 한 건의 콜백이 던져도 나머지 건과 연결은 계속 처리한다.
            try {
                if (rec.kind === 'trade') this.priceOpts.onTrade?.(streamSymbol, rec.last, rec.changePct);
                else this.priceOpts.onOrderbook?.(streamSymbol, rec.bids, rec.asks);
            } catch (err) {
                logger.warn({ err, streamSymbol }, '[KisPriceWs] 콜백 처리 실패');
            }
        }
    }
}

export class KisPriceWs {
    private readonly stream: KisPriceStream;

    constructor(opts: KisPriceWsOptions) {
        this.stream = new KisPriceStream(opts);
    }

    /** 구독을 `subs`로 정하고 접속한다. 이미 접속해 있으면 끊고 다시 잇는다. */
    start(subs: KisWsSub[]): void {
        if (subs.length > KIS_WS_MAX_REGISTRATIONS) {
            logger.warn({ count: subs.length, limit: KIS_WS_MAX_REGISTRATIONS },
                '[KisPriceWs] 구독 수가 연결당 한계 초과 — 초과분 누락 가능(폴링 폴백 의존)');
        }
        this.stream.restart(subs);
    }

    stop(): void {
        this.stream.stop();
    }

    /** 런타임 구독 갱신 — 연결 상태면 빠진 sub 는 해지(`tr_type` `2`)하고 신규 sub 는 등록한다. */
    updateSubs(subs: KisWsSub[]): void {
        this.stream.replaceSubs(subs);
    }

    isConnected(): boolean {
        return this.stream.isConnected();
    }
}
