// SPDX-License-Identifier: MIT
//
// lang-target.test.ts — exhaustive table tests for inferTarget / isSupportedTarget.
//
// @decision DEC-WI877-005 (cross-reference: PLAN.md §4 / #877)

import { describe, expect, it } from "vitest";
import {
  TARGETS_TRACKED,
  inferTarget,
  isSupportedTarget,
  type TargetLang,
} from "./lang-target.js";

describe("lang-target — inferTarget", () => {
  // Extension-based inference (no override)
  it(".ts → ts", () => {
    expect(inferTarget("foo.ts", undefined)).toBe("ts");
  });

  it(".tsx → ts", () => {
    expect(inferTarget("foo.tsx", undefined)).toBe("ts");
  });

  it(".py → python", () => {
    expect(inferTarget("foo.py", undefined)).toBe("python");
  });

  it(".rs → rust", () => {
    expect(inferTarget("foo.rs", undefined)).toBe("rust");
  });

  it(".go → go", () => {
    expect(inferTarget("foo.go", undefined)).toBe("go");
  });

  it("unknown extension + no --target → unknown", () => {
    expect(inferTarget("foo.rb", undefined)).toBe("unknown");
  });

  it("no file path + no --target → unknown", () => {
    expect(inferTarget(undefined, undefined)).toBe("unknown");
  });

  it("undefined file path + undefined override → unknown", () => {
    expect(inferTarget(undefined, undefined)).toBe("unknown");
  });

  // --target overrides extension
  it("--target python overrides .ts extension", () => {
    expect(inferTarget("foo.ts", "python")).toBe("python");
  });

  it("--target ts overrides .py extension", () => {
    expect(inferTarget("foo.py", "ts")).toBe("ts");
  });

  it("--target rust overrides .py extension", () => {
    expect(inferTarget("foo.py", "rust")).toBe("rust");
  });

  it("--target go overrides .ts extension", () => {
    expect(inferTarget("foo.ts", "go")).toBe("go");
  });

  it("invalid --target value → unknown", () => {
    expect(inferTarget("foo.ts", "cobol")).toBe("unknown");
  });

  it("empty --target string falls through to extension inference", () => {
    expect(inferTarget("foo.py", "")).toBe("python");
  });

  it("case-insensitive extension: .PY → python", () => {
    expect(inferTarget("foo.PY", undefined)).toBe("python");
  });

  it("case-insensitive extension: .TS → ts", () => {
    expect(inferTarget("foo.TS", undefined)).toBe("ts");
  });

  it("path with directory segments resolves correctly", () => {
    expect(inferTarget("src/foo/bar.py", undefined)).toBe("python");
  });

  it("path with no extension → unknown", () => {
    expect(inferTarget("Makefile", undefined)).toBe("unknown");
  });
});

describe("lang-target — isSupportedTarget", () => {
  it("'ts' is supported", () => {
    expect(isSupportedTarget("ts")).toBe(true);
  });

  it("'python' is supported", () => {
    expect(isSupportedTarget("python")).toBe(true);
  });

  it("'rust' is supported", () => {
    expect(isSupportedTarget("rust")).toBe(true);
  });

  it("'go' is supported", () => {
    expect(isSupportedTarget("go")).toBe(true);
  });

  it("arbitrary string is not supported", () => {
    expect(isSupportedTarget("cobol")).toBe(false);
  });

  it("empty string is not supported", () => {
    expect(isSupportedTarget("")).toBe(false);
  });

  // Type-guard check: TS narrowing works
  it("narrows to TargetLang after truthy check", () => {
    const s = "python";
    if (isSupportedTarget(s)) {
      const t: TargetLang = s; // should compile
      expect(t).toBe("python");
    }
  });
});

describe("lang-target — TARGETS_TRACKED", () => {
  it("TARGETS_TRACKED.rust === 868", () => {
    expect(TARGETS_TRACKED.rust).toBe(868);
  });

  it("TARGETS_TRACKED.go === 870", () => {
    expect(TARGETS_TRACKED.go).toBe(870);
  });
});
