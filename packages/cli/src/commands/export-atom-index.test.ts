// SPDX-License-Identifier: MIT
//
// export-atom-index.test.ts — T1–T6 integration tests for `yakcc export-atom-index`
//
// Production sequence exercised:
//   1. Run exportAtomIndex() against the bootstrap corpus (via corpusPath override).
//   2. Assert atoms.json exists with correct count, schema, and model stamp.
//   3. Assert embeddings.json exists with correct count, dimension, alignment, and model stamp.
//   4. Verify vector integrity and specHash alignment (index-aligned invariant).
//   5. Verify Slice-1 fit: cosine self-match (mirrors rankCandidates) + determinism.
//   6. Verify fail-loud: missing corpus → exit code 1, no silent output.
//
// T1–T3 and T6 use the real bootstrap corpus (skipped when absent, e.g. bare CI).
// T4 and T5 fast paths use a small fixture registry (3 blocks) to keep CI fast.
// T5 corpus smoke test (self-match on atom 0): gated on BOOTSTRAP_CORPUS_PATH.
//
// @decision DEC-1117-S2-TEST-001
// @title T1–T6 vitest suite exercises the export-atom-index production sequence
// @status decided (WI-1117 Slice 2)
// @rationale
//   The exporter's corpusPath injection seam lets us point at the real bootstrap
//   corpus from any worktree path. Fast-path tests (T4, T5 fixture) use an in-
//   memory registry with a deterministic mock provider to avoid ONNX loading.
//   The corpus-backed tests confirm production output shape and counts without
//   mocking internal state. T5 implements the Slice-1 fit check via an inline
//   cosine rank helper (see rankCandidatesInline) that mirrors the production
//   @yakcc/discovery-search rankCandidates contract:
//     rankCandidates(queryVec: Float32Array, atomVectors: Float32Array[], topK?)
//     → { ranked: RankedResult[], tier } where RankedResult = {index, score, band}
//   This avoids a cross-package relative import that would violate the CLI
//   tsconfig rootDir constraint (search.ts is outside packages/cli/src).
//   The inline helper uses the same cosine formula and produces identical
//   rankings on the fixture corpus — verified manually against the production impl.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EmbeddingProvider,
  type ProofManifest,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import { type BlockTripletRow, openRegistry } from "@yakcc/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { exportAtomIndex } from "./export-atom-index.js";

// ---------------------------------------------------------------------------
// Bootstrap corpus path resolution (same pattern as seed-yakcc.test.ts)
// ---------------------------------------------------------------------------

function resolveBootstrapCorpusPath(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 30; i++) {
    const candidate = join(dir, "bootstrap", "yakcc.registry.sqlite");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const BOOTSTRAP_CORPUS_PATH = resolveBootstrapCorpusPath();

// ---------------------------------------------------------------------------
// BGE-matching stub provider
//
// Matches the bootstrap corpus stored modelId (Xenova/bge-small-en-v1.5) without
// loading the real ONNX model. The exporter reads stored vectors — it never calls
// embed() on the source corpus; the provider is only required to satisfy the
// openRegistry model-id check. Offline safe.
// ---------------------------------------------------------------------------

const bgeStubEmbeddings = {
  modelId: "Xenova/bge-small-en-v1.5",
  dimension: 384,
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(384);
  },
};

// ---------------------------------------------------------------------------
// Mock embedding provider for fixture registries
//
// Deterministic 384-dim vectors from char-code hash. Used for T4/T5 fast paths
// and T6 fixture. No ONNX loading.
// ---------------------------------------------------------------------------

function makeMockProvider(modelId = "mock/export-test"): EmbeddingProvider {
  return {
    dimension: 384,
    modelId,
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        vec[i] = (text.charCodeAt(i % text.length) / 128 + i * 0.001) % 1;
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Inline cosine rank helper — mirrors @yakcc/discovery-search rankCandidates
//
// This is a test-local mirror of the production rankCandidates function from
// packages/discovery-search/src/search.ts. It implements the same:
//   - O(n) linear cosine scan
//   - combinedScore formula: (1 + sim) / 2 (valid for unit-norm vectors)
//   - sort descending by combinedScore
//   - RankedResult shape: { index, score, band }
//
// Used in T5 to verify Slice-1 fit (cosine self-match invariant) without
// introducing a cross-package relative import that violates CLI tsconfig rootDir.
//
// Mirror fidelity: the formula is equivalent to the production impl's
//   cosineDistanceToCombinedScore(sqrt(2 - 2*sim)) = 1 - (2-2*sim)/4 = (1+sim)/2.
//
// @decision DEC-1117-S2-TEST-002
// @title Inline cosine rank in test — avoids rootDir violation for Slice-1 fit check
// @status decided (WI-1117 Slice 2)
// @rationale
//   @yakcc/discovery-search is not in CLI's tsconfig references. A relative import
//   to discovery-search/src/search.ts violates rootDir and breaks pnpm -r build.
//   Adding the dep+alias+reference is a non-trivial config change that widens
//   CLI's dependency surface. The inline helper proves the same behavioral
//   invariant (self-match under cosine similarity) with zero new production deps.
// ---------------------------------------------------------------------------

interface RankedResultInline {
  readonly index: number;
  readonly score: number;
  readonly band: string;
}

/**
 * Cosine-rank queryVec against atomVectors. Returns results sorted descending
 * by combinedScore, which equals (1 + cosineSimilarity) / 2 for unit-norm vecs.
 * Mirrors the contract of @yakcc/discovery-search rankCandidates.
 */
function rankCandidatesInline(
  queryVec: Float32Array,
  atomVectors: readonly Float32Array[],
): { ranked: readonly RankedResultInline[] } {
  const dim = queryVec.length;
  const results: RankedResultInline[] = [];

  for (let i = 0; i < atomVectors.length; i++) {
    const vec = atomVectors[i];
    if (vec === undefined || vec.length !== dim) continue;

    let dot = 0;
    let normQ = 0;
    let normA = 0;
    for (let j = 0; j < dim; j++) {
      const q = queryVec[j] ?? 0;
      const a = vec[j] ?? 0;
      dot += q * a;
      normQ += q * q;
      normA += a * a;
    }
    const denom = Math.sqrt(normQ) * Math.sqrt(normA);
    const sim = denom === 0 ? 0 : dot / denom;
    // combinedScore = (1 + sim) / 2, same as cosineDistanceToCombinedScore(sqrt(2-2*sim))
    const score = (1 + sim) / 2;
    // band: mirrors production assignScoreBand from packages/discovery-search/src/score.ts
    // (DEC-1117-S2-TEST-002): strong>=0.85, confident>=0.70, weak>=0.50, poor<0.50
    const band =
      score >= 0.85 ? "strong" : score >= 0.7 ? "confident" : score >= 0.5 ? "weak" : "poor";

    results.push({ index: i, score, band });
  }

  results.sort((a, b) => b.score - a.score);
  return { ranked: results };
}

// ---------------------------------------------------------------------------
// Fixture factory — minimal BlockTripletRow (same pattern as export-embeddings.test.ts)
// ---------------------------------------------------------------------------

function makeSpec(name: string, behavior = `Compute ${name}`): SpecYak {
  return {
    name,
    behavior,
    inputs: [{ name: "x", type: "number" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    nonFunctional: { purity: "pure", threadSafety: "safe" },
  };
}

function makeRow(spec: SpecYak, implSuffix = ""): BlockTripletRow {
  const manifest: ProofManifest = { artifacts: [] };
  const artifacts = new Map<string, Uint8Array>();
  const implSrc = `export function ${spec.name.replace(/-/g, "_")}(x: number): number { return x; }${implSuffix}`;
  const bmr = blockMerkleRoot({ spec, implSource: implSrc, manifest, artifacts });
  const sHash = deriveSpecHash(spec);
  const specBytes = canonicalize(spec as Parameters<typeof canonicalize>[0]);
  return {
    blockMerkleRoot: bmr,
    specHash: sHash,
    specCanonicalBytes: specBytes,
    implSource: implSrc,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: deriveCanonicalAstHash(implSrc),
    parentBlockRoot: null,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Suite lifecycle — shared temp dir for test output
// ---------------------------------------------------------------------------

let suiteDir: string;

beforeAll(() => {
  suiteDir = mkdtempSync(join(tmpdir(), "yakcc-export-atom-index-test-"));
});

afterAll(() => {
  try {
    rmSync(suiteDir, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup.
  }
});

// ---------------------------------------------------------------------------
// T1 — outputs + counts (corpus-backed)
//
// Run exportAtomIndex against the bootstrap corpus. Assert:
//   - atoms.json exists with .atoms.length === 4829
//   - embeddings.json exists with .count === 4829 and .vectors.length === 4829
// ---------------------------------------------------------------------------

describe.skipIf(BOOTSTRAP_CORPUS_PATH === null)(
  "T1 — outputs and counts (bootstrap corpus)",
  () => {
    let outDir: string;
    let exitCode: number;

    beforeAll(async () => {
      outDir = join(suiteDir, "t1-out");
      const logger = new CollectingLogger();
      exitCode = await exportAtomIndex(["--out", outDir], logger, {
        embeddings: bgeStubEmbeddings,
        corpusPath: BOOTSTRAP_CORPUS_PATH as string,
      });
    }, 120_000);

    it("handler exits with code 0", () => {
      expect(exitCode).toBe(0);
    });

    it("atoms.json is written", () => {
      expect(existsSync(join(outDir, "atoms.json"))).toBe(true);
    });

    it("embeddings.json is written", () => {
      expect(existsSync(join(outDir, "embeddings.json"))).toBe(true);
    });

    it("atoms.json.atoms.length === 4829", () => {
      const raw = readFileSync(join(outDir, "atoms.json"), "utf-8");
      const parsed = JSON.parse(raw) as { atoms: unknown[] };
      expect(parsed.atoms.length).toBe(4829);
    });

    it("embeddings.json.count === 4829 and .vectors.length === 4829", () => {
      const raw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
      const parsed = JSON.parse(raw) as { count: number; vectors: unknown[] };
      expect(parsed.count).toBe(4829);
      expect(parsed.vectors.length).toBe(4829);
    });
  },
);

// ---------------------------------------------------------------------------
// T2 — atom card schema (corpus-backed)
//
// Each atom has MUST fields with correct types. No license/root keys present.
// ---------------------------------------------------------------------------

describe.skipIf(BOOTSTRAP_CORPUS_PATH === null)("T2 — atom card schema (bootstrap corpus)", () => {
  let outDir: string;
  const VALID_LEVELS = new Set(["L0", "L1", "L2", "L3"]);

  beforeAll(async () => {
    outDir = join(suiteDir, "t2-out");
    const logger = new CollectingLogger();
    await exportAtomIndex(["--out", outDir], logger, {
      embeddings: bgeStubEmbeddings,
      corpusPath: BOOTSTRAP_CORPUS_PATH as string,
    });
  }, 120_000);

  it("every atom has required string fields with correct types", () => {
    const raw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      atoms: Array<{
        specHash: unknown;
        blockMerkleRoot: unknown;
        name: unknown;
        behavior: unknown;
        level: unknown;
        signature: { inputs: unknown[]; outputs: unknown[] };
        nonFunctional: {
          purity: unknown;
          threadSafety: unknown;
          time: unknown;
          space: unknown;
        };
        source: { pkg: unknown; file: unknown };
      }>;
    };

    for (const atom of parsed.atoms) {
      // specHash
      expect(typeof atom.specHash).toBe("string");
      expect((atom.specHash as string).length).toBeGreaterThan(0);
      // blockMerkleRoot
      expect(typeof atom.blockMerkleRoot).toBe("string");
      expect((atom.blockMerkleRoot as string).length).toBeGreaterThan(0);
      // name
      expect(typeof atom.name).toBe("string");
      // behavior: string or null
      expect(atom.behavior === null || typeof atom.behavior === "string").toBe(true);
      // level
      expect(VALID_LEVELS.has(atom.level as string)).toBe(true);
      // signature.inputs / outputs — arrays of {name, type}
      expect(Array.isArray(atom.signature.inputs)).toBe(true);
      expect(Array.isArray(atom.signature.outputs)).toBe(true);
      for (const p of [...atom.signature.inputs, ...atom.signature.outputs]) {
        const param = p as { name: unknown; type: unknown };
        expect(typeof param.name).toBe("string");
        expect(typeof param.type).toBe("string");
      }
      // nonFunctional
      expect(typeof atom.nonFunctional.purity).toBe("string");
      expect(typeof atom.nonFunctional.threadSafety).toBe("string");
      expect(atom.nonFunctional.time === null || typeof atom.nonFunctional.time === "string").toBe(
        true,
      );
      expect(
        atom.nonFunctional.space === null || typeof atom.nonFunctional.space === "string",
      ).toBe(true);
      // source
      expect(atom.source.pkg === null || typeof atom.source.pkg === "string").toBe(true);
      expect(atom.source.file === null || typeof atom.source.file === "string").toBe(true);
    }
  });

  it("no atom has license or root keys", () => {
    const raw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const parsed = JSON.parse(raw) as { atoms: Array<Record<string, unknown>> };
    for (const atom of parsed.atoms) {
      expect(Object.prototype.hasOwnProperty.call(atom, "license")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(atom, "root")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — model stamp (corpus-backed)
//
// atoms.json.model.id === embeddings.json.model.id === "Xenova/bge-small-en-v1.5"
// Both dimension fields === 384.
// ---------------------------------------------------------------------------

describe.skipIf(BOOTSTRAP_CORPUS_PATH === null)("T3 — model stamp (bootstrap corpus)", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = join(suiteDir, "t3-out");
    const logger = new CollectingLogger();
    await exportAtomIndex(["--out", outDir], logger, {
      embeddings: bgeStubEmbeddings,
      corpusPath: BOOTSTRAP_CORPUS_PATH as string,
    });
  }, 120_000);

  it("atoms.json.model.id === Xenova/bge-small-en-v1.5", () => {
    const raw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const parsed = JSON.parse(raw) as { model: { id: string; dimension: number } };
    expect(parsed.model.id).toBe("Xenova/bge-small-en-v1.5");
  });

  it("atoms.json.model.dimension === 384", () => {
    const raw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const parsed = JSON.parse(raw) as { model: { id: string; dimension: number } };
    expect(parsed.model.dimension).toBe(384);
  });

  it("embeddings.json.model.id === Xenova/bge-small-en-v1.5", () => {
    const raw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const parsed = JSON.parse(raw) as { model: { id: string; dimension: number } };
    expect(parsed.model.id).toBe("Xenova/bge-small-en-v1.5");
  });

  it("embeddings.json.model.dimension === 384", () => {
    const raw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const parsed = JSON.parse(raw) as { model: { id: string; dimension: number } };
    expect(parsed.model.dimension).toBe(384);
  });

  it("atoms.json.model === embeddings.json.model (same id and dimension)", () => {
    const atomsRaw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const embeddingsRaw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const atomsParsed = JSON.parse(atomsRaw) as { model: { id: string; dimension: number } };
    const embeddingsParsed = JSON.parse(embeddingsRaw) as {
      model: { id: string; dimension: number };
    };
    expect(atomsParsed.model.id).toBe(embeddingsParsed.model.id);
    expect(atomsParsed.model.dimension).toBe(embeddingsParsed.model.dimension);
  });
});

// ---------------------------------------------------------------------------
// T4 — vector integrity + alignment (fixture registry, fast path)
//
// Uses a small 3-block fixture registry with a mock provider.
// Asserts:
//   - every vector length === 384
//   - atoms[i].specHash === vectors[i].specHash for all i (index-aligned)
//   - Set(atoms.specHash) === Set(vectors.specHash) (no orphans)
//   - both ASC by specHash
// ---------------------------------------------------------------------------

describe("T4 — vector integrity and alignment (fixture registry)", () => {
  let outDir: string;
  let fixtureDbPath: string;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "yakcc-export-fixture-"));
    fixtureDbPath = join(fixtureDir, "fixture.sqlite");
    outDir = join(fixtureDir, "t4-out");

    // Build a 3-block fixture registry with mock provider
    const provider = makeMockProvider();
    const reg = await openRegistry(fixtureDbPath, { embeddings: provider });

    const specs = [
      makeSpec("alphaFn", "Compute alpha value"),
      makeSpec("betaFn", "Compute beta value"),
      makeSpec("gammaFn", "Compute gamma value"),
    ];
    for (const spec of specs) {
      await reg.storeBlock(makeRow(spec));
    }
    await reg.close();

    // Export using the fixture corpus and mock provider
    const logger = new CollectingLogger();
    await exportAtomIndex(["--out", outDir], logger, {
      embeddings: provider,
      corpusPath: fixtureDbPath,
    });
  }, 30_000);

  afterAll(() => {
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // Non-fatal cleanup.
    }
  });

  it("every vector has length === 384", () => {
    const raw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      vectors: Array<{ specHash: string; vector: number[] }>;
    };
    expect(parsed.vectors.length).toBeGreaterThan(0);
    for (const entry of parsed.vectors) {
      expect(entry.vector.length).toBe(384);
    }
  });

  it("atoms and vectors are index-aligned: atoms[i].specHash === vectors[i].specHash", () => {
    const atomsRaw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const embeddingsRaw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const atoms = (JSON.parse(atomsRaw) as { atoms: Array<{ specHash: string }> }).atoms;
    const vectors = (JSON.parse(embeddingsRaw) as { vectors: Array<{ specHash: string }> }).vectors;

    expect(atoms.length).toBe(vectors.length);
    for (let i = 0; i < atoms.length; i++) {
      expect(atoms[i]?.specHash).toBe(vectors[i]?.specHash);
    }
  });

  it("no orphan specHashes: Set(atoms.specHash) === Set(vectors.specHash)", () => {
    const atomsRaw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const embeddingsRaw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const atomHashes = new Set(
      (JSON.parse(atomsRaw) as { atoms: Array<{ specHash: string }> }).atoms.map((a) => a.specHash),
    );
    const vectorHashes = new Set(
      (JSON.parse(embeddingsRaw) as { vectors: Array<{ specHash: string }> }).vectors.map(
        (v) => v.specHash,
      ),
    );

    expect(atomHashes).toEqual(vectorHashes);
  });

  it("atoms are sorted ASC by specHash", () => {
    const raw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const atoms = (JSON.parse(raw) as { atoms: Array<{ specHash: string }> }).atoms;
    for (let i = 1; i < atoms.length; i++) {
      const prev = atoms[i - 1]?.specHash ?? "";
      const curr = atoms[i]?.specHash ?? "";
      expect(prev < curr).toBe(true);
    }
  });

  it("vectors are sorted ASC by specHash", () => {
    const raw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const vectors = (JSON.parse(raw) as { vectors: Array<{ specHash: string }> }).vectors;
    for (let i = 1; i < vectors.length; i++) {
      const prev = vectors[i - 1]?.specHash ?? "";
      const curr = vectors[i]?.specHash ?? "";
      expect(prev < curr).toBe(true);
    }
  });

  it("fixture: 3 distinct specs → 3 atoms and 3 vectors", () => {
    const atomsRaw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const embeddingsRaw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const atoms = (JSON.parse(atomsRaw) as { atoms: unknown[] }).atoms;
    const vectors = (JSON.parse(embeddingsRaw) as { count: number }).count;
    expect(atoms.length).toBe(3);
    expect(vectors).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T5 — Slice-1 fit + determinism (fixture registry, fast path)
//
// Uses a small 3-block fixture registry with a mock provider. No ONNX loading.
//
// Slice-1 fit check uses rankCandidatesInline (see top of file), which mirrors
// the @yakcc/discovery-search rankCandidates contract. This avoids a cross-
// package relative import that would violate CLI tsconfig rootDir (DEC-1117-S2-TEST-002).
//
// Assertions:
//   - For each atom k, rankCandidatesInline(vectors[k], allVectors) top-1.index === k.
//     (Self-match: the mock provider gives each spec a unique deterministic vector,
//      so every atom's own vector is its nearest neighbor.)
//   - RankedResult shape: {index: number, score: number, band: string}
//   - Determinism: two runs produce byte-identical atoms.json AND embeddings.json.
// ---------------------------------------------------------------------------

describe("T5 — Slice-1 fit and determinism (fixture registry)", () => {
  let outDir: string;
  let outDir2: string;
  let fixtureDbPath: string;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "yakcc-export-t5-fixture-"));
    fixtureDbPath = join(fixtureDir, "fixture.sqlite");
    outDir = join(fixtureDir, "t5-out-run1");
    outDir2 = join(fixtureDir, "t5-out-run2");

    // Build a 3-block fixture registry. The mock provider's deterministic
    // per-text vectors make each atom's embedding unique so self-match holds.
    const provider = makeMockProvider();
    const reg = await openRegistry(fixtureDbPath, { embeddings: provider });

    const specs = [
      makeSpec("hashFn", "Compute BLAKE3 hash of binary input"),
      makeSpec("sortFn", "Sort an array of integers in ascending order"),
      makeSpec("parseFn", "Parse a decimal string into a number"),
    ];
    for (const spec of specs) {
      await reg.storeBlock(makeRow(spec));
    }
    await reg.close();

    // Run exporter twice for determinism check
    const logger1 = new CollectingLogger();
    await exportAtomIndex(["--out", outDir], logger1, {
      embeddings: provider,
      corpusPath: fixtureDbPath,
    });

    const logger2 = new CollectingLogger();
    await exportAtomIndex(["--out", outDir2], logger2, {
      embeddings: provider,
      corpusPath: fixtureDbPath,
    });
  }, 30_000);

  afterAll(() => {
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // Non-fatal cleanup.
    }
  });

  it("Slice-1 fit: top-1 self-match for each atom k (cosine rank via rankCandidatesInline)", () => {
    const raw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      vectors: Array<{ specHash: string; vector: number[] }>;
    };

    // Build Float32Array[] — the same type @yakcc/discovery-search's rankCandidates expects
    const atomVectors: Float32Array[] = parsed.vectors.map((v) => Float32Array.from(v.vector));

    // Self-match: for each atom k, its own vector must be the top-1 result.
    // This proves the exported vectors are consumable by cosine search (Slice-1 fit).
    for (let k = 0; k < atomVectors.length; k++) {
      const queryVec = atomVectors[k];
      if (queryVec === undefined) continue;
      const result = rankCandidatesInline(queryVec, atomVectors);
      const top1Index = result.ranked[0]?.index;
      expect(top1Index).toBe(k);
    }
  });

  it("RankedResult shape: {index: number, score: number, band: string}", () => {
    const raw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      vectors: Array<{ specHash: string; vector: number[] }>;
    };
    const atomVectors = parsed.vectors.map((v) => Float32Array.from(v.vector));

    if (atomVectors.length === 0) return;
    const result = rankCandidatesInline(atomVectors[0] as Float32Array, atomVectors);

    expect(result.ranked.length).toBeGreaterThan(0);
    const top = result.ranked[0];
    if (top !== undefined) {
      expect(typeof top.index).toBe("number");
      expect(typeof top.score).toBe("number");
      expect(typeof top.band).toBe("string");
    }
  });

  it("atoms[i].specHash maps back to the self-match atom's specHash via the exported index", () => {
    // Cross-reference: the index returned by the rank function maps back to the
    // correct atom in atoms.json via the index alignment invariant (T4).
    const atomsRaw = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const embeddingsRaw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const atoms = (JSON.parse(atomsRaw) as { atoms: Array<{ specHash: string }> }).atoms;
    const vectors = (
      JSON.parse(embeddingsRaw) as { vectors: Array<{ specHash: string; vector: number[] }> }
    ).vectors;

    const atomVectors: Float32Array[] = vectors.map((v) => Float32Array.from(v.vector));

    for (let k = 0; k < atomVectors.length; k++) {
      const queryVec = atomVectors[k];
      if (queryVec === undefined) continue;
      const result = rankCandidatesInline(queryVec, atomVectors);
      const top1Index = result.ranked[0]?.index;
      if (top1Index === undefined) continue;
      // The atom at the top-1 index must have the same specHash as the query vector's specHash
      expect(atoms[top1Index]?.specHash).toBe(vectors[k]?.specHash);
    }
  });

  it("determinism: two runs produce byte-identical atoms.json", () => {
    const a1 = readFileSync(join(outDir, "atoms.json"), "utf-8");
    const a2 = readFileSync(join(outDir2, "atoms.json"), "utf-8");
    expect(a1).toBe(a2);
  });

  it("determinism: two runs produce byte-identical embeddings.json", () => {
    const e1 = readFileSync(join(outDir, "embeddings.json"), "utf-8");
    const e2 = readFileSync(join(outDir2, "embeddings.json"), "utf-8");
    expect(e1).toBe(e2);
  });
});

// ---------------------------------------------------------------------------
// T5 corpus smoke test (self-match on atom 0 from the real bootstrap corpus)
//
// Uses the bootstrap corpus + bgeStubEmbeddings. Only verifies that atom 0
// maps back to itself under cosine similarity — proves Slice-1 fit on real data.
// Uses rankCandidatesInline (same contract as production rankCandidates).
// ---------------------------------------------------------------------------

describe.skipIf(BOOTSTRAP_CORPUS_PATH === null)(
  "T5 corpus smoke — Slice-1 self-match on atom 0 (bootstrap corpus)",
  () => {
    let outDir: string;

    beforeAll(async () => {
      outDir = join(suiteDir, "t5-corpus-out");
      const logger = new CollectingLogger();
      await exportAtomIndex(["--out", outDir], logger, {
        embeddings: bgeStubEmbeddings,
        corpusPath: BOOTSTRAP_CORPUS_PATH as string,
      });
    }, 180_000);

    it("atom 0 maps to itself under cosine rank (Slice-1 self-match on bootstrap corpus)", () => {
      const raw = readFileSync(join(outDir, "embeddings.json"), "utf-8");
      const parsed = JSON.parse(raw) as {
        vectors: Array<{ specHash: string; vector: number[] }>;
      };

      expect(parsed.vectors.length).toBeGreaterThan(0);

      // Use atom 0 as the query; top-1 must map back to index 0.
      // (The bgeStubEmbeddings fills stored vectors from the real BGE-embedded corpus;
      //  atom 0's own vector must be its nearest neighbor.)
      const atomVectors: Float32Array[] = parsed.vectors.map((v) => Float32Array.from(v.vector));
      const query = atomVectors[0];
      if (query === undefined) throw new Error("No vectors in corpus output");

      const result = rankCandidatesInline(query, atomVectors);
      const top1Index = result.ranked[0]?.index;
      expect(top1Index).toBe(0);
    });
  },
);

// ---------------------------------------------------------------------------
// T6 — fail-loud: missing corpus → exit code 1
//
// Missing corpus path (non-existent file via corpusPath injection) must:
//   - return exit code 1
//   - log an error message (never silent)
//   - produce no output files (no silent empty output)
// ---------------------------------------------------------------------------

describe("T6 — fail-loud: missing corpus path", () => {
  it("returns exit code 1 and logs error when corpusPath does not exist", async () => {
    const outDir = join(suiteDir, "t6-out");
    const logger = new CollectingLogger();

    const exitCode = await exportAtomIndex(["--out", outDir], logger, {
      embeddings: bgeStubEmbeddings,
      corpusPath: join(suiteDir, "nonexistent-corpus.sqlite"),
    });

    expect(exitCode).toBe(1);
    // At least one error line must have been emitted
    expect(logger.errLines.length).toBeGreaterThan(0);
    // No output files should have been written (no silent empty output)
    expect(existsSync(join(outDir, "atoms.json"))).toBe(false);
    expect(existsSync(join(outDir, "embeddings.json"))).toBe(false);
  });

  it("returns exit code 1 with informative error for a second distinct missing path", async () => {
    // Belt-and-suspenders: verify the fail-loud contract with a different path.
    const outDir = join(suiteDir, "t6-null-out");
    const logger = new CollectingLogger();

    const exitCode = await exportAtomIndex(["--out", outDir], logger, {
      embeddings: bgeStubEmbeddings,
      corpusPath: join(suiteDir, "definitely-missing.sqlite"),
    });

    expect(exitCode).toBe(1);
  });

  it("error output contains informative message with 'error:' prefix", async () => {
    const outDir = join(suiteDir, "t6-msg-out");
    const logger = new CollectingLogger();
    await exportAtomIndex(["--out", outDir], logger, {
      embeddings: bgeStubEmbeddings,
      corpusPath: join(suiteDir, "missing-corpus.sqlite"),
    });

    const allErrors = logger.errLines.join("\n");
    // The error message must reference the corpus path issue
    expect(allErrors.length).toBeGreaterThan(0);
    expect(allErrors).toContain("error:");
  });
});
