/**
 * assemble-candidate.test.ts — tests for the compile-time continuous-shave
 * entry point (WI-014-05, DEC-COMPILE-CANDIDATE-001).
 *
 * Production trigger: assembleCandidate() is called by the CLI (WI-015) when a
 * user passes raw source text they want to compile. It runs universalize() on
 * the source, resolves the resulting slice plan to a BlockMerkleRoot, then
 * delegates to assemble().
 *
 * Real production sequence (documented, partially tested):
 *   candidateSource
 *     → universalize() [license gate → extractIntent (cache) → decompose → slice]
 *     → PointerEntry(merkleRoot)
 *     → assemble(merkleRoot, registry)
 *     → Artifact { source, manifest }
 *
 * License-refusal test (Test 1): fully live — the license gate fires BEFORE
 * extractIntent, so no cache or API key is required.
 *
 * Tests 2–4 (PointerEntry end-to-end, multi-leaf, novel-glue): SKIPPED pending
 * a public cache-seeding API in @yakcc/shave. These tests need to write intent
 * cache entries offline but @yakcc/shave does not export writeIntent,
 * keyFromIntentInputs, or sourceHash from its public surface
 * (only "." is in the exports field — see packages/shave/package.json).
 * TODO(future-WI): once @yakcc/shave exports a public seedIntentCache() helper
 * (or exposes the cache internals under a sub-path export), re-enable these
 * tests as full compound-interaction coverage.
 */

import * as os from "node:os";
import { join } from "node:path";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { LicenseRefusedError } from "@yakcc/shave";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleCandidate, CandidateNotResolvableError } from "./assemble-candidate.js";

// ---------------------------------------------------------------------------
// Per-test isolation: cacheDir, registry, API key
// ---------------------------------------------------------------------------

let cacheDir: string;
let registry: Registry;

beforeEach(async () => {
  const unique = Math.random().toString(36).slice(2);
  cacheDir = join(os.tmpdir(), `ac-test-${unique}`);
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
  registry = await openRegistry(":memory:");
});

afterEach(async () => {
  await registry.close();
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Test 1: License-refused candidate → LicenseRefusedError propagates
// ---------------------------------------------------------------------------

describe("assembleCandidate — license-refused candidate", () => {
  it(
    "throws LicenseRefusedError for a GPL-licensed source before intent extraction",
    async () => {
      // The license gate in universalize() runs before extractIntent (cheap, fail-fast).
      // No cache seed is needed — the gate fires before any API or cache access.
      const gplSource = `// SPDX-License-Identifier: GPL-3.0-or-later
export function foo(x: number): number { return x + 1; }`;

      await expect(
        assembleCandidate(gplSource, registry, undefined, {
          shaveOptions: { cacheDir, offline: true },
        }),
      ).rejects.toBeInstanceOf(LicenseRefusedError);
    },
  );
});

// ---------------------------------------------------------------------------
// Test 2: PointerEntry-only single-entry slice → delegates to assemble()
// Compound-interaction: real universalize + real registry + real assemble()
// SKIPPED: requires public cache-seeding API from @yakcc/shave (see file header)
// ---------------------------------------------------------------------------

describe("assembleCandidate — PointerEntry → assemble end-to-end (compound)", () => {
  it.skip(
    // TODO(future-WI): re-enable when @yakcc/shave exports seedIntentCache() or
    // equivalent public helper for writing intent cache entries offline.
    // The test needs to call writeIntent + keyFromIntentInputs + sourceHash from
    // @yakcc/shave internals, which are not in the package exports field.
    "resolves PointerEntry to an Artifact via the full pipeline without API key",
    async () => {
      void cacheDir; // referenced by shaveOptions when re-enabled
    },
  );
});

// ---------------------------------------------------------------------------
// Test 3: Multi-leaf slice → CandidateNotResolvableError("multi-leaf")
// SKIPPED: requires public cache-seeding API from @yakcc/shave (see file header)
// ---------------------------------------------------------------------------

describe("assembleCandidate — multi-leaf slice", () => {
  it.skip(
    // TODO(future-WI): re-enable when @yakcc/shave exports seedIntentCache() or
    // equivalent public helper. The multi-leaf path runs extractIntent before
    // decompose, so a cache entry is required to avoid a live API call.
    "throws CandidateNotResolvableError with 'multi-leaf' in the message",
    async () => {
      void cacheDir;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 4: Single NovelGlueEntry → CandidateNotResolvableError("atom persistence")
// SKIPPED: requires public cache-seeding API from @yakcc/shave (see file header)
// ---------------------------------------------------------------------------

describe("assembleCandidate — single novel-glue entry", () => {
  it.skip(
    // TODO(future-WI): re-enable when @yakcc/shave exports seedIntentCache() or
    // equivalent public helper. The novel-glue path also runs extractIntent,
    // so a cache entry is required.
    "throws CandidateNotResolvableError with 'atom persistence in universalize' in message",
    async () => {
      void cacheDir;
    },
  );
});
