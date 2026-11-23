// SPDX-License-Identifier: MIT
// @decision DEC-ATOM-PERSIST-001
// title: persistNovelGlueAtom persists novel atoms to the registry as BlockTripletRows
// status: decided
// rationale:
//   - Persistence is opt-in via ShaveRegistryView.storeBlock (optional method):
//     when storeBlock is absent the entry is left untouched and no error is raised.
//     This lets read-only registry views (e.g. the test mock with only findByCanonicalAstHash)
//     be used without modification.
//   - Only NovelGlueEntries with an intentCard persist; PointerEntries reference
//     existing blocks in the registry and do not produce new rows.
//   - Entries without an intentCard are skipped. For NovelGlueEntries this
//     should not occur in practice: WI-031 (commit `8dfb44b`, 2026-05-01)
//     calls extractIntent per novel-glue entry for multi-leaf trees (see
//     DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001). The intentCard field remains
//     optional on NovelGlueEntry for forward-compat with PointerEntry /
//     ForeignLeafEntry kinds that carry no intent slot.
//   - WI-016: Property-test corpus is extracted via extractCorpus() before buildTriplet().
//     The CorpusResult is passed to buildTriplet() as the canonical artifact source.
//     The bootstrap placeholder (empty bytes) is no longer the silent default.
//   - Corpus extraction source preference: upstream-test (a) > documented-usage (b) > ai-derived (c).
//     cacheDir is forwarded from PersistOptions when provided, enabling source (c).
//   - Effect declaration is empty (atoms are pure-by-default at this stage;
//     effect inference is a future pass).
//   - The signature takes Registry (full interface) not ShaveRegistryView because
//     persistence requires storeBlock, which isn't in the read-only view. Callers
//     that have a full Registry pass it directly.

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import { emitTypeScript, liftAtom, linkReferences, packGraph } from "@yakcc/duc";
import type { BlockTripletRow, DucImplementationRow } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { runMutationTesting } from "@yakcc/variance";
import type { MutationResult } from "@yakcc/variance";
import { extractCorpus } from "../corpus/index.js";
import type { CorpusAtomSpec, CorpusExtractionOptions, CorpusSource } from "../corpus/index.js";
import type { IntentCard } from "../intent/types.js";
import type { NovelGlueEntry } from "../universalize/types.js";
import {
  type DucGateMode,
  type ModuleBindingInfo,
  atomDefinedNames,
  ducGateModeFromEnv,
  enforceDucGate,
} from "./duc-gate.js";
import { buildTriplet } from "./triplet.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for persistNovelGlueAtom() and maybePersistNovelGlueAtom().
 */
export interface PersistOptions {
  /**
   * Root cache directory for corpus extraction source (c) — AI-derived synthesis.
   * When provided, the AI-derived cache path is attempted after (a) and (b).
   * When omitted, source (c) is skipped (sources (a) and (b) are always available).
   */
  readonly cacheDir?: string | undefined;

  /**
   * Corpus extraction options forwarded to extractCorpus().
   * Use to disable individual sources (e.g. for testing).
   */
  readonly corpusOptions?: CorpusExtractionOptions | undefined;

  /**
   * Absolute path to the source file being processed.
   *
   * When provided, the props-file corpus extractor looks for a sibling
   * `<stem>.props.ts` file (replacing the `.ts` extension). If found and it
   * contains matching `prop_<atom>_*` exports, the props-file content is used
   * as the corpus artifact (highest priority, WI-V2-07-L8).
   *
   * Forwarded from shave()'s `sourcePath` parameter. Omitting this disables
   * the props-file source for this atom.
   */
  readonly sourceFilePath?: string | undefined;

  // @decision DEC-REGISTRY-PARENT-BLOCK-004
  // title: parentBlockRoot is the canonical lineage field on PersistOptions
  // status: decided (WI-017)
  // rationale:
  //   The parent_block_root column on the blocks table (added in WI-014-04) is
  //   the single authority for recursion-tree lineage. To avoid a sidecar table or
  //   in-memory map, lineage is injected via PersistOptions.parentBlockRoot and
  //   written directly into BlockTripletRow.parentBlockRoot on each persist call.
  //   No re-derivation of the parent merkle root is performed here — callers supply
  //   the literal BlockMerkleRoot returned by a prior persistNovelGlueAtom call.
  //   This preserves content-address purity: the parent reference is row metadata,
  //   not part of the child block's content address computation.
  /**
   * BlockMerkleRoot of the recursion-tree parent from which this atom was shaved.
   *
   * - `null` (or omitted) → this block is the root of its recursion tree.
   * - non-null → the caller supplies the LITERAL merkle root returned by a prior
   *   persistNovelGlueAtom call for the parent atom.
   *
   * The value is written directly to BlockTripletRow.parentBlockRoot. It is NOT
   * part of the block's content address — it is registry row metadata only.
   */
  readonly parentBlockRoot?: BlockMerkleRoot | null | undefined;

  /**
   * Source-file provenance context forwarded from ShaveOptions.sourceContext.
   *
   * When provided, the persisted BlockTripletRow carries sourcePkg, sourceFile,
   * and sourceOffset so the registry can record where the atom was shaved from.
   * When absent (undefined), the row is stored with null provenance — correct for
   * interactive shaves and non-bootstrap runners.
   *
   * Forwarded from ShaveOptions.sourceContext via shave() → maybePersistNovelGlueAtom
   * → persistNovelGlueAtom without modification.
   *
   * @decision DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001
   * @scope WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P1
   */
  readonly sourceContext?:
    | {
        readonly sourcePkg: string;
        readonly sourceFile: string;
        readonly sourceOffset: number | null;
      }
    | undefined;

  // @decision DEC-MUTATE-PERSIST-001
  // title: skipMutationGate bypasses the mutation-testing gate in PersistOptions
  // status: decided (WI-776)
  // rationale:
  //   The mutation-testing gate runs fast-check assertions against mutated impls
  //   using node:vm. In dev workflows and test suites, the gate can be bypassed
  //   via this option. The CLI default is to enforce (false). Bootstrap path
  //   enforces the gate but writes failures to bootstrap/report.json rather than
  //   aborting (handled by the bootstrap orchestrator, not by this function).
  //   When skipMutationGate is true (or process.env.YAKCC_SKIP_MUTATION_GATE=1),
  //   storeBlock is called unconditionally.
  /**
   * When true, skip the mutation-testing gate for this atom.
   *
   * Default: false (gate is enforced). Set to true for development or test
   * workflows. Can also be bypassed by setting YAKCC_SKIP_MUTATION_GATE=1.
   */
  readonly skipMutationGate?: boolean | undefined;

  /**
   * Minimum fraction of non-equivalent mutants that must be killed by the
   * corpus property tests for the atom to be admitted.
   *
   * Default: 0.80. Range [0, 1].
   */
  readonly mutationKillRateThreshold?: number | undefined;

  // @decision DEC-DUC-CONSERVATION-GATE-001
  /**
   * DUC conservation-gate mode. `warn` (default) records unknown-support and
   * warns on unexplained free references but still admits the atom; `reject`
   * throws {@link DucGateRejection} on such an atom. When omitted, resolved from
   * `YAKCC_DUC_GATE` (default warn). The gate always runs and always records
   * `ducUsupp` provenance regardless of mode.
   */
  readonly ducGateMode?: DucGateMode | undefined;

  // @decision DEC-DUC-COMPOSITION-EDGE-001 (WI-EXPLAIN-01, GH #1170)
  /**
   * The recursion forest's internal-symbol set — the names of every sibling/child
   * atom in the same shave. A `free-identifier` reference matching one of these is
   * an internal composition edge, not an external unknown: the gate records it as
   * `composition` and excludes it from `unexplained` (so it never trips reject
   * mode). Metadata-only — the atom's bytes and content address are untouched.
   *
   * Computed once per forest via `collectInternalSymbols(...)` and forwarded here.
   * When omitted, no free-identifier is treated as internal (pre-#1170 behavior).
   */
  readonly internalSymbols?: ReadonlySet<string> | undefined;

  // @decision DEC-DUC-MODULE-CAPTURE-001 (WI-EXPLAIN, GH #1171)
  /**
   * The enclosing module's top-level bindings, classified `pure` (a literal const
   * never mutated) or `mutable`. An atom's free reference to a `pure` binding is a
   * recorded capture and does not trip reject mode. Computed once per module via
   * `moduleBindingsOf(moduleSource)`. When omitted, no capture is recognised.
   */
  readonly moduleBindings?: ReadonlyMap<string, ModuleBindingInfo> | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a NovelGlueEntry as a block triplet row in the registry.
 *
 * Returns the BlockMerkleRoot of the persisted block, or undefined if the
 * entry was skipped (no intentCard).
 *
 * Skips persistence without error when:
 *   - entry.intentCard is undefined (deep leaf in a multi-leaf tree).
 *
 * @param entry      - The NovelGlueEntry from the slicer. Must carry an intentCard
 *                     for persistence; entries without one are skipped.
 * @param registry   - Full Registry interface (requires storeBlock). For callers
 *                     with a read-only view, use the opt-in path in shave() instead.
 * @param options    - Optional persistence options (cacheDir for corpus source c).
 */
export async function persistNovelGlueAtom(
  entry: NovelGlueEntry,
  registry: Registry,
  options?: PersistOptions,
): Promise<BlockMerkleRoot | undefined> {
  // Skip atoms without an intent card — this is the defensive safety net for
  // non-NovelGlue entry kinds (PointerEntry, ForeignLeafEntry) that have no
  // intentCard slot. Per WI-031 (DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001),
  // novel-glue entries in multi-leaf trees DO carry per-leaf cards; this branch
  // is not expected to fire for them in the normal pipeline.
  const intentCard: IntentCard | undefined = entry.intentCard;
  if (intentCard === undefined) {
    return undefined;
  }

  // WI-016: Extract the property-test corpus before building the triplet.
  // The corpus result carries the artifact bytes that become the "property_tests"
  // entry in the ProofManifest, making the BlockMerkleRoot content-dependent on
  // the actual test corpus (not empty bytes).
  //
  // WI-V2-07-L8: derive propsFilePath from sourceFilePath when provided.
  // The props-file extractor (highest-priority source) will check for matching
  // prop_<atom>_* exports in the sibling *.props.ts before falling through
  // to upstream-test source-(a).
  const propsFilePath = options?.sourceFilePath?.replace(/\.ts$/, ".props.ts");
  const atomSpec: CorpusAtomSpec = {
    source: entry.source,
    intentCard,
    cacheDir: options?.cacheDir,
    propsFilePath,
  };
  const corpusResult = await extractCorpus(atomSpec, options?.corpusOptions);

  // Build the full block triplet with the extracted corpus.
  const triplet = buildTriplet(intentCard, entry.source, entry.canonicalAstHash, corpusResult);

  // Construct the BlockTripletRow for registry storage.
  // parentBlockRoot is row metadata (lineage), not part of the content address —
  // per DEC-REGISTRY-PARENT-BLOCK-004. It defaults to null for root atoms.
  //
  // DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: artifacts is the SAME Map that buildTriplet
  // passed to blockMerkleRoot() — forwarded here unchanged, no copy or re-derivation.
  //
  // DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001: sourceContext fields are forwarded
  // from PersistOptions.sourceContext when provided by the bootstrap walker.
  // When absent (undefined), all three provenance fields default to null — correct
  // for interactive shaves and non-bootstrap runners. INSERT OR IGNORE in storeBlock
  // ensures first-observed-wins: a second store with null does not clobber existing
  // non-null provenance.
  // DUC conservation gate (DEC-DUC-CONSERVATION-GATE-001): lift the atom, compute
  // its unknown-support, and enforce the warn/reject policy. In `reject` mode an
  // atom with an unexplained free reference throws DucGateRejection here, before
  // any registry write; in `warn` mode (default) it is recorded and admitted. The
  // gate never throws for lift failures — those degrade to a recorded liftError.
  const gate = enforceDucGate(
    entry.source,
    intentCard.behavior.slice(0, 60),
    options?.ducGateMode ?? ducGateModeFromEnv(),
    undefined, // warn — default console.warn
    options?.internalSymbols, // sibling/child atom names → composition edges (#1170)
    options?.moduleBindings, // pure module constants → recorded captures (#1171)
  );

  const sc = options?.sourceContext;
  const row: BlockTripletRow = {
    blockMerkleRoot: triplet.merkleRoot,
    specHash: triplet.specHash,
    specCanonicalBytes: triplet.specCanonicalBytes,
    implSource: triplet.impl,
    proofManifestJson: JSON.stringify(triplet.manifest),
    artifacts: triplet.artifacts,
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: entry.canonicalAstHash,
    parentBlockRoot: options?.parentBlockRoot ?? null,
    // Provenance fields — null when not supplied by the caller.
    sourcePkg: sc?.sourcePkg ?? null,
    sourceFile: sc?.sourceFile ?? null,
    sourceOffset: sc?.sourceOffset ?? null,
    // DUC unknown-support provenance (DEC-DUC-USUPP-PROVENANCE-001).
    ducUsupp: gate.ducUsupp,
    // DEC-RETRIEVAL-DERIVATION-001 (WI-REUSE B2, #1259): how the corpus artifact was made.
    derivationJson: JSON.stringify({ derivation: derivationOf(corpusResult.source) }),
  };

  // Mutation-testing gate: verify corpus tests kill a minimum fraction of
  // mutants before admitting the atom to the registry.
  // Bypassed when skipMutationGate is true or YAKCC_SKIP_MUTATION_GATE=1.
  const gateSkipped =
    options?.skipMutationGate === true || process.env.YAKCC_SKIP_MUTATION_GATE === "1";

  if (!gateSkipped) {
    const corpusTestSource = new TextDecoder().decode(corpusResult.bytes);
    const killRateThreshold = options?.mutationKillRateThreshold ?? 0.8;
    const gateResult: MutationResult = await runMutationTesting(
      {
        implSource: entry.source,
        corpusTestSource,
        canonicalAstHash: entry.canonicalAstHash,
        atomName: intentCard.behavior.slice(0, 60),
      },
      { killRateThreshold },
    );
    if (!gateResult.skipped && gateResult.killRate < killRateThreshold) {
      const survivorDescs = gateResult.survivors
        .filter((s) => s.reason === "tests_passed")
        .slice(0, 3)
        .map((s) => s.mutant.description)
        .join("; ");
      throw new Error(
        `Mutation gate: atom rejected — kill rate ${(gateResult.killRate * 100).toFixed(0)}% < ${(killRateThreshold * 100).toFixed(0)}% threshold. Surviving mutants: ${survivorDescs || "(none listed)"}. Use --skip-mutation-gate or set YAKCC_SKIP_MUTATION_GATE=1 to bypass.`,
      );
    }
  }

  // Persist to registry. storeBlock is idempotent: storing the same
  // blockMerkleRoot twice is a no-op (per Registry contract).
  await registry.storeBlock(row);

  // The graph beside the block (#1279): the implementation keyed by (specHash, graph identity),
  // with the emitted TypeScript as its cache. A registry view without the method, or an atom the
  // lifter refuses, stores the block alone.
  if (typeof registry.storeDucImplementation === "function") {
    const stored = ducImplementationOf(entry.source, triplet.specHash, triplet.merkleRoot);
    if (stored !== undefined) await registry.storeDucImplementation(stored);
  }

  return triplet.merkleRoot;
}

/**
 * The DUC implementation of an atom's source: its packed graph under the contract, with the emitted
 * TypeScript as a cache (undefined when the emitter does not express the graph). Undefined when the
 * source does not lift.
 */
export function ducImplementationOf(
  source: string,
  specHash: string,
  blockMerkleRoot: string | null,
): DucImplementationRow | undefined {
  let graph: ReturnType<typeof liftAtom>;
  try {
    graph = liftAtom(source);
  } catch {
    return undefined;
  }
  const packed = packGraph(graph);
  let tsCache: string | null = null;
  try {
    tsCache = emitTypeScript(graph);
  } catch {
    tsCache = null;
  }
  return {
    specHash,
    graphIdentity: packed.identity,
    formatVersion: packed.formatVersion,
    lifterVersion: packed.lifterVersion,
    structure: packed.structure,
    links: packed.links,
    annotations: packed.annotations ?? null,
    blockMerkleRoot,
    tsCache,
  };
}

/**
 * Opt-in persistence path for use within shave().
 *
 * Checks whether the registry view supports storeBlock and, if so, calls
 * persistNovelGlueAtom. Returns undefined when the view does not support
 * persistence (graceful degradation, no error).
 *
 * This is separate from persistNovelGlueAtom so that shave() can work with
 * a ShaveRegistryView (which may not implement storeBlock) while the direct
 * persistNovelGlueAtom API accepts the full Registry interface.
 *
 * @param entry      - The NovelGlueEntry to potentially persist.
 * @param registry   - A registry view that optionally supports storeBlock.
 * @param options    - Optional persistence options forwarded to persistNovelGlueAtom.
 */
export async function maybePersistNovelGlueAtom(
  entry: NovelGlueEntry,
  registry: { storeBlock?: Registry["storeBlock"] } & {
    findByCanonicalAstHash?: (hash: CanonicalAstHash) => Promise<readonly BlockMerkleRoot[]>;
  },
  options?: PersistOptions,
): Promise<BlockMerkleRoot | undefined> {
  if (typeof registry.storeBlock !== "function") {
    return undefined;
  }

  // Delegate to the full Registry path. We cast here because the duck-typed
  // registry satisfies the storeBlock contract even if it doesn't implement
  // every Registry method. Only storeBlock is called in this flow.
  return persistNovelGlueAtom(entry, registry as unknown as Registry, options);
}

/**
 * How a corpus source was derived (DEC-RETRIEVAL-DERIVATION-001). `ai-derived` is the
 * only model-written source, so it is the one that must be filterable. Tests and
 * documented examples were written by people. props-file is a hand-written property file.
 */
function derivationOf(source: CorpusSource): "human" | "tool" | "ai" {
  switch (source) {
    case "ai-derived":
      return "ai";
    case "props-file":
    case "upstream-test":
    case "documented-usage":
      return "human";
    default:
      return "tool";
  }
}

/**
 * Links each persisted atom's references to the atoms of the same plan that declare them (#1279):
 * a free name another atom of the module declares is linked to that atom's contract (its
 * specHash), and the implementation is stored again with its links (links are records outside
 * the graph's identity, so the pair it is keyed by does not change). Atoms with nothing to link,
 * and a registry without the DUC methods, are left as they are. Returns how many references were
 * linked.
 */
export async function linkPlanAtoms(
  atoms: readonly { readonly source: string; readonly merkleRoot?: BlockMerkleRoot | undefined }[],
  registry: {
    readonly getBlock?: (root: BlockMerkleRoot) => Promise<BlockTripletRow | null | undefined>;
    readonly storeDucImplementation?: Registry["storeDucImplementation"];
  },
): Promise<number> {
  if (
    typeof registry.getBlock !== "function" ||
    typeof registry.storeDucImplementation !== "function"
  )
    return 0;
  // The contract of each name an atom of the plan declares.
  const declared = new Map<string, string>();
  const persisted: { source: string; specHash: string; merkleRoot: BlockMerkleRoot }[] = [];
  for (const atom of atoms) {
    if (atom.merkleRoot === undefined) continue;
    const row = await registry.getBlock(atom.merkleRoot);
    if (row === null || row === undefined) continue;
    persisted.push({ source: atom.source, specHash: row.specHash, merkleRoot: atom.merkleRoot });
    for (const name of atomDefinedNames(atom.source))
      if (!declared.has(name)) declared.set(name, row.specHash);
  }
  let linked = 0;
  for (const atom of persisted) {
    let graph: ReturnType<typeof liftAtom>;
    try {
      graph = liftAtom(atom.source);
    } catch {
      continue;
    }
    let count = 0;
    const withLinks = linkReferences(graph, (label) => {
      if (label.reason !== "free-identifier") return undefined;
      const spec = declared.get(label.symbol);
      // A name the atom declares itself is not a reference to another atom.
      if (spec === undefined || spec === atom.specHash) return undefined;
      count++;
      return spec;
    });
    if (count === 0) continue;
    const packed = packGraph(withLinks);
    let tsCache: string | null = null;
    try {
      tsCache = emitTypeScript(withLinks);
    } catch {
      tsCache = null;
    }
    await registry.storeDucImplementation({
      specHash: atom.specHash,
      graphIdentity: packed.identity,
      formatVersion: packed.formatVersion,
      lifterVersion: packed.lifterVersion,
      structure: packed.structure,
      links: packed.links,
      annotations: packed.annotations ?? null,
      blockMerkleRoot: atom.merkleRoot,
      tsCache,
    });
    linked += count;
  }
  return linked;
}
