# Task: JWT HS256 Verification

Implement a TypeScript function that verifies a JWT (JSON Web Token) signed with the HMAC-SHA256 algorithm (HS256).

```typescript
export function verifyHs256(
  token: string,
  secret: string,
): VerifyResult;

interface VerifyResult {
  valid: boolean;
  payload?: Record<string, unknown>;
  header?: Record<string, unknown>;
  reason?: string;
}
```

## Requirements

### Input

- `token`: A JWT string in the standard three-part format `header.payload.signature`, where each part is base64url-encoded (no padding, using `-` and `_` instead of `+` and `/`).
- `secret`: The HMAC secret key as a UTF-8 string.

### Verification steps (in order)

1. **Structural check**: Split `token` on `.`. Reject if there are not exactly 3 non-empty parts.
2. **Header decode**: Base64url-decode part 0 and JSON-parse it. Reject if decoding fails.
3. **Algorithm check**: Verify `header.alg === "HS256"`. Reject tokens with `alg: "none"`, `alg: "RS256"`, or any algorithm other than `"HS256"` — even if the signature would otherwise match.
4. **Payload decode**: Base64url-decode part 1 and JSON-parse it. Reject if decoding fails.
5. **Signature verification**: Compute `HMAC-SHA256(secret, headerPart + "." + payloadPart)` where `headerPart` and `payloadPart` are the ORIGINAL base64url strings from the token (not re-encoded). Compare using a **constant-time comparison** (`crypto.timingSafeEqual`). Reject if signature does not match.
6. **Expiry check**: If `payload.exp` is present (a Unix timestamp in seconds), reject the token if `Math.floor(Date.now() / 1000) >= payload.exp` (i.e., the token has expired).

### Return value

- On success: `{ valid: true, header, payload }`
- On failure: `{ valid: false, reason: "<brief description of failure>" }`

## Constraints

- Use only Node.js built-ins (`node:crypto`). No external JWT libraries.
- Use `Buffer.from(x, "base64url")` for base64url decoding (available since Node 16).
- The HMAC signature input is the original header and payload strings as they appear in the token (concatenated with `.`), NOT decoded and re-encoded values.
- Signature comparison MUST use `crypto.timingSafeEqual` to prevent timing oracle attacks.
- The implementation must be a single `.ts` file.

## Export

Named export:

```typescript
export { verifyHs256 };
export type { VerifyResult };
```

## Notes

- The `alg: "none"` attack vector (CVE-class): a tampered token claiming `alg: "none"` with no signature must be rejected.
- The HMAC input canonical form: sign `base64url(header) + "." + base64url(payload)` using the literal strings from the token, preserving any padding differences or non-canonical encoding in the source token.
- Missing or non-numeric `exp` field: if `payload.exp` is absent, do not reject for expiry. If `payload.exp` is present but not a number, reject with a reason.
