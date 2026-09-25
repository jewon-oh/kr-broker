"""TypeScript 판과 Python 판이 따로 적은 데이터 표가 같은지, TypeScript 원문을 읽어 대조한다.

새 영숫자 종목코드나 세율 개정을 한 판에만 넣으면, 요청 픽스처가 그 값을 쓰지 않는 한 다른 검사가 알아채지 못한다.
원문은 정규식으로 읽는다. 표의 모양을 바꾸면 여기 읽기 규칙도 함께 고친다(읽지 못하면 빈 표라 실패한다).
"""

import calendar
import re
from pathlib import Path
from typing import Dict, List, Tuple

from kr_broker import broker_krx_code, broker_market_group, krx_sell_tax, krx_tick_size
from kr_broker.async_support.kis import KIS_EXCEPTIONS_EXACT

TS = Path(__file__).resolve().parents[3] / 'ts' / 'src'


def _source(relative: str) -> str:
    """주석을 뗀 TypeScript 원문. 표 안의 줄 끝 주석(`// ...`)이 값처럼 읽히지 않게 한다."""
    text = (TS / relative).read_text(encoding='utf-8')
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'//[^\n]*', '', text)


def _literal(text: str, name: str, opening: str, closing: str) -> str:
    """`name ... = <opening> ... <closing>` 에서 괄호 안쪽. 못 찾으면 실패한다."""
    match = re.search(re.escape(name) + r'\b[^=]*=\s*' + re.escape(opening) + r'(.*?)' + re.escape(closing), text, re.S)
    assert match is not None, f'{name} 를 TypeScript 원문에서 찾지 못했다'
    return match.group(1)


def _pairs(body: str) -> Dict[str, str]:
    """`KEY: 'value'` 또는 `KEY: Name` 쌍."""
    pairs = dict(re.findall(r"(\w+):\s*'?(\w+)'?\s*,", body))
    assert pairs, '표가 비었다'
    return pairs


def test_known_alnum_krx_codes_match() -> None:
    text = _source('broker-krx-code.ts')
    codes = set(re.findall(r"'([0-9A-Za-z]+)'", _literal(text, 'KNOWN_ALNUM_KRX_CODES', 'new Set([', '])')))
    assert codes and codes == set(broker_krx_code.KNOWN_ALNUM_KRX_CODES)
    digits = re.search(r'KIS_KRX_CODE_DIGITS = (\d+);', text)
    assert digits is not None and int(digits.group(1)) == broker_krx_code.KIS_KRX_CODE_DIGITS


def _date_utc_ms(args: str) -> int:
    """`Date.UTC(y, m, d, h)` 의 인자(달은 0 부터) → 밀리초."""
    y, m, d, h = (int(part) for part in args.split(','))
    return calendar.timegm((y, m + 1, d, h, 0, 0, 0, 0, 0)) * 1000


def test_krx_sell_tax_schedule_matches() -> None:
    text = _source('krx-sell-tax.ts')
    body = _literal(text, 'KRX_SELL_TAX_SCHEDULE', '[', '];')
    entries: List[Tuple[int, float]] = [
        (_date_utc_ms(args), float(rate)) for args, rate in re.findall(r'fromUtcMs: Date\.UTC\(([\d, ]+)\), rate: ([\d.]+)', body)
    ]
    assert entries and entries == [(entry['fromUtcMs'], entry['rate']) for entry in krx_sell_tax.KRX_SELL_TAX_SCHEDULE]
    horizon = re.search(r'KRX_SELL_TAX_SCHEDULE_HORIZON_MS = Date\.UTC\(([\d, ]+)\);', text)
    assert horizon is not None and _date_utc_ms(horizon.group(1)) == krx_sell_tax.KRX_SELL_TAX_SCHEDULE_HORIZON_MS


def test_krx_tick_size_table_matches() -> None:
    text = _source('krx-tick-size.ts')
    body = _literal(text, 'KRX_STOCK_TICK_SIZES', '[', '];')
    rows = [(int(below.replace('_', '')), int(tick.replace('_', ''))) for below, tick in re.findall(r'\[([\d_]+), ([\d_]+)\]', body)]
    assert rows and tuple(rows) == krx_tick_size.KRX_STOCK_TICK_SIZES
    top = re.search(r'KRX_STOCK_TOP_TICK_SIZE = ([\d_]+);', text)
    assert top is not None and int(top.group(1).replace('_', '')) == krx_tick_size.KRX_STOCK_TOP_TICK_SIZE
    detail = re.search(r"KRX_TICK_INVALID_DETAIL = '([\w-]+)';", text)
    assert detail is not None and detail.group(1) == krx_tick_size.KRX_TICK_INVALID_DETAIL


def test_kis_exact_error_codes_match() -> None:
    ts = _pairs(_literal(_source('kis/kis-error-codes.ts'), 'KIS_EXCEPTIONS_EXACT', '{', '};'))
    assert ts == {code: error.__name__ for code, error in KIS_EXCEPTIONS_EXACT.items()}


def test_market_group_tables_match() -> None:
    text = _source('broker-market-group.ts')
    exchanges = set(re.findall(r"'(\w+)'", _literal(text, 'STOCK_BROKER_EXCHANGES', 'new Set([', '])')))
    assert exchanges and exchanges == set(broker_market_group.STOCK_BROKER_EXCHANGES)
    assert _pairs(_literal(text, 'BROKER_MARKET_CODE_TO_MARKET', '{', '}')) == broker_market_group.BROKER_MARKET_CODE_TO_MARKET
    assert _pairs(_literal(text, 'MARKET_TO_GROUP', '{', '};')) == broker_market_group._MARKET_TO_GROUP
