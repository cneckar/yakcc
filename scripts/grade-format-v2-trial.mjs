// Grades the format-v2 model trial (trials/format-v2/prompt.md). Each task has a hidden reference,
// lifted by the DUC lifter. For each answer it reports:
//   parses     — the line form is valid;
//   structure  — its graph identity equals the reference's;
//   behaviour  — the graph, emitted to TypeScript and run on test inputs, returns what the reference returns.
// "behaviour without structure" is a canonicalization gap; "no parse" is a syntax problem.
// Usage: node scripts/grade-format-v2-trial.mjs <output.txt> [label]
//        node scripts/grade-format-v2-trial.mjs --print-references
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { liftAtom } from "../packages/duc/dist/lift.js";
import { parseLineForm, printLineForm, LineFormError } from "../packages/duc/dist/line-form.js";
import { graphIdentity } from "../packages/duc/dist/canonical.js";
import { emitTypeScript } from "../packages/duc/dist/emit-ts.js";

const TASKS = {
  1: { construct: "member and call", ref: "export function f(s) { return s.trim().toUpperCase(); }", inputs: [["  ab "], ["x"]] },
  2: { construct: "object and template", ref: "export function f(n) { return { name: n, label: `id-${n}` }; }", inputs: [[3], [0]] },
  3: { construct: "if / join", ref: "export function f(x) { if (x < 0) { return 0 - x; } return x * 2; }", inputs: [[-3], [4], [0]] },
  4: { construct: "select", ref: "export function f(a, b) { return a > b ? a : b; }", inputs: [[1, 2], [5, 3]] },
  5: { construct: "while loop", ref: "export function f(n) { let s = 0; let i = 1; while (i <= n) { s = s + i; i = i + 1; } return s; }", inputs: [[0], [1], [5]] },
  6: { construct: "loop over a collection", ref: "export function f(xs, k) { let c = 0; for (const x of xs) { if (x > k) { c = c + 1; } } return c; }", inputs: [[[], 1], [[1, 5, 3], 2]] },
  7: { construct: "function", ref: "export function f(k) { const add = (y) => y + k; return add(1) * add(2); }", inputs: [[0], [3]] },
  8: { construct: "ambient", ref: "export function f(a, b) { return Math.max(a, b) - Math.min(a, b); }", inputs: [[1, 4], [7, 2]] },
  9: { construct: "property write", ref: "export function f(x) { const o = { v: 0 }; o.v = x + 1; return o; }", inputs: [[1], [-1]] },
  10: { construct: "array and spread", ref: "export function f(xs, y) { return [...xs, y]; }", inputs: [[[], 1], [[1, 2], 3]] },
};

const run = (code, args) => new Function(code.replace(/^export function f/m, "return function f"))()(...args);

if (process.argv[2] === "--print-references") {
  for (const [n, t] of Object.entries(TASKS)) {
    console.log(`=== task ${n} ===`);
    console.log(printLineForm(liftAtom(t.ref)).trimEnd());
  }
  process.exit(0);
}

const [file, label = file] = process.argv.slice(2);
const parts = readFileSync(file, "utf8").split(/^=== task (\d+) ===\s*$/m);
const programs = {};
for (let i = 1; i < parts.length; i += 2) {
  programs[Number(parts[i])] = (parts[i + 1] ?? "").replace(/^```\w*\s*$/gm, "").trim();
}
const rows = [];
for (const [n, t] of Object.entries(TASKS)) {
  const row = { task: Number(n), construct: t.construct, parses: false, structure: false, behaviour: false, detail: "" };
  const program = programs[Number(n)];
  // A rerun covers some of the tasks: grade the ones the reply has.
  if (program === undefined) continue;
  let g;
  try { g = parseLineForm(program + "\n"); row.parses = true; } catch (e) { rows.push({ ...row, detail: e instanceof LineFormError ? e.message : String(e) }); continue; }
  const ref = liftAtom(t.ref);
  row.structure = graphIdentity(g) === graphIdentity(ref);
  try {
    const code = emitTypeScript(g);
    row.behaviour = t.inputs.every((args) => isDeepStrictEqual(run(code, structuredClone(args)), run(t.ref, structuredClone(args))));
    if (!row.behaviour) row.detail = "returns a different value";
  } catch (e) {
    row.detail = `cannot run: ${String(e.message ?? e).slice(0, 80)}`;
  }
  rows.push(row);
}
const count = (k) => rows.filter((r) => r[k]).length;
const of = rows.length;
console.log(`${label}: parses ${count("parses")}/${of}, same structure ${count("structure")}/${of}, same behaviour ${count("behaviour")}/${of}`);
for (const r of rows) {
  const mark = (b) => (b ? "yes" : "no ");
  console.log(`  task ${String(r.task).padStart(2)} ${r.construct.padEnd(24)} parses ${mark(r.parses)} structure ${mark(r.structure)} behaviour ${mark(r.behaviour)}${r.detail ? "  — " + r.detail : ""}`);
}
