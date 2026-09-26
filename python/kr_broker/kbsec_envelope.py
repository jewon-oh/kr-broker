"""KB증권 응답 봉투 판정과 요청 `dataHeader` 의 호스트 주소. TypeScript 판 `ts/src/kbsec/kbsec-envelope.ts` 를 옮겼다.

업무 오류가 HTTP 200 으로도, HTTP 500 으로도 온다. 봉투(`dataHeader.processFlag`)가 있으면 상태 코드보다 봉투가 정본이다.
`resultCode`·`resultMessage` 는 실패해도 `200`·`성공` 이라 성패 판정에 쓰지 않는다.
"""

import socket
import uuid
from typing import Any, Dict, Mapping, Optional

from kr_broker.base import functions as fn

# 성공 플래그. `A` 만 성공이다.
_PROCESS_FLAG_OK = 'A'
# 조회 결과 없음. 플래그와 무관하게 정상적인 빈 결과로 본다(`SSQM2341` 은 미체결 0건을 `B` 와 1861 로 준다).
_EMPTY_RESULT_CODES = frozenset([
    '1861',  # 조회할 자료가 없습니다.
    '2149',  # 해당자료가 없습니다.
])
# 재발급한 뒤 한 번 다시 보내면 복구되는 토큰 실패. KB 는 401 이 아니라 HTTP 500 과 `processFlag B`, `I445` 로 준다.
# `I446`(API 사용 권한 없음)도 같은 500 으로 오지만 재발급으로 낫지 않으므로 넣지 않는다.
_TOKEN_FAILURE_CODES = frozenset([
    'I445',  # 토큰 검증에 실패했습니다.
])
# `connect` 로 나가는 경로만 고르는 주소(RFC 5737 문서용 주소). UDP 라 패킷을 보내지 않는다.
_ROUTE_PROBE = ('192.0.2.1', 9)
# MAC 의 멀티캐스트 비트. `uuid.getnode()` 가 MAC 을 찾지 못해 지어낸 값에는 이 비트가 켜져 있다.
_MULTICAST_BIT = 1 << 40

_cached_host_addr: Optional[Dict[str, str]] = None


def _text(value: Any) -> str:
    """JavaScript `String(value ?? '')` 와 같다."""
    return '' if value is None else fn.js_string(value)


def is_kbsec_token_failure(http_status: int, header: Optional[Mapping[str, Any]]) -> bool:
    """토큰 재발급으로 복구할 수 있는 응답인가. HTTP 401(표준)이거나 KB 의 `I445` 다."""
    if http_status == 401:
        return True
    return _text(None if header is None else header.get('processCode')).strip() in _TOKEN_FAILURE_CODES


def is_kbsec_business_error(header: Optional[Mapping[str, Any]]) -> bool:
    """업무 실패인가. 플래그가 없으면 판정할 수 없어 실패로 보지 않고, 빈 결과 코드는 플래그가 `B` 여도 실패가 아니다."""
    if header is None:
        return False
    flag = _text(header.get('processFlag')).strip().upper()
    if not flag:
        return False
    if _text(header.get('processCode')).strip() in _EMPTY_RESULT_CODES:
        return False
    return flag != _PROCESS_FLAG_OK


def kbsec_host_addr() -> Dict[str, str]:
    """TR 요청 `dataHeader` 의 `ipAddr`·`macAddr`. 빈 값이면 KB 가 TR 을 전부 거부한다(토큰 발급만 빈 값을 받는다).

    이 호스트가 밖으로 나갈 때 쓰는 IPv4 와 MAC 을 한 번만 찾아 둔다. 찾지 못하면 루프백 주소와 0 으로 채운 MAC 이다.
    TypeScript 판은 네트워크 인터페이스 목록의 첫 외부 IPv4 를 쓰는데, 표준 라이브러리에는 인터페이스 목록이 없어 기본 경로의 주소를 쓴다.
    그래서 인터페이스가 여럿인 호스트에서는 두 판이 다른 주소를 고를 수 있다. 운영에서는 `options['hostAddr']` 로 주는 것을 권한다.
    """
    global _cached_host_addr
    if _cached_host_addr is not None:
        return _cached_host_addr
    ip_addr = '127.0.0.1'
    mac_addr = '00-00-00-00-00-00'
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(_ROUTE_PROBE)
            address = probe.getsockname()[0]
        if address and not address.startswith('127.') and address != '0.0.0.0':
            ip_addr = address
            node = uuid.getnode()
            if node and not node & _MULTICAST_BIT:
                mac_addr = '-'.join(f'{(node >> shift) & 0xFF:02X}' for shift in range(40, -8, -8))
    except OSError:
        # 인터페이스를 읽지 못하면 폴백 값을 쓴다.
        pass
    _cached_host_addr = {'ipAddr': ip_addr, 'macAddr': mac_addr}
    return _cached_host_addr
