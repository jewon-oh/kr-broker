/**
 * @fileoverview KB 입력 필드 채우기 계약 — 부분 바디가 라이브에서 거부된 회귀를 고정한다.
 *
 * 2026-08-11 실측: SSQM1801 을 `{inq_clsf, nxt_key}` 만으로 호출하니
 * `시장 구분값을 확인하세요 [processCode=3576]` 로 거부됐다. KB 는 입력 레이아웃 전체를
 * 검증하므로 값이 없어도 **키는 있어야 한다**. 여기서는 (a) 배선된 TR 이 전부 입력표에
 * 등재돼 있는지 (b) 채우기가 값을 덮지 않는지를 고정한다.
 */

import { describe, it, expect } from 'vitest';


import { KBSEC_TR_INPUTS, fillTrInputs } from '../kbsec-tr-inputs';
import { KBSEC_TR, kbsecNormalizeCode, kbsecMarketOf } from '../kbsec-types';

describe('KBSec TR 입력표 계약', () => {
    it('KBSEC_TR 의 모든 TR 이 입력표에 등재돼 있다', () => {
        const missing = Object.entries(KBSEC_TR)
            .filter(([, code]) => typeof code === 'string' && !(code in KBSEC_TR_INPUTS))
            .map(([name, code]) => `${name}=${String(code)}`);
        // 미등재 TR 은 부분 바디로 나가 라이브에서만 오류로 드러난다 — 새 TR 배선 시 표도 갱신할 것.
        expect(missing).toEqual([]);
    });

    it('보유주식(SSQM1801)은 시장시간구분을 입력으로 갖는다 — 누락하면 실서버가 거부한다', () => {
        expect(KBSEC_TR_INPUTS.SSQM1801).toContain('mkt_tm_ccd');
    });

    it('해외 정정/취소의 구분 필드는 crct_cncl_clsf 다 (국내 crct_clsf 와 다름)', () => {
        expect(KBSEC_TR_INPUTS.SKAM2102).toContain('crct_cncl_clsf');
        expect(KBSEC_TR_INPUTS.SKAM2102).not.toContain('crct_clsf');
    });
});

describe('kbsecNormalizeCode — KB 응답의 A 접두 종목코드', () => {
    it('국내 단축코드의 A 접두를 벗긴다', () => {
        expect(kbsecNormalizeCode('A005930')).toBe('005930');
    });

    it('표준종목번호(ISIN)도 단축코드로 흡수한다', () => {
        expect(kbsecNormalizeCode('KR7005930003')).toBe('005930');
    });

    it('이미 정규 코드거나 해외 티커면 그대로 둔다', () => {
        expect(kbsecNormalizeCode('005930')).toBe('005930');
        expect(kbsecNormalizeCode('AAPL')).toBe('AAPL');
        // 'A' 로 시작하는 해외 티커를 잘라내면 안 된다.
        expect(kbsecNormalizeCode('AMZN')).toBe('AMZN');
    });

    it('신형 영숫자 국내 코드도 A 접두와 ISIN 을 벗기고, 국내 코드 모양이 아니면 벗기지 않는다', () => {
        expect(kbsecNormalizeCode('A0193L0')).toBe('0193L0');
        expect(kbsecMarketOf(kbsecNormalizeCode('A0193L0'))).toBe('KR');
        expect(kbsecNormalizeCode('KR70193L0006')).toBe('0193L0');
        expect(kbsecNormalizeCode('ABCDEFG')).toBe('ABCDEFG');   // 벗긴 결과가 숫자로 시작하지 않는다
    });

    it('정규화하면 국내로 판정된다 — 안 하면 해외 취소 TR 로 잘못 보낸다', () => {
        expect(kbsecMarketOf('A005930')).toBe('US');                    // 정규화 전(오판)
        expect(kbsecMarketOf(kbsecNormalizeCode('A005930'))).toBe('KR'); // 정규화 후
    });
});

describe('fillTrInputs', () => {
    it('누락 필드를 빈 문자열로 채우고 준 값은 보존한다', () => {
        const body = fillTrInputs('SSQM1801', { inq_clsf: '1', mkt_tm_ccd: '1' });
        expect(body).toEqual({
            inq_clsf: '1',
            is_no: '',
            mkt_tm_ccd: '1',
            spclz_ordr_ccd: '',
            act_cd: '',
            nxt_key: '',
        });
    });

    it('스펙 순서를 따른다 — KB 콘솔 요청과 같은 모양', () => {
        const body = fillTrInputs('SSQM1802', { bnd_mktio_ccd: '1' });
        expect(Object.keys(body)).toEqual(['is_no', 'bnd_mktio_ccd']);
    });

    it('입력이 없는 TR 은 빈 바디를 만든다', () => {
        expect(fillTrInputs('SZQM0771', {})).toEqual({});
    });

    it('미등재 TR 은 그대로 통과시킨다 (채우기 없음)', () => {
        expect(fillTrInputs('ZZZZ9999', { a: '1' })).toEqual({ a: '1' });
    });

    it('스펙에 없는 키도 떨구지 않는다 — 경고만 하고 함께 보낸다', () => {
        const body = fillTrInputs('SKAM2102', { crct_clsf: '2' });
        expect(body.crct_clsf).toBe('2');
        expect(body.crct_cncl_clsf).toBe('');
    });

    it('0 과 빈 문자열은 유효한 값이라 덮어쓰지 않는다', () => {
        const body = fillTrInputs('SSQM1802', { is_no: '', bnd_mktio_ccd: 0 });
        expect(body.bnd_mktio_ccd).toBe(0);
    });
});
