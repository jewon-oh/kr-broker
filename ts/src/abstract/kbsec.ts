/**
 * @fileoverview `kbsec` 의 API 트리와 암묵 메서드 선언. `scripts/gen-ts-abstract.mjs` 가 `ts/src/spec/kbsec.json` 에서 만든 생성 파일이다.
 * 직접 고치지 말고 JSON 을 고친 뒤 `node scripts/gen-ts-abstract.mjs` 를 돌린다.
 */
import type { Dict, ImplicitApiMethod } from '../base/types';

/** `describe().api` 에 넣는 트리. `Exchange.defineRestApi` 가 엔드포인트마다 암묵 메서드를 만든다. */
export const KBSEC_API_TREE: Dict = {
    private: {
        post: {
            'ivu10140': { cost: 1 },
            'ivu10070': { cost: 1 },
            'ivs11560': { cost: 1 },
            'ivu10080': { cost: 1 },
            'szqm0771': { cost: 1 },
            'siqm4900': { cost: 1 },
            'spam2508': { cost: 1 },
            'ivu10430': { cost: 1 },
            'ivu10240': { cost: 1 },
            'ivu10280': { cost: 1 },
            'ivs10920': { cost: 1 },
            'ivu10210': { cost: 1 },
            'ivs10910': { cost: 1 },
            'iva60190': { cost: 1 },
            'iva60140': { cost: 1 },
            'ivm10050': { cost: 1 },
            'ivu10550': { cost: 1 },
            'ivu10020': { cost: 1 },
            'iva10370': { cost: 1 },
            'ivs11190': { cost: 1 },
            'ivu10270': { cost: 1 },
            'ivu10420': { cost: 1 },
            'ivu10450': { cost: 1 },
            'ivsa0070': { cost: 1 },
            'ivs11430': { cost: 1 },
            'ivm30010': { cost: 1 },
            'gss10030': { cost: 1 },
            'gss10040': { cost: 1 },
            'gsc10060': { cost: 1 },
            'gsa10020': { cost: 1 },
            'ssqm0004': { cost: 1 },
            'ssqm1801': { cost: 1 },
            'ssqm2952': { cost: 1 },
            'ssqm0006': { cost: 1 },
            'ssqm5472': { cost: 1 },
            'swqa2301': { cost: 1 },
            'swqb2301': { cost: 1 },
            'swqn2302': { cost: 1 },
            'szqm6019': { cost: 1 },
            'ssqm2392': { cost: 1 },
            'swqm2412': { cost: 1 },
            'swqm2302': { cost: 1 },
            'spqn3390': { cost: 1 },
            'skqo3390': { cost: 1 },
            'ssqm1802': { cost: 1 },
            'ssam1802': { cost: 1, order: true },
            'ssam1801': { cost: 1, order: true },
            'ssam1805': { cost: 1, order: true },
            'ssam1806': { cost: 1, order: true },
            'ssqm2341': { cost: 1 },
            'ssqm2121': { cost: 1 },
            'ssam5763': { cost: 1, order: true },
            'ssam5762': { cost: 1, order: true },
            'ssqn5472': { cost: 1 },
            'ssqm5765': { cost: 1 },
            'ssqm5475': { cost: 1 },
            'ssam0831': { cost: 1, order: true },
            'ssqm0831': { cost: 1 },
            'ssqm0834': { cost: 1 },
            'srqm3051': { cost: 1 },
            'skam2101': { cost: 1, order: true },
            'skam2102': { cost: 1, order: true },
            'skam2201': { cost: 1, order: true },
            'spqm2103': { cost: 1 },
            'spqn5472': { cost: 1 },
            'spqm5472': { cost: 1 },
            'spqn5473': { cost: 1 },
            'spao2104': { cost: 1, order: true },
            'spao2106': { cost: 1, order: true },
            'spqm1818': { cost: 1 },
            'skqm2106': { cost: 1 },
            'spqm3390': { cost: 1 },
            'spqm2226': { cost: 1 },
            'spqm2205': { cost: 1 },
            'skqm3350': { cost: 1 },
            'spqm2106': { cost: 1 },
            'spqm2204': { cost: 1 },
            'ssqm0005': { cost: 1 },
            'ssqn2952': { cost: 1 },
            'ssqm2932': { cost: 1 },
            'ssqm2442': { cost: 1 },
            'ssqm2443': { cost: 1 },
            'spqm5473': { cost: 1 },
        },
    },
};

/** `KBSEC_API_TREE` 의 엔드포인트마다 생기는 암묵 메서드. 증권사 클래스가 선언 병합으로 받는다. */
export interface KbsecImplicitApi {
    privatePostIvu10140: ImplicitApiMethod;
    privatePostIvu10070: ImplicitApiMethod;
    privatePostIvs11560: ImplicitApiMethod;
    privatePostIvu10080: ImplicitApiMethod;
    privatePostSzqm0771: ImplicitApiMethod;
    privatePostSiqm4900: ImplicitApiMethod;
    privatePostSpam2508: ImplicitApiMethod;
    privatePostIvu10430: ImplicitApiMethod;
    privatePostIvu10240: ImplicitApiMethod;
    privatePostIvu10280: ImplicitApiMethod;
    privatePostIvs10920: ImplicitApiMethod;
    privatePostIvu10210: ImplicitApiMethod;
    privatePostIvs10910: ImplicitApiMethod;
    privatePostIva60190: ImplicitApiMethod;
    privatePostIva60140: ImplicitApiMethod;
    privatePostIvm10050: ImplicitApiMethod;
    privatePostIvu10550: ImplicitApiMethod;
    privatePostIvu10020: ImplicitApiMethod;
    privatePostIva10370: ImplicitApiMethod;
    privatePostIvs11190: ImplicitApiMethod;
    privatePostIvu10270: ImplicitApiMethod;
    privatePostIvu10420: ImplicitApiMethod;
    privatePostIvu10450: ImplicitApiMethod;
    privatePostIvsa0070: ImplicitApiMethod;
    privatePostIvs11430: ImplicitApiMethod;
    privatePostIvm30010: ImplicitApiMethod;
    privatePostGss10030: ImplicitApiMethod;
    privatePostGss10040: ImplicitApiMethod;
    privatePostGsc10060: ImplicitApiMethod;
    privatePostGsa10020: ImplicitApiMethod;
    privatePostSsqm0004: ImplicitApiMethod;
    privatePostSsqm1801: ImplicitApiMethod;
    privatePostSsqm2952: ImplicitApiMethod;
    privatePostSsqm0006: ImplicitApiMethod;
    privatePostSsqm5472: ImplicitApiMethod;
    privatePostSwqa2301: ImplicitApiMethod;
    privatePostSwqb2301: ImplicitApiMethod;
    privatePostSwqn2302: ImplicitApiMethod;
    privatePostSzqm6019: ImplicitApiMethod;
    privatePostSsqm2392: ImplicitApiMethod;
    privatePostSwqm2412: ImplicitApiMethod;
    privatePostSwqm2302: ImplicitApiMethod;
    privatePostSpqn3390: ImplicitApiMethod;
    privatePostSkqo3390: ImplicitApiMethod;
    privatePostSsqm1802: ImplicitApiMethod;
    privatePostSsam1802: ImplicitApiMethod;
    privatePostSsam1801: ImplicitApiMethod;
    privatePostSsam1805: ImplicitApiMethod;
    privatePostSsam1806: ImplicitApiMethod;
    privatePostSsqm2341: ImplicitApiMethod;
    privatePostSsqm2121: ImplicitApiMethod;
    privatePostSsam5763: ImplicitApiMethod;
    privatePostSsam5762: ImplicitApiMethod;
    privatePostSsqn5472: ImplicitApiMethod;
    privatePostSsqm5765: ImplicitApiMethod;
    privatePostSsqm5475: ImplicitApiMethod;
    privatePostSsam0831: ImplicitApiMethod;
    privatePostSsqm0831: ImplicitApiMethod;
    privatePostSsqm0834: ImplicitApiMethod;
    privatePostSrqm3051: ImplicitApiMethod;
    privatePostSkam2101: ImplicitApiMethod;
    privatePostSkam2102: ImplicitApiMethod;
    privatePostSkam2201: ImplicitApiMethod;
    privatePostSpqm2103: ImplicitApiMethod;
    privatePostSpqn5472: ImplicitApiMethod;
    privatePostSpqm5472: ImplicitApiMethod;
    privatePostSpqn5473: ImplicitApiMethod;
    privatePostSpao2104: ImplicitApiMethod;
    privatePostSpao2106: ImplicitApiMethod;
    privatePostSpqm1818: ImplicitApiMethod;
    privatePostSkqm2106: ImplicitApiMethod;
    privatePostSpqm3390: ImplicitApiMethod;
    privatePostSpqm2226: ImplicitApiMethod;
    privatePostSpqm2205: ImplicitApiMethod;
    privatePostSkqm3350: ImplicitApiMethod;
    privatePostSpqm2106: ImplicitApiMethod;
    privatePostSpqm2204: ImplicitApiMethod;
    privatePostSsqm0005: ImplicitApiMethod;
    privatePostSsqn2952: ImplicitApiMethod;
    privatePostSsqm2932: ImplicitApiMethod;
    privatePostSsqm2442: ImplicitApiMethod;
    privatePostSsqm2443: ImplicitApiMethod;
    privatePostSpqm5473: ImplicitApiMethod;
}
