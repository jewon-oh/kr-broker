"""`Exchange` 가 쓰는 순수 함수. TypeScript 판 `ts/src/base/functions/*.ts` 와 같은 결과를 낸다.

두 판이 같은 요청을 만들어야 하므로(요청 픽스처가 대조한다), 값을 문자열로 바꾸는 자리는 JavaScript 의 규칙을 따른다.
`js_string(0.5)` 는 `'0.5'`, `js_string(5.0)` 은 `'5'`, `js_string(True)` 는 `'true'` 이고, 쿼리는 `encodeURIComponent`,
JSON 본문은 `JSON.stringify` 와 같은 모양이다.
"""

import calendar
import datetime
import decimal
import json
import math
import re
import time
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import quote

from kr_broker.base.errors import NotSupported

# ============ 타입 판별 ============


def is_number(x: Any) -> bool:
    """유한한 숫자인가. 불리언은 숫자가 아니다(JavaScript 의 `Number.isFinite` 와 같다)."""
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def is_integer(x: Any) -> bool:
    return is_number(x) and float(x).is_integer()


def decimal_to_float(x: Any) -> Any:
    """`Decimal` 은 `float` 로 바꾸고 다른 값은 그대로 돌려준다. ccxt 처럼 숫자 인자와 `params` 에 `Decimal` 을 받으려고 입구에서 쓴다."""
    return float(x) if isinstance(x, decimal.Decimal) else x


def is_string(x: Any) -> bool:
    return isinstance(x, str)


def is_dict(x: Any) -> bool:
    return isinstance(x, dict)


def is_array(x: Any) -> bool:
    return isinstance(x, (list, tuple))


# ============ JavaScript 와 같은 문자열 변환 ============


def js_number_string(x: float) -> str:
    """JavaScript `String(number)` 와 같은 표기. 정수 값은 소수점 없이, 1e-7 미만과 1e21 이상은 지수 표기다."""
    if isinstance(x, int) and not isinstance(x, bool):
        return str(x)
    if math.isnan(x):
        return 'NaN'
    if math.isinf(x):
        return 'Infinity' if x > 0 else '-Infinity'
    if x == 0:
        return '0'
    # repr 은 값을 되살리는 가장 짧은 십진수다. JavaScript 도 같은 자릿수를 고르고 표기만 다르다.
    sign = '-' if x < 0 else ''
    digits_decimal = decimal.Decimal(repr(abs(x)))
    sign_bit, digits_tuple, exponent = digits_decimal.normalize().as_tuple()
    digits = ''.join(str(d) for d in digits_tuple)
    n = len(digits) + int(exponent)  # 소수점 위치(과학 표기의 지수 + 1)
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + '0' * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + '.' + digits[n:]
    if -6 < n <= 0:
        return sign + '0.' + '0' * (-n) + digits
    e = n - 1
    exp = ('+' if e >= 0 else '-') + str(abs(e))
    if k == 1:
        return sign + digits + 'e' + exp
    return sign + digits[0] + '.' + digits[1:] + 'e' + exp


def js_string(x: Any) -> str:
    """JavaScript `String(x)` 와 같은 결과."""
    if x is None:
        return 'null'
    if isinstance(x, bool):
        return 'true' if x else 'false'
    if isinstance(x, (int, float, decimal.Decimal)):
        return js_number_string(decimal_to_float(x))
    if isinstance(x, (list, tuple)):
        return ','.join('' if v is None else js_string(v) for v in x)
    if isinstance(x, dict):
        return '[object Object]'
    return str(x)


# JavaScript `Number(string)` 이 받는 문법. Python `float` 는 `1_000`·`inf`·유니코드 숫자도 받으므로 먼저 이 문법으로 거른다.
_JS_DECIMAL = re.compile(r'[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?')
_JS_RADIX = {'x': (16, re.compile(r'[0-9a-fA-F]+')), 'o': (8, re.compile(r'[0-7]+')), 'b': (2, re.compile(r'[01]+'))}


def _js_number_of_text(raw: str) -> float:
    text = raw.strip()
    if text == '':
        return 0.0
    if text in ('Infinity', '+Infinity', '-Infinity'):
        return -math.inf if text[0] == '-' else math.inf
    if _JS_DECIMAL.fullmatch(text):
        return float(text)
    radix = _JS_RADIX.get(text[1:2].lower()) if text[:1] == '0' else None
    if radix is not None and radix[1].fullmatch(text[2:]):
        return float(int(text[2:], radix[0]))
    return math.nan


def js_number(raw: Any) -> float:
    """JavaScript `Number(raw)` 과 같은 변환. `None` 은 0, 읽지 못하면 NaN 이다."""
    if raw is None:
        return 0.0
    if isinstance(raw, bool):
        return 1.0 if raw else 0.0
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        return _js_number_of_text(raw)
    return math.nan


def encode_uri_component(value: str) -> str:
    """JavaScript `encodeURIComponent` 와 같다."""
    return quote(value, safe="-_.!~*'()")


def form_urlencode(params: Dict[str, Any]) -> str:
    """JavaScript `new URLSearchParams(params).toString()` 과 같다(application/x-www-form-urlencoded).
    영숫자와 `*-._` 만 그대로 두고, 공백은 `+`, 나머지는 UTF-8 바이트를 `%XX` 로 쓴다."""
    def encode(text: str) -> str:
        out = []
        for byte in text.encode('utf-8'):
            ch = chr(byte)
            if (byte < 128 and ch.isalnum()) or ch in '*-._':
                out.append(ch)
            elif ch == ' ':
                out.append('+')
            else:
                out.append('%%%02X' % byte)
        return ''.join(out)
    return '&'.join(encode(str(k)) + '=' + encode(js_string(v)) for k, v in params.items())


def json_stringify(value: Any) -> str:
    """JavaScript `JSON.stringify` 와 같은 모양(공백 없음, 한글 그대로, 정수 값의 실수는 소수점 없이)."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float, decimal.Decimal)):
        value = decimal_to_float(value)
        return js_number_string(value) if is_number(value) else 'null'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(json_stringify(v) for v in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(str(k), ensure_ascii=False) + ':' + json_stringify(v) for k, v in value.items()) + '}'
    return json.dumps(str(value), ensure_ascii=False)


# ============ 키 조회 ============


def prop(o: Any, k: Any) -> Any:
    """키의 값. 값이 없거나 `None` 이거나 빈 문자열이면 `None`. `Decimal` 은 `float` 로 읽는다."""
    if k is None:
        return None
    if isinstance(o, dict):
        x = o.get(k)
    elif isinstance(o, (list, tuple)) and isinstance(k, int) and not isinstance(k, bool):
        x = o[k] if 0 <= k < len(o) else None
    else:
        return None
    return None if x is None or x == '' else decimal_to_float(x)


def prop_n(o: Any, keys: Iterable[Any]) -> Any:
    """키를 차례로 시도해 처음 값이 있는 키의 값."""
    if not isinstance(o, (dict, list, tuple)):
        return None
    for k in keys:
        x = prop(o, k)
        if x is not None:
            return x
    return None


# ============ 값 변환 ============

_JS_FLOAT_PREFIX = re.compile(r'^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[+-]?Infinity)')


def as_float(x: Any) -> float:
    """JavaScript `parseFloat` 처럼 앞에서 읽을 수 있는 만큼 읽는다. 못 읽으면 NaN."""
    if isinstance(x, str) and len(x) > 0:
        m = _JS_FLOAT_PREFIX.match(x)
        if m is None:
            return math.nan
        text = m.group(1)
        return float(text.replace('Infinity', 'inf'))
    if is_number(x):
        return float(x)
    return math.nan


def as_integer(x: Any) -> float:
    """JavaScript `Math.trunc(Number(x))` 와 같다. 못 읽으면 NaN."""
    if isinstance(x, str):
        n = _js_number_of_text(x)
        return float(math.trunc(n)) if math.isfinite(n) else n
    if is_number(x):
        return float(math.trunc(x))
    return math.nan


def _to_float(x: Any, d: Optional[float] = None) -> Optional[float]:
    if x is None:
        return d
    n = as_float(x)
    return n if math.isfinite(n) else d


def _to_integer(x: Any, d: Optional[int] = None) -> Optional[int]:
    if x is None:
        return d
    n = as_integer(x)
    return int(n) if math.isfinite(n) else d


def _to_product(x: Any, factor: float, d: Optional[int] = None) -> Optional[int]:
    if x is None:
        return d
    product = as_float(x) * factor
    return int(math.trunc(product)) if math.isfinite(product) else d


def _as_str(x: Any, d: Optional[str] = None) -> Optional[str]:
    if x is None:
        return d
    if isinstance(x, str):
        return x
    if is_number(x):
        return js_number_string(x)
    return d


# ============ safe* ============


def safe_value(o: Any, k: Any, default_value: Any = None) -> Any:
    x = prop(o, k)
    return default_value if x is None else x


def safe_value_2(o: Any, k1: Any, k2: Any, default_value: Any = None) -> Any:
    x = prop_n(o, [k1, k2])
    return default_value if x is None else x


def safe_value_n(o: Any, keys: Iterable[Any], default_value: Any = None) -> Any:
    x = prop_n(o, keys)
    return default_value if x is None else x


def safe_string(o: Any, k: Any, default_value: Optional[str] = None) -> Optional[str]:
    return _as_str(prop(o, k), default_value)


def safe_string_2(o: Any, k1: Any, k2: Any, default_value: Optional[str] = None) -> Optional[str]:
    return _as_str(prop_n(o, [k1, k2]), default_value)


def safe_string_n(o: Any, keys: Iterable[Any], default_value: Optional[str] = None) -> Optional[str]:
    return _as_str(prop_n(o, keys), default_value)


def safe_string_lower(o: Any, k: Any, default_value: Optional[str] = None) -> Optional[str]:
    s = _as_str(prop(o, k))
    return default_value if s is None else s.lower()


def safe_string_upper(o: Any, k: Any, default_value: Optional[str] = None) -> Optional[str]:
    s = _as_str(prop(o, k))
    return default_value if s is None else s.upper()


def safe_float(o: Any, k: Any, default_value: Optional[float] = None) -> Optional[float]:
    return _to_float(prop(o, k), default_value)


def safe_float_2(o: Any, k1: Any, k2: Any, default_value: Optional[float] = None) -> Optional[float]:
    return _to_float(prop_n(o, [k1, k2]), default_value)


def safe_integer(o: Any, k: Any, default_value: Optional[int] = None) -> Optional[int]:
    return _to_integer(prop(o, k), default_value)


def safe_integer_2(o: Any, k1: Any, k2: Any, default_value: Optional[int] = None) -> Optional[int]:
    return _to_integer(prop_n(o, [k1, k2]), default_value)


def safe_integer_n(o: Any, keys: Iterable[Any], default_value: Optional[int] = None) -> Optional[int]:
    return _to_integer(prop_n(o, keys), default_value)


def safe_integer_product(o: Any, k: Any, factor: float, default_value: Optional[int] = None) -> Optional[int]:
    return _to_product(prop(o, k), factor, default_value)


def safe_timestamp(o: Any, k: Any, default_value: Optional[int] = None) -> Optional[int]:
    return _to_product(prop(o, k), 1000, default_value)


def safe_timestamp_2(o: Any, k1: Any, k2: Any, default_value: Optional[int] = None) -> Optional[int]:
    return _to_product(prop_n(o, [k1, k2]), 1000, default_value)


def safe_number(o: Any, k: Any, default_value: Optional[float] = None) -> Optional[float]:
    return parse_number(safe_string(o, k), default_value)


def safe_number_2(o: Any, k1: Any, k2: Any, default_value: Optional[float] = None) -> Optional[float]:
    return parse_number(safe_string_2(o, k1, k2), default_value)


def safe_number_n(o: Any, keys: Iterable[Any], default_value: Optional[float] = None) -> Optional[float]:
    return parse_number(safe_string_n(o, keys), default_value)


def safe_bool(o: Any, k: Any, default_value: Optional[bool] = None) -> Optional[bool]:
    x = prop(o, k)
    return x if isinstance(x, bool) else default_value


def safe_bool_2(o: Any, k1: Any, k2: Any, default_value: Optional[bool] = None) -> Optional[bool]:
    x = prop_n(o, [k1, k2])
    return x if isinstance(x, bool) else default_value


def safe_dict(o: Any, k: Any, default_value: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    x = prop(o, k)
    return x if isinstance(x, dict) else default_value


def safe_dict_2(o: Any, k1: Any, k2: Any, default_value: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    x = prop_n(o, [k1, k2])
    return x if isinstance(x, dict) else default_value


def safe_list(o: Any, k: Any, default_value: Optional[List[Any]] = None) -> Optional[List[Any]]:
    x = prop(o, k)
    return x if isinstance(x, list) else default_value


def safe_list_2(o: Any, k1: Any, k2: Any, default_value: Optional[List[Any]] = None) -> Optional[List[Any]]:
    x = prop_n(o, [k1, k2])
    return x if isinstance(x, list) else default_value


# ============ 숫자 ============


def parse_number(value: Any, d: Optional[float] = None) -> Optional[float]:
    """숫자로 읽을 수 있는 값만 숫자로 바꾸고, 못 읽으면 `d`. 빈 문자열과 `None` 은 0 이 아니라 못 읽은 값이다.
    ccxt Python 판처럼 결과는 `float` 이다."""
    if value is None:
        return d
    if isinstance(value, bool):
        return d
    if isinstance(value, (int, float)):
        return d if math.isnan(value) else float(value)
    if not isinstance(value, str) or value.strip() == '':
        return d
    try:
        n = float(value.strip())
    except ValueError:
        return d
    return d if math.isnan(n) else n


def number_to_string(x: Any) -> Optional[str]:
    """지수 표기를 쓰지 않은 십진 문자열. 숫자가 아니면 `js_string` 결과."""
    if x is None:
        return None
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return js_string(x)
    if isinstance(x, int):
        return str(x)
    d = decimal.Decimal(repr(x))
    text = format(d, 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return '0' if text in ('-0', '') else text


def omit_zero(value: Optional[str]) -> Optional[str]:
    """값이 0 이거나 비어 있으면 `None`. 0 을 값 없음으로 다루는 필드(시가·호가 등)에 쓴다."""
    if value is None or value == '':
        return None
    return None if as_float(value) == 0 else value


def precision_from_string(text: Optional[str]) -> int:
    """`'0.0001'` → 4, `'1e-4'` → 4, `'100'` → 0."""
    if text is None:
        return 0
    if 'e' in text or 'E' in text:
        return int(re.sub(r'^[-+]?\d\.?\d*[eE]', '', text)) * -1
    # 끝의 0 을 지운다. `re.sub(r'0+$', ...)` 는 0 이 길게 이어진 입력에서 되추적이 제곱으로 늘어난다.
    parts = text.rstrip('0').split('.')
    return len(parts[1]) if len(parts) > 1 else 0


# ============ 사전·배열 ============


def extend(*args: Any) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for arg in args:
        if arg is not None:
            result.update(arg)
    return result


def deep_extend(*args: Any) -> Any:
    """일반 사전은 깊게 합치고 그 밖의 값은 뒤의 것으로 덮어쓴다. 입력은 바꾸지 않는다."""
    result: Any = None
    result_is_dict = False
    for arg in args:
        if isinstance(arg, dict):
            if result is None or not result_is_dict:
                result = {}
                result_is_dict = True
            for key, value in arg.items():
                current = result.get(key)
                if isinstance(value, dict):
                    result[key] = deep_extend(current, value) if isinstance(current, dict) else deep_extend(value)
                else:
                    result[key] = value
        else:
            result = arg
            result_is_dict = False
    return result


def clone(x: Any) -> Any:
    if isinstance(x, list):
        return list(x)
    if isinstance(x, dict):
        return dict(x)
    return x


def omit(x: Any, *args: Any) -> Any:
    """지정한 키를 뺀 사본. `omit(x, 'a', 'b')` 와 `omit(x, ['a', 'b'])` 를 모두 받는다."""
    if x is None or isinstance(x, list):
        return x
    out = dict(x)
    for k in args:
        for kk in (k if isinstance(k, (list, tuple)) else [k]):
            out.pop(kk, None)
    return out


def keysort(x: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return {} if x is None else {k: x[k] for k in sorted(x)}


def to_array(obj: Any) -> List[Any]:
    if obj is None:
        return []
    if isinstance(obj, dict):
        return list(obj.values())
    return list(obj)


def index_by(x: Any, k: Any) -> Dict[Any, Any]:
    out: Dict[Any, Any] = {}
    for v in to_array(x):
        if isinstance(v, dict) and k in v:
            out[v[k]] = v
    return out


def group_by(x: Any, k: Any) -> Dict[Any, List[Any]]:
    out: Dict[Any, List[Any]] = {}
    for v in to_array(x):
        if isinstance(v, dict) and k in v:
            out.setdefault(v[k], []).append(v)
    return out


def filter_by(x: Any, k: Any, value: Any = None) -> List[Any]:
    return [v for v in to_array(x) if isinstance(v, dict) and v.get(k) == value]


def _sort_key(value: Any) -> Any:
    # 숫자와 문자열이 섞여도 던지지 않게 종류별로 나눈다(같은 종류 안에서만 크기를 비교한다).
    if value is None:
        return (0, 0)
    if is_number(value):
        return (1, value)
    return (2, str(value))


def sort_by(array: List[Any], key: Any, descending: bool = False, default_value: Any = 0) -> List[Any]:
    def get(item: Any) -> Any:
        if isinstance(item, dict):
            return item.get(key, default_value) if key in item else default_value
        if isinstance(item, (list, tuple)) and isinstance(key, int):
            return item[key] if 0 <= key < len(item) else default_value
        return default_value
    return sorted(array, key=lambda item: _sort_key(get(item)), reverse=descending)


def sort_by_2(array: List[Any], key1: Any, key2: Any, descending: bool = False) -> List[Any]:
    return sorted(array, key=lambda item: (_sort_key(item.get(key1)), _sort_key(item.get(key2))), reverse=descending)


def unique(x: Iterable[Any]) -> List[Any]:
    out: List[Any] = []
    for v in x:
        if v not in out:
            out.append(v)
    return out


def flatten(x: Iterable[Any]) -> List[Any]:
    out: List[Any] = []
    for v in x:
        if isinstance(v, (list, tuple)):
            out.extend(flatten(v))
        else:
            out.append(v)
    return out


def is_empty(obj: Any) -> bool:
    if obj is None:
        return True
    if isinstance(obj, (list, tuple, dict)):
        return len(obj) < 1
    return False


# ============ 경로·쿼리 ============

_PATH_PARAM = re.compile(r'{([\w-]+)}')


def extract_params(path: str) -> List[str]:
    """`'candles/{unit}/{code}'` 처럼 `{}` 로 감싼 이름들."""
    return _PATH_PARAM.findall(path)


def implode_params(path: Optional[str], params: Any) -> str:
    """경로의 `{이름}` 자리를 `params` 값으로 채운다. 배열 값과 없는 이름은 그대로 둔다."""
    if path is None:
        return ''
    if isinstance(params, dict):
        for key, value in params.items():
            if not isinstance(value, (list, tuple)):
                path = path.replace('{' + str(key) + '}', js_string(value), 1)
    return path


def urlencode(params: Dict[str, Any]) -> str:
    """쿼리 문자열. 값이 `None` 인 키는 빼고, 배열은 쉼표로 잇는다. 키 순서는 입력 순서다."""
    parts = []
    for key, value in params.items():
        if value is None:
            continue
        parts.append(encode_uri_component(str(key)) + '=' + encode_uri_component(js_string(value)))
    return '&'.join(parts)


# ============ 시각 ============


def milliseconds() -> int:
    """지금 시각(UTC 밀리초). 패키지는 현재 시각을 모두 이 함수로 읽는다. 테스트는 이 함수를 바꿔 끼워 시각을 고정한다."""
    return int(time.time() * 1000)


def seconds() -> int:
    return milliseconds() // 1000


def iso8601(timestamp: Any) -> Optional[str]:
    """밀리초 시각을 `2018-04-10T06:42:23.000Z` 꼴로 바꾼다. 숫자가 아니거나(숫자로만 된 문자열은 허용) 음수면 `None`."""
    if isinstance(timestamp, bool):
        return None
    if isinstance(timestamp, (int, float)) and math.isfinite(timestamp):
        ms = int(math.floor(timestamp))
    elif isinstance(timestamp, str) and re.fullmatch(r'[0-9]+', timestamp):
        ms = int(timestamp)
    else:
        return None
    if ms < 0 or ms > 8640000000000000:
        return None
    try:
        dt = datetime.datetime(1970, 1, 1) + datetime.timedelta(milliseconds=ms)
    except OverflowError:
        return None
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (ms % 1000)


_ISO = re.compile(r'^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$')


def parse8601(x: Any) -> Optional[int]:
    """ISO 8601 문자열을 밀리초 시각으로 읽는다. 시간대 표기가 없으면 UTC 로 본다(한국 시각만 적은 응답은 호출하는 쪽이 9시간을 뺀다)."""
    if not isinstance(x, str) or not x:
        return None
    if re.fullmatch(r'[0-9]+', x) or '-' not in x or ':' not in x:
        return None
    m = _ISO.match(x.strip())
    if m is None:
        return None
    year, month, day, hour, minute, second, fraction, zone = m.groups()
    try:
        base = calendar.timegm((int(year), int(month), int(day), int(hour or 0), int(minute or 0), int(second or 0), 0, 0, 0))
    except (ValueError, OverflowError):
        return None
    ms = base * 1000 + (int((fraction + '000')[:3]) if fraction else 0)
    if zone and zone != 'Z':
        sign = 1 if zone[0] == '+' else -1
        digits = zone[1:].replace(':', '')
        offset_minutes = int(digits[:2]) * 60 + (int(digits[2:4]) if len(digits) >= 4 else 0)
        ms -= sign * offset_minutes * 60 * 1000
    return ms


_SECONDS_PER_UNIT = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400, 'w': 604800, 'M': 2592000, 'y': 31536000}


def parse_timeframe(timeframe: Optional[str]) -> float:
    """`'1m'`·`'4h'`·`'1d'` 같은 봉 주기를 초로 바꾼다. 월(`M`)은 30일, 연(`y`)은 365일이다."""
    if timeframe is None:
        raise NotSupported('timeframe is required')
    scale = _SECONDS_PER_UNIT.get(timeframe[-1])
    if scale is None:
        raise NotSupported(f'timeframe unit {timeframe[-1]} is not supported')
    return float(timeframe[:-1]) * scale
