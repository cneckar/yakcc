// Two measurements for #1274 decisions D3 (structured control) and the compact encoding.
//   E1 encoding: canonical JSON size, compact encoding size, and gzip of each, per atom.
//   C1 control:  which control constructs each atom contains, and the deepest nesting.
// Usage: node scripts/duc-control-and-encoding-measure.mjs <outDir> [pkg ...]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { shavePackage, collectForestSlicePlans } from "../packages/shave/dist/universalize/module-graph.js";
import { slice } from "../packages/shave/dist/universalize/slicer.js";
import { liftAtom } from "../packages/duc/dist/lift.js";
import { encodeGraph } from "../packages/duc/dist/compact.js";

const requireFromShave = createRequire(resolve("packages/shave/package.json"));
const { Project, ScriptKind, Node } = requireFromShave("ts-morph");

const CORPUS = resolve("packages/shave/src/__fixtures__/module-graph");
const OUT = process.argv[2];
const pkgs = process.argv.length > 3 ? process.argv.slice(3) : readdirSync(CORPUS).sort();
const reg = { findByCanonicalAstHash: async () => [] };
const CONTROL = new Set([
  "IfStatement", "ConditionalExpression", "ForStatement", "ForOfStatement", "ForInStatement",
  "WhileStatement", "DoStatement", "SwitchStatement", "TryStatement", "LabeledStatement",
  "BreakStatement", "ContinueStatement",
]);

function controlOf(source) {
  const p = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: false, noEmit: true, noLib: true } });
  const sf = p.createSourceFile("a.ts", source, { scriptKind: ScriptKind.TS });
  if (p.getProgram().getSyntacticDiagnostics(sf).length > 0) return null;
  const kinds = new Set();
  let maxDepth = 0;
  const walk = (node, depth) => {
    const name = node.getKindName();
    let d = depth;
    if (CONTROL.has(name)) { kinds.add(name); d = depth + 1; maxDepth = Math.max(maxDepth, d); }
    node.forEachChild((c) => walk(c, d));
  };
  walk(sf, 0);
  return { kinds: [...kinds], maxDepth };
}

for (const pkg of pkgs) {
  const t0 = Date.now();
  const forest = await shavePackage(join(CORPUS, pkg), { registry: reg });
  const plans = await collectForestSlicePlans(forest, slice, reg);
  const rec = { pkg, atoms: 0, jsonBytes: 0, compactBytes: 0, jsonGzip: 0, compactGzip: 0,
    unparsed: 0, controlAtoms: 0, tier: { none: 0, ifOnly: 0, loops: 0, switchTryLabels: 0 },
    constructAtoms: {}, maxDepthHist: {}, liftErrors: 0 };
  for (const { slicePlan } of plans) {
    for (const e of slicePlan.entries) {
      if (e.kind !== "novel-glue" || typeof e.source !== "string") continue;
      rec.atoms++;
      let g;
      try { g = liftAtom(e.source); } catch { rec.liftErrors++; continue; }
      const json = JSON.stringify(g);
      const compact = JSON.stringify(encodeGraph(g));
      rec.jsonBytes += Buffer.byteLength(json);
      rec.compactBytes += Buffer.byteLength(compact);
      rec.jsonGzip += gzipSync(json).length;
      rec.compactGzip += gzipSync(compact).length;
      const c = controlOf(e.source);
      if (c === null) { rec.unparsed++; continue; }
      if (c.kinds.length === 0) { rec.tier.none++; continue; }
      rec.controlAtoms++;
      for (const k of c.kinds) rec.constructAtoms[k] = (rec.constructAtoms[k] ?? 0) + 1;
      rec.maxDepthHist[c.maxDepth] = (rec.maxDepthHist[c.maxDepth] ?? 0) + 1;
      const loops = c.kinds.some((k) => /For|While|Do/.test(k));
      const other = c.kinds.some((k) => ["SwitchStatement", "TryStatement", "LabeledStatement", "BreakStatement", "ContinueStatement"].includes(k));
      if (other) rec.tier.switchTryLabels++;
      else if (loops) rec.tier.loops++;
      else rec.tier.ifOnly++;
    }
  }
  rec.ms = Date.now() - t0;
  writeFileSync(join(OUT, `${pkg}.json`), JSON.stringify(rec, null, 2));
  console.log("DONE", pkg, "atoms", rec.atoms, "control", rec.controlAtoms, "json", rec.jsonBytes, "compact", rec.compactBytes, "gzipJson", rec.jsonGzip, "gzipCompact", rec.compactGzip);
}
console.log("ALL DONE");
