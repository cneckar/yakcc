/**
 * WI-010-01 skeleton tests — updated in WI-010-03 to reflect live wiring.
 *
 * What remains here:
 *   1. shave() shape contract — still a stub returning empty atoms/intentCards.
 *   2. createIntentExtractionHook() shape — id and intercept present.
 *      NOTE: intercept() now delegates to the live universalize() which calls
 *      extractIntent(); invoking it without a cache hit or API key throws
 *      AnthropicApiKeyMissingError. The shape test only checks the object.
 *   3. universalize() live-wiring smoke test — calling without an API key or
 *      cache must throw AnthropicApiKeyMissingError, proving the sentinel path
 *      is gone and extractIntent is wired.
 *
 * All deeper universalize/extract tests live in index.test.ts and
 * src/intent/extract.test.ts where mock-client injection is available.
 *
 * Production trigger: shave() is called by the CLI's `yakcc shave <file>`.
 * createIntentExtractionHook() is called by the hook pipeline. universalize()
 * is called by the continuous universalizer loop (WI-012).
 */

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { createIntentExtractionHook, shave, universalize } from "./index.js";
import { AnthropicApiKeyMissingError } from "./index.js";
import type { ShaveRegistryView } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal noop registry
// ---------------------------------------------------------------------------

const noopRegistry: ShaveRegistryView = {
  selectBlocks(_specHash: SpecHash): Promise<readonly BlockMerkleRoot[]> {
    return Promise.resolve([]);
  },
  getBlock(_merkleRoot: BlockMerkleRoot) {
    return Promise.resolve(undefined);
  },
};

// ---------------------------------------------------------------------------
// shave() stub tests — unchanged from WI-010-01
// ---------------------------------------------------------------------------

describe("shave()", () => {
  it("returns stubbed ShaveResult with empty atoms and intentCards", async () => {
    const result = await shave("dummy.ts", noopRegistry);

    expect(result.sourcePath).toBe("dummy.ts");
    expect(result.atoms).toEqual([]);
    expect(result.intentCards).toEqual([]);
  });

  it("includes 'decomposition' in diagnostics.stubbed", async () => {
    const result = await shave("dummy.ts", noopRegistry);

    expect(result.diagnostics.stubbed).toContain("decomposition");
  });

  it("reports zero cache hits and misses (shave is still a stub)", async () => {
    const result = await shave("dummy.ts", noopRegistry);

    expect(result.diagnostics.cacheHits).toBe(0);
    expect(result.diagnostics.cacheMisses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// universalize() — live-wiring smoke test
// WI-010-03: universalize is now wired to extractIntent. Without an API key
// or pre-seeded cache, calling it must throw AnthropicApiKeyMissingError —
// proving the sentinel IntentCard path is removed.
// ---------------------------------------------------------------------------

describe("universalize() — live-wiring guard", () => {
  it("throws AnthropicApiKeyMissingError when called without API key (sentinel removed)", async () => {
    // Remove the API key so the error is deterministic
    const orig = process.env.ANTHROPIC_API_KEY;
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(universalize({ source: "const x = 1;" }, noopRegistry)).rejects.toThrow(
        AnthropicApiKeyMissingError,
      );
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// createIntentExtractionHook() — shape tests only
// Invocation tests live in index.test.ts with mock-client injection.
// ---------------------------------------------------------------------------

describe("createIntentExtractionHook()", () => {
  it("returns a hook with the default id", () => {
    const hook = createIntentExtractionHook();

    expect(hook.id).toBe("yakcc.shave.default");
  });

  it("hook has an intercept function", () => {
    const hook = createIntentExtractionHook();

    expect(typeof hook.intercept).toBe("function");
  });
});
