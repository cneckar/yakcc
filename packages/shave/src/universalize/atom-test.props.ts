// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave universalize/atom-test.ts. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3j)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Surface covered: universalize/atom-test.ts
//   isAtom(node, source, registry, options?) → Promise<AtomTestResult>
//
// Properties covered:
//   AT-REASON-1: reason is always one of the 5 canonical AtomTestReason literals.
//   AT-CF-3: controlFlowBoundaryCount in result is always a non-negative integer.
//   AT-CF-1: isAtom with 0 CF boundaries (empty registry) always returns isAtom=true.
//   AT-CF-2: isAtom with CF count > maxCF always returns reason="too-many-cf-boundaries".
//   AT-CF-4: undefined maxControlFlowBoundaries uses default (1).
//   AT-REG-1: empty registry + 0 CF options-sweep → always atomic.
//   AT-MATCH-1: matchedPrimitive is undefined IFF reason != "contains-known-primitive".
//   AT-REG-2: always-match registry triggers contains-known-primitive on fn with 2 stmts.
//   Compound: real parse → isAtom → result — CF-varies-by-maxCF correctness.

// ---------------------------------------------------------------------------
// Property-test corpus for universalize/atom-test.ts
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import { Project, ScriptKind } from "ts-morph";
import { isAtom } from "./atom-test.js";
import type { AtomTestOptions, AtomTestResult } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries and helpers
// ---------------------------------------------------------------------------

/** The 5 canonical AtomTestReason literal values. */
const ATOM_TEST_REASONS: ReadonlySet<string> = new Set([
  "atomic",
  "too-many-cf-boundaries",
  "contains-known-primitive",
  "non-decomposable-non-atom",
  "loop-with-escaping-cf",
]);

/** Arbitrary non-negative integer for maxControlFlowBoundaries (0–5). */
const natCFArb: fc.Arbitrary<number> = fc.nat({ max: 5 });

/**
 * Build a ts-morph Project + SourceFile from the given source string.
 * Returns the root SourceFile node and the source for passing to isAtom().
 */
function parseSource(source: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: false, noEmit: true, skipLibCheck: true },
  });
  const file = project.createSourceFile("test.ts", source, {
    scriptKind: ScriptKind.TS,
  });
  return { file, source };
}

/** Registry that always returns no matches. */
const emptyRegistry = {
  async findByCanonicalAstHash(_hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
    return [];
  },
};

/** Registry that returns a fake match for every hash query. */
const alwaysMatchRegistry = {
  async findByCanonicalAstHash(_hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
    return ["fake-merkle" as BlockMerkleRoot];
  },
};

// ---------------------------------------------------------------------------
// AT-REASON-1: reason is always one of the 5 canonical AtomTestReason literals
//
// Invariant: reason is a discriminant used by downstream consumers (CLI,
// slicer, decompose). Any value outside the canonical set is unreachable in
// exhaustive switch statements and causes silent misclassification.
// ---------------------------------------------------------------------------

/**
 * prop_isAtom_reason_is_valid_AtomTestReason
 *
 * Every AtomTestResult produced by isAtom() has a reason that belongs to the
 * 5-element canonical AtomTestReason union, for varying maxControlFlowBoundaries.
 *
 * Invariant (AT-REASON-1, DEC-ATOM-TEST-003): reason drives branching in the
 * CLI diagnostic output and in decompose(). Any sixth or unknown value would
 * be silently dropped in exhaustive switch statements.
 */
export const prop_isAtom_reason_is_valid_AtomTestReason: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    const source = "function f(x: number) { if (x > 0) return x; return 0; }";
    const { file } = parseSource(source);
    const result: AtomTestResult = await isAtom(file, source, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });
    return ATOM_TEST_REASONS.has(result.reason);
  });

// ---------------------------------------------------------------------------
// AT-CF-3: controlFlowBoundaryCount in result is always a non-negative integer
//
// Invariant: this count is used to evaluate maxControlFlowBoundaries. A
// negative count would always satisfy any threshold, making every node appear
// atomic regardless of actual structure.
// ---------------------------------------------------------------------------

/**
 * prop_isAtom_controlFlowBoundaryCount_is_non_negative
 *
 * The controlFlowBoundaryCount in any AtomTestResult is a non-negative integer.
 *
 * Invariant (AT-CF-3, DEC-ATOM-TEST-003): the CF count is compared against
 * maxControlFlowBoundaries. A negative count is structurally impossible — no
 * source file contains fewer than 0 control-flow boundary nodes.
 */
export const prop_isAtom_controlFlowBoundaryCount_is_non_negative: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    const source = "function f(x: number) { if (x > 0) return x; return 0; }";
    const { file } = parseSource(source);
    const result: AtomTestResult = await isAtom(file, source, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });
    return (
      typeof result.controlFlowBoundaryCount === "number" &&
      Number.isInteger(result.controlFlowBoundaryCount) &&
      result.controlFlowBoundaryCount >= 0
    );
  });

// ---------------------------------------------------------------------------
// AT-CF-1: 0 CF boundaries always returns isAtom=true (no registry match)
//
// Invariant: a node with 0 control-flow boundaries and no known-primitive
// sub-statements is always atomic regardless of maxCF threshold.
// ---------------------------------------------------------------------------

/**
 * prop_isAtom_zero_cf_empty_registry_is_always_atomic
 *
 * For a source with exactly 0 control-flow boundaries and an empty registry,
 * isAtom() always returns isAtom=true with reason="atomic" for every value of
 * maxControlFlowBoundaries in {0..5}.
 *
 * Invariant (AT-CF-1, DEC-ATOM-TEST-003): the degenerate case — simplest
 * possible function body — must classify as atomic unconditionally. Any other
 * result indicates a regression in CF counting.
 */
export const prop_isAtom_zero_cf_empty_registry_is_always_atomic: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    // Source with exactly 0 CF boundaries: pure arithmetic return.
    const source = "function f(x: number) { return x + 1; }";
    const { file } = parseSource(source);
    const result = await isAtom(file, source, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });
    return (
      result.isAtom === true && result.reason === "atomic" && result.controlFlowBoundaryCount === 0
    );
  });

// ---------------------------------------------------------------------------
// AT-CF-2: CF count > maxCF always returns reason="too-many-cf-boundaries"
//
// Invariant: When the CF count strictly exceeds maxControlFlowBoundaries,
// criterion 1 fails immediately and reason must be too-many-cf-boundaries.
// ---------------------------------------------------------------------------

/**
 * prop_isAtom_excess_cf_returns_too_many_cf_boundaries
 *
 * For a source with exactly 2 CF boundaries and maxControlFlowBoundaries=0,
 * isAtom() always returns isAtom=false with reason="too-many-cf-boundaries".
 *
 * Invariant (AT-CF-2, DEC-ATOM-TEST-003): criterion 1 short-circuits before
 * the registry is consulted. A result with a different reason indicates the
 * short-circuit is broken.
 */
export const prop_isAtom_excess_cf_returns_too_many_cf_boundaries = fc.asyncProperty(
  fc.constant<undefined>(undefined),
  async () => {
    // Source with exactly 2 CF boundaries (if + for): exceeds maxCF=0.
    const source =
      "function f(x: number) { if (x > 0) { for (let i = 0; i < 10; i++) {} } return 0; }";
    const { file } = parseSource(source);
    const result = await isAtom(file, source, emptyRegistry, {
      maxControlFlowBoundaries: 0,
    });
    return result.isAtom === false && result.reason === "too-many-cf-boundaries";
  },
);

// ---------------------------------------------------------------------------
// AT-CF-4: undefined maxControlFlowBoundaries uses default (1)
//
// Invariant: The default maxControlFlowBoundaries is 1. A source with exactly
// 1 CF boundary must classify as atomic when options is undefined.
// ---------------------------------------------------------------------------

/**
 * prop_isAtom_undefined_options_uses_default_max_cf_1
 *
 * When options is undefined, isAtom() uses maxControlFlowBoundaries=1. A
 * source with exactly 1 CF boundary must classify as atomic.
 *
 * Invariant (AT-CF-4, DEC-ATOM-TEST-003): the default maxCF=1 is documented
 * in atom-test.ts. If this default ever changed silently, previously-atomic
 * nodes would be reclassified as non-atomic, breaking the decompose tree.
 */
export const prop_isAtom_undefined_options_uses_default_max_cf_1 = fc.asyncProperty(
  fc.constant<undefined>(undefined),
  async () => {
    // Exactly 1 CF boundary (single if) → atomic with default maxCF=1.
    const source = "function f(x: number) { if (x > 0) return x; return 0; }";
    const { file } = parseSource(source);
    const result = await isAtom(file, source, emptyRegistry);
    return (
      result.isAtom === true && result.reason === "atomic" && result.controlFlowBoundaryCount === 1
    );
  },
);

// ---------------------------------------------------------------------------
// AT-REG-1: empty registry + options sweep → always atomic for 0-CF source
//
// Invariant: With no known primitives in the registry, a node with 0 CF
// boundaries must always classify as atomic for any options value.
// ---------------------------------------------------------------------------

/**
 * prop_isAtom_empty_registry_zero_cf_options_sweep_always_atomic
 *
 * For a 0-CF source and an empty registry, isAtom() returns atomic regardless
 * of the options.maxControlFlowBoundaries value (including undefined).
 *
 * Invariant (AT-REG-1, DEC-ATOM-TEST-003): criteria 1 and 2 both pass for
 * 0-CF nodes with an empty registry. Any non-atomic result indicates a bug.
 */
export const prop_isAtom_empty_registry_zero_cf_options_sweep_always_atomic = fc.asyncProperty(
  fc.record({ maxControlFlowBoundaries: fc.nat({ max: 10 }) }, { requiredKeys: [] }),
  async (opts) => {
    const source = "function g(a: string): string { return a.trim(); }";
    const { file } = parseSource(source);
    const result = await isAtom(file, source, emptyRegistry, opts);
    // 0 CF boundaries → always atomic regardless of maxCF threshold.
    return result.isAtom === true && result.reason === "atomic";
  },
);

// ---------------------------------------------------------------------------
// AT-MATCH-1: matchedPrimitive is undefined IFF reason != "contains-known-primitive"
//
// Invariant: matchedPrimitive carries the registry result. It must only appear
// when the registry matched a sub-statement. In all other cases it must be
// absent/undefined.
// ---------------------------------------------------------------------------

/**
 * prop_isAtom_matchedPrimitive_absent_for_non_contains_reason
 *
 * For a 0-CF source with an empty registry (always produces "atomic"),
 * matchedPrimitive must be undefined in the result.
 *
 * Invariant (AT-MATCH-1, DEC-ATOM-TEST-003): callers use matchedPrimitive to
 * populate the PointerEntry in the slice plan. If it's set for wrong reasons,
 * spurious pointers appear in the output.
 */
export const prop_isAtom_matchedPrimitive_absent_for_non_contains_reason: fc.IAsyncProperty<
  [number]
> = fc.asyncProperty(natCFArb, async (maxCF) => {
  // Source with 0 CF boundaries and empty registry → always atomic, no matchedPrimitive.
  const source = "function f(x: number) { return x + 1; }";
  const { file } = parseSource(source);
  const result = await isAtom(file, source, emptyRegistry, {
    maxControlFlowBoundaries: maxCF,
  });
  // For atomic results, matchedPrimitive must be absent.
  if (result.reason !== "contains-known-primitive") {
    return result.matchedPrimitive === undefined;
  }
  // For contains-known-primitive, matchedPrimitive must be defined.
  return result.matchedPrimitive !== undefined;
});

// ---------------------------------------------------------------------------
// AT-REG-2: always-match registry triggers contains-known-primitive
//
// Invariant: When every registry query returns a match, a function with
// multiple body statements must classify as contains-known-primitive.
// ---------------------------------------------------------------------------

/**
 * prop_isAtom_always_match_registry_triggers_contains_known_primitive
 *
 * For a two-statement function body and an always-match registry, the
 * FunctionDeclaration node must classify as contains-known-primitive because
 * the first sub-statement matches the registry.
 *
 * Invariant (AT-REG-2, DEC-ATOM-TEST-003): criterion 2 is reachable. Without
 * this property a bug where the registry is never consulted could go unnoticed.
 */
export const prop_isAtom_always_match_registry_triggers_contains_known_primitive = fc.asyncProperty(
  fc.constant<undefined>(undefined),
  async () => {
    // Two-statement function body: first statement can match the always-match registry.
    const source = "function f(x: number) { const y = x * 2; return y + 1; }";
    const { file } = parseSource(source);

    // Call isAtom on the FunctionDeclaration node so getTopLevelStatements
    // returns the body's statements (not the self-recognition guard path).
    const fnDecl = file.getFunctions()[0];
    if (fnDecl === undefined) return false; // unexpected parse failure

    const result = await isAtom(fnDecl, source, alwaysMatchRegistry);

    // The always-match registry returns a hit for the first sub-statement.
    return (
      result.isAtom === false &&
      result.reason === "contains-known-primitive" &&
      result.matchedPrimitive !== undefined
    );
  },
);

// ---------------------------------------------------------------------------
// Compound: real parse → isAtom → result — CF-varies-by-maxCF correctness
//
// Production sequence: parse TypeScript source → extract SourceFile node →
// call isAtom() → verify joint invariants on result shape.
//
// This is the required compound-interaction property that crosses multiple
// internal components (ts-morph parsing, CF boundary counting, registry stub,
// result shape validation).
// ---------------------------------------------------------------------------

/**
 * prop_compound_isAtom_real_parse_cf_varies_by_maxcf
 *
 * Drives the real production sequence end-to-end for both atomic and
 * non-atomic cases by varying maxControlFlowBoundaries relative to a fixed
 * source with 1 CF boundary:
 *   - maxCF >= 1 → isAtom=true, reason="atomic", cfCount=1
 *   - maxCF < 1 (maxCF=0) → isAtom=false, reason="too-many-cf-boundaries", cfCount=1
 *
 * Crosses: ts-morph Project construction, SourceFile parse, CF walk (all
 * descendants), result shape validation. Exercises all three observable
 * behaviors of isAtom() (CF count, threshold comparison, result shape).
 *
 * Invariant (AT-CF-1, AT-CF-2, DEC-ATOM-TEST-003): the above outcome rules
 * must hold for every value of maxCF in {0, 1, 2, 3, 4, 5}.
 */
export const prop_compound_isAtom_real_parse_cf_varies_by_maxcf: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    // Source with exactly 1 CF boundary (single if statement).
    const source = "function f(x: number) { if (x > 0) return x; return 0; }";
    const { file } = parseSource(source);

    const result: AtomTestResult = await isAtom(file, source, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });

    // CF count must always be 1 for this source regardless of maxCF.
    if (result.controlFlowBoundaryCount !== 1) return false;
    // reason must be one of the canonical set.
    if (!ATOM_TEST_REASONS.has(result.reason)) return false;
    // isAtom is boolean.
    if (typeof result.isAtom !== "boolean") return false;

    if (maxCF >= 1) {
      // 1 CF <= maxCF=1+ -> atomic
      return result.isAtom === true && result.reason === "atomic";
    }
    // maxCF=0: 1 CF > 0 -> too-many-cf-boundaries
    return result.isAtom === false && result.reason === "too-many-cf-boundaries";
  });
