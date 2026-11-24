#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real retrieval for B11 (replaces the hand-set fixture scores as the slice source).
//
// Every named definition in the shave corpus fixtures (functions, classes, methods, and
// const-bound arrow or function expressions) is stored as a block in an in-memory registry. The
// registry uses the local embedding provider (Xenova/bge-small-en-v1.5), the same one
// bootstrap uses. Each block's spec is built the way shave persists an atom offline:
// staticExtract -> validateIntentCard -> specFromIntent.
// Each task's spec is then the query for registry.findCandidatesByIntent with the lexical
// channel on (embedding KNN fused with BM25, DEC-RETRIEVAL-LEXICAL-001). Scores are the
// registry's combinedScore (cosineDistanceToCombinedScore). A lexical-only hit has no
// embedding distance; the registry reports distance 1 for it.
//
// Variants:
//   production     the spec exactly as specFromIntent builds it. It keeps the behavior
//                  text only as a 30-character name slug.
//   with-behavior  the same spec plus the extracted behavior text (diagnostic: how much the
//                  slug costs retrieval).
//
//   node harness/retrieve.mjs [--variant production|with-behavior] [--k 8] [--deep 50]
// Writes retrieval/<variant>.json. Needs the shave, registry and contracts packages built,
// and the embedding model (downloaded once, then cached). No model API calls.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTasks } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");
const repo = resolve(benchDir, "..", "..");
const FIXTURES = join(repo, "packages/shave/src/__fixtures__/module-graph");
// Shave's own test packages, not corpus.
const SYNTHETIC = new Set(["circular-pkg", "degradation-pkg", "three-module-pkg"]);

const dist = (p) => pathToFileURL(join(repo, p)).href;
const { openRegistry } = await import(dist("packages/registry/dist/index.js"));
const { cosineDistanceToCombinedScore } = await import(
  dist("packages/registry/dist/discovery-eval-helpers.js")
);
const contracts = await import(dist("packages/contracts/dist/index.js"));
const { staticExtract } = await import(dist("packages/shave/dist/intent/static-extract.js"));
const { validateIntentCard } = await import(
  dist("packages/shave/dist/intent/validate-intent-card.js")
);
const { specFromIntent } = await import(dist("packages/shave/dist/persist/spec-from-intent.js"));
const { Project, Node, ScriptKind } = createRequire(join(repo, "packages/shave/package.json"))(
  "ts-morph",
);

/** Every named definition in the corpus, de-duplicated by source text (first path wins). */
/**
 * Every named definition in the corpus. By default, definitions whose source text repeats one
 * already seen are dropped (the first path wins); `{ dedupe: false }` keeps every copy, for
 * packages that ship several builds (uuid's cjs, esm and browser copies) where only some run
 * in a given runtime.
 */
export function corpusDefinitions({ dedupe = true } = {}) {
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(c|m)?js$|\.ts$/.test(f) && !f.endsWith(".d.ts")) files.push(p);
    }
  };
  for (const pkg of readdirSync(FIXTURES).sort())
    if (!SYNTHETIC.has(pkg)) walk(join(FIXTURES, pkg));
  const seen = new Set();
  const defs = [];
  for (const file of files) {
    const rel = relative(FIXTURES, file);
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { allowJs: true, noLib: true },
    });
    const sf = project.createSourceFile("m.ts", readFileSync(file, "utf8"), {
      scriptKind: ScriptKind.TS,
    });
    sf.forEachDescendant((node) => {
      let name;
      let target = node;
      if (Node.isFunctionDeclaration(node)) name = node.getName();
      else if (Node.isClassDeclaration(node)) name = node.getName();
      else if (Node.isMethodDeclaration(node)) name = node.getName();
      else if (Node.isVariableDeclaration(node)) {
        const kind = node.getInitializer()?.getKindName() ?? "";
        if (/^(Arrow|Function)/.test(kind)) {
          name = node.getName();
          // The whole statement, so the text is a declaration on its own.
          target = node.getVariableStatement() ?? node;
        }
      }
      if (!name) return;
      const text = target.getText();
      if (dedupe && seen.has(text)) return;
      seen.add(text);
      defs.push({
        pkg: rel.split("/")[0],
        sourceFile: rel,
        name,
        kind: node.getKindName(),
        lineStart: target.getStartLineNumber(),
        lineEnd: target.getEndLineNumber(),
        text,
      });
    });
  }
  return defs;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The spec shave would persist for a definition (offline intent), or a reason it has none. */
function specFor(def, variant) {
  const envelope = {
    sourceHash: sha256(def.text),
    modelVersion: "static",
    promptVersion: "static",
    extractedAt: "1970-01-01T00:00:00.000Z",
  };
  const card = validateIntentCard(staticExtract(def.text, envelope));
  const spec = specFromIntent(card, contracts.canonicalAstHash(def.text));
  return {
    card,
    spec: variant === "with-behavior" ? { ...spec, behavior: card.behavior } : spec,
  };
}

function blockRow(spec, implSource) {
  // A placeholder L0 manifest: retrieval reads the spec and the implementation only.
  const manifest = { artifacts: [{ kind: "property_tests", path: "property_tests.ts" }] };
  const artifacts = new Map([["property_tests.ts", new TextEncoder().encode("// none")]]);
  return {
    blockMerkleRoot: contracts.blockMerkleRoot({ spec, implSource, manifest, artifacts }),
    specHash: contracts.specHash(spec),
    specCanonicalBytes: contracts.canonicalize(spec),
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: 0,
    canonicalAstHash: contracts.canonicalAstHash(implSource),
    artifacts,
  };
}

/** The pkg and name an atom reference (pkg:file#name) needs a candidate to have. */
export function atomKey(atom) {
  const [pkg, rest] = atom.split(":");
  return `${pkg}#${rest.split("#")[1]}`;
}

/**
 * Whether a retrieved definition covers a needed atom: the same package and name, or a
 * definition whose span contains the atom's span in the same file (a class covers its
 * methods). `span` is the atom's fixture citation.
 */
export function covers(candidate, atom, span) {
  const [pkg, rest] = atom.split(":");
  const name = rest.split("#")[1];
  if (candidate.pkg !== pkg) return false;
  if (candidate.name === name) return true;
  return (
    span !== undefined &&
    candidate.sourceFile === span.sourceFile &&
    candidate.lineStart <= span.lineStart &&
    candidate.lineEnd >= span.lineEnd
  );
}

/** The fixture citation of a needed atom, from the task's hand-curated slice refs. */
function atomSpan(task, atom) {
  const [pkg, rest] = atom.split(":");
  const [file, name] = rest.split("#");
  return task.slice.find((c) => c.ref?.file === `${pkg}/${file}` && c.ref?.name === name)?.citation;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const variant = arg("variant", "production");
  if (!["production", "with-behavior"].includes(variant)) throw new Error(`variant ${variant}`);
  const K = Number(arg("k", "8"));
  const DEEP = Number(arg("deep", "50"));

  const defs = corpusDefinitions();
  const provider = contracts.createLocalEmbeddingProvider();
  const registry = await openRegistry(":memory:", { embeddings: provider });
  const byRoot = new Map();
  const skipped = {};
  let fragments = 0;
  for (const def of defs) {
    let built;
    try {
      built = specFor(def, variant);
    } catch (err) {
      const reason = String(err?.message ?? err)
        .split("\n")[0]
        .slice(0, 80);
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    if (built.card.behavior.startsWith("source fragment")) fragments++;
    const row = blockRow(built.spec, def.text);
    await registry.storeBlock(row);
    byRoot.set(row.blockMerkleRoot, { ...def, behavior: built.card.behavior });
  }

  const tasks = loadTasks(join(benchDir, "tasks"));
  const out = {
    variant,
    model: provider.modelId,
    k: K,
    deep: DEEP,
    pool: {
      definitions: defs.length,
      stored: byRoot.size,
      sourceFragmentBehaviors: fragments,
      skipped,
    },
    tasks: {},
  };
  const candidateOf = (c, rank) => {
    const d = byRoot.get(c.block.blockMerkleRoot);
    return {
      id: `${d.sourceFile}#${d.name}@${d.lineStart}`,
      rank,
      score: cosineDistanceToCombinedScore(c.cosineDistance),
      channel: c.retrievalChannel ?? "knn",
      sourcePkg: d.pkg,
      name: d.name,
      behavior: d.behavior,
      text: d.text,
      citation: {
        merkleRoot: c.block.blockMerkleRoot,
        sourceFile: d.sourceFile,
        lineStart: d.lineStart,
        lineEnd: d.lineEnd,
      },
    };
  };
  for (const task of tasks) {
    const query = { behavior: task.spec, inputs: [], outputs: [] };
    const top = await registry.findCandidatesByIntent(query, { k: K, lexical: true });
    const deep = await registry.findCandidatesByIntent(query, { k: DEEP, lexical: true });
    const slice = top.map((c, i) => candidateOf(c, i + 1));
    const sliceDefs = top.map((c) => byRoot.get(c.block.blockMerkleRoot));
    const deepDefs = deep.map((c) => byRoot.get(c.block.blockMerkleRoot));
    const needed = (task.atoms ?? []).map((atom) => {
      const span = atomSpan(task, atom);
      const inSlice = sliceDefs.findIndex((d) => covers(d, atom, span));
      const deepRank = deepDefs.findIndex((d) => covers(d, atom, span));
      return {
        atom,
        sliceRank: inSlice < 0 ? null : inSlice + 1,
        deepRank: deepRank < 0 ? null : deepRank + 1,
        coveredBy: inSlice < 0 ? null : slice[inSlice].id,
      };
    });
    out.tasks[task.id] = {
      slice,
      needed,
      recallAtK:
        needed.length === 0
          ? null
          : needed.filter((n) => n.sliceRank !== null).length / needed.length,
      bestScore: slice.length === 0 ? null : Math.max(...slice.map((c) => c.score)),
    };
  }
  await registry.close();

  const composed = Object.values(out.tasks).filter((t) => t.recallAtK !== null);
  out.summary = {
    meanRecallAtK: composed.reduce((n, t) => n + t.recallAtK, 0) / composed.length,
    tasksWithAllAtoms: composed.filter((t) => t.recallAtK === 1).length,
    tasksWithNoAtoms: composed.filter((t) => t.recallAtK === 0).length,
    compositionTasks: composed.length,
    neededAtoms: composed.reduce((n, t) => n + t.needed.length, 0),
    neededAtomsInSlice: composed.reduce(
      (n, t) => n + t.needed.filter((x) => x.sliceRank).length,
      0,
    ),
    neededAtomsInDeep: composed.reduce((n, t) => n + t.needed.filter((x) => x.deepRank).length, 0),
  };
  const file = join(benchDir, "retrieval", `${variant}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ pool: out.pool, summary: out.summary }, null, 2));
  console.log(`wrote ${relative(benchDir, file)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
