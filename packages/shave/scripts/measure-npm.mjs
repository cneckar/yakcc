// SPDX-License-Identifier: Apache-2.0
// Shave each file of an npm package through the real pipeline and gate every atom (#1368): the
// counterpart of node-platform's scripts/measure.mjs for the npm closure. Run after building:
//   node scripts/measure-npm.mjs <package root> [file list] > report.txt
// Without a file list, every .js/.cjs/.mjs file under the root (outside node_modules) is shaved.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  collectForestSlicePlans,
  enclosingBindingsOf,
  forestGateContext,
  runDucConservationGate,
  shavePackage,
  slice,
} from "../dist/index.js";

const [root, listFile] = process.argv.slice(2);
if (root === undefined) {
  console.error("usage: node scripts/measure-npm.mjs <package root> [file list]");
  process.exit(2);
}
const filesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? d.name === "node_modules"
        ? []
        : filesUnder(join(dir, d.name))
      : /\.(c|m)?js$/.test(d.name)
        ? [join(dir, d.name)]
        : [],
  );
const files =
  listFile === undefined
    ? filesUnder(root)
    : readFileSync(listFile, "utf8")
        .split("\n")
        .filter((f) => f !== "");
// The registry is empty: every atom is novel, so every atom is gated. Nothing is persisted.
const registry = { findByCanonicalAstHash: async () => [], getBlock: async () => undefined };
// A CommonJS module's wrapper parameters.
const CJS = ["exports", "require", "module", "__filename", "__dirname"];
let atoms = 0;
let clean = 0;
const unexplained = Object.create(null);
for (const file of files) {
  let fileAtoms = 0;
  let fileClean = 0;
  try {
    const forest = await shavePackage(root, { registry, entryPath: file, maxModules: 1 });
    const plans = await collectForestSlicePlans(
      forest,
      (tree, _registry, options) => slice(tree, registry, options),
      registry,
    );
    for (const plan of plans) {
      const context = forestGateContext(plans, plan.filePath);
      const text = readFileSync(plan.filePath, "utf8");
      for (const entry of plan.slicePlan.entries) {
        if (entry.kind !== "novel-glue" || typeof entry.source !== "string") continue;
        fileAtoms++;
        const gate = runDucConservationGate(
          entry.source,
          context.internalSymbols,
          context.moduleBindings,
          new Set([...CJS, ...enclosingBindingsOf(text, entry.sourceRange)]),
        );
        if (gate.liftError !== undefined) {
          console.log(`LIFT ${file}: ${String(gate.liftError).slice(0, 160)}`);
          continue;
        }
        const faithful = gate.fidelity?.holds ?? true;
        if (!faithful)
          console.log(
            `UNFAITHFUL ${file}: missing ${gate.fidelity.missing.join(",")}; extra ${gate.fidelity.extra.join(",")}`,
          );
        for (const u of gate.unexplained) unexplained[u.symbol] = (unexplained[u.symbol] ?? 0) + 1;
        if (gate.unexplained.length === 0 && faithful) fileClean++;
      }
    }
  } catch (e) {
    console.log(`SHAVE ${file}: ${String(e).slice(0, 160)}`);
  }
  atoms += fileAtoms;
  clean += fileClean;
  if (fileClean !== fileAtoms) console.log(`${file}: ${fileClean}/${fileAtoms} clean`);
}
const top = Object.entries(unexplained)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 40)
  .map(([symbol, count]) => `${count} ${symbol}`);
if (top.length > 0) console.log(`unexplained: ${top.join(", ")}`);
console.log(
  `files ${files.length}, atoms ${atoms}, clean ${clean} (${((100 * clean) / Math.max(1, atoms)).toFixed(2)}%)`,
);
