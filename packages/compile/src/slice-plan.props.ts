// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-003: hand-authored property-test corpus for
// @yakcc/compile slice-plan.ts atoms. Two-file pattern: this file (.props.ts)
// is vitest-free and holds the corpus; the sibling .props.test.ts is the
// vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3-compile-gaps)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// @decision DEC-CI-MERGE-GATE-ENFORCE-003
// title: branded-type fixture pattern — named inline cast helpers for fast-check arbitraries
// status: accepted (WI-CI-MERGE-GATE-ENFORCEMENT slice A1, closes #294)
// rationale: PointerEntry.merkleRoot and PointerEntry/NovelGlueEntry.canonicalAstHash
//   are branded types (BlockMerkleRoot, CanonicalAstHash) enforced by
//   exactOptionalPropertyTypes:true in tsconfig. fast-check's stringMatching()
//   produces fc.Arbitrary<string>, not the brand. The canonical fix (Sacred Practice #12)
//   is to map through named inline helpers asBlockMerkleRoot/asCanonicalAstHash using
//   the `as unknown as <Brand>` structural-typing escape — the same pattern used
//   throughout the workspace (federation/src/pull.test.ts, registry/src/storage.test.ts,
//   etc.). No new exported brand-helper module is added; the helpers are local to
//   this file. The branded-type definitions in @yakcc/contracts remain unchanged.
//
// Atoms covered (3 named):
//   SP1.1 — GlueLeafInWasmModeError: construction and field contract
//   SP1.2 — compileToTypeScript: entry-kind emit rules and output shape
//   SP1.3 — assertNoGlueLeaf: glue-free pass-through and rejection
//
// Properties (18 named):
//   prop_error_name_is_GlueLeafInWasmModeError
//   prop_error_message_contains_hash_prefix
//   prop_error_message_contains_reason
//   prop_error_message_names_compileToTypeScript
//   prop_error_canonicalAstHash_preserved
//   prop_error_glueReason_preserved
//   prop_ts_output_ends_with_newline
//   prop_ts_output_contains_header_comment
//   prop_ts_pointer_entry_emits_merkle_root
//   prop_ts_pointer_entry_emits_hash_prefix
//   prop_ts_novel_glue_entry_emits_source
//   prop_ts_novel_glue_entry_emits_hash_prefix
//   prop_ts_glue_entry_emits_source_between_markers
//   prop_ts_glue_entry_markers_contain_hash_prefix
//   prop_ts_foreign_leaf_entry_not_inlined
//   prop_ts_empty_plan_contains_only_header
//   prop_assert_passes_on_glue_free_plan
//   prop_assert_throws_on_first_glue_entry
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import type { GlueLeafEntry, SlicePlan, SlicePlanEntry } from "@yakcc/shave";
import * as fc from "fast-check";
import { GlueLeafInWasmModeError, assertNoGlueLeaf, compileToTypeScript } from "./slice-plan.js";

// ---------------------------------------------------------------------------
// Named inline brand-cast helpers (DEC-CI-MERGE-GATE-ENFORCE-003)
//
// These helpers use `as unknown as <Brand>` — the canonical structural-typing
// escape for branded primitives in fast-check fixtures (see pattern at
// federation/src/pull.test.ts, manifest.test.ts fakeRoot/fakeSpec). No new
// exported module is created; authority stays in @yakcc/contracts.
// ---------------------------------------------------------------------------

/** Cast a hex string from a fast-check arbitrary to BlockMerkleRoot brand. */
const asBlockMerkleRoot = (s: string): BlockMerkleRoot => s as unknown as BlockMerkleRoot;

/** Cast a hex string from a fast-check arbitrary to CanonicalAstHash brand. */
const asCanonicalAstHash = (s: string): CanonicalAstHash => s as unknown as CanonicalAstHash;

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** An 8-40 character hex string simulating a canonicalAstHash (unbranded). */
const hashArb: fc.Arbitrary<string> = fc.stringMatching(/^[0-9a-f]{8,40}$/);

/** An 8-40 character hex string simulating a merkleRoot (unbranded). */
const merkleRootArb: fc.Arbitrary<string> = fc.stringMatching(/^[0-9a-f]{8,40}$/);

/** Branded CanonicalAstHash arbitrary — required for PointerEntry/NovelGlueEntry fields. */
const canonicalAstHashArb: fc.Arbitrary<CanonicalAstHash> = hashArb.map(asCanonicalAstHash);

/** Branded BlockMerkleRoot arbitrary — required for PointerEntry.merkleRoot. */
const blockMerkleRootArb: fc.Arbitrary<BlockMerkleRoot> = merkleRootArb.map(asBlockMerkleRoot);

/** A short human-readable reason string. */
const reasonArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9 ]{3,20}$/)
  .filter((s) => s.length >= 4);

/** Source code snippet — arbitrary printable string. */
const sourceArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((s) => s.trim().length > 0);

/** A GlueLeafEntry arbitrary. */
const glueLeafEntryArb: fc.Arbitrary<GlueLeafEntry> = fc.record({
  kind: fc.constant("glue" as const),
  source: sourceArb,
  canonicalAstHash: hashArb,
  reason: reasonArb,
});

/** A PointerEntry arbitrary. */
const pointerEntryArb: fc.Arbitrary<SlicePlanEntry> = fc.record({
  kind: fc.constant("pointer" as const),
  sourceRange: fc.record({
    start: fc.integer({ min: 0, max: 500 }),
    end: fc.integer({ min: 501, max: 1000 }),
  }),
  merkleRoot: blockMerkleRootArb,
  canonicalAstHash: canonicalAstHashArb,
  matchedBy: fc.constant("canonical_ast_hash" as const),
});

/** A NovelGlueEntry arbitrary. */
const novelGlueEntryArb: fc.Arbitrary<SlicePlanEntry> = fc.record({
  kind: fc.constant("novel-glue" as const),
  sourceRange: fc.record({
    start: fc.integer({ min: 0, max: 500 }),
    end: fc.integer({ min: 501, max: 1000 }),
  }),
  source: sourceArb,
  canonicalAstHash: canonicalAstHashArb,
});

/** A ForeignLeafEntry arbitrary. */
const foreignLeafEntryArb: fc.Arbitrary<SlicePlanEntry> = fc.record({
  kind: fc.constant("foreign-leaf" as const),
  pkg: fc.constantFrom("node:fs", "sqlite-vec", "ts-morph"),
  export: fc.constantFrom("readFileSync", "Project", "default"),
});

/** A glue-free SlicePlan arbitrary (no GlueLeafEntry). */
const glueFreeSlicePlanArb: fc.Arbitrary<SlicePlan> = fc
  .array(fc.oneof(pointerEntryArb, novelGlueEntryArb, foreignLeafEntryArb), {
    minLength: 0,
    maxLength: 6,
  })
  .map((entries) => ({
    entries,
    matchedPrimitives: [],
    sourceBytesByKind: { pointer: 0, novelGlue: 0, glue: 0 },
  }));

/** A SlicePlan containing exactly one GlueLeafEntry (at an arbitrary position). */
const slicePlanWithOneGlueArb: fc.Arbitrary<{
  plan: SlicePlan;
  glueEntry: GlueLeafEntry;
  glueIndex: number;
}> = fc
  .tuple(
    glueLeafEntryArb,
    fc.array(fc.oneof(pointerEntryArb, novelGlueEntryArb, foreignLeafEntryArb), {
      minLength: 0,
      maxLength: 4,
    }),
    fc.integer({ min: 0, max: 4 }),
  )
  .map(([glueEntry, otherEntries, rawIndex]) => {
    const glueIndex = Math.min(rawIndex, otherEntries.length);
    const entries: SlicePlanEntry[] = [
      ...otherEntries.slice(0, glueIndex),
      glueEntry,
      ...otherEntries.slice(glueIndex),
    ];
    const plan: SlicePlan = {
      entries,
      matchedPrimitives: [],
      sourceBytesByKind: { pointer: 0, novelGlue: 0, glue: glueEntry.source.length },
    };
    return { plan, glueEntry, glueIndex };
  });

// ---------------------------------------------------------------------------
// SP1.1 — GlueLeafInWasmModeError: construction and field contract
// ---------------------------------------------------------------------------

/**
 * prop_error_name_is_GlueLeafInWasmModeError
 *
 * The error's .name property is exactly "GlueLeafInWasmModeError".
 *
 * Invariant (SP1.1): instanceof checks alone are insufficient in some bundler
 * environments; the .name property is the portable discrimination mechanism.
 */
export const prop_error_name_is_GlueLeafInWasmModeError = fc.property(glueLeafEntryArb, (entry) => {
  const err = new GlueLeafInWasmModeError(entry);
  return err.name === "GlueLeafInWasmModeError";
});

/**
 * prop_error_message_contains_hash_prefix
 *
 * The error message contains the first 8 characters of canonicalAstHash.
 *
 * Invariant (SP1.1): the hash prefix must appear in the message so callers
 * can identify the offending entry from a log line without re-running the slicer.
 */
export const prop_error_message_contains_hash_prefix = fc.property(glueLeafEntryArb, (entry) => {
  const err = new GlueLeafInWasmModeError(entry);
  return err.message.includes(entry.canonicalAstHash.slice(0, 8));
});

/**
 * prop_error_message_contains_reason
 *
 * The error message contains the full reason string from the GlueLeafEntry.
 *
 * Invariant (SP1.1): the reason is load-bearing for human triage — it must be
 * preserved verbatim so operators can identify why the subgraph was not shaveable
 * without access to the original AST.
 */
export const prop_error_message_contains_reason = fc.property(glueLeafEntryArb, (entry) => {
  const err = new GlueLeafInWasmModeError(entry);
  return err.message.includes(entry.reason);
});

/**
 * prop_error_message_names_compileToTypeScript
 *
 * The error message mentions "compileToTypeScript" as the actionable alternative.
 *
 * Invariant (SP1.1): callers must be guided to the correct API without reading
 * source. The message acts as inline documentation for the rejection.
 */
export const prop_error_message_names_compileToTypeScript = fc.property(
  glueLeafEntryArb,
  (entry) => {
    const err = new GlueLeafInWasmModeError(entry);
    return err.message.includes("compileToTypeScript");
  },
);

/**
 * prop_error_canonicalAstHash_preserved
 *
 * GlueLeafInWasmModeError.canonicalAstHash equals the entry's canonicalAstHash.
 *
 * Invariant (SP1.1): the typed field must equal the source entry so programmatic
 * callers can correlate the error to its plan entry without string-parsing.
 */
export const prop_error_canonicalAstHash_preserved = fc.property(glueLeafEntryArb, (entry) => {
  const err = new GlueLeafInWasmModeError(entry);
  return err.canonicalAstHash === entry.canonicalAstHash;
});

/**
 * prop_error_glueReason_preserved
 *
 * GlueLeafInWasmModeError.glueReason equals the entry's reason.
 *
 * Invariant (SP1.1): the typed field must equal the source entry's reason so
 * programmatic callers can read the reason without string-parsing the message.
 */
export const prop_error_glueReason_preserved = fc.property(glueLeafEntryArb, (entry) => {
  const err = new GlueLeafInWasmModeError(entry);
  return err.glueReason === entry.reason;
});

// ---------------------------------------------------------------------------
// SP1.2 — compileToTypeScript: entry-kind emit rules and output shape
// ---------------------------------------------------------------------------

/**
 * prop_ts_output_ends_with_newline
 *
 * compileToTypeScript always returns a string ending with "\n".
 *
 * Invariant (SP1.2): the assembled TS source is suitable for file-write without
 * a trailing newline fix. Every plan, including empty ones, produces a
 * newline-terminated string.
 */
export const prop_ts_output_ends_with_newline = fc.property(glueFreeSlicePlanArb, (plan) => {
  const out = compileToTypeScript(plan);
  return out.endsWith("\n");
});

/**
 * prop_ts_output_contains_header_comment
 *
 * compileToTypeScript output contains the "@yakcc/compile" header comment.
 *
 * Invariant (SP1.2): the header comment acts as a machine-readable marker that
 * the file was assembled by the compile pipeline. Downstream tools (L10 manifest)
 * can verify provenance without parsing the full AST.
 */
export const prop_ts_output_contains_header_comment = fc.property(glueFreeSlicePlanArb, (plan) => {
  const out = compileToTypeScript(plan);
  return out.includes("@yakcc/compile");
});

/**
 * prop_ts_pointer_entry_emits_merkle_root
 *
 * A PointerEntry's merkleRoot appears in the compiled output.
 *
 * Invariant (SP1.2): pointer entries reference existing registry blocks; the
 * merkleRoot is the identity of that block and must appear in the output so
 * downstream assembly can reconstruct the dependency graph.
 */
export const prop_ts_pointer_entry_emits_merkle_root = fc.property(
  fc.record({
    merkleRoot: blockMerkleRootArb,
    canonicalAstHash: canonicalAstHashArb,
  }),
  ({ merkleRoot, canonicalAstHash }) => {
    const entry: SlicePlanEntry = {
      kind: "pointer",
      sourceRange: { start: 0, end: 10 },
      merkleRoot,
      canonicalAstHash,
      matchedBy: "canonical_ast_hash",
    };
    const plan: SlicePlan = {
      entries: [entry],
      matchedPrimitives: [],
      sourceBytesByKind: { pointer: 10, novelGlue: 0, glue: 0 },
    };
    const out = compileToTypeScript(plan);
    return out.includes(merkleRoot);
  },
);

/**
 * prop_ts_pointer_entry_emits_hash_prefix
 *
 * A PointerEntry's canonicalAstHash 8-char prefix appears in the compiled output.
 *
 * Invariant (SP1.2): the hash prefix is emitted alongside the merkleRoot to allow
 * per-entry tracing in the assembled output without requiring the full hash.
 */
export const prop_ts_pointer_entry_emits_hash_prefix = fc.property(
  fc.record({
    merkleRoot: blockMerkleRootArb,
    canonicalAstHash: canonicalAstHashArb,
  }),
  ({ merkleRoot, canonicalAstHash }) => {
    const entry: SlicePlanEntry = {
      kind: "pointer",
      sourceRange: { start: 0, end: 10 },
      merkleRoot,
      canonicalAstHash,
      matchedBy: "canonical_ast_hash",
    };
    const plan: SlicePlan = {
      entries: [entry],
      matchedPrimitives: [],
      sourceBytesByKind: { pointer: 10, novelGlue: 0, glue: 0 },
    };
    const out = compileToTypeScript(plan);
    return out.includes(canonicalAstHash.slice(0, 8));
  },
);

/**
 * prop_ts_novel_glue_entry_emits_source
 *
 * A NovelGlueEntry's source appears verbatim in the compiled output.
 *
 * Invariant (SP1.2): novel glue is the new code that must be synthesized; it must
 * appear verbatim in the assembled module so it can be compiled and executed.
 */
export const prop_ts_novel_glue_entry_emits_source = fc.property(
  fc.record({
    source: sourceArb,
    canonicalAstHash: canonicalAstHashArb,
  }),
  ({ source, canonicalAstHash }) => {
    const entry: SlicePlanEntry = {
      kind: "novel-glue",
      sourceRange: { start: 0, end: source.length },
      source,
      canonicalAstHash,
    };
    const plan: SlicePlan = {
      entries: [entry],
      matchedPrimitives: [],
      sourceBytesByKind: { pointer: 0, novelGlue: source.length, glue: 0 },
    };
    const out = compileToTypeScript(plan);
    return out.includes(source);
  },
);

/**
 * prop_ts_novel_glue_entry_emits_hash_prefix
 *
 * A NovelGlueEntry's canonicalAstHash 8-char prefix appears in the compiled output.
 *
 * Invariant (SP1.2): the hash prefix identifies the novel-glue region in the
 * assembled output for audit and deduplication purposes.
 */
export const prop_ts_novel_glue_entry_emits_hash_prefix = fc.property(
  fc.record({
    source: sourceArb,
    canonicalAstHash: canonicalAstHashArb,
  }),
  ({ source, canonicalAstHash }) => {
    const entry: SlicePlanEntry = {
      kind: "novel-glue",
      sourceRange: { start: 0, end: source.length },
      source,
      canonicalAstHash,
    };
    const plan: SlicePlan = {
      entries: [entry],
      matchedPrimitives: [],
      sourceBytesByKind: { pointer: 0, novelGlue: source.length, glue: 0 },
    };
    const out = compileToTypeScript(plan);
    return out.includes(canonicalAstHash.slice(0, 8));
  },
);

/**
 * prop_ts_glue_entry_emits_source_between_markers
 *
 * A GlueLeafEntry's source appears verbatim in the compiled output, between
 * opening and closing comment markers.
 *
 * Invariant (SP1.2): glue source is project-local TS that didn't shave; it must
 * appear verbatim in the assembled module. The markers make the boundary auditable
 * without requiring re-running the slicer (DEC-V2-GLUE-LEAF-TS-EMIT-001).
 */
export const prop_ts_glue_entry_emits_source_between_markers = fc.property(
  glueLeafEntryArb,
  (glueEntry) => {
    const plan: SlicePlan = {
      entries: [glueEntry],
      matchedPrimitives: [],
      sourceBytesByKind: { pointer: 0, novelGlue: 0, glue: glueEntry.source.length },
    };
    const out = compileToTypeScript(plan);
    const shortHash = glueEntry.canonicalAstHash.slice(0, 8);
    const openMarker = `// --- glue: ${shortHash}`;
    const closeMarker = "// --- end glue ---";
    const openIdx = out.indexOf(openMarker);
    const closeIdx = out.indexOf(closeMarker);
    if (openIdx === -1 || closeIdx === -1) return false;
    const between = out.slice(openIdx, closeIdx);
    return between.includes(glueEntry.source);
  },
);

/**
 * prop_ts_glue_entry_markers_contain_hash_prefix
 *
 * The opening marker for a GlueLeafEntry contains the 8-char hash prefix.
 *
 * Invariant (SP1.2): the hash prefix in the marker enables correlation between the
 * assembled output and the original plan entry in downstream audit tooling.
 */
export const prop_ts_glue_entry_markers_contain_hash_prefix = fc.property(
  glueLeafEntryArb,
  (glueEntry) => {
    const plan: SlicePlan = {
      entries: [glueEntry],
      matchedPrimitives: [],
      sourceBytesByKind: { pointer: 0, novelGlue: 0, glue: glueEntry.source.length },
    };
    const out = compileToTypeScript(plan);
    return out.includes(`// --- glue: ${glueEntry.canonicalAstHash.slice(0, 8)}`);
  },
);

/**
 * prop_ts_foreign_leaf_entry_not_inlined
 *
 * A ForeignLeafEntry does NOT produce any inlined content in the compiled output
 * beyond the header comment.
 *
 * Invariant (SP1.2): foreign imports are opaque leaves; their package specifier
 * and binding name must not appear in the assembled module source. They are
 * accounted for in the provenance manifest (L4), not inlined here.
 */
export const prop_ts_foreign_leaf_entry_not_inlined = fc.property(
  fc.record({
    pkg: fc.constantFrom("node:fs", "sqlite-vec", "ts-morph", "my-unique-pkg-xyz"),
    export: fc.constantFrom("readFileSync", "Project", "default", "myUniqueExport"),
  }),
  ({ pkg, export: exp }) => {
    const entry: SlicePlanEntry = {
      kind: "foreign-leaf",
      pkg,
      export: exp,
    };
    const plan: SlicePlan = {
      entries: [entry],
      matchedPrimitives: [],
      sourceBytesByKind: { pointer: 0, novelGlue: 0, glue: 0 },
    };
    const out = compileToTypeScript(plan);
    // The output should only contain the header — no pkg or export mention.
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    // Header is 2 lines. With a foreign-leaf only, expect only those 2 lines.
    return lines.length === 2 && !out.includes(pkg);
  },
);

/**
 * prop_ts_empty_plan_contains_only_header
 *
 * An empty SlicePlan produces output consisting solely of the header comment
 * (2 non-empty lines) followed by a trailing newline.
 *
 * Invariant (SP1.2): the header is always emitted exactly once regardless of
 * plan content. An empty plan is valid (all nodes may have been matched as
 * pointers and stripped in a prior compilation pass).
 */
export const prop_ts_empty_plan_contains_only_header = fc.property(fc.constant(null), (_) => {
  const plan: SlicePlan = {
    entries: [],
    matchedPrimitives: [],
    sourceBytesByKind: { pointer: 0, novelGlue: 0, glue: 0 },
  };
  const out = compileToTypeScript(plan);
  const nonEmptyLines = out.split("\n").filter((l) => l.trim().length > 0);
  return nonEmptyLines.length === 2 && out.endsWith("\n");
});

// ---------------------------------------------------------------------------
// SP1.3 — assertNoGlueLeaf: glue-free pass-through and rejection
// ---------------------------------------------------------------------------

/**
 * prop_assert_passes_on_glue_free_plan
 *
 * assertNoGlueLeaf does not throw when the SlicePlan contains no GlueLeafEntry.
 *
 * Invariant (SP1.3): glue-free plans must pass validation without side effects.
 * The WASM compilation path calls assertNoGlueLeaf before handing off to the
 * backend; a false positive would break all valid WASM compilation.
 */
export const prop_assert_passes_on_glue_free_plan = fc.property(glueFreeSlicePlanArb, (plan) => {
  try {
    assertNoGlueLeaf(plan);
    return true;
  } catch {
    return false;
  }
});

/**
 * prop_assert_throws_on_first_glue_entry
 *
 * assertNoGlueLeaf throws GlueLeafInWasmModeError when the plan contains a
 * GlueLeafEntry. The thrown error's canonicalAstHash matches the first glue
 * entry in plan.entries (left-to-right scan order).
 *
 * Invariant (SP1.3): the error must identify the FIRST offending entry so callers
 * can log or surface it without re-scanning the plan. Scan order is left-to-right
 * (DFS iteration order of plan.entries), consistent with
 * DEC-V2-GLUE-LEAF-WASM-001 (option a: reject on first glue).
 */
export const prop_assert_throws_on_first_glue_entry = fc.property(
  slicePlanWithOneGlueArb,
  ({ plan, glueEntry }) => {
    try {
      assertNoGlueLeaf(plan);
      return false; // should not reach here
    } catch (e) {
      return (
        e instanceof GlueLeafInWasmModeError &&
        e.canonicalAstHash === glueEntry.canonicalAstHash &&
        e.glueReason === glueEntry.reason
      );
    }
  },
);
