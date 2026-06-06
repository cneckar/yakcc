Implement RFC 4648 §5 Base64URL encode/decode (URL-safe variant).

Use the **URL-safe alphabet**: characters 62 and 63 are `-` and `_` (NOT `+` and `/`).
Padding character is `=`; strict-padding mode: reject inputs whose length mod 4 is 1.

Export a **single class**:

```typescript
export class Base64Codec {
  /** Encode a Uint8Array to a Base64URL string (with padding). */
  encode(data: Uint8Array): string;
  /** Decode a Base64URL string to a Uint8Array.
   *  Throws if the input contains invalid characters or invalid padding length. */
  decode(input: string): Uint8Array;
}
```

Constraints:
- No native `atob` / `btoa` (those use the standard alphabet, not URL-safe).
- No external libraries.
- `encode` always produces padded output.
- `decode` must accept both padded and un-padded input.
- Reject characters outside the Base64URL alphabet (throw `RangeError`).
- Input length mod 4 === 1 is always invalid — throw `RangeError`.

Test vectors (RFC 4648 §10, URL-safe alphabet):
- `encode(new Uint8Array([]))` → `""`
- `encode(new Uint8Array([0x14, 0xfb, 0x9c, 0x03, 0xd9, 0x7e]))` → `"FPucA9l-"`
  (note `-` in position 7, not `/`)
- `decode("FPucA9l-")` → `Uint8Array [0x14, 0xfb, 0x9c, 0x03, 0xd9, 0x7e]`
