"""KB증권 국내 주문 본문. TypeScript 판 `ts/src/kbsec/kbsec-order-body.ts` 와 같다.

국내 주문 네 가지(매수, 매도, 정정, 취소)는 입력 레이아웃이 같고(명세 확인) 필수 여부만 다르다. 그래서 본문을 한곳에서 만들고 차이는
`override` 로 덮는다.
"""

import math
from typing import Any, Dict, Optional

from kr_broker.kbsec_types import KBSEC_CREDIT_CASH, KBSEC_ORDER_TYPE_KR, KBSEC_SESSION_REGULAR, KBSEC_SOR, kbsec_num


def build_kr_order_body(base: str, jb_clsf: str, amount: Optional[float] = None, price: Optional[float] = None, is_limit: Optional[bool] = None,
                        sor: Optional[str] = None, session: Optional[str] = None,
                        override: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """국내 주문 본문. `jb_clsf` 는 주문업무구분(`KBSEC_ORDER_SIDE_KR`)이다. `amount` 는 수량이고 취소는 전부 취소라 비워도 된다.
    `is_limit` 을 생략하면 지정가, `sor` 를 생략하면 KRX, `session` 을 생략하면 정규장이다. `override` 의 키가 본문의 같은 키를 덮는다."""
    limit = True if is_limit is None else is_limit
    body: Dict[str, Any] = {
        'mkt_tm_clsf': KBSEC_SESSION_REGULAR if session is None else session,
        'ordr_jb_clsf': jb_clsf,
        # 매도구분은 `1` 선물대용매도, `2` 입고예정매도, `3` 공매도다. 일반 현금매매는 해당 없음이라 빈 값이 정본이다.
        's_clsf': '',
        'is_cd': base,
        # 수량은 내림이다. `kbsec_num` 은 반올림이라 8.87주가 9주로 나가 요청보다 많이 산다.
        'ordr_q': kbsec_num(math.floor(0 if amount is None else amount)),
        # 시장가는 단가를 빈 값으로 보낸다. `'0'` 을 보내면 `주문단가를 확인하십시오`(1896)로 거부된다. 공식 예제 콘솔도 빈 값이다.
        'ordr_uprc': kbsec_num(0 if price is None else price) if limit else '',
        'ordr_ccd': KBSEC_ORDER_TYPE_KR['LIMIT'] if limit else KBSEC_ORDER_TYPE_KR['MARKET'],
        'crdt_typ_cd': KBSEC_CREDIT_CASH,
        'sor_ordr_ccd': KBSEC_SOR['KRX'] if sor is None else sor,
    }
    body.update(override or {})
    return body
