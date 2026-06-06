Implement a two-step compound operation: SHA-256 hash a payload, then Base64URL-encode the raw digest bytes.

This is the canonical `per_block` benchmark task: it composes two distinct generic operations,
each of which should be resolved separately from the registry:
- **Sub-intent A**: SHA-256 hash a `Uint8Array` to a 32-byte digest  (proof_requirement: `required`)
- **Sub-intent B**: Base64URL-encode the 32-byte `Uint8Array`        (proof_requirement: `preferred`)

Export a **single class**:

```typescript
export class HashAndEncode {
  /** Compute SHA-256(data) then Base64URL-encode the 32-byte digest. Returns a string. */
  static compute(data: Uint8Array): string;
}
```

Constraints:
- No `crypto` module. No external libraries. Pure JS.
- SHA-256: correct 64-round implementation with standard K constants.
- Base64URL: URL-safe alphabet (`-` for 62, `_` for 63), padded output.
- The output string is 44 characters long (32 bytes × 4/3 = 42.67 → 44 with padding).

Test vector:
- `HashAndEncode.compute(new Uint8Array(0))`
  SHA-256 of empty → `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
  Base64URL of those 32 bytes → `47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=`
- `HashAndEncode.compute(new TextEncoder().encode("hello"))`
  SHA-256("hello") → `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`
  Base64URL → `LPJNul-wow4TNtCmk6kf7ADIa1a_qFQTFCDq0GVq1mg=`
