#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Record each task's composition context with the source-spread fill off (rank order) and on
// (#1271), at several token budgets. Deterministic: no model, no network.
//   node harness/selections.mjs [--budgets 600,1200] [--share 0.5] [--out results/fill-selections.json]
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTasks } from "./lib.mjs";
import { DEFAULTS, describeSelection, selectionFor } from "./run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const budgets = arg("budgets", "600,1200").split(",").map(Number);
const maxPackageShare = Number(arg("share", String(DEFAULTS.maxPackageShare)));
const out = arg("out", join(here, "..", "results", "fill-selections.json"));
const tasks = loadTasks(join(here, "..", "tasks"));

const report = { maxPackageShare, budgets: {} };
for (const tokenBudget of budgets) {
  const rows = tasks.map((task) => {
    const rank = describeSelection(
      selectionFor(task, { tokenBudget, maxPackageShare, fill: false }).ctx,
    );
    const fill = describeSelection(
      selectionFor(task, { tokenBudget, maxPackageShare, fill: true }).ctx,
    );
    const atoms = new Set(
      (task.atoms ?? []).map((a) => {
        const [pkg, rest] = a.split(":");
        const [file, name] = rest.split("#");
        return task.slice.find((c) => c.ref?.file === `${pkg}/${file}` && c.ref?.name === name)?.id;
      }),
    );
    const neededDropped = (sel) => sel.dropped.filter((id) => atoms.has(id));
    return {
      task: task.id,
      differs: rank.selected.join() !== fill.selected.join(),
      rank,
      fill,
      neededAtomsDropped: { rank: neededDropped(rank), fill: neededDropped(fill) },
    };
  });
  report.budgets[tokenBudget] = {
    tasksWhereFillDiffers: rows.filter((r) => r.differs).map((r) => r.task),
    tasks: rows,
  };
}
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
for (const [b, r] of Object.entries(report.budgets))
  console.log(
    `budget ${b}: the fill changes the candidate set of ${r.tasksWhereFillDiffers.length} tasks: ${r.tasksWhereFillDiffers.join(", ")}`,
  );
console.log(`wrote ${out}`);
