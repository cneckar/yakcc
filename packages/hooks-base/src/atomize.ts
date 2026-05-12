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
 * PIPELINE:
 *   atomizeEmission → licenseGate (from @yakcc/shave) → universalize (static strategy)
 *   → iterate NovelGlueEntry items → buildBlockRow (inline) → registry.storeBlock
 *
 *   buildBlockRow is inlined here (not imported from shave) because specFromIntent
 *   and buildTriplet are private to @yakcc/shave's persist/ sub-directory and not
 *   on the package's public API surface (exports."."). The logic is minimal and
 *   fully derived from public @yakcc/contracts and @yakcc/shave types.
 *
 * Cross-reference: DEC-HOOK-PHASE-2-001, DEC-HOOK-PHASE-1-001, DEC-HOOK-LAYER-001,
 *   docs/adr/hook-layer-architecture.md D-HOOK-7.
 */

import {
  blockMerkleRoot,
  canonicalize,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
  validateSpecYak,
} from "@yakcc/contracts";
import type {
  BlockMerkleRoot,
  ProofManifest,
  SpecYak,
  SpecYakParameter,
} from "@yakcc/contracts";
import type { BlockTripletRow, Registry } from "@yakcc/registry";

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

// ---------------------------------------------------------------------------
// BlockTripletRow builder
// ---------------------------------------------------------------------------

/**
 * L0 bootstrap manifest — placeholder for the property-tests artifact.
 * Used here because atomizeEmission runs offline (no corpus extraction API call).
 *
 * @decision DEC-HOOK-ATOM-CAPTURE-001 (property tests)
 * Per spec edge case #6: v0 atoms have a placeholder property_tests artifact.
 * Corpus extraction (WI-016) and prop-test synthesis (WI-HOOK-ATOM-PROPTEST-SYNTHESIS)
 * are future work. The placeholder satisfies the schema requirement without
 * making any LLM or network call (B6 compliance).
 */
const PROPERTY_TESTS_PATH = "property-tests.ts";
const EMPTY_BYTES = new Uint8Array(0);

const L0_BOOTSTRAP_MANIFEST: ProofManifest = {
  artifacts: [{ kind: "property_tests", path: PROPERTY_TESTS_PATH }],
} as const;

/**
 * Derive a stable spec name slug from a behavior string and canonical AST hash.
 *
 * Mirrors specFromIntent's deriveSpecName from @yakcc/shave/persist/spec-from-intent.ts.
 * Format: <30-char-slug>-<last-6-of-hash>
 * Non-word characters are replaced with "-"; leading/trailing "-" stripped.
 */
function deriveSpecName(behavior: string, canonicalAstHashHex: string): string {
  const prefix = behavior
    .slice(0, 30)
    .replace(/\W+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hashSuffix = canonicalAstHashHex.slice(-6);
  return `${prefix}-${hashSuffix}`;
}

/**
 * Map an IntentParam (shave type) to a SpecYakParameter (contracts type).
 *
 * Mirrors the mapping in @yakcc/shave/persist/spec-from-intent.ts.
 * IntentParam.typeHint maps to SpecYakParameter.type.
 */
function mapIntentParam(param: {
  name: string;
  typeHint: string;
  description: string;
}): SpecYakParameter {
  return { name: param.name, type: param.typeHint, description: param.description };
}

/**
 * Build an L0 BlockTripletRow from a NovelGlueEntry's intentCard + source.
 *
 * This inline implementation mirrors the logic in:
 *   @yakcc/shave/persist/spec-from-intent.ts (specFromIntent)
 *   @yakcc/shave/persist/triplet.ts (buildTriplet → L0 bootstrap path)
 *   @yakcc/shave/persist/atom-persist.ts (persistNovelGlueAtom)
 *
 * All three are in @yakcc/shave's private persist/ sub-directory and are NOT
 * exported on the package's public API surface. Inlining here uses only public
 * APIs from @yakcc/contracts and @yakcc/registry.
 *
 * @decision DEC-HOOK-ATOM-CAPTURE-001 (inline persist logic)
 * The alternative — calling persistNovelGlueAtom directly via a deep import — would
 * violate the package boundary (exports map) and break on any future dist reorganization.
 * This inline path is self-contained, auditable, and safe for v0.
 */
function buildBlockRow(entry: {
  source: string;
  canonicalAstHash: string;
  intentCard: {
    behavior: string;
    inputs: readonly { name: string; typeHint: string; description: string }[];
    outputs: readonly { name: string; typeHint: string; description: string }[];
    preconditions: readonly string[];
    postconditions: readonly string[];
  };
}): BlockTripletRow {
  const { source, canonicalAstHash: astHashHex, intentCard } = entry;

  // Build SpecYak from the intentCard (mirrors specFromIntent logic).
  const specName = deriveSpecName(intentCard.behavior, astHashHex);
  const specCandidate = {
    name: specName,
    inputs: intentCard.inputs.map(mapIntentParam),
    outputs: intentCard.outputs.map(mapIntentParam),
    preconditions: Array.from(intentCard.preconditions),
    postconditions: Array.from(intentCard.postconditions),
    invariants: [] as string[],
    effects: [] as string[],
    level: "L0" as const,
  };
  const spec: SpecYak = validateSpecYak(specCandidate);

  // Compute content addresses.
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  const sh = deriveSpecHash(spec);

  // L0 bootstrap manifest (placeholder property-tests artifact).
  const manifest = L0_BOOTSTRAP_MANIFEST;
  const artifacts = new Map<string, Uint8Array>([[PROPERTY_TESTS_PATH, EMPTY_BYTES]]);

  // blockMerkleRoot = BLAKE3(spec_hash || impl_hash || proof_root).
  const root: BlockMerkleRoot = blockMerkleRoot({ spec, implSource: source, manifest, artifacts });

  // Canonical AST hash — re-derive from source to get the typed value.
  const canonicalAstHashTyped = deriveCanonicalAstHash(source);

  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes,
    implSource: source,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: canonicalAstHashTyped,
    artifacts,
    parentBlockRoot: null,
  };
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
 *   3. @yakcc/shave universalize() — static strategy, offline, zero network calls
 *   4. For each NovelGlueEntry with intentCard: buildBlockRow + registry.storeBlock
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
    const registryAsShaveView = registry as Parameters<typeof universalize>[1];

    let universalizeResult;
    try {
      universalizeResult = await universalize(
        { source: codeForShave },
        registryAsShaveView,
        {
          intentStrategy: "static",
          offline: true,
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

    // ── Step 4: Persist novel-glue entries ───────────────────────────────

    const atomsCreated: Array<{
      blockMerkleRoot: string;
      atomName: string;
      spec: { name: string; behavior: string };
    }> = [];

    for (const entry of universalizeResult.slicePlan) {
      if (entry.kind !== "novel-glue") continue;

      const { intentCard } = entry;
      if (intentCard === undefined) continue;

      try {
        const row = buildBlockRow({
          source: entry.source,
          canonicalAstHash: entry.canonicalAstHash as unknown as string,
          intentCard: {
            behavior: intentCard.behavior,
            inputs: intentCard.inputs as readonly { name: string; typeHint: string; description: string }[],
            outputs: intentCard.outputs as readonly { name: string; typeHint: string; description: string }[],
            preconditions: intentCard.preconditions,
            postconditions: intentCard.postconditions,
          },
        });

        // storeBlock uses INSERT OR IGNORE — safe under concurrent calls (DEC-HOOK-ATOM-CAPTURE-001).
        await registry.storeBlock(row);

        const atomName = extractFunctionName(entry.source) ?? deriveSpecName(intentCard.behavior, entry.canonicalAstHash as unknown as string);

        atomsCreated.push({
          blockMerkleRoot: row.blockMerkleRoot as unknown as string,
          atomName,
          spec: { name: row.specHash as unknown as string, behavior: intentCard.behavior },
        });
      } catch {
        // Individual atom build/store failure is non-fatal — continue with other entries.
      }
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
