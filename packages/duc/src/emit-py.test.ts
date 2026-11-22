// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering to Python (#1278): each source's graph lowered to Python computes, on the same inputs,
 * what the source computes in JavaScript (conformance), run with the system's python3.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { PY_PRELUDE, PyEmitError, emitPython } from "./emit-py.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";

const UNDEF = { $undefined: true };

/** The result as JSON, with undefined kept apart from null, and integral numbers as integers. */
const DRIVER = `
import json, sys

def _tojson(x):
    if x is UNDEFINED:
        return {"$undefined": True}
    if isinstance(x, float) and not math.isnan(x) and not math.isinf(x) and x == int(x):
        return int(x)
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    if isinstance(x, list):
        return [_tojson(e) for e in x]
    if isinstance(x, dict):
        return {k: _tojson(v) for k, v in x.items()}
    return x

for line in sys.stdin:
    args = json.loads(line)
    try:
        out = {"value": _tojson(f(*args))}
    except JsError as e:
        out = {"threw": e.kind + ": " + e.message}
    except JsThrow as e:
        out = {"threw": str(e.value)}
    print(json.dumps(out))
`;

function runPython(code: string, inputs: readonly unknown[][]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), "duc-py-"));
  const file = join(dir, "m.py");
  writeFileSync(file, `${PY_PRELUDE}\n\n${code}\n${DRIVER}`);
  const out = execFileSync("python3", [file], {
    input: inputs.map((a) => JSON.stringify(a)).join("\n"),
    encoding: "utf8",
  });
  return out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as unknown);
}

const toJson = (x: unknown): unknown => {
  if (x === undefined) return UNDEF;
  if (Array.isArray(x)) return x.map(toJson);
  if (x !== null && typeof x === "object")
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toJson(v)]));
  if (typeof x === "number" && !Number.isFinite(x)) return null;
  return x;
};

function runJs(source: string, inputs: readonly unknown[][]): unknown[] {
  const code = emitTypeScript(liftAtom(source));
  const f = new Function(`${code.replace("export ", "")}; return f;`)() as (
    ...a: unknown[]
  ) => unknown;
  return inputs.map((args) => {
    try {
      return { value: toJson(f(...structuredClone(args))) };
    } catch (e) {
      return { threw: `${(e as Error).name}: ${(e as Error).message}` };
    }
  });
}

const python = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!python)("lowering to Python: conformance (#1278)", () => {
  for (const tc of EMIT_CASES) {
    it(`computes what the source computes: ${tc.name}`, () => {
      const g = liftAtom(tc.source);
      const code = emitPython(g);
      expect(runPython(code, tc.args), code).toEqual(runJs(tc.source, tc.args));
    });
  }

  const more: [string, string, unknown[][]][] = [
    [
      "string methods",
      "export function f(s: string) { return s.trim().toUpperCase() + s.indexOf('b') + s.slice(1, 3); }",
      [["  abc "], ["b"]],
    ],
    [
      "JavaScript's remainder and division",
      "export function f(a: number, b: number) { return [a % b, a / b, -a % b]; }",
      [
        [7, 3],
        [7, 0],
        [-7, 2],
      ],
    ],
    [
      "strict equality and truthiness",
      "export function f(x: unknown) { return [x === 0, x === '0', !x, x ?? 'none']; }",
      [[0], ["0"], [""], [null]],
    ],
    [
      "lazy && with a member read",
      "export function f(s: any) { return s && s.length; }",
      [["abc"], [null], [""]],
    ],
    [
      "a closure",
      "export function f(k: number) { const add = (y: number) => y + k; return add(1) * add(2); }",
      [[0], [3]],
    ],
    [
      "break and continue",
      "export function f(n: number) { let s = 0; for (let i = 0; i < n; i = i + 1) { if (i % 2 === 0) continue; if (s > 10) break; s = s + i; } return s; }",
      [[0], [7], [30]],
    ],
    [
      "a return from a loop",
      "export function f(xs: number[], k: number) { let i = 0; while (i < xs.length) { if (xs[i] === k) return i; i = i + 1; } return -1; }",
      [
        [[4, 5, 6], 5],
        [[4, 5, 6], 9],
      ],
    ],
    [
      "a throw on some paths",
      "export function f(x: number) { if (x < 0) throw new RangeError('negative'); return Math.floor(x / 2); }",
      [[5], [-1]],
    ],
    [
      "a switch",
      "export function f(k: string) { switch (k) { case 'a': return 1; case 'b': case 'c': return 2; default: return 3; } }",
      [["a"], ["c"], ["z"]],
    ],
    [
      "destructuring with defaults",
      "export function f(o: any) { const { a, b = 7 } = o; return a + b; }",
      [[{ a: 1 }], [{ a: 1, b: 2 }]],
    ],
    [
      "a template and Math",
      "export function f(a: number, b: number) { return `${Math.max(a, b)}-${Math.min(a, b)}`; }",
      [
        [1, 4],
        [7, 2],
      ],
    ],
  ];
  for (const [name, src, inputs] of more) {
    it(`computes what the source computes: ${name}`, () => {
      const code = emitPython(liftAtom(src));
      expect(runPython(code, inputs), code).toEqual(runJs(src, inputs));
    });
  }
});

describe("lowering to Python: refusals (#1278)", () => {
  it("an unknown method is refused with a reason, not guessed", () => {
    expect(() =>
      emitPython(
        liftAtom("export function f(xs: number[]) { return xs.reduceRight((a, b) => a + b, 0); }"),
      ),
    ).toThrow(PyEmitError);
  });

  it("a function with its own receiver is refused", () => {
    expect(() =>
      emitPython(
        liftAtom(
          "export function f(k: number) { const o = { k, get: function () { return this.k; } }; return o; }",
        ),
      ),
    ).toThrow(PyEmitError);
  });
});

describe.skipIf(!python)("lowering to Python: more of the platform (#1278)", () => {
  const cases: [string, string, unknown[][]][] = [
    [
      "parseInt, parseFloat, isNaN",
      "export function f(s: string) { return [parseInt(s, 10), parseFloat(s), isNaN(parseInt(s, 10))]; }",
      [["42px"], ["3.5e2"], ["x"]],
    ],
    [
      "the comma call idiom",
      "export function f(s: string) { return (0, String)(s.length); }",
      [["abc"]],
    ],
    [
      "replace and push",
      "export function f(s: string) { const xs = [1]; const n = xs.push(2, 3); return s.replace('a', 'b') + n + xs.length; }",
      [["aXa"]],
    ],
  ];
  for (const [name, src, inputs] of cases) {
    it(`computes what the source computes: ${name}`, () => {
      const code = emitPython(liftAtom(src));
      expect(runPython(code, inputs), code).toEqual(runJs(src, inputs));
    });
  }
});
