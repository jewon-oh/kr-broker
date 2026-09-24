/**
 * 테스트용 KIS 마스터 데이터 — 패키지는 KIS 마스터 파일을 싣지 않으므로(재배포 조건 불명확), 종목 판별이 필요한 테스트는 이 픽스처를
 * 인스턴스의 `options.masterData` 로 넘긴다. 실제 마스터의 일부가 아니라 테스트가 쓰는 소수 종목을 손으로 적은 값이다.
 */
import { EMPTY_KIS_MASTER_DATA, type KisMasterData } from '../../kis/kis-master-data';

export const KIS_MASTER_FIXTURE: KisMasterData = {
    ...EMPTY_KIS_MASTER_DATA,
    kospi: [{ code: '005930', name: '삼성전자', market: 'KOSPI' }],
    kosdaq: [{ code: '247540', name: '에코프로비엠', market: 'KOSDAQ' }],
    nasdaq: [
        { code: 'AAPL', name: 'APPLE INC', nameKr: '애플', market: 'NAS', currency: 'USD' },
        { code: 'TSLA', name: 'TESLA INC', nameKr: '테슬라', market: 'NAS', currency: 'USD' },
        { code: 'MSFT', name: 'MICROSOFT CORP', nameKr: '마이크로소프트', market: 'NAS', currency: 'USD' },
    ],
    nyse: [{ code: 'V', name: 'VISA INC-CLASS A SHARES', nameKr: '비자', market: 'NYS', currency: 'USD' }],
    amex: [],
};
