"""증권사 ID 판정과 상장 시장 → 시장 그룹(KR/US) 판정. TypeScript 판 `ts/src/broker-market-group.ts` 와 같다.

이 모듈은 다른 모듈을 가져오지 않는다.
"""

from typing import Optional

# 이 패키지가 다루는 증권사 거래소 ID.
STOCK_BROKER_EXCHANGES = frozenset(['kis', 'toss', 'kbsec'])


def is_stock_broker_exchange(exchange_id: str) -> bool:
    """`exchange_id` 가 이 패키지가 다루는 증권사인가."""
    return exchange_id in STOCK_BROKER_EXCHANGES


# KIS 해외 시세코드(3글자) → 표준 상장 시장명. KR/US 밖의 시장도 담는다. `AMS` 는 암스테르담이 아니라 AMEX 다.
BROKER_MARKET_CODE_TO_MARKET = {
    'NAS': 'NASDAQ',
    'NYS': 'NYSE',
    'AMS': 'AMEX',
    'HKS': 'HKEX',
    'SHS': 'SSE',
    'SZS': 'SZSE',
    'HSX': 'HOSE',
    'HNX': 'HNX',
    'TSE': 'TSE',
}


def normalize_market_name(market: Optional[str] = None) -> Optional[str]:
    """시장 이름을 표준명으로 바꾼다. 시세코드면 표준명으로, 이미 표준명이면 그대로 둔다. 비었으면 `None`."""
    if not market:
        return None
    key = market.strip().upper()
    return BROKER_MARKET_CODE_TO_MARKET.get(key, key)


# 상장 시장 → 시장 그룹. 시세코드는 적지 않는다(`normalize_market_name` 이 먼저 표준명으로 바꾼다).
_MARKET_TO_GROUP = {
    'KR': 'KR',
    'KOSPI': 'KR',
    'KOSDAQ': 'KR',
    'KONEX': 'KR',
    'KRX': 'KR',
    'KSE': 'KR',
    'NXT': 'KR',
    'US': 'US',
    'NYSE': 'US',
    'NASDAQ': 'US',
    'AMEX': 'US',
    'NYSEARCA': 'US',
    'ARCA': 'US',
    'BATS': 'US',
    'OTC': 'US',
}


def market_group_of(market: Optional[str] = None) -> Optional[str]:
    """상장 시장의 시장 그룹(`'KR'`·`'US'`). 모르면 `None` 이다. 모르는 값을 한쪽으로 몰래 분류하지 않는다."""
    name = normalize_market_name(market)
    return _MARKET_TO_GROUP.get(name) if name else None
