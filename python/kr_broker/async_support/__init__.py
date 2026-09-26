"""비동기 판. ccxt 의 `ccxt.async_support` 처럼 같은 이름의 증권사 클래스를 코루틴 메서드로 준다.

.. code-block:: python

    import asyncio
    import kr_broker.async_support as kr_broker

    async def main():
        async with kr_broker.kis({'apiKey': APP_KEY, 'secret': APP_SECRET, 'uid': '12345678-01'}) as broker:
            print(await broker.fetch_ticker('005930/KRW'))

    asyncio.run(main())

이 디렉터리의 `kis.py`·`toss.py` 같은 증권사 소스가 정본이고, 동기 판(`kr_broker/kis.py` 등)은 `scripts/gen-python-sync.mjs` 가
이 소스에서 만든다. 고칠 때는 이 디렉터리의 파일을 고치고 생성 스크립트를 돌린다.
"""

from kr_broker import __version__
from kr_broker.async_support.base.exchange import Exchange
from kr_broker.async_support.kbsec import kbsec
from kr_broker.async_support.kis import kis
from kr_broker.async_support.toss import toss
from kr_broker.base.errors import *  # noqa: F401,F403 - ccxt 처럼 오류 클래스를 최상위에서도 부른다
from kr_broker.base.errors import __all__ as _error_names
from kr_broker.base.precise import Precise
from kr_broker.base.token_store import BrokerTokenStore

exchanges = ['kbsec', 'kis', 'toss']

__all__ = ['Exchange', 'Precise', 'BrokerTokenStore', 'exchanges', 'kbsec', 'kis', 'toss', '__version__'] + list(_error_names)
