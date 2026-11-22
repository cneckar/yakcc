// Measurements for the "DUC-native" decision (issue: DUC-native artifact).
// For every novel-glue atom in the fixture corpus:
//   M1 captures:      reads of module-level bindings (captured by the atom)
//   M2 composition:   reads of sibling/internal atom symbols
//   M3 surface:       diamond sources by reason (foreign, ambient, free, unresolved)
//   M4 control:       atoms whose graph lowers control to sel/loop nodes
//   M5 size:          graph node/edge counts and JSON bytes vs source bytes
//   M6 determinism:   two independent lifts produce identical JSON
//   M7 boundary:      atoms whose source as written does not parse (wrapped by lift)
// Usage: node tmp/duc-native-measure.mjs <outDir> [pkg ...]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const requireFromShave = createRequire(resolve("packages/shave/package.json"));
const { Project, ScriptKind } = requireFromShave("ts-morph");
import { shavePackage, collectForestSlicePlans } from "../packages/shave/dist/universalize/module-graph.js";
import { slice } from "../packages/shave/dist/universalize/slicer.js";
import { collectInternalSymbols, moduleBindingsOf } from "../packages/shave/dist/persist/duc-gate.js";
import { liftAtom } from "../packages/duc/dist/lift.js";

const CORPUS = resolve("packages/shave/src/__fixtures__/module-graph");
const OUT = process.argv[2];
const pkgs = process.argv.length > 3 ? process.argv.slice(3) : readdirSync(CORPUS).sort();
const reg = { findByCanonicalAstHash: async () => [] };

function parsesAsWritten(source) {
  const p = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: false, noEmit: true, noLib: true } });
  const sf = p.createSourceFile("a.ts", source, { scriptKind: ScriptKind.TS });
  return p.getProgram().getSyntacticDiagnostics(sf).length === 0;
}

for (const pkg of pkgs) {
  const t0 = Date.now();
  const forest = await shavePackage(join(CORPUS, pkg), { registry: reg });
  const plans = await collectForestSlicePlans(forest, slice, reg);
  const sources = [];
  for (const { slicePlan } of plans) for (const e of slicePlan.entries) if (e.kind === "novel-glue" && typeof e.source === "string") sources.push(e.source);
  const internal = collectInternalSymbols(sources);
  const rec = { pkg, atoms: 0, captureAtoms: 0, captureNames: new Set(), compositionAtoms: 0, compositionRefs: 0,
    reasons: {}, controlAtoms: 0, nodes: 0, edges: 0, jsonBytes: 0, sourceBytes: 0, deterministic: 0, notDeterministic: 0,
    unparsableAsWritten: 0, liftErrors: 0 };
  for (const { filePath, slicePlan } of plans) {
    const bindings = moduleBindingsOf(readFileSync(filePath, "utf8"));
    for (const e of slicePlan.entries) {
      if (e.kind !== "novel-glue" || typeof e.source !== "string") continue;
      rec.atoms++;
      rec.sourceBytes += Buffer.byteLength(e.source, "utf8");
      if (!parsesAsWritten(e.source)) rec.unparsableAsWritten++;
      let g1, g2;
      try { g1 = liftAtom(e.source); g2 = liftAtom(e.source); } catch { rec.liftErrors++; continue; }
      const j1 = JSON.stringify(g1);
      if (j1 === JSON.stringify(g2)) rec.deterministic++; else rec.notDeterministic++;
      rec.jsonBytes += Buffer.byteLength(j1, "utf8");
      rec.nodes += g1.nodes.length;
      rec.edges += g1.nodes.reduce((a, n) => a + (n.inputs?.length ?? 0), 0);
      const diamonds = g1.nodes.filter((n) => n.diamond !== undefined).map((n) => n.diamond);
      for (const d of diamonds) rec.reasons[d.reason] = (rec.reasons[d.reason] ?? 0) + 1;
      const captured = diamonds.filter((d) => bindings.has(d.symbol));
      if (captured.length) { rec.captureAtoms++; for (const d of captured) rec.captureNames.add(d.symbol); }
      const comp = diamonds.filter((d) => internal.has(d.symbol));
      if (comp.length) { rec.compositionAtoms++; rec.compositionRefs += comp.length; }
      if (g1.nodes.some((n) => n.kind === "sel" || n.kind === "loop")) rec.controlAtoms++;
    }
  }
  rec.captureNames = rec.captureNames.size;
  rec.ms = Date.now() - t0;
  writeFileSync(join(OUT, `${pkg}.json`), JSON.stringify(rec, null, 2));
  console.log("DONE", pkg, "atoms", rec.atoms, "captureAtoms", rec.captureAtoms, "controlAtoms", rec.controlAtoms, "deterministic", rec.deterministic, "/", rec.deterministic + rec.notDeterministic);
}
console.log("ALL DONE");
