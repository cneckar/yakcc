// SPDX-License-Identifier: Apache-2.0
// Per-target base sets (#1282): which names a target provides, and their labels.
import { describe, expect, it } from "vitest";
import { ECMASCRIPT, NODE, nondeterministicObservations, primitiveReport } from "./base-set.js";
import { checkSubmission, closureOf } from "./closure.js";
import { liftAtom } from "./lift.js";

const lift = (body: string, params = "x: number"): ReturnType<typeof liftAtom> =>
  liftAtom(`export function f(${params}): unknown { ${body} }`);

describe("per-target base sets (#1282)", () => {
  it("process and timers are platform primitives with a capability, not holes", () => {
    const g = lift("setTimeout(() => 1, x); return process.env.HOME;");
    const report = primitiveReport(g, NODE);
    expect(report.uses.find((u) => u.symbol === "process")?.capabilities).toEqual(["process"]);
    expect(report.uses.find((u) => u.symbol === "setTimeout")?.capabilities).toEqual(["timers"]);
    expect(closureOf(g, { baseSet: NODE }).closed).toBe(true);
  });

  it("a Node primitive is a hole on a target that does not provide it", () => {
    const g = lift("return process.env.HOME;");
    expect(closureOf(g, { baseSet: ECMASCRIPT }).unlinked).toContain("process");
    expect(checkSubmission([{ spec: "s", graph: g }], new Set(), ECMASCRIPT).accepted).toBe(false);
    expect(checkSubmission([{ spec: "s", graph: g }], new Set(), NODE).accepted).toBe(true);
  });

  it("require, module and exports are not primitives: they are holes (D5)", () => {
    const g = lift("const m = require('m'); module.exports = m; return exports;");
    expect(closureOf(g, { baseSet: NODE }).unlinked).toEqual(["exports", "module", "require"]);
  });

  it("a member can be nondeterministic when its symbol is not", () => {
    const random = primitiveReport(lift("return Math.random() * x;"), ECMASCRIPT).uses[0];
    const floor = primitiveReport(lift("return Math.floor(x);"), ECMASCRIPT).uses[0];
    expect(random?.nondeterministic).toBe(true);
    expect(floor?.nondeterministic).toBe(false);
  });

  it("a nondeterministic primitive that reaches an observation is reported (#1270)", () => {
    expect(nondeterministicObservations(lift("return Math.random() + x;"), ECMASCRIPT)).toEqual([
      { obs: 0, source: "Math.random" },
    ]);
    expect(
      nondeterministicObservations(lift("return Date.now() - x;"), ECMASCRIPT).map((r) => r.source),
    ).toEqual(["Date"]);
    expect(nondeterministicObservations(lift("return Math.floor(x);"), ECMASCRIPT)).toEqual([]);
  });

  it("primitives used inside a closure are reported", () => {
    const report = primitiveReport(
      lift("const g = (y: number) => Math.random() + y; return g(x);"),
      ECMASCRIPT,
    );
    expect(report.uses.map((u) => u.symbol)).toEqual(["Math"]);
  });

  it("Node's web data classes are its globals: the Fetch API's, streams, DOMException (#1368)", () => {
    for (const name of ["Headers", "Request", "Response", "ReadableStream", "DOMException"])
      expect(NODE.primitives[name], name).toEqual({});
    expect(NODE.primitives.fetch).toEqual({ capability: "network" });
  });
});
