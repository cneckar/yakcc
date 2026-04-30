/**
 * Tests for normalizeSource — the minimal normalization function that ensures
 * CRLF line endings and leading/trailing whitespace do not produce distinct
 * cache keys.
 *
 * Production trigger: normalizeSource is called inside sourceHash() before
 * hashing, so every time extractIntent computes a cache key it normalizes first.
 *
 * Compound-interaction test: the fast-check idempotency property exercises the
 * same normalization path that extractIntent takes during cache key derivation,
 * confirming that double-normalizing (e.g. in a re-extraction scenario) still
 * produces the same hash input.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeSource } from "./normalize.js";

describe("normalizeSource()", () => {
  it("converts CRLF to LF and trims trailing whitespace", () => {
    expect(normalizeSource("a\r\nb\r\n")).toBe("a\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSource("  hello  \n")).toBe("hello");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeSource("")).toBe("");
  });

  it("leaves LF-only content with no surrounding whitespace unchanged", () => {
    expect(normalizeSource("line1\nline2")).toBe("line1\nline2");
  });

  it("handles mixed CRLF and LF", () => {
    expect(normalizeSource("a\r\nb\nc\r\n")).toBe("a\nb\nc");
  });

  it("trims leading whitespace only", () => {
    expect(normalizeSource("  hello")).toBe("hello");
  });

  it("handles whitespace-only string", () => {
    expect(normalizeSource("   \n\r\n  ")).toBe("");
  });

  // -------------------------------------------------------------------------
  // fast-check property: normalizeSource is idempotent
  // Applying it twice must produce the same result as applying it once.
  // This is the production invariant: re-normalization of a normalized string
  // must never produce a different hash.
  // -------------------------------------------------------------------------
  it("is idempotent (fast-check)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeSource(s);
        const twice = normalizeSource(once);
        return once === twice;
      }),
    );
  });
});
