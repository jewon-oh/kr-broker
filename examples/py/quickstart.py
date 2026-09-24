"""빠른 시작 — 한국투자증권 모의계좌에 연결해 삼성전자 현재가를 읽는다.

앱키와 시크릿은 KIS Developers에서 발급한다. 통합 메서드(fetch_ticker 등)는 옮기는 중이라, 지금은 엔드포인트를 암묵 메서드로 직접 부른다.
"""
import os

import kr_broker

kis = kr_broker.kis({
    'apiKey': os.environ.get('KIS_APP_KEY', ''),
    'secret': os.environ.get('KIS_APP_SECRET', ''),
    'uid': os.environ.get('KIS_ACCOUNT_NO', ''),  # 계좌번호. 예: 12345678-01
    'sandbox': True,  # 모의투자. 실전은 생략한다.
})

price = kis.private_get_uapi_domestic_stock_v1_quotations_inquire_price({
    'tr_id': 'FHKST01010100', 'FID_COND_MRKT_DIV_CODE': 'J', 'FID_INPUT_ISCD': '005930',
})
print(price['output']['stck_prpr'])
