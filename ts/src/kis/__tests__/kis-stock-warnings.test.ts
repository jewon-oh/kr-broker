/**
 * `kis.fetchStockWarnings` — VI(변동성완화장치) 발동 현황(`inquire-vi-status`, TR `FHPST01390000`).
 * KIS 는 토스가 함께 주는 유의사항 여섯 종류 중 VI 만 제공한다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { BadSymbol } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

const VI_PATH = '/quotations/inquire-vi-status';

beforeEach(() => {
    mockFetch.mockReset();
});

describe('fetchStockWarnings', () => {
    it('VI가 발동한 적이 있으면 그 기록을 정리해 돌려준다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: {
                bsop_date: '20260922', vi_cls_code: '1', vi_kind_code: '2', cntg_vi_hour: '093015',
                vi_cncl_hour: '093315', vi_prc: '71000', vi_count: '1',
            },
        }));

        const [warning] = await newKis().fetchStockWarnings('005930/KRW');

        const call = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(VI_PATH));
        expect(String(mockFetch.mock.calls[call]![0])).toContain('FID_INPUT_ISCD=005930');
        expect(String(mockFetch.mock.calls[call]![0])).toContain('FID_COND_SCR_DIV_CODE=20139');
        expect(headersOf(mockFetch, call).tr_id).toBe('FHPST01390000');
        expect(warning).toMatchObject({
            businessDate: '20260922', statusCode: '1', kindCode: '2', triggeredAt: '093015',
            canceledAt: '093315', price: 71000, count: 1,
        });
    });

    it('발동한 적이 없으면(빈 객체) 빈 배열이다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output: {} }));

        const warnings = await newKis().fetchStockWarnings('005930/KRW');

        expect(warnings).toEqual([]);
    });

    it('여러 번 발동했으면 배열로 온다', async () => {
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output: [
                { bsop_date: '20260922', vi_cls_code: '1', vi_kind_code: '1', vi_count: '1' },
                { bsop_date: '20260922', vi_cls_code: '1', vi_kind_code: '2', vi_count: '2' },
            ],
        }));

        const warnings = await newKis().fetchStockWarnings('005930/KRW');

        expect(warnings).toHaveLength(2);
        expect(warnings.map((w) => w.count)).toEqual([1, 2]);
    });

    it('해외 종목은 BadSymbol이고 요청을 보내지 않는다', async () => {
        const broker = newKis({ masterData: KIS_MASTER_FIXTURE });
        await expect(broker.fetchStockWarnings('AAPL/USD')).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
