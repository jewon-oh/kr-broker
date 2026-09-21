/**
 * @fileoverview `kis` 클래스의 요청 파이프라인: 헤더 서명, 응답 봉투, 재시도, 오류 매핑, 모의투자 전환, 유량.
 *
 * - `params.tr_id` 가 헤더로 옮겨지고 쿼리에는 실리지 않는다.
 * - 조회는 초당 거래건수 초과(`EGW00201`·`EGW00215`)에 한해 다시 보내고, 주문은 절대 다시 보내지 않는다.
 * - 오류 봉투(`rt_cd`·`msg_cd`)는 상태 코드보다 먼저 읽는다. 비-2xx 로 오는 업무 코드를 버리면 재발급·재시도를 코드로 판단할 수 없다.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch, mockSlot } = vi.hoisted(() => ({ mockFetch: vi.fn(), mockSlot: vi.fn() }));

vi.mock('../kis-rate-limiter', () => ({
    acquireKisSlot: mockSlot,
    KIS_MIN_INTERVAL_MS: 67,
}));
global.fetch = mockFetch as unknown as typeof fetch;

import { kis } from '../../kis';
import {
    AuthenticationError, ExchangeError, ExchangeNotAvailable, OrderOutcomeUnknown, RateLimitExceeded, RequestTimeout,
} from '../../base/errors';
import { CREDENTIALS, bodyOf, businessError, dataOk, headersOf, jsonResponse, newKis, tokenOk } from './support/kis-test-utils';

const PRICE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-price';

beforeEach(() => {
    mockFetch.mockReset();
    mockSlot.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('요청 서명', () => {
    it('★tr_id 는 헤더로 가고 쿼리에는 실리지 않는다. 앱키·시크릿·토큰·고객유형이 헤더에 있다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk('access-1')).mockResolvedValueOnce(dataOk({ output: {} }));

        await newKis().privateGetUapiDomesticStockV1QuotationsInquirePrice({ FID_INPUT_ISCD: '005930', tr_id: 'FHKST01010100' });

        const [url, init] = mockFetch.mock.calls[1] as [string, { method: string; headers: Record<string, string> }];
        expect(url).toBe(`https://openapivts.koreainvestment.com:29443${PRICE_PATH}?FID_INPUT_ISCD=005930`);
        expect(init.method).toBe('GET');
        expect(init.headers).toMatchObject({
            authorization: 'Bearer access-1',
            appkey: CREDENTIALS.apiKey,
            appsecret: CREDENTIALS.secret,
            tr_id: 'FHKST01010100',
            custtype: 'P',
        });
    });

    it('POST 는 JSON 본문으로 보낸다. 대문자 키는 그대로 둔다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '1' } }));

        await newKis().privatePostUapiDomesticStockV1TradingOrderCash({ CANO: '12345678', PDNO: '005930', tr_id: 'VTTC0802U' });

        expect(bodyOf(mockFetch, 1)).toEqual({ CANO: '12345678', PDNO: '005930' });
        expect(headersOf(mockFetch, 1).tr_id).toBe('VTTC0802U');
    });

    it('tr_id 가 없으면 요청을 보내지 않는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk());

        await expect(newKis().privateGetUapiDomesticStockV1QuotationsInquirePrice({ FID_INPUT_ISCD: '005930' })).rejects.toThrow('tr_id');

        expect(mockFetch).toHaveBeenCalledTimes(1); // 토큰만
    });

    it('자격증명이 비어 있으면 요청을 보내지 않고 AuthenticationError 다', async () => {
        const broker = new kis({ apiKey: 'a', secret: 'b' }); // uid(계좌번호) 없음

        await expect(broker.privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' })).rejects.toThrow(AuthenticationError);

        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('모의투자 전환', () => {
    it('setSandboxMode 는 도메인·호출 간격을 모의로 바꾸고 끄면 되돌린다', () => {
        const broker = new kis({ ...CREDENTIALS });
        expect(broker.urls.api.private).toBe('https://openapi.koreainvestment.com:9443');
        expect(broker.rateLimit).toBe(67);

        broker.setSandboxMode(true);
        expect(broker.isSandboxModeEnabled).toBe(true);
        expect(broker.urls.api.private).toBe('https://openapivts.koreainvestment.com:29443');
        expect(broker.rateLimit).toBe(500); // 모의는 초당 2건

        broker.setSandboxMode(false);
        expect(broker.urls.api.private).toBe('https://openapi.koreainvestment.com:9443');
        expect(broker.rateLimit).toBe(67);
    });

    it('생성자의 sandbox 옵션도 같다', () => {
        const broker = new kis({ ...CREDENTIALS, sandbox: true });

        expect(broker.isSandboxModeEnabled).toBe(true);
        expect(broker.rateLimit).toBe(500);
    });

    it('★모의투자에서는 호출마다 500ms, 실전은 67ms 를 앱키 스케줄러에 예약한다', async () => {
        mockFetch.mockResolvedValue(dataOk({ output: {} }));
        mockFetch.mockResolvedValueOnce(tokenOk());

        await newKis({ sandbox: true, rateLimit: true }).privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' });
        expect(mockSlot).toHaveBeenLastCalledWith(CREDENTIALS.apiKey, 500);

        mockSlot.mockClear();
        mockFetch.mockResolvedValueOnce(tokenOk());
        await newKis({ sandbox: false, rateLimit: true }).privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' });
        expect(mockSlot).toHaveBeenLastCalledWith(CREDENTIALS.apiKey, 67);
    });
});

describe('초당 거래건수 초과 — 조회만 다시 보낸다', () => {
    const rateLimited = () => businessError('EGW00201', '초당 거래건수를 초과하였습니다.', 500);
    const ledgerLimited = () => businessError('EGW00215', '원장에서 허용 가능한 초당 거래건수를 초과하였습니다.', 500);
    const get = (broker: kis) => broker.privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'FHKST01010100' });
    const post = (broker: kis) => broker.privatePostUapiDomesticStockV1TradingOrderCash({ tr_id: 'TTTC0802U' });

    it('GET 은 EGW00201 시 다시 보내 성공한다', async () => {
        mockFetch
            .mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(rateLimited())
            .mockResolvedValueOnce(dataOk({ output: { ok: '1' } }));

        const response = await get(newKis());

        expect(response.output).toEqual({ ok: '1' });
        expect(mockFetch).toHaveBeenCalledTimes(3); // 토큰 + 실패 + 재시도 성공
    });

    it('GET 은 EGW00215(원장 초당 거래건수)도 같다 — 예전에는 재시도 대상이 아니라 잔고 조회가 곧장 실패했다', async () => {
        mockFetch
            .mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(ledgerLimited())
            .mockResolvedValueOnce(dataOk({ output: { ok: '1' } }));

        expect((await get(newKis())).output).toEqual({ ok: '1' });
    });

    it('EGW00201 가 계속되면 최대 3번 다시 보낸 뒤 RateLimitExceeded', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValue(rateLimited());

        await expect(get(newKis())).rejects.toThrow(RateLimitExceeded);

        // 토큰(1) + 최초(1) + 재시도 3회. 토큰은 프로세스 캐시라 한 번만 받는다.
        expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('★POST(주문)는 EGW00201 라도 다시 보내지 않는다(이중 주문 방지)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(rateLimited());

        await expect(post(newKis())).rejects.toThrow(RateLimitExceeded);

        expect(mockFetch).toHaveBeenCalledTimes(2); // 토큰 + 한 번
    });

    it('POST 는 EGW00215 도 같다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(ledgerLimited());

        await expect(post(newKis())).rejects.toThrow(RateLimitExceeded);

        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('재시도 대상이 아닌 업무 오류는 다시 보내지 않는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(businessError('APBK0919', '주문가능금액 부족'));

        await expect(get(newKis())).rejects.toThrow(ExchangeError);

        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});

describe('오류 매핑', () => {
    const get = (broker: kis) => broker.privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' });

    it('★표에 없는 업무 오류는 추측하지 않는다 — ExchangeError 이고 메시지에 코드와 문구가 있다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(businessError('APBK0919', '주문가능금액 부족'));

        const error = await get(newKis()).catch((e: unknown) => e) as Error;

        expect(Object.getPrototypeOf(error)).toBe(ExchangeError.prototype);
        expect(error.message).toBe('KIS API 비즈니스 오류 [APBK0919]: 주문가능금액 부족');
    });

    it('★증권사 오류 코드는 표에 있든 없든 detail 에 남는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(businessError('APBK0919', '주문가능금액 부족'));
        const unlisted = await get(newKis()).catch((e: unknown) => e) as ExchangeError;
        mockFetch.mockReset().mockResolvedValueOnce(tokenOk()).mockResolvedValue(businessError('EGW00201', '초당 거래건수를 초과하였습니다.', 500));
        const listed = await get(newKis()).catch((e: unknown) => e) as RateLimitExceeded;

        expect(unlisted.detail).toBe('APBK0919');
        expect(listed).toBeInstanceOf(RateLimitExceeded);
        expect(listed.detail).toBe('EGW00201');
    });

    it('★비-2xx 로 실려 온 업무 봉투도 msg_cd 로 분류한다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValue(businessError('EGW00133', '토큰 문제', 500));

        await expect(get(newKis())).rejects.toThrow(/KIS API 오류: 500 \[EGW00133\]/);
    });

    it('JSON 이 아닌 오류 본문은 원문을 잃지 않고 HTTP 상태 표가 받는다', async () => {
        mockFetch
            .mockResolvedValueOnce(tokenOk())
            .mockResolvedValue({ ...jsonResponse('<html>bad gateway</html>', 502), text: async () => '<html>bad gateway</html>' });

        const error = await get(newKis()).catch((e: unknown) => e) as Error;

        expect(error).toBeInstanceOf(ExchangeNotAvailable);
        expect(error.message).toContain('bad gateway');
    });

    it('접근토큰 만료(EGW00123)는 HTTP 200 으로 와도 AuthenticationError 다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(businessError('EGW00123', '기간이 만료된 token 입니다.'));

        await expect(get(newKis())).rejects.toThrow(AuthenticationError);
    });

    it('연결이 끊기면 NetworkError, 조회에서는 다시 보낸다', async () => {
        mockFetch
            .mockResolvedValueOnce(tokenOk())
            .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
            .mockResolvedValueOnce(dataOk({ output: { ok: '1' } }));

        expect((await get(newKis())).output).toEqual({ ok: '1' });
    });
});

describe('인증 실패 시 토큰 캐시 무효화', () => {
    const get = (broker: kis) => broker.privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' });

    async function failWith(status: number, body: unknown, broker = newKis()) {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/tokenP') ? tokenOk() : jsonResponse(body, status)));
        const spy = vi.spyOn(broker, 'invalidateToken').mockResolvedValue(undefined);
        await get(broker).catch(() => undefined);
        return spy;
    }

    it('★401 이면 무효화한다(예전에는 호출하는 곳이 없어 죽은 토큰이 영원히 남았다)', async () => {
        const spy = await failWith(401, { rt_cd: '1', msg_cd: 'X', msg1: 'unauthorized' });

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('403 도 같다', async () => {
        const spy = await failWith(403, { rt_cd: '1', msg_cd: 'X', msg1: 'forbidden' });

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('★500 에는 붙지 않는다 — 화이트리스트를 좁게 둔다(발급 남발은 분당 1회 제한 위반)', async () => {
        const spy = await failWith(500, { rt_cd: '1', msg_cd: 'EGW00201', msg1: 'rate limit' });

        expect(spy).not.toHaveBeenCalled();
    });

    it('토큰 발급 요청 자체의 403 은 무효화 대상이 아니다(캐시할 토큰이 없다)', async () => {
        const broker = newKis();
        const spy = vi.spyOn(broker, 'invalidateToken').mockResolvedValue(undefined);
        mockFetch.mockResolvedValueOnce(jsonResponse({ error_code: 'EGW00133', error_description: '접근토큰 발급 잠시 후 다시 시도하세요(1분당 1회)' }, 403));

        await expect(get(broker)).rejects.toThrow(RateLimitExceeded);

        expect(spy).not.toHaveBeenCalled();
    });

    it('무효화하면 다음 호출이 새 토큰을 받는다', async () => {
        mockFetch
            .mockResolvedValueOnce(tokenOk('old'))
            .mockResolvedValueOnce(jsonResponse({ rt_cd: '1', msg_cd: 'X', msg1: 'unauthorized' }, 401))
            .mockResolvedValueOnce(tokenOk('new'))
            .mockResolvedValueOnce(dataOk({ output: {} }));
        const broker = newKis();

        await get(broker).catch(() => undefined);
        await get(broker);

        expect(headersOf(mockFetch, 3).authorization).toBe('Bearer new');
    });
});

describe('토큰 발급 실패 메시지', () => {
    it('403 + 발급 빈도 제한은 RateLimitExceeded 이고 상태와 본문이 메시지에 남는다', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ error_code: 'EGW00133' }, 403));

        const error = await newKis().privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' }).catch((e: unknown) => e) as Error;

        expect(error).toBeInstanceOf(RateLimitExceeded);
        expect(error.message).toMatch(/KIS 토큰 발급 실패: 403/);
    });

    it('응답에 access_token 이 없으면 AuthenticationError', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({}));

        await expect(newKis().authenticate()).rejects.toThrow(AuthenticationError);
    });
});

describe('요청 시간 상한 — 조회와 주문의 계약이 다르다', () => {
    /** 토큰 한 건만 정상 응답하고, 그 뒤 요청은 응답 없이 멈춘다. */
    function hangAfterToken(): AbortSignal[] {
        const signals: AbortSignal[] = [];
        mockFetch.mockImplementationOnce(async () => tokenOk());
        mockFetch.mockImplementation((_url: unknown, init?: { signal?: AbortSignal }) => {
            if (init?.signal) signals.push(init.signal);
            return new Promise<never>(() => undefined);
        });
        return signals;
    }

    async function settle(ms: number, promise: Promise<unknown>) {
        const settled = promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
        await vi.advanceTimersByTimeAsync(ms);
        return settled;
    }

    it('★GET 이 20초 안에 안 끝나면 요청을 취소하고 RequestTimeout 이다(다시 보내지 않는다)', async () => {
        vi.useFakeTimers();
        const signals = hangAfterToken();

        const result = await settle(20_000, newKis().privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' }));

        expect(result.ok).toBe(false);
        expect((result as { error: unknown }).error).toBeInstanceOf(RequestTimeout);
        expect((result as { error: unknown }).error).not.toBeInstanceOf(OrderOutcomeUnknown);
        expect(signals.at(-1)?.aborted).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2); // 토큰 + 한 번(시간 초과는 재시도하지 않는다)
    });

    it('★주문 POST 가 25초 안에 안 끝나면 OrderOutcomeUnknown — 접수 여부를 모르므로 실패로 넘기면 안 된다', async () => {
        vi.useFakeTimers();
        const signals = hangAfterToken();

        const result = await settle(25_000, newKis().privatePostUapiDomesticStockV1TradingOrderCash({ tr_id: 'TTTC0802U' }));

        expect(result.ok).toBe(false);
        expect((result as { error: unknown }).error).toBeInstanceOf(OrderOutcomeUnknown);
        expect(signals.at(-1)?.aborted).toBe(true);
    });

    it('토큰 발급이 10초 안에 안 끝나면 RequestTimeout — 뒤의 호출이 한없이 멈추지 않는다', async () => {
        vi.useFakeTimers();
        mockFetch.mockImplementation(() => new Promise<never>(() => undefined));

        const result = await settle(10_000, newKis().privateGetUapiDomesticStockV1QuotationsInquirePrice({ tr_id: 'X' }));

        expect(result.ok).toBe(false);
        expect((result as { error: unknown }).error).toBeInstanceOf(RequestTimeout);
    });
});
