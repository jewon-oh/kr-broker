"""KB증권 국내 정산 행 파서. `SSQM2121`(계좌별매매가정산현황)의 필드 이름은 이 모듈만 안다.
TypeScript 판 `ts/src/kbsec/kbsec-settlement-row.ts` 와 같다. 필드 표와 실응답 근거는 TypeScript 판 설명에 있다.

- 체결 TR(`SSQM2341`, `SPQM2103`)에는 수수료 필드가 없다. KB 가 실제로 청구한 금액을 주는 곳은 정산 TR 뿐이다.
- `ec_amt`(정산금액)는 비용이 이미 반영된 금액이라 비용으로 쓰지 않는다. 비용은 수수료 + 세금(`kbsec_settlement_cost_krw`)이고,
  `ec_amt` 는 묶음 검산(`kbsec_resolve_settlement_rows`)에만 쓴다.
- 매매구분(`trd_clsf`)의 `9`(전체)는 실응답이 잘린 부분집합이라 매도(`1`)와 매수(`2`)를 따로 부른다.
- `clsf=1`(단가별)로 부르면 한 종목의 두 번째 단가부터 종목·방향이 공백인 연속 행으로 오고, 비용은 묶음의 마지막 행에만 실린다.

결과 사전의 키는 TypeScript 판과 같은 camelCase 다.
"""

from typing import Any, Dict, List, Mapping, Optional

from kr_broker.base import functions as fn
from kr_broker.kbsec_number import kbsec_number as num
from kr_broker.kbsec_types import kbsec_normalize_code

# `clsf`(구분) 입력 코드. 단가별은 같은 종목·방향이라도 체결단가마다 행이 나뉘고, 종목별은 하루치를 종목·방향 단위로 묶는다.
KBSEC_SETTLE_CLSF = {'BY_PRICE': '1', 'BY_SYMBOL': '2'}
# `trd_clsf`(매매구분) 입력 코드. `ALL`(`9`)은 실응답이 잘려 비용 행 일부가 빠지므로 `SELL`·`BUY` 를 따로 부른다.
KBSEC_SETTLE_TRD_CLSF = {'ALL': '9', 'SELL': '1', 'BUY': '2'}
# 검산 여유(원). 비용 항목 넷이 각각 원 단위로 끊기므로 그만큼은 열어 둔다.
SETTLEMENT_CONSISTENCY_TOLERANCE_KRW = 4


def _text(raw: Mapping[str, Any], key: str) -> str:
    """JavaScript `String(raw[key] ?? '').trim()` 과 같다."""
    value = raw.get(key)
    return '' if value is None else fn.js_string(value).strip()


def kbsec_settlement_side_of(raw: Mapping[str, Any]) -> Optional[str]:
    """정산 행의 매매 방향. 출력 `trd_clsf` 는 `char(8)` 이라 코드(`1`·`2`)로도 이름(`매도`·`현금매수` 계열)으로도 올 수 있어 둘 다 받는다.
    `trd_clsf` 다음에 `dl_clsf` 를 본다. 어느 쪽으로도 못 읽으면 `None` 이다. 방향을 모르는 비용을 한쪽에 붙이면 조용히 틀린다."""
    for key in ('trd_clsf', 'dl_clsf'):
        v = _text(raw, key)
        if v == '':
            continue
        if v == KBSEC_SETTLE_TRD_CLSF['SELL']:
            return 'sell'
        if v == KBSEC_SETTLE_TRD_CLSF['BUY']:
            return 'buy'
        if '매도' in v:
            return 'sell'
        if '매수' in v:
            return 'buy'
    return None


def parse_kbsec_domestic_settlement_row(raw: Mapping[str, Any]) -> Dict[str, Any]:
    """`SSQM2121` 그리드 한 행 → 정규화. 금액은 모두 원화다. 종목코드가 비면 단가별 연속 행(`continuation`)이다."""
    quantity = num(raw, 'ccls_q', 'tl_ccls_q')
    price_krw = num(raw, 'ccls_uprc')
    notional = num(raw, 'dl_amt')
    symbol = kbsec_normalize_code(_text(raw, 'is_no'))
    return {
        'symbol': symbol,
        'side': kbsec_settlement_side_of(raw),
        'continuation': symbol == '',
        'quantity': quantity,
        'priceKrw': price_krw,
        'notionalKrw': notional if notional > 0 else quantity * price_krw,
        'feeKrw': num(raw, 'fee'),
        # 현물 현금매매에서 소득세·주민세는 0 이지만, 신용·배당 계좌로 넓어져도 비용이 빠지지 않게 합계에 넣는다.
        'taxKrw': num(raw, 'dl_tx') + num(raw, 'ffs_tx') + num(raw, 'incm_tx') + num(raw, 'rsdnt_tx'),
        'settledKrw': num(raw, 'ec_amt'),
    }


def kbsec_settlement_cost_krw(row: Mapping[str, Any]) -> float:
    """이 행의 총 매매비용(원화). 수수료 + 세금이다. `ec_amt` 가 아니다."""
    return row['feeKrw'] + row['taxKrw']


def kbsec_resolve_settlement_rows(rows: List[Dict[str, Any]], tolerance_krw: float = SETTLEMENT_CONSISTENCY_TOLERANCE_KRW) -> Dict[str, Any]:
    """연속 행을 앞 헤더 행에 귀속시키고 종목 묶음 단위로 검산한다. 결과는 `{'rows', 'inconsistent', 'orphaned'}` 다.

    `clsf=1` 은 비용과 정산금액을 묶음의 마지막 행에만 싣는다. 행 단위로 검산하면 비용이 실린 행이 버려지므로 묶음으로 본다
    (`|거래금액 합 − 정산금액| ≈ 비용 합`). 검산에 실패한 묶음은 통째로 버린다. 정산금액이 0 인 묶음은 잴 근거가 없어 통과시킨다.
    주인 없는 연속 행(페이지 경계 등)도 버린다. 귀속할 곳을 모르는 비용을 남의 종목에 붙이지 않는다.
    """
    resolved: List[Dict[str, Any]] = []
    header: Optional[Dict[str, Any]] = None
    orphaned = 0
    for row in rows:
        if not row['continuation']:
            header = row
            resolved.append(row)
            continue
        if header is None:
            orphaned += 1
            continue
        resolved.append(dict(row, symbol=header['symbol'], side=header['side'], continuation=False))

    groups: Dict[str, List[Dict[str, Any]]] = {}
    for r in resolved:
        side = r['side']
        groups.setdefault(f"{r['symbol']}|{'?' if side is None else side}", []).append(r)

    out: List[Dict[str, Any]] = []
    inconsistent = 0
    for group in groups.values():
        notional: float = 0
        cost: float = 0
        settled: float = 0
        for r in group:
            notional += r['notionalKrw']
            cost += kbsec_settlement_cost_krw(r)
            # 정산금액은 묶음의 마지막 행에만 실린다. 0 이 아닌 값을 집는다.
            settled = max(settled, r['settledKrw'])
        if notional > 0 and settled > 0 and abs(abs(notional - settled) - cost) > tolerance_krw:
            inconsistent += len(group)
            continue
        out.extend(group)
    return {'rows': out, 'inconsistent': inconsistent, 'orphaned': orphaned}
