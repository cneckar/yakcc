// SPDX-License-Identifier: MIT
/**
 * @decision DEC-LICENSE-GATE-REMOVE-001
 * @title WI-682 regression: universalize() must not gate on SPDX headers
 * @status accepted
 * @rationale
 *   Before WI-682, universalize() (via shave/license/gate.ts) threw
 *   LicenseRefusedError when source lacked an SPDX header or carried a
 *   copyleft identifier. The gate was removed per operator DEC 2026-05-17:
 *   yakcc reimplements behavior, not source, so ingest-side license gating
 *   is misapplied defense-in-depth.
 *
 *   This test file is a regression net: if a future implementer re-introduces
 *   a license gate (any error thrown for missing/copyleft SPDX), these tests
 *   will catch it immediately.
 *
 * Production trigger: universalize() is called by the continuous universalizer
 *   loop for every candidate block emitted by the compiler, many of which come
 *   from third-party packages whose source may lack SPDX headers entirely.
 *
 * Real production sequence exercised:
 *   1. Caller invokes universalize(candidate, registry, options).
 *   2. extractIntent runs (static strategy — offline-safe, no API key needed).
 *   3. decompose() parses the TypeScript source into a RecursionTree.
 *   4. slice() walks the tree and emits a SlicePlan.
 *   5. The result is returned without any license-gate check.
 *
 * Mocking strategy: emptyRegistry stub (no SQLite). Static intent strategy
 *   is used — no API key, no cache seeding required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { universalize } from "../index.js";
import type { ShaveRegistryView } from "../types.js";

// ---------------------------------------------------------------------------
// Registry stub — all nodes become NovelGlueEntry (no registry matches).
// ---------------------------------------------------------------------------

const emptyRegistry: ShaveRegistryView = {
  selectBlocks: async () => [],
  getBlock: async () => undefined,
  findByCanonicalAstHash: async () => [],
};

// ---------------------------------------------------------------------------
// API key isolation — static strategy never calls Anthropic, but enforce
// the discipline so accidental LLM-path fall-through fails loudly.
// ---------------------------------------------------------------------------

beforeEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Sources under test — deliberately lack SPDX headers.
// ---------------------------------------------------------------------------

/**
 * Atomic source with NO SPDX header at all.
 *
 * Expression-body arrow function: one variable statement, no control-flow
 * boundaries → decompose() classifies as an atom (leafCount === 1, maxDepth === 0).
 * The critical property: the first line is NOT "// SPDX-License-Identifier: ..."
 */
const SOURCE_NO_SPDX = `const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), hi);`;

/**
 * Source with a GPL-2.0-only SPDX header — the kind that the old gate
 * explicitly refused with LicenseRefusedError (copyleft policy).
 */
const SOURCE_GPL_SPDX = `// SPDX-License-Identifier: GPL-2.0-only
const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), hi);`;

/**
 * Source with an AGPL-3.0-or-later SPDX header — strongest copyleft,
 * refused by the old gate.
 */
const SOURCE_AGPL_SPDX = `// SPDX-License-Identifier: AGPL-3.0-or-later
const add = (a: number, b: number): number => a + b;`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WI-682 regression: no ingest-side license gate", () => {
  it("accepts source with no SPDX header and returns a valid result", async () => {
    // The old LicenseRefusedError would have been thrown here for missing SPDX.
    const result = await universalize({ source: SOURCE_NO_SPDX }, emptyRegistry, {
      intentStrategy: "static",
    });

    // Did not throw — gate is gone.
    expect(result).toBeDefined();

    // Pipeline completed: intentCard and slicePlan are populated.
    expect(result.intentCard).toBeDefined();
    expect(result.slicePlan.length).toBeGreaterThan(0);

    // The single atomic source produces exactly one novel-glue entry.
    expect(result.slicePlan[0].kind).toBe("novel-glue");

    // Diagnostics confirm no license-gate stub remains active.
    expect(result.diagnostics.stubbed).not.toContain("license-gate");
  });

  it("accepts source with GPL-2.0-only SPDX header without throwing", async () => {
    // The old gate refused GPL with LicenseRefusedError.
    const result = await universalize({ source: SOURCE_GPL_SPDX }, emptyRegistry, {
      intentStrategy: "static",
    });

    expect(result).toBeDefined();
    expect(result.intentCard).toBeDefined();
    expect(result.slicePlan.length).toBeGreaterThan(0);
  });

  it("accepts source with AGPL-3.0-or-later SPDX header without throwing", async () => {
    // The old gate refused AGPL with LicenseRefusedError (strongest copyleft).
    const result = await universalize({ source: SOURCE_AGPL_SPDX }, emptyRegistry, {
      intentStrategy: "static",
    });

    expect(result).toBeDefined();
    expect(result.intentCard).toBeDefined();
    expect(result.slicePlan.length).toBeGreaterThan(0);
  });

  it("compound interaction: full production sequence executes without license check", async () => {
    /**
     * This test exercises the real production sequence end-to-end crossing
     * all internal component boundaries, per Compound-Interaction Test
     * Requirement (implementer.md):
     *
     *   universalize() → extractIntent (static) → decompose() → slice()
     *
     * The source has no SPDX header. Before WI-682, the license gate ran as
     * step 0 (before extractIntent) and would throw LicenseRefusedError here.
     * After WI-682, the gate is gone — all steps run to completion.
     *
     * Verified properties:
     *   - Result is defined (no throw at step 0 / license gate position).
     *   - intentCard is populated (extractIntent ran — step 1).
     *   - slicePlan is non-empty (decompose + slice ran — steps 2+3).
     *   - matchedPrimitives is empty (emptyRegistry — step 3 slicer ran correctly).
     *   - diagnostics.stubbed is empty (no stubbed steps remain).
     */
    const result = await universalize({ source: SOURCE_NO_SPDX }, emptyRegistry, {
      intentStrategy: "static",
    });

    // Step 0 (old gate position): did not throw.
    expect(result).toBeDefined();

    // Step 1: extractIntent completed — intentCard is populated.
    expect(result.intentCard).toBeDefined();
    expect(typeof result.intentCard.behavior).toBe("string");

    // Steps 2+3: decompose + slice completed — slicePlan is non-empty.
    expect(result.slicePlan.length).toBeGreaterThan(0);

    // Step 3 slicer: emptyRegistry → no matches → matchedPrimitives empty.
    expect(result.matchedPrimitives).toEqual([]);

    // No gate stubs remain in the pipeline.
    expect(result.diagnostics.stubbed).toHaveLength(0);
  });
});
