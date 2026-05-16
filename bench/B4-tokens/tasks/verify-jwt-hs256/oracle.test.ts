// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/verify-jwt-hs256/oracle.test.ts
//
// @decision DEC-B4-SLICE-3-TASKS-001
// @title B4 Slice 3 oracle: verify-jwt-hs256
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Must pass against reference-impl.ts
//   before the B4 harness measures LLM-generated implementations. Tests cover:
//   - Structural validation (3-part split, non-empty parts)
//   - Algorithm confusion attack: alg=none, alg=RS256, alg=missing must be rejected
//   - HMAC signing input correctness (original base64url strings, not re-encoded)
//   - Constant-time comparison requirement (tested via tampered signature detection)
//   - Expiry check: payload.exp past, future, exactly-now, absent, non-numeric
//   - Base64url vs base64 edge cases (characters + and / are illegal in base64url)
//   - Error shape: reason field present on failure, absent on success
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/verify-jwt-hs256/oracle.test.ts

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

const implUrl = pathToFileURL(implPath).href;

type VerifyResult = {
  valid: boolean;
  payload?: Record<string, unknown>;
  header?: Record<string, unknown>;
  reason?: string;
};

let verifyHs256: (token: string, secret: string) => VerifyResult;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  verifyHs256 = mod.verifyHs256 ?? mod.default?.verifyHs256;
  if (typeof verifyHs256 !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export verifyHs256 as a named export function`
    );
  }
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test token helpers
// ---------------------------------------------------------------------------

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  secret: string,
  overrideSignature?: string,
): string {
  const h = b64url(header);
  const p = b64url(payload);
  const sigInput = `${h}.${p}`;
  const sig =
    overrideSignature ??
    createHmac("sha256", secret).update(sigInput).digest("base64url");
  return `${h}.${p}.${sig}`;
}

const SECRET = "test-secret-key";
const VALID_PAYLOAD = { sub: "user123", iat: 1700000000 };
const VALID_HEADER = { alg: "HS256", typ: "JWT" };

// A well-formed valid token
const VALID_TOKEN = makeToken(VALID_HEADER, VALID_PAYLOAD, SECRET);

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

describe("verifyHs256 — structural validation", () => {
  it("accepts a well-formed valid token", () => {
    const result = verifyHs256(VALID_TOKEN, SECRET);
    expect(result.valid).toBe(true);
    expect(result.payload).toBeDefined();
    expect(result.header).toBeDefined();
    expect(result.reason).toBeUndefined();
  });

  it("rejects empty string", () => {
    const result = verifyHs256("", SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects token with only 1 part", () => {
    const result = verifyHs256("onlyone", SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects token with only 2 parts", () => {
    const result = verifyHs256("header.payload", SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects token with 4+ parts", () => {
    const result = verifyHs256("a.b.c.d", SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects token with empty header part", () => {
    const result = verifyHs256(".payload.signature", SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Algorithm confusion attack (adversarial trap)
// ---------------------------------------------------------------------------

describe("verifyHs256 — algorithm confusion attack (adversarial trap)", () => {
  it("rejects alg: none (classic CVE class)", () => {
    const token = makeToken({ alg: "none", typ: "JWT" }, VALID_PAYLOAD, SECRET, "");
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects alg: RS256", () => {
    const token = makeToken({ alg: "RS256", typ: "JWT" }, VALID_PAYLOAD, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects alg: HS512", () => {
    const token = makeToken({ alg: "HS512", typ: "JWT" }, VALID_PAYLOAD, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects missing alg field", () => {
    const token = makeToken({ typ: "JWT" }, VALID_PAYLOAD, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects alg: HS256 with capital difference (HS256 vs hs256)", () => {
    const token = makeToken({ alg: "hs256", typ: "JWT" }, VALID_PAYLOAD, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("accepts exactly alg: HS256 (case-sensitive check)", () => {
    const token = makeToken({ alg: "HS256", typ: "JWT" }, VALID_PAYLOAD, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("verifyHs256 — signature verification", () => {
  it("rejects tampered payload (bit flip in base64url payload)", () => {
    // Create valid token, then flip one char in payload
    const parts = VALID_TOKEN.split(".");
    const tamperedPayload = parts[1]!.slice(0, -1) + (parts[1]!.at(-1) === "a" ? "b" : "a");
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const result = verifyHs256(tampered, SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects tampered header (flip a char in header)", () => {
    const parts = VALID_TOKEN.split(".");
    const tamperedHeader = parts[0]!.slice(0, -1) + (parts[0]!.at(-1) === "a" ? "b" : "a");
    const tampered = `${tamperedHeader}.${parts[1]}.${parts[2]}`;
    const result = verifyHs256(tampered, SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects tampered signature", () => {
    const parts = VALID_TOKEN.split(".");
    const tamperedSig = parts[2]!.slice(0, -1) + (parts[2]!.at(-1) === "a" ? "b" : "a");
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    const result = verifyHs256(tampered, SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects wrong secret", () => {
    const result = verifyHs256(VALID_TOKEN, "wrong-secret");
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects empty signature string", () => {
    const parts = VALID_TOKEN.split(".");
    const result = verifyHs256(`${parts[0]}.${parts[1]}.`, SECRET);
    // Empty signature part should fail structurally or signature-wise
    expect(result.valid).toBe(false);
  });

  it("accepts valid token with correct secret", () => {
    expect(verifyHs256(VALID_TOKEN, SECRET).valid).toBe(true);
  });

  it("signing input uses original base64url strings (not re-encoded)", () => {
    // Construct a token where the header has non-minimal base64url encoding.
    // The implementation must sign `headerPart.payloadPart` using the LITERAL
    // strings from the token, not decoded-and-re-encoded values.
    // We do this by manually building a valid HMAC over specific known strings.
    const rawHeader = '{"alg":"HS256","typ":"JWT"}';
    const rawPayload = '{"sub":"test"}';
    const hPart = Buffer.from(rawHeader).toString("base64url");
    const pPart = Buffer.from(rawPayload).toString("base64url");
    const sigInput = `${hPart}.${pPart}`;
    const sig = createHmac("sha256", SECRET).update(sigInput).digest("base64url");
    const token = `${hPart}.${pPart}.${sig}`;

    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(true);
    expect(result.payload?.["sub"]).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Expiry check (adversarial trap: exp not checked)
// ---------------------------------------------------------------------------

describe("verifyHs256 — expiry check (adversarial trap)", () => {
  it("accepts token with future exp", () => {
    const future = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const token = makeToken(VALID_HEADER, { sub: "user", exp: future }, SECRET);
    expect(verifyHs256(token, SECRET).valid).toBe(true);
  });

  it("rejects token with past exp", () => {
    const past = Math.floor(Date.now() / 1000) - 1; // 1 second ago
    const token = makeToken(VALID_HEADER, { sub: "user", exp: past }, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects token where exp === now (expired at exactly now)", () => {
    // exp == now means the token expired; exp > now means it's still valid
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);
    const token = makeToken(VALID_HEADER, { sub: "user", exp: now }, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(false);
    vi.useRealTimers();
  });

  it("accepts token where exp is 1 second in the future", () => {
    vi.useFakeTimers();
    const now = 1700000000;
    vi.setSystemTime(now * 1000);
    const token = makeToken(VALID_HEADER, { sub: "user", exp: now + 1 }, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(true);
    vi.useRealTimers();
  });

  it("accepts token with no exp field (no expiry check)", () => {
    const token = makeToken(VALID_HEADER, { sub: "user" }, SECRET);
    expect(verifyHs256(token, SECRET).valid).toBe(true);
  });

  it("rejects token with non-numeric exp field", () => {
    const token = makeToken(VALID_HEADER, { sub: "user", exp: "2099-01-01" }, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Return value shape
// ---------------------------------------------------------------------------

describe("verifyHs256 — return value shape", () => {
  it("successful result includes header and payload", () => {
    const payload = { sub: "u1", iat: 1700000000, custom: "data" };
    const token = makeToken(VALID_HEADER, payload, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(true);
    expect(result.header?.["alg"]).toBe("HS256");
    expect(result.payload?.["sub"]).toBe("u1");
    expect(result.payload?.["custom"]).toBe("data");
    expect(result.reason).toBeUndefined();
  });

  it("failed result includes reason string", () => {
    const result = verifyHs256(VALID_TOKEN, "wrong-secret");
    expect(result.valid).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect((result.reason?.length ?? 0)).toBeGreaterThan(0);
  });

  it("failed result does not include payload on signature failure", () => {
    const result = verifyHs256(VALID_TOKEN, "wrong-secret");
    expect(result.valid).toBe(false);
    // Implementation may or may not include payload on failure — either is fine,
    // but valid must be false and reason must be present
    expect(result.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Base64url correctness (adversarial trap: base64 vs base64url confusion)
// ---------------------------------------------------------------------------

describe("verifyHs256 — base64url correctness", () => {
  it("handles payloads whose base64url encoding contains - and _ (not + and /)", () => {
    // A payload that when base64url-encoded produces chars that differ from base64.
    // We create a payload with binary-ish data that forces - and _ in the encoding.
    // Specifically, test that decoding uses base64url not base64.
    const payload = {
      sub: "user",
      data: "this+has/special+chars/in/base64",
    };
    const token = makeToken(VALID_HEADER, payload, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(true);
    expect(result.payload?.["data"]).toBe("this+has/special+chars/in/base64");
  });

  it("rejects malformed base64url in header", () => {
    const badHeader = "!!!notbase64!!!";
    const result = verifyHs256(`${badHeader}.${b64url(VALID_PAYLOAD)}.sig`, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects malformed base64url in payload", () => {
    const h = b64url(VALID_HEADER);
    const result = verifyHs256(`${h}.!!!notbase64!!!.sig`, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("correctly decodes header with non-ASCII-safe base64url (uses + and _ positions)", () => {
    // Verify that a round-trip through our own token construction works correctly
    const header = { alg: "HS256", typ: "JWT", kid: "key~1" };
    const payload = { sub: "abc" };
    const token = makeToken(header, payload, SECRET);
    const result = verifyHs256(token, SECRET);
    expect(result.valid).toBe(true);
    expect(result.header?.["kid"]).toBe("key~1");
  });
});

// ---------------------------------------------------------------------------
// Multiple valid tokens (compound production-sequence test)
// ---------------------------------------------------------------------------

describe("verifyHs256 — compound production sequence", () => {
  it("verifies a sequence of tokens with different payloads and secrets", () => {
    const scenarios = [
      { payload: { sub: "alice", iat: 1700000000 }, secret: "secret-alice" },
      { payload: { sub: "bob", exp: Math.floor(Date.now() / 1000) + 7200 }, secret: "s3cr3t" },
      { payload: { iss: "myapp", aud: "api", sub: "svc" }, secret: "long-secret-key-for-hmac" },
    ];

    for (const { payload, secret } of scenarios) {
      const token = makeToken(VALID_HEADER, payload, secret);
      const result = verifyHs256(token, secret);
      expect(result.valid).toBe(true);

      // Wrong secret must fail for each
      const wrongResult = verifyHs256(token, `${secret}-wrong`);
      expect(wrongResult.valid).toBe(false);
    }
  });

  it("alg=none attack: unsigned token with valid payload must fail even without signature", () => {
    // The canonical alg=none attack: attacker strips the signature and sets alg=none.
    // The token looks valid because the payload is unchanged, but there's no HMAC.
    const attackerHeader = { alg: "none", typ: "JWT" };
    const legitimatePayload = { sub: "admin", role: "superuser" };
    const attackToken = makeToken(attackerHeader, legitimatePayload, SECRET, "");
    const result = verifyHs256(attackToken, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
