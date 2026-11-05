/**
 * KB 응답 봉투 판정 — 빈 결과 코드는 전역 목록(1861·2149)과 TR 한정 목록(I742 는 SPQM2103 만)으로 갈린다.
 */
import { describe, it, expect } from 'vitest';
import { isKbsecBusinessError, isKbsecEmptyResult } from '../kbsec-envelope';

const failure = (processCode: string) => ({ processFlag: 'B', processCode });

describe('isKbsecBusinessError — 빈 결과 코드', () => {
    it('전역 빈 결과 코드(1861·2149)는 플래그가 B 여도 어느 TR 에서나 실패가 아니다', () => {
        expect(isKbsecBusinessError(failure('1861'))).toBe(false);
        expect(isKbsecBusinessError(failure('2149'), 'SSAM1801')).toBe(false);
    });

    it('I742 는 해외 체결내역(SPQM2103)에서만 빈 결과다', () => {
        expect(isKbsecBusinessError(failure('I742'), 'SPQM2103')).toBe(false);
        expect(isKbsecBusinessError(failure('I742'), 'spqm2103')).toBe(false); // TR 코드 대소문자는 가리지 않는다
    });

    it('★다른 TR 의 I742 는 계속 실패다 — 주문 TR 의 거절이 성공으로 읽히면 안 된다', () => {
        expect(isKbsecBusinessError(failure('I742'), 'SKAM2101')).toBe(true); // 해외 주문
        expect(isKbsecBusinessError(failure('I742'), 'SSAM1801')).toBe(true);
        expect(isKbsecBusinessError(failure('I742'))).toBe(true); // TR 을 모르면 좁게 본다
    });

    it('빈 결과가 아닌 코드와 성공 플래그의 판정은 그대로다', () => {
        expect(isKbsecBusinessError(failure('I446'), 'SPQM2103')).toBe(true);
        expect(isKbsecBusinessError({ processFlag: 'A', processCode: '0011' }, 'SPQM2103')).toBe(false);
        expect(isKbsecBusinessError({ processCode: 'I742' }, 'SKAM2101')).toBe(false); // 플래그가 없으면 판정하지 않는다
        expect(isKbsecBusinessError(undefined, 'SPQM2103')).toBe(false);
    });
});

describe('isKbsecEmptyResult', () => {
    it('전역 코드는 TR 없이도, TR 한정 코드는 그 TR 에서만 참이다', () => {
        expect(isKbsecEmptyResult(failure('1861'))).toBe(true);
        expect(isKbsecEmptyResult(failure('I742'))).toBe(false);
        expect(isKbsecEmptyResult(failure('I742'), 'SPQM2103')).toBe(true);
        expect(isKbsecEmptyResult(undefined, 'SPQM2103')).toBe(false);
    });
});
