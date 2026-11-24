#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Build B16's held-out cases: for each task with `inputs` or `gen`, run the reference (the
// corpus module plus the task's reference glue) on those inputs and record what it returns or
// that it throws. First, the task's published `vectors` are checked against the reference, so
// a reference that disagrees with the standard stops the build instead of becoming the answer.
// Deterministic: generated inputs come from a generator seeded by the task id.
//
//   node harness/build-cases.mjs [--tasks id,id]
process.env.TZ = "UTC";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { taggedEqual } from "../../B12-need-to-code/harness/sandbox.mjs";
import { tasks } from "../tasks.mjs";
import { rngFor } from "./rng.mjs";
import { CASES_DIR, callSolve, loadSolution } from "./score.mjs";

const uniq = (lists) => {
  const seen = new Set();
  return lists.filter((a) => {
    const k = JSON.stringify(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Build one task's cases; throws if a published vector disagrees with the reference. */
export function buildCases(task) {
  const loaded = loadSolution(task.referenceGlue, task.lib);
  if (loaded.error) throw new Error(`${task.id}: reference did not load: ${loaded.error}`);
  const run = (args) => callSolve(loaded.context, args);
  for (const v of task.vectors ?? []) {
    const r = run(v.args);
    if (!r.ok || !taggedEqual(r.value, v.returns))
      throw new Error(
        `${task.id}: the reference disagrees with ${v.source} on ${JSON.stringify(v.args)}: got ${JSON.stringify(r.ok ? r.value : r.error)}`,
      );
  }
  const inputs = uniq([
    ...(task.vectors ?? []).map((v) => v.args),
    ...(task.inputs ?? []),
    ...(task.gen ? task.gen(rngFor(task.id)) : []),
  ]);
  const cases = [];
  for (const args of inputs) {
    const r = run(args);
    if (r.timeout)
      throw new Error(`${task.id}: the reference timed out on ${JSON.stringify(args)}`);
    cases.push(r.ok ? { args, returns: r.value } : { args, throws: true });
  }
  return cases;
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--tasks");
  const only = i >= 0 ? argv[i + 1].split(",") : null;
  mkdirSync(CASES_DIR, { recursive: true });
  for (const t of tasks) {
    if (only && !only.includes(t.id)) continue;
    if (!t.inputs && !t.gen && !t.vectors) continue;
    const cases = buildCases(t);
    const throws = cases.filter((c) => c.throws).length;
    const distinct = new Set(cases.map((c) => JSON.stringify(c.returns ?? "throws"))).size;
    writeFileSync(
      join(CASES_DIR, `${t.id}.json`),
      `${JSON.stringify({ id: t.id, cases }, null, 1)}\n`,
    );
    console.log(
      `${t.id.padEnd(24)} ${String(cases.length).padStart(3)} cases, ${throws} throw, ${distinct} distinct outputs`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
