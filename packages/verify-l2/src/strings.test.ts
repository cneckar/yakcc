// SPDX-License-Identifier: Apache-2.0
// Strings as sequences of UTF-16 code units (#1421, the strings slice).
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
): L2Contract => ({
  inputs: Object.entries(inputs).map(([name, type]) => ({ name, type })),
  outputs: [{ type: output }],
  preconditions,
  postconditions,
});
const S = { s: "string" };
const verdict = async (src: string, contract: L2Contract) =>
  (await verifyL2(src, contract)).verdict;

describe("proven", () => {
  it("concatenation adds lengths, keeps a prefix and a suffix", async () => {
    const r = await verifyL2(
      "function join(p: string, s: string): string { return p + s; }",
      c({ p: "string", s: "string" }, "string", [
        "result.length === p.length + s.length",
        "result.startsWith(p)",
        "result.endsWith(s)",
        "result.includes(s)",
      ]),
    );
    expect(r.obligations.map((o) => o.outcome)).toEqual(["proven", "proven", "proven", "proven"]);
    expect(r.verdict).toBe("proven");
  });

  it("slice(0, 3) is at most 3 units, and a prefix", async () => {
    expect(
      await verdict(
        "function head(s: string): string { return s.slice(0, 3); }",
        c(S, "string", ["result.length <= 3", "s.startsWith(result)"]),
      ),
    ).toBe("proven");
  });

  it("a negative slice counts from the end", async () => {
    expect(
      await verdict(
        "function tail(s: string): string { return s.slice(-2); }",
        c(S, "string", ["result.length === Math.min(2, s.length)", "s.endsWith(result)"]),
      ),
    ).toBe("proven");
  });

  it("substring swaps its bounds", async () => {
    expect(
      await verdict(
        "function f(s: string): string { return s.substring(3, 1); }",
        c(S, "string", ["result === s.substring(1, 3)"]),
      ),
    ).toBe("proven");
  });

  it("charCodeAt is NaN exactly past the end, and a code unit otherwise", async () => {
    expect(
      await verdict(
        "function first(s: string): number { return s.charCodeAt(0); }",
        c(S, "number", [
          "(result === result) === (s.length > 0)",
          "s.length === 0 || (result >= 0 && result < 65536)",
        ]),
      ),
    ).toBe("proven");
  });

  it("indexOf finds where the search string is", async () => {
    expect(
      await verdict(
        "function find(s: string, t: string): number { return s.indexOf(t); }",
        c({ s: "string", t: "string" }, "number", [
          "result >= -1",
          "result === -1 || s.slice(result, result + t.length) === t",
          "(result === -1) === !s.includes(t)",
        ]),
      ),
    ).toBe("proven");
  });

  it("template literals and string truthiness", async () => {
    expect(
      await verdict(
        "function greet(name: string): string { return `hi ${name}!`; }",
        c({ name: "string" }, "string", [
          "result.length === name.length + 4",
          'result.startsWith("hi ")',
        ]),
      ),
    ).toBe("proven");
    expect(
      await verdict(
        "function nonEmpty(s: string): boolean { return s ? true : false; }",
        c(S, "boolean", ["result === (s.length > 0)"]),
      ),
    ).toBe("proven");
  });

  it("a character outside the BMP is two code units", async () => {
    expect(
      await verdict(
        'function f(): number { return "😀".length; }',
        c({}, "number", ["result === 2"]),
      ),
    ).toBe("proven");
  });

  it("strings in a loop, by an invariant", async () => {
    const pad =
      'function pad(s: string, n: number): string { let r = s; while (r.length < n) { r = " " + r; } return r; }';
    const r = await verifyL2(pad, {
      ...c({ s: "string", n: "number" }, "string", [
        "result.endsWith(s)",
        "result.length >= n || n !== n",
      ]),
      loopInvariants: [["r.endsWith(s)"]],
    });
    expect(r.verdict).toBe("proven");
  });
});

describe("disproven, with string counterexamples replayed", () => {
  it("a length bound", async () => {
    const r = await verifyL2(
      "function len(s: string): number { return s.length; }",
      c(S, "number", ["result < 5"]),
    );
    const o = r.obligations[0];
    expect(o?.outcome).toBe("disproven");
    expect(o?.confirmed).toBe(true);
    expect((o?.counterexample?.[0]?.value as string).length).toBeGreaterThanOrEqual(5);
  });

  it("slice(0, 3) is not always 3 units", async () => {
    const r = await verifyL2(
      "function head(s: string): string { return s.slice(0, 3); }",
      c(S, "string", ["result.length === 3"]),
    );
    expect(r.obligations[0]?.outcome).toBe("disproven");
    expect(r.obligations[0]?.confirmed).toBe(true);
  });
});

describe("unsupported, never approximated", () => {
  for (const [why, src] of [
    ["a number's ToString", "function f(s: string): string { return s + 1; }"],
    ["code-unit order", 'function f(s: string): boolean { return s < "m"; }'],
    ["an unencoded method", "function f(s: string): string { return s.toUpperCase(); }"],
    ["a search position", 'function f(s: string): number { return s.indexOf("a", 2); }'],
    ["StringToNumber", "function f(s: string): number { return s * 2; }"],
  ] as const) {
    it(why, async () => {
      const r = await verifyL2(
        src,
        c(
          S,
          src.includes("): string") ? "string" : src.includes("): boolean") ? "boolean" : "number",
          ["true"],
        ),
      );
      expect(r.obligations[0]?.outcome, src).toBe("unsupported");
    });
  }

  it("an unused .length on a number is still refused", async () => {
    const r = await verifyL2(
      "function f(x: number): number { x.length; return 1; }",
      c({ x: "number" }, "number", ["result === 1"]),
    );
    expect(r.obligations[0]?.outcome).toBe("unsupported");
  });
});
