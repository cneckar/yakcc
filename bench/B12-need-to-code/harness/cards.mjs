// SPDX-License-Identifier: MIT
// Library-side cards: what is known about each corpus definition without a model.
//   - signature: parameter names, from the source
//   - doc: the JSDoc description just above the definition, when there is one
//   - callable: whether the sandbox can call it, and why not
//   - examples and observed types: the definition run on a fixed set of probe inputs. A
//     call that returns (the same thing twice) is an example; the types of its arguments and
//     results are the observed signature. Nothing here reads a query.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, callTagged, resolveCallable, taggedEqual } from "./sandbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const ts = createRequire(join(repo, "packages/shave/package.json"))("typescript");

/** The type name of a tagged value. */
export function typeOfTagged(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v !== "object") return typeof v;
  if (v.$type !== undefined)
    return v.$type === "NaN" || /Infinity/.test(v.$type) ? "number" : v.$type;
  for (const k of ["$date", "$bytes", "$map", "$set", "$regexp", "$bigint", "$error"])
    if (k in v) return k.slice(1);
  return "object";
}

/** Parameter names of the first function-like node in a definition's text. */
export function paramNames(text) {
  const sf = ts.createSourceFile("d.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let found;
  const visit = (n) => {
    if (found) return;
    if (ts.isFunctionLike(n) && "parameters" in n && !ts.isClassDeclaration(n)) {
      found = n.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : "_"));
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found ?? [];
}

/** The JSDoc description that ends just above `lineStart`, without tags; null if none. */
export function docAbove(fileText, lineStart) {
  const lines = fileText.split("\n");
  let end = lineStart - 2;
  while (end >= 0 && lines[end].trim() === "") end--;
  if (end < 0 || !lines[end].trim().endsWith("*/")) return null;
  let start = end;
  while (start >= 0 && !lines[start].includes("/**")) start--;
  if (start < 0) return null;
  const body = lines.slice(start, end + 1).map((l) =>
    l
      .replace(/^\s*\/?\*+\/?/, "")
      .replace(/\*\/\s*$/, "")
      .trim(),
  );
  const desc = [];
  for (const l of body) {
    if (l.startsWith("@")) break;
    if (l) desc.push(l);
  }
  const text = desc.join(" ").replace(/\s+/g, " ").trim();
  return text.length === 0 ? null : text.slice(0, 300);
}

// Probe values, by kind. Deterministic, small, and varied enough to show what a function
// accepts and returns.
const P = {
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
// Argument kind patterns by arity, most common shapes first.
const PATTERNS = {
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
const MAX_EXAMPLES = 6;
const MAX_CALLS = 64;
// Rounds per arity: one-argument functions try every probe value of a kind; with more
// arguments the combinations grow, so fewer rounds.
const ROUNDS_BY_ARITY = [1, 8, 5, 4];
const roundsFor = (arity) => ROUNDS_BY_ARITY[Math.min(arity, 3)];

/** Probe argument lists for an arity: for each pattern, values by index, so calls vary. */
export function probeArgs(arity) {
  const pats = PATTERNS[Math.min(arity, 3)] ?? PATTERNS[3];
  const out = [];
  for (let i = 0; i < roundsFor(arity); i++)
    for (const pat of pats) out.push(pat.map((k, j) => P[k][(i + j) % P[k].length]));
  return out.slice(0, MAX_CALLS);
}

/**
 * Whether a result says the call did not really work: undefined, NaN, an invalid date, a
 * promise, a function, or a string that shows a coerced input ("NaN", "undefined",
 * "[object ...]").
 */
export function degenerate(v) {
  if (Array.isArray(v)) return v.some(degenerate);
  if (v && typeof v === "object" && "$map" in v) return v.$map.some((e) => e.some(degenerate));
  if (v && typeof v === "object" && "$set" in v) return v.$set.some(degenerate);
  if (v && typeof v === "object" && typeOfTagged(v) === "object")
    return Object.values(v).some(degenerate);
  const t = typeOfTagged(v);
  if (["undefined", "promise", "function", "symbol", "deep"].includes(t)) return true;
  if (v && typeof v === "object" && v.$type === "NaN") return true;
  if (t === "date" && v.$date === "Invalid") return true;
  if (typeof v === "string" && /NaN|undefined|\[object /.test(v)) return true;
  return false;
}

/** An empty result: [], "", or {}. */
export function trivial(v) {
  if (Array.isArray(v)) return v.length === 0;
  if (v === "") return true;
  return (
    v !== null &&
    typeof v === "object" &&
    typeOfTagged(v) === "object" &&
    Object.keys(v).length === 0
  );
}

/**
 * Run a callable on the probes. JavaScript accepts any argument, so a function returns
 * something for most inputs. Each argument pattern is scored by how many of its calls return
 * a non-degenerate result twice in a row, first by results with content (not empty, not an
 * argument echoed back), then by clean calls. Only the best-scoring patterns (at most three,
 * ties kept) give the examples and the observed types. A heuristic: it is measured, not assumed.
 */
export function probe(callable, arity) {
  const pats = PATTERNS[Math.min(arity, 3)] ?? PATTERNS[3];
  const byPattern = pats.map(() => ({ clean: [], all: 0, score: 0 }));
  let deterministic = true;
  let calls = 0;
  const rounds = roundsFor(arity);
  for (let round = 0; round < rounds; round++) {
    pats.forEach((pat, pi) => {
      if (calls >= MAX_CALLS) return;
      const args = pat.map((k, j) => P[k][(round + j) % P[k].length]);
      calls++;
      const a = callTagged(callable, args);
      if (!a.ok) return;
      byPattern[pi].all++;
      const b = callTagged(callable, args);
      if (!b.ok || !taggedEqual(a.value, b.value)) {
        deterministic = false;
        return;
      }
      if (!degenerate(a.value)) {
        byPattern[pi].clean.push({ args, returns: a.value });
        // Rank by results with content: not empty ([], "", {}) and not an argument echoed
        // back. Clean calls break ties.
        const echo = args.some((x) => taggedEqual(x, a.value));
        byPattern[pi].score += trivial(a.value) || echo ? 1 : 100;
      }
    });
  }
  const best = Math.max(0, ...byPattern.map((p) => p.score));
  // Every tied pattern is kept (at most three), so an ambiguous signature shows as a union.
  const chosen = best === 0 ? [] : byPattern.filter((p) => p.score === best).slice(0, 3);
  const examples = [];
  for (let i = 0; examples.length < MAX_EXAMPLES && i < rounds; i++)
    for (const p of chosen)
      if (p.clean[i] && examples.length < MAX_EXAMPLES) examples.push(p.clean[i]);
  const params = Array.from({ length: arity }, (_, i) => [
    ...new Set(examples.map((e) => typeOfTagged(e.args[i]))),
  ]);
  const returns = [...new Set(examples.map((e) => typeOfTagged(e.returns)))];
  return { examples, observed: { params, returns }, deterministic };
}

/** The card of one corpus definition (from B11's corpusDefinitions). */
export function buildCard(def) {
  const fileText = readFileSync(join(FIXTURES, def.sourceFile), "utf8");
  const params = paramNames(def.text);
  const card = {
    id: `${def.sourceFile}#${def.name}@${def.lineStart}`,
    pkg: def.pkg,
    sourceFile: def.sourceFile,
    name: def.name,
    kind: def.kind,
    lineStart: def.lineStart,
    lineEnd: def.lineEnd,
    params,
    doc: docAbove(fileText, def.lineStart),
  };
  const c = resolveCallable(def.sourceFile, def.name);
  if (!c.callable)
    return { ...card, callable: false, reason: c.reason, examples: [], observed: null };
  const arity = Math.max(c.arity, params.length);
  return { ...card, callable: true, arity, ...probe(c, arity) };
}

const show = (v) => {
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/**
 * The text a card is indexed by. "card": name, parameters, doc and observed types.
 * "card+examples": the same plus up to three example calls.
 */
export function cardText(card, variant = "card") {
  const parts = [`${card.name}(${card.params.join(", ")})`];
  if (card.doc) parts.push(card.doc);
  if (card.observed && card.observed.returns.length > 0)
    parts.push(
      `takes ${card.observed.params.map((t) => t.join("|") || "?").join(", ")} returns ${card.observed.returns.join("|")}`,
    );
  if (variant === "card+examples")
    for (const e of card.examples.slice(0, 3))
      parts.push(`${card.name}(${e.args.map(show).join(", ")}) = ${show(e.returns)}`);
  return parts.join("\n");
}
