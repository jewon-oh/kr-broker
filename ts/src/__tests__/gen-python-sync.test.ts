/**
 * Python 동기 판 생성기(`scripts/gen-python-sync.mjs`)의 줄 단위 변환 규칙.
 *
 * 동기 판이 비동기 소스와 같은지는 `node scripts/gen-python-sync.mjs --check` 가 본다. 이 테스트는 규칙 자체를 본다.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GENERATOR = path.join(ROOT, 'scripts/gen-python-sync.mjs');

interface Generator {
    toSync(text: string, pkg: string, source: string): string;
}

// 생성기는 타입 선언이 없는 .mjs 다. 경로를 변수로 만들어 불러오면 경계 검사와 타입 검사가 파일 안쪽으로 따라가지 않는다.
const generator = (await import(pathToFileURL(GENERATOR).href)) as Generator;

/** 생성 표시 줄을 뗀 본문. */
function body(text: string): string {
    return generator.toSync(text, 'kr_broker', 'src.py').split('\n').slice(1).join('\n');
}

describe('gen-python-sync', () => {
    it('async 와 await, 비동기 패키지 경로를 동기 모양으로 바꾼다', () => {
        expect(body([
            'from kr_broker.async_support.base.runtime import sleep_seconds',
            'async def f(self):',
            '    async with self.lock:',
            '        return await self.g()',
        ].join('\n'))).toBe([
            'from kr_broker.base.runtime import sleep_seconds',
            'def f(self):',
            '    with self.lock:',
            '        return self.g()',
        ].join('\n'));
    });

    it('Awaitable[X] 힌트를 X 로 벗기고 typing 가져오기에서 Awaitable 을 뺀다', () => {
        expect(body([
            'from typing import Any, Awaitable, Callable, Dict',
            'from typing import Awaitable, Callable',
            'from typing import Callable, Awaitable',
            'def f(probe: Callable[[int], Awaitable[Dict[str, Any]]]) -> Callable[..., Awaitable[Dict[str, Any]]]:',
        ].join('\n'))).toBe([
            'from typing import Any, Callable, Dict',
            'from typing import Callable',
            'from typing import Callable',
            'def f(probe: Callable[[int], Dict[str, Any]]) -> Callable[..., Dict[str, Any]]:',
        ].join('\n'));
    });

    it('문자열과 주석, 여러 줄 docstring 안의 await 는 지우지 않고 실패한다', () => {
        expect(() => body("    logger.warning('await 없이 부른다: await self.f()')")).toThrow(/문자열이나 주석/);
        expect(() => body('    x = 1  # await self.f() 는 쓰지 않는다')).toThrow(/문자열이나 주석/);
        expect(() => body(['    """설명.', '', '    await broker.close() 로 닫는다."""', '    return 1'].join('\n'))).toThrow(/:3 /);
    });

    it('같은 줄의 문자열 뒤에 있는 코드의 await 는 지운다', () => {
        expect(body("    logger.info('#1 \\'x\\'', await self.f(), \"a'b\")")).toBe("    logger.info('#1 \\'x\\'', self.f(), \"a'b\")");
        expect(body(['    """여러 줄', '    설명."""', '    return await self.f()'].join('\n'))).toBe(['    """여러 줄', '    설명."""', '    return self.f()'].join('\n'));
    });

    it('한 줄에서 닫히지 않은 Awaitable 힌트는 남은 비동기 구문으로 보고 실패한다', () => {
        expect(() => body('def f(probe: Callable[[int], Awaitable[\n        Dict[str, Any]]]):')).toThrow(/Awaitable/);
    });
});
