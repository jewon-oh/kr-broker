/**
 * @fileoverview KIS 요청 스케줄러 (앱키 단위)
 * @description 초당 거래건수 초과(EGW00201)를 막는 예약 기반 간격 스케줄러.
 *
 * 인스턴스마다 따로 대기하면 병렬 호출에 취약하다. 100개가 동시에 들어오면 전부 같은 시각 상태를 읽고 함께 통과해 버스트가 하드 한도를
 * 넘고, 뒤이은 재시도가 몰린다(미국 100종목을 `Promise.allSettled` 로 훑는 스캔이 이 모양이었다).
 *
 * 이 스케줄러는 슬롯을 *동기적으로* 예약한다. 각 호출자가 들어오는 즉시 다음 가용 시각을 단조 증가로 확보하므로 동시에 들어와도
 * 간격을 두고 차례로 나간다. 같은 프로세스 안에서 같은 앱키를 쓰는 `kis` 인스턴스는 하나의 스케줄을 공유한다.
 *
 * 이 `Map` 은 프로세스 로컬 메모리다. 같은 앱키로 KIS 를 부르는 프로세스가 여럿이면 각자 독립된 스케줄을 갖고 서로의 존재를 모른 채
 * 같은 계정의 한도를 나눠 쓴다. 프로세스 경계를 넘는 유량제한은 별도 설계(공유 저장소 기반 슬롯 등)가 필요하다.
 */

/** 기본 최소 호출 간격(ms). 실전 하드 한도 초당 20건(50ms)에 여유를 둔 초당 15건이다. */
export const KIS_MIN_INTERVAL_MS = Math.ceil(1000 / 15);

/**
 * 앱키별 다음 가용 슬롯 시각(epoch ms). 예약은 동기적으로 이뤄져 병렬 진입에도 레이스가 없다.
 * 키 개수 = 앱키 수(소수)라 무한 증가 없음.
 */
const nextSlotAt = new Map<string, number>();

/**
 * 앱키별 요청 슬롯 획득 — 반환 시점이 곧 발사 허용 시각.
 *
 * 동시 호출도 각자 단조 증가 슬롯을 받아 `intervalMs` 간격으로 직렬화된다.
 * 백로그가 빠지면(현재 시각이 예약 슬롯을 추월) `now` 로 자가 회복하므로, 일시적 버스트
 * 후에도 불필요한 대기가 누적되지 않는다.
 *
 * @param appKey KIS 앱키 (동일 키 공유 인스턴스는 하나의 스케줄로 병합)
 * @param intervalMs 이 호출이 차지하는 시간. 모의투자는 초당 2건이라 실전보다 길다.
 */
export async function acquireKisSlot(appKey: string, intervalMs: number = KIS_MIN_INTERVAL_MS): Promise<void> {
    const now = Date.now();
    const prev = nextSlotAt.get(appKey) ?? 0;
    const scheduledAt = Math.max(now, prev);
    // 다음 호출자용 슬롯을 *동기적으로* 예약 — await 이전에 확정해 병렬 진입 레이스 차단.
    nextSlotAt.set(appKey, scheduledAt + intervalMs);
    const waitMs = scheduledAt - now;
    if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }
}

/** 테스트용 — 예약 상태 초기화. */
export function resetKisRateLimiter(appKey?: string): void {
    if (appKey) nextSlotAt.delete(appKey);
    else nextSlotAt.clear();
}
