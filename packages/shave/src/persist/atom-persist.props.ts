// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave persist/atom-persist.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3c)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from atom-persist.ts):
//   persistNovelGlueAtom (AP1.1)   — persists a NovelGlueEntry to the full Registry.
//   maybePersistNovelGlueAtom (AP1.2) — opt-in persistence; degrades gracefully when
//                                        storeBlock is absent from the registry view.
//
// Properties covered:
//   - persistNovelGlueAtom skips entries without an intentCard (returns undefined).
//   - persistNovelGlueAtom calls storeBlock exactly once per novel entry.
//   - persistNovelGlueAtom returns the same BlockMerkleRoot as the stored row.
//   - persistNovelGlueAtom is deterministic: two calls with identical inputs
//     call storeBlock with the same blockMerkleRoot.
//   - persistNovelGlueAtom forwards parentBlockRoot to the stored row (or null
//     when omitted).
//   - maybePersistNovelGlueAtom returns undefined when storeBlock is absent.
//   - maybePersistNovelGlueAtom delegates to persistNovelGlueAtom when storeBlock
//     is present.
//   - maybePersistNovelGlueAtom skips entries without intentCard regardless of
//     registry shape (returns undefined).
//   - The stored row carries level === "L0" for every novel entry.
//   - persistNovelGlueAtom produces distinct merkleRoots for distinct source texts.
//
// Deferred atoms:
//   - corpusOptions / propsFilePath forwarding: tested via extractCorpus contract,
//     not a property of the persist boundary.
//   - cacheDir (AI-derived corpus source c): requires live filesystem; out of
//     property-test scope (offline discipline per DEC-SHAVE-002).

// ---------------------------------------------------------------------------
// Property-test corpus for persist/atom-persist.ts
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import type { IntentCard } from "../intent/types.js";
import type { NovelGlueEntry } from "../universalize/types.js";
import { maybePersistNovelGlueAtom, persistNovelGlueAtom } from "./atom-persist.js";
import type { PersistOptions } from "./atom-persist.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** 64-char hex string suitable for a CanonicalAstHash. */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Well-formed IntentCard for property testing. */
const intentCardArb: fc.Arbitrary<IntentCard> = fc.record({
  schemaVersion: fc.constant(1 as const),
  behavior: nonEmptyStr,
  inputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 2 },
  ),
  outputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 2 },
  ),
  preconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 2 }),
  postconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 2 }),
  notes: fc.array(fc.string(), { minLength: 0, maxLength: 2 }),
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
  sourceHash: hexHash64,
  extractedAt: fc.constant("2024-01-01T00:00:00.000Z"),
});

/** Source text for an atom (non-empty string). */
const sourceArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 200 });

/** Well-formed NovelGlueEntry with an intentCard. */
const novelGlueEntryArb: fc.Arbitrary<NovelGlueEntry> = fc
  .tuple(sourceArb, hexHash64, intentCardArb)
  .map(([source, hash, intentCard]) => ({
    kind: "novel-glue" as const,
    sourceRange: { start: 0, end: source.length },
    source,
    canonicalAstHash: hash as CanonicalAstHash,
    intentCard,
  }));

/** NovelGlueEntry without an intentCard (deep leaf). */
const novelGlueEntryNoCardArb: fc.Arbitrary<NovelGlueEntry> = fc
  .tuple(sourceArb, hexHash64)
  .map(([source, hash]) => ({
    kind: "novel-glue" as const,
    sourceRange: { start: 0, end: source.length },
    source,
    canonicalAstHash: hash as CanonicalAstHash,
  }));

// ---------------------------------------------------------------------------
// Registry stub helpers (no mocks — real interface duck-typed from shape)
// ---------------------------------------------------------------------------

/** Build an in-memory registry stub that records storeBlock calls. */
function makeStoreStub(): {
  storeBlock: (row: { blockMerkleRoot: BlockMerkleRoot }) => Promise<void>;
  calls: Array<{ blockMerkleRoot: BlockMerkleRoot }>;
} {
  const calls: Array<{ blockMerkleRoot: BlockMerkleRoot }> = [];
  return {
    storeBlock: async (row) => {
      calls.push(row);
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// AP1.1: persistNovelGlueAtom — skips entries without intentCard
// ---------------------------------------------------------------------------

/**
 * prop_persistNovelGlueAtom_skips_no_intent_card
 *
 * When the NovelGlueEntry has no intentCard, persistNovelGlueAtom returns
 * undefined and never calls storeBlock.
 *
 * Invariant (AP1.1, DEC-ATOM-PERSIST-001): entries without an intentCard are
 * silently skipped — no error, no persistence. This is the safety net for
 * non-NovelGlue kinds (PointerEntry, ForeignLeafEntry). Per WI-031
 * (DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001), novel-glue entries in multi-leaf
 * trees carry per-leaf cards; intentCard optionality is preserved for
 * forward-compat with entry kinds that carry no intent slot.
 */
export const prop_persistNovelGlueAtom_skips_no_intent_card = fc.asyncProperty(
  novelGlueEntryNoCardArb,
  async (entry) => {
    const stub = makeStoreStub();
    const registry = { storeBlock: stub.storeBlock } as never;
    const result = await persistNovelGlueAtom(entry, registry);
    return result === undefined && stub.calls.length === 0;
  },
);

// ---------------------------------------------------------------------------
// AP1.1: persistNovelGlueAtom — calls storeBlock exactly once per entry
// ---------------------------------------------------------------------------

/**
 * prop_persistNovelGlueAtom_calls_store_block_once
 *
 * For any well-formed NovelGlueEntry with an intentCard, persistNovelGlueAtom
 * calls storeBlock exactly once.
 *
 * Invariant (AP1.1): one entry → one block row. Idempotency of storeBlock is
 * the registry's contract; this side drives exactly one call per persist.
 */
export const prop_persistNovelGlueAtom_calls_store_block_once = fc.asyncProperty(
  novelGlueEntryArb,
  async (entry) => {
    const stub = makeStoreStub();
    const registry = { storeBlock: stub.storeBlock } as never;
    await persistNovelGlueAtom(entry, registry);
    return stub.calls.length === 1;
  },
);

// ---------------------------------------------------------------------------
// AP1.1: persistNovelGlueAtom — return value matches stored merkleRoot
// ---------------------------------------------------------------------------

/**
 * prop_persistNovelGlueAtom_return_equals_stored_merkle_root
 *
 * The BlockMerkleRoot returned by persistNovelGlueAtom equals the
 * blockMerkleRoot on the row passed to storeBlock.
 *
 * Invariant (AP1.1): the return value is the content address of the stored
 * block, so callers can use it as the parentBlockRoot of child atoms without
 * re-reading the registry.
 */
export const prop_persistNovelGlueAtom_return_equals_stored_merkle_root = fc.asyncProperty(
  novelGlueEntryArb,
  async (entry) => {
    const stub = makeStoreStub();
    const registry = { storeBlock: stub.storeBlock } as never;
    const result = await persistNovelGlueAtom(entry, registry);
    return result !== undefined && stub.calls[0]?.blockMerkleRoot === result;
  },
);

// ---------------------------------------------------------------------------
// AP1.1: persistNovelGlueAtom — determinism (identical inputs → identical merkleRoot)
// ---------------------------------------------------------------------------

/**
 * prop_persistNovelGlueAtom_is_deterministic
 *
 * Two calls to persistNovelGlueAtom() with identical entry+options return
 * identical BlockMerkleRoot values.
 *
 * Invariant (AP1.1, DEC-ATOM-PERSIST-001): the merkle root is derived from the
 * content address of the spec + impl + manifest — all pure, no timestamps or
 * random bytes in the computation.
 */
export const prop_persistNovelGlueAtom_is_deterministic = fc.asyncProperty(
  novelGlueEntryArb,
  async (entry) => {
    const stub1 = makeStoreStub();
    const stub2 = makeStoreStub();
    const r1 = await persistNovelGlueAtom(entry, { storeBlock: stub1.storeBlock } as never);
    const r2 = await persistNovelGlueAtom(entry, { storeBlock: stub2.storeBlock } as never);
    return r1 !== undefined && r1 === r2;
  },
);

// ---------------------------------------------------------------------------
// AP1.1: persistNovelGlueAtom — parentBlockRoot forwarded to stored row
// ---------------------------------------------------------------------------

/**
 * prop_persistNovelGlueAtom_forwards_parent_block_root
 *
 * When PersistOptions.parentBlockRoot is provided, the stored row carries
 * that exact value. When omitted, the stored row carries null.
 *
 * Invariant (AP1.1, DEC-REGISTRY-PARENT-BLOCK-004): lineage is injected via
 * parentBlockRoot and written verbatim to the row — no re-derivation. This
 * preserves content-address purity: the parent reference is row metadata only.
 */
export const prop_persistNovelGlueAtom_forwards_parent_block_root = fc.asyncProperty(
  novelGlueEntryArb,
  fc.option(
    hexHash64.map((h) => h as BlockMerkleRoot),
    { nil: null },
  ),
  async (entry, parentBlockRoot) => {
    const calls: Array<{ parentBlockRoot: BlockMerkleRoot | null }> = [];
    const registry = {
      storeBlock: async (row: { parentBlockRoot: BlockMerkleRoot | null }) => {
        calls.push(row);
      },
    } as never;
    const opts: PersistOptions = { parentBlockRoot: parentBlockRoot ?? null };
    await persistNovelGlueAtom(entry, registry, opts);
    return calls[0]?.parentBlockRoot === (parentBlockRoot ?? null);
  },
);

// ---------------------------------------------------------------------------
// AP1.1: persistNovelGlueAtom — stored row level is always "L0"
// ---------------------------------------------------------------------------

/**
 * prop_persistNovelGlueAtom_stored_row_level_is_L0
 *
 * The BlockTripletRow written to storeBlock always carries level === "L0".
 *
 * Invariant (AP1.1, DEC-TRIPLET-L0-ONLY-019): specFromIntent hard-codes "L0";
 * buildTriplet propagates it to the row. No upgrade path exists at this layer.
 */
export const prop_persistNovelGlueAtom_stored_row_level_is_L0 = fc.asyncProperty(
  novelGlueEntryArb,
  async (entry) => {
    const calls: Array<{ level: string }> = [];
    const registry = {
      storeBlock: async (row: { level: string }) => {
        calls.push(row);
      },
    } as never;
    await persistNovelGlueAtom(entry, registry);
    return calls[0]?.level === "L0";
  },
);

// ---------------------------------------------------------------------------
// AP1.1: persistNovelGlueAtom — distinct sources yield distinct merkleRoots
// ---------------------------------------------------------------------------

/**
 * prop_persistNovelGlueAtom_distinct_sources_yield_distinct_merkle_roots
 *
 * Two NovelGlueEntries with distinct source texts (holding all other fields
 * equal) produce distinct BlockMerkleRoot values.
 *
 * Invariant (AP1.1, DEC-TRIPLET-IDENTITY-020): impl is the raw source text at
 * L0 — file bytes are the identity unit. Different source → different impl →
 * different blockMerkleRoot (content-addressed by construction).
 */
export const prop_persistNovelGlueAtom_distinct_sources_yield_distinct_merkle_roots =
  fc.asyncProperty(
    fc.tuple(nonEmptyStr, nonEmptyStr).filter(([a, b]) => a !== b),
    hexHash64,
    intentCardArb,
    async ([sourceA, sourceB], hash, intentCard) => {
      const entryA: NovelGlueEntry = {
        kind: "novel-glue",
        sourceRange: { start: 0, end: sourceA.length },
        source: sourceA,
        canonicalAstHash: hash as CanonicalAstHash,
        intentCard,
      };
      const entryB: NovelGlueEntry = {
        kind: "novel-glue",
        sourceRange: { start: 0, end: sourceB.length },
        source: sourceB,
        canonicalAstHash: hash as CanonicalAstHash,
        intentCard,
      };
      const stub1 = makeStoreStub();
      const stub2 = makeStoreStub();
      const r1 = await persistNovelGlueAtom(entryA, { storeBlock: stub1.storeBlock } as never);
      const r2 = await persistNovelGlueAtom(entryB, { storeBlock: stub2.storeBlock } as never);
      // Different source bytes → different content address → different merkleRoot.
      return r1 !== undefined && r2 !== undefined && r1 !== r2;
    },
  );

// ---------------------------------------------------------------------------
// AP1.2: maybePersistNovelGlueAtom — returns undefined when no storeBlock
// ---------------------------------------------------------------------------

/**
 * prop_maybePersistNovelGlueAtom_returns_undefined_when_no_store_block
 *
 * When the registry view does not implement storeBlock, maybePersistNovelGlueAtom
 * returns undefined without throwing.
 *
 * Invariant (AP1.2, DEC-ATOM-PERSIST-001): shave() uses ShaveRegistryView which
 * may omit storeBlock. Graceful degradation (no-op, no error) is the contract.
 */
export const prop_maybePersistNovelGlueAtom_returns_undefined_when_no_store_block =
  fc.asyncProperty(novelGlueEntryArb, async (entry) => {
    // Registry view with no storeBlock method.
    const registryView = {} as never;
    const result = await maybePersistNovelGlueAtom(entry, registryView);
    return result === undefined;
  });

// ---------------------------------------------------------------------------
// AP1.2: maybePersistNovelGlueAtom — delegates to persistNovelGlueAtom when storeBlock present
// ---------------------------------------------------------------------------

/**
 * prop_maybePersistNovelGlueAtom_delegates_when_store_block_present
 *
 * When the registry view implements storeBlock, maybePersistNovelGlueAtom
 * returns a defined BlockMerkleRoot (equal to what persistNovelGlueAtom returns).
 *
 * Invariant (AP1.2): the maybe-path is a thin wrapper that calls persistNovelGlueAtom
 * when the storeBlock capability is present. The result must be non-undefined
 * for well-formed entries.
 */
export const prop_maybePersistNovelGlueAtom_delegates_when_store_block_present = fc.asyncProperty(
  novelGlueEntryArb,
  async (entry) => {
    const stub = makeStoreStub();
    const registryView = { storeBlock: stub.storeBlock } as never;
    const result = await maybePersistNovelGlueAtom(entry, registryView);
    return result !== undefined && stub.calls.length === 1;
  },
);

// ---------------------------------------------------------------------------
// AP1.2: maybePersistNovelGlueAtom — skips no-intentCard entries regardless of registry
// ---------------------------------------------------------------------------

/**
 * prop_maybePersistNovelGlueAtom_skips_no_intent_card
 *
 * Even when storeBlock is present, maybePersistNovelGlueAtom returns undefined
 * for entries without an intentCard.
 *
 * Invariant (AP1.2): the intentCard guard fires before the storeBlock check in
 * the delegated persistNovelGlueAtom call — the registry capability does not
 * override the entry-level skip logic.
 */
export const prop_maybePersistNovelGlueAtom_skips_no_intent_card = fc.asyncProperty(
  novelGlueEntryNoCardArb,
  async (entry) => {
    const stub = makeStoreStub();
    const registryView = { storeBlock: stub.storeBlock } as never;
    const result = await maybePersistNovelGlueAtom(entry, registryView);
    return result === undefined && stub.calls.length === 0;
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: novelGlueEntry → persistNovelGlueAtom → maybePersistNovelGlueAtom
//
// Production sequence: NovelGlueEntry (from slicer) → persistNovelGlueAtom()
// → extractCorpus() → buildTriplet() → storeBlock(). This exercises the
// boundary between slicer output, corpus extraction, triplet construction, and
// registry storage in a single end-to-end call.
// ---------------------------------------------------------------------------

/**
 * prop_persist_atom_compound_interaction
 *
 * For a well-formed NovelGlueEntry, persistNovelGlueAtom and
 * maybePersistNovelGlueAtom (with storeBlock) produce the same BlockMerkleRoot.
 *
 * This is the canonical compound-interaction property crossing:
 *   NovelGlueEntry → persistNovelGlueAtom() → extractCorpus() + buildTriplet()
 *   → BlockTripletRow.blockMerkleRoot
 *
 * Invariant (AP1.1 + AP1.2): both paths delegate to the same underlying
 * buildTriplet() derivation, so their content addresses are identical.
 */
export const prop_persist_atom_compound_interaction = fc.asyncProperty(
  novelGlueEntryArb,
  async (entry) => {
    const stub1 = makeStoreStub();
    const stub2 = makeStoreStub();
    const r1 = await persistNovelGlueAtom(entry, { storeBlock: stub1.storeBlock } as never);
    const r2 = await maybePersistNovelGlueAtom(entry, { storeBlock: stub2.storeBlock } as never);
    return r1 !== undefined && r2 !== undefined && r1 === r2;
  },
);
