Implement a Pratt (top-down operator precedence) expression parser and evaluator.

Export **two named classes**:

```typescript
/** Thrown for any parse error. */
export class ParseError extends Error {
  constructor(message: string, public readonly position: number);
}

export class ExpressionEvaluator {
  /**
   * Evaluate an arithmetic expression string and return a number.
   * @throws {ParseError} on malformed input.
   */
  evaluate(expr: string): number;
}
```

**Supported syntax:**
- Integer and decimal literals: `42`, `3.14`, `.5`
- Binary operators (left-associative): `+` `-` `*` `/` `%`
- Unary minus (prefix): `-3`, `1 + -2`
- Parentheses for grouping: `(2 + 3) * 4`
- Whitespace is insignificant.

**Precedence (low → high):**
1. `+` `-` (additive)
2. `*` `/` `%` (multiplicative)
3. Unary `-` (prefix, highest)

**Left-associativity requirement:** `2 - 3 - 4` must evaluate as `(2 - 3) - 4 = -5`, not `2 - (3 - 4) = 3`. Same for `/` and `%`.

**Error handling:** Throw `ParseError` (never return `NaN` or `0`) for:
- Unbalanced parentheses
- Trailing operator: `1 +`
- Unknown character: `1 + @2`
- Empty input

Constraints:
- No external libraries, no `eval()`.
- Use a Pratt / recursive-descent parser (NOT a two-stack shunting-yard algorithm).
- The parser must handle unary minus appearing after a binary operator: `1 + -2` is valid and equals `-1`.

**Adversarial trap:** Weak models commonly:
1. Get left-associativity wrong for subtraction/division: they right-associate giving `2 - 3 - 4 = 3`.
2. Reject `1 + -2` as a syntax error instead of treating the second `-` as unary.
3. Place `%` at additive precedence (same level as `+`), giving wrong results for `2 + 7 % 3`.
4. Return `NaN` or `0` for malformed input instead of throwing a typed error.
5. Use `parseInt` instead of `parseFloat`, silently truncating decimal literals.
