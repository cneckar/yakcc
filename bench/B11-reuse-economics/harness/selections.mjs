#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Record each task's composition context with the source-spread fill off (rank order) and on
// (#1271), at several token budgets. Deterministic: no model, no network.
//   node harness/selections.mjs [--slice fixture|retrieved] [--budgets 400,600,1200] [--share 0.5]
//     [--out results/fill-selections.json]
// The default slice source here is the fixture (the #1271 record); --slice retrieved uses
// retrieval/production.json and writes results/fill-selections-retrieved.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTasks } from "./lib.mjs";
import {
  DEFAULTS,
  RETRIEVAL_FILE,
  describeSelection,
  selectionFor,
  withSliceSource,
} from "./run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const budgets = arg("budgets", "400,600,1200").split(",").map(Number);
const maxPackageShare = Number(arg("share", String(DEFAULTS.maxPackageShare)));
const sliceSource = arg("slice", "fixture");
const out = arg(
  "out",
  join(
    here,
    "..",
    "results",
    sliceSource === "fixture" ? "fill-selections.json" : `fill-selections-${sliceSource}.json`,
  ),
);
const retrieval =
  sliceSource === "retrieved" ? JSON.parse(readFileSync(RETRIEVAL_FILE, "utf8")) : undefined;
const tasks = withSliceSource(loadTasks(join(here, "..", "tasks")), sliceSource, retrieval);

const report = { sliceSource, maxPackageShare, budgets: {} };
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
        // Needed atoms are named by fixture id; a retrieved slice has its own ids.
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
