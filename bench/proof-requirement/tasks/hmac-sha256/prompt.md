Implement HMAC-SHA256 in pure JavaScript. Include a complete SHA-256 implementation (no `crypto` module).

Export a **single class**:

```typescript
export class HmacSha256 {
  /** Compute HMAC-SHA256 of `message` using `key`. Both are raw bytes (Uint8Array).
   *  Returns a 32-byte Uint8Array digest. */
  static sign(key: Uint8Array, message: Uint8Array): Uint8Array;

  /** Streaming interface. */
  constructor(key: Uint8Array);
  update(chunk: Uint8Array): this;
  digest(): Uint8Array;
}
```

Constraints:
- No `crypto` module, no `SubtleCrypto`, no external libraries.
- SHA-256 must implement all 64 rounds with the correct K constants and initial hash values.
- HMAC: `HMAC(K, m) = H((K' ⊕ opad) ‖ H((K' ⊕ ipad) ‖ m))` where:
  - K' = K if len(K) ≤ 64; K' = H(K) otherwise; then zero-pad K' to 64 bytes.
  - `ipad` = 0x36 repeated 64 times; `opad` = 0x5C repeated 64 times.

Test vectors (RFC 4231 §4.2):
- `key = new Uint8Array(20).fill(0x0b)`  
  `message = new TextEncoder().encode("Hi There")`  
  expected digest (hex): `b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7`
- `key = new TextEncoder().encode("Jefe")`  
  `message = new TextEncoder().encode("what do ya want for nothing?")`  
  expected digest (hex): `5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964a72002`
