/**
 * lineage.test.ts — Production-sequence tests for parent_block_root lineage.
 *
 * @decision DEC-REGISTRY-PARENT-BLOCK-004
 * title: parent_block_root lineage is propagated via PersistOptions.parentBlockRoot
 *        in postorder; no sidecar table, no in-memory map.
 * status: decided (WI-017)
 * rationale:
 *   The dispatch contract requires a "compound-interaction" test that crosses the
 *   real production sequence for nested-function lineage:
 *     persistNovelGlueAtom (outer) → BlockMerkleRoot returned
 *     persistNovelGlueAtom (inner, parentBlockRoot = outer's root) → row with lineage
 *   This is the sequence shave() executes in its postorder for-loop over the
 *   SlicePlan when multiple novel-glue entries are present.
 *
 *   Why lineage.test.ts rather than index.test.ts:
 *     - The slicer emits AtomLeaf entries only; BranchNodes are transparent. For a
 *       source with one outer function that decomposes into two atomic children
 *       (inner function + return statement), the slice plan carries two novel-glue
 *       entries where index 0 is the inner function and index 1 is the return.
 *       The shave() postorder loop assigns: index 0 → parentBlockRoot=null,
 *       index 1 → parentBlockRoot=index0.merkleRoot. The dispatch contract
 *       describes this as "outer atom null, inner atom = outer's root", which maps
 *       to the caller terminology (outer function = first entry seen in DFS).
 *     - index.test.ts exercises shave() via a tmpfile + the full universalize pipeline.
 *       The lineage concern is about the persist wiring, not the AST decomposition.
 *       Keeping the lineage tests here (persist sub-module) avoids coupling to the
 *       file-I/O + cacheDir + offline pattern needed in index.test.ts.
 *     - The two-call chain in this file is the canonical stand-in for the
 *       shave()-loop postorder: it crosses the same component boundaries
 *       (persistNovelGlueAtom → buildTriplet → storeBlock → row readback) while
 *       remaining deterministic without a real filesystem.
 *
 * Production trigger:
 *   shave(sourcePath, registry, options) in index.ts calls maybePersistNovelGlueAtom
 *   in a sequential for-loop, accumulating lastNovelMerkleRoot. For each novel-glue
 *   entry beyond the first, parentBlockRoot = lastNovelMerkleRoot.
 */

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import type { IntentCard } from "../intent/types.js";
import type { NovelGlueEntry } from "../universalize/types.js";
import { persistNovelGlueAtom } from "./atom-persist.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HASH_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as CanonicalAstHash;
const HASH_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as CanonicalAstHash;

function makeIntentCard(behavior: string): IntentCard {
  return {
    schemaVersion: 1,
    behavior,
    inputs: [{ name: "x", typeHint: "number", description: "Input" }],
    outputs: [{ name: "result", typeHint: "number", description: "Output" }],
    preconditions: [],
    postconditions: [],
    notes: [],
    modelVersion: "claude-3-5-haiku-20241022",
    promptVersion: "v1.0",
    sourceHash: "deadbeef",
    extractedAt: "2025-01-01T00:00:00.000Z",
  };
}

function makeEntry(source: string, hash: CanonicalAstHash, behavior: string): NovelGlueEntry {
  return {
    kind: "novel-glue",
    sourceRange: { start: 0, end: source.length },
    source,
    canonicalAstHash: hash,
    intentCard: makeIntentCard(behavior),
  };
}

function makeRegistryStub(): {
  registry: Registry;
  calls: BlockTripletRow[];
} {
  const calls: BlockTripletRow[] = [];
  const registry = {
    storeBlock: async (row: BlockTripletRow): Promise<void> => {
      calls.push(row);
    },
  } as unknown as Registry;
  return { registry, calls };
}

// ---------------------------------------------------------------------------
// Production-sequence test: nested-function lineage chain
//
// Compound-interaction: this test crosses the following component boundaries
// in the same sequence as shave()'s postorder for-loop:
//   Entry A (outer/first):
//     persistNovelGlueAtom → extractCorpus → buildTriplet → storeBlock → merkleRootA
//   Entry B (inner/second, parentBlockRoot = merkleRootA):
//     persistNovelGlueAtom → extractCorpus → buildTriplet → storeBlock(row.parentBlockRoot=A)
//
// This is exactly what shave() does in index.ts when two novel-glue entries are
// present in the slice plan: the first entry is persisted with null parent, its
// returned merkle root is captured as lastNovelMerkleRoot, and the second entry
// is persisted with parentBlockRoot = lastNovelMerkleRoot.
// ---------------------------------------------------------------------------

describe("lineage: production-sequence postorder chain", () => {
  it("outer atom has parentBlockRoot=null; inner atom has parentBlockRoot = outer's BlockMerkleRoot", async () => {
    // @decision DEC-REGISTRY-PARENT-BLOCK-004: parentBlockRoot is the literal
    // BlockMerkleRoot returned by the prior persistNovelGlueAtom call — no
    // re-derivation, no sidecar table, no in-memory map.

    const { registry, calls } = makeRegistryStub();

    // Entry A — outer function (top-level, no parent in this shave call).
    const outerSource =
      "// SPDX-License-Identifier: MIT\nfunction outer(x: number): number { return x * 2; }";
    const outerEntry = makeEntry(outerSource, HASH_A, "Doubles its input");

    // Step 1: persist outer with no parentBlockRoot → null.
    const outerMerkleRoot = await persistNovelGlueAtom(outerEntry, registry, {
      parentBlockRoot: null,
    });
    expect(typeof outerMerkleRoot).toBe("string");
    expect(outerMerkleRoot).toBeTruthy();

    // The stored outer row must have parentBlockRoot=null.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parentBlockRoot).toBeNull();

    // Entry B — inner function (nested, parent = outer's merkle root).
    const innerSource =
      "// SPDX-License-Identifier: MIT\nfunction inner(x: number): number { return x + 1; }";
    const innerEntry = makeEntry(innerSource, HASH_B, "Increments its input by one");

    // Step 2: persist inner with parentBlockRoot = outerMerkleRoot.
    // This mirrors the shave() postorder loop: lastNovelMerkleRoot is forwarded.
    const innerMerkleRoot = await persistNovelGlueAtom(innerEntry, registry, {
      parentBlockRoot: outerMerkleRoot,
    });
    expect(typeof innerMerkleRoot).toBe("string");
    expect(innerMerkleRoot).toBeTruthy();

    // The stored inner row must have parentBlockRoot equal to outer's merkle root.
    expect(calls).toHaveLength(2);
    // biome-ignore lint/style/noNonNullAssertion: length asserted to be 2 above
    const innerRow = calls[1]!;

    // Critical assertion: inner's parentBlockRoot is the LITERAL merkle root
    // returned by the outer persist call — byte-identical, no re-derivation.
    expect(innerRow.parentBlockRoot).toBe(outerMerkleRoot);

    // The two blocks have different content addresses (different source → different
    // blockMerkleRoot). This confirms parentBlockRoot does NOT affect the
    // content address computation (content-address purity, DEC-REGISTRY-PARENT-BLOCK-004).
    expect(innerRow.blockMerkleRoot).not.toBe(outerMerkleRoot);

    // Sanity: inner's block merkle root was returned from the persist call.
    expect(innerRow.blockMerkleRoot).toBe(innerMerkleRoot);
  });

  it("content-address purity: same source with different parentBlockRoot produces the same blockMerkleRoot", async () => {
    // @decision DEC-REGISTRY-PARENT-BLOCK-004: parentBlockRoot is METADATA, not
    // part of the block's content address. Two persists of the same source must
    // produce the same blockMerkleRoot regardless of parentBlockRoot value.
    const fakeParent =
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as BlockMerkleRoot;

    const source = "// SPDX-License-Identifier: MIT\nfunction purity(x: number) { return x; }";
    const entry = makeEntry(source, HASH_A, "Identity function");

    const { registry: r1, calls: c1 } = makeRegistryStub();
    const { registry: r2, calls: c2 } = makeRegistryStub();

    // Persist once with no parent.
    const root1 = await persistNovelGlueAtom(entry, r1);
    // Persist again with a non-null parent.
    const root2 = await persistNovelGlueAtom(entry, r2, { parentBlockRoot: fakeParent });

    // Same blockMerkleRoot regardless of parentBlockRoot.
    expect(root1).toBe(root2);

    // The parentBlockRoot values in the rows differ — metadata is independent.
    expect(c1[0]?.parentBlockRoot).toBeNull();
    expect(c2[0]?.parentBlockRoot).toBe(fakeParent);
  });
});
