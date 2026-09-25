/**
 * `kis.fetchTicker` — 국내·해외 시세 매핑과 심볼 라우팅 회귀.
 * 전일대비(change)는 prdy_vrss 가 부호 없을 수 있어 등락률(prdy_ctrt) 부호로 보정한다. 호가는 현재가 응답에 없어 비어 있다.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

global.fetch = mockFetch as unknown as typeof fetch;

import { BadSymbol, NullResponse } from '../../base/errors';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { dataOk, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

/** 종목 마스터 픽스처를 넘긴 인스턴스. */
const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase({ masterData: KIS_MASTER_FIXTURE, ...config });

async function tickerWith(output: Record<string, unknown>) {
    mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output }));
    return newKis().fetchTicker('005930');
}

beforeEach(() => {
    mockFetch.mockReset();
});

describe('fetchTicker — 국내 change/quoteVolume', () => {
    it('하락: change 는 음수(prdy_ctrt<0), quoteVolume=acml_tr_pbmn, percentage=prdy_ctrt', async () => {
        const t = await tickerWith({
            stck_prpr: '79000', prdy_ctrt: '-1.5', prdy_vrss: '1200',
            acml_vol: '1000000', acml_tr_pbmn: '5000000000',
            stck_hgpr: '80000', stck_lwpr: '78500',
        });

        expect(t.symbol).toBe('005930/KRW');
        expect(t.last).toBe(79000);
        expect(t.percentage).toBe(-1.5);
        expect(t.change).toBe(-1200);
        expect(t.quoteVolume).toBe(5_000_000_000);
        expect(t.baseVolume).toBe(1_000_000);
        expect(t.high).toBe(80000);
        expect(t.low).toBe(78500);
    });

    it('상승: change 양수', async () => {
        const t = await tickerWith({
            stck_prpr: '81000', prdy_ctrt: '2.0', prdy_vrss: '1500',
            acml_vol: '1', acml_tr_pbmn: '123', stck_hgpr: '82000', stck_lwpr: '80000',
        });

        expect(t.change).toBe(1500);
    });

    it('prdy_vrss 가 이미 부호를 가져도 prdy_ctrt 기준으로 정규화(이중부호 방지)', async () => {
        const t = await tickerWith({
            stck_prpr: '79000', prdy_ctrt: '-1.5', prdy_vrss: '-1200',
            acml_vol: '1', acml_tr_pbmn: '1', stck_hgpr: '8', stck_lwpr: '7',
        });

        expect(t.change).toBe(-1200);
    });

    it('★호가는 추정하지 않는다 — bid·ask 는 비어 있다(현재가 응답에 호가가 없다)', async () => {
        const t = await tickerWith({ stck_prpr: '79000', prdy_ctrt: '0', prdy_vrss: '0' });

        expect(t.bid).toBeUndefined();
        expect(t.ask).toBeUndefined();
    });

    it('★현재가가 0 이거나 비어 있으면 0 을 현재가로 넘기지 않고 NullResponse 다(손익 -100% 오표시 방지)', async () => {
        await expect(tickerWith({ stck_prpr: '0', prdy_ctrt: '0' })).rejects.toThrow(NullResponse);

        mockFetch.mockReset();
        await expect(tickerWith({ stck_prpr: '', prdy_ctrt: '0' })).rejects.toThrow(NullResponse);
    });
});

describe('fetchTicker — 해외', () => {
    it('전일 종가(base)로 절대 변동을 구한다: change = last - base', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { last: '150', base: '145', rate: '3.45', tvol: '1000', tamt: '150000' },
        }));

        const t = await newKis().fetchTicker('AAPL/USD');

        expect(t).toMatchObject({ symbol: 'AAPL/USD', last: 150, previousClose: 145, change: 5, percentage: 3.45, baseVolume: 1000, quoteVolume: 150000 });
    });

    it('마스터에 없는 티커는 BadSymbol 이고 시세를 부르지 않는다', async () => {
        await expect(newKis().fetchTicker('ZZZZNOTREAL/USD')).rejects.toThrow(BadSymbol);

        expect(mockFetch).not.toHaveBeenCalled();
    });
});

/**
 * fetchTicker 심볼 라우팅 회귀 — 접미사(`/KRW`)가 붙은 국내 심볼이 해외로 오라우팅되지 않아야 한다.
 * 국내는 inquire-price(FID_INPUT_ISCD=base), 해외는 overseas price(SYMB=base).
 */
describe('fetchTicker — 심볼 라우팅 (base 추출)', () => {
    async function routeTicker(symbol: string): Promise<string> {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                stck_prpr: '79000', prdy_ctrt: '0', prdy_vrss: '0', acml_vol: '1', acml_tr_pbmn: '1', stck_hgpr: '1', stck_lwpr: '1',
                last: '150', high: '151', low: '149', tvol: '1', tamt: '1', rate: '0',
            },
        }));
        await newKis().fetchTicker(symbol);
        return String(mockFetch.mock.calls[1]![0]);
    }

    it("bare '005930' → 국내 inquire-price(FID_INPUT_ISCD=005930)", async () => {
        const url = await routeTicker('005930');

        expect(url).toContain('/domestic-stock/v1/quotations/inquire-price');
        expect(url).toMatch(/FID_INPUT_ISCD=005930$/);
    });

    it("풀형식 '005930/KRW' → 국내 라우팅(슬래시 오염 없음)", async () => {
        const url = await routeTicker('005930/KRW');

        expect(url).toContain('/domestic-stock/v1/quotations/inquire-price');
        expect(url).toMatch(/FID_INPUT_ISCD=005930$/);
        expect(url).not.toContain('%2F');
    });

    it("'AAPL' → 해외 price(SYMB=AAPL)", async () => {
        const url = await routeTicker('AAPL');

        expect(url).toContain('/overseas-price/v1/quotations/price');
        expect(url).toMatch(/SYMB=AAPL$/);
    });

    it("풀형식 'AAPL/USD' → 해외 price(SYMB=AAPL, 슬래시 오염 없음)", async () => {
        const url = await routeTicker('AAPL/USD');

        expect(url).toContain('/overseas-price/v1/quotations/price');
        expect(url).toMatch(/SYMB=AAPL$/);
        expect(url).not.toContain('%2F');
    });
});
