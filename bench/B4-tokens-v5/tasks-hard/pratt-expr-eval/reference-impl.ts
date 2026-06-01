// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/tasks-hard/pratt-expr-eval/reference-impl.ts
//
// Pratt (top-down operator precedence) expression parser + evaluator.
// Supports: + - * / % , unary minus, parentheses, integer + decimal literals.
// Throws ParseError for malformed input.
//
// @decision DEC-BENCH-B4-V5-HARD-TASKS-001
// title: Pratt expression evaluator reference — precedence + error handling trap
// status: accepted
// rationale: Haiku's most reliable failure modes here are:
//   (1) Left-associativity: "2 - 3 - 4" is (2-3)-4 = -5, not 2-(3-4) = 3.
//   (2) Unary minus priority: -2^2 must be -(2^2) but this impl has no ^ so
//       the trap is "-3 * 4" = (-3)*4 = -12, not -(3*4) = -12 (same here).
//       The real trap is unary minus binding: "-2 ** 2" if ^ were present.
//       For this subset the trap is more subtle — Haiku often misparses
//       "1 + -2" (unary minus after binary op) as a syntax error.
//   (3) Error propagation: Haiku returns NaN / 0 instead of throwing on
//       unbalanced parens, trailing operators, or unknown characters.
//   (4) Operator precedence: % at the same level as * / (Haiku sometimes
//       puts % at the additive level).
//   (5) Decimal literals: Haiku commonly parseInt()s the input, truncating
//       decimals, or handles "3.14" but not ".5" or "1.".

/** Thrown for any parse error. Message describes the problem and position. */
export class ParseError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`ParseError at position ${position}: ${message}`);
    this.name = 'ParseError';
  }
}

// ── Token types ────────────────────────────────────────────────────────────

type TokType =
  | 'NUMBER'
  | 'PLUS'
  | 'MINUS'
  | 'STAR'
  | 'SLASH'
  | 'PERCENT'
  | 'LPAREN'
  | 'RPAREN'
  | 'EOF';

interface Token {
  type: TokType;
  value: string;
  pos: number;
}

// ── Lexer ──────────────────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    // Number: optional leading dot, digits, optional decimal point + digits
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < input.length && input[i] >= '0' && input[i] <= '9') i++;
      if (i < input.length && input[i] === '.') {
        i++;
        while (i < input.length && input[i] >= '0' && input[i] <= '9') i++;
      }
      tokens.push({ type: 'NUMBER', value: input.slice(start, i), pos: start });
      continue;
    }

    // Number starting with a decimal point: ".5"
    if (ch === '.') {
      const start = i;
      i++;
      if (i >= input.length || input[i] < '0' || input[i] > '9') {
        throw new ParseError('Expected digit after decimal point', start);
      }
      while (i < input.length && input[i] >= '0' && input[i] <= '9') i++;
      tokens.push({ type: 'NUMBER', value: input.slice(start, i), pos: start });
      continue;
    }

    // Single-character tokens
    if (ch === '+') { tokens.push({ type: 'PLUS',    value: '+', pos: i++ }); continue; }
    if (ch === '-') { tokens.push({ type: 'MINUS',   value: '-', pos: i++ }); continue; }
    if (ch === '*') { tokens.push({ type: 'STAR',    value: '*', pos: i++ }); continue; }
    if (ch === '/') { tokens.push({ type: 'SLASH',   value: '/', pos: i++ }); continue; }
    if (ch === '%') { tokens.push({ type: 'PERCENT', value: '%', pos: i++ }); continue; }
    if (ch === '(') { tokens.push({ type: 'LPAREN',  value: '(', pos: i++ }); continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN',  value: ')', pos: i++ }); continue; }

    throw new ParseError(`Unexpected character '${ch}'`, i);
  }

  tokens.push({ type: 'EOF', value: '', pos: i });
  return tokens;
}

// ── Pratt parser ───────────────────────────────────────────────────────────
//
// Binding power table (higher = tighter):
//   additive:       + -    left  bp = 10
//   multiplicative: * / %  left  bp = 20
//   unary minus:           right bp = 30 (prefix)

/** Left binding power for infix operators. */
function infixBP(type: TokType): number {
  if (type === 'PLUS' || type === 'MINUS')    return 10;
  if (type === 'STAR' || type === 'SLASH' || type === 'PERCENT') return 20;
  return 0; // not an infix operator
}

class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokType): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new ParseError(
        `Expected ${type} but got '${tok.value || tok.type}'`,
        tok.pos,
      );
    }
    return this.consume();
  }

  /** Parse an expression with left-binding-power floor of minBP. */
  parseExpr(minBP: number = 0): number {
    // ── prefix / nud ────────────────────────────────────────────────
    const tok = this.consume();
    let left: number;

    if (tok.type === 'NUMBER') {
      left = parseFloat(tok.value);
    } else if (tok.type === 'MINUS') {
      // Unary minus: right-associative, bp = 30
      const operand = this.parseExpr(30);
      left = -operand;
    } else if (tok.type === 'PLUS') {
      // Unary plus (identity)
      left = this.parseExpr(30);
    } else if (tok.type === 'LPAREN') {
      left = this.parseExpr(0);
      this.expect('RPAREN');
    } else {
      throw new ParseError(
        `Unexpected token '${tok.value || tok.type}' in expression`,
        tok.pos,
      );
    }

    // ── infix / led ─────────────────────────────────────────────────
    while (true) {
      const op = this.peek();
      const bp = infixBP(op.type);
      // Left-associative: continue only if bp > minBP (strict >).
      // This ensures left-associativity: "2 - 3 - 4" → (2-3) - 4.
      if (bp <= minBP) break;
      this.consume(); // eat the operator
      const right = this.parseExpr(bp); // bp as new floor → left-assoc
      switch (op.type) {
        case 'PLUS':    left = left + right; break;
        case 'MINUS':   left = left - right; break;
        case 'STAR':    left = left * right; break;
        case 'SLASH':   left = left / right; break;
        case 'PERCENT': left = left % right; break;
        default:
          throw new ParseError(`Unknown operator '${op.value}'`, op.pos);
      }
    }

    return left;
  }

  parse(): number {
    const result = this.parseExpr(0);
    const eof = this.peek();
    if (eof.type !== 'EOF') {
      throw new ParseError(
        `Unexpected token '${eof.value}' after expression`,
        eof.pos,
      );
    }
    return result;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Arithmetic expression evaluator.
 *
 * Operators (in ascending precedence order):
 *   +  -  (additive, left-associative)
 *   *  /  %  (multiplicative, left-associative)
 *   unary -  (prefix, right-associative, highest)
 *
 * Parentheses group sub-expressions.
 * Integer and decimal literals (including leading-dot form like ".5").
 * Throws ParseError on malformed input.
 */
export class ExpressionEvaluator {
  /**
   * Evaluate an arithmetic expression string and return the numeric result.
   * @throws {ParseError} for unbalanced parentheses, trailing operators,
   *   unknown characters, or other malformed input.
   */
  evaluate(expr: string): number {
    const tokens = tokenize(expr);
    const parser = new Parser(tokens);
    return parser.parse();
  }
}
