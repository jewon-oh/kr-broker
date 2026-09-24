/**
 * `kis.fetchCorporateSchedules` — 예탁원 일정 12종(`ksdinfo/*`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { ArgumentsRequired, BadSymbol, NotSupported } from '../../base/errors';
import { dataOk, headersOf, newKis as newKisBase, tokenOk } from './support/kis-test-utils';
import { KIS_MASTER_FIXTURE } from '../../__tests__/support/kis-master-fixture';

const newKis = (config: Parameters<typeof newKisBase>[0] = {}) => newKisBase(config);

beforeEach(() => {
    mockFetch.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

/** 경로가 들어간 첫 호출의 순번. */
const find = (path: string): number => mockFetch.mock.calls.findIndex((c) => String(c[0]).includes(path));

/** 요청 URL 의 쿼리를 객체로. */
const queryOf = (index: number): Record<string, string> => Object.fromEntries(new URL(String(mockFetch.mock.calls[index][0])).searchParams);

const SINCE = Date.parse('2026-09-01T00:00:00Z');
const UNTIL = Date.parse('2026-09-30T00:00:00Z');

describe('fetchCorporateSchedules', () => {
    const CASES = [
        { type: 'RIGHTS_ISSUE', path: '/ksdinfo/paidin-capin', tr: 'HHKDB669100C0', extra: { GB1: '1' } },
        { type: 'BONUS_ISSUE', path: '/ksdinfo/bonus-issue', tr: 'HHKDB669101C0', extra: {} },
        { type: 'DIVIDEND', path: '/ksdinfo/dividend', tr: 'HHKDB669102C0', extra: { GB1: '0', HIGH_GB: '' } },
        { type: 'APPRAISAL_RIGHTS', path: '/ksdinfo/purreq', tr: 'HHKDB669103C0', extra: {} },
        { type: 'MERGER_SPLIT', path: '/ksdinfo/merger-split', tr: 'HHKDB669104C0', extra: {}, nameKey: 'cust_nm' },
        { type: 'PAR_VALUE_CHANGE', path: '/ksdinfo/rev-split', tr: 'HHKDB669105C0', extra: { MARKET_GB: '0' } },
        { type: 'CAPITAL_REDUCTION', path: '/ksdinfo/cap-dcrs', tr: 'HHKDB669106C0', extra: {} },
        { type: 'LISTING', path: '/ksdinfo/list-info', tr: 'HHKDB669107C0', extra: {}, dateKey: 'list_dt' },
        { type: 'PUBLIC_OFFERING', path: '/ksdinfo/pub-offer', tr: 'HHKDB669108C0', extra: {} },
        { type: 'FORFEITED_SHARES', path: '/ksdinfo/forfeit', tr: 'HHKDB669109C0', extra: {} },
        { type: 'MANDATORY_DEPOSIT', path: '/ksdinfo/mand-deposit', tr: 'HHKDB669110C0', extra: {}, dateKey: 'depo_date' },
        { type: 'SHAREHOLDER_MEETING', path: '/ksdinfo/sharehld-meet', tr: 'HHKDB669111C0', extra: {} },
    ] as const;

    it.each(CASES)('$type 는 $path 를 TR $tr 로 부르고 기간과 전체 종목을 보낸다', async (c) => {
        const nameKey = 'nameKey' in c ? c.nameKey : 'isin_name';
        const dateKey = 'dateKey' in c ? c.dateKey : 'record_date';
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({
            output1: [{ [dateKey]: '20260915', sht_cd: '005930', [nameKey]: '삼성전자', extra: 'x' }],
        }));

        const [row] = await newKis().fetchCorporateSchedules(c.type, undefined, SINCE, undefined, { until: UNTIL });

        const call = find(c.path);
        expect(headersOf(mockFetch, call).tr_id).toBe(c.tr);
        expect(queryOf(call)).toEqual({ ...c.extra, CTS: '', F_DT: '20260901', T_DT: '20260930', SHT_CD: '' });
        expect(row).toEqual({
            timestamp: Date.parse('2026-09-14T15:00:00Z'), datetime: '2026-09-14T15:00:00.000Z',
            symbol: '005930/KRW', name: '삼성전자', recordDate: '20260915', info: expect.objectContaining({ extra: 'x' }),
        });
    });

    it('종목을 주면 종목코드를 보내고, 끝 날짜 기본값은 오늘(한국 날짜)이다', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-22T16:30:00Z'));
        mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk({ output1: [{ sht_cd: '', cust_nm: '합병회사' }] }));

        const [row] = await newKis().fetchCorporateSchedules('MERGER_SPLIT', '005930/KRW', SINCE);

        expect(queryOf(find('/ksdinfo/merger-split'))).toMatchObject({ F_DT: '20260901', T_DT: '20260923', SHT_CD: '005930' });
        expect(row).toMatchObject({ symbol: '', name: '합병회사', recordDate: undefined });
    });

    it('since 가 없거나 종류가 없거나 해외 종목이면 보내기 전에 던진다', async () => {
        const broker = newKis({ masterData: KIS_MASTER_FIXTURE });
        await expect(broker.fetchCorporateSchedules('DIVIDEND')).rejects.toThrow(ArgumentsRequired);
        await expect(broker.fetchCorporateSchedules('SPLIT' as never, undefined, SINCE)).rejects.toThrow(NotSupported);
        await expect(broker.fetchCorporateSchedules('DIVIDEND', 'AAPL/USD', SINCE)).rejects.toThrow(BadSymbol);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
