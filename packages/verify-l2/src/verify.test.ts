// SPDX-License-Identifier: Apache-2.0
import { liftAtom } from "@yakcc/duc";
import { afterAll, describe, expect, it } from "vitest";
import { encodeGraph, f64Bits, f64FromBits, f64Literal } from "./encode.js";
import { shutdownSolver } from "./solver.js";
import { type L2Contract, verifyL2 } from "./verify.js";

afterAll(async () => {
  await shutdownSolver();
});

const num = (name: string) => ({ name, type: "number" });
const contract = (
  inputs: L2Contract["inputs"],
  postconditions: readonly string[],
  preconditions: readonly string[] = [],
  output = "number",
): L2Contract => ({ inputs, outputs: [{ type: output }], preconditions, postconditions });

const CLAMP =
  "function clamp(x: number, lo: number, hi: number): number { if (x < lo) return lo; if (x > hi) return hi; return x; }";
const ABS = "function abs(x: number): number { return x < 0 ? -x : x; }";

describe("literals", () => {
  it("round-trips binary64 bit patterns, -0 and NaN included", () => {
    for (const x of [0, -0, 1, -1.5, 5e-324, Number.MAX_VALUE, Number.POSITIVE_INFINITY]) {
      expect(Object.is(f64FromBits(f64Bits(x)), x)).toBe(true);
    }
    expect(Number.isNaN(f64FromBits(f64Bits(Number.NaN)))).toBe(true);
    expect(f64Literal(1).smt).toBe("((_ to_fp 11 53) #x3ff0000000000000)");
  });
});

describe("proven", () => {
  it("clamp stays in [lo, hi] when lo <= hi", async () => {
    const r = await verifyL2(
      CLAMP,
      contract(
        [num("x"), num("lo"), num("hi")],
        ["result >= lo && result <= hi"],
        ["lo <= hi", "x === x"],
      ),
    );
    expect(r.obligations.map((o) => o.outcome)).toEqual(["proven"]);
    expect(r.verdict).toBe("proven");
    expect(r.preconditionsSatisfiable).toBe("yes");
    expect(r.obligations[0]?.queryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("abs is non-negative once NaN is excluded, and returns x or -x", async () => {
    const r = await verifyL2(
      ABS,
      contract([num("x")], ["result >= 0", "result === x || result === -x"], ["x === x"]),
    );
    expect(r.obligations.map((o) => o.outcome)).toEqual(["proven", "proven"]);
    expect(r.verdict).toBe("proven");
  });

  it("max of two numbers is at least each, for non-NaN inputs", async () => {
    const r = await verifyL2(
      "function max(a: number, b: number): number { return a > b ? a : b; }",
      contract([num("a"), num("b")], ["result >= a", "result >= b"], ["a === a", "b === b"]),
    );
    expect(r.verdict).toBe("proven");
  });

  it("booleans: xor through the operators", async () => {
    const r = await verifyL2(
      "function xor(a: boolean, b: boolean): boolean { return (a || b) && !(a && b); }",
      {
        inputs: [
          { name: "a", type: "boolean" },
          { name: "b", type: "boolean" },
        ],
        outputs: [{ type: "boolean" }],
        preconditions: [],
        postconditions: ["result === (a !== b)"],
      },
    );
    expect(r.verdict).toBe("proven");
  });
});

describe("disproven, with counterexamples confirmed by execution", () => {
  it("x === x is false at NaN", async () => {
    const r = await verifyL2(
      "function id(x: number): number { return x; }",
      contract([num("x")], ["result === x"]),
    );
    const o = r.obligations[0];
    expect(o?.outcome).toBe("disproven");
    expect(o?.counterexample?.[0]?.text).toBe("NaN");
    expect(r.verdict).toBe("not-proven");
  });

  it("abs(x) >= 0 fails at NaN without a precondition", async () => {
    const r = await verifyL2(ABS, contract([num("x")], ["result >= 0"]));
    expect(r.obligations[0]?.outcome).toBe("disproven");
    expect(r.obligations[0]?.counterexample?.[0]?.text).toBe("NaN");
  });

  it("x + 1 > x fails for large finite x, as binary64 rounds", async () => {
    const r = await verifyL2(
      "function inc(x: number): number { return x + 1; }",
      contract([num("x")], ["result > x"], ["x === x", "x < Infinity", "x > -Infinity"]),
    );
    const o = r.obligations[0];
    expect(o?.outcome).toBe("disproven");
    const x = o?.counterexample?.[0]?.value as number;
    expect(Number.isFinite(x)).toBe(true);
    expect(x + 1 > x).toBe(false);
  });

  it("clamp returns NaN for a NaN x, which is outside every range", async () => {
    const r = await verifyL2(
      CLAMP,
      contract([num("x"), num("lo"), num("hi")], ["result >= lo && result <= hi"], ["lo <= hi"]),
    );
    const o = r.obligations[0];
    expect(o?.outcome).toBe("disproven");
    expect(o?.counterexample?.[0]?.text).toBe("NaN");
    expect(o?.counterexampleResult).toBe("NaN");
  });

  it("clamp without lo <= hi can leave the range", async () => {
    const r = await verifyL2(
      CLAMP,
      contract([num("x"), num("lo"), num("hi")], ["result >= lo && result <= hi"]),
    );
    expect(r.obligations[0]?.outcome).toBe("disproven");
  });

  it("-0 and 0 are equal under ===, so the counterexample needs Object.is semantics nowhere", async () => {
    const r = await verifyL2(
      "function negzero(x: number): number { return x * 0; }",
      contract([num("x")], ["result === 0"], ["x === x", "x < Infinity", "x > -Infinity"]),
    );
    expect(r.obligations[0]?.outcome).toBe("proven");
  });
});

describe("unsupported, never approximated", () => {
  it("refuses % with the reason", async () => {
    const r = await verifyL2(
      "function odd(x: number): number { return x % 2; }",
      contract([num("x")], ["result < 2"]),
    );
    expect(r.obligations[0]?.outcome).toBe("unsupported");
    expect(r.obligations[0]?.reason).toMatch(/fmod/);
    expect(r.verdict).toBe("not-proven");
  });

  it("refuses calls, throws and loops", async () => {
    for (const src of [
      "function f(x: number): number { return Math.abs(x); }",
      "function f(x: number): number { if (x > 0) throw new Error('no'); return x; }",
      "function f(n: number): number { let s = 0; for (let i = 0; i < n; i++) { s = s + i; } return s; }",
    ]) {
      const r = await verifyL2(src, contract([num("x")], ["result === result"]));
      expect(r.obligations[0]?.outcome, src).toBe("unsupported");
    }
  });

  it("refuses bitwise operations until ToInt32 is encoded", async () => {
    const r = await verifyL2(
      "function f(x: number): number { return x | 0; }",
      contract([num("x")], ["result === result"]),
    );
    expect(r.obligations[0]?.reason).toMatch(/ToInt32/);
  });

  it("refuses types it has no sort for", async () => {
    const r = await verifyL2("function f(s: string): number { return 1; }", {
      inputs: [{ name: "s", type: "string" }],
      outputs: [{ type: "number" }],
      preconditions: [],
      postconditions: ["result === 1"],
    });
    expect(r.obligations[0]?.outcome).toBe("unsupported");
  });

  it("a prose condition is unsupported, not proven", async () => {
    const r = await verifyL2(ABS, contract([num("x")], ["the result is never negative"]));
    expect(r.obligations[0]?.outcome).toBe("unsupported");
  });
});

describe("verdicts that are not proofs", () => {
  it("no postconditions is no-obligations", async () => {
    const r = await verifyL2(ABS, contract([num("x")], []));
    expect(r.verdict).toBe("no-obligations");
  });

  it("unsatisfiable preconditions are vacuous", async () => {
    const r = await verifyL2(ABS, contract([num("x")], ["result < 0"], ["x > 1", "x < 0"]));
    expect(r.preconditionsSatisfiable).toBe("no");
    expect(r.obligations[0]?.outcome).toBe("proven");
    expect(r.verdict).toBe("vacuous");
  });
});

describe("determinism", () => {
  it("the same atom and contract give the same query hash", async () => {
    const c = contract([num("x")], ["result >= 0"], ["x === x"]);
    const a = await verifyL2(ABS, c);
    const b = await verifyL2(liftAtom(ABS), c);
    expect(a.obligations[0]?.queryHash).toBe(b.obligations[0]?.queryHash);
  });

  it("encodes each computed value once, in dependency order", () => {
    const g = liftAtom(CLAMP);
    const params = [0, 1, 2].map((i) => ({ sort: "F64" as const, smt: `((_ to_fp 11 53) p${i})` }));
    const { defs, result } = encodeGraph(g, "impl", params);
    const names = defs.map((d) => /define-fun (\S+)/.exec(d)?.[1]);
    expect(new Set(names).size).toBe(names.length);
    for (const [i, d] of defs.entries()) {
      for (const later of names.slice(i + 1)) expect(d.includes(` ${later} `)).toBe(false);
    }
    expect(result.sort).toBe("F64");
  });
});
