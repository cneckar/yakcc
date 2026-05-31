Implement CRC-32C (Castagnoli) checksum.

CRC-32C uses the **Castagnoli polynomial** `0x82F63B78` (reflected), which is DIFFERENT from the
common CRC-32 (Ethernet) polynomial `0xEDB88320`. This distinction matters — using the wrong
polynomial produces silently incorrect checksums.

Export a **single class**:

```typescript
export class CRC32C {
  /** Accumulate more data into the running checksum. Returns `this` for chaining. */
  update(data: Uint8Array | string): this;
  /** Return the finalized 32-bit unsigned checksum as a decimal number. */
  digest(): number;
  /** Reset to initial state (all-ones seed). */
  reset(): void;
  /** Return a new CRC32C instance with the same internal state. */
  clone(): CRC32C;
}
```

Constraints:
- No external libraries.
- `string` inputs to `update()` must be UTF-8 encoded before processing (use `TextEncoder` for this step only).
- `digest()` must NOT mutate internal state; calling `digest()` twice returns the same value.
- After `reset()` the instance behaves as freshly constructed.
- Initial seed is `0xFFFFFFFF`; final XOR is `0xFFFFFFFF`.
- The lookup table must be computed from the **Castagnoli polynomial** (`0x82F63B78`), not CRC-32.
- Return value of `digest()` is an unsigned 32-bit integer.

Test vector: `CRC32C` of the ASCII string `"123456789"` is `0xE3069283` (3541077635 decimal).
