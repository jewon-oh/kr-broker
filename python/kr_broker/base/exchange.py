"""증권사 클래스의 부모 클래스. ccxt Python 판의 `Exchange` 구조를 따르고, 동작은 TypeScript 판 `ts/src/base/Exchange.ts` 와 같다.

증권사 클래스(`class kis(Exchange, ImplicitAPI)`)는 다음을 채운다.

- `describe()`: 이름·URL·`has`·`exceptions`·`requiredCredentials` 같은 선언. 부모의 값 위에 `deep_extend` 로 얹는다.
- `sign()`: 요청 하나를 `{'url', 'method', 'headers', 'body'}` 로 만든다.
- `authenticate()`: 토큰 발급처럼 요청 전에 마쳐야 하는 인증 준비.
- `handle_errors()`: 증권사 응답의 오류 봉투를 오류 클래스로 던진다. 못 잡은 것은 HTTP 상태 표(`httpExceptions`)가 받는다.
- `fetch_markets()`·`parse_*()`·`fetch_balance()`·`create_order()` 같은 통합 메서드.

암묵 메서드(`private_get_...`)는 `abstract/<증권사>.py` 의 `ImplicitAPI` 가 준다. 호출하면
`request` → `fetch2`(비공개면 자격증명 확인·`authenticate`, 그다음 `throttle` → `sign` → `fetch` → `handle_rest_response` → `handle_errors`) 순으로 간다.

메서드는 snake_case 로 정의하고, 생성자가 ccxt 처럼 camelCase 별칭(`fetch_ohlcv` → `fetchOHLCV`)을 붙인다. 속성 이름은 ccxt 처럼 camelCase 다
(`apiKey`, `rateLimit`, `enableRateLimit`). 시각은 UTC 밀리초 정수, 금액과 수량은 `float` 이다.

주문 요청(`config['order']`)은 재시도하지 않고, 시간 초과나 연결 끊김이면 접수 여부를 모르므로 `OrderOutcomeUnknown` 으로 바꿔 던진다.
조회는 `OperationFailed` 계열이면서 `retryable is not False` 인 오류만 `maxRetriesOnFailure` 번까지 다시 보낸다.
"""

import calendar
import datetime
import inspect
import json
import logging
import re
import time
import types
import urllib.parse
from collections.abc import Mapping
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests

from kr_broker.base import functions as fn
from kr_broker.base.decimal_to_precision import (
    DECIMAL_PLACES, NO_PADDING, ROUND, TICK_SIZE, TRUNCATE, decimal_to_precision,
)
from kr_broker.base.errors import (
    ArgumentsRequired, AuthenticationError, BadRequest, BadResponse, BadSymbol, BaseError, DDoSProtection, ExchangeError,
    ExchangeNotAvailable, InvalidOrder, NetworkError, NotSupported, NullResponse, OperationFailed, OrderOutcomeUnknown,
    RateLimitExceeded, RequestTimeout,
)
from kr_broker.base.precise import Precise
from kr_broker.base.throttler import Throttler
from kr_broker.base.token_store import BrokerTokenStore, resolve_token_store
from kr_broker.base.types import ApiName, Int, Num, Str, Strings
from kr_broker.execution_confirm import resolve_confirm_budget

logger = logging.getLogger('kr_broker')

# verbose 로그에서 값을 가리는 헤더와 본문 필드(소문자로 비교). TS 판 `SECRET_LOG_FIELDS` 와 같다.
_SECRET_LOG_FIELDS = frozenset(['authorization', 'appkey', 'appsecret', 'secretkey', 'client_secret', 'access_token', 'approval_key',
                                'refresh_token'])
_REDACTED = '***'
_FORM_BODY = re.compile(r'[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*')


def redact_headers_for_log(headers: Optional[Dict[str, str]]) -> Optional[Dict[str, str]]:
    """로그에 남길 헤더. 비밀 헤더의 값을 가린다."""
    if headers is None:
        return None
    return {key: _REDACTED if str(key).lower() in _SECRET_LOG_FIELDS else value for key, value in dict(headers).items()}


def redact_body_for_log(body: Str) -> Str:
    """로그에 남길 본문. JSON 이나 폼 본문의 비밀 필드 값을 가린다. 읽을 수 없는 본문은 비밀이 섞여 있을 수 있어 길이만 남긴다."""
    if not body:
        return None if body is None else ''

    def redact(value: Any) -> Any:
        if isinstance(value, list):
            return [redact(v) for v in value]
        if isinstance(value, dict):
            return {k: _REDACTED if str(k).lower() in _SECRET_LOG_FIELDS else redact(v) for k, v in value.items()}
        return value

    unreadable = f'<본문 {len(body)}자, 해석하지 못해 생략>'
    trimmed = body.strip()
    if trimmed[:1] in ('{', '['):
        try:
            return json.dumps(redact(json.loads(trimmed)), ensure_ascii=False, separators=(',', ':'))
        except ValueError:
            return unreadable
    if _FORM_BODY.fullmatch(trimmed):
        pairs = [part.split('=', 1) for part in trimmed.split('&')]
        return '&'.join(f'{k}={_REDACTED}' if k.lower() in _SECRET_LOG_FIELDS else f'{k}={v}' for k, v in pairs)
    return unreadable

DEFAULT_TIMEOUT_MS = 10_000
DEFAULT_RATE_LIMIT_MS = 50
DEFAULT_CURRENCY_TICK = '1e-8'
DEFAULT_CURRENCY_DECIMALS = 8
RATIO_TO_PERCENT = '100'
# 이보다 큰 limit 은 쓰일 일이 없다. 이런 값은 옛 위치 인자 until(ms)이 limit 자리로 들어온 것이다.
LIMIT_LOOKS_LIKE_MS = 1_000_000_000
KST_OFFSET_MS = 9 * 60 * 60 * 1000


_LOOPBACK_HOSTS = frozenset(['localhost', '127.0.0.1', '::1'])


def kst_timestamp_of(ymd: Str, hms: Str = None) -> Optional[int]:
    """한국 날짜(`YYYYMMDD`)와 시각(`HHMMSS`)을 UTC 밀리초로 바꾼다. TypeScript 판 `kstTimestampOf` 와 같다.

    날짜를 못 읽거나 달력에 없는 날짜면 `None` 이다. 시각은 앞의 0 이 빠져 올 수 있어 여섯 자리로 채우고, 비었거나 숫자가 아니거나
    범위(`235959`)를 넘으면 그날 0시다.
    """
    date = re.fullmatch(r'(\d{4})(\d{2})(\d{2})', ymd or '')
    if date is None or not _is_calendar_date(int(date.group(1)), int(date.group(2)), int(date.group(3))):
        return None
    hh, mm, ss = (_kst_clock_of(hms) if hms else None) or (0, 0, 0)
    return calendar.timegm((int(date.group(1)), int(date.group(2)), int(date.group(3)), hh, mm, ss, 0, 0, 0)) * 1000 - KST_OFFSET_MS


def strict_kst_timestamp_of(ymd: Str, hms: Str = None) -> Optional[int]:
    """`kst_timestamp_of` 와 같되, 시각을 읽을 수 없으면(숫자가 아니거나 `240000` 처럼 범위를 넘으면) 그날 0시가 아니라 `None` 이다.
    시각을 읽지 못한 행을 버려야 하는 곳(봉)에 쓴다. 시각이 비었으면 그날 0시다. TypeScript 판 `strictKstTimestampOf` 와 같다."""
    if hms and _kst_clock_of(hms) is None:
        return None
    return kst_timestamp_of(ymd, hms)


def _kst_clock_of(hms: str) -> Optional[Tuple[int, int, int]]:
    """`HHMMSS` 를 시, 분, 초로 읽는다. 앞의 0 이 빠진 값(`93000`)은 여섯 자리로 채운다. 숫자가 아니거나 범위(`235959`)를 넘으면 `None` 이다."""
    clock = re.fullmatch(r'(\d{2})(\d{2})(\d{2})', hms.rjust(6, '0'))
    if clock is None:
        return None
    hh, mm, ss = int(clock.group(1)), int(clock.group(2)), int(clock.group(3))
    # `calendar.timegm` 은 범위를 넘는 시각(93분 등)을 다음 시각으로 넘기므로 읽지 못한 시각으로 본다.
    return (hh, mm, ss) if hh < 24 and mm < 60 and ss < 60 else None


def assert_secure_url(exchange_id: str, url: str, allow_insecure: bool) -> None:
    """요청 주소가 `https:` 가 아니면 보내기 전에 `BadRequest` 를 던진다. 평문으로 보내면 앱키와 시크릿, 토큰이 경로 위에 드러난다.
    루프백 주소와 `allow_insecure`(`options['allowInsecureUrl']`)만 예외다. TypeScript 판 `assertSecureUrl` 과 같다."""
    if allow_insecure:
        return
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == 'https' or (parsed.scheme == 'http' and parsed.hostname in _LOOPBACK_HOSTS):
        return
    if not parsed.scheme:
        return
    raise BadRequest(f'{exchange_id} 요청 주소가 https 가 아니다: {parsed.scheme}://{parsed.netloc}. 평문 전송은 options.allowInsecureUrl 로만 허용한다')


def _is_calendar_date(year: int, month: int, day: int) -> bool:
    """달력에 있는 날짜인가(`00000000`, 달 `13`, `0230` 같은 값을 거른다)."""
    try:
        datetime.date(year, month, day)
    except ValueError:
        return False
    return True


def _capitalize(s: str) -> str:
    return s[:1].upper() + s[1:]


class Exchange:
    # ---- 신원 ----
    id: str = 'Exchange'
    name: Str = None
    countries: List[str] = []
    version: Str = None
    hostname: Str = None

    # ---- 요청 ----
    enableRateLimit = True
    rateLimit: float = DEFAULT_RATE_LIMIT_MS
    timeout: float = DEFAULT_TIMEOUT_MS
    orderTimeout: Num = None
    verbose = False
    userAgent: Str = None
    headers: Dict[str, str] = {}
    session: Any = None
    # 동기 판이면 `True` 다. ccxt 처럼 비동기 판(`kr_broker.async_support`)은 `False` 이고 HTTP 세션을 처음 요청할 때 연다.
    synchronous = True
    # 동기 판이 환경 변수 프록시와 `~/.netrc` 를 따를지. 비동기 판의 `aiohttp_trust_env` 와 같이 기본은 따르지 않는다.
    requests_trust_env = False

    # ---- 선언 ----
    has: Dict[str, Any] = {}
    urls: Dict[str, Any] = {}
    api: Optional[Dict[str, Any]] = None
    requiredCredentials: Dict[str, bool] = {}
    options: Dict[str, Any] = {}
    exceptions: Dict[str, Any] = {}
    httpExceptions: Dict[str, Any] = {}
    commonCurrencies: Dict[str, str] = {}
    timeframes: Optional[Dict[str, str]] = None
    status: Dict[str, Any] = {}
    rateLimitBuckets: Dict[str, Dict[str, float]] = {}

    # ---- 정밀도·수수료 ----
    precisionMode = TICK_SIZE
    paddingMode = NO_PADDING
    precision: Dict[str, Any] = {}
    limits: Dict[str, Any] = {}
    fees: Dict[str, Any] = {'trading': {}, 'funding': {'withdraw': {}, 'deposit': {}}}
    reduceFees = True

    # ---- 자격증명 ----
    apiKey: Str = None
    secret: Str = None
    uid: Str = None
    login: Str = None
    password: Str = None
    twofa: Str = None
    token: Str = None
    accountId: Str = None
    privateKey: Str = None
    walletAddress: Str = None

    # ---- 종목·통화 ----
    markets: Optional[Dict[str, Any]] = None
    markets_by_id: Optional[Dict[str, List[Dict[str, Any]]]] = None
    symbols: List[str] = []
    ids: List[str] = []
    currencies: Dict[str, Any] = {}
    currencies_by_id: Optional[Dict[str, Any]] = None
    codes: List[str] = []

    # ---- 상태 ----
    isSandboxModeEnabled = False
    lastRestRequestTimestamp = 0
    last_http_response: Str = None
    last_json_response: Any = None
    last_response_headers: Optional[Dict[str, str]] = None
    last_request_url: Str = None
    last_request_method: Str = None
    last_request_headers: Optional[Dict[str, str]] = None
    last_request_body: Str = None

    # 결과 수치의 형. ccxt Python 판처럼 `float` 이다.
    number = float

    _camelcase_cache: Dict[str, str] = {}

    # ============ 순수 함수(ccxt 처럼 인스턴스에서 부른다) ============

    safe_value = staticmethod(fn.safe_value)
    safe_value_2 = staticmethod(fn.safe_value_2)
    safe_value_n = staticmethod(fn.safe_value_n)
    safe_string = staticmethod(fn.safe_string)
    safe_string_2 = staticmethod(fn.safe_string_2)
    safe_string_n = staticmethod(fn.safe_string_n)
    safe_string_lower = staticmethod(fn.safe_string_lower)
    safe_string_upper = staticmethod(fn.safe_string_upper)
    safe_float = staticmethod(fn.safe_float)
    safe_float_2 = staticmethod(fn.safe_float_2)
    safe_integer = staticmethod(fn.safe_integer)
    safe_integer_2 = staticmethod(fn.safe_integer_2)
    safe_integer_n = staticmethod(fn.safe_integer_n)
    safe_integer_product = staticmethod(fn.safe_integer_product)
    safe_timestamp = staticmethod(fn.safe_timestamp)
    safe_timestamp_2 = staticmethod(fn.safe_timestamp_2)
    safe_number = staticmethod(fn.safe_number)
    safe_number_2 = staticmethod(fn.safe_number_2)
    safe_number_n = staticmethod(fn.safe_number_n)
    safe_bool = staticmethod(fn.safe_bool)
    safe_bool_2 = staticmethod(fn.safe_bool_2)
    safe_dict = staticmethod(fn.safe_dict)
    safe_dict_2 = staticmethod(fn.safe_dict_2)
    safe_list = staticmethod(fn.safe_list)
    safe_list_2 = staticmethod(fn.safe_list_2)
    parse_number = staticmethod(fn.parse_number)
    number_to_string = staticmethod(fn.number_to_string)
    omit_zero = staticmethod(fn.omit_zero)
    precision_from_string = staticmethod(fn.precision_from_string)
    iso8601 = staticmethod(fn.iso8601)
    parse8601 = staticmethod(fn.parse8601)
    parse_timeframe = staticmethod(fn.parse_timeframe)
    extend = staticmethod(fn.extend)
    deep_extend = staticmethod(fn.deep_extend)
    clone = staticmethod(fn.clone)
    omit = staticmethod(fn.omit)
    keysort = staticmethod(fn.keysort)
    to_array = staticmethod(fn.to_array)
    index_by = staticmethod(fn.index_by)
    group_by = staticmethod(fn.group_by)
    filter_by = staticmethod(fn.filter_by)
    sort_by = staticmethod(fn.sort_by)
    sort_by_2 = staticmethod(fn.sort_by_2)
    unique = staticmethod(fn.unique)
    flatten = staticmethod(fn.flatten)
    is_empty = staticmethod(fn.is_empty)
    extract_params = staticmethod(fn.extract_params)
    implode_params = staticmethod(fn.implode_params)
    urlencode = staticmethod(fn.urlencode)
    json = staticmethod(fn.json_stringify)

    @staticmethod
    def milliseconds() -> int:
        # 부를 때마다 `fn.milliseconds` 를 찾는다. 테스트가 바꿔 끼운 시계를 따르게 하려는 것이다.
        return fn.milliseconds()

    @staticmethod
    def seconds() -> int:
        return fn.seconds()

    @staticmethod
    def sleep(milliseconds: float) -> None:
        time.sleep(milliseconds / 1000)

    @staticmethod
    def capitalize(s: str) -> str:
        return _capitalize(s)

    # ============ 생성 ============

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        config = {} if config is None else config
        self.options = self.get_default_options()
        # 사용자가 넣은 세션은 사용자가 닫는다.
        self.own_session = not (isinstance(config, dict) and config.get('session') is not None)
        # 부모 기본값 → 증권사 선언 → 사용자 설정 순으로 얹는다. 사전은 깊게 합치고 나머지는 덮어쓴다.
        for settings in (self.describe(), config):
            for key, value in settings.items():
                current = getattr(self, key, None)
                if isinstance(value, dict):
                    setattr(self, key, fn.deep_extend(current if isinstance(current, dict) else {}, value))
                else:
                    setattr(self, key, value)
        self._throttler: Optional[Throttler] = None
        self._bucket_throttlers: Dict[str, Optional[Throttler]] = {}
        self._define_camelcase_aliases()
        if self.session is None and self.synchronous:
            self.session = self._new_requests_session()
        self.after_construct()
        if fn.safe_bool(config, 'sandbox') is True:
            self.set_sandbox_mode(True)

    def _new_requests_session(self) -> Any:
        """동기 판의 HTTP 세션. `requests_trust_env` 가 꺼져 있으면 `~/.netrc` 와 환경 변수 프록시를 따르지 않는다.
        `.netrc` 를 따르면 Basic 인증이 직접 넣은 `Authorization` 헤더를 덮는다."""
        session = requests.Session()
        session.trust_env = self.requests_trust_env
        return session

    def _define_camelcase_aliases(self) -> None:
        """snake_case 이름마다 camelCase 별칭을 붙인다. ccxt Python 판과 같은 규칙이다(`fetch_ohlcv` → `fetchOHLCV`).
        메서드는 클래스에, 그 밖의 값(정적 함수 포함)은 인스턴스에 붙인다."""
        cls = type(self)
        cache = Exchange._camelcase_cache
        for name in dir(self):
            if name[0] == '_' or name[-1] == '_' or '_' not in name:
                continue
            camelcase = cache.get(name)
            if camelcase is None:
                parts = name.split('_')
                exceptions = {'ohlcv': 'OHLCV', 'le': 'LE', 'be': 'BE', 'adl': 'ADL'}
                camelcase = parts[0] + ''.join(exceptions.get(p, _capitalize(p)) for p in parts[1:])
                cache[name] = camelcase
            attr = getattr(self, name)
            if isinstance(attr, types.MethodType):
                setattr(cls, camelcase, getattr(cls, name))
            elif not hasattr(self, camelcase) or attr is not None:
                setattr(self, camelcase, attr)

    def describe(self) -> Dict[str, Any]:
        """부모의 기본 선언. 증권사 클래스는 `deep_extend(super().describe(), {...})` 로 자기 값을 얹는다."""
        return {
            'id': self.id,
            'name': self.name,
            'countries': self.countries,
            'enableRateLimit': True,
            'rateLimit': DEFAULT_RATE_LIMIT_MS,
            'timeout': DEFAULT_TIMEOUT_MS,
            # 능력표는 이 클래스가 실제로 하는 것만 적는다. 나머지는 증권사 클래스가 True·False 로 밝힌다.
            'has': {
                'publicAPI': True,
                'privateAPI': True,
                'createLimitOrder': 'emulated',
                'createMarketOrder': 'emulated',
                'fetchMarkets': 'emulated',
                'fetchCurrencies': 'emulated',
            },
            'urls': {},
            'requiredCredentials': {
                'apiKey': True, 'secret': True, 'uid': False, 'accountId': False, 'login': False, 'password': False,
                'twofa': False, 'privateKey': False, 'walletAddress': False, 'token': False,
            },
            'markets': None,
            'currencies': {},
            'timeframes': None,
            'fees': {'trading': {}, 'funding': {'withdraw': {}, 'deposit': {}}},
            'status': {'status': 'ok'},
            'httpExceptions': {
                '422': ExchangeError, '418': DDoSProtection, '429': RateLimitExceeded, '404': ExchangeNotAvailable,
                '409': ExchangeNotAvailable, '410': ExchangeNotAvailable, '451': ExchangeNotAvailable, '500': ExchangeNotAvailable,
                '501': ExchangeNotAvailable, '502': ExchangeNotAvailable, '520': ExchangeNotAvailable, '521': ExchangeNotAvailable,
                '522': ExchangeNotAvailable, '525': ExchangeNotAvailable, '526': ExchangeNotAvailable, '400': ExchangeNotAvailable,
                '403': ExchangeNotAvailable, '405': ExchangeNotAvailable, '503': ExchangeNotAvailable, '530': ExchangeNotAvailable,
                '408': RequestTimeout, '504': RequestTimeout, '401': AuthenticationError, '407': AuthenticationError,
                '511': AuthenticationError,
            },
            'commonCurrencies': {},
            'precisionMode': TICK_SIZE,
            'paddingMode': NO_PADDING,
            'limits': {
                'leverage': {'min': None, 'max': None},
                'amount': {'min': None, 'max': None},
                'price': {'min': None, 'max': None},
                'cost': {'min': None, 'max': None},
            },
        }

    def get_default_options(self) -> Dict[str, Any]:
        """증권사별 기본 `options`. `describe()['options']` 가 이 값 위에 얹힌다."""
        return {}

    def after_construct(self) -> None:
        if self.markets is not None:
            self.set_markets(self.markets)
        self.init_rest_rate_limiter()
        if fn.safe_bool_2(self.options, 'sandbox', 'testnet', False) is True:
            self.set_sandbox_mode(True)

    # ============ 요청 ============

    def request(self, path: str, api: ApiName = 'public', method: str = 'GET', params: Optional[Dict[str, Any]] = None,
                headers: Optional[Dict[str, str]] = None, body: Str = None, config: Optional[Dict[str, Any]] = None) -> Any:
        return self.fetch2(path, api, method, {} if params is None else params, headers, body, {} if config is None else config)

    def is_private_api(self, api: ApiName) -> bool:
        """이 `api` 이름이 비공개(자격증명이 필요한) 호출인가. 이름 리스트면 그 안에 'private' 이 있는지 본다."""
        return 'private' in api if isinstance(api, (list, tuple)) else api == 'private'

    def fetch2(self, path: str, api: ApiName = 'public', method: str = 'GET', params: Optional[Dict[str, Any]] = None,
               headers: Optional[Dict[str, str]] = None, body: Str = None, config: Optional[Dict[str, Any]] = None) -> Any:
        """요청 하나를 처리한다: (비공개면) 자격증명 확인 → 재시도 루프 { `throttle` → (비공개면) `authenticate` → `sign` → `fetch` }."""
        params = {} if params is None else params
        config = {} if config is None else config
        is_order = fn.safe_bool(config, 'order', False) is True
        is_private = self.is_private_api(api)
        if is_private:
            self.check_required_credentials()
        retries, params = self.handle_option_and_params(params, path, 'maxRetriesOnFailure', 0)
        retry_delay, params = self.handle_option_and_params(params, path, 'maxRetriesOnFailureDelay', 0)
        if is_order:
            retries = 0
        timeout = self.orderTimeout if is_order and self.orderTimeout is not None else self.timeout
        attempt = 0
        while True:
            # 재시도도 간격 조절을 거치고, 인증은 그 뒤에 한다. 둘은 재시도 대상 밖이다(토큰 발급 실패를 다시 시도하지 않는다).
            if self.enableRateLimit:
                self.throttle(self.calculate_rate_limiter_cost(api, method, path, params, config), fn.safe_string(config, 'bucket'))
            if is_private:
                self.authenticate(path, api, method, params, headers, body)
            try:
                self.lastRestRequestTimestamp = fn.milliseconds()
                request = self.sign(path, api, method, params, headers, body)
                self.last_request_url = request['url']
                self.last_request_method = request['method']
                self.last_request_headers = request.get('headers')
                self.last_request_body = request.get('body')
                response = self.fetch(request['url'], request['method'], request.get('headers'), request.get('body'), timeout)
                self.check_order_response(is_order, method, path, response)
                return response
            except BaseError as e:
                error: BaseError = e
                if is_order and not isinstance(e, OrderOutcomeUnknown) and self.is_outcome_unknown(e):
                    error = OrderOutcomeUnknown(f'{self.id} {method} {path} 주문 요청이 접수됐는지 알 수 없다: {e}')
                    error.__cause__ = e
                retryable = isinstance(error, OperationFailed) and error.retryable is not False
                if not retryable or attempt >= retries:
                    if error is e:
                        raise
                    raise error from e
                attempt += 1
                self.log(f'요청 실패, 다시 시도한다({attempt}/{retries}): {error}')
                # 서버가 알려 준 대기 시간(429 `Retry-After`)이 있으면 그만큼 기다린다.
                retry_after = getattr(error, 'retry_after_ms', None)
                wait_ms = max(retry_delay, retry_after if isinstance(retry_after, (int, float)) else 0)
                if wait_ms > 0:
                    self.sleep(wait_ms)

    def is_outcome_unknown(self, error: BaseException) -> bool:
        """주문 요청이 이 오류로 끝났을 때 접수 여부를 알 수 없는가. 시간 초과, 응답 전에 연결이 끊긴 전송 오류(`NetworkError` 그 자체),
        증권사 오류 코드 없이 HTTP 상태만으로 만든 5xx 오류(`http_status_error`), 해석할 수 없는 응답(`BadResponse`)이다."""
        return (isinstance(error, RequestTimeout) or type(error) is NetworkError or isinstance(error, BadResponse)
                or getattr(error, '_http_status', 0) >= 500)

    def http_status_error(self, code: int, error_class: Any, message: str, **options: Any) -> BaseException:
        """HTTP 상태만 보고 오류를 만든다. 증권사 오류 코드로 분류하지 못한 응답에 쓰고, 주문 요청의 5xx 는 `is_outcome_unknown` 이 접수 미상으로 본다."""
        error = error_class(message, **options)
        error._http_status = code
        return error

    def check_order_response(self, is_order: bool, method: str, path: str, response: Any) -> None:
        """주문 응답이 비어 있지 않은데 JSON 이 아니면 `BadResponse` 를 던진다(접수 미상이 된다). 빈 본문은 취소 응답일 수 있어 그대로 둔다."""
        if is_order and isinstance(response, str) and response.strip() != '':
            raise BadResponse(f'{self.id} {method} {path} 주문 응답이 JSON 이 아니다: {response[:200]}')

    def authenticate(self, path: str, api: ApiName, method: str, params: Dict[str, Any], headers: Optional[Dict[str, str]],
                     body: Str) -> None:
        """비공개 호출 앞에서 부르는 훅. 토큰 발급·갱신처럼 요청 전에 마쳐야 하는 준비를 여기서 한다. 기본 구현은 아무것도 하지 않는다."""

    def sign(self, path: str, api: ApiName = 'public', method: str = 'GET', params: Optional[Dict[str, Any]] = None,
             headers: Optional[Dict[str, str]] = None, body: Str = None) -> Dict[str, Any]:
        """요청을 만든다. 기본 구현은 서명 없이 `urls['api']` 에 경로를 붙이고, GET·DELETE·HEAD 는 쿼리로, 그 밖은 JSON 본문으로 보낸다."""
        params = {} if params is None else params
        key = api[0] if isinstance(api, (list, tuple)) else api
        base = self.urls['api'].get(key) if isinstance(self.urls.get('api'), dict) else self.urls.get('api')
        if not isinstance(base, str):
            raise ExchangeError(f'{self.id} sign() 에 쓸 urls.api 가 없다: {key}')
        url = fn.implode_params(base, {'hostname': self.hostname}).rstrip('/') + '/' + fn.implode_params(path, params)
        query = fn.omit(params, fn.extract_params(path))
        if method in ('GET', 'DELETE', 'HEAD'):
            if query:
                url += '?' + fn.urlencode(query)
        elif body is None:
            body = fn.json_stringify(query)
            headers = fn.extend({'Content-Type': 'application/json'}, headers)
        return {'url': url, 'method': method, 'headers': headers, 'body': body}

    def fetch(self, url: str, method: str = 'GET', headers: Optional[Dict[str, str]] = None, body: Str = None,
              timeout_ms: Optional[float] = None) -> Any:
        """HTTP 요청을 보내고 응답을 `handle_rest_response` 로 읽는다. 시간 상한 안에 응답을 받지 못하면 `RequestTimeout`, 연결이 끊기면 `NetworkError` 이다."""
        timeout_ms = self.timeout if timeout_ms is None else timeout_ms
        request_headers = self.prepare_request_headers(headers)
        if self.verbose:
            self.log(f'{self.id} {method} {url}', {'headers': redact_headers_for_log(request_headers), 'body': redact_body_for_log(body)})
        response = self.http_request(method, url, request_headers, body, timeout_ms)
        return self.handle_rest_response(response, url, method, request_headers, body)

    def prepare_request_headers(self, headers: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        """인스턴스 공통 헤더(`headers`)와 `userAgent` 위에 요청 헤더를 얹는다."""
        request_headers = fn.extend(self.headers, headers)
        if self.userAgent is not None:
            request_headers = fn.extend({'User-Agent': self.userAgent}, request_headers)
        return request_headers

    def http_request(self, method: str, url: str, headers: Optional[Dict[str, str]] = None, body: Str = None,
                     timeout_ms: Optional[float] = None) -> Any:
        """HTTP 요청 하나를 그대로 보내고 응답(`status_code`·`reason`·`headers`·`encoding`·`content`)을 돌려준다.
        오류 봉투는 보지 않는다. 시간 초과는 `RequestTimeout`, 그 밖의 전송 실패는 `NetworkError` 로 바꿔 던진다."""
        assert_secure_url(self.id, url, self.options.get('allowInsecureUrl') is True)
        timeout_ms = self.timeout if timeout_ms is None else timeout_ms
        session = self.session if self.session is not None else self._new_requests_session()
        try:
            # 리다이렉트를 따르지 않는다. 따르면 앱키와 시크릿 헤더, 토큰 발급 본문을 다른 호스트로 다시 보낸다. 3xx 는 오류로 던진다.
            return session.request(method, url, headers=headers, data=None if body is None else body.encode('utf-8'),
                                   timeout=timeout_ms / 1000, allow_redirects=False)
        except requests.exceptions.Timeout as e:
            raise RequestTimeout(f'{self.id} {method} {url} 요청이 {int(timeout_ms)}ms 안에 끝나지 않았다') from e
        except (requests.exceptions.InvalidHeader, requests.exceptions.InvalidURL, requests.exceptions.MissingSchema,
                requests.exceptions.InvalidSchema, requests.exceptions.URLRequired) as e:
            # 보내기 전에 실패했으므로 접수 미상이 아니다.
            raise BadRequest(f'{self.id} {method} {url} 요청을 만들 수 없다: {e}') from e
        except requests.exceptions.RequestException as e:
            raise NetworkError(f'{self.id} {method} {url} 연결에 실패했다: {e}') from e

    def handle_rest_response(self, response: Any, url: str, method: str = 'GET', request_headers: Optional[Dict[str, str]] = None,
                             request_body: Str = None) -> Any:
        """응답 본문을 JSON 으로 읽고 `handle_errors` → `handle_http_status_code` 순으로 오류를 가린다."""
        response_headers = self.get_response_headers(response.headers)
        # `requests` 는 charset 없는 `text/*` 를 ISO-8859-1 로 읽는다. 한글 원문이 깨지지 않게 charset 이 있을 때만 그 값을 쓴다.
        content_type = str(fn.safe_string_2(response_headers, 'Content-Type', 'content-type') or '').lower()
        encoding = response.encoding if response.encoding and 'charset=' in content_type else 'utf-8'
        response_body = response.content.decode(encoding, errors='replace')
        parsed_body = self.parse_json(response_body)
        self.last_response_headers = response_headers
        self.last_http_response = response_body
        self.last_json_response = parsed_body
        if self.verbose:
            self.log(f'{self.id} {method} {url} -> {response.status_code}',
                     {'headers': redact_headers_for_log(response_headers), 'body': redact_body_for_log(response_body)})
        handled = self.handle_errors(response.status_code, response.reason or '', url, method, response_headers, response_body,
                                     parsed_body, request_headers, request_body)
        if handled is None:
            self.handle_http_status_code(response.status_code, response.reason or '', url, method, response_body)
        return parsed_body if parsed_body is not None else response_body

    def handle_errors(self, code: int, reason: str, url: str, method: str, headers: Dict[str, str], body: str, response: Any,
                      request_headers: Optional[Dict[str, str]], request_body: Str) -> Optional[bool]:
        """증권사 응답의 오류 봉투를 오류 클래스로 던진다. `None` 을 돌려주면 HTTP 상태 표가 이어서 본다. 기본 구현은 아무것도 하지 않는다."""
        return None

    def handle_http_status_code(self, code: int, reason: str, url: str, method: str, body: str) -> None:
        """상태 표(`httpExceptions`)의 오류를 던진다. 표에 없는 3xx(따르지 않은 리다이렉트)와 5xx 는 `ExchangeNotAvailable` 이다."""
        error_class = self.httpExceptions.get(str(code)) or (ExchangeNotAvailable if code >= 500 or 300 <= code < 400 else None)
        if error_class is not None:
            raise self.http_status_error(code, error_class, f'{self.id} {method} {url} {code} {reason} {body}')

    @staticmethod
    def parse_json(text: str) -> Any:
        trimmed = text.strip()
        if len(trimmed) < 2 or trimmed[0] not in '{[':
            return None
        try:
            return json.loads(trimmed)
        except ValueError:
            return None

    @staticmethod
    def get_response_headers(headers: Any) -> Dict[str, str]:
        def capitalize_words(key: str) -> str:
            return '-'.join(_capitalize(part) for part in key.split('-'))
        result: Dict[str, str] = {}
        if headers is None:
            return result
        for key, value in dict(headers).items():
            result[capitalize_words(str(key).lower())] = ', '.join(value) if isinstance(value, list) else str(value)
        return result

    # ---- 오류 매핑 ----

    def throw_exactly_matched_exception(self, exact: Optional[Dict[str, Any]], text: Str, message: str, **options: Any) -> None:
        if exact is None or text is None:
            return
        if text in exact:
            raise exact[text](message, **options)

    def throw_broadly_matched_exception(self, broad: Optional[Dict[str, Any]], text: Str, message: str, **options: Any) -> None:
        if broad is None:
            return
        key = self.find_broadly_matched_key(broad, text)
        if key is not None:
            raise broad[key](message, **options)

    @staticmethod
    def find_broadly_matched_key(broad: Dict[str, Any], text: Str) -> Str:
        if text is None:
            return None
        for key in broad:
            if key in text:
                return key
        return None

    # ---- 속도 제한 ----

    def calculate_rate_limiter_cost(self, api: ApiName, method: str, path: str, params: Dict[str, Any],
                                    config: Optional[Dict[str, Any]] = None) -> float:
        return fn.safe_number(config, 'cost', 1)

    def init_rest_rate_limiter(self) -> None:
        if self.rateLimit is None or self.rateLimit < 0:
            raise ExchangeError(f'{self.id}.rateLimit 이 설정되지 않았다')
        self._throttler = self._new_throttler(self.rateLimit)
        self._bucket_throttlers = {bucket: self._new_throttler(fn.safe_number(config, 'rateLimit', 0))
                                   for bucket, config in self.rateLimitBuckets.items()}

    @staticmethod
    def _new_throttler(rate_limit: float) -> Optional[Throttler]:
        # rateLimit 이 0 이면 기다릴 이유가 없으므로 조절기를 만들지 않는다.
        return Throttler(refill_rate=1 / rate_limit, capacity=1, cost=1) if rate_limit > 0 else None

    def throttle(self, cost: Num = None, bucket: Str = None) -> None:
        """요청 하나가 들어가기 전에 간격을 기다린다. `bucket` 이 있으면 그 버킷의 한도를 쓴다."""
        if bucket is not None and bucket not in self._bucket_throttlers:
            raise ExchangeError(f'{self.id} 에 없는 rateLimitBuckets 이름이다: {bucket}')
        throttler = self._throttler if bucket is None else self._bucket_throttlers[bucket]
        if throttler is not None:
            throttler.throttle(cost)

    # ============ 설정 ============

    def check_required_credentials(self, error: bool = True) -> bool:
        """필수 자격증명이 비어 있으면 `AuthenticationError`(또는 `error=False` 면 `False`)."""
        for key, required in self.requiredCredentials.items():
            value = getattr(self, key, None)
            if required is True and (value is None or value is False or value == ''):
                if error:
                    raise AuthenticationError(f'{self.id} requires "{key}" credential')
                return False
        return True

    def set_sandbox_mode(self, enabled: bool) -> None:
        """모의 환경으로 바꾼다. `urls['test']` 가 없는 증권사는 `NotSupported`. 끄면 원래 URL 로 되돌린다."""
        if enabled:
            if self.urls.get('test') is None:
                raise NotSupported(f'{self.id} 에는 모의 환경 URL 이 없다')
            self.urls['apiBackup'] = fn.clone(self.urls['api'])
            self.urls['api'] = fn.clone(self.urls['test'])
            self.isSandboxModeEnabled = True
        elif self.urls.get('apiBackup') is not None:
            self.urls['api'] = fn.clone(self.urls['apiBackup'])
            self.urls = fn.omit(self.urls, 'apiBackup')
            self.isSandboxModeEnabled = False

    def handle_option_and_params(self, params: Dict[str, Any], method_name: Str, option_name: str,
                                 default_value: Any = None) -> Tuple[Any, Dict[str, Any]]:
        """옵션 하나를 `params` → `options[method_name]` → `options` → 기본값 순으로 찾는다(`defaultXxx` 이름도 본다).
        `params` 에서 찾았으면 그 키를 뺀 `params` 를 돌려주므로 요청에 새어 들어가지 않는다."""
        default_option_name = 'default' + _capitalize(option_name)
        value = fn.safe_value_2(params, option_name, default_option_name)
        if value is not None:
            return value, fn.omit(params, [option_name, default_option_name])
        method_options = fn.safe_value(self.options, method_name)
        if method_options is not None:
            value = fn.safe_value_2(method_options, option_name, default_option_name)
        if value is None:
            value = fn.safe_value_2(self.options, option_name, default_option_name)
        if value is None:
            value = default_value
        return value, params

    def spawn(self, method: Callable[..., Any], *args: Any) -> Any:
        """`method(*args)` 를 결과를 기다리지 않는 작업으로 부른다. 동기 판은 그 자리에서 부르고, 비동기 판은 태스크로 띄운다.
        던진 오류는 로그만 남긴다. 응답 해석처럼 동기로 도는 자리에서 저장소 정리 같은 I/O 를 부를 때 쓴다."""
        try:
            return method(*args)
        except Exception:
            logger.warning('%s 백그라운드 작업 실패: %s', self.id, getattr(method, '__name__', method), exc_info=True)
            return None

    def log(self, message: str, context: Optional[Dict[str, Any]] = None) -> None:
        """`verbose` 일 때만 남기는 디버그 로그(로거 이름 `kr_broker`)."""
        if self.verbose:
            logger.debug('%s %s', message, '' if context is None else context)

    def get_token_store(self) -> Optional[BrokerTokenStore]:
        """`options['tokenStore']` 가 가리키는 토큰 저장소. 없으면 `None` 이고, 값이 함수면 부를 때마다 호출한다."""
        return resolve_token_store(self.options.get('tokenStore'))

    def is_option_enabled(self, name: str) -> bool:
        """켜고 끄는 옵션(`nxtRouting` 등)이 켜져 있는가. 불리언이거나 불리언을 돌려주는 함수를 받는다."""
        option = self.options.get(name)
        if callable(option):
            option = option()
        return option is True

    def get_confirm_budget(self, defaults: Optional[Dict[str, Any]] = None) -> Dict[str, int]:
        """접수 뒤 체결을 확정할 때 쓰는 조회 예산. `options['confirmBudget']`(사전이거나 사전을 돌려주는 함수)이 증권사가 정한 기본값
        `defaults` 를 이긴다. 범위를 벗어난 값은 무시하고 아래 층의 값을 쓴다."""
        # 주문을 보낸 뒤에 부르므로 던지지 않는다. 던지면 접수된 주문이 실패처럼 보인다.
        overrides: Any = None
        try:
            option = self.options.get('confirmBudget')
            overrides = option() if callable(option) else option
        except Exception as e:
            logger.warning('[%s] options.confirmBudget 이 던져 기본 예산을 쓴다: %s', self.id, e)
        if inspect.iscoroutine(overrides):
            overrides.close()
        return resolve_confirm_budget(defaults, overrides if isinstance(overrides, Mapping) else None)

    # ============ 종목 ============

    def load_markets(self, reload: bool = False, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """종목 목록을 받는다. 이미 받았으면 `reload` 가 아닌 한 다시 부르지 않는다(비동기 판은 진행 중인 조회도 함께 쓴다)."""
        return self._load_markets_helper(reload, params)

    def _load_markets_helper(self, reload: bool, params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not reload and self.markets is not None:
            if self.markets_by_id is None:
                return self.set_markets(self.markets)
            return self.markets
        currencies = self.fetch_currencies() if self.has.get('fetchCurrencies') is True else None
        markets = self.fetch_markets({} if params is None else params)
        return self.set_markets(markets, currencies)

    def fetch_markets(self, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        return list((self.markets or {}).values())

    def fetch_currencies(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.currencies

    def parse_market(self, market: Dict[str, Any]) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} parse_market() is not supported yet')

    def parse_markets(self, markets: Any) -> List[Dict[str, Any]]:
        return [self.parse_market(market) for market in fn.to_array(markets)]

    def set_markets(self, markets: Any, currencies: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """종목 목록을 넣고 색인(`markets`·`markets_by_id`·`symbols`·`ids`)과 통화 목록을 다시 만든다."""
        markets_by_id: Dict[str, List[Dict[str, Any]]] = {}
        values: List[Dict[str, Any]] = []
        for value in fn.sort_by(fn.to_array(markets), 'spot', True, True):
            if value.get('id') is None:
                raise ExchangeError(f'{self.id} set_markets() 종목에 id 가 없다: {value.get("symbol")}')
            defined = {k: v for k, v in value.items() if v is not None}
            market = fn.deep_extend(self.safe_market_structure(), {'precision': self.precision, 'limits': self.limits},
                                    self.fees['trading'], defined)
            markets_by_id.setdefault(value['id'], []).append(market)
            values.append(market)
        self.markets_by_id = markets_by_id
        self.markets = fn.index_by(values, 'symbol')
        self.symbols = sorted(self.markets.keys())
        self.ids = sorted(markets_by_id.keys())
        base_currencies = currencies if currencies else self._currencies_from_markets(values)
        self.currencies = fn.deep_extend(base_currencies, self.currencies)
        self.currencies_by_id = fn.index_by(self.currencies, 'id')
        self.codes = sorted(self.currencies.keys())
        return self.markets

    def _currencies_from_markets(self, markets: List[Dict[str, Any]]) -> Dict[str, Any]:
        default_precision = DEFAULT_CURRENCY_DECIMALS if self.precisionMode == DECIMAL_PLACES else float(DEFAULT_CURRENCY_TICK)

        def finer(a: float, b: float) -> bool:
            return a < b if self.precisionMode == TICK_SIZE else a > b

        result: Dict[str, Any] = {}

        def add(code: Str, currency_id: Str, precision: Num) -> None:
            if code is None:
                return
            currency = {'id': currency_id if currency_id is not None else code, 'code': code,
                        'precision': precision if precision is not None else default_precision, 'info': None}
            existing = result.get(code)
            if existing is None or finer(currency['precision'], existing['precision']):
                result[code] = currency

        for market in markets:
            precision = market.get('precision') or {}
            add(market.get('base'), market.get('baseId'), precision.get('base') if precision.get('base') is not None else precision.get('amount'))
            add(market.get('quote'), market.get('quoteId'), precision.get('quote') if precision.get('quote') is not None else precision.get('price'))
        return fn.keysort(result)

    def safe_market_structure(self, market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """빈 종목 골격. 모르는 값은 `None` 이고, 현물이면 파생 관련 플래그를 `False` 로 채운다."""
        clean: Dict[str, Any] = {
            'id': None, 'lowercaseId': None, 'symbol': None, 'base': None, 'quote': None, 'settle': None,
            'baseId': None, 'quoteId': None, 'settleId': None, 'type': None,
            'spot': None, 'margin': None, 'swap': None, 'future': None, 'option': None, 'index': None,
            'active': None, 'contract': None, 'linear': None, 'inverse': None, 'subType': None,
            'taker': None, 'maker': None, 'contractSize': None, 'expiry': None, 'expiryDatetime': None,
            'strike': None, 'optionType': None,
            'precision': {'amount': None, 'price': None, 'cost': None, 'base': None, 'quote': None},
            'limits': {
                'leverage': {'min': None, 'max': None},
                'amount': {'min': None, 'max': None},
                'price': {'min': None, 'max': None},
                'cost': {'min': None, 'max': None},
            },
            'created': None,
            'info': None,
        }
        result = fn.extend(clean, market)
        if result.get('spot') is True:
            for key in ('contract', 'swap', 'future', 'option', 'index'):
                if result.get(key) is None:
                    result[key] = False
        return result

    def market(self, symbol: Str) -> Dict[str, Any]:
        """통합 심볼(없으면 id 도)로 종목을 찾는다. 종목이 로드되지 않았으면 `ExchangeError`, 못 찾으면 `BadSymbol`."""
        if symbol is None:
            raise ArgumentsRequired(f'{self.id} market() requires a symbol argument')
        if self.markets is None:
            raise ExchangeError(f'{self.id} markets not loaded')
        if symbol in self.markets:
            return self.markets[symbol]
        by_id = (self.markets_by_id or {}).get(symbol)
        if by_id is not None:
            default_type = fn.safe_string_2(self.options, 'defaultType', 'defaultSubType', 'spot')
            for candidate in by_id:
                if candidate.get(default_type) is True:
                    return candidate
            return by_id[0]
        raise BadSymbol(f'{self.id} does not have market symbol {symbol}')

    def market_id(self, symbol: Str) -> Str:
        return self.market(symbol)['id']

    def symbol(self, symbol: Str) -> str:
        if symbol is None:
            raise ArgumentsRequired(f'{self.id} symbol() requires a symbol argument')
        return fn.safe_string(self.market(symbol), 'symbol', symbol)

    def market_symbols(self, symbols: Strings = None, allow_empty: bool = True) -> Strings:
        if not symbols:
            if not allow_empty:
                raise ArgumentsRequired(f'{self.id} empty list of symbols is not supported')
            return symbols
        return [self.symbol(symbol) for symbol in symbols]

    def safe_market(self, market_id: Str = None, market: Optional[Dict[str, Any]] = None, delimiter: Str = None,
                    market_type: Str = None) -> Dict[str, Any]:
        """응답의 종목 id 를 종목으로 바꾼다. 로드한 종목에 있으면 그것을, 없으면 `delimiter` 로 쪼개 임시 종목을 만든다."""
        if market_id is not None:
            candidates = (self.markets_by_id or {}).get(market_id)
            if candidates is not None:
                if len(candidates) == 1:
                    return candidates[0]
                kind = market_type if market_type is not None else (market or {}).get('type')
                if kind is None:
                    raise ArgumentsRequired(f'{self.id} safe_market() requires a fourth argument for {market_id} to disambiguate '
                                            'between different markets with the same market id')
                for candidate in candidates:
                    if candidate.get(kind) is True:
                        return candidate
            elif delimiter:
                parts = market_id.split(delimiter)
                result = self.safe_market_structure({'symbol': market_id, 'marketId': market_id})
                if len(parts) == 2:
                    base_id, quote_id = parts
                    base = self.safe_currency_code(base_id)
                    quote = self.safe_currency_code(quote_id)
                    result['baseId'] = base_id
                    result['quoteId'] = quote_id
                    result['base'] = base
                    result['quote'] = quote
                    if base is not None and quote is not None:
                        result['symbol'] = f'{base}/{quote}'
                return result
        if market is not None:
            return market
        return self.safe_market_structure({'symbol': market_id, 'marketId': market_id})

    def safe_symbol(self, market_id: Str = None, market: Optional[Dict[str, Any]] = None, delimiter: Str = None,
                    market_type: Str = None) -> str:
        return self.safe_market(market_id, market, delimiter, market_type)['symbol']

    def common_currency_code(self, code: str) -> str:
        return fn.safe_string(self.commonCurrencies, code, code)

    def safe_currency(self, currency_id: Str, currency: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if currency_id is None and currency is not None:
            return currency
        known = None if currency_id is None else (self.currencies_by_id or {}).get(currency_id)
        if known is not None:
            return known
        code = None if currency_id is None else self.common_currency_code(currency_id.upper())
        return {'id': currency_id, 'code': code, 'precision': None, 'info': None}

    def safe_currency_code(self, currency_id: Str, currency: Optional[Dict[str, Any]] = None) -> Str:
        return self.safe_currency(currency_id, currency)['code']

    # ============ 정밀도 ============

    def is_tick_precision(self) -> bool:
        return self.precisionMode == TICK_SIZE

    def price_to_precision(self, symbol: Str, price: Any) -> Str:
        """가격을 종목의 정밀도로 반올림한 문자열. 종목에 가격 정밀도가 없으면(가격대별 호가 단위) 손대지 않는다. 결과가 0 이면 `InvalidOrder`."""
        if price is None:
            return None
        market = self.market(symbol)
        tick = market['precision'].get('price')
        if tick is None:
            return fn.number_to_string(price)
        result = decimal_to_precision(price, ROUND, tick, self.precisionMode, self.paddingMode)
        if result == '0':
            raise InvalidOrder(f'{self.id} price of {market["symbol"]} must be greater than minimum price precision of '
                               f'{fn.number_to_string(tick)}')
        return result

    def amount_to_precision(self, symbol: Str, amount: Any) -> Str:
        """수량을 종목의 정밀도로 버림한 문자열. 정밀도가 없으면 손대지 않고, 결과가 0 이면 `InvalidOrder`."""
        if amount is None:
            return None
        market = self.market(symbol)
        step = market['precision'].get('amount')
        if step is None:
            return fn.number_to_string(amount)
        result = decimal_to_precision(amount, TRUNCATE, step, self.precisionMode, self.paddingMode)
        if result == '0':
            raise InvalidOrder(f'{self.id} amount of {market["symbol"]} must be greater than minimum amount precision of '
                               f'{fn.number_to_string(step)}')
        return result

    def cost_to_precision(self, symbol: Str, cost: Any) -> Str:
        if cost is None:
            return None
        market = self.market(symbol)
        precision = market['precision']
        step = precision.get('cost') if precision.get('cost') is not None else precision.get('price')
        if step is None:
            return fn.number_to_string(cost)
        return decimal_to_precision(cost, TRUNCATE, step, self.precisionMode, self.paddingMode)

    # ============ 응답 정리(safe*·parse*) ============

    def safe_ticker(self, ticker: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """시세 응답을 통합 구조로 정리한다. `open`·`close`·`change`·`percentage`·`average`·`vwap` 중 빠진 것은 있는 값으로 계산한다."""
        open_ = fn.omit_zero(fn.safe_string(ticker, 'open'))
        close = fn.omit_zero(fn.safe_string_2(ticker, 'close', 'last'))
        change = fn.safe_string(ticker, 'change')  # 보합이면 0 이 정상 값이라 0 을 비우지 않는다
        percentage = fn.omit_zero(fn.safe_string(ticker, 'percentage'))
        average = fn.omit_zero(fn.safe_string(ticker, 'average'))
        vwap = fn.safe_string(ticker, 'vwap')
        base_volume = fn.safe_string(ticker, 'baseVolume')
        quote_volume = fn.safe_string(ticker, 'quoteVolume')
        if vwap is None:
            vwap = Precise.string_div(fn.omit_zero(quote_volume), base_volume)
        if change is not None:
            if close is None and average is not None:
                close = Precise.string_add(average, Precise.string_div(change, '2'))
            if open_ is None and close is not None:
                open_ = Precise.string_sub(close, change)
        elif percentage is not None:
            ratio = Precise.string_add('1', Precise.string_div(percentage, RATIO_TO_PERCENT))
            if close is None and average is not None:
                open_add_close = Precise.string_mul(average, '2')
                denominator = Precise.string_add('2', Precise.string_div(percentage, RATIO_TO_PERCENT))
                calc_open = open_ if open_ is not None else Precise.string_div(open_add_close, denominator)
                close = Precise.string_mul(calc_open, ratio)
            if open_ is None and close is not None:
                open_ = Precise.string_div(close, ratio)
        if change is None:
            if close is not None and open_ is not None:
                change = Precise.string_sub(close, open_)
            elif close is not None and percentage is not None:
                change = Precise.string_mul(Precise.string_div(percentage, RATIO_TO_PERCENT), Precise.string_div(close, RATIO_TO_PERCENT))
            elif open_ is not None and percentage is not None:
                change = Precise.string_mul(open_, Precise.string_div(percentage, RATIO_TO_PERCENT))
        if open_ is not None:
            if percentage is None and change is not None:
                percentage = Precise.string_mul(Precise.string_div(change, open_), RATIO_TO_PERCENT)
            if close is None and change is not None:
                close = Precise.string_add(open_, change)
            if close is None and average is not None:
                close = Precise.string_sub(Precise.string_mul(average, '2'), open_)
            if average is None and close is not None:
                digits = 18
                if market is not None and self.is_tick_precision():
                    price_tick = fn.safe_string(market.get('precision'), 'price')
                    if price_tick is not None:
                        digits = fn.precision_from_string(price_tick)
                average = Precise.string_div(Precise.string_add(open_, close), '2', digits)
        close_parsed = fn.parse_number(fn.omit_zero(close))
        return fn.extend(ticker, {
            'bid': fn.parse_number(fn.omit_zero(fn.safe_string(ticker, 'bid'))),
            'bidVolume': fn.safe_number(ticker, 'bidVolume'),
            'ask': fn.parse_number(fn.omit_zero(fn.safe_string(ticker, 'ask'))),
            'askVolume': fn.safe_number(ticker, 'askVolume'),
            'high': fn.parse_number(fn.omit_zero(fn.safe_string(ticker, 'high'))),
            'low': fn.parse_number(fn.omit_zero(fn.safe_string(ticker, 'low'))),
            'open': fn.parse_number(fn.omit_zero(open_)),
            'close': close_parsed,
            'last': close_parsed,
            'change': fn.parse_number(change),
            'percentage': fn.parse_number(percentage),
            'average': fn.parse_number(average),
            'vwap': fn.parse_number(vwap),
            'baseVolume': fn.parse_number(base_volume),
            'quoteVolume': fn.parse_number(quote_volume),
            'previousClose': fn.safe_number(ticker, 'previousClose'),
            'indexPrice': fn.safe_number(ticker, 'indexPrice'),
            'markPrice': fn.safe_number(ticker, 'markPrice'),
        })

    def safe_trade(self, trade: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """체결 응답을 정리한다: 금액이 없으면 가격 × 수량, 수수료를 `fee`·`fees` 로 맞추고, 수치를 `float` 로 바꾼다."""
        amount = fn.safe_string(trade, 'amount')
        price = fn.safe_string(trade, 'price')
        cost = fn.safe_string(trade, 'cost')
        if cost is None:
            contract_size = fn.safe_string(market, 'contractSize')
            multiply_price = price
            if contract_size is not None:
                if fn.safe_bool(market, 'inverse', False) is True:
                    multiply_price = Precise.string_div('1', price)
                multiply_price = Precise.string_mul(multiply_price, contract_size)
            cost = Precise.string_mul(multiply_price, amount)
        fee, fees = self.parsed_fee_and_fees(trade)
        trade['fee'] = fee
        trade['fees'] = fees
        trade['amount'] = fn.parse_number(amount)
        trade['price'] = fn.parse_number(price)
        trade['cost'] = fn.parse_number(cost)
        return trade

    def safe_order(self, order: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """주문 응답을 정리한다. 있는 값에서 빠진 값을 계산해 채우고 수치를 `float` 로 바꾼다."""
        amount = fn.omit_zero(fn.safe_string(order, 'amount'))
        remaining = fn.safe_string(order, 'remaining')
        filled = fn.safe_string(order, 'filled')
        cost = fn.safe_string(order, 'cost')
        average = fn.omit_zero(fn.safe_string(order, 'average'))
        price = fn.omit_zero(fn.safe_string(order, 'price'))
        last_trade_timestamp = fn.safe_integer(order, 'lastTradeTimestamp')
        symbol = fn.safe_string(order, 'symbol')
        side = fn.safe_string(order, 'side')
        status = fn.safe_string(order, 'status')
        parse_filled = filled is None
        parse_cost = cost is None
        parse_last_trade_timestamp = last_trade_timestamp is None
        fee = fn.safe_value(order, 'fee')
        parse_fee = fee is None
        parse_fees = fn.safe_value(order, 'fees') is None
        parse_symbol = symbol is None
        parse_side = side is None
        should_parse_fees = parse_fee or parse_fees
        fees = list(fn.safe_list(order, 'fees', []))
        trades: List[Dict[str, Any]] = []
        is_trigger_order = any(fn.safe_string(order, k) is not None for k in ('triggerPrice', 'stopLossPrice', 'takeProfitPrice'))
        if parse_filled or parse_cost or should_parse_fees:
            raw_trades = fn.safe_value(order, 'trades', [])
            first_trade = fn.safe_value(raw_trades, 0)
            trades_are_parsed = isinstance(first_trade, dict) and 'info' in first_trade and 'id' in first_trade
            trades = raw_trades if trades_are_parsed else self.parse_trades(raw_trades, market)
            if isinstance(trades, list) and len(trades) > 0:
                for key, source in (('symbol', 'symbol'), ('side', 'side'), ('type', 'type'), ('id', 'order')):
                    if order.get(key) is None:
                        order[key] = trades[0].get(source)
                if parse_filled:
                    filled = '0'
                if parse_cost:
                    cost = '0'
                for trade in trades:
                    trade_amount = fn.safe_string(trade, 'amount')
                    if parse_filled and trade_amount is not None:
                        filled = Precise.string_add(filled, trade_amount)
                    trade_cost = fn.safe_string(trade, 'cost')
                    if parse_cost and trade_cost is not None:
                        cost = Precise.string_add(cost, trade_cost)
                    if parse_symbol:
                        symbol = fn.safe_string(trade, 'symbol')
                    if parse_side:
                        side = fn.safe_string(trade, 'side')
                    trade_timestamp = fn.safe_value(trade, 'timestamp')
                    if parse_last_trade_timestamp and trade_timestamp is not None:
                        last_trade_timestamp = trade_timestamp if last_trade_timestamp is None else max(last_trade_timestamp, trade_timestamp)
                    if should_parse_fees:
                        trade_fees = fn.safe_value(trade, 'fees')
                        if trade_fees is not None:
                            fees.extend(dict(f) for f in trade_fees)
                        else:
                            trade_fee = fn.safe_value(trade, 'fee')
                            if trade_fee is not None:
                                fees.append(dict(trade_fee))
        if should_parse_fees:
            reduced_fees = self.reduce_fees_by_currency(fees) if self.reduceFees else fees
            for reduced in reduced_fees:
                reduced['cost'] = fn.safe_number(reduced, 'cost')
                if 'rate' in reduced:
                    reduced['rate'] = fn.safe_number(reduced, 'rate')
            if not parse_fee and len(reduced_fees) == 0:
                fee_copy = fn.deep_extend(fee)
                fee_copy['cost'] = fn.safe_number(fee_copy, 'cost')
                if 'rate' in fee_copy:
                    fee_copy['rate'] = fn.safe_number(fee_copy, 'rate')
                reduced_fees.append(fee_copy)
            order['fees'] = reduced_fees
            if parse_fee and len(reduced_fees) == 1:
                order['fee'] = reduced_fees[0]
        if amount is None:
            if filled is not None and remaining is not None:
                amount = Precise.string_add(filled, remaining)
            elif status == 'closed':
                amount = filled
        if filled is None:
            if amount is not None and remaining is not None:
                filled = Precise.string_sub(amount, remaining)
            elif status == 'closed' and amount is not None:
                filled = amount
        if remaining is None:
            if amount is not None and filled is not None:
                remaining = Precise.string_sub(amount, filled)
            elif status == 'closed':
                remaining = '0'
        inverse = fn.safe_bool(market, 'inverse', False)
        contract_size = fn.number_to_string(fn.safe_value(market, 'contractSize', 1))
        if average is None and filled is not None and cost is not None and Precise.string_gt(filled, '0'):
            filled_times_contract_size = Precise.string_mul(filled, contract_size)
            average = Precise.string_div(filled_times_contract_size, cost) if inverse is True else Precise.string_div(cost, filled_times_contract_size)
        if parse_cost and filled is not None and (average is not None or price is not None):
            multiply_price = price if average is None else average
            filled_times_contract_size = Precise.string_mul(filled, contract_size)
            cost = Precise.string_div(filled_times_contract_size, multiply_price) if inverse is True else Precise.string_mul(filled_times_contract_size, multiply_price)
        order_type = fn.safe_value(order, 'type')
        empty_price = price is None or Precise.string_equals(price, '0')
        if empty_price and order_type == 'market':
            price = average
        for entry in trades:
            entry['amount'] = fn.safe_number(entry, 'amount')
            entry['price'] = fn.safe_number(entry, 'price')
            entry['cost'] = fn.safe_number(entry, 'cost')
            trade_fee = fn.safe_dict(entry, 'fee', {})
            trade_fee['cost'] = fn.safe_number(trade_fee, 'cost')
            if 'rate' in trade_fee:
                trade_fee['rate'] = fn.safe_number(trade_fee, 'rate')
            entry_fees = fn.safe_list(entry, 'fees', [])
            for entry_fee in entry_fees:
                entry_fee['cost'] = fn.safe_number(entry_fee, 'cost')
            entry['fees'] = entry_fees
            entry['fee'] = trade_fee
        time_in_force = fn.safe_string(order, 'timeInForce')
        post_only = fn.safe_value(order, 'postOnly')
        if time_in_force is None:
            if not is_trigger_order and fn.safe_string(order, 'type') == 'market':
                time_in_force = 'IOC'
            if post_only is True:
                time_in_force = 'PO'
        elif post_only is None:
            post_only = time_in_force == 'PO'
        timestamp = fn.safe_integer(order, 'timestamp')
        trigger_price = fn.parse_number(fn.safe_string_2(order, 'triggerPrice', 'stopPrice'))
        datetime_ = fn.safe_string(order, 'datetime')
        return fn.extend(order, {
            'id': fn.safe_string(order, 'id'),
            'clientOrderId': fn.safe_string(order, 'clientOrderId'),
            'timestamp': timestamp,
            'datetime': datetime_ if datetime_ is not None else fn.iso8601(timestamp),
            'symbol': symbol,
            'type': fn.safe_string(order, 'type'),
            'side': side,
            'lastTradeTimestamp': last_trade_timestamp,
            'lastUpdateTimestamp': fn.safe_integer(order, 'lastUpdateTimestamp'),
            'price': fn.parse_number(price),
            'amount': fn.parse_number(amount),
            'cost': fn.parse_number(cost),
            'average': fn.parse_number(average),
            'filled': fn.parse_number(filled),
            'remaining': fn.parse_number(remaining),
            'timeInForce': time_in_force,
            'postOnly': post_only,
            'trades': trades,
            'reduceOnly': fn.safe_value(order, 'reduceOnly'),
            'stopPrice': trigger_price,
            'triggerPrice': trigger_price,
            'takeProfitPrice': fn.parse_number(fn.safe_string(order, 'takeProfitPrice')),
            'stopLossPrice': fn.parse_number(fn.safe_string(order, 'stopLossPrice')),
            'status': status,
            'fee': fn.safe_value(order, 'fee'),
        })

    def safe_balance(self, balance: Dict[str, Any]) -> Dict[str, Any]:
        """코드별 `{free, used, total}` 에서 빠진 값을 채우고 같은 값을 `free`·`used`·`total`(·`debt`) 사전으로도 담는다."""
        codes = list(fn.omit(balance, ['info', 'timestamp', 'datetime', 'free', 'used', 'total', 'debt']).keys())
        balance['free'] = {}
        balance['used'] = {}
        balance['total'] = {}
        debt_balance: Dict[str, Any] = {}
        for code in codes:
            total = fn.safe_string(balance[code], 'total')
            free = fn.safe_string(balance[code], 'free')
            used = fn.safe_string(balance[code], 'used')
            debt = fn.safe_string(balance[code], 'debt')
            if total is None and free is not None and used is not None:
                total = Precise.string_add(free, used)
            if free is None and total is not None and used is not None:
                free = Precise.string_sub(total, used)
            if used is None and total is not None and free is not None:
                used = Precise.string_sub(total, free)
            balance[code]['free'] = fn.parse_number(free)
            balance[code]['used'] = fn.parse_number(used)
            balance[code]['total'] = fn.parse_number(total)
            balance['free'][code] = balance[code]['free']
            balance['used'][code] = balance[code]['used']
            balance['total'][code] = balance[code]['total']
            if debt is not None:
                balance[code]['debt'] = fn.parse_number(debt)
                debt_balance[code] = balance[code]['debt']
        if debt_balance:
            balance['debt'] = debt_balance
        return balance

    def safe_order_book(self, orderbook: Dict[str, Any]) -> Dict[str, Any]:
        """호가 응답을 정리한다: 매수는 가격 내림차순, 매도는 오름차순으로 정렬하고 `datetime` 을 채운다."""
        timestamp = fn.safe_integer(orderbook, 'timestamp')
        datetime_ = fn.safe_string(orderbook, 'datetime')
        return {
            'symbol': fn.safe_string(orderbook, 'symbol'),
            'bids': fn.sort_by(fn.safe_list(orderbook, 'bids', []), 0, True),
            'asks': fn.sort_by(fn.safe_list(orderbook, 'asks', []), 0),
            'timestamp': timestamp,
            'datetime': datetime_ if datetime_ is not None else fn.iso8601(timestamp),
            'nonce': fn.safe_integer(orderbook, 'nonce'),
        }

    def parse_order_book(self, orderbook: Any, symbol: Str, timestamp: Int = None, bids_key: str = 'bids', asks_key: str = 'asks',
                         price_key: Any = 0, amount_key: Any = 1) -> Dict[str, Any]:
        return self.safe_order_book({
            'symbol': symbol,
            'timestamp': timestamp,
            'bids': self.parse_bids_asks(fn.safe_value(orderbook, bids_key, []), price_key, amount_key),
            'asks': self.parse_bids_asks(fn.safe_value(orderbook, asks_key, []), price_key, amount_key),
        })

    def parse_bids_asks(self, bidasks: Any, price_key: Any = 0, amount_key: Any = 1) -> List[List[Num]]:
        return [[fn.safe_float(bidask, price_key), fn.safe_float(bidask, amount_key)] for bidask in fn.to_array(bidasks)]

    def reduce_fees_by_currency(self, fees: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """수수료 목록을 통화(와 요율)별로 합친다."""
        reduced: Dict[str, Dict[str, Any]] = {}
        for fee in fees:
            currency = fn.safe_string(fee, 'currency')
            if currency is None:
                continue
            rate = fn.safe_string(fee, 'rate')
            cost = fn.safe_string(fee, 'cost')
            key = currency if rate is None else f'{currency}:{rate}'
            entry = reduced.setdefault(key, {'currency': currency, 'cost': '0'} if rate is None else {'currency': currency, 'cost': '0', 'rate': rate})
            if cost is not None:
                entry['cost'] = Precise.string_add(entry['cost'], cost)
        return list(reduced.values())

    def parsed_fee_and_fees(self, container: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        fee = fn.safe_dict(container, 'fee')
        fees = fn.safe_list(container, 'fees')
        if fee is not None or fees is not None:
            if fee is not None:
                fee = self.parse_fee_numeric(fee)
            if fees is None:
                fees = [fee]
            reduced = [self.parse_fee_numeric(item) for item in (self.reduce_fees_by_currency(fees) if self.reduceFees else fees)]
            fees = reduced
            if len(reduced) == 1:
                fee = reduced[0]
            elif len(reduced) == 0:
                fee = None
        return (fee if fee is not None else {'cost': None, 'currency': None}), (fees if fees is not None else [])

    def parse_fee_numeric(self, fee: Dict[str, Any]) -> Dict[str, Any]:
        fee['cost'] = fn.safe_number(fee, 'cost')
        if 'rate' in fee:
            fee['rate'] = fn.safe_number(fee, 'rate')
        return fee

    def account(self) -> Dict[str, Num]:
        return {'free': None, 'used': None, 'total': None}

    def parse_ticker(self, ticker: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} parse_ticker() is not supported yet')

    def parse_tickers(self, tickers: Any, symbols: Strings = None) -> Dict[str, Any]:
        return self.filter_by_array_tickers([self.parse_ticker(ticker) for ticker in fn.to_array(tickers)], 'symbol', symbols)

    def parse_trade(self, trade: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} parse_trade() is not supported yet')

    def parse_trades(self, trades: Any, market: Optional[Dict[str, Any]] = None, since: Int = None, limit: Int = None,
                     params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        parsed = [fn.extend(self.parse_trade(trade, market), params) for trade in fn.to_array(trades)]
        return self.filter_by_symbol_since_limit(fn.sort_by_2(parsed, 'timestamp', 'id'), (market or {}).get('symbol'), since, limit)

    def parse_order(self, order: Dict[str, Any], market: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} parse_order() is not supported yet')

    def parse_orders(self, orders: Any, market: Optional[Dict[str, Any]] = None, since: Int = None, limit: Int = None,
                     params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        results = []
        if isinstance(orders, list):
            results = [fn.extend(self.parse_order(order, market), params) for order in orders]
        elif isinstance(orders, dict):
            results = [fn.extend(self.parse_order(fn.extend({'id': order_id}, order), market), params) for order_id, order in orders.items()]
        return self.filter_by_symbol_since_limit(fn.sort_by(results, 'timestamp'), (market or {}).get('symbol'), since, limit)

    def parse_ohlcv(self, ohlcv: Any, market: Optional[Dict[str, Any]] = None) -> List[Num]:
        raise NotSupported(f'{self.id} parse_ohlcv() is not supported yet')

    def parse_ohlcvs(self, ohlcvs: Optional[List[Any]], market: Optional[Dict[str, Any]] = None, timeframe: str = '1m',
                     since: Int = None, limit: Int = None, tail: bool = False) -> List[List[Num]]:
        if ohlcvs is None:
            return []
        parsed = fn.sort_by([self.parse_ohlcv(ohlcv, market) for ohlcv in ohlcvs], 0)
        return self.filter_by_since_limit(parsed, since, limit, 0, tail)

    def parse_balance(self, response: Any) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} parse_balance() is not supported yet')

    # ---- 자르기·거르기 ----

    def handle_until_param(self, method: str, limit: Int, params: Dict[str, Any]) -> Tuple[Int, Dict[str, Any]]:
        """ccxt 규칙대로 기간 끝(`params['until']`, ms)을 꺼내고 `params` 에서 뺀다. ms 처럼 큰 수가 `limit` 으로 오면 `BadRequest`."""
        if limit is not None and limit > LIMIT_LOOKS_LIKE_MS:
            raise BadRequest(f'{self.id} {method}() 의 기간 끝은 params["until"](ms)로 준다. 이 자리는 limit 이다: {limit}')
        return fn.safe_integer(params, 'until'), fn.omit(params, 'until')

    def limit_rows(self, rows: List[Any], since: Int, limit: Int, key: Any = 'timestamp') -> List[Any]:
        """ccxt 의미대로 `limit` 개로 자른다. `since` 가 있으면 가장 이른 것부터, 없으면 가장 최근 것부터다."""
        return self.filter_by_limit(rows, limit, key, since is not None)

    def ms_stamp(self, timestamp: Int) -> Dict[str, Any]:
        return {'timestamp': timestamp, 'datetime': None if timestamp is None else fn.iso8601(timestamp)}

    def kst_stamp(self, ymd: Str, hms: Str = None) -> Dict[str, Any]:
        """한국 날짜(`YYYYMMDD`)와 시각(`HHMMSS`)으로 `timestamp`·`datetime` 을 만든다. 날짜를 못 읽으면 둘 다 비운다."""
        timestamp = kst_timestamp_of(ymd, hms)
        return {'timestamp': None, 'datetime': None} if timestamp is None else {'timestamp': timestamp, 'datetime': fn.iso8601(timestamp)}

    def filter_by_limit(self, array: List[Any], limit: Int = None, key: Any = 'timestamp', from_start: bool = False) -> List[Any]:
        if limit is None or len(array) == 0:
            return array
        ascending = True
        first_item, last_item = array[0], array[-1]
        first = fn.safe_value(first_item, key) if isinstance(first_item, (dict, list)) else None
        last = fn.safe_value(last_item, key) if isinstance(last_item, (dict, list)) else None
        if first is not None and last is not None:
            ascending = first <= last
        take_head = from_start == ascending
        return array[:limit] if take_head else array[-limit:]

    def filter_by_since_limit(self, array: Optional[List[Any]], since: Int = None, limit: Int = None, key: Any = 'timestamp',
                              tail: bool = False) -> List[Any]:
        if array is None:
            return []
        since_is_defined = since is not None
        result = fn.to_array(array)
        if since_is_defined:
            result = [entry for entry in result if (lambda v: v is not None and v != 0 and v >= since)(fn.safe_value(entry, key))]
        if tail and limit is not None:
            return result[-limit:]
        return self.filter_by_limit(result, limit, key, not tail and since_is_defined)

    def filter_by_value_since_limit(self, array: List[Any], field: Any, value: Any = None, since: Int = None, limit: Int = None,
                                    key: Any = 'timestamp', tail: bool = False) -> List[Any]:
        value_is_defined = value is not None
        since_is_defined = since is not None
        result = fn.to_array(array)
        if value_is_defined or since_is_defined:
            def keep(entry: Any) -> bool:
                field_matches = fn.safe_value(entry, field) == value if value_is_defined else True
                stamp = fn.safe_value(entry, key)
                since_matches = (stamp is not None and stamp != 0 and stamp >= since) if since_is_defined else True
                return field_matches and since_matches
            result = [entry for entry in result if keep(entry)]
        if tail and limit is not None:
            return result[-limit:]
        return self.filter_by_limit(result, limit, key, since_is_defined)

    def filter_by_symbol_since_limit(self, array: List[Any], symbol: Str = None, since: Int = None, limit: Int = None,
                                     tail: bool = False) -> List[Any]:
        return self.filter_by_value_since_limit(array, 'symbol', symbol, since, limit, 'timestamp', tail)

    def filter_by_array_tickers(self, objects: List[Dict[str, Any]], key: Any, values: Strings = None) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for obj in objects:
            object_key = fn.safe_string(obj, key)
            if object_key is None:
                continue
            if values is None or object_key in values:
                result[object_key] = obj
        return result

    # ============ 주문 인자 검사 ============

    def check_order_arguments(self, market: Optional[Dict[str, Any]], type: str, side: str, amount: Num, price: Num,
                              params: Optional[Dict[str, Any]] = None) -> None:
        if side not in ('buy', 'sell'):
            raise InvalidOrder(f"{self.id} create_order() side must be 'buy' or 'sell'")
        if type not in ('limit', 'market'):
            raise InvalidOrder(f"{self.id} create_order() type must be 'limit' or 'market'")
        if type == 'limit' and price is None:
            raise ArgumentsRequired(f'{self.id} create_order() requires a price argument for a limit order')
        if amount is None or not amount > 0:
            raise ArgumentsRequired(f'{self.id} create_order() amount should be above 0')

    # ============ 통합 메서드(기본 구현) ============
    #
    # 증권사가 지원하는 것만 override 한다. 나머지는 NotSupported 를 던진다.

    def fetch_time(self, params: Optional[Dict[str, Any]] = None) -> Int:
        raise NotSupported(f'{self.id} fetch_time() is not supported yet')

    def fetch_status(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} fetch_status() is not supported yet')

    def fetch_ticker(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if self.has.get('fetchTickers') not in (None, False):
            self.load_markets()
            market = self.market(symbol)
            tickers = self.fetch_tickers([market['symbol']], params)
            ticker = fn.safe_dict(tickers, market['symbol'])
            if ticker is None:
                raise NullResponse(f'{self.id} fetch_tickers() could not find a ticker for {market["symbol"]}')
            return ticker
        raise NotSupported(f'{self.id} fetch_ticker() is not supported yet')

    def fetch_tickers(self, symbols: Strings = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} fetch_tickers() is not supported yet')

    def fetch_order_book(self, symbol: str, limit: Int = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} fetch_order_book() is not supported yet')

    def fetch_ohlcv(self, symbol: str, timeframe: str = '1m', since: Int = None, limit: Int = None,
                    params: Optional[Dict[str, Any]] = None) -> List[List[Num]]:
        raise NotSupported(f'{self.id} fetch_ohlcv() is not supported yet')

    def fetch_balance(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} fetch_balance() is not supported yet')

    def create_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None,
                     params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} create_order() is not supported yet')

    def create_trigger_order(self, symbol: str, type: str, side: str, amount: float, price: Num = None, trigger_price: Num = None,
                             params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} create_trigger_order() is not supported yet')

    def edit_order(self, id: str, symbol: str, type: str, side: str, amount: Num = None, price: Num = None,
                   params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} edit_order() is not supported yet')

    def create_limit_order(self, symbol: str, side: str, amount: float, price: float, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.create_order(symbol, 'limit', side, amount, price, params)

    def create_market_order(self, symbol: str, side: str, amount: float, price: Num = None,
                            params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.create_order(symbol, 'market', side, amount, price, params)

    def create_limit_buy_order(self, symbol: str, amount: float, price: float, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.create_order(symbol, 'limit', 'buy', amount, price, params)

    def create_limit_sell_order(self, symbol: str, amount: float, price: float, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.create_order(symbol, 'limit', 'sell', amount, price, params)

    def create_market_buy_order(self, symbol: str, amount: float, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.create_order(symbol, 'market', 'buy', amount, None, params)

    def create_market_sell_order(self, symbol: str, amount: float, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.create_order(symbol, 'market', 'sell', amount, None, params)

    def cancel_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} cancel_order() is not supported yet')

    def cancel_all_orders(self, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        raise NotSupported(f'{self.id} cancel_all_orders() is not supported yet')

    def fetch_order(self, id: str, symbol: Str = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} fetch_order() is not supported yet')

    def fetch_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                     params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        raise NotSupported(f'{self.id} fetch_orders() is not supported yet')

    def fetch_open_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                          params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        if self.has.get('fetchOrders') not in (None, False):
            return fn.filter_by(self.fetch_orders(symbol, since, limit, params), 'status', 'open')
        raise NotSupported(f'{self.id} fetch_open_orders() is not supported yet')

    def fetch_closed_orders(self, symbol: Str = None, since: Int = None, limit: Int = None,
                            params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        if self.has.get('fetchOrders') not in (None, False):
            return fn.filter_by(self.fetch_orders(symbol, since, limit, params), 'status', 'closed')
        raise NotSupported(f'{self.id} fetch_closed_orders() is not supported yet')

    def fetch_my_trades(self, symbol: Str = None, since: Int = None, limit: Int = None,
                        params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        raise NotSupported(f'{self.id} fetch_my_trades() is not supported yet')

    def fetch_trading_fee(self, symbol: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotSupported(f'{self.id} fetch_trading_fee() is not supported yet')

    def close(self) -> None:
        """이 인스턴스가 연 HTTP 세션을 닫는다. 사용자가 넘긴 세션은 사용자가 닫는다."""
        if self.session is not None and self.own_session:
            self.session.close()
            self.session = None

