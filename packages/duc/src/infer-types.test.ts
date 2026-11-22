import { Project, ts } from "ts-morph";
// SPDX-License-Identifier: Apache-2.0
/**
 * Type inference over the graph (#1277, T1). The contract's types seed the parameters; every value's
 * inferred type is checked against what TypeScript infers for the same value in the emitted code,
 * annotated from the same contract. Integer and float are kept apart where TypeScript cannot.
 */
import { describe, expect, it } from "vitest";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { emitTypeScript } from "./emit-ts.js";
import {
  type DucType,
  inferTypes,
  parseType,
  typeToText,
  typeToTypeScript,
} from "./infer-types.js";
import { liftAtom } from "./lift.js";

/** The contract a source declares: its parameter and result annotations. */
function signatureOf(source: string): { inputs: string[]; output?: string } {
  const sf = ts.createSourceFile("s.ts", source, ts.ScriptTarget.Latest, true);
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (fn === undefined) throw new Error("no function");
  return {
    inputs: fn.parameters.map((p) => p.type?.getText(sf) ?? "unknown"),
    ...(fn.type !== undefined ? { output: fn.type.getText(sf) } : {}),
  };
}

/** TypeScript's widened type of each `const $vN` of the emitted code. */
function typescriptTypes(code: string): Map<string, string> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts"],
      noEmit: true,
    },
  });
  const sf = project.createSourceFile("/emitted.ts", code);
  const checker = project.getTypeChecker().compilerObject;
  const out = new Map<string, string>();
  for (const d of sf.getDescendantsOfKind(ts.SyntaxKind.VariableDeclaration)) {
    const name = d.getName();
    if (!/^\$v\d+$/.test(name)) continue;
    const t = checker.getBaseTypeOfLiteralType(
      checker.getTypeAtLocation(d.getNameNode().compilerNode),
    );
    out.set(name.slice(1), checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation));
  }
  return out;
}

/** Both sides as TypeScript writes them, members in order, so `{ a: number; }` and `{ a: number }` agree. */
const normal = (text: string): string => typeToTypeScript(parseType(text));

describe("type inference against TypeScript's (#1277)", () => {
  for (const tc of EMIT_CASES) {
    it(`agrees with TypeScript on every value: ${tc.name}`, () => {
      const g = liftAtom(tc.source);
      const sig = signatureOf(tc.source);
      const report = inferTypes(g, {
        inputs: sig.inputs.map(parseType),
        ...(sig.output !== undefined ? { output: parseType(sig.output) } : {}),
      });
      expect(report.mismatches).toEqual([]);
      const theirs = typescriptTypes(emitTypeScript(g, sig));
      const disagreements: string[] = [];
      for (const [v, t] of theirs) {
        const ours = report.types.get(v as never);
        if (ours === undefined || ours.k === "unknown" || t === "any" || t === "unknown") continue;
        if (normal(typeToTypeScript(ours)) !== normal(t))
          disagreements.push(`${v}: ours ${typeToTypeScript(ours)}, TypeScript ${t}`);
      }
      expect(disagreements).toEqual([]);
    });
  }

  it("knows most values: few are left unknown", () => {
    let known = 0;
    let total = 0;
    for (const tc of EMIT_CASES) {
      const sig = signatureOf(tc.source);
      const report = inferTypes(liftAtom(tc.source), { inputs: sig.inputs.map(parseType) });
      for (const t of report.types.values()) {
        total++;
        if (t.k !== "unknown") known++;
      }
    }
    expect(known / total).toBeGreaterThan(0.8);
  });
});

describe("integer and float (#1277)", () => {
  const infer = (src: string, inputs: string[]): DucType | undefined =>
    inferTypes(liftAtom(src), { inputs: inputs.map(parseType) }).results[0];

  it("the contract's language says integer and float; TypeScript reads both as number", () => {
    expect(typeToText(parseType("integer[]"))).toBe("integer[]");
    expect(typeToTypeScript(parseType("{ n: integer; x: float }"))).toBe(
      "{ n: number; x: number }",
    );
  });

  it("integer arithmetic stays integer, division is float, mixing is number", () => {
    expect(
      infer("export function f(a: number, b: number) { return a * b + 1; }", [
        "integer",
        "integer",
      ]),
    ).toEqual({ k: "num", n: "integer" });
    expect(
      infer("export function f(a: number, b: number) { return a / b; }", ["integer", "integer"]),
    ).toEqual({ k: "num", n: "float" });
    expect(
      infer("export function f(a: number, b: number) { return a + b; }", ["integer", "float"]),
    ).toEqual({ k: "num", n: "float" });
  });

  it("lengths, indexes and Math.floor are integers", () => {
    expect(
      infer("export function f(s: string) { return s.length + s.indexOf('a'); }", ["string"]),
    ).toEqual({ k: "num", n: "integer" });
    expect(infer("export function f(x: number) { return Math.floor(x / 2); }", ["float"])).toEqual({
      k: "num",
      n: "integer",
    });
  });

  it("a plain number, and an array with no element, are reported as ambiguous", () => {
    const r = inferTypes(
      liftAtom("export function f(a: number) { const xs = []; return a + 1; }"),
      { inputs: [parseType("number")] },
    );
    expect(r.ambiguities.some((a) => /integer or float/.test(a.reason))).toBe(true);
    const e = inferTypes(liftAtom("export function f() { return []; }"), { inputs: [] });
    expect(e.ambiguities.some((a) => /no element/.test(a.reason))).toBe(true);
  });

  it("a loop's carried value is the fixpoint of its start and next values", () => {
    expect(
      infer(
        "export function f(n: number) { let s = 0; let i = 0; while (i < n) { s = s + i / 2; i = i + 1; } return s; }",
        ["integer"],
      ),
    ).toEqual({
      k: "num",
      n: "number",
    });
    expect(
      infer(
        "export function f(n: number) { let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + i; } return s; }",
        ["integer"],
      ),
    ).toEqual({
      k: "num",
      n: "integer",
    });
  });

  it("a closure's result is inferred at its call", () => {
    expect(
      infer("export function f(k: number) { const add = (y: number) => y + k; return add(1); }", [
        "integer",
      ]),
    ).toEqual({ k: "num", n: "integer" });
  });

  it("a result that does not fit the contract is a mismatch", () => {
    const r = inferTypes(liftAtom("export function f(a: number) { return String(a); }"), {
      inputs: [parseType("integer")],
      output: parseType("integer"),
    });
    expect(r.mismatches.length).toBe(1);
  });
});

describe("the emitter annotates from the contract (#1277)", () => {
  it("parameters and the result carry the contract's types", () => {
    const code = emitTypeScript(liftAtom("export function f(a, b) { return a + b; }"), {
      inputs: ["integer", "float"],
      output: "float",
    });
    expect(code).toContain("export function f($v0: number, $v1: number): number {");
  });
});
