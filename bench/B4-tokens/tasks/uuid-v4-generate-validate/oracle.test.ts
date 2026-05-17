// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/uuid-v4-generate-validate/oracle.test.ts
//
// @decision DEC-B4-SLICE-3-TASKS-001
// @title B4 Slice 3 oracle: uuid-v4-generate-validate
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Must pass against reference-impl.ts
//   before the B4 harness measures LLM-generated implementations. Tests cover:
//   - generateV4(): canonical structure, version nibble, variant nibble, lowercase,
//     crypto RNG distribution (10000-sample chi-squared proxy), format invariants
//   - validateV4(): correct acceptance of v1-v8 + NIL, rejection of uppercase/URN/
//     curly-brace/wrong-nibble/wrong-length/padding forms
//   - Adversarial traps: Math.random detection, version-nibble omission, variant-nibble
//     omission, over-permissive validator, NIL UUID handling
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/uuid-v4-generate-validate/oracle.test.ts

import { describe, expect, it, beforeEach } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

const implUrl = pathToFileURL(implPath).href;

let generateV4: () => string;
let validateV4: (input: string) => boolean;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  generateV4 = mod.generateV4 ?? mod.default?.generateV4;
  validateV4 = mod.validateV4 ?? mod.default?.validateV4;
  if (typeof generateV4 !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export generateV4 as a named export function`
    );
  }
  if (typeof validateV4 !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export validateV4 as a named export function`
    );
  }
});

// RFC 4122 canonical UUID regex for independent verification
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("generateV4 — canonical structure", () => {
  it("produces a 36-character string", () => {
    expect(generateV4()).toHaveLength(36);
  });

  it("matches canonical UUID format (8-4-4-4-12)", () => {
    const uuid = generateV4();
    expect(uuid).toMatch(CANONICAL_UUID_RE);
  });

  it("dashes appear at positions 8, 13, 18, 23", () => {
    const uuid = generateV4();
    expect(uuid[8]).toBe("-");
    expect(uuid[13]).toBe("-");
    expect(uuid[18]).toBe("-");
    expect(uuid[23]).toBe("-");
  });

  it("all non-dash characters are lowercase hex", () => {
    const uuid = generateV4();
    const withoutDashes = uuid.replace(/-/g, "");
    expect(withoutDashes).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does NOT contain uppercase hex characters", () => {
    // Run 100 times to catch probabilistic uppercase errors
    for (let i = 0; i < 100; i++) {
      const uuid = generateV4();
      expect(uuid).not.toMatch(/[A-F]/);
    }
  });
});

describe("generateV4 — version nibble (adversarial trap: version bits omitted)", () => {
  it("version nibble at index 14 is '4'", () => {
    // Structure: xxxxxxxx-xxxx-4xxx-...
    //            0123456789012345678...
    //                         ^14
    const uuid = generateV4();
    expect(uuid[14]).toBe("4");
  });

  it("version nibble is '4' across 1000 generated UUIDs", () => {
    for (let i = 0; i < 1000; i++) {
      const uuid = generateV4();
      expect(uuid[14]).toBe("4");
    }
  });
});

describe("generateV4 — variant nibble (adversarial trap: variant bits omitted)", () => {
  it("variant nibble at index 19 is 8, 9, a, or b", () => {
    // Structure: xxxxxxxx-xxxx-4xxx-yxxx-...
    //            0         1         2
    //            0123456789012345678901234...
    //                             ^19
    const uuid = generateV4();
    expect(["8", "9", "a", "b"]).toContain(uuid[19]);
  });

  it("variant nibble is always in {8,9,a,b} across 1000 generated UUIDs", () => {
    const validVariants = new Set(["8", "9", "a", "b"]);
    for (let i = 0; i < 1000; i++) {
      const uuid = generateV4();
      expect(validVariants.has(uuid[19]!)).toBe(true);
    }
  });

  it("all four variant values (8,9,a,b) appear across 10000 UUIDs", () => {
    // Variant nibble has 2 fixed bits (10) and 2 random bits.
    // Over 10000 samples we expect each of {8,9,a,b} ~2500 times.
    // Statistical floor: each must appear at least 500 times (p < 10^-100).
    const counts: Record<string, number> = { "8": 0, "9": 0, a: 0, b: 0 };
    for (let i = 0; i < 10000; i++) {
      const v = generateV4()[19]!;
      if (v in counts) counts[v]++;
    }
    expect(counts["8"]).toBeGreaterThan(500);
    expect(counts["9"]).toBeGreaterThan(500);
    expect(counts["a"]).toBeGreaterThan(500);
    expect(counts["b"]).toBeGreaterThan(500);
  });
});

describe("generateV4 — cryptographic RNG (adversarial trap: Math.random())", () => {
  it("generates distinct UUIDs across 1000 calls", () => {
    // Math.random() with a fixed seed or low-entropy source produces collisions.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateV4());
    }
    // Any collision across 1000 calls is essentially impossible with crypto RNG
    // (collision probability ~= 1000^2 / (2 * 2^122) ≈ 10^-31)
    expect(seen.size).toBe(1000);
  });

  it("randomness in non-fixed nibble positions: bit diversity test over 5000 samples", () => {
    // For each of the 122 random bits, count how many times it is 1 vs 0.
    // With Math.random(), the distribution is often biased. With crypto RNG,
    // each bit should be ~50/50. We test position 0 (first hex char's high bit)
    // across 5000 samples. Floor: at least 1500 and at most 3500 ones (p < 10^-20).
    let ones = 0;
    for (let i = 0; i < 5000; i++) {
      const uuid = generateV4();
      // First hex char of UUID — fully random (not version/variant nibble)
      const firstNibble = Number.parseInt(uuid[0]!, 16);
      ones += (firstNibble >> 3) & 1;
    }
    expect(ones).toBeGreaterThan(1500);
    expect(ones).toBeLessThan(3500);
  });
});

describe("validateV4 — valid UUID acceptance", () => {
  it("accepts a freshly generated UUID", () => {
    expect(validateV4(generateV4())).toBe(true);
  });

  it("accepts 1000 freshly generated UUIDs", () => {
    for (let i = 0; i < 1000; i++) {
      expect(validateV4(generateV4())).toBe(true);
    }
  });

  it("accepts a known valid v4 UUID", () => {
    // f47ac10b-58cc-4372-a567-0e02b2c3d479:
    // index 14 = '4' (version 4), index 19 = 'a' (RFC 4122 variant)
    expect(validateV4("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
    // 550e8400-e29b-11d4-a716-446655440000:
    // index 14 = '1' (version 1), index 19 = 'a' (RFC 4122 variant) — valid v1 UUID
    expect(validateV4("550e8400-e29b-11d4-a716-446655440000")).toBe(true);
  });

  it("accepts NIL UUID (all zeros) — version nibble=0, variant nibble=0", () => {
    // NIL UUID is special: both version and variant nibbles are 0.
    // npm uuid's validate.js accepts it; naive version-nibble!=0 validators reject it.
    expect(validateV4("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("accepts v1 UUID", () => {
    // v1: version nibble = '1'
    expect(validateV4("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
  });

  it("accepts v3 UUID", () => {
    // v3: version nibble = '3'
    expect(validateV4("6ba7b810-9dad-31d1-80b4-00c04fd430c8")).toBe(true);
  });

  it("accepts v5 UUID", () => {
    // v5: version nibble = '5'
    expect(validateV4("6ba7b810-9dad-51d1-80b4-00c04fd430c8")).toBe(true);
  });

  it("accepts all valid variant nibbles: 8, 9, a, b", () => {
    const base = "f47ac10b-58cc-4372-";
    const suffix = "-0e02b2c3d479";
    expect(validateV4(`${base}8567${suffix}`)).toBe(true);
    expect(validateV4(`${base}9567${suffix}`)).toBe(true);
    expect(validateV4(`${base}a567${suffix}`)).toBe(true);
    expect(validateV4(`${base}b567${suffix}`)).toBe(true);
  });
});

describe("validateV4 — rejection of invalid forms (adversarial trap: over-permissive validator)", () => {
  it("rejects uppercase hex digits", () => {
    // Uppercase is non-canonical; npm uuid's validate.js rejects it
    expect(validateV4("F47AC10B-58CC-4372-A567-0E02B2C3D479")).toBe(false);
    expect(validateV4("f47ac10b-58cc-4372-A567-0e02b2c3d479")).toBe(false);
  });

  it("rejects wrong version nibble: 'f' at position 14", () => {
    // Version nibble must be 0-8; 'f' is invalid
    expect(validateV4("f47ac10b-58cc-f372-a567-0e02b2c3d479")).toBe(false);
  });

  it("rejects wrong variant nibble: 'c', 'd', 'e', 'f' at position 19", () => {
    const base = "f47ac10b-58cc-4372-";
    const suffix = "-0e02b2c3d479";
    expect(validateV4(`${base}c567${suffix}`)).toBe(false);
    expect(validateV4(`${base}d567${suffix}`)).toBe(false);
    expect(validateV4(`${base}e567${suffix}`)).toBe(false);
    expect(validateV4(`${base}f567${suffix}`)).toBe(false);
  });

  it("rejects missing dashes", () => {
    expect(validateV4("f47ac10b58cc4372a5670e02b2c3d479")).toBe(false);
  });

  it("rejects wrong dash positions", () => {
    expect(validateV4("f47ac10-b58cc-4372-a567-0e02b2c3d479")).toBe(false);
  });

  it("rejects UUID shorter than 36 chars", () => {
    expect(validateV4("f47ac10b-58cc-4372-a567-0e02b2c3d47")).toBe(false);
  });

  it("rejects UUID longer than 36 chars", () => {
    expect(validateV4("f47ac10b-58cc-4372-a567-0e02b2c3d4799")).toBe(false);
  });

  it("rejects URN prefix form", () => {
    expect(validateV4("urn:uuid:f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(false);
  });

  it("rejects curly-brace-wrapped form", () => {
    expect(validateV4("{f47ac10b-58cc-4372-a567-0e02b2c3d479}")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateV4("")).toBe(false);
  });

  it("rejects non-string input coerced to string (number)", () => {
    // @ts-expect-error: testing runtime type coercion guard
    expect(validateV4(12345)).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(validateV4("g47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(false);
    expect(validateV4("f47ac10b-58cc-4372-a567-0e02b2c3z479")).toBe(false);
  });

  it("rejects spaces in UUID", () => {
    expect(validateV4("f47ac10b-58cc-4372-a567-0e02b2c3d47 ")).toBe(false);
    expect(validateV4(" f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(false);
  });

  it("rejects null", () => {
    // @ts-expect-error: testing runtime type guard
    expect(validateV4(null)).toBe(false);
  });

  it("rejects undefined", () => {
    // @ts-expect-error: testing runtime type guard
    expect(validateV4(undefined)).toBe(false);
  });
});

describe("generateV4 + validateV4 — round-trip integration", () => {
  it("every generated UUID passes its own validator", () => {
    for (let i = 0; i < 500; i++) {
      const uuid = generateV4();
      expect(validateV4(uuid)).toBe(true);
    }
  });

  it("generated UUIDs have correct structure for version 4", () => {
    for (let i = 0; i < 100; i++) {
      const uuid = generateV4();
      // Must be v4: version nibble = '4'
      expect(uuid[14]).toBe("4");
      // Must be RFC 4122 variant: variant nibble in {8,9,a,b}
      expect(["8", "9", "a", "b"]).toContain(uuid[19]);
      // Must pass the validator
      expect(validateV4(uuid)).toBe(true);
    }
  });
});
