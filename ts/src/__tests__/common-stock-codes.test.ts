/**
 * 현금 코드와 같은 티커의 통합 코드 표(`COMMON_STOCK_CODES`, 인스턴스의 `commonStockCodes`).
 * 세 증권사가 같은 종목을 한 심볼로 돌려주고 옛 심볼과 티커도 받는지 본다. 증권사에 나가는 요청은 요청 픽스처와 증권사별 주문 테스트가 고정한다.
 */
import { describe, expect, it } from 'vitest';

import type { Dict } from '../base/types';
import { COMMON_STOCK_CODES, commonStockCode, stockTicker, symbolBaseCode } from '../broker-market-group';
import { kbsec } from '../kbsec';
import { kis } from '../kis';
import { toStreamSymbol } from '../kis/kis-realtime-parser';
import { toss } from '../toss';
import { marketSessionBlockReason } from '../trading-hours';
import { KIS_MASTER_FIXTURE } from './support/kis-master-fixture';

const NAME = 'ProShares Ultra Semiconductors';
const MASTER = { ...KIS_MASTER_FIXTURE, amex: [{ code: 'USD', name: 'PROSHARES ULTRA SEMICONDUCTORS', market: 'AMS' as const, currency: 'USD' }] };

describe('표와 공용 도우미', () => {
    it('기본 표는 미국 티커 USD 하나다', () => {
        expect(COMMON_STOCK_CODES).toEqual({ USD: NAME });
    });

    it('양쪽 모두 대소문자를 가리지 않고 찾고, 표에 없으면 그대로 돌려준다', () => {
        expect(['USD', 'usd', 'AAPL'].map((ticker) => commonStockCode(ticker))).toEqual([NAME, NAME, 'AAPL']);
        expect([NAME, NAME.toLowerCase(), 'USD', 'AAPL'].map((code) => stockTicker(code))).toEqual(['USD', 'USD', 'USD', 'AAPL']);
        expect(commonStockCode('USD', { USD: 'Foo' })).toBe('Foo');
        expect(stockTicker('foo', { USD: 'Foo' })).toBe('USD');
    });

    it('symbolBaseCode 는 표의 통합 코드 심볼에서 티커를 꺼낸다', () => {
        expect([`${NAME}/USD`, 'USD/USD', 'USD'].map((symbol) => symbolBaseCode(symbol))).toEqual(['USD', 'USD', 'USD']);
    });

    it('toStreamSymbol 은 해외 티커를 표의 통합 코드 심볼로 만들고, 표를 넘기면 그 표를 쓴다', () => {
        expect(toStreamSymbol('usd')).toBe(`${NAME}/USD`);
        expect(toStreamSymbol('USD', { USD: 'Foo' })).toBe('Foo/USD');
        expect(toStreamSymbol('005930')).toBe('005930/KRW');
    });

    it('marketSessionBlockReason 은 표의 통합 코드 심볼도 티커로 상장 거래소를 찾는다', () => {
        const usRegular = new Date('2026-08-19T14:00:00Z'); // 수요일 10:00 ET
        expect(marketSessionBlockReason('kbsec', `${NAME}/USD`, usRegular, MASTER)).toBeNull();
        expect(marketSessionBlockReason('kbsec', 'USD/USD', usRegular, MASTER)).toBeNull();
    });
});

const BROKERS: Record<string, (config?: Dict) => kis | toss | kbsec> = {
    kis: (config = {}) => new kis({ ...config, options: { masterData: MASTER } }),
    toss: (config = {}) => new toss(config),
    kbsec: (config = {}) => new kbsec(config),
};

describe.each(Object.keys(BROKERS))('%s market()', (name) => {
    const make = BROKERS[name]!;

    it('티커, 옛 심볼, 표의 통합 코드와 그 심볼(대소문자 무관)이 모두 같은 종목이다. id 와 baseId 는 티커로 남는다', () => {
        const broker = make();
        for (const input of ['USD', 'USD/USD', NAME, `${NAME}/USD`, `${NAME.toUpperCase()}/USD`]) {
            expect(broker.market(input), input).toMatchObject({ id: 'USD', baseId: 'USD', base: NAME, quote: 'USD', symbol: `${NAME}/USD` });
        }
    });

    it('현금 코드와 겹치지 않는 티커는 바뀌지 않는다', () => {
        expect(make().market('AAPL/USD')).toMatchObject({ id: 'AAPL', base: 'AAPL', symbol: 'AAPL/USD' });
    });

    it('생성자 인자 commonStockCodes 로 표를 덮는다. 공용 도우미가 쓰는 기본 표의 심볼도 계속 받는다', () => {
        const broker = make({ commonStockCodes: { USD: 'Foo' } });

        expect(broker.market('Foo/USD')).toMatchObject({ id: 'USD', base: 'Foo', symbol: 'Foo/USD' });
        expect(broker.market(`${NAME}/USD`)).toMatchObject({ id: 'USD', symbol: 'Foo/USD' });
    });
});

describe('불러온 종목', () => {
    it('한국투자증권 loadMarkets 는 표의 통합 코드로 종목을 만들고, 옛 심볼과 티커도 그 종목을 찾는다', async () => {
        const broker = new kis({ options: { masterData: MASTER } });
        await broker.loadMarkets();
        const market = broker.markets?.[`${NAME}/USD`];

        expect(market).toMatchObject({ id: 'USD', baseId: 'USD', base: NAME, quoteId: 'USD' });
        expect(broker.markets?.['USD/USD']).toBeUndefined();
        expect(broker.market('USD/USD')).toBe(market);
        expect(broker.market('USD')).toBe(market);
    });

    it('토스증권 불러온 종목도 같고, 옛 심볼은 모양으로 새로 만들지 않고 불러온 종목을 돌려준다', () => {
        const broker = new toss({});
        broker.setMarkets([broker.parseMarket({ symbol: 'USD', market: 'AMEX' }), broker.parseMarket({ symbol: 'AAPL', market: 'NASDAQ' })]);
        const market = broker.markets?.[`${NAME}/USD`];

        expect(market).toMatchObject({ id: 'USD', baseId: 'USD', base: NAME });
        expect(broker.market('USD/USD')).toBe(market);
        expect(broker.safeMarket('USD')).toBe(market);
    });

    it('통화 목록에서 같은 id(USD)의 종목과 현금이 겹쳐도 id 로 찾으면 현금이다. 표의 코드가 USD 보다 뒤에 정렬돼도 같다', async () => {
        for (const commonStockCodes of [{}, { USD: 'Zeta Fund' }]) {
            const broker = new kis({ commonStockCodes, options: { masterData: MASTER } });
            await broker.loadMarkets();
            const code = broker.commonStockCode('USD');

            expect(broker.currencies[code]).toMatchObject({ id: 'USD', code });
            expect(broker.safeCurrencyCode('USD')).toBe('USD');
        }
    });
});
