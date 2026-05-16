// SPDX-License-Identifier: MIT
// @decision DEC-WI508-INTERCEPT-001
// title: import-intercept scan -- AST-based pre-emit foreign import detection
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   scanImportsForIntercept() uses ts-morph in-memory parsing to extract non-builtin
//   external imports from emitted code. It mirrors the classifyForeign() discipline
//   from packages/shave/src/universalize/slicer.ts with one deliberate divergence:
//   classifyForeign() classifies "node:" builtins as FOREIGN (to track them as
//   opaque dependencies), whereas this module SKIPS them (excludes them from
//   intercept candidates). The divergence is intentional -- the import-intercept goal
//   is to surface npm packages for which the registry has coverage; node: built-ins
//   have no registry coverage and must never be intercepted. All other classification
//   rules (type-only, relative, @yakcc/ workspace, bare Node core modules) are
//   mirrored exactly. Only Slice 1 allowlist ("validator") is intercepted. All other
//   foreign imports are logged to importedDynamic (for future slices) without
//   triggering intercept.

// @decision DEC-WI508-INTERCEPT-002
// title: CONFIDENT_THRESHOLD (0.70) reused as intercept threshold
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   yakccResolve() returns status: "matched" when the top candidate combinedScore >= 0.70
//   (CONFIDENT_THRESHOLD from yakcc-resolve.ts). The intercept fires only on "matched"
//   status -- consistent with the D3 4-band table. No second threshold knob is introduced.

// @decision DEC-WI508-INTERCEPT-003
// title: YAKCC_HOOK_DISABLE_SUBSTITUTE=1 disables import-intercept (no second knob)
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   The disable knob is the existing YAKCC_HOOK_DISABLE_SUBSTITUTE env var. Adding a
//   second knob would create two authorities for the same "disable all yakcc hook enrichment"
//   intent. The import-intercept is an additive enrichment path -- if the caller disables
//   substitution they are signaling they want raw passthrough, and intercept must respect that.

// @decision DEC-WI508-INTERCEPT-004
// title: Observe-don't-mutate -- intercept failure returns base response unchanged
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   Any failure in scanImportsForIntercept(), yakccResolve(), or result mapping must not
//   change the hook's response. The try/catch in applyImportIntercept() wraps the entire
//   intercept path and returns the base HookResponseWithSubstitution unchanged on any error.
//   This preserves Phase 1/2/3 semantics for all existing callers.

// @decision DEC-WI508-INTERCEPT-005
// title: SLICE1_INTERCEPT_ALLOWLIST restricts intercept to "validator" in Slice 1
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   Slice 1 is a mechanism proof. Intercepting all foreign imports in production before
//   the registry has coverage would produce false positives. An allowlist-of-one ("validator")
//   scopes the live intercept to packages for which seed atoms exist. Future slices can
//   expand the allowlist or replace it with a coverage-query against the registry.

// @decision DEC-WI508-INTERCEPT-006
// title: additive branch runs after substitution and atomize in executeRegistryQueryWithSubstitution
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   The import-intercept is the fourth additive branch in executeRegistryQueryWithSubstitution()
//   (after registry-hit, substitution, and atomize). It runs only when substituted=false and
//   atomize did not fire. This preserves all earlier response paths and makes the intercept
//   branch reachable only for raw passthrough emissions.

// @decision DEC-WI508-INTERCEPT-TSMORPH-DEP-001
// title: ts-morph is a direct dependency of @yakcc/hooks-base
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   import-intercept needs AST-level parsing of import statements to correctly
//   classify type-only specifiers and namespace imports. ts-morph is already used
//   across the workspace (shave, compile) and its in-memory Project API is the
//   lowest-friction way to parse TS/TSX without a tsconfig. Accepting it as a direct
//   dep is lower cost than reimplementing AST parsing or vendoring a lighter parser.
//   Cross-reference EC §4.6.11.

// @decision DEC-WI508-INTERCEPT-DYNAMIC-LIMITATION-001
// title: Slice 1 covers static ImportDeclaration nodes only -- dynamic import() not intercepted
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   ts-morph getImportDeclarations() returns only static import ... from "..." declarations.
//   Dynamic import("...") call expressions are CallExpression AST nodes and are invisible
//   to getImportDeclarations(). Intercepting CallExpression-based dynamic imports is
//   deferred to a future slice. Static ImportDeclaration coverage is sufficient for the
//   Slice 1 mechanism proof. Off-allowlist bindings (including those that could correspond
//   to dynamic imports in the same file) are logged to importedDynamic for telemetry.

// @decision DEC-WI508-S2-ASYNC-BACKGROUND-001
// title: Miss branch wires applyShaveOnMiss() for background shave-on-miss (Slice 2)
// status: decided (WI-508 Slice 2)
// rationale:
//   When intercept candidates exist but none matched (miss), Slice 2 enqueues a background
//   shave for each missing binding via applyShaveOnMiss(). The response is enriched with
//   shaveOnMissEnqueued=true on the per-binding ImportInterceptResult. importInterceptResults
//   is now included even when intercepted=false (when shaveOnMissEnqueued=true), making the
//   side-effect observable on the first-occurrence response.
//   The observe-don't-mutate envelope (DEC-WI508-INTERCEPT-004) is preserved: the base
//   response kind is unchanged; only shave-on-miss is fired as a side effect.

import type { QueryIntentCard } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
// @decision DEC-WI508-INTERCEPT-TSMORPH-DEP-001
import { Project, ScriptKind } from "ts-morph";
import {
  BARE_NODE_CORE_MODULES,
  NODE_BUILTIN_PREFIX,
  WORKSPACE_PREFIX,
  extractBareName,
} from "./import-classifier.js";
import type { EmissionContext } from "./index.js";
import type { HookResponseWithSubstitution } from "./index.js";
import type { ShaveOnMissResult } from "./shave-on-miss.js";
import { CONFIDENT_THRESHOLD, yakccResolve } from "./yakcc-resolve.js";

// Classification constants and extractBareName are in the shared classifier module.
// DEC-WI508-INTERCEPT-CLASSIFIER-SHARED-001

/**
 * Slice 1 intercept allowlist.
 * Only imports whose module name matches an entry here will trigger a registry query.
 * "validator" is the seed package for Slice 1 mechanism proof.
 * Expand in future slices or replace with coverage query against the registry.
 * DEC-WI508-INTERCEPT-005.
 */
export const SLICE1_INTERCEPT_ALLOWLIST = new Set(["validator"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single foreign import binding extracted from emitted code.
 */
export interface ImportBinding {
  /** Module specifier (e.g. "validator", "zod", "express"). */
  readonly moduleSpecifier: string;
  /** Named imports (may be empty when only default or namespace import). */
  readonly namedImports: readonly string[];
  /** Default import alias (e.g. "validator" for "import validator from ..."). */
  readonly defaultImport: string | null;
  /** Namespace import alias (e.g. "v" for "import * as v from ..."). */
  readonly namespaceImport: string | null;
}

/**
 * A candidate for import-intercept: a foreign binding that is on the Slice 1
 * allowlist and for which a registry query is warranted.
 */
export interface InterceptCandidate {
  readonly binding: ImportBinding;
  /** The intent card constructed from this binding for yakccResolve(). */
  readonly intentCard: QueryIntentCard;
}

/**
 * Result of scanImportsForIntercept(): classified foreign import bindings.
 */
export interface ImportScanResult {
  /** Imports that are on SLICE1_INTERCEPT_ALLOWLIST and will be queried. */
  readonly interceptCandidates: readonly InterceptCandidate[];
  /** Foreign imports outside the allowlist (for future slices / telemetry). */
  readonly importedDynamic: readonly ImportBinding[];
}

/**
 * Result of runImportIntercept() for a single candidate.
 *
 * Slice 2 adds shaveOnMissEnqueued (DEC-WI508-S2-RESPONSE-ENRICH-ADDITIVE-001):
 * when intercepted=false and a background shave was enqueued, this field is true.
 * Additive and backward-compatible -- Slice 1 consumers see it as undefined.
 */
export interface ImportInterceptResult {
  readonly binding: ImportBinding;
  /**
   * Whether a confident registry match was found.
   * true  => yakccResolve returned status "matched" (score >= CONFIDENT_THRESHOLD 0.70)
   * false => no match or weak_only
   */
  readonly intercepted: boolean;
  /** The top candidate's address when intercepted=true, otherwise null. */
  readonly address: string | null;
  /** The top candidate's behavior description when intercepted=true, otherwise null. */
  readonly behavior: string | null;
  /** The top candidate's score when intercepted=true, otherwise null. */
  readonly score: number | null;
  /**
   * Whether a background shave-on-miss was enqueued for this binding (Slice 2).
   *
   * @decision DEC-WI508-S2-RESPONSE-ENRICH-ADDITIVE-001
   * Additive field: present when intercepted=false and applyShaveOnMiss() enqueued
   * a background shave. Undefined when intercepted=true (no miss-path invoked) or
   * when the miss path was not reached (Slice 1 callers, empty registry, etc.).
   * Backward-compatible: Slice 1 consumers see this as undefined.
   */
  readonly shaveOnMissEnqueued?: boolean;
  /**
   * Layer 1 intent-specificity reject envelope for this binding (wi-579 S1).
   *
   * @decision DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001
   * Present when Layer 1 rejected the enriched behavior string for this binding,
   * causing yakccResolve to be skipped entirely for the binding.
   * intercepted is false when this field is present.
   * Backward-compatible: consumers that predate wi-579 S1 see this as undefined.
   */
  readonly intentSpecificity?: import("./enforcement-types.js").IntentRejectEnvelope;
}

// ---------------------------------------------------------------------------
// Import scanner
// ---------------------------------------------------------------------------

/**
 * Parse emitted TypeScript/JavaScript source and extract foreign import bindings.
 *
 * Classification mirrors classifyForeign() from slicer.ts (DEC-WI508-INTERCEPT-001):
 *   - type-only imports are skipped (no runtime dependency)
 *   - relative imports (start with ".") are skipped (intra-package)
 *   - node: builtins are skipped
 *   - bare Node core module names are skipped
 *   - @yakcc/ workspace imports are skipped
 *   - everything else is a foreign import binding
 *
 * Returns an ImportScanResult partitioned into interceptCandidates (on allowlist)
 * and importedDynamic (off allowlist, logged for future use).
 *
 * @param source - The emitted TypeScript or JavaScript source code.
 */
export function scanImportsForIntercept(source: string): ImportScanResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true },
  });

  const sourceFile = project.createSourceFile("__scan__.ts", source, {
    scriptKind: ScriptKind.TSX,
  });

  const interceptCandidates: InterceptCandidate[] = [];
  const importedDynamic: ImportBinding[] = [];

  for (const decl of sourceFile.getImportDeclarations()) {
    // Skip type-only imports -- no runtime dependency
    if (decl.isTypeOnly()) continue;

    const spec = decl.getModuleSpecifierValue();

    // Skip relative imports (intra-package)
    if (spec.startsWith(".")) continue;

    // Skip node: builtins
    if (spec.startsWith(NODE_BUILTIN_PREFIX)) continue;

    // Skip @yakcc/ workspace imports
    if (spec.startsWith(WORKSPACE_PREFIX)) continue;

    // Extract the bare package name (strip @scope/ prefix and subpath)
    const bareName = extractBareName(spec);

    // Skip bare Node core modules
    if (BARE_NODE_CORE_MODULES.has(bareName)) continue;

    // Foreign import -- build binding.
    // Filter out inline type-only specifiers (e.g. "type T" in "import { type T, isEmail }").
    // isTypeOnly() returns true for specifiers with the inline "type" modifier.
    // This mirrors the classifyForeign() discipline: type-only bindings have no runtime
    // dependency and must not contribute to the intercept candidates.
    const namedImports = decl
      .getNamedImports()
      .filter((ni) => !ni.isTypeOnly())
      .map((ni) => ni.getName());

    const nsNode = decl.getNamespaceImport();
    const defNode = decl.getDefaultImport();

    const binding: ImportBinding = {
      moduleSpecifier: spec,
      namedImports,
      defaultImport: defNode !== undefined ? defNode.getText() : null,
      namespaceImport: nsNode !== undefined ? nsNode.getText() : null,
    };

    if (SLICE1_INTERCEPT_ALLOWLIST.has(bareName)) {
      const intentCard = buildImportIntentCard(binding);
      interceptCandidates.push({ binding, intentCard });
    } else {
      importedDynamic.push(binding);
    }
  }

  return { interceptCandidates, importedDynamic };
}

// ---------------------------------------------------------------------------
// Intent card construction
// ---------------------------------------------------------------------------

/**
 * Build a QueryIntentCard for a foreign import binding.
 *
 * The behavior field describes what the import is used for based on the
 * module name and imported symbols. This is used as the query for yakccResolve().
 *
 * @param binding - The foreign import binding.
 */
export function buildImportIntentCard(binding: ImportBinding): QueryIntentCard {
  const { moduleSpecifier, namedImports, defaultImport, namespaceImport } = binding;

  // Build a behavior string from the import shape
  let usageHint: string;

  if (namedImports.length > 0) {
    usageHint = namedImports.slice(0, 3).join(", ");
    if (namedImports.length > 3) {
      usageHint += ", ...";
    }
  } else if (defaultImport !== null) {
    usageHint = defaultImport;
  } else if (namespaceImport !== null) {
    usageHint = namespaceImport;
  } else {
    usageHint = moduleSpecifier;
  }

  const behavior = `${moduleSpecifier} -- ${usageHint}`;

  return { behavior };
}

// ---------------------------------------------------------------------------
// Registry query + intercept decision
// ---------------------------------------------------------------------------

/**
 * Run the registry query for a list of intercept candidates.
 *
 * For each candidate on the Slice 1 allowlist, calls yakccResolve() and
 * maps the result to an ImportInterceptResult:
 *   - intercepted=true when status === "matched" (score >= CONFIDENT_THRESHOLD 0.70)
 *   - intercepted=false otherwise
 *
 * Registry query failures are caught and produce intercepted=false (DEC-WI508-INTERCEPT-004).
 *
 * @param candidates - Candidates from scanImportsForIntercept().
 * @param registry   - Registry instance.
 * @param ctx        - Emission context (for intent enrichment).
 */
export async function runImportIntercept(
  candidates: readonly InterceptCandidate[],
  registry: Registry,
  ctx: EmissionContext,
): Promise<readonly ImportInterceptResult[]> {
  const results: ImportInterceptResult[] = [];

  for (const candidate of candidates) {
    try {
      // Enrich the intent card with the emission context when available
      const enrichedCard: QueryIntentCard =
        ctx.intent.length > 0
          ? { behavior: `${candidate.intentCard.behavior} for: ${ctx.intent}` }
          : candidate.intentCard;

      // -----------------------------------------------------------------------
      // Layer 1 — intent specificity gate (wi-579 S1, DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001)
      // Gate the enriched behavior before calling yakccResolve. On reject, skip the
      // registry query for this binding and surface the envelope on the result.
      // No escape hatch here — applyImportIntercept already checks
      // YAKCC_HOOK_DISABLE_SUBSTITUTE; if that is set, we never reach this loop.
      //
      // enrichedCard.behavior is QueryIntentCard.behavior (string | undefined).
      // Fall back to empty string when undefined — scoreIntentSpecificity rejects
      // empty strings with too_short, preserving the conservative gate behavior.
      // -----------------------------------------------------------------------
      const { scoreIntentSpecificity } = await import("./intent-specificity.js");
      const behaviorText = enrichedCard.behavior ?? "";
      const intentCheck = scoreIntentSpecificity(behaviorText);
      if (intentCheck.status === "intent_too_broad") {
        results.push({
          binding: candidate.binding,
          intercepted: false,
          address: null,
          behavior: null,
          score: null,
          intentSpecificity: intentCheck,
        });
        continue; // skip yakccResolve for this binding
      }

      const resolveResult = await yakccResolve(registry, enrichedCard);

      const intercepted = resolveResult.status === "matched";
      const top = resolveResult.candidates[0];

      // -----------------------------------------------------------------------
      // Layer 4 — descent-depth tracking (wi-592 S4, DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001)
      // Record miss or hit per binding so substitute.ts can read descent depth
      // at substitution time. Failures are swallowed (observe-don't-mutate).
      // -----------------------------------------------------------------------
      try {
        const { recordMiss: l4RecordMiss, recordHit: l4RecordHit } = await import("./descent-tracker.js");
        const bindingName =
          candidate.binding.namedImports[0] ??
          candidate.binding.defaultImport ??
          candidate.binding.moduleSpecifier;
        if (intercepted) {
          l4RecordHit(candidate.binding.moduleSpecifier, bindingName);
        } else {
          l4RecordMiss(candidate.binding.moduleSpecifier, bindingName);
        }
      } catch {
        // Tracking failure must not affect the hook path.
      }

      results.push({
        binding: candidate.binding,
        intercepted,
        address: intercepted && top !== undefined ? top.address : null,
        behavior: intercepted && top !== undefined ? top.behavior : null,
        score: intercepted && top !== undefined ? top.score : null,
      });
    } catch {
      // Registry query failure must not affect hook outcome (DEC-WI508-INTERCEPT-004)
      results.push({
        binding: candidate.binding,
        intercepted: false,
        address: null,
        behavior: null,
        score: null,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Log-only path for dynamic imports outside allowlist
// ---------------------------------------------------------------------------

/**
 * Log dynamic (off-allowlist) imports to a telemetry-ready structure.
 * This is a no-op in Slice 1 -- the bindings are captured in ImportScanResult.importedDynamic
 * but not queried against the registry. Future slices can expand this path.
 *
 * DEC-WI508-INTERCEPT-005.
 *
 * @param _bindings - Off-allowlist foreign import bindings (unused in Slice 1).
 */
export function _logDynamicImports(_bindings: readonly ImportBinding[]): void {
  // Intentionally no-op in Slice 1. Captured in ImportScanResult.importedDynamic.
  // Future slices: emit telemetry for off-allowlist imports to measure coverage gaps.
}

// ---------------------------------------------------------------------------
// Additive integration point
// ---------------------------------------------------------------------------

/**
 * Apply import-intercept enrichment to a base HookResponseWithSubstitution.
 *
 * This is the primary integration point called from executeRegistryQueryWithSubstitution()
 * in index.ts (DEC-WI508-INTERCEPT-006). It is ADDITIVE -- it never changes the
 * response kind (registry-hit | synthesis-required | passthrough) and returns the
 * base response unchanged on any error (DEC-WI508-INTERCEPT-004).
 *
 * Called only when:
 *   - YAKCC_HOOK_DISABLE_SUBSTITUTE != "1" (DEC-WI508-INTERCEPT-003)
 *   - substituted === false (Phase 2 substitution did not fire)
 *   - atomize did not produce atomizedCode (Phase 3 did not fire)
 *   - emittedCode.trim().length > 0
 *
 * Sequence (Slice 2 extension, DEC-WI508-S2-ASYNC-BACKGROUND-001):
 *   1. scanImportsForIntercept(emittedCode) -- extract foreign import bindings
 *   2. If no interceptCandidates, return base response unchanged
 *   3. runImportIntercept(candidates, registry, ctx) -- query registry per candidate
 *   4. If any intercepted=true, attach importInterceptResults to the response
 *   5. [NEW Slice 2] If no intercepted=true (miss), call applyShaveOnMiss() for each
 *      candidate's first named binding. Attach importInterceptResults with
 *      shaveOnMissEnqueued=true for enqueued bindings.
 *   6. On any error, return base response unchanged
 *
 * @param base        - The base HookResponseWithSubstitution from substitution/atomize pass.
 * @param emittedCode - The agent's emitted source code.
 * @param ctx         - Emission context (intent + optional sourceContext).
 * @param registry    - Registry instance.
 */
export async function applyImportIntercept(
  base: HookResponseWithSubstitution,
  emittedCode: string,
  ctx: EmissionContext,
  registry: Registry,
): Promise<HookResponseWithSubstitution> {
  // Disable knob check (DEC-WI508-INTERCEPT-003)
  if (process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE === "1") {
    return base;
  }

  if (emittedCode.trim().length === 0) {
    return base;
  }

  try {
    const scanResult = scanImportsForIntercept(emittedCode);

    // Log dynamic imports (off-allowlist) -- no-op in Slice 1
    _logDynamicImports(scanResult.importedDynamic);

    if (scanResult.interceptCandidates.length === 0) {
      return base;
    }

    const interceptResults = await runImportIntercept(
      scanResult.interceptCandidates,
      registry,
      ctx,
    );

    const anyIntercepted = interceptResults.some((r) => r.intercepted);

    if (anyIntercepted) {
      // Matched branch: attach intercept results additively -- base response kind is unchanged.
      // The cast is safe: base.substituted is false at this call site.
      //
      // WI-508 Slice 3: record registry hits for skip-shave heuristic.
      // DEC-WI508-S3-SKIP-HIT-THRESHOLD-001: hit count drives skip-shave on subsequent misses.
      for (const result of interceptResults) {
        if (result.intercepted) {
          const bindingName =
            result.binding.namedImports[0] ??
            result.binding.defaultImport ??
            result.binding.moduleSpecifier;
          try {
            const { recordImportHit } = await import("./shave-on-miss-state.js");
            recordImportHit(result.binding.moduleSpecifier, bindingName);
          } catch {
            // Hit recording failure must not affect the hook path (observe-don't-mutate).
          }
        }
      }
      return {
        ...base,
        importInterceptResults: interceptResults,
      } as HookResponseWithSubstitution;
    }

    // -- Slice 2 miss branch (DEC-WI508-S2-ASYNC-BACKGROUND-001) -----------------
    // No candidates matched. Enqueue background shave for each missed binding.
    // applyShaveOnMiss() returns immediately (never blocks emission).
    // DEC-WI508-S2-REGISTRY-IS-CANONICAL-001: same registry instance used for both paths.
    // DEC-WI508-INTERCEPT-004: if shave-on-miss itself fails, it's caught inside
    //   applyShaveOnMiss() — the observe-don't-mutate envelope is preserved at both levels.

    const { applyShaveOnMiss } = await import("./shave-on-miss.js");

    // Enrich each missed result with shaveOnMissEnqueued.
    // anyEntryResolved tracks whether any binding had a corpus entry (resolved path).
    // When entryResolved=false for all (corpus not found), return base unchanged to
    // preserve pre-Slice-2 behavior for callers without the corpus installed.
    // When entryResolved=true for at least one, attach enrichedResults so callers
    // can observe the miss-path status (enqueued/already-queued/completed).
    // DEC-WI508-S2-ASYNC-BACKGROUND-001.
    const enrichedResults: ImportInterceptResult[] = [];
    let anyEntryResolved = false;

    for (const result of interceptResults) {
      if (!result.intercepted) {
        // Take the first named binding as the per-binding shave target.
        const bindingName =
          result.binding.namedImports[0] ??
          result.binding.defaultImport ??
          result.binding.moduleSpecifier;

        let missResult: ShaveOnMissResult;
        try {
          missResult = applyShaveOnMiss(
            result.binding.moduleSpecifier,
            bindingName,
            ctx,
            registry,
          );
        } catch {
          // applyShaveOnMiss failure must not affect hook outcome (DEC-WI508-INTERCEPT-004)
          missResult = { shaveOnMissEnqueued: false, entryResolved: false, atomsCreated: [] };
        }

        if (missResult.entryResolved) {
          anyEntryResolved = true;
        }

        enrichedResults.push({
          ...result,
          shaveOnMissEnqueued: missResult.shaveOnMissEnqueued,
        });
      } else {
        enrichedResults.push(result);
      }
    }

    // Only attach importInterceptResults when the corpus was found for at least one binding.
    // When entryResolved=false for all (corpus not installed), return base unchanged.
    // DEC-WI508-INTERCEPT-004: observe-don't-mutate envelope preserved.
    if (!anyEntryResolved) {
      return base;
    }

    return {
      ...base,
      importInterceptResults: enrichedResults,
    } as HookResponseWithSubstitution;
  } catch {
    // Any failure returns base unchanged (DEC-WI508-INTERCEPT-004)
    return base;
  }
}

// Re-export CONFIDENT_THRESHOLD for consumers of this module
export { CONFIDENT_THRESHOLD };
