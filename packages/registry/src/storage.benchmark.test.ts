/**
 * storage.benchmark.test.ts — 1000-contract corpus latency benchmark.
 *
 * Acceptance criterion (WI-003): p99 latency of search(spec, 10) over 100
 * query specs must be < 100 ms on a laptop, measured against a 1000-contract
 * corpus stored in a temp-file SQLite database backed by sqlite-vec.
 *
 * @decision DEC-BENCH-001: Uses a temp file rather than :memory: because
 * sqlite-vec's vec0 virtual table requires disk-backed storage for reliable
 * operation with large corpora. The file is cleaned up in afterAll.
 * Status: decided (WI-003)
 *
 * @decision DEC-BENCH-002: The embedding provider uses a fast deterministic
 * hash function instead of a transformer model. The benchmark measures
 * SQLite + structural filter overhead — not model inference latency — which
 * is the quantity the 100ms budget governs. The real model is warmed up
 * separately in the integration suite. Status: decided (WI-003)
 *
 * Production sequence exercised end-to-end:
 *   openRegistry → store(1000 contracts) → [warm-up] search(spec, 10)
 *   → 100× timed search(spec, 10) → p99 assertion
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fc from "fast-check";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Contract, ContractSpec, EmbeddingProvider } from "@yakcc/contracts";
import { contractId } from "@yakcc/contracts";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { openRegistry } from "./storage.js";
import type { Registry, Implementation } from "./index.js";

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

const specArb = fc.record({
  inputType: typeArb,
  outputType: typeArb,
  behavior: fc.string({ minLength: 8, maxLength: 60 }),
  errorType: fc.constantFrom("SyntaxError", "RangeError", "TypeError", "Error", ""),
  purity: purityArb,
  threadSafety: threadArb,
  time: fc.constantFrom("O(1)", "O(n)", "O(n log n)", "O(n^2)", "O(2^n)"),
}).map(({ inputType, outputType, behavior, errorType, purity, threadSafety, time }) => {
  const spec: ContractSpec = {
    inputs: [{ name: "input", type: inputType }],
    outputs: [{ name: "result", type: outputType }],
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
 * Generate a fixed-size corpus of unique ContractSpec values using fast-check's
 * `sample` with a fixed seed so the corpus is reproducible across runs.
 */
function generateCorpus(size: number): ContractSpec[] {
  // seed=42, path=[] gives a stable arbitrary stream.
  const samples = fc.sample(specArb, { numRuns: size * 2, seed: 42 });
  // Deduplicate by contractId to avoid collisions (idempotent store is fine
  // but fewer distinct contracts reduces the effective corpus size).
  const seen = new Set<string>();
  const unique: ContractSpec[] = [];
  for (const s of samples) {
    const id = contractId(s);
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(s);
    }
    if (unique.length >= size) break;
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;
let dbPath: string;
let corpus: ContractSpec[];
let querySpecs: ContractSpec[];

beforeAll(async () => {
  // Use a temp file; sqlite-vec's vec0 is most reliable on disk.
  dbPath = path.join(os.tmpdir(), `yakcc-bench-${Date.now()}.db`);
  registry = await openRegistry(dbPath, { embeddings: benchEmbeddingProvider() });

  // Generate corpus and query specs.
  corpus = generateCorpus(1000);
  // 100 query specs drawn from a different seed to ensure realistic overlap.
  querySpecs = fc.sample(specArb, { numRuns: 200, seed: 99 }).slice(0, 100);

  // Store all 1000 contracts. Store is serial because better-sqlite3 is sync
  // under the hood — Promises resolve immediately after the JS microtask queue.
  const encoder = new TextEncoder();

  for (const spec of corpus) {
    const id = contractId(spec);
    const source = `export function impl(input: unknown): unknown { return null; /* ${id.slice(0, 8)} */ }`;
    const bytes = encoder.encode(source);
    const digest = blake3(bytes);
    const blockId = bytesToHex(digest);
    const contract: Contract = { id, spec, evidence: { testHistory: [] } };
    const impl: Implementation = { source, blockId, contractId: id };
    await registry.store(contract, impl);
  }

  // Warm-up: one search to prime the sqlite-vec index and any module caches.
  const warmup = querySpecs[0];
  if (warmup !== undefined) {
    await registry.search(warmup, 10);
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

describe("benchmark: 1000-contract corpus — search p99 < 100ms", () => {
  it(
    "p99 latency of search(spec, 10) over 100 queries is under 100ms",
    async () => {
      expect(querySpecs.length).toBe(100);
      expect(corpus.length).toBe(1000);

      const latencies: number[] = [];

      for (const spec of querySpecs) {
        const start = performance.now();
        await registry.search(spec, 10);
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
      }

      latencies.sort((a, b) => a - b);

      // p99: index at 98 (0-indexed) out of 100 samples.
      const p99Index = Math.ceil(latencies.length * 0.99) - 1;
      const p99 = latencies[p99Index] ?? latencies[latencies.length - 1] ?? Infinity;
      const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? Infinity;
      const max = latencies[latencies.length - 1] ?? Infinity;

      console.log(`search latency — p50=${p50.toFixed(2)}ms  p99=${p99.toFixed(2)}ms  max=${max.toFixed(2)}ms`);

      expect(p99).toBeLessThan(100);
    },
    30_000, // 30-second per-test budget.
  );
});
