/**
 * @fileoverview KIS 어댑터 결함 수정 회귀 — 잔고·해외 시장가·보합 부호.
 * 1. 해외 USD 잔고: 손익 필드뿐인 TTTS3012R output2 대신 체결기준현재잔고(CTRP6504R)를 쓴다.
 *    free=예수금-매수증거금, total=예수금이고 종목 평가 합계는 `info.stockValue` 다.
 * 2. 국내 KRW 잔고: 예수금총액이 total, 주문가능현금(`inquire-psbl-order`)이 free 다.
 * 3. 해외 실전 시장가→LOC 매핑에서 price 가 없으면 단가 0 을 보내지 않고 막는다.
 * 4. 국내 보합(prdy_ctrt=0)이면 전일대비가 0 이다.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock('../us-market-hours', () => ({
    getUsMarketPhase: () => 'open',
    formatEtWallClock: () => '10:00 ET',
}) satisfies Partial<typeof import('../us-market-hours')>);
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadRequest } from '../../base/errors';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';
import { bodyOf, dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';

/** 종목 마스터 픽스처를 넘긴 인스턴스. */
const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase({ masterData: KIS_MASTER_FIXTURE, ...config });

beforeEach(() => {
    mockFetch.mockReset();
});

describe('항목1 — 해외 USD 잔고 (체결기준현재잔고 CTRP6504R)', () => {
    it('free=예수금-매수증거금, total=예수금, used=예수금-free, 종목 평가 합계는 info 에 둔다', async () => {
        mockFetch
            .mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({
                output1: [
                    { pdno: 'AAPL', frcr_evlu_amt2: '1500.50', buy_crcy_cd: 'USD', cblc_qty13: '10' },
                    { pdno: 'TSLA', frcr_evlu_amt2: '2000.00', buy_crcy_cd: 'USD', cblc_qty13: '5' },
                ],
                output2: [{ crcy_cd: 'USD', frcr_dncl_amt_2: '800.25', frcr_buy_mgn_amt: '100.00', frcr_drwg_psbl_amt_1: '700.25' }],
            }));

        const balances = await newKis({ sandbox: false }).fetchBalance({ scope: 'usd' });

        expect(balances.USD).toMatchObject({ free: 700.25, used: 100, total: 800.25 });
        expect(balances.USD.info.stockValue).toBe(3500.5);
        // 손익 필드 요약(TTTS3012R)이 아니라 체결기준현재잔고를 호출했는지 본다.
        const index = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes('inquire-present-balance'));
        expect(index).toBeGreaterThan(0);
        expect(headersOf(mockFetch, index).tr_id).toBe('CTRP6504R');
        const url = new URL(String(mockFetch.mock.calls[index][0]));
        expect(url.searchParams.get('WCRC_FRCR_DVSN_CD')).toBe('02'); // 외화 기준
        expect(url.searchParams.get('NATN_CD')).toBe('840'); // 미국
    });

    it('USD 통화 행 없음(빈 계좌) → 전부 0', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: [], output2: [] }));

        const balances = await newKis({ sandbox: false }).fetchBalance({ scope: 'usd' });

        expect(balances.USD).toMatchObject({ free: 0, used: 0, total: 0 });
    });

    it('매수증거금 > 예수금(이상치) → free 0 으로 클램프(음수 자본 차단)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [],
            output2: [{ crcy_cd: 'USD', frcr_dncl_amt_2: '50', frcr_buy_mgn_amt: '80', frcr_drwg_psbl_amt_1: '0' }],
        }));

        const balances = await newKis({ sandbox: false }).fetchBalance({ scope: 'usd' });

        expect(balances.USD.free).toBe(0);
        expect(balances.USD.total).toBe(50);
    });
});

describe('항목2 — 국내 KRW 잔고 free/used/total 매핑', () => {
    it('total=예수금총액, free=주문가능현금(inquire-psbl-order), used=차액 — 평가금액과 주문가능금액은 info 에 둔다', async () => {
        mockFetch
            .mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output1: [], output2: [{ dnca_tot_amt: '1000000', tot_evlu_amt: '1500000' }] }))
            .mockResolvedValueOnce(dataOk({ output: { ord_psbl_cash: '700000', nrcvb_buy_amt: '650000', max_buy_qty: '9' } }));

        const balances = await newKis({ sandbox: false }).fetchBalance({ scope: 'kr' });

        expect(balances.KRW).toMatchObject({ free: 700000, used: 300000, total: 1000000 });
        expect(balances.KRW.info.summary.tot_evlu_amt).toBe('1500000');
        expect(balances.KRW.info.orderable.nrcvb_buy_amt).toBe('650000');
        // 매수가능조회 TR 로 조회했고 시장가(01)로 물었다(종목 증거금율이 반영된다).
        const index = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes('inquire-psbl-order'));
        expect(headersOf(mockFetch, index).tr_id).toBe('TTTC8908R');
        expect(new URL(String(mockFetch.mock.calls[index][0])).searchParams.get('ORD_DVSN')).toBe('01');
    });

    it('★모르는 scope 는 요청 없이 빈 잔고를 돌려주지 않고 BadRequest 로 던진다', async () => {
        for (const scope of ['domestic', 'KR', [], ['kr', 'krw']]) {
            await expect(newKis({ sandbox: false }).fetchBalance({ scope }), JSON.stringify(scope)).rejects.toBeInstanceOf(BadRequest);
        }
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('orderable:false 면 매수가능조회를 부르지 않고 free 를 비워 둔다(호출 한 번 절약)', async () => {
        mockFetch
            .mockResolvedValueOnce(tokenOk())
            .mockResolvedValueOnce(dataOk({ output1: [], output2: [{ dnca_tot_amt: '1000000' }] }));

        const balances = await newKis({ sandbox: false }).fetchBalance({ scope: 'kr', orderable: false });

        expect(balances.KRW.total).toBe(1000000);
        expect(balances.KRW.free).toBeUndefined();
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('보유 종목은 종목코드 키에 total=보유수량, free=주문가능수량(없으면 보유수량)으로 담는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [
                { pdno: '005930', prdt_name: '삼성전자', hldg_qty: '10', ord_psbl_qty: '7', pchs_avg_pric: '70000', evlu_amt: '800000' },
                { pdno: '000660', prdt_name: 'SK하이닉스', hldg_qty: '3' },
                { pdno: '035420', prdt_name: 'NAVER', hldg_qty: '0' },
            ],
            output2: [{ dnca_tot_amt: '0' }],
        }));

        const balances = await newKis().fetchBalance({ scope: 'kr', orderable: false });

        expect(balances['005930']).toMatchObject({ free: 7, used: 3, total: 10 });
        expect(balances['005930'].info.pchs_avg_pric).toBe('70000');
        expect(balances['000660']).toMatchObject({ free: 3, total: 3 });
        expect(balances['035420']).toBeUndefined(); // 보유 0 은 담지 않는다
    });

    it('★같은 종목이 매매구분별로 여러 행이면 수량을 더하고 원문 행은 info.rows 에 모은다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [
                { pdno: '005930', trad_dvsn_name: '현금', hldg_qty: '10', ord_psbl_qty: '10' },
                { pdno: '005930', trad_dvsn_name: '자기융자', loan_dt: '20260901', hldg_qty: '5', ord_psbl_qty: '3' },
            ],
            output2: [{ dnca_tot_amt: '0' }],
        }));

        const balances = await newKis().fetchBalance({ scope: 'kr', orderable: false });

        expect(balances['005930']).toMatchObject({ free: 13, used: 2, total: 15 });
        expect((balances['005930'].info.rows as unknown[]).length).toBe(2);
        expect(balances['005930'].info.trad_dvsn_name).toBe('현금');
    });

    it('★달러 예수금과 매수증거금을 문자열로 빼서 부동소수 잡음이 남지 않는다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [], output2: [{ crcy_cd: 'USD', frcr_dncl_amt_2: '1000.1', frcr_buy_mgn_amt: '200.2' }], output3: {},
        }));

        const balances = await newKis().fetchBalance({ scope: 'usd' });

        expect(balances.USD).toMatchObject({ free: 799.9, used: 200.2, total: 1000.1 });
    });

    it('조회가 실패하면 빈 잔고가 아니라 던진다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockRejectedValueOnce(new TypeError('fetch failed'));

        await expect(newKis().fetchBalance({ scope: 'kr' })).rejects.toThrow();
    });
});

describe('미국 보유 종목 — 실전은 NASD 한 번이 미국 전체다', () => {
    const holding = { ovrs_pdno: 'AAPL', ovrs_item_name: 'APPLE INC', ovrs_cblc_qty: '5', ord_psbl_qty: '5', pchs_avg_pric: '150', ovrs_stck_evlu_amt: '800' };

    it('실전: 거래소를 하나만 조회한다(세 거래소를 따로 부르면 같은 종목이 겹칠 수 있다)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: [holding] }));

        const balances = await newKis({ sandbox: false }).fetchBalance({ scope: 'us' });

        const calls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('overseas-stock/v1/trading/inquire-balance'));
        expect(calls).toHaveLength(1);
        expect(new URL(String(calls[0][0])).searchParams.get('OVRS_EXCG_CD')).toBe('NASD');
        expect(balances.AAPL).toMatchObject({ total: 5, free: 5 });
    });

    it('모의: 나스닥·뉴욕·아멕스를 따로 조회한다(모의는 거래소별로만 조회된다)', async () => {
        mockFetch
            .mockResolvedValueOnce(tokenOk())
            .mockResolvedValue(dataOk({ output1: [] }));

        await newKis({ sandbox: true }).fetchBalance({ scope: 'us' });

        const exchanges = mockFetch.mock.calls
            .filter((c) => String(c[0]).includes('overseas-stock/v1/trading/inquire-balance'))
            .map((c) => new URL(String(c[0])).searchParams.get('OVRS_EXCG_CD'));
        expect(exchanges.sort()).toEqual(['AMEX', 'NASD', 'NYSE']);
    });
});

describe('항목3 — 해외 실전 시장가(LOC) price 부재 차단', () => {
    it('실전 + type=market + price 없음 → LOC 단가0 대신 거부, HTTP 를 보내지 않는다', async () => {
        const broker = newKis({ sandbox: false });

        await expect(broker.createOrder('AAPL', 'market', 'buy', 5)).rejects.toThrow(ArgumentsRequired);
        await expect(broker.createOrder('AAPL', 'market', 'buy', 5)).rejects.toThrow('price 필수');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('실전 + type=market + price 지정 → LOC(34) 지정가로 통과(주문 발주)', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '0000000009' } }));

        const order = await newKis({ sandbox: false }).createOrder('AAPL', 'market', 'buy', 5, 150);

        expect(order.id).toBe('0000000009');
        const index = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes('/overseas-stock/v1/trading/order'));
        expect(bodyOf(mockFetch, index)).toMatchObject({ OVRS_ORD_UNPR: '150', ORD_DVSN: '34' });
    });

    it('모의는 시장가를 받지 않아 지정가(00)로 낸다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: { ODNO: '1' } }));

        await newKis({ sandbox: true }).createOrder('AAPL', 'market', 'buy', 5, 150);

        expect(bodyOf(mockFetch, 1).ORD_DVSN).toBe('00');
        expect(headersOf(mockFetch, 1).tr_id).toBe('VTTT1002U');
    });
});

describe('항목4 — 국내 보합 시 전일대비 부호', () => {
    async function tickerChange(prdy_ctrt: string, prdy_vrss: string): Promise<number | undefined> {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: { stck_prpr: '70000', prdy_ctrt, prdy_vrss, acml_vol: '1', acml_tr_pbmn: '1', stck_hgpr: '1', stck_lwpr: '1' },
        }));
        return (await newKis({ sandbox: false }).fetchTicker('005930')).change;
    }

    it('보합(prdy_ctrt=0, prdy_vrss>0) → change=0', async () => {
        expect(await tickerChange('0', '50')).toBe(0);
    });

    it('하락(prdy_ctrt<0) → change 음수 유지', async () => {
        expect(await tickerChange('-1.5', '1200')).toBe(-1200);
    });

    it('상승(prdy_ctrt>0) → change 양수 유지', async () => {
        expect(await tickerChange('2.0', '1500')).toBe(1500);
    });
});
