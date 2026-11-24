/**
 * Behavior: run a newly written function on fixed inputs and compare its outputs with the outputs
 * stored definitions recorded on the same inputs, to find code that already behaves the same.
 *
 * @decision DEC-MCP-BEHAVIOR-001
 * @title Dedup by observed behavior, against recorded outputs, running only the new code
 * @status decided (lane:reuse; evidence in bench/B15-upsert-dedup)
 * @rationale
 *   B15 found the stored twin of a newly written function 97% of the time by combining text
 *   search with a behavioral fingerprint (outputs on fixed probe inputs and on examples), and
 *   its "near" verdict names the input where two plausible implementations disagree. Here the
 *   stored side is not run: scripts/build-behavior-index.mjs records each stored definition's
 *   outputs once (on probeArgs(arity) and on its own examples), and the check runs only the new
 *   code. The probe values, the tagged-value codec and the verdict rules are the same as B15's;
 *   a test pins the codec and probes against the bench's.
 *
 *   The new code runs in a node:vm context with no host globals and a per-call timeout. vm is
 *   not a security boundary: this is the caller's own code, checked on the caller's machine.
 *   TypeScript is stripped with node:module stripTypeScriptTypes (no typescript dependency).
 *   "Equivalent" is observed on finitely many inputs: evidence, not proof. Probes alone gave
 *   9.7% false equivalence in B15, so the result says how many informative inputs agreed.
 */

import { createHash } from "node:crypto";
import * as nodeModule from "node:module";
import vm from "node:vm";

/** Per-call time limit for the new code, in milliseconds. */
export const CALL_TIMEOUT_MS = 200;
/** Informative agreements needed before a verdict other than inconclusive. */
export const MIN_INFORMATIVE = 3;
/** Agreement a "near" verdict needs. */
export const NEAR_AGREEMENT = 0.8;
/** Output keys longer than this are stored as a hash. */
export const MAX_KEY_CHARS = 120;

// The tagged-value codec (identical to bench/B12-need-to-code/harness/sandbox.mjs).
export const CODEC = `
var __enc = function enc(v, depth) {
  depth = depth || 0;
  if (depth > 20) return { $type: "deep" };
  if (v === undefined) return { $type: "undefined" };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $type: "NaN" };
    if (v === Infinity) return { $type: "Infinity" };
    if (v === -Infinity) return { $type: "-Infinity" };
    if (Object.is(v, -0)) return 0;
    return v;
  }
  if (typeof v === "bigint") return { $bigint: String(v) };
  if (typeof v === "function") return { $type: "function" };
  if (typeof v === "symbol") return { $type: "symbol" };
  if (v === null || typeof v !== "object") return v;
  if (typeof v.then === "function") {
    try { v.then(null, function () {}); } catch (e) {}
    return { $type: "promise" };
  }
  if (v instanceof Date) return { $date: Number.isNaN(v.getTime()) ? "Invalid" : v.toISOString() };
  if (ArrayBuffer.isView(v)) return { $bytes: Array.from(v) };
  if (v instanceof Map) return { $map: Array.from(v, function (e) { return [enc(e[0], depth + 1), enc(e[1], depth + 1)]; }) };
  if (v instanceof Set) return { $set: Array.from(v, function (e) { return enc(e, depth + 1); }) };
  if (v instanceof RegExp) return { $regexp: String(v) };
  if (v instanceof Error) return { $error: v.name };
  if (Array.isArray(v)) return v.map(function (e) { return enc(e, depth + 1); });
  var out = {};
  Object.keys(v).sort().forEach(function (k) { out[k] = enc(v[k], depth + 1); });
  return out;
};
var __dec = function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v === null || typeof v !== "object") return v;
  if (v.$type === "undefined") return undefined;
  if (v.$type === "NaN") return NaN;
  if (v.$type === "Infinity") return Infinity;
  if (v.$type === "-Infinity") return -Infinity;
  if ("$date" in v) return new Date(v.$date);
  if ("$bytes" in v) return Uint8Array.from(v.$bytes);
  if ("$map" in v) return new Map(v.$map.map(function (e) { return [dec(e[0]), dec(e[1])]; }));
  if ("$set" in v) return new Set(v.$set.map(dec));
  if ("$bigint" in v) return BigInt(v.$bigint);
  var out = {};
  Object.keys(v).forEach(function (k) { out[k] = dec(v[k]); });
  return out;
};
`;

// Probe values and argument patterns (identical to bench/B12-need-to-code/harness/cards.mjs).
type Tagged = unknown;
const P: Record<string, readonly Tagged[]> = {
  s: [
    "abc",
    "",
    "Hello World",
    "kitten",
    "2024-01-31",
    "1.5h",
    "a/b~c",
    "109156be-c4fb-41ea-b1b4-efe1671c5836",
  ],
  n: [3, 0, -2, 2.5, 1000, 255],
  a: [
    [1, 2, 3],
    [],
    ["b", "a", "c"],
    [
      ["a", "b"],
      ["b", "c"],
    ],
  ],
  o: [{ a: 1, b: { c: 2 } }, {}],
  d: [{ $date: "2024-01-31T12:00:00.000Z" }],
  b: [true],
};
const PATTERNS: Record<number, readonly (readonly string[])[]> = {
  0: [[]],
  1: [["s"], ["n"], ["a"], ["o"], ["d"], ["b"]],
  2: [
    ["s", "s"],
    ["n", "n"],
    ["a", "n"],
    ["s", "n"],
    ["o", "s"],
    ["a", "a"],
    ["d", "n"],
    ["d", "d"],
    ["a", "s"],
  ],
  3: [
    ["n", "n", "n"],
    ["s", "n", "n"],
    ["a", "n", "n"],
    ["s", "s", "s"],
    ["o", "s", "s"],
    ["d", "n", "n"],
  ],
};
const MAX_CALLS = 64;
const ROUNDS_BY_ARITY = [1, 8, 5, 4];

/** Probe argument lists for an arity (tagged JSON), the same for every caller. */
export function probeArgs(arity: number): Tagged[][] {
  const pats = PATTERNS[Math.min(arity, 3)] ?? PATTERNS[3] ?? [];
  const rounds = ROUNDS_BY_ARITY[Math.min(arity, 3)] ?? 4;
  const out: Tagged[][] = [];
  for (let i = 0; i < rounds; i++)
    for (const pat of pats)
      out.push(
        pat.map((k, j) => {
          const pool = P[k] ?? [];
          return pool[(i + j) % pool.length];
        }),
      );
  return out.slice(0, MAX_CALLS);
}

/** Whether a tagged output says the call did not really work (as B12's cards define it). */
export function degenerate(v: Tagged): boolean {
  if (Array.isArray(v)) return v.some(degenerate);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("$map" in o) return (o.$map as Tagged[][]).some((e) => e.some(degenerate));
    if ("$set" in o) return (o.$set as Tagged[]).some(degenerate);
    if (o.$type !== undefined)
      return ["undefined", "promise", "function", "symbol", "deep", "NaN"].includes(
        String(o.$type),
      );
    if ("$date" in o) return o.$date === "Invalid";
    if (["$bytes", "$bigint", "$regexp", "$error"].some((k) => k in o)) return false;
    return Object.values(o).some(degenerate);
  }
  return typeof v === "string" && /NaN|undefined|\[object /.test(v);
}

const kindOf = (v: Tagged): string =>
  Array.isArray(v)
    ? "array"
    : v !== null && typeof v === "object"
      ? "$date" in (v as object)
        ? "date"
        : "object"
      : typeof v;

/** The kinds a declared parameter type admits, or null for any. */
export function kindsOf(type: string | undefined): Set<string> | null {
  const t = String(type ?? "").trim();
  if (!t || /\bany\b|\bunknown\b|^[A-Z]$|^T\b/.test(t)) return null;
  if (!/\|/.test(t) && /(\[\]|^Array<.*>|^readonly .*|^\[.*\])$/.test(t)) return new Set(["array"]);
  const kinds = new Set<string>();
  if (/\bstring\b|["'`]/.test(t)) kinds.add("string");
  if (/\bnumber\b|\bbigint\b/.test(t)) kinds.add("number");
  if (/\bboolean\b/.test(t)) kinds.add("boolean");
  if (/\[\]|\bArray\b|^\[|\breadonly\b/.test(t)) kinds.add("array");
  if (/\bDate\b/.test(t)) kinds.add("date");
  if (/^\{|\bRecord\b|\bobject\b|\bMap\b|\bSet\b/.test(t)) kinds.add("object");
  return kinds.size === 0 ? null : kinds;
}

/** Whether a value fits a declared type; for `T[]`, each element must fit T. */
export function fitsType(v: Tagged, type: string | undefined): boolean {
  const kinds = kindsOf(type);
  if (!kinds) return true;
  if (!kinds.has(kindOf(v))) return false;
  const t = String(type).trim();
  const elem = /^(?:readonly\s+)?(.+)\[\]$/.exec(t)?.[1] ?? /^Array<(.+)>$/.exec(t)?.[1];
  if (Array.isArray(v) && elem && !/\|/.test(t))
    return v.every((x) => fitsType(x, elem.replace(/^\((.*)\)$/, "$1")));
  return true;
}

/** Whether an argument list fits the declared parameter types. */
export function fitsTypes(args: readonly Tagged[], paramTypes: readonly string[] = []): boolean {
  return args.every((v, i) => fitsType(v, paramTypes[i]));
}

/** The comparison key of a tagged output: its JSON, or a hash of it when long. */
export function outputKey(v: Tagged): string {
  const json = JSON.stringify(v) ?? "undefined";
  return json.length <= MAX_KEY_CHARS
    ? json
    : `#${createHash("sha256").update(json).digest("hex").slice(0, 16)}`;
}

/** A recorded call: the output's key and whether it is informative, or the error name. */
export type Run = { ok: true; key: string; informative: boolean } | { ok: false; error: string };

/** A function loaded in a sandbox. */
export interface Loaded {
  readonly context: vm.Context;
  readonly fn: unknown;
  readonly arity: number;
}

const stripTypes = (code: string): string => {
  const strip = (nodeModule as unknown as { stripTypeScriptTypes?: (s: string) => string })
    .stripTypeScriptTypes;
  if (typeof strip !== "function")
    throw new Error("this Node has no stripTypeScriptTypes; pass JavaScript");
  // The API warns that it is experimental; the warning is not the caller's concern.
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return strip(code);
  } finally {
    process.emitWarning = emit;
  }
};

/**
 * Load one function from source (TypeScript or JavaScript; `export` keywords allowed, imports
 * refused) into a fresh context with no host globals. Picks `name`, else the first declared
 * function.
 */
export function loadFunction(code: string, name?: string): Loaded {
  if (/^\s*import\s/m.test(code) || /\brequire\s*\(/.test(code))
    throw new Error("the code must be self-contained: no imports");
  let js = /:\s*\w|<\w|\binterface\b|\btype\s+\w+\s*=/.test(code) ? stripTypes(code) : code;
  js = js.replace(/^(\s*)export\s+(default\s+)?/gm, "$1");
  const declared =
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(js);
  const pick = name ?? declared?.[1] ?? declared?.[2];
  if (!pick || !/^[A-Za-z_$][\w$]*$/.test(pick)) throw new Error("no function found in the code");
  const context = vm.createContext({});
  vm.runInContext(CODEC, context);
  vm.runInContext(
    `globalThis.__fn = (function(){ ${js}\n; return typeof ${pick} === "function" ? ${pick} : undefined; })();`,
    context,
    { timeout: 2000 },
  );
  const fn = (context as { __fn?: unknown }).__fn;
  if (typeof fn !== "function") throw new Error(`${pick} is not a function`);
  return { context, fn, arity: fn.length };
}

/** Call the loaded function on tagged arguments. */
export function call(f: Loaded, args: readonly Tagged[]): Run {
  const ctx = f.context as { __argsJson?: string; __fn?: unknown };
  ctx.__fn = f.fn;
  ctx.__argsJson = JSON.stringify(args);
  try {
    const out = JSON.parse(
      vm.runInContext(
        `JSON.stringify((function(){ try { return { ok: true, value: __enc(__fn.apply(undefined, __dec(JSON.parse(__argsJson)))) }; } catch (e) { return { ok: false, error: (e && e.name) || "Error" }; } })())`,
        f.context,
        { timeout: CALL_TIMEOUT_MS },
      ) as string,
    ) as { ok: true; value: Tagged } | { ok: false; error: string };
    return out.ok
      ? { ok: true, key: outputKey(out.value), informative: !degenerate(out.value) }
      : out;
  } catch (err) {
    return {
      ok: false,
      error: /timed out/i.test(String((err as Error)?.message)) ? "timeout" : "host",
    };
  }
}

/** A comparison of two runs over the same inputs. */
export interface Comparison {
  comparable: number;
  agree: number;
  informative: number;
  distinct: number;
  counterexamples: { args: Tagged[]; new: string; stored: string }[];
}

const unusable = (r: Run | undefined): boolean =>
  !r || (!r.ok && (r.error === "timeout" || r.error === "host"));
const shown = (r: Run): string => (r.ok ? r.key : `throws ${r.error}`);

/** Compare two runs (B15's rules: both throwing agrees; one throwing differs; timeouts skip). */
export function compareRuns(
  inputs: readonly Tagged[][],
  a: readonly Run[],
  b: readonly Run[],
): Comparison {
  const c: Comparison = {
    comparable: 0,
    agree: 0,
    informative: 0,
    distinct: 0,
    counterexamples: [],
  };
  const outputs = new Set<string>();
  inputs.forEach((args, i) => {
    const x = a[i];
    const y = b[i];
    if (!x || !y || unusable(x) || unusable(y)) return;
    c.comparable++;
    if (!x.ok && !y.ok) {
      c.agree++;
      return;
    }
    if (x.ok && y.ok && x.key === y.key) {
      c.agree++;
      if (x.informative && y.informative) {
        c.informative++;
        outputs.add(x.key);
      }
      return;
    }
    if (c.counterexamples.length < 3)
      c.counterexamples.push({ args: [...args], new: shown(x), stored: shown(y) });
  });
  c.distinct = outputs.size;
  return c;
}

export type Verdict = "equivalent" | "near" | "different" | "inconclusive";

/** The verdict for a comparison (B15's rules). */
export function verdict(all: Comparison): Verdict {
  const weak = all.informative < MIN_INFORMATIVE || all.distinct < 2;
  if (all.agree === all.comparable) return weak ? "inconclusive" : "equivalent";
  if (!weak && all.agree / all.comparable >= NEAR_AGREEMENT) return "near";
  return "different";
}

// ---------------------------------------------------------------------------
// The behavior index (built by scripts/build-behavior-index.mjs)
// ---------------------------------------------------------------------------

/** One stored definition's recorded behavior. */
export interface BehaviorEntry {
  readonly id: string;
  readonly pkg: string;
  readonly name: string;
  readonly sourceFile: string;
  readonly arity: number;
  /** Its description (JSDoc or a generated one), for text search. */
  readonly text: string;
  /** Outputs on probeArgs(arity), in order. */
  readonly probes: readonly Run[];
  /** Its own examples, with recorded outputs. */
  readonly examples: readonly { readonly args: readonly Tagged[]; readonly run: Run }[];
}

/**
 * A stored module file, ready to evaluate: CommonJS (transpiled at build time) ending with
 * `module.__picked = {...}`, which picks its top-level bindings by name; and where each of its
 * relative requires resolves to, among the index's files.
 */
export interface StoredFile {
  readonly js: string;
  readonly deps: Readonly<Record<string, string>>;
}

export interface BehaviorIndex {
  readonly version: 1;
  readonly entries: readonly BehaviorEntry[];
  /**
   * The stored code, by source file, when the index carries it: then stored definitions can
   * also be run on the caller's examples, which are the most discriminating inputs (B15).
   */
  readonly files?: Readonly<Record<string, StoredFile>>;
}

const storedModules = new WeakMap<BehaviorIndex, Map<string, Record<string, unknown> | null>>();

/**
 * A stored definition, loaded from the index's files into a context of its own module (cached
 * per index and file), or null when the index carries no code for it or it does not load.
 * Stored code runs under the same rules as new code: no host globals, requires only among the
 * index's files, a timeout on every call.
 */
export function loadStored(index: BehaviorIndex, sourceFile: string, name: string): Loaded | null {
  const files = index.files;
  if (!files?.[sourceFile]) return null;
  let cache = storedModules.get(index);
  if (!cache) {
    cache = new Map();
    storedModules.set(index, cache);
  }
  if (!cache.has(sourceFile)) {
    let picked: Record<string, unknown> | null = null;
    try {
      const context = vm.createContext({});
      vm.runInContext(CODEC, context);
      const loaded = new Map<string, { exports: unknown; __picked?: Record<string, unknown> }>();
      const load = (path: string): { exports: unknown; __picked?: Record<string, unknown> } => {
        const hit = loaded.get(path);
        if (hit) return hit;
        const file = files[path];
        if (!file) throw new Error(`not in the index: ${path}`);
        const module: { exports: unknown; __picked?: Record<string, unknown> } = { exports: {} };
        loaded.set(path, module);
        const fn = vm.runInContext(
          `(function (exports, require, module) {\n${file.js}\n})`,
          context,
          { filename: path, timeout: 2000 },
        ) as (e: unknown, r: (s: string) => unknown, m: unknown) => void;
        const req = (spec: string): unknown => {
          const target = file.deps[spec];
          if (!target) throw new Error(`require("${spec}") is not available`);
          return load(target).exports;
        };
        fn(module.exports, req, module);
        return module;
      };
      const m = load(sourceFile);
      picked = { ...(m.__picked ?? {}), __context: context };
    } catch {
      picked = null;
    }
    cache.set(sourceFile, picked);
  }
  const picked = cache.get(sourceFile);
  const fn = picked?.[name];
  if (!picked || typeof fn !== "function") return null;
  return { context: picked.__context as vm.Context, fn, arity: (fn as () => void).length };
}

/** Validate a parsed behavior index (shape only). */
export function parseBehaviorIndex(raw: unknown): BehaviorIndex {
  const r = raw as Partial<BehaviorIndex> | null;
  if (!r || r.version !== 1 || !Array.isArray(r.entries))
    throw new Error("not a behavior index (version 1)");
  return r as BehaviorIndex;
}

/** One neighbor of the new function. */
export interface Neighbor {
  readonly id: string;
  readonly pkg: string;
  readonly sourceFile: string;
  readonly name: string;
  readonly text: string;
  readonly verdict: Verdict;
  readonly agree: number;
  readonly comparable: number;
  readonly informative: number;
  readonly counterexamples: Comparison["counterexamples"];
  readonly from: readonly ("behavior" | "text")[];
  /** Whether the stored code ran on the caller's examples (the index carries code for it). */
  readonly ranOnExamples: boolean;
}

const ORDER: Record<Verdict, number> = { equivalent: 0, near: 1, inconclusive: 2, different: 3 };

/**
 * Find stored definitions that behave like the new function. Candidates: the k best by
 * agreement on the probe inputs (same arity), and the k best text matches given by the caller
 * (indexes into entries). Each is verified on the probes and its own examples, kept to the
 * declared parameter types.
 */
export function findNeighbors(
  index: BehaviorIndex,
  f: Loaded,
  opts: {
    arity: number;
    paramTypes?: readonly string[];
    textRanked?: readonly number[];
    /** The caller's example argument lists: run on both sides when the stored code is in the index. */
    exampleArgs?: readonly (readonly Tagged[])[];
    k?: number;
  },
): { neighbors: Neighbor[]; probesRun: number } {
  const { arity, paramTypes = [], textRanked = [], exampleArgs = [], k = 5 } = opts;
  const newEx = exampleArgs.map((args) => call(f, args));
  const probes = probeArgs(arity);
  const keep = probes.map((args) => fitsTypes(args, paramTypes));
  const typed = probes.filter((_, i) => keep[i]);
  const newRuns = probes.map((args, i) => (keep[i] ? call(f, args) : undefined));
  const typedNew = newRuns.filter((_, i) => keep[i]) as Run[];

  const scored: { i: number; s: number }[] = [];
  index.entries.forEach((e, i) => {
    if (e.arity !== arity) return;
    const c = compareRuns(
      typed,
      typedNew,
      e.probes.filter((_, j) => keep[j]),
    );
    // The caller's examples, run on the stored side too, when its code is in the index.
    if (exampleArgs.length > 0) {
      const s = loadStored(index, e.sourceFile, e.name);
      if (s) {
        const x = compareRuns(
          exampleArgs.map((a) => [...a]),
          newEx,
          exampleArgs.map((a) => call(s, a)),
        );
        c.comparable += x.comparable;
        c.agree += x.agree;
        c.informative += x.informative;
      }
    }
    if (c.informative === 0) return;
    scored.push({ i, s: c.informative * (c.agree / Math.max(1, c.comparable)) ** 4 });
  });
  scored.sort((x, y) => y.s - x.s || x.i - y.i);
  const fromBehavior = new Set(scored.slice(0, k).map((x) => x.i));
  const fromText = new Set(textRanked.filter((i) => index.entries[i]?.arity === arity).slice(0, k));

  const neighbors = [...new Set([...fromBehavior, ...fromText])].map((i): Neighbor => {
    const e = index.entries[i] as BehaviorEntry;
    const ex = e.examples.filter((x) => fitsTypes(x.args, paramTypes));
    const s = exampleArgs.length > 0 ? loadStored(index, e.sourceFile, e.name) : null;
    const inputs = [
      ...typed,
      ...ex.map((x) => [...x.args]),
      ...(s ? exampleArgs.map((a) => [...a]) : []),
    ];
    const stored = [
      ...e.probes.filter((_, j) => keep[j]),
      ...ex.map((x) => x.run),
      ...(s ? exampleArgs.map((a) => call(s, a)) : []),
    ];
    const c = compareRuns(
      inputs,
      [...typedNew, ...ex.map((x) => call(f, x.args)), ...(s ? newEx : [])],
      stored,
    );
    return {
      id: e.id,
      pkg: e.pkg,
      sourceFile: e.sourceFile,
      name: e.name,
      text: e.text,
      verdict: verdict(c),
      agree: c.agree,
      comparable: c.comparable,
      informative: c.informative,
      counterexamples: c.counterexamples,
      from: [
        ...(fromBehavior.has(i) ? (["behavior"] as const) : []),
        ...(fromText.has(i) ? (["text"] as const) : []),
      ],
      ranOnExamples: s !== null,
    };
  });
  neighbors.sort(
    (x, y) =>
      ORDER[x.verdict] - ORDER[y.verdict] ||
      y.agree / Math.max(1, y.comparable) - x.agree / Math.max(1, x.comparable),
  );
  return { neighbors, probesRun: typed.length };
}

/** Whether the function returns each example's value (or throws where `throws` is true). */
export function passesExamples(
  f: Loaded,
  examples: readonly { args?: unknown; returns?: unknown; throws?: unknown }[],
): boolean {
  return examples.every((e) => {
    const r = call(f, e.args as Tagged[]);
    if (e.throws === true) return !r.ok;
    return (
      r.ok && r.key === outputKey(e.returns === undefined ? { $type: "undefined" } : e.returns)
    );
  });
}
