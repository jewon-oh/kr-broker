"""빠른 시작(비동기 판) — 한국투자증권 모의계좌에 연결해 삼성전자 현재가를 읽는다.

앱키와 시크릿은 KIS Developers에서 발급한다. `kr_broker.async_support`의 메서드는 코루틴이라 `await`로 부른다.
`async with`를 나가면 HTTP 세션이 닫힌다.
"""
import asyncio
import os

import kr_broker.async_support as kr_broker


async def main() -> None:
    async with kr_broker.kis({
        'apiKey': os.environ.get('KIS_APP_KEY', ''),
        'secret': os.environ.get('KIS_APP_SECRET', ''),
        'uid': os.environ.get('KIS_ACCOUNT_NO', ''),  # 계좌번호. 예: 12345678-01
        'sandbox': True,  # 모의투자. 실전은 생략한다.
    }) as kis:
        ticker = await kis.fetch_ticker('005930/KRW')
        print(ticker['last'])


asyncio.run(main())
