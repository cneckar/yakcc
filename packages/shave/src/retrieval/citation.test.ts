// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { citeBehavior } from "./citation.js";

const UNIT = [
  "/**",
  " * Removes characters that are unsafe in a file name.",
  " * Keeps letters, digits, and dots.",
  " */",
  "export function sanitizeFilename(s: string): string {",
  "  return s.replace(/[^\\w.]/g, '');",
  "}",
].join("\n");

describe("citation check for behavior claims (WI-REUSE B5, #1262)", () => {
  it("cites a claim that appears in the source, with its line span", () => {
    const r = citeBehavior(UNIT, "Removes characters that are unsafe in a file name.");
    expect(r).toEqual({ status: "cited", lineStart: 2, lineEnd: 2 });
  });

  it("cites a claim that spans two JSDoc lines, across the decoration", () => {
    const r = citeBehavior(
      UNIT,
      "Removes characters that are unsafe in a file name. Keeps letters, digits, and dots.",
    );
    expect(r.status).toBe("cited");
    if (r.status === "cited") {
      expect(r.lineStart).toBe(2);
      expect(r.lineEnd).toBe(3);
    }
  });

  it("a planted misquote fails the check, and is not silently dropped", () => {
    const r = citeBehavior(UNIT, "Removes characters that are safe in a file name.");
    expect(r).toEqual({ status: "uncited", reason: "not-found" });
  });

  it("a truncated behavior is checked on its prefix", () => {
    const r = citeBehavior(UNIT, "Removes characters that are unsafe in a file...");
    expect(r.status).toBe("cited");
  });

  it("an empty claim is uncited with a reason", () => {
    expect(citeBehavior(UNIT, "   ")).toEqual({ status: "uncited", reason: "empty-claim" });
  });

  it("a stale cached claim fails once the source it was keyed to has changed", () => {
    const cachedBehavior = "Removes characters that are unsafe in a file name.";
    const edited = UNIT.replace("unsafe in a file name", "unsafe in a path");
    expect(citeBehavior(UNIT, cachedBehavior).status).toBe("cited");
    expect(citeBehavior(edited, cachedBehavior).status).toBe("uncited");
  });
});
