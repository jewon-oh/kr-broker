"""KB증권 체결 행 파서. 국내 `SSQM2341`(계좌별주문체결조회)와 해외 `SPQM2103`(해외 주문체결조회)의 필드 이름은 이 모듈만 안다.
TypeScript 판 `ts/src/kbsec/kbsec-fill-row.ts` 와 같다. 필드 표와 실응답 근거는 TypeScript 판 설명에 있다.

- 한 행이 한 체결이다. 이름은 총체결수량(`tl_ccls_q`)이지만 누적이 아니라 그 한 건의 수량이라, 주문의 체결수량은 행의 합이다.
- 분할체결은 헤더 행 하나와 식별자를 지운 연속 행 여럿으로 온다(연속 행은 `ordr_no` 가 전부 `0`, 종목·방향은 공백, `ordr_q` 는 0).
  연속 행을 독립된 체결로 읽으면 낸 주문에 맞지 않아 첫 행의 수량만 체결로 확정되므로, `kbsec_resolve_fills` 가 바로 앞 헤더 행에 귀속시킨다.
- 헤더 없이 온 연속 행(페이지 경계 등)은 귀속할 곳이 없어 식별자를 비운 채 내보내고 소비처가 버린다. 덜 세는 쪽이라 유령청산으로 이어지지 않는다.
- 방향은 구분명(`trd_dl_ccd_nm`·`dl_clsf_nm`)에 `매도` 가 있으면 매도, `매수` 가 있으면 매수다. `ordr_typ_cd` 는 방향 축으로 쓰지 않는다.

결과 사전의 키는 TypeScript 판과 같은 camelCase 다. 체결 건(`kbsec_resolve_fills` 의 결과)은 `Trade.info` 로 나간다.
"""

import math
import re
from typing import Any, Dict, List, Mapping, Optional

from kr_broker.base import functions as fn
from kr_broker.kbsec_number import kbsec_number as num_of, kbsec_string as str_of
from kr_broker.kbsec_types import KBSEC_TRD_SELL, kbsec_normalize_code

_ALL_ZERO = re.compile(r'0+')


def kbsec_fill_side_of(row: Mapping[str, Any]) -> Optional[str]:
    """매매 방향. 구분명(국내 `trd_dl_ccd_nm`, 해외 `dl_clsf_nm`) → `trd_clsf`(종전 이름, 폴백) 순서로 읽고, 둘 다 없으면 `None` 이다.
    `공매도`·`신용매도` 를 매수로 읽지 않게 `매도` 를 먼저 본다."""
    name = str_of(row, 'trd_dl_ccd_nm', 'dl_clsf_nm')
    if name:
        if '매도' in name:
            return 'sell'
        if '매수' in name:
            return 'buy'
    legacy = str_of(row, 'trd_clsf')
    if legacy:
        return 'sell' if legacy == KBSEC_TRD_SELL else 'buy'
    return None


def _is_amended(row: Mapping[str, Any]) -> bool:
    """정정·취소가 걸린 행인가. `crct_cncl_ccd` 의 값 어휘가 확정되지 않아 0 이 아니면 걸린 것으로 본다."""
    value = str_of(row, 'crct_cncl_ccd')
    return value != '' and fn.js_number(value) != 0


def _cost_of(row: Mapping[str, Any], filled_qty: float, price: float) -> float:
    """체결금액. 행에 `ccls_amt` 가 있으면 그 값, 없으면 수량 × 단가다. 단가가 0 이면 모르는 값을 지어내지 않고 0 이다."""
    explicit = num_of(row, 'ccls_amt')
    if explicit > 0:
        return explicit
    return filled_qty * price if price > 0 else 0


def _order_no_of(row: Mapping[str, Any]) -> Dict[str, Any]:
    """주문번호. 전부 `0` 이면 KB 어휘로 "없음" 이라 분할체결 연속 행이다. 빈 값은 모르는 것이라 연속 행으로 보지 않는다."""
    raw = str_of(row, 'ordr_no', 'odno')
    if raw != '' and _ALL_ZERO.fullmatch(raw) is not None:
        return {'orderId': '', 'continuation': True}
    return {'orderId': raw, 'continuation': False}


def parse_kbsec_domestic_fill_row(row: Mapping[str, Any]) -> Dict[str, Any]:
    """국내 `SSQM2341` 그리드 한 행을 정규화한다. 로그와 I/O 가 없다."""
    filled_qty = num_of(row, 'tl_ccls_q', 'ccls_q')
    price = num_of(row, 'ccls_uprc', 'ccls_prc')
    order_no = _order_no_of(row)
    return {
        'orderId': order_no['orderId'],
        'symbol': kbsec_normalize_code(str_of(row, 'stnd_is_no', 'is_cd', 'shrt_cd')),
        'side': kbsec_fill_side_of(row),
        'filledQty': filled_qty,
        'unfilledQty': num_of(row, 'nccls_q'),
        'orderQty': num_of(row, 'ordr_q'),
        'price': price,
        'cost': _cost_of(row, filled_qty, price),
        'seq': str_of(row, 'ccls_ntc_tm', 'ordr_tm'),
        'amended': _is_amended(row),
        'continuation': order_no['continuation'],
    }


def parse_kbsec_overseas_fill_row(row: Mapping[str, Any]) -> Dict[str, Any]:
    """해외 `SPQM2103` 그리드 한 행을 정규화한다. 스펙 이름(`ccls_q_p6`·`frgn_ccls_prc_p6`)이 먼저이고 국내 이름은 폴백이다.
    연속 행 표기는 해외에서 실측하지 못했지만 같은 `ordr_no` 필드라 같은 규칙을 적용한다."""
    filled_qty = num_of(row, 'ccls_q_p6', 'tl_ccls_q', 'ccls_q')
    price = num_of(row, 'frgn_ccls_prc_p6', 'ccls_uprc', 'ccls_prc')
    order_no = _order_no_of(row)
    return {
        'orderId': order_no['orderId'],
        'symbol': kbsec_normalize_code(str_of(row, 'is_cd', 'stnd_is_no')),
        'side': kbsec_fill_side_of(row),
        'filledQty': filled_qty,
        'unfilledQty': 0,
        'orderQty': num_of(row, 'frgn_ordr_q_p6', 'ordr_q'),
        'price': price,
        'cost': _cost_of(row, filled_qty, price),
        'seq': str_of(row, 'ccls_ttm', 'ordr_ttm'),
        'amended': _is_amended(row),
        'continuation': order_no['continuation'],
    }


def kbsec_fill_totals_inconsistent(rows: List[Dict[str, Any]]) -> bool:
    """수량 모델의 자가진단. 주문 단위로 `Σ체결 + 잔여미체결 = 주문수량` 이 깨진 주문이 있으면 참이다.

    깨졌다면 연속 행을 놓쳤거나 수량 모델이 바뀐 것이고, 어느 쪽이든 분할체결이 실제보다 적게 확정된다. 잔여미체결은 그 주문 행들의
    `nccls_q` 최솟값이다(체결이 진행될수록 줄어든다). 정정·취소가 낀 주문은 오탐이라 빼고, 주문수량이나 체결수량이 없는 주문은 판정하지 않는다.
    """
    header: Optional[Dict[str, Any]] = None
    filled = 0.0
    min_unfilled = math.inf
    amended = False
    broken = False

    def settle() -> None:
        nonlocal broken
        if header is None or amended:
            return
        if not header['orderQty'] > 0 or not filled > 0:
            return
        remaining = min_unfilled if math.isfinite(min_unfilled) else 0
        if filled + remaining != header['orderQty']:
            broken = True

    for r in rows:
        if not r['continuation']:
            settle()
            header, filled, min_unfilled, amended = r, 0.0, math.inf, False
        if r['amended']:
            amended = True
        filled += r['filledQty']
        min_unfilled = min(min_unfilled, r['unfilledQty'])
    settle()
    return broken


def kbsec_fill_totals_checked_orders(rows: List[Dict[str, Any]]) -> int:
    """검산으로 실제 판정한 주문 수. 0 이면 "통과" 가 아니라 "아무것도 못 봤다" 다."""
    return len([r for r in rows if not r['continuation'] and not r['amended'] and r['orderQty'] > 0 and r['filledQty'] > 0])


def kbsec_resolve_fills(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """체결 행을 식별자가 붙은 체결 건 목록으로 바꾼다. 연속 행은 바로 앞 헤더 행의 `orderId`, `symbol`, `side` 를 물려받는다.

    수량은 건별이라 차분도 중복 제거도 하지 않는다. 헤더 없이 시작하는 연속 행은 식별자를 비운 채 내보내고 소비처가 버린다.
    수량이 0 이하인 행은 내지 않는다. 단가 0 인 체결은 그대로 내고, 버릴지는 소비처가 정한다.
    """
    out: List[Dict[str, Any]] = []
    header: Optional[Dict[str, Any]] = None
    for r in rows:
        if not r['continuation']:
            header = r
        owner = header if r['continuation'] else r
        if not r['filledQty'] > 0:
            continue
        out.append({
            'orderId': '' if owner is None else owner['orderId'],
            'symbol': '' if owner is None else owner['symbol'],
            'side': None if owner is None else owner['side'],
            'qty': r['filledQty'],
            'price': r['price'],
            'cost': r['filledQty'] * r['price'] if r['price'] > 0 else 0,
        })
    return out
