Implement RFC 4648 Base32 encoding and decoding.

RFC 4648 §6 Base32 uses the alphabet `ABCDEFGHIJKLMNOPQRSTUVWXYZ234567` (26 upper-case letters +
digits 2–7). This is **NOT** Base32Hex (which uses `0-9A-V`) and **NOT** Base64.

Export a **single class**:

```typescript
export class Base32Codec {
  /**
   * Encode raw bytes to a Base32 string.
   * Output is upper-case; padding characters `=` are appended to make the
   * output length a multiple of 8.
   * Empty input → empty string.
   */
  encode(input: Uint8Array): string;

  /**
   * Decode a Base32 string to raw bytes.
   * Accepts both upper-case and lower-case input.
   * Trailing `=` padding characters are stripped before decoding.
   * Throws TypeError for characters outside the Base32 alphabet (after case-fold).
   * Throws TypeError for an input length (after stripping padding) that is
   * impossible under RFC 4648 (lengths 1, 3, 6 mod 8 are invalid).
   */
  decode(input: string): Uint8Array;
}
```

Encoding group sizes (5-bit groups):
- 1 byte  → 2 Base32 chars + 6 padding `=`
- 2 bytes → 4 Base32 chars + 4 padding `=`
- 3 bytes → 5 Base32 chars + 3 padding `=`
- 4 bytes → 7 Base32 chars + 1 padding `=`
- 5 bytes → 8 Base32 chars + 0 padding

Constraints:
- No external libraries.
- No `Buffer` or `atob`/`btoa`.
