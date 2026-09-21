/**
 * @fileoverview 통합차트(`IVS11560`) 요청 파라미터와 봉 시각 변환.
 */

import { NotSupported } from '../base/errors';
import { KBSEC_CHART_KIND } from './kbsec-types';

/** `describe().timeframes` 의 표. 값은 통합차트의 `chrt_clsf`(일·주·월) 또는 분 단위 숫자 문자열이다. */
export const KBSEC_TIMEFRAMES: Readonly<Record<string, string>> = {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '10m': '10',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '4h': '240',
    '1d': KBSEC_CHART_KIND.DAY,
    '1w': KBSEC_CHART_KIND.WEEK,
    '1M': KBSEC_CHART_KIND.MONTH,
};

/**
 * timeframe → 통합차트 파라미터. 분봉은 `B` 와 분 단위를 함께 넘긴다(`5m` → `B`, `5`). 시간봉은 분으로 환산한다(`4h` → `B`, `240`).
 * 알 수 없는 timeframe 은 일봉으로 바꾸지 않고 `NotSupported` 를 던진다.
 */
export function kbsecChartParams(timeframe: string): { chrt_clsf: string; minute: string } {
    const tf = timeframe.trim();
    if (tf === '1d') return { chrt_clsf: KBSEC_CHART_KIND.DAY, minute: '' };
    if (tf === '1w') return { chrt_clsf: KBSEC_CHART_KIND.WEEK, minute: '' };
    if (tf === '1M' || tf === '1mo') return { chrt_clsf: KBSEC_CHART_KIND.MONTH, minute: '' };
    const m = /^(\d+)m$/.exec(tf);
    if (m) return { chrt_clsf: KBSEC_CHART_KIND.MINUTE, minute: m[1] };
    const h = /^(\d+)h$/.exec(tf);
    if (h) return { chrt_clsf: KBSEC_CHART_KIND.MINUTE, minute: String(Number(h[1]) * 60) };
    throw new NotSupported(`kbsec 이 지원하지 않는 timeframe 이다: ${timeframe}`);
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 국내 봉의 `dt`(YYYYMMDD)와 `tm`(HHMMSS) → UTC 밀리초. 두 값은 한국 시각이다. `long` 형이라 앞의 0 이 빠져 올 수 있어 자리를 채운다.
 * 일자를 읽을 수 없으면 `undefined` 다. 일봉은 시각이 없거나 0 이라 자정(KST)이 된다.
 */
export function kbsecCandleTimestamp(dt: string, tm: string): number | undefined {
    const date = /^(\d{4})(\d{2})(\d{2})$/.exec(dt.trim());
    if (!date) return undefined;
    const time = /^(\d{2})(\d{2})(\d{2})$/.exec(tm.trim() === '' ? '000000' : tm.trim().padStart(6, '0'));
    if (!time) return undefined;
    return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(time[1]), Number(time[2]), Number(time[3])) - KST_OFFSET_MS;
}
