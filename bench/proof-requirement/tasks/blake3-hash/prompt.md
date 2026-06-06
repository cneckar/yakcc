Implement the BLAKE3 cryptographic hash function in pure JavaScript (no WASM, no native modules).

Produce a 32-byte (256-bit) digest from an arbitrary-length `Uint8Array` input.

Export a **single class**:

```typescript
export class Blake3 {
  /** Hash `data` and return a 32-byte Uint8Array digest. */
  static hash(data: Uint8Array): Uint8Array;

  /** Streaming interface: accumulate chunks and call digest() once. */
  update(chunk: Uint8Array): this;
  digest(): Uint8Array;
  reset(): void;
}
```

Constraints:
- No external libraries. Pure JS only.
- BLAKE3 is NOT BLAKE2. Use BLAKE3's specific constants, IV, G function, and chunk/parent domain separators.
- The IV is the SHA-256 initialization constants (first 8 × 32-bit words of the fractional parts of the square roots of the first 8 primes).
- Domain flags: `CHUNK_START = 1`, `CHUNK_END = 2`, `PARENT = 4`, `ROOT = 8`.
- Each chunk is 1024 bytes; each block is 64 bytes (16 × 32-bit words).
- The compression function uses the BLAKE3 permutation schedule (not BLAKE2's).

Test vector (from the official BLAKE3 test vectors at github.com/BLAKE3-team/BLAKE3/blob/master/test_vectors/test_vectors.json):
- `Blake3.hash(new Uint8Array(0))` → first 8 bytes: `[0xaf, 0x13, 0x49, 0xb9, 0xf5, 0xf9, 0xa1, 0xa6]`
- `Blake3.hash(new Uint8Array(1).fill(0))` → first 8 bytes: `[0x2d, 0x3a, 0xde, 0xdf, 0xf1, 0x1b, 0x61, 0xf1]`
