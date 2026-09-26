"""증권사 ID 판정, 심볼의 종목코드, 상장 시장 → 시장 그룹(KR/US) 판정. TypeScript 판 `ts/src/broker-market-group.ts` 와 같다.

이 모듈은 다른 모듈을 가져오지 않는다.
"""

from typing import Mapping, Optional

# 이 패키지가 다루는 증권사 거래소 ID.
STOCK_BROKER_EXCHANGES = frozenset(['kis', 'toss', 'kbsec'])


def is_stock_broker_exchange(exchange_id: str) -> bool:
    """`exchange_id` 가 이 패키지가 다루는 증권사인가."""
    return exchange_id in STOCK_BROKER_EXCHANGES


# 현금 코드와 같은 티커의 통합 코드(티커 → 통합 코드). ccxt `commonCurrencies` 처럼 한쪽의 통합 코드를 바꾸되 종목 코드에만 적용해서,
# 같은 코드의 현금(`USD`)은 그대로 둔다. 종목의 `id` 와 `baseId` 는 티커로 남는다. 증권사 인스턴스는 생성자 인자 `commonStockCodes` 로 덮는다.
COMMON_STOCK_CODES: Mapping[str, str] = {
    'USD': 'ProShares Ultra Semiconductors',
}


def common_stock_code(ticker: str, codes: Optional[Mapping[str, str]] = None) -> str:
    """티커 → 통합 코드. 표에 없으면 티커 그대로다. 대소문자는 가리지 않는다. `codes` 가 없으면 `COMMON_STOCK_CODES` 다."""
    upper = ticker.upper()
    for key, code in (COMMON_STOCK_CODES if codes is None else codes).items():
        if key.upper() == upper:
            return code
    return ticker


def stock_ticker(code: str, codes: Optional[Mapping[str, str]] = None) -> str:
    """통합 코드 → 티커. 표의 통합 코드가 아니면(티커를 받았으면) 그대로 돌려준다. 대소문자는 가리지 않는다. `codes` 가 없으면 `COMMON_STOCK_CODES` 다."""
    upper = code.upper()
    for ticker, common in (COMMON_STOCK_CODES if codes is None else codes).items():
        if common.upper() == upper:
            return ticker
    return code


def symbol_base_code(symbol: str) -> str:
    """심볼에서 종목코드(티커)를 꺼낸다. 끝의 `/KRW`·`/USD` 만 떼고, `COMMON_STOCK_CODES` 의 통합 코드는 티커로 돌리고, 남은 `/` 는 클래스 주식
    표기로 보고 통합 표기의 `.` 로 바꾼다(`BRK/B` → `BRK.B`, `BRK.B/USD` → `BRK.B`, `ProShares Ultra Semiconductors/USD` → `USD`).
    대소문자와 공백은 그대로 둔다."""
    for quote in ('/KRW', '/USD'):
        if symbol.endswith(quote):
            symbol = symbol[:-len(quote)]
            break
    return stock_ticker(symbol).replace('/', '.')


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
