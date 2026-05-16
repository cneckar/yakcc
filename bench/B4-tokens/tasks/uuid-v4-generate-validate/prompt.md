# Task: UUID v4 Generation and Validation

Implement a TypeScript module with two exported functions:

```typescript
/** Generate a cryptographically random RFC 4122 version-4 UUID. */
export function generateV4(): string;

/**
 * Validate that `input` is a correctly-formed UUID string.
 * Accepts v1–v8 and NIL UUID (all-zeros).
 * Returns true only for the canonical lowercase 36-character form:
 * xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx
 * where M is the version nibble (1–8 or 0 for NIL) and
 * N is the variant nibble (8–b for RFC 4122 variant, or 0 for NIL).
 */
export function validateV4(input: string): boolean;
```

## Requirements

### `generateV4()`

1. **RFC 4122 §4.4 structure**: Output is a 36-character string in the form
   `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` where:
   - All `x` positions are random hex digits (lowercase).
   - Position 14 (version nibble, 0-indexed in the hex stream) is `4`.
   - Position 19 (variant nibble) is one of `8`, `9`, `a`, or `b`
     (i.e., the two high bits of that byte are `10`).
   - Four dashes appear at positions 8, 13, 18, 23 in the output string.
2. **Cryptographic RNG**: Use `crypto.randomBytes` (Node.js built-in).
   Do NOT use `Math.random()`.
3. **Lowercase output only**: All hex digits must be lowercase.

### `validateV4(input: string): boolean`

Validate that `input` is a syntactically valid UUID per RFC 4122:

1. **Canonical form only**: Must be exactly 36 characters, lowercase hex
   separated by dashes at positions 8, 13, 18, 23.
2. **Version nibble** (character at index 14 of the input string): must
   be a digit 0–8 (0 for NIL, 1–8 for RFC versions).
3. **Variant nibble** (character at index 19 of the input string):
   - For NIL UUID (`00000000-0000-0000-0000-000000000000`): `0` is accepted.
   - For all other UUIDs: must be `8`, `9`, `a`, or `b` (RFC 4122 variant).
4. **Reject non-canonical forms**:
   - Uppercase hex digits → `false`
   - Missing or extra dashes → `false`
   - Curly-brace wrapping (`{...}`) → `false`
   - URN prefix (`urn:uuid:...`) → `false`
   - Wrong length → `false`
   - Wrong version nibble (e.g., `f`) → `false`
   - Wrong variant nibble (e.g., `c`, `d`, `e`, `f`) for non-NIL UUIDs → `false`

## Export

Named exports only:

```typescript
export { generateV4, validateV4 };
```

## Notes

- Use only Node.js built-ins (`node:crypto`). No external libraries.
- The implementation must be a single `.ts` file.
- `validateV4` is intentionally broader than "v4 only": it accepts valid
  UUIDs of any version (the name reflects the primary use-case pairing with
  `generateV4`, not a restriction to v4-only validation).
