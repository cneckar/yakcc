# Task: Base64 Encode (RFC 4648)

Implement a TypeScript function `base64Encode` that encodes a `Uint8Array` to a Base64 string per RFC 4648 §4:

```typescript
function base64Encode(input: Uint8Array, options?: Base64EncodeOptions): string;

interface Base64EncodeOptions {
  padding?: boolean;  // default: true — include '=' padding characters
  urlSafe?: boolean;  // default: false — use standard alphabet (+/) not URL-safe alphabet (-_)
}
```

## Requirements

1. **RFC 4648 §4 standard alphabet**: Use exactly this 64-character alphabet:
   `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/`
   Index 62 is `+`, index 63 is `/`. Do not use any other character at these positions.
2. **RFC 4648 §5 URL-safe alphabet** (when `urlSafe: true`): Replace `+` with `-` and `/` with `_`.
3. **Padding**: When `padding: true` (default), pad the output to a multiple of 4 characters using `=`.
   When `padding: false`, omit trailing `=` characters.
4. **Input encoding**: Each 3 bytes of input produce 4 Base64 characters. The last group may be 1 or 2 bytes:
   - 1 remaining byte → 2 Base64 chars + `==` (or just 2 chars if `padding: false`)
   - 2 remaining bytes → 3 Base64 chars + `=` (or just 3 chars if `padding: false`)
5. **Empty input**: `base64Encode(new Uint8Array([]))` → `""`.
6. **All byte values 0–255**: Must encode all byte values correctly, including 0x00 (null byte).
7. **No built-in base64 functions**: Do not use `btoa`, `Buffer.from(..., "base64")`, `atob`, or any other runtime-provided base64 encoding. Implement the encoding algorithm directly from the bit manipulation.

## Export

Export the function and interface as named exports:

```typescript
export { base64Encode };
export type { Base64EncodeOptions };
```

## Notes

- Do not use external libraries. Pure TypeScript, no dependencies.
- The implementation must be a single `.ts` file.
- Input is always a `Uint8Array` (not a string).
