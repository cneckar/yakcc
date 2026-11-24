// SPDX-License-Identifier: Apache-2.0
/**
 * Raising from Python (#1298): coverage and faithfulness on a fixed sample of real Python functions
 * (`__fixtures__/python-sample.json`, pure functions of CPython's standard library).
 *
 * Each function is raised (`pythonAst` → `raisePythonFunction` → `liftAtom`), lowered back to Python
 * (`emitPython`), and run beside the original function in the same Python process, on the same
 * generated inputs. The results are compared exactly, with Python's own types kept apart: an int is
 * not a float, a tuple is not a list, and an exception is its class and its message. The arguments
 * after the call are compared too (a function may mutate a list it is given).
 *
 * A mismatch is also sorted by why, as evidence for DEC-DUC-CROSS-LANGUAGE-OPS-001 (proposed):
 * `number-kind` (equal as numbers, but int versus float), `tuple-list`, `exception` (both raise, but
 * a different class or message), `wrong` (anything else). Each function's status is pinned in
 * `__fixtures__/raise-py-expected.json`. DUC_RAISE_PY_UPDATE=1 rewrites it, and
 * DUC_RAISE_PY_REPORT=<file> writes the full results.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rng, runReference, seedOf } from "./__fixtures__/differential.js";
import { graphIdentity } from "./canonical.js";
import { PY_PRELUDE, emitPython } from "./emit-py.js";
import { liftAtom } from "./lift.js";
import { pythonAst, raisePythonFunction } from "./raise-py.js";
import type { DucGraph } from "./types.js";

type PySpec =
  | "int"
  | "float"
  | "bool"
  | "str"
  | { readonly int: readonly [number, number] }
  | { readonly float: readonly [number, number] }
  | { readonly str: string; readonly max: number }
  | { readonly lit: readonly unknown[] }
  | { readonly list: PySpec; readonly min: number; readonly max: number }
  | { readonly opt: PySpec }
  | { readonly union: readonly PySpec[] };

interface PyFunction {
  readonly module: string;
  readonly name: string;
  readonly args: readonly PySpec[];
  readonly source: string;
  /** The module's statements that define the names the function reads. */
  readonly context: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(
  readFileSync(join(here, "__fixtures__", "python-sample.json"), "utf8"),
) as {
  readonly python: string;
  readonly functions: readonly PyFunction[];
};
const EXPECTED_FILE = join(here, "__fixtures__", "raise-py-expected.json");
const EXPECTED = JSON.parse(readFileSync(EXPECTED_FILE, "utf8")) as Record<string, string>;

const OMIT = Symbol("omit");
const INT_EDGES = [0, 1, -1, 2, 3, 4, 7, -7, 100, 400, 1900, 2000, 2 ** 31, 2 ** 53 + 1];
const FLOAT_EDGES = [0, -0, 0.5, 1, 0.25, 1e-7, 1 / 3];

/** A Python value as the driver reads it: a float is `{"$f": text}`, a big int `{"$i": text}`. */
function gen(spec: PySpec, r: () => number): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const float = (x: number): unknown => ({ $f: Object.is(x, -0) ? "-0.0" : String(x) });
  const int = (x: number): unknown => (Math.abs(x) > 2 ** 53 ? { $i: BigInt(x).toString() } : x);
  if (spec === "int") return int(r() < 0.4 ? pick(INT_EDGES) : Math.floor((r() - 0.5) * 4000));
  if (spec === "float") return float(r() < 0.4 ? pick(FLOAT_EDGES) : (r() - 0.5) * 100);
  if (spec === "bool") return r() < 0.5;
  if (spec === "str")
    return Array.from({ length: Math.floor(r() * 8) }, () => pick([..."ab Z0é"])).join("");
  if ("int" in spec) return int(spec.int[0] + Math.floor(r() * (spec.int[1] - spec.int[0] + 1)));
  if ("float" in spec) {
    const [lo, hi] = spec.float;
    const edges = FLOAT_EDGES.filter((x) => x >= lo && x <= hi);
    return float(r() < 0.3 && edges.length > 0 ? pick(edges) : lo + r() * (hi - lo));
  }
  if ("str" in spec)
    return Array.from({ length: Math.floor(r() * (spec.max + 1)) }, () => pick([...spec.str])).join(
      "",
    );
  if ("lit" in spec) return pick(spec.lit);
  if ("list" in spec)
    return Array.from({ length: spec.min + Math.floor(r() * (spec.max - spec.min + 1)) }, () =>
      gen(spec.list, r),
    );
  if ("opt" in spec) return r() < 0.3 ? OMIT : gen(spec.opt, r);
  return gen(pick(spec.union), r);
}

function inputs(fn: PyFunction, count = 40): unknown[][] {
  const r = rng(seedOf(`${fn.module}.${fn.name}`));
  const seen = new Set<string>();
  const out: unknown[][] = [];
  for (let tries = 0; out.length < count && tries < count * 20; tries++) {
    const args = fn.args.map((s) => gen(s, r));
    while (args.length > 0 && args[args.length - 1] === OMIT) args.pop();
    if (args.includes(OMIT)) continue;
    const key = JSON.stringify(args);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(args);
  }
  return out;
}

const DRIVER = String.raw`
import copy as _copy, importlib as _importlib, json as _json, sys as _sys

_ORIGINAL = getattr(_importlib.import_module(_sys.argv[1]), _sys.argv[2])

def _dec(x):
    if isinstance(x, dict) and "$f" in x:
        return float(x["$f"])
    if isinstance(x, dict) and "$i" in x:
        return int(x["$i"])
    if isinstance(x, list):
        return [_dec(e) for e in x]
    return x

def _n(x):
    try:
        v = float(x)
    except OverflowError:
        return "big"
    if v != v:
        return "nan"
    if isinstance(x, int) and v != x:
        return "big:" + str(x)
    return v.hex()

def _enc(x):
    if x is UNDEFINED:
        return {"u": 1}
    if x is None:
        return None
    if isinstance(x, bool):
        return {"b": x}
    if isinstance(x, int):
        return {"i": str(x), "n": _n(x)}
    if isinstance(x, float):
        return {"f": _n(x), "n": _n(x)}
    if isinstance(x, str):
        return {"s": x}
    if isinstance(x, list):
        return {"l": [_enc(e) for e in x]}
    if isinstance(x, tuple):
        return {"t": [_enc(e) for e in x]}
    if isinstance(x, dict):
        return {"d": [[_enc(k), _enc(v)] for k, v in x.items()]}
    return {"x": type(x).__name__}

def _bits(v):
    import struct
    return "7ff8000000000000" if v != v else struct.pack(">d", v).hex()

def _units(t):
    b = t.encode("utf-16-le", "surrogatepass")
    return [int.from_bytes(b[i:i + 2], "little") for i in range(0, len(b), 2)]

def _js(x):
    # The original's result in the reference language's value model (see differential.ts): what a
    # graph with JavaScript's meaning can compute. An int a double cannot hold is {"$big": …}.
    if x is None or isinstance(x, bool):
        return x
    if isinstance(x, int):
        return {"$n": _bits(float(x))} if float(x) == x else {"$big": str(x)}
    if isinstance(x, float):
        return {"$n": _bits(x)}
    if isinstance(x, str):
        return {"$s": _units(x)}
    if isinstance(x, (list, tuple)):
        return [_js(e) for e in x]
    if isinstance(x, dict):
        return {"$o": [[_js(k), _js(v)] for k, v in x.items()]}
    return {"$x": "py:" + type(x).__name__}

def _run_js(fn, args):
    try:
        return {"v": _js(fn(*_copy.deepcopy(args)))}
    except Exception as e:
        return {"t": {"$e": {"$s": _units(type(e).__name__ + ": " + str(e))}}}

def _run(fn, args, lowered):
    args = _copy.deepcopy(args)
    try:
        out = {"r": _enc(fn(*args))}
    except JsThrow as e:
        v = e.value
        out = {"e": v.kind, "m": v.message} if isinstance(v, JsError) else {"e": "throw", "m": str(v)}
    except JsError as e:
        out = {"e": e.kind, "m": e.message}
    except Exception as e:
        out = {"crash": type(e).__name__ + ": " + str(e)} if lowered else {"e": type(e).__name__, "m": str(e)}
    out["a"] = _enc(args)
    return out

for _line in _sys.stdin:
    _args = _dec(_json.loads(_line))
    print(_json.dumps([_run(_ORIGINAL, _args, False), _run(f, _args, True), _run_js(_ORIGINAL, _args)], separators=(",", ":")))
`;

type Reason = "number-kind" | "tuple-list" | "exception" | "wrong";

/** Why two results differ: every relaxation that is needed to make them equal ([] when equal). */
function why(a: unknown, b: unknown): Reason[] {
  const s = (x: unknown): string => JSON.stringify(x);
  if (s(a) === s(b)) return [];
  const o = a as Record<string, unknown>;
  const p = b as Record<string, unknown>;
  if (("e" in o || "crash" in o) !== ("e" in p || "crash" in p)) return ["wrong"];
  if ("e" in o && "e" in p) return why(o.a, p.a).length === 0 ? ["exception"] : ["wrong"];
  const numbers = (x: unknown): unknown =>
    JSON.parse(s(x), (_k, v) => (v !== null && typeof v === "object" && "n" in v ? { n: v.n } : v));
  const containers = (x: unknown): unknown =>
    JSON.parse(s(x), (_k, v) => (v !== null && typeof v === "object" && "t" in v ? { l: v.t } : v));
  if (s(numbers(a)) === s(numbers(b))) return ["number-kind"];
  if (s(containers(a)) === s(containers(b))) return ["tuple-list"];
  if (s(numbers(containers(a))) === s(numbers(containers(b)))) return ["number-kind", "tuple-list"];
  return ["wrong"];
}

type GraphReason = "big-int" | "exception" | "wrong";

/** Why the reference's result differs from the original's, both in JavaScript's value model. */
function graphWhy(original: string, reference: string): GraphReason | undefined {
  const o = JSON.parse(original) as Record<string, unknown>;
  const r = JSON.parse(reference) as Record<string, unknown>;
  if (JSON.stringify(o) === JSON.stringify(r)) return undefined;
  if (original.includes('"$big"')) return "big-int";
  if ("t" in o && "t" in r) return "exception";
  return "wrong";
}

interface Outcome {
  readonly status: string;
  readonly detail?: string;
  readonly identity?: string;
  readonly agree?: string;
  readonly reasons?: Partial<Record<Reason, number>>;
  /** The raised graph's own meaning (the TypeScript reference) against the original. */
  readonly graphAgree?: string;
  readonly graphReasons?: Partial<Record<GraphReason, number>>;
  readonly typescript?: string;
}

function outcome(fn: PyFunction): Outcome {
  let ts: string;
  try {
    ts = raisePythonFunction(pythonAst(`${fn.context}\n${fn.source}`), fn.name);
  } catch (e) {
    return { status: "refused", detail: (e as Error).message };
  }
  let code: string;
  let identity: string;
  let graph: DucGraph;
  try {
    graph = liftAtom(ts);
    identity = graphIdentity(graph);
    code = emitPython(graph);
  } catch (e) {
    return { status: "refused", detail: `lowering: ${(e as Error).message}`, typescript: ts };
  }
  const ins = inputs(fn);
  const dir = mkdtempSync(join(tmpdir(), "duc-raise-py-"));
  const file = join(dir, "m.py");
  writeFileSync(file, `${PY_PRELUDE}\n\n${code}\n${DRIVER}`);
  const lines = execFileSync("python3", [file, fn.module, fn.name], {
    input: `${ins.map((a) => JSON.stringify(a)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
    .trim()
    .split("\n");
  // The raised graph under its own meaning: the TypeScript reference on the same inputs, as numbers.
  const jsInputs = ins.map(
    (a) =>
      JSON.parse(JSON.stringify(a), (_k, v) =>
        v !== null && typeof v === "object" && "$f" in v
          ? Number(v.$f)
          : v !== null && typeof v === "object" && "$i" in v
            ? Number(BigInt(v.$i))
            : v,
      ) as unknown[],
  );
  const reference = runReference(graph, jsInputs);
  const graphReasons: Partial<Record<GraphReason, number>> = {};
  let graphAgree = 0;
  const reasons: Partial<Record<Reason, number>> = {};
  let agree = 0;
  let first: string | undefined;
  lines.forEach((line, i) => {
    const [orig, low, origJs] = JSON.parse(line) as [unknown, unknown, Record<string, unknown>];
    const g = graphWhy(JSON.stringify(origJs), reference[i] ?? "");
    if (g === undefined) graphAgree++;
    else graphReasons[g] = (graphReasons[g] ?? 0) + 1;
    const rs = why(orig, low);
    if (rs.length === 0) agree++;
    else {
      for (const r of rs) reasons[r] = (reasons[r] ?? 0) + 1;
      first ??= `${fn.name}(${JSON.stringify(ins[i]).slice(1, -1)}): Python ${JSON.stringify(orig)}, raised ${JSON.stringify(low)}`;
    }
  });
  const kinds = Object.keys(reasons).sort();
  return {
    status: kinds.length === 0 ? "faithful" : `differs: ${kinds.join(", ")}`,
    identity,
    agree: `${agree}/${ins.length}`,
    reasons,
    graphAgree: `${graphAgree}/${ins.length}`,
    graphReasons,
    typescript: ts,
    ...(first !== undefined ? { detail: first.slice(0, 400) } : {}),
  };
}

const python = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!python)("raising from Python: a fixed sample of CPython functions (#1298)", () => {
  const outcomes = new Map(SAMPLE.functions.map((fn) => [`${fn.module}.${fn.name}`, outcome(fn)]));

  if (process.env.DUC_RAISE_PY_UPDATE === "1")
    writeFileSync(
      EXPECTED_FILE,
      `${JSON.stringify(Object.fromEntries([...outcomes].map(([k, o]) => [k, o.status])), null, 2)}\n`,
    );
  if (process.env.DUC_RAISE_PY_REPORT !== undefined)
    writeFileSync(
      process.env.DUC_RAISE_PY_REPORT,
      `${JSON.stringify(Object.fromEntries(outcomes), null, 2)}\n`,
    );

  it("raising is deterministic: the same function gives the same graph", () => {
    for (const fn of SAMPLE.functions) {
      const o = outcomes.get(`${fn.module}.${fn.name}`);
      if (o?.identity === undefined) continue;
      expect(
        graphIdentity(
          liftAtom(raisePythonFunction(pythonAst(`${fn.context}\n${fn.source}`), fn.name)),
        ),
      ).toBe(o.identity);
    }
  });

  for (const fn of SAMPLE.functions) {
    const key = `${fn.module}.${fn.name}`;
    it(`${key}: ${EXPECTED[key] ?? "(not pinned)"}`, () => {
      const o = outcomes.get(key);
      expect(o?.status, o?.detail).toBe(EXPECTED[key]);
      if (o?.status === "refused") expect(o.detail ?? "").not.toBe("");
    });
  }
});
