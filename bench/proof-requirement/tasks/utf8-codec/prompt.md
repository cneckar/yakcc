Implement a UTF-8 encoder and decoder **without** using the built-in `TextEncoder` or `TextDecoder` APIs.

Export a **single class**:

```typescript
export class Utf8Codec {
  /**
   * Encode a JavaScript string to UTF-8 bytes.
   * Handles surrogate pairs (U+10000–U+10FFFF) via the standard 4-byte encoding.
   */
  encode(str: string): Uint8Array;

  /**
   * Decode a UTF-8 byte sequence to a JavaScript string.
   * Throws TypeError for invalid byte sequences:
   *   - Unexpected continuation bytes
   *   - Truncated multi-byte sequences at end of input
   *   - Overlong encodings (e.g. 0xC0 0x80 for U+0000)
   *   - Bytes that decode to surrogate code points (U+D800–U+DFFF)
   *   - Code points above U+10FFFF
   */
  decode(bytes: Uint8Array): string;
}
```

UTF-8 encoding rules:
- U+0000–U+007F: 1 byte `0xxxxxxx`
- U+0080–U+07FF: 2 bytes `110xxxxx 10xxxxxx`
- U+0800–U+FFFF: 3 bytes `1110xxxx 10xxxxxx 10xxxxxx` (excluding U+D800–U+DFFF surrogates)
- U+10000–U+10FFFF: 4 bytes `11110xxx 10xxxxxx 10xxxxxx 10xxxxxx`

For surrogate pairs in the JavaScript string (U+D800–U+DFFF):
- A valid surrogate pair (high + low) encodes the supplementary code point as 4 UTF-8 bytes.
- An unpaired surrogate (no corresponding low/high surrogate) should be encoded as the
  CESU-8 3-byte sequence for that code point (lenient behavior matching what `TextEncoder` does).

Constraints:
- No `TextEncoder`, `TextDecoder`, `Buffer`, or other encoding APIs.
- No external libraries.
