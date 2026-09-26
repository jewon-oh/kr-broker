"""KIS 실시간 웹소켓 프레임 파서. TypeScript 판 `ts/src/kis/kis-realtime-parser.ts` 를 옮겼다. 동기·비동기 판과 무관한 순수 함수다.

프레임은 `<암호화 여부>|<TR ID>|<건수>|<본문(^ 구분)>` 이다. JSON(`{` 로 시작하는 구독 응답과 PINGPONG)과 빈 프레임은 빈 목록이고,
체결(`H0STCNT0`, `HDFSCNT0`)과 호가(`H0STASP0`)만 레코드로 바꾼다(종목코드는 받은 그대로다). 필드 위치는 `kis_types.KIS_WS_FIELD` 를 따른다.
"""

import json
import math
from typing import List, Mapping, NamedTuple, Optional, Tuple, Union

from kr_broker.base import functions as fn
from kr_broker.broker_market_group import common_stock_code
from kr_broker.kis_types import KIS_WS_FIELD, KIS_WS_TR, is_overseas_symbol

__all__ = ['OVERSEAS_STREAM_QUOTE', 'KisTradeRecord', 'KisOrderbookRecord', 'to_stream_symbol', 'parse_kis_realtime_frame', 'parse_kis_realtime_payload',
           'is_ping_pong']

# 해외 주식 스트림의 호가 통화. `USDT` 가 아니라 `USD` 다. 가격 스트림을 받는 쪽이 거래소 접두 없는 심볼을 키로 쓰면, 주식을 토큰화해
# `AMD/USDT` 로 거래하는 거래소의 피드와 키가 겹쳐 다른 자산 가격으로 손절·익절을 평가할 수 있다. `USD` 는 스테이블코인 페어에 쓰이지 않는다.
OVERSEAS_STREAM_QUOTE = 'USD'


class KisTradeRecord(NamedTuple):
    """체결 한 건."""
    # 받은 종목코드(국내 005930, 해외 AAPL)
    symbol: str
    last: float
    change_pct: float
    kind: str = 'trade'


class KisOrderbookRecord(NamedTuple):
    """호가 한 건. 가격과 잔량 쌍을 좋은 가격부터 담는다."""
    symbol: str
    bids: List[Tuple[float, float]]
    asks: List[Tuple[float, float]]
    kind: str = 'orderbook'


KisRealtimeRecord = Union[KisTradeRecord, KisOrderbookRecord]


def to_stream_symbol(raw_symbol: str, codes: Optional[Mapping[str, str]] = None) -> str:
    """실시간 종목코드를 가격 스트림 키로 바꾼다. 국내(6자리)는 `<코드>/KRW`, 해외는 `<티커>/USD` 다. 현금 코드와 같은 티커는 표(`codes`,
    없으면 `COMMON_STOCK_CODES`)의 통합 코드를 쓴다(`USD` → `ProShares Ultra Semiconductors/USD`)."""
    code = raw_symbol.upper()
    return f'{common_stock_code(code, codes)}/{OVERSEAS_STREAM_QUOTE}' if is_overseas_symbol(code) else f'{code}/KRW'


def _number_at(fields: List[str], index: int) -> float:
    """JavaScript 의 `Number(fields[index])`. 범위 밖(`undefined`)은 NaN 이다."""
    return fn.js_number(fields[index]) if 0 <= index < len(fields) else math.nan


def parse_kis_realtime_frame(raw: str) -> List[KisRealtimeRecord]:
    """실시간 프레임 하나를 레코드 목록으로 바꾼다. 제어·빈·지원하지 않는 프레임은 빈 목록이다.

    라이브러리 안에서 쓰지 않는다. 연결은 복호한 본문을 `parse_kis_realtime_payload` 로 읽는다. 다음 판에서 지운다.
    """
    if not raw or raw[0] == '{':
        return []
    parts = raw.split('|')
    if len(parts) < 4:
        return []
    return parse_kis_realtime_payload(parts[1], parts[2], '|'.join(parts[3:]))


def parse_kis_realtime_payload(tr_id: str, count_text: str, payload: str) -> List[KisRealtimeRecord]:
    """프레임의 TR, 건수, 본문(`^` 구분)을 레코드 목록으로 바꾼다. `KisPriceWs` 는 연결이 복호까지 마친 본문을 넘긴다."""
    count_number = fn.js_number(count_text)
    # JavaScript 의 `Math.max(1, Number(countText) || 1)`
    count = max(1, count_number if count_number and not math.isnan(count_number) else 1)
    fields = payload.split('^')
    out: List[KisRealtimeRecord] = []

    if tr_id in (KIS_WS_TR['DOMESTIC_TRADE'], KIS_WS_TR['OVERSEAS_TRADE']):
        record_size = max(1, len(fields) // count)
        overseas = tr_id == KIS_WS_TR['OVERSEAS_TRADE']
        sym_idx = KIS_WS_FIELD['OVERSEAS_TRADE_SYMBOL'] if overseas else 0
        last_idx = KIS_WS_FIELD['OVERSEAS_TRADE_LAST'] if overseas else KIS_WS_FIELD['DOMESTIC_TRADE_LAST']
        pct_idx = KIS_WS_FIELD['OVERSEAS_TRADE_CHANGE_PCT'] if overseas else KIS_WS_FIELD['DOMESTIC_TRADE_CHANGE_PCT']
        r = 0
        while r < count:
            base = int(r * record_size)
            symbol = (fields[base + sym_idx] if base + sym_idx < len(fields) else '').strip()
            last = _number_at(fields, base + last_idx)
            pct = _number_at(fields, base + pct_idx)
            if symbol and math.isfinite(last) and last > 0:
                out.append(KisTradeRecord(symbol, last, pct if math.isfinite(pct) else 0))
            r += 1
            if base + sym_idx >= len(fields):
                # 이 뒤로는 모두 범위 밖이다. 건수가 터무니없이 커도 끝나게 멈춘다.
                break
        return out

    if tr_id == KIS_WS_TR['DOMESTIC_ASKING']:
        symbol = fields[0].strip()
        bids: List[Tuple[float, float]] = []
        asks: List[Tuple[float, float]] = []
        for i in range(10):
            ap = _number_at(fields, KIS_WS_FIELD['DOMESTIC_ASKP_BASE'] + i)
            aq = _number_at(fields, KIS_WS_FIELD['DOMESTIC_ASKP_RSQN_BASE'] + i)
            if math.isfinite(ap) and ap > 0:
                asks.append((ap, aq if math.isfinite(aq) else 0))
            bp = _number_at(fields, KIS_WS_FIELD['DOMESTIC_BIDP_BASE'] + i)
            bq = _number_at(fields, KIS_WS_FIELD['DOMESTIC_BIDP_RSQN_BASE'] + i)
            if math.isfinite(bp) and bp > 0:
                bids.append((bp, bq if math.isfinite(bq) else 0))
        if symbol and (len(bids) > 0 or len(asks) > 0):
            out.append(KisOrderbookRecord(symbol, bids, asks))
        return out

    # 해외 호가(HDFSASP0) 등은 아직 읽지 않는다.
    return out


def is_ping_pong(raw: str) -> bool:
    """PINGPONG 제어 메시지인가(받은 그대로 되돌려 보내야 한다)."""
    if not raw or raw[0] != '{':
        return False
    try:
        message = json.loads(raw)
    except ValueError:
        return False
    header = message.get('header') if isinstance(message, dict) else None
    return isinstance(header, dict) and header.get('tr_id') == KIS_WS_TR['PINGPONG']
