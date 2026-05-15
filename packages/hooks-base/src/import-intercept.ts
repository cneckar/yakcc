// SPDX-License-Identifier: MIT
// @decision DEC-WI508-INTERCEPT-001
// title: import-intercept scan -- AST-based pre-emit foreign import detection
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   scanImportsForIntercept() uses ts-morph in-memory parsing to extract non-builtin
//   external imports from emitted code. It mirrors the classifyForeign() discipline
//   from packages/shave/src/universalize/slicer.ts: skip type-only, relative, node:
//   builtins, bare Node core modules, and @yakcc/ workspace imports.
//   Only Slice 1 allowlist ("validator") is intercepted. All other foreign imports
//   are logged to importedDynamic (for future slices) without triggering intercept.

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

import { Project, ScriptKind } from "ts-morph";
import type { QueryIntentCard } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import type { EmissionContext } from "./index.js";
import type { HookResponseWithSubstitution } from "./index.js";
import { yakccResolve, CONFIDENT_THRESHOLD } from "./yakcc-resolve.js";

// ---------------------------------------------------------------------------
// Classification constants -- mirror classifyForeign() from slicer.ts
// ---------------------------------------------------------------------------

/** Prefix for Node built-in modules (e.g. "node:fs"). */
const NODE_BUILTIN_PREFIX = "node:";

/** Prefix for workspace-internal packages. */
const WORKSPACE_PREFIX = "@yakcc/";

/**
 * Bare Node core module names (without "node:" prefix).
 * Mirrors BARE_NODE_CORE_MODULES in packages/shave/src/universalize/slicer.ts.
 * Any divergence from slicer.ts is a bug -- tracked in DEC-WI508-INTERCEPT-001.
 */
const BARE_NODE_CORE_MODULES = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

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

    // Foreign import -- build binding
    const namedImports = decl
      .getNamedImports()
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
 * Extract the bare package name from a module specifier.
 * "@scope/pkg/subpath" => "pkg"
 * "pkg/subpath" => "pkg"
 * "pkg" => "pkg"
 */
function extractBareName(spec: string): string {
  if (spec.startsWith("@")) {
    // Scoped package: "@scope/name" or "@scope/name/subpath"
    const parts = spec.slice(1).split("/");
    return parts[1] ?? spec;
  }
  return spec.split("/")[0] ?? spec;
}

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
      const enrichedCard: QueryIntentCard = ctx.intent.length > 0
        ? { behavior: `${candidate.intentCard.behavior} for: ${ctx.intent}` }
        : candidate.intentCard;

      const resolveResult = await yakccResolve(registry, enrichedCard);

      const intercepted = resolveResult.status === "matched";
      const top = resolveResult.candidates[0];

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
 * Sequence:
 *   1. scanImportsForIntercept(emittedCode) -- extract foreign import bindings
 *   2. If no interceptCandidates, return base response unchanged
 *   3. runImportIntercept(candidates, registry, ctx) -- query registry per candidate
 *   4. If any intercepted=true, attach importInterceptResults to the response
 *   5. On any error, return base response unchanged
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

    if (!anyIntercepted) {
      return base;
    }

    // Attach intercept results additively -- base response kind is unchanged.
    // The cast is safe: base.substituted is false at this call site (applyImportIntercept
    // is only called from the substituted=false branch in executeRegistryQueryWithSubstitution).
    // importInterceptResults lives exclusively on the substituted:false union member.
    return {
      ...base,
      importInterceptResults: interceptResults,
    } as HookResponseWithSubstitution;
  } catch {
    // Any failure returns base unchanged (DEC-WI508-INTERCEPT-004)
    return base;
  }
}

// Re-export CONFIDENT_THRESHOLD for consumers of this module
export { CONFIDENT_THRESHOLD };