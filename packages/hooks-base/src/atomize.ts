// SPDX-License-Identifier: MIT
/**
 * atomize.ts — Auto-atomize novel LLM code emissions into the local registry.
 *
 * @decision DEC-HOOK-ATOM-CAPTURE-001
 * @title Bidirectional hook design: substitute (read) + atomize (write)
 * @status accepted (WI-V0-HOOK-ATOM-CAPTURE, issue #362)
 * @rationale
 *   The hook layer was previously read-only from the corpus perspective: it could
 *   substitute existing atoms but could never contribute new ones. This WI adds the
 *   write half. Every intercepted tool call now either:
 *     (A) Substitutes an existing atom (Phase 2 path, DEC-HOOK-PHASE-2-001), OR
 *     (B) Atomizes the emission — runs it through the shave pipeline and stores the
 *         result in the local registry so future sessions discover it via the
 *         discovery query (this module), OR
 *     (C) Passes through unchanged (non-atom-shaped emissions).
 *
 *   This closes the "every session grows the corpus" thesis from the operator
 *   decision recorded in issue #362. Without this, discovery surfaces only what
 *   was bulk-shaved upfront; sessions never contribute back.
 *
 * SHAPE FILTER (per spec shape table, issue #362):
 *   YES:   Exported function with JSDoc → proceed to atomize
 *   MAYBE: Exported function without JSDoc → atomize with inferred IntentCard
 *          from name + signature; return reason "no-jsdoc" if skipOnNoJsdoc=true
 *   NO:    Inner functions, arrow-expressions, test files (*.test.ts / *.spec.ts),
 *          type-only emissions, trivial bodies (<3 statements), hook subprocess ctx
 *
 *   Trivial body threshold: 3 statements (non-blank, non-comment lines in body).
 *   Rationale: a function body with fewer than 3 statements is a trivial wrapper
 *   not worth registry weight (e.g. `return a + b`, `return obj.field`).
 *
 * LICENSE POLICY (per spec edge case #1):
 *   - SPDX header present → use it as-is.
 *   - SPDX header absent → auto-prepend `// SPDX-License-Identifier: MIT`.
 *     v0 always defaults to MIT; future `.yakccrc.json` override deferred.
 *   - GPL / AGPL license detected → refuse with reason "license-missing".
 *     shave's licenseGate() throws / rejects copyleft; we catch and return the reason.
 *
 * DEDUP POLICY (per spec edge case #3):
 *   INSERT OR IGNORE in registry.storeBlock() makes idempotent stores safe. Calling
 *   atomizeEmission with the same code twice produces the same BlockMerkleRoot on
 *   both calls; the second storeBlock is a no-op. No error.
 *
 * LOCAL-ONLY (v0):
 *   All stores go to the local registry only. Federation deferred to a future WI.
 *   atomizeEmission makes ZERO outbound network calls — shave uses the "static"
 *   strategy which is pure AST analysis (no Anthropic API, no HTTP). B6 preserved.
 *
 * PIPELINE (WI-424):
 *   atomizeEmission → licenseGate (from @yakcc/shave) → universalize({persist:true})
 *   → iterate NovelGlueEntry items in slicePlan (merkleRoot populated by universalize)
 *
 *   WI-424 (DEC-V2-ATOMIZE-DELEGATES-UNIVERSALIZE-001): the inline buildBlockRow +
 *   registry.storeBlock loop is removed. universalize({persist:true}) is now the
 *   single authority for atom persistence (Sacred Practice #12), mirroring the
 *   WI-423 delegation pattern applied to shave() (PR #431).
 *
 * Cross-reference: DEC-HOOK-PHASE-2-001, DEC-HOOK-PHASE-1-001, DEC-HOOK-LAYER-001,
 *   docs/adr/hook-layer-architecture.md D-HOOK-7.
 */

import type { Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input to atomizeEmission().
 */
export interface AtomizeInput {
  /** Raw LLM emission text (the code written by the agent). */
  readonly emittedCode: string;
  /** Claude Code tool that triggered this intercept. */
  readonly toolName: "Edit" | "Write" | "MultiEdit";
  /** Registry instance to store the resulting atom into. */
  readonly registry: Registry;
  /**
   * When true, exported functions without JSDoc are NOT atomized.
   * Returns atomized=false with reason="no-jsdoc".
   * Default: false (MAYBE shape is atomized with an inferred IntentCard).
   */
  readonly skipOnNoJsdoc?: boolean | undefined;
  /**
   * File path hint for test-file detection (*.test.ts, *.spec.ts).
   * When provided and matches the pattern, the emission is rejected.
   */
  readonly filePath?: string | undefined;
}

/**
 * Result of atomizeEmission().
 */
export interface AtomizeResult {
  /** Whether atomization succeeded and produced at least one atom. */
  readonly atomized: boolean;
  /**
   * Atoms created during this atomize call.
   * Non-empty only when atomized === true.
   */
  readonly atomsCreated: ReadonlyArray<{
    readonly blockMerkleRoot: string;
    readonly atomName: string;
    readonly spec: { readonly name: string; readonly behavior: string };
  }>;
  /**
   * Reason for NOT atomizing (when atomized === false).
   * Per the spec shape table and edge case decisions (issue #362).
   */
  readonly reason?:
    | "not-exported-function"
    | "no-jsdoc"
    | "inner-scope"
    | "test-file"
    | "type-only"
    | "trivial-body"
    | "shave-rejected"
    | "license-missing"
    | undefined;
}

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

/**
 * Minimum statement count in a function body to qualify as non-trivial.
 *
 * @decision DEC-HOOK-ATOM-CAPTURE-001 (trivial-body threshold)
 * A body with fewer than 3 non-blank, non-comment lines is considered trivial
 * and not worth registry weight. Threshold covers single-expression wrappers
 * (1 line) and simple two-liner pass-throughs. Functions with 3+ meaningful
 * lines have genuine logic worth atomizing.
 */
const TRIVIAL_BODY_THRESHOLD = 3;

/**
 * Whether the emitted code is from a test file (by filePath hint or content).
 */
function isTestEmission(code: string, filePath: string | undefined): boolean {
  if (filePath !== undefined && /\.(test|spec)\.[jt]sx?$/.test(filePath)) {
    return true;
  }
  // Content heuristic: test-framework API calls.
  return /(?:^|\s)(?:describe|it|test|expect|beforeEach|afterEach|beforeAll|afterAll)\s*\(/.test(
    code,
  );
}

/**
 * Result of detectFunctionShape().
 */
type FunctionShape =
  | "exported-with-jsdoc"
  | "exported-no-jsdoc"
  | "not-exported"
  | "no-function"
  | "inner-scope"
  | "type-only";

/**
 * Heuristic (regex-based, no AST) shape detector for a code emission.
 *
 * Conservative: false negatives (skipping an atomizable function) are preferred
 * over false positives (atomizing non-atom-shaped code that breaks shave).
 */
function detectFunctionShape(code: string): FunctionShape {
  const lines = code.split("\n");
  const trimmed = lines.map((l) => l.trim());

  // Find the first function declaration line.
  const fnLineIdx = trimmed.findIndex(
    (l) =>
      /^export\s+(async\s+)?function\s+\w/.test(l) ||
      /^(async\s+)?function\s+\w/.test(l),
  );

  if (fnLineIdx === -1) {
    // No function declaration — check for type-only content.
    const hasTypeDecl = trimmed.some(
      (l) =>
        /^export\s+type\s+/.test(l) ||
        /^export\s+interface\s+/.test(l) ||
        /^type\s+\w/.test(l) ||
        /^interface\s+\w/.test(l),
    );
    return hasTypeDecl ? "type-only" : "no-function";
  }

  const fnLine = trimmed[fnLineIdx] ?? "";

  // Check for inner-scope: open braces before the function line indicate nesting.
  if (!/^export\s+/.test(fnLine)) {
    const before = lines.slice(0, fnLineIdx).join("\n");
    const opens = (before.match(/\{/g) ?? []).length;
    const closes = (before.match(/\}/g) ?? []).length;
    if (opens > closes) return "inner-scope";
    return "not-exported";
  }

  // Exported function — scan backwards for JSDoc.
  for (let i = fnLineIdx - 1; i >= 0; i--) {
    const l = trimmed[i] ?? "";
    if (l === "") continue;
    if (l.endsWith("*/")) return "exported-with-jsdoc";
    // Non-JSDoc lines immediately before the function → no JSDoc.
    break;
  }
  return "exported-no-jsdoc";
}

/**
 * Count non-blank, non-comment lines in the outermost function body.
 * Used for trivial-body detection.
 *
 * @decision DEC-HOOK-ATOM-CAPTURE-002
 * @title JSDoc comment stripping before body-locator string-scan
 * @status accepted (issue #383)
 * @rationale
 *   The original implementation found the first `{` in the raw source string,
 *   which caused JSDoc tags like `@throws {RangeError}`, `@returns {Promise<T>}`,
 *   `@param {number} n`, and `@type {string}` to be mistaken for the function
 *   body opener. The fix strips all block JSDoc comments (`/** ... *\/`) before
 *   the scan, then locates the first `{` in the comment-free code. This is the
 *   preferred approach over full AST parsing because:
 *     (a) ts-morph is NOT a direct dependency of @yakcc/hooks-base (would balloon scope)
 *     (b) JSDoc block comments have a fixed shape `/** ... *\/` — the regex is robust
 *     (c) Strip-then-scan preserves line/offset fidelity for statement counting
 *   Future maintainers: if ts-morph is ever added to hooks-base, consider upgrading
 *   to `getBody()?.getStatements().length` for exact AST-level statement counting.
 */
function countBodyStatements(code: string): number {
  // Strip JSDoc and other block comments before scanning for `{`.
  // This prevents tags like `@throws {RangeError}` from being mistaken
  // for the function body opener (issue #383).
  const codeWithoutBlockComments = code.replace(/\/\*[\s\S]*?\*\//g, "");
  const openIdx = codeWithoutBlockComments.indexOf("{");
  if (openIdx === -1) return 0;

  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;

  for (let i = openIdx; i < codeWithoutBlockComments.length; i++) {
    const ch = codeWithoutBlockComments[i];
    if (ch === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }

  if (bodyStart === -1 || bodyEnd === -1) return 0;

  return codeWithoutBlockComments
    .slice(bodyStart, bodyEnd)
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("//") &&
        !l.startsWith("/*") &&
        !l.startsWith("*"),
    ).length;
}

/** Extract the first exported function name from code. Returns null if none. */
function extractFunctionName(code: string): string | null {
  return /(?:export\s+(?:async\s+)?function\s+)(\w+)/.exec(code)?.[1] ?? null;
}

/**
 * Behavior-derived slug fallback for atomName when extractFunctionName returns null.
 * Mirrors specFromIntent.deriveSpecName's format so anonymous-function fallbacks
 * keep the same shape as before WI-424's persist delegation.
 */
function deriveAtomNameFallback(behavior: string, canonicalAstHashHex: string): string {
  const prefix = behavior
    .slice(0, 30)
    .replace(/\W+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hashSuffix = canonicalAstHashHex.slice(-6);
  return `${prefix}-${hashSuffix}`;
}

// ---------------------------------------------------------------------------
// Core atomizeEmission function
// ---------------------------------------------------------------------------

/**
 * Attempt to atomize an LLM-emitted code snippet into the local registry.
 *
 * This is the write-side of the bidirectional hook (DEC-HOOK-ATOM-CAPTURE-001).
 * Steps:
 *   1. Shape filter (test-file, inner-scope, type-only, trivial-body rejection)
 *   2. License header injection (MIT default if absent)
 *   3. @yakcc/shave universalize({persist:true}) — static strategy, offline, zero
 *      network calls; universalize handles all atom persistence internally
 *   4. Consume merkleRoot from NovelGlueEntry items in the returned slicePlan
 *   5. Return AtomizeResult with the list of atoms created
 *
 * CONCURRENT SAFETY: registry.storeBlock uses INSERT OR IGNORE — idempotent under
 * concurrent calls from parallel sessions. Two parallel atomize calls on different
 * inputs both succeed; on the SAME input, the second is a no-op (same BMR).
 *
 * B6 AIR-GAP: universalize() with strategy:"static" + offline:true uses only
 * local AST parsing (ts-morph). No outbound HTTP. No Anthropic API key needed.
 *
 * @param input - Emission context: code, toolName, registry, and optional flags.
 * @returns AtomizeResult.
 */
export async function atomizeEmission(input: AtomizeInput): Promise<AtomizeResult> {
  const { emittedCode, registry, skipOnNoJsdoc = false, filePath } = input;

  // ── Step 1: Shape filter ──────────────────────────────────────────────────

  // Test-file detection.
  if (isTestEmission(emittedCode, filePath)) {
    return { atomized: false, atomsCreated: [], reason: "test-file" };
  }

  const shape = detectFunctionShape(emittedCode);

  if (shape === "no-function") {
    return { atomized: false, atomsCreated: [], reason: "not-exported-function" };
  }
  if (shape === "inner-scope") {
    return { atomized: false, atomsCreated: [], reason: "inner-scope" };
  }
  if (shape === "not-exported") {
    return { atomized: false, atomsCreated: [], reason: "not-exported-function" };
  }
  if (shape === "type-only") {
    return { atomized: false, atomsCreated: [], reason: "type-only" };
  }
  if (shape === "exported-no-jsdoc" && skipOnNoJsdoc) {
    return { atomized: false, atomsCreated: [], reason: "no-jsdoc" };
  }
  // shape is "exported-with-jsdoc" or "exported-no-jsdoc" (MAYBE path) — proceed.

  // Trivial body check.
  const stmtCount = countBodyStatements(emittedCode);
  if (stmtCount < TRIVIAL_BODY_THRESHOLD) {
    return { atomized: false, atomsCreated: [], reason: "trivial-body" };
  }

  // ── Step 2: License header injection ────────────────────────────────────

  // @decision DEC-HOOK-ATOM-CAPTURE-001 (license-default-MIT)
  // Auto-prepend MIT SPDX header when absent. shave's licenseGate then detects MIT.
  // GPL/AGPL in the original code → licenseGate rejects → reason: "license-missing".
  const hasSpdx = /SPDX-License-Identifier\s*:/i.test(emittedCode);
  const codeForShave = hasSpdx ? emittedCode : `// SPDX-License-Identifier: MIT\n${emittedCode}`;

  // ── Step 3: Shave pipeline ──────────────────────────────────────────────

  // Import lazily — avoids circular-reference issues in tests that stub shave.
  // The static strategy is B6-safe: pure AST analysis, no network calls.
  try {
    const {
      detectLicense,
      licenseGate,
      universalize,
      LicenseRefusedError,
      DidNotReachAtomError,
    } = await import("@yakcc/shave");

    // License pre-check — fast, fail-early before AST parsing.
    const detection = detectLicense(codeForShave);
    const gateResult = licenseGate(detection);
    if (!gateResult.accepted) {
      return { atomized: false, atomsCreated: [], reason: "license-missing" };
    }

    // The shave registry view interface is structurally satisfied by our Registry.
    // universalize() uses selectBlocks / getBlock / findByCanonicalAstHash for
    // known-primitive lookups — all present on the Registry interface.
    // storeBlock is also on Registry and will be used by universalize({persist:true}).
    const registryAsShaveView = registry as Parameters<typeof universalize>[1];

    let universalizeResult;
    try {
      /**
       * @decision DEC-V2-ATOMIZE-DELEGATES-UNIVERSALIZE-001
       * @title atomize.ts delegates atom persistence to universalize({persist:true})
       * @status accepted (WI-424)
       * @rationale
       *   WI-373 (PR #419) introduced universalize({persist:true}) as the canonical
       *   persistence primitive. WI-423 (PR #431) closed the Sacred Practice #12 debt
       *   for shave() by making it delegate to universalize({persist:true}).
       *
       *   This WI (WI-424) applies the identical delegation pattern to atomize.ts.
       *   The previous inline loop — buildBlockRow() + registry.storeBlock()
       *   for each novel-glue entry — duplicated the postorder lineage-threading
       *   logic that universalize()'s step 6 already implements
       *   (DEC-UNIVERSALIZE-PERSIST-PIPELINE-001).
       *
       *   By passing persist:true, universalize() now runs maybePersistNovelGlueAtom
       *   for each NovelGlueEntry in DFS postorder with parentBlockRoot lineage
       *   threading, and surfaces merkleRoot on each enriched entry. atomize.ts reads
       *   these merkleRoots from the returned slicePlan instead of calling storeBlock
       *   directly.
       *
       *   Sacred Practice #12: universalize() is the single authority for atom
       *   persistence in the entire system. Both shave() (WI-423) and atomize.ts
       *   (this WI) now delegate to it. The inline buildBlockRow helper and all
       *   associated @yakcc/contracts / @yakcc/registry persist-side imports are
       *   removed.
       *
       *   Hot-path compliance (DEC-HOOK-LAYER-001 D-HOOK-3 <=200ms p95): the persist
       *   step is O(novel-glue entries) before and after this refactor. The same
       *   SQLite writes via the same maybePersistNovelGlueAtom primitive run either
       *   way. No additional I/O, network calls, or synchronization is introduced.
       */
      universalizeResult = await universalize(
        { source: codeForShave },
        registryAsShaveView,
        {
          intentStrategy: "static",
          offline: true,
          persist: true,
        },
      );
    } catch (e) {
      if (e instanceof DidNotReachAtomError) {
        return { atomized: false, atomsCreated: [], reason: "shave-rejected" };
      }
      if (
        e instanceof LicenseRefusedError ||
        (e !== null && typeof e === "object" && "name" in e &&
          (e as { name: unknown }).name === "LicenseRefusedError")
      ) {
        return { atomized: false, atomsCreated: [], reason: "license-missing" };
      }
      throw e;
    }

    // ── Step 4: Collect atoms from the enriched slicePlan ────────────────────
    //
    // universalize({persist:true}) has already called storeBlock for each
    // NovelGlueEntry that carried an intentCard. The enriched entries carry
    // merkleRoot when persistence succeeded; entries without intentCard have
    // merkleRoot === undefined (they were skipped by maybePersistNovelGlueAtom,
    // per DEC-ATOM-PERSIST-001).

    const atomsCreated: Array<{
      blockMerkleRoot: string;
      atomName: string;
      spec: { name: string; behavior: string };
    }> = [];

    for (const entry of universalizeResult.slicePlan) {
      if (entry.kind !== "novel-glue") continue;
      if (entry.merkleRoot === undefined) continue;

      const behaviorText = entry.intentCard?.behavior ?? "";
      const atomName =
        extractFunctionName(entry.source) ??
        deriveAtomNameFallback(
          behaviorText,
          entry.canonicalAstHash as unknown as string,
        );

      atomsCreated.push({
        blockMerkleRoot: entry.merkleRoot as unknown as string,
        atomName,
        spec: {
          name: entry.merkleRoot as unknown as string,
          behavior: behaviorText,
        },
      });
    }
    if (atomsCreated.length === 0) {
      return { atomized: false, atomsCreated: [], reason: "shave-rejected" };
    }

    return { atomized: true, atomsCreated };
  } catch (e: unknown) {
    // Catch-all: any unhandled shave pipeline error → shave-rejected.
    if (
      e !== null &&
      typeof e === "object" &&
      "name" in e &&
      ((e as { name: unknown }).name === "LicenseRefusedError")
    ) {
      return { atomized: false, atomsCreated: [], reason: "license-missing" };
    }
    return { atomized: false, atomsCreated: [], reason: "shave-rejected" };
  }
}

// ---------------------------------------------------------------------------
// @atom-new comment rendering
// ---------------------------------------------------------------------------

/**
 * Render the `// @atom-new` comment for an auto-atomized emission.
 *
 * Format: `// @atom-new: <first-8-hex-of-BMR> — yakcc:<atomName>`
 *
 * @decision DEC-HOOK-ATOM-CAPTURE-001 (@atom-new comment format)
 * The format parallels the `// @atom <name> ...` contract comment on the
 * substitute side (DEC-HOOK-PHASE-3-001) but is distinguishable by the
 * "-new:" suffix. This ensures:
 *   (a) Agents can distinguish a newly created atom from a substituted one.
 *   (b) Future tooling can grep for `@atom-new:` to audit session contributions.
 *   (c) The 8-char BMR prefix is enough for `yakcc_resolve` lookups per session.
 *
 * @param blockMerkleRoot - Full BlockMerkleRoot; only first 8 chars are emitted.
 * @param atomName        - Function name of the atomized function.
 * @returns Single-line comment (no trailing newline).
 */
export function renderAtomNewComment(blockMerkleRoot: string, atomName: string): string {
  const shortBmr = blockMerkleRoot.slice(0, 8);
  return `// @atom-new: ${shortBmr} — yakcc:${atomName}`;
}
