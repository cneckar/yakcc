# Task: JSON Pointer Resolve (RFC 6901)

Implement a TypeScript function `jsonPointerResolve` that resolves an RFC 6901 JSON Pointer against a JSON document:

```typescript
function jsonPointerResolve(doc: unknown, pointer: string): unknown;
```

## Requirements

1. **RFC 6901 compliance**: Implement the full JSON Pointer specification (RFC 6901) including escape sequences.
2. **Empty pointer**: The empty string `""` refers to the whole document — return `doc` unchanged.
3. **Pointer format**: A non-empty pointer MUST start with `/`. Each `/` separates reference tokens.
4. **Escape sequences** (critical correctness requirement):
   - `~1` in a reference token is decoded to `/` BEFORE using the token as a key.
   - `~0` in a reference token is decoded to `~` BEFORE using the token as a key.
   - Decode order: `~1` first, then `~0` — this prevents `~01` from being decoded as `/` instead of `~1`.
   - `~` followed by any character other than `0` or `1` is an error — throw an `Error`.
5. **Array indexing**: When the current value is an array, the reference token must be a non-negative integer (no leading zeros except for `"0"` itself) or the special token `"-"` (refers to the element after the last, which is always out of bounds — throw `Error`).
6. **Object key lookup**: When the current value is a plain object, use the decoded reference token as the key.
7. **Error conditions** — throw a typed `Error` with a descriptive message for:
   - Pointer does not start with `/` (and is not empty `""`)
   - Invalid escape sequence (`~` followed by non-0/1 character)
   - Reference token is a non-integer string when indexing an array (unless `"-"`)
   - Reference token has leading zeros (e.g., `"01"`) when indexing an array
   - `-` token on an array (always out of bounds)
   - Key or index not found in the current value
   - Current value is a primitive and there are more reference tokens to resolve

## Export

Export the function as a named export:

```typescript
export { jsonPointerResolve };
```

## Notes

- Do not use external libraries. Pure TypeScript, no dependencies.
- The implementation must be a single `.ts` file.
- The function should handle all JSON-compatible input types: objects, arrays, strings, numbers, booleans, and null.
