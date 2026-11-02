"""KB 응답 행에서 값을 뽑는 함수. TypeScript 판 `ts/src/kbsec/kbsec-pick.ts` 에서 Python 판이 쓰는 것만 옮겼다."""

import logging
from typing import Any, Callable, Dict, List, Mapping, Optional

from kr_broker.kbsec_number import kbsec_number_of, kbsec_string

logger = logging.getLogger('kr_broker')


def pick_num(row: Optional[Mapping[str, Any]], *keys: str) -> float:
    """후보 필드를 순서대로 시도해 숫자를 뽑는다. 값이 있으면 0 이어도 그 키에서 멈추고, 하나도 못 읽으면 0 이다.

    필드 이름이 틀려도 0 으로 조용히 넘어가지 않게, 후보가 하나도 없고 응답에 다른 키가 있으면 DEBUG 로그를 남긴다.
    """
    if not row:
        return 0
    for key in keys:
        n = kbsec_number_of(row.get(key))
        if n is not None:
            return n
    if not any(key in row for key in keys):
        logger.debug('[kbsec] 응답에 후보 필드가 하나도 없음 — 명세 대조 필요: tried=%s available=%s', list(keys), list(row)[:12])
    return 0


def pick_optional_num(row: Optional[Mapping[str, Any]], *keys: str) -> Optional[float]:
    """`pick_num` 과 같되 후보를 하나도 읽지 못하면 0 이 아니라 `None` 이다. 값이 없는 것과 0 을 가려야 하는 필드(거래량)에 쓴다."""
    if not row:
        return None
    for key in keys:
        n = kbsec_number_of(row.get(key))
        if n is not None:
            return n
    return None


def pick_positive_num(row: Optional[Mapping[str, Any]], *keys: str) -> float:
    """`pick_num` 과 같되 양수인 첫 후보를 고른다. KB 는 값 없음을 0 으로 준다(장 밖 국내 현재가의 `now_prc` 등)."""
    if not row:
        return 0
    for key in keys:
        n = kbsec_number_of(row.get(key))
        if n is not None and n > 0:
            return n
    return 0


def pick_str(row: Optional[Mapping[str, Any]], *keys: str) -> str:
    """공백이 아닌 첫 후보 문자열. 없으면 `''` 이다."""
    return kbsec_string(row, *keys)


def kbsec_holding_quantity(row: Mapping[str, Any]) -> float:
    """국내 보유주식(`SSQM1801`) 한 행의 보유수량. 수량 축 `gnrl_q`(결제완료)와 `ordr_psbl_q`(주문가능) 가운데 큰 쪽이다.

    어느 쪽도 상대를 포함하지 않으므로 합이 아니라 max 다. `pick_num(row, 'gnrl_q', 'ordr_psbl_q')` 처럼 후보 목록에 맡기면 앞 필드가 0 이어도
    채택해 미결제 매수분(`gnrl_q = 0`)이 보유 0 으로 읽힌다. 결제대기 매도 차감은 체결내역을 기준으로 하는 `_adjust_for_pending_sale` 이 맡는다.
    """
    return max(pick_num(row, 'gnrl_q'), pick_num(row, 'ordr_psbl_q'))


# 해외 보유 그리드에서 수량일 수 있는 필드 후보. 진단 전용이다. 행이 전부 버려졌을 때 어느 필드가 0 이 아니었는지 이름만 남긴다.
OVERSEAS_QTY_CANDIDATES = (
    'frgn_hld_q_p6', 'frgn_ordr_psbl_q_p6', 'frgn_ordr_psbl_q1_p6',
    'b_ccls_q_p6', 's_ccls_q_p6', 'b_ordr_q', 's_ordr_q',
)


def pick_grid(body: Optional[Mapping[str, Any]], is_grid: Callable[[Mapping[str, Any]], bool]) -> Dict[str, Any]:
    """응답 본문의 배열 가운데 `is_grid` 를 만족하는 첫 배열을 고른다. 길이가 아니라 필드 이름으로 고른다. 결과는 `{'rows', 'seen'}` 이고
    `seen` 은 본 배열들의 (길이, 첫 행 키)다. 배열이 둘인 TR 에서 첫 배열을 집으면 엉뚱한 그리드를 읽는다(해외 잔고평가 `SPQM2226`)."""
    seen: List[Dict[str, Any]] = []
    if not body:
        return {'rows': [], 'seen': seen}
    for value in body.values():
        if not isinstance(value, list) or len(value) == 0:
            continue
        first = value[0]
        seen.append({'len': len(value), 'keys': list(first)[:30] if isinstance(first, dict) else []})
        if isinstance(first, dict) and is_grid(first):
            return {'rows': value, 'seen': seen}
    return {'rows': [], 'seen': seen}


def unknown_grids(body: Optional[Mapping[str, Any]], known: List[Any]) -> List[Dict[str, Any]]:
    """응답 본문에서 `known` 에 없는(같은 객체가 아닌) 비어 있지 않은 배열을 모두 찾는다. 객체 안에 든 배열도 본다. (길이, 첫 행 키)를 돌려준다."""
    out: List[Dict[str, Any]] = []

    def walk(value: Any) -> None:
        if isinstance(value, list):
            if len(value) > 0 and not any(value is grid for grid in known):
                first = value[0]
                out.append({'len': len(value), 'keys': list(first)[:30] if isinstance(first, dict) else []})
            return
        if isinstance(value, dict):
            for item in value.values():
                walk(item)

    walk(body)
    return out


def pick_holding_grid(body: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """해외 잔고평가(`SPQM2226`)의 종목 그리드. 종목코드나 보유수량 필드가 있는 배열이다."""
    return pick_grid(body, lambda first: 'is_cd' in first or 'frgn_hld_q_p6' in first)


def pick_cash_grid(body: Optional[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """해외 잔고평가(`SPQM2226`)의 통화별 예수금 그리드. 통화 이름(`crncy_clsf_nm`)과 예수금(`tfnd`)이 있고 종목코드(`is_cd`)는 없다.
    종목 그리드에도 통화 이름이 있으므로 예수금 필드까지 본다. 못 찾으면 빈 목록이다."""
    return pick_grid(body, lambda first: 'crncy_clsf_nm' in first and 'tfnd' in first and 'is_cd' not in first)['rows']


def is_usd_cash_row(row: Mapping[str, Any]) -> bool:
    """통화별 예수금 그리드의 행이 달러 행인가. 명세에 통화 코드 필드가 없어 통화구분명이 `USD` 와 같은지(대소문자 무시)만 본다."""
    return pick_str(row, 'crncy_clsf_nm').upper() == 'USD'


# 빈 행이 되려면 숫자 0 이어야 하는 필드. 기준환율이 0 인 통화는 없으므로 이 행은 어느 통화의 행도 아니다.
_EMPTY_CASH_ROW_ZERO_KEYS = ('std_exch_r', 'cnvr_exch_r_p4', 'tfnd', 'ordr_psbl_amt_p2')


def is_empty_cash_row(row: Mapping[str, Any]) -> bool:
    """통화별 예수금 그리드의 빈 행인가. 통화구분명이 비고 기준환율, 전환환율, 예수금, 주문가능금액이 모두 숫자 0 인 행이다.
    외화 예수금이 없는 계좌에서 KB 는 이 그리드를 빈 행으로 채운다. 필드가 없거나 비어 있으면 0 으로 보지 않는다."""
    return pick_str(row, 'crncy_clsf_nm') == '' and all(kbsec_number_of(row.get(key)) == 0 for key in _EMPTY_CASH_ROW_ZERO_KEYS)


def pick_array(body: Optional[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """응답 `dataBody` 에서 첫 배열을 찾는다. TR 마다 배열 필드 이름이 달라서다. 배열이 하나뿐인 TR 에만 쓴다."""
    if not body:
        return []
    for value in body.values():
        if isinstance(value, list):
            return value
    return []


def pick_settlement_grid(body: Optional[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """국내 정산(`SSQM2121`) 응답의 종목 그리드. 못 고르면 무엇을 봤는지 남긴다."""
    picked = pick_grid(body, lambda first: 'is_no' in first or 'ec_amt' in first)
    if len(picked['rows']) == 0 and len(picked['seen']) > 0:
        logger.warning('[kbsec] 정산 그리드를 못 골랐다 — 필드명 대조 필요: seen=%s', picked['seen'])
    return picked['rows']


def pick_overseas_settlement_grid(body: Optional[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """해외 정산(`SPQM2205`) 응답의 종목 그리드. 못 고르면 무엇을 봤는지 남긴다."""
    picked = pick_grid(body, lambda first: 'shrt_is_cd' in first or 'frgn_stmt_amt_p4' in first)
    if len(picked['rows']) == 0 and len(picked['seen']) > 0:
        logger.warning('[kbsec] 해외 정산 그리드를 못 골랐다 — 필드명 대조 필요: seen=%s', picked['seen'])
    return picked['rows']


def kbsec_raw_response(body: Mapping[str, Any]) -> Dict[str, Any]:
    """그리드를 필드 이름으로 가를 수 없는 TR 의 응답 원문(`fetch_one_market_margin_usage`, `fetch_deposit_details`). TypeScript 판 `kbsecRawResponse` 와 같다.
    배열이 아닌 필드는 `fields` 에, 배열(그리드)은 응답에 나온 순서대로 `grids` 에 담는다. 그리드마다 무엇인지는 명세에 없다."""
    fields: Dict[str, Any] = {}
    grids: List[Any] = []
    for key, value in body.items():
        if isinstance(value, list):
            grids.append(value)
        else:
            fields[key] = value
    return {'fields': fields, 'grids': grids, 'info': body}


def kbsec_raw_fields(body: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """응답 본문에서 배열이 아닌 필드만 모은다. TypeScript 판 `kbsecRawResponse(body).fields` 와 같다."""
    if not body:
        return {}
    return {key: value for key, value in body.items() if not isinstance(value, list)}


def kbsec_sector_index(row: Mapping[str, Any]) -> Dict[str, Any]:
    """업종랭킹(`IVM30010`)의 지수 하나. 전일대비는 원문 값이고, 전일대비구분코드(`bdy_cmpr_ccd`)는 `info` 에 있다."""
    return {
        'id': pick_str(row, 'indx_id'),
        'name': pick_str(row, 'indx_nm'),
        'value': pick_num(row, 'now_indx_p2'),
        'change': pick_num(row, 'bdy_cmpr_p2'),
        'percentage': pick_num(row, 'up_dwn_r_p2'),
        'info': row,
    }
