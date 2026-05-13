// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/base64-encode-rfc4648/oracle.test.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 oracle: Base64 encode (RFC 4648)
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Tests cover: empty input, known
//   RFC 4648 test vectors, padding variants, URL-safe alphabet, null bytes, all-zeros,
//   all-ones (0xFF), and the alphabet-boundary adversarial cases (indices 62 and 63).
//   The alphabet hallucination test is the primary discriminator.
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/base64-encode-rfc4648/oracle.test.ts

import { describe, expect, it, beforeEach } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

const implUrl = pathToFileURL(implPath).href;

let base64Encode: (input: Uint8Array, options?: { padding?: boolean; urlSafe?: boolean }) => string;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  base64Encode = mod.base64Encode ?? mod.default;
  if (typeof base64Encode !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export base64Encode as a named or default export function`
    );
  }
});

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function asciiBytes(s: string): Uint8Array {
  return new Uint8Array(Array.from(s).map((c) => c.charCodeAt(0)));
}

describe("base64Encode — empty input", () => {
  it("empty Uint8Array returns empty string", () => {
    expect(base64Encode(bytes())).toBe("");
  });

  it("empty with padding=false: still empty string", () => {
    expect(base64Encode(bytes(), { padding: false })).toBe("");
  });
});

describe("base64Encode — RFC 4648 section 10 test vectors", () => {
  it("f encodes to Zg==", () => {
    expect(base64Encode(asciiBytes("f"))).toBe("Zg==");
  });

  it("fo encodes to Zm8=", () => {
    expect(base64Encode(asciiBytes("fo"))).toBe("Zm8=");
  });

  it("foo encodes to Zm9v", () => {
    expect(base64Encode(asciiBytes("foo"))).toBe("Zm9v");
  });

  it("foob encodes to Zm9vYg==", () => {
    expect(base64Encode(asciiBytes("foob"))).toBe("Zm9vYg==");
  });

  it("fooba encodes to Zm9vYmE=", () => {
    expect(base64Encode(asciiBytes("fooba"))).toBe("Zm9vYmE=");
  });

  it("foobar encodes to Zm9vYmFy", () => {
    expect(base64Encode(asciiBytes("foobar"))).toBe("Zm9vYmFy");
  });
});

describe("base64Encode — alphabet correctness (adversarial: hallucination trap)", () => {
  it("standard mode: bytes(0,0,0xFE) produces AAD+ not AAD-", () => {
    // triple = 254: c0=0->A, c1=0->A, c2=3->D, c3=62->+
    const result = base64Encode(bytes(0, 0, 0xFE));
    expect(result).toBe("AAD+");
  });

  it("standard mode: bytes(0,0,0xFF) produces AAD/ not AAD_", () => {
    // triple = 255: c3=63->/
    const result = base64Encode(bytes(0, 0, 0xFF));
    expect(result).toBe("AAD/");
  });

  it("urlSafe mode: bytes(0,0,0xFE) produces AAD- not AAD+", () => {
    const result = base64Encode(bytes(0, 0, 0xFE), { urlSafe: true });
    expect(result).toBe("AAD-");
  });

  it("urlSafe mode: bytes(0,0,0xFF) produces AAD_ not AAD/", () => {
    const result = base64Encode(bytes(0, 0, 0xFF), { urlSafe: true });
    expect(result).toBe("AAD_");
  });

  it("standard alphabet has + and / not - and _", () => {
    const allBytes = new Uint8Array(192);
    for (let i = 0; i < 192; i++) allBytes[i] = i;
    const encoded = base64Encode(allBytes, { padding: false });
    const charset = new Set(encoded.split(""));
    expect(charset.size).toBe(64);
    expect(charset.has("+")).toBe(true);
    expect(charset.has("/")).toBe(true);
    expect(charset.has("-")).toBe(false);
    expect(charset.has("_")).toBe(false);
  });
});

describe("base64Encode — padding variants", () => {
  it("1-byte input with padding: Zg==", () => {
    expect(base64Encode(asciiBytes("f"))).toBe("Zg==");
  });

  it("1-byte input without padding: Zg", () => {
    expect(base64Encode(asciiBytes("f"), { padding: false })).toBe("Zg");
  });

  it("2-byte input with padding: Zm8=", () => {
    expect(base64Encode(asciiBytes("fo"))).toBe("Zm8=");
  });

  it("2-byte input without padding: Zm8", () => {
    expect(base64Encode(asciiBytes("fo"), { padding: false })).toBe("Zm8");
  });

  it("output with padding always has length divisible by 4", () => {
    for (let len = 0; len <= 12; len++) {
      const input = new Uint8Array(len).fill(42);
      const result = base64Encode(input);
      if (len > 0) {
        expect(result.length % 4).toBe(0);
      }
    }
  });
});

describe("base64Encode — special byte values", () => {
  it("3 null bytes encode to AAAA", () => {
    expect(base64Encode(bytes(0, 0, 0))).toBe("AAAA");
  });

  it("single null byte encodes to AA==", () => {
    expect(base64Encode(bytes(0))).toBe("AA==");
  });

  it("3 bytes of 0xFF encode to //// in standard mode", () => {
    expect(base64Encode(bytes(0xFF, 0xFF, 0xFF))).toBe("////");
  });

  it("3 bytes of 0xFF encode to ____ in urlSafe mode", () => {
    expect(base64Encode(bytes(0xFF, 0xFF, 0xFF), { urlSafe: true })).toBe("____");
  });

  it("bytes [0,1,2] encode to AAEC", () => {
    expect(base64Encode(bytes(0, 1, 2))).toBe("AAEC");
  });
});

describe("base64Encode — longer inputs", () => {
  it("Man encodes to TWFu", () => {
    expect(base64Encode(asciiBytes("Man"))).toBe("TWFu");
  });

  it("Many hands make light work. encodes correctly", () => {
    expect(base64Encode(asciiBytes("Many hands make light work."))).toBe(
      "TWFueSBoYW5kcyBtYWtlIGxpZ2h0IHdvcmsu"
    );
  });
});
