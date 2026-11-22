// Recall of the retrieval signature under model-style rewrites (#1275, item 3, measurement).
//
// Index: every stored atom in the fixture corpus, as embed(retrievalSignature(graph)).
// Queries: for each straight-line atom, variants of its line-form text, rewritten the way a
// model might write the same function. Each variant is parsed back to a graph, its signature is
// computed, embedded, and the rank of the original atom among all atoms is recorded.
// Rewrites are semantics-preserving by construction:
//   R0 identity            the atom's own line form (sanity: must be rank 1)
//   R1 operand swap        commutative operators, operands exchanged
//   R2 strength reduction  x * 2 written as x + x
//   R3 negated subtraction a - b written as a + (neg b)
//   R4 redundant identity  r written as r + 0 at its definition
//   R5 flipped comparison  a < b written as b > a
// Usage: node scripts/retrieval-recall-measure.mjs <outDir> <atomsCache.json>
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { liftAtom } from "../packages/duc/dist/lift.js";
import { printLineForm, parseLineForm } from "../packages/duc/dist/line-form.js";
import { retrievalSignature } from "../packages/duc/dist/retrieval-signature.js";
import { graphIdentity } from "../packages/duc/dist/canonical.js";
import { shavePackage, collectForestSlicePlans } from "../packages/shave/dist/universalize/module-graph.js";
import { slice } from "../packages/shave/dist/universalize/slicer.js";

const OUT = process.argv[2];
const CACHE = process.argv[3];
const CORPUS = resolve("packages/shave/src/__fixtures__/module-graph");

// 1. The atoms, cached so the shaving is done once.
let atoms;
if (existsSync(CACHE)) {
  atoms = JSON.parse(readFileSync(CACHE, "utf8"));
} else {
  const reg = { findByCanonicalAstHash: async () => [] };
  atoms = [];
  for (const pkg of readdirSync(CORPUS).sort()) {
    const forest = await shavePackage(join(CORPUS, pkg), { registry: reg });
    const plans = await collectForestSlicePlans(forest, slice, reg);
    for (const { slicePlan } of plans) {
      for (const e of slicePlan.entries) {
        if (e.kind === "novel-glue" && typeof e.source === "string") atoms.push({ pkg, source: e.source });
      }
    }
    console.log("shaved", pkg, atoms.length);
  }
  writeFileSync(CACHE, JSON.stringify(atoms));
}
atoms.forEach((a, i) => { a.id = i; });

// 2. The embedder: the same model and pooling as the registry.
const req = createRequire(resolve("packages/contracts/package.json"));
const { pipeline } = await import(req.resolve("@xenova/transformers"));
const pipe = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
const embed = async (text) => Float32Array.from((await pipe(text, { pooling: "mean", normalize: true })).data);

// 3. Line-form directives, for rewriting. Printing and parsing go through the real line form.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function toDirectives(text) {
  return text.split("\n").map((raw) => raw.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const m = /^lit\s+("(?:[^"\\]|\\.)*")\s*->\s*(\S+)$/.exec(l);
    if (m) return { t: "lit", label: JSON.parse(m[1]), name: m[2] };
    const p = l.split(/\s+/);
    if (p[0] === "param") return { t: "param", name: p[1] };
    if (p[0] === "out") return { t: "out", name: p[1] };
    if (p[0] === "free" || p[0] === "ambient") return { t: p[0], sym: p[1], name: p[3] };
    const arrow = p.indexOf("->");
    const args = arrow === -1 ? p.slice(2) : p.slice(2, arrow);
    return { t: "op", label: p[1], args, res: arrow === -1 ? null : p[arrow + 1] };
  });
}
function toText(ds) {
  return ds.map((d) => {
    if (d.t === "param") return `param ${d.name}`;
    if (d.t === "out") return `out ${d.name}`;
    if (d.t === "lit") return `lit ${JSON.stringify(d.label)} -> ${d.name}`;
    if (d.t === "free" || d.t === "ambient") return `${d.t} ${d.sym} -> ${d.name}`;
    return `op ${d.label}${d.args.length ? " " + d.args.join(" ") : ""}${d.res ? " -> " + d.res : ""}`;
  }).join("\n") + "\n";
}
let fresh = 0;
const freshName = (base) => `${base}_${fresh++}`;
const COMMUTATIVE = new Set(["+", "*", "==", "===", "!=", "!==", "&", "|", "^"]);
const FLIP = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };

function rewrites(ds) {
  const out = {};
  // R1 operand swap.
  const r1 = ds.map((d) => (d.t === "op" && COMMUTATIVE.has(d.label) && d.args.length === 2 ? { ...d, args: [d.args[1], d.args[0]] } : d));
  if (toText(r1) !== toText(ds)) out.R1 = r1;
  // R2 strength reduction: x * lit(2) -> x + x.
  const litOf = new Map(ds.filter((d) => d.t === "lit").map((d) => [d.name, d.label]));
  const r2 = [];
  let changed2 = false;
  for (const d of ds) {
    if (d.t === "op" && d.label === "*" && d.args.length === 2 && d.res) {
      const [a, b] = d.args;
      const other = litOf.get(b) === "2" ? a : litOf.get(a) === "2" ? b : null;
      if (other !== null) { r2.push({ ...d, label: "+", args: [other, other] }); changed2 = true; continue; }
    }
    r2.push(d);
  }
  if (changed2) {
    const used = new Set(r2.flatMap((d) => (d.t === "op" ? d.args : d.t === "out" ? [d.name] : [])));
    out.R2 = r2.filter((d) => !(d.t === "lit" && litOf.get(d.name) === "2" && !used.has(d.name)));
  }
  // R3 a - b -> a + neg(b).
  const r3 = [];
  let changed3 = false;
  for (const d of ds) {
    if (d.t === "op" && d.label === "-" && d.args.length === 2 && d.res) {
      const t = freshName("neg");
      r3.push({ t: "op", label: "neg", args: [d.args[1]], res: t }, { ...d, label: "+", args: [d.args[0], t] });
      changed3 = true;
    } else r3.push(d);
  }
  if (changed3) out.R3 = r3;
  // R4 redundant identity: after the first definition r, use r + 0 everywhere after it.
  const idx = ds.findIndex((d) => (d.t === "op" && d.res) || d.t === "lit" || d.t === "param");
  const firstName = idx === -1 ? undefined : (ds[idx].name ?? ds[idx].res);
  if (firstName !== undefined && firstName !== null) {
    const r = firstName;
    const z = freshName("zero");
    const r2name = freshName("plus0");
    const rewired = ds.slice(idx + 1).map((d) => {
      if (d.t === "op") return { ...d, args: d.args.map((a) => (a === r ? r2name : a)) };
      if (d.t === "out") return { ...d, name: d.name === r ? r2name : d.name };
      return d;
    });
    out.R4 = [...ds.slice(0, idx + 1), { t: "lit", label: "0", name: z }, { t: "op", label: "+", args: [r, z], res: r2name }, ...rewired];
  }
  // R5 flipped comparison: a < b -> b > a.
  const r5 = ds.map((d) => (d.t === "op" && FLIP[d.label] && d.args.length === 2 ? { ...d, label: FLIP[d.label], args: [d.args[1], d.args[0]] } : d));
  if (toText(r5) !== toText(ds)) out.R5 = r5;
  return out;
}

// 4. Index every atom.
const index = [];
for (const a of atoms) {
  let g;
  try { g = liftAtom(a.source); } catch { continue; }
  a.sig = retrievalSignature(g);
  // Structurally identical atoms are one distinct structure (D1/D6): a hit is any member of the group.
  a.identity = graphIdentity(g);
  index.push({ id: a.id, identity: a.identity, vec: await embed(a.sig) });
}
const dot = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * y[i]; return s; };

// 5. Queries.
const families = {};
const note = (fam, rank, id) => {
  const f = (families[fam] ??= { n: 0, top1: 0, top5: 0, top10: 0, ranks: [], misses: [] });
  f.n++;
  if (rank === 1) f.top1++;
  if (rank <= 5) f.top5++;
  if (rank <= 10) f.top10++;
  f.ranks.push(rank);
  if (rank > 10 && f.misses.length < 6) f.misses.push(id);
};
let straight = 0;
const queried = new Set();
for (const a of atoms) {
  // One query per distinct structure: identical copies would otherwise count the same case many times.
  if (a.identity === undefined || queried.has(a.identity)) continue;
  queried.add(a.identity);
  let base;
  try { base = printLineForm(liftAtom(a.source)); } catch { continue; }
  straight++;
  const queries = { R0: base };
  let ds = toDirectives(base);
  for (const [fam, rewritten] of Object.entries(rewrites(ds))) {
    const text = toText(rewritten);
    try { parseLineForm(text); queries[fam] = text; } catch { families.invalid ??= { n: 0 }; families.invalid.n++; }
  }
  for (const [fam, text] of Object.entries(queries)) {
    const sig = retrievalSignature(parseLineForm(text));
    const q = await embed(sig);
    const sims = index.map((e) => ({ id: e.id, identity: e.identity, s: dot(q, e.vec) })).sort((x, y) => y.s - x.s);
    const hit = sims.findIndex((e) => e.identity === a.identity);
    if (hit === -1) throw new Error(`atom ${a.id} is not in the index`);
    const rank = hit + 1;
    note(fam, rank, a.id);
  }
}

const summary = {};
for (const [fam, f] of Object.entries(families)) {
  if (fam === "invalid") { summary[fam] = f; continue; }
  f.ranks.sort((x, y) => x - y);
  summary[fam] = { queries: f.n, recall1: +(f.top1 / f.n).toFixed(3), recall5: +(f.top5 / f.n).toFixed(3), recall10: +(f.top10 / f.n).toFixed(3), medianRank: f.ranks[Math.floor(f.n / 2)], missedIds: f.misses };
}
const report = { atoms: atoms.length, indexed: index.length, distinctStructures: queried.size, straightLine: straight, summary };
writeFileSync(join(OUT, "recall.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log("ALL DONE");
