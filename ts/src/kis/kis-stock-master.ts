/**
 * @fileoverview KRX 종목 마스터의 재수출 — 정본은 `../krx-stock-master` 다.
 *
 * 공개 경로(`kr-broker/kis/kis-stock-master`)를 쓰는 쪽을 위해 남긴 재수출이다. 소스는 정본을 직접 가져온다.
 */
export { getKRXStockByCode, getStockMasterCount, searchKRXStocks } from '../krx-stock-master';
export type { KRXStock } from '../krx-stock-master';
