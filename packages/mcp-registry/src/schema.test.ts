/**
 * Tests for schema.ts (DEC-MCP-SCHEMA-PARSERS-010).
 *
 * Covers every parser: happy paths and each rejection branch.
 * No network calls — pure in-process validation logic.
 */

import { describe, expect, it } from "vitest";
import {
  parseBlockMerkleRoot,
  parseShaveRequestCoord,
  parseSpecHash,
  parseWireBlockTriplet,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_HEX64 = "a".repeat(64);
const VALID_HEX64_B = "b".repeat(64);

// ---------------------------------------------------------------------------
// parseBlockMerkleRoot
// ---------------------------------------------------------------------------

describe("parseBlockMerkleRoot", () => {
  it("accepts a valid 64-char lowercase hex string", () => {
    const r = parseBlockMerkleRoot(VALID_HEX64);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(VALID_HEX64);
  });

  it("rejects non-string input", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const r = parseBlockMerkleRoot(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_input");
        expect(r.message).toMatch(/string/);
      }
    }
  });

  it("rejects a string shorter than 64 chars", () => {
    const r = parseBlockMerkleRoot("abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });

  it("rejects a string longer than 64 chars", () => {
    const r = parseBlockMerkleRoot("a".repeat(65));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });

  it("rejects uppercase hex", () => {
    const r = parseBlockMerkleRoot("A".repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });

  it("rejects non-hex characters", () => {
    const r = parseBlockMerkleRoot("g".repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });

  it("accepts a mixed-digit valid hex string", () => {
    const mixed = "0123456789abcdef".repeat(4); // 64 chars
    const r = parseBlockMerkleRoot(mixed);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSpecHash
// ---------------------------------------------------------------------------

describe("parseSpecHash", () => {
  it("accepts a valid 64-char lowercase hex string", () => {
    const r = parseSpecHash(VALID_HEX64);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(VALID_HEX64);
  });

  it("rejects non-string input", () => {
    const r = parseSpecHash(12345);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_input");
      expect(r.message).toMatch(/string/);
    }
  });

  it("rejects strings not matching 64-char lowercase hex pattern", () => {
    for (const bad of ["", "abc", "Z".repeat(64), "a".repeat(63)]) {
      const r = parseSpecHash(bad);
      expect(r.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// parseWireBlockTriplet
// ---------------------------------------------------------------------------

const VALID_TRIPLET = {
  specHash: VALID_HEX64,
  specCanonicalBytes: "base64encodedorwhatever",
  blockMerkleRoot: VALID_HEX64_B,
  implSource: "pypi:requests:2.31.0",
};

describe("parseWireBlockTriplet", () => {
  it("accepts a valid WireBlockTriplet object", () => {
    const r = parseWireBlockTriplet(VALID_TRIPLET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(VALID_TRIPLET);
  });

  it("rejects null", () => {
    const r = parseWireBlockTriplet(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });

  it("rejects an array", () => {
    const r = parseWireBlockTriplet([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });

  it("rejects a primitive", () => {
    const r = parseWireBlockTriplet("string");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });

  it("rejects object missing specHash", () => {
    const { specHash: _, ...rest } = VALID_TRIPLET;
    const r = parseWireBlockTriplet(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_input");
      expect(r.message).toContain("specHash");
    }
  });

  it("rejects object missing specCanonicalBytes", () => {
    const { specCanonicalBytes: _, ...rest } = VALID_TRIPLET;
    const r = parseWireBlockTriplet(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("specCanonicalBytes");
  });

  it("rejects object missing blockMerkleRoot", () => {
    const { blockMerkleRoot: _, ...rest } = VALID_TRIPLET;
    const r = parseWireBlockTriplet(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("blockMerkleRoot");
  });

  it("rejects object missing implSource", () => {
    const { implSource: _, ...rest } = VALID_TRIPLET;
    const r = parseWireBlockTriplet(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("implSource");
  });

  it("rejects non-string field values", () => {
    const r = parseWireBlockTriplet({ ...VALID_TRIPLET, specHash: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("specHash");
  });
});

// ---------------------------------------------------------------------------
// parseShaveRequestCoord
// ---------------------------------------------------------------------------

describe("parseShaveRequestCoord", () => {
  // ---- happy paths ----

  it("accepts a valid pypi coord", () => {
    const r = parseShaveRequestCoord({ source: "pypi", name: "requests", version: "2.31.0" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ source: "pypi", name: "requests", version: "2.31.0" });
    }
  });

  it("accepts a valid npm coord", () => {
    const r = parseShaveRequestCoord({ source: "npm", name: "lodash", version: "4.17.21" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ source: "npm", name: "lodash", version: "4.17.21" });
    }
  });

  it("accepts a valid github coord", () => {
    const r = parseShaveRequestCoord({
      source: "github",
      owner: "psf",
      repo: "requests",
      ref: "v2.31.0",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ source: "github", owner: "psf", repo: "requests", ref: "v2.31.0" });
    }
  });

  // ---- non-object input ----

  it("rejects null", () => {
    const r = parseShaveRequestCoord(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });

  it("rejects an array", () => {
    const r = parseShaveRequestCoord(["pypi", "requests"]);
    expect(r.ok).toBe(false);
  });

  it("rejects a string", () => {
    const r = parseShaveRequestCoord("pypi");
    expect(r.ok).toBe(false);
  });

  // ---- missing or bad source ----

  it("rejects object with non-string source", () => {
    const r = parseShaveRequestCoord({ source: 42, name: "requests", version: "1.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/source/);
  });

  it("rejects unknown source value", () => {
    const r = parseShaveRequestCoord({ source: "cargo", name: "serde", version: "1.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_input");
      expect(r.message).toMatch(/cargo/);
    }
  });

  // ---- pypi / npm field validation ----

  it("rejects pypi coord with empty name", () => {
    const r = parseShaveRequestCoord({ source: "pypi", name: "", version: "1.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/name/);
  });

  it("rejects pypi coord with missing version", () => {
    const r = parseShaveRequestCoord({ source: "pypi", name: "requests" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/version/);
  });

  it("rejects npm coord with empty version", () => {
    const r = parseShaveRequestCoord({ source: "npm", name: "lodash", version: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/version/);
  });

  // ---- github field validation ----

  it("rejects github coord with missing owner", () => {
    const r = parseShaveRequestCoord({ source: "github", repo: "requests", ref: "main" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/owner/);
  });

  it("rejects github coord with empty repo", () => {
    const r = parseShaveRequestCoord({ source: "github", owner: "psf", repo: "", ref: "main" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/repo/);
  });

  it("rejects github coord with empty ref", () => {
    const r = parseShaveRequestCoord({
      source: "github",
      owner: "psf",
      repo: "requests",
      ref: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/ref/);
  });
});
