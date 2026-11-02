# 이 파일은 scripts/gen-python-sync.mjs 가 python/kr_broker/async_support/kbsec.py 에서 만든다. 직접 고치지 않는다.
"""KB증권 Open API(`class kbsec(Exchange, ImplicitAPI)`). TypeScript 판 `ts/src/kbsec.ts` 와 `ts/src/kbsec/kbsec-auth.ts` 를 옮기는 중이다.
지금은 인증과 요청 봉투, 오류 처리, 토큰 복구, 시세(`fetch_ticker`, `fetch_order_book`, `fetch_ohlcv`, `fetch_trades`), 수수료 추정
(`fetch_trading_fee`), 휴장일(`fetch_market_calendar`, `refresh_market_calendar`), 투자자 매매동향(`fetch_investor_trading`), 주문·체결 조회
(`fetch_order`, `fetch_orders`, `fetch_open_orders`, `fetch_closed_orders`, `fetch_canceled_orders`, `fetch_my_trades`, `fetch_overseas_order_status`),
잔고(`fetch_balance`, `fetch_one_market_margin`), 주문(`create_order`, `create_trigger_order`, `create_market_buy_order_with_cost`, `edit_order`,
`cancel_order`, `cancel_all_orders`, `fetch_marketable_buy_price`)을 옮겼다. 통합 메서드의 `has` 는 TypeScript 판과 같다.
TypeScript 판의 확장 메서드(정산, 매수가능금액, 소수점 내역, 예약주문 등)는 아직 옮기지 않았다. 모든 TR 은 암묵 메서드로 부를 수 있다.

.. code-block:: python

    import kr_broker
    broker = kr_broker.kbsec({'apiKey': APP_KEY, 'secret': APP_SECRET})
    ticker = broker.fetch_ticker('005930/KRW')
    body = broker.private_post_ssqm1801({'inq_clsf': '1', 'mkt_tm_ccd': '1'})['dataBody']

자격증명
    `apiKey` 는 앱키, `secret` 은 앱시크릿이다. KB 는 계좌번호를 받지 않는다(계좌가 앱키에 묶인다). 모의투자 서버가 없어
    `set_sandbox_mode(True)` 는 `NotSupported` 다.

심볼
    국내는 `005930/KRW`, 미국은 `AAPL/USD` 다. 종목 목록을 받지 않고 심볼 모양으로 종목을 만든다(`market['info']['country']` 가 `KR` 이나 `US`).
    현금 코드와 같은 티커(`USD`)는 `commonStockCodes` 의 통합 코드로 심볼을 만든다(`ProShares Ultra Semiconductors/USD`). 입력은 `USD/USD` 도 받는다.

주문
    주문 TR 은 다시 보내지 않는다. 시간 초과나 연결 끊김, 증권사 오류 코드 없는 5xx 는 `OrderOutcomeUnknown` 이다(토큰 무효 `I445` 는 접수 전
    거절이라 재발급 뒤 한 번 다시 보낸다). 주문과 정정은 장 시간 밖이면 요청 없이 `MarketClosed` 다. 판정은 세 증권사 공용 게이트(`trading_hours`)이고,
    국내는 판정 전에 휴장일 캘린더를 받는다. 미국 종목은 `options['masterData']` 로 상장 거래소를 알아야 낸다. 국내 지정가는 `masterData` 가
    주식이라고 알려 주면 호가 단위를 요청 전에 확인한다(`InvalidOrder`, `detail` `price-tick-invalid`). 접수 뒤에는 체결내역(`fetch_my_trades`)으로
    체결을 확정하고, 확정하지 못하면 `info['fillConfirmed']` 가 `False` 다. 메서드마다 규칙은 메서드 설명에 있다.

요청
    모든 호출이 `POST /api/v1/{trcode}` 이고 본문은 `{dataHeader, dataBody}` 봉투다. `dataBody` 는 TR 입력 레이아웃(`kbsec_tr_inputs`)의 빠진 필드를
    빈 문자열로 채워 보낸다. 업무 오류는 HTTP 200 으로도 500 으로도 온다. 봉투의 `processFlag` 가 정본이고, `processCode` 는 오류의 `broker_code` 에 싣는다.
    토큰이 무효(HTTP 401, `I445`)면 토큰을 회전하고 한 번만 다시 보낸다. 그 뒤에도 토큰 실패가 이어지면 차단기(`kbsec_token_breaker`)가 호출을 멈춘다.

옵션
    `tokenStore`(토큰 저장소), `masterData`(국내 종목 유형과 시장, 해외 종목의 상장 거래소. `price_to_precision`, 통합차트의 시장구분, 주문 게이트가 쓴다),
    `nxtRouting`(정규장 국내 주문을 SOR 로 보낸다), `blockAuctionBuys`(종가 동시호가의 신규 매수를 막는다), `confirmBudget`(체결 확정 조회 예산),
    `marketableLimitBuffer`(해외 시장가 매수를 대체하는 지정가의 버퍼), `hostAddr`(TR 본문에 싣는 `{'ipAddr', 'macAddr'}`.
    주지 않으면 이 호스트의 주소를 찾아 쓴다. KB 는 빈 값을 받지 않는다), `krwIntegratedMargin`(원마켓 계좌의 미국 주식 매수여력을 원화 환산분으로
    보강, 환율은 `usdKrwRate`)다.
"""

import base64
import datetime
import json
import logging
import math
import re
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Set, Tuple, cast

from kr_broker.abstract.kbsec import ImplicitAPI
from kr_broker.base.exchange import Exchange
from kr_broker.base.runtime import maybe_await, new_lock
from kr_broker.base.token_store import refresh_token_with_lock
from kr_broker.execution_confirm import confirm_execution, fill_deviation_bps, trade_list_probe
from kr_broker.market_calendar import refresh_market_calendar as refresh_shared_market_calendar
from kr_broker.base import functions as fn
from kr_broker.base.decimal_to_precision import NO_PADDING, ROUND, TICK_SIZE, decimal_to_precision
from kr_broker.base.errors import (
    ArgumentsRequired, AuthenticationError, BadRequest, BadResponse, BadSymbol, BaseError, ExchangeError, ExchangeNotAvailable, InvalidOrder,
    MarketClosed, NetworkError, NotSupported, NullResponse, OrderNotFound, RateLimitExceeded,
)
from kr_broker.base.exchange import assert_secure_url, kst_trade_timestamps
from kr_broker.base.precise import Precise
from kr_broker.base.token_store import BrokerTokenStore, token_store_key
from kr_broker.base.types import ApiName, Balances, Int, Market, MarketInterface, Num, Order, OrderBook, Str, Ticker, Trade, TradingFeeInterface
from kr_broker.broker_time import candle_period_utc_ms, kst_ymd
from kr_broker.edit_order_amount import assert_whole_remaining_edit
from kr_broker.kbsec_chart import KBSEC_CHART_MAX, KBSEC_TIMEFRAMES, kbsec_bar_ms, kbsec_candle_timestamp, kbsec_chart_params
from kr_broker.kbsec_envelope import is_kbsec_business_error, is_kbsec_token_failure, kbsec_host_addr
from kr_broker.kbsec_error_codes import KBSEC_ERROR_DETAIL, kbsec_error_detail, kbsec_exact_exceptions
from kr_broker.kbsec_fee import kbsec_estimated_fee_rate
from kr_broker.kbsec_fill_row import kbsec_resolve_fills, parse_kbsec_domestic_fill_row, parse_kbsec_overseas_fill_row
from kr_broker.kbsec_fill_warnings import warn_fill_without_price, warn_if_fill_side_unreadable, warn_if_fill_totals_inconsistent
from kr_broker.kbsec_number import kbsec_number_of
from kr_broker.kbsec_order_body import build_kr_order_body
from kr_broker.kbsec_pick import (
    OVERSEAS_QTY_CANDIDATES, is_empty_cash_row, is_usd_cash_row, kbsec_holding_quantity, pick_array, pick_cash_grid, pick_holding_grid, pick_num,
    pick_optional_num, pick_positive_num, pick_str, unknown_grids,
)
from kr_broker.kbsec_token_breaker import record_kbsec_call_ok, record_token_failure, throw_if_token_breaker_open
from kr_broker.kbsec_tr_inputs import fill_tr_inputs
from kr_broker.kbsec_types import (
    KBSEC_API_BASE, KBSEC_CCLS_ALL, KBSEC_CCLS_FILLED, KBSEC_CCLS_PENDING, KBSEC_CHART_KIND, KBSEC_CONT_FIRST, KBSEC_CONT_NEXT,
    KBSEC_EXCH_RATE_MARKET, KBSEC_FEE_EXCLUDED, KBSEC_INQ_ALL, KBSEC_INQ_STOCK, KBSEC_ORDER_SIDE_KR, KBSEC_ORDER_SIDE_US, KBSEC_ORDER_TYPE_KR,
    KBSEC_ORDER_TYPE_US, KBSEC_REVOKE_PATH, KBSEC_SESSION_REGULAR, KBSEC_SOR, KBSEC_STD_CURRENCY_FOREIGN, KBSEC_TOKEN_DEFAULT_TTL_MS, KBSEC_TOKEN_PATH, KBSEC_TOKEN_SAFETY_MARGIN_MS, KBSEC_TR, KBSEC_TR_PATH_PREFIX,
    KBSEC_US_EXCHANGES, kbsec_base_symbol, kbsec_business_date_kst, kbsec_business_date_us_eastern, kbsec_market_of, kbsec_normalize_code,
    kbsec_num,
)
from kr_broker.kis_master_data import master_data_of
from kr_broker.kis_stock_master import get_krx_stock_by_code
from kr_broker.krx_tick_size import KRX_TICK_INVALID_DETAIL, get_krx_tick_size, krx_tick_violation
from kr_broker.market_calendar import expand_business_days
from kr_broker.trading_hours import market_session_block_reason
from kr_broker.us_market_hours import et_ymd

logger = logging.getLogger('kr_broker')

# 조회 요청 상한. KB 는 토큰 발급이 분당 1회로 제한되고 과도한 반복 조회를 계정 제한 사유로 들므로, 정상 응답을 자르지 않게 넉넉히 둔다.
READ_TIMEOUT_MS = 20_000
# 주문 요청 상한. 호출하는 쪽이 주문에 두는 바깥 상한(보통 30초)보다 짧아야 요청을 끊고 `OrderOutcomeUnknown` 으로 다룬다.
ORDER_TIMEOUT_MS = 25_000
# 요청 사이 간격(ms). KB 는 호출 제한 수치를 공개하지 않아 초당 2~3회로 낮게 잡았다.
RATE_LIMIT_MS = 400
# 토큰 발급·폐기 요청 상한. 토큰 요청이 멈추면 그 뒤의 TR 이 모두 멈추므로 조회 상한보다 짧다.
AUTH_TIMEOUT_MS = 10_000
# 토큰 발급 락 TTL(한국투자증권과 같은 값).
TOKEN_FETCH_LOCK_TTL_MS = 90 * 1000
# 토큰 폐기 쿨다운. 토큰 장애 중에는 모든 TR 이 I445 로 실패하므로 실패마다 폐기를 부르지 않는다.
REVOKE_COOLDOWN_MS = 5 * 60 * 1000
# 휴장일 캘린더를 다시 받기까지의 시간. 장운영상태 TR 은 전·기준·익영업일만 줘서 자주 받아야 한다.
CALENDAR_TTL_MS = 6 * 60 * 60 * 1000
# 토큰 저장소 키 앞부분. 뒤에 앱키의 해시가 붙는다.
KBSEC_TOKEN_KEY_PREFIX = 'kbsec:token:'
# 발급·폐기 요청의 `dataHeader`. TR 과 달리 빈 주소를 받는다.
_EMPTY_HOST = {'ipAddr': '', 'macAddr': ''}
# 국내 통합차트(`IVS11560`)의 차트구분 가운데 기간 봉의 타임프레임. 분봉은 없다. `'1mo'` 로 불러도 월봉(M)을 보내므로 `'1M'` 의 규칙을 쓴다.
KBSEC_CHART_PERIOD = {KBSEC_CHART_KIND['DAY']: '1d', KBSEC_CHART_KIND['WEEK']: '1w', KBSEC_CHART_KIND['MONTH']: '1M'}
# 해외 체결현황(`SPQM2204`) 기타매매구분코드(`etc_trd_ccd`)의 방향. 명세에 값 설명이 없다.
# 실계좌(2026-09-28)에서 입력 매매구분(`trd_clsf`)을 `01` 로 거르면 `01` 행만, `02` 로 거르면 `02` 행만 왔다.
KBSEC_OVERSEAS_ORDER_SIDE = {'01': 'sell', '02': 'buy'}
# 접수 응답에 주문번호가 없을 때의 값(`pick_str` 가 빈 문자열을 돌려준다). 이때 주문의 `id` 를 비우고 체결 확정을 하지 않는다.
NO_ORDER_ID = ''
# `create_order` 가 받지 않는 ccxt 조건 주문 인자. 버리고 일반 주문으로 내면 조건 주문을 의도한 호출이 곧바로 체결된다.
UNSUPPORTED_CONDITIONAL_PARAMS = ('triggerPrice', 'stopPrice', 'stopLossPrice', 'takeProfitPrice', 'stopLoss', 'takeProfit')


def _now_ms() -> int:
    return fn.milliseconds()


def _js_truthy(value: Any) -> bool:
    """JavaScript 의 참 거짓 판정. `None`, 0, NaN, 빈 문자열이 거짓이다."""
    if value is None or value == 0 or value == '':
        return False
    return not (isinstance(value, float) and math.isnan(value))


def _get(value: Any, key: str) -> Any:
    """JavaScript `value?.[key]` 처럼 읽는다. 사전이 아니면 `None` 이다."""
    return value.get(key) if isinstance(value, dict) else None


def _process_code_of(text: str) -> Str:
    """KB 봉투(`dataHeader.processCode`)의 업무 코드. JSON 이 아니거나 코드가 비었으면 `None` 이다."""
    try:
        code = _get(_get(json.loads(text), 'dataHeader'), 'processCode')
    except ValueError:
        return None
    return code if isinstance(code, str) and code.strip() != '' else None


def token_jti(token: str) -> Str:
    """JWT 의 `jti`. 토큰 동일성 판정의 정본이다.

    앞부분 비교로 판정하지 않는다. 헤더와 payload 앞부분(`sub`·`aud`)이 모든 토큰에서 같아 서로 다른 토큰도 접두가 같다.
    JWT 가 아니거나 `jti` 가 없으면 `None` 이고, 그때는 동일성을 모르는 것으로 다룬다. payload 는 패딩 없는 base64url 이다.
    """
    parts = token.split('.')
    payload = parts[1] if len(parts) > 1 else ''
    if not payload:
        return None
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)).decode('utf-8', errors='replace'))
    except ValueError:
        return None
    jti = _get(claims, 'jti')
    return jti if isinstance(jti, str) and jti != '' else None


class KbsecAuth:
    """KB증권 OAuth2 토큰의 캐시와 발급, 토큰 장애 뒤의 회전. TypeScript 판 `ts/src/kbsec/kbsec-auth.ts` 와 같다.

    토큰은 프로세스 메모리 → 토큰 저장소 → 새 발급 순으로 찾는다. 발급은 저장소의 락으로 한 곳에서만 한다(KB 는 발급 빈도를 제한한다).
    발급 본문은 공식 예제 저장소의 봉투 형태(`grantType`)를 먼저 보내고, 거절되면 포털 가이드의 평면 형태(`grant_type`)로 한 번 더 보낸다.
    통한 형태는 기억한다. 연결 실패, 시간 초과, 업무 코드 없는 5xx, 429 는 본문 형태와 관계없으므로 다른 형태로 다시 보내지 않는다.

    요청은 `post_json(url, body)` 로 보낸다. 증권사 인스턴스의 `http_request` 를 직접 쓰므로 `handle_errors` 와 verbose 로그를 거치지 않는다.
    """

    def __init__(self, app_key: str, app_secret: str, base_url: str, post_json: Callable[[str, Any], Tuple[int, str]],
                 store_of: Callable[[], Optional[BrokerTokenStore]] = lambda: None) -> None:
        self.app_key = app_key
        self.app_secret = app_secret
        self.base_url = base_url
        self.post_json = post_json
        self.raw_store_of = store_of
        self.cached_token: Optional[Dict[str, Any]] = None
        # 통한 발급 본문 형태. 두 번째 발급부터는 그 형태만 보낸다.
        self.working_shape: Str = None
        # 마지막 폐기 시도 시각(ms). 인스턴스 단위로만 제한한다.
        self.last_revoke_attempt_at = 0
        self._lock = new_lock()

    @property
    def store_key(self) -> str:
        return token_store_key(KBSEC_TOKEN_KEY_PREFIX, self.app_key)

    def store_of(self) -> Any:
        """토큰 저장소. 인스턴스 옵션 `tokenStore` 를 그대로 쓴다."""
        return self.raw_store_of()

    def get_access_token(self) -> str:
        """유효한 접근 토큰. 같은 프로세스 안의 동시 갱신은 락으로 하나로 합친다."""
        cached = self.cached_token
        if cached is not None and cached['expiresAt'] > _now_ms():
            return cached['accessToken']
        with self._lock:
            cached = self.cached_token
            if cached is not None and cached['expiresAt'] > _now_ms():
                return cached['accessToken']
            stored = self._read_cached_token()
            if stored is not None:
                return stored
            return refresh_token_with_lock('[KBSecAuth]', self.store_of(), self.store_key, TOKEN_FETCH_LOCK_TTL_MS,
                                           self._read_cached_token, self._issue_token)

    def invalidate(self, failed_token: Str = None) -> None:
        """토큰 캐시를 프로세스 메모리와 토큰 저장소에서 지운다. 토큰 실패 뒤 다시 보내기 전에 부르고 끝날 때까지 기다린다.

        `failed_token` 을 주면 그 토큰이 캐시에 그대로 있을 때만 메모리 캐시를 비우고, 저장소도 같은 토큰일 때만 지운다.
        동시 요청 가운데 먼저 끝난 쪽이 받아 둔 새 토큰을 지우지 않기 위해서다.
        """
        cached = self.cached_token
        if failed_token is None or (cached is not None and cached['accessToken'] == failed_token):
            self.cached_token = None
        store = self.store_of()
        if store is not None:
            try:
                if failed_token:
                    if not maybe_await(store.delete_if_access_token_equals(self.store_key, failed_token)):
                        logger.info('[KBSecAuth] 메모리 캐시만 무효화 — 토큰 저장소에는 이미 다른(더 새) 토큰이 있다')
                        return
                else:
                    maybe_await(store.delete(self.store_key))
            except Exception:
                logger.debug('[KBSecAuth] 토큰 저장소 삭제 실패 (메모리 캐시 무효화는 완료)', exc_info=True)
        logger.info('[KBSecAuth] 토큰 캐시 초기화')

    def rotate_after_token_failure(self, failed_token: str) -> None:
        """토큰 실패(I445) 뒤 토큰을 회전한다.

        KB 는 쓸 수 없게 된 토큰을 재발급 요청에도 같은 `jti` 로 돌려줄 수 있어 무효화만으로는 회복되지 않는다. 재발급 결과가 실패한 토큰과
        같은 `jti` 일 때만 `/oauth2/revoke` 로 폐기하고 한 번 더 발급한다. 새 토큰이 오면 폐기하지 않으므로 다른 프로세스가 쓰는 토큰을 없애지 않는다.
        폐기가 실패하면 재발급한 토큰을 그대로 둔다. 폐기는 `REVOKE_COOLDOWN_MS` 에 한 번만 시도한다.
        """
        self.invalidate(failed_token)
        reissued = self.get_access_token()
        if token_jti(reissued) is None or token_jti(reissued) != token_jti(failed_token):
            return
        now = _now_ms()
        if now - self.last_revoke_attempt_at < REVOKE_COOLDOWN_MS:
            logger.debug('[KBSecAuth] 폐기 쿨다운 중 — 이번 실패는 종전 동작으로: sinceMs=%s', now - self.last_revoke_attempt_at)
            return
        self.last_revoke_attempt_at = now
        logger.warning('[KBSecAuth] 재발급이 같은 토큰을 돌려줬다 — 명시 폐기 후 재발급: jti=%s', token_jti(failed_token))
        if not self._revoke_token(failed_token):
            return
        # 폐기된 토큰은 누가 갖고 있든 쓸 수 없으므로 무조건 지운다.
        self.invalidate()
        fresh = self.get_access_token()
        logger.info('[KBSecAuth] 폐기 후 재발급 완료: rotated=%s jti=%s', token_jti(fresh) != token_jti(failed_token), token_jti(fresh))

    def _revoke_token(self, token: str) -> bool:
        """`/oauth2/revoke` 호출. `processFlag` 가 `A` 면 성공이다. 본문 필드 이름이 공식 문서에 없어 후보를 순서대로 시도한다."""
        credentials = {'appKey': self.app_key, 'appSecret': self.app_secret}
        candidates = [
            ('token', fn.extend(credentials, {'token': token})),
            ('accessToken', fn.extend(credentials, {'accessToken': token})),
            ('access_token', fn.extend(credentials, {'access_token': token})),
        ]
        for label, data_body in candidates:
            try:
                status, text = self.post_json(f'{self.base_url}{KBSEC_REVOKE_PATH}', {'dataHeader': _EMPTY_HOST, 'dataBody': data_body})
                if _get(_get(json.loads(text), 'dataHeader'), 'processFlag') == 'A':
                    logger.info('[KBSecAuth] 토큰 폐기 성공: shape=%s', label)
                    return True
                logger.debug('[KBSecAuth] 토큰 폐기 실패 — 다음 형태 시도: shape=%s status=%s body=%s', label, status, text[:200])
            except Exception:
                logger.debug('[KBSecAuth] 토큰 폐기 요청 오류 — 다음 형태 시도: shape=%s', label, exc_info=True)
        logger.warning('[KBSecAuth] 토큰 폐기 — 시도한 본문 형태 전부 실패: shapes=%s', [label for label, _ in candidates])
        return False

    def _read_cached_token(self) -> Optional[str]:
        """토큰 저장소의 유효한 토큰. 없거나 만료됐으면 `None`."""
        store = self.store_of()
        if store is None:
            return None
        try:
            raw = maybe_await(store.get(self.store_key))
            if not raw:
                return None
            parsed = json.loads(raw)
            if parsed['expiresAt'] <= _now_ms():
                return None
            self.cached_token = parsed
            return parsed['accessToken']
        except Exception:
            logger.debug('[KBSecAuth] 토큰 저장소 조회 실패 — 신규 발급', exc_info=True)
            return None

    def _issue_token(self) -> str:
        """본문 형태를 차례로 보내 발급한다. 모두 거절되면 형태별 오류를 모아 `AuthenticationError` 로 던진다.
        `broker_code` 는 첫 형태의 업무 코드만 싣는다. 나중에 보내는 평면 형태는 원인과 관계없이 `E021` 을 받기 때문이다."""
        shapes = [self.working_shape] if self.working_shape else ['envelope', 'flat']
        failures: List[str] = []
        broker_code: Str = None
        for shape in shapes:
            try:
                token = self._request_token(shape)
                self.working_shape = shape
                return token
            except NetworkError:
                raise
            except Exception as err:
                if not failures and isinstance(err, BaseError):
                    broker_code = err.broker_code
                failures.append(f'{shape}: {type(err).__name__}: {err}')
                logger.warning('[KBSecAuth] 토큰 발급 실패 — 다른 본문 형태로 재시도: shape=%s err=%s', shape, err)
        raise AuthenticationError('[KBSecAuth] 토큰 발급 실패 — 시도한 본문 형태 전부 실패\n  ' + '\n  '.join(failures), broker_code=broker_code)

    def _request_token(self, shape: str) -> str:
        if shape == 'envelope':
            body: Dict[str, Any] = {'dataHeader': _EMPTY_HOST,
                                    'dataBody': {'appKey': self.app_key, 'appSecret': self.app_secret, 'grantType': 'client_credentials'}}
        else:
            body = {'grant_type': 'client_credentials', 'appKey': self.app_key, 'appSecret': self.app_secret}
        status, text = self.post_json(f'{self.base_url}{KBSEC_TOKEN_PATH}', body)
        if not 200 <= status < 300:
            message = f'KB증권 토큰 발급 오류: {status} {text[:300]}'
            if status == 429:
                raise RateLimitExceeded(message)
            # KB 는 자격증명 오류(E021 등)도 HTTP 500 과 봉투의 processCode 로 준다. 업무 코드가 없는 5xx 만 일시 장애다.
            broker_code = _process_code_of(text)
            if status >= 500 and broker_code is None:
                raise ExchangeNotAvailable(message)
            raise AuthenticationError(message, broker_code=broker_code)
        try:
            parsed = json.loads(text)
        except ValueError:
            raise ValueError(f'KB증권 토큰 응답이 JSON 이 아님: {text[:200]}') from None
        # 봉투 응답(dataBody.access_token)과 평면 응답(access_token)을 모두 받는다.
        data_body = _get(parsed, 'dataBody')
        payload = parsed if data_body is None else data_body
        access_token = _get(payload, 'access_token')
        if access_token is None:
            access_token = _get(payload, 'accessToken')
        if not access_token:
            # KB 는 발급 거절을 HTTP 200 과 빈 토큰, 실패 봉투(`processFlag B`)로도 준다.
            header = _get(parsed, 'dataHeader')
            broker_code = _process_code_of(text) if is_kbsec_business_error(header if isinstance(header, dict) else None) else None
            raise AuthenticationError(f'KB증권 토큰 응답에 access_token 없음: {text[:200]}', broker_code=broker_code)
        expires_in = _get(payload, 'expires_in')
        valid_expiry = isinstance(expires_in, (int, float)) and not isinstance(expires_in, bool) and expires_in > 0
        ttl_ms = expires_in * 1000 if valid_expiry else KBSEC_TOKEN_DEFAULT_TTL_MS
        # 수명이 안전 여유의 두 배보다 짧으면(KB 는 만료 직전에 3초, 1초를 준다) 여유를 수명의 절반으로 줄인다.
        short_lived = ttl_ms <= KBSEC_TOKEN_SAFETY_MARGIN_MS * 2
        expires_at = _now_ms() + (math.floor(ttl_ms / 2) if short_lived else ttl_ms - KBSEC_TOKEN_SAFETY_MARGIN_MS)
        self.cached_token = {'accessToken': access_token, 'expiresAt': expires_at}
        # 저장소 쓰기도 기다린다. 수명이 짧거나 남은 수명이 없는 토큰은 저장하지 않는다(다른 프로세스가 곧 만료될 토큰을 가져다 쓴다).
        store = self.store_of()
        ttl_sec = math.floor((expires_at - _now_ms()) / 1000)
        if store is not None and ttl_sec > 0 and not short_lived:
            try:
                maybe_await(store.set(self.store_key, fn.json_stringify(self.cached_token), ttl_sec * 1000))
            except Exception:
                logger.warning('[KBSecAuth] 토큰 저장소 쓰기 실패 (메모리 캐시는 유효)', exc_info=True)
        logger.info('[KBSecAuth] 접근 토큰 발급 완료: shape=%s expiresInSec=%s', shape, math.floor(ttl_ms / 1000))
        return access_token


class kbsec(Exchange, ImplicitAPI):

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        # 발급한 토큰을 들고 있는 인증 객체. 앱키나 시크릿이 바뀌면 다시 만든다.
        self._auth: Optional[KbsecAuth] = None
        self._auth_identity = ''
        # 해외 종목의 KB 거래소코드(`krx_cd`). 심볼마다 한 번 찾아 둔다. NYSE 종목이 섞여 있어 `NAS` 로 고정하면 안 된다.
        self._us_exchange_cache: Dict[str, str] = {}
        # NXT 에 상장돼 있지 않다고 확인한 국내 종목. SOR 주문이 L545 로 거부되면 넣고, 다음 주문부터 KRX 로 바로 보낸다.
        self._nxt_ineligible: Set[str] = set()
        # 조회일자 되감기 캐시(시장별, 그 시장 날짜별). 연휴에 호출마다 같은 실패를 되풀이하지 않게 한다. 국내와 해외는 날짜 축이 달라 따로 둔다.
        self._business_date_backoff: Dict[str, Dict[str, Any]] = {'KR': {'day': '', 'steps': 0}, 'US': {'day': '', 'steps': 0}}
        # 해외 체결조회(SPQM2103) 영구 실패.
        self._overseas_fills_unavailable = False
        # 평가금액 산출용 현재가 캐시(종목코드 → 가격·조회 시각).
        self._holding_price_cache: Dict[str, Dict[str, Any]] = {}
        self._holding_fields_logged = False
        # 해외 잔고 TR 이 영구 실패했는가(권한 없음 등 업무 오류). 반복 호출은 계정 제한 사유라 다시 부르지 않는다.
        self._overseas_holdings_unavailable = False
        # 일시 오류 뒤 해외 잔고를 다시 부르기 전까지 기다리는 시각(epoch ms). 0 이면 대기 없음.
        self._overseas_holdings_retry_at = 0
        # 해외 보유 행을 실제로 읽은 적이 있는가. 한 번 참이 되면 내려가지 않는 이력이다. 이 값이 참이면 뒤의 응답이 종목 그리드 없이 와도
        # 미보유로 읽는다. 빈 행이나 예수금 그리드만 온 응답으로는 켜지 않는다. 이력이 넓으면 뒤 응답의 필드 이름 불일치를 덮는다.
        self._overseas_grid_seen = False
        # 원마켓 증거금(SPQM3390) 영구 실패. 미신청 계좌는 다시 물어도 답이 같다.
        self._one_market_unavailable = False
        # 일시 오류 뒤 원마켓 증거금을 다시 부르기 전까지 기다리는 시각(epoch ms). 0 이면 대기 없음.
        self._one_market_retry_at = 0
        self._one_market_notice_logged = False
        super().__init__(config)

    def describe(self) -> Dict[str, Any]:
        return self.deep_extend(super().describe(), {
            'id': 'kbsec',
            'name': 'KB증권',
            'countries': ['KR'],
            'version': 'v1',
            'rateLimit': RATE_LIMIT_MS,
            'timeout': READ_TIMEOUT_MS,
            'orderTimeout': ORDER_TIMEOUT_MS,
            # 옮긴 통합 메서드만 True 다. 키는 TypeScript 판과 같다.
            'has': {
                'ws': False,
                'watchTicker': False,
                'watchTrades': False,
                'watchOrderBook': False,
                'watchOrders': False,
                'spot': True,
                'margin': False,
                'swap': False,
                'future': False,
                'option': False,
                'sandbox': False,
                'fetchMarkets': False,
                'fetchCurrencies': False,
                'fetchTicker': True,
                'fetchTickers': False,
                'fetchOrderBook': True,
                # 국내만 지원한다. 해외 차트는 15분 지연 시세라 `NotSupported` 다.
                'fetchOHLCV': True,
                'fetchBalance': True,
                'createOrder': True,
                'createLimitOrder': True,
                'createMarketOrder': True,
                'createTriggerOrder': True,
                'editOrder': True,
                'cancelOrder': True,
                # 미체결 조회로 받은 주문을 하나씩 취소한다. 국내만 지원한다.
                'cancelAllOrders': 'emulated',
                'fetchOrder': True,
                'fetchOrders': True,
                'fetchOpenOrders': True,
                'fetchClosedOrders': True,
                'fetchCanceledOrders': True,
                'fetchMyTrades': True,
                'fetchTrades': True,
                # KB 에 수수료 조회 TR 이 없어 공시 요율로 추정한다.
                'fetchTradingFee': 'emulated',
                'fetchStatus': False,
                'fetchTime': False,
                # 주식 고유. 장운영상태 TR 로 전·기준·익영업일을 받아 휴장일 캘린더를 채운다.
                'fetchMarketCalendar': True,
                'fetchInvestorTrading': True,
                'createMarketBuyOrderWithCost': True,
                'createConditionalOrder': False,
            },
            'urls': {
                'api': {'private': KBSEC_API_BASE},
                'www': 'https://openapi.kbsec.com',
                'doc': ['https://openapi.kbsec.com', 'https://github.com/kbsecurities/kb-openapi'],
            },
            'requiredCredentials': {'apiKey': True, 'secret': True, 'uid': False},
            'timeframes': dict(KBSEC_TIMEFRAMES),
            'fees': {
                'trading': {'tierBased': False, 'percentage': True},
            },
            # 국내 호가단위는 가격대별이라 종목 정밀도로 적지 않는다.
            'precisionMode': TICK_SIZE,
            'exceptions': {'exact': kbsec_exact_exceptions()},
            'options': {
                # 해외 시장가 매수를 대체하는 지정가에 더하는 버퍼. 상한일 뿐 비용이 아니다(체결은 호가에서 일어난다).
                'marketableLimitBuffer': 0.005,
                # 국내 체결 확정 조회 예산. 5회 × 1초다. KRX 는 현재가 지정가라도 체결이 몇 초 뒤에 잡히는 일이 흔하고, KB 는 반복 조회를 계정
                # 제한 사유로 들므로 짧은 간격으로 자주 부르는 것보다 1초 간격이 안전하다. 해외는 공용 기본값을 쓴다.
                'domesticConfirmBudget': {'attempts': 5, 'intervalMs': 1000},
                # 접수 뒤 체결 확정 조회의 예산 `{'attempts', 'intervalMs'}`. 사전이거나 사전을 돌려주는 함수다. 국내와 해외 기본값을 모두 이긴다.
                'confirmBudget': None,
                # 켜고 끄는 옵션은 불리언이거나 불리언을 돌려주는 함수(코루틴 함수도 받는다)다. 기본은 꺼짐이다.
                # 정규장 안의 국내 주문을 SOR(KRX·NXT 가운데 유리한 쪽)로 보낸다. 정규장 밖 주문은 세션 게이트가 `MarketClosed` 로 막는다.
                'nxtRouting': None,
                # 종가 동시호가(국내 15:20~15:30, 미국 15:50~16:00 ET)의 신규 매수를 막는다. 시장이 받는 주문이라 기본은 꺼짐이다.
                'blockAuctionBuys': None,
                # 토큰을 여러 프로세스가 나눠 쓰는 저장소(BrokerTokenStore). 없으면 프로세스 메모리 캐시만 쓴다.
                'tokenStore': None,
                # 국내 종목 유형과 해외 종목의 상장 거래소를 알려 주는 KIS 마스터 데이터(`kis_master_data` 참고). 없으면 빈 데이터라
                # 해외 주문은 거래소 미상으로 막힌다.
                'masterData': None,
                # 연속조회 페이지 상한. 호출 급증을 막는 값이지 정상 한도가 아니다.
                'holdingsMaxPages': 20,
                # 조회일자 되감기 상한. 연휴를 덮되 날짜와 무관한 실패를 끝없이 다시 부르지 않는다.
                'businessDateMaxBackoff': 5,
                # 잔고 평가에 쓰는 현재가 캐시 시간(ms).
                'holdingPriceTtl': 60_000,
                # 결제대기 매도 보정용 체결내역 조회 창(영업일 수). KRX 는 T+2 결제라 T·T+1·T+2 세 영업일이다.
                'settlementLookbackDays': 3,
                # 일시 오류 뒤 같은 TR 을 다시 부르기까지의 대기(ms). 영구 오류는 래치라 이 값과 무관하다.
                'transientRetryCooldown': 5 * 60 * 1000,
                # 원마켓(통합증거금) 계좌의 미국 주식 매수여력을 원화 환산분으로 보강한다. 불리언이거나 불리언을 돌려주는 함수다. 기본은 꺼짐이다.
                # 켜면 `fetch_balance` 가 원화환산 외화예수금을 `usdKrwRate` 로 환산한 USD 를 싣는다.
                'krwIntegratedMargin': None,
                # 원마켓 환산에 쓰는 환율 조회 함수. 1달러당 원화를 돌려주는 함수(코루틴 함수도 받는다)다. 없으면 환산을 하지 못한다.
                'usdKrwRate': None,
            },
        })

    # ============ 요청 ============

    def _base_url(self) -> str:
        api = self.urls.get('api')
        if isinstance(api, str):
            return api
        private = _get(api, 'private')
        return KBSEC_API_BASE if private is None else private

    def _host_addr(self) -> Dict[str, str]:
        """TR 본문 `dataHeader` 에 싣는 호스트 주소. `options['hostAddr']` 로 준 값을 쓰고, 빠진 값만 이 호스트에서 모은다."""
        given = self.safe_dict(self.options, 'hostAddr', {})
        auto = kbsec_host_addr()
        return {'ipAddr': self.safe_string(given, 'ipAddr') or auto['ipAddr'], 'macAddr': self.safe_string(given, 'macAddr') or auto['macAddr']}

    def _get_auth(self) -> KbsecAuth:
        """앱키·시크릿에 묶인 인증 객체. 토큰 캐시와 발급 락이 여기 있다."""
        identity = f'{self.apiKey}\u0000{self.secret}'
        if self._auth is None or identity != self._auth_identity:
            base_url = self._base_url()
            # 발급 요청 안에서 주소가 막히면 그 `BadRequest` 가 다른 본문 형태로 넘어가는 실패가 되어 `AuthenticationError` 로 바뀐다. 먼저 확인한다.
            assert_secure_url(self.id, base_url, self.options.get('allowInsecureUrl') is True)
            self._auth = KbsecAuth(self.apiKey or '', self.secret or '', base_url, self._post_json, self.get_token_store)
            self._auth_identity = identity
        return self._auth

    def _post_json(self, url: str, body: Any) -> Tuple[int, str]:
        """토큰 발급·폐기 요청. `fetch` 를 거치지 않아 `handle_errors` 가 끼지 않고, verbose 로그에 시크릿이 든 본문이 찍히지 않는다.
        리다이렉트를 따르지 않고, 연결 실패는 `NetworkError`, 시간 초과는 `RequestTimeout` 이다. 상태 코드와 본문을 그대로 돌려준다."""
        response = self.http_request('POST', url, {'Content-Type': 'application/json'}, self.json(body), AUTH_TIMEOUT_MS)
        return response.status_code, response.content.decode('utf-8', errors='replace')

    def authenticate(self, path: str, api: ApiName, method: str, params: Dict[str, Any], headers: Optional[Dict[str, str]],
                     body: Str) -> None:
        """비공개 호출 앞에서 토큰을 준비해 요청 헤더에 싣는다. 소문자 `bearer` 다(공식 예제 기준이며 대문자는 거부된 사례가 있다)."""
        try:
            token = self._get_auth().get_access_token()
        except BaseError:
            raise
        except Exception as e:
            raise AuthenticationError(f'{self.id} 토큰을 받지 못했다: {e}') from e
        if headers is not None:
            headers['Authorization'] = f'bearer {token}'

    def sign(self, path: str, api: ApiName = 'private', method: str = 'POST', params: Optional[Dict[str, Any]] = None,
             headers: Optional[Dict[str, str]] = None, body: Str = None) -> Dict[str, Any]:
        """TR 요청을 만든다. 본문은 스펙의 입력 필드를 모두 채운 `{dataHeader, dataBody}` 봉투다(일부만 보내면 KB 가 거부한다)."""
        params = {} if params is None else params
        return {
            'url': f'{self._base_url()}{KBSEC_TR_PATH_PREFIX}{path.lower()}',
            'method': 'POST',
            'headers': self.extend({'Content-Type': 'application/json', 'appKey': self.apiKey or ''}, headers),
            # 빈 주소면 KB 가 TR 을 거부한다(`kbsec_host_addr` 참고).
            'body': self.json({'dataHeader': self._host_addr(), 'dataBody': fill_tr_inputs(path, params)}),
        }

    def fetch2(self, path: str, api: ApiName = 'private', method: str = 'POST', params: Optional[Dict[str, Any]] = None,
               headers: Optional[Dict[str, str]] = None, body: Str = None, config: Optional[Dict[str, Any]] = None) -> Any:
        """토큰이 무효인 응답(401, `I445`)을 받으면 토큰을 회전하고 한 번만 다시 보낸다. 그 뒤에도 토큰 실패면 차단기에 센다.
        I445 는 증권사가 처리하기 전에 거절한 것이라 주문 TR 도 다시 보낸다."""
        return self._fetch_with_token_recovery(path, api, method, params, headers, body, config, True)

    def _fetch_with_token_recovery(self, path: str, api: ApiName, method: str, params: Optional[Dict[str, Any]],
                                   headers: Optional[Dict[str, str]], body: Str, config: Optional[Dict[str, Any]],
                                   allow_retry: bool) -> Any:
        tr_code = path.upper()
        # 차단기가 열려 있으면 KB 를 부르지 않는다. 근거는 `kbsec_token_breaker`.
        throw_if_token_breaker_open(self.apiKey, tr_code)
        # 요청마다 새 헤더 사전을 쓴다. `authenticate` 가 여기에 토큰을 싣고, 실패했을 때 어느 토큰이었는지 여기서 읽는다.
        request_headers: Dict[str, str] = dict(headers or {})
        try:
            response = super().fetch2(path, api, method, params, request_headers, body, config)
        except Exception as error:
            token_failed = isinstance(error, AuthenticationError) and error.detail == KBSEC_ERROR_DETAIL['TOKEN_INVALID']
            if not token_failed:
                # 응답을 읽고 던진 오류(업무 거절)는 토큰이 통했다는 뜻이므로 차단기를 푼다. 전송 실패는 아무것도 알려 주지 않는다.
                # 토큰을 싣지 못한 요청(발급 거절)은 TR 을 보내지 않았으므로 풀지 않는다.
                if isinstance(error, ExchangeError) and 'Authorization' in request_headers:
                    record_kbsec_call_ok(self.apiKey)
                raise
            if not allow_retry:
                # 폐기와 회전까지 하고도 토큰 실패면 이쪽에서 쓸 수단이 다 떨어진 상태다.
                record_token_failure(self.apiKey, tr_code, KBSEC_ERROR_DETAIL['TOKEN_INVALID'])
                raise
            logger.warning('[kbsec] 토큰 실패 — 재발급 후 1회 재시도: trCode=%s', tr_code)
        else:
            record_kbsec_call_ok(self.apiKey)
            return response
        # 회전은 `except` 밖에서 한다. 안에서 하면 회전이나 재시도의 오류에 첫 토큰 실패가 원인 사슬로 붙는다.
        # 무효화가 끝나기 전에 다시 보내면 방금 무효로 판정한 토큰을 캐시에서 다시 읽으므로 회전을 끝까지 기다린다.
        failed_token = re.sub(r'^bearer ', '', request_headers.get('Authorization') or '', flags=re.IGNORECASE)
        self._get_auth().rotate_after_token_failure(failed_token)
        return self._fetch_with_token_recovery(path, api, method, params, headers, body, config, False)

    def handle_errors(self, code: int, reason: str, url: str, method: str, headers: Dict[str, str], body: str, response: Any,
                      request_headers: Optional[Dict[str, str]], request_body: Str) -> Optional[bool]:
        """응답 봉투를 오류로 옮긴다. 상태 코드와 무관하게 봉투가 정본이다. 봉투가 없는 비-2xx 는 `httpExceptions` 표가 받는다."""
        header = self.safe_dict(response, 'dataHeader')
        tr_code = url.split('/')[-1].upper()
        if is_kbsec_business_error(header):
            process_code = (self.safe_string(header, 'processCode') or '').strip()
            process_message = (self.safe_string(header, 'processMessage') or '').strip()
            feedback = f'KB증권 업무 오류 ({tr_code}): {process_message} [processCode={process_code}]'
            broker_code = process_code or None
            self.throw_exactly_matched_exception(self.exceptions.get('exact'), process_code, feedback, detail=kbsec_error_detail(process_code),
                                                 broker_code=broker_code)
            raise ExchangeError(feedback, broker_code=broker_code)
        if is_kbsec_token_failure(code, header):
            broker_code = (self.safe_string(header, 'processCode') or '').strip() or None
            raise AuthenticationError(f'{self.id} {method} {url} {code} 토큰이 무효다', detail=KBSEC_ERROR_DETAIL['TOKEN_INVALID'],
                                      broker_code=broker_code)
        if 200 <= code < 300 and response is None:
            raise BadResponse(f'KB증권 응답이 JSON 이 아님 ({tr_code}): {body[:200]}')
        return None

    def _call_tr(self, tr_code: str, data_body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """TR 을 부르고 봉투에서 `dataBody` 를 꺼낸다. 오류는 `handle_errors` 가 던진다."""
        method = getattr(self, 'private_post_' + tr_code.lower(), None)
        if method is None:
            raise NotSupported(f'{self.id} 에 없는 TR 이다: {tr_code}')
        response = method({} if data_body is None else data_body)
        return self.safe_dict(response, 'dataBody', {}) or {}

    # ============ 종목 ============

    def market(self, symbol: Str) -> MarketInterface:
        """종목. 종목 목록 TR 을 쓰지 않고 심볼 모양으로 만든다. `005930/KRW`·`005930` 은 국내, 그 밖은 미국이다.
        `markets` 에 넣어 둔 종목이 있으면 그것을 먼저 찾는다."""
        if symbol is None:
            raise ArgumentsRequired(f'{self.id} market() requires a symbol argument')
        known = (self.markets or {}).get(symbol)
        if known is not None:
            return known
        id = self.stock_ticker(kbsec_base_symbol(symbol)).upper()
        if id == '':
            raise BadSymbol(f'{self.id} does not have market symbol {symbol}')
        country = kbsec_market_of(id)
        quote = 'KRW' if country == 'KR' else 'USD'
        base = self.common_stock_code(id)
        return self.safe_market_structure({
            'id': id,
            'symbol': f'{base}/{quote}',
            'base': base,
            'quote': quote,
            'baseId': id,
            'quoteId': quote,
            'type': 'spot',
            'spot': True,
            'margin': False,
            'swap': False,
            'future': False,
            'option': False,
            'active': True,
            'contract': False,
            # 주식은 주 단위다. 국내 호가단위는 가격대별이라 가격 정밀도는 적지 않는다.
            'precision': {'amount': 1, 'price': None},
            'info': {'country': country},
            'options': {'country': country},
        })

    def _is_us(self, market: MarketInterface) -> bool:
        return _get(market.get('options'), 'country') == 'US'

    def _domestic_security_type(self, market: MarketInterface) -> Str:
        """국내 종목의 증권 유형(`STOCK`, `ETF` 등). `options['masterData']` 에 없으면 `None` 이다."""
        stock = get_krx_stock_by_code(master_data_of(self.options), market['id'] or '')
        return None if stock is None else stock.get('securityType')

    def _is_kosdaq(self, market: MarketInterface) -> bool:
        """`options['masterData']` 가 코스닥 종목이라고 알려 주는가. 통합차트의 시장구분(`mkt_clsf`)을 고를 때 쓴다."""
        stock = get_krx_stock_by_code(master_data_of(self.options), market['id'] or '')
        return stock is not None and stock.get('market') == 'KOSDAQ'

    def price_to_precision(self, symbol: Str, price: Any) -> Str:
        """가격을 호가 단위에 맞춘 문자열. 국내는 가격대별 호가 단위 표(`krx_tick_size`)로 반올림하고, `options['masterData']` 가 주식이 아니라고
        알려 주면 표가 달라 그대로 돌려준다. 미국은 부모 클래스를 따른다. 주문 경로는 이 메서드로 가격을 바꾸지 않는다."""
        if price is None:
            return None
        market = self.market(symbol)
        if self._is_us(market):
            return super().price_to_precision(symbol, price)
        security_type = self._domestic_security_type(market)
        if security_type is not None and security_type != 'STOCK':
            return self.number_to_string(price)
        return decimal_to_precision(price, ROUND, get_krx_tick_size(fn.js_number(price)), TICK_SIZE, NO_PADDING)

    def _assert_krx_tick_aligned(self, market: MarketInterface, price: Num, method: str) -> None:
        """국내 지정가가 호가 단위 표에 맞지 않으면 요청 전에 `InvalidOrder` 다. KB 는 종목 유형을 알려 주는 경로가 없어 `options['masterData']` 가
        주식(`STOCK`)이라고 알려 줄 때만 검사한다. 모르면 서버(`1896` 주문단가 오류)에 맡긴다. 가격을 바꿔 내지 않는다."""
        if price is None or self._is_us(market) or self._domestic_security_type(market) != 'STOCK':
            return
        violation = krx_tick_violation(price)
        if violation is not None:
            raise InvalidOrder(f"{self.id} {method}() {violation} ({market['symbol']})", detail=KRX_TICK_INVALID_DETAIL)

    def fetch_investor_trading(self, symbol: str, since: Int = None, limit: Int = None,
                               params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """종목별 투자자 매매동향(`IVU10430`)을 하루 단위로 준다. 세 증권사 공통 모양이다. 국내만 지원한다.
        개인, 외국인, 기관의 값을 싣고, 등락률과 거래량, 나머지 10개 투자자 유형은 `info` 의 원문에 있다.
        기본은 오늘(KST) 하루, 순매수(`trd_clsf='1'`), 금액 기준(`amt_q_clsf='1'`)이다. `since` 와 `params['until']` 로 기간을 넓힌다.
        `params` 로 `trd_clsf`(1 순매수, 2 매수, 3 매도)나 `amt_q_clsf`(1 금액, 2 수량)를 덮어쓰면 세 투자자 필드도 그 값이 된다.
        금액은 백만 원 단위이고 원으로 바꾸지 않는다. 실계좌(2026-09-28) 5영업일의 모든 투자자 유형에서 순매수 대금 ÷ (순매수 수량 × 종가)가 약 1e-6 이었다."""
        until, query = self.handle_until_param('fetchInvestorTrading', limit, {} if params is None else params)
        market = self.market(symbol)
        if self._is_us(market):
            raise NotSupported(f'{self.id} fetchInvestorTrading() 는 국내 종목만 지원한다: {symbol}')
        today = kst_ymd(self.milliseconds())
        body = self._call_tr(KBSEC_TR['INVESTOR_TRADING'], self.extend({
            'excg_clsf': '1',
            'is_cd': market['id'],
            'strt_dt': today if since is None else kst_ymd(since),
            'end_dt': today if until is None else kst_ymd(until),
            'amt_q_clsf': '1',
            'trd_clsf': '1',
            'acml_clsf': '0',
        }, query))
        return self.limit_rows([self.extend(self.kst_stamp(pick_str(row, 'dt')), {
            'date': pick_str(row, 'dt'),
            'close': pick_num(row, 'cls_prc'),
            'change': pick_num(row, 'bdy_cmpr'),
            'individual': pick_num(row, 'indv'),
            'foreign': pick_num(row, 'fgnr'),
            'institution': pick_num(row, 'ogn'),
            'info': row,
        }) for row in pick_array(body)], since, limit)

    # ============ 시세 ============

    def _call_us_quote(self, base: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """해외 현재가 응답. 거래소코드를 후보 순서대로 시도해 현재가가 나온 응답을 돌려준다. 못 찾으면 `None`."""
        cached = self._us_exchange_cache.get(base)
        candidates = KBSEC_US_EXCHANGES if cached is None else (cached,)
        for krx_code in candidates:
            row = self._call_tr(KBSEC_TR['QUOTE_US'], self.extend({'krx_cd': krx_code, 'is_cd': base}, params))
            if pick_num(row, 'now_prc_p4') > 0:
                self._us_exchange_cache[base] = krx_code
                return row
        return None

    def fetch_ticker(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Ticker:
        params = {} if params is None else params
        market = self.market(symbol)
        market_id = market['id'] or ''
        if self._is_us(market):
            row = self._call_us_quote(market_id, params)
            if row is None:
                raise NullResponse(f'{self.id} fetchTicker() {symbol} 해외 현재가 없음 — 거래소코드 전 계열 미매칭')
        else:
            # 국내 현재가 입력은 `excg_clsf`(0 통합, 1 KRX, 2 NXT)와 `shrt_cd`(단축코드)다. `is_cd` 를 보내면 "해당자료가 없습니다"가 온다.
            row = self._call_tr(KBSEC_TR['QUOTE_KR'], self.extend({'excg_clsf': '1', 'shrt_cd': market_id}, params))
        ticker = self.parse_ticker(row, market)
        if ticker['last'] is None:
            raise NullResponse(f'{self.id} fetchTicker() {symbol} 현재가를 읽지 못했다 — 응답 필드 대조 필요')
        return ticker

    def parse_ticker(self, ticker: Dict[str, Any], market: Market = None) -> Ticker:
        """해외는 필드가 국내와 다르다(`_p4` 계열). 국내는 장 밖에서 `now_prc` 가 0 으로 오므로 양수인 첫 후보를 골라 종가로 넘어간다."""
        symbol = None if market is None else market['symbol']
        if market is not None and self._is_us(market):
            result = self.safe_ticker({
                'symbol': symbol,
                'timestamp': None,
                'datetime': None,
                'last': pick_positive_num(ticker, 'now_prc_p4'),
                'bid': pick_num(ticker, 'b_askprc_p4'),
                'ask': pick_num(ticker, 's_askprc_p4'),
                'high': pick_num(ticker, 'hgh_prc_p4'),
                'low': pick_num(ticker, 'lw_prc_p4'),
                'open': pick_num(ticker, 'opn_prc_p4'),
                'percentage': pick_num(ticker, 'up_dwn_r_p2'),
                # 거래량 필드가 없으면 비운다. 0 으로 오면 0 이다.
                'baseVolume': pick_optional_num(ticker, 'vlm', 'bdy_vlm'),
                'info': ticker,
            }, market)
        else:
            result = self.safe_ticker({
                'symbol': symbol,
                'timestamp': None,
                'datetime': None,
                'last': pick_positive_num(ticker, 'now_prc', 'bdy_cls_prc', 'krx_bdy_clpr', 'expct_ccls_prc'),
                'bid': pick_num(ticker, 'b_sq1_askprc'),
                'ask': pick_num(ticker, 's_sq1_askprc'),
                'high': pick_num(ticker, 'hgh_prc'),
                'low': pick_num(ticker, 'lw_prc'),
                'open': pick_num(ticker, 'opn_prc'),
                'percentage': pick_num(ticker, 'up_dwn_r_p2'),
                'baseVolume': pick_optional_num(ticker, 'acml_vlm', 'bdy_vlm'),
                'info': ticker,
            }, market)
        # 등락률은 `up_dwn_r_p2` 다. 보합이면 0 이 정상 값인데 `safe_ticker` 는 0 을 비우고 시가와 종가로 다시 계산하므로 KB 가 준 값으로 되돌린다.
        if 'up_dwn_r_p2' in ticker:
            result['percentage'] = pick_num(ticker, 'up_dwn_r_p2')
        return result

    def fetch_order_book(self, symbol: str, limit: Int = None, params: Optional[Dict[str, Any]] = None) -> OrderBook:
        """호가. 매수는 가격 내림차순, 매도는 오름차순이다. 호가가 하나도 없으면 `NullResponse` 다."""
        params = {} if params is None else params
        market = self.market(symbol)
        market_id = market['id'] or ''
        is_us = self._is_us(market)
        if is_us:
            krx_code = self._us_exchange_cache.get(market_id, KBSEC_US_EXCHANGES[0])
            row = self._call_tr(KBSEC_TR['ORDERBOOK_US'], self.extend({'krx_cd': krx_code, 'is_cd': market_id}, params))
        else:
            row = self._call_tr(KBSEC_TR['ORDERBOOK_KR'], self.extend({'is_cd': market_id, 'ovtm_mkt_clsf': '1'}, params))
        # 국내는 가격 `b{N}_aprc`·`s{N}_aprc`, 잔량 `b_pstn_b{N}_aprc_q`·`s_pstn_s{N}_aprc_q` 다.
        # 해외는 가격 `b_askprc{N}_p4`·`s_askprc{N}_p4`, 잔량 `b_askprc_q{N}`·`s_askprc_q{N}` 이다.
        bids: List[List[float]] = []
        asks: List[List[float]] = []
        for i in range(1, 11):
            bid_price = pick_num(row, f'b_askprc{i}_p4') if is_us else pick_num(row, f'b{i}_aprc')
            bid_size = pick_num(row, f'b_askprc_q{i}') if is_us else pick_num(row, f'b_pstn_b{i}_aprc_q')
            if bid_price > 0:
                bids.append([bid_price, bid_size])
            ask_price = pick_num(row, f's_askprc{i}_p4') if is_us else pick_num(row, f's{i}_aprc')
            ask_size = pick_num(row, f's_askprc_q{i}') if is_us else pick_num(row, f's_pstn_s{i}_aprc_q')
            if ask_price > 0:
                asks.append([ask_price, ask_size])
        if not bids and not asks:
            raise NullResponse(f'{self.id} fetchOrderBook() {symbol} 호가가 하나도 없다')
        book = self.parse_order_book({'bids': bids, 'asks': asks}, market['symbol'], None)
        if limit is not None:
            book['bids'] = book['bids'][:limit]
            book['asks'] = book['asks'][:limit]
        return book

    def fetch_ohlcv(self, symbol: str, timeframe: str = '1m', since: Int = None, limit: Int = None,
                    params: Optional[Dict[str, Any]] = None) -> List[List[Num]]:
        """봉. 국내만 지원한다. 명세(`IVS11560`)의 필드 이름으로 읽으며, 실계좌로 검증한 적은 없다. 해외 차트(`GSC10060`)는 15분 지연 시세라
        지연 봉을 공통 메서드에 섞지 않으려고 `NotSupported` 를 던진다.
        시장구분(`mkt_clsf`)은 `options['masterData']` 로 코스닥 종목임을 알면 `'1'`, 그 밖에는 코스피(`'0'`)로 보낸다. `params['mkt_clsf']` 가 있으면 그 값을 쓴다.

        `since` 가 있으면 `since` 부터 `limit`(기본 100) 개이고, 없으면 가장 최근 `limit` 개다. `params['until']`(ms)은 그 시각까지의 봉만 남긴다.
        명세의 시작일(`strt_dy`)은 뜻을 확인하지 못해 비워 보낸다. 대신 지금부터 `since`(또는 `until`)까지 덮을 만큼 최근 봉을 받아 거른다.
        조회건수 상한(9999)으로도 `since` 까지 닿지 못하면 경고 로그를 남기고 받은 가장 오래된 봉부터 돌려준다."""
        timeframe = '1m' if timeframe is None else timeframe
        params = {} if params is None else params
        market = self.market(symbol)
        if self._is_us(market):
            raise NotSupported(f'{self.id} fetchOHLCV() 는 국내 종목만 지원한다: 해외 차트는 15분 지연 시세다')
        chrt_clsf, minute = kbsec_chart_params(timeframe)
        wanted = 100 if limit is None else limit
        until = self.safe_integer(params, 'until')
        query = self.omit(params, 'until')

        # 조회는 가장 최근 봉부터 개수로만 하므로, 지금부터 그 시각까지 들어가는 봉 수를 달력 시간으로 넉넉히 센다.
        def bars_since(start: int) -> int:
            return math.ceil((self.milliseconds() - start) / kbsec_bar_ms(timeframe)) + 1

        count = wanted
        if since is not None:
            count = max(wanted, bars_since(since))
        elif until is not None:
            count = wanted + max(0, bars_since(until))
        count = min(count, KBSEC_CHART_MAX)
        body = self._call_tr(KBSEC_TR['CHART_KR'], self.extend({
            'info_ccd': '1',  # 원주가
            'mkt_clsf': '1' if self._is_kosdaq(market) else '0',  # 명세: 0 KOSPI, 1 KOSDAQ
            'chrt_clsf': chrt_clsf,
            'minute_tck_indx': minute,
            'is_cd': market['id'],
            'inq_clsf': '2',  # 데이터 수로 조회
            'inq_cnt': kbsec_num(count),
        }, query))
        received = pick_array(body)
        rows = [row for row in received if kbsec_candle_timestamp(pick_str(row, 'dt'), pick_str(row, 'tm')) is not None]
        # 일·주·월봉은 KB 가 현지 자정(00:00 KST)으로 주므로 기간 첫날의 00:00 UTC 로 옮긴다(`candle_period_utc_ms`). 규칙은 보낸 차트구분으로 고른다.
        period = KBSEC_CHART_PERIOD.get(chrt_clsf)
        candles = [[candle_period_utc_ms(cast(int, candle[0]), period, 'KR'), *candle[1:]] if period is not None else candle
                   for candle in self.parse_ohlcvs(rows, market, timeframe)]
        candles = [candle for candle in candles if until is None or cast(int, candle[0]) <= until]
        oldest = candles[0][0] if candles else None
        if since is not None and len(received) >= count and oldest is not None and oldest > since:
            logger.warning('[kbsec] 봉 조회건수 상한에 닿아 since 까지 받지 못했다. 받은 가장 오래된 봉부터 돌려준다 '
                           '(symbol=%s, timeframe=%s, since=%s, oldest=%s, count=%s)', market['symbol'], timeframe, since, oldest, count)
        return self.filter_by_since_limit(candles, since, wanted, 0)

    def parse_ohlcv(self, ohlcv: Any, market: Market = None) -> List[Num]:
        return [
            kbsec_candle_timestamp(pick_str(ohlcv, 'dt'), pick_str(ohlcv, 'tm')),
            pick_num(ohlcv, 'opn_prc_p2'),
            pick_num(ohlcv, 'hgh_prc_p2'),
            pick_num(ohlcv, 'lw_prc_p2'),
            pick_num(ohlcv, 'cls_prc_p2'),
            pick_num(ohlcv, 'vlm'),
        ]

    def fetch_trades(self, symbol: str, since: Int = None, limit: Int = None,
                     params: Optional[Dict[str, Any]] = None) -> List[Trade]:
        """시간대별 체결 내역. 국내(`IVU10080`)와 해외(`GSA10020`)를 종목 국가로 가른다.

        국내는 체결가, 체결수량, 체결시각만 채운다. 방향(매도매수구분, `sell_buy_ccd`)과 체결 ID 는 코드값 의미를 확정할 근거가 없어(명세에 설명 없음)
        채우지 않고, `info` 에 원본이 남아 있다. 체결 행에는 시각(`ccls_tm`, HHMMSS)만 있어서, 일봉(`fetch_ohlcv`)을 한 번 더 받아 거래량이 있는
        가장 최근 영업일을 가장 새 체결의 날짜로 쓴다. 날짜가 바뀐 행부터 비우는 규칙은 한국투자증권과 같다(`kst_trade_timestamps`).
        행은 새 것부터 온다. 명세에는 없지만 실계좌(2026-09-28) 30행에서 시각이 앞 행보다 늦어진 적이 없었다.
        결과는 한국투자증권처럼 오래된 것부터 둔다. `limit` 은 조회건수(`inq_cnt`)로 보내고 결과에도 적용한다(`since` 가 없으면 가장 최근 것이다).
        `since` 를 주면 `timestamp` 가 빈 행은 빠진다.

        해외는 체결구분(`ccls_clsf`, `1` 매수자체결, `2` 매도자체결)이 명세에 있어 `side` 를 채운다. 시각은 한국 시각 변환 필드(`kor_dt`·`kor_tm`)를
        쓴다(국내와 달리 여러 날짜를 한 번에 준다). 거래소코드(`krx_cd`)는 `fetch_ticker` 가 쓰는 캐시를 그대로 쓰고, 없으면 먼저 현재가 조회로 채운다."""
        params = {} if params is None else params
        market = self.market(symbol)
        if self._is_us(market):
            return self._fetch_overseas_trades_timeline(market, since, limit, params)
        body = self._call_tr(KBSEC_TR['TRADES_TIMELINE_KR'], self.extend({
            'excg_clsf': '1', 'is_cd': market['id'], 'ovtm_mkt_clsf': '0', 'inq_cnt': kbsec_num(30 if limit is None else limit),
        }, params))
        rows = pick_array(body)
        if len(rows) == 0:
            return []
        stamps = kst_trade_timestamps([pick_str(row, 'ccls_tm') for row in rows], self._last_traded_date(market), self.milliseconds())
        trades = [self.safe_trade({
            'info': row,
            'id': None,
            'order': None,
            'timestamp': timestamp,
            'datetime': self.iso8601(timestamp),
            'symbol': market['symbol'],
            'type': None,
            'side': None,
            'takerOrMaker': None,
            'price': pick_num(row, 'ccls_prc'),
            'amount': pick_num(row, 'ccls_q'),
            'cost': None,
            'fee': None,
        }, market) for row, timestamp in zip(rows, stamps)]
        trades.reverse()
        return self.filter_by_since_limit(trades, since, limit, 'timestamp', since is None)

    def _last_traded_date(self, market: MarketInterface) -> Str:
        """거래량이 있는 가장 최근 영업일(`YYYYMMDD`). 일봉을 받지 못했거나 최근 30개에 그런 날이 없으면 `None` 이다.
        통합차트의 시장구분은 코스피(`0`)가 기본이고, `options['masterData']` 가 코스닥 종목이라고 알려 주면 코스닥(`1`)으로 조회한다."""
        symbol = market['symbol']
        try:
            candles = self.fetch_ohlcv(symbol, '1d', None, 30, {'mkt_clsf': '1'} if self._is_kosdaq(market) else {})
        except Exception as err:
            logger.warning('[kbsec] fetch_trades 의 날짜를 정할 일봉을 받지 못해 체결 시각을 비운다 (symbol=%s, err=%s)', symbol, err)
            return None
        days = [cast(int, candle[0]) for candle in candles if (candle[5] or 0) > 0]
        return kst_ymd(max(days)) if days else None

    def _fetch_overseas_trades_timeline(self, market: MarketInterface, since: Int, limit: Int, params: Dict[str, Any]) -> List[Trade]:
        base = market['id'] or ''
        if self._us_exchange_cache.get(base) is None:
            self._call_us_quote(base, {})
        krx_code = self._us_exchange_cache.get(base, KBSEC_US_EXCHANGES[0])
        body = self._call_tr(KBSEC_TR['TRADES_TIMELINE_US'], self.extend({
            'krx_cd': krx_code, 'is_cd': base, 'rcrd_c': kbsec_num(30 if limit is None else limit),
        }, params))
        trades: List[Trade] = []
        for row in pick_array(body):
            timestamp = kbsec_candle_timestamp(pick_str(row, 'kor_dt'), pick_str(row, 'kor_tm'))
            ccls_clsf = pick_str(row, 'ccls_clsf')
            trades.append(self.safe_trade({
                'info': row,
                'id': None,
                'order': None,
                'timestamp': timestamp,
                'datetime': self.iso8601(timestamp),
                'symbol': market['symbol'],
                'type': None,
                'side': 'buy' if ccls_clsf == '1' else 'sell' if ccls_clsf == '2' else None,
                'takerOrMaker': None,
                'price': pick_num(row, 'now_prc_p4'),
                'amount': pick_num(row, 'ccls_q'),
                'cost': None,
                'fee': None,
            }, market))
        return trades if since is None else [trade for trade in trades if (trade['timestamp'] or 0) >= since]

    # ============ 수수료 ============

    def fetch_trading_fee(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> TradingFeeInterface:
        """위탁수수료율의 추정이다. KB 에 수수료 조회 TR 이 없어 공시 요율의 근사를 돌려준다(`info['estimated']` 가 `True`).
        국내 매도(`params['side']` 가 `'sell'`)는 시행일별 증권거래세를 더한 실효율이다."""
        market = self.market(symbol)
        side = 'sell' if (params or {}).get('side') == 'sell' else 'buy'
        rate = kbsec_estimated_fee_rate('US' if self._is_us(market) else 'KR', side)
        return {'info': {'estimated': True, 'side': side}, 'symbol': market['symbol'], 'maker': rate, 'taker': rate, 'percentage': True,
                'tierBased': False}

    # ============ 휴장일 ============

    def fetch_market_calendar(self, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """국내 휴장일을 날짜별 개장 여부로 돌려준다. 장운영상태(`SZQM0771`)가 주는 전영업일, 기준영업일, 익영업일을 열린 날로 보고, 그 사이의
        평일을 닫힌 날로 넓힌다. KB 는 이 세 날짜 밖은 알려 주지 않으므로 넓히는 범위가 앞뒤 며칠이다.
        세 증권사 공통 모양이다. `params['market']` 은 `'KR'`(기본)만 받고, `'US'` 는 요청 없이 `NotSupported` 다."""
        if self._calendar_market(params) == 'US':
            raise NotSupported(f'{self.id} fetchMarketCalendar() 는 국내 휴장일만 준다')
        body = self._call_tr(KBSEC_TR['MARKET_STATUS'], self.omit(params or {}, 'market'))
        open_dates = [date for date in (pick_str(body, 'bfr_bsns_dt'), pick_str(body, 'std_bsnss_dt'), pick_str(body, 'next_biz_dt')) if date != '']
        return expand_business_days(open_dates)

    def refresh_market_calendar(self) -> bool:
        """`fetch_market_calendar` 의 결과를 공용 휴장일 캘린더(`market_calendar`)에 넣는다. 장 시간 판정이 이 캘린더를 읽는다. 장 시간 판정을
        주문 밖에서 쓰면 시작할 때 한 번 직접 부른다. 6시간 안에 성공한 호출은 다시 하지 않는다.
        신선한 캘린더가 있으면 `True` 다. 자격증명이 없으면 부르지 않고 `False` 다. 호출에 실패해도 던지지 않는다."""
        if self.apiKey is None or self.secret is None:
            return False
        return refresh_shared_market_calendar('KR', self.fetch_market_calendar, CALENDAR_TTL_MS)

    # ============ 주문 ============

    def fetch_marketable_buy_price(self, symbol: str) -> float:
        """해외 시장가 매수를 대체하는 체결 가능 지정가. 매도호가(없으면 현재가)에 `options['marketableLimitBuffer']` 를 더해 센트 단위로 올린다.
        미국 주식 호가단위는 $1 이상 구간에서 $0.01 이라 4자리로 보내면 단위 위반이고, 올림이라 늘 호가 이상이다(내림하면 크로스가 안 돼 미체결로 남는다).
        호가를 못 구하면 던진다. 가격 없는 주문은 거부되고 KB 는 잘못된 호출 반복을 계정 제한 사유로 들므로 보내지 않는다."""
        try:
            ticker: Optional[Ticker] = self.fetch_ticker(symbol)
        except Exception as err:
            logger.warning('[kbsec] 해외 시장가 매수 대체용 호가 조회 실패: symbol=%s err=%s', symbol, err)
            ticker = None
        ask = None if ticker is None else ticker.get('ask')
        last = None if ticker is None else ticker.get('last')
        # JavaScript 의 `ask || last` 와 같다. 매도호가가 없거나 0(또는 NaN)이면 현재가다.
        reference = ask if _js_truthy(ask) else last
        if reference is None or not math.isfinite(reference) or reference <= 0:
            raise ExchangeError('KB 해외 시장가 매수는 지정가 대체가 필요한데 호가를 조회하지 못했다')
        price = math.ceil(reference * (1 + self.options['marketableLimitBuffer']) * 100) / 100
        logger.info('[kbsec] 해외 시장가 매수 → 체결 가능 지정가 대체: symbol=%s ask=%s last=%s limitPrice=%s', symbol, ask, last, price)
        return price

    def _session_block_reason(self, base: str, side: Optional[str]) -> Optional[str]:
        """주문 게이트. 판정은 공용 술어(`market_session_block_reason`)에 맡긴다. `side` 를 주면 `blockAuctionBuys` 의 동시호가 매수 차단도 건다."""
        block_auction_buys = self.is_option_enabled('blockAuctionBuys') if side is not None else False
        return market_session_block_reason('kbsec', base, self.milliseconds(), master_data_of(self.options), side, block_auction_buys)

    def create_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None,
                           params: Optional[Dict[str, Any]] = None) -> Order:
        """주문을 낸다. `type` 은 `limit`·`market`, `side` 는 `buy`·`sell` 이다.

        - 장 시간 밖이면 요청을 보내지 않고 `MarketClosed` 를 던진다. 국내는 판정 전에 휴장일 캘린더를 받는다(`refresh_market_calendar`).
        - 국내는 주 단위다. 수량은 내림하고(`8.87` 은 `8`), 1주 미만이면 `InvalidOrder` 다.
        - KB 해외는 시장가 매수를 받지 않는다. 매도호가에 버퍼를 더한 지정가(체결 가능 지정가, `fetch_marketable_buy_price`)로 바꿔 보낸다.
          지정가가 호가보다 높으면 체결은 호가에서 일어나므로 버퍼는 상한일 뿐 비용이 아니다. 호가를 못 구하면 보내지 않는다.
        - 접수 뒤에는 체결 조회로 체결가와 수량을 확정한다. 확정하지 못하면 `order['info']['fillConfirmed']` 가 `False` 이고 `filled` 는 비어 있다.
        - `params['fractional']` 이 참이면 국내 소수점 주문이다(수량을 소수 6자리로 보내고 체결 확정을 하지 않는다).
        - `params['sor']` 는 국내 라우팅(`K` KRX, `N` NXT, `S` SOR)이다. 생략하면 `options['nxtRouting']` 을 따른다.
        - 조건 인자는 받지 않는다. `params` 에 `triggerPrice`·`stopPrice`·`stopLossPrice`·`takeProfitPrice`·`stopLoss`·`takeProfit` 가 있으면
          요청 없이 `NotSupported` 다. 스탑지정가는 `create_trigger_order` 로 낸다.

        시간 초과나 연결 끊김은 `OrderOutcomeUnknown` 이다. 다시 보내지 말고 `fetch_my_trades` 로 접수 여부를 확인한다.
        """
        params = {} if params is None else params
        amount, price = cast(float, fn.decimal_to_float(amount)), cast(Optional[float], fn.decimal_to_float(price))
        market = self.market(symbol)
        # 조건 주문 인자는 어떤 요청보다 먼저 거른다(세션 게이트의 휴장일 조회도 요청이다).
        for key in UNSUPPORTED_CONDITIONAL_PARAMS:
            if self.safe_value(params, key) is not None:
                raise NotSupported(f'{self.id} createOrder() does not support {key} (conditional orders): 조건 인자는 받지 않는다. '
                                   '스탑지정가는 createTriggerOrder() 로 낸다')
        self.check_order_arguments(market, type, side, amount, price, params)
        if type == 'limit':
            self._assert_krx_tick_aligned(market, price, 'createOrder')
        is_kr = not self._is_us(market)
        base = market['id'] or ''
        fractional = params.get('fractional') is True
        sor_override = self.safe_string(params, 'sor')
        extra = self.omit(params, ['fractional', 'sor', 'timeInForce', 'postOnly', 'reduceOnly', 'clientOrderId', 'cost'])

        # 세션 게이트. 거래시간 밖 주문은 KB 로 보내지 않고 `MarketClosed` 로 막는다.
        if is_kr:
            self.refresh_market_calendar()
        closed = self._session_block_reason(base, side)
        if closed is not None:
            logger.info('[kbsec] 거래시간 외 주문 차단: symbol=%s side=%s reason=%s', symbol, side, closed)
            raise MarketClosed(closed)

        if fractional:
            return self._create_fractional_order(market, side, amount)

        effective_price = price
        is_market = type == 'market'
        # 해외 시장가 매수는 KB 가 받지 않는다(`시장가주문은 매도만 가능합니다`, G474). 매도는 시장가로 나가므로 청산 경로는 그대로다.
        # 패시브 지정가(최우선 매수호가)로 걸지 않는다. 미체결로 남으면 매수 시점이 지나가 "주문은 나갔는데 안 산" 상태가 된다.
        if not is_kr and side == 'buy' and is_market:
            effective_price = self.fetch_marketable_buy_price(symbol)
            is_market = False
        is_limit = not is_market

        # 증권사에 실제로 나가는 수량은 내림값이다. 이 값이 본문, 체결 조회, 반환값의 정본이다.
        submitted_qty = math.floor(amount)
        # 주 단위 주문은 1주 미만이면 수량이 0 으로 나가 거부된다(`주문수량을 확인하십시오`, 2329). 거부될 주문은 보내지 않는다.
        if submitted_qty < 1:
            raise InvalidOrder(f'{self.id} 1주 미만 주문 불가 (수량 {fn.js_string(amount)}). 미국 소수점 주문은 params.fractional 을 준다',
                               detail=KBSEC_ERROR_DETAIL['QUANTITY_INVALID'])

        if is_kr:
            tr_code = KBSEC_TR['BUY_KR'] if side == 'buy' else KBSEC_TR['SELL_KR']
            jb_clsf = KBSEC_ORDER_SIDE_KR['BUY'] if side == 'buy' else KBSEC_ORDER_SIDE_KR['SELL']

            def send(sor: str) -> Dict[str, Any]:
                return self._call_tr(tr_code, build_kr_order_body(base, jb_clsf, amount=submitted_qty, price=effective_price, is_limit=is_limit,
                                                                        sor=sor, override=extra))

            # `nxtRouting` 옵션이 켜져 있으면 SOR 에 맡긴다(KRX·NXT 가운데 유리한 쪽). 꺼져 있으면 KRX 고정이다.
            # NXT 미상장 종목이라고 이미 확인했으면 왕복을 건너뛴다.
            want_sor = sor_override is None and self.is_option_enabled('nxtRouting') and base not in self._nxt_ineligible
            first_sor = sor_override if sor_override is not None else KBSEC_SOR['SOR'] if want_sor else KBSEC_SOR['KRX']
            try:
                response = send(first_sor)
                resend = False
            except ExchangeError as err:
                # NXT 미상장 종목(우선주 등)은 SOR 로 나가면 통째로 거부된다. 증권사가 사유와 조치를 그대로 알려 준다(`KRX로 주문해주세요`).
                # 업무 거부라 주문은 접수되지 않았고, 다시 보내도 중복 주문이 되지 않는다.
                if not want_sor or err.detail != KBSEC_ERROR_DETAIL['NXT_INELIGIBLE']:
                    raise
                resend = True
            if resend:
                # 한 번 확인한 종목은 인스턴스 수명 동안 기억해 다음 주문부터 KRX 로 바로 보낸다.
                self._nxt_ineligible.add(base)
                logger.warning('[kbsec] NXT 미상장 — KRX 로 재주문 (이후 이 종목은 KRX 직행): symbol=%s side=%s qty=%s', symbol, side, submitted_qty)
                response = send(KBSEC_SOR['KRX'])
        else:
            response = self._call_tr(KBSEC_TR['ORDER_US'], self.extend({
                'trd_dl_ccd': KBSEC_ORDER_SIDE_US['BUY'] if side == 'buy' else KBSEC_ORDER_SIDE_US['SELL'],
                'is_cd': base,
                'frgn_ordr_typ_cd': KBSEC_ORDER_TYPE_US['LIMIT'] if is_limit else KBSEC_ORDER_TYPE_US['MARKET'],
                # 국내와 같은 이유로 내림이다. `kbsec_num` 은 반올림이라 요청 수량보다 많이 살 수 있다.
                'frgn_ordr_q': kbsec_num(submitted_qty),
                'frgn_ordr_prc_p4': kbsec_num(0 if effective_price is None else effective_price, 4) if is_limit else '0',
            }, extra))
        order_id = pick_str(response, 'ordr_no', 'odno')
        logger.info('[kbsec] %s 주문 접수: symbol=%s side=%s amount=%s submittedQty=%s orderId=%s', '국내' if is_kr else '해외', symbol, side, amount,
                    submitted_qty, order_id)
        return self._confirmed_order(order_id, market, side, 'limit' if is_limit else 'market', submitted_qty, effective_price, response)

    def create_trigger_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None, trigger_price: Num = None,
                                   params: Optional[Dict[str, Any]] = None) -> Order:
        """스탑지정가 주문을 낸다. 조건가격(`trigger_price`)에 닿으면 `price` 지정가 주문이 된다. 국내(`ordr_ccd='S0'`)와 해외
        (`frgn_ordr_typ_cd='C'`) 모두 지정가만 지원한다. 시장가 트리거(해외 명세의 `B`)는 실계좌로 확인하지 않아 쓰지 않는다.
        `price` 와 `trigger_price` 둘 다 필요하다. 장 시간 밖이면 `create_order` 와 같이 요청 없이 `MarketClosed` 다.
        국내는 `params` 를 본문에 싣지 않고, 해외는 본문에 합친다."""
        params = {} if params is None else params
        amount = cast(float, fn.decimal_to_float(amount))
        price, trigger_price = cast(Optional[float], fn.decimal_to_float(price)), cast(Optional[float], fn.decimal_to_float(trigger_price))
        if trigger_price is None:
            raise ArgumentsRequired(f'{self.id} createTriggerOrder() 는 triggerPrice 인자가 필요하다')
        if price is None:
            raise ArgumentsRequired(f'{self.id} createTriggerOrder() 는 price 인자가 필요하다(스탑지정가는 지정가만 지원한다)')
        market = self.market(symbol)
        base = market['id'] or ''
        is_kr = not self._is_us(market)
        self.check_order_arguments(market, 'limit', side, amount, price, params)

        if is_kr:
            self.refresh_market_calendar()
        closed = self._session_block_reason(base, side)
        if closed is not None:
            logger.info('[kbsec] 거래시간 외 주문 차단: symbol=%s side=%s reason=%s', symbol, side, closed)
            raise MarketClosed(closed)

        submitted_qty = math.floor(amount)
        if submitted_qty < 1:
            raise InvalidOrder(f'{self.id} 1주 미만 주문 불가 (수량 {fn.js_string(amount)})', detail=KBSEC_ERROR_DETAIL['QUANTITY_INVALID'])

        if is_kr:
            tr_code = KBSEC_TR['BUY_KR'] if side == 'buy' else KBSEC_TR['SELL_KR']
            response = self._call_tr(tr_code, build_kr_order_body(
                base, KBSEC_ORDER_SIDE_KR['BUY'] if side == 'buy' else KBSEC_ORDER_SIDE_KR['SELL'], amount=submitted_qty, price=price, is_limit=True,
                override={'ordr_ccd': KBSEC_ORDER_TYPE_KR['STOP_LIMIT'], 'stpd_prc': kbsec_num(trigger_price)}))
        else:
            response = self._call_tr(KBSEC_TR['ORDER_US'], self.extend({
                'trd_dl_ccd': KBSEC_ORDER_SIDE_US['BUY'] if side == 'buy' else KBSEC_ORDER_SIDE_US['SELL'],
                'is_cd': base,
                'frgn_ordr_typ_cd': KBSEC_ORDER_TYPE_US['STOP_LIMIT'],
                'frgn_ordr_q': kbsec_num(submitted_qty),
                'frgn_ordr_prc_p4': kbsec_num(price, 4),
                'frgn_stp_prc_p4': kbsec_num(trigger_price, 4),
            }, params))
        order_id = pick_str(response, 'ordr_no', 'odno')
        logger.info('[kbsec] %s 스탑지정가 주문 접수: symbol=%s side=%s amount=%s submittedQty=%s price=%s triggerPrice=%s orderId=%s',
                    '국내' if is_kr else '해외', symbol, side, amount, submitted_qty, price, trigger_price, order_id)
        return self._confirmed_order(order_id, market, side, 'limit', submitted_qty, price, response)

    def _confirmed_order(self, order_id: str, market: MarketInterface, side: str, type: str, quantity: float, price: Optional[float],
                               response: Dict[str, Any]) -> Order:
        """접수된 주문의 실체결을 확정해 주문으로 만든다. 접수 응답에는 체결 정보가 없어 계좌 체결내역에서 주문번호로 찾는다.
        확정하지 못하면 `filled`·`average` 를 비워 둔다(주문 자체는 접수됐다). 값을 지어내지 않고 `info['fillConfirmed']` 를 `False` 로 둔다."""
        is_kr = not self._is_us(market)
        fee_currency = 'KRW' if is_kr else 'USD'
        draft: Dict[str, Any] = {
            'id': None if order_id == NO_ORDER_ID else order_id,
            'timestamp': self.milliseconds(),
            'symbol': market['symbol'],
            'type': type,
            'side': side,
            'price': price,
            'amount': quantity,
            'status': 'open',
            'trades': [],
        }

        def unconfirmed() -> Order:
            return self.safe_order(self.extend(draft, {'info': self.extend(response, {'fillConfirmed': False})}), market)

        if order_id == NO_ORDER_ID:
            return unconfirmed()

        def fetch_trades() -> List[Dict[str, Any]]:
            return cast(List[Dict[str, Any]], self.fetch_my_trades(market['symbol']))

        # 국내만 드물고 긴 예산을 쓴다. 해외는 공용 기본값이다. `options['confirmBudget']` 이 있으면 둘 다 이긴다.
        budget = self.get_confirm_budget(self.options.get('domesticConfirmBudget') if is_kr else None)
        matched = confirm_execution('[kbsec]', order_id, 'kbsec', trade_list_probe(fetch_trades, order_id, quantity, fee_currency), budget=budget)
        if matched is None:
            return unconfirmed()

        # 체결수량은 주문수량을 넘을 수 없다. 넘는다면 체결 행 해석이 틀린 것이다(같은 체결을 두 번 셌거나 연속 행을 엉뚱한 주문에 귀속시킨 경우).
        # 상한이 없으면 실제보다 많은 수량으로 포지션이 열린다.
        filled = min(matched['filled'], quantity)
        clamped = filled != matched['filled']
        if clamped:
            logger.warning('[kbsec] 체결수량이 주문수량을 초과해 상한으로 자름 — 체결 행 해석 대조 필요: orderId=%s symbol=%s reported=%s requested=%s',
                           order_id, market['symbol'], matched['filled'], quantity)

        # 자른 경우 체결금액도 같이 자른다. 수량과 금액이 어긋나면 평단이 틀어진다.
        def product(a: float, b: Num) -> float:
            return fn.js_number(Precise.string_mul(fn.number_to_string(a), fn.number_to_string(0 if b is None else b)) or 0)

        if clamped:
            cost = product(filled, matched['average'])
        else:
            cost = matched['amount'] if matched['amount'] is not None else product(matched['filled'], matched['average'])
        logger.info('[kbsec] 실체결 확정: orderId=%s symbol=%s side=%s requestedPrice=%s actualPrice=%s actualQty=%s deviationBps=%s',
                    order_id, market['symbol'], side, price, matched['average'], filled, fill_deviation_bps(price, matched['average']))
        return self.safe_order(self.extend(draft, {
            'status': 'closed' if filled >= quantity else 'open',
            'filled': filled,
            'remaining': max(0, quantity - filled),
            'average': matched['average'] if matched['average'] is not None else price,
            'cost': cost,
            'fee': {'cost': matched['fee'], 'currency': fee_currency if matched.get('feeCurrency') is None else matched['feeCurrency']}
            if matched['fee'] is not None else None,
            'info': self.extend(response, {'fillConfirmed': True}),
        }), market)

    def create_market_buy_order_with_cost(self, symbol: str, cost: float, params: Optional[Dict[str, Any]] = None) -> Order:
        """미국 주식 시장가 매수를 금액으로 낸다. 소수점매도/매수주문(`SKAM2201`)을 금액 기준(`amt_q_clsf='0'`)으로 부른다.
        이 TR 은 `SKAM2101` 과 주문유형코드 값이 달라 시장가(`1`)가 없고 유사시장가(`E`)를 쓴다. 금액은 내림해 보낸다.
        체결 확정은 하지 않는다(다른 소수점 주문과 같다). `order['info']['fillConfirmed']` 는 늘 `False` 다.
        국내 종목은 요청 없이 `NotSupported`, 장 시간 밖이면 요청 없이 `MarketClosed` 다."""
        params = {} if params is None else params
        cost = cast(float, fn.decimal_to_float(cost))
        market = self.market(symbol)
        if not self._is_us(market):
            raise NotSupported(f'{self.id} createMarketBuyOrderWithCost() 는 미국 종목만 지원한다: {symbol}')
        if cost is None or not cost > 0:
            raise ArgumentsRequired(f'{self.id} createMarketBuyOrderWithCost() requires a cost argument above 0')

        closed = self._session_block_reason(market['id'] or '', 'buy')
        if closed is not None:
            logger.info('[kbsec] 거래시간 외 주문 차단: symbol=%s cost=%s reason=%s', symbol, cost, closed)
            raise MarketClosed(closed)

        # 실제로 나가는 금액은 내림값이다(소수점 아래는 버린다). `ordr_amt` 가 소수 0자리 필드라 반올림하면 초과 주문이 나간다.
        submitted_cost = math.floor(cost)
        response = self._call_tr(KBSEC_TR['FRAC_ORDER_US'], self.extend({
            'frgn_krx_ccd': 'US',
            'trd_dl_ccd': KBSEC_ORDER_SIDE_US['BUY'],
            'is_cd': market['id'],
            'amt_q_clsf': '0',  # 0 금액, 1 수량
            'tv_s_est_f': '',
            'frgn_ordr_typ_cd': 'E',  # 2 지정가, E 유사시장가
            'crncy_ccd': '1',  # 0 원화, 1 외화(USD)
            'ordr_amt': kbsec_num(submitted_cost),
            'dcml_ordr_q_p6': '',
            'frgn_ordr_prc_p4': '',
            'spclz_ordr_ccd': '33',  # 소수점매매주문(소수점매매-금액기준)
            'cpn_cd': '',
            'cutn_mtr_cnfr_f': '',
        }, params))
        order_id = pick_str(response, 'ordr_no', 'odno')
        logger.info('[kbsec] 금액 기준 시장가 매수: symbol=%s cost=%s submittedCost=%s orderId=%s', symbol, cost, submitted_cost, order_id)
        return self.safe_order({
            'id': None if order_id == NO_ORDER_ID else order_id,
            'timestamp': self.milliseconds(),
            'symbol': market['symbol'],
            'type': 'market',
            'side': 'buy',
            'cost': submitted_cost,
            'status': 'open',
            'trades': [],
            'info': self.extend(response, {'fillConfirmed': False, 'fractional': True}),
        }, market)

    def _create_fractional_order(self, market: MarketInterface, side: str, amount: float) -> Order:
        """국내 소수점 주문. 수량이 정수가 아니어도 된다. 체결 확정은 하지 않는다. 해외는 지원하지 않는다.
        필드 이름은 `ordr_q_p6` 다(`_p6` 접미사가 소수 6자리를 뜻한다). 정수 주문의 `ordr_q` 로 보내면 수량 없는 주문이 나간다."""
        if self._is_us(market):
            raise NotSupported(f'{self.id} 해외 소수점은 미배선이다')
        response = self._call_tr(KBSEC_TR['FRAC_BUY_KR'] if side == 'buy' else KBSEC_TR['FRAC_SELL_KR'], {
            'is_cd': market['id'],
            'ordr_q_p6': kbsec_num(amount, 6),
        })
        order_id = pick_str(response, 'ordr_no', 'odno')
        logger.info('[kbsec] 소수점 주문: symbol=%s side=%s amount=%s orderId=%s', market['symbol'], side, amount, order_id)
        return self.safe_order({
            'id': None if order_id == NO_ORDER_ID else order_id,
            'timestamp': self.milliseconds(),
            'symbol': market['symbol'],
            'type': 'market',
            'side': side,
            'amount': amount,
            'status': 'open',
            'trades': [],
            'info': self.extend(response, {'fillConfirmed': False, 'fractional': True}),
        }, market)

    def edit_order(self, id: str, symbol: str, type: str, side: str, amount: Num = None, price: Num = None,
                         params: Optional[Dict[str, Any]] = None) -> Order:
        """정정주문. 취소 후 재접수보다 체결 순위를 덜 잃는다(원주문 시각 일부 승계).

        - 정정하면 주문번호가 바뀐다. 이후 취소는 새 번호(`order['id']`)로 한다. 옛 번호로 취소하면 주문이 살아남는다.
        - 국내는 원주문과 같은 라우팅으로 보낸다(SOR 주문을 KRX 로 정정하면 거부된다). 미체결 목록 행의 `sor_ordr_ccd` 가 정본이다.
        - `amount` 는 ccxt 와 같이 정정 뒤 주문의 총수량(체결분 포함)이다. 국내는 주면 미체결 목록으로 체결 수량과 잔량의 합과 대조하고, 같을 때만
          잔량 전부를 정정한다. 다르면 정정 요청 없이 `NotSupported` 다. 조회가 실패하면 던진다. 해외는 원주문의 체결 수량을 믿을 만한 조회로
          확인할 수 없어 `amount` 를 주면 요청 없이 `NotSupported` 다.
        - 국내 전부정정은 수량을 0 으로 보낸다. 잔량 일부만 새 가격으로 옮기는 일부정정은 `params['partial']` 이 `True` 일 때만 보내고
          (`crct_clsf: '1'`), 이때 `amount` 는 옮길 수량이다.
        - 해외 정정은 잔량 전부의 가격만 바꾼다(`SKAM2102` 에 수량 필드가 없다). 일부정정은 `NotSupported` 다.
        - `price` 가 필요하다. 빼면 요청 없이 `ArgumentsRequired` 다(빼고 보내면 단가 `0` 이 나간다).
        - 장 시간 밖이면 원주문 조회와 정정 요청을 보내지 않고 `MarketClosed` 다. `create_order` 와 같은 시간표이고, 정정은 신규 진입이 아니라서
          `blockAuctionBuys` 의 동시호가 매수 차단은 걸지 않는다.
        """
        params = {} if params is None else params
        amount, price = cast(Optional[float], fn.decimal_to_float(amount)), cast(Optional[float], fn.decimal_to_float(price))
        market = self.market(symbol)
        base = market['id'] or ''
        # 정정은 단가를 바꾸는 주문이다. 가격을 빼면 단가 '0' 이 나가므로 원주문 라우팅 조회를 포함해 어떤 요청보다 먼저 막는다.
        if price is None:
            raise ArgumentsRequired(f'{self.id} editOrder() requires a price argument')
        is_partial = params.get('partial') is True
        if is_partial and amount is None:
            raise ArgumentsRequired(f'{self.id} editOrder() 의 일부정정(params.partial)에는 옮길 수량 amount 가 필요하다')
        if self._is_us(market):
            if is_partial:
                raise NotSupported(f'{self.id} editOrder() 의 일부정정(params.partial)은 해외 주문에서 지원하지 않는다(해외 정정은 가격만 바꾼다)')
            # 해외 원주문의 체결 수량은 체결내역과 체결현황을 맞춰 추정해야 한다. 체결 반영이 늦으면 잔량을 크게 잡으므로 amount 를 대조하지 않고 막는다.
            if amount is not None:
                raise NotSupported(f'{self.id} editOrder() 는 해외 주문의 amount 를 받지 않는다. 원주문의 체결 수량을 믿을 만한 조회로 확인할 수 없다. '
                                   'amount 를 빼면 잔량 전부의 가격만 정정하고, 수량을 바꾸려면 취소한 뒤 다시 주문한다')
            self._assert_edit_session_open(symbol, base, False)
            response = self._call_tr(KBSEC_TR['AMEND_CANCEL_US'], {
                'is_cd': base,
                'orgn_ordr_no': id,
                # 해외 TR(SKAM2102)의 구분 필드는 `crct_cncl_clsf` 다(국내의 `crct_clsf` 가 아니다). 스펙 밖 키는 구분이 빈 값으로 나간다.
                'crct_cncl_clsf': '1',
                'frgn_ordr_prc_p4': kbsec_num(price, 4),
            })
            return self._edited_order(response, market, price, None)
        self._assert_krx_tick_aligned(market, price, 'editOrder')
        self._assert_edit_session_open(symbol, base, True)
        if not is_partial and amount is not None:
            # 수량을 대조하므로 원주문 조회 실패를 발주 정책으로 덮지 않고 던진다.
            original = self._find_open_order(id, symbol)
            assert_whole_remaining_edit(self.id, id, amount, original)
            sor = pick_str(original.get('info') or {}, 'sor_ordr_ccd') or self._default_order_sor(symbol)
        else:
            sor = self._resolve_order_sor(id, symbol)
        response = self._call_tr(KBSEC_TR['AMEND_KR'], build_kr_order_body(
            base, KBSEC_ORDER_SIDE_KR['AMEND'], amount=amount if is_partial else 0, price=price, sor=sor,
            override={'crct_clsf': '1' if is_partial else '2', 'orgn_ordr_no': id}))
        new_id = pick_str(response, 'ordr_no', 'odno')
        logger.info('[kbsec] 정정주문 — 주문번호가 바뀌었다: orderId=%s newOrderId=%s symbol=%s price=%s sor=%s partial=%s', id, new_id, symbol, price, sor,
                    is_partial)
        # 일부정정은 옮긴 수량, 전부정정은 대조한 총수량을 싣는다. `amount` 없이 부른 전부정정의 수량은 이 응답으로 알 수 없어 싣지 않는다.
        return self._edited_order(response, market, price, amount)

    def _assert_edit_session_open(self, symbol: str, ticker: str, is_kr: bool) -> None:
        """정정 게이트. `create_order` 와 같은 판정이고, 방향을 넘기지 않아 동시호가 매수 차단은 걸지 않는다. 국내는 휴장일 캘린더를 먼저 받는다."""
        if is_kr:
            self.refresh_market_calendar()
        closed = self._session_block_reason(ticker, None)
        if closed is not None:
            logger.info('[kbsec] 거래시간 외 정정 차단: symbol=%s reason=%s', symbol, closed)
            raise MarketClosed(closed)

    def _edited_order(self, response: Dict[str, Any], market: MarketInterface, price: Num, amount: Num) -> Order:
        id = pick_str(response, 'ordr_no', 'odno')
        return self.safe_order({
            'id': None if id == NO_ORDER_ID else id,
            'timestamp': self.milliseconds(),
            'symbol': market['symbol'],
            'type': 'limit',
            'price': price,
            'amount': amount,
            'status': 'open',
            'trades': [],
            'info': response,
        }, market)

    def _resolve_order_sor(self, order_id: str, symbol: str) -> str:
        """원주문이 어느 라우팅으로 나갔는지. 정정과 취소에 그대로 싣는다. 미체결 목록 행의 `sor_ordr_ccd` 를 정본으로 본다.
        못 찾으면(이미 체결, 조회 실패) 발주 때와 같은 정책으로 되짚는다. 같은 인스턴스 안에서는 `nxtRouting` 옵션과 NXT 캐시가 그대로라 같은 값이 나온다."""
        try:
            found = next((order for order in self.fetch_open_orders(symbol) if order.get('id') == order_id), None)
            sor = pick_str((found or {}).get('info') or {}, 'sor_ordr_ccd')
            if sor != '':
                return sor
        except Exception as err:
            logger.warning('[kbsec] 원주문 라우팅 조회 실패 — 발주 정책으로 폴백: orderId=%s symbol=%s err=%s', order_id, symbol, err)
        return self._default_order_sor(symbol)

    def _default_order_sor(self, symbol: str) -> str:
        """발주 때와 같은 라우팅 정책(`nxtRouting` 옵션과 NXT 미상장 캐시)."""
        if self.is_option_enabled('nxtRouting') and kbsec_base_symbol(symbol) not in self._nxt_ineligible:
            return KBSEC_SOR['SOR']
        return KBSEC_SOR['KRX']

    def _find_open_order(self, order_id: str, symbol: str) -> Order:
        """정정할 국내 원주문을 미체결 목록에서 찾는다. 조회가 실패하면 던지고, 목록에 없으면 `OrderNotFound` 다."""
        found = next((order for order in self.fetch_open_orders(symbol) if order.get('id') == order_id), None)
        if found is None:
            raise OrderNotFound(f'{self.id} editOrder() 미체결 주문을 찾지 못했다: {order_id} ({symbol})')
        return found

    def cancel_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Order:
        """주문 취소(전부 취소). `symbol` 이 필요하다. 이미 체결되거나 취소된 주문은 KB 가 거부하므로 그 오류를 그대로 던진다. 호출하는 쪽이
        그것을 "이미 사라진 주문"으로 볼지 실패로 볼지 정한다. 국내는 원주문의 라우팅(`params['sor_ordr_ccd']`, 없으면 미체결 목록)을 싣는다.
        장 시간 게이트는 거치지 않는다. `params` 는 본문에 합친다."""
        params = {} if params is None else params
        if symbol is None:
            raise ArgumentsRequired(f'{self.id} cancelOrder() requires a symbol argument')
        market = self.market(symbol)
        if not self._is_us(market):
            # 원주문의 라우팅(SOR)을 싣는다. 정정과 같이 SOR 주문을 KRX 로 취소하면 거부될 수 있다.
            given_sor = self.safe_string(params, 'sor_ordr_ccd')
            sor = given_sor if given_sor is not None else self._resolve_order_sor(id, symbol)
            response = self._call_tr(KBSEC_TR['CANCEL_KR'], build_kr_order_body(
                market['id'] or '', KBSEC_ORDER_SIDE_KR['CANCEL'], sor=sor,
                override=self.extend({'crct_clsf': '2', 'orgn_ordr_no': id}, params)))  # 2 전부취소
        else:
            response = self._call_tr(KBSEC_TR['AMEND_CANCEL_US'], self.extend({
                'is_cd': market['id'],
                'orgn_ordr_no': id,
                'crct_cncl_clsf': '2',
            }, params))
        logger.info('[kbsec] 주문 취소: orderId=%s symbol=%s', id, symbol)
        return self.safe_order({'id': id, 'symbol': market['symbol'], 'status': 'canceled', 'trades': [], 'info': response}, market)

    def cancel_all_orders(self, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> List[Order]:
        """미체결 주문을 모두 취소한다(종목을 주면 그 종목만). 국내만 지원한다(`fetch_open_orders` 가 국내만 본다). 취소를 시도한 주문마다
        미체결 조회로 받은 주문을 항목으로 돌려준다. 취소된 항목은 `status: 'canceled'` 이고 취소 응답 원문이 `info['cancelResponse']` 에 있다.
        실패한 항목은 원래 상태(`open`)이고 `info['cancelError']`(메시지)와 `info['cancelErrorDetail']`(오류의 `detail`)이 있다.
        일부가 실패해도 던지지 않는다. 미체결 조회가 실패하면 하나도 취소하지 않고 던진다."""
        params = {} if params is None else params
        open_orders = self.fetch_open_orders(symbol, None, None, params)
        results: List[Order] = []
        for order in open_orders:
            try:
                # 목록 행의 라우팅을 넘겨 주문마다 미체결 목록을 다시 조회하지 않는다.
                sor = pick_str(order.get('info') or {}, 'sor_ordr_ccd')
                canceled = self.cancel_order(cast(str, order['id']), order.get('symbol'), {'sor_ordr_ccd': sor} if sor != '' else {})
                results.append(cast(Order, self.extend(order, {'status': 'canceled',
                                                               'info': self.extend(order.get('info'), {'cancelResponse': canceled.get('info')})})))
            except Exception as err:
                logger.warning('[kbsec] 주문 취소 실패: orderId=%s err=%s', order.get('id'), err)
                info = self.extend(order.get('info'), {'cancelError': str(err), 'cancelErrorDetail': getattr(err, 'detail', None)})
                results.append(cast(Order, self.extend(order, {'info': info})))
        return results

    # ============ 주문·체결 조회 ============

    def _is_permanent_failure(self, err: BaseException) -> bool:
        """이 인스턴스에서 다시 불러도 답이 같은 영구 실패인가. KB 가 응답으로 거절한 업무 오류(권한 없음 I446, 미신청 H049 등)만 해당한다.
        연결 끊김, 시간 초과, 5xx, 토큰 차단기, 토큰 무효(I445, 재발급으로 풀린다)는 영구 실패가 아니다."""
        return isinstance(err, ExchangeError) and not (isinstance(err, AuthenticationError) and err.detail == KBSEC_ERROR_DETAIL['TOKEN_INVALID'])

    def _collect_tr_pages(self, tr_code: str, request: Dict[str, Any], parse: Callable[[Dict[str, Any]], Any], max_pages: Optional[int] = None,
                                rows_of: Callable[[Dict[str, Any]], List[Dict[str, Any]]] = pick_array) -> Dict[str, Any]:
        """다음키(`nxt_key`)가 있는 목록 TR 을 끝까지 읽어 `{'rows', 'truncated'}` 로 돌려준다. 첫 페이지만 보면 2페이지 이후 행이 빠진다.

        - 다음키가 빈 값이면 멈춘다(KB 는 마지막 페이지에 공백을 주고, `pick_str` 가 잘라 낸다).
        - 같은 다음키가 되풀이되면 그 페이지는 버리고 `truncated` 로 표시한다. 담으면 같은 행이 두 번 들어간다.
        - 페이지 상한은 `max_pages`(기본 `options['holdingsMaxPages']`)다. 상한에 걸리면 `truncated` 로 표시한다.
        - 호출하는 쪽이 `request` 에 넣은 `nxt_key` 는 무시하고 처음부터 읽는다.
        - 행은 첫 배열에서 읽는다. 그리드가 둘 이상인 TR 은 `rows_of` 로 행 그리드를 고른다.

        조회 실패는 그대로 던진다(빈 목록으로 삼키지 않는다).
        """
        page_limit: int = self.options['holdingsMaxPages'] if max_pages is None else max_pages
        base = self.omit(request, 'nxt_key')
        rows: List[Any] = []
        next_key = ''
        truncated = False
        for page in range(page_limit):
            # 연속구분(`cn_clsf`)을 받는 TR 은 둘째 페이지부터 `1`(연속)을 보낸다.
            continued = {'cn_clsf': KBSEC_CONT_NEXT} if next_key != '' and 'cn_clsf' in base else {}
            body = self._call_tr(tr_code, self.extend(base, continued, {'nxt_key': next_key}))
            page_rows = [parse(row) for row in rows_of(body)]
            prev_key = next_key
            next_key = pick_str(body, 'nxt_key')
            if next_key != '' and next_key == prev_key:
                truncated = True
                break
            rows.extend(page_rows)
            if next_key == '':
                break
            if page == page_limit - 1:
                truncated = True
        return {'rows': rows, 'truncated': truncated}

    def _call_on_business_date(self, call: Callable[[str], Any], country: str = 'KR') -> Any:
        """조회일자를 KB 영업일로 맞춰 부른다. 주말·휴장일에는 조회 전체가 거부된다(`주문일자가 현재일자보다 큽니다`, 2854).

        주말은 `kbsec_business_date_kst` 가 되감는다. 남는 것은 표에 없는 공휴일이라, 2854 를 만나면 한 칸씩 더 되감아 다시 부른다
        (상한 `options['businessDateMaxBackoff']`). 처음 칸이 아닌 칸에서 성공하면 모르는 휴장일이라 WARN 을 남기고, 되감은 칸 수를 그날 하루 캐시한다.
        2854 가 아닌 오류는 그대로 던진다. 날짜와 무관한 실패를 날짜 탓으로 삼키지 않는다. 해외 조회(`US`)는 미국 현지 날짜로 되감는다.
        """
        today = et_ymd(self.milliseconds()) if country == 'US' else kst_ymd(self.milliseconds())
        if self._business_date_backoff[country]['day'] != today:
            self._business_date_backoff[country] = {'day': today, 'steps': 0}
        start_steps = self._business_date_backoff[country]['steps']
        last_err: Optional[BaseException] = None
        for steps in range(start_steps, self.options['businessDateMaxBackoff'] + 1):
            now = self.milliseconds()
            ordr_dt = kbsec_business_date_us_eastern(steps, now) if country == 'US' else kbsec_business_date_kst(steps, now)
            try:
                result = call(ordr_dt)
            except ExchangeError as err:
                if err.detail != KBSEC_ERROR_DETAIL['FUTURE_QUERY_DATE']:
                    raise
                last_err = err
                continue
            # 새로 되감았을 때만 WARN 을 남긴다. 캐시가 맞은 경우는 조용히 지나간다.
            if steps != start_steps:
                logger.warning('[kbsec] 조회일자를 영업일보다 더 되감아 성공 — 미등록 휴장일로 보임: ordrDt=%s steps=%s country=%s', ordr_dt, steps, country)
                self._business_date_backoff[country] = {'day': today, 'steps': steps}
            return result
        # 한 칸도 부르지 않았다. 상한을 오늘 이미 되감은 칸 수보다 작게 줬을 때다.
        if last_err is None:
            raise BadRequest(f"{self.id} 조회일자를 영업일로 맞추지 못했다: options.businessDateMaxBackoff({self.options['businessDateMaxBackoff']})가 "
                             f'오늘 되감은 칸 수({start_steps})보다 작다')
        raise last_err

    def _fetch_domestic_order_rows(self, ccls_clsf: str, market: Optional[MarketInterface], date: Str,
                                         params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """국내 주문·체결 목록(`SSQM2341`)의 행을 모든 페이지 읽는다. 날짜를 주지 않으면 가장 최근 영업일이다.
        목록이 페이지 상한(`holdingsMaxPages`)에서 잘리면 일부만 돌려주지 않고 던진다. 빠진 주문은 취소 누락이나 재주문으로 이어진다."""

        def request(ordr_dt: str) -> Dict[str, Any]:
            return self._collect_tr_pages(KBSEC_TR['TRADES_KR'], self.extend({
                'inq_clsf': KBSEC_INQ_STOCK,  # 주식
                'ccls_clsf': ccls_clsf,  # 구분 필드를 비우면 거부된다(`체결구분을 확인하십시오`, 8654)
                'ordr_dt': ordr_dt,
                'is_cd': '' if market is None else market['id'] or '',
                'cn_clsf': KBSEC_CONT_FIRST,
            }, params), lambda row: row)

        result = request(date) if date is not None else self._call_on_business_date(request)
        if result['truncated']:
            raise BadResponse(f"{self.id} 주문·체결 목록({KBSEC_TR['TRADES_KR']})이 페이지 상한(holdingsMaxPages)에서 잘렸다. 일부만 돌려주지 않는다")
        return result['rows']

    def _orders_from_rows(self, rows: List[Dict[str, Any]], market: Optional[MarketInterface], limit: Int) -> List[Order]:
        """주문·체결 목록 행을 주문 단위로 묶는다. 이 TR 은 한 행이 한 체결이고, 분할체결의 둘째 체결부터는 주문번호를 지운 연속 행으로 온다.
        헤더 행이 주문 하나를 열고 뒤따르는 연속 행의 체결을 그 주문에 더한다. 헤더 없이 온 연속 행은 귀속할 곳이 없어 버린다."""
        groups: List[Dict[str, Any]] = []
        for row in rows:
            fill = parse_kbsec_domestic_fill_row(row)
            if not fill['continuation']:
                groups.append({'header': row, 'filled': fill['filledQty'], 'cost': fill['cost']})
            elif groups:
                groups[-1]['filled'] += fill['filledQty']
                groups[-1]['cost'] += fill['cost']
        orders = [self._parse_order_group(group['header'], group['filled'], group['cost'], market) for group in groups]
        matched = orders if market is None else [order for order in orders if order['symbol'] == market['symbol']]
        return matched if limit is None else matched[:limit]

    def fetch_open_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                                params: Optional[Dict[str, Any]] = None) -> List[Order]:
        """국내 미체결 주문. 계좌별주문체결조회(`SSQM2341`)에서 체결구분 `미체결` 로 뽑는다. 이 TR 은 미체결이 0건이면 플래그 `B` 와 1861 로 주는데,
        그것은 빈 결과로 받는다. 해외 미체결은 지원하지 않는다. 모든 페이지를 읽고 분할체결 행을 주문 단위로 묶는다.

        `since` 는 적용하지 않는다. 미체결 행에는 주문 날짜가 없어 `timestamp` 를 채울 수 없고, 기본 필터는 `timestamp` 가 없는 항목을 전부 버린다.
        미체결은 빠지면 위험한 목록이라 시각을 모르는 항목을 거르지 않고 전부 돌려준다. `symbol` 과 `limit` 은 그대로 적용한다.
        """
        params = {} if params is None else params
        market = None if symbol is None else self.market(symbol)
        if market is not None and self._is_us(market):
            raise NotSupported(f'{self.id} fetchOpenOrders() 는 국내 종목만 지원한다')
        rows = self._fetch_domestic_order_rows(KBSEC_CCLS_PENDING, market, None, params)
        return self._orders_from_rows(rows, market, limit)

    def fetch_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                           params: Optional[Dict[str, Any]] = None) -> List[Order]:
        """국내 전체 주문(체결+미체결+취소). 계좌별주문체결조회(`SSQM2341`)에서 체결구분 전체로 뽑아 주문 단위로 묶는다. 해외는 지원하지 않는다.

        `since` 는 적용하지 않는다. 이 TR 행으로는 `timestamp` 를 채우지 않아서 `since` 를 그대로 넘기면 기본 필터가 전부 버린다(`fetch_open_orders` 와 같은 이유).
        `params['date']`(`YYYYMMDD`)를 주면 그 영업일을 조회한다.
        """
        params = {} if params is None else params
        market = None if symbol is None else self.market(symbol)
        if market is not None and self._is_us(market):
            raise NotSupported(f'{self.id} fetchOrders() 는 국내 종목만 지원한다')
        rows = self._fetch_domestic_order_rows(KBSEC_CCLS_ALL, market, self.safe_string(params, 'date'), self.omit(params, 'date'))
        return self._orders_from_rows(rows, market, limit)

    def fetch_closed_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                                  params: Optional[Dict[str, Any]] = None) -> List[Order]:
        """국내 종료 주문(전량 체결, 취소). 전체 주문(`fetch_orders`)에서 `open` 이 아닌 주문만 돌려준다. 체결 내역 자체(행 단위 단가·수량)는
        `fetch_my_trades` 로 본다. 해외는 지원하지 않는다. `since` 를 적용하지 않는 이유는 `fetch_orders` 와 같다."""
        orders = self.fetch_orders(symbol, None, None, params)
        closed = [order for order in orders if order['status'] != 'open']
        return closed if limit is None else closed[:limit]

    def fetch_canceled_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                                    params: Optional[Dict[str, Any]] = None) -> List[Order]:
        """국내 취소 주문. 전체 주문(`fetch_orders`)에서 `canceled` 인 주문만 돌려준다. 남은 수량 없이 덜 체결된 주문이 `canceled` 라
        일부 체결 뒤 취소한 주문도 여기에 든다. `limit` 은 거른 뒤에 적용한다. 해외는 지원하지 않는다. `since` 를 적용하지 않는 이유는 `fetch_orders` 와 같다."""
        orders = self.fetch_orders(symbol, None, None, params)
        canceled = [order for order in orders if order['status'] == 'canceled']
        return canceled if limit is None else canceled[:limit]

    def parse_order(self, order: Dict[str, Any], market: Market = None) -> Order:
        """국내 주문·체결 목록(`SSQM2341`)의 행 하나를 주문으로 옮긴다. 분할체결 연속 행을 묶은 주문은 `fetch_orders` 가 만든다."""
        fill = parse_kbsec_domestic_fill_row(order)
        return self._parse_order_group(order, fill['filledQty'], fill['cost'], market)

    def _parse_order_group(self, header: Dict[str, Any], filled: float, cost: float, market: Market) -> Order:
        """헤더 행과 그 주문의 체결 합계로 주문을 만든다. 필드 이름은 `kbsec_fill_row` 가 정본이다.
        상태는 미체결수량(`nccls_q`)으로 정한다. 남았으면 `open`, 전량 체결이면 `closed`, 남지 않았는데 덜 체결됐으면 `canceled`(전부나 일부 취소)다.
        미체결수량 필드가 없으면 취소를 가릴 수 없어 체결 수량만 본다."""
        fill = parse_kbsec_domestic_fill_row(header)
        quantity = fill['orderQty']
        knows_unfilled = 'nccls_q' in header
        remaining = fill['unfilledQty'] if knows_unfilled else max(0, quantity - filled)
        fully_filled = quantity > 0 and filled >= quantity
        status = 'closed' if fully_filled else 'open' if remaining > 0 or not knows_unfilled else 'canceled'
        # `A005930` 을 그대로 두면 심볼 필터가 맞지 않고 취소가 해외 TR 로 잘못 넘어간다. 종목코드를 정규화해 심볼로 옮긴다.
        symbol = self.market(fill['symbol'])['symbol'] if fill['symbol'] != '' else None if market is None else market['symbol']
        return self.safe_order({
            'info': header,
            'id': None if fill['orderId'] == '' else fill['orderId'],
            'symbol': symbol,
            'type': 'market' if pick_str(header, 'ordr_ccd') == KBSEC_ORDER_TYPE_KR['MARKET'] else 'limit',
            'side': fill['side'],
            'status': status,
            'price': pick_num(header, 'ordr_uprc'),
            'amount': quantity,
            'filled': filled,
            'remaining': 0 if fully_filled else remaining,
            'cost': cost,
            'average': cost / filled if filled > 0 and cost > 0 else None,
            'trades': [],
        }, market)

    def fetch_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Order:
        """주문 한 건. 국내는 체결내역과 같은 날의 전체 주문 목록(`SSQM2341` 체결구분 0)에서 주문을 찾아 `fetch_orders` 와 같은 규칙으로
        상태를 정한다. 미체결수량이 남았으면 `open`, 전량 체결이면 `closed`, 남지 않았는데 덜 체결됐으면 `canceled` 다. 체결수량과 금액은 체결내역의 합이다.
        미국은 체결내역과 해외 체결현황(`SPQM2204`, 최근 사흘)을 함께 보고 잔량으로 상태를 정한다. 어디에도 없을 때만 `OrderNotFound` 다.

        `params['date']`(`YYYYMMDD`)를 주면 그날의 체결내역을 조회하고 실패를 던진다(국내는 한국 날짜, 미국은 미국 현지 날짜). 국내는 주문 목록도 그날을 조회한다.
        생략하면 가장 최근 영업일이다. 지난 날짜의 목록에 그날 끝까지 남은 미체결수량이 오는지는 실계좌로 확인하지 못했다. 온다면 그 주문은 `open` 이다.
        """
        params = {} if params is None else params
        if symbol is None:
            raise ArgumentsRequired(f'{self.id} fetchOrder() requires a symbol argument')
        market = self.market(symbol)
        trades = [trade for trade in self.fetch_my_trades(symbol, None, None, params) if trade['order'] == id]

        # 체결 행의 수량과 금액은 문자열로 더한다. 부동소수로 더하면 잡음이 남는다.
        def total(values: List[Any]) -> float:
            acc = '0'
            for value in values:
                acc = Precise.string_add(acc, self.number_to_string(0 if value is None else value))
            return fn.js_number(acc)

        filled = total([trade['amount'] for trade in trades])
        cost = total([trade['cost'] for trade in trades])
        trade_info = [trade['info'] for trade in trades]
        if self._is_us(market):
            return self._overseas_order_of(id, market, trades, filled, cost)
        # 주문 목록도 체결내역과 같은 날을 조회한다. 다른 날의 목록에서 같은 주문번호를 찾으면 다른 주문을 합친다.
        rows = self._fetch_domestic_order_rows(KBSEC_CCLS_ALL, market, self.safe_string(params, 'date'))
        order = next((row for row in self._orders_from_rows(rows, market, None) if row['id'] == id), None)
        if order is None and len(trades) == 0:
            raise OrderNotFound(f'{self.id} fetchOrder() {symbol} 주문 {id} 을 체결내역과 주문 목록에서 찾지 못했다')
        if order is None:
            return self.safe_order({
                'id': id, 'symbol': market['symbol'], 'status': 'closed', 'side': trades[0]['side'], 'filled': filled, 'cost': cost,
                'average': cost / filled if filled > 0 else None, 'trades': [], 'info': {'trades': trade_info},
            }, market)
        # 상태와 잔량은 목록의 헤더 행(`_parse_order_group`)으로 정해 `fetch_orders` 와 같게 둔다. 체결수량과 금액은 이 주문의 체결내역 합계가 정본이다.
        return self.safe_order(self.extend(order, {
            'filled': filled, 'cost': cost, 'average': cost / filled if filled > 0 else None, 'trades': [],
        }), market)

    def _overseas_order_of(self, id: str, market: MarketInterface, trades: List[Trade], filled: float, cost: float) -> Order:
        """미국 주문 한 건. 체결내역에 없어도 해외 체결현황에 있으면 미체결이나 취소로 돌려준다. 둘 다 없을 때만 `OrderNotFound` 다."""
        lookback_ms = 3 * 24 * 60 * 60 * 1000
        rows = (self.fetch_overseas_order_status(self.milliseconds() - lookback_ms))['rows']
        status = next((row for row in rows if row['id'] == id), None)
        if status is None and len(trades) == 0:
            raise OrderNotFound(f"{self.id} fetchOrder() {market['symbol']} 주문 {id} 을 체결내역과 해외 체결현황에서 찾지 못했다")
        trade_info = [trade['info'] for trade in trades]
        if status is None:
            return self.safe_order({
                'id': id, 'symbol': market['symbol'], 'status': 'closed', 'side': trades[0]['side'], 'filled': filled, 'cost': cost,
                'average': cost / filled if filled > 0 else None, 'trades': [], 'info': {'trades': trade_info},
            }, market)
        # 체결내역이 비었으면(조회 날짜가 다른 경우) 체결현황의 체결수량과 체결가를 쓴다.
        total_filled = filled if trades else status['filledQuantity']
        total_cost = cost if trades else status['filledQuantity'] * status['filledPrice']
        amount = status['quantity']
        remaining = status['remainingQuantity']
        order_status = ('open' if remaining > 0
                        else 'closed' if amount > 0 and total_filled >= amount
                        else 'rejected' if status['rejectReason'] != '' else 'canceled')
        return self.safe_order({
            'id': id, 'symbol': market['symbol'], 'status': order_status, 'side': (trades[0]['side'] if trades else None) or status['side'],
            'amount': amount, 'filled': total_filled, 'remaining': remaining, 'price': status['price'] if status['price'] > 0 else None,
            'cost': total_cost, 'average': total_cost / total_filled if total_filled > 0 and total_cost > 0 else None,
            'trades': [], 'info': {'status': status['info'], 'trades': trade_info},
        }, market)

    def fetch_overseas_order_status(self, since: Int = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """해외 체결현황(`SPQM2204`). 해외 주문번호별주문내역(`SPQM1818`)과 같은 주문 목록에 단축종목코드를 더 준다. 결과는 `{'rows', 'truncated'}` 다.

        시작과 종료 주문일자가 필수 입력이라 `since` 가 없으면 던진다. 날짜는 미국 현지 일자이고, 끝은 `params['until']`, 없으면 오늘이다.
        체결구분, 매매구분, 거래구분은 설명된 전체(`0`, `99`, `0`)를 보낸다. 해외거래소구분, ISO코드, 원화통합증거금신청여부,
        다이렉트인덱싱여부는 설명이 없어 비워 보낸다. 미체결만 보려면 `params['ccls_clsf']` 를 `2` 로 준다. 연속조회는 끝까지 따라가고,
        상한(`holdingsMaxPages`)에 걸리면 `truncated` 로 알린다. 방향(`side`)은 기타매매구분코드(`etc_trd_ccd`)의 `01` 매도, `02` 매수로 채운다.
        """
        params = {} if params is None else params
        if since is None:
            raise ArgumentsRequired(f'{self.id} fetchOverseasOrderStatus() 는 since 인자가 필요하다(시작 주문일자가 필수 입력이다)')
        until = self.safe_integer(params, 'until')
        date_from = et_ymd(since)
        date_to = et_ymd(self.milliseconds() if until is None else until)

        def parse(row: Dict[str, Any]) -> Dict[str, Any]:
            return {
                'date': pick_str(row, 'ordr_dt'),
                'time': pick_str(row, 'ordr_tm'),
                'id': pick_str(row, 'ordr_no'),
                'originalId': pick_str(row, 'orgn_ordr_no'),
                'standardCode': pick_str(row, 'stnd_is_cd'),
                'shortCode': pick_str(row, 'shrt_is_cd'),
                'side': KBSEC_OVERSEAS_ORDER_SIDE.get(pick_str(row, 'etc_trd_ccd')),
                'name': pick_str(row, 'shrt_is_nm'),
                'statusName': pick_str(row, 'ordr_st_nm'),
                'orderTypeName': pick_str(row, 'ordr_clsf_nm'),
                'currency': pick_str(row, 'crncy_cd'),
                'quantity': pick_num(row, 'frgn_ordr_q_p6'),
                'price': pick_num(row, 'frgn_ordr_prc_p6'),
                'filledQuantity': pick_num(row, 'ccls_q_p6'),
                'filledPrice': pick_num(row, 'frgn_ccls_prc_p6'),
                'remainingQuantity': pick_num(row, 'nccls_q_p6'),
                'rejectReason': pick_str(row, 'rfsl_rsn'),
                'info': row,
            }

        result = self._collect_tr_pages(KBSEC_TR['ORDER_STATUS_US'], self.extend({
            'strt_ordr_dt': date_from, 'end_ordr_dt': date_to, 'ccls_clsf': '0', 'frgn_krx_ccd': '', 'trd_clsf': '99', 'stnd_is_cd': '', 'iso_cd': '',
            'krw_unty_mgn_rqst_f': '', 'dl_clsf': '0', 'drid_f': '',
        }, self.omit(params, 'until')), parse)
        if result['truncated']:
            logger.warning('[kbsec] 해외 체결현황 연속조회가 잘렸다 — 기간을 좁혀 다시 불러야 한다: rows=%s from=%s to=%s', len(result['rows']), date_from, date_to)
        return result

    def fetch_my_trades(self, symbol: Str = None, since: Int = None, limit: Int = None,
                              params: Optional[Dict[str, Any]] = None) -> List[Trade]:
        """체결내역. 계좌 체결내역을 종목 단위로 준다(`symbol` 이 필요하다). 국내는 `SSQM2341`, 해외는 `SPQM2103` 이고 모든 페이지를 읽는다.

        조회일자는 세 가지다. `params['date']`(`YYYYMMDD`)를 주면 그날만 조회한다. `since` 를 주면 그 날짜부터 오늘까지 영업일마다 조회한다(최대 31일).
        둘 다 없으면 가장 최근 영업일이다. 날짜는 국내가 한국 날짜, 미국이 미국 현지 날짜다. 체결 행에는 시각이 없어 `since` 는 날짜 단위로만 적용된다.

        분할체결은 식별자를 지운 연속 행으로 온다. 이 메서드가 그 행을 앞 헤더에 귀속시키므로 주문번호(`trade['order']`)별로 `amount` 를 더하면 체결수량이다.
        단가가 0 인 체결은 체결가를 모르므로 버린다. 체결 id 는 `주문번호#조회일자#순번` 이다(`_fill_rows_to_trades`).
        """
        params = {} if params is None else params
        if symbol is None:
            raise ArgumentsRequired(f'{self.id} fetchMyTrades() requires a symbol argument')
        market = self.market(symbol)
        country = 'US' if self._is_us(market) else 'KR'
        explicit_date = self.safe_string(params, 'date')
        dates = [explicit_date] if explicit_date is not None else None if since is None else self._trade_dates_since(since, country)
        if country == 'US':
            return self._fetch_overseas_trades(market, dates, limit)

        def request(ordr_dt: str) -> List[Dict[str, Any]]:
            return self._fetch_domestic_order_rows(KBSEC_CCLS_FILLED, market, ordr_dt)

        def dated(ordr_dt: str) -> Dict[str, Any]:
            return {'date': ordr_dt, 'rows': request(ordr_dt)}

        # 날짜를 주지 않으면 되감아 고른 영업일을 체결 id 에 넣어야 하므로, 조회한 날짜를 행과 함께 돌려받는다.
        if dates is None:
            return self._fill_rows_to_trades([self._call_on_business_date(dated)], market, limit)
        days: List[Dict[str, Any]] = []
        for date in dates:
            days.append({'date': date, 'rows': self._on_date_skipping_holiday(date, request, len(dates) > 1)})
        return self._fill_rows_to_trades(days, market, limit)

    def _trade_dates_since(self, since: int, country: str) -> List[str]:
        """`since` 의 날짜부터 오늘까지의 평일(`YYYYMMDD`). 국내는 한국 날짜, 해외는 미국 현지 날짜다. 31일을 넘으면 던진다."""

        def date_of(at: int) -> datetime.date:
            ymd = et_ymd(at) if country == 'US' else kst_ymd(at)
            return datetime.date(int(ymd[0:4]), int(ymd[4:6]), int(ymd[6:8]))

        start = date_of(since)
        end = date_of(self.milliseconds())
        if (end - start).days > 31:
            raise BadRequest(f'{self.id} fetchMyTrades() 는 since 부터 31일까지만 조회한다. 기간을 나눠 부른다')
        dates: List[str] = []
        day = start
        while day <= end:
            if day.weekday() < 5:
                dates.append(f'{day.year:04d}{day.month:02d}{day.day:02d}')
            day += datetime.timedelta(days=1)
        return dates

    def _on_date_skipping_holiday(self, date: str, call: Callable[[str], List[Dict[str, Any]]],
                                        skip_holiday: bool) -> List[Dict[str, Any]]:
        """날짜 하나를 조회한다. 여러 날을 도는 중이면 휴장일 거부(2854)는 그날만 건너뛴다. 하루만 조회하면 그대로 던진다."""
        try:
            return call(date)
        except ExchangeError as err:
            if skip_holiday and err.detail == KBSEC_ERROR_DETAIL['FUTURE_QUERY_DATE']:
                return []
            raise

    def _fetch_overseas_trades(self, market: MarketInterface, dates: Optional[List[str]], limit: Int) -> List[Trade]:
        """해외 체결내역(`SPQM2103`). 응답 필드는 공식 스펙 이름(`ccls_q_p6`·`frgn_ccls_prc_p6`·`dl_clsf_nm`)이 먼저이고 국내 이름은 폴백이다.
        체결구분은 비우면 거부되므로 명시한다. 조회일자는 미국 현지 날짜이고, 날짜를 주지 않으면 미국 날짜 기준 가장 최근 영업일이다.
        모든 페이지를 읽고, 페이지 상한에서 잘리면 던진다.

        영구 실패(`_is_permanent_failure`)면 이 인스턴스에서는 다시 부르지 않는다(반복 실패는 계정 제한 사유). 해외 체결 확정이 실패해도
        주문 자체는 접수된 상태다.
        """
        if self._overseas_fills_unavailable:
            raise ExchangeError(f'{self.id} 해외 체결 조회가 이 인스턴스에서 영구 실패해 다시 부르지 않는다')
        try:
            def request(ordr_dt: str) -> List[Dict[str, Any]]:
                result = self._collect_tr_pages(KBSEC_TR['ORDERS_US'], {
                    'ccls_clsf': KBSEC_CCLS_FILLED,  # 체결만. 비우면 거부된다
                    'ordr_dt': ordr_dt,
                    'is_cd': market['id'],
                }, lambda row: row)
                if result['truncated']:
                    raise BadResponse(f"{self.id} 해외 체결 목록({KBSEC_TR['ORDERS_US']})이 페이지 상한(holdingsMaxPages)에서 잘렸다. 일부만 돌려주지 않는다")
                return result['rows']

            def dated(ordr_dt: str) -> Dict[str, Any]:
                return {'date': ordr_dt, 'rows': request(ordr_dt)}

            # 날짜를 주지 않으면 되감아 고른 영업일을 체결 id 에 넣어야 하므로, 조회한 날짜를 행과 함께 돌려받는다.
            days: List[Dict[str, Any]] = []
            if dates is None:
                days.append(self._call_on_business_date(dated, 'US'))
            else:
                for date in dates:
                    days.append({'date': date, 'rows': self._on_date_skipping_holiday(date, request, len(dates) > 1)})
            trades = self._fill_rows_to_trades(days, market, limit)
            rows = [row for day in days for row in day['rows']]
            if rows and not trades:
                logger.warning('[kbsec] 해외 체결 행은 있으나 전부 걸러짐 — 응답 필드명 불일치: rows=%s rowKeys=%s', len(rows), list(rows[0])[:40])
            return trades
        except Exception as err:
            permanent = self._is_permanent_failure(err)
            if permanent:
                self._overseas_fills_unavailable = True
            logger.warning('[kbsec] 해외 체결 조회 실패 — 영구 실패면 이 인스턴스에서 재시도하지 않는다(반복 실패는 계정 제한 사유): '
                           'symbol=%s trCode=%s latched=%s err=%s', market['symbol'], KBSEC_TR['ORDERS_US'], permanent, err)
            raise

    def _fill_rows_to_trades(self, days: List[Dict[str, Any]], market: MarketInterface, limit: Int) -> List[Trade]:
        """체결 행을 체결 건별 `Trade` 로 옮긴다. `days` 는 조회일자(`date`, `YYYYMMDD`, 국내는 한국 날짜, 미국은 미국 현지 날짜)와 그날 받은 행(`rows`)이다.
        필드 이름은 `kbsec_fill_row` 가 정본이다.

        - 한 행이 한 체결이라 수량은 그대로 쓴다. 분할체결 연속 행은 식별자가 비어 오므로 `kbsec_resolve_fills` 로 헤더 행에 귀속시킨다.
          귀속은 조회일자 안에서만 한다. 다른 날의 연속 행을 앞날의 주문에 붙이면 그 주문의 순번이 겹친다.
        - 종목 필터는 귀속 뒤에 건다. 앞에서 걸면 다른 종목의 헤더 행이 사라지고 식별자 없는 연속 행이 엉뚱한 헤더에 붙는다.
          요청이 이미 종목 단위라 코드가 비어 온 행은 걸러 내지 않는다. 다른 종목이 분명한 행만 뺀다.
        - 단가 0 인 체결은 버린다. 수량만 있고 단가가 없으면 확정된 것처럼 보이는 추측이 만들어진다.
        - 체결 id 는 `주문번호#조회일자#순번` 이다. 순번은 그날 그 주문의 체결을 행 순서대로 센 번호라서 조회 범위(`since`, `params['date']`)가 달라도 같다.
          조회일자를 넣었으므로 KB 가 주문번호를 날마다 새로 매겨도 다른 날의 체결과 겹치지 않는다. `trade['order']` 는 주문번호 그대로다(`create_order`, `fetch_order` 의 id).
          같은 주문의 새 체결이 그 주문의 행 가운데 어디에 붙는지는 실계좌로 확인하지 못했다. 앞에 붙는다면 그날 체결이 더 생길 때 먼저 받은 체결의 순번이 밀린다.
        """
        base = market['id'] or ''
        parse = parse_kbsec_overseas_fill_row if self._is_us(market) else parse_kbsec_domestic_fill_row
        rows = [row for day in days for row in day['rows']]
        parsed_days = [(day['date'], [parse(row) for row in day['rows']]) for day in days]
        warn_if_fill_totals_inconsistent([parsed for _, day in parsed_days for parsed in day], rows, f"체결내역 {market['symbol']}")
        fill_days = [(date, [fill for fill in kbsec_resolve_fills(parsed) if base == '' or fill['symbol'] == '' or fill['symbol'] == base])
                     for date, parsed in parsed_days]
        trades: List[Trade] = []
        for date, fills in fill_days:
            counts: Dict[str, int] = {}
            for fill in fills:
                index = counts.get(fill['orderId'], 0)
                counts[fill['orderId']] = index + 1
                if not fill['price'] > 0:
                    warn_fill_without_price(rows[0] if rows else {}, market['symbol'] or '')
                    continue
                trades.append(self.parse_trade(self.extend(fill, {'date': date, 'index': index}), market))
        side_known = len([fill for _, fills in fill_days for fill in fills if fill['side'] is not None])
        warn_if_fill_side_unreadable(rows, side_known, f"체결내역 {market['symbol']}")
        # 행 순서가 체결 순서다. `parse_trades` 는 시각·id 로 다시 정렬하는데, 체결 시각을 모르는 채로 id 문자열 순서로 섞이게 둘 수 없다.
        return trades[-limit:] if limit is not None else trades

    def parse_trade(self, trade: Dict[str, Any], market: Market = None) -> Trade:
        """`kbsec_resolve_fills` 의 체결 건 하나(조회일자 `date` 와 순번 `index` 를 더한 것)를 체결로 옮긴다. id 는 `주문번호#조회일자#순번` 이고,
        순번은 그날 그 주문 안에서 센다."""
        return self.safe_trade({
            'id': f"{trade['orderId']}#{trade['date']}#{trade['index']}",
            'info': trade,
            # 체결 시각은 응답에 있으나 형식이 확정되지 않아 읽지 않는다. 지어낸 시각을 넣지 않는다.
            'timestamp': None,
            'datetime': None,
            'order': trade['orderId'],
            'symbol': None if market is None else market['symbol'],
            'type': None,
            'side': trade['side'],
            'takerOrMaker': None,
            'price': trade['price'],
            'amount': trade['qty'],
            'cost': trade['cost'],
            'fee': None,
        }, market)

    # ============ 잔고 ============

    def fetch_balance(self, params: Optional[Dict[str, Any]] = None) -> Balances:
        """통화와 보유 종목의 잔고. 현금은 통화 키(`KRW`, `USD`), 보유 종목은 `market['base']` 키(종목 코드)이며 `total` 이 수량이다. 평균 단가·평가금액·종목명은
        각 항목의 `info` 에 있다(`averagePrice`, `marketValue`, `name`, `quoteCurrency`). 미국 티커 `USD` 처럼 현금 코드와 같은 티커는 `commonStockCodes` 의
        통합 코드(`ProShares Ultra Semiconductors`)가 키다. 표에 없는 티커가 현금 키와 겹치면 한쪽을 덮어쓰지 않고 `NotSupported` 를 던진다. KB증권은
        보유와 현금을 나눠 받는 인자가 없어서, 그런 계좌는 `commonStockCodes` 에 그 티커를 더해야 잔고를 조회할 수 있다.

        예수금을 읽지 못하면 던진다. 보유를 일부만 읽었으면 던지지 않고 `info['readStatus']` 가 `PARTIAL`, 못 읽은 시장(`KR`, `US`)이
        `info['unreadMarkets']` 다. 이때 그 시장에서 목록에 없는 종목은 미보유가 아니라 미확인이다.

        - 국내(`KR`): 계좌자산평가(`SSQM2952`)가 국내 행을 주면 읽은 것이다. 실패해서 보유주식(`SSQM1801`) 경로로 내려갔는데 그 행이 전부
          걸러졌거나, 종목코드를 못 읽어 버린 행이 있거나, 연속조회가 상한에서 잘렸거나, 계좌자산평가가 실패했는데 보유주식도 비었으면 못 읽은 것이다.
          계좌자산평가가 성공했는데 국내 행이 없고 보유주식도 비었으면 두 조회가 모두 "보유 없음"이라 읽은 것으로 본다.
        - 해외(`US`): 이번 조회가 성공했고 응답 모양을 알아봤으면 보유가 0 건이어도 읽은 것이다. 종목 그리드가 왔거나(빈 행만 와도),
          예수금 그리드(`tfnd`)가 왔거나, 예전에 보유 행을 읽은 적이 있으면 알아본 것이다. 두 그리드 밖의 배열이 있거나, 종목코드나 수량을
          읽지 못한 보유 행이 있으면 못 읽은 것이다. 이름이 어긋난 종목 그리드를 "보유 없음"으로 읽지 않으려는 것이다.

        `USD` 항목은 해외 잔고평가(`SPQM2226`)의 통화별 예수금 그리드에서 온다(예수금·주문가능금액). 그 그리드를 못 읽었으면 `USD` 항목이 없다.
        없다는 것은 0 이 아니라 모른다는 뜻이다. 미국 시장은 읽었는데 달러 행을 가리지 못해 `USD` 항목이 없으면 `info['unreadCurrencies']` 에 `USD` 가 있다.
        예수금 그리드의 행이 모두 빈 행이면 외화 예수금이 없으므로 `USD` 의 `total` 은 0 이다. 원마켓 계좌는 달러 예수금 없이 원화로 미국 주식을 사므로
        이때 `free` 는 0 이 아니라 모르는 값이라 비운다. 0 으로 두면 호출하는 쪽의 잔액 검사가 원화로 살 수 있는 미국 매수를 모두 막는다.
        `readStatus` 는 보유의 완전성만 알리므로 이때도 `COMPLETE` 일 수 있다. `options['krwIntegratedMargin']` 이 켜져 있고 원화환산 외화예수금이 있으면
        그것을 환율(`options['usdKrwRate']`)로 환산한 USD 가 우선한다.

        `free` 는 지금 주문에 쓸 수 있는 양, `total` 은 정산 뒤 계좌에 남을 양, `used` 는 `total − free` 다(ccxt 정의). 모르는 값은 비운다.

        - 국내 보유: `free` 는 주문가능수량(`ordr_psbl_q`)이다. 해외 보유는 매도 가능 수량을 읽지 않아 `free` 가 비어 있다.
        - `KRW`: `free` 는 주문가능현금이다. 예수금 TR 의 어느 필드가 계좌 현금인지 확인하지 못해 `total` 과 `used` 는 비어 있다. 예수금 원문은 `balances['info']['deposit']` 에 있다.
        - `USD`: `free` 는 주문가능금액(`ordr_psbl_amt_p2`), `total` 은 예수금(`tfnd`)이다. 주문가능금액이 예수금보다 크면 `total` 과 `used` 를 비운다.
          원화를 환산한 USD(`krwIntegratedMargin`)는 달러 예수금이 아니라서 `free` 만 있다.
        """
        # 여러 TR 을 부르지만 `params` 는 기준이 되는 예수금 조회에만 합친다.
        deposit = self._call_tr(KBSEC_TR['DEPOSIT'], dict(params or {}))
        # 실측 필드: ordr_psbl_csh(주문가능현금) · ordr_std_dpstn_csh(주문기준예수금)
        krw_fields = ('ordr_psbl_csh', 'ordr_std_dpstn_csh', 'do_psbl_csh')
        # 후보 필드가 모두 없으면 0 이 아니라 모르는 것이다. 0 으로 두면 "예수금 없음"과 섞인다.
        if not any(key in deposit for key in krw_fields):
            raise BadResponse(f"{self.id} fetchBalance() 예수금 응답에 주문가능현금 필드가 없다 ({KBSEC_TR['DEPOSIT']})")
        krw = pick_num(deposit, *krw_fields)

        # 원마켓(통합증거금) 계좌는 달러 예수금이 0 이어도 원화로 미국 주식을 산다. `krwIntegratedMargin` 옵션이 켜져 있으면 원화환산 외화 예수금을
        # USD 로 환산해 라벨과 값의 축을 맞춘다. USD 라벨에 원화 값을 담지 않는다.
        one_market_usd: Optional[Dict[str, Any]] = None
        if self.is_option_enabled('krwIntegratedMargin'):
            margin = self.fetch_one_market_margin()
            if margin is not None and margin['krwEquivalentForeign'] > 0:
                usd_krw = self._usd_krw_rate()
                usd_equivalent = margin['krwEquivalentForeign'] / usd_krw if usd_krw > 0 else 0
                if usd_equivalent > 0:
                    logger.info('[kbsec] 원마켓 — 원화환산 외화예수금을 USD 로 환산해 합산: krwEquivalentForeign=%s usdKrw=%s usdEquivalent=%.2f',
                                margin['krwEquivalentForeign'], usd_krw, usd_equivalent)
                    # 이 값은 별도 달러 자금이 아니라 원화 예수금의 증거금 환산치다. `sourceCurrency` 로 자금 풀을 밝혀서 호출하는 쪽이
                    # KRW 항목과 이 항목을 같은 풀로 두 번 더하지 않게 한다.
                    one_market_usd = {'amount': usd_equivalent, 'sourceCurrency': 'KRW', 'krwEquivalent': margin['krwEquivalentForeign']}
            elif not self._one_market_notice_logged:
                # 옵션을 켰는데 USD 항목이 안 생기는 경우가 있다. 안 남기면 "켰는데 왜 그대로냐"를 로그로 확인할 방법이 없다.
                # `margin` 이 없으면 계좌가 원마켓 미신청(H049)이다. 코드로 만들 수 있는 매수여력이 아니라 사람이 할 일이다.
                self._one_market_notice_logged = True
                logger.warning('[kbsec] krwIntegratedMargin 옵션은 켜졌는데 USD 매수여력이 안 생겼다 — marginSeen=false 면 계좌가 원마켓 미신청(H049)이다. '
                               '인스턴스당 1회만 남긴다: marginSeen=%s krwEquivalentForeign=%s',
                               margin is not None, None if margin is None else margin['krwEquivalentForeign'])

        # 1순위는 계좌자산평가(`SSQM2952`)다. 실보유수량·매입평균가·평가금액을 명시적으로 주므로 추정이 없다. 실패하면 보유주식 경로로 내려간다.
        # 잔고가 조용히 0 이 되는 것이 이 클래스에서 가장 피해가 큰 실패 모드라, 검증 안 된 경로로 통째로 갈아타지 않는다.
        asset_eval = self._fetch_domestic_holdings_from_asset_eval()
        if asset_eval['status'] == 'ok':
            domestic = {'rows': asset_eval['rows'], 'read': asset_eval['complete']}
        else:
            domestic = self._fetch_domestic_holdings_from_holding_rows(asset_eval['status'] == 'failed')
        overseas = self._fetch_overseas_holdings()

        return self.parse_balance({'krw': krw, 'deposit': deposit, 'holdings': domestic['rows'] + overseas['rows'], 'domesticRead': domestic['read'],
                                   'overseas': overseas, 'oneMarketUsd': one_market_usd})

    def parse_balance(self, response: Dict[str, Any]) -> Balances:
        """`fetch_balance` 가 모은 예수금, 보유 행, 해외 조회 결과를 잔고로 옮긴다. 보유 종목 키가 현금 키와 겹치면 `NotSupported` 다."""
        overseas = response['overseas']
        unread_markets: List[str] = []
        if response.get('domesticRead') is False:
            unread_markets.append('KR')
        if not overseas['read']:
            unread_markets.append('US')
        unread_currencies: List[str] = []
        result: Dict[str, Any] = {
            'info': {
                'readStatus': 'COMPLETE' if len(unread_markets) == 0 else 'PARTIAL',
                'unreadMarkets': unread_markets,
                'unreadCurrencies': unread_currencies,
                'deposit': response['deposit'],
            },
            'timestamp': None,
            'datetime': None,
        }
        result['KRW'] = {'free': response['krw'], 'used': None, 'total': None, 'info': None}
        usd_cash = overseas['usdCash']
        one_market_usd = response.get('oneMarketUsd')
        if one_market_usd is not None:
            result['USD'] = {'free': one_market_usd['amount'], 'used': None, 'total': None, 'info': one_market_usd}
        elif usd_cash is not None:
            # 첫 그리드: `tfnd`(예수금), `ordr_psbl_amt_p2`(주문가능금액). 예수금에서 주문가능금액을 뺀 만큼을 묶인 금액으로 본다.
            deposit = self.number_to_string(pick_num(usd_cash, 'tfnd'))
            free = self.number_to_string(pick_num(usd_cash, 'ordr_psbl_amt_p2'))
            result['USD'] = {'free': free, 'used': None, 'total': None if Precise.string_gt(free, deposit) else deposit, 'info': usd_cash}
        elif overseas['noForeignCash']:
            # 예수금 그리드가 빈 행뿐이면 달러 예수금은 0 이다. 주문에 쓸 수 있는 양은 원마켓 여부에 달려 이 조회로는 모른다.
            result['USD'] = {'free': None, 'used': None, 'total': 0, 'info': None}
        # 미국 시장을 읽었는데 달러 예수금 행을 가리지 못하면 USD 항목이 없다. 0 이 아니라 모르는 것이라 따로 밝힌다.
        # 미국 시장을 못 읽었으면 `unreadMarkets` 가 이미 알린다.
        if overseas['read'] and 'USD' not in result:
            unread_currencies.append('USD')
        held: Dict[str, Any] = {}
        for holding in response['holdings']:
            held[self.common_stock_code(holding['code'])] = {
                'free': holding.get('orderableQuantity'),
                'used': None,
                'total': holding['quantity'],
                'info': {
                    'quoteCurrency': holding['quoteCurrency'],
                    'averagePrice': holding.get('averagePrice'),
                    'marketValue': holding['marketValue'],
                    'name': holding.get('name'),
                },
            }
        for code, entry in held.items():
            # 겹친 키에 대입하면 현금이 알림 없이 보유 수량으로 바뀐다.
            if result.get(code) is not None:
                raise NotSupported(f'{self.id} fetchBalance() 보유 종목 {code} 가 현금 {code} 와 키가 같아 한 잔고에 담을 수 없다. '
                                   'KB증권은 보유 종목과 현금을 나눠 받는 인자가 없다. commonStockCodes 에 그 티커의 통합 코드를 더한다')
            result[code] = entry
        return self.safe_balance(result)

    def _fetch_domestic_holdings_from_asset_eval(self) -> Dict[str, Any]:
        """국내 보유 — 계좌자산평가(`SSQM2952`). 실보유수량은 `ec_q` 다. `hld_q`(결제완료)는 판 주식을 T+2 동안 들고 있고 `ordr_psbl_q`(주문가능)는
        미체결 매도주문에 물리면 줄어서, 둘 다 단독으로는 보유량이 아니다. 매도 후 결제대기 종목은 `ec_q=0` 으로 와서 추정 없이 걸러진다.

        결과는 `{'status': 'ok', 'rows', 'complete'}` 이거나 `{'status': 'empty'}`(성공했지만 국내 행이 없음), `{'status': 'failed'}`(조회 실패)다.
        `ok` 가 아니면 호출부가 보유주식(`SSQM1801`) 경로로 떨어진다.
        """
        try:
            # A=통합시세. KRX 만 보면 NXT 체결분 현재가가 빈다.
            rows = pick_array(self._call_tr(KBSEC_TR['ASSET_EVAL'], {'excg_mktpr_ccd': 'A'}))
        except Exception as err:
            logger.warning('[kbsec] 계좌자산평가 조회 실패 — 보유주식 경로로 폴백: err=%s', err)
            return {'status': 'failed'}
        if len(rows) == 0:
            return {'status': 'empty'}

        out: List[Dict[str, Any]] = []
        domestic_rows = 0
        # 버린 보유: 종목코드 없이 수량이 있는 행, 수량 필드가 없는 국내 행. 합계 행처럼 코드와 수량이 모두 없는 행은 세지 않는다.
        dropped_holdings = 0
        for row in rows:
            code = kbsec_normalize_code(pick_str(row, 'is_cd', 'shrt_cd', 'is_no', 'stnd_is_cd'))
            if code == '':
                if pick_num(row, 'ec_q') > 0:
                    dropped_holdings += 1
                continue
            # 해외는 이 경로의 범위가 아니다. `SPQM2226` 이 담당하므로 여기서 읽으면 중복 계상된다.
            if kbsec_market_of(code) != 'KR':
                continue
            domestic_rows += 1
            if 'ec_q' not in row:
                dropped_holdings += 1
                continue
            quantity = pick_num(row, 'ec_q')
            if quantity <= 0:
                continue  # 매도 후 결제대기 등 — 실보유 0
            out.append({
                'code': code,
                'quantity': quantity,
                'orderableQuantity': kbsec_number_of(row.get('ordr_psbl_q')),
                'quoteCurrency': 'KRW',
                'averagePrice': pick_positive_num(row, 'byng_avr_prc') or None,
                # 평가금액은 KB 가 준 것을 그대로 쓴다. 종목마다 현재가를 다시 묻지 않는다.
                'marketValue': pick_positive_num(row, 'val_amt') or quantity * pick_positive_num(row, 'now_prc'),
                'name': pick_str(row, 'is_nm') or None,
            })
        if domestic_rows == 0:
            logger.warning('[kbsec] 계좌자산평가에 국내 행이 없다 — 보유주식 경로로 폴백: rows=%s rowKeys=%s', len(rows), list(rows[0])[:40])
            return {'status': 'empty'}
        if dropped_holdings > 0:
            logger.warning('[kbsec] 계좌자산평가에서 종목코드나 수량을 읽지 못한 보유 행이 있다 — 국내를 못 읽은 시장으로 표시: droppedHoldings=%s',
                           dropped_holdings)
        return {'status': 'ok', 'rows': out, 'complete': dropped_holdings == 0}

    def _fetch_domestic_holdings_from_holding_rows(self, primary_failed: bool) -> Dict[str, Any]:
        """국내 보유 — 보유주식(`SSQM1801`) 경로. 계좌자산평가가 국내 행을 주지 않았을 때만 쓴다. 결과의 `read` 는 국내 보유를 빠짐없이 읽었는가다.
        `primary_failed` 는 계좌자산평가가 실패(예외)했는가다. 그때 이 경로마저 비면 "보유 없음"이라고 말할 근거가 없다."""
        fetched = self._fetch_holding_rows()
        holding_rows: List[Dict[str, Any]] = fetched['rows']
        truncated = fetched['truncated']
        dropped = 0
        # 결제대기 매도 보정은 `gnrl_q > ordr_psbl_q` 인 행이 하나라도 있을 때만 조회한다. 그 부등호가 성립할 때에만 `max()` 가 `gnrl_q` 를
        # 채택하고, 그 값에만 아직 결제되지 않은 매도분이 섞일 수 있다.
        needs_settlement_adjust = any(pick_num(row, 'gnrl_q') > pick_num(row, 'ordr_psbl_q') for row in holding_rows)
        sold_pending = self._fetch_pending_sold_qty() if needs_settlement_adjust else None

        out: List[Dict[str, Any]] = []
        for row in holding_rows:
            # `A` 접두를 벗기지 않으면 해외 종목으로 오판해 원화 평가액이 달러로 읽힌다. 조회계 TR 은 종목코드를 `shrt_cd` 로 주는 전례가 있어
            # 1순위로 둔다.
            code = kbsec_normalize_code(pick_str(row, 'shrt_cd', 'is_cd', 'is_no', 'stnd_is_cd'))
            quantity = self._adjust_for_pending_sale(code, row, sold_pending)
            if code == '' or quantity <= 0:
                # 행이 조용히 사라지면 호출하는 쪽에서 "외부에서 팔렸다"와 구분되지 않는다(목록에 없음 = 보유 0). 버릴 때는 흔적을 남긴다.
                logger.warning('[kbsec] 보유 행을 버렸다 — 종목코드 없음 또는 수량 0: code=%s keys=%s', code or None, list(row)[:12])
                if code == '':
                    dropped += 1
                continue
            average_price = pick_num(row, 'pchs_avg_prc', 'avg_prc') or None
            out.append({
                'code': code,
                'quantity': quantity,
                'orderableQuantity': kbsec_number_of(row.get('ordr_psbl_q')),
                'quoteCurrency': 'KRW' if kbsec_market_of(code) == 'KR' else 'USD',
                'averagePrice': average_price,
                # 수량을 평가금액 자리에 넣으면 보유가 통째로 사라진다. 평가금액은 수량 × 현재가다.
                'marketValue': self._evaluate_holding(code, quantity, average_price),
                # KB 가 종목명을 직접 준다(`is_nm`). 표시하는 쪽이 마스터를 역조회할 필요가 없다.
                'name': pick_str(row, 'is_nm') or None,
            })
        self._log_holding_fields_once(holding_rows[0] if holding_rows else None)
        # 행은 왔는데 전부 걸러진 경우 — 필드명 불일치가 원인일 가능성이 높다. 값이 아니라 키만 남긴다.
        all_filtered = len(holding_rows) > 0 and len(out) == 0
        if all_filtered:
            logger.warning('[kbsec] 보유주식 행은 있으나 전부 걸러짐 — 종목코드/수량 필드명 불일치: rows=%s rowKeys=%s',
                           len(holding_rows), list(holding_rows[0])[:40])
        read = not truncated and dropped == 0 and not all_filtered and not (primary_failed and len(holding_rows) == 0)
        if not read:
            logger.warning('[kbsec] 국내 보유를 다 읽지 못했다 — readStatus PARTIAL, unreadMarkets 에 KR: primaryFailed=%s rows=%s kept=%s dropped=%s '
                           'truncated=%s', primary_failed, len(holding_rows), len(out), dropped, truncated)
        return {'rows': out, 'read': read}

    def _fetch_overseas_holdings(self) -> Dict[str, Any]:
        """해외 보유 종목과 USD 예수금 — `SPQM2226`(잔고평가조회). 결과는 `{'rows', 'usdCash', 'noForeignCash', 'read'}` 다.
        `noForeignCash` 는 통화별 예수금 그리드가 왔고 그 행이 모두 빈 행이며 알아보지 못한 배열이 없다는 뜻(외화 예수금 없음)이고,
        `read` 는 이번 조회가 성공했고 응답 모양을 알아봤는가다.

        이 TR 은 배열이 둘이다. 통화별 예수금이 앞에 오고 종목별 보유가 뒤에 오므로 첫 배열을 집으면 보유가 0 건이 된다. 종목코드가 있는 배열을
        명시적으로 고른다. 수량(`frgn_hld_q_p6`)과 현재가(`now_prc_p4`)가 한 행에 있어 수량 × 현재가가 외화 평가금액이다(`krw_val_amt` 는
        원화 환산이라 `quoteCurrency: 'USD'` 와 단위가 어긋나서 쓰지 않는다).

        권한이 없거나 업무 오류면 그 뒤로 부르지 않는다. 국내 잔고는 그대로 반환하므로 이 실패가 잔고 조회 전체를 실패시키지 않는다.
        """
        unread: Dict[str, Any] = {'rows': [], 'usdCash': None, 'noForeignCash': False, 'read': False}
        if self._overseas_holdings_unavailable:
            return unread
        # 일시 오류 직후에는 호출 빈도를 제한한다. 이 구간의 빈 결과는 "보유 없음"이 아니라 "안 물어봤다"이며, `read: False` 가 그 사실을 전한다.
        if self.milliseconds() < self._overseas_holdings_retry_at:
            return unread
        try:
            body = self._call_tr(KBSEC_TR['HOLDINGS_US'], {
                'std_crncy_f': KBSEC_STD_CURRENCY_FOREIGN,
                'exch_r_aplc_f': KBSEC_EXCH_RATE_MARKET,
                'fee_clsf': KBSEC_FEE_EXCLUDED,
                'srt_clsf': '1',
                'cn_f': '',
                'nxt_key': '',
            })
            grid = pick_holding_grid(body)
            rows: List[Dict[str, Any]] = grid['rows']
            seen = grid['seen']
            cash_rows = pick_cash_grid(body)
            usd_cash = next((row for row in cash_rows if is_usd_cash_row(row)), None)
            empty_rows = len([row for row in cash_rows if is_empty_cash_row(row)])
            # 빈 행만 왔으면 가릴 달러 행이 없는 것이다. 외화 예수금이 없는 계좌는 조회할 때마다 이 모양이라 경고하지 않는다.
            no_foreign_cash = len(cash_rows) > 0 and empty_rows == len(cash_rows)
            if len(cash_rows) > 0 and usd_cash is None and not no_foreign_cash:
                # 통화구분명과 행별 기준환율(공개 환율)은 금액이 아니라 남긴다. 예수금과 주문가능금액은 남기지 않고 빈 행의 수만 센다.
                # 달러 예수금이 있을 때 행 모양을 보고 `is_usd_cash_row` 를 고치려는 진단이다.
                logger.warning('[kbsec] 해외 예수금 그리드에 USD 행이 없다 — currencyNames 가 받은 통화구분명이다: trCode=%s currencyNames=%s '
                               'standardRates=%s emptyRows=%s', KBSEC_TR['HOLDINGS_US'], [row.get('crncy_clsf_nm') for row in cash_rows],
                               [row.get('std_exch_r') for row in cash_rows], empty_rows)
            out: List[Dict[str, Any]] = []
            # 버린 이유를 세어서 남긴다. "종목코드가 비었다", "수량을 못 읽었다", "수량이 0 이다"는 원인도 조치도 다르다.
            dropped_no_code = 0
            dropped_no_quantity = 0
            dropped_zero_qty = 0
            # 보유를 잃은 행의 수. 이 행이 있으면 다 읽었다고 하지 않는다.
            dropped_holdings = 0
            # 수량 후보 중 실제로 0 이 아니었던 필드 이름만 모은다. 알아야 하는 것은 보유 수량이 아니라 어느 필드가 보유수량인가다.
            non_zero_qty_fields: List[str] = []
            for row in rows:
                code = kbsec_normalize_code(pick_str(row, 'is_cd'))
                quantity = kbsec_number_of(row.get('frgn_hld_q_p6'))
                if code == '' or quantity is None or quantity <= 0:
                    if code == '':
                        dropped_no_code += 1
                    elif quantity is None:
                        dropped_no_quantity += 1
                    else:
                        dropped_zero_qty += 1
                    for key in OVERSEAS_QTY_CANDIDATES:
                        if pick_num(row, key) > 0 and key not in non_zero_qty_fields:
                            non_zero_qty_fields.append(key)
                    # 종목코드 없이 수량이 있는 행, 종목코드는 있는데 수량을 숫자로 못 읽은 행(필드 없음, 빈 값)은 보유를 잃은 것이다.
                    # 뒤의 행을 수량 0 으로 두면 수량 필드 이름이 어긋났을 때 보유가 0 건으로 읽힌다. 수량이 숫자 0 인 행은 보유 0 이다.
                    if (any(pick_num(row, key) > 0 for key in OVERSEAS_QTY_CANDIDATES) if code == '' else quantity is None):
                        dropped_holdings += 1
                    continue
                price = pick_num(row, 'now_prc_p4')
                out.append({
                    'code': code,
                    'quantity': quantity,
                    'quoteCurrency': 'USD',
                    'averagePrice': pick_num(row, 'byng_avr_prc_p4') or None,
                    'marketValue': quantity * price if price > 0 else 0,
                    'name': pick_str(row, 'is_nm') or None,
                })
            if dropped_holdings > 0 or (len(out) == 0 and dropped_zero_qty > 0):
                logger.warning('[kbsec] 해외 보유 행에서 종목코드나 수량을 읽지 못했다 — 해외를 못 읽은 시장으로 표시: rows=%s droppedNoCode=%s '
                               'droppedNoQuantity=%s droppedZeroQty=%s nonZeroQtyFields=%s arrays=%s rowKeys=%s' if dropped_holdings > 0
                               else '[kbsec] 해외 보유 행이 전부 수량 0 이다 — nonZeroQtyFields 로 수량 필드 확인: rows=%s droppedNoCode=%s '
                               'droppedNoQuantity=%s droppedZeroQty=%s nonZeroQtyFields=%s arrays=%s rowKeys=%s',
                               len(rows), dropped_no_code, dropped_no_quantity, dropped_zero_qty, non_zero_qty_fields, seen,
                               list(rows[0])[:40] if rows else [])
            if len(out) > 0:
                # 보유 행을 실제로 읽었다. 이 이력은 뒤의 응답이 종목 그리드 없이 와도 미보유로 읽게 한다.
                self._overseas_grid_seen = True
                logger.info('[kbsec] 해외 보유 조회 완료: trCode=%s holdings=%s', KBSEC_TR['HOLDINGS_US'], len(out))
            # 응답 모양을 알아봤으면 보유 0 건도 읽은 것이다. 뽑은 두 그리드 밖에 배열이 있으면 이름이 어긋난 종목 그리드일 수 있어
            # 이력이 있어도 못 읽은 것이다. `crncy_clsf_nm` 은 종목 그리드에도 있어서, 예수금 그리드는 그 그리드에만 있는 `tfnd` 로 알아본다.
            unknown = unknown_grids(body, [rows, cash_rows])
            cash_grid_read = 'tfnd' in (cash_rows[0] if cash_rows else {})
            read = dropped_holdings == 0 and len(unknown) == 0 and (len(rows) > 0 or self._overseas_grid_seen or cash_grid_read)
            if len(unknown) > 0:
                logger.warning('[kbsec] 해외 잔고 응답에 알아보지 못한 배열이 있다 — 필드명 불일치일 수 있어 해외를 못 읽은 시장으로 표시'
                               '(unknownArrays 로 확인): trCode=%s unknownArrays=%s', KBSEC_TR['HOLDINGS_US'], unknown)
            elif not read and len(rows) == 0:
                logger.warning('[kbsec] 해외 잔고 응답에 배열이 없다 — 권한/파라미터 확인: trCode=%s arrays=%s' if len(seen) == 0
                               else '[kbsec] 해외 잔고에서 종목 그리드도 예수금 그리드(tfnd)도 알아보지 못했다 — arrays 로 확인: trCode=%s arrays=%s',
                               KBSEC_TR['HOLDINGS_US'], seen)
            # 호출이 예외 없이 끝났다. 직전의 실패 상태를 푼다(자가 치유).
            self._overseas_holdings_retry_at = 0
            # 알아보지 못한 배열이 있으면 이름이 어긋난 예수금 그리드일 수 있어 외화 예수금이 없다고 하지 않는다.
            return {'rows': out, 'usdCash': usd_cash, 'noForeignCash': no_foreign_cash and len(unknown) == 0, 'read': read}
        except Exception as err:
            permanent = self._is_permanent_failure(err)
            if permanent:
                self._overseas_holdings_unavailable = True
            else:
                self._overseas_holdings_retry_at = self.milliseconds() + self.options['transientRetryCooldown']
            logger.warning('[kbsec] 해외 잔고 조회 실패(업무 오류) — 이 인스턴스에서 재시도하지 않는다(반복 실패는 계정 제한 사유): trCode=%s latched=%s err=%s'
                           if permanent else '[kbsec] 해외 잔고 조회 실패(일시 오류) — 냉각 후 재시도한다: trCode=%s latched=%s err=%s',
                           KBSEC_TR['HOLDINGS_US'], permanent, err)
            return unread

    def _log_holding_fields_once(self, row: Optional[Dict[str, Any]]) -> None:
        """보유주식 응답의 키 목록을 인스턴스당 한 번 남긴다. 값이 아니라 키만 찍는 것은 보유 종목·수량이 민감 정보이기 때문이다."""
        if self._holding_fields_logged or row is None:
            return
        self._holding_fields_logged = True
        logger.info('[kbsec] 보유주식 응답 필드 목록 — 평가금액 필드 확정용 프로브: trCode=%s rowKeys=%s', KBSEC_TR['HOLDINGS'], list(row)[:40])

    def _evaluate_holding(self, code: str, quantity: float, average_price: Optional[float] = None) -> float:
        """보유 종목의 평가금액(수량 × 현재가, `quoteCurrency` 단위). 현재가를 못 얻으면 매입평균가로 대체하고(과거 원가 기준임을 로그로 남긴다),
        그것도 없으면 0 이다. 수량을 금액 자리에 넣는 것은 틀린 값이라 값이 없다고 말하는 편이 낫다."""
        price = self._holding_price(code)
        if price > 0:
            return quantity * price
        if average_price is not None and average_price > 0:
            logger.debug('[kbsec] 현재가 미확보 — 평가금액을 매입원가로 대체: code=%s', code)
            return quantity * average_price
        logger.warning('[kbsec] 평가금액 산출 불가 — 현재가·매입평균가 모두 없음: code=%s', code)
        return 0

    def _holding_price(self, code: str) -> float:
        """평가용 현재가. 잔고 조회를 잇달아 불러도 종목마다 TR 을 다시 부르지 않도록 TTL(`options['holdingPriceTtl']`) 동안 캐시한다."""
        cached = self._holding_price_cache.get(code)
        if cached is not None and self.milliseconds() - cached['at'] < self.options['holdingPriceTtl']:
            return cached['price']
        price: float = 0
        try:
            price = (self.fetch_ticker(code))['last'] or 0
        except Exception as err:
            logger.debug('[kbsec] 평가용 현재가 조회 실패: code=%s err=%s', code, err)
        if price > 0:
            self._holding_price_cache[code] = {'price': price, 'at': self.milliseconds()}
        return price

    def _fetch_holding_rows(self) -> Dict[str, Any]:
        """보유주식(`SSQM1801`) 행을 연속조회로 끝까지 읽는다. 결과는 `{'rows', 'truncated'}` 이고, 0건이면 근거를 남긴다.

        이 TR 이 0건인 원인은 확정하지 못했다. 후보는 `inq_clsf` 값(`1=주식` 은 체결조회 TR 기준이고 이 TR 의 뜻은 미확인)과 `mkt_tm_ccd` 다.
        그래서 후보 조합을 순서대로 시도하고 무엇이 통했는지 로그로 남긴다.

        연속조회(`nxt_key`)를 끝까지 따라간다. 첫 페이지만 보면 2페이지 이후 보유가 목록에서 사라지고, 목록에서 빠진 종목은 "보유 0"이라
        호출하는 쪽이 외부 청산으로 읽는다.
        """
        attempts = [
            {'inq_clsf': KBSEC_INQ_STOCK, 'mkt_tm_ccd': KBSEC_SESSION_REGULAR},
            {'inq_clsf': KBSEC_INQ_ALL, 'mkt_tm_ccd': KBSEC_SESSION_REGULAR},
        ]
        max_pages = self.options['holdingsMaxPages']
        # 0건일 때 남길 근거로 마지막 응답을 기억한다.
        last_raw: Dict[str, Any] = {}

        def rows_of(body: Dict[str, Any]) -> List[Dict[str, Any]]:
            nonlocal last_raw
            last_raw = body
            return pick_array(body)

        for i, attempt in enumerate(attempts):
            result = self._collect_tr_pages(KBSEC_TR['HOLDINGS'], attempt, lambda row: row, max_pages, rows_of)
            rows = result['rows']
            if result['truncated']:
                # 상한에 걸려 중단했다. 조용히 자르면 그 종목들이 청산으로 읽힌다.
                logger.error('[kbsec] 보유주식 연속조회 상한 도달 — 목록이 잘렸다(청산 오판 위험): pages=%s rows=%s', max_pages, len(rows))
            if len(rows) > 0:
                if i > 0:
                    logger.warning('[kbsec] 보유주식 — 기본 조합은 0건, 대체 조합에서 조회됨 (조합 고정 필요): attempt=%s params=%s rows=%s',
                                   i, attempt, len(rows))
                return result
        logger.warning('[kbsec] 보유주식 0건 — 응답에 배열이 없거나 비어 있다(파라미터/필드명 확인 필요): attempts=%s topLevelKeys=%s',
                       len(attempts), list(last_raw)[:20])
        return {'rows': [], 'truncated': False}

    def _adjust_for_pending_sale(self, code: str, row: Dict[str, Any], sold_pending: Optional[Dict[str, float]]) -> float:
        """보유수량에서 결제대기 매도분을 뺀 값. `qty = max(ordr_psbl_q, max(gnrl_q, ordr_psbl_q) - 결제대기매도)` 다.

        `ordr_psbl_q`(매도가능)를 하한으로 두는 것이 이 식의 안전성 전부다. 브로커가 지금 팔 수 있다고 말한 수량보다 적게 보고하는 일은
        없다. 조회 창이 실제 결제 지연보다 넓어 이미 결제된 매도를 한 번 더 빼더라도 수량이 음수가 되지 않는다.

        ======================== ======== =========== ============ ====
        상황                     gnrl_q   ordr_psbl_q 결제대기매도 결과
        ======================== ======== =========== ============ ====
        미결제 매수              0        21          0            21
        전량 매도 후 결제대기    5        0           5            0
        일부 매도(8 중 3)        8        5           3            5
        대용담보/미체결 매도주문 10       0           0            10
        ======================== ======== =========== ============ ====

        마지막 행이 `max()` 를 유지해야 하는 이유다. 매도 체결이 없으면 아무것도 빼지 않는다.
        """
        raw = kbsec_holding_quantity(row)
        sold = (sold_pending or {}).get(code, 0) if code != '' else 0
        if not sold > 0:
            return raw
        sellable = pick_num(row, 'ordr_psbl_q')
        adjusted = max(sellable, raw - sold)
        if adjusted != raw:
            logger.warning('[kbsec] 결제대기 매도분 차감 — 보유수량 보정(T+2): code=%s name=%s gnrlQ=%s ordrPsblQ=%s pendingSold=%s before=%s after=%s',
                           code, pick_str(row, 'is_nm') or None, pick_num(row, 'gnrl_q'), sellable, sold, raw, adjusted)
        return adjusted

    def _fetch_pending_sold_qty(self) -> Optional[Dict[str, float]]:
        """결제대기 매도 수량(종목코드별 합계). 보유수량에서 빼기 위한 제3의 축이다.

        보유주식 TR 의 두 필드로는 뜻이 다른 두 상태가 같은 모양으로 온다. `gnrl_q>0 · ordr_psbl_q=0` 은 (1) 대용담보·미체결 매도주문이면
        보유가 있고 (2) 매도 체결 뒤 결제대기면 보유가 0 이다. 구분할 축이 이 TR 안에 없어 체결내역(`SSQM2341`)에서 가져온다.

        조회 실패는 `None` 이다. 호출부가 보정을 포기하고 종전 값을 쓴다. 과다보고(판 것을 있다고 함)는 표시 오류로 끝나지만 과소보고
        (있는 것을 없다고 함)는 외부 청산 오판과 재매수라는 실손실을 낸다. 실패는 언제나 안전한 쪽으로 처리한다.
        """
        try:
            out: Dict[str, float] = {}
            for steps in range(self.options['settlementLookbackDays']):
                ordr_dt = kbsec_business_date_kst(steps, self.milliseconds())
                try:
                    result = self._collect_tr_pages(KBSEC_TR['TRADES_KR'], {
                        'inq_clsf': KBSEC_INQ_STOCK,  # 주식
                        'ccls_clsf': KBSEC_CCLS_FILLED,  # 체결만. 비우면 거부된다(8654)
                        'ordr_dt': ordr_dt,
                        'cn_clsf': KBSEC_CONT_FIRST,
                    }, lambda row: row)
                    # 잘리면 빼야 할 매도가 덜 빠진다. 과다보고 쪽이라 보정은 계속하고 기록만 남긴다.
                    if result['truncated']:
                        logger.warning('[kbsec] 결제대기 매도 조회가 페이지 상한에서 잘렸다: ordrDt=%s rows=%s', ordr_dt, len(result['rows']))
                    rows: List[Dict[str, Any]] = result['rows']
                except ExchangeError as err:
                    # `kbsec_business_date_kst` 의 휴장일 표에 없는 휴장일에는 조회일자가 KB 영업일보다 앞서 거부된다. 그 날짜 하나만
                    # 건너뛰고 나머지 영업일은 계속 본다. 통째로 포기하면 공휴일마다 보정이 조용히 꺼진다.
                    if err.detail == KBSEC_ERROR_DETAIL['FUTURE_QUERY_DATE']:
                        logger.debug('[kbsec] 결제대기 매도 조회 — 휴장일 건너뜀: ordrDt=%s', ordr_dt)
                        continue
                    raise
                parsed = [parse_kbsec_domestic_fill_row(row) for row in rows]
                # 한 행 = 한 체결이라 그대로 더한다. 분할체결 연속 행은 식별자가 비어 오므로 먼저 헤더 행에 귀속시킨다.
                warn_if_fill_totals_inconsistent(parsed, rows, '결제대기 매도 조회')
                fills = kbsec_resolve_fills(parsed)
                for fill in fills:
                    # 귀속에 실패한 행(헤더 없이 온 연속 행)은 남의 주문에 붙이느니 빼지 않는다.
                    if fill['orderId'] == '':
                        continue
                    # 방향이 확실히 매도인 것만 뺀다. 빼는 쪽으로 틀리면 과소보고다.
                    if fill['side'] != 'sell':
                        continue
                    if fill['symbol'] == '' or not fill['qty'] > 0:
                        continue
                    out[fill['symbol']] = out.get(fill['symbol'], 0) + fill['qty']
                # 방향 판독 여부는 귀속 뒤로 센다. 연속 행은 원래 방향이 비어 오므로 원본 행으로 세면 정상 응답에도 경고가 뜬다.
                warn_if_fill_side_unreadable(rows, len([fill for fill in fills if fill['side'] is not None]), '결제대기 매도 조회')
            return out
        except Exception as err:
            logger.warning('[kbsec] 결제대기 매도 조회 실패 — 보유수량 보정 생략(종전값 사용): err=%s', err)
            return None

    def _usd_krw_rate(self) -> float:
        """1달러당 원화. `options['usdKrwRate']` 가 없으면 환율을 알 수 없어 던진다. 조회가 실패해도 던진다."""
        source = self.options.get('usdKrwRate')
        if source is None:
            raise ArgumentsRequired(f'{self.id} 원마켓 환산에는 options.usdKrwRate 가 필요하다')
        return maybe_await(source())

    def fetch_one_market_margin(self) -> Optional[Dict[str, Any]]:
        """원마켓 계좌증거금(`SPQM3390`) — 원화·원화환산 외화 예수금과 주문증거금 현황. 통합증거금 계좌의 실제 여력을 보려면 예수금 TR 만으로는 부족하다.
        결과는 `{'krwDeposit', 'krwEquivalentForeign', 'orderMarginSum', 'totalDeposit', 'withdrawable'}` 다.

        이 조회는 잔고 조회를 돕는 보조 조회라 실패해도 던지지 않고 `None` 을 돌려준다. 영구 실패(미신청 계좌 등)는 이 인스턴스에서 다시
        부르지 않는다. 잔고 조회가 종목마다 불릴 수 있어 래치가 없으면 실패가 종목 수만큼 곱해지고, 미신청 계좌는 다시 물어도 답이 같다.
        """
        if self._one_market_unavailable or self.milliseconds() < self._one_market_retry_at:
            return None
        try:
            body = self._call_tr(KBSEC_TR['ONEMARKET_MARGIN'], {})
            return {
                'krwDeposit': pick_num(body, 'krw_tfnd'),
                'krwEquivalentForeign': pick_num(body, 'krw_exch_fcrncy_tfnd'),
                'orderMarginSum': pick_num(body, 'ordr_mgn_sum'),
                'totalDeposit': pick_num(body, 'tfnd_tl_amt'),
                'withdrawable': pick_num(body, 'do_psbl_amt'),
            }
        except Exception as err:
            permanent = self._is_permanent_failure(err)
            if permanent:
                self._one_market_unavailable = True
            else:
                self._one_market_retry_at = self.milliseconds() + self.options['transientRetryCooldown']
            logger.warning('[kbsec] 원마켓 증거금 조회 실패 — 영구 실패면 이 인스턴스에서 재시도하지 않는다(반복 실패는 계정 제한 사유): latched=%s err=%s',
                           permanent, err)
            return None

    # 생성자가 붙이는 camelCase 별칭을 타입 검사기에 알린다. 빠지거나 남는 줄은 test_base.py 가 잡는다.
    if TYPE_CHECKING:
        handleErrors = handle_errors
        priceToPrecision = price_to_precision
        fetchInvestorTrading = fetch_investor_trading
        fetchTicker = fetch_ticker
        parseTicker = parse_ticker
        fetchOrderBook = fetch_order_book
        fetchOHLCV = fetch_ohlcv
        parseOHLCV = parse_ohlcv
        fetchTrades = fetch_trades
        fetchTradingFee = fetch_trading_fee
        fetchMarketCalendar = fetch_market_calendar
        refreshMarketCalendar = refresh_market_calendar
        fetchOpenOrders = fetch_open_orders
        fetchOrders = fetch_orders
        fetchClosedOrders = fetch_closed_orders
        fetchCanceledOrders = fetch_canceled_orders
        parseOrder = parse_order
        fetchOrder = fetch_order
        fetchOverseasOrderStatus = fetch_overseas_order_status
        fetchMyTrades = fetch_my_trades
        parseTrade = parse_trade
        fetchBalance = fetch_balance
        parseBalance = parse_balance
        fetchOneMarketMargin = fetch_one_market_margin
        fetchMarketableBuyPrice = fetch_marketable_buy_price
        createOrder = create_order
        createTriggerOrder = create_trigger_order
        createMarketBuyOrderWithCost = create_market_buy_order_with_cost
        editOrder = edit_order
        cancelOrder = cancel_order
        cancelAllOrders = cancel_all_orders
