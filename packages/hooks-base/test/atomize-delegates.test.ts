// SPDX-License-Identifier: MIT
/**
 * atomize-delegates.test.ts — WI-424 regression: atomize.ts delegates persistence
 * to universalize({persist:true}) — single authority (Sacred Practice #12).
 *
 * @decision DEC-V2-ATOMIZE-DELEGATES-UNIVERSALIZE-001 (WI-424)
 * title: atomize.ts delegates atom persistence to universalize({persist:true})
 * status: accepted (WI-424)
 * rationale:
 *   WI-373 (PR #419) introduced universalize({persist:true}) as the canonical
 *   persistence primitive. WI-423 (PR #431) applied this pattern to shave().
 *   WI-424 (this work item) applies the same pattern to atomize.ts — removing
 *   the inline buildBlockRow + storeBlock loop and delegating to universalize.
 *
 *   This test suite guards against two regressions:
 *
 *   1. Double-persist (universalize + orphaned inline loop): storeBlock would be
 *      called 2N times instead of N times for N novel-glue entries. We count
 *      storeBlock invocations on a spy registry and assert exactly N calls.
 *
 *   2. Zero-persist (universalize not delegating persist): storeBlock would be
 *      called 0 times. Same assertion catches this.
 *
 *   Because atomize.ts imports universalize via a lazy dynamic import, a direct
 *   vi.spyOn on the module cannot intercept the internal call. We instead verify
 *   the delegation contract through its observable side-effect: storeBlock call
 *   count matches novel-glue entry count exactly (exactly once per novel atom).
 *
 * Production trigger:
 *   atomizeEmission() is called by the Claude Code hook layer on every intercepted
 *   Edit/Write/MultiEdit tool invocation that passes the shape filter. Each novel
 *   function written by the agent should produce exactly one storeBlock call.
 *   Double-persist would silently write duplicate rows (masked by INSERT OR IGNORE);
 *   zero-persist would make the flywheel inoperable.
 *
 * Mocking boundary:
 *   - storeBlock: counted via a spy wrapper around an in-memory openRegistry.
 *     We use a real Registry so SQLite receives correct rows — the count is
 *     measured at the atomizeEmission() call boundary, not mocked away.
 *   - Anthropic API: bypassed via intentStrategy:"static" (offline-safe).
 *   - shave import: real @yakcc/shave via workspace alias (no mocking).
 *
 * Air-gap compliance:
 *   intentStrategy:"static" — no network, no API key required.
 */

import type { EmbeddingProvider } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomizeEmission } from "../src/atomize.js";

// ---------------------------------------------------------------------------
// Mock embedding provider — deterministic, no ONNX required
// ---------------------------------------------------------------------------

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-provider-atomize-delegates",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        vec[i] = text.charCodeAt(i % text.length) / 128 + i * 0.001;
      }
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
// Fixtures — canonical "atomize-yes" shapes for the spy tests
// ---------------------------------------------------------------------------

/**
 * SINGLE_ATOM_SOURCE: one exported function with JSDoc and a non-trivial body.
 * MIT license → passes the license gate.
 * Expected: exactly one novel-glue entry → exactly one storeBlock call.
 */
const SINGLE_ATOM_SOURCE = `// SPDX-License-Identifier: MIT
/**
 * Compute the sum of all numbers in an array.
 *
 * @param nums - The numbers to sum.
 * @returns The total sum.
 */
export function sumArray(nums: number[]): number {
  let total = 0;
  for (const n of nums) {
    total += n;
  }
  return total;
}`;

// ---------------------------------------------------------------------------
// Spy registry wrapper — counts storeBlock invocations
// ---------------------------------------------------------------------------

/**
 * Wraps a Registry's storeBlock method with a call counter.
 * Returns the wrapped registry and a getter for the call count.
 *
 * Using a real registry (not a mock) ensures that:
 * - SQLite receives correct rows (no silent corruption).
 * - Idempotency (INSERT OR IGNORE) is exercised by the real storage layer.
 * - The count reflects actual delegation calls, not internal retries.
 */
function withStoreBlockSpy(reg: Registry): {
  spyRegistry: Registry;
  getStoreBlockCallCount: () => number;
} {
  let callCount = 0;
  const originalStoreBlock = reg.storeBlock.bind(reg);
  const spyRegistry: Registry = {
    ...reg,
    storeBlock: async (row: BlockTripletRow) => {
      callCount++;
      return originalStoreBlock(row);
    },
  };
  return { spyRegistry, getStoreBlockCallCount: () => callCount };
}

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let registry: Registry;

beforeEach(async () => {
  registry = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  await registry.close();
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// WI-424 regression: storeBlock call count = novel-glue entry count (exactly once)
//
// If atomize.ts retained the inline buildBlockRow + storeBlock loop alongside
// the universalize({persist:true}) delegation, storeBlock would be called 2x.
// If universalize({persist:true}) is not called with persist:true, it would be 0x.
// Exactly 1 call proves single delegation per novel-glue entry.
// ---------------------------------------------------------------------------

describe("WI-424 regression: atomize.ts delegates to universalize({persist:true}) exactly once", () => {
  it(
    "storeBlock called exactly once for single novel-glue atom — not zero (no persist), not twice (double-persist)",
    async () => {
      const { spyRegistry, getStoreBlockCallCount } = withStoreBlockSpy(registry);

      const result = await atomizeEmission({
        emittedCode: SINGLE_ATOM_SOURCE,
        toolName: "Edit",
        registry: spyRegistry,
      });

      // Atom must have been persisted
      expect(
        result.atomized,
        "SINGLE_ATOM_SOURCE must atomize successfully",
      ).toBe(true);
      expect(result.atomsCreated.length).toBeGreaterThan(0);

      // Verify the BMR is populated (merkleRoot came from universalize return value)
      const firstAtom = result.atomsCreated[0];
      expect(firstAtom).toBeDefined();
      if (firstAtom !== undefined) {
        expect(firstAtom.blockMerkleRoot).toMatch(/^[0-9a-f]+$/i);
      }

      // THE KEY ASSERTION: storeBlock must be called exactly once per novel-glue entry.
      // If the old buildBlockRow + storeBlock loop was retained alongside universalize({persist:true}),
      // this count would be 2. If persist:true was not passed to universalize, it would be 0.
      expect(
        getStoreBlockCallCount(),
        "storeBlock must be called exactly once — not zero (no persist) and not twice (double-persist from retained inline loop)",
      ).toBe(result.atomsCreated.length);
    },
    60_000,
  );

  it(
    "second call on identical code: storeBlock called 0 or 1 times (dedup idempotency)",
    async () => {
      // First call atomizes and stores.
      const { spyRegistry: spy1, getStoreBlockCallCount: count1 } = withStoreBlockSpy(registry);
      const first = await atomizeEmission({
        emittedCode: SINGLE_ATOM_SOURCE,
        toolName: "Edit",
        registry: spy1,
      });
      expect(first.atomized).toBe(true);
      expect(count1()).toBeGreaterThan(0);

      // Second call: the atom is already in the registry.
      // universalize({persist:true}) will find it as a PointerEntry (registry hit).
      // storeBlock may be called 0 times (PointerEntry → no persist) OR 1 time (INSERT OR IGNORE no-op).
      const { spyRegistry: spy2, getStoreBlockCallCount: count2 } = withStoreBlockSpy(registry);
      await atomizeEmission({
        emittedCode: SINGLE_ATOM_SOURCE,
        toolName: "Edit",
        registry: spy2,
      });

      // Must not call storeBlock more times than atoms created on first call.
      // Double-persist on second call would only happen if there is BOTH an inline loop
      // AND a universalize({persist:true}) call — which is the regression we guard against.
      expect(
        count2(),
        "Second call on identical code: storeBlock must not exceed first call count",
      ).toBeLessThanOrEqual(count1());
    },
    60_000,
  );
});