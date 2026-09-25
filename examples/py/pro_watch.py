"""실시간 판 — 토스증권에서 삼성전자 체결가를 받을 때마다 출력한다.

`kr_broker.pro`의 `watch_*`는 부를 때마다 다음 갱신을 돌려준다. `async with`를 나가면 실시간 연결과 HTTP 세션이 닫힌다.
"""
import asyncio
import os

import kr_broker.pro as kr_broker


async def main() -> None:
    async with kr_broker.toss({
        'apiKey': os.environ.get('TOSS_CLIENT_ID', ''),
        'secret': os.environ.get('TOSS_CLIENT_SECRET', ''),
    }) as toss:
        await toss.load_markets()
        for _ in range(5):
            ticker = await toss.watch_ticker('005930/KRW')
            print(ticker['datetime'], ticker['last'])


asyncio.run(main())
