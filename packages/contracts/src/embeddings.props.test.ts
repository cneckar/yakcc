// SPDX-License-Identifier: MIT
// Vitest harness for embeddings.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling embeddings.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import * as fc from "fast-check";
import {
  prop_localEmbeddingProvider_deterministic,
  prop_localEmbeddingProvider_dimension_constant,
  prop_localEmbeddingProvider_normalized,
  prop_localEmbeddingProvider_distinct_inputs_distinct_outputs,
  prop_offlineEmbeddingProvider_deterministic,
  prop_offlineEmbeddingProvider_dimension_constant,
  prop_offlineEmbeddingProvider_normalized,
  prop_generateEmbedding_default_provider_offline,
  prop_generateEmbedding_explicit_provider_delegates,
} from "./embeddings.props.js";

// numRuns: 100 (fast-check default, explicitly documented per eval contract).
const opts = { numRuns: 100 };
// Async offline properties: 20 runs — each run awaits two embed() calls which
// hash 384 BLAKE3 blocks each; 100 runs would add ~2s per test.
const asyncOpts = { numRuns: 20 };
// Network-guarded tests: 5 runs — ONNX model load is expensive (~500ms).
const networkOpts = { numRuns: 5 };
// 2-minute timeout for any test that may touch the ONNX model.
const MODEL_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// A1.8: createLocalEmbeddingProvider — static metadata (network-free)
// ---------------------------------------------------------------------------

it("property: prop_localEmbeddingProvider_deterministic", () => {
  fc.assert(prop_localEmbeddingProvider_deterministic, opts);
});

it("property: prop_localEmbeddingProvider_dimension_constant", () => {
  fc.assert(prop_localEmbeddingProvider_dimension_constant, opts);
});

it(
  "property: prop_localEmbeddingProvider_normalized",
  async () => {
    await fc.assert(prop_localEmbeddingProvider_normalized, networkOpts);
  },
  MODEL_TIMEOUT,
);

it(
  "property: prop_localEmbeddingProvider_distinct_inputs_distinct_outputs",
  async () => {
    await fc.assert(prop_localEmbeddingProvider_distinct_inputs_distinct_outputs, networkOpts);
  },
  MODEL_TIMEOUT,
);

// ---------------------------------------------------------------------------
// A1.9: createOfflineEmbeddingProvider — fully offline
// ---------------------------------------------------------------------------

it(
  "property: prop_offlineEmbeddingProvider_deterministic",
  async () => {
    await fc.assert(prop_offlineEmbeddingProvider_deterministic, asyncOpts);
  },
);

it(
  "property: prop_offlineEmbeddingProvider_dimension_constant",
  async () => {
    await fc.assert(prop_offlineEmbeddingProvider_dimension_constant, asyncOpts);
  },
);

it(
  "property: prop_offlineEmbeddingProvider_normalized",
  async () => {
    await fc.assert(prop_offlineEmbeddingProvider_normalized, asyncOpts);
  },
);

// ---------------------------------------------------------------------------
// A1.10: generateEmbedding — composition
// ---------------------------------------------------------------------------

it(
  "property: prop_generateEmbedding_default_provider_offline",
  async () => {
    await fc.assert(prop_generateEmbedding_default_provider_offline, asyncOpts);
  },
);

it(
  "property: prop_generateEmbedding_explicit_provider_delegates",
  async () => {
    await fc.assert(prop_generateEmbedding_explicit_provider_delegates, asyncOpts);
  },
);
