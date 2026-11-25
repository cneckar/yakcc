// SPDX-License-Identifier: Apache-2.0
// ToInt32 and the bitwise operations (#1421 slice 2): each encoding is checked against ECMAScript
// itself at edge values, then used for universal proofs.
import { afterAll, describe, expect, it } from "vitest";
import { shutdownSolver } from "./solver.js";
import { type L2Contract, verifyL2 } from "./verify.js";

afterAll(async () => {
  await shutdownSolver();
});

const num = (name: string) => ({ name, type: "number" });

/** A precondition that pins a parameter to one value (NaN by `x !== x`; -0 and 0 are one case). */
function pin(name: string, v: number): string {
  if (Number.isNaN(v)) return `${name} !== ${name}`;
  return `${name} === ${Object.is(v, -0) ? "-0" : String(v)}`;
}

function expectation(v: number): string {
  return Object.is(v, -0) ? "-0" : String(v);
}

const EDGES = [
  0,
  -0,
  0.9,
  -0.9,
  1.5,
  -1.5,
  5e-324,
  2 ** 31 - 1,
  2 ** 31,
  -(2 ** 31),
  -(2 ** 31) - 1,
  2 ** 32,
  2 ** 32 + 5,
  4294967295.5,
  -4294967297,
  2 ** 53 + 2,
  1e20,
  -1e21,
  2 ** 84 - 2 ** 32,
  2 ** 84,
  2 ** 84 + 2 ** 33,
  Number.MAX_VALUE,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
];

async function pinned(source: string, inputs: readonly number[], expected: number) {
  const names = ["x", "y"].slice(0, inputs.length);
  const c: L2Contract = {
    inputs: names.map(num),
    outputs: [{ type: "number" }],
    preconditions: inputs.map((v, i) => pin(names[i] as string, v)),
    postconditions: [`result === ${expectation(expected)}`],
  };
  return verifyL2(source, c);
}

describe("ToInt32 agrees with ECMAScript at the edges", () => {
  for (const [label, source, f] of [
    ["x | 0", "function f(x: number): number { return x | 0; }", (x: number) => x | 0],
    ["x >>> 0", "function f(x: number): number { return x >>> 0; }", (x: number) => x >>> 0],
    ["~x", "function f(x: number): number { return ~x; }", (x: number) => ~x],
  ] as const) {
    it(label, async () => {
      for (const x of EDGES) {
        const r = await pinned(source, [x], f(x));
        expect(r.verdict, `${label} at ${expectation(x)}`).toBe("proven");
      }
    });
  }
});

describe("the binary operations agree with ECMAScript", () => {
  const PAIRS: readonly (readonly [number, number])[] = [
    [-1, 0],
    [-1, 31],
    [-1, 32],
    [-1, 33],
    [1, 31],
    [0x7fffffff, 1],
    [-(2 ** 31), -1],
    [6.7, 2.9],
    [2 ** 32 + 12, 2 ** 32 + 10],
    [Number.NaN, 3],
    [-5, 1e20],
  ];
  for (const [label, op] of [
    ["&", (a: number, b: number) => a & b],
    ["|", (a: number, b: number) => a | b],
    ["^", (a: number, b: number) => a ^ b],
    ["<<", (a: number, b: number) => a << b],
    [">>", (a: number, b: number) => a >> b],
    [">>>", (a: number, b: number) => a >>> b],
  ] as const) {
    it(label, async () => {
      const source = `function f(x: number, y: number): number { return x ${label} y; }`;
      for (const [a, b] of PAIRS) {
        const r = await pinned(source, [a, b], op(a, b));
        expect(r.verdict, `${a} ${label} ${b}`).toBe("proven");
      }
    });
  }
});

describe("universal properties", () => {
  const one = (post: string, source = "function f(x: number): number { return x | 0; }") =>
    verifyL2(source, {
      inputs: [num("x")],
      outputs: [{ type: "number" }],
      preconditions: [],
      postconditions: [post],
    });

  it("x | 0 is a signed 32-bit integer, and a fixed point of | 0", async () => {
    const r = await one("result >= -2147483648 && result <= 2147483647 && (result | 0) === result");
    expect(r.verdict).toBe("proven");
  });

  it("x >>> 0 is never negative", async () => {
    const r = await one("result >= 0", "function f(x: number): number { return x >>> 0; }");
    expect(r.verdict).toBe("proven");
  });

  it("x | 0 can be negative: disproven, replayed", async () => {
    const r = await one("result >= 0");
    const o = r.obligations[0];
    expect(o?.outcome).toBe("disproven");
    const x = o?.counterexample?.[0]?.value as number;
    expect(x | 0).toBeLessThan(0);
  });

  it("a mask keeps the low byte", async () => {
    const r = await one(
      "result >= 0 && result <= 255",
      "function f(x: number): number { return x & 0xff; }",
    );
    expect(r.verdict).toBe("proven");
  });
});
