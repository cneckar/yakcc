// SPDX-License-Identifier: MIT
/**
 * Tests for canLowerTo -- static lowerability check.
 *
 * Truth table exercised:
 *   language=ts  + any atom            -> true   (native form)
 *   language=go  + any atom            -> "unknown" (no adapter)
 *   language=rs  + any atom            -> "unknown" (no adapter)
 *   language=py  + pure number/string/boolean atom -> true
 *   language=py  + atom with bigint type annotation -> false
 *   language=py  + atom with bigint literal (42n)   -> false
 *   language=py  + malformed/empty implSource       -> never throws
 *
 * Compound-interaction test (#15) covers the real production sequence:
 *   canLowerTo gate -> true -> compileToPython -> PythonCompileResult.source exists
 */

import type { BlockTripletRow } from "@yakcc/registry";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { canLowerTo } from "./can-lower-to.js";
import { compileToPython } from "./compile-python.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(implSource: string): BlockTripletRow {
  return {
    blockMerkleRoot: "dead" as BlockMerkleRoot,
    specHash: "dead" as SpecHash,
    specCanonicalBytes: new Uint8Array(),
    implSource,
    proofManifestJson: "{}",
    level: "L0",
    createdAt: 0,
    canonicalAstHash: "dead" as CanonicalAstHash,
    artifacts: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Atom source fixtures
// ---------------------------------------------------------------------------

// Pure number/string/boolean atom -- fully lowerable to Python
const PURE_ATOM_SRC = `
export function add(a: number, b: number): number {
  return a + b;
}`;

// Atom with bigint type annotation: x: bigint
const BIGINT_TYPE_ATOM_SRC = `
export function widen(x: bigint): bigint {
  return x;
}`;

// Atom with bigint literal: 42n
const BIGINT_LITERAL_ATOM_SRC = `
export function answer(): bigint {
  return 42n;
}`;

// Atom with bigint literal in a variable (not in the return type)
const BIGINT_VAR_ATOM_SRC = `
export function compute(): number {
  const big = 9007199254740993n;
  return 0;
}`;

// Boolean atom
const BOOL_ATOM_SRC = `
export function notBool(x: boolean): boolean {
  return !x;
}`;

// String atom
const STRING_ATOM_SRC = `
export function greet(name: string): string {
  return "hello " + name;
}`;

// ---------------------------------------------------------------------------
// 1. language === "ts" -> always true
// ---------------------------------------------------------------------------

describe("canLowerTo -- ts (native form)", () => {
  it("returns true for ts with a pure atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "ts")).toBe(true);
  });

  it("returns true for ts even when the atom has bigint constructs", () => {
    // ts is the native form; bigint is valid TS
    expect(canLowerTo(makeRow(BIGINT_TYPE_ATOM_SRC), "ts")).toBe(true);
  });

  it("returns true for ts with an empty implSource", () => {
    expect(canLowerTo(makeRow(""), "ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. language === "go" -> always "unknown"
// ---------------------------------------------------------------------------

describe("canLowerTo -- go (no adapter shipped)", () => {
  it("returns unknown for go with pure atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "go")).toBe("unknown");
  });

  it("returns unknown for go with bigint atom", () => {
    expect(canLowerTo(makeRow(BIGINT_TYPE_ATOM_SRC), "go")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 3. language === "rs" -> always "unknown"
// ---------------------------------------------------------------------------

describe("canLowerTo -- rs (no adapter shipped)", () => {
  it("returns unknown for rs with pure atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "rs")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 4. language === "py" -- pure atoms -> true
// ---------------------------------------------------------------------------

describe("canLowerTo -- py, pure lowerable atoms", () => {
  it("returns true for pure number/number atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "py")).toBe(true);
  });

  it("returns true for boolean atom", () => {
    expect(canLowerTo(makeRow(BOOL_ATOM_SRC), "py")).toBe(true);
  });

  it("returns true for string atom", () => {
    expect(canLowerTo(makeRow(STRING_ATOM_SRC), "py")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. language === "py" -- bigint constructs -> false
// ---------------------------------------------------------------------------

describe("canLowerTo -- py, bigint type annotation", () => {
  it("returns false when parameter type is bigint", () => {
    expect(canLowerTo(makeRow(BIGINT_TYPE_ATOM_SRC), "py")).toBe(false);
  });
});

describe("canLowerTo -- py, bigint literal in return", () => {
  it("returns false when return expression is a bigint literal (42n)", () => {
    expect(canLowerTo(makeRow(BIGINT_LITERAL_ATOM_SRC), "py")).toBe(false);
  });
});

describe("canLowerTo -- py, bigint literal in variable initializer", () => {
  it("returns false when a variable is initialized with a bigint literal", () => {
    expect(canLowerTo(makeRow(BIGINT_VAR_ATOM_SRC), "py")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Robustness -- never throws
// ---------------------------------------------------------------------------

describe("canLowerTo -- robustness, never throws", () => {
  it("returns true for completely empty implSource on py (no bigint nodes)", () => {
    const result = canLowerTo(makeRow(""), "py");
    expect(result).toBe(true);
  });

  it("does not throw for py with a plain comment-only source", () => {
    const row = makeRow("// just a comment");
    expect(() => canLowerTo(row, "py")).not.toThrow();
    expect(canLowerTo(row, "py")).toBe(true);
  });

  it("does not throw for py with unexpected/garbage implSource content", () => {
    // ts-morph parses it with errors but does not throw; canLowerTo must not throw either
    const row = makeRow("<<<INVALID TS SYNTAX!!!");
    let thrown = false;
    try {
      canLowerTo(row, "py");
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. Compound-interaction test: canLowerTo gate -> compileToPython sequence
//
//     Covers the real production sequence a discovery pipeline consumer uses:
//       call canLowerTo -> gate true -> call compileToPython -> valid Python out
//
//     Crosses canLowerTo and compileToPython component boundaries without mocks.
// ---------------------------------------------------------------------------

describe("canLowerTo compound interaction -- gate feeds compileToPython", () => {
  it("pure atom: canLowerTo=true -> compileToPython produces Python source", () => {
    const atom = makeRow(PURE_ATOM_SRC);
    const gate = canLowerTo(atom, "py");
    expect(gate).toBe(true);

    // Real production sequence: only call compileToPython when gate is true
    const result = compileToPython(atom);
    expect(result.source).toContain("def add(");
    expect(result.source).toContain("return a + b");
    expect(result.warnings.some((w) => w.kind === "number-to-float")).toBe(true);
  });

  it("bigint atom: canLowerTo=false -> guard proves compileToPython should be skipped", () => {
    const atom = makeRow(BIGINT_TYPE_ATOM_SRC);
    const gate = canLowerTo(atom, "py");
    expect(gate).toBe(false);
    // Production code would NOT call compileToPython here.
    // This test proves the guard fires correctly on the bigint boundary.
  });

  it("go atom: canLowerTo=unknown -> discovery treats as undecidable", () => {
    const atom = makeRow(PURE_ATOM_SRC);
    const gate = canLowerTo(atom, "go");
    expect(gate).toBe("unknown");
    // "unknown" is the documented escape hatch -- no adapter installed.
  });

  it("ts atom: canLowerTo=true unconditionally even for bigint atoms", () => {
    // ts is the native form; bigint is valid TS; no blocking needed
    const atom = makeRow(BIGINT_TYPE_ATOM_SRC);
    expect(canLowerTo(atom, "ts")).toBe(true);
  });
});
