// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/tasks/json5-parser/oracle.test.ts
//
// Oracle tests for the json5-parser task (B4-v3).
// Tests are deterministic and hand-authored per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
// Load implementation via IMPL_PATH env var (defaults to reference-impl.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

let parseJSON5: (input: string) => unknown;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  parseJSON5 = mod.parseJSON5;
  if (typeof parseJSON5 !== 'function') {
    throw new Error(`Implementation at ${implPath} must export parseJSON5 as a named function`);
  }
});

describe('json5-parser — standard JSON (must pass)', () => {
  it('parses null', () => expect(parseJSON5('null')).toBeNull());
  it('parses true', () => expect(parseJSON5('true')).toBe(true));
  it('parses false', () => expect(parseJSON5('false')).toBe(false));
  it('parses integer', () => expect(parseJSON5('42')).toBe(42));
  it('parses negative integer', () => expect(parseJSON5('-7')).toBe(-7));
  it('parses float', () => expect(parseJSON5('3.14')).toBeCloseTo(3.14));
  it('parses double-quoted string', () => expect(parseJSON5('"hello"')).toBe('hello'));
  it('parses empty object', () => expect(parseJSON5('{}')).toEqual({}));
  it('parses empty array', () => expect(parseJSON5('[]')).toEqual([]));
  it('parses nested object', () => {
    expect(parseJSON5('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });
  it('parses array of values', () => {
    expect(parseJSON5('[1, "x", null, true]')).toEqual([1, 'x', null, true]);
  });
});

describe('json5-parser — single-quoted strings', () => {
  it("parses single-quoted string", () => expect(parseJSON5("'hello'")).toBe('hello'));
  it("parses escaped single quote inside single-quoted string", () => {
    expect(parseJSON5("'it\\'s alive'")).toBe("it's alive");
  });
  it("parses double-quote inside single-quoted string without escaping", () => {
    expect(parseJSON5('\'"world"\'')).toBe('"world"');
  });
});

describe('json5-parser — unquoted keys', () => {
  it('parses object with unquoted key', () => {
    expect(parseJSON5('{foo: 1}')).toEqual({ foo: 1 });
  });
  it('parses object with reserved-word key', () => {
    expect(parseJSON5('{for: 1}')).toEqual({ for: 1 });
    expect(parseJSON5('{if: 2}')).toEqual({ if: 2 });
  });
  it('parses unquoted key with underscores and dollars', () => {
    expect(parseJSON5('{_foo$: 3}')).toEqual({ _foo$: 3 });
  });
  it('parses mixed quoted and unquoted keys', () => {
    expect(parseJSON5('{a: 1, "b": 2}')).toEqual({ a: 1, b: 2 });
  });
});

describe('json5-parser — trailing commas', () => {
  it('allows trailing comma in array', () => {
    expect(parseJSON5('[1, 2, 3,]')).toEqual([1, 2, 3]);
  });
  it('allows trailing comma in object', () => {
    expect(parseJSON5('{a: 1, b: 2,}')).toEqual({ a: 1, b: 2 });
  });
  it('allows trailing comma in nested structures', () => {
    expect(parseJSON5('{x: [1, 2,],}')).toEqual({ x: [1, 2] });
  });
});

describe('json5-parser — comments', () => {
  it('ignores single-line comment', () => {
    expect(parseJSON5('// ignored\n42')).toBe(42);
  });
  it('ignores block comment', () => {
    expect(parseJSON5('/* ignored */ 42')).toBe(42);
  });
  it('ignores inline comment in object', () => {
    expect(parseJSON5('{a: /* mid */ 1}')).toEqual({ a: 1 });
  });
  it('ignores comment between items', () => {
    expect(parseJSON5('[1, // one\n 2]')).toEqual([1, 2]);
  });
});

describe('json5-parser — special numbers', () => {
  it('parses hex literal', () => expect(parseJSON5('0xFF')).toBe(255));
  it('parses uppercase hex', () => expect(parseJSON5('0xCAFE')).toBe(0xCAFE));
  it('parses leading-dot number', () => expect(parseJSON5('.5')).toBeCloseTo(0.5));
  it('parses trailing-dot number', () => expect(parseJSON5('5.')).toBeCloseTo(5.0));
  it('parses Infinity', () => expect(parseJSON5('Infinity')).toBe(Infinity));
  it('parses -Infinity', () => expect(parseJSON5('-Infinity')).toBe(-Infinity));
  it('parses +Infinity', () => expect(parseJSON5('+Infinity')).toBe(Infinity));
  it('parses NaN', () => expect(Number.isNaN(parseJSON5('NaN'))).toBe(true));
  it('parses +1', () => expect(parseJSON5('+1')).toBe(1));
});

describe('json5-parser — multiline string', () => {
  it('line continuation splices strings', () => {
    // 'hello\<newline>world' should parse as 'helloworld'
    expect(parseJSON5("'hello\\\nworld'")).toBe('helloworld');
  });
});

describe('json5-parser — error cases', () => {
  it('throws SyntaxError for empty input', () => {
    expect(() => parseJSON5('')).toThrow(SyntaxError);
  });
  it('throws SyntaxError for unterminated string', () => {
    expect(() => parseJSON5('"hello')).toThrow(SyntaxError);
  });
  it('throws SyntaxError for unterminated array', () => {
    expect(() => parseJSON5('[1, 2')).toThrow(SyntaxError);
  });
  it('throws SyntaxError for trailing garbage', () => {
    expect(() => parseJSON5('1 2')).toThrow(SyntaxError);
  });
  it('throws SyntaxError for unterminated block comment', () => {
    expect(() => parseJSON5('/* unterminated')).toThrow(SyntaxError);
  });
});
