/**
 * WI-010-01 skeleton tests.
 *
 * These tests verify that the public API stubs:
 *   1. compile and are importable
 *   2. return the correct stubbed shapes (empty arrays for atoms/slicePlan/
 *      matchedPrimitives, diagnostics.stubbed includes "decomposition")
 *   3. createIntentExtractionHook produces a usable hook that runs to completion
 *
 * Production trigger: shave() is called by the CLI's `yakcc shave <file>`
 * command (WI-010-02 wires that entry point). universalize() is called by the
 * continuous universalizer loop that processes candidate blocks extracted by
 * the DFG slicer (WI-012). These tests exercise the same public call sequence
 * to prove the stubs satisfy the shape contract before the real implementations
 * land.
 *
 * Compound-interaction test: the final test exercises shave → universalize →
 * createIntentExtractionHook → intercept in the same sequence a CLI user
 * would trigger, crossing all three public entry points.
 */

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { createIntentExtractionHook, shave, universalize } from "./index.js";
import type { ShaveRegistryView } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal noop registry — satisfies ShaveRegistryView without any storage
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
// shave() stub tests
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

  it("reports zero cache hits and misses (no extractor yet)", async () => {
    const result = await shave("dummy.ts", noopRegistry);

    expect(result.diagnostics.cacheHits).toBe(0);
    expect(result.diagnostics.cacheMisses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// universalize() stub tests
// ---------------------------------------------------------------------------

describe("universalize()", () => {
  it("returns UniversalizeResult with empty slicePlan and matchedPrimitives", async () => {
    const result = await universalize({ source: "const x = 1;" }, noopRegistry);

    expect(result.slicePlan).toEqual([]);
    expect(result.matchedPrimitives).toEqual([]);
  });

  it("returns a sentinel intentCard with schemaVersion 1", async () => {
    const result = await universalize({ source: "x" }, noopRegistry);

    expect(result.intentCard.schemaVersion).toBe(1);
    expect(typeof result.intentCard.behavior).toBe("string");
    expect(result.intentCard.behavior.length).toBeGreaterThan(0);
  });

  it("sentinel sourceHash is 64 hex zeros", async () => {
    const result = await universalize({ source: "x" }, noopRegistry);

    expect(result.intentCard.sourceHash).toBe("0".repeat(64));
  });

  it("includes 'decomposition' in diagnostics.stubbed", async () => {
    const result = await universalize({ source: "x" }, noopRegistry);

    expect(result.diagnostics.stubbed).toContain("decomposition");
  });
});

// ---------------------------------------------------------------------------
// createIntentExtractionHook() stub tests
// ---------------------------------------------------------------------------

describe("createIntentExtractionHook()", () => {
  it("returns a hook with the default id", () => {
    const hook = createIntentExtractionHook();

    expect(hook.id).toBe("yakcc.shave.default");
  });

  it("hook.intercept runs to completion and returns UniversalizeResult shape", async () => {
    const hook = createIntentExtractionHook();
    const result = await hook.intercept({ source: "function foo() {}" }, noopRegistry);

    expect(result.slicePlan).toEqual([]);
    expect(result.matchedPrimitives).toEqual([]);
    expect(result.intentCard.schemaVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction test: shave → universalize → hook.intercept sequence
// ---------------------------------------------------------------------------

describe("compound: shave → universalize → hook pipeline", () => {
  it("produces consistent stubbed results across all three entry points", async () => {
    // Step 1: shave a file
    const shaveResult = await shave("/tmp/example.ts", noopRegistry);
    expect(shaveResult.atoms).toEqual([]);
    expect(shaveResult.diagnostics.stubbed).toContain("decomposition");

    // Step 2: universalize a candidate (as the continuous loop would)
    const uResult = await universalize(
      { source: "const x = 1;", hint: { name: "example" } },
      noopRegistry,
    );
    expect(uResult.slicePlan).toEqual([]);
    expect(uResult.matchedPrimitives).toEqual([]);

    // Step 3: run the same candidate through a hook (as the hook registry would)
    const hook = createIntentExtractionHook();
    const hookResult = await hook.intercept(
      { source: "const x = 1;", hint: { name: "example", origin: "user" } },
      noopRegistry,
    );
    expect(hookResult.intentCard.schemaVersion).toBe(1);
    expect(hookResult.slicePlan).toEqual([]);

    // All three paths agree on the stub diagnostic marker
    expect(shaveResult.diagnostics.stubbed).toContain("decomposition");
    expect(uResult.diagnostics.stubbed).toContain("decomposition");
    expect(hookResult.diagnostics.stubbed).toContain("decomposition");
  });
});
