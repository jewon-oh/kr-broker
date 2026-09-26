"""체결 행 해석이 어긋났을 때 남기는 경고. TypeScript 판 `ts/src/kbsec/kbsec-fill-warnings.ts` 와 같다.

체결 행 파서(`kbsec_fill_row`)의 필드 이름과 값 규칙이 틀리면 조용히 잘못된 수량이 나오므로, 어긋난 징후를 찾는 자리마다 경고를 남긴다.
같은 줄이 반복해 쌓이지 않도록 프로세스당 횟수를 제한한다. 값이 아니라 키만 남긴다. 수량과 종목은 민감 정보다.
동기 판과 비동기 판이 이 모듈 하나를 함께 쓴다. 테스트는 `kr_broker.testing.reset_fill_side_warn` 으로 횟수를 비운다.
"""

import logging
from typing import Any, Dict, List, Mapping

from kr_broker.kbsec_fill_row import kbsec_fill_totals_checked_orders, kbsec_fill_totals_inconsistent

logger = logging.getLogger('kr_broker')

# 수량 검산 경고 횟수 상한. 오탐(정정 행 등)이 먼저 뜨면 뒤의 진짜 불일치가 안 보이므로 한 번이 아니라 이 횟수까지 남긴다.
FILL_TOTALS_WARN_LIMIT = 3

_state = {'sideUnreadableWarned': False, 'withoutPriceWarned': False, 'totalsWarnCount': 0}


def warn_if_fill_side_unreadable(rows: List[Dict[str, Any]], side_known: int, where: str) -> None:
    """행은 왔는데 방향을 한 행도 못 읽었으면 필드 이름이 또 어긋난 것이다. 프로세스당 한 번 남긴다."""
    if len(rows) == 0 or side_known > 0 or _state['sideUnreadableWarned']:
        return
    _state['sideUnreadableWarned'] = True
    logger.warning('[kbsec] 체결 행의 매매 방향을 한 행도 못 읽음 — trd_dl_ccd_nm 값 규칙 대조 필요'
                   ' (방향 미상 행은 결제대기 차감에서 제외된다): where=%s rows=%s rowKeys=%s', where, len(rows), list(rows[0])[:60])


def warn_if_fill_totals_inconsistent(parsed: List[Dict[str, Any]], rows: List[Dict[str, Any]], where: str) -> None:
    """주문 단위 수량 검산(`Σ체결 + 잔여미체결 = 주문수량`)이 깨졌거나, 검산한 주문이 하나도 없을 때 남긴다."""
    if _state['totalsWarnCount'] >= FILL_TOTALS_WARN_LIMIT or len(parsed) == 0:
        return
    row_keys = list(rows[0])[:60] if rows else []
    continuation = len([r for r in parsed if r['continuation']])
    # 검산 대상이 통째로 비면 검산은 통과가 아니라 아무것도 안 본 것이다. KB 의 "정정 없음" 기본값이 `0` 이 아니면 모든 주문이 빠진다.
    checked = kbsec_fill_totals_checked_orders(parsed)
    if checked == 0:
        _state['totalsWarnCount'] += 1
        logger.warning('[kbsec] 수량 검산 대상이 0건 — 검산이 통과한 게 아니라 아무것도 못 봤다 (crct_cncl_ccd 기본값이 0 이 아닐 수 있다): '
                       'where=%s rows=%s amended=%s continuation=%s seen=%s rowKeys=%s', where, len(rows),
                       len([r for r in parsed if r['amended']]), continuation, _state['totalsWarnCount'], row_keys)
        return
    if not kbsec_fill_totals_inconsistent(parsed):
        return
    _state['totalsWarnCount'] += 1
    logger.warning('[kbsec] 주문 수량 검산 불일치 (Σ체결 + 미체결 ≠ 주문수량) — 분할체결 연속 행을 놓쳤거나 수량 모델이 바뀌었다'
                   '(kbsec_fill_row 대조 필요): where=%s rows=%s checked=%s seen=%s continuation=%s rowKeys=%s', where, len(rows), checked,
                   _state['totalsWarnCount'], continuation, row_keys)


def warn_fill_without_price(row: Mapping[str, Any], symbol: str) -> None:
    """체결수량은 있는데 단가가 0 이다. 확정에 쓰지 않고 버린다는 사실을 프로세스당 한 번 남긴다."""
    if _state['withoutPriceWarned']:
        return
    _state['withoutPriceWarned'] = True
    logger.warning('[kbsec] 체결 행에 수량은 있으나 단가(ccls_uprc)가 0 — 확정에 쓰지 않음(필드명 대조 필요): symbol=%s rowKeys=%s', symbol, list(row)[:60])


def reset_fill_side_warn() -> None:
    """테스트용. 경고 횟수 제한을 비운다."""
    _state['sideUnreadableWarned'] = False
    _state['withoutPriceWarned'] = False
    _state['totalsWarnCount'] = 0
