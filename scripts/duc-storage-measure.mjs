// Storage measurement for the minimized atom form (#1275, D6).
// For every novel-glue atom, in four forms, raw bytes and compressed (gzip, brotli):
//   json        the canonical graph as JSON, annotations included (today's form)
//   compact     the compact encoding of that graph, annotations included
//   structure   the structure-only form: origin annotations removed and renumbered
//               (D6: identity is structure only), compact encoding
// Usage: node scripts/duc-storage-measure.mjs <outDir> [pkg ...]
import { readdirSync, writeFileSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { shavePackage, collectForestSlicePlans } from "../packages/shave/dist/universalize/module-graph.js";
import { slice } from "../packages/shave/dist/universalize/slicer.js";
import { liftAtom } from "../packages/duc/dist/lift.js";
import { encodeGraph } from "../packages/duc/dist/compact.js";
import { canonicalizeGraph } from "../packages/duc/dist/canonical.js";

const CORPUS = resolve("packages/shave/src/__fixtures__/module-graph");
const OUT = process.argv[2];
const pkgs = process.argv.length > 3 ? process.argv.slice(3) : readdirSync(CORPUS).sort();
const reg = { findByCanonicalAstHash: async () => [] };

const brotli = (buf) => brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const forms = (name, raw) => {
  const b = Buffer.from(raw, "utf8");
  return { [`${name}Raw`]: b.length, [`${name}Gzip`]: gzipSync(b, { level: 9 }).length, [`${name}Brotli`]: brotli(b) };
};

// Structure-only: drop origin annotations and renumber, so identity is structure only.
function structureOnly(g) {
  const stripped = g.nodes.map(({ origin, ...rest }) => rest);
  return canonicalizeGraph(stripped, g.obs);
}

for (const pkg of pkgs) {
  const t0 = Date.now();
  const forest = await shavePackage(join(CORPUS, pkg), { registry: reg });
  const plans = await collectForestSlicePlans(forest, slice, reg);
  const rec = { pkg, atoms: 0, liftErrors: 0, bytes: {} };
  const add = (k, v) => { rec.bytes[k] = (rec.bytes[k] ?? 0) + v; };
  for (const { slicePlan } of plans) {
    for (const e of slicePlan.entries) {
      if (e.kind !== "novel-glue" || typeof e.source !== "string") continue;
      let g;
      try { g = liftAtom(e.source); } catch { rec.liftErrors++; continue; }
      rec.atoms++;
      for (const [k, v] of Object.entries(forms("json", JSON.stringify(g)))) add(k, v);
      for (const [k, v] of Object.entries(forms("compact", JSON.stringify(encodeGraph(g))))) add(k, v);
      const s = structureOnly(g);
      for (const [k, v] of Object.entries(forms("structure", JSON.stringify(encodeGraph(s))))) add(k, v);
    }
  }
  rec.ms = Date.now() - t0;
  writeFileSync(join(OUT, `${pkg}.json`), JSON.stringify(rec, null, 2));
  console.log("DONE", pkg, "atoms", rec.atoms, "jsonGzip", rec.bytes.jsonGzip, "structureBrotli", rec.bytes.structureBrotli);
}
console.log("ALL DONE");
