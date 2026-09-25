"""한국 증권사 Open API 를 ccxt 방식으로 부르는 라이브러리.

.. code-block:: python

    import kr_broker
    broker = kr_broker.kis({'apiKey': APP_KEY, 'secret': APP_SECRET, 'uid': '12345678-01'})
"""

from kr_broker.base.errors import *  # noqa: F401,F403 - ccxt 처럼 오류 클래스를 최상위에서도 부른다
from kr_broker.base.errors import __all__ as _error_names
from kr_broker.base.exchange import Exchange
from kr_broker.base.precise import Precise
from kr_broker.base.token_store import BrokerTokenStore
from kr_broker.kis import kis
from kr_broker.toss import toss

__version__ = '0.5.0'

exchanges = ['kis', 'toss']

__all__ = ['Exchange', 'Precise', 'BrokerTokenStore', 'exchanges', 'kis', 'toss', '__version__'] + list(_error_names)
