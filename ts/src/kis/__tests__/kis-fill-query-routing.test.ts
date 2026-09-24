/**
 * 체결 조회처 선택. 종목의 시장(국내/미국)으로 조회 TR 이 갈리고, 해외 체결조회는 공식 TR 을 쓴다.
 *
 * 예전에는 해외 체결조회가 `inquire-ccnl` 경로에 `TTTS3018R`(공식은 미체결내역의 TR)을 보냈다. 경로와 TR 이 어긋나 KIS 가 거절했고, 오류가 debug
 * 로그로만 남아 해외 체결 확정이 항상 빈 결과로 끝났다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

global.fetch = mockFetch as unknown as typeof fetch;

import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { dataOk, dataUrls, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

/** 종목 마스터 픽스처를 넘긴 인스턴스. */
const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase({ masterData: KIS_MASTER_FIXTURE, ...config });

const emptyEnvelope = () => dataOk({ output: [], output1: [] });

beforeEach(() => {
    mockFetch.mockReset().mockImplementation(async (url: string) => (String(url).includes('/oauth2/tokenP') ? tokenOk() : emptyEnvelope()));
});

// 시각을 고정한 테스트가 다음 테스트에 새지 않게 한다.
afterEach(() => {
    vi.useRealTimers();
});

/** 호출 순번의 쿼리 값. */
function query(index: number, key: string): string | null {
    return new URL(String(mockFetch.mock.calls[index][0])).searchParams.get(key);
}

describe('fetchMyTrades 가 시장으로 갈린다', () => {
    it('해외 티커면 해외 체결 TR 로 간다', async () => {
        await newKis().fetchMyTrades('AAPL/USD');

        const urls = dataUrls(mockFetch);
        expect(urls.some((u) => u.includes('/overseas-stock/v1/trading/inquire-ccnl'))).toBe(true);
        expect(urls.some((u) => u.includes('/domestic-stock/v1/trading/inquire-daily-ccld'))).toBe(false);
    });

    it('국내 코드는 국내 TR 로 간다', async () => {
        await newKis().fetchMyTrades('005930/KRW');

        const urls = dataUrls(mockFetch);
        expect(urls.some((u) => u.includes('/domestic-stock/v1/trading/inquire-daily-ccld'))).toBe(true);
        expect(urls.some((u) => u.includes('/overseas-stock/v1/trading/inquire-ccnl'))).toBe(false);
    });

    it('종목을 주지 않으면 국내와 해외를 모두 본다. market 옵션으로 좁힌다', async () => {
        await newKis().fetchMyTrades();
        expect(dataUrls(mockFetch)).toHaveLength(2);

        mockFetch.mockClear();
        await newKis().fetchMyTrades(undefined, undefined, undefined, { market: 'domestic' });
        expect(dataUrls(mockFetch)).toHaveLength(1);
    });
});

describe('해외 체결조회 — 공식 TR(TTTS3035R)', () => {
    it('★실전: TTTS3035R, 종목 %·구분 체결·거래소 NASD(미국 전체) 한 번', async () => {
        await newKis({ sandbox: false }).fetchMyTrades('AAPL/USD');

        const index = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes('inquire-ccnl'));
        expect(headersOf(mockFetch, index).tr_id).toBe('TTTS3035R');
        expect(query(index, 'PDNO')).toBe('%');
        expect(query(index, 'CCLD_NCCS_DVSN')).toBe('01');
        expect(query(index, 'OVRS_EXCG_CD')).toBe('NASD');
        expect(dataUrls(mockFetch)).toHaveLength(1); // 예전에는 거래소마다 세 번 불렀다
    });

    it('★모의: VTTS3035R, 종목·거래소는 비우고 구분은 00(모의는 전체 조회만 된다)', async () => {
        await newKis({ sandbox: true }).fetchMyTrades('AAPL/USD');

        const index = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes('inquire-ccnl'));
        expect(headersOf(mockFetch, index).tr_id).toBe('VTTS3035R');
        expect(query(index, 'PDNO')).toBe('');
        expect(query(index, 'OVRS_EXCG_CD')).toBe('');
        expect(query(index, 'SLL_BUY_DVSN')).toBe('00');
        expect(query(index, 'CCLD_NCCS_DVSN')).toBe('00');
    });

    it('체결 행을 체결로 옮기고 미체결 행은 뺀다. 체결 id 는 다시 조회해도 같다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/tokenP') ? tokenOk() : dataOk({
            output: [
                { ord_dt: '20260921', dmst_ord_dt: '20260922', thco_ord_tmd: '223015', odno: 'OV-1', pdno: 'AAPL', sll_buy_dvsn_cd: '02', ft_ord_qty: '5', ft_ccld_qty: '5', ft_ccld_unpr3: '150.25', ft_ccld_amt3: '751.25', nccs_qty: '0', ovrs_excg_cd: 'NASD' },
                { ord_dt: '20260921', odno: 'OV-2', pdno: 'AAPL', sll_buy_dvsn_cd: '02', ft_ord_qty: '3', ft_ccld_qty: '0', nccs_qty: '3', ovrs_excg_cd: 'NASD' },
            ],
        })));

        const trades = await newKis({ sandbox: false }).fetchMyTrades('AAPL/USD');

        expect(trades).toHaveLength(1);
        expect(trades[0]).toMatchObject({
            id: '20260921:OV-1:AAPL:NASD', order: 'OV-1', symbol: 'AAPL/USD', side: 'buy', price: 150.25, amount: 5, cost: 751.25,
            timestamp: Date.parse('2026-09-22T22:30:15+09:00'),
        });
    });
});

describe('국내 체결조회 — 조회일은 KST', () => {
    it('★KST 새벽(UTC 로는 전날)에도 오늘(KST) 날짜로 조회한다 — NXT 프리마켓 체결이 조회에 잡힌다', async () => {
        // 2026-09-21T23:30:00Z = KST 2026-09-22 08:30 (NXT 프리마켓)
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-21T23:30:00Z'));

        await newKis({ sandbox: false }).fetchMyTrades('005930/KRW');

        const index = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes('inquire-daily-ccld'));
        expect(query(index, 'INQR_STRT_DT')).toBe('20260922');
        expect(query(index, 'INQR_END_DT')).toBe('20260922');
    });

    it('신형 TR(TTTC0081R/VTTC0081R)로 조회하고 KRX·NXT·SOR 체결을 모두 본다', async () => {
        await newKis({ sandbox: false }).fetchMyTrades('005930/KRW');
        await newKis({ sandbox: true }).fetchMyTrades('005930/KRW');

        const indexes = mockFetch.mock.calls.map((c, i) => (String(c[0]).includes('inquire-daily-ccld') ? i : -1)).filter((i) => i >= 0);
        expect(indexes.map((i) => headersOf(mockFetch, i).tr_id)).toEqual(['TTTC0081R', 'VTTC0081R']);
        expect(query(indexes[0], 'EXCG_ID_DVSN_CD')).toBe('ALL');
    });

    it('since 가 있으면 그 날부터 조회한다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-21T03:00:00Z'));

        await newKis().fetchMyTrades('005930/KRW', Date.parse('2026-09-15T00:00:00Z'));

        const index = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes('inquire-daily-ccld'));
        expect(query(index, 'INQR_STRT_DT')).toBe('20260915');
        expect(query(index, 'INQR_END_DT')).toBe('20260921');
    });

    it('체결 행만 체결로 옮긴다. 체결단가는 평균가(avg_prvs), 수수료는 응답에 없어 비어 있다', async () => {
        mockFetch.mockImplementation(async (url: string) => (String(url).includes('/oauth2/tokenP') ? tokenOk() : dataOk({
            output1: [
                { ord_dt: '20260921', ord_tmd: '093015', odno: 'D-1', pdno: '005930', sll_buy_dvsn_cd: '01', ord_qty: '10', tot_ccld_qty: '10', avg_prvs: '70100', tot_ccld_amt: '701000' },
                { ord_dt: '20260921', ord_tmd: '093100', odno: 'D-2', pdno: '005930', sll_buy_dvsn_cd: '02', ord_qty: '3', tot_ccld_qty: '0', rmn_qty: '3' },
            ],
        })));

        const trades = await newKis().fetchMyTrades('005930/KRW');

        expect(trades).toHaveLength(1);
        expect(trades[0]).toMatchObject({ order: 'D-1', symbol: '005930/KRW', side: 'sell', price: 70100, amount: 10, cost: 701000 });
        expect(trades[0].fee.cost).toBeUndefined();
        expect(trades[0].timestamp).toBe(Date.parse('2026-09-21T09:30:15+09:00'));
    });
});

