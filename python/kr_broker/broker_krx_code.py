"""국내(KRX) 종목코드 판정. TypeScript 판 `ts/src/broker-krx-code.ts` 와 같다. 이 모듈은 다른 모듈을 가져오지 않는다."""

import re

# KRX 종목코드 자릿수.
KIS_KRX_CODE_DIGITS = 6

_KIS_KRX_CODE_RE = re.compile(r'[0-9]{%d}' % KIS_KRX_CODE_DIGITS)

# 신형 영숫자 KRX 단축코드 화이트리스트. 2026-05-27 단일종목 레버리지·인버스 ETF 에 6자리 영숫자 코드가 생겼다.
# 임의의 6자리 영숫자를 국내로 넓히지 않도록 목록으로만 한정한다.
KNOWN_ALNUM_KRX_CODES = frozenset([
    '0193L0',  # PLUS 삼성전자선물단일종목인버스2X (삼성전자 005930)
    '0197X0',  # SOL SK하이닉스선물단일종목인버스2X (SK하이닉스 000660)
])


def is_krx_domestic_code(code: str) -> bool:
    """국내 KRX 종목코드인가. 6자리 숫자이거나 목록에 있는 신형 영숫자 코드다."""
    return _KIS_KRX_CODE_RE.fullmatch(code) is not None or code in KNOWN_ALNUM_KRX_CODES
