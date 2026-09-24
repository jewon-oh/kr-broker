/**
 * @fileoverview 진짜 `fetch` 와 로컬 HTTP 서버로 확인하는 전송 계층: 본문 읽기, 시간 초과, 연결 끊김.
 * 가짜 `fetch` 로는 실제 런타임의 오류 모양(취소 신호, 소켓 끊김)까지는 알 수 없다.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import { NetworkError, OrderOutcomeUnknown, RequestTimeout, ExchangeNotAvailable } from '../errors';
import { deepExtend } from '../functions/generic';
import { Exchange } from '../Exchange';
import type { Dict } from '../types';

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const path = req.url ?? '';
        if (path.startsWith('/ok')) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ path, method: req.method }));
        } else if (path.startsWith('/echo')) {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), auth: req.headers.authorization ?? null }));
            });
        } else if (path.startsWith('/hang')) {
            // 응답을 보내지 않는다.
        } else if (path.startsWith('/stall-body')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"partial":'); // 본문을 끝내지 않는다
        } else if (path.startsWith('/reset')) {
            req.socket.destroy();
        } else if (path.startsWith('/down')) {
            res.statusCode = 503;
            res.end('maintenance');
        } else {
            res.statusCode = 404;
            res.end('nope');
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

class Local extends Exchange {
    override describe(): Dict {
        return deepExtend(super.describe(), {
            id: 'local',
            rateLimit: 0,
            timeout: 200,
            requiredCredentials: { apiKey: false, secret: false },
            api: {
                public: { get: { ok: 1, hang: 1, 'stall-body': 1, reset: 1, down: 1 } },
                private: { post: { echo: { cost: 1, order: true }, hang: { cost: 1, order: true } } },
            },
        });
    }
}

/** 테스트 서버를 바라보는 증권사. */
function local(config: Dict = {}): Local {
    return new Local({ urls: { api: { public: baseUrl, private: baseUrl } }, ...config });
}

describe('실제 HTTP 전송', () => {
    it('JSON 응답을 읽는다', async () => {
        expect(await local().publicGetOk({ q: 1 })).toEqual({ path: '/ok?q=1', method: 'GET' });
    });

    it('POST 본문과 헤더가 서버에 도달한다', async () => {
        const ex = local({ headers: { Authorization: 'Bearer t' } });
        expect(await ex.privatePostEcho({ a: 1 })).toEqual({ body: '{"a":1}', auth: 'Bearer t' });
    });

    it('HTTP 상태 표가 실제 응답에도 적용된다', async () => {
        const error = await local().publicGetDown().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ExchangeNotAvailable);
        expect((error as Error).message).toContain('maintenance');
    });

    it('응답이 없으면 timeout 뒤에 RequestTimeout', async () => {
        const started = Date.now();
        const error = await local().publicGetHang().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RequestTimeout);
        expect(error).not.toBeInstanceOf(OrderOutcomeUnknown);
        expect(Date.now() - started).toBeLessThan(1500);
    });

    it('본문이 끝나지 않아도 timeout 을 지킨다', async () => {
        const error = await local().publicGetStallBody().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RequestTimeout);
    });

    it('소켓이 끊기면 조회는 NetworkError', async () => {
        const error = await local().publicGetReset().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(RequestTimeout);
    });

    it('서버가 응답하지 않으면 주문 요청은 OrderOutcomeUnknown', async () => {
        const error = await local().privatePostHang({ a: 1 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OrderOutcomeUnknown);
    });
});
