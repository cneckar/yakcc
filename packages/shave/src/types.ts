// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: The shave package exposes three public
// entry points — shave() for one-shot file processing, universalize() for
// continuous single-block processing, and IntentExtractionHook for hookable
// pipeline extensions. All three operate over the same registry view interface
// so callers can substitute any registry implementation without coupling to
// the SQLite storage layer.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Separating the registry view from the full Registry interface
// keeps shave testable with lightweight noop stubs and decoupled from storage.

import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import type { IntentCard } from "./intent/types.js";
import type { LicenseDetection } from "./license/types.js";
import type { SlicePlanEntry } from "./universalize/types.js";

// ---------------------------------------------------------------------------
// Foreign policy
// ---------------------------------------------------------------------------

/**
 * How the shave pipeline handles foreign-block dependencies encountered during
 * slicing. Passed as ShaveOptions.foreignPolicy.
 *
 *   'allow'  — foreign deps are silently accepted; nothing extra is emitted.
 *   'reject' — the shave pipeline throws/fails when a foreign dep is found.
 *   'tag'    — foreign deps are accepted but tagged in the slice plan output
 *              so callers and CLI output can surface them.
 */
export type ForeignPolicy = "allow" | "reject" | "tag";

/**
 * @decision DEC-V2-FOREIGN-BLOCK-SCHEMA-001 (sub-C: default policy)
 * title: FOREIGN_POLICY_DEFAULT = 'tag'
 * status: closed (WI-V2-04 L4)
 * rationale: 'tag' is the visible-by-default option. Code-is-Truth means foreign
 * deps should appear in summary output unless explicitly opted out. 'allow' would
 * silently accept foreign deps; 'reject' would block legitimate workflows. 'tag'
 * surfaces foreign deps without blocking, making the default safe and informative.
 * This constant is the single source of truth for the default (I-X3 invariant):
 * all other references (CLI --foreign-policy, ShaveOptions) import this constant.
 * @scope WI-V2-04 L4
 */
export const FOREIGN_POLICY_DEFAULT: ForeignPolicy = "tag";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Configuration options passed to shave() and universalize().
 * All fields are optional; defaults are documented on each field.
 */
export interface ShaveOptions {
  /**
   * Directory for the file-system intent-extraction cache.
   * Defaults to os.tmpdir()/yakcc-shave-cache when not specified.
   * WI-010-02 fills the cache implementation.
   */
  readonly cacheDir?: string | undefined;
  /**
   * The Anthropic model identifier to use for intent extraction.
   * Defaults to "claude-3-5-haiku-20241022".
   * WI-010-02 connects this to the Anthropic SDK.
   */
  readonly model?: string | undefined;
  /**
   * When true, skip live extraction and rely entirely on cache hits.
   * Useful for CI environments without API access.
   */
  readonly offline?: boolean | undefined;
  /**
   * Intent extraction strategy. (WI-022)
   *
   * @decision DEC-INTENT-STRATEGY-001
   * - "static" (default): TypeScript Compiler API + JSDoc parser. No network,
   *   no API key required. Offline-safe. Produces deterministic IntentCards.
   * - "llm": Anthropic API. Requires ANTHROPIC_API_KEY or a ctx.client.
   *   Subject to offline checks. Produces AI-written documentation fields.
   *
   * When omitted, defaults to "static".
   */
  readonly intentStrategy?: "static" | "llm" | undefined;
  /**
   * Tuning options forwarded to decompose() for the AST recursion.
   * maxDepth (default 8) and maxControlFlowBoundaries (default 1) control
   * when the recursion stops and what counts as atomic. WI-012-06.
   */
  readonly recursionOptions?:
    | {
        readonly maxDepth?: number;
        readonly maxControlFlowBoundaries?: number;
      }
    | undefined;
  /**
   * Controls how the pipeline reacts when a foreign-block dependency is
   * encountered during slicing.
   *
   *   'allow'  — foreign deps are silently accepted.
   *   'reject' — the pipeline throws when a foreign dep is found.
   *   'tag'    — foreign deps are accepted but tagged in slice plan output.
   *
   * Defaults to FOREIGN_POLICY_DEFAULT ('tag').
   * Authority invariant I-X3: all references to the default value import
   * FOREIGN_POLICY_DEFAULT from this module; no inline 'tag' literals elsewhere.
   */
  readonly foreignPolicy?: ForeignPolicy | undefined;

  /**
   * Controls whether the slicer applies the IR strict-subset predicate per-subgraph.
   *
   * @decision DEC-V2-07-PREFLIGHT-L8-003 (scope extension, WI-V2-07-PREFLIGHT-L8)
   * title: shaveMode is plumbed through ShaveOptions to the slicer (DEC-V2-GLUE-AWARE-SHAVE-001)
   * status: accepted
   * rationale:
   *   The slicer's shaveMode option existed only as a SliceOptions field, unreachable from
   *   universalize() or shave() callers. Plumbing it through ShaveOptions allows bootstrap
   *   to explicitly opt into glue-aware mode, which treats non-IR-valid subgraphs as
   *   GlueLeafEntry (verbatim-preserved, not registered) rather than throwing. This is
   *   the correct behavior for production bootstrap runs where some project-local code
   *   (e.g. *.props.ts fast-check arbitraries) contains constructs that are valid TS
   *   but not in the strict subset. Bootstrap defaults to 'glue-aware' per DEC-V2-07-PREFLIGHT-L8-003.
   *   The default 'strict' in SliceOptions is preserved for backward-compatibility of
   *   callers that use slice() directly.
   *
   *   - 'strict' (default): unmatched atoms become NovelGlueEntry regardless of IR validity.
   *     Preserves backward compatibility for direct universalize()/slice() callers.
   *   - 'glue-aware': atoms failing IR strict-subset validation become GlueLeafEntry
   *     (not registered); atoms passing become NovelGlueEntry (registered). Bootstrap
   *     uses this mode via bootstrap.ts passing shaveMode: 'glue-aware'.
   */
  readonly shaveMode?: "strict" | "glue-aware" | undefined;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Diagnostic information returned alongside every shave/universalize result.
 *
 * `stubbed` lists capabilities that are not yet implemented in this work item:
 *   - "decomposition": atom decomposition is a stub (WI-010-01; removed WI-012-06)
 *   - "variance": variance scoring is a stub (WI-011; pending WI-014)
 *   - "license-gate": license gating is a stub (WI-013-01; removed WI-013-02)
 *
 * `cacheHits` and `cacheMisses` count intent-extraction cache events.
 * Both will be 0 in WI-010-01 stubs; WI-010-02 populates them.
 */
export interface ShaveDiagnostics {
  readonly stubbed: readonly ("decomposition" | "variance" | "license-gate")[];
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

// ---------------------------------------------------------------------------
// Shave result types
// ---------------------------------------------------------------------------

/**
 * A stub placeholder for a decomposed atom within a source file.
 *
 * WI-012 replaces this with a real atom backed by a content-addressed
 * block in the registry. In WI-010-01 the atoms array is always empty.
 *
 * WI-014-03: merkleRoot is populated when the atom was persisted to the
 * registry as a novel block triplet. Absent for pointer atoms (which
 * already have an existing registry entry) and for atoms that were not
 * persisted (no storeBlock on the registry view, or no intentCard on the
 * entry).
 */
export interface ShavedAtomStub {
  /** A generated placeholder identifier for this atom position. */
  readonly placeholderId: string;
  /** Byte range within the source file that this atom covers. */
  readonly sourceRange: { readonly start: number; readonly end: number };
  /**
   * The BlockMerkleRoot of the persisted block, if this atom was stored in
   * the registry during the shave() call. Undefined for pointer atoms and
   * for atoms skipped by the persistence path (no storeBlock support or no
   * intentCard).
   */
  readonly merkleRoot?: BlockMerkleRoot | undefined;
}

/**
 * The result of a shave() call on a single source file.
 *
 * In WI-010-01 all arrays are empty stubs. WI-010-02 populates intentCards
 * via the real extractIntent path; WI-012 populates atoms via the DFG slicer.
 */
export interface ShaveResult {
  /** Absolute path of the source file that was processed. */
  readonly sourcePath: string;
  /** Decomposed atom stubs — empty until WI-012. */
  readonly atoms: readonly ShavedAtomStub[];
  /** Extracted intent cards — empty until WI-010-02. */
  readonly intentCards: readonly IntentCard[];
  /** Diagnostic information about the processing run. */
  readonly diagnostics: ShaveDiagnostics;
}

// ---------------------------------------------------------------------------
// Universalize result types
// ---------------------------------------------------------------------------

/**
 * One entry in the slice plan produced by universalize().
 *
 * WI-012-06 wires universalize() to the real DFG slicer. This is a type alias
 * for SlicePlanEntry (PointerEntry | NovelGlueEntry), keeping the public
 * surface aligned with the slicer's discriminated union while letting callers
 * import UniversalizeSlicePlanEntry from the top-level types path.
 *
 * @decision DEC-UNIVERSALIZE-WIRING-001
 * title: UniversalizeSlicePlanEntry aliased to SlicePlanEntry
 * status: decided
 * rationale: The WI-010-01 placeholder shape ({ placeholderId, sourceRange })
 * was superseded by the slicer's PointerEntry | NovelGlueEntry discriminated
 * union (WI-012-05). Re-exporting SlicePlanEntry as UniversalizeSlicePlanEntry
 * avoids two parallel types describing the same thing and keeps the public API
 * surface stable without requiring callers to import from the sub-module path.
 */
export type UniversalizeSlicePlanEntry = SlicePlanEntry;

/**
 * The result of a universalize() call on a single candidate block.
 *
 * The intentCard is the primary output — it describes the behavioral intent
 * of the candidate. slicePlan is populated by WI-012-06 via the real DFG
 * slicer. matchedPrimitives carries the deduplicated (canonicalAstHash,
 * merkleRoot) pairs from the slicer. Variance-based matching (WI-011) is
 * still stubbed and listed in diagnostics.stubbed.
 */
export interface UniversalizeResult {
  /** The extracted intent card for this candidate. */
  readonly intentCard: IntentCard;
  /** DFG-based slice plan — live as of WI-012-06. */
  readonly slicePlan: readonly SlicePlanEntry[];
  /**
   * Registry primitives matched by canonical AST hash — populated by WI-012-06.
   * Each entry carries (canonicalAstHash, merkleRoot) from the slicer's
   * PointerEntry nodes. Variance-scored matches (specHash) are WI-011.
   */
  readonly matchedPrimitives: readonly {
    readonly canonicalAstHash: CanonicalAstHash;
    readonly merkleRoot: BlockMerkleRoot;
  }[];
  /**
   * The license detection result for the candidate's source — populated by
   * WI-013-02. The gate ran against this detection before intent extraction;
   * callers can introspect what signal was found.
   */
  readonly licenseDetection: LicenseDetection;
  readonly diagnostics: ShaveDiagnostics;
}

// ---------------------------------------------------------------------------
// Candidate block
// ---------------------------------------------------------------------------

/**
 * A candidate block submitted for universalization.
 *
 * `source` is the raw source text. `hint` carries optional metadata that
 * hooks or callers may supply to improve extraction quality — it is never
 * required for correctness.
 */
export interface CandidateBlock {
  readonly source: string;
  readonly hint?:
    | {
        readonly name?: string | undefined;
        readonly origin?: "user" | "ai-hook" | "compile-resolver" | undefined;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Registry view — narrow read-only interface for shave operations
// ---------------------------------------------------------------------------

/**
 * The minimal read interface that shave() and universalize() require from the
 * registry. This is intentionally narrower than @yakcc/registry's full Registry
 * interface to keep the shave package decoupled from the SQLite storage layer.
 *
 * findByCanonicalAstHash is optional: shave uses it for structural deduplication
 * when available but degrades gracefully to spec-hash-only lookup otherwise.
 *
 * storeBlock is optional (WI-014-03): when present, shave() persists NovelGlueEntry
 * atoms that carry an intentCard. Callers that pass a full Registry automatically
 * satisfy this interface. Callers with a read-only stub leave it undefined and
 * persistence is silently skipped (graceful degradation, matching the
 * findByCanonicalAstHash? pattern).
 */
export interface ShaveRegistryView {
  selectBlocks(specHash: SpecHash): Promise<readonly BlockMerkleRoot[]>;
  getBlock(merkleRoot: BlockMerkleRoot): Promise<BlockTripletRow | undefined>;
  findByCanonicalAstHash?(canonicalAstHash: string): Promise<readonly BlockMerkleRoot[]>;
  /**
   * Optional: store a block triplet row. When present, shave() calls this for
   * each novel atom it persists. When absent, persistence is silently skipped.
   */
  storeBlock?(row: BlockTripletRow): Promise<void>;
}

// ---------------------------------------------------------------------------
// Intent extraction hook interface
// ---------------------------------------------------------------------------

/**
 * A hookable extension point for the intent-extraction pipeline.
 *
 * Hooks intercept CandidateBlock instances before the default Anthropic
 * extractor runs. A hook may return a fully-populated UniversalizeResult
 * (short-circuiting the default extractor) or may mutate the candidate and
 * pass it on.
 *
 * DEC-CONTINUOUS-SHAVE-022: hooks participate in the continuous universalizer
 * loop so that third-party packages can inject specialized extractors (e.g.
 * for specific DSLs or test frameworks) without forking the shave package.
 */
export interface IntentExtractionHook {
  /** Unique identifier for this hook, e.g. "yakcc.shave.default". */
  readonly id: string;
  intercept(
    candidate: CandidateBlock,
    registry: ShaveRegistryView,
    options?: ShaveOptions,
  ): Promise<UniversalizeResult>;
}
