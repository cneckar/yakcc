// Grades model outputs for the line-form prompt (#1275, item 2 and the model trials).
// Each output has "=== task N ===" headers, then one program per task.
// For each task: does it parse (the parser is the validator), and does it have the same
// structural identity as the reference TypeScript, lifted by the DUC lifter?
// Usage: node scripts/grade-line-form.mjs <output.txt> [label]
import { readFileSync } from "node:fs";
import { liftAtom } from "../packages/duc/dist/lift.js";
import { parseLineForm, LineFormError } from "../packages/duc/dist/line-form.js";
import { graphIdentity } from "../packages/duc/dist/canonical.js";

// The hidden references. Each is the TypeScript the intent describes.
const REFERENCES = {
  1: "export function f(a: number): number { return a * 2; }",
  2: "export function f(a: number, b: number): number { return a - b; }",
  3: "export function f(a: number, b: number): boolean { return a < b; }",
  4: "export function f(s: string): string { return encodeURI(s); }",
  5: "export function f(xs: number[]): number { return xs[0] - xs[1]; }",
  6: "export function f(a: number, b: number): number { return a * 2 + b; }",
  7: "export function f(a: number, b: number): number { return b + a; }",
  8: "export function f(a: number): number { return a - 1; }",
};

const [file, label = file] = process.argv.slice(2);
const text = readFileSync(file, "utf8");
const parts = text.split(/^=== task (\d+) ===\s*$/m);
const programs = {};
for (let i = 1; i < parts.length; i += 2) {
  const body = (parts[i + 1] ?? "").replace(/^```\w*\s*$/gm, "").replace(/^```\s*$/gm, "").trim();
  programs[Number(parts[i])] = body;
}

const results = [];
for (const [task, ref] of Object.entries(REFERENCES)) {
  const program = programs[Number(task)];
  if (program === undefined) { results.push({ task: Number(task), status: "missing" }); continue; }
  let parsed;
  try {
    parsed = parseLineForm(program + "\n");
  } catch (e) {
    const msg = e instanceof LineFormError ? e.message : String(e);
    results.push({ task: Number(task), status: "parse-error", detail: msg });
    continue;
  }
  const same = graphIdentity(parsed) === graphIdentity(liftAtom(ref));
  results.push({ task: Number(task), status: same ? "match" : "parses-different-structure" });
}

const parsed = results.filter((r) => r.status !== "parse-error" && r.status !== "missing").length;
const matched = results.filter((r) => r.status === "match").length;
console.log(`${label}: parsed ${parsed}/8, same structure as reference ${matched}/8`);
for (const r of results) console.log(`  task ${r.task}: ${r.status}${r.detail ? " — " + r.detail : ""}`);
