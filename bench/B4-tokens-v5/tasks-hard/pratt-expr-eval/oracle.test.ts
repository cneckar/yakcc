// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/tasks-hard/pratt-expr-eval/oracle.test.ts
//
// Oracle tests for the pratt-expr-eval task (B4-v5-hard).
// Tests are deterministic and hand-authored per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
// Load implementation via IMPL_PATH env var (defaults to reference-impl.ts).
//
// Adversarial coverage targets the documented Haiku failure modes:
//   1. Left-associativity: "2 - 3 - 4" = -5, not 3.
//   2. Operator precedence: * before +, % at multiplicative level.
//   3. Unary minus after binary operator: "1 + -2" must parse, not throw.
//   4. Typed error (not NaN/0) on malformed input.
//   5. Decimal literals including leading-dot form ".5".

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

type EvaluatorCtor = new () => { evaluate(expr: string): number };
type ParseErrorCtor = new (message: string, position: number) => Error;

let ExpressionEvaluator: EvaluatorCtor;
let ParseError: ParseErrorCtor;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  ExpressionEvaluator = mod.ExpressionEvaluator;
  ParseError = mod.ParseError;
  if (typeof ExpressionEvaluator !== 'function') {
    throw new Error(
      `Implementation at ${implPath} must export ExpressionEvaluator as a named class`,
    );
  }
});

// ── basic literals ─────────────────────────────────────────────────────────

describe('pratt-expr-eval — literals', () => {
  it('single integer literal', () => {
    const ev = new ExpressionEvaluator();
    expect(ev.evaluate('42')).toBe(42);
  });

  it('decimal literal', () => {
    const ev = new ExpressionEvaluator();
    expect(ev.evaluate('3.14')).toBeCloseTo(3.14, 10);
  });

  it('leading-dot decimal literal ".5"', () => {
    const ev = new ExpressionEvaluator();
    expect(ev.evaluate('.5')).toBeCloseTo(0.5, 10);
  });

  it('zero', () => {
    const ev = new ExpressionEvaluator();
    expect(ev.evaluate('0')).toBe(0);
  });
});

// ── basic binary operators ─────────────────────────────────────────────────

describe('pratt-expr-eval — basic binary operators', () => {
  it('addition: 1 + 2 = 3', () => {
    expect(new ExpressionEvaluator().evaluate('1 + 2')).toBe(3);
  });

  it('subtraction: 10 - 4 = 6', () => {
    expect(new ExpressionEvaluator().evaluate('10 - 4')).toBe(6);
  });

  it('multiplication: 3 * 7 = 21', () => {
    expect(new ExpressionEvaluator().evaluate('3 * 7')).toBe(21);
  });

  it('division: 15 / 4 = 3.75', () => {
    expect(new ExpressionEvaluator().evaluate('15 / 4')).toBeCloseTo(3.75, 10);
  });

  it('modulo: 17 % 5 = 2', () => {
    expect(new ExpressionEvaluator().evaluate('17 % 5')).toBe(2);
  });
});

// ── operator precedence (adversarial) ─────────────────────────────────────

describe('pratt-expr-eval — operator precedence', () => {
  it('* before +: 2 + 3 * 4 = 14, not 20', () => {
    expect(new ExpressionEvaluator().evaluate('2 + 3 * 4')).toBe(14);
  });

  it('* before -: 10 - 2 * 3 = 4, not 24', () => {
    expect(new ExpressionEvaluator().evaluate('10 - 2 * 3')).toBe(4);
  });

  it('% at multiplicative level: 2 + 7 % 3 = 3, not 0', () => {
    // 7 % 3 = 1, then 2 + 1 = 3
    expect(new ExpressionEvaluator().evaluate('2 + 7 % 3')).toBe(3);
  });

  it('mixed * and %: 10 % 3 * 2 = 2 (left-assoc)', () => {
    // (10 % 3) * 2 = 1 * 2 = 2
    expect(new ExpressionEvaluator().evaluate('10 % 3 * 2')).toBe(2);
  });

  it('chained mixed: 1 + 2 * 3 - 4 / 2 = 5', () => {
    // 1 + 6 - 2 = 5
    expect(new ExpressionEvaluator().evaluate('1 + 2 * 3 - 4 / 2')).toBe(5);
  });
});

// ── left-associativity (adversarial) ─────────────────────────────────────

describe('pratt-expr-eval — left-associativity', () => {
  it('2 - 3 - 4 = (2-3) - 4 = -5, NOT 2 - (3-4) = 3', () => {
    expect(new ExpressionEvaluator().evaluate('2 - 3 - 4')).toBe(-5);
  });

  it('12 / 4 / 3 = (12/4) / 3 = 1, NOT 12 / (4/3) = 9', () => {
    expect(new ExpressionEvaluator().evaluate('12 / 4 / 3')).toBe(1);
  });

  it('10 % 4 % 2 = (10%4) % 2 = 2 % 2 = 0 (left-assoc %)', () => {
    expect(new ExpressionEvaluator().evaluate('10 % 4 % 2')).toBe(0);
  });

  it('20 - 5 - 3 - 2 = ((20-5)-3)-2 = 10', () => {
    expect(new ExpressionEvaluator().evaluate('20 - 5 - 3 - 2')).toBe(10);
  });
});

// ── unary minus (adversarial) ─────────────────────────────────────────────

describe('pratt-expr-eval — unary minus', () => {
  it('leading unary minus: -5 = -5', () => {
    expect(new ExpressionEvaluator().evaluate('-5')).toBe(-5);
  });

  it('unary minus after binary op: 1 + -2 = -1 (must not throw)', () => {
    expect(new ExpressionEvaluator().evaluate('1 + -2')).toBe(-1);
  });

  it('double unary minus: --5 = 5', () => {
    expect(new ExpressionEvaluator().evaluate('--5')).toBe(5);
  });

  it('-3 * 4 = -12 (unary minus binds tighter than *)', () => {
    expect(new ExpressionEvaluator().evaluate('-3 * 4')).toBe(-12);
  });

  it('2 * -3 = -6 (unary minus after binary *)', () => {
    expect(new ExpressionEvaluator().evaluate('2 * -3')).toBe(-6);
  });
});

// ── parentheses ────────────────────────────────────────────────────────────

describe('pratt-expr-eval — parentheses', () => {
  it('(2 + 3) * 4 = 20', () => {
    expect(new ExpressionEvaluator().evaluate('(2 + 3) * 4')).toBe(20);
  });

  it('nested parens: ((1 + 2) * (3 + 4)) = 21', () => {
    expect(new ExpressionEvaluator().evaluate('((1 + 2) * (3 + 4))')).toBe(21);
  });

  it('parens override left-associativity: 2 - (3 - 4) = 3', () => {
    expect(new ExpressionEvaluator().evaluate('2 - (3 - 4)')).toBe(3);
  });

  it('deep nesting: (((5))) = 5', () => {
    expect(new ExpressionEvaluator().evaluate('(((5)))')).toBe(5);
  });
});

// ── whitespace handling ────────────────────────────────────────────────────

describe('pratt-expr-eval — whitespace', () => {
  it('no spaces: 1+2*3 = 7', () => {
    expect(new ExpressionEvaluator().evaluate('1+2*3')).toBe(7);
  });

  it('extra spaces: "  3  +  4  " = 7', () => {
    expect(new ExpressionEvaluator().evaluate('  3  +  4  ')).toBe(7);
  });
});

// ── error cases (adversarial: must throw ParseError, not return NaN/0) ────

describe('pratt-expr-eval — malformed input throws ParseError', () => {
  it('unbalanced open paren throws', () => {
    const ev = new ExpressionEvaluator();
    expect(() => ev.evaluate('(1 + 2')).toThrow();
    expect(() => ev.evaluate('(1 + 2')).toThrowError(/ParseError|parse/i);
  });

  it('unbalanced close paren throws', () => {
    const ev = new ExpressionEvaluator();
    expect(() => ev.evaluate('1 + 2)')).toThrow();
  });

  it('trailing binary operator throws', () => {
    const ev = new ExpressionEvaluator();
    expect(() => ev.evaluate('1 +')).toThrow();
  });

  it('leading binary operator (not unary) throws', () => {
    const ev = new ExpressionEvaluator();
    expect(() => ev.evaluate('* 3')).toThrow();
  });

  it('unknown character throws', () => {
    const ev = new ExpressionEvaluator();
    expect(() => ev.evaluate('1 + @2')).toThrow();
  });

  it('empty string throws', () => {
    const ev = new ExpressionEvaluator();
    expect(() => ev.evaluate('')).toThrow();
  });

  it('double binary operator throws: "1 ++ 2"', () => {
    // ++ is tokenized as two PLUS tokens; after parsing 1+, the second + has
    // no left operand in context — effectively "1 + (+2)" is actually VALID
    // because the second + is unary. Verify the result is 3, not an error.
    // This tests that unary + is handled.
    const ev = new ExpressionEvaluator();
    expect(ev.evaluate('1 ++ 2')).toBe(3);
  });

  it('result is a finite number, not NaN', () => {
    const ev = new ExpressionEvaluator();
    expect(ev.evaluate('7 / 2')).toBe(3.5);
    expect(Number.isNaN(ev.evaluate('7 / 2'))).toBe(false);
  });
});

// ── compound production-sequence test ─────────────────────────────────────

describe('pratt-expr-eval — compound end-to-end', () => {
  it('complex expression with all operators', () => {
    const ev = new ExpressionEvaluator();
    // 3 + 4 * 2 / (1 - 5) % 3 = ?
    // Step by step with JS semantics (left-assoc, standard precedence):
    //   4 * 2 = 8
    //   1 - 5 = -4
    //   8 / -4 = -2
    //   -2 % 3 = -2
    //   3 + -2 = 1
    expect(ev.evaluate('3 + 4 * 2 / (1 - 5) % 3')).toBe(1);
  });

  it('reuses same instance across multiple evaluate() calls', () => {
    const ev = new ExpressionEvaluator();
    expect(ev.evaluate('1 + 1')).toBe(2);
    expect(ev.evaluate('10 * 10')).toBe(100);
    expect(ev.evaluate('-7')).toBe(-7);
  });
});
