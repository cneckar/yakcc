# Task: CSV Parser with Quoted-Field Handling

Implement a TypeScript function `parseCSV` that parses RFC 4180-compliant CSV text:

```typescript
function parseCSV(input: string, options?: ParseCSVOptions): string[][];

interface ParseCSVOptions {
  delimiter?: string;   // default: ","
  quote?: string;       // default: '"'
  newline?: string;     // default: auto-detect (\r\n or \n)
}
```

## Requirements (RFC 4180 + extensions)

1. **Quoted fields**: A field enclosed in `quote` characters is a quoted field. The surrounding quotes are stripped from the result.
2. **Escaped quotes inside quoted fields**: Two consecutive quote characters inside a quoted field represent a single literal quote character (e.g., `"He said ""hello"""` → `He said "hello"`).
3. **Embedded delimiters**: A quoted field may contain the delimiter character without splitting the record.
4. **Embedded newlines**: A quoted field may span multiple lines. The newline characters within are preserved verbatim in the output value.
5. **Unquoted fields**: Whitespace is significant — do not trim unquoted fields.
6. **Empty fields**: An empty string between two delimiters is a valid empty field (`""` value `""`). A completely empty quoted field (`""`) is also a valid empty field.
7. **Trailing newline**: A trailing `\n` or `\r\n` at the very end of the input does not produce a spurious empty final row.
8. **Single-row, no newline**: `"a,b,c"` → `[["a", "b", "c"]]`.
9. **Completely empty input**: `""` (empty string) → `[]` (empty array, zero rows).
10. **CRLF and LF line endings** must both be supported. CRLF inside a quoted field is preserved.

## Export

Export the function as a named export:

```typescript
export { parseCSV };
export type { ParseCSVOptions };
```

## Notes

- Do not use external libraries. Pure TypeScript, no dependencies.
- The implementation must be a single `.ts` file.
- The parser must be a state machine or equivalent — regex-only approaches often fail corner cases.
