"""실시간 판. ccxt 의 `ccxt.pro` 처럼 비동기 판(`kr_broker.async_support`) 클래스를 상속하고 `watch_*` 를 더한다.

.. code-block:: python

    import asyncio
    import kr_broker.pro as kr_broker

    async def main():
        async with kr_broker.toss({'apiKey': CLIENT_ID, 'secret': CLIENT_SECRET}) as broker:
            while True:
                print(await broker.watch_ticker('005930/KRW'))

    asyncio.run(main())
"""

from kr_broker import __version__
from kr_broker.async_support.base.exchange import Exchange
from kr_broker.base.errors import *  # noqa: F401,F403 - ccxt 처럼 오류 클래스를 최상위에서도 부른다
from kr_broker.base.errors import __all__ as _error_names
from kr_broker.base.precise import Precise
from kr_broker.base.token_store import BrokerTokenStore
from kr_broker.pro.kis import kis
from kr_broker.pro.toss import toss

exchanges = ['kis', 'toss']

__all__ = ['Exchange', 'Precise', 'BrokerTokenStore', 'exchanges', 'kis', 'toss', '__version__'] + list(_error_names)
