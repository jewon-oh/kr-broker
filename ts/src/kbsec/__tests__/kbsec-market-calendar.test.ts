/**
 * @fileoverview KB 휴장일 캘린더 — 장운영상태(`SZQM0771`)의 전영업일·기준영업일·익영업일을 날짜별 개장 여부로 넓힌다.
 *
 * KB 에는 쓸 수 있는 캘린더 API 가 없다고 알려져 있었지만 장운영상태 TR 이 있다. KB 만 쓰는 배포에서는 이것을 배선하지 않으면 캘린더가 비어 공휴일에도
 * 세션 게이트가 열린 채로 주문이 나간다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
global.fetch = mockFetch as unknown as typeof fetch;

import { kbsec } from '../../kbsec';
import { isMarketClosedDay, marketDayStatus } from '../../market-calendar';
import { KBSEC_TR } from '../kbsec-types';
import { __resetKbsecTokenBreaker, resetMarketCalendar } from '../../testing';
import { BadRequest, NotSupported } from '../../base/errors';
import { CREDS, calledTrs, routeTr, trBody } from './support/kbsec-fetch';

const newExchange = () => new kbsec({ ...CREDS, rateLimit: 0 });

/** 수요일(2026-08-19)이 임시공휴일인 주. 전영업일은 화요일, 익영업일은 목요일이다. */
const HOLIDAY_WEDNESDAY = { bfr_bsns_dt: '20260818', std_bsnss_dt: '20260818', next_biz_dt: '20260820' };
/** 평범한 수요일. */
const ORDINARY_WEDNESDAY = { bfr_bsns_dt: '20260818', std_bsnss_dt: '20260819', next_biz_dt: '20260820' };

beforeEach(() => {
    mockFetch.mockReset();
    __resetKbsecTokenBreaker();
    resetMarketCalendar();
});

describe('fetchMarketCalendar', () => {
    it('전·기준·익영업일은 열린 날이고 그 사이의 평일은 닫힌 날이다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: HOLIDAY_WEDNESDAY });

        const days = await newExchange().fetchMarketCalendar();

        expect(Object.fromEntries(days.map(d => [d.date, d.open]))).toEqual({ '20260818': true, '20260819': false, '20260820': true });
    });

    it('평범한 날은 세 날짜가 모두 열려 있다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: ORDINARY_WEDNESDAY });

        const days = await newExchange().fetchMarketCalendar();

        expect(days.every(d => d.open)).toBe(true);
        expect(days.map(d => d.date)).toEqual(['20260818', '20260819', '20260820']);
    });

    it('주말이 끼면 그 사이는 닫힌 날이다 — 금요일 → 월요일', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: { bfr_bsns_dt: '20260821', std_bsnss_dt: '20260821', next_biz_dt: '20260824' } });

        const days = await newExchange().fetchMarketCalendar();

        expect(days.find(d => d.date === '20260822')?.open).toBe(false);
        expect(days.find(d => d.date === '20260823')?.open).toBe(false);
    });

    it('입력이 없는 TR 이고 조회가 실패하면 던진다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: '조회 실패' });

        await expect(newExchange().fetchMarketCalendar()).rejects.toThrow();
    });

    it('날짜를 하나도 못 읽으면 빈 목록이다 — 캘린더를 지어내지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: {} });

        expect(await newExchange().fetchMarketCalendar()).toEqual([]);
    });

    it('params.market 은 KR 만 받고 본문에 싣지 않는다. US 는 NotSupported, 그 밖은 BadRequest 이고 TR 을 부르지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: ORDINARY_WEDNESDAY });
        const exchange = newExchange();

        await exchange.fetchMarketCalendar({ market: 'kr' });
        await expect(exchange.fetchMarketCalendar({ market: 'US' })).rejects.toThrow(NotSupported);
        await expect(exchange.fetchMarketCalendar({ market: 'JP' })).rejects.toThrow(BadRequest);

        expect(trBody(mockFetch, KBSEC_TR.MARKET_STATUS).dataBody).not.toHaveProperty('market');
        expect(calledTrs(mockFetch).filter((tr) => tr === KBSEC_TR.MARKET_STATUS.toLowerCase())).toHaveLength(1);
    });
});

describe('refreshMarketCalendar — 공용 캘린더에 넣는다', () => {
    it('임시공휴일이 닫힌 날로 등록돼 장 시간 판정이 안다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: HOLIDAY_WEDNESDAY });
        expect(marketDayStatus('KR', '20260819')).toBe('unknown'); // 캘린더를 받기 전에는 모른다

        expect(await newExchange().refreshMarketCalendar()).toBe(true);

        expect(isMarketClosedDay('KR', '20260819')).toBe(true);
        expect(marketDayStatus('KR', '20260818')).toBe('open');
        expect(marketDayStatus('KR', '20260820')).toBe('open');
    });

    it('6시간 안에는 다시 부르지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: ORDINARY_WEDNESDAY });
        const exchange = newExchange();

        await exchange.refreshMarketCalendar();
        await exchange.refreshMarketCalendar();

        expect(calledTrs(mockFetch).filter(tr => tr === KBSEC_TR.MARKET_STATUS.toLowerCase())).toHaveLength(1);
    });

    it('실패해도 던지지 않고 false 다 — 주문 경로가 캘린더 실패로 막히지 않는다', async () => {
        routeTr(mockFetch, { [KBSEC_TR.MARKET_STATUS]: '조회 실패' });

        expect(await newExchange().refreshMarketCalendar()).toBe(false);
    });

    it('자격증명이 없으면 요청 없이 false 다', async () => {
        expect(await new kbsec({ rateLimit: 0 }).refreshMarketCalendar()).toBe(false);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
