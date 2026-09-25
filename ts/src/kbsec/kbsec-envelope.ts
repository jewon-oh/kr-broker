/**
 * @fileoverview KB증권 응답 봉투 판정 — 업무 성패, 빈 결과, 토큰 실패를 가르는 규칙과 요청 `dataHeader` 의 호스트 주소.
 *
 * KB 공통 규격:
 * - 모든 호출이 `POST /api/v1/{trcode}` 다. 조회도 POST 다.
 * - 요청 본문은 `{ dataHeader: {ipAddr, macAddr}, dataBody: {...} }`, 응답 본문은 `{ dataHeader, dataBody: {...} }` 다.
 * - **업무 오류가 HTTP 200 으로 온다.** 상태 코드만 보면 실패한 주문을 성공으로 기록하므로 `dataHeader.processFlag` 로 성패를 가른다.
 * - **반대로 업무 오류가 HTTP 500 으로도 온다.** 봉투가 있으면 상태 코드보다 봉투를 정본으로 삼는다.
 */

import { networkInterfaces } from 'node:os';

/**
 * 응답 `dataHeader` — 업무 성패의 정본은 **`processFlag`** 다.
 *
 * 성공: processFlag `A` · processCode `0011`/`0024` · processMessage `정상적으로 조회되었습니다.`
 * 실패: processFlag `B` · processCode `E021`/`9999` 등
 *
 * `resultCode`/`resultMessage` 는 실패해도 `200`/`성공` 이다. 전송 계층 코드라 업무 성패 판정에 쓰면 안 된다.
 */
export interface KbsecResponseHeader {
    processFlag?: string;
    processCode?: string;
    processMessage?: string;
    resultCode?: string;
    resultMessage?: string;
}

/** 성공 플래그. `A` 만 성공이다. */
const PROCESS_FLAG_OK = 'A';

/**
 * "조회 결과 없음"을 뜻하는 processCode 다. 플래그와 무관하게 정상적인 빈 결과로 본다.
 *
 * TR 마다 플래그가 갈린다. 일부는 `A` 와 1861/2149 로 주고, 계좌별주문체결조회(`SSQM2341`)는 미체결이 0건일 때 `B` 와 1861 로 준다.
 * 코드로만 판정한다. 한글 문구는 TR 마다 조금씩 달라서 문구 매칭은 하지 않는다.
 */
const EMPTY_RESULT_CODES: ReadonlySet<string> = new Set([
    '1861', // 조회할 자료가 없습니다.
    '2149', // 해당자료가 없습니다.
]);

/**
 * **토큰 검증 실패**를 뜻하는 processCode 다. 재발급한 뒤 한 번 다시 보내면 스스로 복구된다.
 *
 * KB 는 이것을 401 로 주지 않고 HTTP 500 과 `processFlag B`, `I445` 로 준다. 아무 500 이나 여기에 넣으면 안 된다.
 * `I446`(API 사용 권한 없음)도 같은 500 으로 오지만 재발급으로 낫지 않고, 재시도가 KB 가 경고하는 "잘못된 조회의 과도한 반복"이 된다.
 * 스스로 복구되는 코드만 화이트리스트로 둔다.
 */
const TOKEN_FAILURE_CODES: ReadonlySet<string> = new Set([
    'I445', // 토큰 검증에 실패했습니다.
]);

/** 토큰 재발급으로 복구할 수 있는 응답인가. HTTP 401(표준)이거나 KB 의 `I445` 다. */
export function isKbsecTokenFailure(httpStatus: number, header: KbsecResponseHeader | undefined): boolean {
    if (httpStatus === 401) return true;
    return TOKEN_FAILURE_CODES.has(String(header?.processCode ?? '').trim());
}

/** 업무 실패인가. 플래그가 없으면 판정할 수 없으므로 실패로 보지 않고, 빈 결과 코드는 플래그가 `B` 여도 실패가 아니다. */
export function isKbsecBusinessError(header: KbsecResponseHeader | undefined): boolean {
    if (!header) return false;
    const flag = String(header.processFlag ?? '').trim().toUpperCase();
    if (!flag) return false;
    if (EMPTY_RESULT_CODES.has(String(header.processCode ?? '').trim())) return false;
    return flag !== PROCESS_FLAG_OK;
}

/**
 * 요청 dataHeader 의 ipAddr/macAddr 다. **빈 문자열이면 TR 이 전부 거부된다**
 * (`입력 전문 [dataHeader.ipAddr]을 확인해 주세요`). 토큰 발급만 빈 값을 받아 준다.
 *
 * 공식 예제는 서버에서 호출할 때 비워도 된다고 적지만 실제와 다르다. 호스트의 첫 non-internal IPv4 를 쓰고, 찾지 못하면 루프백으로 대신한다.
 */
let cachedHostAddr: { ipAddr: string; macAddr: string } | null = null;

export function kbsecHostAddr(): { ipAddr: string; macAddr: string } {
    if (cachedHostAddr) return cachedHostAddr;
    let ipAddr = '127.0.0.1';
    let macAddr = '00-00-00-00-00-00';
    try {
        for (const addrs of Object.values(networkInterfaces())) {
            for (const a of addrs ?? []) {
                if (a.family === 'IPv4' && !a.internal && a.address) {
                    ipAddr = a.address;
                    if (a.mac && a.mac !== '00:00:00:00:00:00') {
                        macAddr = a.mac.toUpperCase().replace(/:/g, '-');
                    }
                    cachedHostAddr = { ipAddr, macAddr };
                    return cachedHostAddr;
                }
            }
        }
    } catch {
        // 인터페이스를 읽지 못하면 폴백 값을 쓴다.
    }
    cachedHostAddr = { ipAddr, macAddr };
    return cachedHostAddr;
}

/** @deprecated `KbsecResponseHeader` 를 쓴다. 다음 판에서 지운다. */
export type KBSecResponseHeader = KbsecResponseHeader;
/** @deprecated `isKbsecTokenFailure` 를 쓴다. 다음 판에서 지운다. */
export const isKBSecTokenFailure = isKbsecTokenFailure;
/** @deprecated `isKbsecBusinessError` 를 쓴다. 다음 판에서 지운다. */
export const isKBSecBusinessError = isKbsecBusinessError;
