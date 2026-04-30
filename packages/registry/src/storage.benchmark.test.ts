/**
 * storage.benchmark.test.ts — 1000-block corpus latency benchmark.
 *
 * Acceptance criterion (WI-T03): p99 latency of selectBlocks(specHash) over
 * 100 query spec hashes must be < 100 ms on a laptop, measured against a
 * 1000-block corpus stored in a temp-file SQLite database.
 *
 * @decision DEC-BENCH-001: Uses a temp file rather than :memory: because
 * sqlite-vec's vec0 virtual table requires disk-backed storage for reliable
 * operation with large corpora. The file is cleaned up in afterAll.
 * Status: decided (WI-003, reaffirmed WI-T03)
 *
 * @decision DEC-BENCH-002: The embedding provider uses a fast deterministic
 * hash function instead of a transformer model. The benchmark measures
 * SQLite + structural filter overhead — not model inference latency — which
 * is the quantity the 100ms budget governs. The real model is warmed up
 * separately in the integration suite. Status: decided (WI-003, reaffirmed WI-T03)
 *
 * @decision DEC-BENCH-003: Benchmark migrated from the v0 store(contract, impl)
 * API to the WI-T03 storeBlock(BlockTripletRow) + selectBlocks(specHash) API.
 * Corpus fixtures use SpecYak + blockMerkleRoot() for content-addressed identity.
 * The latency budget and regression bound are preserved from WI-003.
 * Status: decided (WI-T03)
 *
 * Production sequence exercised end-to-end:
 *   openRegistry → storeBlock(1000 blocks) → [warm-up] selectBlocks(specHash)
 *   → 100× timed selectBlocks(specHash) → p99 assertion
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fc from "fast-check";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { EmbeddingProvider, ProofManifest, SpecHash, SpecYak } from "@yakcc/contracts";
import { blockMerkleRoot, canonicalize, specHash as deriveSpecHash } from "@yakcc/contracts";
import { openRegistry } from "./storage.js";
import type { BlockTripletRow, Registry } from "./index.js";

// ---------------------------------------------------------------------------
// Fast deterministic embedding provider for the benchmark
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic 384-dim Float32Array for any input text.
 * Hash-based fill produces varied vectors across different specs so the
 * vector index exercises realistic kNN routing rather than trivial ties.
 *
 * This provider deliberately avoids any I/O or model load — the 100ms
 * budget governs SQLite/structural-filter overhead, not inference latency.
 */
function benchEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "bench/deterministic-hash",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      // Spread chars of text across dimensions with an offset to break symmetry.
      for (let i = 0; i < 384; i++) {
        const c = text.charCodeAt(i % text.length) / 128;
        vec[i] = c + Math.sin(i * 0.1 + c) * 0.3;
      }
      // Normalize to unit length.
      let norm = 0;
      for (const v of vec) norm += v * v;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vec.length; i++) {
        const val = vec[i];
        if (val !== undefined) vec[i] = val * scale;
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Corpus arbitraries (fast-check)
// ---------------------------------------------------------------------------

const typeArb = fc.constantFrom(
  "string", "number", "boolean", "string[]", "number[]",
  "Record<string,string>", "Uint8Array", "Buffer", "null", "undefined",
);

const purityArb = fc.constantFrom(
  "pure" as const, "io" as const, "stateful" as const, "nondeterministic" as const,
);

const threadArb = fc.constantFrom(
  "safe" as const, "sequential" as const, "unsafe" as const,
);

/**
 * Arbitrary that produces SpecYak-shaped objects (the WI-T03 spec type).
 * All required SpecYak fields are populated; v1-only optional fields are omitted.
 */
const specArb = fc.record({
  inputType: typeArb,
  outputType: typeArb,
  behavior: fc.string({ minLength: 8, maxLength: 60 }),
  errorType: fc.constantFrom("SyntaxError", "RangeError", "TypeError", "Error", ""),
  purity: purityArb,
  threadSafety: threadArb,
  time: fc.constantFrom("O(1)", "O(n)", "O(n log n)", "O(n^2)", "O(2^n)"),
  name: fc.string({ minLength: 4, maxLength: 24 }),
}).map(({ inputType, outputType, behavior, errorType, purity, threadSafety, time, name }) => {
  const spec: SpecYak = {
    name,
    inputs: [{ name: "input", type: inputType }],
    outputs: [{ name: "result", type: outputType }],
    preconditions: [],
    postconditions: ["result is defined"],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [{ id: "total", description: "Always terminates." }],
    errorConditions:
      errorType === ""
        ? []
        : [{ description: `Throws ${errorType} on bad input`, errorType }],
    nonFunctional: { purity, threadSafety, time, space: "O(1)" },
    propertyTests: [],
  };
  return spec;
});

/**
 * Generate a fixed-size corpus of unique SpecYak values using fast-check's
 * `sample` with a fixed seed so the corpus is reproducible across runs.
 */
function generateCorpus(size: number): SpecYak[] {
  // seed=42, path=[] gives a stable arbitrary stream.
  const samples = fc.sample(specArb, { numRuns: size * 2, seed: 42 });
  // Deduplicate by specHash to avoid collisions (idempotent store is fine
  // but fewer distinct specs reduces the effective corpus size).
  const seen = new Set<string>();
  const unique: SpecYak[] = [];
  for (const s of samples) {
    const sh = deriveSpecHash(s);
    if (!seen.has(sh)) {
      seen.add(sh);
      unique.push(s);
    }
    if (unique.length >= size) break;
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Fixture builder — SpecYak → BlockTripletRow
// ---------------------------------------------------------------------------

/**
 * Minimal L0 proof manifest with a single property_tests artifact.
 * All blocks in the corpus share this manifest shape; artifact bytes are
 * unique per block (derived from the impl source) so block_merkle_roots differ.
 */
function makeManifest(): ProofManifest {
  return {
    artifacts: [{ kind: "property_tests", path: "property_tests.ts" }],
  };
}

/**
 * Build a complete BlockTripletRow from a SpecYak.
 *
 * Uses blockMerkleRoot() from @yakcc/contracts to derive the content address,
 * matching exactly the production path used by the seeds package.
 */
function makeBlockRow(spec: SpecYak, idx: number): BlockTripletRow {
  // Each block gets a unique impl so block_merkle_roots are distinct per spec.
  const implSource = `export function impl(input: unknown): unknown { return null; /* bench-${idx} */ }`;
  const manifest = makeManifest();
  const artifactContent = `// property tests for bench block ${idx}`;
  const artifactBytes = new TextEncoder().encode(artifactContent);
  const artifacts = new Map<string, Uint8Array>([["property_tests.ts", artifactBytes]]);

  const root = blockMerkleRoot({ spec, implSource, manifest, artifacts });
  const sh = deriveSpecHash(spec);
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);

  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;
let dbPath: string;
let corpus: SpecYak[];
let querySpecHashes: SpecHash[];

beforeAll(async () => {
  // Use a temp file; sqlite-vec's vec0 is most reliable on disk.
  dbPath = path.join(os.tmpdir(), `yakcc-bench-${Date.now()}.db`);
  registry = await openRegistry(dbPath, { embeddings: benchEmbeddingProvider() });

  // Generate corpus and query specs.
  corpus = generateCorpus(1000);
  // 100 query specs drawn from a different seed to ensure realistic overlap.
  const querySpecs = fc.sample(specArb, { numRuns: 200, seed: 99 }).slice(0, 100);
  querySpecHashes = querySpecs.map((s) => deriveSpecHash(s));

  // Store all 1000 blocks. storeBlock is serial because better-sqlite3 is sync
  // under the hood — Promises resolve immediately after the JS microtask queue.
  for (let i = 0; i < corpus.length; i++) {
    const spec = corpus[i];
    if (spec === undefined) continue;
    const row = makeBlockRow(spec, i);
    await registry.storeBlock(row);
  }

  // Warm-up: one selectBlocks to prime the SQLite index and any module caches.
  const firstHash = querySpecHashes[0];
  if (firstHash !== undefined) {
    await registry.selectBlocks(firstHash);
  }
}, 120_000 /* 2-min budget for 1000 stores */);

afterAll(async () => {
  await registry.close();
  // Clean up the temp file.
  try {
    fs.unlinkSync(dbPath);
    // sqlite-vec may create a -shm and -wal file.
    for (const suffix of ["-shm", "-wal"]) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch {
    // Best-effort cleanup; ignore errors.
  }
});

// ---------------------------------------------------------------------------
// Benchmark test
// ---------------------------------------------------------------------------

describe("benchmark: 1000-block corpus — selectBlocks p99 < 100ms", () => {
  it(
    "p99 latency of selectBlocks(specHash) over 100 queries is under 100ms",
    async () => {
      expect(querySpecHashes.length).toBe(100);
      expect(corpus.length).toBe(1000);

      const latencies: number[] = [];

      for (const sh of querySpecHashes) {
        const start = performance.now();
        await registry.selectBlocks(sh);
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
      }

      latencies.sort((a, b) => a - b);

      // p99: index at 98 (0-indexed) out of 100 samples.
      const p99Index = Math.ceil(latencies.length * 0.99) - 1;
      const p99 = latencies[p99Index] ?? latencies[latencies.length - 1] ?? Infinity;
      const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? Infinity;
      const max = latencies[latencies.length - 1] ?? Infinity;

      console.log(`selectBlocks latency — p50=${p50.toFixed(2)}ms  p99=${p99.toFixed(2)}ms  max=${max.toFixed(2)}ms`);

      expect(p99).toBeLessThan(100);
    },
    30_000, // 30-second per-test budget.
  );
});
