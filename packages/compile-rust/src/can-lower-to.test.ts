// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for canLowerTo -- static lowerability check for Rust.
 *
 * Truth table exercised:
 *   language=ts  + any atom                        -> true   (native form)
 *   language=go  + any atom                        -> "unknown" (no adapter)
 *   language=py  + any atom                        -> "unknown" (no adapter)
 *   language=rs  + pure number/string/boolean atom -> true
 *   language=rs  + async function                   -> false (BLOCKER-RUST-001)
 *   language=rs  + Promise return type              -> false (BLOCKER-RUST-001)
 *   language=rs  + generic type param (<T>)         -> false (BLOCKER-RUST-002)
 *   language=rs  + bigint type annotation           -> false (BLOCKER-RUST-003)
 *   language=rs  + bigint literal (42n)             -> false (BLOCKER-RUST-003)
 *   language=rs  + union type (A | B)               -> false (BLOCKER-RUST-004)
 *   language=rs  + union with undefined/null        -> false (BLOCKER-RUST-004)
 *   language=rs  + arrow function value             -> false (BLOCKER-RUST-005)
 *   language=rs  + function-type annotation         -> false (BLOCKER-RUST-005)
 *   language=rs  + malformed/empty implSource       -> never throws
 *
 * Compound-interaction test covers the real production sequence:
 *   canLowerTo gate -> true -> (compileToRust would proceed)
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

const PURE_ATOM_SRC = `
export function add(a: number, b: number): number {
  return a + b;
}`;

const BOOL_ATOM_SRC = `
export function notBool(x: boolean): boolean {
  return !x;
}`;

const STRING_ATOM_SRC = `
export function greet(name: string): string {
  return "hello " + name;
}`;

const BIGINT_TYPE_SRC = `
export function widen(x: bigint): bigint {
  return x;
}`;

const BIGINT_LITERAL_SRC = `
export function answer(): bigint {
  return 42n;
}`;

const GENERIC_SRC = `
export function identity<T>(x: T): T {
  return x;
}`;

const UNION_SRC = `
export function toStr(x: string | number): string {
  return String(x);
}`;

const UNION_UNDEF_SRC = `
export function maybeStr(x: string | undefined): string {
  return x ?? "";
}`;

const ASYNC_SRC = `
export async function fetchNum(): Promise<number> {
  return 42;
}`;

const ARROW_VALUE_SRC = `
export const add = (a: number, b: number): number => a + b;
`;

const FUNCTION_TYPE_SRC = `
export function apply(f: (x: number) => number, v: number): number {
  return f(v);
}`;

// ---------------------------------------------------------------------------
// language === "ts" -> always true
// ---------------------------------------------------------------------------

describe("canLowerTo -- ts (native form)", () => {
  it("returns true for ts with a pure atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "ts")).toBe(true);
  });

  it("returns true for ts even when the atom has bigint constructs", () => {
    expect(canLowerTo(makeRow(BIGINT_TYPE_SRC), "ts")).toBe(true);
  });

  it("returns true for ts with an empty implSource", () => {
    expect(canLowerTo(makeRow(""), "ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// language === "go" / "py" -> always "unknown"
// ---------------------------------------------------------------------------

describe("canLowerTo -- go/py (no adapter in this package)", () => {
  it("returns unknown for go with pure atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "go")).toBe("unknown");
  });

  it("returns unknown for py with pure atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "py")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// language === "rs" -- pure atoms -> true
// ---------------------------------------------------------------------------

describe("canLowerTo -- rs, pure lowerable atoms", () => {
  it("returns true for pure number/number atom", () => {
    expect(canLowerTo(makeRow(PURE_ATOM_SRC), "rs")).toBe(true);
  });

  it("returns true for boolean atom", () => {
    expect(canLowerTo(makeRow(BOOL_ATOM_SRC), "rs")).toBe(true);
  });

  it("returns true for string atom", () => {
    expect(canLowerTo(makeRow(STRING_ATOM_SRC), "rs")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// language === "rs" -- blocker classes -> false
// ---------------------------------------------------------------------------

describe("canLowerTo -- rs, BLOCKER-RUST-001 async/Promise", () => {
  it("returns false for async function with Promise return type", () => {
    expect(canLowerTo(makeRow(ASYNC_SRC), "rs")).toBe(false);
  });
});

describe("canLowerTo -- rs, BLOCKER-RUST-002 generic type parameter", () => {
  it("returns false for function with <T> type parameter", () => {
    expect(canLowerTo(makeRow(GENERIC_SRC), "rs")).toBe(false);
  });
});

describe("canLowerTo -- rs, BLOCKER-RUST-003 bigint type annotation", () => {
  it("returns false when parameter type is bigint", () => {
    expect(canLowerTo(makeRow(BIGINT_TYPE_SRC), "rs")).toBe(false);
  });

  it("returns false when return expression is a bigint literal (42n)", () => {
    expect(canLowerTo(makeRow(BIGINT_LITERAL_SRC), "rs")).toBe(false);
  });
});

describe("canLowerTo -- rs, BLOCKER-RUST-004 union type", () => {
  it("returns false for string | number union parameter", () => {
    expect(canLowerTo(makeRow(UNION_SRC), "rs")).toBe(false);
  });

  it("returns false for T | undefined union parameter", () => {
    expect(canLowerTo(makeRow(UNION_UNDEF_SRC), "rs")).toBe(false);
  });
});

describe("canLowerTo -- rs, BLOCKER-RUST-005 function-typed values", () => {
  it("returns false for arrow function used as a value", () => {
    expect(canLowerTo(makeRow(ARROW_VALUE_SRC), "rs")).toBe(false);
  });

  it("returns false for function-type annotation on a parameter", () => {
    expect(canLowerTo(makeRow(FUNCTION_TYPE_SRC), "rs")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Robustness -- never throws
// ---------------------------------------------------------------------------

describe("canLowerTo -- robustness, never throws", () => {
  it("returns true for empty implSource on rs (no blocked nodes)", () => {
    const result = canLowerTo(makeRow(""), "rs");
    expect(result).toBe(true);
  });

  it("does not throw for rs with a plain comment-only source", () => {
    const row = makeRow("// just a comment");
    expect(() => canLowerTo(row, "rs")).not.toThrow();
    expect(canLowerTo(row, "rs")).toBe(true);
  });

  it("does not throw for rs with unexpected/garbage implSource content", () => {
    const row = makeRow("<<<INVALID TS SYNTAX!!!");
    let thrown = false;
    try {
      canLowerTo(row, "rs");
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction test: production sequence gate check
//
// Covers the real production sequence a discovery pipeline consumer uses:
//   call canLowerTo("rs") -> gate true -> (compileToRust would proceed)
//   call canLowerTo("rs") -> gate false -> guard proves skip
//   call canLowerTo("rs") -> gate unknown -> undecidable
// ---------------------------------------------------------------------------

describe("canLowerTo compound interaction -- gate result coverage", () => {
  it("pure atom: canLowerTo=true signals compileToRust can proceed", () => {
    const atom = makeRow(PURE_ATOM_SRC);
    const gate = canLowerTo(atom, "rs");
    expect(gate).toBe(true);
  });

  it("bigint atom: canLowerTo=false -> guard proves compileToRust should be skipped", () => {
    const atom = makeRow(BIGINT_TYPE_SRC);
    const gate = canLowerTo(atom, "rs");
    expect(gate).toBe(false);
  });

  it("go atom: canLowerTo=unknown -> discovery treats as undecidable", () => {
    const atom = makeRow(PURE_ATOM_SRC);
    const gate = canLowerTo(atom, "go");
    expect(gate).toBe("unknown");
  });

  it("ts atom: canLowerTo=true unconditionally even for blocked constructs", () => {
    const atom = makeRow(BIGINT_TYPE_SRC);
    expect(canLowerTo(atom, "ts")).toBe(true);
  });

  it("generic atom: canLowerTo=false blocks Rust lowering for <T> functions", () => {
    const atom = makeRow(GENERIC_SRC);
    expect(canLowerTo(atom, "rs")).toBe(false);
  });
});
