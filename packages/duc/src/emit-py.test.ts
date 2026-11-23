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
import { runnable } from "./__fixtures__/runnable.js";
import { graphIdentity } from "./canonical.js";
import { PY_PRELUDE, PyEmitError, emitPython } from "./emit-py.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";
import { raisePython } from "./raise-py.js";

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
  const f = new Function(`${runnable(code)}; return f;`)() as (...a: unknown[]) => unknown;
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

describe.skipIf(!python)("lowering to Python: regular expressions (#1278)", () => {
  const cases: [string, string, unknown[][]][] = [
    [
      "test with classes and anchors",
      "export function f(s: string) { return [/^[a-z]+\\d*$/i.test(s), /\\s/.test(s), /a.c/.test(s)]; }",
      [["Abc12"], ["a c"], ["a\nc"], ["abc\n"]],
    ],
    [
      "replace once and globally, with groups",
      "export function f(s: string) { return [s.replace(/(\\w)(\\d)/, '$2$1'), s.replace(/o/g, '0'), s.replace(/x/g, '$&$&')]; }",
      [["a1 b2 foo"], ["xox"]],
    ],
    [
      "named groups",
      "export function f(s: string) { return /(?<y>\\d{4})-(?<m>\\d{2})/.test(s); }",
      [["2024-05"], ["24-5"]],
    ],
  ];
  for (const [name, src, inputs] of cases) {
    it(`computes what the source computes: ${name}`, () => {
      const code = emitPython(liftAtom(src));
      expect(runPython(code, inputs), code).toEqual(runJs(src, inputs));
    });
  }

  it("a flag or construct whose meaning differs is refused", () => {
    expect(() =>
      emitPython(liftAtom("export function f(s: string) { return /a/y.test(s); }")),
    ).toThrow(PyEmitError);
    expect(() =>
      emitPython(liftAtom("export function f(s: string) { return /(?<=a)b/.test(s); }")),
    ).toThrow(PyEmitError);
    expect(() =>
      emitPython(liftAtom("export function f(s: string) { return /\\p{L}/u.test(s); }")),
    ).toThrow(PyEmitError);
  });
});

describe.skipIf(!python)("lowering to Python: platform calls inside loops (#1278)", () => {
  it("a platform function read through a loop's invariant is still that function", () => {
    const src =
      "export function f(xs: string[]) { let s = 0; for (const x of xs) { s = s + parseInt(x, 10); } return [s, 'hello'.substring(4, 1)]; }";
    const inputs = [[["1", "22", "3x"]]];
    expect(runPython(emitPython(liftAtom(src)), inputs)).toEqual(runJs(src, inputs));
  });
});

describe.skipIf(!python)("lowering to Python: platform functions as values (#1278)", () => {
  it("a platform function passed as a value is that function", () => {
    const src =
      "export function f(xs: string[]) { const g = (h: (s: string) => number) => h(xs[0] as string) + 1; return [g(parseInt), g(Number)]; }";
    expect(runPython(emitPython(liftAtom(src)), [[["41"]]])).toEqual(runJs(src, [[["41"]]]));
  });
});

describe.skipIf(!python)("lowering to Python: array callbacks (#1278)", () => {
  const cases: [string, string, unknown[][]][] = [
    [
      "map, filter and reduce with closures",
      "export function f(xs: number[]) { return xs.map((x) => x * 2).filter((x) => x > 2).reduce((a, b) => a + b, 0); }",
      [[[1, 2, 3]], [[]]],
    ],
    [
      "a callback that ignores the index and the array",
      "export function f(xs: number[]) { return [xs.some((x) => x < 0), xs.every((x) => x < 10), xs.find((x) => x > 1), xs.findIndex((x) => x > 1)]; }",
      [[[1, 2, 3]], [[-1]]],
    ],
    [
      "parseInt as a callback gets the index as its radix",
      "export function f(xs: string[]) { return xs.map(parseInt); }",
      [[["1", "2", "3"]]],
    ],
  ];
  for (const [name, src, inputs] of cases) {
    it(`computes what the source computes: ${name}`, () => {
      const code = emitPython(liftAtom(src));
      expect(runPython(code, inputs), code).toEqual(runJs(src, inputs));
    });
  }
});

describe.skipIf(!python)("lowering to Python: arguments (#1278)", () => {
  it("arguments is what the function was called with", () => {
    const src = "export function f(a: number) { return [arguments.length, a, arguments[1]]; }";
    const inputs = [[1], [1, 2], []];
    expect(runPython(emitPython(liftAtom(src)), inputs)).toEqual(runJs(src, inputs));
  });
});

describe.skipIf(!python)("lowering to Python: do loops (#1278)", () => {
  it("a do loop runs once before it tests", () => {
    const src =
      "export function f(n: number) { let i = 0; do { i = i + 1; } while (i < n); return i; }";
    const inputs = [[0], [4]];
    expect(runPython(emitPython(liftAtom(src)), inputs)).toEqual(runJs(src, inputs));
  });
});

describe("raising the Python lowering: round trip (#1278)", () => {
  const sources: [string, string][] = [
    ...EMIT_CASES.map((c): [string, string] => [c.name, c.source]),
    [
      "operations the lowering keeps apart",
      "export function f(o: any, xs: number[], k: string) { let n = 0; n += xs.length; n++; const t = `a${n}b`; o.k = t; o[k] = n; const e = new Error('x'); const c = Error('y'); return [o?.k, xs?.[0], (0, o.g)?.(1), String(n), n.toString(16), void n, (n, k), Math.pow(n, 2), n ** 2, /a+b/i.test(k), e, c, [...xs, n], { ...o, z: 1 }]; }",
    ],
    ["a spread argument", "export function f(g: any, xs: number[]) { return g(...xs); }"],
    ["an unread free name, and nothing returned", "const g = strict ? a : b;"],
    [
      "a method named as one of Object's is refused, not looked up",
      "export function f(o: any) { return o.hasOwnProperty('a'); }",
    ],
  ];
  for (const [name, source] of sources) {
    it(`lowers, raises and lifts to the same identity: ${name}`, () => {
      const g = liftAtom(source);
      if (name.startsWith("a method named")) {
        expect(() => emitPython(g)).toThrow(PyEmitError);
        return;
      }
      const py = emitPython(g);
      const ts = raisePython(py);
      expect(graphIdentity(liftAtom(ts)), `${py}\n${ts}`).toBe(graphIdentity(g));
    });
  }
});
