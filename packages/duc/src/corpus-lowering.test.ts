// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering prototypes on a fixed corpus sample (#1299, criterion 3 of #1292). Each atom of
 * `__fixtures__/corpus-sample.json` is lifted (its identity is committed), lowered to Python, Go and
 * Rust, and run on generated inputs. Each result is compared with the TypeScript reference
 * (`emitTypeScript` of the same graph) exactly: numbers by `Object.is`, strings by UTF-16 code
 * units, objects by entries in order, throws by error name and message.
 *
 * Every (atom, target) has a pinned status in `__fixtures__/corpus-lowering-expected.json`:
 * `identical`, `refused` (the lowering says why), `disagrees` (it runs and computes something else)
 * or `build` (what it emits does not compile). The test fails when a status changes, so a fix in a
 * lowering moves its row, and the table in docs/duc/lowering-prototypes-1299.md with it.
 * Set DUC_CORPUS_UPDATE=1 to rewrite the pinned statuses, DUC_CORPUS_REPORT=<file> to write the
 * full results (reasons, first disagreeing input) as JSON, and DUC_CORPUS_BMP=1 (with a report
 * only) to leave out inputs with characters past U+FFFF.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type InputSpec,
  generateInputs,
  runGo,
  runPython,
  runReference,
  runRust,
  seedOf,
  showResult,
} from "./__fixtures__/differential.js";
import { graphIdentity } from "./canonical.js";
import { emitGo } from "./emit-go.js";
import { emitPython } from "./emit-py.js";
import { emitRust } from "./emit-rust.js";
import { liftAtom } from "./lift.js";
import type { DucGraph } from "./types.js";

interface SampleAtom {
  readonly name: string;
  readonly origin: string;
  readonly identity: string;
  readonly constructs: readonly string[];
  readonly args: readonly InputSpec[];
  readonly source: string;
}

type Target = "python" | "go" | "rust";
const TARGETS: readonly Target[] = ["python", "go", "rust"];

type Status = "identical" | "refused" | "disagrees" | "build";
interface Outcome {
  readonly status: Status;
  /** The refusal, the build error, or the first disagreeing input with both results. */
  readonly detail?: string;
  /** How many inputs agree, of how many. */
  readonly agree?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(
  readFileSync(join(here, "__fixtures__", "corpus-sample.json"), "utf8"),
) as SampleAtom[];
/**
 * Probes of the semantics #1299 names for each target, beside the corpus sample: they are not
 * corpus atoms, so they carry no committed identity. Python: numbers and integers, truthiness,
 * `null` versus `undefined`, `+`. Go and Rust: a throw that is caught (what an error-value lowering
 * must keep). Rust: a heap value shared by two names, and by a closure.
 */
const PROBES: SampleAtom[] = [
  [
    "probe:integer-precision",
    "export function f(a: number, b: number) { return (a + b) - b; }",
    [{ lit: [2 ** 53 - 1, 2 ** 52 + 1, 3, -7, 2 ** 60] }, { lit: [2, 1, 0.5, -3] }],
  ],
  [
    "probe:integer-division",
    "export function f(a: number, b: number) { return [a / b, a % b, Math.floor(a / b), (a | 0) / (b | 0)]; }",
    ["int", "int"],
  ],
  [
    "probe:truthiness",
    "export function f(x: unknown) { return [x ? 1 : 0, !x, x || 'or', x && 'and']; }",
    ["any"],
  ],
  [
    "probe:null-undefined",
    "export function f(x: unknown) { return [x === undefined, x === null, x == null, x ?? 'dflt', typeof x]; }",
    ["any"],
  ],
  ["probe:plus", "export function f(a: unknown, b: unknown) { return a + b; }", ["any", "any"]],
  [
    "probe:number-to-string",
    "export function f(x: number) { return [String(x), '' + x / 7, JSON.stringify([x, x / 3])]; }",
    ["num"],
  ],
  [
    "probe:json-stringify",
    "export function f(x: unknown) { return [JSON.stringify(x), JSON.stringify([x, undefined, { a: x, b: undefined }])]; }",
    ["any"],
  ],
  [
    "probe:caught-throw",
    "export function f(a: number) { try { if (a < 0) throw new RangeError('negative ' + a); return a * 2; } catch (e) { return (e as Error).name + ':' + (e as Error).message; } }",
    ["int"],
  ],
  [
    "probe:uncaught-throw",
    "export function f(a: number) { if (a > 5) throw new TypeError('big'); if (a < 0) throw 'neg'; return a; }",
    ["idx"],
  ],
  [
    "probe:shared-array",
    "export function f(a: number[], x: number) { const b = a; b.push(x); const c = [...a]; c.push(x); return [a.length, b.length, c.length, a === b]; }",
    [{ arr: "int", max: 3 }, "int"],
  ],
  [
    "probe:closure-over-heap",
    "export function f(n: number) { const xs: number[] = []; const add = (v: number) => { xs.push(v); return xs.length; }; let last = 0; for (let i = 0; i < n; i++) last = add(i * 2); return [last, xs]; }",
    ["idx"],
  ],
].map(([name, source, args]) => ({
  name: name as string,
  origin: "probe",
  identity: "",
  constructs: [],
  args: args as InputSpec[],
  source: source as string,
}));

const EXPECTED_FILE = join(here, "__fixtures__", "corpus-lowering-expected.json");
const EXPECTED = JSON.parse(readFileSync(EXPECTED_FILE, "utf8")) as Record<
  string,
  Record<Target, Status>
>;

const has = (cmd: string, arg: string): boolean => {
  try {
    execFileSync(cmd, [arg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const TOOLS = has("python3", "--version") && has("go", "version") && has("rustc", "--version");

const firstLine = (e: unknown): string => {
  const err = e as { stderr?: Buffer | string; message?: string };
  const text =
    err.stderr !== undefined && String(err.stderr).trim() !== ""
      ? String(err.stderr)
      : String(err.message ?? e);
  const error = text.split("\n").find((l) => /error|Error/.test(l)) ?? text.split("\n")[0] ?? "";
  return error.trim().slice(0, 300);
};

function compare(atom: SampleAtom, inputs: unknown[][], want: string[], got: string[]): Outcome {
  let agree = 0;
  let first: string | undefined;
  for (let i = 0; i < inputs.length; i++) {
    if (got[i] === want[i]) agree++;
    else if (first === undefined) {
      first = `${atom.name}(${JSON.stringify(inputs[i], (_k, v) => (v === undefined ? "<undefined>" : typeof v === "number" && !Number.isFinite(v) ? String(v) : Object.is(v, -0) ? "-0" : v)).slice(1, -1)}): reference ${showResult(want[i] ?? "")}, lowered ${got[i] === undefined ? "(no result)" : showResult(got[i])}`;
    }
  }
  const counts = `${agree}/${inputs.length}`;
  return first === undefined
    ? { status: "identical", agree: counts }
    : { status: "disagrees", agree: counts, detail: first };
}

interface Prepared {
  readonly atom: SampleAtom;
  readonly graph: DucGraph;
  readonly inputs: unknown[][];
  readonly reference: string[];
}

function prepare(atom: SampleAtom): Prepared {
  const graph = liftAtom(atom.source);
  const generated = generateInputs(atom.args, seedOf(atom.name));
  // DUC_CORPUS_BMP=1 (reports only): leave out inputs with characters past U+FFFF, to separate
  // the UTF-16 string model from everything else. The pinned statuses use every input.
  const inputs =
    process.env.DUC_CORPUS_BMP === "1"
      ? generated.filter((a) => !/[\u{10000}-\u{10FFFF}]/u.test(JSON.stringify(a)))
      : generated;
  return { atom, graph, inputs, reference: runReference(graph, inputs) };
}

function lowerAndRun(p: Prepared, target: Exclude<Target, "rust">): Outcome {
  let code: string;
  try {
    code = target === "python" ? emitPython(p.graph) : emitGo(p.graph);
  } catch (e) {
    return { status: "refused", detail: (e as Error).message };
  }
  let got: string[];
  try {
    got = target === "python" ? runPython(code, p.inputs) : runGo(code, p.inputs);
  } catch (e) {
    return { status: "build", detail: firstLine(e) };
  }
  return compare(p.atom, p.inputs, p.reference, got);
}

/** Rust compiles every lowered atom into one program; one that does not compile is set apart. */
function rustOutcomes(prepared: readonly Prepared[]): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  const lowered: { p: Prepared; code: string }[] = [];
  for (const p of prepared) {
    try {
      lowered.push({ p, code: emitRust(p.graph) });
    } catch (e) {
      out.set(p.atom.name, { status: "refused", detail: (e as Error).message });
    }
  }
  let builds = lowered;
  try {
    runRust([builds[0]?.code ?? ""], [[]]);
  } catch {
    // The prelude alone fails: nothing can run.
  }
  const tryAll = (): string[][] | undefined => {
    try {
      return runRust(
        builds.map((b) => b.code),
        builds.map((b) => b.p.inputs),
      );
    } catch {
      return undefined;
    }
  };
  let results = tryAll();
  if (results === undefined) {
    builds = [];
    for (const b of lowered) {
      try {
        runRust([b.code], [[]]);
        builds.push(b);
      } catch (e) {
        out.set(b.p.atom.name, { status: "build", detail: firstLine(e) });
      }
    }
    results = tryAll() ?? [];
  }
  builds.forEach((b, i) => {
    out.set(b.p.atom.name, compare(b.p.atom, b.p.inputs, b.p.reference, results?.[i] ?? []));
  });
  return out;
}

describe.skipIf(!TOOLS)("lowering prototypes on the corpus sample (#1299)", () => {
  const ALL = [...SAMPLE, ...PROBES];
  const prepared = ALL.map(prepare);
  const outcomes = new Map<string, Record<Target, Outcome>>();
  const rust = rustOutcomes(prepared);
  for (const p of prepared) {
    outcomes.set(p.atom.name, {
      python: lowerAndRun(p, "python"),
      go: lowerAndRun(p, "go"),
      rust: rust.get(p.atom.name) ?? { status: "build", detail: "no result" },
    });
  }

  if (process.env.DUC_CORPUS_UPDATE === "1") {
    const pinned = Object.fromEntries(
      [...outcomes].map(([name, o]) => [
        name,
        Object.fromEntries(TARGETS.map((t) => [t, o[t].status])),
      ]),
    );
    writeFileSync(EXPECTED_FILE, `${JSON.stringify(pinned, null, 2)}\n`);
  }
  if (process.env.DUC_CORPUS_REPORT !== undefined) {
    writeFileSync(
      process.env.DUC_CORPUS_REPORT,
      `${JSON.stringify(
        prepared.map((p) => ({
          name: p.atom.name,
          origin: p.atom.origin,
          constructs: p.atom.constructs,
          inputs: p.inputs.length,
          ...outcomes.get(p.atom.name),
        })),
        null,
        2,
      )}\n`,
    );
  }

  it("the sample is fixed: each atom lifts to its committed identity", () => {
    for (const a of SAMPLE) expect(graphIdentity(liftAtom(a.source)), a.name).toBe(a.identity);
    expect(SAMPLE.length).toBeGreaterThanOrEqual(50);
  });

  it("every atom runs on distinct generated inputs (all of a small domain, else 40)", () => {
    for (const p of prepared) expect(p.inputs.length, p.atom.name).toBeGreaterThanOrEqual(2);
    expect(prepared.reduce((n, p) => n + p.inputs.length, 0)).toBeGreaterThan(2000);
  });

  for (const target of TARGETS) {
    describe(target, () => {
      for (const a of ALL) {
        it(`${a.name}: ${EXPECTED[a.name]?.[target] ?? "(not pinned)"}`, () => {
          const o = outcomes.get(a.name)?.[target];
          expect(o?.status, o?.detail).toBe(EXPECTED[a.name]?.[target]);
          if (o?.status === "refused") expect(o.detail ?? "").not.toBe("");
        });
      }
    });
  }
});
