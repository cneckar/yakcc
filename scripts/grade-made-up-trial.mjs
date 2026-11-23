// Grades the made-up-construct trial (trials/made-up-construct/prompt.md). There is no TypeScript
// reference, so each task is graded on its structure against the prompt's definitions:
//   1. an op labelled "blend" over the two parameters, and its result is the output
//   2. an ambient "clamp3" whose value flows to the output, and that output depends on a
//   3. a blend whose operands are a and the value of clamp3 applied to b
// Usage: node scripts/grade-made-up-trial.mjs <output.txt> [label]
import { readFileSync } from "node:fs";
import { parseLineForm, LineFormError } from "../packages/duc/dist/line-form.js";
import { mayInfluence } from "../packages/duc/dist/influence.js";

const [file, label = file] = process.argv.slice(2);
const parts = readFileSync(file, "utf8").split(/^=== task (\d+) ===\s*$/m);
const programs = {};
for (let i = 1; i < parts.length; i += 2) {
  programs[Number(parts[i])] = (parts[i + 1] ?? "").replace(/^```\w*\s*$/gm, "").replace(/^```\s*$/gm, "").trim();
}

function grade(task, g) {
  const params = g.nodes.filter((n) => n.kind === "param-source").map((n) => n.outputs[0]);
  const obs = g.obs[0];
  const blends = g.nodes.filter((n) => n.kind === "op" && n.label === "blend");
  const clamp = g.nodes.find((n) => n.diamond?.symbol === "clamp3");
  if (task === 1) {
    const ok = blends.some((n) => n.outputs[0] === obs && n.inputs.length === 2 &&
      n.inputs.includes(params[0]) && n.inputs.includes(params[1]));
    return ok ? "match" : "wrong-structure";
  }
  if (task === 2) {
    if (clamp === undefined || clamp.outputs[0] === undefined) return "no-clamp3";
    const ok = mayInfluence(g, clamp.outputs[0], obs) && mayInfluence(g, params[0], obs);
    return ok ? "match" : "wrong-structure";
  }
  if (task === 3) {
    if (clamp === undefined) return "no-clamp3";
    const cv = clamp.outputs[0];
    const ok = blends.some((n) => n.outputs[0] === obs && n.inputs.length === 2 &&
      n.inputs.includes(params[0]) &&
      n.inputs.some((v) => v !== params[0] && (v === cv || mayInfluence(g, cv, v))));
    return ok ? "match" : "wrong-structure";
  }
  return "unknown-task";
}

const results = [];
for (const task of [1, 2, 3]) {
  const program = programs[task];
  if (program === undefined) { results.push({ task, status: "missing" }); continue; }
  try {
    const g = parseLineForm(program + "\n");
    results.push({ task, status: grade(task, g) });
  } catch (e) {
    results.push({ task, status: "parse-error", detail: e instanceof LineFormError ? e.message : String(e) });
  }
}
const parsed = results.filter((r) => r.status !== "parse-error" && r.status !== "missing").length;
const matched = results.filter((r) => r.status === "match").length;
console.log(`${label}: parsed ${parsed}/3, matches the definitions ${matched}/3`);
for (const r of results) console.log(`  task ${r.task}: ${r.status}${r.detail ? " — " + r.detail : ""}`);
