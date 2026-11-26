// SPDX-License-Identifier: Apache-2.0
// Loops with invariants (slice 3), calls by link and Math's exact functions (slice 4), throws as
// paths (slice 5): #1421.
import { liftAtom } from "@yakcc/duc";
import { afterAll, describe, expect, it } from "vitest";
import { loopsOf } from "./encoder.js";
import { shutdownSolver } from "./solver.js";
import type { Callee, L2Contract } from "./types.js";
import { verifyL2 } from "./verify.js";

afterAll(async () => {
  await shutdownSolver();
});

const num = (name: string) => ({ name, type: "number" });
const c = (
  inputs: readonly string[],
  postconditions: readonly string[],
  preconditions: readonly string[] = [],
  loopInvariants?: readonly (readonly string[])[],
): L2Contract => ({
  inputs: inputs.map(num),
  outputs: [{ type: "number" }],
  preconditions,
  postconditions,
  ...(loopInvariants !== undefined ? { loopInvariants } : {}),
});
const outcomes = (r: { obligations: readonly { id: string; outcome: string }[] }) =>
  Object.fromEntries(r.obligations.map((o) => [o.id, o.outcome]));

const SUM =
  "function sumTo(n: number): number { let s = 0; for (let i = 0; i < n; i++) { s = s + i; } return s; }";

describe("slice 3: loops with invariants", () => {
  it("lists loops with their carried variables, a reassigned parameter renamed", () => {
    expect(loopsOf(liftAtom(SUM))).toMatchObject([{ index: 0, carried: ["s", "i"] }]);
    const down =
      "function f(n: number): number { let c = 0; while (n > 0) { n = n - 1; c = c + 1; } return c; }";
    expect(loopsOf(liftAtom(down))[0]?.carried).toContain("c");
  });

  it("proves a sum of non-negative terms is non-negative, with an inductive invariant", async () => {
    const r = await verifyL2(SUM, c(["n"], ["result >= 0"], [], [["s >= 0 && i >= 0"]]));
    expect(outcomes(r)).toEqual({
      post_0: "proven",
      loop_0_entry: "proven",
      loop_0_preserve: "proven",
    });
    expect(r.verdict).toBe("proven");
    expect(r.abstractions).toEqual(["loop 0 (by its invariants)"]);
  });

  it("without an invariant, a spurious counterexample is unknown, not disproven", async () => {
    const r = await verifyL2(SUM, c(["n"], ["result >= 0"]));
    const o = r.obligations[0];
    expect(o?.outcome).toBe("unknown");
    expect(o?.confirmed).toBe(false);
    expect(o?.reason).toMatch(/too weak/);
  });

  it("an invariant false on entry is disproven at entry", async () => {
    const r = await verifyL2(SUM, c(["n"], ["result >= 0"], [], [["s > 0"]]));
    expect(outcomes(r).loop_0_entry).toBe("disproven");
    expect(r.verdict).toBe("not-proven");
  });

  it("an invariant that is not inductive is disproven at preservation, with the state shown", async () => {
    const r = await verifyL2(SUM, c(["n"], ["result <= 100"], [], [["s <= 100 && i >= 0"]]));
    const o = r.obligations.find((x) => x.id === "loop_0_preserve");
    expect(o?.outcome).toBe("disproven");
    expect(o?.counterexample?.map((v) => v.name)).toEqual(["n", "s", "i"]);
  });

  it("a wrong invariant does not prove itself through its own exit", async () => {
    // `false` makes the exit unsatisfiable; the entry obligation must not assume it.
    const r = await verifyL2(SUM, c(["n"], ["result === 42"], [], [["false"]]));
    expect(outcomes(r).post_0).toBe("proven");
    expect(outcomes(r).loop_0_entry).toBe("disproven");
    expect(r.verdict).toBe("not-proven");
  });

  it("partial correctness: the exit condition proves a bound, and NaN is a real counterexample", async () => {
    const spin = "function f(x: number): number { while (x > 0) { x = x + 0; } return x; }";
    // The reassigned parameter's carried value is `$carry0`; `x` is the argument.
    const withNaN = await verifyL2(
      spin,
      c(["x"], ["result <= 0"], ["x !== x"], [["$carry0 !== $carry0"]]),
    );
    expect(withNaN.obligations[0]?.outcome).toBe("disproven");
    expect(withNaN.obligations[0]?.confirmed).toBe(true);
    expect(withNaN.obligations[0]?.counterexample?.[0]?.text).toBe("NaN");
    // Without an invariant the exit value is unconstrained but for the exit condition, so NaN is
    // possible; the invariant that the carried value is not NaN proves the bound.
    const loose = await verifyL2(spin, c(["x"], ["result <= 0"], ["x === x"]));
    expect(loose.obligations[0]?.outcome).toBe("unknown");
    const noNaN = await verifyL2(
      spin,
      c(["x"], ["result <= 0"], ["x === x"], [["$carry0 === $carry0"]]),
    );
    expect(noNaN.verdict).toBe("proven");
  });

  it("a counterexample whose replay does not terminate is unknown", async () => {
    const spin = "function f(x: number): number { while (x > 0) { x = x + 0; } return x; }";
    const r = await verifyL2(spin, c(["x"], ["result === 7"], ["x === x"]), {
      replayTimeoutMs: 200,
    });
    const o = r.obligations[0];
    expect(["disproven", "unknown"]).toContain(o?.outcome);
    if (o?.outcome === "unknown") expect(o.reason).toMatch(/does not reproduce/);
  });

  it("loops with bitwise steps", async () => {
    const pop =
      "function pop(x: number): number { let c = 0; let v = x >>> 0; while (v !== 0) { c = c + (v & 1); v = v >>> 1; } return c; }";
    const r = await verifyL2(pop, c(["x"], ["result >= 0"], [], [["c >= 0 && v >= 0"]]));
    expect(r.verdict).toBe("proven");
  });
});

describe("slice 4: Math's exact functions", () => {
  it("abs, floor and max", async () => {
    const r = await verifyL2(
      "function f(x: number, y: number): number { return Math.max(Math.abs(x), Math.floor(y)); }",
      c(["x", "y"], ["result >= 0", "result >= Math.floor(y)"], ["x === x", "y === y"]),
    );
    expect(r.verdict).toBe("proven");
  });

  it("Math.min(-0, 0) is -0", async () => {
    const r = await verifyL2(
      "function f(): number { return Math.min(0, -0); }",
      c([], ["1 / result === -Infinity"]),
    );
    expect(r.verdict).toBe("proven");
  });

  it("sqrt(x * x) is not always |x|: disproven, replayed", async () => {
    const r = await verifyL2(
      "function f(x: number): number { return Math.sqrt(x * x); }",
      c(["x"], ["result === Math.abs(x)"], ["x === x"]),
    );
    expect(r.obligations[0]?.outcome).toBe("disproven");
    expect(r.obligations[0]?.confirmed).toBe(true);
  });

  it("Math.round and the approximated functions are refused", async () => {
    for (const f of ["round", "sin", "exp", "random"]) {
      const r = await verifyL2(
        `function f(x: number): number { return Math.${f}(x); }`,
        c(["x"], ["true"]),
      );
      expect(r.obligations[0]?.outcome, f).toBe("unsupported");
    }
  });
});

describe("slice 4: calls by link", () => {
  const CLAMP01 =
    "function clamp01(x: number): number { if (x < 0) return 0; if (x > 1) return 1; return x; }";
  const clamp01 = (proven: boolean): Record<string, Callee> => ({
    "./clamp01.js#clamp01": {
      contract: c(["x"], ["result >= 0 && result <= 1"], ["x === x"]),
      proven,
      root: "blake3:feedface",
      source: CLAMP01,
    },
  });
  const CALLER =
    'import { clamp01 } from "./clamp01.js";\nexport function f(x: number): number { return clamp01(x) * 2; }';

  it("assumes a proven callee's postconditions, and proves its precondition at the call", async () => {
    const r = await verifyL2(CALLER, c(["x"], ["result <= 2"], ["x === x"]), {
      callees: clamp01(true),
    });
    expect(outcomes(r)).toEqual({ post_0: "proven", call_clamp01_0_pre_0: "proven" });
    expect(r.callees).toEqual([
      { key: "./clamp01.js#clamp01", proven: true, root: "blake3:feedface" },
    ]);
    expect(r.verdict).toBe("proven");
  });

  it("an unproven callee's result is unconstrained: the counterexample does not reproduce", async () => {
    const r = await verifyL2(CALLER, c(["x"], ["result <= 2"], ["x === x"]), {
      callees: clamp01(false),
    });
    expect(r.obligations[0]?.outcome).toBe("unknown");
    expect(r.obligations[0]?.reason).toMatch(/too weak/);
  });

  it("a call that can break the callee's precondition is disproven", async () => {
    const r = await verifyL2(CALLER, c(["x"], ["result <= 2"]), { callees: clamp01(true) });
    expect(outcomes(r).call_clamp01_0_pre_0).toBe("disproven");
    expect(r.verdict).toBe("not-proven");
  });

  it("a call whose result is unused still has its precondition checked", async () => {
    const src =
      'import { clamp01 } from "./clamp01.js";\nexport function f(x: number): number { clamp01(x); return 1; }';
    const r = await verifyL2(src, c(["x"], ["result === 1"]), { callees: clamp01(true) });
    expect(outcomes(r).call_clamp01_0_pre_0).toBe("disproven");
  });

  it("a call that is not supplied is refused, even when its result is unused", async () => {
    const r = await verifyL2(
      "function f(x: number): number { console.log(x); return x; }",
      c(["x"], ["result === x"], ["x === x"]),
    );
    expect(r.obligations[0]?.outcome).toBe("unsupported");
  });
});

describe("slice 5: throws as paths", () => {
  const G =
    'function g(x: number): number { if (x < 0) { throw new RangeError("neg"); } const y = x * 2; return y; }';

  it("postconditions hold on normal returns; the throw is reported reachable, with an input", async () => {
    const r = await verifyL2(G, c(["x"], ["result >= 0"], ["x === x"]));
    expect(r.verdict).toBe("proven");
    expect(r.throws).toHaveLength(1);
    expect(r.throws[0]?.reachable).toBe("yes");
    expect(r.throws[0]?.example?.[0]?.value as number).toBeLessThan(0);
  });

  it("a precondition can make a throw unreachable", async () => {
    const r = await verifyL2(G, c(["x"], ["result >= 0"], ["x >= 0"]));
    expect(r.throws[0]?.reachable).toBe("no");
  });

  it("a nested throw beside Math calls", async () => {
    const h =
      'function h(x: number): number { let r = 0; if (x > 1) { r = 1; } else if (x < -1) { throw new Error("e"); } else { r = 2; } return r + Math.floor(x); }';
    const r = await verifyL2(h, c(["x"], ["result >= 1"], ["x === x"]));
    expect(r.verdict).toBe("proven");
    expect(r.throws[0]?.reachable).toBe("yes");
  });

  it("a counterexample on a normal return is still found and replayed", async () => {
    const r = await verifyL2(G, c(["x"], ["result > 0"], ["x === x"]));
    expect(r.obligations[0]?.outcome).toBe("disproven");
    expect(r.obligations[0]?.confirmed).toBe(true);
    expect(r.obligations[0]?.counterexample?.[0]?.value === 0).toBe(true);
  });
});
