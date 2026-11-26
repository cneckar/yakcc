// SPDX-License-Identifier: Apache-2.0
// Records: object types and literals, field reads, records as results (#1421).
import { afterAll, describe, expect, it } from "vitest";
import { typeOf } from "./encoder.js";
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
): L2Contract => ({
  inputs: Object.entries(inputs).map(([name, type]) => ({ name, type })),
  outputs: [{ type: output }],
  preconditions,
  postconditions,
});
const POINT = "{ x: number; y: number }";

describe("record types", () => {
  it("parses fields, optional and readonly fields, and nesting", () => {
    expect(typeOf("{ readonly a: number, b?: string; c: { d: boolean[] } }", "t")).toEqual({
      kind: "record",
      fields: [
        { name: "a", optional: false, type: { kind: "sort", sort: "F64" } },
        { name: "b", optional: true, type: { kind: "sort", sort: "Str" } },
        {
          name: "c",
          optional: false,
          type: {
            kind: "record",
            fields: [{ name: "d", optional: false, type: { kind: "sort", sort: "ArrBool" } }],
          },
        },
      ],
    });
  });
});

describe("records", () => {
  it("swap the fields of a point", async () => {
    const r = await verifyL2(
      "function swap(p: { x: number; y: number }): { x: number; y: number } { return { x: p.y, y: p.x }; }",
      c({ p: POINT }, POINT, [
        "result.x === p.y || p.y !== p.y",
        "result.y === p.x || p.x !== p.x",
      ]),
    );
    expect(r.verdict).toBe("proven");
  });

  it("a record built in a branch, and a nested field", async () => {
    const r = await verifyL2(
      "function clampBox(b: { min: { x: number }; max: { x: number } }, v: number): { lo: number; hi: number } { const box = v < b.min.x ? { lo: v, hi: b.max.x } : { lo: b.min.x, hi: b.max.x }; return box; }",
      c(
        { b: "{ min: { x: number }; max: { x: number } }", v: "number" },
        "{ lo: number; hi: number }",
        [
          "result.lo <= b.min.x || result.lo !== result.lo || b.min.x !== b.min.x",
          "result.hi === b.max.x || b.max.x !== b.max.x",
        ],
      ),
    );
    expect(r.verdict).toBe("proven");
  });

  it("an optional field is undefined when absent, and ?? defaults it", async () => {
    const r = await verifyL2(
      'function label(o: { name?: string }): string { return o.name ?? "anonymous"; }',
      c({ o: "{ name?: string }" }, "string", ['result.length > 0 || o.name === ""']),
    );
    expect(r.verdict).toBe("proven");
  });

  it("a missing field reads as undefined", async () => {
    const r = await verifyL2(
      "function f(p: { x: number; y: number }): boolean { const q = { x: p.x }; return q.y === undefined; }",
      c({ p: POINT }, "boolean", ["result"]),
    );
    expect(r.verdict).toBe("proven");
  });

  it("a counterexample record is assembled and replayed", async () => {
    const r = await verifyL2(
      "function sum(p: { x: number; y: number }): number { return p.x + p.y; }",
      c({ p: POINT }, "number", ["result > p.x"]),
    );
    const o = r.obligations[0];
    expect(o?.outcome).toBe("disproven");
    expect(o?.confirmed).toBe(true);
    const p = o?.counterexample?.[0]?.value as unknown as { x: number; y: number };
    expect(typeof p.x).toBe("number");
    expect(p.x + p.y > p.x).toBe(false);
  });

  it("refuses spreads, computed keys, writes and === on records", async () => {
    for (const [src, out] of [
      [
        "function f(p: { x: number; y: number }): number { const q = { ...p }; return q.x; }",
        "number",
      ],
      [
        "function f(p: { x: number; y: number }): number { const o = { ['x']: 1 }; return o.x; }",
        "number",
      ],
      ["function f(p: { x: number; y: number }): number { p.x = 1; return 1; }", "number"],
      ["function f(p: { x: number; y: number }): boolean { return p === p; }", "boolean"],
    ] as const) {
      const r = await verifyL2(src, c({ p: POINT }, out, ["true"]));
      expect(r.obligations[0]?.outcome, src).toBe("unsupported");
    }
  });
});
