// Grades the branching model trial (trials/branching/prompt.md). Each task has a hidden reference
// TypeScript, lifted by the DUC lifter. A program matches when its structural identity equals the
// reference's. Usage: node scripts/grade-branching-trial.mjs <output.txt> [label]
//        node scripts/grade-branching-trial.mjs --print-references   (prints each reference's line form)
import { readFileSync } from "node:fs";
import { liftAtom } from "../packages/duc/dist/lift.js";
import { parseLineForm, printLineForm, LineFormError } from "../packages/duc/dist/line-form.js";
import { graphIdentity } from "../packages/duc/dist/canonical.js";

const REFERENCES = {
  1: "export function f(a: number): number { let r = a; if (a < 0) { r = 0 - a; } return r; }",
  2: "export function f(a: number, b: number): number { let r = a; if (b > a) { r = b; } return r; }",
  3: "export function f(a: number, b: number, c: number): number { let r = c; if (a > b) { r = a; } return r; }",
  4: "export function f(p: boolean, q: boolean, x: number): number { let r = x; if (p) { if (q) { r = x + 1; } else { r = x - 1; } } return r; }",
};

if (process.argv[2] === "--print-references") {
  for (const [task, ref] of Object.entries(REFERENCES)) {
    console.log(`=== task ${task} ===`);
    console.log(printLineForm(liftAtom(ref)).trimEnd());
  }
  process.exit(0);
}

const [file, label = file] = process.argv.slice(2);
const parts = readFileSync(file, "utf8").split(/^=== task (\d+) ===\s*$/m);
const programs = {};
for (let i = 1; i < parts.length; i += 2) {
  programs[Number(parts[i])] = (parts[i + 1] ?? "").replace(/^```\w*\s*$/gm, "").replace(/^```\s*$/gm, "").trim();
}
const results = [];
for (const [task, ref] of Object.entries(REFERENCES)) {
  const program = programs[Number(task)];
  if (program === undefined) { results.push({ task: Number(task), status: "missing" }); continue; }
  try {
    const same = graphIdentity(parseLineForm(program + "\n")) === graphIdentity(liftAtom(ref));
    results.push({ task: Number(task), status: same ? "match" : "parses-different-structure" });
  } catch (e) {
    results.push({ task: Number(task), status: "parse-error", detail: e instanceof LineFormError ? e.message : String(e) });
  }
}
const parsed = results.filter((r) => r.status !== "parse-error" && r.status !== "missing").length;
const matched = results.filter((r) => r.status === "match").length;
console.log(`${label}: parsed ${parsed}/${Object.keys(REFERENCES).length}, same structure as reference ${matched}/${Object.keys(REFERENCES).length}`);
for (const r of results) console.log(`  task ${r.task}: ${r.status}${r.detail ? " — " + r.detail : ""}`);
