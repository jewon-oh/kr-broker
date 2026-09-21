/**
 * 휴장일과 장 시간 — 휴장일은 저장된 표가 아니라 증권사 캘린더 API가 알려 준 값으로 판정한다.
 */
import { kis, checkKRXTradingHoursAt, isKrxBusinessDayKst, marketCalendarStatus } from '../src';

const broker = new kis({
    apiKey: process.env.KIS_APP_KEY ?? '',
    secret: process.env.KIS_APP_SECRET ?? '',
    uid: process.env.KIS_ACCOUNT_NO ?? '',
});

async function main(): Promise<void> {
    // 증권사 캘린더 API를 불러 공용 캘린더를 채운다. 실주문 직전에도 자동으로 갱신하지만, 주문 밖에서 장 시간을 판정하려면 시작할 때 부른다.
    await broker.refreshMarketCalendar();

    const now = new Date();
    console.log(checkKRXTradingHoursAt(now)); // { tradable, reason }
    console.log(isKrxBusinessDayKst('20261005')); // KST 날짜가 영업일인가
    console.log(marketCalendarStatus('KR')); // 캘린더를 몇 일치 알고 있는가
}

main().catch(console.error);
