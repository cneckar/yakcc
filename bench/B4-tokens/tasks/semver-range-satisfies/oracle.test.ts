// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/semver-range-satisfies/oracle.test.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 oracle: semver range satisfies
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Tests cover: parseSemver base cases,
//   parseRange grammar (OR/AND boundary), satisfies correctness, prerelease ordering,
//   leading-zero rejection, and the adversarial whitespace-as-AND vs pipe-as-OR grammar.
//   The whitespace=AND vs ||=OR boundary is the primary adversarial discriminator.
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/semver-range-satisfies/oracle.test.ts

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

let parseSemver: (v: string) => { major: number; minor: number; patch: number; prerelease: string } | null;
let parseRange: (r: string) => { comparators: unknown[][] } | null;
let satisfies: (version: string, range: string) => boolean;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  parseSemver = mod.parseSemver ?? mod.default?.parseSemver;
  parseRange = mod.parseRange ?? mod.default?.parseRange;
  satisfies = mod.satisfies ?? mod.default?.satisfies;
  if (typeof parseSemver !== "function" || typeof parseRange !== "function" || typeof satisfies !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export parseSemver, parseRange, and satisfies`
    );
  }
});

describe("parseSemver — basic parsing", () => {
  it("parses basic semver: 1.2.3", () => {
    const v = parseSemver("1.2.3");
    expect(v).not.toBeNull();
    expect(v!.major).toBe(1);
    expect(v!.minor).toBe(2);
    expect(v!.patch).toBe(3);
    expect(v!.prerelease).toBe("");
  });

  it("parses 0.0.0", () => {
    const v = parseSemver("0.0.0");
    expect(v).not.toBeNull();
    expect(v!.major).toBe(0);
    expect(v!.minor).toBe(0);
    expect(v!.patch).toBe(0);
  });

  it("parses prerelease: 1.2.3-alpha", () => {
    const v = parseSemver("1.2.3-alpha");
    expect(v).not.toBeNull();
    expect(v!.prerelease).toBe("alpha");
  });

  it("parses complex prerelease: 1.2.3-alpha.1", () => {
    const v = parseSemver("1.2.3-alpha.1");
    expect(v).not.toBeNull();
    expect(v!.prerelease).toBe("alpha.1");
  });

  it("rejects leading zeros in major: 01.0.0", () => {
    expect(parseSemver("01.0.0")).toBeNull();
  });

  it("rejects leading zeros in minor: 1.01.0", () => {
    expect(parseSemver("1.01.0")).toBeNull();
  });

  it("rejects leading zeros in patch: 1.0.01", () => {
    expect(parseSemver("1.0.01")).toBeNull();
  });

  it("rejects non-numeric parts: 1.x.0", () => {
    expect(parseSemver("1.x.0")).toBeNull();
  });

  it("rejects missing patch: 1.2", () => {
    expect(parseSemver("1.2")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseSemver("")).toBeNull();
  });
});

describe("parseRange — grammar", () => {
  it("parses single comparator: >=1.0.0", () => {
    const r = parseRange(">=1.0.0");
    expect(r).not.toBeNull();
    expect(r!.comparators.length).toBe(1);
    expect(r!.comparators[0]!.length).toBe(1);
  });

  it("parses AND group: >=1.0.0 <2.0.0", () => {
    const r = parseRange(">=1.0.0 <2.0.0");
    expect(r).not.toBeNull();
    expect(r!.comparators.length).toBe(1);
    expect(r!.comparators[0]!.length).toBe(2);
  });

  it("parses OR groups: 1.0.0 || 2.0.0", () => {
    const r = parseRange("1.0.0 || 2.0.0");
    expect(r).not.toBeNull();
    expect(r!.comparators.length).toBe(2);
    expect(r!.comparators[0]!.length).toBe(1);
    expect(r!.comparators[1]!.length).toBe(1);
  });

  it("parses complex: >=1.0.0 <2.0.0 || >=3.0.0", () => {
    const r = parseRange(">=1.0.0 <2.0.0 || >=3.0.0");
    expect(r).not.toBeNull();
    expect(r!.comparators.length).toBe(2);
    expect(r!.comparators[0]!.length).toBe(2);
    expect(r!.comparators[1]!.length).toBe(1);
  });

  it("returns null for tilde (unsupported): ~1.0.0", () => {
    expect(parseRange("~1.0.0")).toBeNull();
  });

  it("returns null for caret (unsupported): ^1.0.0", () => {
    expect(parseRange("^1.0.0")).toBeNull();
  });
});

describe("satisfies — basic comparisons", () => {
  it("1.2.3 satisfies =1.2.3", () => {
    expect(satisfies("1.2.3", "=1.2.3")).toBe(true);
  });

  it("1.2.3 satisfies bare 1.2.3 (no operator)", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
  });

  it("1.2.4 does not satisfy =1.2.3", () => {
    expect(satisfies("1.2.4", "=1.2.3")).toBe(false);
  });

  it("1.2.3 satisfies >=1.2.3", () => {
    expect(satisfies("1.2.3", ">=1.2.3")).toBe(true);
  });

  it("1.2.4 satisfies >=1.2.3", () => {
    expect(satisfies("1.2.4", ">=1.2.3")).toBe(true);
  });

  it("1.2.2 does not satisfy >=1.2.3", () => {
    expect(satisfies("1.2.2", ">=1.2.3")).toBe(false);
  });

  it("1.2.3 satisfies <=1.2.3", () => {
    expect(satisfies("1.2.3", "<=1.2.3")).toBe(true);
  });

  it("1.2.4 does not satisfy <=1.2.3", () => {
    expect(satisfies("1.2.4", "<=1.2.3")).toBe(false);
  });

  it("1.2.4 satisfies >1.2.3", () => {
    expect(satisfies("1.2.4", ">1.2.3")).toBe(true);
  });

  it("1.2.3 does not satisfy >1.2.3", () => {
    expect(satisfies("1.2.3", ">1.2.3")).toBe(false);
  });

  it("1.2.2 satisfies <1.2.3", () => {
    expect(satisfies("1.2.2", "<1.2.3")).toBe(true);
  });

  it("1.2.3 does not satisfy <1.2.3", () => {
    expect(satisfies("1.2.3", "<1.2.3")).toBe(false);
  });
});

describe("satisfies — AND groups (whitespace = AND)", () => {
  it("1.5.0 satisfies >=1.0.0 <2.0.0", () => {
    expect(satisfies("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
  });

  it("2.0.0 does not satisfy >=1.0.0 <2.0.0", () => {
    expect(satisfies("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("0.9.0 does not satisfy >=1.0.0 <2.0.0", () => {
    expect(satisfies("0.9.0", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("1.0.0 satisfies >=1.0.0 <2.0.0", () => {
    expect(satisfies("1.0.0", ">=1.0.0 <2.0.0")).toBe(true);
  });

  it("1.9.9 satisfies >=1.0.0 <2.0.0", () => {
    expect(satisfies("1.9.9", ">=1.0.0 <2.0.0")).toBe(true);
  });
});

describe("satisfies — OR groups (pipe = OR, adversarial grammar)", () => {
  it("1.0.0 satisfies 1.0.0 || 2.0.0", () => {
    expect(satisfies("1.0.0", "1.0.0 || 2.0.0")).toBe(true);
  });

  it("2.0.0 satisfies 1.0.0 || 2.0.0", () => {
    expect(satisfies("2.0.0", "1.0.0 || 2.0.0")).toBe(true);
  });

  it("3.0.0 does not satisfy 1.0.0 || 2.0.0", () => {
    expect(satisfies("3.0.0", "1.0.0 || 2.0.0")).toBe(false);
  });

  it("1.5.0 satisfies >=1.0.0 <2.0.0 || >=3.0.0", () => {
    expect(satisfies("1.5.0", ">=1.0.0 <2.0.0 || >=3.0.0")).toBe(true);
  });

  it("3.1.0 satisfies >=1.0.0 <2.0.0 || >=3.0.0", () => {
    expect(satisfies("3.1.0", ">=1.0.0 <2.0.0 || >=3.0.0")).toBe(true);
  });

  it("2.5.0 does not satisfy >=1.0.0 <2.0.0 || >=3.0.0 (gap between groups)", () => {
    expect(satisfies("2.5.0", ">=1.0.0 <2.0.0 || >=3.0.0")).toBe(false);
  });
});

describe("satisfies — prerelease ordering (adversarial)", () => {
  it("1.0.0-alpha does not satisfy >=1.0.0 (prerelease < release)", () => {
    expect(satisfies("1.0.0-alpha", ">=1.0.0")).toBe(false);
  });

  it("1.0.0 satisfies >1.0.0-alpha (release > prerelease)", () => {
    expect(satisfies("1.0.0", ">1.0.0-alpha")).toBe(true);
  });

  it("1.0.0-alpha satisfies <1.0.0", () => {
    expect(satisfies("1.0.0-alpha", "<1.0.0")).toBe(true);
  });

  it("1.0.0-beta > 1.0.0-alpha (lexicographic prerelease ordering)", () => {
    expect(satisfies("1.0.0-beta", ">1.0.0-alpha")).toBe(true);
  });

  it("1.0.0-alpha does not satisfy >1.0.0-beta (alpha < beta lexicographically)", () => {
    expect(satisfies("1.0.0-alpha", ">1.0.0-beta")).toBe(false);
  });
});

describe("satisfies — invalid inputs return false", () => {
  it("invalid version string: false", () => {
    expect(satisfies("not-semver", ">=1.0.0")).toBe(false);
  });

  it("invalid range (tilde): false", () => {
    expect(satisfies("1.0.0", "~1.0.0")).toBe(false);
  });

  it("empty version: false", () => {
    expect(satisfies("", ">=1.0.0")).toBe(false);
  });

  it("empty range: false", () => {
    expect(satisfies("1.0.0", "")).toBe(false);
  });
});
