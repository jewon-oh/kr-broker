# 제3자 코드 고지

이 저장소의 `ts/src/base/` 와 `python/` 은 [ccxt](https://github.com/ccxt/ccxt)의 구조를 따르고, 일부 함수(`decimalToPrecision` 등)는 ccxt 의 코드를 옮겨 왔다.
Python 판의 `base/precise.py` 와 `base/decimal_to_precision.py` 는 ccxt 4.5.83 의 같은 파일이다.
ccxt 는 MIT 라이선스이며 그 전문은 다음과 같다.

```text
MIT License

Copyright © 2024 Igor Kroitor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
