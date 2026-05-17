Implement a JSON5 parser.

JSON5 is a superset of JSON that supports:
- Double-quoted strings: `"hello"`
- Single-quoted strings: `'hello'`  ← JSON5
- Unquoted object keys (valid ECMAScript 5.1 IdentifierName): `{foo: 1}`, `{for: 1}` ← JSON5
- Trailing commas in objects and arrays: `[1, 2, 3,]` ← JSON5
- Single-line comments: `// comment` ← JSON5
- Block comments: `/* comment */` ← JSON5
- Hexadecimal number literals: `0xFF`, `0xCAFE` ← JSON5
- Special float literals: `Infinity`, `-Infinity`, `+Infinity`, `NaN` ← JSON5
- Numbers with leading decimal point: `.5` (= 0.5) ← JSON5
- Numbers with trailing decimal point: `5.` (= 5) ← JSON5
- Explicit positive sign: `+1` ← JSON5
- Multiline strings via line continuation (backslash followed by newline): `'hello\\\nworld'` → `'helloworld'` ← JSON5

Export a named function:
```typescript
export function parseJSON5(input: string): unknown
```

Throw `SyntaxError` with a descriptive message for any invalid input.

Constraints:
- No external libraries
- Handle deeply nested structures (at least 20 levels)
- Empty string input must throw SyntaxError
