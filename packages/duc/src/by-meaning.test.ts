// SPDX-License-Identifier: Apache-2.0
/**
 * Operations chosen by meaning from the contract's types (#1310 step 2, DEC-DUC-CROSS-LANGUAGE-OPS-001).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { byMeaning } from "./by-meaning.js";
import { graphIdentity } from "./canonical.js";
import { emitPython } from "./emit-py.js";
import { emitTypeScript } from "./emit-ts.js";
import { type Signature, parseType } from "./infer-types.js";
import { liftAtom } from "./lift.js";
import { ecmaScriptView } from "./ops.js";
import { pythonAst, raisePythonFunction } from "./raise-py.js";
import type { DucGraph } from "./types.js";

const sig = (inputs: string[], output?: string): Signature => ({
  inputs: inputs.map(parseType),
  ...(output !== undefined ? { output: parseType(output) } : {}),
});

const ops = (g: DucGraph): string[] =>
  g.nodes
    .filter((n) => n.kind === "op")
    .map((n) => n.label ?? "")
    .sort();

/** The contract's types as the source's annotations write them. */
function signatureOf(source: string): Signature | undefined {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile("a.ts", source);
  const fn = file.getFunctions()[0];
  if (fn === undefined) return undefined;
  const params = fn.getParameters().map((p) => p.getTypeNode()?.getText());
  if (params.some((t) => t === undefined)) return undefined;
  return sig(params as string[], fn.getReturnTypeNode()?.getText());
}

describe("operations chosen by meaning (#1310)", () => {
  const add = liftAtom("export function f(a, b) { return a + b; }");

  it("the lifter names ECMAScript's operators, whatever the operands", () => {
    expect(ops(add)).toEqual(["js.add"]);
    expect(ops(liftAtom("export function f(a) { return -a; }"))).toEqual(["js.neg"]);
    expect(ops(liftAtom("export function f(a) { return +a; }"))).toEqual(["js.tonumber"]);
  });

  it("`+` is f64.add on numbers, str.concat on strings, js.add otherwise", () => {
    expect(ops(byMeaning(add, sig(["number", "number"])))).toEqual(["f64.add"]);
    expect(ops(byMeaning(add, sig(["string", "string"])))).toEqual(["str.concat"]);
    expect(ops(byMeaning(add, sig(["number", "string"])))).toEqual(["js.add"]);
    expect(ops(byMeaning(add, sig(["number | string", "number"])))).toEqual(["js.add"]);
    expect(ops(byMeaning(add, sig([])))).toEqual(["js.add"]);
  });

  it("ECMAScript's `%` on numbers is the truncated remainder, never the floored modulo", () => {
    const g = byMeaning(
      liftAtom("export function f(a, b) { return a % b; }"),
      sig(["number", "number"]),
    );
    expect(ops(g)).toEqual(["rem.truncated"]);
  });

  it("comparisons, negation, not, length and element reads, by their operands", () => {
    const g = byMeaning(
      liftAtom(
        "export function f(xs: number[], s: string, b: boolean) { return [xs[0] < -xs.length, s === s + s, !b, s.length]; }",
      ),
      sig(["number[]", "string", "boolean"]),
    );
    expect(ops(g)).toEqual(
      expect.arrayContaining([
        "list.get",
        "f64.lt",
        "f64.neg",
        "list.length",
        "str.eq",
        "str.concat",
        "bool.not",
        "str.length.units16",
      ]),
    );
    expect(ops(g).filter((l) => l.startsWith("js."))).toEqual([]);
  });

  it("choosing is idempotent, and gives the same graph from either naming", () => {
    const s = sig(["number", "number"]);
    const once = byMeaning(add, s);
    expect(graphIdentity(byMeaning(once, s))).toBe(graphIdentity(once));
    // Chosen again under a contract that does not give the types, each is ECMAScript's again.
    expect(ops(byMeaning(once, sig([])))).toEqual(["js.add"]);
  });

  it("IEEE addition commutes, string concatenation does not", () => {
    const ab = liftAtom("export function f(a, b) { return a * b + a; }");
    const ba = liftAtom("export function f(a, b) { return a + b * a; }");
    const num = sig(["number", "number"]);
    expect(graphIdentity(byMeaning(ab, num))).toBe(graphIdentity(byMeaning(ba, num)));
    expect(graphIdentity(ab)).not.toBe(graphIdentity(ba));
    const st = liftAtom("export function f(a, b) { return a + b; }");
    const ts = liftAtom("export function f(a, b) { return b + a; }");
    const str = sig(["string", "string"]);
    expect(graphIdentity(byMeaning(st, str))).not.toBe(graphIdentity(byMeaning(ts, str)));
  });

  it("every lowering reads generic operations as the ECMAScript operators they are cases of", () => {
    const s = sig(["number", "number"], "number");
    const g = byMeaning(
      liftAtom("export function f(a: number, b: number): number { return a % b - a; }"),
      s,
    );
    expect(emitTypeScript(g, { inputs: ["number", "number"], output: "number" })).toBe(
      emitTypeScript(
        liftAtom("export function f(a: number, b: number): number { return a % b - a; }"),
        {
          inputs: ["number", "number"],
          output: "number",
        },
      ),
    );
    expect(emitPython(g)).toBe(emitPython(ecmaScriptView(g)));
    expect(ops(ecmaScriptView(g))).toEqual(["%", "-"]);
  });
});

describe("round trip with the contract (#1310)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sample = JSON.parse(
    readFileSync(join(here, "__fixtures__", "corpus-sample.json"), "utf8"),
  ) as { name: string; source: string }[];

  it("graph → TypeScript → graph, chosen again under the same contract, is the same graph: the corpus sample", () => {
    let checked = 0;
    let generic = 0;
    for (const atom of sample) {
      const s = signatureOf(atom.source);
      if (s === undefined) continue;
      const lifted = liftAtom(atom.source);
      // Two seeds do not round-trip without a contract either (a join order, #1316): not this check's.
      if (graphIdentity(liftAtom(emitTypeScript(lifted))) !== graphIdentity(lifted)) continue;
      const g = byMeaning(lifted, s);
      const back = byMeaning(liftAtom(emitTypeScript(g)), s);
      expect(graphIdentity(back), atom.name).toBe(graphIdentity(g));
      checked++;
      if (ops(g).some((l) => !l.startsWith("js.") && /^(f64|str|bool|list|rem)\./.test(l)))
        generic++;
    }
    expect(checked).toBeGreaterThan(40);
    expect(generic).toBeGreaterThan(10);
  });
});

let python = true;
try {
  execFileSync("python3", ["--version"]);
} catch {
  python = false;
}

describe.skipIf(!python)("one identity across languages (#1310)", () => {
  const pyGraph = (source: string): DucGraph => liftAtom(raisePythonFunction(pythonAst(source)));

  it("a function over floats and strings raised from Python is the TypeScript function's graph", () => {
    const cases: [string, string, Signature][] = [
      [
        "def f(a: float, b: float) -> float:\n    return a * b + a - b\n",
        "export function f(a: number, b: number): number { return a * b + a - b; }",
        sig(["number", "number"], "number"),
      ],
      [
        "def f(s: str, t: str) -> str:\n    return s + ', ' + t\n",
        "export function f(s: string, t: string): string { return s + ', ' + t; }",
        sig(["string", "string"], "string"),
      ],
      [
        "def f(a: float, b: float) -> bool:\n    return a < b and a != b\n",
        "export function f(a: number, b: number): boolean { return a < b && a !== b; }",
        sig(["number", "number"], "boolean"),
      ],
    ];
    for (const [py, ts, s] of cases)
      expect(graphIdentity(byMeaning(pyGraph(py), s)), py).toBe(
        graphIdentity(byMeaning(liftAtom(ts), s)),
      );
  });

  it("Python's `%` and ECMAScript's `%` are different operations", () => {
    const s = sig(["number", "number"], "number");
    const py = byMeaning(pyGraph("def f(a: float, b: float) -> float:\n    return a % b\n"), s);
    const js = byMeaning(
      liftAtom("export function f(a: number, b: number): number { return a % b; }"),
      s,
    );
    expect(ops(js)).toEqual(["rem.truncated"]);
    expect(graphIdentity(py)).not.toBe(graphIdentity(js));
  });
});
