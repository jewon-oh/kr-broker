"""KB증권 해외 정산 행 파서. `SPQM2205`(매매가정산현황)의 필드 이름은 이 모듈만 안다.
TypeScript 판 `ts/src/kbsec/kbsec-overseas-settlement-row.ts` 와 같다. 필드 표와 실응답 근거는 TypeScript 판 설명에 있다.

국내 짝(`kbsec_settlement_row`)과 하나로 합치지 않는다. 다음이 다르다.

- 매매구분이 두 자리(`99` 전체, `01` 매도, `02` 매수)이고, `99` 로 매도·매수가 다 온다.
- 단가별 연속 행이 없다(입력에 `clsf` 축이 없다).
- 정산 항등식이 `정산 = 약정 ± 수수료` 다. 세금은 항등식 밖이라 검산에 넣지 않는다.
- 통화 축이 `krw_unty_mgn_rqst_f` 로 갈린다. 이 파서는 외화(USD) 축만 받고, 행의 `crncy_cd` 가 USD 가 아니면 버린다.

`frgn_stmt_amt_p4`(정산금액)는 비용이 이미 반영된 금액이라 비용으로 쓰지 않는다. 비용은 수수료 + 세금(`kbsec_overseas_settlement_cost_usd`)이다.
주문일자(`ordr_dt`)는 미국 현지 일자다. 결과 사전의 키는 TypeScript 판과 같은 camelCase 다.
"""

from typing import Any, Dict, List, Mapping, Optional

from kr_broker.base import functions as fn
from kr_broker.kbsec_number import kbsec_number as num

# `trd_clsf`(매매구분) 입력 코드. 국내와 달리 두 자리다. 전체(`99`)는 국내 `9` 와 달리 잘리지 않는다.
KBSEC_OVERSEAS_SETTLE_TRD_CLSF = {'ALL': '99', 'SELL': '01', 'BUY': '02'}
# `dl_clsf`(거래구분) 입력 코드. `0` 전체, `1` 일반거래, `2` 소수점거래다.
KBSEC_OVERSEAS_SETTLE_DL_CLSF = {'ALL': '0', 'NORMAL': '1', 'FRACTIONAL': '2'}
# `krw_unty_mgn_rqst_f`(원화통합증거금) 입력. 통화 축이다. 명세는 `0: 외화기준` 이라 적지만 실응답에서 외화 기준은 빈 값이라 빈 값을 보낸다.
KBSEC_OVERSEAS_SETTLE_FX_AXIS = {'FOREIGN': '', 'KRW': '1'}
# 이 파서가 받아들이는 통화. 외화 축의 미국 주식이다.
KBSEC_OVERSEAS_SETTLE_CURRENCY = 'USD'
# 검산 여유(USD). 항등식의 금액 셋이 각각 소수 4자리에서 끊기고 한 묶음에 여러 행이 담길 수 있다.
OVERSEAS_SETTLEMENT_CONSISTENCY_TOLERANCE_USD = 0.01


def _text(raw: Mapping[str, Any], key: str) -> str:
    """JavaScript `String(raw[key] ?? '').trim()` 과 같다."""
    value = raw.get(key)
    return '' if value is None else fn.js_string(value).strip()


def kbsec_overseas_settlement_side_of(raw: Mapping[str, Any]) -> Optional[str]:
    """정산 행의 매매 방향. 출력에 코드 `trd_clsf` 가 없어 이름 `trd_clsf_nm`(`매수`·`매도`)이 정본이고, `etc_trd_ccd`(`01` 매도, `02` 매수)가 폴백이다.
    어느 쪽으로도 못 읽으면 `None` 이다."""
    name = _text(raw, 'trd_clsf_nm')
    if '매도' in name:
        return 'sell'
    if '매수' in name:
        return 'buy'
    code = _text(raw, 'etc_trd_ccd')
    if code == KBSEC_OVERSEAS_SETTLE_TRD_CLSF['SELL']:
        return 'sell'
    if code == KBSEC_OVERSEAS_SETTLE_TRD_CLSF['BUY']:
        return 'buy'
    return None


def parse_kbsec_overseas_settlement_row(raw: Mapping[str, Any]) -> Dict[str, Any]:
    """`SPQM2205` 그리드 한 행 → 정규화. 금액은 모두 외화(USD) 축이다."""
    quantity = num(raw, 'stmt_q_p6')
    price_usd = num(raw, 'frgn_stmt_prc_p6')
    notional = num(raw, 'frgn_agr_amt_p4')
    return {
        'symbol': _text(raw, 'shrt_is_cd'),
        'side': kbsec_overseas_settlement_side_of(raw),
        'orderDateUs': _text(raw, 'ordr_dt'),
        'settlementDateUs': _text(raw, 'stmt_dt'),
        'quantity': quantity,
        'priceUsd': price_usd,
        'notionalUsd': notional if notional > 0 else quantity * price_usd,
        'feeUsd': num(raw, 'frgn_trd_fee_p4'),
        # SEC fee 는 `frgn_dl_tx_p4`, PTP 원천징수는 `ptp_tx_amt` 로 따로 온다. 둘 다 합계에 넣는다.
        'taxUsd': num(raw, 'frgn_dl_tx_p4') + num(raw, 'ptp_tx_amt'),
        'settledUsd': num(raw, 'frgn_stmt_amt_p4', 'stmt_amt_p4'),
        'currency': _text(raw, 'crncy_cd').upper(),
    }


def kbsec_overseas_settlement_cost_usd(row: Mapping[str, Any]) -> float:
    """이 행의 총 매매비용(USD). 수수료 + 세금이다. `frgn_stmt_amt_p4` 가 아니다."""
    return row['feeUsd'] + row['taxUsd']


def kbsec_resolve_overseas_settlement_rows(rows: List[Dict[str, Any]],
                                           tolerance_usd: float = OVERSEAS_SETTLEMENT_CONSISTENCY_TOLERANCE_USD) -> Dict[str, Any]:
    """통화 축을 확인하고 (주문일자 × 종목 × 매매구분) 묶음 단위로 검산한다. 결과는 `{'rows', 'inconsistent', 'foreignCurrency'}` 다.

    USD 가 아닌 행은 버린다(축이 다른 금액을 USD 필드에 넣지 않는다). 검산식은 `|약정 합 − 정산 합| ≈ 수수료 합` 이고 세금은 넣지 않는다.
    검산에 실패한 묶음은 통째로 버린다. 정산금액이 0 인 묶음은 잴 근거가 없어 통과시킨다.
    """
    groups: Dict[str, List[Dict[str, Any]]] = {}
    foreign_currency = 0
    for row in rows:
        if row['currency'] != KBSEC_OVERSEAS_SETTLE_CURRENCY:
            foreign_currency += 1
            continue
        side = row['side']
        groups.setdefault(f"{row['orderDateUs']}|{row['symbol']}|{'?' if side is None else side}", []).append(row)

    out: List[Dict[str, Any]] = []
    inconsistent = 0
    for group in groups.values():
        notional: float = 0
        fee: float = 0
        settled: float = 0
        for r in group:
            notional += r['notionalUsd']
            fee += r['feeUsd']
            settled += r['settledUsd']
        if notional > 0 and settled > 0 and abs(abs(notional - settled) - fee) > tolerance_usd:
            inconsistent += len(group)
            continue
        out.extend(group)
    return {'rows': out, 'inconsistent': inconsistent, 'foreignCurrency': foreign_currency}
