// SPDX-License-Identifier: Apache-2.0
// s[i], arrays, and values that may be undefined (#1421).
import { afterAll, describe, expect, it } from "vitest";
import { shutdownSolver } from "./solver.js";
import type { L2Contract } from "./types.js";
import { verifyL2 } from "./verify.js";

afterAll(async () => {
  await shutdownSolver();
});

const c = (
  inputs: Readonly<Record<string, string>>,
  output: string,
  postconditions: readonly string[],
  preconditions: readonly string[] = [],
  loopInvariants?: readonly (readonly string[])[],
): L2Contract => ({
  inputs: Object.entries(inputs).map(([name, type]) => ({ name, type })),
  outputs: [{ type: output }],
  preconditions,
  postconditions,
  ...(loopInvariants !== undefined ? { loopInvariants } : {}),
});
const outcomes = async (src: string, contract: L2Contract) =>
  (await verifyL2(src, contract)).obligations.map((o) => o.outcome);

describe("s[i] and undefined", () => {
  it("is a one-unit string inside the string, undefined past it", async () => {
    expect(
      await outcomes(
        "function at(s: string): boolean { return s[2] === undefined; }",
        c({ s: "string" }, "boolean", ["result === (s.length <= 2)"]),
      ),
    ).toEqual(["proven"]);
    expect(
      await outcomes(
        'function at(s: string): string { return s.length > 2 ? s[2] : ""; }',
        c({ s: "string" }, "string", ["result.length <= 1"]),
      ),
    ).toEqual(["proven", "proven"]); // the postcondition, and that the result is defined
  });

  it("follows ECMAScript's conversions of undefined", async () => {
    expect(
      await outcomes(
        'function tag(s: string): string { return s[5] + "!"; }',
        c({ s: "string" }, "string", [
          's.length > 5 || result === "undefined!"',
          'result.endsWith("!")',
        ]),
      ),
    ).toEqual(["proven", "proven"]);
    expect(
      await outcomes(
        'function first(s: string): string { return s[0] ?? "?"; }',
        c({ s: "string" }, "string", ["result.length === 1", 's.length > 0 || result === "?"']),
      ),
    ).toEqual(["proven", "proven"]);
  });

  it("a key that is not an integer is not an element", async () => {
    expect(
      await outcomes(
        "function f(s: string): boolean { return s[0.5] === undefined && s[-0] === s[0]; }",
        c({ s: "string" }, "boolean", ["result"]),
      ),
    ).toEqual(["proven"]);
  });

  it("a result that may be undefined fails its obligation to be defined", async () => {
    const r = await verifyL2(
      "function at(s: string, i: number): string { return s[i]; }",
      c({ s: "string", i: "number" }, "string", ["true"]),
    );
    expect(r.obligations.find((o) => o.kind === "defined")?.outcome).toBe("disproven");
    expect(r.verdict).toBe("not-proven");
  });
});

describe("arrays", () => {
  it("a sum over an index loop, with undefined reads ruled out by the invariant", async () => {
    const sum =
      "function sum(xs: number[]): number { let s = 0; for (let i = 0; i < xs.length; i++) { s = s + Math.abs(xs[i]); } return s; }";
    const r = await verifyL2(
      sum,
      c(
        { xs: "number[]" },
        "number",
        ["result >= 0 || result !== result"],
        [],
        [["s >= 0 || s !== s"]],
      ),
    );
    expect(r.verdict).toBe("proven");
  });

  it("a counterexample array is replayed", async () => {
    const r = await verifyL2(
      "function first(xs: number[]): number { return xs.length > 0 ? xs[0] : 0; }",
      c({ xs: "number[]" }, "number", ["result >= 0"]),
    );
    const o = r.obligations[0];
    expect(o?.outcome).toBe("disproven");
    expect(o?.confirmed).toBe(true);
    expect(Array.isArray(o?.counterexample?.[0]?.value)).toBe(true);
  });

  it("literals, length, slice and concat", async () => {
    expect(
      await outcomes(
        "function f(xs: number[]): number[] { return xs.concat([1, 2]).slice(1); }",
        c({ xs: "number[]" }, "number[]", [
          "result.length === Math.max(xs.length + 2 - 1, 0)",
          "result[result.length - 1] === 2",
        ]),
      ),
    ).toEqual(["proven", "proven"]);
  });

  it("includes and indexOf on strings", async () => {
    expect(
      await outcomes(
        "function find(xs: string[], s: string): number { return xs.indexOf(s); }",
        c({ xs: "string[]", s: "string" }, "number", [
          "(result >= 0) === xs.includes(s)",
          "result < 0 || xs[result] === s",
        ]),
      ),
    ).toEqual(["proven", "proven"]);
  });

  it("refuses includes on numbers, writes, mutation and === on arrays", async () => {
    for (const [src, out] of [
      ["function f(xs: number[]): boolean { return xs.includes(0); }", "boolean"],
      ["function f(xs: number[]): number { xs[0] = 1; return 1; }", "number"],
      ["function f(xs: number[]): number { xs.push(1); return 1; }", "number"],
      ["function f(xs: number[]): boolean { return xs === xs; }", "boolean"],
    ] as const) {
      expect(await outcomes(src, c({ xs: "number[]" }, out, ["true"])), src).toEqual([
        "unsupported",
      ]);
    }
  });
});
