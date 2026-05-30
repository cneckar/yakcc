// SPDX-License-Identifier: MIT
/**
 * Tests for canLowerTo -- static lowerability check for Go.
 *
 * Truth table exercised:
 *   language=ts  + any atom                        -> true   (native form)
 *   language=py  + any atom                        -> "unknown" (no adapter)
 *   language=rs  + any atom                        -> "unknown" (no adapter)
 *   language=go  + pure number/string/boolean atom -> true
 *   language=go  + bigint type annotation           -> false (BLOCKER-GO-001)
 *   language=go  + bigint literal (42n)             -> false (BLOCKER-GO-001)
 *   language=go  + generic type param (<T>)         -> false (BLOCKER-GO-002)
 *   language=go  + union type (A | B)               -> false (BLOCKER-GO-003)
 *   language=go  + union with undefined/null        -> false (BLOCKER-GO-003)
 *   language=go  + async function                   -> false (BLOCKER-GO-004)
 *   language=go  + Promise return type              -> false (BLOCKER-GO-004)
 *   language=go  + arrow function value             -> false (BLOCKER-GO-005)
 *   language=go  + function-type annotation         -> false (BLOCKER-GO-005)
 *   language=go  + malformed/empty implSource       -> never throws
 *
 * Compound-interaction test (#15) covers the real production sequence:
 *   canLowerTo gate -> true -> (future compileToGo would proceed)
 *   canLowerTo gate -> false -> guard proves lower should be skipped
 *   canLowerTo gate -> unknown -> discovery treats as undecidable
 */

import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/registry";
import type { BlockTripletRow } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { canLowerTo } from "./can-lower-to.js";

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

// Pure number/string/boolean atom -- fully lowerable to Go
const PURE_ATOM_SRC = `
export function add(a: number, b: number): number {
  return a + b;
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

// BLOCKER-GO-001: bigint type annotation
const BIGINT_TYPE_SRC = `
export function widen(x: bigint): bigint {
  return x;
}`;

// BLOCKER-GO-001: bigint literal (42n)
const BIGINT_LITERAL_SRC = `
export function answer(): bigint {
  return 42n;
}`;

// BLOCKER-GO-002: generic type parameter
const GENERIC_SRC = `
export function identity<T>(x: T): T {
  return x;
}`;

// BLOCKER-GO-003: union type (string | number)
const UNION_SRC = `
export function toStr(x: string | number): string {
  return String(x);
}`;

// BLOCKER-GO-003: union with undefined (T | undefined)
const UNION_UNDEF_SRC = `
export function maybeStr(x: string | undefined): string {
  return x ?? "";
}`;

// BLOCKER-GO-004: async function
const ASYNC_SRC = `
export async function fetchNum(): Promise<number> {
  return 42;
}`;

// BLOCKER-GO-005: arrow function used as a value
const ARROW_VALUE_SRC = `
export const add = (a: number, b: number): number => a + b;
`;

// BLOCKER-GO-005: function-type annotation on a parameter
const FUNCTION_TYPE_SRC = `
export function apply(f: (x: number) => number, v: number): number {
  return f(v);
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
    expect(canLowerTo(makeRow(BIGINT_TYPE_SRC), "ts")).toBe(true);
  });

  it("returns true for ts with an empty implSource", () => {
    expect(canLowerTo(makeRow(""), "ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. language === "py" -> always "unknown"
// ---------------------------------------------------------------------------

describe("canLowerTo -- py (no adapter in this package)", () => {
  it("returns unknown for py with pure atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "py")).toBe("unknown");
  });

  it("returns unknown for py even with bigint atom", () => {
    expect(canLowerTo(makeRow(BIGINT_TYPE_SRC), "py")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 3. language === "rs" -> always "unknown"
// ---------------------------------------------------------------------------

describe("canLowerTo -- rs (no adapter in this package)", () => {
  it("returns unknown for rs with pure atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "rs")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 4. language === "go" -- pure atoms -> true
// ---------------------------------------------------------------------------

describe("canLowerTo -- go, pure lowerable atoms", () => {
  it("returns true for pure number/number atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "go")).toBe(true);
  });

  it("returns true for boolean atom", () => {
    expect(canLowerTo(makeRow(BOOL_ATOM_SRC), "go")).toBe(true);
  });

  it("returns true for string atom", () => {
    expect(canLowerTo(makeRow(STRING_ATOM_SRC), "go")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. language === "go" -- blocker classes -> false
// ---------------------------------------------------------------------------

describe("canLowerTo -- go, BLOCKER-GO-001 bigint type annotation", () => {
  it("returns false when parameter type is bigint", () => {
    expect(canLowerTo(makeRow(BIGINT_TYPE_SRC), "go")).toBe(false);
  });
});

describe("canLowerTo -- go, BLOCKER-GO-001 bigint literal (42n)", () => {
  it("returns false when return expression is a bigint literal", () => {
    expect(canLowerTo(makeRow(BIGINT_LITERAL_SRC), "go")).toBe(false);
  });
});

describe("canLowerTo -- go, BLOCKER-GO-002 generic type parameter", () => {
  it("returns false for function with <T> type parameter", () => {
    expect(canLowerTo(makeRow(GENERIC_SRC), "go")).toBe(false);
  });
});

describe("canLowerTo -- go, BLOCKER-GO-003 union type", () => {
  it("returns false for string | number union parameter", () => {
    expect(canLowerTo(makeRow(UNION_SRC), "go")).toBe(false);
  });

  it("returns false for T | undefined union parameter", () => {
    expect(canLowerTo(makeRow(UNION_UNDEF_SRC), "go")).toBe(false);
  });
});

describe("canLowerTo -- go, BLOCKER-GO-004 async/Promise", () => {
  it("returns false for async function with Promise return type", () => {
    expect(canLowerTo(makeRow(ASYNC_SRC), "go")).toBe(false);
  });
});

describe("canLowerTo -- go, BLOCKER-GO-005 function-typed values", () => {
  it("returns false for arrow function used as a value", () => {
    expect(canLowerTo(makeRow(ARROW_VALUE_SRC), "go")).toBe(false);
  });

  it("returns false for function-type annotation on a parameter", () => {
    expect(canLowerTo(makeRow(FUNCTION_TYPE_SRC), "go")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Robustness -- never throws
// ---------------------------------------------------------------------------

describe("canLowerTo -- robustness, never throws", () => {
  it("returns true for empty implSource on go (no blocked nodes)", () => {
    const result = canLowerTo(makeRow(""), "go");
    expect(result).toBe(true);
  });

  it("does not throw for go with a plain comment-only source", () => {
    const row = makeRow("// just a comment");
    expect(() => canLowerTo(row, "go")).not.toThrow();
    expect(canLowerTo(row, "go")).toBe(true);
  });

  it("does not throw for go with unexpected/garbage implSource content", () => {
    // ts-morph parses it with errors but does not throw; canLowerTo must not throw either
    const row = makeRow("<<<INVALID TS SYNTAX!!!");
    let thrown = false;
    try {
      canLowerTo(row, "go");
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. Compound-interaction test: production sequence gate check
//
//     Covers the real production sequence a discovery pipeline consumer uses:
//       call canLowerTo("go") -> gate true -> (compileToGo would proceed)
//       call canLowerTo("go") -> gate false -> guard proves skip
//       call canLowerTo("go") -> gate unknown -> undecidable
//
//     This test crosses canLowerTo boundary for all three result cases,
//     verifying the three-state contract without mocks.
// ---------------------------------------------------------------------------

describe("canLowerTo compound interaction -- gate result coverage", () => {
  it("pure atom: canLowerTo=true signals compileToGo can proceed", () => {
    const atom = makeRow(PURE_ATOM_SRC);
    const gate = canLowerTo(atom, "go");
    expect(gate).toBe(true);
    // Production code would proceed to compileToGo(atom) here.
    // This test proves the gate fires correctly on the clean-function boundary.
  });

  it("bigint atom: canLowerTo=false -> guard proves compileToGo should be skipped", () => {
    const atom = makeRow(BIGINT_TYPE_SRC);
    const gate = canLowerTo(atom, "go");
    expect(gate).toBe(false);
    // Production code would NOT call compileToGo here.
    // This test proves the guard fires correctly on the bigint boundary.
  });

  it("py atom: canLowerTo=unknown -> discovery treats as undecidable", () => {
    const atom = makeRow(PURE_ATOM_SRC);
    const gate = canLowerTo(atom, "py");
    expect(gate).toBe("unknown");
    // "unknown" is the documented escape hatch -- no py adapter in this package.
  });

  it("ts atom: canLowerTo=true unconditionally even for blocked constructs", () => {
    // ts is the native form; bigint is valid TS; no blocking needed
    const atom = makeRow(BIGINT_TYPE_SRC);
    expect(canLowerTo(atom, "ts")).toBe(true);
  });

  it("generic atom: canLowerTo=false blocks Go lowering for <T> functions", () => {
    const atom = makeRow(GENERIC_SRC);
    expect(canLowerTo(atom, "go")).toBe(false);
    // <T> is BLOCKER-GO-002; Go generics are out of scope for #871 MVP.
  });
});
